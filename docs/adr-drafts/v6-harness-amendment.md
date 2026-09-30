# ADR draft (v6) — A stopped official grid resumes under a changed harness only through an audited amendment

**Status:** draft · 2026-09-30 · built on branch `p3/luna-harness-amend` from `p3/candidate-v5`
(5dc1069, the harness `v6-stage1-luna` was launched on) · amends ADR-031's resume rule and the
classifier's infrastructure list (ADR-026, fifth amendment; ADR-031) · to be numbered when merged

### Context

- **An official grid stopped on a provider check.** `v6-stage1-luna` (GPT-6 Luna, provider
  `openai-codex`, grid kind `v6-stage1`, 4 passes, `--breaker`, `--auth-horizon-hours 24`) stopped
  at 119/192 on 2026-09-30. Its candidate run of `CVE-2026-64619#3`, attempt 1, cell
  `1bc99d70d57647e7`, ended about 1.7 h in when assistant reply #319 came back with
  `stopReason: "error"` and `errorMessage: "native turn auth context mismatch: scopes"`. pi did
  not retry it.
- **The text is the provider's.** It appears nowhere in `node_modules`, so pi did not write it.
  The operator's `~/.pi/agent/auth.json` had not changed since 2026-09-25, and its token was valid
  to 2026-10-05. It happened in 1 of the grid's 132 launched runs (137 rows in `runs.jsonl`, 5 of
  them partners that were never launched). A credential the run had spoiled would have failed the
  runs after it too.
- **The figures here are provisional.** They were counted from a copy taken at 20:44 UTC. The
  stopped runner (pid 9165) was not finished: it was still draining two scored arms, the
  `CVE-2026-53553#3` candidate at attempt 2 and the patched twin
  `OpenBMB_XAgent-f73set-patched#3` candidate. Every count below is to be re-measured after it
  exits.
- **The harness classed it as the run's own failure.** The row reads `valid: false`,
  `infraFailure: false`, `infraReason: null`, `process.exitCode: 0`, `timedOut: false`,
  `providerFailures.parent: ["native turn auth context mismatch: scopes"]`. `classifyInfra` knew
  no such class, so the breaker tripped, as it is designed to for a non-infrastructure invalid run
  of an official grid, and the partner baseline was recorded not launched, also non-infrastructure.
- **It is the class fixed once before.** v5b's "Unable to verify Daybreak Blue access. Please try
  again." was an entitlement check on OpenAI's side that blocked a pair the same way (ADR-026,
  fifth amendment). That fix could be made before a fresh grid, v5c. This one stops a grid 62%
  through, whose pilot has already fixed its pass count.
- **The frozen harness cannot take the fix.**
  - Every resume refuses unless every pin is byte-identical to the original manifest, and
    `harnessSha256` covers `eval/delegation-compare.ts` itself. Any code change refuses a plain
    resume.
  - `planResume` judges each pair from the `infraFailure` flag stored when the run ended. A fixed
    classifier alone never reaches a run that is already recorded.
  - `amendments.jsonl` holds pass-count amendments only. `parseAmendments` refuses any other row,
    and `eval/v6-decision.ts` and stage 2's `--passes-from` read it.
- **Measured on a copy of the grid's state** (manifest, runs, resumes, amendments, summary; no
  preflight, pure planning functions only): a plain resume plans 36 pairs to re-run, 59 kept and 1
  blocked (`CVE-2026-64619#3`), and refuses. The grid holds 2 invalid non-infrastructure rows, both
  for that pair: the candidate and its unlaunched partner.

### Decision

- **The auth-context check is infrastructure.** `classifyInfra` matches `/\bauth context mismatch\b/i`
  in provider-originated text as `provider auth-context check`, with the text as evidence. It runs
  after the quota patterns, beside the try-again class, so a spent plan whose message also names
  the mismatch still stops the grid. A timed-out run is still never infrastructure.
