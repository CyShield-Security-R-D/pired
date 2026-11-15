---
name: review-sast-semgrep
description: Use when driving semgrep/opengrep — pick rulesets, write custom sink rules, emit SARIF to evidence/, and verify each hit by reading the code.
---

# SAST with semgrep / opengrep

Goal: widen coverage fast, then set confidence by reading the code. Semgrep finds *candidates*; your read of the data flow turns one into a `finding` or a downgraded lead — it does not silently delete anything. `opengrep` is the drop-in FOSS fork — the flags below work on either binary.

**SAST does not clear a class.** Semgrep is strong on injection/crypto/secrets patterns but **blind to missing authorization, IDOR, broken authentication, and business-logic/insecure-design flaws** — the harness's biggest miss areas. A clean scan for those classes means *nothing*; you must still do the manual per-endpoint authz pass and logic pass (`review-methodology` §5–6, `review-authz-authn`). Never treat "semgrep found nothing" as coverage.

Tools run via `bash` and may be absent. If neither `semgrep` nor `opengrep` is installed: `record kind=blocker blockerType=input question="install semgrep (pip install semgrep)?"` and fall back to the ripgrep recipes in the class skills. Always write raw output to `evidence/`.

## 1. Choose rulesets
```bash
mkdir -p "$PIRED_WORKSPACE/evidence"
# broad, auto-detects languages (fetches the registry the first time → needs network)
semgrep --config auto --sarif -o "$PIRED_WORKSPACE/evidence/semgrep.sarif" . 2>"$PIRED_WORKSPACE/evidence/semgrep.err"
# curated security packs (verified registry slugs):
semgrep --config p/default --config p/security-audit --config p/owasp-top-ten \
        --config p/secrets --config p/ci --sarif -o "$PIRED_WORKSPACE/evidence/semgrep-sec.sarif" .
# language / framework packs (registry slugs; run only those matching §1 orient):
semgrep --config p/javascript --config p/typescript --config p/react --config p/nodejsscan .
semgrep --config p/python --config p/django --config p/flask .
semgrep --config p/java --config p/spring .
semgrep --config p/golang --config p/gosec --config p/php --config p/ruby --config p/csharp .
# offline / registry blocked → run local rule dirs only:
semgrep --config ./rules --sarif -o "$PIRED_WORKSPACE/evidence/semgrep.sarif" .
```
Confirm a slug exists before asserting a finding from it (`semgrep --config p/<slug> --dryrun .` errors on an unknown pack); never invent a ruleset name. Handy flags: `--severity ERROR` (drop noise), `--exclude 'test/**' --exclude '*.min.js'`, `--json`/`--sarif`/`--gitlab-sast` output, `--metrics off`, `--max-target-bytes 2000000`, `--dataflow-traces` (show the taint path in output).

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
    pattern-sanitizers:              # declaring the real sanitizer cuts false positives
      - pattern: db.escape(...)
```
```bash
semgrep --config "$PIRED_WORKSPACE/evidence/rules/rawquery.yml" --sarif -o "$PIRED_WORKSPACE/evidence/rawquery.sarif" .
semgrep --test "$PIRED_WORKSPACE/evidence/rules/"    # validate a rule's own logic quickly
```
`mode: taint` with `pattern-sources`/`pattern-sinks`/`pattern-sanitizers` is the highest-signal way to encode a source→sink question. Write one per project-specific sink you find in the class skills.

## 3. Triage the SARIF
```bash
# rank by rule, see counts before opening files
jq -r '.runs[].results[] | [.ruleId, .locations[0].physicalLocation.artifactLocation.uri, (.locations[0].physicalLocation.region.startLine|tostring)] | @tsv' \
  "$PIRED_WORKSPACE/evidence/semgrep.sarif" | sort | uniq -c | sort -rn | head -40
# or human view:
semgrep --config auto --severity ERROR .
```
Skim by rule id: cluster the injection/deser/authz/crypto/secrets rules to the top, deprioritize style/`p/ci` lint rules — but **triage, do not delete**. A low-severity or noisy-looking rule can still mark a real bug.

## 4. Mandatory verify-by-reading step (sets confidence, never deletes)
For each hit that survives triage, open the exact `file:line` and confirm:
- **Source is attacker-controlled** — trace the tainted var back to a real request/CLI/env/file/queue input, not a constant or an internal trusted value.
- **Sink is reachable** — the function is actually called on a path an attacker can hit; not dead code, not test-only.
- **No sanitizer between them** — no parameterization, allowlist, encoder, canonicalizer, type coercion, or framework auto-escaping neutralizing it.

Then record one of three outcomes — you must not drop the lead:
```
# survives verification → confirmed:
record kind=finding title="Command injection in deploy handler" severity=critical target=<id> class=cmdi cwe=CWE-78 description="req.body.branch flows to child_process.exec" repro="POST /deploy {branch:'x;id'}" evidence=["evidence/semgrep.sarif","server/deploy.js:88"] status=confirmed
# genuinely sanitized/unreachable → refuted with the SPECIFIC reason:
record kind=hypothesis id=y9 outcome=refuted method="semgrep flagged deploy.js:88 but branch is validated against ^[\\w./-]+$ at line 80"
# plausible but you could not fully trace it → KEEP as low-confidence, route via recall gaps:
record kind=hypothesis id=y9 outcome=inconclusive method="semgrep taint hit deploy.js:88; source path crosses a helper I couldn't fully resolve — needs another look"
```

## 5. Wire into the loop
- Record a `hypothesis` per class before diving; `recall gaps` to see untested class×surface cells.
- Keep every raw scan in `evidence/`; reference the SARIF path in the finding's `evidence[]`.
- **Semgrep's coverage ≠ your coverage.** A clean scan for a class does not clear it — grep the sinks yourself (class skills), read the high-value handlers by hand, and run the scanner-blind authz/logic passes. Do not conclude while `recall gaps` is non-empty.

## References
- Semgrep CLI reference (flags, `--config`, `--sarif`, `--test`) — https://semgrep.dev/docs/cli-reference
- Semgrep taint mode (`mode: taint`, sources/sinks/sanitizers) — https://semgrep.dev/docs/writing-rules/data-flow/taint-mode
- Semgrep Registry — `p/owasp-top-ten` ruleset — https://semgrep.dev/p/owasp-top-ten
- OASIS SARIF 2.1.0 output specification — https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
- OWASP Code Review Guide v2 — https://owasp.org/www-project-code-review-guide/
