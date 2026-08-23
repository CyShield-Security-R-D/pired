---
name: network-service-enum
description: Use to enumerate a specific network service (SMB, LDAP, SNMP, DB, SSH, SMTP, RDP, etc.) for common weaknesses and seed hypotheses per checklist class.
---

# Per-service enumeration & common weaknesses

Goal: for **every** open service in inventory, run the standard enumeration, check the classic misconfigs/default-creds, and turn what you find into `record kind=hypothesis` (tagged with a checklist `class`) — promoting confirmed ones to findings. Passive/unauthenticated checks first; anything intrusive (brute force, write attempts, active relay/exploit) needs an operator `approval` blocker.

**High recall is the whole point of this skill: work down the inventory service-by-service and don't skip the "boring" ones — misses hide in UDP services, second-instance DBs on odd ports, and management interfaces nobody expected.** Tools run via `bash` and may be missing — try an alternative, else park a note/blocker. Every target must be in the authorized scope. Save raw output to `evidence/<host>-<svc>.txt`; keep only distilled findings in context.

## 0. Frame it in the loop
- Pull the **full** service list from `recall inventory` / `recall next` and cover each one. Nothing open should leave enumeration untouched — an unhandled service is a coverage gap, not a pass.
- `record kind=hypothesis` *before* testing so coverage tracks it (`outcome=testing`).
- Confirm the service (don't trust the port/banner) before enumerating; a misidentified service wastes effort. `nmap -sV --version-all -p<port> HOST` on anything unclear.
- Default-cred / unauth-access wins are often `critical`/`high` — record them as findings with evidence immediately.
- **Never drop a lead.** If a check is ambiguous or a tool is missing, record a hypothesis with `outcome=inconclusive` plus a note on what would confirm it — don't discard it.
- NSE script categories matter for the intrusive gate: `safe`/`discovery`/`default` scripts are fine to run; `intrusive`/`brute`/`vuln`/`external` scripts (flagged per-service below) actively probe or attempt access → treat as intrusive and `approval`-gate on strict rules of engagement.

## HTTP(S) — 80/443/8080/8443/8000/8888 (misconfig / infodisclosure)
Hand full web work to `web-recon` + the `web-*` skills. Quick network-level triage:
```bash
curl -sSI http://HOST:PORT/          # headers, server, redirects (also try https://)
nmap --script http-title,http-headers,http-methods,http-enum -p80,443 HOST -oN evidence/HOST-http.txt
```
Dangerous methods (`PUT`/`DELETE`/`TRACE`), verbose `Server`/`X-Powered-By`, exposed admin/actuator paths → hypotheses (`class=misconfig`/`exposed-admin`/`infodisclosure`).

## SSH — 22 (misconfig / default-creds)
```bash
nmap --script ssh2-enum-algos,ssh-hostkey,ssh-auth-methods -p22 HOST -oN evidence/HOST-ssh.txt
ssh -vv -o PreferredAuthentications=none -o BatchMode=yes user@HOST 2>&1 | grep -i 'authentications'
```
Weak KEX/ciphers/MACs, password auth enabled on internet-facing SSH → hypotheses (`class=misconfig`); outdated OpenSSH with a CVE → `class=outdated-service`. `ssh-auth-methods` is `auth`/`intrusive` (it opens an auth attempt) — mild but note it. Brute force (`hydra`/`ncrack`) is intrusive → `approval` blocker; reuse `recall loot` creds by handle before ever brute-forcing (`class=default-creds`).

## FTP — 21 (unauth-service, CWE-306)
```bash
nmap --script ftp-anon,ftp-syst,ftp-bounce,ftp-vsftpd-backdoor -p21 HOST -oN evidence/HOST-ftp.txt
curl -s ftp://HOST/ --user anonymous:anonymous        # confirm anonymous listing by hand
```
Anonymous **read** → finding (`class=unauth-service`, CWE-306). Anonymous **write** / world-writable dir → finding (`class=misconfig`, CWE-276 Incorrect Default Permissions / CWE-732) — but a write attempt is intrusive, `approval`-gate it. Note the daemon version for known CVEs (`class=outdated-service`).

## Telnet — 23 (misconfig, cleartext)
```bash
nmap --script telnet-encryption,telnet-ntlm-info,banner -p23 HOST -oN evidence/HOST-telnet.txt
```
Telnet at all = cleartext credentials/session → finding (`class=misconfig`, CWE-319 Cleartext Transmission). No encryption option → higher severity. Default device creds on the login → `class=default-creds`.

## SMTP — 25/465/587 (misconfig / infodisclosure)
```bash
nmap --script smtp-commands,smtp-ntlm-info -p25 HOST -oN evidence/HOST-smtp.txt   # safe: banner+EHLO
printf 'EHLO x\r\nVRFY root\r\nQUIT\r\n' | nc -w5 HOST 25                          # manual user enum
# INTRUSIVE (approval-gate): actually attempts to relay / enumerate users
nmap --script smtp-open-relay,smtp-enum-users -p25 HOST -oN evidence/HOST-smtp-int.txt
```
Open relay → finding (`class=misconfig`, CWE-306 Missing Authentication for Critical Function — NOT CWE-269). `smtp-open-relay` is `intrusive`/`external` (it sends real relay-test mail) and `smtp-enum-users` is `auth`/`intrusive` — `approval`-gate both. `VRFY`/`EXPN`/`RCPT` user enumeration → hypothesis (`class=infodisclosure`, CWE-200).

## DNS — 53 tcp/udp (dns, CWE-200)
```bash
dig axfr @HOST acme.test                    # zone transfer — full internal namespace if misconfigured
nmap --script dns-zone-transfer,dns-nsid,dns-recursion --script-args dns-zone-transfer.domain=acme.test -p53 HOST -oN evidence/HOST-dns.txt
```
Successful AXFR → finding (`class=dns`, CWE-200): it hands over the whole internal namespace. Open recursion → note (`class=misconfig` — cache-poisoning/amplification risk). Version via `dig CH TXT version.bind @HOST`.

## POP3 / IMAP — 110/143/993/995 (misconfig / infodisclosure)
```bash
nmap --script pop3-capabilities,pop3-ntlm-info -p110 HOST -oN evidence/HOST-pop3.txt
nmap --script imap-capabilities,imap-ntlm-info -p143 HOST -oN evidence/HOST-imap.txt
```
Plaintext `USER`/`PASS` or `LOGIN` allowed without STARTTLS/implicit TLS → finding (`class=misconfig`, CWE-319). `*-ntlm-info` leaks the AD/domain and hostname → `class=infodisclosure`. Default mailbox creds → `class=default-creds` (brute = intrusive, gate it).

## SMB / RPC — 139/445 and MSRPC 135 (smb-rpc, CWE-306/CWE-200)
```bash
enum4linux-ng -A HOST | tee evidence/HOST-smb.txt        # OS, users, groups, shares, password policy, RID cycling
nmap --script smb-os-discovery,smb-protocols,smb-security-mode,smb2-security-mode,smb-enum-shares,smb-enum-users,smb-enum-domains,smb-enum-groups,smb-enum-sessions -p139,445 HOST -oN evidence/HOST-smbnse.txt
smbclient -L //HOST/ -N                                  # null-session share listing
nxc smb HOST -u '' -p '' --shares --users --sessions     # netexec; crackmapexec on older builds
nxc smb HOST -u 'guest' -p '' --shares                   # guest fallback
rpcclient -U '' -N HOST -c 'enumdomusers;querydominfo'   # null-session RPC
nmap --script msrpc-enum -p135 HOST                      # MSRPC endpoint mapper
```
- Null/guest session listing shares or users → hypothesis (`class=smb-rpc`/`authz`, CWE-306/CWE-284). Anonymous access to a share **containing data** is a finding.
- SMBv1 enabled → finding (`class=outdated-service`/`misconfig`); signing not required (`smb-security-mode`/`smb2-security-mode`) → `class=misconfig` (NTLM relay risk).
- MS17-010 / MS08-067 check (`vuln` category, safe to run): `nmap --script smb-vuln-ms17-010 -p445 HOST`. A positive is a critical finding (`class=outdated-service`) — but *exploiting* it is intrusive, `approval`-gate.
- Reading a share is enumeration; **writing** to one, password spraying, or exploiting a vuln is intrusive → `approval` blocker.

## LDAP / Active Directory — 389/636/3268/3269 (authz / infodisclosure)
```bash
nmap --script ldap-rootdse,ldap-search -p389 HOST -oN evidence/HOST-ldap.txt
ldapsearch -x -H ldap://HOST -s base -b "" namingContexts defaultNamingContext   # anonymous rootDSE
ldapsearch -x -H ldap://HOST -b "DC=acme,DC=test" '(objectClass=*)'              # anonymous bind dump (if allowed)
```
Anonymous bind that returns directory data → finding (`class=authz`, CWE-287 Improper Authentication + CWE-200). For AD, capture domain/naming contexts and any user objects; feed usernames to Kerberos work below. `ldap-brute` is `intrusive`/`brute` — gate it.

## SNMP — 161/udp (snmp, CWE-1392/CWE-200)
```bash
onesixtyone -c /usr/share/seclists/Discovery/SNMP/common-community-strings.txt HOST   # find community strings
snmpwalk -v2c -c public HOST | tee evidence/HOST-snmp.txt        # if 'public' works, dump the MIB
snmp-check HOST -c public
nmap -sU --script snmp-info,snmp-netstat,snmp-win32-users -p161 HOST -oN evidence/HOST-snmpnse.txt
```
A working community string (`public`/`private`/vendor default) is a finding (`class=snmp`, CWE-1392 Use of Default Credentials + CWE-200) — SNMP leaks processes, routes, ARP, users, sometimes credentials. Useful OIDs: `1.3.6.1.4.1.77.1.2.25` (Windows users), `1.3.6.1.2.1.25.4.2.1.2` (running processes), `1.3.6.1.2.1.25.6.3.1.2` (installed software). Read-write community → higher severity (`class=misconfig`). `snmp-brute` is `intrusive`/`brute` — gate it; `onesixtyone` against a small default list is standard recon.

## Databases — unauth / default access (exposed-db, CWE-306/CWE-668)
Datastores are the highest-value network surface — enumerate **every** DB port, including second instances on odd ports.
```bash
# MySQL/MariaDB 3306
nmap --script mysql-info,mysql-empty-password,mysql-users -p3306 HOST -oN evidence/HOST-mysql.txt
mysql -h HOST -u root --password='' -e 'select version();'
# MSSQL 1433
nmap --script ms-sql-info,ms-sql-ntlm-info,ms-sql-empty-password -p1433 HOST -oN evidence/HOST-mssql.txt
# PostgreSQL 5432
psql "host=HOST user=postgres password=postgres connect_timeout=5" -c 'select version();'
# Oracle TNS 1521
nmap --script oracle-tns-version,oracle-sid-brute -p1521 HOST -oN evidence/HOST-oracle.txt
# Redis 6379 — frequently fully unauthenticated
redis-cli -h HOST ping ; redis-cli -h HOST info server
nmap --script redis-info -p6379 HOST
# MongoDB 27017 — legacy installs bind 0.0.0.0 with no auth
mongosh --host HOST --quiet --eval 'db.adminCommand({listDatabases:1})'
nmap --script mongodb-info,mongodb-databases -p27017 HOST
# Memcached 11211 — no auth by design; leaks cached data
printf 'stats\r\n' | nc -w3 HOST 11211
# Elasticsearch 9200 — REST API, often no auth
curl -s "http://HOST:9200/_cat/indices?v" ; curl -s "http://HOST:9200/_cluster/health?pretty"
```
Unauthenticated DB access → finding (`class=exposed-db`, CWE-306 + CWE-668 Exposure to Wrong Sphere). Default/weak creds (`root:''`, `postgres:postgres`, `sa:sa`) → finding (`class=default-creds`, CWE-1392) — NOT CWE-1188. Prove it with a **single benign** query (`version()`, `ping`, `_cat/indices`), capture to evidence, then STOP — do not dump data unless the engagement authorizes it (`approval` blocker). `*-empty-password` NSE scripts attempt a login (mild-intrusive); `oracle-sid-brute` is `intrusive`/`brute` — gate it.

## RDP / VNC / WinRM — 3389 / 5900 / 5985-5986 (exposed-admin / misconfig)
```bash
nmap --script rdp-ntlm-info,rdp-enum-encryption -p3389 HOST -oN evidence/HOST-rdp.txt
nmap --script vnc-info,vnc-title,realvnc-auth-bypass -p5900 HOST -oN evidence/HOST-vnc.txt
nxc winrm HOST -u '' -p ''                              # WinRM reachability / auth (netexec)
```
NLA disabled / weak RDP encryption → hypothesis (`class=misconfig`). VNC reachable with **no or weak auth** → finding (`class=unauth-service`/`exposed-admin`, CWE-306). `realvnc-auth-bypass` (`vuln`) checks CVE-2006-2369. Exposed management interface reachable from an untrusted segment → `class=exposed-admin` (CWE-668). Actual login attempts / `evil-winrm` are intrusive → `approval` blocker; reuse `recall loot` handles first.

## Kerberos — 88 (AD) (default-creds / infodisclosure)
```bash
nmap --script krb5-enum-users --script-args krb5-enum-users.realm='acme.test' -p88 HOST   # valid-user check
kerbrute userenum -d acme.test --dc HOST users.txt                                         # user enumeration (no creds)
impacket-GetNPUsers acme.test/ -usersfile users.txt -dc-ip HOST -no-pass                   # AS-REP roast (no pre-auth)
```
Valid users found → hypothesis (`class=infodisclosure`). AS-REP-roastable accounts (no pre-auth) → finding/hypothesis (`class=default-creds`/`misconfig`). Cracking returned hashes is offline and needs `approval`; captured hashes go to `record kind=loot` by handle. (Kerberoasting needs valid creds — reuse `recall loot`.)

## NFS / rpcbind — 2049 / 111 (unauth-service / authz)
```bash
rpcinfo -p HOST                                  # registered RPC programs
showmount -e HOST                                # exported NFS shares + allowed hosts
nmap --script nfs-showmount,nfs-ls,nfs-statfs -p2049 HOST -oN evidence/HOST-nfs.txt
```
World-readable export (`*` / no host restriction) → finding (`class=unauth-service`/`authz`, CWE-306). Note `no_root_squash` exports (privilege-escalation risk) → `class=misconfig`. Mounting/reading data beyond the listing is intrusive if it exposes sensitive data — capture the export list, gate the mount.

## TLS/SSL — any encrypted port (tls, CWE-326/CWE-327/CWE-295)
Run against every TLS-wrapped service (443, 636, 993, 995, 465, 3389, 5986, DB TLS ports):
```bash
nmap --script ssl-enum-ciphers,ssl-cert,ssl-heartbleed -p443 HOST -oN evidence/HOST-tls.txt
testssl.sh --quiet HOST:443 | tee evidence/HOST-testssl.txt     # or: sslscan HOST:443
```
Weak/legacy protocols (SSLv2/SSLv3/TLS1.0/1.1), weak ciphers/DH, expired/self-signed/hostname-mismatch cert, Heartbleed/POODLE → hypotheses (`class=tls`: CWE-326 Inadequate Encryption Strength / CWE-327 Broken Crypto / CWE-295 Improper Cert Validation). `ssl-enum-ciphers` is `intrusive` (many handshakes) but read-only.

## Long-tail / other exposed services (don't skip these)
Quick per-port triage so nothing open is left unenumerated:
| Port(s) | Service | First check | Class |
|---|---|---|---|
| 135 | MSRPC endpoint mapper | `nmap --script msrpc-enum -p135`, `rpcdump.py @HOST` | smb-rpc |
| 623/udp | IPMI/BMC | `nmap -sU --script ipmi-version,ipmi-cipher-zero -p623` (cipher-0 auth bypass) | default-creds / unauth-service |
| 873 | rsync | `rsync --list-only rsync://HOST/` (anonymous module listing) | unauth-service |
| 2049/111 | NFS/rpcbind | `showmount -e HOST` | unauth-service |
| 2375/2376 | Docker API | `curl -s http://HOST:2375/version` (unauth = host RCE) | exposed-admin / unauth-service |
| 5601 | Kibana | `curl -sI http://HOST:5601/` (unauth dashboard → ES data) | exposed-admin |
| 6443/10250 | Kubernetes API/kubelet | `curl -sk https://HOST:6443/version`, `https://HOST:10250/pods` | exposed-admin |
| 9000/8080/8443 | Jenkins/Tomcat/app mgmt | banner + `/manager/html`, `/script` | exposed-admin / default-creds |
| 9200/9300 | Elasticsearch | `curl -s http://HOST:9200/_cat/indices?v` | exposed-db |
| 11211 | Memcached | `printf 'stats\r\n' | nc -w3 HOST 11211` | exposed-db |
| 27017/28017 | MongoDB | `mongosh --host HOST --eval 'db.adminCommand({listDatabases:1})'` | exposed-db |
| 500/udp | IKE/VPN | `ike-scan HOST` (aggressive mode = PSK leak) | misconfig |
| 69/udp | TFTP | `nmap -sU --script tftp-enum -p69`; grab configs unauth | unauth-service |
For anything not listed: `nmap -sV --version-all`, grab the banner, search the version for known CVEs (`class=outdated-service`), and record it — an unrecognized service is a hypothesis with `outcome=inconclusive`, never a silent skip.

## Wire it back
```
record kind=hypothesis statement="SMB null session lists shares+users on 10.10.20.7" target=s1 class=smb-rpc approach="smbclient -L -N; nxc smb -u '' -p '' --shares" outcome=testing
record kind=hypothesis statement="SNMP 'public' community responds on .8/udp — MIB dumpable" target=s3 class=snmp approach="onesixtyone; snmpwalk -v2c -c public" outcome=inconclusive
record kind=finding title="Unauthenticated Redis on 10.10.20.9:6379" severity=high target=s4 class=exposed-db cwe=CWE-306 description="redis-cli -h host ping -> PONG; INFO returns full server config, no AUTH required" evidence=["evidence/h9-redis.txt"]
```
- Map each service to its checklist `class` (`unauth-service`, `default-creds`, `outdated-service`, `smb-rpc`, `snmp`, `dns`, `tls`, `exposed-db`, `exposed-admin`, `authz`, `misconfig`, `infodisclosure`, `segmentation`) — use only these ids. Run `recall next` to keep going and `recall gaps` to see what is untested; the goal is an empty gap list.
- **Intrusive = blocker.** Brute force/spraying, share/DB writes, data dumps, active relay tests, exploit attempts, mounting NFS with sensitive data all need `record kind=blocker blockerType=approval`; the cell goes `blocked` and you route around it until answered.
- Confirm before recording a finding: re-run the decisive check by hand (single query / null session / one handshake) so a scanner false-positive never becomes a finding. Keep uncertain leads as `outcome=inconclusive` hypotheses rather than deleting them.

## References
- PTES — Vulnerability Analysis (network service testing) — Penetration Testing Execution Standard (pentest-standard.org; link omitted, site not fetch-verifiable this session)
- NIST SP 800-115, Technical Guide to Information Security Testing and Assessment — https://csrc.nist.gov/pubs/sp/800/115/final
- Nmap NSE script documentation (verify script name/categories, e.g. `smb-enum-shares`, `ssl-enum-ciphers`, `snmp-info`, `smtp-open-relay`) — https://nmap.org/nsedoc/
- NetExec (nxc) Wiki — SMB/WinRM null-session & enumeration syntax — https://www.netexec.wiki/
- enum4linux-ng (`-A` all modules; `-U`/`-S`/`-P`/`-G` selective) — https://github.com/cddmp/enum4linux-ng
- CWE-306 Missing Authentication for Critical Function — https://cwe.mitre.org/data/definitions/306.html
- CWE-1392 Use of Default Credentials — https://cwe.mitre.org/data/definitions/1392.html
- CWE-668 Exposure of Resource to Wrong Sphere — https://cwe.mitre.org/data/definitions/668.html
