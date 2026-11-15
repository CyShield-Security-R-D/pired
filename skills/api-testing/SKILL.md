---
name: api-testing
description: Use when testing a REST/JSON API — BOLA/BFLA, excessive data exposure, mass assignment, JSON injection, rate limits, JWT/key handling; OWASP API Top 10 2023.
---

# REST / JSON API abuse (OWASP API Security Top 10 2023)

APIs fail on **authorization**, not exotic payloads. The two top bugs — BOLA and BFLA — need two accounts and a differential test. Prove with least-intrusive reads; gate writes/deletes behind approval. Stay in scope.

Record a `hypothesis` with the mapped `class` before each test. Use `recall next` to walk endpoints systematically — every `{id}` route deserves a BOLA hypothesis, every privileged op a BFLA one.

**Distinguish the authz bugs:** BOLA = wrong *object* — swap an id, get another user's whole record (API1:2023). BFLA = wrong *function* — invoke an admin/privileged operation you shouldn't reach (API5:2023). BOPLA = wrong *property* of an object you may legitimately touch — reading fields you shouldn't see (excessive data exposure) or writing fields you shouldn't set (mass assignment). In the 2023 edition Excessive Data Exposure and Mass Assignment merged into **API3:2023 Broken Object Property Level Authorization**; the old 2019 "API6 mass assignment" slot is now **API6:2023 Unrestricted Access to Sensitive Business Flows** (a different bug).

## BOLA — broken object level authorization (API1:2023 · class=idor · CWE-639) — #1 API bug
Test **every** endpoint that carries an object reference — not a sample. Walk the whole inventory with `recall next`; each `{id}`/`?id=`/body-id/nested-reference route gets its own BOLA hypothesis so `recall gaps` tracks coverage per endpoint. With account **B**, request **A**'s object:
```bash
curl -s -H 'Authorization: Bearer <B>' https://TARGET/api/v1/users/<A_id>/orders -o "$PIRED_WORKSPACE/evidence/bola-B.json"
curl -s -H 'Authorization: Bearer <A>' https://TARGET/api/v1/users/<A_id>/orders -o "$PIRED_WORKSPACE/evidence/bola-A.json"
diff "$PIRED_WORKSPACE/evidence/bola-A.json" "$PIRED_WORKSPACE/evidence/bola-B.json"     # same data => BOLA
```
- Confirm B **receives A's data** (or the write lands), not merely a 200. Test the id in path, query, JSON body, and nested references. Try guessable ids (sequential ints, leaked/enumerable UUIDs, base64/hashids). Cover every object type (orders, invoices, messages, files), not just users.
- **Don't drop a maybe:** a 403/empty for B but a suspicious partial leak, or an id you couldn't get a second account to compare — record an `inconclusive` hypothesis (or a `status=open` finding at reduced severity) so `recall gaps` re-routes it, rather than marking the endpoint clear.

## BFLA — broken function level authorization (API5:2023 · class=authz · CWE-285)
- Enumerate **every** privileged/admin operation from the spec, JS, and version diffs, then call each with a normal user's token — cover the whole set, not one example: `POST /api/v1/admin/users`, `DELETE /api/v1/users/{id}`, role/status changes, bulk/export ops. Try HTTP methods the UI never issues (`PUT`/`PATCH`/`DELETE` on read-only routes; `OPTIONS` to reveal `Allow:`).
- Confirm the privileged action executes (or returns admin-only data) for the low-priv token. If a call returns an ambiguous 500/redirect rather than a clean allow/deny, keep it as an `inconclusive` hypothesis for follow-up — don't clear it.

## Excessive data exposure — BOPLA read side (API3:2023 · class=dataexposure · CWE-213)
- Endpoints returning full objects where the client filters client-side. Inspect raw JSON for fields the UI never shows: `password_hash`, `ssn`, internal flags, other users' PII, tokens.
```bash
curl -s -H 'Authorization: Bearer <B>' https://TARGET/api/v1/me | jq 'keys'
```
Confirm sensitive fields are actually returned. Severity scales with data sensitivity. (In the 2023 edition, Excessive Data Exposure and Mass Assignment merged into **API3:2023 BOPLA** — the read and write sides of object-property authorization.)

