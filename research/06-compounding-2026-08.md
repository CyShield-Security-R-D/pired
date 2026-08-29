# The compounding experiment, August 2026

*The persisted ledger did not improve recall. The result that said it did was a scoring artifact.*

## Why run it

`research/04 §6` claimed the record/recall workflow "measurably improved coverage
over an unstructured review of the same model." `research/05` showed the
benchmark could not support that: the ledger was empty in four of five runs, so
whatever produced the detection lift, it was not the engagement machinery.

`05 §3` named the experiment that would settle it — *"three arms, k sessions,
persisted vs wiped ledger"* — and recorded that it had not been run. This is that
experiment.

## Method

Two arms, identical in every respect but one:

| arm | between sessions |
|---|---|
| `persisted` | the engagement workspace carries forward |
| `wiped` | the workspace is deleted — every session is a cold first look |

Same target (DVBank `clean/` plus the six decoys), same model
(`qwen/qwen3.8-27b`), same prompt, same grader, same key, `window=3`.
**n=3 rollouts per arm × k=3 sessions = 18 scans.**

Because memory is the only variable, any difference between arms is what the
ledger bought.

Serving was pinned to a single host (Parasail, fp8) through a metering proxy with
`allow_fallbacks: false`. Default OpenRouter routing picks a host per request,
which would have mixed quantizations across ~470 requests and added variance
exactly where the design is trying to detect a slope. Zero off-host requests were
recorded. Cost: **$3.45**, measured per request rather than estimated.

## 1. The headline, as the runner first reported it

```
recall
  persisted  0.428  →  0.585  →  0.591   Δ 0.163
  wiped      0.390  →  0.421  →  0.516   Δ 0.126
```

At session 1 the arms separated completely — every persisted rollout above every
wiped rollout, an exact permutation test at p = 0.050, the floor for 3-vs-3.
This looked like a clean positive result.

It was not one.

## 2. The confound

`compounding.ts` scores each session from the engagement ledger:

```ts
const findings = dedupe(await fromLedger(engagementDir));
```

The persisted arm's ledger is never cleared, so by session *k* it holds the
**union of sessions 0..k**. The wiped arm's is cleared before each session, so it
holds **one** session's findings. The two arms were being scored on different
quantities.

A union of *k* draws beats a single draw for any stochastic process. The rising
line measured accumulation, not learning.

## 3. Re-scored on a common basis

Unioning the wiped arm's per-session findings the same way the persisted ledger
accumulates them:

```
cumulative recall (union of sessions 0..s)
  persisted  0.428  →  0.585  →  0.591   Δ 0.163
  wiped      0.390  →  0.497  →  0.591   Δ 0.201

final cumulative recall
  persisted  0.566, 0.641, 0.566   mean 0.591
  wiped      0.604, 0.547, 0.623   mean 0.591
  gap                              -0.000
```

**The persisted ledger bought nothing.** Three sessions of accumulated
engagement state reach the same recall as three independent cold scans unioned
together, and the per-rollout finals interleave — there is not even a rank
ordering to argue about.

## 4. What durable state *did* change

Session durations, mean per arm:

| | s0 | s1 | s2 |
|---|:--:|:--:|:--:|
| persisted | 484s | 595s | **255s** |
| wiped | 524s | 414s | **480s** |

The persisted arm's final sessions run roughly half as long. `persisted r0 s2`
ran 105 seconds and recorded **zero** new findings and **zero** new hypotheses:
the agent opened a full ledger, concluded the work was done, and stopped.

So the ledger does change behaviour — it makes the agent **stop earlier**. That
is the opposite of the "keep testing while gaps remain" the harness is built to
enforce. It is not an efficiency win either: total time across three sessions
moved only 1418s → 1334s, about 6%.

Hypothesis recording, by contrast, was heavily exercised (mean 541 hypotheses per
persisted session by s2, against 0.8 records per run in `research/05`), so the
harness fixes between those runs did take effect. The mechanism ran; it just did
not pay.

## 5. What this does and does not license

**Supported.** On a single target, over three sessions, a persisted engagement
ledger produces no measurable recall benefit over independent cold scans, and
biases the agent toward early exit.

**Not supported, in either direction.** With n=3 and within-rollout
session-to-session noise of ±0.095 recall, this rules out large effects, not
small ones. It is also one target, one model, one provider, and a target small
enough that a single session already reaches ~0.43 recall — a codebase where one
pass cannot cover the surface is where durable state should help most, and this
is not that codebase.

**The claim that has to change.** `research/04 §6` and the README's "coverage
discipline is where the recall lift came from" cannot be repaired by this
experiment; it refutes them on this target. The value of `record`/`recall` must
now be argued on grounds this benchmark does not measure — continuity across a
real multi-day engagement, operator visibility, the audit trail, findings that
survive a compaction — or the design must change so that a full ledger drives
*further* testing rather than a confident early exit.

## 6. A contamination found along the way

The DVBank target tree contained a stray `AGENTS.md` — 13 KB of pired's own
system prompt, written there by a harness run on 25 August and never removed.
Both pi and codex read `AGENTS.md` as project instructions.

For the qwen arms it is a duplicate of a prompt pired already injects, and it hit
both arms equally, so the persisted-vs-wiped comparison stands. For anything else
it is serious: it silently hands pired's full methodology — including the
19-class weakness floor — to whatever agent reviews that tree. A codex arm run
against it returned **0 findings**; the same scan with the file removed returned
**28**.

It has been quarantined out of the target. Any earlier result measured against
`eval/variants/clean` after 25 August should be re-checked for it, including the
"vanilla pi" arm, whose vanilla-ness the file would have undermined.

## 7. Threats to validity

- n=3 per arm, k=3. The design's floor is p = 0.05; it cannot resolve small effects.
- One target, one model, one provider, one quantization.
- The target is small relative to a real engagement — the regime least favourable
  to durable memory.
- The per-session scores in §1 remain in the raw output. They are kept because
  they are what the instrument produced, and the artifact is worth seeing.
