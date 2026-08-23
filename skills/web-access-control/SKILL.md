---
name: web-access-control
description: Use when testing authorization — IDOR, horizontal/vertical privesc, forced browsing, mass assignment, verb tampering. Classes authz/idor/massassign.
---

# Broken access control & IDOR

The highest-yield, scanner-invisible bug class: the server does the action but never checks *whether this user may*. You need **two accounts** (or an authed + anon pair) to prove it. If you only have one, `record kind=blocker blockerType=credential-request question="Need a second low-priv account for authz diffing"` and route around.

Record a `hypothesis` (`class=authz` or `idor` or `massassign`) per target before testing.

## Set up the differential test
- Account A (victim) and Account B (attacker), each low-priv. Capture both session cookies / bearer tokens as `loot`.
- Baseline: as A, note a resource id you own (`/api/order/1001`). The test = can **B** read/modify it?

## 1. IDOR / object-id tampering (class=idor, CWE-639)
```bash
# request A's object using B's session — least intrusive is a READ (GET)
curl -s -b 'session=<B>' https://TARGET/api/order/1001 -o evidence/idor-B.json
curl -s -b 'session=<A>' https://TARGET/api/order/1001 -o evidence/idor-A.json
diff evidence/idor-A.json evidence/idor-B.json      # identical body = B read A's data = IDOR
```
- Confirm, don't guess: **B receives A's data** (or the write takes effect), not just a 200. A 200 with an empty/"forbidden" body is not IDOR.
- Try id formats: sequential ints, UUIDs (predictable? leaked elsewhere?), hashids, base64. Encode/replace in path, query, body, and JSON.
- Read is least-intrusive; only attempt a WRITE/DELETE on a resource you're authorized to modify or after operator approval — prefer proving read access to another user's object.

## 2. Vertical privesc (class=authz, CWE-284)
- Access admin routes with a normal user's token (`/admin`, `/api/admin/*`, `/internal`). Forced browsing: feed admin paths from recon to `ffuf` with the low-priv cookie and diff against anon.
- Function-level: can a user hit an action the UI hides (e.g. `role=admin` change, other users' settings)?

## 3. Forced browsing / missing function-level auth
```bash
ffuf -u https://TARGET/FUZZ -w admin-paths.txt -H 'Cookie: session=<low-priv>' -mc 200,302 -fc 401,403
```
A page reachable without the intended role = access-control gap.

## 4. Mass assignment / over-posting (class=massassign, CWE-915)
- Add unexpected fields to a JSON/form body the client never sends:
```bash
curl -s -b 'session=<B>' -H 'Content-Type: application/json' \
  -d '{"email":"b@x.com","role":"admin","isAdmin":true,"verified":true}' \
  https://TARGET/api/profile -o evidence/massassign.json
```
Confirm the privileged field actually stuck (re-fetch the profile, check `role`). Source field names from the GET response, API docs, or JS.

## 5. Verb / method tampering
- Auth enforced on `GET` but not `POST`/`PUT`/`DELETE`? Try `X-HTTP-Method-Override: PUT`. Try `HEAD` to bypass a `GET`-only filter. Try changing content-type.

## Bypass tricks to try before concluding "not vulnerable"
- Path tricks: `/admin/..;/`, `/./admin`, `//admin`, trailing `/`, `%2e`, case (`/Admin`), extension (`/admin.json`).
- Header overrides: `X-Original-URL`, `X-Rewrite-URL`, `X-Forwarded-For: 127.0.0.1`, `X-Forwarded-Host`.

## Wire into the loop
```
record kind=hypothesis statement="GET /api/order/{id} is IDOR-able across users" target=e5 class=idor approach="fetch A's order with B's session, diff" outcome=confirmed evidence=evidence/idor.diff
record kind=finding title="IDOR: any user reads any order via /api/order/{id}" severity=high target=e5 class=idor cwe=CWE-639 status=confirmed hypothesisId=y9 repro="1. login B 2. GET /api/order/1001 3. receive A's order" evidence=["evidence/idor-B.json"]
```
Severity: cross-tenant data read/write or vertical privesc to admin = high/critical; low-impact IDOR = medium.
