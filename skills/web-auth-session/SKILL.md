---
name: web-auth-session
description: Use when testing login, sessions, password reset, cookies, JWTs, OAuth/OIDC or MFA for auth/session weaknesses. Classes authn/authz.
---

# Authentication & session testing

Goal: break or bypass the identity/session layer safely. Keep credential attacks rate-limited and authorized — brute force can lock accounts, so prefer targeted checks and park a `blocker` for anything noisy.

Record a `hypothesis` (`class=authn`) before each test; promote confirmed ones to `finding`; store captured creds/tokens as `loot` by handle.

## Credential attacks (safe, rate-limited)
- Test **default creds** first (admin/admin, product docs), then a *small* curated list — never a full rockyou blast without approval.
```bash
# low-and-slow, stop on success; watch for lockout
ffuf -u https://TARGET/login -X POST -d 'user=admin&pass=FUZZ' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -w passwords-short.txt -mc all -fr 'Invalid' -rate 10
# alt: hydra https-post-form / wfuzz
```
- **User enumeration:** differential response/timing between valid and invalid usernames (login, reset, register). Confirm with a boolean or timing oracle, not one request.
- Missing lockout / no rate limit on `/login` → `class=ratelimit` finding (CWE-307). Before heavy spraying: `record kind=blocker blockerType=approval question="Approve credential spray against /login?"`.

## Password reset flaws
- Token predictability (sequential/timestamped), token not invalidated after use, token leak via `Host`/`X-Forwarded-Host` header (poisons reset link → **host-header injection**, see web-logic-misc), no rate limit, response reflecting the token.
- Account takeover via reset = high/critical (CWE-640).

## Session management
- Cookie flags: `Secure`, `HttpOnly`, `SameSite`. `curl -sSI` and read `Set-Cookie`. Missing HttpOnly on the session cookie (CWE-1004) aids XSS theft.
- **Session fixation** (CWE-384): capture the pre-auth session id, log in, check whether the id **rotates**. No rotation = vulnerable.
- Logout doesn't invalidate server-side session; token still valid after password change.
- Predictable/short session ids; session id in URL.

## JWT attacks (jwt_tool / hashcat)
```bash
jwt_tool <TOKEN> -T                                  # tamper/inspect all claims
jwt_tool <TOKEN> -X a                                # alg:none / alg confusion probe
# weak HMAC secret — offline crack, no traffic to target:
hashcat -m 16500 jwt.txt /usr/share/wordlists/rockyou.txt
```
Check for: `alg:none` accepted (CWE-347); RS256→HS256 confusion signing with the public key as HMAC secret; weak/guessable HMAC secret; `kid` path traversal/SQLi; `jku`/`x5u` pointing to attacker JWKS; unverified signature; missing `exp`. **Confirm** by presenting the forged token and getting an authenticated response — a decode alone is not a finding.

## OAuth / OIDC pitfalls
- `redirect_uri` validation weak (open redirect / token exfil), missing/`state` reuse (CSRF on the callback), `code` reuse/replay, implicit-flow token leakage, PKCE absent on a public client, `id_token` audience/issuer not validated, scope escalation.

## MFA bypass
- MFA step skippable by navigating directly post-password, brute-forceable OTP (no rate limit), OTP reuse, response manipulation (`"mfa":false`), backup-code weaknesses, remember-device cookie forgeable.

## Wire into the loop
```
record kind=hypothesis statement="/login has no lockout" target=e_login class=ratelimit approach="20 bad logins, watch for block" outcome=testing
record kind=loot handle=cred:web-admin lootType=password username=admin secret=... source=y_login target=h1
record kind=finding title="Session id not rotated on login (fixation)" severity=high target=e_login class=authn cwe=CWE-384 status=confirmed hypothesisId=y3 evidence=["evidence/y3-fixation.http"]
```
Severity guide: auth bypass / ATO = critical/high; fixation, weak JWT = high; missing lockout = medium; cookie-flag gaps = low.
