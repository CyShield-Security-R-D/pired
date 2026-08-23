---
name: web-logic-misc
description: Use for bugs scanners miss — logic flaws, CSRF, open redirect, host-header/CORS/rate-limit issues, races. Classes logic/csrf/redirect/misconfig/ratelimit.
---

# Business logic, CSRF, redirects, CORS, rate limits & races

These need reasoning about *intent*, not payload fuzzing. Reason from the workflow, then prove with a minimal, non-destructive request pair. Stay in scope; don't place real orders or move real money without approval — `record kind=blocker`.

Record a `hypothesis` per idea with the relevant `class` before testing. **Walk every workflow and every state-changing request through these classes** — logic and access bugs don't announce themselves in a param name. A plausible-but-unproven idea is `outcome=inconclusive` (surfaced by `recall gaps`), never silently dropped.

## Business-logic flaws (class=logic · WSTG-BUSL-* · OWASP A04:2021)
Reason about what the app *assumes*, then break the assumption — test each pattern:
- **Quantity/price tampering:** negative quantities, `price=0`/negative, currency swap, rounding/precision abuse, coupon stacking, integer overflow on totals, client-supplied price/total.
- **Step/state skipping:** jump past payment/verification by hitting the final endpoint directly; replay a one-time action; reorder multi-step flows; resume another user's half-finished flow.
- **Parameter injection into trust decisions:** `role`, `isAdmin`, `discount`, `status`, `userId`, `account`, `verified` in bodies/JSON (overlaps mass assignment — see web-access-control).
- **Limit/quota abuse:** exceed per-user caps, reuse single-use tokens/codes, refund/cancel loops, trial/quota reset, referral self-credit.
- **Workflow race** (below).
Prove with a before/after showing the invariant broken (balance, order state, entitlement). Record as a `finding` with a clear `repro`; severity follows business impact.

## CSRF (class=csrf · WSTG-SESS-05 · CWE-352)
- Check **every** state-changing request for an anti-CSRF token and whether it's *validated*: drop it, send an empty token, reuse another user's token, swap POST→GET, change `Content-Type`. Check `SameSite` on the session cookie (Lax/Strict largely mitigates form-CSRF; None does not).
```bash
# does the action succeed with the token removed and only the cookie present?
curl -s -X POST https://TARGET/account/email -b 'session=<victim>' -d 'email=attacker@x.com' -i
```
Confirm: the state change happens with no valid token under cross-origin-plausible conditions. JSON-only endpoints enforcing `Content-Type: application/json` are often not CSRFable — but verify a simple-request form/`text-plain` body isn't accepted before refuting; if unsure, keep it `inconclusive`.

## Open redirect (class=redirect · WSTG-CLNT-04 · CWE-601)
Sinks (enumerate all): `?next=`, `?url=`, `?return=`, `?returnUrl=`, `?redirect=`, `?redirect_uri=`, `?dest=`, `?continue=`, `?callback=`, `?goto=`, `?out=`, `?r=`, post-login/logout `returnUrl`, OAuth `redirect_uri`.
```bash
curl -sI "https://TARGET/login?next=https://evil.example" | grep -i location
```
Confirm: `Location:` (or JS/meta-refresh) sends the browser to your external host. Bypasses to try: `//evil.com`, `https:evil.com`, `/\evil.com`, `\/\/evil.com`, `https://TARGET.evil.com`, `https://evil.com%2f@TARGET`, `https://TARGET@evil.com`, whitelisted-substring (`evil.com/TARGET`), CRLF, double-encoding. Impact rises when it aids OAuth token/code theft or credible phishing.

## Host-header injection (WSTG-INPV-17 · CWE-644)
```bash
curl -s https://TARGET/reset -H 'Host: evil.example' -d 'email=victim@x.com' -i
curl -s https://TARGET/ -H 'X-Forwarded-Host: evil.example' -i
```
Also try `X-Host`, `X-Forwarded-Server`, `X-HTTP-Host-Override`, absolute request-URI, duplicate `Host` headers, and `Host: TARGET:@evil.com`. Look for the injected host reflected in links, **password-reset emails (→ account takeover)**, cache keys (web cache poisoning), `<script>`/resource `src`, or absolute redirects.

