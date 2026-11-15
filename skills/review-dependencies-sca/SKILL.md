---
name: review-dependencies-sca
description: Use when reviewing dependencies for known/outdated vulns — run npm audit, pip-audit, osv-scanner, govulncheck, bundler/composer audit; record every advisory.
---

# Software composition analysis (SCA)

Goal: find **every** known-vulnerable / outdated dependency and record it. Missing outdated components is the single biggest recall gap in code review — so the rule here is **record-first**: every advisory that matches an installed version becomes a finding. Reachability analysis then sets its **confidence and severity** — it does **not** decide whether the advisory is recorded. A vuln you import but can't prove you reach is a *lower-confidence* finding, not a dropped one; note the residual doubt and let the operator patch.

**This pass is mandatory.** If a codebase has any manifest/lockfile, run SCA before you finish — never skip it, and never close the review with `recall gaps` still showing `sca` untested. Tools run via `bash` and may be absent; if all are missing, fall back to reading lockfiles and checking advisories manually (step 6), and `record kind=blocker blockerType=input question="install osv-scanner?"`. Save raw output to `evidence/`.

## 1. Identify every ecosystem & lockfile
```bash
ls package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lockb \
   requirements*.txt poetry.lock Pipfile.lock pdm.lock uv.lock pyproject.toml \
   go.mod go.sum pom.xml build.gradle build.gradle.kts gradle.lockfile \
   Gemfile.lock composer.lock composer.json Cargo.lock *.csproj packages.lock.json 2>/dev/null
find . -name package.json -not -path '*/node_modules/*' | head   # monorepo: multiple manifests
```
Lockfiles pin the **exact installed version** — that's what you match against advisories (a range in a manifest isn't precise enough). Enumerate **all** of them (monorepos/polyglot repos have several).

## 2. Run the ecosystem SCA tool(s) — run every one that applies
```bash
mkdir -p "$PIRED_WORKSPACE/evidence"
# --- Node (pick by the lockfile that exists) ---
npm audit --json > "$PIRED_WORKSPACE/evidence/npm-audit.json" 2>/dev/null || true
pnpm audit --json > "$PIRED_WORKSPACE/evidence/pnpm-audit.json" 2>/dev/null || true
yarn npm audit --json > "$PIRED_WORKSPACE/evidence/yarn-audit.json" 2>/dev/null || yarn audit --json > "$PIRED_WORKSPACE/evidence/yarn-audit.json" 2>/dev/null || true
npx --yes retire --outputformat json --outputpath "$PIRED_WORKSPACE/evidence/retire.json" 2>/dev/null || true   # also flags vendored/bundled libs
# --- Python ---
pip-audit -r requirements.txt -f json -o "$PIRED_WORKSPACE/evidence/pip-audit.json" 2>/dev/null || true
pip-audit -f json -o "$PIRED_WORKSPACE/evidence/pip-audit-env.json" 2>/dev/null || true    # audits the installed env (also reads pyproject/poetry)
# --- Go (call-graph reachability built in) ---
govulncheck -json ./... > "$PIRED_WORKSPACE/evidence/govulncheck.json" 2>/dev/null || govulncheck ./... > "$PIRED_WORKSPACE/evidence/govulncheck.txt" 2>/dev/null || true
# --- Ruby / PHP / Java ---
bundle audit check --update 2>/dev/null > "$PIRED_WORKSPACE/evidence/bundler-audit.txt" || bundle-audit check --update 2>/dev/null > "$PIRED_WORKSPACE/evidence/bundler-audit.txt" || true
composer audit --format=json > "$PIRED_WORKSPACE/evidence/composer-audit.json" 2>/dev/null || true
mvn -q org.owasp:dependency-check-maven:check 2>/dev/null || gradle dependencyCheckAnalyze 2>/dev/null || true
# --- Cross-ecosystem: OSV (reads most lockfiles) and Trivy (SBOM + advisories) ---
osv-scanner --lockfile=package-lock.json --format json --output "$PIRED_WORKSPACE/evidence/osv.json" 2>/dev/null || true
osv-scanner -r --format json --output "$PIRED_WORKSPACE/evidence/osv-all.json" . 2>/dev/null || osv-scanner scan source -r . --format json --output "$PIRED_WORKSPACE/evidence/osv-all.json" 2>/dev/null || true
trivy fs --scanners vuln --format json -o "$PIRED_WORKSPACE/evidence/trivy-fs.json" . 2>/dev/null || true
```
- **`govulncheck`** does Go call-graph analysis and surfaces only vulns your code transitively calls — treat its hits as **high-confidence, reachable**. (`npm/pnpm/yarn audit`, `pip-audit`, `osv-scanner`, `trivy`, `composer audit`, `bundler-audit` report by **version presence**, so they feed step 4/5.)
- `osv-scanner` flags: `--lockfile=<file>` for one lockfile, `-r` (recursive) to walk the tree; v2 also exposes `osv-scanner scan source`. `--format json`.
- `composer audit` also reports **abandoned** packages and packages flagged as **malware**; `retire.js` also catches vendored/minified front-end libs that no lockfile lists.

