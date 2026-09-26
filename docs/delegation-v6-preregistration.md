# Delegation v6 — pre-registration (DRAFT)

*Plan item 4.2 of [`delegation-v6-plan.md`](delegation-v6-plan.md). **Draft, not frozen.** It is
frozen, by commit and hash, before the first v6 model call. Any change after that is an amendment,
dated and logged, and it is written before the results it could affect are read. Items marked
**[operator]** need the operator's decision before freezing.*

## Questions

1. **Product (primary).** Does the v5 candidate make pired a better security harness on
   applications it has never seen? The v5 candidate is grounded verification (3.1), budget and
   coverage visibility with an explicit settle (3.2), and delegation that is opt-in, with a
   separate verifier cap. "Better" means: finds at least as many labelled issues, presents fewer
   false claims, and costs no more.
2. **Delegation (secondary).** Within the same product, does delegating add anything beyond
   spending the same tokens on single-agent sessions?

## Arms

| arm | snapshot | configuration | role |
|---|---|---|---|
| **A · incumbent** | `main` at the freeze, currently 84c7965 | single agent: delegation off by default (ADR-029) | what users get today |
| **S · candidate solo** | `p3/candidate-v5` at the freeze | `maxAgents: 0`, `maxVerifiers: 0`, budget line on | Phase 3's single-agent changes alone |
| **D · candidate delegating** | same as S | `maxAgents: 8`, `maxVerifiers: 2` **[operator: the verifier cap]**, budget line on | the full candidate |
| **M · matched compute** | same as S | delegation off, k = 3 sessions, total tokens capped at D's realised tokens for the same pair (follow mode, ADR draft 2.5), findings unioned | D's compute without delegation |

**The comparisons:**
- S vs A (primary).
- D vs S (primary).
- D vs M (secondary).
- D vs A (reported).

A and S differ only in the Phase 3 changes. D and S differ only in delegation. D and M differ only
in how the same tokens are spent.

**[operator] Staging, to control cost.** Run A and S first. D and M run only if S is not worse than
A on the primary rule, because a candidate whose own single agent regresses is not shipped with
delegation on top. The alternative is all four arms at once, which is simpler and costs about twice
as much per pair.

## Corpus

- `eval/corpus/fresh/`: 12 targets and 2 clean-code controls, drawn with seed 20260926 from the
  OSV pool. The procedure is in `eval/corpus/fresh.md`, and it is frozen by the hashes of
  `pool.json`, `exclusions.json`, `selection.json` and `truth/`.
  - **Pending:** the independent review of the draw, including whether frameworks and SDKs are
    eligible. A rule fixed after the review is logged as variant 2, with the reason, and the draw is
    re-run with the same seed before any model call.
- None of the 9 apps of the v5 trial (official or held-out), and no repository named in pired's
  research, appears.
- The v5 official grid is **not** used for the decision. It is run only if the operator wants
  continuity numbers, and those are labelled development evidence.

## Model and settings

- **Model:** GPT-6 Luna via `openai-codex`, thinking `medium`, as in v5c.
- **Other models:** GLM-5.3 Flash and DeepSeek V4.1 Flash are added later under this same document,
  each as its own grid. A later model cannot change the Luna verdict.
- **Harness:** the v6 harness at the freeze, with `--retry` (ADR-033) and `--breaker default`
  (ADR-031; attempt ceiling 16).
  - The run limit is 4 h, as in v5c. It is written into every arm's scope as `budget.minutes`
    (3.2).
  - The candidate cap is pinned (ADR-032).
  - The stop reason is recorded for every run (ADR-030).

## Sample size

- The unit is a pair (target × pass) with every arm valid at the same attempt, or reused under 2.4
  if it lands.
- The paired standard deviation measured on Luna v5c was 0.88 true positives per pair. That gives:

| difference to detect (TP/pair) | pairs needed (α = 0.05 two-sided, power 0.8) |
|---|---:|
| 0.3 | 69 |
| 0.2 | 154 |

- **[operator] N = 72 pairs:** 12 targets × 6 passes, per comparison. This detects about 0.3
  true positives per pair.
  - At Luna v5c's measured means (A ≈ 5.4M tokens/run, D ≈ 8.8M), the A and S stage alone is about
    72 × 2 runs ≈ 780M tokens. D and M together add about 1.3B.
  - Fewer pairs are possible, but then the trial can detect only larger effects. The table above is
    the trade-off.
