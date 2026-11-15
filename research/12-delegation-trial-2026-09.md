# 12 · The delegation trial, and what it says to change

*September 2026 — pired with pi-subagents delegation (snapshot v4) against pired@64479f0, on GPT-6 Luna, GLM-5.3 Flash and DeepSeek V4.1 Flash*

## The question

ADR-027 made pired delegate to four worker subagents: scout, investigate, verify and escalate. ADR-026
fixed in advance how that change would be judged. On each priority model it must either keep quality
within 15% of the baseline while spending fewer tokens, or find at least 15% more with precision
within 15%. It must also clear a held-out veto grid. Delegation is accepted only if GPT-6 Luna and
GLM-5.3 Flash both approve.

This note records the measured outcome, what the run data says about where delegation gains and
loses, and the design and measurement changes the evidence supports. The plan built on it is
`docs/delegation-v6-plan.md`.

All numbers here are aggregates over run records. Held-out grids are used only for their pre-registered
verdicts, never to diagnose.

## Verdict

| model | grid | pairs | TP (baseline → candidate) | precision | tokens | outcome |
|---|---|---|---|---|---|---|
| **GPT-6 Luna** | official v5c (gating) | 15/15 | pass-mean 2.00 → 2.33 (117%) | 0.103 → 0.061 (**59%**) | 27.0M → 43.8M (**+62%**) | **not approved** |
| GPT-6 Luna | held-out | 10 matched\* | 100% | 180% | — | no veto |
| GLM-5.3 Flash | official, commandcode | 10/15, stopped | 12 → 11 (92%) | 101% | −5% | incomplete: commandcode weekly limit |
| GLM-5.3 Flash | held-out, commandcode | 7/12, stopped | 90% | 84% | −10% | incomplete |
| DeepSeek V4.1 Flash | official (evidence) | 12/15 | 92% | 100% | +8% | blocked by a 16k output-cap failure |
| DeepSeek V4.1 Flash | held-out (evidence) | 12/12 | 100% | 106% | +13% | no veto |

\* Held-out runs that hit the 2-hour limit are scored on their ledger at the deadline, as
pre-registered. Two had no partner run and are left out. Counting them anyway gives 150% / 129%, also
no veto.

**Luna fails both paths.** The candidate finds a little more, but it makes nearly twice the claims
per true positive and costs 62% more tokens. In dollars it costs 1.7× the baseline: 96% of the tokens
are cache reads. It delegated in all 15 runs, launching 41 workers (14 scout, 9 investigate, 18
verify).

Delegation needs both priority models to approve, so **snapshot v4 is not accepted**. GLM's remaining
pairs cannot change that.

Across the six official grids, including the previous design (v3), the candidate found **58 true
positives against the baseline's 69**.

## What the run data shows

### Coverage is not the bottleneck

Across 984 (run × labelled location) outcomes on the official corpus, both arms:

| outcome | baseline | candidate |
|---|---:|---:|
| matched (within 3 lines) | 19% | 15% |
| claim in the right file, outside the window | 30% | 30% |
| recorded in the ledger, not claimed | 11% | 17% |
| file opened, nothing recorded | 13% | 12% |
| file touched by a tool, nothing recorded | 12% | 11% |
| file never opened | 15% | 14% |

The agents reach the right file in about 85% of cases. The losses come after that point.

"Right file, outside the window" is not a clean localisation rate. Files that hold several labelled
locations inflate it, and a claim 10–80 lines away may be a different issue in the same file.

One part of it is a scoring rule, not the agents. *(Corrected 2026-09-26 by the Phase 1 re-scorer;
the first version of this note blamed the wrong mechanism.)*
- A 266-line label carries no CWE. Its sibling label in the same target carries one.
- The grader applies its class rule to every label in a target once any label in it has a class. A
  claim that names a CWE can then never match the classless label.
