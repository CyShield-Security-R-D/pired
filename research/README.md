# pired — Research

Documentation of the development of **pired** (a security assessment harness for
consultants, built on the pi coding agent) and a controlled benchmark measuring whether pired + an open-weight
27B model competes with a frontier coding agent on real vulnerability detection.

## Documents

| # | Document | Contents |
|---|----------|----------|
| 01 | [Development of pired](./01-pired-development.md) | Goals, "AI agent not a toolbox" stance, ports & adapters architecture, engagement ontology, scope gate, TDD, the self-review hardening pass, pi-ecosystem compatibility. |
| 02 | [Benchmark Methodology](./02-benchmark-methodology.md) | The three arms, DVBank ground-truth benchmark, fairness controls, contamination controls (isolated targets + audit), environment issues and how they were handled, the grader. |
| 03 | [Results](./03-results.md) | 3-way scores, the harness effect (A vs C), pired vs codex (A vs B), OWASP breakdown, the hard tail, exact token/cost accounting. |
| 04 | [Findings & Conclusions](./04-findings-and-conclusions.md) | The central finding (harness > model for recall), where the harness helps, cost reality, business-logic frontier, threats to validity. |
| 05 | [Re-run](./05-rerun-2026-08.md) | An independent replication at n=5, and the ledger grading that showed the workflow was never exercised. Supersedes 04 §6. |
| 06 | [Compounding](./06-compounding-2026-08.md) | Persisted vs wiped ledger over k sessions: no measurable recall benefit, and the scoring artifact that first suggested otherwise. |
| 07 | [Real-app corpus](./07-corpus-2026-08.md) | 17 real CVEs with maintainer patches as ground truth: recall halves against the teaching app. |
| 08 | [Application corpus](./08-application-corpus-2026-08.md) | Why the library corpus measured ontology mismatch rather than the harness, and the application corpus built to replace it. |
| 09 | [Misses](./09-misses-2026-08.md) | Every missed bug so far, per target: what it was, what the ledger shows, and what was reported instead. |
| 10 | [Small-application corpus](./10-app-corpus-2026-09.md) | The 46-target application corpus; paused after 2 targets. |
| 11 | [Three arms on the application corpus](./11-three-arm-2026-09.md) | pired, bare pi and codex on the same five targets, separating harness, model and benchmark. |
| 12 | [The delegation trial](./12-delegation-trial-2026-09.md) | pi-subagents delegation against the single agent on three models, and what it says to change. |

## The three arms

| Arm | Harness | Model | Role |
|-----|---------|-------|------|
| **A** | **pired** (security layer on pi) | `qwen/qwen3.8-27b` (OpenRouter) | the pired proposition |
| **B** | OpenAI Codex CLI v0.147.0 | `openai/gpt-5.6-sol` | frontier agent baseline |
| **C** | vanilla pi (provider shim only) | `qwen/qwen3.8-27b` (OpenRouter) | isolates the harness effect |

## Results at a glance

| Metric | A · pired+qwen | B · codex | C · vanilla+qwen |
|--------|:--:|:--:|:--:|
| Recall | **0.736** | 0.679 | 0.585 |
| Precision | 0.629 | **0.800** | 0.564 |
| F1 | 0.678 | **0.735** | 0.574 |
| Critical recall | **100%** | 93% | 79% |
| Decoy FPs | 0/6 | 0/6 | 0/6 |
| Cost / scan | $0.262 | ~$0.19 | $0.158 |

**Headline:** the pired security layer lifted the *same* 27B model from F1 0.574 →
0.678 and recall 0.585 → **0.736**, overtaking a frontier agent on recall and
catching **100% of criticals** — closing ~65% of the F1 gap to the frontier model
**with the harness alone.** codex stays ahead on precision/F1 (cleaner, less noise).
Cost is roughly comparable per scan; the harness trades more turns for more coverage.

## Data

Raw artifacts in [`data/`](./data/): the prompt, each arm's `findings.json`, each
grader report, the consolidated 3-way analysis (`analysis.3way.json`), and exact
token/cost accounting (`cost.exact.json`).

> All figures are from a single run per arm against the DVBank `clean/` variant,
> deterministically graded, with every arm audited to have never accessed the answer
> key. Directional, not a leaderboard — see each doc's threats-to-validity notes.
