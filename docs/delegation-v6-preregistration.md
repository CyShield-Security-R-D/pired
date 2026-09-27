# Delegation v6 — pre-registration (DRAFT)

*Plan item 4.2 of [`delegation-v6-plan.md`](delegation-v6-plan.md). **Draft, not frozen;** the operator's decisions were recorded 2026-09-27. It is
frozen, by commit and hash, before the first v6 model call. Any change after that is an amendment,
dated and logged, and it is written before the results it could affect are read. Operator decisions
are marked with their date.*

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
| **D · candidate delegating** | same as S | `maxAgents: 8`, `maxVerifiers: 2` (operator, 2026-09-27), budget line on | the full candidate |
| **M · matched compute** | same as S | delegation off, k = 3 sessions, total tokens capped at D's realised tokens for the same pair (follow mode, ADR-034), findings unioned | D's compute without delegation |

**The comparisons:**
- S vs A (primary).
- D vs S (primary).
- D vs M (secondary).
- D vs A (reported).

A and S differ only in the Phase 3 changes. D and S differ only in delegation, which carries the verify worker's larger turn budget (about 40, up from 24; 3.1) as part of the delegating configuration. D and M differ only
in how the same tokens are spent.

**Staging, to control cost (operator, 2026-09-27).** Run A and S first. D and M run only if S is
not worse than A on the primary rule, because a candidate whose own single agent regresses is not
shipped with delegation on top.

## Corpus

- `eval/corpus/fresh/`: 12 targets drawn with seed 20260926 from the OSV pool. The procedure is in
  `eval/corpus/fresh.md`, and it is frozen by the hashes of `pool.json`, `exclusions.json`,
  `selection.json` and `truth/`.
- **Eligibility rule v2 (variant 2).** An independent review of variant 1, before any model call,
  found three non-applications: an SDK whose "routes" were HTTP client calls, a framework whose
  route was a generator template, and a desktop app whose server entry was archived. The rule now
  requires:
  - server-side route shapes outside tests, examples, fixtures and archives;
  - a deployable-service marker;
  - no README self-description as a framework, library, SDK or toolkit;
  - vendored files excluded from size and language measurement.

  The same seed is re-walked, and both variants stay on record.
- **Truth is location-only for the official score.** OSV sorts CWE ids as text, so a "first" CWE
  is not the primary one, and the v5 trial showed the class rule refusing location-correct claims.
  Labels carry every CWE of their advisory for the re-scorer's class level, matched any-of.
  - Import-only hunks are dropped.
  - Every label names its advisory.
  - Regions of known advisories without labels are **neutral**: a claim there counts as neither a
    true nor a false positive.
- **Controls are patched twins:** each target's fix-commit tree, with its fixed regions recorded.
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
  - The run limit is 4 h, as in v5c. It is written as `budget.minutes`, with a deadline, into the scope of
    every arm that runs the candidate snapshot (S, D, M). Arm A runs exactly as users get `main`
    today, with no budget in its scope; the budget line is one of the candidate's changes (3.2).
  - The thinking level is pinned at `medium` in both stage kinds.
  - The internal pilot is blind: until the pass count is fixed, a stage grid prints and stores
    only the pooled paired SD. The comparison itself is sealed for `eval/v6-decision.ts`.
  - Passes are extended exactly once on stage 1, by a recorded amendment (who, why, and what
    existed at the time), to at most 10. Stage 2 adopts stage 1's pass count.
  - The harness refuses a stage grid whose worst case exceeds the login-token horizon unless the
    horizon is given. Before each launch it stops resumably when the token would expire
    mid-run.
  - **Token refresh (operator, 2026-09-27):** when the harness stops for the token, the openai-codex
    token is refreshed between runs with pi's own command,
    `pi auth print-bearer-token --provider openai-codex --min-expiry <h>` with output discarded, and
    the grid is resumed. The token is never printed, and it is never refreshed inside a cell.
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

