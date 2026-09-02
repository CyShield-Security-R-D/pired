# Skills and Checklists

pired ships two kinds of methodology: **skills**, which the model pulls in as reference when a situation calls for them, and **checklists**, which define the classes the coverage matrix is built from.

Both are opt-in by design. The system prompt hands the model situational awareness and the stakes, then trusts its judgment — methodology is reference to reach for, never an always-on wall of instructions. A script written for a weaker model boxes in a stronger one.

## Skills

41 skills under `skills/<name>/SKILL.md`, contributed to pi's resource loader. pi discovers each one, advertises the name and description in the system prompt, and loads the body only when the model asks for it — so the always-on cost is one line each.

```
skills/
  review-injection/SKILL.md
  web-ssrf/SKILL.md
  ops-severity-cvss/SKILL.md
  ...
```

### Code review — 15

| Skill | For |
|---|---|
| `review-methodology` | Starting a read-only audit: orient, enumerate every entrypoint, SAST + secrets + SCA, then manual authz and logic passes. |
| `review-injection` | SQL, OS command, code eval, SSTI, NoSQL, LDAP/XPath sinks. CWE-89/78/94/917. |
| `review-authz-authn` | Missing authz, IDOR, broken auth, insecure session/JWT. CWE-862/863/639/287. |
| `review-deserialization-ssrf` | Insecure deserialization, SSRF, XXE. CWE-502/918/611. |
| `review-path-file` | Path traversal, arbitrary read/write, unsafe uploads, zip-slip. CWE-22/434. |
| `review-crypto-secrets-handling` | Weak hashes/ciphers, static IV/keys, bad randomness, secrets in logs. |
| `review-secrets` | Hardcoded keys and tokens in source and git history; live vs dummy. |
| `review-dependencies-sca` | `npm audit`, `pip-audit`, `osv-scanner`, `govulncheck`, and friends. |
| `review-sast-semgrep` | Driving semgrep/opengrep, custom sink rules, SARIF to `evidence/`. |
| `review-iac-cloud-config` | Dockerfile, Kubernetes, Terraform, GitHub Actions. |
| `review-language-python` | Django/Flask/FastAPI sources and sinks. |
| `review-language-js-ts` | Express/Fastify/Next, prototype pollution, `vm`/`eval`. |
| `review-language-java` | Spring, Jackson/native deser, SpEL/OGNL, reflection. |
| `review-language-go-ruby-php` | Per-language sources and sinks for the other three. |

### Web — 10

`web-recon`, `web-injection`, `web-xss`, `web-access-control`, `web-auth-session`, `web-ssrf`, `web-ssti-deser`, `web-xxe`, `web-file-path`, `web-logic-misc` — the last one for what scanners miss: logic flaws, CSRF, open redirect, host-header and CORS issues, races.

### API — 3

`api-recon` (OpenAPI/Swagger/introspection/WSDL), `api-testing` (OWASP API Top 10 2023 — BOLA/BFLA, mass assignment, excessive data exposure), `api-graphql`.

### Recon — 3, network — 3

`recon-passive`, `recon-active-web`, `recon-attack-surface`, `network-host-discovery`, `network-service-enum`, `network-post-exploit-notes`.

### Operations — 7

| Skill | For |
|---|---|
| `ops-scope-safety` | Reading the scope, knowing the gate's limits, gating intrusive actions. |
| `ops-evidence` | Redirecting bulky output to `evidence/`, pulling only summaries into context. |
| `ops-finding-writeup` | Promoting a confirmed hypothesis to a report-grade finding, de-duped. |
| `ops-severity-cvss` | Severity, a CVSS v3.1 vector, and the right CWE, with worked examples. |
| `ops-loot-credentials` | Stable handles, referring by handle instead of reprinting plaintext. |
| `ops-delegation` | Delegating noisy recon and adversarial verification to a sub-agent. |
| `ops-technical-writer` | Rewriting a confirmed finding to report grade, working from `recall finding`. |

### What a skill looks like

Frontmatter that tells the model *when* to reach for it, then dense, tool-first reference:

```markdown
---
name: review-injection
description: Use when tracing injection sinks in source — SQL, OS command,
  code eval, template (SSTI), NoSQL, LDAP/XPath. CWE-89/78/94/917.
---

Goal: find where untrusted input reaches an interpreter without
parameterization or escaping...

## SQL injection — CWE-89 (class `sqli` · WSTG-INPV-05 · ASVS V5.3)
```

Two conventions matter. Each section names the **checklist class** it settles (`class \`sqli\``), so following a skill produces coverage rather than just findings. And each maps to standard references — CWE, WSTG, ASVS — so a finding lands in the vocabulary a client's report already uses.

## Checklists

Four templates in `checklists/`, one per target type. They define the classes on the coverage matrix's vertical axis.

| Template | Classes | Used for |
|---|---|---|
| `code-review.json` | 19 | `review` |
| `web.json` | 21 | `recon` / `pentest` against domains or URLs |
| `network.json` | 13 | `recon` / `pentest` against IPs or CIDRs only |
| `api.json` | 13 | Selected by editing the engagement's checklist |

```jsonc
{
  "id": "sqli",
  "title": "SQL injection (string-built queries)",
  "cwe": ["CWE-89"],
  "appliesTo": ["endpoint", "param"]
}
```

`appliesTo` is the applicability filter: cells outside it become `n/a` and leave the denominator, so "SQL injection against a `tech` record" is not counted as an untested gap. Both directions fail open — a class with no `appliesTo` applies to everything. See [Coverage](coverage.md#applicability-appliesto-and-na).

### Per-engagement checklists

The checklist is seeded **once**, on first run, and **never clobbered**. To tailor it, edit `checklist.json` in the engagement workspace — add a class the client cares about, drop one that is out of scope, or tighten an `appliesTo`. Coverage recomputes from it on the next read.

A malformed template is non-fatal: coverage stays uncomputed rather than taking the session down.

## Adding your own

Skills are plain directories with a `SKILL.md`. Drop one into `skills/`, or install it as any pi skill — pired takes no ownership of the mechanism, it only contributes its own directory to the loader. See [pi's skills documentation](https://pi.dev).

Keep the two conventions above if you want the skill to feed coverage: name the class it settles, and map to CWE.
