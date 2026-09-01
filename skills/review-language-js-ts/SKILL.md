---
name: review-language-js-ts
description: Use when auditing Node.js/JS/TS — Express/Fastify/Next sources & sinks for cmdi, eval/vm, SQL/NoSQL, prototype pollution, SSRF, deser, crypto, authz.
---

# Node.js / JavaScript / TypeScript review

Goal: apply the class skills with JS/TS-specific source and sink names. Sources are request objects and process inputs; sinks are the exec/eval/query/fs/redirect/crypto APIs below. Aim for **complete** sink coverage — grep every row, then verify by reading the data flow (source → sink, no validator/parameterization between). TS types do **not** sanitize at runtime — a typed `string` is still tainted.

Tools run via `bash`. Widen with `semgrep --config p/javascript --config p/nodejsscan --config p/typescript .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "req\.(query|body|params|headers|cookies|hostname|ip)|request\.(query|body)|ctx\.(request|query|params)|process\.(env|argv)|fs\.readFileSync\(.*req|searchParams|useSearchParams|headers\(\)|cookies\(\)" -g '*.{js,ts,mjs,cjs,jsx,tsx}'
```
Express/Koa/Fastify/Hapi/NestJS: `req.query`, `req.body`, `req.params`, `req.headers`, `req.cookies`, `req.hostname`. Next.js: `searchParams`, route `params`, `req` in API/route handlers, `headers()`/`cookies()`, `useSearchParams`. Also `process.env`, `process.argv`, WebSocket `message`, `postMessage`, `JSON.parse` of external data, DB reads, and file contents. NestJS `@Param/@Query/@Body/@Headers` decorators bind the same untrusted values.

## Command injection (CWE-78)
```bash
rg -n "child_process|\bexec\(|execSync\(|\bspawn\(|spawnSync\(|execFileSync\(|\bfork\(|execa|shelljs|\bsh\.exec\(|zx|\x24\x60" -g '*.{js,ts,mjs,cjs}'
```
`child_process.exec`/`execSync` run the string through `/bin/sh` → any tainted substring = injection. **Safe:** `execFile`/`execFileSync`/`spawn` with the program fixed and args as a **separate array**, `shell:false` (the default). Also shell sinks: `shelljs.exec`, `execa(cmd, {shell:true})`, the `zx` `` $`...` `` tag, and a user-controlled *program name* even in the array form. → class `cmdi`.

## Code / eval injection (CWE-94, CWE-95)
```bash
rg -n "\beval\(|new Function\(|vm\.(runInThisContext|runInContext|runInNewContext|compileFunction)|vm2|isolated-vm|setTimeout\(\s*[\"'\x60]|setInterval\(\s*[\"'\x60]|require\(\s*[^'\"]|import\(\s*[^'\"]" -g '*.{js,ts}'
```
`eval`, `new Function(str)`, `vm.*`, and **string-form** `setTimeout`/`setInterval` execute code. `vm` is **not** a security sandbox — treat tainted `vm` input as RCE (and `vm2` has multiple public escapes). Dynamic `require(userVar)`/`import(userVar)` loads arbitrary modules. → class `codeinj`.

## SQL injection (CWE-89)
```bash
rg -n "\.query\(.*(\+|\x24\{|concat)|sequelize\.query\(|knex\.raw\(|\.whereRaw\(|\.orderByRaw\(|\x24queryRawUnsafe|\x24executeRawUnsafe|pg\.query|mysql.*query|sql\s*=\s*[\x60\"'].*\x24\{" -g '*.{js,ts}'
```
Vulnerable: `connection.query("... " + x)` / template literals, `knex.raw(\`...${x}\`)`, `.whereRaw`/`.orderByRaw` with interpolation, Prisma `$queryRawUnsafe`/`$executeRawUnsafe`, `sequelize.query("..."+x)`. **Safe:** parameterized `query(sql, [params])` / `$1` placeholders, `knex.where({col: v})`, Prisma **tagged-template** `$queryRaw\`... ${v}\`` (auto-parameterized), Sequelize `replacements`/`bind`. → class `sqli`.

## NoSQL injection (CWE-943)
```bash
rg -n "\.find\(\s*req|\.findOne\(\s*req|\.aggregate\(|\x24where|\.\x24where|mapReduce|\{\s*\x24where|Model\.(find|update|delete)\w*\(\s*(req|\{?\s*\.\.\.\s*req)" -g '*.{js,ts}'
```
Spreading/passing `req.body`/`req.query` straight into a Mongo (Mongoose) filter lets an attacker inject operators: `{"password":{"$gt":""}}`, `{"$where":"..."}`, `{"$regex":...}`. **Safe:** cast to expected scalar types first (`String(req.body.x)`), validate with a schema (zod/Joi/`express-mongo-sanitize`), never accept object-typed query values where a scalar is expected. → class `sqli`.

