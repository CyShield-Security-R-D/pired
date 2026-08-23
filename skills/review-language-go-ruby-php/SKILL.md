---
name: review-language-go-ruby-php
description: Use when auditing Go, Ruby/Rails, or PHP — per-language sources & sinks for SQLi, cmdi, SSTI, deserialization, SSRF, XXE, mass assignment, LFI, crypto, authz.
---

# Go / Ruby(Rails) / PHP review

Goal: apply the class skills with the right source/sink names for whichever of these three ecosystems you're in. Each section is self-contained and aims for **complete** sink coverage — grep the sinks, widen with `semgrep --config p/golang` / `p/ruby` / `p/php` / `p/gosec` (see `review-sast-semgrep`), then verify by reading. Save output to `evidence/`. Record which language/framework in the hypothesis so coverage reflects the ecosystem reviewed.

---

## Go

**Sources:** `r.URL.Query().Get`, `r.FormValue`, `r.PostFormValue`, `r.Header.Get`, `mux.Vars(r)`, `c.Query`/`c.Param`/`c.PostForm`/`c.ShouldBindJSON` (gin), `c.QueryParam` (echo), `chi.URLParam`, `os.Args`, `os.Getenv`, request body decode (`json.NewDecoder(r.Body)`).

```bash
rg -n "fmt\.Sprintf\(.*(SELECT|INSERT|UPDATE|DELETE)|db\.(Query|Exec|QueryRow)\(.*(\+|Sprintf)|exec\.Command|exec\.CommandContext|os/exec|template\.HTML\(|template\.JS\(|text/template|http\.(Get|Post|Head|NewRequest)\(|os\.(Open|ReadFile)\(.*r\.|ioutil\.ReadFile\(.*r\.|filepath\.Join\(.*r\.|http\.ServeFile|InsecureSkipVerify|math/rand|crypto/(md5|sha1|des)|yaml\.Unmarshal|gob\.NewDecoder" -g '*.go'
```
- **SQLi (CWE-89, `sqli`):** `db.Query(fmt.Sprintf("... %s", x))` or `"..."+x`. **Safe:** `db.Query("... WHERE id=$1", id)` (placeholders — `$1`/`?` by driver); never build the query string.
- **Command (CWE-78, `cmdi`):** `exec.Command("sh","-c", userStr)` / `bash -c` is a shell sink; `exec.Command(prog, arg1, arg2)` with fixed prog + separate args is safe. Watch a user-controlled *program name*.
- **SSTI / XSS (CWE-1336/CWE-79, `ssti`/`codeinj`):** `html/template` auto-escapes — safe. **`text/template` used for HTML** does not; `template.HTML(userInput)`/`template.JS()`/`template.URL()` bypass escaping. Parsing a template built from user input is template injection.
- **SSRF (CWE-918, `ssrf`):** `http.Get(userURL)` / `http.NewRequest` with a user URL and no allowlist → cloud metadata / internal hosts.
- **Path (CWE-22, `pathtrav`):** `os.Open`/`os.ReadFile`/`http.ServeFile` with `filepath.Join(base, userPath)` — call `filepath.Clean` **and** confirm the result is still under base (a bare `Clean` doesn't confine). → `review-path-file`.
- **Deserialization (CWE-502, `deser`):** `encoding/gob` and `yaml.Unmarshal` on untrusted input; only decode data from trusted producers.
- **Weak crypto/RNG (CWE-327/338, `crypto`):** `math/rand` for tokens (use `crypto/rand`), `crypto/md5`·`crypto/sha1`·`crypto/des`, `tls.Config{InsecureSkipVerify: true}` (TLS off).
- **Authz (`authz`):** no decorator model — verify every mux/route is wrapped by the auth middleware; a handler registered outside the authenticated group is unprotected. Errors ignored (`_ =`) around auth/validation silently skip checks — read those paths.

## Ruby / Rails

**Sources:** `params[:x]`, `request.headers`, `cookies`, `request.body`, `request.env`, `ARGV`, `ENV`.

```bash
rg -n "where\(['\x22].*(#\{|\+)|find_by_sql|\.select\(['\x22].*#\{|order\(['\x22].*#\{|execute\(|exec_query|\.system\(|\x60.*#\{|%x\(|Kernel\.(system|exec)|\beval\(|constantize|\.(send|public_send)\(|instance_eval|class_eval|ERB\.new|render\s+(inline|text):|permit!|Marshal\.load|YAML\.load\b|Psych\.load\b|open\(.*params|URI\.open|Net::HTTP|File\.(read|open)\(.*params|redirect_to\s+params|Digest::(MD5|SHA1)|Nokogiri.*noent|skip_before_action.*verify_authenticity" -g '*.rb'
```
- **SQLi (CWE-89, `sqli`):** `where("name = '#{params[:n]}'")` / `find_by_sql("..."+x)` / interpolated `order`/`select`/`pluck`. **Safe:** `where("name = ?", n)` / `where(name: n)`; column names need an allowlist.
- **Command (CWE-78, `cmdi`):** `` `...#{x}` ``, `%x(...)`, `system("...#{x}")`, `exec`, `open("|cmd")`. **Safe:** `system("prog", arg)` multi-arg form.
- **Code eval / reflection (CWE-94/CWE-470, `codeinj`/`reflection`):** `eval`, `instance_eval`, `class_eval`, `params[:x].constantize`, `obj.send(params[:m])`/`public_send` → arbitrary method/class invocation.
- **SSTI (CWE-1336, `ssti`):** `ERB.new(user_input).result` and `render inline:`/`render text:` with user data execute embedded Ruby.
- **Mass assignment (CWE-915, `authz`):** `Model.new(params[:user])`/`update(params[:user])` without strong params, or `params.permit!` / `params.require(:x).permit!` — sets any attribute (e.g. `admin=true`). **Safe:** explicit `permit(:name, :email)`.
- **Deserialization (CWE-502, `deser`):** `Marshal.load`, `YAML.load`/`Psych.load` on user data (use `YAML.safe_load`), `Oj` in object mode.
- **SSRF (CWE-918, `ssrf`):** `open(params[:url])`/`URI.open`/`Net::HTTP` on a user URL; open-uri following `http`/`file`.
- **XXE (CWE-611, `xxe`):** Nokogiri is safe by default; `Nokogiri::XML(x){ |c| c.noent }` / passing `Nokogiri::XML::ParseOptions::NOENT` re-enables entity expansion → XXE.
- **Open redirect (CWE-601, `authz`):** `redirect_to params[:url]` unvalidated (Rails `redirect_to` allows external hosts unless `allow_other_host: false`).
- **CSRF / authn (`authn`):** `skip_before_action :verify_authenticity_token` on state-changing actions; a controller missing `before_action :authenticate_user!`.
- **Weak crypto/RNG (CWE-327/338, `crypto`):** `Digest::MD5`/`SHA1` for security, `OpenSSL::Cipher` in ECB, `rand`/`Kernel#rand` for tokens (use `SecureRandom`), `OpenSSL::SSL::VERIFY_NONE`.

## PHP

**Sources:** `$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`, `$_FILES`, `$_SERVER` (headers), `php://input`, `$argv`.

```bash
rg -n "\bmysql_query\(|->query\(.*\.\s*\x24|\bquery\(['\x22].*\x24|\beval\(|\bassert\(|\bsystem\(|\bexec\(|\bshell_exec\(|\bpassthru\(|\bpopen\(|proc_open\(|\bunserialize\(|\binclude(_once)?\b|\brequire(_once)?\b|preg_replace\(.*/e|\bcreate_function\(|\bextract\(|\bparse_str\(|simplexml_load_(string|file)|->loadXML\(|LIBXML_NOENT|libxml_disable_entity_loader|curl_exec|file_get_contents\(\s*\x24|fsockopen|move_uploaded_file|header\(\s*['\x22]?Location|\bmd5\(|\bsha1\(|\bmt_rand\(|\brand\(|\buniqid\(|==[^=]" -g '*.php'
```
- **SQLi (CWE-89, `sqli`):** `mysql_query("... $_GET[x]")` / `$pdo->query("...".$x)`. **Safe:** PDO/mysqli prepared statements with bound params (`prepare` + `execute([$x])`) — not `PDO::quote` juggling.
- **Command (CWE-78, `cmdi`):** `system`, `exec`, `shell_exec`, `passthru`, `` `...` ``, `popen`, `proc_open` with tainted data. `escapeshellarg`/`escapeshellcmd` help only if applied to *every* user part.
- **Code eval (CWE-94/CWE-95, `codeinj`):** `eval`, `assert(string)`, `preg_replace('/.../e', ...)` (deprecated `/e`), `create_function`, dynamic `$func()`/`$class::method()`.
- **LFI/RFI (CWE-98/CWE-22, `pathtrav`):** `include`/`require`/`include_once` with `$_GET`/`$_POST` → local/remote file inclusion → RCE (via log poisoning, `php://filter`, `data://`). Also `fopen`/`file_get_contents`/`readfile` with user paths → `review-path-file`.
- **Deserialization (CWE-502, `deser`):** `unserialize($_COOKIE/$_POST)` → object injection / POP chains. Prefer `json_decode`; `unserialize($x, ['allowed_classes'=>false])` limits gadgets.
- **SSRF (CWE-918, `ssrf`):** `curl_exec`/`file_get_contents($url)`/`fsockopen` with a user URL and no allowlist → internal/metadata access.
- **XXE (CWE-611, `xxe`):** `simplexml_load_string`/`DOMDocument->loadXML` with the `LIBXML_NOENT` flag (or pre-8.0 code relying on `libxml_disable_entity_loader`) parses external entities → file read / SSRF. Don't pass `LIBXML_NOENT` for untrusted XML.
- **Upload (CWE-434, `upload`):** `move_uploaded_file($_FILES['f']['tmp_name'], $_FILES['f']['name'])` with no extension/MIME allowlist → webshell upload. Generate the stored name and validate type server-side.
- **Type-juggling (CWE-697, `authn`):** loose `==` comparing hashes/tokens/passwords (`"0e123" == "0e456"` magic-hash bypass; `strcmp` with an array returns null). Require strict `===`; `hash_equals` for MACs/tokens.
- **Weak crypto/RNG (CWE-327/338, `crypto`):** `md5`/`sha1` for passwords (use `password_hash`/`password_verify`), `mt_rand`/`rand`/`uniqid` for tokens (use `random_bytes`/`random_int`), `mcrypt`/ECB ciphers.
- **Variable overwrite (CWE-621):** `extract($_GET)`, `parse_str($_SERVER['QUERY_STRING'])`, `$$var` overwrite arbitrary variables.
- **Header injection / open redirect (CWE-601/CWE-113, `authz`):** `header("Location: ".$_GET['url'])` unvalidated.

---

## Wire into the loop (any of the three)
```
record kind=hypothesis statement="Rails UsersController uses Model.new(params[:user]) without strong params" target=e_users class=authz approach="check permit list; try setting admin" outcome=testing
record kind=finding title="Mass assignment allows privilege escalation" severity=high target=e_users class=authz cwe=CWE-915 description="User.new(params[:user]) with permit! sets admin attribute" repro="POST /users user[admin]=true" evidence=["app/controllers/users_controller.rb:19"] status=confirmed hypothesisId=y5
```
Refute (set `outcome=refuted`) only when a placeholder query, multi-arg exec, strong-params allowlist, `===`/`hash_equals`, `SecureRandom`/`random_bytes`, allowlisted redirect, or `safe_load` is genuinely in the path. Uncertain-but-plausible → keep `outcome=inconclusive` with a note; never silently drop it.

## References
- Ruby on Rails Security Guide — https://guides.rubyonrails.org/security.html
- Go `html/template` (contextual auto-escaping) — https://pkg.go.dev/html/template
- PHP Security — Filesystem / Program-execution / preg_replace `/e` notes — https://www.php.net/manual/en/security.php
- OWASP Mass Assignment Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html
- CWE-915: Improperly Controlled Modification of Dynamically-Determined Object Attributes — https://cwe.mitre.org/data/definitions/915.html
- CWE-98: PHP Remote/Local File Inclusion — https://cwe.mitre.org/data/definitions/98.html
- CWE-697: Incorrect Comparison (PHP type juggling) — https://cwe.mitre.org/data/definitions/697.html