- **A resume may run under a changed harness only with `--amend-harness <reason>`.**
  - It is allowed with `--resume` only, may be combined with `--extend-passes`, and needs a
    non-empty reason.
  - Its pins may differ from the grid's record in the hashes of two files only, the allow-list
    `AMENDABLE_HARNESS_FILES`: `eval/delegation-compare.ts`, the runner, which classifies runs and
    keeps the grid's books, and `eval/delegation-compare-grid.ts`, which reads the amendments.
  - Every other pinned file still refuses, with the flag or without, because each changes what a
    run measures or what the grid is:
    - the entry script runs inside every cell;
    - `eval/delegation-compare.pins.json` names the snapshots, corpora and kinds;
    - `fs-seal.c` is the seal;
    - the lib holds the acceptance rule, the usage accounting and the schedule;
    - stage, proc and bash-timeout decide what a cell stages, reaps and waits for;
    - stop, matched, the delegation audit and the settle telemetry write the numbers the summary
      reports.

    A recorded amendment that names a file outside the allow-list refuses every later resume.
  - Every other pin must still be byte-identical: runtime tree and node, grader blob, snapshots,
    corpus and truth, pi-subagents tree, fs-seal binary, prompt, provider, model, thinking, model
    runtime, schedule, passes. Adding a file to the pinned set, or removing one, is refused.
  - **The fields that decide a result are compared on every resume**, with the flag or without:
    `official`, `exploratoryReasons` and `runtimeConfiguration`. They were measured equal across
    `v6-stage1-luna`'s manifest and its resume-1..3, and across `v6-stage1-glm`'s, so no plain
    resume of those changes. The runner and the grid module also shape a cell (its scope and
    settings); comparing these fields keeps an amendment from moving the grid's decision or the
    cells' configuration.
  - One exploratory reason, the one naming a kindless corpus's pass count (`--passes 6 is not 3`),
    changes when an exploratory grid's passes are extended. An extended grid is compared without
    it; every other reason must match.
  - It is refused as a no-op when no harness file differs from the record.
  - The comparison is one pure function, `resumePinCheck`.
- **The amending resume re-judges stored runs before it decides what to block.**
  - At each pair's highest attempt, a launched run stored invalid and non-infrastructure is
    re-judged by the current `classifyInfra` from its stored `providerFailures` (`rejudgeStoredRun`).
    This happens only when the row has provider text and `process.timedOut` is not true.
  - A partner that was not launched because of that run follows it, as `notLaunchedOutcome`
    records one: infrastructure exactly when its arm's failure is. Without this, the partner's
    stored `infraFailure: false` would keep the pair blocked.
  - A pair judged infrastructure is re-run at attempt + 1, both arms, like any infrastructure
    failure. The blocked-pair refusal runs after this (`resumeGateRefusal`). A pair still
    non-infrastructure after re-judging refuses the resume exactly as before.
  - The re-judgement is narrower than the live one. Under the v6 validity policy the live
    classifier reads a run that reached the limit; a stored run whose process timed out is never
    re-judged.
  - No row of `runs.jsonl` is rewritten. The file stays append-only.
- **One function accepts a resume, in a fixed order**, and a test records that order:
  `acceptResume`, with the runner's effects passed in.
  1. It plans with the reclassifier.
  2. It applies the gate's refusal.
  3. It builds the harness row. An amendment that re-judges no run on a grid with no pair left to
     run is refused, so a complete grid such as `v6-stage1-glm` is never amended by mistake.
  4. It writes the resume's manifest, with every harness amendment, this one included, only now
     that the resume is accepted.
  5. It appends `resumes.jsonl`, then `amendments.jsonl`, then `harness-amendments.jsonl`.

  A refused resume appends nothing. The review of 222108e found three mutants the earlier tests
  missed: planning without the reclassifier, appending the row before the gate, and never
  appending it. Each now fails the tests.
