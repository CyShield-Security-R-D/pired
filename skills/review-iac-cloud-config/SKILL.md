---
name: review-iac-cloud-config
description: Use when reviewing IaC & config — Dockerfile, Kubernetes, Terraform/CloudFormation, GitHub Actions, env files — for misconfig. checkov/tfsec/hadolint.
---

# Infrastructure-as-code & config review

Goal: find misconfigurations in build/deploy/config that expose data or grant excess privilege. Source of risk is a config *value*, not tainted runtime input (except CI injection) — so scan the manifests, then read the flagged lines.

Tools run via `bash` and may be absent. If a scanner is missing, use the grep recipes and `record kind=note`. Save raw output to `evidence/`.

## 1. Run the scanners
```bash
mkdir -p evidence
checkov -d . -o sarif --output-file-path evidence 2>/dev/null || true    # multi-IaC
tfsec . --format sarif --out evidence/tfsec.sarif 2>/dev/null || true     # Terraform
hadolint Dockerfile -f sarif > evidence/hadolint.sarif 2>/dev/null || true
kube-linter lint . --format sarif > evidence/kube-linter.sarif 2>/dev/null || true
# GitHub Actions
actionlint -format '{{json .}}' > evidence/actionlint.json 2>/dev/null || true
```
Every hit is a lead — open the file:line and confirm it's a real deployed config, not an example/test fixture.

## 2. Dockerfile
```bash
rg -n -i "^FROM .*:latest|^USER root|^\s*ADD |curl .*\| ?sh|--no-check-certificate|^ENV .*(PASS|SECRET|TOKEN|KEY)|^ARG .*(PASS|SECRET|TOKEN)|chmod 777" Dockerfile*
```
- Runs as **root** (no `USER` directive → CWE-250) — container escape blast radius.
- Secrets baked in `ENV`/`ARG`/`COPY` (persist in image layers — cross-ref `review-secrets`).
- `FROM ...:latest` or no digest pin (non-reproducible, supply-chain drift).
- `ADD` of a remote URL / `curl | sh`, disabled TLS checks, `chmod 777`.

## 3. Kubernetes manifests
```bash
rg -n -i "privileged:\s*true|hostPath|hostNetwork:\s*true|hostPID|allowPrivilegeEscalation:\s*true|runAsNonRoot:\s*false|runAsUser:\s*0|capabilities|readOnlyRootFilesystem|automountServiceAccountToken" -g '*.{yaml,yml}'
```
- `privileged: true`, `allowPrivilegeEscalation: true`, `runAsUser: 0`, added `CAP_SYS_ADMIN` → CWE-250.
- `hostPath`/`hostNetwork`/`hostPID` mounts (node breakout).
- Missing resource `limits` (DoS), missing `securityContext`, secrets in plain `env`/ConfigMap instead of Secrets, overly broad RBAC (`verbs: ["*"]`, `resources: ["*"]`).

## 4. Terraform / CloudFormation
```bash
rg -n -i "0\.0\.0\.0/0|::/0|public-read|publicly_accessible\s*=\s*true|acl\s*=\s*\"public|ingress|password\s*=\s*\"|access_key|secret_key|encrypted\s*=\s*false|force_destroy" -g '*.{tf,tfvars,json,yaml,yml}'
```
- Security group / firewall open to `0.0.0.0/0` on sensitive ports (22/3389/DB) → CWE-284.
- Public S3/GCS buckets (`acl=public-read`, public access block disabled), `publicly_accessible=true` DB.
- Hardcoded credentials/keys in `.tf`/`.tfvars` (cross-ref `review-secrets`) — and note `.tfstate` files leak secrets in plaintext.
- Encryption disabled (`encrypted=false`), logging disabled.

## 5. CI/CD — GitHub Actions (injection is real code exec here)
```bash
rg -n "pull_request_target|\$\{\{\s*github\.event\.(issue|pull_request|comment|head_ref|.*\.body|.*\.title)|run:\s*.*\$\{\{|secrets\.|actions/checkout.*ref:\s*\$\{\{|permissions:" .github/workflows/*.y*ml
```
- **Script injection (CWE-94):** untrusted `${{ github.event.* }}` (PR title/body, branch name, comment) interpolated directly into a `run:` shell block → command execution on the runner. Safe: pass via `env:` and reference `$VAR`, quoted.
- **`pull_request_target`** + checking out/executing PR code with access to secrets → secret exfiltration from forks.
- Secrets echoed to logs, `permissions: write-all`, unpinned third-party actions (`uses: x/y@main` vs a commit SHA), `curl | bash` in steps.

## 6. Env & app config files
```bash
rg -n -i "DEBUG\s*[:=]\s*true|(password|secret|token|api_key)\s*[:=]|ssl.*false|verify\s*[:=]\s*false|ALLOWED_HOSTS.*\*" -g '*.{env,ini,cfg,conf,yaml,yml,json,properties,toml}' -g '!*.example'
```
Debug enabled, secrets in committed `.env`/`config`, TLS verification off, permissive CORS (`Access-Control-Allow-Origin: *` with credentials).

## 7. Wire into the loop
```
record kind=hypothesis statement="prod SG opens 22 to 0.0.0.0/0" target=infra/main.tf class=iac approach="read ingress block" outcome=testing
record kind=finding title="SSH exposed to the internet (0.0.0.0/0)" severity=high target=infra/main.tf:40 class=iac cwe=CWE-284 description="aws_security_group ingress port 22 cidr 0.0.0.0/0" repro="see infra/main.tf:40" evidence=["evidence/tfsec.sarif","infra/main.tf:40"] status=confirmed hypothesisId=y7
```
Severity: workflow script injection / secret exfil = high/critical; public bucket / open admin port = high; privileged container = high; missing limits / debug on = medium/low. Refute when the flagged setting is an example file or scoped/pinned/encrypted for real.
