---
name: review-authz-authn
description: Use when reviewing access control & auth in source — missing authz, IDOR, broken auth, insecure session/JWT, client-side checks. CWE-862/863/639/287.
---

# Access control & authentication review

Goal: find handlers that act on data or privileged actions **without proving the caller is allowed**. Unlike injection there is no single grep-able sink — you compare *which endpoints enforce a check* against *which don't*, and whether object lookups verify ownership.

**This is the harness's #1 miss category.** SAST/semgrep CANNOT find missing access control, IDOR, or broken auth — they have no model of who *should* be allowed. So this is a manual, per-endpoint pass, and it is mandatory: **visit EVERY endpoint enumerated in `review-methodology` §2** — routes, controllers, GraphQL resolvers, RPC methods, admin/CLI actions, queue consumers — and answer the four questions in §1 for each. A missed endpoint here is a missed high-severity bug. Sources: any authenticated route, any user-supplied object id, any privileged action.

Tools run via `bash` and may be absent. Grep to enumerate routes and guards, then read each handler. Save route inventories to `evidence/`.

## 1. Enumerate every route and diff it against the guards
```bash
# every handler / privileged action
rg -n "@app\.route|app\.(get|post|put|delete|patch)|router\.(get|post|put|delete|patch)|@(Get|Post|Put|Delete|Patch|RequestMapping|GetMapping|PostMapping)|def (create|update|destroy|delete|edit|admin)|@Resolver|@Mutation|@Query" .
# where the guards ARE (build the allowlist of protected routes) — framework-agnostic
rg -n "login_required|permission_required|user_passes_test|@PreAuthorize|@Secured|@RolesAllowed|permission_classes|IsAuthenticated|IsAdminUser|has_perm|is_staff|is_superuser|isAuthenticated|requireAuth|ensureLoggedIn|current_user|req\.user|ctx\.user|hasRole|hasAuthority|authorize|can\?|policy|Pundit|load_and_authorize_resource|before_action.*authenticate|middleware\(.*auth|verifyToken|checkPermission|\[Authorize" .
```
For **each** endpoint, answer in order — a failure at any step is a candidate finding:
1. **Authentication present?** Is the caller proven logged in at all? An unauthenticated state-changing or data-returning endpoint = CWE-306 Missing Authentication.
2. **Function-level authorization?** Is the caller's *role/permission* checked for THIS action? (admin panels, `/users/:id/delete`, `/config`, billing) — CWE-862/863.
3. **Object-level authorization (ownership)?** When it loads/mutates an object by a user id, is the query scoped to the caller or is ownership re-checked after fetch? — CWE-639 (IDOR/BOLA).
4. **Correct & consistent?** Guard runs *before* the sensitive action; applied to every sibling method (not just `GET`); enforced server-side (not a client-only `if isAdmin`); role read from a trusted session, not a spoofable header/param/body field.

## Missing / incorrect function-level authorization — CWE-862/863 (class `authz` · ASVS V4.1 · WSTG-ATHZ-02)
- Admin/privileged endpoints (`/admin`, `/users/:id/delete`, `/config`, `/export`, feature flags) with no role check.
- Auth applied inconsistently — some methods on a controller guarded, a sibling not; a new route added without the guard.
- Check present but wrong: verifies *authenticated* but not *authorized for this role/resource*; role compared with `==` to a client-supplied field (`req.body.role`, `X-Role` header); check placed *after* the mutation already ran; default-allow instead of default-deny.
```python
# VULNERABLE — any logged-in user can delete anyone
@app.post("/users/<uid>/delete")
@login_required
def delete(uid): db.delete(uid)          # authenticated, but no "am I admin / is uid mine?"
```

## Privilege escalation — CWE-269 (class `authz` · WSTG-ATHZ-03)
- **Vertical:** a normal user reaching admin functionality (unguarded admin route, role settable by the client).
- **Horizontal:** a user acting as another user of the same role (see IDOR).
- **Mass assignment / auto-binding (CWE-915):** a create/update binds request fields wholesale (`User(**request.json)`, `update_attributes(params)`, `Object.assign(user, req.body)`) letting the caller set `is_admin`, `role`, `balance`, `user_id`. Grep: `update_attributes|Object\.assign\(|\*\*request|\bsetattr\(|ModelForm|body\)` and check for a field allowlist.