- **N is set by the blind pilot below (operator, 2026-09-27),** at most 10 passes per target. For
  scale, 12 targets × 6 passes gives 72 pairs per comparison, which detects about 0.3 true
  positives per pair at the v5 spread.
  - At Luna v5c's measured means (A ≈ 5.4M tokens/run, D ≈ 8.8M), the A and S stage alone is about
    72 × 2 runs ≈ 780M tokens. D and M together add about 1.3B.
  - Fewer pairs are possible, but then the trial can detect only larger effects. The table above is
    the trade-off.
- **The fresh apps' variance is unknown**, and label skew will raise it. At an SD of 1.2, +0.3 needs
  about 11 passes per target. The count is therefore fixed by an **internal pilot**:
  - 2 passes of arms A and S on all 12 targets.
  - The pooled paired SD of advisories found is computed blind to the direction of the difference.
    Only the SD is read; the arm means are not inspected.
  - Passes per target = ⌈(1.96 + 0.84)² · SD² / 0.3² / 12⌉, capped at 10, with a floor of 2. When
    the rule gives 2 or fewer, the pilot's count is fixed as it stands (a "fix-passes" amendment).
  - The pilot is computed by `eval/v6-pilot-sd.ts`, which prints only the number of valid pairs, the
    SD and the pass count.
  - The pilot pairs count toward the final analysis.
  - The rule is fixed here, before the pilot.
- **With only 12 apps,** the app-clustered interval stays wide whatever the pass count. This is
  reported as a limitation, not fixed by adding passes.

## Metrics

**Primary**
- **Advisories found per pair (primary):** an advisory is found when any of its labels is matched
  at the official rule: the pinned grader's matching (basename files, ±3 over the label's range, each
  claim assigned to at most one label), which is location-only on this corpus's classless truth. Five targets hold most of the
  labels, so counting labels would let one app carry the result.
  - Also reported: unique labelled locations, at every `eval/rescore.ts` level (file, point ±3,
    range ±3, ±10, capped overlap), and at the class level, matched any-of.
- **Adjudicated precision, per claim tier:** all rows, presented (not refuted or disposed) and
  confirmed. The unit is the unique issues an arm claimed on a target, across all its runs there.
  Precision is pooled over targets as Σ valid ÷ Σ claimed issues, and its bound comes from the
  app-clustered bootstrap. Labels reach the analysis through a blind worksheet: per target, claims
  under shuffled ids, with no arm, run, author or status (`eval/adjudication.md`). Adjudication follows `eval/adjudication.md`.
  - **Judge (operator, 2026-09-27):** Claude Opus 5.5 (`claude-opus-5-5`). It runs as
    fresh-context sub-agents, one per target, and never sees the arm mapping: the worksheet is
    blind, and the key map stays with the join step.
  - **Second judge:** GLM-5.3 Flash or DeepSeek V4.1 Flash, whichever is available, on a random 20%
    of the issues (at least 40). Labels count only at Cohen's κ ≥ 0.6.
  - **Operator spot check:** 20 issues, blind.
  - A small batch is judged first, to confirm the judging is not interrupted.
- **Cost:** the median per-pair log ratio of total tokens (metered plus the retry estimate), with an
  app-clustered bootstrap interval. Pooled sums are reported beside it and not used for the decision:
  on Luna they swung from 0.51 to 2.86 on single runs.

**Secondary**
- **Dollars,** at the provider's list prices, with cache reads priced separately.
- **Stopping, which 3.2 should move:**
  - **Offered-to-continue rate:** always read by the ADR-030 text test, in every arm. An arm's own
    settle record is tallied separately and never replaces the text test, so the arms are measured
    with the same instrument.
  - **An arm-neutral co-primary**, because the settle wording could change how a closing reads
    without changing the work done:
    - the share of the run limit used at the stop;
    - the share of runs that stop with time left **and** open cells or hypotheses.

    3.2 passes on stopping only if all of these hold: the text-test offered rate falls; the share
    of runs stopping with time left and open work falls; and the median share of the run limit used
    does not fall.
