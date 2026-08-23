---
name: review-language-js-ts
description: Use when auditing Node.js/JavaScript/TypeScript — Express/Fastify/Next sources & sinks, child_process, eval/vm, prototype pollution, ORM injection, npm risk.
---

# Node.js / JavaScript / TypeScript review

Goal: apply the class skills with JS/TS-specific source and sink names. Sources are request objects and process inputs; sinks are the exec/eval/query/fs/redirect APIs below.

Tools run via `bash`. Widen with `semgrep --config p/javascript --config p/nodejsscan .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "req\.(query|body|params|headers|cookies)|request\.(query|body)|ctx\.request|process\.env|process\.argv|fs\.readFileSync\(.*req" -g '*.{js,ts,mjs}'
```
Express/Koa/Fastify: `req.query`, `req.body`, `req.params`, `req.headers`, `req.cookies`. Next.js: `searchParams`, `params`, `req` in API routes, `headers()`/`cookies()`. Also `process.env`, `process.argv`, WebSocket messages, and `JSON.parse` of external data.

## Command execution — CWE-78
```bash
rg -n "child_process|\bexec\(|execSync\(|spawn\(|spawnSync\(|execa|shelljs|\.exec\(" -g '*.{js,ts}'
```
`child_process.exec`/`execSync` run through `/bin/sh` → tainted string = injection. Safe: `execFile`/`spawn` with an **args array** and `shell:false`. `shelljs.exec` and `` eval(`...`) `` templates are also shell sinks.

## Code eval — CWE-94
```bash
rg -n "\beval\(|new Function\(|vm\.(runInThisContext|runInContext|runInNewContext|compileFunction)|setTimeout\(\s*[\"'\`]|setInterval\(\s*[\"'\`]" -g '*.{js,ts}'
```
`eval`, `new Function(str)`, `vm.*`, and string-form `setTimeout`/`setInterval` execute code. `vm` is **not** a security sandbox — treat tainted `vm` input as RCE.

## Injection into DB / template
```bash
rg -n "\.query\(|sequelize\.query|knex\.raw|\$where|\.find\(\s*req|mongoose|\.aggregate\(|ejs\.render|pug\.compile|handlebars\.compile|\.\$queryRaw" -g '*.{js,ts}'
```
- **SQL:** `connection.query("...".concat(x))`, `knex.raw(\`...${x}\`)`, Prisma `$queryRawUnsafe` → SQLi. Safe: `query(sql, [params])`, `knex.where({})`, Prisma tagged `$queryRaw`.
- **NoSQL:** spreading `req.body` into a Mongo filter/`$where` → operator injection (`{"$gt":""}`). Cast/validate types first.
- **SSTI:** compiling a template from user input (see `review-injection`).

## Filesystem / SSRF / redirect
```bash
rg -n "fs\.(readFile|writeFile|createReadStream|unlink)|path\.join\(.*req|res\.sendFile|res\.redirect\(|axios\(|fetch\(|got\(|http\.request\(|http\.get\(" -g '*.{js,ts}'
```
- Path: `path.join(dir, req.query.x)` into `fs`/`sendFile` → traversal (`review-path-file`).
- SSRF: `axios/fetch/got(req.body.url)` → `review-deserialization-ssrf`.
- Open redirect: `res.redirect(req.query.next)` unvalidated (CWE-601).

## Prototype pollution — CWE-1321 (JS-specific)
```bash
rg -n "Object\.assign\(|merge\(|extend\(|deepmerge|_\.merge|\[.*(req|body|params).*\]\s*=|JSON\.parse\(.*req|lodash" -g '*.{js,ts}'
```
Recursive merge/`set`-by-path of user JSON into an object without blocking `__proto__`/`constructor`/`prototype` keys pollutes `Object.prototype` → can flip flags, escalate, or chain to RCE. Vulnerable when keys come from the request and the merge doesn't filter them.

## Node deserialization — CWE-502
`node-serialize`/`serialize-javascript`/`funcster` `unserialize()` on user data (`_$$ND_FUNC$$_` payloads) = RCE. See `review-deserialization-ssrf`.

## npm dependency risk
```bash
npm audit --json > evidence/npm-audit.json 2>/dev/null || true    # see review-dependencies-sca
rg -n "\"(node-serialize|serialize-to-js|vm2|lodash)\"" package.json   # historically-risky pkgs
```
`vm2` sandbox escapes, unmaintained/typo-squatted packages, `postinstall` scripts running arbitrary code. Map any CVE to *actual reachable usage* before recording (`review-dependencies-sca`).

## Wire into the loop
```
record kind=hypothesis statement="POST /run passes req.body.cmd to execSync" target=e_run class=cmdi approach="trace req.body.cmd" outcome=testing
record kind=finding title="Command injection via /run cmd param" severity=critical target=e_run class=cmdi cwe=CWE-78 description="child_process.execSync(req.body.cmd) — shell sink" repro="POST /run {cmd:'id;cat /etc/passwd'}" evidence=["routes/run.js:12"] status=confirmed hypothesisId=y3
```
Refute when the input hits `execFile`/parameterized query/validated redirect target. TS types do **not** sanitize at runtime — a `string` is still tainted.