- **The amendment is recorded, and only when its resume is accepted.**
  - It is one row, appended to a new file `<grid>/harness-amendments.jsonl`, never
    `amendments.jsonl`.
  - The same row is mirrored as `harnessAmendment` in that resume's `resumes.jsonl` entry and
    listed in `resume-<n>/manifest.json`.
  - The row carries:
    - `kind: "harness"`, `at`, `by` (user@host), `reason` and `resume`;
    - `commit`, the `git rev-parse HEAD` of the worktree the resume ran from. It is also written
      into `resume-<n>/manifest.json`'s `resumedFrom` from the start, so a refused amendment names
      its commit too;
    - `files`, the changed paths only, each `{from, to}`;
    - `reclassified`, each re-judged run's key, arm, attempt, cell, reason and evidence;
    - `runsCompleted`, and `runsSha256` and `summarySha256`, computed as for a pass amendment.
  - `summary.json` at that moment is copied to `resume-<n>/summary-before-amendment.json`. It
    holds the stop the amendment answers: the breaker's trip and the decision codes. The resumed
    runner overwrites `summary.json`, so without the copy only its hash would survive.
  - Parsing is strict. A malformed row refuses the resume, and so does a row in one file that is
    missing from the other or differs from it.
- **Later resumes are held to the amended record.**
  - A resume compares the harness against the original pins overlaid, in order, by every recorded
    harness amendment (`amendedHarness`). An amendment whose `from` is not the hash the record
    holds at that point refuses.
  - The supervisor's plain `--resume` after the amendment therefore passes. Any further unrecorded
    edit refuses.
  - A plain resume of an amended grid applies the recorded verdicts to the same stored runs
    (matched by key, arm, attempt and cell). It re-judges nothing else. Without this, an amending
    resume interrupted before the pair launched would leave the next plain resume to find the
    stored row, block the pair and refuse. A second amendment would then be refused as a no-op,
    and the grid could never go on.
  - The record is checked before it is trusted. `runs.jsonl` must still begin with the
    `runsCompleted` rows each amendment hashed. Each launched run it re-judged must still be
    invalid, non-infrastructure, not timed out and carrying provider text, and each partner must
    still be not launched. Otherwise the resume refuses, so an edited row cannot inherit a
    verdict.
  - A grid with no harness amendment plans exactly as it always did.