## IDOR / BOLA — CWE-639 (class `authz` · ASVS V4.2 · WSTG-ATHZ-04)
The highest-yield code-review bug: an object is fetched/mutated **by a user-supplied id with no ownership/tenant check**.
```bash
rg -n "findById|findByPk|get_object_or_404|\.get\(pk=|\.get\(id=|Model\.find\(|\.findOne\(\s*\{ ?_?id|params\[:id\]|req\.params\.id|request\.args\.get\(.id|request\.json\[.id|WHERE id ?= ?|getById|loadById|\.load\(|findResource" .
```
```js
// VULNERABLE — no check that order belongs to req.user
app.get('/orders/:id', auth, (req,res)=> res.json(db.orders.findById(req.params.id)))
// SAFE — scoped to the owner / tenant
db.orders.findOne({ _id: req.params.id, userId: req.user.id })
```
Verify: does the query constrain by the current user/tenant (`AND owner_id = ?`), or is a post-fetch `if (obj.owner !== req.user.id) 403` present? If neither — and the id is guessable/enumerable (sequential int, UUID leaked elsewhere, in a list response) — it's IDOR. Applies to every object type: orders, messages, files, invoices, API keys, sub-resources (`/orgs/:o/projects/:p`). Check nested/tenant scoping too.

## Broken authentication — CWE-287 (class `authn` · ASVS V2 · WSTG-ATHN)
- Auth bypass: a header/param that skips login (`X-Auth: true`, `?admin=1`, `debug=1`, a backdoor account), `authenticated=true`/`isAdmin` trusted from the client, an SSO/`assertion` accepted without signature check.
- Missing/blank-password paths, empty password accepted, default/hardcoded/skeleton creds (cross-ref `review-secrets`).
- Password compared with `==`/`.equals` on a hash or plaintext (timing + no hashing); no verification of the *current* password on change/reset; user-controllable account lookup that returns another account.
- No rate limiting / lockout / MFA on login, password reset, OTP, or token endpoints (anti-automation, ASVS V2.2) — a business-logic authn gap SAST can't see.
```bash
rg -n "password ?== ?|\.equals\(.*password|== *req\.(body|query)\.(password|token)|checkPassword|verify_password|compare\(|bcrypt\.compare|is_valid|authenticate\(|passport\." .
```

## Session & JWT handling — CWE-384/613/347 (class `authn` · ASVS V3 · WSTG-SESS)
```bash
rg -n "jwt\.(decode|verify|sign)|algorithms?=|alg['\"]?\s*[:=]|verify(_signature)?\s*=\s*(False|false)|none['\"]|set_cookie|Set-Cookie|SameSite|HttpOnly|Secure|max_?age|session\[|session\.|express-session|cookie-session|secret:|signed:" .
```
- **JWT (CWE-347):** `verify=False` / signature not checked / `algorithms` including `none` / `alg` taken from the token (alg-confusion RS→HS) / secret hardcoded or weak / no `exp`/`nbf`/`aud`/`iss` validation.
- **Session (CWE-384/613):** session id not rotated on login (fixation); no server-side invalidation on logout; overlong/absent expiry; predictable session id (cross-ref `review-crypto-secrets-handling`).
- **Cookies:** session cookie missing `HttpOnly` / `Secure` / `SameSite`; auth token stored in `localStorage`; CSRF token absent on state-changing routes (CWE-352).

## Client-side / decorative checks — CWE-602
UI-only gating (`if (user.isAdmin) renderButton()`) with the server accepting the action regardless = the check is decorative. Always trace the *server* handler; a role check that lives only in frontend/mobile code, or is enforced only by hiding a link, is a finding.

## Wire into the loop
```
record kind=hypothesis statement="GET /orders/:id fetches by id without owner check" target=e_orders class=authz approach="read handler, look for userId scope" outcome=testing
record kind=finding title="IDOR: any user can read any order" severity=high target=e_orders class=authz cwe=CWE-639 description="findById(req.params.id) not scoped to req.user.id" repro="GET /orders/1001 as user with order 42" evidence=["routes/orders.js:23"] status=confirmed hypothesisId=y6
```
Severity: auth bypass / admin-action-without-check = critical/high; IDOR reading or mutating other users' data = high; missing rate-limit/HttpOnly = medium/low. Refute only when a genuine server-side ownership/role check sits in the path — record that reasoning. If you inspected an endpoint but couldn't confirm the guard's correctness, keep it `outcome=inconclusive` and leave the cell open in `recall gaps`; never assume an endpoint is safe by omission.

## References
- OWASP Authorization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP WSTG v4.2 Authorization Testing (WSTG-ATHZ-01..04) — https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/05-Authorization_Testing/
- OWASP Top 10 2021 A01 Broken Access Control — https://owasp.org/Top10/A01_2021-Broken_Access_Control/
- MITRE CWE-862 Missing Authorization — https://cwe.mitre.org/data/definitions/862.html
- MITRE CWE-639 Authorization Bypass Through User-Controlled Key — https://cwe.mitre.org/data/definitions/639.html
- MITRE CWE-287 Improper Authentication — https://cwe.mitre.org/data/definitions/287.html
