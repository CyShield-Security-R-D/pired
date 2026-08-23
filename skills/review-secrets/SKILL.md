---
name: review-secrets
description: Use when hunting hardcoded secrets, API keys, private keys, tokens and connection strings in source or git history; distinguish live from dummy. CWE-798.
---

# Hardcoded secrets & credential leaks (CWE-798 · CWE-259 · CWE-522 · ASVS V2.10/V6 · WSTG-ATHN-08)

Goal: find committed credentials that are real and reachable, not test fixtures. Source: literal values in source/config/CI/history. Sink: anything that authenticates (the leak *is* the vuln — CWE-798). Read-only: never exfiltrate or use a secret; record its location and mask it in reports.

**Search everywhere a secret can hide — recall depends on breadth:** application source & config (`*.env`, `*.ini`, `*.yaml`, `*.json`, `*.properties`, `*.xml`, `appsettings.json`); CI/CD (`.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/`); container/IaC (`Dockerfile`, `docker-compose*.yml`, k8s manifests/`Secret` objects, `*.tf`/`*.tfvars`, Ansible vaults); package manager configs (`.npmrc`, `.pypirc`, `.netrc`, `pip.conf`, `settings.xml`); client bundles / mobile (`.apk`, minified JS); comments and commit messages; and the **git history**, where a secret survives a "fix" commit.

Tools run via `bash` and may be absent. If `gitleaks`/`trufflehog` are missing, use the ripgrep patterns below, and `record kind=note` the tool gap. Write raw scanner output to `evidence/`.

## 1. Dedicated scanners
```bash
mkdir -p evidence
# gitleaks — v8.19+ subcommands: `dir` scans a filesystem, `git` scans commit history
gitleaks dir . --report-format sarif --report-path evidence/gitleaks-fs.sarif || true
gitleaks git . --report-format sarif --report-path evidence/gitleaks-history.sarif || true   # every commit
# older gitleaks (detect is deprecated but still works as a fallback):
gitleaks detect --no-git -f sarif -r evidence/gitleaks-fs.sarif . || true
# trufflehog — verifies many key types against their live API (only if authorized & network-ok)
trufflehog filesystem . --json > evidence/trufflehog.json 2>/dev/null || true
trufflehog git file://. --results=verified --json > evidence/th-verified.json 2>/dev/null || true
```
`--results=verified` (older: `--only-verified`) is high-signal but performs an outbound check — confirm the engagement allows it before running; otherwise stay offline and keep every *unverified* hit as a lead.

## 2. High-signal ripgrep patterns — assignments & provider formats
```bash
# secret-looking assignments (generic)
rg -nI --no-heading -i '(api[_-]?key|secret|passwd|password|token|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|bearer|credential|passphrase)\s*[:=]\s*["\x27][^"\x27]{6,}' .
# cloud / provider key formats
rg -nI 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key' .                 # AWS access / STS
rg -nI 'AIza[0-9A-Za-z_\-]{35}|"type":\s*"service_account"' .                       # Google API key / GCP SA JSON
rg -nI 'gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{22,}'                    # GitHub PAT/tokens
rg -nI 'glpat-[0-9A-Za-z_\-]{20,}'                                                  # GitLab PAT
rg -nI 'sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}'                            # OpenAI
rg -nI 'sk_(live|test)_[0-9A-Za-z]{24,}|rk_(live|test)_[0-9A-Za-z]{24,}'            # Stripe
rg -nI 'xox[baprs]-[0-9A-Za-z-]+|https://hooks\.slack\.com/services/[A-Za-z0-9/]+'  # Slack token / webhook
rg -nI 'SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}|key-[0-9a-f]{32}'                # SendGrid / Mailgun
rg -nI 'AC[0-9a-f]{32}|SK[0-9a-f]{32}'                                              # Twilio
rg -nI 'npm_[0-9A-Za-z]{36}|//.*_authToken=|pypi-AgEIcHlwaS[0-9A-Za-z_\-]+'         # npm / .npmrc / PyPI
rg -nI 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*'                  # JWTs
rg -nI 'xapp-[0-9]-[A-Za-z0-9-]+|dop_v1_[0-9a-f]{64}|shpat_[0-9a-f]{32}'            # Slack app / DigitalOcean / Shopify
# private keys / certs
rg -nI 'BEGIN (RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY'
# DB / service connection strings with inline creds
rg -nI '(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp|ftp|ssh|https?)://[^:@/\s]+:[^@/\s]+@' .
# high-entropy base64/hex blobs in config
rg -nI '["\x27][A-Za-z0-9+/]{40,}={0,2}["\x27]|["\x27][0-9a-f]{32,}["\x27]' -g '*.{env,yml,yaml,json,ini,properties,conf}' .
```

