---
name: web-recon
description: Use when starting a web target — fingerprint tech, discover content/endpoints/params, harvest JS routes, map vhosts/TLS/headers, and seed the inventory.
---

# Web recon & attack-surface mapping

Goal: turn a URL/host into a recorded inventory of hosts, endpoints, params, and tech so `recall gaps` has a surface to reason over. Passive/light-active first; nothing destructive.

Tools run via `bash` and may be absent. If a needed tool is missing: try an alternative, else `record kind=note` the gap and (for a critical one) `record kind=blocker blockerType=input question="install ffuf?"`. Stay inside scope — every target must match the authorized scope.

## 0. Frame it in the loop
- Seed `record kind=host value=TARGET` first; use the returned id (e.g. `h1`) as `host=` on endpoints.
- Save raw scan output to `evidence/`; pull only distilled lines into context.
- After mapping, run `recall coverage` / `recall gaps` to see what to test next.

## 1. Fingerprint tech (WSTG-INFO-02 · WSTG-INFO-08)
```bash
# fast probe + tech + status/title
httpx -u https://TARGET -sc -title -td -server -ip -o evidence/httpx.txt
whatweb -a3 https://TARGET | tee evidence/whatweb.txt
curl -sSD - https://TARGET -o /dev/null        # response headers only
```
Record: `record kind=tech name=nginx version=1.25 host=h1`, one per stack element (server, framework, CMS, WAF, language).

## 2. Headers & TLS (WSTG-CONF-07 · WSTG-CRYP-01)
```bash
curl -sSI https://TARGET | tee evidence/headers.txt   # missing CSP/HSTS/X-Frame-Options/X-Content-Type-Options/Referrer-Policy/Permissions-Policy; verbose Server/X-Powered-By
testssl.sh --quiet --color 0 https://TARGET | tee evidence/tls.txt   # or: sslscan / nmap --script ssl-enum-ciphers
```
Missing security headers → low/info findings (`class=misconfig`). Weak TLS/cipher/protocol (SSLv3, TLS 1.0/1.1, weak/NULL ciphers, expired/self-signed cert) → `class=misconfig`, note the specific weakness.

## 3. Content discovery (WSTG-CONF-04)
```bash
ffuf -u https://TARGET/FUZZ -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt \
  -mc all -fc 404 -recursion -recursion-depth 2 -t 40 -o evidence/ffuf-dirs.json -of json
# extension sweep
ffuf -u https://TARGET/FUZZ -w /usr/share/seclists/Discovery/Web-Content/raft-medium-files.txt \
  -e .php,.bak,.old,.zip,.txt,.json -mc 200,301,302,401,403 -t 40
# alternatives: feroxbuster -u https://TARGET -w WORDLIST -x php,bak  |  gobuster dir -u https://TARGET -w WORDLIST
```
- Calibrate against noise: if `/randomxyz123` returns 200, the app soft-404s — use `-fs <size>` or `-fw <words>` to filter, not just `-fc 404`.
- SecLists paths vary; if absent, `record kind=blocker` asking for a wordlist, or fall back to a smaller built-in list.

## 4. Robots / sitemap / well-known (WSTG-INFO-03)
```bash
for p in robots.txt sitemap.xml .well-known/security.txt .git/HEAD .git/config .svn/entries \
  .env .env.local .DS_Store backup.zip config.php.bak crossdomain.xml swagger.json openapi.json \
  api-docs graphql actuator/health; do
  echo "== $p =="; curl -s -o /dev/null -w "%{http_code}\n" https://TARGET/$p; done
```
- Exposed `.git/` / `.svn/` repo (dump it with git-dumper) → `class=secrets`, CWE-527.
- `.env`, backups, `.DS_Store`, config dumps → `class=secrets`, CWE-538. Secrets/keys embedded in reachable source/JS → CWE-540.
- `swagger.json`/`openapi.json`/`graphql` introspection → not a finding by itself but a rich endpoint/param source — feed it into the inventory.

## 5. Spider & JS endpoint harvest (WSTG-INFO-05 · WSTG-INFO-06)
```bash
katana -u https://TARGET -jc -d 3 -o evidence/katana.txt          # crawl + parse JS
gau TARGET >> evidence/urls.txt ; waybackurls TARGET >> evidence/urls.txt   # historical URLs (passive)
# pull endpoints/secrets out of JS bundles
linkfinder -i "https://TARGET/main.js" -o cli
```
Grep harvested URLs for params: `grep -oE '[?&][a-zA-Z0-9_]+=' evidence/urls.txt | sort -u`.

## 6. Virtual hosts & subdomains (WSTG-INFO-04)
```bash
subfinder -d TARGET -all -o evidence/subs.txt          # passive subdomain enum (in-scope root only)
ffuf -u https://TARGET -H "Host: FUZZ.TARGET" -w SUBWORDLIST -fs <baseline-size>   # vhost brute
dnsx -l evidence/subs.txt -a -resp -o evidence/resolved.txt
```
Only probe subdomains that fall inside the authorized scope.

## 7. Record the surface
For each live route:
```
record kind=endpoint host=h1 method=GET path=/api/user params=["id"] auth=session
record kind=param name=id endpoint=e1 location=query
```
Record **every** live route and param you find (don't sample — an unmapped endpoint is a class the tester never checks). Then propose first hypotheses against high-value endpoints (auth, params, file ops) and let `recall next` drive testing. A quick baseline scan (`nuclei -u https://TARGET -o evidence/nuclei.txt`) is fine for known-CVE/misconfig triage, but verify every hit by hand before recording a **confirmed** finding — treat scanner output as leads. A plausible-but-unverified hit is not dropped: keep it as an `inconclusive` hypothesis or an unconfirmed (`status=open`) finding routed via `recall gaps`.

## References
- OWASP WSTG — Information Gathering & Configuration testing (WSTG-INFO-*, WSTG-CONF-*, WSTG-CRYP-01) — https://owasp.org/www-project-web-security-testing-guide/stable/
- CWE-527: Exposure of Version-Control Repository to an Unauthorized Control Sphere — https://cwe.mitre.org/data/definitions/527.html
- CWE-538: Insertion of Sensitive Information into Externally-Accessible File or Directory — https://cwe.mitre.org/data/definitions/538.html
- OWASP Top 10 2021 — A05:2021 Security Misconfiguration — https://owasp.org/Top10/A05_2021-Security_Misconfiguration/
- httpx (ProjectDiscovery) flag reference — https://github.com/projectdiscovery/httpx
- ffuf usage & filter/match flags — https://github.com/ffuf/ffuf