## Server-side template injection (CWE-1336)
```bash
rg -n "ejs\.render\(|pug\.(compile|render)\(|handlebars\.compile\(|Handlebars\.compile\(|nunjucks\.(render|compile)String|_\.template\(|dot\.template\(|new Function.*template|eta\.render" -g '*.{js,ts}'
```
Compiling a template **from** user input (not passing user data as a *value* into a fixed template) is SSTI → RCE in most JS engines. Keep templates static; treat user input strictly as data. See `review-injection`. → class `ssti`.

## Cross-site scripting sinks (CWE-79)
```bash
rg -n "dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|document\.write|insertAdjacentHTML|res\.send\(.*req|\{\{\{|\|\s*safe|v-html|res\.write\(.*req" -g '*.{js,ts,jsx,tsx,vue,hbs,ejs}'
```
React `dangerouslySetInnerHTML`, DOM `innerHTML`/`outerHTML`/`document.write`/`insertAdjacentHTML`, Handlebars triple-`{{{`, Vue `v-html`, or echoing `req.*` into an HTML response without encoding → XSS. Prefer text APIs / framework auto-escaping; sanitize with DOMPurify only when HTML is required. → class `codeinj` (reflected/stored XSS; cross-ref `review-injection`).

## Prototype pollution (CWE-1321, JS-specific)
```bash
rg -n "Object\.assign\(|_\.merge\(|_\.mergeWith\(|_\.defaultsDeep\(|_\.set\(|deepmerge|extend\(|\bmerge\(|set\(\s*\w+,\s*(req|path)|JSON\.parse\(.*req|\[\s*(req|body|params)[^\]]*\]\s*=" -g '*.{js,ts}'
```
Recursive merge / `set`-by-path of user JSON into an object without blocking `__proto__` / `constructor` / `prototype` keys pollutes `Object.prototype` → flip auth flags, DoS, or chain to RCE. Vulnerable when the *keys* come from the request and the merge doesn't filter them (historic: lodash `<4.17.12` `defaultsDeep`, `merge`). **Safe:** `Object.create(null)`, `Map`, freeze prototypes, or reject `__proto__`/`constructor`/`prototype` keys. → class `codeinj`.

## Deserialization (CWE-502)
```bash
rg -n "node-serialize|serialize-to-js|funcster|\.unserialize\(|js-yaml.*load\b|yaml\.load\(|cryo|\bunserialize\(" -g '*.{js,ts}'
```
`node-serialize`/`serialize-to-js`/`funcster` `unserialize()` on user data (`_$$ND_FUNC$$_` payloads) = RCE. `js-yaml` `load()` in **< v4** with the default schema executes custom tags — use `safeLoad`/v4 `load` (safe by default). → class `deser`; see `review-deserialization-ssrf`.

## SSRF (CWE-918)
```bash
rg -n "axios(\.|\()|fetch\(|got\(|node-fetch|superagent|needle\(|request\(|http\.(get|request)\(|https\.(get|request)\(|undici|new URL\(.*req" -g '*.{js,ts}'
```
`axios/fetch/got/http.get(req.body.url)` with no allowlist reaches internal hosts / cloud metadata (`169.254.169.254`). Validate against an **allowlist** of hosts, resolve+check the IP (block RFC1918/link-local), and disable redirects for user URLs. → class `ssrf`; see `review-deserialization-ssrf`.

## Path traversal & unsafe file handling (CWE-22, CWE-434)
```bash
rg -n "fs\.(readFile|readFileSync|writeFile|createReadStream|createWriteStream|unlink|readdir)\(|path\.(join|resolve)\(.*(req|param|body|query)|res\.(sendFile|download)\(|express\.static|multer|formidable|busboy|\.originalname|\.mv\(" -g '*.{js,ts}'
```
- **Traversal:** `path.join(dir, req.query.x)` into `fs`/`sendFile`/`download` → read/write outside base. **Safe:** resolve then verify the result `startsWith` the intended base dir; reject `..`. → class `pathtrav`; see `review-path-file`.
- **Upload:** `multer`/`formidable`/`busboy` writing to a path built from `file.originalname`, or no MIME/extension/size limit → arbitrary write / malicious upload. Store with a generated name, validate type server-side. → class `upload`.

## Open redirect (CWE-601)
```bash
rg -n "res\.redirect\(|res\.location\(|\.header\(\s*['\"]Location|redirect\(\s*(req|url|next)" -g '*.{js,ts}'
```
`res.redirect(req.query.next)` unvalidated → phishing / OAuth token theft. Allowlist redirect targets or force same-origin relative paths. → class `authz` (open redirect; cross-ref `review-injection`).

