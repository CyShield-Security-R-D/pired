---
name: review-path-file
description: Use when tracing user input into filesystem APIs — path traversal, arbitrary file read/write, unsafe uploads, zip-slip. CWE-22/434.
---

# Path traversal & unsafe file handling review

Goal: find where untrusted input decides **which file** is read, written, served, included, or extracted, without canonicalization or an allowlist. Sources: HTTP params/body, filenames in uploads, archive entry names, path segments.

Tools run via `bash` and may be absent — grep the filesystem sinks, then read the path-building. Save output to `evidence/`.

## Path traversal / arbitrary file read — CWE-22 (class `pathtrav`)
Vulnerable = tainted value **joined into a path** and passed to a file API with no confinement check.
```bash
rg -n "open\(|readFile|readFileSync|sendFile|createReadStream|fs\.(read|write|unlink)|os\.path\.join\(|Paths\.get|new File\(|File\.new|fopen\(|readfile\(|include|require |serve_static|send_file|res\.download" .
# path-building from request data
rg -n "(join|resolve)\(.*(req\.(query|params|body)|request\.|params\[|\$_(GET|POST)|argv)" .
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
- Does it **canonicalize** (`realpath`/`Path.resolve`/`Canonicalize`) *and* check the result is under the base? A check on the **raw** string before normalization is bypassable (`....//`, encoded `%2e%2e`, absolute paths, Windows `\`, null byte, symlinks).
- Blacklisting `..` alone is not sufficient. Basename-only (`path.basename`) is usually safe.
- Absolute-path injection: if the input can be an absolute path, `join(base, "/etc/passwd")` returns `/etc/passwd`.

## Arbitrary file write / overwrite — CWE-22/73
Same trace, but the sink writes (`writeFile`, `fs.write`, `open(...,"w")`, `move`, upload save). Attacker-chosen write path can plant a webshell, overwrite config, or clobber code. Higher severity than read.

## Unsafe file upload — CWE-434 (class `upload`)
```bash
rg -n "multer|MultipartFile|request\.files|\$_FILES|FileUpload|save\(.*filename|move_uploaded_file|transferTo|part\.write" .
```
Check each upload handler for:
- **Type validation on content, not just extension/`Content-Type`** (both are attacker-controlled). Extension allowlist beats blocklist.
- **Filename sanitization** — the uploaded `filename` is user data; used raw in the save path it's path traversal (`../../var/www/shell.php`).
- **Executable landing dir** — files written under a web-served/executable path (`.php`, `.jsp`, `.aspx`) = RCE.
- Missing size limits (DoS). Serving uploads from the app origin without `Content-Disposition` (stored XSS via HTML/SVG).

## Zip-slip / archive extraction — CWE-22
```bash
rg -n "ZipFile|ZipInputStream|getNextEntry|extractall|tarfile|unzip|Compress::|extractTo|zip->extractTo" .
```
```python
# VULNERABLE — entry name may be ../../../etc/cron.d/x
zf.extractall(dest)
```
Vulnerable when an archive **entry name** is joined to the output dir without checking the resolved path stays inside it. `extractall`/looping `getNextEntry()` and writing to `join(dest, entry.name)` with no confinement = zip-slip → arbitrary write. Safe = resolve each entry and reject any escaping `dest`.

## Wire into the loop
```
record kind=hypothesis statement="GET /download?name= joins into UPLOAD_DIR with no canonicalization" target=e_download class=pathtrav approach="trace name -> send_file" outcome=testing
record kind=finding title="Path traversal in file download" severity=high target=e_download class=pathtrav cwe=CWE-22 description="request.args['name'] joined to UPLOAD_DIR, no realpath confinement" repro="GET /download?name=../../../../etc/passwd" evidence=["app/files.py:29"] status=confirmed hypothesisId=y7
```
Severity: arbitrary file write / upload-to-RCE = critical/high; arbitrary read of sensitive files = high; read confined to non-sensitive dir = medium. Refute when canonicalize-then-confine, basename-only, or a strict allowlist is present.
