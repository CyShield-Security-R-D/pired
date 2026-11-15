# Delegation v6 — Phase 2 design (benchmark operations)

*Design for Phase 2 of [`delegation-v6-plan.md`](delegation-v6-plan.md). It comes from a read-only
review of the harness on 2026-09-26, at 7f52327. Each item still needs its own ADR before it
lands. Line numbers are as of that commit.*

The arms of a pair run **one after the other** today: `runGrid` loops `for (const arm of
pair.order)` (`eval/delegation-compare.ts:3322`). `--concurrency` counts pairs, and `planSchedule`
(`delegation-compare-lib.ts:1197`) alternates the order by pass and target. pi is
`@earendil-works/pi-coding-agent` 0.87.1.

## What pi's retry actually does

pi retries at two levels.

**Agent level (`retry.enabled`).**
- Defaults: `maxRetries` 3, `baseDelayMs` 2000, `maxAgentDelayMs` 60000
  (`dist/core/settings-manager.js`).
- **What triggers it:** a reply that ends `stopReason: "error"` and passes
  `isRetryableAssistantError`. That covers 429, 5xx, overloaded, timeout, terminated,
  fetch/socket failures and "retry your request". It excludes quota and billing text, and context
  overflow.
- **What a retry does:**
  - emits `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage}`;
  - drops the failed reply from context with a `context_edit {targetId, replacement: null}` entry;
  - sleeps `base·2^(n−1)`;
  - continues. `auto_retry_end {success, attempt, finalError}` closes the streak.
- **The cap is per streak, not per run.** The counter resets on the next good reply.
- Compaction retries with the same settings and emits `summarization_retry_*`.

**Transport level (`retry.provider.maxRetries`).** It defaults to 0, and codex's own default is 0.
These retries are silent: no event, no usage.

**What is logged:**
- The parent transcript (JSON stdout) has everything: the failed `message_end`, the context edit,
  and the `auto_retry_*` events.
- A child's `session.jsonl` keeps only the failed reply and its context edit.
- A child's compaction retries leave no trace at all.

**Usage for failed attempts is almost never reported.**
- Responses/codex set usage only on `response.completed`, and completions only on the last chunk,
  so a dropped stream shows zero.
- Failed compaction attempts are discarded.

## 2.1 Retry transient errors inside a run

**Changes**
- **Settings.** `BENCHMARK_SETTINGS` (`delegation-compare-entry.ts:96`) becomes
  `retry: {enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 30000, provider: {maxRetries: 0}}`.
  - Transport retries are pinned at 0 so nothing retries silently.
  - The same object is written to each cell's agent directory, so workers get the same policy.
- **Request log.**
  - The entry's fetch wrapper logs `benchmark_request {n, host, status, msToHeaders}` for provider
    hosts.
  - Parent and in-process workers share `globalThis.fetch`. Logged requests minus metered replies
    and compactions is therefore the number of unmetered attempts, including the workers'
    compaction retries.
- **Accounting (`observationsFromPiEvents`, behind a new `retry` option):**
  - an `error` reply followed by `auto_retry_start` is a retried attempt; its reported usage is
    kept and it goes into a `retries[]` list;
  - `auto_retry_end success: false` stays a failure;
  - with the option off, output is byte-identical.
- **Accounting (`observationsFromChildSession`):** an error reply that a later context edit omits,
  followed by a reply, is a retry, not a failure.
- **Unmetered attempts** get a lower-bound estimate: the previous reply's prompt plus output.
- **Classification.**
  - `providerFailureTexts` and `childProviderFailure` must skip retries that succeeded. Otherwise
    a run that is invalid for its own reason is classed as infrastructure because of a drop pi
    already recovered.
  - A run with more than R failed attempts in total, across parent and workers, is invalid
    infrastructure.
- **Run record.** It gains a `retry` block and `totalTokensWithRetryEstimate`. `totalTokens` keeps
  its meaning (metered).

**Fairness**
- Retrying removes the survival bias toward short runs, and with it the extra penalty on the arm
  that makes more calls.
- It also undercounts that arm's tokens, because failed attempts are unmetered. Gate on metered
  tokens plus the lower-bound estimate, which is conservative against the candidate, and report
  metered-only beside it.
- A retried turn consumes a worker's turn budget (`core/child.ts` counts `turn_start`). The
  baseline has no such budget, so measure this; do not change the frozen product.