## 3. Git history (secrets survive a "fix" commit)
```bash
git log --all --oneline | head                                   # is it a git repo?
git log -p --all -S 'password' -- . | head -200                  # pickaxe: when a literal was added/removed
gitleaks git . --report-format json --report-path evidence/gitleaks-history.json   # every commit
```
A secret deleted in HEAD but present in history is still exposed — record it with the commit hash.

## 4. Live vs test/dummy — a confidence gate, NOT a delete gate
Decide how confident you are; never discard a plausible real secret just because you can't verify it safely.
- **Dummy tells (→ refute):** value is `example`/`changeme`/`xxxx`/`your-key-here`/`placeholder`/`0000...`/`REDACTED`, sits under `test/`, `fixtures/`, `examples/`, `.env.example`, `__mocks__`, or docs; obviously placeholder length; a well-known public test key (e.g. Stripe's `sk_test_` docs key).
- **Live tells (→ confirm, higher severity):** correct provider format & checksum (AKIA + 40-char secret, `sk_live_`), in real config/source, referenced by production code paths, high Shannon entropy on a random-looking string, verifier confirms it live.
- **Uncertain (→ keep as a finding, don't drop):** a high-entropy blob in prod config with no dummy tell — you cannot safely verify without *using* it, so report it as an unconfirmed/low-confidence finding rather than deleting the lead.
- **Entropy sanity check:**
```bash
python3 - <<'PY'
import math,collections
s="PUT-CANDIDATE-HERE"
p=[c/len(s) for c in collections.Counter(s).values()]
print("entropy bits/char:", round(-sum(x*math.log2(x) for x in p),2))  # >3.5 ≈ random-ish
PY
```

## 5. Wire into the loop
```
record kind=hypothesis statement="AWS key literal in config/prod.py" target=config/prod.py class=secrets outcome=testing
record kind=finding title="Hardcoded AWS access key in prod config" severity=critical target=config/prod.py:12 class=secrets cwe=CWE-798 description="AKIA... live-format key committed" repro="see config/prod.py:12; format matches AWS access key" evidence=["evidence/gitleaks-fs.sarif","config/prod.py:12"] status=confirmed
```
Do **not** paste full secret values into findings/notes — reference `file:line` (redaction masks known secrets only at export). If you must retain one for the operator, use `record kind=loot handle=cred:leaked-aws` (that store is chmod 600). Mark placeholders as `outcome=refuted` with the reason; keep un-disproven high-entropy blobs as findings.

## References
- OWASP Secrets Management Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- MITRE CWE-798 Use of Hard-coded Credentials — https://cwe.mitre.org/data/definitions/798.html
- MITRE CWE-259 Use of Hard-coded Password — https://cwe.mitre.org/data/definitions/259.html
- MITRE CWE-522 Insufficiently Protected Credentials — https://cwe.mitre.org/data/definitions/522.html
- gitleaks (subcommands `git`/`dir`, SARIF output) — https://github.com/gitleaks/gitleaks
- trufflehog (`filesystem`/`git`, `--results=verified`) — https://github.com/trufflesecurity/trufflehog
