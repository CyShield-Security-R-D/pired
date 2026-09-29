# Delegation v6: results

This file holds each verdict of the trial pre-registered in
[delegation-v6-preregistration.md](delegation-v6-preregistration.md), in the order the verdicts
arrive. Every number is copied from `eval/v6-decision.ts`'s output. That output, and the complete
run data behind it, are in `pired-research` under `v6/decisions/` and `v6/grids/`.

A verdict is added here only when its grid is complete and official. A later model's verdict
never changes Luna's.

## GLM-5.3 Flash · stage 1 · S vs A · FAILS (2026-09-29)

Grid `v6-stage1-glm`:

- Official, 144/144 runs: 12 apps and 12 patched twins, 3 passes. The blind pilot fixed the pass
  count by the one amendment.
- Run from `p2/drain` at babcd32, on z.ai.
- The decision script was run from the same worktree.
- The data is in pired-research at 24eaf2a.

| rule | measured | threshold | |
|---|---|---|---|
| 1 · advisories found per pair (pinned grader) | +0.167 [−0.083, +0.417], 36 pairs, 12 apps | lower bound > −0.3 | non-inferior; not superior |
| 2 · adjudicated precision, presented tier | pending, 1,562 claims | ≥ 85% of A's | cannot change the outcome |
| 3 · median per-pair log token ratio | −0.034 [−0.141, +0.296] | upper bound ≤ log 1.10 = 0.095 | not met |

What it says:

- **Finding.** On GLM, the candidate run solo finds at least as much as `main`. S found 30 of
  the 39 advisory opportunities, A found 24, and the difference is not significant (McNemar
  b=3, c=9, p=0.15). Leaving any one app out keeps rule 1 non-inferior in 12 of 12 cases.
- **Cost.** The typical pair costs about the same (median ratio 0.97). The interval reaches 1.34,
  so 12 apps × 3 passes cannot show "at most 10% more", and the rule reads that as a failure,
  not a tie. The pooled token ratio is 1.08.
- **Stopping, 3.2's condition.** The budget line did not make GLM work longer.
  - S offered to continue in 3/36 runs; A in 1/36.
  - Runs that stopped with time left and open work: S 24/36; A 23/36.
  - Median share of the 4 h limit used: S 0.20; A 0.14.
  - No run of either arm reached the limit.
  - 3.2 needs all three to move the right way; only the time share did.
- **Twins.** A made 24 claims within ±3 lines of a fixed region, S 26, over 883 and 865 claims in
  total. Neither arm tells the bug from its fix better than the other.
- **Verification.**
  - A ran 487 verifications and downgraded none.
  - S's grounded tier (3.1) ran 809 and downgraded 42%.
  - Each arm has 2 refuted rows. S's matched 1 labelled true-positive location; A's matched none.

Consequences, by the ship table:

- S is non-inferior on rule 1, so **GLM's stage 2 runs** (S vs D, plus the matched arm M).
- S does not pass against A on GLM, so this model gives Phase 3 no licence to ship to `main`.
  Luna's verdict is the one the pre-registration makes primary.

**Operator decision, 2026-09-30 (ADR-036).** Having read this verdict, the operator shipped
Phase 3 to `main` anyway, with delegation still opt-in: `maxAgents` and `maxVerifiers` default to
0, which is the configuration measured here as S. The trial goes on unchanged. Every arm runs
from a snapshot pinned by digest, so moving `main` changes nothing any v6 grid measures, and every
later verdict is still recorded here as pre-registered.

A known reporting slip does not change any number. The decision's header reads "36 paired of
24 expected". The expected count is read from the manifest, which is written once, at the
2-pass pilot, so it does not include the third pass the amendment added. All 36 pairs are
present and none was abandoned.

The slip matters only in one case. Abandoned pairs are read from the summary, so they are always
listed. A pair of an amended pass that was neither paired nor abandoned, however, would not be
listed as excluded. The fix reads the expected cells from the latest resume manifest, which lists
all 36. It landed as ca8a97a (`p2/decision-expected`, on `main` with ADR-036). Rerun on this grid,
only the header line changes, to "36 paired of 36 expected". Every later decision uses it.
