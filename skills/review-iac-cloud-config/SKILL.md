---
name: review-iac-cloud-config
description: Use when reviewing IaC & config — Dockerfile, Kubernetes, Terraform/CloudFormation, GitHub Actions, env files — for misconfig. checkov/trivy/hadolint.
---

# Infrastructure-as-code & config review

Goal: find misconfigurations in build/deploy/config that expose data or grant excess privilege. The source of risk is a config *value*, not tainted runtime input (except CI injection) — so scan the manifests, then read the flagged lines. Aim for **complete** coverage: run the scanners, then also grep the recipes below so a missing scanner never means a missed misconfig. Record every real hit — an unscanned manifest is a recall gap.

Tools run via `bash` and may be absent. If a scanner is missing, use the grep recipes and `record kind=note` for the tooling gap. Save raw output to `evidence/`.

## 1. Run the scanners
```bash
mkdir -p "$PIRED_WORKSPACE/evidence"
checkov -d . -o sarif --output-file-path evidence 2>/dev/null || true          # multi-IaC: TF, CFN, K8s, Dockerfile, Helm, ARM, GitHub Actions
trivy config --format sarif -o "$PIRED_WORKSPACE/evidence/trivy-config.sarif" . 2>/dev/null || true # misconfig: TF/CFN/K8s/Dockerfile/Helm (tfsec's engine — tfsec is EOL, merged into Trivy)
tfsec . --format sarif --out "$PIRED_WORKSPACE/evidence/tfsec.sarif" 2>/dev/null || true            # legacy Terraform-only (if trivy absent)
hadolint Dockerfile --format sarif > "$PIRED_WORKSPACE/evidence/hadolint.sarif" 2>/dev/null || true
kube-linter lint . --format sarif > "$PIRED_WORKSPACE/evidence/kube-linter.sarif" 2>/dev/null || true
actionlint -format '{{json .}}' > "$PIRED_WORKSPACE/evidence/actionlint.json" 2>/dev/null || true   # GitHub Actions
```
`tfsec` is end-of-life and folded into **Trivy** (`trivy config`) — prefer Trivy, keep `tfsec` only as a fallback. Every hit is a **lead** — open the file:line and confirm it's a real deployed config, not an example/test fixture.

## 2. Dockerfile (CWE-250, CWE-798)
```bash
rg -n -i "^FROM .*:latest|^FROM [^@]*$|^USER root|^\s*ADD\s+https?://|curl .*\|\s*(sh|bash)|wget .*\|\s*(sh|bash)|--no-check-certificate|-k\b|^ENV .*(PASS|SECRET|TOKEN|KEY)|^ARG .*(PASS|SECRET|TOKEN|KEY)|chmod\s+777|--privileged|sudo" Dockerfile*
```
- Runs as **root** (no `USER` directive, or `USER root`) → CWE-250, container-escape blast radius.
- Secrets baked in `ENV`/`ARG`/`COPY .env` — they persist in image layers (cross-ref `review-secrets`) → CWE-798.
- `FROM ...:latest` or an unpinned tag with no `@sha256:` digest → non-reproducible, supply-chain drift.
- `ADD` of a remote URL, `curl|sh`/`wget|bash`, disabled TLS checks (`-k`, `--no-check-certificate`), `chmod 777`.

## 3. Kubernetes manifests (CWE-250, CWE-732, CWE-284)
```bash
rg -n -i "privileged:\s*true|allowPrivilegeEscalation:\s*true|hostPath|hostNetwork:\s*true|hostPID:\s*true|hostIPC:\s*true|runAsNonRoot:\s*false|runAsUser:\s*0|add:\s*\[?.*(SYS_ADMIN|NET_ADMIN|ALL)|readOnlyRootFilesystem:\s*false|automountServiceAccountToken:\s*true|verbs:\s*\[?.*\*|resources:\s*\[?.*\*|type:\s*LoadBalancer|:\s*NodePort" -g '*.{yaml,yml}'
```
- `privileged: true`, `allowPrivilegeEscalation: true`, `runAsUser: 0`, added caps (`SYS_ADMIN`/`NET_ADMIN`/`ALL`) → CWE-250.
- `hostPath`/`hostNetwork`/`hostPID`/`hostIPC` mounts → node breakout.
- Missing resource `limits` (DoS), missing `securityContext`/`runAsNonRoot`, `readOnlyRootFilesystem: false`.
- Secrets in plain `env`/ConfigMap instead of `Secret`, `automountServiceAccountToken: true` on pods that don't need the API.
- Over-broad RBAC (`verbs: ["*"]`, `resources: ["*"]`, `ClusterRoleBinding` to `cluster-admin`), missing `NetworkPolicy` (flat network). → CWE-732/CWE-284.

