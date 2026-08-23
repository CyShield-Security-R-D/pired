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
- If introspection is **enabled in production**, that's itself a low/info finding (information exposure, CWE-200) — but it's also your map: record queries, mutations, and any `admin*`/`internal*`/`debug*` fields as endpoints.
- If disabled: recover the schema via field suggestions ("did you mean") with `clairvoyance`, or from JS/persisted queries. Tools: `graphw00f` (fingerprint engine), `graphql-cop`/InQL (Burp) for quick audits.

## 2. Field-level authz & BOLA (class=authz / idor, CWE-285/639)
- Query privileged fields/objects with a low-priv (or no) token: `{ user(id:"<other>"){ email ssn } }`, `{ users{ edges{ node{ passwordHash } } } }`, `{ me{ orders{ ... } } }` swapping ids.
- Confirm you receive **another user's / admin-only data**. Authz in GraphQL is per-resolver, so a blocked top-level query may still leak via a nested field — test nested paths too.

## 3. Injection through resolvers (classes sqli/nosqli/cmdi)
- Resolver args flow to DBs/OS just like REST params. Inject into `filter`, `where`, `search`, `id` args and confirm with a boolean/time/OOB oracle (see **web-injection**). GraphQL only changes the transport, not the sink.

## 4. Mutation abuse (class=massassign / authz)
- Enumerate mutations from the schema: `createUser`, `updateRole`, `deleteX`, `resetPassword`. Try privilege-granting inputs (`role:"ADMIN"`, `isAdmin:true`) and objects you shouldn't own.
- Confirm the state change persists / the privileged mutation succeeds for a low-priv token. Get approval before running destructive mutations.

## 5. Resource abuse — DoS-aware (class=ratelimit, CWE-770)
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

## Confirm vs false positive
- Introspection on ≠ exploitable by itself (map, then find the real authz/injection bug). For DoS-class items, a single slow response can be noise — show it scales with depth/batch size, and keep the PoC minimal.

## Wire into the loop
```
record kind=hypothesis statement="user(id) resolver lacks object authz (BOLA)" target=e_gql class=idor approach="query other user's email with low-priv token" outcome=confirmed evidence=evidence/gql-bola.json
record kind=finding title="GraphQL BOLA: any user reads any user via user(id)" severity=high target=e_gql class=idor cwe=CWE-639 status=confirmed hypothesisId=y3 evidence=["evidence/gql-bola.json"]
record kind=finding title="No query-depth/complexity limit enables DoS" severity=medium target=e_gql class=ratelimit cwe=CWE-770 status=confirmed hypothesisId=y5
record kind=finding title="Introspection enabled in production" severity=info target=e_gql class=secrets cwe=CWE-200 status=confirmed
```
Severity: privileged mutation / cross-tenant BOLA = high/critical; injection = per web-injection; missing depth limit = medium; introspection/verbose errors = low/info.
