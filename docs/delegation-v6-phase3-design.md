# Delegation v6 — Phase 3 design (verification tier, budget and coverage)

*Design for items 3.1 and 3.2 of [`delegation-v6-plan.md`](delegation-v6-plan.md), from a read-only
review of the code on 2026-09-26 (ecb04b6). No run data was read, so nothing here is fitted to the
corpus. Each item still needs its own ADR, and none of it merges to `main` until the Phase 4 trial
passes.*

## Five facts from the code that shape the design

1. **The official scorer ignores status.** `fromLedger` in `eval/dvbank/score.ts` scores every
   finding row. A verifier's refutation therefore cannot move official true positives or official
   precision. The pre-registration (4.2) has to name claim tiers.
2. **There is a cheap per-turn channel already.** `pi.on("context")` in `extensions/pired.ts`
   rebuilds `<pired-coverage>` on every request, after the cached prefix. That is where the budget
   and the areas go.
3. **Provenance now has a dependant.** ADR-028 rejected a `by` field because nothing depended on
   it. ADR-030's fairness note needs it to tell worker-left leads apart, and 3.1 needs it too.
4. **Part of "offer to continue" may be pired's own prompt, in both arms.** `methodologyBlock` ends
   "Before finishing, briefly note what you did not get to and would investigate with more time."
   That plausibly contributes to the closings in both arms. It is not measured.
5. **No new status is needed.** `suspected` already means that nobody has challenged a finding.

## 3.1 Independent, grounded verification tier

### Provenance
- Every ledger row gets `by`, stamped by the record path on create from a host-supplied author:
  `lead`, the worker's agent name, `scribe` or `operator`.
- Caller input for `by` is deleted, the way `pass` and `verification` are today.
- Merges and updates by id keep the creator.
- `verification.by` records who judged the finding.

### The grounded contract
`verification` gains three fields:
- `path`: the hops from source to sink;
- `guards`: the checks examined;
- `tier`: `static` or `executed`, derived by pired and never taken from the caller.

The model sends `path`, `guards` and `basis` as string lists of `"file:line: verbatim text"`.
String lists are the shape the tool already handles well; nested objects are the shape models
serialise worst. They are stored as `{at, quote}`.

On write, the record tool reads each cited file through the `Fs` port. The quote must appear
within ±3 lines of the cited line after whitespace normalisation, and must meet a minimum length.
The tolerance is fixed before any v6 run and never tuned on corpus runs.

`judge()`:
- **Confirm, source-backed engagement:** `control` plus a `path` with at least a grounded source hop
  and a grounded sink hop.
- **Confirm, live target:** unchanged. Control, entitlement and wire evidence (ADR-009).
- **Refute:** `basis` plus at least one grounded quote, either the guard or the line that makes it
  not a finding. This matches the adjudication rubric's `guarded` label.
- **An ungrounded quote:** the verdict is `unresolved` and the status does not move (ADR-007). The
  reply prints the actual text at the cited line, so the model can fix it in one turn.

`tier` is `executed` when the verification is live, or cites evidence that is not a static
excerpt. Otherwise it is `static`. `executed` is the top label, not a gate.

**How this differs from what ADR-028 rejected.** ADR-028 rejected grounding the finding's own cited
line because that cost true positives. Here only the verification's quotes are checked, a failed
check only blocks promotion, and the finding's `target` is never touched.

### Who may set which status
Enforced in `core/child.ts`, by refusing with a reason rather than stripping (ADR-028):

| writer | may do |
|---|---|
| lead | Anything. Its confirm and refute are judged. A self-confirmation is kept and labelled. |
| scout | No findings (as today). |
| investigate, escalate | Create findings, which land `suspected`. `status=confirmed` or `refuted` is refused, with a reason. May not change another author's finding by id; merges are still allowed. |
| verify | `confirmed`, `refuted` or `suspected`, with grounds. A finding it creates lands `suspected`: no confirming in the same write that creates the row. |
| every worker | No `kind=settle` (3.2). |

### What the lead and the report show
- **The coverage brief** counts unverified findings by author, for example "7 unverified — 5
  recorded by workers: f3, f5, f9 …".
- **`recall findings` / `recall challenge`** show the author and the verification tier.
- **The export** shows "Recorded by", "Verified by" and "Tier" for each finding.
  - A confirmed finding is marked "independently verified" or "verified by its finder".
  - Unverified worker findings stay in the Suspected section, marked as recorded by a worker.
  - A refuted finding is printed with its quoted guard.

### Making rejected true positives measurable
- A refutation is `status=refuted` with a verification carrying `by`, `basis` and quotes. It is
  never deleted.
- The JSONL keeps every line, so "ever refuted by a verifier" can be computed even after a later
  re-confirmation.
