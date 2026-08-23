---
name: review-methodology
description: Use when starting a read-only code audit — orient, enumerate every entrypoint, run SAST/secrets/SCA plus manual authz & logic passes, trace sources to sinks.
---

# Read-only code-review methodology

Goal: audit source for security defects without ever modifying it. Read, grep, and run scanners via `bash`; cite exact `file:line`; prefer real, reachable bugs over style nits. This is the entry-point skill — it orients you and hands off to the class/language skills.

**Recall is the mission.** This harness historically MISSES real bugs — most often in access control, authentication, and insecure design, and it under-reports high-severity issues. Optimize for *not missing a true vulnerability*: a false negative (a real bug you never flagged) is worse than a false positive (an extra candidate the operator triages). Enumerate exhaustively, cover every entrypoint, and never silently drop a plausible lead.

Golden rule: **SAST + grep WIDEN coverage; reading sets CONFIDENCE and SEVERITY — it never deletes a candidate.** Never `record kind=finding status=confirmed` from a scanner hit alone. But the inverse is just as important: when you cannot *fully* confirm a plausible issue, you do **not** discard it — you downgrade its confidence (record a low-confidence/unconfirmed `finding`, or keep the `hypothesis` at `outcome=inconclusive` with a note) and route it via `recall gaps`. Deleting an un-disproven lead is how real bugs get missed.

Tools run via `bash` and may be absent. If a needed scanner is missing: try an alternative, else `record kind=note` the gap and (for a critical one) `record kind=blocker blockerType=input question="install semgrep?"`. Keep raw scanner output in `evidence/`; only distilled lines enter context.

## 0. Frame it in the loop
- Seed the surface as inventory so `recall gaps` has something to reason over: `record kind=host value=repo:<name>`; record entrypoints as `endpoint` and config files as `tech`/`note`.
- Record a `hypothesis` (tagged with its checklist `class`) before each deep-dive; mark `outcome` confirmed/refuted/inconclusive; promote confirmed ones to `finding`.
- Use `recall next` / `recall gaps` to stay systematic. **Do not conclude the audit while `recall gaps` is non-empty** — every untested class×surface cell is a potential missed bug.

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

## 2. Enumerate EVERY entrypoint & trust boundary (the coverage backbone)
The coverage matrix can only protect you from missing a bug if every surface element is in it. **Enumerate exhaustively — routes, handlers, controllers, CLI commands, cron/queue consumers, event/webhook handlers, GraphQL resolvers, gRPC/RPC methods, IPC, deserializers, template renders, and DB/file readers — then `record` each one as an `endpoint`** so it becomes a row in coverage. Missing surface = a class that never gets tested there.
```bash
# HTTP route/handler entrypoints (adjust per framework)
rg -n "@(Get|Post|Put|Delete|Patch|RequestMapping|GetMapping|PostMapping|RequestParam|RequestBody|PathVariable)" -g '*.java'
rg -n "app\.(get|post|put|delete|patch|all|use)|router\.(get|post|put|delete|patch|use)|@app\.route|@(bp|blueprint)\.route|@router\.(get|post|put|delete)|\.add_url_rule|Rails\.application\.routes|resources :|match .*=>|http\.HandleFunc|mux\.|gin\.|echo\.(GET|POST)" -g '*.{js,ts,py,rb,go}'
# non-HTTP entrypoints: CLI, queue/cron consumers, webhooks, GraphQL, gRPC, event handlers
rg -n "argparse|click\.command|commander|yargs|cobra\.Command|def main\(|if __name__|@(task|shared_task|celery)|@(Scheduled|KafkaListener|RabbitListener|SqsListener)|addEventListener|on\('message'|consume\(|@Resolver|@Query|@Mutation|type Query|grpc\.|ServeHTTP" .
# raw untrusted SOURCES entering the process
rg -n "req\.(query|body|params|headers|cookies|files)|request\.(GET|POST|args|form|json|values|files|data|headers|cookies)|\$_(GET|POST|REQUEST|COOKIE|FILES|SERVER)|os\.Getenv|process\.env|os\.args|sys\.argv|ARGV|flag\.|bufio\.NewReader|c\.(Query|Param|PostForm)|@RequestParam|@RequestBody|@PathVariable|getParameter" .
```
Record high-value entrypoints as `endpoint` and their user-controlled params as `param location=query|body|header|path|cookie`. **Sources to treat as untrusted** (not just HTTP): HTTP query/body/headers/cookies/multipart; CLI args & env vars; files & stdin; database rows written by users; message-queue / event payloads; webhook bodies; inter-service RPC; deserialized objects; parsed archives; imported/uploaded documents.

