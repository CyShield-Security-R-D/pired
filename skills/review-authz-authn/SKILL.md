---
name: review-authz-authn
description: Use when reviewing access control & auth in source — missing authz, IDOR, broken auth, insecure session/JWT, client-side checks. CWE-862/863/639/287.
---

# Access control & authentication review

Goal: find handlers that act on data or privileged actions **without proving the caller is allowed**. Unlike injection, there is no single sink to grep — you compare *which routes enforce a check* against *which don't*, and whether object lookups verify ownership. Sources: any authenticated route, any user-supplied object id.

Tools run via `bash` and may be absent. Grep to enumerate routes, then read each handler. Save route inventories to `evidence/`.

## 1. Enumerate every route and its guard
```bash
# list handlers, then look for the auth guard on each
rg -n "@app\.route|app\.(get|post|put|delete)|router\.(get|post|put|delete)|@(Get|Post|Put|Delete|RequestMapping)" .
# where ARE the checks? (build the allowlist of protected routes)
rg -n "login_required|@login_required|permission_required|@PreAuthorize|@RolesAllowed|isAuthenticated|requireAuth|ensureLoggedIn|current_user|req\.user|hasRole|authorize|can\?|before_action.*authenticate|middleware\(.*auth" .
```
Diff the two lists: a route that mutates state or returns user data but appears in the first grep and **not** near an auth check is a candidate for **missing authorization (CWE-862)**.

## 2. Missing / incorrect function-level authz — CWE-862/863
- Admin endpoints (`/admin`, `/users/:id/delete`, `/config`) with no role check.
- Auth applied inconsistently — some methods on a controller guarded, a sibling not.
- Check present but wrong: verifies *authenticated* but not *authorized for this resource/role*; role compared with `==` to a spoofable field; check after the sensitive action already ran.
```python
# VULNERABLE — any logged-in user can delete anyone
@app.post("/users/<uid>/delete")
@login_required
def delete(uid): db.delete(uid)          # no "is uid mine / am I admin?"
```

## 3. IDOR / BOLA — CWE-639 (class `authz`)
The highest-yield code-review bug: an object is fetched **by a user-supplied id with no ownership/tenant check**.
```bash
rg -n "findById|get_object_or_404|\.get\(pk=|WHERE id ?= ?|params\[:id\]|req\.params\.id|request\.args\.get\(.id|\.findOne\(\{ ?_?id" .
```
```js
// VULNERABLE — no check that order belongs to req.user
app.get('/orders/:id', auth, (req,res)=> res.json(db.orders.findById(req.params.id)))
// SAFE — scoped to the owner
db.orders.findOne({ _id: req.params.id, userId: req.user.id })
```
Verify: does the query/lookup constrain by the current user/tenant, or is a post-fetch `if (obj.owner !== req.user) 403` present? If neither, and the id is guessable/enumerable (sequential int, exposed elsewhere) → IDOR finding.

## 4. Broken authentication — CWE-287
- Auth bypass: a header/param that skips login (`X-Auth: true`, `?admin=1`, debug backdoor), `authenticated=true` trusted from the client.
- Missing/blank password paths, empty-password accepted, hardcoded/skeleton creds (cross-ref `review-secrets`).
- Password compared with `==` on a hash (timing), or plaintext compare; no verification of the current password on change.

## 5. Session & JWT handling
```bash
rg -n "jwt\.(decode|verify|sign)|algorithms=|verify=False|verify_signature|set_cookie|Set-Cookie|SameSite|HttpOnly|Secure|session\[|express-session|secret:" .
```
- JWT: `verify=False` / `algorithms` including `none` / signature not checked / secret hardcoded / `alg` taken from the token / no `exp` validation (CWE-347).
- Cookies: session cookie missing `HttpOnly`/`Secure`/`SameSite`; session id not rotated on login (fixation, CWE-384); overlong/no expiry.

## 6. Client-side privilege checks
UI-only gating (`if (user.isAdmin) renderButton()`) with the server accepting the action regardless = the check is decorative. Trace the *server* handler; a role check that lives only in frontend code is a finding.

## 7. Wire into the loop
```
record kind=hypothesis statement="GET /orders/:id fetches by id without owner check" target=e_orders class=authz approach="read handler, look for userId scope" outcome=testing
record kind=finding title="IDOR: any user can read any order" severity=high target=e_orders class=authz cwe=CWE-639 description="findById(req.params.id) not scoped to req.user.id" repro="GET /orders/1001 as user with order 42" evidence=["routes/orders.js:23"] status=confirmed hypothesisId=y6
```
Severity: auth bypass / admin-action-without-check = critical/high; IDOR reading other users' data = high; missing HttpOnly = low. Refute when a genuine server-side ownership/role check sits in the path.
