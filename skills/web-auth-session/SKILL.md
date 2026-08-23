---
name: web-auth-session
description: Use when testing login, sessions, password reset, cookies, JWTs, OAuth/OIDC or MFA for auth/session weaknesses. Classes authn/authz.
---

# Authentication & session testing

Goal: break or bypass the identity/session layer safely. Keep credential attacks rate-limited and authorized — brute force can lock accounts, so prefer targeted checks and park a `blocker` for anything noisy.

Record a `hypothesis` (`class=authn`, or `authz`/`ratelimit` where noted) before each test; promote confirmed ones to `finding`; store captured creds/tokens as `loot` by handle. Run **every** auth/session control below through its checks — a skipped surface is a missed bug. A plausible-but-unproven weakness is never dropped: keep it as an `inconclusive` hypothesis or an unconfirmed (`status=open`, honest lower severity) finding routed via `recall gaps`.

## Credential attacks (WSTG-ATHN-02 · WSTG-ATHN-03)
- Test **default creds** first (admin/admin, product docs), then a *small* curated list — never a full rockyou blast without approval.
```bash
# low-and-slow, stop on success; watch for lockout
ffuf -u https://TARGET/login -X POST -d 'user=admin&pass=FUZZ' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -w passwords-short.txt -mc all -fr 'Invalid' -rate 10
# alt: hydra https-post-form / wfuzz
```
- **User enumeration (WSTG-IDNT-04):** differential message, HTTP status, redirect, response length, or timing between valid and invalid usernames — check *every* surface that takes a username: login, password reset, registration, forgot-username, account/profile lookup, and any API. Confirm with a boolean or timing oracle, not one request.
- Missing lockout / no rate limit on `/login` → `class=ratelimit` finding (CWE-307). Before heavy spraying: `record kind=blocker blockerType=approval question="Approve credential spray against /login?"`.

## Password reset flaws (WSTG-ATHN-09 · CWE-640)
- Token predictability (sequential/timestamped/short), token not invalidated after use or after a new request, token doesn't expire, token reuse across accounts, leak via `Host`/`X-Forwarded-Host` header (poisons reset link → **host-header injection**, see web-logic-misc) or via `Referer` to third parties, no rate limit on request/verify, response body reflecting the token, and reset that ignores the old password or accepts an attacker-controlled `email`/`user` param.
- Account takeover via reset = high/critical (CWE-640).

## Session management (WSTG-SESS-02 · WSTG-SESS-03)
- Cookie flags: `Secure`, `HttpOnly`, `SameSite`, plus `Domain`/`Path` scope and `__Host-`/`__Secure-` prefixes. `curl -sSI` and read `Set-Cookie`. Missing HttpOnly on the session cookie (CWE-1004) aids XSS theft; missing/`SameSite=None` without cause aids CSRF.
- **Session fixation** (CWE-384): capture the pre-auth session id, log in, check whether the id **rotates**. No rotation = vulnerable.
- Logout doesn't invalidate the server-side session; session still valid after password change / reset; concurrent sessions not revoked.
- Predictable/short/low-entropy session ids (<64 bits); session id in URL or leaked via `Referer`; token stored in `localStorage` (XSS-readable); session not re-bound after privilege change.

## JWT attacks (WSTG-SESS-10 · CWE-347)
```bash
jwt_tool <TOKEN> -T                                  # tamper mode: inspect/edit any claim
jwt_tool <TOKEN> -X a                                # forge alg:none / unsigned token
jwt_tool <TOKEN> -X k -pk public.pem                 # RS256->HS256 key/algorithm confusion (needs the pubkey)
jwt_tool <TOKEN> -X s                                # spoof JWKS via jku/x5u header
# weak HMAC secret — offline crack, no traffic to target:
hashcat -m 16500 jwt.txt /usr/share/wordlists/rockyou.txt   # or: jwt_tool <TOKEN> -C -d rockyou.txt
```
Check **every** one: `alg:none`/empty-sig accepted; RS256→HS256 confusion (sign HS256 with the public key as the HMAC secret); weak/guessable HMAC secret; `kid` header path traversal / SQLi / command injection to control the key; `jku`/`x5u` pointing to an attacker-hosted JWKS; unverified or stripped signature; missing/ignored `exp`, `nbf`, `aud`, `iss`; claim tampering (`sub`, `role`, `admin`) with a still-accepted token. **Confirm** by presenting the forged token and getting an authenticated response. A decode/tamper alone isn't a confirmed finding — keep it an `inconclusive` hypothesis until the server accepts the forgery; don't drop it.

## OAuth / OIDC pitfalls (WSTG-ATHZ-05)
- `redirect_uri` validation weak (open redirect / token exfil via substring/subdomain/path bypass), missing or reusable `state` (CSRF on the callback), `code` reuse/replay, implicit-flow token leakage in URL/`Referer`, PKCE absent on a public client, `id_token` signature/audience/issuer not validated (or `alg:none`), `nonce` not checked, scope escalation, and account-linking/`login_hint` confusion.

## MFA bypass (WSTG-ATHN-11)
- MFA step skippable by navigating directly to the post-password page, brute-forceable OTP (no rate limit / no attempt lock), OTP reuse or no expiry, predictable/short OTP, response manipulation (`"mfa":false`/status flip), backup-code weaknesses (predictable, unlimited attempts), remember-device cookie forgeable, and MFA enforced on the UI but not the underlying API.

## Wire into the loop
```
record kind=hypothesis statement="/login has no lockout" target=e_login class=ratelimit approach="20 bad logins, watch for block" outcome=testing
record kind=loot handle=cred:web-admin lootType=password username=admin secret=... source=y_login target=h1
record kind=finding title="Session id not rotated on login (fixation)" severity=high target=e_login class=authn cwe=CWE-384 status=confirmed hypothesisId=y3 evidence=["evidence/y3-fixation.http"]
```
Severity guide: auth bypass / ATO = critical/high; fixation, weak JWT = high; missing lockout = medium; cookie-flag gaps = low.

## References
- OWASP WSTG — Authentication (WSTG-ATHN-*), Identity (WSTG-IDNT-04), Session (WSTG-SESS-*), OAuth (WSTG-ATHZ-05) — https://owasp.org/www-project-web-security-testing-guide/stable/
- OWASP Authentication Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- PortSwigger Web Security Academy — JWT attacks (alg confusion, kid, jku) — https://portswigger.net/web-security/jwt
- jwt_tool usage (-T tamper, -X a/k/s exploits, -C crack) — https://github.com/ticarpi/jwt_tool/wiki/Using-jwt_tool
- OWASP Top 10 2021 — A07:2021 Identification and Authentication Failures — https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/
