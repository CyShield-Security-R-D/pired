# Delegation acceptance experiment

The delegation change (ADR-027: pired's four workers through pi-subagents) is taken only if it finds
vulnerabilities about as well as the baseline with fewer total tokens. In the operator's words:
"similar quality with less tokens." ADR-027 records the design; this comparison decides whether the
change is kept, and it has not run. This page is the protocol, and its rule was fixed before any
scored model call. The no-model checks (`extensions/child.test.ts` and the runner's sealed
delegation probe) establish behaviour only and cannot approve the change. The synthetic assay in
`eval/delegation.md` measured the deleted native worker and says nothing about this candidate.

ADR-026 fixed this rule for the earlier native-worker candidate (ADR-025). ADR-027 keeps the rule
byte-for-byte and swaps in the pi-subagents candidate, so both arms now run on the same pinned pi
runtime.

## Protocol

- **Baseline:** pired commit `496b1900c2fae2d63ba8378b3c3f56a4b49f317c`, run **without** pi-subagents,
  so the baseline arm has no delegation available at all. The runner compares every staged file
  against that commit with `git show`, so a drifted baseline is exploratory.
- **Candidate:** a frozen snapshot of the current working tree **plus pinned `pi-subagents@0.71.0`**,
  which registers the four pired agents. **No candidate is frozen yet.**
  `eval/delegation-compare.pins.json` has `candidateDigest: null`, and until it holds the frozen
  snapshot's digest every grid is exploratory and cannot approve. The freeze happens before any
  scored run, by the steps under [Running](#running). The native-worker snapshot under
  `eval/artifacts/claude-handoff-2026-09-23/snapshots/candidate` and its `675bd2ef…` digest belong
  to ADR-025. They are not this candidate: that snapshot still exposes `pired_delegate`, and the
  candidate probe refuses it.
- **pi-subagents:** pinned by tree digest in the same file (`piSubagents`: `0.71.0` at
  `eval/artifacts/pi-subagents-0.71.0`). The package is half of the change under test, so a
  different tree is a pin mismatch.
- **Pi runtime:** both arms run on the same pinned `pi 0.87.1`, with `cacheWarming` off so a warmed
  cache cannot flatter one arm's token total. Only the candidate arm loads pi-subagents; the runtime
  is otherwise identical.
- **Models:** `openai-codex/gpt-6-luna` and `zai/glm-5.3-flash`, both at `medium` in both versions.
  Children inherit the parent's model and effort, and the runner invalidates a run in which they did
  not. Earlier research used GPT-5.6 Luna, and its results are not a baseline for GPT-6 Luna.
- **Inputs:** the five research applications and their 24 labelled locations, from
  [pired-research](https://github.com/mamgad/pired-research). The manifest and every truth file are
  pinned by hash. Each run gets a fresh private copy.
- **Fixed passes:** three complete passes per model and version, 60 target sessions in all. There
  are no extra repetitions after seeing results.
- **Identical conditions in both versions:**
  - the production-review prompt (byte-identical to `eval/corpus/run.ts`) and whole-application scope
  - the pinned Pi runtime and pinned grader
  - two-hour ceiling per session
  - five matched pairs in flight, pass-major, with arm order counterbalanced

  Delegation is the model's choice; the prompt never forces it.
- **Pi setup, shared by both versions** (`delegation-compare-entry.ts`):
  - Pi's SDK in JSON print mode. The baseline loads only pired; the candidate loads pired and pinned
    `pi-subagents@0.71.0`, and nothing else differs.
  - Global packages, skills discovery, context files and the scribe are off. Ambient extensions are
    off, so the candidate's pi-subagents is the pinned copy the entry loads, not a globally installed
    one.
  - Automatic compaction is on, and its usage is counted.
  - Provider retries are off, so failures stay visible.
  - The entry passes no `tools` option at the parent level. `tools` is an allowlist that also filters
    extension tools; the first preflight passed four built-ins, and pired's `record`/`recall` never
    reached the model. A child's `tools` allowlist is separate and must name `record`, or pi-subagents
    fails the child at start (the fail-closed tripwire in ADR-027).

## Acceptance gate (ADR-026)

A model's grid approves the candidate only when the grid is the complete official one (five targets,
three passes, every pin matched, every run valid) and all of these hold:

1. **True positives:** candidate pass-mean pooled true positives are at least 85% of the baseline's.
2. **Precision:** candidate grid-pooled precision (ΣTP/Σclaims) is at least 85% of the baseline's.
3. **Per-target guard:** on no target is the candidate's true-positive range wholly below the
   baseline's.
4. **Tokens:** candidate mean total tokens are lower.

**The delegation change (ADR-027) is taken only if both models approve.** A rejection means the
change is not taken as it stands. It does not say which part to change. Decision labels name the
part that failed: `quality_below_margin`, `no_token_reduction` or both.

Resampling the research's own per-target runs gives these chances of approval, both models together:

| Candidate's true positives | This gate | Old every-target rule |
|---|---:|---:|
| Identical to baseline | ~62% | 0.7% |
| 15% fewer | ~15% | — |
| 25% fewer | ~3% | — |

Bootstrapping three historical runs per target understates variance, so the real rates are somewhat
worse. A rejection does not show that the candidate is worse, and an approval does not show that it
is better. The simulator and its data are in
`eval/artifacts/claude-handoff-2026-09-23/gate-sim/`.

Other reading rules:
- **Unmatched claims:** the grader matches patch-localized locations, so an unmatched claim is not
  automatically a false positive.
- **Hits:** a location hit does not prove exploitability.
- **Activity:** more records, hypotheses or worker calls are not quality.
- **Findings:** read the retained findings before believing either outcome.

### Second approval path (amendment, 2026-09-24, before any candidate run was graded)

"It's ok to spend more if we are going to find more." A model's grid also approves the candidate
when its pass-mean pooled true positives reach at least 115% of the baseline's (and exceed it),
its grid-pooled precision stays at least 85% of the baseline's, and no target falls wholly below
its baseline range — whatever the tokens, which are reported. Both models must approve, each by
either path. See ADR-026's amendment for the error rates and why it is applied after the grids.

### Held-out guard (amendment, 2026-09-24, before any held-out run)

The candidate after v3 is tuned on defects found in the five research applications' runs, so it is
also checked on four corpus applications no diagnosis read. They are listed in
`eval/heldout/manifest-2026-09-24.json` (sha256 `29d31fd9aa185678d1052010621ea0fe3723e270cd19bd89dc607d8b44ed3705`):

| target | application | answer key sha256 |
|---|---|---|
| CVE-2022-1850 | filegator_filegator-l9zjk4 | `3639aa8c959a16acb028ddcd78a8dff6f3c439358225379cb6021901c2a46bda` |
| CVE-2023-37469 | IceWhaleTech_CasaOS-7bevo7 | `bcc6bbf9528191dc97feabd9417f23aecbd0059baa2a297e8454cd5ae10d0202` |
| CVE-2022-1553 | publify_publify-c7hz4c | `28050d621b79edcbd46132797e5e6a08c4da9ce526473b0424b1997e800cea5b` |
| CVE-2025-67502 | remram44_taguette-3awrde | `1bf97202260fa60c73636a6d8b384feffe6e521efd9bbbeba2fcdeefd1998b56` |

Run it with the same harness, baseline, models and effort as the official grid, three passes, and
`--manifest eval/heldout/manifest-2026-09-24.json --corpus /home/mamgad/corpus/targets --truth
/home/mamgad/corpus/targets --only <the four ids>`. It is exploratory, so it can only veto.

On each model it vetoes when either of these holds:
- the candidate's pass-mean pooled true positives fall below 85% of the baseline's;
- its grid-pooled precision falls below 85% of the baseline's.

Tokens are reported, not gated. See ADR-026's second amendment.

**Runs that hit the time limit.** Amended 2026-09-24 at about 04:20Z, while the held-out grid was
running and before its remaining results.

The rule above did not say what happens to a held-out run that hits the harness's per-run limit
(2 h). The harness classes such a run as non-infrastructure and never re-runs it. The first one was
luna's CasaOS pass 1 candidate: it was still working at the limit, with 396 requests made and 25% of
its test cases settled.

The rule applies to both arms alike. A held-out run that hits the limit delivers its ledger as it
stood at the limit: its findings are scored by the same pinned scorer, and its tokens up to the
limit are counted.

The official grid is unchanged. There, a run that hits the limit leaves its pair incomplete, and the
grid cannot approve.

### The luna official re-run (amendment, 2026-09-24, before it runs)

The v5 official luna grid could not be decided: an unchanged baseline run passed the 2-hour limit on
a slow provider night, and a blocked pair keeps an official grid from approving. The re-run keeps the
same gate, candidate (v4, `826bd8d0…`), baseline, targets and passes. It changes two things in both
arms:
- the per-run limit is 4 hours (`--timeout 14400000`);
- a `bash` call that names no timeout gets 900 s (`eval/delegation-compare-bash-timeout.ts`).

The v5 official luna pairs are indicative only. See ADR-026's third amendment.

### DeepSeek V4.1 Flash (amendment, 2026-09-24, before it runs)

DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash` on commandcode.ai) runs the official grid and
the held-out grid in the environment of the luna re-run: same candidate, baseline, gate and guard, 4 h
per run, and the 900 s `bash` default. Its verdicts are reported but do not gate: acceptance still
needs GPT-6 Luna and GLM-5.3 Flash. See ADR-026's fourth amendment.

### The luna v5c re-run (amendment, 2026-09-24, before it runs)

The v5b luna grid was blocked by a provider access check ("Unable to verify … access. Please try
again.") that pi's retry list does not match. v5c is a fresh official luna grid in the v5b
environment with one classifier change: a provider message that asks the client to try again is
infrastructure. The v5b luna pairs are indicative only. See ADR-026's fifth amendment.

## Measurement

The efficiency measure is Pi's provider-reported `totalTokens`, summed over parent responses,
compaction summaries and every child response. That total already includes cache reads, and reasoning
is a split of output, so neither is added again. The runner keeps component counts, parent and
child subtotals, and Pi's cost estimate for inspection.

Child usage is accounted from pi-subagents' own records, not re-estimated: per-response usage in each
child's `session.jsonl` (keyed by `responseId`), reconciled against the per-child summary in the
`subagent` tool result's `details.results[]` (usage, exit status, `runId`). Every child session a
call produced is summed. In practice each launch is one child: pi-subagents 0.71 removed the
top-level `tasks[]`/`chain[]` shapes, and pired's gate refuses workflow scripts.

A run is invalid, never a cheap success, if any of these happens:
- **Usage:**
  - a response's usage is missing or zero
  - a total differs from input + output + cache read + cache write
  - a child request has no response
  - a `subagent` call does not reconcile with its child session records
- **Process:** a compaction fails, a provider errors, or a retry occurs; the process times out,
  exits non-zero, or emits malformed output.
- **Scoring:** the grader fails to write a readable report.

How a child ended decides whether its run can be scored. The runner reads two sources. One is the
child's session, written inside the seal. The other is pi-subagents' row for it in the parent's
transcript, which the sealed process cannot rewrite:
- **`completed`:** the child handed back. Accepted.
- **`incomplete`:** a bound the design puts on a worker stopped it, and every request it sent is
  answered in its session. The bound is pired's turn budget or pi-subagents' worker timeout. Both
  sources must show the bound fired. For the turn budget, the session ends on pired's stop and
  the row carries pired's stop text. For the timeout, the session ends between requests and the
  row says `timedOut`. The bound is part of the candidate under test, so the child's tokens count
  and the run stays valid. Rejecting these would let one looping worker end the whole grid.
- **`failed`:** the child ended on its own terms, with every request answered. That covers an
  empty final answer or a last tool error. Accepted, because rejecting it would keep only the runs
  whose workers went well.
- **Unaccounted:** paused, detached, stopped from outside, or cut off mid-request, including a
  timeout that fired during a request. Also a child whose session and row disagree about how it
  ended. Its remaining spend is not known, so the run is invalid.

## Isolation

A candidate child is an in-process foreground pi session. It runs inside the cell's already-sealed
process and inherits the same Landlock and seccomp boundary, so there is no separate sandbox to
maintain for delegation. pired's scope gate applies to the child's tool calls exactly as it does to
the parent's.

Each cell runs under `eval/corpus/fs-seal.c` with these protections:
- **Landlock:** filesystem reads and writes are limited to the cell's own target copy, workspace,
  staged snapshot, config and agent directory, plus the runtime. Both arms get the same writable
  set: `<cell>/target`, `<cell>/workspace`, `<cell>/agent`, `<cell>/tmp` and `<cell>/child-sessions`.
  The last two are siblings of the agent directory, not inside it. `<cell>/child-sessions` is
  pi-subagents' `defaultSessionDir`, where every worker writes its `session.jsonl`. Run status and
  artifacts go to `PI_SUBAGENTS_TEMP_ROOT=<cell>/tmp/psa`, because the cell's pi-subagents config
  sets `artifactDir: "temp"`. `<cell>/tmp` is also every arm's `TMPDIR`. The baseline never writes
  `<cell>/child-sessions`, but it is granted to both arms so the seal is the same. The shared auth
  file and its refresh lock are the documented exception.
- **Candidate-only reads:** the candidate arm alone may read the pinned pi-subagents install and
  every `package.json` above the entry script. pi-subagents walks those manifests to identify the
  host pi. In the first sealed dry run one of them was unreadable, and it fell back to registering
  the full `subagent` schema on every request.
- **seccomp:** `socket(AF_UNIX)` is blocked. Before this, a sealed shell could ask `systemd --user`
  or `dockerd` to read an answer key its own `open` was denied. `io_uring_setup/enter/register` are
  also denied, since io_uring opens and connects a socket inside a kernel worker that the `socket()`
  rule never sees. x32 syscall numbers and foreign architectures are killed.
- **Environment:** broker socket variables are dropped.
- **Opaque names:** cell, engagement and snapshot directory names are random, because pired puts the
  absolute workspace and skills paths in its system prompt.
- **Snapshot redaction:** each cell's pired snapshot has corpus-specific comment blocks redacted.
  One comment named CVE-2025-52903's mechanism, another a truth location. Line counts are kept, and
  the transpiled code is checked unchanged.
- **Symlinks:** external symlinks in the target copy are rewritten in-tree. note-mark's pointed at
  the corpus clone path.
- **Reaping:** each cell runs in its own transient `systemd --user` scope, killed as a cgroup when
  the arm closes, so a server one arm started cannot serve the next. A second pass reaps any
  process still carrying the cell's environment marker. The cgroup catches strays that did
  `unset` the marker; the marker catches strays if the scope somehow fails.

The preflight proves these on the real per-cell command before anything is spent:
- answer-key denial for every target
- escape-vector refusal
- DNS and TLS to the provider
- sealed no-model probes of every target and arm, including the active tool set of each arm. The
  baseline arm must expose pired's tools and no delegation tool at all. The candidate arm must add
  only `subagents_enable`, and hide `bg_wait`, `subagent_supervisor` and the deleted
  `pired_delegate`
- one sealed delegation probe per grid, on the candidate arm, driven by a scripted faux model. The
  parent launches `pired-scout` through pi-subagents under a loopback-only enforced scope. The
  worker must record a surface element into the parent's ledger and have an out-of-scope `bash`
  call blocked by pired's gate. It must also leave a child session under `<cell>/child-sessions`
  that the accounting reconciles with the parent's `subagent` result. This is the only check that
  runs the real child extension under the seal
- the resolved runtime: api, endpoint, context window and output cap. It is pinned, and every scored
  run must match it, because a changed `models.json` entry would move the compaction threshold.

Remaining limits:
- a TCP service on localhost
- signals, which Landlock ABI 4 does not scope
- the HTTP proxy blackhole, which steers traffic and is not a network sandbox
- pretraining contamination

## Delegation audit

For every candidate run, `eval/delegation-audit.ts` reads the parent transcript, the child sessions
under `<cell>/child-sessions` and the ledger. Its report is saved in `run.json` and aggregated in
`summary.json`. It separates **violations**, which break the delegation contract, from **notes**,
which are worth reading and break nothing.

Violations:
- **Foreign agent:** a launched child that is not one of `pired-scout`, `pired-investigate`,
  `pired-verify` or `pired-escalate`. The gate should already have refused it.
- **Background run:** a launch with `async`. pired's workers run in the foreground.
- **Two at once:** two `subagent` calls whose runs overlap in the parent's transcript. pi runs one
  reply's tool calls in parallel, so this is what a second launch in the same reply looks like.
- **Over budget:** more workers in the run than the session budget (the scope default, 8).
- **Past the turn budget:** a worker tool call that ran after the role's turn budget, which pired's
  child gate refuses. Or a worker that took more turns than the budget, the grace turns and its
  handoff, the point at which pired stops it.
- **No durable record:** a child that finished without writing anything to the shared ledger.
- **Neither completed nor bounded:** a child that ended `failed`, or whose spend is unaccounted.
  The accounting still scores a run whose `failed` child accounts for every call. The audit
  flags it because the worker broke the handoff contract.

Notes:
- **Never delegated:** the run has no child at all. It is still valid, because delegation is the
  model's choice.
- **Delegated too early:** the parent delegated before recording anything it knew.
- **Refused launches:** a launch the gate refused, including one for a non-pired agent.
- **Bounded stop:** a child that ended `incomplete`, stopped by pired's turn budget or by
  pi-subagents' worker timeout. That is the design working: its records stand and its spend is
  counted.
- **Refused past the budget:** a worker whose calls were refused past its turn budget before it
  handed back.
- **Late first record:** a child's first record came after turn 8.
- **Long handoff:** a handoff of more than 200 words.
- **Unresolved paths (heuristic):** the task names source paths that do not exist in the target.
- **Unused records (heuristic):** no later parent call or reply names the children's record IDs.
- **Prompt growth:** the parent's prompt grew more than 6,000 tokens across the call. It should
  grow by the handoff, not by the child's work.

The limits the audit checks against are read from the product modules that set them. They are each
role's `maxTurns` (`core/subagents.ts`), the grace turns (`core/child.ts`) and the default
session budget (`core/scope.ts`). The per-task ledger IDs and source paths are recorded for
reading. They are never scored.

The audit never changes validity. But the summary states how many candidate runs delegated, and how
many workers ended in each status and outcome, so a grid in which the model rarely used a child is
not read as a verdict on them.

## Running

**Freeze the candidate first.** Do this once, before any scored run, and never edit the snapshot
afterwards:

```sh
C=eval/artifacts/candidate-$(date +%Y-%m-%d)      # new directory; eval/artifacts is not in git
mkdir "$C"
cp -R bin core extensions checklists skills themes package.json package-lock.json tsconfig.json "$C"/
node --experimental-strip-types -e '
  const { treeManifest } = await import("./eval/delegation-compare-stage.ts");
  console.log((await treeManifest(process.argv[1], "snapshot")).digest);' "$C"
```

1. Write the printed digest into `eval/delegation-compare.pins.json` as `candidateDigest`, and the
   date as `candidateFrozenAt`. The digest covers only what a staged snapshot carries. Tests,
   docs and eval are excluded (`shouldIncludeSnapshotPath`), so the stray test files `cp` brings
   along do not change it.
2. Leave `piSubagents` pointing at the pinned install. If it is missing, rebuild it with
   `npm install --prefix eval/artifacts/pi-subagents-0.71.0 --ignore-scripts --save-exact pi-subagents@0.71.0`,
   then check its `treeManifest(<dir>, "runtime")` digest against the pin.
3. Run the full grid with `--dry-run` for each priority model. It must pass and print no
   `EXPLORATORY` line.

The pins file is itself a harness pin, so freezing changes the harness pin. Freeze before the first
grid. A grid started before the freeze cannot be resumed after it.

Then run each model's grid against that snapshot:

```sh
cc -O2 -Wall -Wextra -o /tmp/pired-fs-seal eval/corpus/fs-seal.c
H=eval/artifacts/claude-handoff-2026-09-23
C=eval/artifacts/candidate-<date>                  # the snapshot frozen above
node --experimental-strip-types eval/delegation-compare.ts \
  --baseline $H/snapshots/baseline --candidate "$C" \
  --corpus /home/mamgad/corpus/targets \
  --truth $H/research/corpus/truth --manifest $H/research/corpus/manifest.json \
  --provider zai --model glm-5.3-flash --thinking medium \
  --passes 3 --concurrency 5 --timeout 7200000 --out <new-dir> [--dry-run]
```

`--candidate` must name the frozen snapshot. It must not name `$H/snapshots/candidate`, the
native-worker snapshot from ADR-025, which the candidate probe refuses because it exposes
`pired_delegate`. `--help` prints the current pins and the same freeze steps.

- **Pilot:** `--only <id> --passes 1` runs a pilot. It is exploratory by construction and proves
  the live path end to end.
- **Stops:** the runner stops launching pairs after the first invalid run. If a pair's first arm is
  invalid, its second arm is not launched. A quota stop is reported with the wait it needs: zai
  `1308` (five-hour window), zai `1310` (weekly), or a quota or billing message.
- **Infrastructure failures:** only provider-originated text is classified, never harness errors or
  free stderr. That text is:
  - a parent or compaction `errorMessage`
  - an errored worker's failure text, when the parent received the same text
  - the entry's `benchmark_fetch_error` lines

  A failure counts as infrastructure when pi's own `isRetryableAssistantError` accepts it, when the
  provider's message asks the client to try again, when it carries zai `1302`/`1308`/`1310`, when
  it is a quota message, or when it is an undici or socket code. An arm the runner stopped on a
  signal also counts, as runner interruption. The try-again class was added before the luna v5c
  grid (ADR-026, fifth amendment); a quota message that also says "try again" is still a quota stop.
- **Resume:** `--resume <out-dir>` continues a stopped grid. Its rules:
  - **Pins:** it refuses unless every pin is byte-identical to the grid's original
    `manifest.json`, which is written once and never overwritten. Each resume keeps its own
    manifest and status under `resume-<n>/`.
  - **Exclusivity:** an owner file with the pid and start time refuses a second runner while the
    first is alive.
  - **What re-runs:** each pair is judged at its highest attempt, and both arms are re-run when
    either is missing or invalid for an infrastructure reason. Attempts are never mixed.
  - **Blocked pairs:** a pair invalid for any other reason (a timeout, a fast empty run, a harness
    check) is never re-run. An official grid holding one refuses to resume, because it cannot
    approve.

### v6 grids: N targets, patched twins, per-arm scopes, grid kinds (plan 2.8, ADR draft)

- **Targets.** The manifest may list any number of targets, at least one. What makes a grid
  official is the corpus pinned under `corpora` in `eval/delegation-compare.pins.json`: without
  `--grid-kind` that is `v5-official`, judged exactly as above.
- **Patched twins.** `--twins <twins.json> --twin-arms baseline,candidate` runs each target's
  fix-commit tree in the named arms. A twin runs under its `name` as its id, its answer key is an
  empty list, and its runs stay out of the gate and the matched arm; `summary.json`'s `twins` block
  lists them per arm with their cells, and `eval/rescore.ts` scores them against the
  `fixed_regions` the grid manifest carries.
- **Per-arm scopes.** `--baseline-max-agents`, `--max-verifiers <arm>=<n>` and `--budget-arms`
  configure each arm's scope, and `--subagents-arms` which arms load pi-subagents; unset, every
  arm is what it always was. Stage 2 loads pi-subagents in its baseline, so S's cells are the same
  in both stages.
- **Grid kinds.** `--grid-kind v6-stage1` or `v6-stage2` claims a kind pinned under `gridKinds`;
  the grid is official only when its corpus, snapshots and every option match it, and each
  difference is listed as an exploratory reason. Both kinds are drafts until the pre-registration
  is frozen. `kindFlags` in `eval/delegation-compare-grid.ts` builds a kind's options, and a test
  reads them back as exactly the kind. A kind grid is not approved or refused by ADR-026's gate:
  its `summary.json` names the v6 pre-registration's rule and `eval/v6-decision.ts`, which
  computes it, and says whether the grid is ready for it.
- **Run validity (`docs/adr-drafts/v6-run-validity.md`).** Both kinds pin `validity: "v6"`
  (`--validity v6`, recorded in the manifest). Under it a run that reaches the run limit is valid,
  scored by the pinned scorer on its ledger as it stood at the deadline (graded after the process
  group has closed and the scope is reaped), flagged `reachedLimit: true`, with its stop reason
  still `budget`; the errors the stop caused are listed as `limitEffects`, and when a worker was
  still running its tokens are withheld as null. A fast empty run is valid with zero findings,
  flagged `fastEmpty: true`. Both are model behaviour: excluding them would bias the comparison
  against the arm that works longer or quits sooner, which is what 3.2 changes. Every other
  invalid reason stays invalid and on an official grid still trips the breaker at once.
  `eval/v6-decision.ts` reports both counts per arm, never deciding. A grid without the policy,
  every v5 grid included, is judged exactly as above.
- **Stage 1 is a pilot, then the full grid.** It starts at `--passes 2`. Until the pass count is
  fixed it is blind: it prints and summarises only the valid pairs and their paired SD, and the
  arms' numbers go to `<out>/sealed/comparison.json`, never printed. The count is fixed once:

  ```sh
  node --experimental-strip-types eval/delegation-compare.ts --resume <stage-1 out> \
    --extend-passes <n> --extend-reason "<the pre-registered rule's inputs and result>"
  ```

  with n at most 10, or n = 2 to keep the pilot's count. The amendment is recorded, with who made
  it and hashes of `runs.jsonl` and `summary.json`, in `amendments.jsonl` and `resumes.jsonl`,
  which must agree on every resume.
- **Stage 2** is launched with `--passes-from <stage-1 out>` in place of `--passes`, and runs the
  count stage 1 fixed. Its `--baseline` and `--candidate` name the same snapshot, which its kind
  pins as stage 1's candidate, staged bytes included.
- **OAuth.** Both stages' worst case is past the 168 h the check asks for, so both need
  `--auth-horizon-hours`. The runner stops before any arm the token would not outlive; refresh the
  token outside the grid and `--resume`.

## Results

None yet. No scored session has run.
