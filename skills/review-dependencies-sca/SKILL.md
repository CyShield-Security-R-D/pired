---
name: review-dependencies-sca
description: Use when reviewing dependencies for known vulns — run npm audit/pip-audit/osv-scanner/govulncheck, then confirm the vulnerable code path is reachable.
---

# Software composition analysis (SCA)

Goal: find known-vulnerable dependencies **and prove the vulnerable code path is used** before reporting. An advisory on a package you import but never exercise on the affected function is not a confirmed finding — it's a note. This is the false-positive gate for SCA.

Tools run via `bash` and may be absent. If an SCA tool is missing: `record kind=blocker blockerType=input question="install osv-scanner?"`, or fall back to reading the lockfile and checking advisories manually. Save raw output to `evidence/`.

## 1. Identify the ecosystems & lockfiles
```bash
ls package-lock.json yarn.lock pnpm-lock.yaml requirements.txt poetry.lock Pipfile.lock \
   go.mod go.sum pom.xml build.gradle Gemfile.lock composer.lock 2>/dev/null
```
Lockfiles pin exact versions — that's what you match against advisories (a range in a manifest isn't precise enough).

## 2. Run the ecosystem SCA tool
```bash
mkdir -p evidence
# Node
npm audit --json > evidence/npm-audit.json 2>/dev/null || true
# Python
pip-audit -r requirements.txt -f json -o evidence/pip-audit.json 2>/dev/null || true
# Go
govulncheck ./... > evidence/govulncheck.txt 2>/dev/null || true   # BEST: reports only reachable vulns
# Cross-ecosystem (reads most lockfiles)
osv-scanner --lockfile=package-lock.json --format json --output evidence/osv.json 2>/dev/null || true
osv-scanner scan --recursive . --format json --output evidence/osv-all.json 2>/dev/null || true
# Java / Ruby / PHP
mvn org.owasp:dependency-check-maven:check 2>/dev/null || true
bundle audit check --update 2>/dev/null || true
```
`govulncheck` is special — it does call-graph analysis and only flags vulns your code actually reaches; treat its hits as high-confidence. `npm audit`/`osv-scanner`/`pip-audit` report by version presence, so they need step 4.

## 3. Triage the report
```bash
jq -r '.vulnerabilities // .results // [] ' evidence/osv.json >/dev/null 2>&1 && \
  jq -r '.. | .id? // empty' evidence/osv.json | sort -u | head
```
Sort by severity and whether a fix exists. Pull each advisory's **affected function/feature** — the vuln is usually in one API, not the whole package.

## 4. Reachability check (the SCA false-positive gate)
For each high/critical advisory, confirm the vulnerable code path is used:
```bash
# is the package a direct dep or transitive-only?
rg -n "\"<pkg>\"" package.json requirements.txt go.mod pom.xml 2>/dev/null
# is the vulnerable API actually called in this codebase?
rg -n "require\(['\"]<pkg>|import .*<pkg>|from <pkg>|<pkg>\.<vulnerable_func>\(" .
```
- **Reachable** = the app imports the package AND calls the affected API (or an affected code path runs) → confirmed finding.
- **Not reachable** = transitive-only, unused, or the affected function is never called → record as a `note`/`hypothesis outcome=inconclusive`, not a confirmed finding. Note dev-only deps (`devDependencies`, test scope) as lower priority — they don't ship.
- Confirm the **installed version** is inside the vulnerable range (lockfile), not merely that a vulnerable version exists somewhere.

## 5. Wire into the loop
```
record kind=hypothesis statement="lodash 4.17.11 (CVE-2019-10744) present; is defaultsDeep reachable?" target=package-lock.json class=sca approach="grep for lodash import + affected api" outcome=testing
record kind=finding title="Prototype pollution via vulnerable lodash (CVE-2019-10744)" severity=high target=package-lock.json class=sca cwe=CWE-1321 description="lodash 4.17.11 <4.17.12; app calls _.defaultsDeep on request data in api/merge.js:30" repro="see CVE-2019-10744; reachable via POST /merge" evidence=["evidence/osv.json","api/merge.js:30"] status=confirmed hypothesisId=y6
```
Always cite the **advisory/CVE id** and the reachable call site. Record unreachable known-vulns as info/notes so the operator can still patch, but keep them out of the confirmed-findings set — that's the whole point of the reachability gate.
