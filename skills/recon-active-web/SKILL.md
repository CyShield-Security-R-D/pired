---
name: recon-active-web
description: Use after passive recon to probe which hosts are alive — resolve, httpx-probe, fingerprint, screenshot/triage, and vhost check — then seed inventory.
---

# Light-active web surface mapping

Goal: take the (possibly large) name list from `recon-passive` and turn it into a triaged set of **live** web hosts with tech fingerprints and screenshots, recorded as inventory. This is light-active — a few HTTP requests per host — not fuzzing. Defer deep content discovery / param fuzzing to `web-recon`; here you decide *which* hosts are worth that effort.

Tools run via `bash` and may be missing. If absent: try an alternative, else `record kind=note` the gap and `record kind=blocker` for a critical one. Stay in scope — every host probed must match the authorized scope; drop out-of-scope names.

## 0. Frame it in the loop
- Input: `evidence/subs_all.txt` (from `recon-passive`) or `recall inventory` hosts.
- Save raw probe output to `evidence/`; pull only distilled tables into context.
- Record live hosts + tech; hand strong leads to findings at severity `info` (recon profile) and let `recall gaps` drive deeper testing.

## 1. Resolve, then probe liveness
```bash
# resolve first so you only probe things that exist
dnsx -l evidence/subs_all.txt -a -resp-only -silent -o evidence/resolved.txt
# probe HTTP/HTTPS: status, title, tech, server, redirects, content-length
httpx -l evidence/subs_all.txt -sc -title -td -server -location -ip -cl \
  -o evidence/httpx.txt -json -o evidence/httpx.json
```
`httpx` sends 1–2 requests per host — light, but it IS traffic; only run it against in-scope names. Filter to live: `jq -r 'select(.status_code)|.url' evidence/httpx.json | sort -u`.

## 2. Fingerprint the stack
```bash
whatweb -a3 --color=never -i evidence/resolved.txt --log-brief evidence/whatweb.txt
# or per-host, richer:
whatweb -a3 https://HOST | tee -a evidence/whatweb.txt
curl -sSD - https://HOST -o /dev/null        # raw response headers (Server, X-Powered-By, Set-Cookie flags)
```
Record one tech record per stack element:
```
record kind=host value=app.TARGET ip=203.0.113.10 tech=["nginx","node","react"]
record kind=tech name=nginx version=1.25 host=h1
```

## 3. Screenshot & visual triage
```bash
gowitness scan file -f evidence/resolved.txt --screenshot-path evidence/shots/ --write-db
# alternatives: aquatone < evidence/resolved.txt -out evidence/aquatone/
#               httpx -l evidence/resolved.txt -ss -srd evidence/shots/
```
Skim the gallery to cluster: default/parked pages, login portals, admin panels, dev/staging banners, error pages leaking versions. A dev/staging or admin panel exposed to the internet is a lead worth an `info` finding and a hypothesis.

## 4. Light content-discovery pointers (not deep fuzzing)
Just enough to see if a host is interesting — the full sweep belongs to `web-recon`.
```bash
for p in robots.txt sitemap.xml .well-known/security.txt .git/HEAD .env actuator/health; do
  echo "== $p =="; curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://HOST/$p; done
```
`.git/HEAD` (returns `ref: refs/...`), `.env`, exposed `actuator`/debug endpoints → immediately `record kind=finding` (`class=secrets`, CWE-538/CWE-540) and verify by fetching the content once.

## 5. Virtual hosts
```bash
# establish a baseline size for a bogus Host, then look for hosts that differ
curl -s -o /dev/null -w "%{size_download}\n" -H "Host: nonexistent.TARGET" https://IP
ffuf -u https://IP -H "Host: FUZZ.TARGET" -w SUBWORDLIST -fs <baseline-size> -o evidence/vhosts.json -of json
```
A vhost that renders a different app than the default is new surface — record it as a host and note the IP it shares.

## 6. Record & hand off
```
record kind=host value=admin.TARGET ip=203.0.113.5 tech=["apache","php"]
record kind=endpoint host=h1 method=GET path=/login auth=none
record kind=finding kind_hint=info title="Staging panel exposed to internet" severity=info target=h2 class=secrets description="dev.TARGET serves an unauthenticated admin build" evidence=["evidence/shots/dev.png"]
```
- Verify before recording: a 200 from `httpx` can be a soft-404 / WAF splash — open the screenshot or fetch once to confirm real content.
- Treat `nuclei -l evidence/resolved.txt` output as leads only; confirm each hit by hand before it becomes a finding.
- When the live set is mapped, run `recall coverage` / `recall gaps`, then move promising hosts into `web-recon` for content/param discovery and the vuln-class skills.
