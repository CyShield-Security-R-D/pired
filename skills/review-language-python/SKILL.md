---
name: review-language-python
description: Use when auditing Python (Django/Flask/FastAPI) — sources & sinks for cmdi, eval, pickle/yaml deser, Jinja2 SSTI, raw SQL, SSRF, XXE, mass assignment, crypto.
---

# Python / Django / Flask / FastAPI review

Goal: apply the class skills with Python-specific source and sink names. Sources are the request objects and process inputs; sinks are the exec/eval/query/template/fs/crypto APIs below. Aim for **complete** sink coverage — grep every row, then verify the data flow by reading. Pydantic/serializer validation checks *shape/type*, not injection safety.

Tools run via `bash`. Widen with `semgrep --config p/python --config p/django --config p/flask .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "request\.(GET|POST|args|form|json|data|values|files|headers|COOKIES|body|META)|self\.request|sys\.argv|os\.environ|input\(|\.read\(\)" -g '*.py'
```
- Django: `request.GET`, `request.POST`, `request.body`, `request.FILES`, `request.META` (headers), path kwargs.
- Flask: `request.args`, `request.form`, `request.json`, `request.values`, `request.files`, `request.headers`, `request.cookies`.
- FastAPI/Starlette: path/query params, `Body`, `Request`, `Form`, `Header`, `File`/`UploadFile` — Pydantic validates *shape/type*, not safety.

## Command injection (CWE-78)
```bash
rg -n "os\.system\(|os\.popen\(|subprocess\.(run|call|Popen|check_output|check_call)\(|shell\s*=\s*True|commands\.(getoutput|getstatusoutput)|popen2|os\.exec[lv]|pty\.spawn" -g '*.py'
```
`os.system`, `os.popen`, and any `subprocess.*(..., shell=True)` with tainted data = injection. **Safe:** `subprocess.run([prog, arg], shell=False)` with each input as a **separate list element** (never a joined string). `shlex.quote` helps only if applied to every user part. → class `cmdi`.

## Code eval / import / reflection (CWE-94, CWE-95, CWE-470)
```bash
rg -n "\beval\(|\bexec\(|\bcompile\(|__import__\(|importlib\.import_module\(|getattr\(.*request|setattr\(.*request|globals\(\)\[|locals\(\)\[|\bvars\(\)|pickle\.loads" -g '*.py'
```
`eval`/`exec`/`compile` on user data = RCE. `getattr(obj, request.x)` / `setattr` / `__import__(request.x)` / `importlib.import_module(request.x)` is dynamic-attribute/import injection (unsafe reflection). → class `codeinj` / `reflection`.

## Deserialization (CWE-502)
```bash
rg -n "pickle\.loads|pickle\.load|cPickle|_pickle|yaml\.load\(|yaml\.unsafe_load|yaml\.full_load|jsonpickle\.decode|marshal\.loads|dill\.loads|shelve\.open|numpy\.load\(.*allow_pickle\s*=\s*True|pandas\.read_pickle" -g '*.py'
```
`pickle.loads`, `yaml.load(x)` **without** `Loader=SafeLoader` (and `yaml.unsafe_load`/`full_load`), `jsonpickle.decode`, `dill`, `marshal`, `numpy.load(allow_pickle=True)`, `pandas.read_pickle` on untrusted bytes = RCE. **Safe:** `yaml.safe_load`, `json.loads`. → class `deser`; see `review-deserialization-ssrf`.

## Template injection (SSTI) (CWE-1336)
```bash
rg -n "render_template_string|Template\(.*(\+|%|format|f['\x22])|from_string\(|jinja2\.Environment|Environment\(.*autoescape\s*=\s*False|\|\s*safe\b|mark_safe\(|format_html\(.*%|autoescape\s*(off|=\s*False)" -g '*.py'
```
- Flask/Jinja: `render_template_string(user_input)` / `Environment().from_string(user_input)` = SSTI → RCE. Passing user data as a *context variable* to a fixed template is fine.
- Django templates: `|safe`, `mark_safe()`, `{% autoescape off %}`, `format_html` with an unescaped `%` → XSS (auto-escaping bypassed). → class `ssti` (Jinja) / `codeinj` (Django XSS); see `review-injection`.

