# Delegation

pired delegates through [pi-subagents](https://github.com/nicobailon/pi-subagents). When
the package is present, pired registers four security-operator agents at session start. An
engagement that opts in by setting `maxAgents` in its scope file authorizes the model to use them,
and so does a single run started with `pired --agents 8` or switched on with `/agents 8`
([ADR-042](decisions.md)). By default delegation is off ([ADR-029](decisions.md)). pired has no
worker of its own; see [ADR-027](decisions.md).

## Versions

**The supported stack is `pi-subagents ≥ 0.71.0` on `pi ≥ 0.86.1`.** It is what the installers
enforce and what the no-model tests and the comparison harness run against (pi-subagents 0.71.0 on
pi 0.87.1). The installers install pi when it is missing and upgrade one below 0.86.1. They register
`npm:pi-subagents` when it is missing and upgrade one below 0.71.0. A pinned or forked entry is left alone and reported
([Quickstart](quickstart.md#install)).

pired reads no version number. Its agent definitions use only the fields that pi-subagents 0.66
and 0.71 both accept, so an older package, such as 0.66, still registers the four workers. Two costs
come with it:
- **The full tool schema on every request.** 0.71 shows the parent a small `subagents_enable`
  stub until the model first delegates. 0.66 sends the full `subagent` schema with every request
  (about 21k characters for that tool alone).
- **Before 0.68, providers come from the mirror.** From 0.68 an in-process child inherits the
  providers its parent registered. Before that, a worker knows only pi's own providers, so a
  pired provider from `~/.pired/models.json` resolves in the child only through the copy pired
  mirrors into `~/.pi/agent/models.json`.

pired notices the first cost. When the parent has the full `subagent` tool active and no
`subagents_enable` loader, it tells the operator once, with the update command. That happens with
pi-subagents before 0.71, or with 0.71 on a pi older than 0.86.1. Re-running the installer also
moves an unpinned `npm:pi-subagents` to the supported version.

## What a worker is

A child runs as an **in-process foreground pi session**. pired hands it the same engagement
by naming `extensions/child.ts` in the agent definition. The child loads pired's `record` and
`recall`, bound to the parent's workspace, and arms the engagement scope gate. A record the child
writes is durable immediately, and the parent reads it back with `recall`. The child starts
fresh, with none of the parent's conversation. It reads what it needs from the shared ledger:
`recall context` for a bounded snapshot of the model, surface, claims and blockers, and the other
`recall` queries for the rest, including loot handles (never the secrets). It returns at most 200 words: the record IDs it
wrote, evidence paths, verdicts, and any work left open.

A worker gets the parent's default toolset, `read` and `bash`, plus the ledger's `record` and
`recall`. pi's `grep`, `find` and `ls` are left out for parity with the parent, which does not have
them by default. `grep` and `find` also run the `rg` and `fd` binaries, which pi downloads on first
use when they are missing. The 2026-09-24 v4 grid ran on a host with neither binary and no network,
and there every worker call to them failed (grep 45 of 45, find 57 of 57). Where the binaries are
installed or can be fetched, those tools work.

The worker's scope is the parent's own, handed over in-process: the parent publishes the exact
scope object its gate was built from, keyed by workspace, and the worker arms from that copy. It
never reads `scope.json`. That file is the parent's copy for the panel and `pired-state`, and the
gated model can write it, because the scope gate does not police local paths. A worker armed from
it could be widened mid-session by one edit. A worker that finds no scope published for its
workspace refuses to start.

pi-subagents keeps each worker's transcript and run artifacts under pi's own session directory
(`~/.pi/agent/sessions/…`, or the OS temp directory when the parent has no session file), not in
the owner-only engagement workspace. What the engagement keeps is what the worker recorded, and
what it saved under `evidence/`.

## The four agents

| Agent | Use it for | Records |
|---|---|---|
| `pired-scout` | Attack-surface mapping of an area: routes, handlers, inputs, trust boundaries, sinks. | Surface elements (with file) and proposed hypotheses. |
| `pired-investigate` | A deep dive on one module or lead. | Hypotheses with verdicts, findings (suspected until verified). |
| `pired-verify` | A fresh adversarial check that tries to refute findings or cleared hypotheses, one at a time, from source or a control case. | Each verdict on the record by id, `suspected` (finding) or `inconclusive` (hypothesis) when unsettled; a finding linked by `hypothesisId` for a clearance it overturns. |
| `pired-escalate` | Impact amplification: what existing findings unlock, and whether they chain. | A chained finding only with a concrete path citing component record IDs and each hop's `file:line`; otherwise the chain as a hypothesis. |

`pired-escalate` reads the ledger first (`recall`), traces reachable sinks, privileged
operations, secrets and crossed trust boundaries, tries combinations, and never inflates
severity without a concrete path behind it.

## Using a worker

Give a worker one objective and pass exact record IDs and source paths in the task, because
it has not seen your reasoning. Record what you already know first, so the child can build on
it through `recall` rather than rediscovering it. The parent keeps the engagement plan,
cross-component reasoning, and the final severity judgment. The prompt authorizes the four
agents but never forces delegation.

A launch is `{agent, task}`:

```json
{"agent":"pired-verify","task":"Try to REFUTE findings f3 and f5, one at a time. Read recall challenge id=<id> for each; ground each verdict in file:line or a control case you ran, and record it on the finding by id."}
```

A verifier records its verdict on the record through the same evidence checks the parent's
writes go through, so a task does not need to tell it to leave the status alone. One launch can
carry two or three records: the verifier records each verdict before it starts the next, and names
the ones it did not reach as unchallenged.

Each agent has a per-role turn budget: scout 20, investigate 24, verify 24, escalate 20. At the
budget the worker is told to hand back. The ledger stays open for two grace turns, so `record` and
`recall` still run and it can write down what it established; every other tool is refused. A tool
call after the grace turns, `record` included, ends the run. Each worker also has a 45-minute
timeout, a safety net behind the turn budget.

Workers run **one at a time**, in the foreground. pired is synchronous by design, which keeps
accountability clear and does not send concurrent requests to one GPU. This is enforced, not
trusted. pi runs the tool calls of one assistant message in parallel, and `subagent` does not
declare itself sequential, so two launches in one message used to run two workers at once. The
gate refuses a launch while another is running.

**Delegation is opt-in.** `maxAgents` in the scope file caps how many workers a session may launch,
and `pired --agents <n>` or `/agents <n>` sets that cap for one run instead (ADR-042).
It defaults to `0`, which disables delegation: the model sees a one-line block saying so, and neither
`subagent` nor `subagents_enable`. `8` is the suggested cap for an engagement that opts in. The
default was 8 until the pre-registered trial found delegation matched the single agent's true
positives at a higher cost and lower precision ([ADR-029](decisions.md), ADR-026 outcome). It was on
again from 2026-10-01 to 2026-10-06 (ADR-038). On GPT-6 Luna the delegating build then stopped after
a median 20 minutes and found 16 of 52 advisory opportunities against 22 solo, so it is opt-in again
([ADR-039](decisions.md)).
The delegation block states the number. Each launch the gate allows counts against it. A launch
that pi-subagents rejects before any worker starts is refunded. A launch past the cap is refused
with wrap-up guidance, not a stop: the rest is the parent's, starting with what the ledger already
holds (unchallenged findings, inconclusive leads, worker verdicts not yet acted on) and then the
rest of the method.

## What the gate and the child enforce

The **parent gate** allows a `subagent` launch in one shape only. It must name one of the four
pired agents and a `task`, and it may add nothing but these:
- `cwd`, when it is the engagement directory or a directory inside it
- `async: false` or `context: "fresh"`, which restate what the definition already sets

Every other field is refused with a reason that names it. The registered definition is the contract:
it fixes the model and thinking level (the parent's), the fresh context, the timeout, the tool
budget and the tools. So the gate refuses:
- **Host-side checks:** `gate` and `acceptance`. pi-subagents runs a verify command with a shell on
  the host after the worker, where no `tool_call` hook sees it. In a review probe, a `gate`
  command wrote a marker file, while the same command through `bash` was refused.
- **Model overrides:** `model` (including a `:level` thinking suffix), `thinking` and `fast`. A
  worker on another provider would send client code there.
- **Context and placement:** `context: "fork"`, which hands the worker the parent's whole transcript,
  and `sessionDir`, which writes the worker's transcript wherever the call names instead of where
  pi-subagents is configured to keep it, and where the comparison's accounting reads it.
- **Limits and output:** per-call timeouts and budgets, output modes and schemas, and skills.
- **Other shapes:** `async: true`, worktrees, `tasks`/`chain`/`parallel` fan-outs, and workflow
  scripts. The agents a workflow script will start cannot be checked before it runs.
- **Management:** any action that creates, updates or deletes agents, runs or configs. Read-only
  actions (`list`, `status`, `doctor` and the like) are allowed and uncounted.

The list is an allowlist because the denylist before it kept missing fields. The `subagent`
schema has dozens of top-level keys, and it changed between 0.66 and 0.71. External runner agents
(claude-code, codex-exec, cursor-agent, …) are refused, since only the four pired names pass.

The **child** fails closed. Its agent definition lists `record` in the `tools` allowlist,
and pi-subagents fails a child at start when an allowlisted tool is missing. So a child whose
`extensions/child.ts` did not load never runs half-armed with the gate off. Until it is armed, the
child refuses every tool call. Once armed, its own gate refuses nested delegation (`subagent`,
`subagents_enable`) and pi-subagents' supervisor channel, and refuses any out-of-scope action with
pired's exact scope reason.

The child also holds each worker to its role and to the ledger. Where a rule below refuses a
call, the refusal says why and what to record instead; nothing the worker sends is silently
rewritten.
- **Role rules.** A scout does not record findings; it proposes hypotheses for an investigator to
  settle. A verifier records verdicts, not rewrites. On a finding it names by id it may pass only
  the verdict keys (`status`, `basis`, `live`, `control`, `entitlement`, `reason`), and the status
  only `confirmed`, `refuted` or `suspected`. It deletes nothing and does not change the status of a
  finding already `reported`. It creates a finding only with `hypothesisId`, for a hypothesis
  recorded `confirmed` that no finding already covers.
- **The recording reserve.** A worker that reaches the last three turns of its budget with nothing
  recorded may only `record` and `recall` until it records something. Saved evidence and notes do
  not count, because neither says what the worker established.
- **One reminder before hand-back.** A worker about to hand back with nothing recorded is told once,
  while it still has turns, that its handoff is not durable. A second hand-back is let go.
- **No supervisor section.** pi-subagents 0.71 appends a section to each worker's prompt inviting
  it to contact its supervisor. A pired worker has none, so the child strips that section when it
  matches the default template, and the gate refuses the tool either way.
- **Source-only refutation.** A refutation needs a cited `basis`. When the scope lists a target, a
  refutation that says `live=false` stays unresolved, because an unreachable target refutes
  nothing. When the scope lists no target, whatever its mode, nothing is running to reach, so the
  basis is the whole bar. The child reads this from the parent's scope, never from the worker.

As with the parent, this gate catches mistakes; it is not a shell sandbox. It governs network
targets, not local paths: a worker's `read` and `bash` reach the same files the parent's do.
Restate the authorized boundary in the task, and treat a delegated network action as work you
authorized personally.

## Accounting

A child's model usage is real spend and must be counted alongside the parent's. pi-subagents
records per-response usage in the child's `session.jsonl` (keyed by `responseId`) and a
per-child summary in the `subagent` tool result's `details.results[]` (usage, exit status,
`runId`). The acceptance comparison in [`delegation-compare.md`](../eval/delegation-compare.md)
sums parent, compaction and every child response into one total.

## When pi-subagents is absent

If the package is not loaded or registration fails, pired drops the delegation guidance
from its prompt and shows one operator notice. To install the package, run
`pi install npm:pi-subagents`. To move an existing unpinned entry to the current version, run
`pi update npm:pi-subagents`, or re-run pired's installer. Nothing else changes: pired works
without delegation.

## How it is tested

`extensions/child.test.ts` covers the child's wiring on every `npm run check`. Its end-to-end case
drives a real pi-subagents launch with a scripted model, and it runs when `PIRED_TEST_PI_SUBAGENTS`
names an installed package. The comparison harness's sealed delegation probe runs the same path
under Landlock and seccomp. [Testing](testing.md#delegation-end-to-end) has the command and what
each check proves.