## 3. Mandatory breadth passes — run ALL of these (do not skip one because time is short)
Recall depends on doing every pass; a clean result on one pass never excuses skipping another. Each pass seeds hypotheses across the checklist classes.
- **(a) Full SAST sweep** — `review-sast-semgrep`: `semgrep --config auto` + curated packs, SARIF to `evidence/`. Treat every hit as a *lead*.
- **(b) Secrets sweep** — `review-secrets`: gitleaks/trufflehog + the ripgrep patterns, across the working tree **and git history**.
- **(c) Dependency / SCA sweep** — `review-dependencies-sca`: npm/pip/osv/govulncheck against lockfiles, then reachability.
- **(d) Manual per-endpoint authorization/authentication pass** — see §5. **SAST cannot find missing access control, IDOR, or broken auth** — these are the harness's biggest miss category, so this pass is non-negotiable and must visit *every* endpoint from §2.
- **(e) Business-logic / insecure-design pass** — see §6. Scanners cannot reason about intended behavior; you must.
Also run the class hand-offs: `review-injection`, `review-deserialization-ssrf`, `review-path-file`, `review-crypto-secrets-handling`, and the `review-language-*` skill for the stack, plus `review-iac-cloud-config`.

## 4. Manual source → sink tracing (taint the whole graph)
For each candidate: start at the source, follow the variable through assignments/transforms/helpers/function calls (across files), and see if it reaches a dangerous sink (query/exec/eval/template/file/redirect/HTTP client/deserializer/reflection) **without** an intervening validator, allowlist, parameterization, canonicalizer, or encoder.
- Attacker-controlled source? (a hardcoded constant is not a bug)
- Reaches the sink on a real path? (is the function actually called? follow call chains, not just single files)
- Sanitized in between? (parameterized query, `shell=False`, allowlist, canonicalize, encode) — if a *genuine* sanitizer is on the path, lower confidence/severity; if it is partial or bypassable (blacklist, `startswith`, pre-normalization check), keep it as a live finding.

## 5. Manual per-endpoint authorization & ownership pass (highest-yield, scanner-blind)
Do this for **every** endpoint recorded in §2. Build two lists and diff them:
```bash
# every route/handler
rg -n "@app\.route|app\.(get|post|put|delete|patch)|router\.(get|post|put|delete|patch)|@(Get|Post|Put|Delete|RequestMapping|GetMapping|PostMapping)" .
# where the guards ARE (the allowlist of protected routes)
rg -n "login_required|permission_required|@PreAuthorize|@Secured|@RolesAllowed|isAuthenticated|requireAuth|ensureLoggedIn|current_user|req\.user|ctx\.user|hasRole|authorize|can\?|policy|before_action.*authenticate|middleware\(.*auth|verifyToken|checkPermission" .
```
For each endpoint ask, in order:
1. **Authentication** — is the caller proven to be logged in at all?
2. **Function-level authorization** — is the caller's *role/permission* checked for this action (admin routes, config, user management)? (CWE-862/CWE-863)
3. **Object-level authorization / ownership (IDOR/BOLA)** — when it loads an object by a user-supplied id, is the query scoped to the caller (`WHERE id=? AND owner=?`) or is there a post-fetch ownership check? (CWE-639)
4. **Consistency** — are sibling methods on the same controller guarded the same way? Is the check *before* the sensitive action, and is it server-side (not a decorative client-side `if isAdmin`)?
Any endpoint that fails one of these is a candidate — record it. Details and record shapes: `review-authz-authn`.

