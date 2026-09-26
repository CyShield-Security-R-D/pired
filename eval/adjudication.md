# Adjudication protocol — specification

*Plan item 1.4 of [`docs/delegation-v6-plan.md`](../docs/delegation-v6-plan.md). Status: spec, not
yet adopted. Running it needs model calls, so it runs in Phase 4.*

## The problem it solves

The answer key labels only the locations of known CVEs. Every other claim counts as a false
positive, including real issues the key does not list. Two measurements from the v5 trial
([`research/12`](../research/12-delegation-trial-2026-09.md)) show why that is not good enough:

- **Absolute precision was 4–10% in both arms.** A consultant reading that would conclude the tool
  is mostly noise. Nobody has checked whether that is true.
- **On Luna the candidate made 115 claims against the baseline's 58, for 7 true positives against
  6.** ADR-026 read that as a precision loss (59%). It is one only if the 57 extra claims are not
  real issues. The key cannot tell.

So precision can only be compared between arms, and even that comparison assumes both arms'
unlabelled claims are equally likely to be real. Delegation changes what gets recorded: 51 of the
candidate's 115 Luna claims were recorded by workers. That assumption is the one most likely to
fail.

Adjudication replaces "matches the key" with "is a real issue at the cited location", judged by a
process that cannot see which arm made the claim.

## What is judged

**Unit: the unique issue per target.**
- Collect every live (not deleted, not disposed) finding from every run on a target: both arms,
  all passes, all attempts that count.
- Group the claims into issues. An issue is one weakness at one sink. The same sink reached from
  two routes is one issue; two sinks in one function are two issues.
- Precision and yield are counted over issues, not raw claims. Duplicates count once, so an arm
  gains nothing by recording the same issue three times. The raw claim count is reported beside
  it, as the cost of reading the ledger.

**Grouping is part of the judgement, and it is blind.**
- A mechanical pass proposes candidate groups: same file, overlapping cited ranges within ±3 lines,
  compatible class or CWE.
- The judge confirms or splits each group with the code in front of it.
- Grouping by text similarity alone is rejected: two workers describing one sink in different
  words would count as two issues, and that is exactly the inflation being measured.

## Blinding

The judge sees, for each claim:
- the cited locations;
- the title;
- the class and CWE;
- the description;
- the evidence, stripped of the fields listed below.

The following is **removed or normalised**:
- arm, run, pass and attempt;
- finding id: ids are re-issued per target in shuffled order;
- `verification` and `status`: these differ by design between arms (ADR-028 workers write
  verdicts), so they would reveal the arm;
- `source`;
- any worker or provenance tag;
- timestamps;
- file paths of evidence under the run's workspace;
- wording that names the orchestration, such as "scout", "worker", "subagent", or a verifier's
  verdict text.

Claims from both arms are interleaved in random order under a fixed, recorded seed. Formatting is
normalised to one template, so ledger style (for example, bullet density) cannot identify the arm.

**The judge never sees the answer key.** Claims that match the key serve as a built-in check on the
judge (see *Validity* below). A judge that has read the key would pass that check for free.

## What the judge has

The application's source tree, read-only, in the same sandbox the benchmark uses. The judge is
expected to open the cited code, follow the input to the sink, and check the guards.
- The rubric asks for the verdict to be grounded in quoted code lines.
- A verdict without a quote is recorded as `unverifiable`, not accepted.

This follows the finding that checks grounded in the code raise precision, while re-reading the
claim's own reasoning barely helps (research/12: 2601.18844, RepoAudit, Kamoi et al.).

The judge gets **no transcripts**. The claim has to stand on what was recorded. That is also what a
consultant reading the ledger gets.

## Rubric

Each unique issue gets exactly one label:

