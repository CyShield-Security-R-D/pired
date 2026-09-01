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
dnsx -l "$PIRED_WORKSPACE/evidence/subs_all.txt" -a -resp-only -silent -o "$PIRED_WORKSPACE/evidence/resolved.txt"
# probe HTTP/HTTPS: status, title, tech, server, redirects, content-length (JSONL output)
httpx -l "$PIRED_WORKSPACE/evidence/subs_all.txt" -sc -title -td -server -location -ip -cl -json -o "$PIRED_WORKSPACE/evidence/httpx.json"
# drop -json for a quick human-readable table to "$PIRED_WORKSPACE/evidence/httpx.txt" instead
```
`httpx` sends 1–2 requests per host — light, but it IS traffic; only run it against in-scope names. Probe **every** in-scope name (don't sample) so no live host is missed. Filter to live: `jq -r 'select(.status_code)|.url' evidence/httpx.json | sort -u`.

## 2. Fingerprint the stack
```bash
whatweb -a3 --color=never -i "$PIRED_WORKSPACE/evidence/resolved.txt" --log-brief "$PIRED_WORKSPACE/evidence/whatweb.txt"
# or per-host, richer:
whatweb -a3 https://HOST | tee -a "$PIRED_WORKSPACE/evidence/whatweb.txt"
curl -sSD - https://HOST -o /dev/null        # raw response headers (Server, X-Powered-By, Set-Cookie flags)
```
Record one tech record per stack element:
```
record kind=host value=app.TARGET ip=203.0.113.10 tech=["nginx","node","react"]
record kind=tech name=nginx version=1.25 host=h1
```

## 3. Screenshot & visual triage
```bash
gowitness scan file -f "$PIRED_WORKSPACE/evidence/resolved.txt" --screenshot-path "$PIRED_WORKSPACE/evidence/shots/" --write-db
# alternatives: aquatone < "$PIRED_WORKSPACE/evidence/resolved.txt" -out "$PIRED_WORKSPACE/evidence/aquatone/"
#               httpx -l "$PIRED_WORKSPACE/evidence/resolved.txt" -ss -srd "$PIRED_WORKSPACE/evidence/shots/"
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
ffuf -u https://IP -H "Host: FUZZ.TARGET" -w SUBWORDLIST -fs <baseline-size> -o "$PIRED_WORKSPACE/evidence/vhosts.json" -of json
```
A vhost that renders a different app than the default is new surface — record it as a host and note the IP it shares.

## 6. Record & hand off
```
record kind=host value=admin.TARGET ip=203.0.113.5 tech=["apache","php"]
record kind=endpoint host=h1 method=GET path=/login auth=none
record kind=finding kind_hint=info title="Staging panel exposed to internet" severity=info target=h2 class=secrets description="dev.TARGET serves an unauthenticated admin build" evidence=["evidence/shots/dev.png"]
```
- Calibrate, don't discard: a 200 from `httpx` can be a soft-404 / WAF splash — open the screenshot or fetch once to confirm real content. If you can't classify a host yet, keep it as a lead (`record kind=host` / note) for `recall gaps`, don't drop it.
- Treat `nuclei -l evidence/resolved.txt` output as leads only; confirm each hit by hand before it becomes a finding — verification sets confidence, it doesn't delete the lead. An unconfirmed-but-plausible hit stays a `status=open` finding at low severity or an `inconclusive` hypothesis.
- When the live set is mapped, run `recall coverage` / `recall gaps`, then move promising hosts into `web-recon` for content/param discovery and the vuln-class skills.

## References
- OWASP WSTG — Information Gathering: Fingerprint Web Server / Application, Enumerate Applications (cite by name)
- httpx — HTTP toolkit (`-sc`/`-title`/`-td`/`-server`/`-location`/`-ip`/`-cl`/`-json`, `-ss` screenshot) — https://github.com/projectdiscovery/httpx
- dnsx — DNS resolver (`-a`, `-resp-only`, `-silent`, `-l`) — https://github.com/projectdiscovery/dnsx
- gowitness — headless screenshot utility (`scan file -f`, `--screenshot-path`, `--write-db`) — https://github.com/sensepost/gowitness
- CWE-538: Insertion of Sensitive Information into Externally-Accessible File or Directory (`.git`/`.env` exposure) — https://cwe.mitre.org/data/definitions/538.html
- CWE-540: Inclusion of Sensitive Information in Source Code — https://cwe.mitre.org/data/definitions/540.html