## 3. Triage: enumerate every advisory
```bash
# OSV / trivy: pull the advisory ids
jq -r '.results[]?.packages[]?.vulnerabilities[]?.id' "$PIRED_WORKSPACE/evidence/osv-all.json" 2>/dev/null | sort -u
jq -r '.. | objects | select(.id and (.id|test("^(CVE|GHSA|PYSEC|RUSTSEC|GO)-"))) | .id' "$PIRED_WORKSPACE/evidence/osv.json" 2>/dev/null | sort -u
# npm audit: package -> severity -> advisory
jq -r '.vulnerabilities | to_entries[] | "\(.key)\t\(.value.severity)"' "$PIRED_WORKSPACE/evidence/npm-audit.json" 2>/dev/null | sort -u
```
List **each** advisory with its package, installed version, fixed version, severity, and the **affected function/feature** (the vuln is usually one API, not the whole package). Do not pre-filter by severity here — a low-severity advisory is still a finding.

## 4. Reachability — sets confidence/severity, NOT inclusion
For each advisory, gather signals (they raise/lower confidence; they never delete the finding):
```bash
# direct dep or transitive-only? (transitive still ships and still runs)
rg -n "\"<pkg>\"|^<pkg>[=<>~ ]|<pkg> " package.json requirements.txt go.mod pom.xml Gemfile composer.json 2>/dev/null
# is the package imported, and the vulnerable API called?
rg -n "require\(['\"]<pkg>|import .*<pkg>|from ['\"]?<pkg>|<pkg>\.<vulnerable_func>\(" .
```
- **Reachable** (imported AND the affected API/path is exercised, or `govulncheck` confirms) → **confirmed** finding, full severity.
- **Reachability uncertain** (imported but the specific call is hard to trace, dynamic dispatch, framework-invoked, or the affected path is data-dependent) → **record anyway** as an unconfirmed / lower-confidence finding (`status=open`) with a note explaining the residual doubt. Do **not** drop it.
- **Transitive-only / not obviously called** → still record (transitive code runs at runtime); mark lower confidence/severity, note "transitive, call site not located".
- **Dev/test-only** (`devDependencies`, test scope) → record at reduced severity; it doesn't ship to prod but can still hit CI/build supply chain.
- Always confirm the **installed version** (from the lockfile) actually falls inside the advisory's vulnerable range — that's the one check that legitimately downgrades a hit to a note (version not affected).

## 5. Wire into the loop
Record a hypothesis per advisory, then promote to a finding. Reachable → `status=confirmed`; uncertain → `status=open` with residual-doubt note. Keep refuted/inconclusive hypotheses (no-retest + audit trail).
```
record kind=hypothesis statement="lodash 4.17.11 (CVE-2019-10744) present; is defaultsDeep reachable?" target=package-lock.json class=sca approach="grep lodash import + affected api" outcome=testing
record kind=finding title="Prototype pollution via vulnerable lodash (CVE-2019-10744)" severity=high target=package-lock.json class=sca cwe=CWE-1321 description="lodash 4.17.11 <4.17.12; _.defaultsDeep called on request data in api/merge.js:30 (reachable)" repro="see CVE-2019-10744; reachable via POST /merge" evidence=["evidence/osv.json","api/merge.js:30"] status=confirmed hypothesisId=y6
record kind=finding title="Outdated Spring with RCE advisory (CVE-2022-22965, Spring4Shell)" severity=high target=pom.xml class=sca cwe=CWE-1395 description="spring-webmvc 5.3.17 in affected range; call site not confirmed — record with residual doubt" repro="see CVE-2022-22965" evidence=["evidence/osv-all.json","pom.xml:44"] status=open hypothesisId=y7
```
Always cite the **advisory/CVE/GHSA id**, the package + installed version, and (when found) the call site. Reachable → `severity` per the advisory; uncertain → keep the finding at reduced confidence with a note, not deleted. The whole point: **an outdated-component lead is never silently dropped.**

## 6. No-tool fallback (still find them)
If no SCA tool is installed, read the lockfile versions and check them against advisories by hand:
```bash
rg -n "\"version\"|resolved" package-lock.json | head        # exact versions
grep -E "==|~=" requirements.txt ; sed -n 's/^/  /p' go.sum | head
```
Then look up each package@version against the ecosystem advisory DB (npm advisories / GitHub Advisory Database / OSV / PyPI PYSEC / RubySec / FriendsOfPHP). Record every match as above with `status=open` and a note that the check was manual. Record the tooling gap as a `note`/`blocker` so it's visible.

## References
- OSV-Scanner (`--lockfile`, `-r`, guided remediation) — https://google.github.io/osv-scanner/
- govulncheck (Go call-graph reachability) — https://go.dev/security/vuln/
- pip-audit (`-r`, `-f json`, env audit) — https://pypi.org/project/pip-audit/
- bundler-audit (`bundle-audit check --update`, reads Gemfile.lock) — https://github.com/rubysec/bundler-audit
- composer audit (JSON, abandoned + malware detection) — https://getcomposer.org/doc/03-cli.md#audit
- CWE-1395: Dependency on Vulnerable Third-Party Component — https://cwe.mitre.org/data/definitions/1395.html
- CWE-1104: Use of Unmaintained Third-Party Components — https://cwe.mitre.org/data/definitions/1104.html
- OWASP A06:2021 Vulnerable and Outdated Components — https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/
