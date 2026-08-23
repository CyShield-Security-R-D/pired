---
name: review-deserialization-ssrf
description: Use when reviewing insecure deserialization (pickle/yaml/Java/PHP/Node), SSRF from user-controlled URLs, and XXE in XML parsers. CWE-502/918/611.
---

# Insecure deserialization, SSRF & XXE review

Goal: trace untrusted input into (a) a deserializer that can instantiate objects/run gadgets, (b) an HTTP/file client whose destination the user controls, or (c) an XML/data parser that resolves external entities. All three turn "just parsing data" into code exec or internal access.

**Untrusted byte/URL sources to trace:** HTTP body/params/headers/cookies, uploaded files, message-queue/webhook payloads, cache/session blobs, imported documents, and anything read back from storage a user could influence. Grep the sinks below exhaustively, then read the source path. Save output to `evidence/`. Verification sets confidence/severity — keep un-disproven leads as `outcome=inconclusive`, never delete them.

## Insecure deserialization — CWE-502 (class `deser` · ASVS V5.5 · OWASP A08)
Vulnerable = **untrusted bytes** fed to a deserializer that reconstructs arbitrary types / runs gadget chains.
```bash
rg -n "pickle\.loads|cPickle|_pickle|\bdill\b|shelve\.|marshal\.loads|jsonpickle|numpy\.load\(|allow_pickle ?= ?True|torch\.load|read_pickle|yaml\.(load|unsafe_load)\(|yaml\.load\([^,)]*\)|readObject\(|ObjectInputStream|XMLDecoder|XStream|readUnshared|enableDefaultTyping|activateDefaultTyping|@JsonTypeInfo|TypeNameHandling|new Yaml\(\)\.load|SnakeYaml|unserialize\(|node-serialize|serialize-to-js|funcster|cryo|Marshal\.load|Oj\.load|Psych\.load|BinaryFormatter|LosFormatter|ObjectStateFormatter|SoapFormatter|NetDataContractSerializer|fromJson\(.*getClass" .
```
- **Python:** `pickle.loads`/`cPickle`/`dill`/`shelve`/`marshal.loads`; `yaml.load(x)` without `Loader=SafeLoader` (use `yaml.safe_load`) / `yaml.unsafe_load`; `jsonpickle`; `numpy.load(..., allow_pickle=True)`; `torch.load`; `pandas.read_pickle`. On request/file/queue data = RCE.
- **Java:** `ObjectInputStream.readObject()` on network/user bytes; Jackson default typing (`enableDefaultTyping`/`activateDefaultTyping`/polymorphic `@JsonTypeInfo`); `XMLDecoder`; `XStream`; SnakeYAML `new Yaml().load()`. Gadget-chain RCE.
- **PHP:** `unserialize()` on user data (POP chains); `yaml_parse`. Prefer `json_decode`.
- **Node:** `node-serialize`/`serialize-to-js`/`funcster`/`cryo` `unserialize()` with an `_$$ND_FUNC$$_` payload.
- **Ruby:** `Marshal.load`, `YAML.load`/`Psych.load` (pre-safe default), `Oj.load` in object mode.
- **.NET:** `BinaryFormatter`, `LosFormatter`, `ObjectStateFormatter`, `SoapFormatter`, `NetDataContractSerializer`, `Json.NET` with `TypeNameHandling.All`.
```python
# VULNERABLE
data = pickle.loads(request.body)
obj  = yaml.load(request.data)           # full loader
# SAFE
obj  = yaml.safe_load(request.data)
data = json.loads(request.body)          # data-only format
```
Verify: is the byte source attacker-reachable, and is the loader the unsafe variant? A `safe_load` / allowlisted type resolver / data-only format (`json.loads`) refutes it.