## Weak crypto & randomness (CWE-327, CWE-328, CWE-338, CWE-916)
```bash
rg -n "Math\.random\(|createHash\(\s*['\"](md5|sha1)|createCipher\(|['\"]des-|['\"]rc4|['\"]aes-\d+-ecb|crypto\.pbkdf2\(.*,\s*1?\d{1,3}\s*,|jwt\.sign\(.*none|algorithms:\s*\[.*none|rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED" -g '*.{js,ts}'
```
- `Math.random()` for tokens/IDs/passwords → predictable (CWE-338). **Safe:** `crypto.randomBytes`/`crypto.randomUUID`.
- `createHash('md5'|'sha1')`, DES/RC4/AES-ECB, deprecated `crypto.createCipher` (no IV) → CWE-327/328. **Safe:** SHA-256+, `createCipheriv` with a random IV, AES-GCM.
- Password hashing with a plain hash instead of bcrypt/scrypt/argon2 (CWE-916).
- `jwt.verify` without pinning `algorithms:` → **alg-confusion / `alg:none`** bypass; `rejectUnauthorized:false` / `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS verification. → class `crypto` (JWT alg → also `authn`); see `review-crypto-secrets-handling`.

## Auth / authz & framework bypasses (CWE-862, CWE-287)
```bash
rg -n "passport|express-jwt|jwt\.verify|requireAuth|isAuthenticated|ensureLogged|@UseGuards|AuthGuard|middleware|app\.use\(|export function middleware|x-middleware-subrequest" -g '*.{js,ts}'
```
- Compare state-changing routes/handlers that **lack** an auth/authz middleware against protected ones (missing check → BOLA/IDOR). Middleware **order** matters: a route mounted before `app.use(auth)` is unprotected.
- NestJS: sensitive routes missing `@UseGuards(AuthGuard)`; a global guard overridden by `@Public()`.
- **Next.js middleware auth bypass — CVE-2025-29927:** if authz is enforced only in `middleware.ts`, a spoofed `x-middleware-subrequest` header skips it entirely on unpatched Next (`<12.3.5`, `<13.5.9`, `<14.2.25`, `<15.2.3`). Verify the Next version (`review-dependencies-sca`) and that authz is *also* enforced in the route/handler, not only middleware. → class `authz`/`authn`; see `review-authz-authn`.

## Sensitive-data logging (CWE-532)
```bash
rg -n "console\.(log|error|info)\(.*(password|token|secret|apiKey|authorization|req\.body)|logger\.\w+\(.*(password|token|secret)" -g '*.{js,ts}'
```
Logging full request bodies, tokens, or `Authorization` headers writes secrets to log sinks. → class `logging`; cross-ref `review-secrets`.

## Dependency risk (hand off to SCA)
```bash
npm audit --json > "$PIRED_WORKSPACE/evidence/npm-audit.json" 2>/dev/null || pnpm audit --json > "$PIRED_WORKSPACE/evidence/pnpm-audit.json" 2>/dev/null || yarn npm audit --json > "$PIRED_WORKSPACE/evidence/yarn-audit.json" 2>/dev/null || true
rg -n "\"(node-serialize|serialize-to-js|vm2|lodash|event-stream|flatmap-stream)\"" package.json   # historically-risky
```
`vm2` sandbox escapes, unmaintained/typo-squatted packages, malicious `postinstall` scripts. **Do not drop a vulnerable-dependency lead** even if reachability is unclear — map each CVE to actual usage but still record it (see `review-dependencies-sca`). → class `sca`.

## Wire into the loop
```
record kind=hypothesis statement="POST /run passes req.body.cmd to execSync" target=e_run class=cmdi approach="trace req.body.cmd -> child_process" outcome=testing
record kind=finding title="Command injection via /run cmd param" severity=critical target=e_run class=cmdi cwe=CWE-78 description="child_process.execSync(req.body.cmd) — shell sink, no validation" repro="POST /run {cmd:'id;cat /etc/passwd'}" evidence=["routes/run.js:12"] status=confirmed hypothesisId=y3
```
Refute (set `outcome=refuted`) only when the input demonstrably hits `execFile`/parameterized query/validated redirect target/schema validator. Uncertain-but-plausible → keep `outcome=inconclusive` with a note; never silently drop it.

## References
- Node.js Security Best Practices — nodejs.org — https://nodejs.org/en/learn/getting-started/security-best-practices
- OWASP Node.js Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
- CWE-1321: Prototype Pollution — https://cwe.mitre.org/data/definitions/1321.html
- CWE-943: Improper Neutralization of Special Elements in Data Query Logic (NoSQLi) — https://cwe.mitre.org/data/definitions/943.html
- CVE-2025-29927: Next.js Middleware Authorization Bypass (`x-middleware-subrequest`) — https://github.com/advisories/GHSA-f82v-jwr5-mffw
- Prisma raw queries (`$queryRaw` tagged vs `$queryRawUnsafe`) — https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries
