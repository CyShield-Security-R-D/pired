---
name: review-secrets
description: Use when hunting hardcoded secrets, API keys, private keys, tokens and connection strings in source or git history; distinguish live from dummy. CWE-798.
---

# Hardcoded secrets & credential leaks

Goal: find committed credentials that are real and reachable, not test fixtures. Source: literal values in source/config/history. Sink: anything that authenticates (the leak *is* the vuln — CWE-798). Read-only: never exfiltrate or use a secret; record its location and mask it in reports.

Tools run via `bash` and may be absent. If `gitleaks`/`trufflehog` are missing, use the ripgrep patterns below, and `record kind=note` the tool gap. Write raw scanner output to `evidence/`.

## 1. Dedicated scanners
```bash
mkdir -p evidence
# gitleaks — filesystem (no git) AND full history
gitleaks detect --no-git -f sarif -r evidence/gitleaks-fs.sarif . || true
gitleaks detect --source . -f sarif -r evidence/gitleaks-history.sarif || true   # scans commits
# trufflehog — verifies many key types against their live API (only if authorized & network-ok)
trufflehog filesystem . --json > evidence/trufflehog.json 2>/dev/null || true
trufflehog git file://. --only-verified --json > evidence/th-verified.json 2>/dev/null || true
```
`--only-verified` is high-signal but performs an outbound check — confirm the engagement allows it before running; otherwise stay offline.

## 2. High-signal ripgrep patterns
```bash
# assignments of secret-looking keys
rg -nI --no-heading -i '(api[_-]?key|secret|passwd|password|token|access[_-]?key|private[_-]?key|client[_-]?secret|bearer)\s*[:=]\s*["\x27][^"\x27]{6,}' .
# provider key formats
rg -nI 'AKIA[0-9A-Z]{16}|aws_secret_access_key' .                # AWS
rg -nI 'gh[pousr]_[0-9A-Za-z]{36,}'                              # GitHub tokens
rg -nI 'AIza[0-9A-Za-z_\-]{35}'                                  # Google API
rg -nI 'sk_(live|test)_[0-9A-Za-z]{24,}|xox[baprs]-[0-9A-Za-z-]+' .   # Stripe / Slack
rg -nI 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'            # JWTs
# private keys
rg -nI 'BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY'
# DB / service connection strings with inline creds
rg -nI '(postgres|postgresql|mysql|mongodb(\+srv)?|redis|amqp|https?)://[^:@/\s]+:[^@/\s]+@' .
```

## 3. Git history (secrets survive a "fix" commit)
```bash
git log --all --oneline | head                                   # is it a git repo?
git log -p --all -S 'password' -- . | head -200                  # pickaxe: when a literal was added/removed
gitleaks detect --source . -f json -r evidence/gitleaks-history.json   # every commit
```
A secret deleted in HEAD but present in history is still exposed — record it with the commit hash.

## 4. Live vs test/dummy — the false-positive gate
Before recording, decide if it is real:
- **Dummy tells:** value is `example`/`changeme`/`xxxx`/`your-key-here`/`0000...`, sits under `test/`, `fixtures/`, `examples/`, `.env.example`, or docs; obviously placeholder length.
- **Live tells:** correct provider format & checksum (AKIA + 40-char secret, `sk_live_`), in real config/source, referenced by production code paths, high Shannon entropy on a random-looking string.
- **Entropy sanity check:**
```bash
python3 - <<'PY'
import math,collections
s="PUT-CANDIDATE-HERE"
p=[c/len(s) for c in collections.Counter(s).values()]
print("entropy bits/char:", round(-sum(x*math.log2(x) for x in p),2))  # >3.5 ≈ random-ish
PY
```
- A key format that a verifier confirms live = critical. A high-entropy blob in prod config with no dummy tell = report it (you cannot safely verify without using it).

## 5. Wire into the loop
```
record kind=hypothesis statement="AWS key literal in config/prod.py" target=config/prod.py class=secrets outcome=testing
record kind=finding title="Hardcoded AWS access key in prod config" severity=critical target=config/prod.py:12 class=secrets cwe=CWE-798 description="AKIA... live-format key committed" repro="see config/prod.py:12; format matches AWS access key" evidence=["evidence/gitleaks-fs.sarif","config/prod.py:12"] status=confirmed
```
Do **not** paste full secret values into findings/notes — reference `file:line` (redaction masks known secrets only at export). If you must retain one for the operator, use `record kind=loot handle=cred:leaked-aws` (that store is chmod 600). Mark placeholders as `outcome=refuted` with the reason.
