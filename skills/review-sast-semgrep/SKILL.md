---
name: review-sast-semgrep
description: Use when driving semgrep/opengrep — pick rulesets, write custom sink rules, emit SARIF to evidence/, and verify each hit by reading the code.
---

# SAST with semgrep / opengrep

Goal: widen coverage fast, then kill false positives by reading the code. Semgrep finds *candidates*; only your read of the data flow turns one into a `finding`. `opengrep` is the drop-in FOSS fork — the flags below work on either binary.

Tools run via `bash` and may be absent. If neither `semgrep` nor `opengrep` is installed: `record kind=blocker blockerType=input question="install semgrep (pip install semgrep)?"` and fall back to the ripgrep recipes in the class skills. Always write raw output to `evidence/`.

## 1. Choose rulesets
```bash
mkdir -p evidence
# broad, auto-detects languages (needs network to fetch the registry the first time)
semgrep --config auto --sarif -o evidence/semgrep.sarif . 2>evidence/semgrep.err
# curated security packs — pick by what §1 orient found:
semgrep --config p/ci --config p/security-audit --config p/secrets --sarif -o evidence/semgrep-sec.sarif .
# language / framework packs:
semgrep --config p/javascript --config p/nodejsscan --config p/react .
semgrep --config p/python --config p/django --config p/flask .
semgrep --config p/java --config p/spring .
semgrep --config p/golang --config p/php --config p/ruby --config p/gosec .
# offline / registry blocked → run local rule dirs only:
semgrep --config ./rules --sarif -o evidence/semgrep.sarif .
```
Handy flags: `--severity ERROR` (drop noise), `--exclude 'test/**' --exclude '*.min.js'`, `--json`/`--sarif`/`--gitlab-sast` output, `--metrics off`, `--max-target-bytes 2000000`.

## 2. Write a quick custom rule for a specific sink
When you spot a project-specific dangerous helper (e.g. `db.rawQuery`, `render(templateFromUser)`), pin it with a tiny rule instead of grepping repeatedly:
```yaml
# evidence/rules/rawquery.yml
rules:
  - id: user-input-into-rawquery
    languages: [javascript, typescript]
    severity: ERROR
    message: user input reaches db.rawQuery — possible SQLi
    mode: taint
    pattern-sources:
      - pattern: req.$X
    pattern-sinks:
      - pattern: db.rawQuery(...)
```
```bash
semgrep --config evidence/rules/rawquery.yml --sarif -o evidence/rawquery.sarif .
# validate a rule's own logic quickly:
semgrep --test evidence/rules/
```
`mode: taint` with `pattern-sources`/`pattern-sinks`/`pattern-sanitizers` is the highest-signal way to encode a source→sink question.

## 3. Triage the SARIF
```bash
# rank by rule, see counts before opening files
jq -r '.runs[].results[] | [.ruleId, .locations[0].physicalLocation.artifactLocation.uri, (.locations[0].physicalLocation.region.startLine|tostring)] | @tsv' \
  evidence/semgrep.sarif | sort | uniq -c | sort -rn | head -40
# or human view:
semgrep --config auto --severity ERROR .
```
Skim by rule id: cluster the injection/deser/secrets rules to the top, deprioritize style/`p/ci` lint rules.

## 4. Mandatory verify-by-reading step (the whole point)
For each hit that survives triage, open the exact `file:line` and confirm:
- **Source is attacker-controlled** — trace the tainted var back to a real request/CLI/env/file input, not a constant or an internal trusted value.
- **Sink is reachable** — the function is actually called on a path an attacker can hit; not dead code, not test-only.
- **No sanitizer between them** — no parameterization, allowlist, encoder, type coercion, or framework auto-escaping neutralizing it.

Then:
```
# survives verification:
record kind=finding title="Command injection in deploy handler" severity=critical target=<id> class=cmdi cwe=CWE-78 description="req.body.branch flows to child_process.exec" repro="POST /deploy {branch:'x;id'}" evidence=["evidence/semgrep.sarif","server/deploy.js:88"] status=confirmed
# false positive (parameterized / sanitized / unreachable):
record kind=hypothesis id=y9 outcome=refuted method="semgrep flagged deploy.js:88 but branch is validated against ^[\\w./-]+$ at line 80"
```

## 5. Wire into the loop
- Record a `hypothesis` per class before diving; `recall gaps` to see untested class×surface cells.
- Keep every raw scan in `evidence/`; reference the SARIF path in the finding's `evidence[]`.
- Semgrep's coverage ≠ your coverage: a clean scan for a class does **not** clear that class — grep the sinks yourself (class skills) and read the high-value handlers by hand.