## SQL injection (CWE-89)
```bash
rg -n "\.raw\(|\.extra\(|RawSQL|\.objects\.raw|cursor\.execute\(.*(%|\+|f['\x22]|format|\.format)|cursor\.executemany\(.*%|connection\.cursor|text\(.*(\+|%|f['\x22])|session\.execute\(.*(\+|%|f)" -g '*.py'
```
Django ORM filters (`.filter(x=v)`) are parameterized and safe; **`.raw()`, `.extra()`, `RawSQL`, and cursor `execute` with `%`/`.format()`/f-string interpolation are not.** SQLAlchemy `text("... "+x)` / `.execute(f"...")` is likewise injectable. **Safe:** DB-API binding `cursor.execute("... WHERE id=%s", [uid])`, SQLAlchemy `text("... :id")` + params, ORM keyword filters. → class `sqli`.

## NoSQL injection (CWE-943)
```bash
rg -n "\x24where|find\(\s*\{?\s*['\x22]?\x24|\.find\(\s*request|\.find_one\(\s*request|\.aggregate\(|json_util|eval\s*:\s*true" -g '*.py'
```
PyMongo/Motor: passing `request.json` straight into a filter allows operator injection (`{"$gt": ""}`, `{"$where": "..."}`). **Safe:** coerce to expected scalar types and validate before querying. → class `sqli`.

## XXE / unsafe XML (CWE-611, CWE-776)
```bash
rg -n "lxml\.etree|etree\.(parse|fromstring|XML)|xml\.dom\.minidom|xml\.sax|xmlrpc|xml\.etree\.ElementTree|pulldom|resolve_entities\s*=\s*True|no_network\s*=\s*False" -g '*.py'
```
`lxml.etree` (external entities/network enabled), stdlib `xml.etree`/`minidom`/`sax`, and `xmlrpc` parsing untrusted XML → file read / SSRF / billion-laughs DoS. **Safe:** parse with **`defusedxml`** (`defusedxml.ElementTree`, `defusedxml.lxml`), or an lxml parser with `resolve_entities=False, no_network=True`. → class `xxe`; see `review-deserialization-ssrf`.

## SSRF (CWE-918)
```bash
rg -n "requests\.(get|post|put|head|delete|request)\(|urllib\.request\.urlopen|urllib2|httpx\.|aiohttp|http\.client|socket\.(create_connection|connect)|verify\s*=\s*False" -g '*.py'
```
`requests.get(request.args['url'])` / `urlopen(user)` with no allowlist → internal-service / cloud-metadata access (`169.254.169.254`). Allowlist hosts, resolve+check the IP, and disable redirects for user URLs. Note `verify=False` also disables TLS validation (crypto). → class `ssrf`; see `review-deserialization-ssrf`.

## Path traversal & file upload (CWE-22, CWE-434)
```bash
rg -n "open\(.*request|send_file\(|send_from_directory\(|FileResponse\(|os\.path\.join\(.*request|pathlib.*request|shutil\.(copy|move)|\.save\(.*filename|secure_filename|request\.files" -g '*.py'
```
- **Traversal:** `open`/`send_file`/`FileResponse`/`os.path.join` with request data → read/write outside base. **Safe:** resolve and confirm the path stays under the intended dir; Flask `send_from_directory` validates, `send_file(user)` does not. → class `pathtrav`; see `review-path-file`.
- **Upload:** saving `request.FILES`/`request.files` under a user-controlled `filename` → arbitrary write. **Safe:** `werkzeug.utils.secure_filename`, generated names, server-side type/size checks. → class `upload`.

## Mass assignment (CWE-915)
```bash
rg -n "fields\s*=\s*['\x22]__all__['\x22]|exclude\s*=|ModelForm|ModelSerializer|setattr\(.*request|\.update\(\*\*request|for .* in request\.(POST|data).*setattr" -g '*.py'
```
Django `ModelForm`/DRF `ModelSerializer` with `fields = '__all__'` (or a blocklist `exclude`) binds *every* model field — an attacker can set `is_staff`/`is_superuser`/`owner_id`. `setattr` loops over `request.data` do the same. **Safe:** an explicit allowlist of `fields`. → class `authz`.