## 6. Business-logic & insecure-design pass (scanner-blind)
Reason about *intended* behavior, then look for violations no rule can encode:
- Missing rate limits / anti-automation on login, password reset, OTP, coupon, payment.
- Trusting client-supplied price/quantity/role/state; negative or overflow amounts; race conditions / TOCTOU on balance or stock.
- Broken workflow/state machine (skip payment, reuse a one-time token, replay).
- Mass assignment / auto-binding of fields the user shouldn't set (`is_admin`, `balance`).
- Password reset / account recovery / email-change flows that don't re-verify identity.
Record each as a `hypothesis` tagged `class=logic` (business-logic / insecure-design), or `authz`/`authn` when it is really an access/auth defect, so it enters coverage.
- Security misconfiguration in code — `DEBUG`/verbose errors enabled, permissive CORS, missing or wrong security headers, insecure cookie flags (HttpOnly/Secure/SameSite), default or unsafe framework settings → record `class=misconfig`.

## 7. Prioritize (triage order — do not spend the whole budget on style)
**Access control / auth → injection → secrets/crypto → deser/SSRF/path/XXE → deps/config → logging.** A missing authz check on an admin route, an IDOR, or a login-handler SQLi beats ten header nits. Because access-control/auth/insecure-design are the known miss areas, give §5 and §6 first-class time even when SAST is quiet.

## 8. Verify without dropping leads
Verification **sets confidence and severity; it does not delete candidates.** Three outcomes only:
- **Confirmed** (source attacker-controlled, sink reachable, no real sanitizer) → `record kind=finding status=confirmed` with severity.
- **Genuinely refuted** (a real parameterization/allowlist/ownership check sits in the path) → `hypothesis outcome=refuted` with the *specific* reason. Refuted ≠ "I ran out of time."
- **Cannot fully confirm** (plausible but you couldn't trace the whole path, or reachability is uncertain) → **keep it**: either `record kind=finding status=open` at your best-estimate severity noting "unconfirmed/low-confidence", **or** `hypothesis outcome=inconclusive` with a note, and leave the cell open in `recall gaps`. Never delete a plausible real issue.

## 9. Record coverage so you don't quit early
```
record kind=hypothesis statement="search() builds SQL by string concat with req.query.q" target=e_search class=sqli approach="trace req.query.q to db.query" outcome=testing
record kind=finding title="SQL injection in /search" severity=high target=e_search class=sqli cwe=CWE-89 description="req.query.q concatenated into SELECT" repro="GET /search?q=' OR 1=1--" evidence=["core/search.js:42"] status=confirmed hypothesisId=y4
```
Refuted/inconclusive hypotheses are **retained** — they prove you looked and prevent silent drops. Loop until `recall gaps` is empty across the code-review checklist classes: **sqli, cmdi, codeinj, ssti, authz, authn, deser, ssrf, xxe, pathtrav, upload, secrets, crypto, sca, iac, logging, reflection, logic, misconfig** — for every surface element. A class with no finding is only "clear" once you have actually looked at each endpoint for it.

## References
- OWASP Code Review Guide v2 — https://owasp.org/www-project-code-review-guide/
- OWASP Web Security Testing Guide (WSTG) v4.2 — https://owasp.org/www-project-web-security-testing-guide/
- OWASP Application Security Verification Standard (ASVS) 4.0.3 — verification-requirement checklist; access control = V4, authentication = V2, session = V3, validation/encoding = V5 (ASVS 5.0, May 2025, renumbered these — Authorization → V8) — https://owasp.org/www-project-application-security-verification-standard/
- OWASP Top 10 2021 — A01 Broken Access Control, A04 Insecure Design, A07 Identification & Authentication Failures (the known miss areas) — https://owasp.org/Top10/
- MITRE CWE — CWE-862 Missing Authorization — https://cwe.mitre.org/data/definitions/862.html
