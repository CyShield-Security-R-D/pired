# Evaluation

pired makes a measurable claim — that coverage discipline lifts recall more than a bigger model does — so it carries the instrument to check it.

Two layers, answering different questions:

| | Asks | Cost |
|---|---|---|
| **Assay** (`eval/`) | Does the harness still hold its own rules? | < 100 ms, in CI |
| **The benchmark** (`research/`) | Does the harness find more real bugs? | A full scan per arm |

## Assay — the harness's own tests

```bash
npm run assay
npm run check     # tsc + unit tests + assay
```

Scripted scenarios with deterministic assertions against `core/`'s pure functions and the in-memory fakes. No model, no network, no target repo — which is what lets it sit in CI beside the unit tests rather than in a nightly job nobody reads.

| Family | Asks |
|---|---|
| `scope` | Does the gate hold against direct, content-injected, ambiguous, and unauthorized targets — *and* does in-scope work still run? |
| `router` | Does `selectNext` keep returning workable cells as blocker density rises, without ever handing back blocked work? |
| `coverage` | Can the denominator every other metric is expressed in drift silently? |
| `continuity` | Does a cold restart over the same directory reconstruct the engagement exactly? |
| `ledger` | Does claimed evidence resolve — and does the detector still catch planted defects? |
| `grader` | Does the scorer classify every outcome correctly, and does key validation refuse assertions dressed as ground truth? |

### Three disciplines

**Positive controls.** Every detector probe plants defects it must catch. A detector that has silently stopped detecting anything otherwise passes forever.

**Known limits, pinned.** `core/scope.ts` states plainly that the gate is accident-prevention, not a sandbox. Those cases are marked `limit` and reported as `known-limit` rather than failing the build — but if the behaviour ever *changes*, in either direction, the case flips to a hard result. The documented boundary stays where it is documented, or the suite says so.

**Benign work is measured too.** `scope.false_blocks` counts in-scope work the gate refused, ratcheted to 0 alongside `scope.violations`. A gate that passes by blocking everything has failed differently.

### The ratchet

`eval/ratchet.json` holds a floor per metric. A change that regresses one fails the suite even when no individual case flipped. Floors move only via `npm run assay -- --update-ratchet`, which can **only tighten** — lowering a floor means editing the file and writing down why.

### Mutation testing

A suite that cannot fail is not testing anything, so Assay is mutation-tested: break a rule in `core/`, confirm it goes red, revert.

Thirteen mutations are known to be caught — six in `core/` (dropping the scope exclusion by host and by URL, removing the domain boundary check, returning blocked work from the router, dropping the evidence-path traversal guard, breaking last-write-wins, ignoring `appliesTo`) and seven in the grader. Two of the `core/` cases exist *because* mutation testing found the suite missing them.

The grader is mutation-tested hardest on purpose: every headline number flows through it, so a misclassification there is wrong in a way no individual result looks wrong.

## The benchmark

A controlled, three-arm comparison on a ground-truth-labeled vulnerable banking application — 53 CWE/OWASP-tagged vulnerabilities, deterministic grader. Same target, same prompt, same grader; the only variable is harness + model.

| Arm | Harness | Model |
|---|---|---|
| **A** | pired | `qwen/qwen3.8-27b` |
| **B** | OpenAI Codex CLI | `openai/gpt-5.6-sol` |
| **C** | vanilla pi (provider shim only) | `qwen/qwen3.8-27b` |

Arm C is the one that matters: same model as A, without pired. The gap between them *is* the harness effect.

The headline is that wrapping the same 27B model in pired lifted recall well past the frontier agent's, and that a re-run on a mutated variant — renamed routes, shifted lines, changed literals, built to defeat training-data recall — did not move the score.

Full methodology, per-category breakdown, exact token and cost accounting, and threats to validity: **[`research/`](../research/)**.

| Document | Contents |
|---|---|
| [01 — Development](../research/01-pired-development.md) | Goals, architecture, ontology, the self-review hardening pass. |
| [02 — Methodology](../research/02-benchmark-methodology.md) | The three arms, fairness and contamination controls, the grader. |
| [03 — Results](../research/03-results.md) | Scores, the harness effect, OWASP breakdown, the hard tail. |
| [04 — Findings](../research/04-findings-and-conclusions.md) | Harness > model for recall, cost reality, the business-logic frontier. |
| [05 — Re-run](../research/05-rerun-2026-08.md) | An independent replication, and what it showed was *not* exercised. |

## Grading your own engagement

Assay can grade a real engagement workspace against an answer key, in pired's own coordinates — cell keys, not a findings list — which is what makes a false *clear* measurable at all:

```bash
npm run assay:grade -- --workspace ~/.pired/engagements/<name> --key <key.json>
```

That distinction is the point. A findings-list grader can only tell you what was found. A cell-keyed grader can tell you what was **claimed clear but was not** — the failure mode that matters most in a security engagement, and the one a recall number alone hides.

## Honesty about what is measured

Two things worth stating plainly, because the instrument is only useful if its limits are known:

- **pired is not a scanner.** It owns no detection engines and makes no claim to reproducible, rule-count-comparable output against one.
- **A benchmark is one target.** The corpus work in `eval/corpus/` exists to widen that — real applications with maintainer security patches as ground truth — and where a result has not been produced, the research says so rather than implying one.
