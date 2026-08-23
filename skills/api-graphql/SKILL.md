---
name: api-graphql
description: Use when the target exposes GraphQL — introspection, field-level authz/BOLA, resolver injection, mutation abuse, DoS-aware depth/batching/alias attacks.
---

# GraphQL testing

One endpoint, many operations. The bugs are authorization (per field/object) and resource abuse (depth/batching). Batching/deep-query attacks can DoS the server — keep them light and gate anything heavy behind operator approval. Stay in scope.

Record a `hypothesis` with the mapped `class` before each test.

## 1. Introspection (map the whole schema)
```bash
curl -s https://TARGET/graphql -H 'Content-Type: application/json' \
  --data-binary @- <<'JSON' | tee evidence/gql-schema.json
{"query":"query{__schema{queryType{name} mutationType{name} types{name kind fields{name args{name type{name}} type{name kind ofType{name}}}}}}"}
JSON
```
- If introspection is **enabled in production**, that's itself a low/info finding (information exposure, CWE-200) — but it's also your map: record **every** query, mutation, and subscription, and flag any `admin*`/`internal*`/`debug*` fields as endpoints. The full query walks `__schema{ queryType mutationType subscriptionType types{...} directives{...} }` with a recursive `ofType` chain to resolve wrapped types.
- If disabled: don't stop — recover the schema anyway. Apollo and others still leak field names via **suggestion errors** ("did you mean") — mine them mechanically with `clairvoyance`. Try introspection-filter bypasses: insert whitespace/newline/comma between `__schema` and its selection set (flawed regex blocks the literal keyword only), or switch method — `GET ?query=...` or `POST` with `application/x-www-form-urlencoded` when the filter guards only one. Also recover from JS bundles and persisted-query maps. Tools: `graphw00f` (fingerprint engine), `graphql-cop`, InQL (Burp).

## 2. Field-level authz & BOLA/BFLA (API1/API5:2023 · class=authz / idor · CWE-285/639)
- Test **every** field and resolver that takes an id or returns an object — not a sample. Query privileged fields/objects with a low-priv (or no) token: `{ user(id:"<other>"){ email ssn } }`, `{ users{ edges{ node{ passwordHash } } } }`, `{ me{ orders{ ... } } }` swapping ids across every object type.
- Confirm you receive **another user's / admin-only data**. Authz in GraphQL is **per-resolver**, so a blocked top-level query may still leak the same object via a *nested* field (e.g. `post{ author{ email } }`) — walk nested paths exhaustively. Property-level over-exposure of an object you can legitimately fetch is API3:2023 BOPLA (class=dataexposure).
- A field that errors ambiguously (not a clean authz denial) stays an `inconclusive` hypothesis routed via `recall gaps` — don't mark the resolver clear.

## 3. Injection through resolvers (class=injection)
- Resolver args flow to DBs/OS just like REST params — SQL (CWE-89), NoSQL (CWE-943), OS-command (CWE-78). Inject into **every** `filter`, `where`, `search`, `sort`, `id` arg and confirm with a boolean/time/OOB oracle (see **web-injection**). GraphQL only changes the transport, not the sink.

## 4. Mutation abuse (class=massassign / authz)
- Enumerate **all** mutations from the schema: `createUser`, `updateRole`, `deleteX`, `resetPassword`, bulk/import ops. Try privilege-granting inputs (`role:"ADMIN"`, `isAdmin:true`) and objects you shouldn't own — mass assignment here is the write side of API3:2023 BOPLA; a low-priv account reaching an admin-only mutation is API5:2023 BFLA.
- Confirm the state change persists / the privileged mutation succeeds for a low-priv token. Get approval before running destructive mutations.

## 5. Resource abuse — DoS-aware (API4:2023 · class=ratelimit · CWE-770)
Prove the *weakness* with a small probe; do not actually take the service down.
- **Depth/nesting:** deeply recursive relation (`posts{author{posts{author{...}}}}`) — a moderate-depth query timing out worse than a shallow one shows no depth limit. Keep it modest.
- **Aliasing brute force / batching:** many aliased fields in one request bypass per-request rate limits (e.g. brute-force OTP/login by aliasing the same mutation N times, or query batching `[{...},{...}]`). Use a *small* N to demonstrate, then stop.
```bash
# alias-based: several attempts in ONE request (keep count low as a PoC)
curl -s https://TARGET/graphql -H 'Content-Type: application/json' \
 -d '{"query":"mutation{a:login(u:\"x\",p:\"1\"){token} b:login(u:\"x\",p:\"2\"){token}}"}'
```
Confirm: rate limiting is per-request not per-operation (aliases slip through), or no depth/complexity cap exists. Record as a weakness; don't sustain the load.

## 6. Other checks
- CSRF if the endpoint accepts `application/x-www-form-urlencoded` or GET queries (state-changing GET). Verbose errors leaking stack traces/paths. Batching enabled. `null`-origin CORS.

## Calibrate confidence — don't drop leads
- Introspection on ≠ exploitable by itself (map, then find the real authz/injection bug). For DoS-class items, a single slow response can be noise — show it scales with depth/batch size, and keep the PoC minimal.
- Verification calibrates confidence; it never deletes a plausible lead. A resolver you suspect but couldn't prove (ambiguous error, missing second account, throttled probe) stays an `inconclusive` hypothesis or a `status=open` finding at reduced severity, routed via `recall gaps` — never silently cleared.

## Wire into the loop
```
record kind=hypothesis statement="user(id) resolver lacks object authz (BOLA)" target=e_gql class=idor approach="query other user's email with low-priv token" outcome=confirmed evidence=evidence/gql-bola.json
record kind=finding title="GraphQL BOLA: any user reads any user via user(id)" severity=high target=e_gql class=idor cwe=CWE-639 status=confirmed hypothesisId=y3 evidence=["evidence/gql-bola.json"]
record kind=finding title="No query-depth/complexity limit enables DoS" severity=medium target=e_gql class=ratelimit cwe=CWE-770 status=confirmed hypothesisId=y5
record kind=finding title="Introspection enabled in production" severity=info target=e_gql class=secrets cwe=CWE-200 status=confirmed
```
Severity: privileged mutation / cross-tenant BOLA = high/critical; injection = per web-injection; missing depth limit = medium; introspection/verbose errors = low/info.

## References
- PortSwigger Web Security Academy — GraphQL API vulnerabilities (introspection, suggestions, alias-based batching, CSRF, bypasses) — https://portswigger.net/web-security/graphql
- OWASP API Security Top 10 — 2023 (API1/API3/API4/API5:2023) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- CWE-639: Authorization Bypass Through User-Controlled Key (BOLA) — https://cwe.mitre.org/data/definitions/639.html
- CWE-285: Improper Authorization (field/function-level authz) — https://cwe.mitre.org/data/definitions/285.html
- CWE-770: Allocation of Resources Without Limits or Throttling (depth/batch DoS) — https://cwe.mitre.org/data/definitions/770.html
- OWASP Cheat Sheet Series — GraphQL Cheat Sheet (cite by name)
- OWASP WSTG — Testing GraphQL (cite by name)