| label | meaning |
|---|---|
| `valid` | A real security weakness, reachable from an input the application accepts, at the cited location (the sink or its immediate guard, within the cited range) |
| `valid-mislocated` | A real weakness, but the cited location is not where it is: a different function, or more than 10 lines from the sink |
| `not-security` | The code does behave as described, but the consequence is not a security one: a crash on bad input with no impact, style, or a missing best practice with no exploit path |
| `guarded` | The described flow exists, but a guard in the code blocks it. The quoted guard is required |
| `wrong` | The code does not do what the claim says |
| `unverifiable` | The claim is too vague to check (no location, or a location with no matching code) or the judge could not ground a verdict |

The judge also records:
- `severity_agrees` (yes / higher / lower);
- the quoted code lines the verdict rests on.

It records **no reproduction steps**. The protocol measures whether a claim is real and where it
is, not how to exploit it. Keeping the output to labels and quotes also keeps the judge's cost
predictable.

## Metrics

Per arm, per target, then summed or averaged as the pre-registration states:

- **Adjudicated precision** = `valid` issues ÷ unique issues the arm claimed.
  - Reported both with and without `valid-mislocated` counted as valid.
- **Pooled yield** = `valid` issues the arm found ÷ `valid` issues found by any run on the target.
  - Pooling across both arms, the TREC approach, is fair here because both arms contribute to the
    pool.
  - It measures relative recall. It is not a claim about every issue in the application.
- **Key recall** = the current true-positive count, unchanged, reported at every scoring level of
  `eval/rescore.ts`.
- **Claims per valid issue** = raw ledger claims ÷ `valid` issues. This is the reader's cost.

Paired comparisons between arms use `eval/paired.ts` on these per-pair numbers, with the same
app-clustered bootstrap.

## Judge

- **A different model family from the model under test.** LLM judges favour outputs that resemble
  their own (research/12: 2404.13076). For a Luna trial the judge is not an OpenAI model.
- **One judge model per trial**, named in the pre-registration and pinned by provider, model id and
  settings, the same way `delegation-compare.pins.json` pins the benchmark.
- **Judging is per target**: one session per target sees that target's claims from every run,
  shuffled. Across-arm grouping needs that. It also means the judge reads each file once, not once
  per claim.

## Validity

The adjudication is used only if all three checks pass. Each threshold is fixed before the first
judged claim.

1. **Key agreement.** Of the claims that match the answer key at the ±3 level, at least 90% are
   labelled `valid` or `valid-mislocated`. A judge that rejects known CVE locations cannot be
   trusted on the rest.
2. **Inter-judge agreement.**
   - A second judge, from a third model family, independently labels a random sample: 20% of
     unique issues, and at least 40.
   - Cohen's κ on the `valid` / not-`valid` split must be at least 0.6.
   - Below that, the rubric is revised and the whole set is re-judged. The revision is logged as a
     variant (plan principle: count every variant tried).
3. **Operator spot check.** The operator labels 20 issues drawn at random, blind in the same way.
   The disagreement rate is reported beside κ. It is not a gate, because one person's labels on 20
   items cannot carry one. It is the check that the rubric means what a consultant means.

The Phase 4 clean-code controls add a fourth reading. Every claim on a control application should
be `wrong`, `guarded` or `not-security`. The judge's `valid` rate there is its false-accept rate,
reported beside the results.

## Held-out grids

Held-out claims are adjudicated only to compute the pre-registered held-out verdict. Their labels
are never read to diagnose or shape a change ([ADR-026](../docs/decisions.md), held-out guard).

## Cost

Measured, not estimated, when it first runs. Spend is reported with the trial's other tokens.
Luna v5c had 173 raw claims over 15 pairs, before grouping. Per-target sessions mean the number of
judge sessions scales with targets × trials, not with claims.

## What would make this spec wrong

- **If grouping turns out unstable**, the unit of measurement moves with the judge rather than with
  the arms. The same claims regrouped by the second judge would then give a different issue count.
  The κ check covers labels, not grouping, so the second judge's issue count is compared too.
  - A difference of more than 10% between the two judges' counts is reported as a limitation.
- **If the key-agreement check passes only because CVE locations are the most obvious issues in each
  app**, the judge may still be poor on subtle unlabelled claims. The operator spot check is the
  only guard against that, and it is small. More operator labels are the fix, not a larger model.