- That label was matched officially in 0 runs. 29 valid runs cited a line inside its range.
- The range is 266 lines wide, so most of those 29 may not be the labelled issue. With the label
  capped at 30 lines, only 1 still matches.
- So the recall this hides lies somewhere between 1 and 29 run-matches, and the key alone cannot
  say where. See *Scoring sensitivity* below.

### Luna stops early; the others do not

- In **both arms**, about 40% of Luna runs end within 5 minutes.
- 32 of 41 baseline and 31 of 37 candidate Luna runs end by saying the review is incomplete and
  offering to continue. Unattended, the run simply ends.
- GLM and DeepSeek never stop early.
- Stopping early has not been shown to cost true positives. Short Luna runs averaged 0.50 TP per run
  against 0.32 for longer ones, but the short runs fell on the easier targets.

### Spending more tokens does not buy more true positives

- True positives per run are roughly flat across token buckets: Luna baseline 0.44–0.67 from under 2M
  to 25M tokens; GLM baseline 1.40 at 2–5M against 1.27 at 5–10M.
- This is observational. Tokens are an outcome, not a treatment: harder targets use more and yield
  less. Only a randomised budget cap would give a dose-response answer.

### Where the candidate's extra claims come from

| grid | claims (baseline → candidate) | TP | findings recorded by workers |
|---|---|---|---:|
| Luna v5c | 58 → 115 | 6 → 7 | 51 |
| GLM, z.ai (indicative) | 159 → 215 | 6 → 7 | 37 |
| GLM, commandcode | 168 → 152 | 12 → 11 | 12 |
| DeepSeek | 240 → 221 | 12 → 11 | 48 |

- On Luna, worker-recorded findings account for almost all of the inflation.
- On GLM (commandcode) and DeepSeek there is no inflation.
- Absolute precision is 4–10% in both arms. The answer key labels only known CVE locations, so real
  but unlabelled issues count as false positives. Precision is meaningful only as a comparison between
  arms until claims are adjudicated.

### Where the extra cost sits

- On Luna, workers used 7% of the candidate's tokens. The rest of the increase is in the parent
  session: 15% more requests, and 31% more context per request, weighted by request.
- `eval/cost-breakdown.ts` splits the parent's extra 41.6M tokens (Luna v5c, 15 pairs). Parent
  totals reconcile with the run records on 30 of 30 runs.

| source of the extra parent tokens | share |
|---|---:|
| more turns, at the baseline's starting prompt and growth rate | 78% |
| faster growth per turn, other than handoffs | 14% |
| handoff payloads carried in context (estimated at 4 characters per token) | 4% |
| larger starting prompt (the delegation block and the loader stub) | 3% |
| output and compaction summaries | 1% |

- The static scaffolding and the handoffs are small. The cost is **longer parent sessions**, and
  a longer session costs more per turn because every turn re-sends everything before it.
- The parent re-read a file a worker had already read at least 0.47 times per run. That counts the
  `read` tool only; `bash` reads are not counted.
- **Most of it is one pair.** One candidate run carries 85% of the pooled extra. The median pair's
  candidate used slightly *fewer* parent tokens, 48k fewer. Luna's run lengths are heavy-tailed in
  both arms, so pooled token sums swing on single runs, in both directions:

| Luna grid | pooled token ratio | median pair ratio | candidate cheaper | pooled, without the largest pair |
|---|---:|---:|---:|---:|
| v5c (gating) | 1.62 | 1.18 | 6 of 15 | 1.18 |
| v5b | 2.86 | 1.36 | 3 of 7 | 1.52 |
| v5 | 0.58 | 0.85 | 6 of 10 | 0.97 |
| v4 | 0.51 | 0.62 | 6 of 8 | 0.80 |

  ADR-026's path 1 compared pooled sums. With tails this heavy, that test is decided by whichever
  arm drew the longest run. The typical Luna v5c pair still cost about 18% more.

### Delegating runs vs solo runs