- **Verifier:** confirmed-tier against suspected-tier precision; rejected true positives, as a
  share of labelled true positives among refuted rows; quote-downgrade rate.
- **Patched twins:** claims within ±3 lines of each fixed region, per arm. This is re-flagging
  patched code, and it measures whether an arm tells the bug from its fix. Findings per KLOC are
  reported but never folded into precision.
  - **Twin arms (operator, 2026-09-27):** A and S only, in stage 1.
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
rule 3 is relaxed to log(1.5) when superiority is shown. (operator, 2026-09-27)

**Ship decisions:**

| outcome | action |
|---|---|
| S non-inferior to A on rule 1 (after stage 1) | stage 2 runs; otherwise it does not, and delegation stays opt-in |
| S passes against A | Phase 3's single-agent changes can ship to `main` |
| D passes against S **and** D passes against M (all three rules each) | delegation may become the default again, by a new ADR citing this trial |
| D does not pass against S, or does not pass against M | delegation stays opt-in: it adds nothing that the same tokens do not buy solo |

The last two rows are mutually exclusive by construction.

**D against A** is reported descriptively only and decides nothing. A and D run in different stages,
so they are never paired directly. The bridged estimate (D − S₂) + (S₁ − A) is paired by target and
pass index, with targets resampled jointly across the two grids. S₂ − S₁ is reported beside it, as
the check that S did not drift between stages.

## Held-out guard

- The v5 held-out apps are **not reused**: they have now been run once, and their role was to veto
  tuning on the v5 corpus.
- The v6 guard is the fresh corpus itself. Nothing in Phase 3 was designed from run data (the
  design documents say so), and no change is made after the freeze.
- **No sealed confirmation set (operator, 2026-09-27).** 12 apps is already the limit of the
  clustered interval. Holding 3 back would cost more power than it guards. A result carried by one
  app is checked instead by reporting each comparison with every target left out in turn.

## Analysis plan

- **Tools:** `eval/rescore.ts`, `eval/paired.ts` and `eval/cost-breakdown.ts` at their frozen
  commits.
- **Bootstrap:** 10,000 app-clustered resamples, seed 1.
- **Decision script:** `eval/v6-decision.ts` at its frozen commit.
- **Run validity (the v6 policy, pinned in both stage kinds):**
  - A run that reaches the run limit is valid, and is scored on its ledger as it stood at the
    deadline.
  - A run that ends quickly with nothing recorded is valid, with zero findings.
  - Both are model behaviour, not harness failure. Excluding them would bias the comparison
    against the arm that works longer or quits sooner, which is exactly what 3.2 changes. Their
    counts are reported per arm.
  - Only harness-integrity failures make a run invalid. On an official grid such a failure still
    stops the grid at once.
- **Exclusions:**
  - invalid runs are excluded only by the harness's validity rules, and listed;
  - pairs abandoned by the attempt ceiling are reported per arm. They make a comparison that uses
    them inconclusive, never passing, but the full report is still produced. A matched-arm
    abandonment affects only D against M.
  - A pair with no token count makes rule 3 inconclusive, not failed.
- **Reported whatever the outcome:** every comparison, every level, every arm, every variant.
- **Everything in this document is fixed at the freeze.** A metric added later is labelled
  exploratory.

## Before the freeze

- [ ] Variant 2 drawn and truth re-derived (review fixes in progress); draw final.
- [ ] Harness accepts N targets plus controls (it takes exactly 5 today).
- [ ] 2.5 matched arm merged and reviewed.
- [ ] 3.1 and 3.2 merged into `p3/candidate-v5` and reviewed; candidate snapshot built and hashed.
- [ ] Faux-provider smoke run of every arm, no model calls, proving the arms are configured as
  above.
- [ ] Operator decisions above.
