# Delegation v6 — plan

*Started 2026-09-26. Evidence and sources: [`research/12-delegation-trial-2026-09.md`](../research/12-delegation-trial-2026-09.md).*

Snapshot v4 of delegation was not accepted under ADR-026. On GPT-6 Luna, the gating model, it found
slightly more true positives, but at 59% of the baseline's precision and 62% more tokens. Across all
grids the candidate found 58 true positives against the baseline's 69.

The trial's main lesson is that the largest problems are in **how we measure** and **how we run the
benchmark**, not only in orchestration. This plan fixes the instruments first, then the benchmark,
then the product. Each product change is judged by a pre-registered test on fresh applications.

## Principles

- **Luna first.** Work with GPT-6 Luna until a design passes. Add GLM-5.3 Flash and DeepSeek V4.1
  Flash later against the same pre-registration.
- **No overfitting.** The corpus is a measuring stick and will be replaced. Every change must follow
  from a general mechanism, never from specific applications or CVEs. Validation runs on applications
  outside the graded corpus. Held-out results are never read to shape a change.
- **Inform, don't micromanage.** Give the model information, tools and feedback, such as budget,
  coverage and evidence requirements, rather than rigid scripts.
- **Instruments before interventions.** Nothing is changed in the product until the measurement can
  show whether the change worked.
- **Count every variant tried.** Every configuration that is run is recorded, not only the one
  shipped.

## Phase 0 — Close v5

| # | item | status |
|---|---|---|
| 0.1 | Research note with the measured outcome, the critic's corrections and the literature (`research/12`) | done |
| 0.2 | ADR-026: record the verdict (Luna not approved; delegation v4 not accepted); GLM stopped at 10/15 + 7/12 as evidence | done |
| 0.3 | ADR-027/028 status: not accepted as they stand | done |
| 0.4 | **Operator decision:** delegation is on by default on `main` (`maxAgents` 8). ADR-027 says a rejection means the change is not kept as it stands. Proposal: default `maxAgents: 0` (opt-in) on `main` until v6 passes. | awaiting decision |

## Phase 1 — Measurement instruments (no model calls)

| # | item | acceptance |
|---|---|---|
| 1.1 | **Multi-level re-scorer** `eval/rescore.ts`. Reads ledgers directly and keeps `file:lo-hi` ranges. Scores unique labelled locations at several levels: same file; line ±3 (the official rule); line ±10; claim range overlapping the label range, with the label width capped. Adds a label-hygiene report that flags labels wider than the cap. | Reproduces the official true-positive count exactly at the ±3 point level on every valid v5 run (the control). Unit tests beside the module. |
| 1.2 | **Paired per-issue analysis** `eval/paired.ts`. Per-issue find rate per arm; McNemar exact test on discordant pairs; mean difference per pair with an app-clustered bootstrap confidence interval (fixed seed); minimum detectable effect from the observed paired standard deviation. | Unit tests on synthetic data. A report for Luna v5c. |
| 1.3 | **Cost breakdown** `eval/cost-breakdown.ts`. Splits parent tokens into first-request prompt size, handoff payload size, and files re-read by the parent after a worker read them. Uses existing transcripts only. | Explains the +32% context per request and +15% requests on Luna v5c, or says what it cannot explain. |
| 1.4 | **Adjudication protocol (spec).** Blind to arm and provenance; claims merged into unique issues; fixed rubric; a judge from a different model family; agreement measured on a double-judged sample. Execution needs model calls, so it runs in Phase 4. | Spec reviewed, with an ADR if adopted. |

## Phase 2 — Benchmark operations (harness; both arms identical)

Every item keeps both arms under identical conditions. Each item's fairness trade-off is written into
its ADR.

| # | item | why |
|---|---|---|
| 2.1 | **Retry known-transient provider errors inside a run.** Capped, logged per request, failed partial tokens counted, identical in both arms, reported per arm. | 349M tokens were lost to drops. Having no retry also biases the valid set toward short runs, and hits the arm that makes more calls hardest. |
| 2.2 | **Run a pair's two arms concurrently, in random start order.** | Removes night-to-night drift within a pair. Makes the next item safe. |
| 2.3 | **Circuit breaker** (consecutive failures, or failure rate within a window) instead of stopping on the first failed run. | Keeps the protection during outages without stalling the grid on single drops. |
| 2.4 | **Reuse a valid arm** when only its partner failed for infrastructure, both started in the same window, and runs are concurrent. Results are reported with and without reuse. | 17 valid runs (135M tokens, 7.2 run-hours) were discarded. |
| 2.5 | **Matched-compute arm:** the single agent run *k* times at the candidate's token budget, with findings combined. | Tests whether delegation adds anything beyond spending more tokens. |
| 2.6 | **Stop reason as a first-class outcome**, recorded per run: finished, offered to continue, budget, turn cap, error. | Luna ends about 80% of runs by offering to continue. |

## Phase 3 — Product changes (candidate snapshot v5; each its own ADR)

| # | item | mechanism (source) |
|---|---|---|
| 3.1 | **Independent, grounded verification tier.** Worker findings enter the ledger as *unverified*, tagged with who recorded them. A verifier with a fresh context checks the source-to-sink path and the guards against quoted code before promoting a finding. "Confirmed" requires an evidence field. Execution-backed proof is the top tier, not a gate. Optionally the verifier uses another model family. Every true positive the verifier rejects is measured. | Parallel generators without a verifier lower precision; grounded checks, not self-critique, raise it; judges favour their own outputs. |
| 3.2 | **Budget and coverage visibility.** Each turn shows budget used and remaining, framed as a ceiling, not a target. The scout's map becomes a checklist of areas, each with a status. Settling shows what remains uncovered. The model is told its state persists. An "unattended" statement is added only if pired ships a headless mode. | Agents under-use budgets they cannot see; context-aware models wrap up early. |
| 3.3 | **Delegate only when the work divides.** Worker count scales with the size of the scout's map. Delegation guidance is loaded only when the model chooses to delegate. Investigator briefs name a function or line range, not a file. | Multi-agent designs lose on sequential, tool-heavy work; recall drops late in long inputs; the parent's context grew 32% per request. |
| 3.4 | **Source-to-sink framing with verbatim locations.** Leads and claims carry source, sink and path. Workers write the location, with a verbatim code quote, straight into the ledger instead of relaying it. | Improves both coverage and localisation; relayed summaries lose detail. |

## Phase 4 — Evaluation v6 (Luna first)

| # | item |
|---|---|
| 4.1 | **Fresh applications** outside the graded corpus. Label hygiene: cap label width and split wide labels. Clean-code controls where nothing should be reported. |
| 4.2 | **Pre-registration, written before any v6 run:** arms (baseline, candidate v5, single agent × k at matched compute); metrics (unique labelled locations at every scoring level, adjudicated precision, cost in tokens and dollars, stop reasons); sample size from 1.2's power analysis; ship rule (TP non-inferior within a stated margin at no higher cost, or TP superior); held-out guard. |
| 4.3 | **Run on Luna.** Then add GLM-5.3 Flash and DeepSeek V4.1 Flash under the same pre-registration. |

## Order of work

Phase 0 → Phase 1 (1.1, 1.2 and 1.3 in parallel) → Phase 2 → Phase 3 (3.1 first) → Phase 4. Phases 1
and 2 need no model calls, apart from 2.x smoke tests with the faux provider. Phase 3 changes the
product and is not merged until Phase 4 passes. Tooling from the v5 trial is in
`eval/artifacts/session-2026-09-24-tools/`.
