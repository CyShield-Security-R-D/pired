---
name: review-deserialization-ssrf
description: Use when reviewing insecure deserialization (pickle/yaml/Java/PHP/Node), SSRF from user-controlled URLs, and XXE in XML parsers. CWE-502/918/611.
---

# Insecure deserialization, SSRF & XXE review

Goal: trace untrusted input into (a) a deserializer that can instantiate objects/run gadgets, (b) an HTTP/file client whose destination the user controls, or (c) an XML parser that resolves external entities. All three turn "just parsing data" into code exec or internal access.

Tools run via `bash` and may be absent — grep the sink, then read the source path. Save output to `evidence/`.

## Insecure deserialization — CWE-502 (class `deser`)
Vulnerable = **untrusted bytes** fed to a deserializer that reconstructs arbitrary types.
```bash
rg -n "pickle\.loads|cPickle|yaml\.load\(|yaml\.full_load|readObject\(|ObjectInputStream|XMLDecoder|unserialize\(|node-serialize|serialize-javascript|Marshal\.load|__reduce__|jackson.*enableDefaultTyping|ReadObject|BinaryFormatter|fromJson\(.*getClass" .
```
- **Python:** `pickle.loads`, `yaml.load(x)` without `Loader=SafeLoader` (use `yaml.safe_load`), `jsonpickle`. Any of these on request/file/queue data = RCE.
- **Java:** `ObjectInputStream.readObject()` on network/user bytes; Jackson with default typing / `enableDefaultTyping`; `XMLDecoder`. Gadget-chain RCE.
- **PHP:** `unserialize()` on user data (POP chains). Prefer `json_decode`.
- **Node:** `node-serialize`/`serialize-javascript` `unserialize()` with an `_$$ND_FUNC$$_` payload; `funcster`. `.NET`: `BinaryFormatter`, `LosFormatter`, `TypeNameHandling.All`.
```python
# VULNERABLE
data = pickle.loads(request.body)
obj  = yaml.load(request.data)           # full loader
# SAFE
obj  = yaml.safe_load(request.data)
data = json.loads(request.body)          # data-only format
```
Verify: is the byte source attacker-reachable, and is the loader the unsafe variant? A `safe_load`/allowlisted type resolver refutes it.

## SSRF — CWE-918 (class `ssrf`)
Vulnerable = a **user-controlled URL/host** passed to a server-side HTTP client, file fetch, or webhook, with no allowlist.
```bash
rg -n "requests\.(get|post)\(|urllib\.request|urlopen\(|httpx\.|http\.get|axios\(|fetch\(|got\(|HttpURLConnection|RestTemplate|WebClient|curl_exec|file_get_contents\(https?|ImageIO\.read\(new URL|new URL\(" .
```
```python
# VULNERABLE — user picks the host the server calls
r = requests.get(request.args["url"])
# server can be steered to http://169.254.169.254/ (cloud metadata), internal admin, file://
```
Verify the fix is real: allowlist of hosts/schemes, DNS-resolve-then-check-not-private, blocked `file://`/`gopher://`, no redirect-following into internal ranges. A bare "startswith http" check does **not** stop SSRF (still hits internal http). High-value confirmation: reaches `169.254.169.254`, `localhost`, internal CIDRs, or `file://`.

## XXE — CWE-611 (class `xxe`)
Vulnerable = an XML parser with **external entity / DTD resolution enabled** parsing user XML.
```bash
rg -n "DocumentBuilderFactory|SAXParser|XMLReader|XMLInputFactory|etree\.(parse|fromstring)|lxml|libxml_disable_entity_loader|resolveEntities|new SAXReader|XmlDocument|DTD|DOCTYPE|SYSTEM " .
```
- **Java:** `DocumentBuilderFactory`/`SAXParserFactory`/`XMLInputFactory` without `setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)` or `FEATURE_SECURE_PROCESSING`.
- **Python:** stdlib `xml.etree`/`minidom` are vulnerable on hostile input; `lxml` with `resolve_entities=True`/`no_network=False`. Use `defusedxml`.
- **PHP:** old libxml before entity loading disabled.
```java
// SAFE
dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
```
Payload shape to reason about: `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>` → file read / SSRF / DoS (billion laughs). Confirm the parser processes external entities and the XML is user-supplied.

## Wire into the loop
```
record kind=hypothesis statement="/import parses uploaded XML with default DocumentBuilder" target=e_import class=xxe approach="check parser feature flags" outcome=testing
record kind=finding title="SSRF in webhook URL" severity=high target=e_webhook class=ssrf cwe=CWE-918 description="requests.get(request.json['url']) with no host allowlist; reaches 169.254.169.254" repro="POST /webhook {url:'http://169.254.169.254/latest/meta-data/'}" evidence=["app/webhook.py:44"] status=confirmed hypothesisId=y8
```
Severity: deserialization RCE = critical; SSRF to cloud metadata / internal = high; XXE file read = high; blind/limited XXE or DoS = medium. Refute when a safe loader, host allowlist, or DTD-disabled parser is in place.