## Weak crypto & randomness (CWE-327, CWE-328, CWE-338, CWE-916)
```bash
rg -n "hashlib\.(md5|sha1)\(|random\.(random|randint|choice|getrandbits)|Crypto\.Cipher.*MODE_ECB|DES\.|ARC4|ssl\._create_unverified_context|CERT_NONE|hashlib\.new\(\s*['\x22](md5|sha1)|make_password.*unsalted" -g '*.py'
```
- `hashlib.md5`/`sha1` for signatures/passwords → CWE-327/328 (use SHA-256+ / HMAC).
- `random.*` for tokens/passwords/session IDs → predictable (CWE-338). **Safe:** the `secrets` module (`secrets.token_urlsafe`, `secrets.choice`).
- DES/RC4/AES-ECB, `ssl._create_unverified_context`/`CERT_NONE` (TLS off). Password storage: use `argon2`/`bcrypt`/PBKDF2, not a bare hash (CWE-916). → class `crypto`; see `review-crypto-secrets-handling`.

## Django/Flask config & secrets (CWE-798, CWE-489)
```bash
rg -n "DEBUG\s*=\s*True|SECRET_KEY\s*=\s*['\x22]|ALLOWED_HOSTS\s*=\s*\[\s*['\x22]\*|@csrf_exempt|SESSION_COOKIE_SECURE\s*=\s*False|CSRF_COOKIE_SECURE\s*=\s*False|SECURE_SSL_REDIRECT\s*=\s*False|CORS_ORIGIN_ALLOW_ALL\s*=\s*True|PICKLE" -g '*.py'
```
`DEBUG=True` in prod (leaks stack traces/settings), hardcoded `SECRET_KEY` (session/signature forgery — cross-ref `review-secrets`), `ALLOWED_HOSTS=['*']`, `@csrf_exempt` on state-changing views, insecure cookie/SSL flags, `CORS_ORIGIN_ALLOW_ALL=True`. → class `secrets` / `authn` / `iac`.

## Auth / authz decorators (CWE-862, CWE-287)
```bash
rg -n "@login_required|@permission_required|@user_passes_test|LoginRequiredMixin|PermissionRequiredMixin|IsAuthenticated|IsAdminUser|permission_classes|AllowAny|@app\.route|@router\.(get|post)|Depends\(" -g '*.py'
```
Compare protected views against unprotected **state-changing** ones (missing authz → IDOR/BOLA). DRF `permission_classes = [AllowAny]` on sensitive actions, or a view with **no** decorator/mixin, is a red flag. FastAPI: an endpoint missing its auth `Depends(...)`. → class `authz`/`authn`; see `review-authz-authn`.

## Wire into the loop
```
record kind=hypothesis statement="search view uses .raw() with string-formatted q" target=e_search class=sqli approach="trace request.GET['q'] -> .raw()" outcome=testing
record kind=finding title="SQLi in search via .raw()" severity=high target=e_search class=sqli cwe=CWE-89 description="Model.objects.raw('...%s' % q) interpolates request.GET['q']" repro="GET /search?q=' OR 1=1--" evidence=["app/views.py:88"] status=confirmed hypothesisId=y2
```
Refute (set `outcome=refuted`) only when a parameterized cursor, `safe_load`, `shell=False` arg-vector, `defusedxml`, a `secrets`/allowlist guard, or a real auth decorator sits in the path. Uncertain-but-plausible → keep `outcome=inconclusive` with a note; never silently drop it.

## References
- Django Security overview — https://docs.djangoproject.com/en/stable/topics/security/
- Flask Security Considerations — https://flask.palletsprojects.com/en/stable/web-security/
- OWASP Deserialization Cheat Sheet (pickle/yaml) — https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html
- defusedxml — Python XML attack defenses — https://pypi.org/project/defusedxml/
- CWE-1336: Improper Neutralization of Special Elements Used in a Template Engine (SSTI) — https://cwe.mitre.org/data/definitions/1336.html
- CWE-338: Use of Cryptographically Weak PRNG — https://cwe.mitre.org/data/definitions/338.html
- Python `secrets` module — https://docs.python.org/3/library/secrets.html