## Mass assignment — BOPLA write side (API3:2023 · class=massassign · CWE-915)
Add fields the client shouldn't set:
```bash
curl -s -H 'Authorization: Bearer <B>' -H 'Content-Type: application/json' \
  -d '{"email":"b@example.com","role":"admin","balance":99999,"emailVerified":true}' \
  -X PATCH https://TARGET/api/v1/me
```
Re-fetch and confirm the privileged field persisted. Source field names from GET responses / the OpenAPI schema.

## Injection via JSON (class=injection)
- Same oracles as web-injection, in JSON values *and* keys — SQL (CWE-89), NoSQL (CWE-943), and OS-command (CWE-78) injection all reach their sinks through API params. NoSQL operator injection is common here: `{"email":{"$ne":null}}`, `{"$gt":""}`. Type juggling: send a number/array/object where a string is expected. Confirm with a boolean/time/OOB oracle — see **web-injection**. GraphQL/REST only changes the transport, not the sink, so probe every string-ish arg (`filter`, `search`, `sort`, `id`).

## Unrestricted resource consumption (API4:2023 · class=ratelimit · CWE-770, CWE-307)
- Blast auth, OTP, search, and expensive endpoints; watch for 429. Missing limits enable credential stuffing and enumeration. Also check: unbounded page size (`?limit=1000000`), no pagination cap, expensive filters. Keep bursts modest and non-destructive.

## Broken authentication & key handling (API2:2023 · API8:2023 misconfig · class=authn)
- JWT: `alg:none`, RS256→HS256 confusion, weak secret (`hashcat -m 16500`), missing `exp`, unverified signature, `kid` injection — full playbook in **web-auth-session**. Confirm by getting an authed response with a forged/tampered token.
- API keys: in URL/query (logged, cacheable), never rotated, shared across tenants, over-privileged, valid after "revocation". Test another tenant's key against your objects.

## Other API Top 10 2023 classes (route to the right skill)
- **API7:2023 SSRF** (class=ssrf) — any endpoint where the server fetches a client-supplied URL/host; see **web-ssrf**.
- **API9:2023 Improper Inventory Management** (class=inventory) — shadow/legacy/undocumented/old-version endpoints that skip current authz; enumerate them in **api-recon** and test each here.
- **API10:2023 Unsafe Consumption of APIs** (class=unsafe-consumption) — the API trusts an upstream/third-party response without validating it (injection, SSRF, or data poisoning via the integration).

## Calibrate confidence — don't drop leads
- 200 ≠ vulnerable. Confirmation requires the *other user's data returned*, the *privileged action succeeding*, or the *sensitive field present*. Re-run to rule out caching/flakiness; a generic error is not proof.
- Verification **calibrates** — it never silently deletes a plausible lead. If a bug is likely but unproven (couldn't get a second account, ambiguous response, blocked by a missing token), downgrade rather than discard: keep an `inconclusive` hypothesis or a `status=open` finding at reduced severity so `recall gaps` re-routes it. Missing a real authz bug is worse than an extra flag to triage.

## Wire into the loop
```
record kind=hypothesis statement="GET /users/{id}/orders is BOLA" target=e2 class=idor approach="fetch A's orders with B's bearer, diff" outcome=confirmed evidence=evidence/bola.diff
record kind=finding title="BOLA: any user reads any user's orders" severity=high target=e2 class=idor cwe=CWE-639 status=confirmed hypothesisId=y2 repro="Bearer(B) GET /api/v1/users/<A>/orders returns A's data" evidence=["evidence/bola-B.json"]
record kind=finding title="BFLA: normal user can DELETE any account" severity=critical target=e5 class=authz cwe=CWE-285 status=confirmed hypothesisId=y4
```
Severity: BFLA to destructive/admin action = critical; BOLA cross-tenant data = high; excessive exposure of PII = medium/high; missing rate limit = medium.

## References
- OWASP API Security Top 10 — 2023 (API1:2023 … API10:2023) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- CWE-639: Authorization Bypass Through User-Controlled Key (BOLA/IDOR) — https://cwe.mitre.org/data/definitions/639.html
- CWE-285: Improper Authorization (BFLA) — https://cwe.mitre.org/data/definitions/285.html
- CWE-915: Improperly Controlled Modification of Dynamically-Determined Object Attributes (mass assignment) — https://cwe.mitre.org/data/definitions/915.html
- CWE-770: Allocation of Resources Without Limits or Throttling — https://cwe.mitre.org/data/definitions/770.html
- OWASP Cheat Sheet Series — REST Security & Authorization Cheat Sheets (cite by name)
- OWASP WSTG — API testing & Authorization/IDOR testing (cite by name)