**Tests**
- "accepts a transient failure pi retried and counts the failed attempt's reported usage"
- "still refuses retry events when the retry policy is off"
- "leaves the run invalid when the retries run out"
- "treats a worker's error reply omitted by a context edit and followed by a reply as a retried attempt"
- "keeps an overflow recovery apart from a retry"
- "estimates an unmetered attempt from the previous reply's prompt plus output"
- "does not class a run as infrastructure from a drop pi recovered"
- A faux preflight retry probe in both arms: "terminated", then success.

**Risks**
- A v5 run with a retry was invalid, so `valid` changes meaning. Record a `retryPolicy` in the
  manifest.
- Retry sleeps count against the run limit.
- Do not extend pi's retry list: patching pi changes `piRuntimeSha256`.

## 2.2 Run a pair's arms concurrently, in seeded random order

**Changes**
- `planSchedule(ids, passes, {seed})`: a seeded PRNG with permuted blocks per pass, so the orders
  stay balanced to within one. With no seed it keeps today's alternating order.
- The seed goes into `manifest.schedule`, which resume already compares. Add `--order-seed`.
- Split `runOne` into prepare, launch and inspect:
  - prepare both cells before either launches;
  - launch in start order with a fixed ~2 s stagger;
  - wait with `Promise.allSettled`.
- Record `pairLaunchId`, `launchedAt` and `startSkewMs` per arm.
- `gridWorstCaseMs` drops the ×2 and multiplies by the per-pair attempt cap from 2.3.

**Fairness.** Both arms share the provider window, and any first-mover effect is randomised
instead of alternated.

**Main risk: both arms review the same application at the same time.** If both start its server on
the default port, one arm gets EADDRINUSE or talks to the other arm's server. The documented
"TCP service on localhost" limit becomes systematic and uneven within a pair.
- The fix is a network namespace per cell. `bwrap` and `unshare` are installed, but pasta or
  slirp4netns (needed for provider traffic) are not, so this is an operator decision. Prove it in
  preflight.
- At minimum, count bind and connect errors per arm.
- Provider load doubles, so `--concurrency 5` now means 10 processes.

## 2.3 Circuit breaker

**Changes**
- A pure `createBreaker(policy).record({atMs, valid, infra, exhausted, blocked}) → {tripped, reason}`.
- **It trips at once** on an exhausted quota, or on a non-infrastructure invalid run in an official
  grid.
- **Otherwise it trips** on C consecutive infrastructure failures (3), or on an infrastructure
  failure rate of R (50%) or more over the last N runs (8). A valid run resets the streak.
- It replaces fail-fast at `delegation-compare.ts:3355`.
- An infrastructure-failed pair is re-queued at attempt+1 after a cooldown of 60 s × attempt, up to
  4 attempts.
- One pure `nextPairAction` is shared with `planResume`.
- The policy goes in the manifest, so resume restores it.

**Fairness.** At the start of an outage it spends up to C × runs-in-flight. Both arms are treated
alike.

**Tests**
- "trips after three consecutive infrastructure failures"
- "does not trip on isolated drops among valid runs"
- "trips on the window failure rate only once the window is full"
- "trips at once on a quota stop"
- "re-queues at the next attempt after the cooldown"
- "stops re-queuing at the attempt cap"

## 2.4 Reuse a valid arm

**When reuse is allowed.** Only the failed arm X is re-run, and all of these must hold:
- X failed for infrastructure;
- its partner Y is valid, with the same `pairLaunchId` and a start skew within the stagger;
- the replacement for X starts within a pre-registered window W (e.g. 6 h) of Y's launch;
- the pair has no non-infrastructure error.

**Changes**
- `nextPairAction` returns keep, rerun-both, rerun-arm or blocked.
- A new `pairings.jsonl` records `{key, baseline: {attempt, cellId}, candidate: {…}, reused, skewMs}`.
  `runs.jsonl` keeps exactly one row per launched run.
- The summary's `comparison` stays strict: same attempt only. `comparisonWithReuse` and a `reuse`
  block are added beside it.
- `eval/paired.ts` and `eval/rescore.ts` take pairings as an optional input, and stay strict when
  the file is absent.

**Fairness**
- Each arm is then selected by its own survival, not its partner's.
- The cost: reused pairs no longer share a provider window.
- Reuse will mostly keep baselines, because candidates fail more often. Report results with and
  without reuse.

