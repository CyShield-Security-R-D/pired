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

## 2. Headers & TLS
```bash
curl -sSI https://TARGET | tee evidence/headers.txt   # look for missing CSP/HSTS/XFO, verbose Server/X-Powered-By
testssl.sh --quiet --color 0 https://TARGET | tee evidence/tls.txt   # or: sslscan / nmap --script ssl-enum-ciphers
```
Missing security headers → low/info findings (`class=secrets` or a headers class). Weak TLS/cipher → note it.

## 3. Content discovery (directories & files)
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

## 4. Robots / sitemap / well-known
```bash
for p in robots.txt sitemap.xml .well-known/security.txt .git/HEAD .env; do
  echo "== $p =="; curl -s -o /dev/null -w "%{http_code}\n" https://TARGET/$p; done
```
`.git/`, `.env`, backups → immediately record as `finding` (`class=secrets`, CWE-538/CWE-540).

## 5. Spider & JS endpoint harvest
```bash
katana -u https://TARGET -jc -d 3 -o evidence/katana.txt          # crawl + parse JS
gau TARGET >> evidence/urls.txt ; waybackurls TARGET >> evidence/urls.txt   # historical URLs (passive)
# pull endpoints/secrets out of JS bundles
linkfinder -i "https://TARGET/main.js" -o cli
```
Grep harvested URLs for params: `grep -oE '[?&][a-zA-Z0-9_]+=' evidence/urls.txt | sort -u`.

## 6. Virtual hosts & subdomains
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
Then propose first hypotheses against high-value endpoints (auth, params, file ops) and let `recall next` drive testing. A quick baseline scan (`nuclei -u https://TARGET -o evidence/nuclei.txt`) is fine for known-CVE/misconfig triage, but verify every hit by hand before recording a finding — treat scanner output as leads, not findings.