- `eval/rescore.ts` gains a partition by status and by provenance.
- `eval/adjudication.md` is amended to include refuted rows, with their status blinded. Otherwise a
  verifier rejecting real but unlabelled issues is invisible.

### The verifier, and its cost
The verifier is the existing `pired-verify` worker: fresh context, `read` and `bash`, the tested
gate. It is not a native loop (ADR-027). The measured cost driver is extra parent turns at full
context, so:
- **One late batch.** The settle reply (3.2) lists the unverified worker findings as one batch, and
  the verify turn budget rises to about 40, which is about 5 findings per launch at ADR-028's
  measured ~8 turns per finding.
- **A 60-word handoff** of ids and verdict words. The verdicts are already on the ledger, and the
  delegation block says verified rows need no re-reading.
- **A separate `maxVerifiers` cap** in the scope, so verification does not compete with work
  launches. `hiddenParentTools` keeps `subagent` visible when it is above 0.
- **An optional other model:** `verifier.model` in the scope. Per-launch overrides are still
  refused. This is operator-only, because it sends client code to another provider.
  - In the benchmark, that provider's host must be in the sealed allowlist.
  - The adjudication judge must then come from a third model family.

### Delegation only, or the single agent too?
**The contract applies to every writer, in both modes:** provenance, grounded confirm and refute,
tiers, and the report marking. The reasons:
- It is deterministic and needs no model calls.
- The precision problem exists in both arms, at 4–10% absolute precision.
- Baseline self-confirmations were ungrounded: 17 of 18 asserted `live=true` on scopes with no
  target (ADR-028).

**The independent verifier is opt-in for the single agent** (`maxAgents: 0, maxVerifiers: N`) and
measured as its own configuration. The reasons:
- It costs parent turns, which is the measured cost driver.
- Its benefit for a single competent agent is unmeasured.

### Measurement in the v6 trial
- **Before any model call:** a synthetic decoy fixture (each sink beside a guarded twin) pins
  `groundQuotes` and `judge` on recorded verdicts.
- **Pre-registered claim tiers:** all rows (official, unchanged), presented (not refuted or
  disposed), and confirmed. True positives at every rescore level and precision (key-matched and
  adjudicated) are reported for each tier.
- **It should move:**
  - confirmed-tier precision above suspected-tier precision;
  - presented precision up against the v5 candidate;
  - rejected true positives within a pre-set share, with the literature's ~25% as the ceiling.
- **It is falsified if** any of these hold:
  - the confirmed and suspected tiers do not separate;
  - rejected true positives exceed the share;
  - median parent requests rise by more than about 2 per verify launch.
- **Reported per model:** the quote-downgrade rate and the adoption of the new fields.

### Risks
- The verifier refutes real bugs. The mitigation is that rows are retained, shown and counted.
- Quote fidelity differs by model. Some paraphrase or truncate, which gives more downgrades, so
  tiers are not comparable across models.
- A same-family verifier favours the finder.
- The stricter bar demotes most current self-confirmations to `suspected`.

### Files
- **Core** (pure, tested with fakes):
  - `ontology.ts`: `by`, the verification fields, a `QuotedLocation` type.
  - `challenge.ts`: `groundQuotes`, the `judge` bars, tier derivation, brief text,
    `isIndependent`.
  - `tools.ts`: stamping `by` on every write path, reading files for grounding, the schema, recall
    lines.
  - `child.ts`: the role rules.
  - `subagents.ts`: the missions, the verify budget, the delegation block.
  - `scope.ts`: `maxVerifiers`.
  - `export.ts`: the labels.
- **Extensions:** the authors (`lead`, `scribe`, `operator`) and the verifier-model registration.
- **Docs:**
  - FORMAT.md §4 (`by`), §6 (`maxVerifiers`, `verifier`), §8.3 (the fields and a who-writes-what
    table), §13 (additive, no version bump);
  - the skills `ops-delegation` and `ops-challenge-finding`.

## 3.2 Budget and coverage visibility

### Where the budget comes from
- **In an engagement:** optional `budget: {tokens?, minutes?}` in the scope file, per session like
  `maxAgents`.
  - Tokens are counted across parent turns, workers, the scribe and the verifier. Minutes are wall
    clock.
  - Turns are not a unit: nobody buys turns, and a turn's cost varies with context size.
  - Absent means no budget line at all, so the default is unchanged.
- **In the benchmark:** the harness writes its real ceilings into the scope. That is the run limit
  as `minutes`, and the 2.5 token ceiling as `tokens`, enforced in both arms. **A ceiling the
  harness does not enforce is never stated.**

### What is shown, where, and how often
- **One line in the tail block on every request,** never in the system prompt, where it would
  break the cache. For example: "Budget: 6.1M of 20M tokens · 52 of 240 min — a ceiling, not a
  target." It costs roughly 40 uncached tokens.
  - At 80% it says to record what is established. At the ceiling it says to settle.