- The fresh apps' variance is unknown. It is re-estimated from the first 24 valid pairs. N is **not**
  changed from that estimate unless this document pre-registers the rule for changing it. Proposed:
  no change; report the achieved power.

## Metrics

**Primary**
- **Labelled true positives per pair:** unique labelled locations matched at the official rule, and
  at every `eval/rescore.ts` level (file, point ±3, range ±3, ±10, capped overlap), with and without
  the class rule.
- **Adjudicated precision, per claim tier:** all rows, presented (not refuted or disposed) and
  confirmed. Adjudication follows `eval/adjudication.md`, and the judge is not an OpenAI model
  **[operator: judge model]**.
- **Cost:** the median per-pair log ratio of total tokens (metered plus the retry estimate), with an
  app-clustered bootstrap interval. Pooled sums are reported beside it and not used for the decision:
  on Luna they swung from 0.51 to 2.86 on single runs.

**Secondary**
- **Dollars,** at the provider's list prices, with cache reads priced separately.
- **Stop reasons** per arm (ADR-030): the offered-to-continue rate is the metric 3.2 should move.
- **Verifier:** confirmed-tier against suspected-tier precision; rejected true positives, as a
  share of labelled true positives among refuted rows; quote-downgrade rate.
- **Clean controls:** valid claims per control run; the false-accept rate.
- **Per-issue find rates and McNemar** (`eval/paired.ts`).

## Decision rule

A comparison **passes** when all three hold:

1. **True positives.** The lower bound of the 95% app-clustered bootstrap interval on the per-pair
   difference is above −0.3 (non-inferior within 0.3 TP/pair) at the official rule. The same holds
   at the class-free ±3 level, reported as a robustness check.
2. **Precision.** Adjudicated precision of the presented tier is at least 85% of the comparator's.
   The ratio's lower 95% bound is reported beside it.
3. **Cost.** The upper bound of the 95% interval on the median per-pair log token ratio is at or
   below log(1.10). The candidate costs at most 10% more at the typical pair.

A comparison is **superior** when rule 1's lower bound is above 0. Rules 2 and 3 still apply, but
rule 3 is relaxed to log(1.5) when superiority is shown. **[operator: the cost allowance for a real
gain.]**

**Ship decisions:**

| outcome | action |
|---|---|
| S passes against A | Phase 3's single-agent changes can ship to `main` |
| D passes against S **and** D is at least non-inferior to M | delegation may become the default again, by a new ADR citing this trial |
| D does not pass against M | delegation stays opt-in: it adds nothing that the same tokens do not buy solo |

## Held-out guard

- The v5 held-out apps are **not reused**: they have now been run once, and their role was to veto
  tuning on the v5 corpus.
- The v6 guard is the fresh corpus itself. Nothing in Phase 3 was designed from run data (the
  design documents say so), and no change is made after the freeze.
- **[operator]** Whether to hold back 3 of the 12 fresh targets as a sealed confirmation set, run
  only after the main result is known. It costs power; it guards against a result carried by one app.

## Analysis plan

- **Tools:** `eval/rescore.ts`, `eval/paired.ts` and `eval/cost-breakdown.ts` at their frozen
  commits.
- **Bootstrap:** 10,000 app-clustered resamples, seed 1.
- **Exclusions:**
  - invalid runs are excluded only by the harness's validity rules;
  - pairs abandoned by the attempt ceiling are reported per arm, and they make a comparison
    inconclusive, never passing.
- **Reported whatever the outcome:** every comparison, every level, every arm, every variant.
- **Everything in this document is fixed at the freeze.** A metric added later is labelled
  exploratory.

## Before the freeze

- [ ] Fresh-corpus review settled; draw final.
- [ ] Harness accepts N targets plus controls (it takes exactly 5 today).
- [ ] 2.5 matched arm merged and reviewed.
- [ ] 3.1 and 3.2 merged into `p3/candidate-v5` and reviewed; candidate snapshot built and hashed.
- [ ] Faux-provider smoke run of every arm, no model calls, proving the arms are configured as
  above.
- [ ] Operator decisions above.
