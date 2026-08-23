---
name: review-injection
description: Use when tracing injection sinks in source — SQL, OS command, code eval, template (SSTI), NoSQL, LDAP/XPath. CWE-89/78/94/917.
---

# Injection review — SQL / command / code / template / NoSQL / LDAP / XPath

Goal: find where untrusted input reaches an interpreter without parameterization or escaping. The bug is **string-building a query/command/template from tainted data** where a safe parameterized API exists.

**Sources to treat as tainted (enumerate all — recall depends on it):** HTTP query/body/form/JSON/headers/cookies/path segments/multipart filenames; CLI args & env vars; stdin & files; DB rows written by users; message-queue / webhook / event payloads; deserialized objects; imported documents; any value that transited a client. A hardcoded constant is not a bug — everything else is a candidate until proven safe.

Tools run via `bash` and may be absent — grep first, semgrep to widen (`review-sast-semgrep`), then verify by reading. Save output to `evidence/`. Verification sets confidence/severity; a plausible-but-untraced hit is kept as `outcome=inconclusive`, never deleted.

## SQL injection — CWE-89 (class `sqli` · WSTG-INPV-05 · ASVS V5.3)
Vulnerable = tainted value **concatenated / interpolated / formatted** into SQL. Safe = placeholders (`?`, `$1`, `:name`) with a params array, or a vetted ORM bind. Column/table/`ORDER BY`/`LIMIT` can't be parameterized → require an allowlist.
```bash
# tainted SQL string-building
rg -n "SELECT .*(\+|\|\||\bformat\b|%|f\"|f'|\.format\(|\$\{|#\{|`)" -g '*.{js,ts,py,java,go,rb,php,cs,scala,kt}'
# query-executing sinks (then check whether the argument was string-built)
rg -n "execute(many)?\(|\.query\(|rawQuery|createStatement|prepareStatement|\.raw\(|db\.query|cursor\.execute|session\.execute|knex\.raw|sequelize\.query|\$queryRawUnsafe|queryRawUnsafe|mysqli?_query|pg_query|\.extra\(|find_by_sql|createNativeQuery|createQuery|jdbcTemplate|\.Raw\(|\.Exec\(" .
# Java / .NET string-built SQL
rg -n "String\.format.*(SELECT|INSERT|UPDATE|DELETE)|\"SELECT\" *\+|SqlCommand\(|CommandText *=" -g '*.{java,cs}'
# Ruby ActiveRecord interpolation
rg -n "where\(\".*#\{|find_by_sql|\.order\(\".*#\{|sanitize_sql" -g '*.rb'
```
```python
# VULNERABLE
cur.execute("SELECT * FROM users WHERE name='%s'" % name)
cur.execute(f"SELECT * FROM users WHERE id={uid}")
# SAFE
cur.execute("SELECT * FROM users WHERE name=%s", (name,))
```
Verify: is the interpolated var attacker-controlled? ORM `.where("x = " + v)`, `.raw()`, `.extra()`, `queryRawUnsafe` with concat are also vulnerable; `.where({x:v})` / bound params are safe.

## OS command injection — CWE-78 (class `cmdi` · WSTG-INPV-12 · ASVS V5.3.8)
Vulnerable = tainted data in a command run **through a shell**. Safe = arg-vector exec (no shell) with a fixed program.
```bash
rg -n "os\.system|os\.popen|subprocess\.(call|run|Popen|check_output|getoutput)|shell=True|commands\.getoutput|\bpopen\(|Runtime\.getRuntime\(\)\.exec|ProcessBuilder|child_process\.(exec|execSync|spawn|execFile)|\{ ?shell: ?true|shell_exec|\bexec\(|\bsystem\(|passthru\(|proc_open|pcntl_exec|IO\.popen|Open3\.|%x\{|`[^`]*\$|exec\.Command" .
```
```js
// VULNERABLE — string goes to /bin/sh
child_process.exec(`convert ${req.query.file} out.png`)
// SAFE — arg vector, no shell
child_process.execFile('convert', [req.query.file, 'out.png'])
```
Verify: `exec`/`system`/`shell=True`/backticks/`sh -c` with a tainted substring = vulnerable. `execFile`/`spawn`/`subprocess.run([...], shell=False)` with the input as a **separate array element** is safe — but still check argument injection (a leading `-` that becomes a flag).

## Code injection / eval — CWE-94/95 (class `codeinj` · WSTG-INPV-11 · ASVS V5.2.4)
```bash
rg -n "\beval\(|\bexec\(|\bcompile\(|execfile|new Function\(|\bFunction\(|vm\.(runIn|compileFunction)|setTimeout\(\s*[\"'`]|setInterval\(\s*[\"'`]|\brequire\(\s*[^'\"]|import\(\s*[^'\"]|assert\(|create_function|preg_replace\(.*/e|call_user_func|instance_eval|class_eval|__import__|getattr\(" .
```
Tainted data into `eval`/`exec`/`compile`/`new Function`/`vm.*`/dynamic `require`/`import`/PHP `assert`/`create_function`/`preg_replace /e`/`call_user_func`/Ruby `instance_eval`/`send` = RCE. There is rarely a safe reason — verify the input path and record. (Reflection-based dispatch belongs to class `reflection`, CWE-470.)

## Template injection (SSTI) — CWE-1336/917 (class `ssti` · WSTG-INPV-18 · ASVS V5.2.5)
Vulnerable = user input used to **build the template**, not just fill a context variable.
```bash
rg -n "render_template_string|Template\(|from_string|\.render\(|Jinja2|Handlebars\.compile|_\.template\(|ejs\.(render|compile)|pug\.(compile|render)|new Function|Twig.*createTemplate|Velocity|Freemarker|Mako|Smarty|\|\s*safe\b|\|\s*raw\b|autoescape\s*(false|off)|mark_safe|render\(.*\+" .
```
```python
# VULNERABLE — SSTI, executes {{7*7}} etc.
render_template_string("Hi " + request.args["name"])
# SAFE — name is data in a fixed template
render_template("hi.html", name=request.args["name"])
```
Prove it structurally (you can't run `{{7*7}}` read-only): the *template string itself* is attacker-influenced, or auto-escaping is disabled (`|safe`, `|raw`, `mark_safe`, `autoescape off`) on tainted data.

## NoSQL / LDAP / XPath — query/filter injection (class `sqli`)
The checklist has no separate row for these — record them under class `sqli` (data-query injection family) with their own CWE.
```bash
rg -n "\$where|\$regex|\$expr|mapReduce|\.find\(\s*req|\.findOne\(\s*\{|\.aggregate\(|InitialDirContext|DirContext|ldap\.search|search\(.*filter|createEntry|XPath|selectNodes|selectSingleNode|document\.evaluate|\.xpath\(|evaluate\(" .
```
- **NoSQL — CWE-943:** passing `req.body`/`req.query` straight into a Mongo filter allows operator injection (`{"$gt":""}`, `{"$where":"..."}`, `{"$regex":"..."}`). Safe = cast/validate types; never spread raw request objects into queries.
- **LDAP — CWE-90:** tainted value concatenated into a search filter with no escaping → auth bypass / disclosure. Safe = escape per RFC-4515 / parameterize.
- **XPath — CWE-643:** tainted value concatenated into an XPath expression → node/data disclosure. Safe = variable binding, not string concat.

## Wire into the loop
```
record kind=hypothesis statement="listUsers concatenates req.query.sort into ORDER BY" target=e_users class=sqli approach="trace req.query.sort -> db.query" outcome=testing
record kind=finding title="SQL injection via sort param" severity=high target=e_users class=sqli cwe=CWE-89 description="req.query.sort interpolated into ORDER BY at repo/users.js:57" repro="GET /users?sort=id;DROP--" evidence=["repo/users.js:57"] status=confirmed hypothesisId=y5
```
Severity: RCE (cmdi/codeinj/SSTI) = critical; SQLi/NoSQLi with data access = high. Refute only when a parameterized API / allowlist / escaper genuinely sits in the path — record that specific reasoning. If you can't fully trace the path, keep the hypothesis `outcome=inconclusive` (a lead, not a deletion).

## References
- OWASP SQL Injection Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- OWASP OS Command Injection Defense Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
- OWASP Injection Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html
- MITRE CWE-89 SQL Injection — https://cwe.mitre.org/data/definitions/89.html
- MITRE CWE-78 OS Command Injection — https://cwe.mitre.org/data/definitions/78.html
- MITRE CWE-1336 Server-Side Template Injection — https://cwe.mitre.org/data/definitions/1336.html
- OWASP WSTG v4.2 Input Validation Testing — https://owasp.org/www-project-web-security-testing-guide/