- **`recall status`** repeats it, with the last settle.
- **A static, cached sentence in `methodologyBlock`** says the state persists: the ledger is the
  next session's start, and there is no need to stop and ask leave to continue the work given. It
  replaces "note what you did not get to" with the settle action.
- There is no "unattended" statement (plan 3.2), and ADR-012's ambiguity rule stays.

### Coverage as areas
- **What already exists:** inventory elements with a `file`; the class × element matrix with cell
  statuses; `coverageBrief`; `recall gaps`; the passes `file` lens; the unchallenged queue.
- **The minimal change** is a derived "areas" view, in a new pure `core/areas.ts`:
  - surface is grouped by the directory of `file`, or by host;
  - the grouping is deterministic, with a cap of about 20 areas, fixed on synthetic trees, not on
    corpus layouts;
  - each area's status comes from its cells: untested, in progress, settled or blocked, plus a
    finding count;
  - source directories with no recorded surface are listed as unmapped, from a cached,
    directory-only listing.
- **Where it shows:** the tail block (bounded, "+N more"), the settle reply (in full) and
  `recall status`.
- **Nothing is stored.** It informs and ranks nothing.

### Explicit finish
- **The record:** `record kind=settle outcome=finished|paused|blocked note="…"`, written to a new
  additive store, `sessions.jsonl`.
- **The remainder:** the harness computes it itself — open cells, unmapped areas, unverified
  findings by author, inconclusive hypotheses, open blockers and budget used. It ignores any
  remainder the caller sends.
- **It never refuses.** The reply lists what remains, and says that settling does not end the
  session.
- **Workers are refused `kind=settle`.**
- **The stop classifier (ADR-030)** reads it:
  - the order becomes error, budget, turn cap, **settle**, then the text test;
  - `finished` maps to finished;
  - `paused` or `blocked` with budget left maps to offered to continue, with the settle recorded
    as evidence;
  - a settle followed by more writes is superseded;
  - the text test is always kept as evidence, and it is the only fallback. The baseline has no
    settle.

### Measurement
- **Isolation:** a single-agent pair, candidate-solo against the baseline, or candidate-solo with
  and without 3.2.
- **It should move:**
  - Luna's offered-to-continue rate, read by the text test, the same instrument in both arms;
  - true positives stay non-inferior;
  - cost, as the median per-pair log ratio. The direction is two-sided, because fewer early stops
    can mean longer runs.
- **It is falsified if** any of these hold:
  - the offered-to-continue rate does not fall by the pre-registered margin;
  - cost rises with true positives flat;
  - used/ceiling clusters near 1.0, meaning the budget is read as a target;
  - GLM or DeepSeek, which never stop early, start hitting time limits more often.

### Risks
- The budget is read as a target.
- The prompt changes move together: the persistence sentence, the settle wording and the removed
  sentence. The ADR must list every text change.
- Different models adopt settle differently. Some may settle as a ritual; "the last settle not
  followed by work" handles that.
- Area grouping quality depends on repository layout.
- In the benchmark, the harness's token count is the authority.

### Files
- **Core** (pure):
  - new `budget.ts`: `parseBudget`, `budgetState`, `renderBudgetLine`;
  - new `areas.ts`;
  - `ontology.ts`: the settle record, the sessions store, `EngagementScope.budget`;
  - `tools.ts`: the settle branch, `recall status`;
  - `prompts.ts`: the persistence sentence and the settle wording;
  - `child.ts`: refuse settle.
- **Extensions:** token accounting, the cached directory listing, the budget and areas lines in the
  context handler.
- **Eval:**
  - the scope budget in `delegation-compare.ts`;
  - settle in the stop classifier and in telemetry.
- **FORMAT.md:** §5 stores, §6 budget, a new §8.6 sessions, §12 areas, §13 log.

## Build order

3.1 and 3.2 share `ontology.ts`, `tools.ts`, `child.ts`, `extensions/pired.ts`, FORMAT.md and the
eval telemetry, so the order is:

1. **Groundwork:** one shared-types commit — `by`, the verification fields, the settle type,
   `budget`, `maxVerifiers`, the `author` and `budget` hooks in `ToolDeps`, and FORMAT.md. `by` is
   itself an instrument (ADR-030).
2. **Instruments:** the rescore status and provenance partition, and the adjudication amendment
   (3.1). Settle plus the classifier read (3.2).
3. **In parallel:**
   - **Track A (3.1):** the grounded judge, the role rules, the missions, the export; then
     `maxVerifiers` and the verifier model.
   - **Track B (3.2):** `budget.ts`, `areas.ts`, the context line, the prompt text.
4. **Pre-register** the arms that isolate each change (4.2), then run on Luna.
