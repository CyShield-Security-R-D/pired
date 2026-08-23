---
name: review-methodology
description: Use when starting a read-only code audit — orient the codebase, map trust boundaries, run SAST to widen, then trace sources to sinks and record findings.
---

# Read-only code-review methodology

Goal: audit source for security defects without ever modifying it. Read, grep, and run scanners via `bash`; cite exact `file:line`; prefer real, reachable bugs over style nits. This is the entry-point skill — it orients you and hands off to the class/language skills.

Golden rule: **SAST widens coverage, reading verifies it.** Never `record kind=finding` from a scanner hit alone — confirm the source is attacker-controlled, the sink is dangerous, and no validator/parameterization sits between them.

Tools run via `bash` and may be absent. If a needed scanner is missing: try an alternative, else `record kind=note` the gap and (for a critical one) `record kind=blocker blockerType=input question="install semgrep?"`. Keep raw scanner output in `evidence/`; only distilled lines enter context.

## 0. Frame it in the loop
- Seed the surface as inventory so `recall gaps` has something to reason over: `record kind=host value=repo:<name>`; record entrypoints as `endpoint` and config files as `tech`/`note`.
- Record a `hypothesis` (tagged with its checklist `class`) before each deep-dive; mark `outcome` confirmed/refuted/inconclusive; promote confirmed ones to `finding`.
- Use `recall next` / `recall gaps` to stay systematic. **Never quit while `recall gaps` is non-empty.**

## 1. Orient — map the codebase
```bash
# languages & size
( command -v tokei >/dev/null && tokei ) || cloc . 2>/dev/null || \
  find . -type f -name '*.*' | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -30
# manifests / frameworks / build
ls package.json requirements.txt pyproject.toml go.mod pom.xml build.gradle \
   composer.json Gemfile *.csproj 2>/dev/null
# infra & CI
find . \( -name Dockerfile -o -name '*.tf' -o -name '*.yml' -o -name '*.yaml' \) \
  -not -path '*/node_modules/*' | grep -iE 'docker|k8s|kube|helm|terraform|\.github/workflows' | head
```
Record each stack element: `record kind=tech name=express version=4.18`. Note the framework — it dictates the source/sink APIs (see the `review-language-*` skills).

## 2. Enumerate trust boundaries & sources
Find where untrusted input enters — HTTP params/body/headers, CLI args, env, files, deserialization, DB reads, message queues, IPC.
```bash
# route/handler entrypoints (adjust per framework)
rg -n "@(Get|Post|Put|Delete|RequestMapping|RequestParam|RequestBody)" -g '*.java'
rg -n "app\.(get|post|put|delete)|router\.(get|post)|@app\.route|@router\.(get|post)" -g '*.{js,ts,py}'
# raw request sources
rg -n "req\.(query|body|params|headers|cookies)|request\.(GET|POST|args|form|json|values)|\$_(GET|POST|REQUEST|COOKIE)|os\.Getenv|process\.env|os\.args|sys\.argv" .
```
Record high-value entrypoints as `endpoint` and their user-controlled params as `param location=query|body|header`.

## 3. Run SAST to widen coverage
See `review-sast-semgrep` for depth. Fast baseline:
```bash
mkdir -p evidence
semgrep --config auto --sarif -o evidence/semgrep.sarif . 2>evidence/semgrep.err || \
  opengrep --config auto --sarif -o evidence/semgrep.sarif .
gitleaks detect --no-git -f sarif -r evidence/gitleaks.sarif . || true
```
Treat every hit as a **lead**, not a finding.

## 4. Manual source → sink tracing (the real work)
For each candidate: start at the source, follow the variable through assignments/transforms/function calls, and see if it reaches a dangerous sink (query/exec/eval/template/file/redirect/HTTP client/reflection) **without** an intervening validator, allowlist, parameterization, or encoder.
- Attacker-controlled source? (a hardcoded constant is not a bug)
- Reaches the sink on a real path? (is the function actually called?)
- Sanitized in between? (parameterized query, `shell=False`, allowlist, canonicalize, encode) — if yes, refute.

Hand off by class: `review-injection`, `review-authz-authn`, `review-crypto-secrets-handling`, `review-deserialization-ssrf`, `review-path-file`, `review-secrets`, `review-dependencies-sca`, `review-iac-cloud-config`.

## 5. Prioritize
Triage in this order — do not spend the whole budget on style: **auth/access control → injection → secrets/crypto → deser/SSRF/path → deps/config.** A missing authz check on an admin route or a SQLi in a login handler beats ten header nits.

## 6. Record coverage so you don't quit early
```
record kind=hypothesis statement="search() builds SQL by string concat with req.query.q" target=e_search class=sqli approach="trace req.query.q to db.query" outcome=testing
record kind=finding title="SQL injection in /search" severity=high target=e_search class=sqli cwe=CWE-89 description="req.query.q concatenated into SELECT" repro="GET /search?q=' OR 1=1--" evidence=["core/search.js:42"] status=confirmed hypothesisId=y4
```
Refuted/inconclusive hypotheses are **retained** — they prove you looked. Loop until `recall gaps` is empty across the code-review checklist classes (sqli, cmdi, authz, authn, crypto, secrets, deser, ssrf, xxe, pathtrav, upload, sca, iac).
