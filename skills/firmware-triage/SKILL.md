---
name: firmware-triage
description: Use on an extracted root filesystem — secrets, credentials, keys, startup scripts, and the web/CGI surface that yields most real firmware findings.
---

# Triaging an extracted root filesystem

Goal: walk the filesystem the way an attacker with a copy of it would, and turn what is there into recorded surface and hypotheses. OWASP FSTM stage 5.

**Where the findings actually are.** ISE's SOHOpelessly Broken 2.0 tested 13 SOHO routers and NAS devices and found a web-application vulnerability in **all 13**, obtaining a root shell on 12; Cisco Talos found 44 vulnerabilities in the CGI and shell scripts of a single router. Hardcoded credentials are the most consistently reported class across every published IoT list. So: **the web root and the credential material are the high-yield ground, not the boot chain.** Cover the boot and update classes because a client is paying for coverage, but spend your judgement here.

Set `ROOT` once: `ROOT="$PIRED_WORKSPACE/artifacts/rootfs"`.

## 0. Frame it in the loop
Everything you record becomes a row in the matrix. A CGI binary you never recorded is a `cmdi` cell that never existed, so the report will claim a clean floor it never asked about.
- CGI/web handlers → `record kind=endpoint host=<image id> method=GET path=/cgi-bin/admin file=www/cgi-bin/admin`
- Components with versions → `record kind=tech name=... version=...`
- Listening services named in init scripts → `record kind=service host=<image id> port=23 proto=tcp name=telnetd`

`file` on an endpoint is what lets a gap point at a place on disk. Set it.

## 1. Credentials and key material (`hardcoded-creds`, `hardcoded-keys`, `cleartext-secrets`)
```bash
cat "$ROOT/etc/passwd" "$ROOT/etc/shadow" 2>/dev/null
grep -rIn -iE 'password|passwd|admin|root|secret|token|api[_-]?key' "$ROOT/etc" "$ROOT/usr/etc" 2>/dev/null | head -50
find "$ROOT" \( -name '*.pem' -o -name '*.key' -o -name '*.crt' -o -name '*.p12' -o -name 'id_rsa*' -o -name '*_host_key' \)
grep -rIn -oE '\$[1256]\$[^:]*' "$ROOT" 2>/dev/null | head            # crypt hashes anywhere, not just /etc/shadow
```
`firmwalker` automates the sweep — **use a maintained fork**, `craigz28/firmwalker` is now 404. `zhibx/firmwalker_pro` carries a far larger secret pattern set.
```bash
./firmwalker.sh "$ROOT" "$PIRED_WORKSPACE/evidence/firmwalker.txt"
```
Prove before claiming. A hash in `/etc/shadow` is `cleartext-secrets` only once you show it is *the* login credential; crack it (`john`, `hashcat`) or show the account is used, and record which. A private key is `hardcoded-keys` when the same key ships on every unit — say how you know, or record it `suspected` and say what would settle it.

## 2. The web root — the highest-yield surface (`cmdi`, `authbypass`, `traversal`)
```bash
find "$ROOT" -type d \( -iname www -o -iname htdocs -o -iname cgi-bin -o -iname webroot \)
find "$ROOT" \( -name '*.cgi' -o -name '*.asp' -o -name '*.php' -o -name '*.sh' \) -path '*www*'
# the sinks, inside compiled CGI as well as scripts
grep -rIn -aE 'system\(|popen\(|execve?\(|`|eval |exec ' "$ROOT/www" "$ROOT/usr/www" 2>/dev/null | head -40
strings "$ROOT/usr/sbin/httpd" | grep -iE 'system|popen|/bin/sh|nvram_set|cmd=' | head -30
```
Record every handler as an `endpoint`. Then for each, ask the three questions that produce most real findings:
1. **Is any parameter concatenated into a shell string?** → `cmdi`. Vendor CGI routinely blocklists rather than escapes; the published NETGEAR case blocked `` ` `` and `/bin` but not `|`. A blocklist you can walk around is a finding, not a mitigation.
2. **Is this handler reachable before authentication?** → `authbypass`. Compare the handler list against wherever the auth check lives; a router's "session check" is often one function some handlers simply do not call.
3. **Does it open a path built from input?** → `traversal`.

## 3. Startup, services and defaults (`exposed-services`, `insecure-defaults`, `debug-code`)
```bash
cat "$ROOT/etc/inittab" "$ROOT/etc/init.d/rcS" 2>/dev/null
ls "$ROOT/etc/init.d/" "$ROOT/etc/rc.d/" 2>/dev/null
grep -rIn -E 'telnetd|dropbear|ftpd|tftp|inetd|adbd|sshd' "$ROOT/etc" 2>/dev/null
find "$ROOT" -perm -4000 -o -perm -2000 2>/dev/null            # setuid/setgid
grep -rIn -E 'debug|DEBUG|test_mode|factory' "$ROOT/etc" 2>/dev/null | head -20
```
A `telnetd` started unconditionally from `rcS` is `exposed-services`, and with §1's credentials it is usually the engagement's root shell. World-writable files or a setuid shell are `insecure-defaults`.

## 4. The update mechanism (`update-signature`, `update-rollback`, `no-update-path`)
```bash
grep -rIn -aE 'upgrade|firmware|\.bin|ota|update' "$ROOT/etc" "$ROOT/usr/sbin" 2>/dev/null | head -30
strings "$ROOT/usr/sbin/upgrade" 2>/dev/null | grep -iE 'http://|https://|sig|rsa|sha256|verify' | head
```
An update client fetching over plain `http://` with no signature check is `update-signature` (CWE-494 for the transport case, CWE-347 when it parses a signature and ignores the result — the distinction belongs in the write-up). No update client at all is `no-update-path`.

Be honest about second-order severity: unsigned update is *critical if chained* — usually you need a second bug (an unauthenticated update trigger, or a MITM-able channel) to weaponise it. Say which you have.

## 5. Record refutations too
A class you looked at and cleared is a result. `record kind=hypothesis ... outcome=refuted` with the specific reason — "every CGI handler calls `check_session()` first, verified across all 14" — or the matrix cannot tell your work from work nobody did.

## References
- OWASP FSTM stage 5 — https://scriptingxss.gitbook.io/firmware-security-testing-methodology
- ISE, SOHOpelessly Broken 2.0 — 13/13 devices, 125 CVEs — https://www.ise.io/casestudies/sohopelessly-broken-2-0/
- Pen Test Partners, CVE-2019-12103 (TP-Link M7350, pre-auth RCE via `popen`) — https://www.pentestpartners.com/security-blog/cve-2019-12103-analysis-of-a-pre-auth-rce-on-the-tp-link-m7350-with-ghidra/
- GMO Flatt Security, NETGEAR PSV-2022-0044 (blocklist bypass) — https://flatt.tech/research/posts/finding-bugs-to-trigger-unauthenticated-command-injection-in-a-netgear-router-psv-2022-0044/
- firmwalker_pro — https://github.com/zhibx/firmwalker_pro
