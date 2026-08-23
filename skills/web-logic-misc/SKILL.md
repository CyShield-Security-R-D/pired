---
name: web-logic-misc
description: Use for bugs scanners miss — logic flaws, CSRF, open redirect, host-header injection, CORS misconfig, rate-limit gaps, races. Classes csrf/redirect/ratelimit.
---

# Business logic, CSRF, redirects, CORS, rate limits & races

These need reasoning about *intent*, not payload fuzzing. Reason from the workflow, then prove with a minimal, non-destructive request pair. Stay in scope; don't place real orders or move real money without approval — `record kind=blocker`.

Record a `hypothesis` per idea with the relevant `class` before testing.

## Business-logic flaws (no single class — pick the closest)
Reason about what the app *assumes*:
- **Quantity/price tampering:** negative quantities, `price=0`, currency swap, coupon stacking, integer overflow on totals.
- **Step/state skipping:** jump past payment/verification by hitting the final endpoint directly; replay a one-time action.
- **Parameter injection into trust decisions:** `role`, `isAdmin`, `discount`, `userId` in bodies (overlaps mass assignment — see web-access-control).
- **Workflow race** (below). 
Prove with a before/after showing the invariant broken (balance, order state). Record as a `finding` with a clear `repro`; severity follows business impact.

## CSRF (class=csrf, CWE-352)
- Check state-changing requests for an anti-CSRF token and whether it's **validated** (drop it / reuse another user's / swap to GET). Check `SameSite` on the session cookie (Lax/Strict largely mitigates form-CSRF).
```bash
# does the action succeed with the token removed and only the cookie present?
curl -s -X POST https://TARGET/account/email -b 'session=<victim>' -d 'email=attacker@x.com' -i
```
Confirm: the state change happens with no valid token and cross-origin-plausible conditions. JSON-only endpoints with enforced `Content-Type: application/json` are often not CSRFable — verify a simple-request form body isn't accepted.

## Open redirect (class=redirect, CWE-601)
Sinks: `?next=`, `?url=`, `?return=`, `?redirect=`, post-login/logout `returnUrl`.
```bash
curl -sI "https://TARGET/login?next=https://evil.example" | grep -i location
```
Confirm: `Location:` (or JS) sends the browser to your external host. Bypasses: `//evil.com`, `https:evil.com`, `/\evil.com`, `https://TARGET.evil.com`, `https://evil.com%2f@TARGET`, whitelisted-substring tricks. Impact rises when it aids OAuth token theft or phishing.

## Host-header injection (CWE-644)
```bash
curl -s https://TARGET/reset -H 'Host: evil.example' -d 'email=victim@x.com' -i
curl -s https://TARGET/ -H 'X-Forwarded-Host: evil.example' -i
```
Look for the injected host reflected in links, password-reset emails (→ ATO), cache keys, or absolute redirects.

## CORS misconfiguration (CWE-942)
```bash
curl -sI https://TARGET/api/me -H 'Origin: https://evil.example' | grep -i 'access-control-allow'
```
Vulnerable if the response **reflects arbitrary Origin** with `Access-Control-Allow-Credentials: true` (attacker reads authed responses), or trusts `null`, or a `*.trusted` regex that also matches `trusted.evil.com`. `ACAO: *` without credentials is usually low/info. Confirm by fetching authed data cross-origin.

## Rate limiting / anti-automation (class=ratelimit, CWE-307/799)
- Endpoints that should throttle: login, OTP/2FA, password reset, coupon, signup, API keys. Send N rapid requests; observe if any 429/lockout appears.
- Bypass attempts: rotate `X-Forwarded-For`, casing/trailing-slash path variants, spread across endpoints. Missing limits on OTP → brute-force ATO (high).

## Race conditions (TOCTOU, CWE-362)
- Fire the same request many times concurrently to exploit a check-then-act gap: double-spend a coupon/gift card, over-withdraw a balance, bypass a "once" limit.
```bash
# crude burst; better: turbo-intruder / a small parallel script sharing one session
seq 20 | xargs -P20 -I_ curl -s -X POST https://TARGET/redeem -b 'session=<x>' -d 'code=ONE' -o /dev/null -w "%{http_code}\n"
```
Confirm: the limited action succeeds more times than allowed (e.g. coupon redeemed twice). Keep bursts small and non-destructive; get approval before racing anything that spends real value.

## Wire into the loop
```
record kind=hypothesis statement="/reset trusts Host header for reset link" target=e_reset class=csrf approach="inject Host: evil, read link target" outcome=confirmed evidence=evidence/hostheader.http
record kind=finding title="Open redirect via ?next enables OAuth token theft" severity=medium target=e_login class=redirect cwe=CWE-601 status=confirmed hypothesisId=y13 evidence=["evidence/redirect.txt"]
record kind=finding title="No rate limit on 2FA verify (brute-forceable OTP)" severity=high target=e_2fa class=ratelimit cwe=CWE-307 status=confirmed hypothesisId=y14
```
Severity: logic flaw follows business impact (can be critical); CORS-credentialed reflect / OTP-brute = high; CSRF on sensitive action = medium/high; open redirect = medium (low if purely informational).
