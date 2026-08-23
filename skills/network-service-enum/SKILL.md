---
name: network-service-enum
description: Use to enumerate a specific network service (SMB, LDAP, SNMP, DB, SSH, SMTP, RDP, etc.) for common weaknesses and seed hypotheses per checklist class.
---

# Per-service enumeration & common weaknesses

Goal: for each open service in inventory, run the standard enumeration, check the classic misconfigs/default-creds, and turn what you find into `record kind=hypothesis` (tagged with a checklist `class`) — promoting confirmed ones to findings. Passive/unauthenticated checks first; anything intrusive (brute force, write attempts) needs an operator `approval` blocker.

Tools run via `bash` and may be missing — try an alternative, else park a note/blocker. Every target must be in the authorized scope. Save raw output to `evidence/<host>-<svc>.txt`; keep only distilled findings in context.

## 0. Frame it in the loop
- Pick a service from `recall inventory` / `recall next`. `record kind=hypothesis` *before* testing so coverage tracks it.
- Confirm the service (don't trust the port/banner) before enumerating; a misidentified service wastes effort.
- Default-cred / unauth-access wins are often `critical`/`high` — record them as findings with evidence immediately.

## HTTP(S) — 80/443/8080/8443
Hand full web work to `web-recon` + the `web-*` skills. Quick network-level triage:
```bash
curl -sSI https://HOST/           # headers, server, redirects
nmap --script http-title,http-headers,http-methods,http-enum -p443 HOST -oN evidence/HOST-http.txt
```
Dangerous methods (`PUT`/`DELETE`/`TRACE`), verbose `Server` → hypotheses (`class=misconfig`/`secrets`).

## SSH — 22
```bash
nmap --script ssh2-enum-algos,ssh-auth-methods,ssh-hostkey -p22 HOST -oN evidence/HOST-ssh.txt
ssh -vv -o PreferredAuthentications=none -o BatchMode=yes user@HOST 2>&1 | grep -i 'authentications'
```
Weak KEX/ciphers, password auth enabled, exposed to internet → hypotheses. Brute force (`hydra`/`ncrack`) is intrusive → `approval` blocker first. Reuse `recall loot` creds by handle before ever brute-forcing.

## FTP — 21
```bash
nmap --script ftp-anon,ftp-syst,ftp-vsftpd-backdoor -p21 HOST -oN evidence/HOST-ftp.txt
# confirm anonymous access by hand
curl -s ftp://HOST/ --user anonymous:anonymous
```
Anonymous read/write → finding (CWE-548/CWE-276). Note the daemon version for known CVEs.

## SMB / RPC — 139/445
```bash
enum4linux-ng -A HOST | tee evidence/HOST-smb.txt        # OS, users, shares, groups, password policy
nmap --script "smb-os-discovery,smb-enum-shares,smb-enum-users,smb-protocols,smb-security-mode" -p139,445 HOST -oN evidence/HOST-smbnse.txt
# null / guest session -> list shares
smbclient -L //HOST/ -N
crackmapexec smb HOST -u '' -p '' --shares       # nxc on newer builds; null-session share listing
rpcclient -U '' -N HOST -c 'enumdomusers;querydominfo'
```
- Null-session enumeration, readable/writable shares, SMBv1 enabled, signing not required → hypotheses (`class=authz`/`misconfig`). Anonymous access to a share with data is a finding.
- Reading a share is enumeration; **writing** to one or password spraying is intrusive → `approval` blocker.

## LDAP / Active Directory — 389/636/3268
```bash
nmap --script "ldap-rootdse,ldap-search" -p389 HOST -oN evidence/HOST-ldap.txt
ldapsearch -x -H ldap://HOST -s base -b "" namingContexts     # anonymous rootDSE
ldapsearch -x -H ldap://HOST -b "DC=acme,DC=test"             # anonymous bind dump (if allowed)
```
Anonymous bind that returns directory data → finding (CWE-287/CWE-200). For AD, note domain/naming contexts; Kerberos work below.

## DNS — 53
```bash
dig axfr @HOST acme.test                    # zone transfer — full record dump if misconfigured
nmap --script "dns-zone-transfer,dns-nsid,dns-recursion" -p53 HOST -oN evidence/HOST-dns.txt
```
Successful AXFR → finding (CWE-200): it hands over the whole internal namespace. Open recursion → note (abuse/amplification risk).

## SMTP — 25/465/587
```bash
nmap --script "smtp-commands,smtp-open-relay,smtp-enum-users" -p25 HOST -oN evidence/HOST-smtp.txt
# manual user enumeration
printf 'EHLO x\r\nVRFY root\r\nQUIT\r\n' | nc -w5 HOST 25
```
Open relay → finding (CWE-269/abuse). `VRFY`/`EXPN`/`RCPT` user enumeration → hypothesis (`class=info`/enum).

## SNMP — 161/udp
```bash
onesixtyone -c /usr/share/seclists/Discovery/SNMP/common-community-strings.txt HOST   # find community strings
snmpwalk -v2c -c public HOST | tee evidence/HOST-snmp.txt        # if 'public' works, dump the MIB
snmp-check HOST -c public
```
A working community string (`public`/`private`) is a finding (CWE-200/CWE-1188): SNMP leaks processes, routes, users, sometimes credentials. `snmpwalk` on `1.3.6.1.4.1.77.1.2.25` (Windows users) etc.

## Databases — unauth / default access
```bash
# MySQL 3306
mysql -h HOST -u root --password='' -e 'select version();'
nmap --script "mysql-info,mysql-empty-password,mysql-users" -p3306 HOST
# MSSQL 1433
nmap --script "ms-sql-info,ms-sql-empty-password,ms-sql-ntlm-info" -p1433 HOST
# PostgreSQL 5432
psql "host=HOST user=postgres password=postgres" -c 'select version();'
# Redis 6379 — often fully unauthenticated
redis-cli -h HOST ping ; redis-cli -h HOST info server
# MongoDB 27017
mongosh --host HOST --eval 'db.adminCommand({listDatabases:1})'
```
Unauthenticated or default-cred DB access is almost always `high`/`critical` (CWE-1188/CWE-306). Prove it with a single benign query (`version()`, `ping`), capture output to evidence, then STOP — do not dump data unless the engagement authorizes it (get an `approval` blocker).

## RDP / VNC — 3389 / 5900
```bash
nmap --script "rdp-ntlm-info,rdp-enum-encryption" -p3389 HOST -oN evidence/HOST-rdp.txt
nmap --script "vnc-info,realvnc-auth-bypass,vnc-title" -p5900 HOST -oN evidence/HOST-vnc.txt
```
NLA disabled, weak encryption, VNC with no/weak auth → hypotheses. Actual login attempts are intrusive → `approval` blocker; reuse `recall loot` handles first.

## Kerberos — 88 (AD)
```bash
# user enumeration (no creds) — light
kerbrute userenum -d acme.test --dc HOST users.txt
# AS-REP roasting (accounts without pre-auth) — needs a user list; extraction only
impacket-GetNPUsers acme.test/ -usersfile users.txt -dc-ip HOST -no-pass
```
AS-REP-roastable accounts / valid users found → hypotheses. Cracking the returned hashes is offline and needs `approval`; captured hashes go to `record kind=loot` by handle.

## Wire it back
```
record kind=hypothesis statement="SMB null session lists shares on 10.10.20.7" target=s1 class=authz approach="smbclient -L -N"
record kind=finding title="Unauthenticated Redis on 10.10.20.9:6379" severity=high target=s4 class=misconfig cwe=CWE-306 description="redis-cli -h host ping -> PONG, INFO returns full server config" evidence=["evidence/h9-redis.txt"]
```
- Map each service to its checklist class; run `recall next` to keep going and `recall gaps` to see what is untested.
- **Intrusive = blocker.** Brute force, password spraying, share writes, data dumps, exploit attempts all need `record kind=blocker blockerType=approval`; the cell goes `blocked` and you route around it until answered.
- Confirm before recording: re-run the decisive check by hand (a single query / null session) so a scanner script false-positive never becomes a finding.