## 4. Terraform / CloudFormation (CWE-284, CWE-732, CWE-311)
```bash
rg -n -i "0\.0\.0\.0/0|::/0|public-read|public-read-write|publicly_accessible\s*=\s*true|acl\s*=\s*\"public|block_public_(acls|policy)\s*=\s*false|ingress|\"Action\"\s*:\s*\"\*\"|\"Principal\"\s*:\s*\"\*\"|Effect\"\s*:\s*\"Allow\".*\"\*\"|password\s*=\s*\"|access_key|secret_key|encrypted\s*=\s*false|storage_encrypted\s*=\s*false|force_destroy\s*=\s*true|skip_final_snapshot" -g '*.{tf,tfvars,json,yaml,yml,template}'
```
- Security group / firewall open to `0.0.0.0/0` (`::/0`) on sensitive ports (22/3389/DB) → CWE-284.
- Public S3/GCS buckets (`acl=public-read`, `block_public_acls=false`), `publicly_accessible=true` DB.
- **IAM wildcards** — `"Action":"*"`, `"Principal":"*"`, `"Resource":"*"` in a policy → excessive privilege (CWE-732).
- Hardcoded credentials/keys in `.tf`/`.tfvars` (cross-ref `review-secrets`); note `.tfstate` stores secrets/outputs in **plaintext**.
- Encryption disabled (`encrypted=false`, `storage_encrypted=false`) → CWE-311; access logging disabled; `force_destroy`/`skip_final_snapshot` on stateful resources.

## 5. CI/CD — GitHub Actions (injection is real code exec here) (CWE-94)
```bash
rg -n "pull_request_target|\x24\{\{\s*github\.event\.(issue|pull_request|comment|review|head_ref|.*\.body|.*\.title|.*\.email|.*\.name)|run:\s*.*\x24\{\{|secrets\.|actions/checkout.*ref:\s*\x24\{\{|permissions:\s*write-all|uses:\s*[^@]+@(main|master|v?\d+)\s*$" .github/workflows/*.y*ml
```
- **Script injection (CWE-94):** untrusted `${{ github.event.* }}` (PR title/body, branch name, comment, author name/email) interpolated directly into a `run:` shell block → command execution on the runner. **Safe:** pass via `env:` and reference `"$VAR"`, quoted.
- **`pull_request_target`** + checking out/executing PR code with access to secrets → secret exfiltration from forks.
- Secrets echoed to logs, `permissions: write-all` (default should be least-privilege), unpinned third-party actions (`uses: x/y@main`/`@v4` vs a full commit SHA), `curl | bash` in steps. `checkout` with a PR-controlled `ref`.

## 6. Env & app config files
```bash
rg -n -i "DEBUG\s*[:=]\s*true|(password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*\S|ssl.*(false|none)|verify\s*[:=]\s*false|InsecureSkipVerify|ALLOWED_HOSTS.*\*|Access-Control-Allow-Origin.*\*" -g '*.{env,ini,cfg,conf,yaml,yml,json,properties,toml}' -g '!*.example' -g '!*.sample'
```
Debug enabled in prod, secrets committed in `.env`/`config` (cross-ref `review-secrets`), TLS verification off, wildcard hosts, permissive CORS (`Access-Control-Allow-Origin: *` — dangerous with credentials). → class `iac` (config) / `secrets`.

## 7. Wire into the loop
```
record kind=hypothesis statement="prod SG opens 22 to 0.0.0.0/0" target=infra/main.tf class=iac approach="read ingress block" outcome=testing
record kind=finding title="SSH exposed to the internet (0.0.0.0/0)" severity=high target=infra/main.tf:40 class=iac cwe=CWE-284 description="aws_security_group ingress port 22 cidr 0.0.0.0/0" repro="see infra/main.tf:40" evidence=["evidence/trivy-config.sarif","infra/main.tf:40"] status=confirmed hypothesisId=y7
```
Severity: workflow script injection / secret exfil = high/critical; public bucket / open admin port / IAM `*` = high; privileged container = high; missing limits / debug on = medium/low. Refute (set `outcome=refuted`) only when the flagged setting is genuinely an example/test fixture or is scoped/pinned/encrypted for real. Uncertain-but-plausible → keep `outcome=inconclusive` with a note; never silently drop it.

## References
- Checkov — supported IaC & CLI — https://www.checkov.io/1.Welcome/What%20is%20Checkov.html
- Trivy — Misconfiguration (IaC) scanning (`trivy config`) — https://trivy.dev/latest/docs/scanner/misconfiguration/
- tfsec is EOL / migrating to Trivy — https://github.com/aquasecurity/tfsec
- hadolint — Dockerfile linter (SARIF output) — https://github.com/hadolint/hadolint
- OWASP GitHub Actions / CI-CD Security (script injection) — https://cheatsheetseries.owasp.org/cheatsheets/CI_CD_Security_Cheat_Sheet.html
- Kubernetes Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Kubernetes_Security_Cheat_Sheet.html
- CWE-250: Execution with Unnecessary Privileges — https://cwe.mitre.org/data/definitions/250.html
- CWE-732: Incorrect Permission Assignment for Critical Resource — https://cwe.mitre.org/data/definitions/732.html