- Candidate runs that delegated matched the baseline on the same pairs: 38 against 37 true positives.
- Candidate runs that did not delegate trailed it: 20 against 32.
- Most of that gap comes from the previous design (v3), and from self-selection: the candidate chose
  not to delegate on pairs where the baseline scored well.
- For the current design the solo gap is about 9 against 12 over 11 pairs, about one standard error.
  It is not established.

### The benchmark's own cost

- 144 valid runs used 1,024M tokens.
- Runs that did not count burned 550M more: provider and network drops 349M, the operator pause 112M,
  timeouts 40M, quota windows 38M, other 10M.
- 17 valid runs (135M tokens, 7.2 run-hours) were discarded because a pair's arms must come from the
  same attempt.
- One pair needed 14 attempts.
- About 43% of all tokens went to runs that did not count.

Two design choices make this worse:
- Retries inside a run are disabled, so provider failures stay visible.
- One failed run stops a grid from launching new pairs.

The first also biases the valid set toward shorter runs, and the candidate arm, which makes more
calls, is hit harder.

### How much the trial can detect

Measured with `eval/paired.ts` on Luna v5c, at the location level closest to the official rule
(line ±3 over the label's range, without the class rule):
- **Result:** the candidate found 0.27 more labelled locations per pair. The 95% confidence
  interval, from a bootstrap that resamples apps, runs from −0.27 to +0.73.
- **Per issue:** 7 issues were found only by the candidate and 3 only by the baseline, McNemar
  p = 0.34.
- **Spread:** the paired difference has a standard deviation of 0.88 per pair.
- **Power:** with 15 pairs, the smallest difference detectable at 80% power and α = 0.05 is 0.64
  true positives per pair, more than the baseline's own mean. Detecting +0.3 per pair needs 69
  pairs; +0.2 needs 154.
- **Tighter levels:** these have less spread but smaller effects too. At ±3 around the labelled line
  the standard deviation is 0.46 and the smallest detectable difference is 0.33. The measured
  difference there is +0.07, 95% interval −0.20 to +0.33.
- **GLM (commandcode, 10 pairs):** standard deviation 1.75; the smallest detectable difference is
  1.55.
- Nights differ too. The same GLM baseline on the same provider matched 39% of labelled locations one
  night and 17% the next. The two nights' finished pair sets also differed.

### Scoring sensitivity

`eval/rescore.ts` re-scores every valid run of seven grids (160 runs) from the ledgers.
- **Its controls:**
  - a line-for-line mirror of the pinned adapter and grader reproduces the official true-positive
    count on all 160 runs;
  - the claims it parses equal the scorer's own claim list on all 160.
- **Three grader rules move the official number.**
  - **Class rule.** Once any label in a target carries a CWE, a claim at the right location but
    with a different CWE, or with one where the label has none, is refused. Without this rule, total
    true positives go from 145 to 194. The case above accounts for up to 29 of the 49.
  - **Basename file matching.** A claim in `handlers/assets.go` counts against a label in
    `services/assets.go`. This credits 4 true positives across the grids.
  - **Label ranges.** The ±3 window applies to the label's whole range. 7 of the 24 labels span
    more than 31 lines, and the widest spans 501. At ±3 around the labelled line itself, Luna v5c
    scores 2 against 3 instead of 8 against 12.
- **Summed over matched pairs, the verdict does not change:**

| scoring | baseline | candidate |
|---|---:|---:|
| official | 73 | 63 |
| without the class rule | 99 | 85 |
| without the class rule, full-path file matching | 94 | 81 |

On Luna v5c alone the class rule costs the candidate more: 7 → 12 against the baseline's 6 → 8.
Whether those refused matches are the labelled issue is exactly what adjudication has to decide
(`eval/adjudication.md`).

## What the literature says

**Multi-agent gains depend on the task.**
- In a controlled study of 260 configurations at matched tokens, multi-agent designs helped on work
  that splits into independent parts. They hurt on sequential, tool-heavy work, and gave negative
  returns once a single agent was competent.
- Multi-agent overhead ran from 58% to 515%.
- Independent workers amplified errors 17.2×, against 4.4× with central verification.
- Source: [Kim et al., *Towards a science of scaling agent systems*](https://arxiv.org/abs/2512.08296).

**Token spend explains most of the variance.**
- In Anthropic's multi-agent research system, spend explained about 80% of performance variance.
- The post notes that coding offers fewer truly parallel parts than research.
- A comparison that does not match compute partly measures "more tokens against fewer".
- Source: [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system).

**Adding generators without a verifier lowers precision.**
- Three parallel experts without a verifier scored below one expert. An adversarial verifier restored
  F1 ([2604.21282](https://arxiv.org/html/2604.21282v1)).
- Verifiers work when they check external facts, not when they re-read the reasoning:
  - In an industrial study, grounding the check in path-feasibility analysis raised precision from
    0.28 to 0.93, at a cost of 25% of true positives ([2601.18844](https://arxiv.org/html/2601.18844v1)).
  - Removing RepoAudit's validator halved its precision ([2501.18160](https://arxiv.org/html/2501.18160v1)).
  - Prompted self-critique barely helps ([Kamoi et al.](https://arxiv.org/abs/2406.01297)).
- LLM judges favour their own outputs ([2404.13076](https://arxiv.org/abs/2404.13076)), so a verifier
  should start from a fresh context and, where possible, be a different model.
- Voting across independent passes is a proven production filter ([Cursor Bugbot](https://cursor.com/blog/building-bugbot)).

**Localisation is harder than detection.**
- Statement-level F1 is about 24% even for strong models ([SecVulEval](https://arxiv.org/abs/2505.19828)).
- Detection falls off late in long inputs; smaller units restore it ([2502.06898](https://arxiv.org/abs/2502.06898)).
- Source-to-sink framing improves both coverage and localisation ([IRIS](https://arxiv.org/abs/2405.17238), [RepoAudit](https://arxiv.org/html/2501.18160v1)).
- Relaying worker summaries through a lead agent loses detail (Anthropic).

**Stopping.**
- Agents under-use a budget they cannot see. Showing used and remaining budget each turn gave the same
  accuracy at 31% lower cost ([BATS](https://arxiv.org/abs/2511.17006)).
- Context-aware models wrap up early unless told their state persists ([Anthropic prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)).
- Termination is a recognised multi-agent failure class ([MAST](https://arxiv.org/abs/2503.13657)).

**Evaluation practice.**
- Match compute, or report cost and accuracy together. A simple baseline matched an elaborate method
  at 1/55 of the cost ([Kapoor et al.](https://arxiv.org/html/2407.01502)).
- Use paired, clustered analysis over repeated runs ([Miller](https://arxiv.org/abs/2411.00640)).
- Score location at several levels of precision, validate the grader against transcripts, and include
  clean code where nothing should be reported ([Anthropic, evals for agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

## Conclusions

1. Delegation as designed in snapshot v4 **finds about the same issues at a higher cost**. On Luna it
   also lowers precision. It is not accepted.
2. The largest problems are **measurement** and **benchmark operations**, not orchestration:
   - the grader's class rule and over-wide labels move the true-positive count by a third;
   - pooled token sums on Luna are decided by single outlier runs;
   - precision cannot be read without adjudication;
   - the trial cannot detect differences below about 0.6 TP per pair;
   - about 43% of tokens went to runs that did not count.
3. The literature and the data agree on the orchestration side. Delegation needs an independent,
   grounded verification step between workers and the ledger. It should be used only where the work
   actually divides, and compared against a single agent at matched compute.
4. These findings describe mechanisms, not these five applications. Any change built on them is to be
   validated on fresh applications with a pre-registered test.
