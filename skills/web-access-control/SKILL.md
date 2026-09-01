---
name: web-access-control
description: Use when testing authorization — IDOR, horizontal/vertical privesc, forced browsing, mass assignment, verb tampering. Classes authz/idor/massassign.
---

# Broken access control & IDOR

The highest-yield, scanner-invisible bug class: the server does the action but never checks *whether this user may*. You need **two accounts** (or an authed + anon pair) to prove it. If you only have one, `record kind=blocker blockerType=credential-request question="Need a second low-priv account for authz diffing"` and route around.

Record a `hypothesis` (`class=authz` or `idor` or `massassign`) per target before testing. Test **every** object-referencing endpoint and privileged action against this class — access control is per-endpoint, so one unchecked route is one missed bug. A cross-user access you suspect but can't fully prove is not dropped: keep it an `inconclusive` hypothesis or an unconfirmed (`status=open`) finding routed via `recall gaps`.

## Set up the differential test
- Account A (victim) and Account B (attacker), each low-priv. Capture both session cookies / bearer tokens as `loot`.
- Baseline: as A, note a resource id you own (`/api/order/1001`). The test = can **B** read/modify it?

## 1. IDOR / object-id tampering (WSTG-ATHZ-04 · CWE-639)
```bash
# request A's object using B's session — least intrusive is a READ (GET)
curl -s -b 'session=<B>' https://TARGET/api/order/1001 -o "$PIRED_WORKSPACE/evidence/idor-B.json"
curl -s -b 'session=<A>' https://TARGET/api/order/1001 -o "$PIRED_WORKSPACE/evidence/idor-A.json"
diff "$PIRED_WORKSPACE/evidence/idor-A.json" "$PIRED_WORKSPACE/evidence/idor-B.json"      # identical body = B read A's data = IDOR
```
- Confirm, don't guess: **B receives A's data** (or the write takes effect), not just a 200. A 200 with an empty/"forbidden" body is not confirmed IDOR — but a response that looks like it may leak and you can't yet prove stays an `inconclusive` hypothesis (surfaced by `recall gaps`), not a discard.
- Try id formats: sequential ints, UUIDs (predictable/v1-timestamped? leaked elsewhere?), hashids, GUIDs, base64/hex, composite keys, negative/`0` ids. Tamper the id in **every** location: path, query, POST/PUT body, JSON, cookie, custom header, `Referer`, and batch/GraphQL node ids.
- Read is least-intrusive; only attempt a WRITE/DELETE on a resource you're authorized to modify or after operator approval — prefer proving read access to another user's object.

## 2. Vertical privesc (WSTG-ATHZ-03 · CWE-284)
- Access admin routes with a normal user's token (`/admin`, `/api/admin/*`, `/internal`). Forced browsing: feed admin paths from recon to `ffuf` with the low-priv cookie and diff against anon.
- Function-level: can a user hit an action the UI hides (e.g. `role=admin` change, other users' settings)?

## 3. Forced browsing / missing function-level auth (WSTG-ATHZ-02)
```bash
ffuf -u https://TARGET/FUZZ -w admin-paths.txt -H 'Cookie: session=<low-priv>' -mc 200,302 -fc 401,403
```
A page reachable without the intended role = access-control gap.

## 4. Mass assignment / over-posting (CWE-915)
- Add unexpected fields to a JSON/form body the client never sends:
```bash
curl -s -b 'session=<B>' -H 'Content-Type: application/json' \
  -d '{"email":"b@x.com","role":"admin","isAdmin":true,"verified":true}' \
  https://TARGET/api/profile -o "$PIRED_WORKSPACE/evidence/massassign.json"
```
Confirm the privileged field actually stuck (re-fetch the profile, check `role`). Source field names from the GET response, API docs, or JS.

## 5. Verb / method tampering (WSTG-INPV-03)
- Auth enforced on `GET` but not `POST`/`PUT`/`DELETE`/`PATCH`? Try `X-HTTP-Method-Override`/`X-Method-Override` and an arbitrary/unknown verb (some frameworks default-allow). Try `HEAD` to bypass a `GET`-only filter. Try flipping content-type (form ↔ JSON) or wrapping ids as arrays.

## Bypass tricks to try before concluding "not vulnerable"
- Path tricks: `/admin/..;/`, `/./admin`, `//admin`, trailing `/`, `%2e`/`%2f`, double-encoding (`%252e`), `..%2f`, case (`/Admin`), extension (`/admin.json`, `/admin;.css`), unicode/overlong, null byte.
- Header overrides: `X-Original-URL`, `X-Rewrite-URL`, `X-Original-Host`, `X-Forwarded-For: 127.0.0.1`, `X-Forwarded-Host`, `Referer` allow-listing.
- Re-run every bypass with the low-priv cookie AND anonymously, diffing against the authorized baseline; a single reachable variant = access-control gap.

## Wire into the loop
```
record kind=hypothesis statement="GET /api/order/{id} is IDOR-able across users" target=e5 class=idor approach="fetch A's order with B's session, diff" outcome=confirmed evidence=evidence/idor.diff
record kind=finding title="IDOR: any user reads any order via /api/order/{id}" severity=high target=e5 class=idor cwe=CWE-639 status=confirmed hypothesisId=y9 repro="1. login B 2. GET /api/order/1001 3. receive A's order" evidence=["evidence/idor-B.json"]
```
Severity: cross-tenant data read/write or vertical privesc to admin = high/critical; low-impact IDOR = medium.

## References
- OWASP WSTG — Authorization Testing (WSTG-ATHZ-01..05), HTTP Verb Tampering (WSTG-INPV-03) — https://owasp.org/www-project-web-security-testing-guide/stable/
- OWASP Top 10 2021 — A01:2021 Broken Access Control — https://owasp.org/Top10/A01_2021-Broken_Access_Control/
- OWASP Authorization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Mass Assignment Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- PortSwigger Web Security Academy — Insecure Direct Object References (IDOR) — https://portswigger.net/web-security/access-control/idor
- CWE-639: Authorization Bypass Through User-Controlled Key — https://cwe.mitre.org/data/definitions/639.html
- CWE-915: Improperly Controlled Modification of Dynamically-Determined Object Attributes (mass assignment) — https://cwe.mitre.org/data/definitions/915.html
