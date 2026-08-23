---
name: recon-passive
description: Use at the very start of an engagement to map targets with zero direct traffic — CT-log/passive subdomains, DNS, ASN/netblocks, and leak hunting.
---

# Passive recon & OSINT (no-touch)

Goal: expand a root domain / org name into a recorded inventory of subdomains, IPs, netblocks, and technology **without sending a single packet to the target**. Every source here queries a third party (CT logs, passive DNS, search engines), not the target — so it stays quiet and low-risk. Confirm liveness later in `recon-active-web`; here you only harvest and `record`.

Tools run via `bash` and may be missing. If one is absent: try an alternative below, else `record kind=note` the gap and, for a critical tool, `record kind=blocker blockerType=input question="install subfinder?"`. Never install heavy tooling unprompted.

## 0. Frame it in the pired loop
- Work only on roots inside the authorized scope (`recall`/`pired.scope.json`). Passive sources can surface out-of-scope siblings — record them as notes, do not probe them.
- Save raw output to `evidence/`; pull only distilled, deduped lines into context.
- `record kind=host value=<sub> ip=<ip>` for each discovered name; `record kind=tech` for stacks you learn passively. Then hand liveness/fingerprint to `recon-active-web`.

## 1. Subdomain enumeration (passive sources only)
```bash
subfinder -d TARGET -all -silent -o evidence/subs_subfinder.txt
amass enum -passive -d TARGET -o evidence/subs_amass.txt          # passive flag = no brute, no resolution
# crt.sh certificate-transparency pull (no target traffic)
curl -s "https://crt.sh/?q=%25.TARGET&output=json" | jq -r '.[].name_value' | sed 's/\*\.//g' | sort -u > evidence/subs_crtsh.txt
# merge + dedupe
cat evidence/subs_*.txt | sort -u > evidence/subs_all.txt && wc -l evidence/subs_all.txt
```
- `amass enum -passive` and `subfinder` never touch the target; `amass enum -active`/`-brute` DO — do not use them in a passive pass.
- Run **several** sources and merge — no single source is complete, so breadth here directly bounds how much surface downstream testing can cover. Alternatives / additions if a tool is missing: `assetfinder --subs-only TARGET`, `github-subdomains -d TARGET`, `subfinder -all` (all sources), or crt.sh alone. A name you can't confirm yet still gets recorded as a lead — never drop it just because one source missed it.

## 2. DNS records (resolvers, not the target)
```bash
# resolve names against public resolvers — queries hit DNS infra, not the app
dnsx -l evidence/subs_all.txt -a -aaaa -cname -resp -silent -o evidence/dns_resolved.txt
# per-record types for the apex
dig +noall +answer TARGET ANY; dig +short MX TARGET; dig +short TXT TARGET   # SPF/DMARC/DKIM, verification tokens
```
Record resolved hosts: `record kind=host value=api.TARGET ip=203.0.113.10`. TXT records often leak vendors (SaaS, mail, cloud) — note them as tech/leads.

## 3. ASN / netblock discovery
```bash
# org -> ASN -> CIDRs (feeds network-host-discovery, but only scan CIDRs the scope authorizes)
whois -h whois.radb.net -- "-i origin AS12345" | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]+' | sort -u
amass intel -org "Acme Corp"                 # org name -> ASN candidates
# reverse-DNS a netblock passively via the resolver
dnsx -ptr -l evidence/netblock_ips.txt -resp -silent
```
Cross-check owned IP ranges against scope CIDRs. An ASN belonging to a shared cloud provider is NOT authorization to scan the whole ASN — only the scoped CIDRs/IPs.

## 4. Historical endpoints & content (Wayback / urlscan)
```bash
gau TARGET > evidence/urls_gau.txt ; waybackurls TARGET > evidence/urls_wayback.txt   # archived URLs, no target hit
cat evidence/urls_*.txt | sort -u > evidence/urls_all.txt
# mine params + interesting paths from archives
grep -oE '\?[^ ]+' evidence/urls_all.txt | grep -oE '[?&][a-zA-Z0-9_]+=' | sort -u   # candidate params
grep -iE '\.(json|xml|bak|old|zip|sql|env|config)' evidence/urls_all.txt | sort -u
# urlscan.io historical scans of the domain (passive, from their DB)
curl -s "https://urlscan.io/api/v1/search/?q=domain:TARGET" | jq -r '.results[].page.url' | sort -u
```
These are candidate endpoints/params only — do NOT request them here (that is active). Stash them; `recon-active-web` probes liveness.

## 5. Tech / leak hunting (high level, low-touch)
- **Google/Bing dorking** (search engine, not target): `site:TARGET`, `site:TARGET ext:sql|env|log|bak`, `site:TARGET inurl:admin|login|api`, `intitle:"index of"`. Record interesting hits as notes/leads.
- **Public cloud storage**: guess and check bucket names derived from the org (`ORG`, `ORG-prod`, `ORG-backups`) via provider list URLs; an open/listed bucket is a `finding` (`class=secrets`, CWE-200). Enumerate names from a wordlist tool if available; do not brute aggressively.
- **Code / secret leaks**: search public GitHub/GitLab for the org and domains (`org:ORG`, `"TARGET" password`), and run `trufflehog github --org=ORG` / `gitleaks` against public repos if authorized. A live key is `record kind=loot` + a `finding` (CWE-798) — and often a `blocker` to confirm the operator owns that repo.
- **Third-party exposure**: certificate SANs (from §1) and reverse-IP lookups reveal co-hosted apps; keep only in-scope ones.

## 6. Record & hand off
```
record kind=host value=admin.TARGET ip=203.0.113.5
record kind=tech name=Cloudflare host=h1
record kind=note text="Wayback shows /legacy/api/*; 4 buckets guessed, acme-backups listable"
```
Then run `recall inventory` to confirm the surface landed, and move to `recon-active-web` to probe which of these hosts are actually alive. Anything already proven exposed (open bucket, live leaked key) goes straight to `record kind=finding` at the appropriate severity; everything else stays inventory/leads — nothing discovered is discarded.

## References
- PTES — Intelligence Gathering (OSINT phasing & passive-source discipline) — cite by name
- OWASP WSTG — Information Gathering (WSTG-INFO-*) — cite by name
- subfinder — passive subdomain enumeration (`-all`, `-silent`, `-d`, `-o`) — https://github.com/projectdiscovery/subfinder
- dnsx — DNS toolkit (`-a`/`-aaaa`/`-cname`/`-ptr`, `-resp`, `-silent`) — https://github.com/projectdiscovery/dnsx
- crt.sh — Certificate Transparency log search (JSON output) — cite by name
- CWE-200: Exposure of Sensitive Information to an Unauthorized Actor (open bucket/leak) — https://cwe.mitre.org/data/definitions/200.html
- CWE-798: Use of Hard-coded Credentials (live leaked key) — https://cwe.mitre.org/data/definitions/798.html