## SSRF — CWE-918 (class `ssrf` · ASVS V12.6 · WSTG-INPV-19 · OWASP A10)
Vulnerable = a **user-controlled URL/host** passed to a server-side HTTP/file client, webhook, or media/URL fetcher, with no allowlist.
```bash
rg -n "requests\.(get|post|put|head|request)|urllib\.request|urlopen\(|urllib3|httpx\.|aiohttp|http\.client|socket\.connect|axios\(|axios\.(get|post)|fetch\(|node-fetch|got\(|superagent|needle|http\.(get|request)|https\.request|HttpURLConnection|\.openConnection\(|\.openStream\(|RestTemplate|WebClient|OkHttp|HttpClient|ImageIO\.read\(new URL|new URL\(|curl_(init|exec|setopt)|file_get_contents\(\s*[\"']?https?|fopen\(\s*[\"']?https?|fsockopen|stream_context|http\.Get|http\.NewRequest|\.Do\(|net\.Dial|Net::HTTP|open-uri|URI\.(open|parse)|Faraday|HTTParty" .
```
```python
# VULNERABLE — user picks the host the server calls
r = requests.get(request.args["url"])
# server can be steered to http://169.254.169.254/ (cloud metadata), internal admin, file://
```
Also SSRF-prone: webhook/callback URLs, PDF/HTML/SVG/image renderers, URL preview/unfurl, `<img>`/`<object>` proxies, XML `SYSTEM` (see XXE), and open redirects that a fetcher follows. Verify the fix is *real*:
- Allowlist of hosts/schemes (default-deny), **DNS-resolve then check the resolved IP is not private/link-local** (blocks DNS rebinding), no redirect-following into internal ranges, blocked `file://`/`gopher://`/`dict://`/`ftp://`.
- A bare `startswith("http")` or substring/blacklist check does **not** stop SSRF. Bypasses to reason about: `169.254.169.254` and `fd00:ec2::254` (AWS/Azure metadata), `metadata.google.internal` (GCP), `127.0.0.1`/`0.0.0.0`/`localhost`/`[::1]`, decimal/octal/hex IP encodings, `user@host`, `#`/`@` tricks, short-links, and internal CIDRs. High-value confirmation: reaches metadata/`localhost`/internal or `file://`.

## XXE — CWE-611/776 (class `xxe` · ASVS V5.5 · WSTG-INPV-07)
Vulnerable = an XML/SVG/SOAP/SAML parser with **external entity / DTD resolution enabled** parsing user data.
```bash
rg -n "DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|SAXReader|SAXBuilder|TransformerFactory|SchemaFactory|Unmarshaller|XMLReader|etree\.(parse|fromstring|XMLParser)|minidom|pulldom|xml\.sax|lxml|resolve_entities|no_network ?= ?False|simplexml_load|DOMDocument|libxml_disable_entity_loader|LIBXML_NOENT|XmlDocument|XmlReader|DtdProcessing|XmlResolver|Nokogiri.*NOENT|new SAXReader|DOCTYPE|<!ENTITY|SYSTEM " .
```
- **Java:** `DocumentBuilderFactory`/`SAXParserFactory`/`XMLInputFactory`/`TransformerFactory`/JAXB `Unmarshaller`/dom4j `SAXReader` without `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)` or `FEATURE_SECURE_PROCESSING` and `XMLConstants.ACCESS_EXTERNAL_*=""`.
- **Python:** stdlib `xml.etree`/`minidom`/`pulldom`/`sax` are vulnerable on hostile input; `lxml` with `resolve_entities=True`/`no_network=False`. Use `defusedxml`.
- **PHP:** `simplexml_load_*`/`DOMDocument->load` without `LIBXML_NONET`; old libxml before entity loading disabled.
- **.NET:** `XmlDocument`/`XmlReader` with `DtdProcessing.Parse` and a non-null `XmlResolver`.
- **Ruby:** Nokogiri with the `NOENT` option enabled.
```java
// SAFE
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
```
Payload shape to reason about: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>` → file read / SSRF / DoS (billion laughs, CWE-776). Confirm the parser processes external entities/DTDs and the XML is user-supplied.

## Wire into the loop
```
record kind=hypothesis statement="/import parses uploaded XML with default DocumentBuilder" target=e_import class=xxe approach="check parser feature flags" outcome=testing
record kind=finding title="SSRF in webhook URL" severity=high target=e_webhook class=ssrf cwe=CWE-918 description="requests.get(request.json['url']) with no host allowlist; reaches 169.254.169.254" repro="POST /webhook {url:'http://169.254.169.254/latest/meta-data/'}" evidence=["app/webhook.py:44"] status=confirmed hypothesisId=y8
```
Severity: deserialization RCE = critical; SSRF to cloud metadata / internal = high; XXE file read = high; blind/limited XXE or DoS = medium. Refute only when a safe loader, host allowlist (resolve-then-check), or DTD-disabled parser is genuinely in place; otherwise keep the lead.

## References
- OWASP Deserialization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html
- OWASP Server-Side Request Forgery Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP XML External Entity Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html
- MITRE CWE-502 Deserialization of Untrusted Data — https://cwe.mitre.org/data/definitions/502.html
- MITRE CWE-918 Server-Side Request Forgery (SSRF) — https://cwe.mitre.org/data/definitions/918.html
- MITRE CWE-611 Improper Restriction of XML External Entity Reference — https://cwe.mitre.org/data/definitions/611.html