## CORS misconfiguration (WSTG-CLNT-07 · CWE-942; origin-reflection = CWE-346)
```bash
curl -sI https://TARGET/api/me -H 'Origin: https://evil.example' | grep -i 'access-control-allow'
```
Vulnerable if the response **reflects an arbitrary Origin** with `Access-Control-Allow-Credentials: true` (attacker reads authed responses), or trusts `null` (sandboxed-iframe origin), or a weak regex (`*.trusted` also matching `trusted.evil.com`, suffix/prefix, unescaped `.`). `ACAO: *` without credentials is usually low/info. Confirm by actually fetching authed data cross-origin; if the reflection is present but you can't prove data read, keep it `inconclusive`.

## Rate limiting / anti-automation (class=ratelimit · CWE-307 / CWE-799)
- Endpoints that should throttle (test each): login, OTP/2FA verify, password reset, email/phone verification, coupon/gift-card redeem, signup, API keys, search/export, payment retry.
- Send N rapid requests; observe any 429/lockout/backoff. Bypass attempts: rotate `X-Forwarded-For`/`X-Real-IP`/`X-Client-IP`, casing/trailing-slash/`%2e` path variants, HTTP/2 multiplexing, spread across equivalent endpoints, rotate session/no-session. Missing limits on OTP → brute-force ATO (high).

## Race conditions (TOCTOU · CWE-362)
- Fire the same request many times **concurrently** to exploit a check-then-act gap: double-spend a coupon/gift card, over-withdraw a balance, bypass a "once" limit, redeem-then-cancel, multi-use of a single-use token.
```bash
# crude burst; better: turbo-intruder single-packet attack / a small parallel script sharing one session
seq 20 | xargs -P20 -I_ curl -s -X POST https://TARGET/redeem -b 'session=<x>' -d 'code=ONE' -o /dev/null -w "%{http_code}\n"
```
Confirm: the limited action succeeds more times than allowed (e.g. coupon redeemed twice). Keep bursts small and non-destructive; get approval before racing anything that spends real value. Inconclusive timing → keep the hypothesis open in `recall gaps`, retry with tighter concurrency, don't refute prematurely.

## Wire into the loop
```
record kind=hypothesis statement="/reset trusts Host header for reset link" target=e_reset class=csrf approach="inject Host: evil, read link target" outcome=confirmed evidence=evidence/hostheader.http
record kind=finding title="Open redirect via ?next enables OAuth token theft" severity=medium target=e_login class=redirect cwe=CWE-601 status=confirmed hypothesisId=y13 evidence=["evidence/redirect.txt"]
record kind=finding title="No rate limit on 2FA verify (brute-forceable OTP)" severity=high target=e_2fa class=ratelimit cwe=CWE-307 status=confirmed hypothesisId=y14
```
Severity: logic flaw follows business impact (can be critical); CORS-credentialed reflect / OTP-brute / host-header→ATO = high; CSRF on sensitive action = medium/high; open redirect = medium (low if purely informational).

## References
- OWASP WSTG — Business Logic Testing (WSTG-BUSL-01..09) — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/
- OWASP WSTG — Testing for Cross Site Request Forgery — WSTG-SESS-05 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Session_Management_Testing/05-Testing_for_Cross_Site_Request_Forgery
- OWASP WSTG — Testing for Client-side URL Redirect — WSTG-CLNT-04 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/04-Testing_for_Client-side_URL_Redirect
- OWASP WSTG — Testing for Host Header Injection — WSTG-INPV-17 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/17-Testing_for_Host_Header_Injection
- OWASP WSTG — Testing Cross Origin Resource Sharing — WSTG-CLNT-07 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/07-Testing_Cross_Origin_Resource_Sharing
- MITRE CWE-352 (CSRF) / CWE-601 (Open Redirect) / CWE-644 (HTTP Header Injection) / CWE-942 (Permissive Cross-domain Policy) / CWE-307 (Excessive Auth Attempts) — https://cwe.mitre.org/data/definitions/352.html
- PortSwigger Web Security Academy — Business logic vulnerabilities — https://portswigger.net/web-security/logic-flaws
- PortSwigger Web Security Academy — HTTP Host header attacks & CORS — https://portswigger.net/web-security/host-header