**Tests**
- "reuses a valid baseline when only the candidate failed for infrastructure in the same concurrent launch"
- "never reuses legacy sequential rows"
- "does not reuse outside the window"
- "never reuses across a non-infrastructure failure"

## 2.5 Matched-compute arm (single agent × k)

**Changes**
- `Arm` widens to baseline, candidate and matched. `compareMatchedRuns` runs twice: baseline vs
  candidate for the gate, and matched vs candidate.
- **The matched arm:**
  - k baseline-snapshot sessions in fresh cells, launched with the pair;
  - each has a token ceiling of B/k, where B is a pre-registered per-target candidate budget taken
    from a pilot;
  - the entry gets a `tokenCeiling`. It aborts between requests after the `message_end` that
    reaches the ceiling, so every request is metered.
- **The union:**
  - deduplicate the way `compounding-union.ts` does, then score with the pinned scorer;
  - tokens are the sum over the k sessions;
  - the arm is valid only when all k sessions are, and a failed session re-runs on its own.

**Fairness**
- A budget fixed in advance keeps the arm in the same window, but it matches compute only in
  expectation. Report the realised ratio.
- The union raises claims as well as true positives, so compare precision after deduplication.

**Risk.** This has the widest reach: `Arm` is used everywhere. `eval/paired.ts` already skips
unknown arms.

## 2.6 Stop reason as an outcome

**Changes**
- A new module, `eval/delegation-compare-stop.ts`, with `classifyStop → {outcome, evidence}`.
- Precedence: error, then budget (time limit or token ceiling), then turn cap, then the text test.
- It is attached after the run record is built, the way the delegation audit is, and recorded per
  worker too. It never changes validity.

**Detecting "offered to continue" without matching one model's phrasing**
1. Strip code blocks, quotes and finding lists, then read the last paragraph.
2. Use grammatical features, not phrases taken from any model's output:
   - the closing sentence is a question;
   - it addresses the reader ("you");
   - it makes a first-person offer or conditional;
   - it states the work is incomplete.
3. "Offered" is a closing question, or an address to the reader combined with an offer. Record
   which features fired.
4. Cross-check with a signal that doesn't depend on text: open hypotheses and unsettled surface
   cells from engagement telemetry.
5. Validate the rule on a labelled sample from all three models before freezing it. GLM and
   DeepSeek never stop early, so they serve as negatives.

A pired "finish" action (Phase 3) would later make this structural.

**Tests**
- "labels a time-limit stop as budget"
- "labels a worker stopped by pired's turn budget as turn cap"
- "labels a closing question to the reader as offered to continue"
- "ignores a question inside a code block"
- "labels a declarative closing summary as finished"

## 2.7 The candidate's scope states its worker cap

Since ADR-029 the default is 0. `reviewScope` writes no `maxAgents`, so a candidate cut from `main`
would run with delegation silently off. The candidate's scope names its cap, and the manifest pins
it.

## Pins and old grids

- **Harness pins.** Any edit to a `HARNESS_FILES` file changes `harnessSha256`, and so does adding a
  module to that list. An old grid then refuses to resume under the new code, so resume it from a
  worktree at its own commit.
- **Never change `piRuntimeSha256`.** That means no pi patch, and no `npm install` while a grid is
  running.
- **Manifest schema v3** adds `retryPolicy`, `orderSeed`, `breaker`, `reusePolicy` and `matched`.
  - `optionsFromManifest` refuses a v2 manifest with a clear message.
  - New fields are additive: `totalTokens`, `valid`, `comparison` and `order` keep their meanings.
- **Protocol documents.** `eval/delegation-compare.md` stays the v5 protocol, and v6 gets its own.

## Order and parallel tracks

- **In parallel:**
  - A: 2.1, touching the entry settings, the lib accounting and failure classification.
  - B: 2.6, a new module plus a small hook.
  - D: groundwork for 2.5, the union scorer and the entry's token ceiling.
- **One engineer, in sequence:** C, which is 2.2 → 2.3 → 2.4. All three change `runGrid`,
  `planSchedule` and `planResume`.
- **Last:** 2.5 integration, then 2.7.
- **Overlaps to coordinate:**
  - 2.1 and 2.6 both touch the run record; 2.6 attaches after it.
  - 2.1 and 2.5 both edit the entry: settings vs ceiling.
