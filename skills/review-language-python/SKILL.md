---
name: review-language-python
description: Use when auditing Python (Django/Flask/FastAPI) — sources, subprocess/eval, pickle/yaml, Jinja2 SSTI, raw SQL/.raw()/.extra(), SSRF, DEBUG/secrets.
---

# Python / Django / Flask / FastAPI review

Goal: apply the class skills with Python-specific source and sink names. Sources are the request objects and process inputs; sinks are the exec/eval/query/template/fs APIs below.

Tools run via `bash`. Widen with `semgrep --config p/python --config p/django --config p/flask .` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## Sources (untrusted input)
```bash
rg -n "request\.(GET|POST|args|form|json|data|values|files|headers|COOKIES|body)|sys\.argv|os\.environ|input\(" -g '*.py'
```
- Django: `request.GET`, `request.POST`, `request.body`, `request.FILES`, `request.META` (headers), path kwargs.
- Flask: `request.args`, `request.form`, `request.json`, `request.values`, `request.files`, `request.headers`, `request.cookies`.
- FastAPI: path/query params, `Body`, `Request`, `Form`, `Header` — note Pydantic validates *shape/type*, not safety.

## Command execution — CWE-78
```bash
rg -n "os\.system\(|os\.popen\(|subprocess\.(run|call|Popen|check_output).*shell\s*=\s*True|commands\.|popen2|os\.exec" -g '*.py'
```
`os.system`, `os.popen`, and `subprocess.*(..., shell=True)` with tainted data = injection. Safe: `subprocess.run([prog, arg], shell=False)` with the input as a **separate list element**.

## Code eval / import — CWE-94
```bash
rg -n "\beval\(|\bexec\(|compile\(|__import__\(|importlib\.import_module\(.*request|getattr\(.*request|globals\(\)\[" -g '*.py'
```
`eval`/`exec`/`compile` on user data = RCE. `getattr(obj, request.x)` / `__import__(request.x)` is dynamic-attribute/import injection.

## Deserialization — CWE-502
```bash
rg -n "pickle\.loads|cPickle|yaml\.load\((?!.*Loader\s*=\s*(Safe|yaml\.Safe))|jsonpickle|marshal\.loads|dill\.loads|shelve\.open" -g '*.py'
```
`pickle.loads`, `yaml.load(x)` without `SafeLoader`, `jsonpickle`, `dill` on untrusted bytes = RCE. Safe: `yaml.safe_load`, `json.loads`.

## Template injection (SSTI) — CWE-1336
```bash
rg -n "render_template_string|Template\(.*\+|from_string|jinja2\.Environment|\|\s*safe\b|mark_safe\(|format_html\(.*%|autoescape\s*=\s*False" -g '*.py'
```
- Flask/Jinja: `render_template_string(user_input)` = SSTI → RCE. Passing user data as a *context variable* to a fixed template is fine.
- Django: `|safe`, `mark_safe()`, `autoescape off`, `format_html` with unescaped `%` → XSS (escaping bypassed).

## SQL — CWE-89
```bash
rg -n "\.raw\(|\.extra\(|cursor\.execute\(.*(%|\+|f\"|f'|format)|RawSQL|connection\.cursor|\.objects\.raw" -g '*.py'
```
- Django ORM filters are parameterized and safe; **`.raw()`, `.extra()`, `RawSQL`, and cursor `execute` with `%`/f-string interpolation** are not. Safe cursor form: `cursor.execute("... WHERE id=%s", [uid])` (DB-API binding, not `%` formatting).

## SSRF & filesystem
```bash
rg -n "requests\.(get|post|put|head)\(|urllib\.request\.urlopen|httpx\.|aiohttp|open\(.*request|send_file\(|os\.path\.join\(.*request|FileResponse\(" -g '*.py'
```
- SSRF: `requests.get(request.args['url'])` with no allowlist → `review-deserialization-ssrf`.
- Path: `open`/`send_file`/`os.path.join` with request data → `review-path-file`.

## Django/Flask config & secrets
```bash
rg -n "DEBUG\s*=\s*True|SECRET_KEY\s*=\s*[\"']|ALLOWED_HOSTS\s*=\s*\[\s*['\"]\*|CSRF_|SECURE_SSL|@csrf_exempt|PICKLE|SESSION_COOKIE_SECURE\s*=\s*False" -g '*.py'
```
- `DEBUG=True` in production (leaks stack traces/settings), hardcoded `SECRET_KEY` (session forgery — cross-ref `review-secrets`), `ALLOWED_HOSTS=['*']`, `@csrf_exempt` on state-changing views, `SESSION_COOKIE_SECURE=False`.

## Auth decorators
```bash
rg -n "@login_required|@permission_required|@user_passes_test|LoginRequiredMixin|PermissionRequiredMixin|IsAuthenticated|permission_classes" -g '*.py'
```
Compare protected views against unprotected state-changing ones (missing authz → `review-authz-authn`). DRF views with `permission_classes = [AllowAny]` on sensitive actions are a red flag.

## Wire into the loop
```
record kind=hypothesis statement="search view uses .raw() with string-formatted q" target=e_search class=sqli approach="trace request.GET['q'] -> .raw()" outcome=testing
record kind=finding title="SQLi in search via .raw()" severity=high target=e_search class=sqli cwe=CWE-89 description="Model.objects.raw('...%s' % q) interpolates request.GET['q']" repro="GET /search?q=' OR 1=1--" evidence=["app/views.py:88"] status=confirmed hypothesisId=y2
```
Refute when a parameterized cursor, `safe_load`, `shell=False` arg-vector, or a real auth decorator sits in the path.