- **The runner checks each launch against the harness it was accepted under.** Its per-launch
  integrity checks (the entry script's hash, the fs-seal binary, the snapshots, pi-subagents) read
  the pins its own preflight measured. An edit after that preflight still invalidates the run.
- **The summary is decided by the runner that finishes.** Its reason codes (`interrupted`,
  `stopped`, `blocked`, `invalid`, …) are that runner's own, or come from each pair's highest
  attempt. The earlier runner's breaker stop leaves no code, and once the pair's attempt 2 is valid
  the pair counts. `eval/rescore.ts`'s `currentRuns` reads the highest attempt, and a fixture grid
  in this state reads as ready in `eval/v6-decision.ts`.
- **The history is kept.**
  - `summary.json` lists `harnessAmendments`.
  - The breaker's `launchedInfraFailures` counts a re-judged run under its new reason. Its row in
    `runs.jsonl` keeps the flag it was written with.
  - `resumes.jsonl` holds the accepted resumes, as before. A refused resume leaves its record only
    in its own `resume-<n>/manifest.json` and `status.json`.
  - An edit to either amendment file, or to `resumes.jsonl`, during the grid gives
    `amendment-mismatch`, which `eval/v6-decision.ts` reads as not ready.
- **Measured on the same copy:** the amending resume's plan is 37 to re-run, 59 kept and 0
  blocked. The one pair that changes is `CVE-2026-64619#3` (blocked → re-run at attempt 2), with 2
  runs reclassified: the candidate and its partner. The pin check names two changed files,
  `eval/delegation-compare.ts` and `eval/delegation-compare-grid.ts`.

### What is still refused

- A plain `--resume` across any unrecorded harness edit, as before.
- An amending resume in which anything but the allow-listed files' hashes differs:
  - any other harness file, including the entry script, the pins file, `fs-seal.c`, the
    delegation audit, the lib, stage, proc, stop, matched, bash-timeout and the settle telemetry;
  - the runtime, grader, snapshots, corpus, truth, pi-subagents, fs-seal, prompt, provider,
    model, thinking, model runtime, schedule, passes and the set of pinned files;
  - `official`, `exploratoryReasons` or `runtimeConfiguration`.
- An amendment that changes nothing.
- An amendment that re-judges no run on a grid with no pair left to run.
- A resume whose recorded amendment no longer checks out against `runs.jsonl`.
- An amendment without a reason.
- Re-judging a timed-out run, a run with no provider text, a valid run, or a run below its pair's
  highest attempt.
- A pair whose run is still the run's own failure after re-judging. On an official grid it refuses
  the resume, as before.
- An amendment record that is malformed, does not chain from the original pins, or disagrees
  between `harness-amendments.jsonl` and `resumes.jsonl`.

### Rejected

- **Editing `runs.jsonl`.** Setting `infraFailure: true` on the stored row would unblock the pair
  with no code change. It would also make the record say something the harness never measured,
  leave no trace of who changed it or why, and break `runsSha256` in the pass amendment already
  on record.
- **Restarting the grid.** The v5c remedy. It discards the grid's 132 launched runs: 241.9
  run-hours, and 4.47 billion tokens in the 123 valid ones (summed from `runs.jsonl`). It also
  discards a pilot whose pass count the pre-registered rule has already fixed from those runs,
  and re-draws every pair already measured.
- **A classifier pattern with no audited resume.** It changes a harness pin, so every resume would
  refuse. Relaxing the pin check to let it through would let any harness edit through unrecorded.
  The fix would also not reach the stored run, because `planResume` reads the stored flag.
- **Reusing `amendments.jsonl`.** `parseAmendments` refuses any row that is not a pass count.
  `eval/v6-decision.ts` requires exactly one amendment there to call stage 1's pass count fixed,
  and stage 2's `--passes-from` adopts it. A harness row there would stop both, or be read as a
  second pass amendment.

### Costs

- **The grid is measured under two classifier versions.** Its 132 runs launched before the
  amendment were classified under the old rule, and every run after under the new. The rules
  differ only in one provider message that no other row carries, and the amendment lists every
  run it re-judged.
- **A pair is re-drawn.** `CVE-2026-64619#3` is re-run at attempt 2. Its attempt-1 candidate
  stays in `runs.jsonl`, and the pair's re-run may score differently. This is the same selection
  any infrastructure re-run makes.
- **The operator's reason is free text.** The harness checks that it is present, not that it is
  right. What makes it auditable is the record: the files, the runs, who, when, and the hashes of
  what the grid held.
- **A new file is part of a grid's record.** `harness-amendments.jsonl` must be kept with the
  grid. A grid copied without it refuses to resume if its `resumes.jsonl` records an amendment.
- **Resumes must run from the grid's own worktree.** The pins record absolute paths
  (`piNodeModules`, the pi-subagents install), so the amending resume runs in `/home/mamgad/pired-p3`
  with this branch checked out there, as every earlier resume of this grid did.
- **The allow-list narrows the escape hatch but does not close it.** The runner and the grid module
  also build each cell's scope and settings. The compared fields keep an amendment from moving the
  grid's decision or its recorded runtime configuration; beyond those, what guards the change is
  the review of its diff, which the recorded commit and hashes make possible.
- **A gap this does not close.** The runner imports `eval/delegation-compare-validity.ts` (the
  validity policy) and `eval/corpus/lib.ts` (the scope clause and leak stripping), and neither is
  in `HARNESS_FILES`. An edit to either passes a plain resume unnoticed today, amendment or not.
  Adding them would change every running grid's pins and refuse its resume, so it is left for the
  next grid rather than done here.
