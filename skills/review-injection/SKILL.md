---
name: review-injection
description: Use when tracing injection sinks in source — SQL, OS command, code eval, template (SSTI), NoSQL, LDAP/XPath. CWE-89/78/94/917.
---

# Injection review (SQL / command / code / template / NoSQL / LDAP / XPath)

Goal: find where untrusted input reaches an interpreter without parameterization or escaping. Sources: HTTP params/body/headers, CLI args, env, file/DB reads. The bug is **string-building a query/command/template from tainted data** where a safe parameterized API exists.

Tools run via `bash` and may be absent — grep first, semgrep to widen (`review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

## SQL injection — CWE-89 (class `sqli`)
Vulnerable = tainted value **concatenated / interpolated** into SQL. Safe = placeholders (`?`, `$1`, `:name`) with a params array, or a vetted ORM query builder.
```bash
rg -n "SELECT .*(\+|\|\||\bformat\b|%|f\"|f'|\$\{|#\{|`)" -g '*.{js,ts,py,java,go,rb,php,cs}'
rg -n "execute\(|query\(|rawQuery|createStatement|Statement\(|\.raw\(|db\.query|cursor\.execute" .
rg -n "String\.format.*(SELECT|INSERT|UPDATE|DELETE)|\"SELECT\" *\+" -g '*.java'
```
```python
# VULNERABLE
cur.execute("SELECT * FROM users WHERE name='%s'" % name)
cur.execute(f"SELECT * FROM users WHERE id={uid}")
# SAFE
cur.execute("SELECT * FROM users WHERE name=%s", (name,))
```
Verify: is the interpolated var attacker-controlled? ORM `.where("x = " + v)` and `.raw()` with concat are also vulnerable; `.where({x:v})` bind is safe. Column/table names can't be parameterized → require an allowlist.

## OS command injection — CWE-78 (class `cmdi`)
Vulnerable = tainted data in a command run **through a shell**. Safe = arg-vector exec (no shell) with a fixed program.
```bash
rg -n "os\.system|subprocess\.(call|run|Popen).*shell=True|popen\(|`.*\$|Runtime\.getRuntime\(\)\.exec|ProcessBuilder|child_process\.(exec|execSync)\(|shell_exec|proc_open|exec\(|system\(|passthru\(" .
```
```js
// VULNERABLE — string goes to /bin/sh
child_process.exec(`convert ${req.query.file} out.png`)
// SAFE — arg vector, no shell
child_process.execFile('convert', [req.query.file, 'out.png'])
```
Verify: `exec`/`system`/`shell=True`/backticks with a tainted substring = vulnerable. `execFile`/`spawn`/`subprocess.run([...] , shell=False)` with the input as a **separate array element** is safe (still check for arg-injection like a leading `-`).

## Code injection / eval — CWE-94/95 (class `codeinj`)
```bash
rg -n "\beval\(|\bexec\(|new Function\(|vm\.runIn|setTimeout\(\s*[\"'].*\+|pickle\.loads|Function\(|assert\(|compile\(|InvokeMethod|reflection" .
```
Tainted data into `eval`/`exec`/`new Function`/`vm`/dynamic `require`/reflection = RCE. There is rarely a safe reason — verify the input path and record.

## Template injection (SSTI) — CWE-1336/917 (class `ssti`)
Vulnerable = user input used to **build the template**, not just fill a context variable.
```bash
rg -n "render_template_string|Template\(|from_string|Jinja2|new Function|Handlebars\.compile|ejs\.render|Velocity|Freemarker|\|\s*safe\b|render\(.*\+" .
```
```python
# VULNERABLE — SSTI, executes {{7*7}} etc.
render_template_string("Hi " + request.args["name"])
# SAFE — name is data in a fixed template
render_template("hi.html", name=request.args["name"])
```
Confirm reachability with a math probe in your read (`{{7*7}}`/`${7*7}`) — but you cannot run it read-only, so prove it structurally: the source string is attacker-influenced.

## NoSQL / LDAP / XPath (classes `nosqli`, `ldapi`, `xpathi`)
```bash
rg -n "\$where|\.find\(\s*req|mapReduce|\$regex|InitialDirContext|search\(.*filter|XPath|selectNodes|evaluate\(" .
```
- **NoSQL:** passing `req.body` straight into a Mongo filter allows operator injection (`{"$gt":""}`, `{"$where":"..."}`). Safe = cast/validate types, never spread raw request objects into queries.
- **LDAP/XPath:** tainted value concatenated into a filter/expression with no escaping → auth bypass / data disclosure. Safe = escape or parameterize.

## Wire into the loop
```
record kind=hypothesis statement="listUsers concatenates req.query.sort into ORDER BY" target=e_users class=sqli approach="trace req.query.sort -> db.query" outcome=testing
record kind=finding title="SQL injection via sort param" severity=high target=e_users class=sqli cwe=CWE-89 description="req.query.sort interpolated into ORDER BY at repo/users.js:57" repro="GET /users?sort=id;DROP--" evidence=["repo/users.js:57"] status=confirmed hypothesisId=y5
```
Severity: RCE (cmdi/codeinj/SSTI) = critical; SQLi/NoSQLi with data access = high; refuted when a parameterized API or allowlist sits in the path — record that reasoning so it isn't retested.
