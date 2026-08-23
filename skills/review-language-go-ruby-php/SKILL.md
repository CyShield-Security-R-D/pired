---
name: review-language-go-ruby-php
description: Use when auditing Go, Ruby/Rails, or PHP — per-language sources & sinks for SQLi, command exec, SSTI, deserialization, mass assignment, LFI.
---

# Go / Ruby(Rails) / PHP review

Goal: apply the class skills with the right source/sink names for whichever of these three ecosystems you're in. Each section is self-contained. Grep the sinks, widen with `semgrep --config p/golang` / `p/ruby` / `p/php` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`.

---

## Go

**Sources:** `r.URL.Query().Get`, `r.FormValue`, `r.PostForm`, `r.Header.Get`, `mux.Vars(r)`, `c.Query`/`c.Param`/`c.PostForm` (gin), `c.QueryParam` (echo), `os.Args`, `os.Getenv`, request body decode.

```bash
rg -n "fmt\.Sprintf\(.*(SELECT|INSERT|UPDATE|DELETE)|db\.(Query|Exec)\(.*\+|db\.(Query|Exec)\(fmt\.Sprintf|exec\.Command|os/exec|template\.HTML\(|text/template|http\.Get\(|http\.(Post|NewRequest)\(|os\.Open\(.*r\.|ioutil\.ReadFile\(.*r\.|filepath\.Join\(.*r\." -g '*.go'
```
- **SQLi (CWE-89):** `db.Query(fmt.Sprintf("... %s", x))` or `"..."+x`. Safe: `db.Query("... WHERE id=$1", id)` (placeholders — `$1`/`?` by driver).
- **Command (CWE-78):** `exec.Command("sh","-c", userStr)` is a shell sink; `exec.Command(prog, arg1, arg2)` with fixed prog + separate args is safe. Watch a user-controlled program name.
- **XSS/templates:** `html/template` auto-escapes — safe. **`text/template` for HTML** does not, and `template.HTML(userInput)` / `template.JS()` bypass escaping (CWE-79).
- **SSRF (CWE-918):** `http.Get(userURL)` / `http.NewRequest` with a user URL and no allowlist → `review-deserialization-ssrf`.
- **Path (CWE-22):** `os.Open`/`ioutil.ReadFile`/`http.ServeFile` with `filepath.Join(base, userPath)` — use `filepath.Clean` **and** confirm the result is under base (a bare `Clean` doesn't confine). → `review-path-file`.
- Errors ignored (`_ =`) around auth/validation can silently skip checks — read those paths.

## Ruby / Rails

**Sources:** `params[:x]`, `request.headers`, `cookies`, `request.body`, `ARGV`, `ENV`.

```bash
rg -n "where\(\".*#\{|where\(\".*\+|find_by_sql|execute\(|exec_query|\.system\(|`.*#\{|%x\(|Kernel\.(system|exec)|eval\(|constantize|\.send\(|instance_eval|ERB\.new|render\s+inline:|permit!|Marshal\.load|YAML\.load\b|open\(.*params|File\.(read|open)\(.*params" -g '*.rb'
```
- **SQLi:** `where("name = '#{params[:n]}'")` / `find_by_sql("..."+x)`. Safe: `where("name = ?", n)` or `where(name: n)`. `order`/`pluck`/interpolated column names need an allowlist.
- **Command (CWE-78):** `` `...#{x}` ``, `%x(...)`, `system("...#{x}")`, `exec`, `open("|cmd")`. Safe: `system("prog", arg)` multi-arg form.
- **Code eval / reflection (CWE-94):** `eval`, `instance_eval`, `params[:x].constantize`, `obj.send(params[:m])` → arbitrary method/class invocation.
- **SSTI:** `ERB.new(user_input).result` and `render inline: user_input` execute embedded Ruby.
- **Mass assignment (CWE-915):** `Model.new(params[:user])` without strong params, or `params.permit!` / `params.require(:x).permit!` — allows setting any attribute (e.g. `admin=true`). Safe: explicit `permit(:name, :email)`.
- **Deserialization (CWE-502):** `Marshal.load` / `YAML.load` (use `YAML.safe_load`) on user data.

## PHP

**Sources:** `$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`, `$_FILES`, `$_SERVER` (headers), `php://input`, `$argv`.

```bash
rg -n "\bmysql_query\(|->query\(.*\.\s*\\\$|\bquery\(\".*\\\$|\beval\(|\bassert\(|\bsystem\(|\bexec\(|\bshell_exec\(|\bpassthru\(|\bpopen\(|proc_open\(|\bunserialize\(|\binclude(_once)?\b|\brequire(_once)?\b|preg_replace\(.*/e|\bextract\(|==[^=]" -g '*.php'
```
- **SQLi:** `mysql_query("... $_GET[x]")` / `$pdo->query("...".$x)`. Safe: PDO prepared statements with bound params (`prepare` + `execute([$x])`) — not `PDO::quote` juggling.
- **Command (CWE-78):** `system`, `exec`, `shell_exec`, `passthru`, `` `...` ``, `popen`, `proc_open` with tainted data. `escapeshellarg`/`escapeshellcmd` help only if applied to every user part.
- **Code eval (CWE-94):** `eval`, `assert(string)`, `preg_replace('/.../e', ...)` (deprecated `/e`), `create_function`, dynamic `$func()`.
- **LFI/RFI (CWE-98/22):** `include`/`require`/`include_once` with `$_GET`/`$_POST` → local/remote file inclusion → RCE (via log poisoning, `php://filter`, `data://`). Also `fopen`/`file_get_contents`/`readfile` with user paths (`review-path-file`).
- **Deserialization (CWE-502):** `unserialize($_COOKIE/$_POST)` → object injection / POP chains. Prefer `json_decode`.
- **Type-juggling (CWE-697):** loose `==` comparing hashes/tokens/passwords (`"0e123" == "0e456"` magic-hash bypass, `strcmp` with array returns null). Require strict `===` for security comparisons; `hash_equals` for MACs.
- **`extract($_GET)`/`$$var`** overwrites arbitrary variables.

---

## Wire into the loop (any of the three)
```
record kind=hypothesis statement="Rails UsersController uses Model.new(params[:user]) without strong params" target=e_users class=authz approach="check permit list; try setting admin" outcome=testing
record kind=finding title="Mass assignment allows privilege escalation" severity=high target=e_users class=authz cwe=CWE-915 description="User.new(params[:user]) with permit! sets admin attribute" repro="POST /users user[admin]=true" evidence=["app/controllers/users_controller.rb:19"] status=confirmed hypothesisId=y5
```
Refute when a placeholder query, multi-arg exec, strong-params allowlist, `===`/`hash_equals`, or `safe_load` is genuinely in the path. Record which language/framework in the hypothesis so coverage reflects the ecosystem reviewed.
