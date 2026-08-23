---
name: review-path-file
description: Use when tracing user input into filesystem APIs — path traversal, arbitrary file read/write, unsafe uploads, zip-slip. CWE-22/434.
---

# Path traversal & unsafe file handling review

Goal: find where untrusted input decides **which file** is read, written, served, included, deleted, or extracted, without canonicalization or an allowlist. **Sources:** HTTP params/body/query/headers, uploaded filenames, archive entry names, path segments, `Content-Disposition` names, and any user-influenced value that becomes part of a path.

Tools run via `bash` and may be absent — grep the filesystem sinks, then read the path-building. Save output to `evidence/`. Verification sets confidence/severity; keep an un-disproven traversal lead as `outcome=inconclusive`, never delete it.

## Path traversal / arbitrary file read — CWE-22 (class `pathtrav` · ASVS V12.3 · WSTG-ATHZ-01)
Vulnerable = tainted value **joined into a path** and passed to a file API with no confinement check.
```bash
# filesystem read/serve sinks
rg -n "\bopen\(|io\.open|readFile(Sync)?|createReadStream|fs\.(read|readFile|createReadStream)|sendFile|res\.(sendFile|download)|send_file|send_from_directory|serve_static|express\.static|static_file|Files\.(read|readAllBytes|newInputStream)|FileInputStream|new File\(|Paths\.get|fopen\(|file_get_contents\(|readfile\(|\binclude(_once)?\b|\brequire(_once)?\b|pathlib\.Path|os\.path\.join\(|filepath\.Join|ioutil\.ReadFile|http\.ServeFile" .
# path-building directly from request data
rg -n "(join|resolve|Join|realpath|normalize)\(.*(req\.(query|params|body|headers)|request\.|params\[|\$_(GET|POST|REQUEST)|argv|c\.(Query|Param))" .
```
```python
# VULNERABLE — ../../etc/passwd escapes the dir
send_file(os.path.join(UPLOAD_DIR, request.args["name"]))
# SAFE — canonicalize, then confirm still inside the base
base = os.path.realpath(UPLOAD_DIR)
full = os.path.realpath(os.path.join(base, request.args["name"]))
if not full.startswith(base + os.sep): abort(403)
```
Verify the fix is genuine:
- Does it **canonicalize** (`realpath`/`Path.resolve`/`filepath.Clean`+abs/`Canonicalize`) *and* check the result is under the base? A check on the **raw** string *before* normalization is bypassable.
- Bypasses to reason about: `../`, `..\\`, URL-encoded `%2e%2e%2f`, double-encoded `%252e`, overlong UTF-8, `....//`, absolute-path injection (`/etc/passwd`), null byte `%00`, Windows drive/UNC (`C:\`, `\\host\share`), and **symlink** escape. Blacklisting `..` alone is insufficient. Basename-only (`os.path.basename`/`path.basename`) is usually safe.
- **Absolute-path injection:** if the input can be absolute, `join(base, "/etc/passwd")` returns `/etc/passwd`.

## Local / remote file inclusion — CWE-98 (class `pathtrav` · WSTG-INPV-11.1/11.2)
PHP `include`/`require`/`include_once`/`require_once` (and dynamic template/module loads) with a tainted path = LFI (read/execute local files, log poisoning, `php://filter`, `data://`) or RFI (`allow_url_include` → remote code). Any dynamic `require(userVar)` / `import(userVar)` is in scope. Require a strict allowlist of includable files.

## Arbitrary file write / overwrite / delete — CWE-22/73 (class `pathtrav`)
Same trace, but the sink **writes or deletes**:
```bash
rg -n "writeFile(Sync)?|fs\.(write|writeFile|createWriteStream|rename|rm|unlink)|open\([^)]*['\"][wa]|createWriteStream|FileOutputStream|Files\.(write|move|delete|copy)|shutil\.(move|copy|rmtree)|os\.(remove|rename|rmdir)|move_uploaded_file|transferTo|\.save\(|part\.write|ioutil\.WriteFile" .
```
An attacker-chosen write path can plant a webshell, overwrite config/code, or clobber data; an attacker-chosen delete path is DoS/tampering. Write/delete = higher severity than read.

## Unsafe file upload — CWE-434 (class `upload` · ASVS V12.1/V12.2)
```bash
rg -n "multer|formidable|busboy|MultipartFile|request\.files|\$_FILES|FileUpload|CommonsMultipart|save\(.*filename|move_uploaded_file|transferTo|part\.write|UploadedFile|store(As)?\(" .
```
Check each upload handler for **all** of:
- **Content validation by magic bytes, not extension or `Content-Type`** (both attacker-controlled). Extension **allowlist**, never blocklist (blocklists miss `.php5`, `.phtml`, `.pht`, `.phar`, `.jsp`, `.jspx`, `.asp`, `.aspx`, `.svg`, double extensions `x.jpg.php`, trailing dot/space, null-byte `x.php%00.jpg`).
- **Filename sanitization** — the uploaded `filename` is user data; used raw in the save path it's path traversal (`../../var/www/shell.php`). Prefer a server-generated random name.
- **Executable / web-served landing dir** — files written under a path the web server executes or serves (`.php`, `.jsp`, `.aspx`, or any origin serving user HTML) = RCE or stored XSS. Store outside webroot, non-executable.
- **Serving safety** — return uploads with `Content-Disposition: attachment` and a correct non-`text/html` `Content-Type`; SVG/HTML/XML uploads served inline from the app origin = stored XSS.
- **Size limits** (DoS), decompression bombs, image re-encoding for image uploads, and AV/polyglot checks where relevant.

## Zip-slip / tar-slip — CWE-22 (class `pathtrav`)
```bash
rg -n "ZipFile|ZipInputStream|getNextEntry|zipfile\.|extractall|extract\(|tarfile|TarInputStream|unzip|Compress::|extractTo|\.getName\(\)" .
```
```python
# VULNERABLE — entry name may be ../../../etc/cron.d/x
zf.extractall(dest)
```
Vulnerable when an archive **entry name** is joined to the output dir without checking the resolved path stays inside it (`extractall`/looping `getNextEntry()` writing to `join(dest, entry.name)` with no confinement) → arbitrary write. Also reject entries that are symlinks or absolute paths. Safe = resolve each entry against `realpath(dest)` and reject any that escapes.

## Wire into the loop
```
record kind=hypothesis statement="GET /download?name= joins into UPLOAD_DIR with no canonicalization" target=e_download class=pathtrav approach="trace name -> send_file" outcome=testing
record kind=finding title="Path traversal in file download" severity=high target=e_download class=pathtrav cwe=CWE-22 description="request.args['name'] joined to UPLOAD_DIR, no realpath confinement" repro="GET /download?name=../../../../etc/passwd" evidence=["app/files.py:29"] status=confirmed hypothesisId=y7
```
Severity: arbitrary file write / upload-to-RCE = critical/high; arbitrary read of sensitive files = high; read confined to a non-sensitive dir = medium. Refute only when canonicalize-then-confine, basename-only, or a strict allowlist is genuinely present; otherwise keep the lead.

## References
- OWASP File Upload Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP Input Validation Cheat Sheet (file paths) — https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- MITRE CWE-22 Improper Limitation of a Pathname to a Restricted Directory — https://cwe.mitre.org/data/definitions/22.html
- MITRE CWE-434 Unrestricted Upload of File with Dangerous Type — https://cwe.mitre.org/data/definitions/434.html
- MITRE CWE-98 PHP Remote/Local File Inclusion — https://cwe.mitre.org/data/definitions/98.html
- OWASP WSTG v4.2 — Testing Directory Traversal File Include (WSTG-ATHZ-01) — https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/05-Authorization_Testing/01-Testing_Directory_Traversal_File_Include
