---
name: ops-delegation
description: Use when the pi-subagents `subagent` tool is available — delegate noisy recon and adversarial verification to a pired worker to keep the parent context clean and cut false positives.
---

# Delegating to pired workers

Goal: use a child agent to keep the **parent's context clean** and to **reduce false positives**, not for raw parallelism. The two big wins on local models are context isolation (a noisy enumeration burns the child's context, and only a distilled result returns) and adversarial verification (a fresh agent tries to *refute* a hypothesis before it becomes a finding).

pired delegates through the **pi-subagents** package. It registers four workers you launch with the `subagent` tool; each starts in a fresh context with your model, runs pired's own child extension (so it has `record`/`recall` bound to the same ledger and the same scope gate), and returns a short handoff. There is no separate native delegate tool — the four workers below are it.

## 0. Availability
When pi-subagents is loaded and the workers registered, a `<delegation>` block in your prompt lists them, and that is your standing authorization to use them. Delegation is off in two cases:
- **No `<delegation>` block:** pi-subagents is not loaded, or the workers did not register. The operator was shown the install command (`pi install npm:pi-subagents`).
- **A block that says delegation is off:** the engagement did not opt in (`maxAgents` is 0, the default), and the gate refuses every launch.

Either way, do the work inline: capture raw output to `evidence/`, distill it into `record`, and review hypotheses adversarially yourself before promoting them.

The `subagent` tool may start hidden behind a small `subagents_enable` tool; call that first, then `subagent`. pired hides pi-subagents' background tools (`bg_wait`, `subagent_supervisor`) on purpose: pired workers run in the **foreground**, one at a time, so their work stays accountable to this session.

Launch with `agent` and `task`, and nothing else. The worker's definition already fixes its model and effort (yours), its fresh context, its timeout and its tools. pired's gate refuses a launch that tries to override any of that. It also refuses a `gate`/`acceptance` check, because that is a shell command pi-subagents runs on the host, outside the scope gate. A refused launch costs a turn.

## 0a. The four pired workers
Each is a real pi child that loads pired. It reads and writes the same ledger you see, and its records appear to you immediately, with no bash bridge needed. It runs under the same scope you do. It cannot delegate again, run in the background, or use a git worktree, and pired's gate refuses any agent that is not one of these four. It starts in the engagement directory (or a `cwd` inside it). Its tools are your session's default `read` and `bash`, plus `record` and `recall`, and its `read` and `bash` reach the same local files yours do: the scope gate governs network targets, not paths. Name the files it should work on in the task.

- **`pired-scout`** — map an area's attack surface: routes, handlers, inputs, trust boundaries, sinks. Records surface (with the source file) and proposes hypotheses. Breadth, not confirmation.
- **`pired-investigate`** — deep-dive one module or lead in isolation, so the grind burns the child's context, not yours. Records hypotheses with verdicts, and findings that land `suspected`, citing exact `file:line`. It does not confirm or refute findings, and does not change ones it did not record.
- **`pired-verify`** — a fresh, skeptical pass that tries to **refute** findings or cleared cells before a client reads them, one at a time, a batch of about five per launch. Records each verdict on the record by id, with its grounds quoted from the code. The cheapest guard against both a false positive and a false negative.
- **`pired-escalate`** — trace what your findings and open hypotheses unlock (reachable sinks, privileged ops, secrets, boundaries crossed), try to chain them, and record a chained finding only with a concrete path. Like an investigator's, its findings land `suspected`.

## 0b. Verifying a cleared cell — part of the coverage loop, not of a direct request

**This is the routine one.** A hypothesis recorded `refuted` turns its coverage cell `clear`, and that cell counts toward the percentage the client is handed. It is the only verdict in the harness nothing revisits — findings get challenged, clearances were taken at their word. During a normal engagement, hand them out to `pired-verify`:

```
recall cleared                      # cells a refutation settled, oldest first
recall challenge id=<hypothesis id> # the brief for one
```

`recall cleared` is the list to sample from — `gaps` and `next` will never show these, because a cleared cell is settled and the router moves on. It shows oldest first on purpose: a cell cleared in the first hour was cleared by an agent that had not yet read the code it was clearing.

Hand the hypothesis ids and their source paths to `pired-verify` in the task. The worker reads `recall challenge id=<id>` for each, tries to overturn the clearance, and records the verdict on the hypothesis by its id with what it was grounded in (`basis=file:line`; `live=true` only when it tested a running target, left out when its basis is the source), or `inconclusive` when it cannot settle it. That writes a `verification` on the row — `stands` if the clearance held, `amended` if it was overturned — which is what lets the report say a cell was independently checked. A clearance it overturns is recorded `confirmed` on the hypothesis first, then comes back as a finding linked by `hypothesisId` unless one already covers it; that finding lands `suspected`, and the verifier's verdict on it is a second write on its id.

Sample rather than sweep. One cell per class, or the ones cleared earliest, buys most of the value; challenging every refutation costs more than the engagement. One verifier takes a batch of about five records in a launch: it settles them one at a time, records each verdict before the next, and names any it did not reach as unchallenged.

## 0c. Independent verification — why a finder does not settle its own findings

A check made by whoever wrote the claim tends to agree with it: the scribe pass, which re-read the agent's own reasoning, moved precision from 0.059 to 0.038. So pired records who wrote each finding (`by`) and who judged it (`verification.by`), and the roles are held apart:
- A finding an investigator or escalator records lands `suspected`, and pired refuses `status=confirmed` or `refuted` from them. A verifier or you settle it.
- Your own confirmation is judged and kept, and the report labels it "verified by its finder"; one made by someone else is "independently verified". Nothing is refused for being yours — the reader is told which it was.
- On a review of source, a verdict rests on **grounded quotes**: `file:line: verbatim text`, checked against the file within 3 lines of the cited line. A confirmation quotes the path from source to sink, a refutation the guard. A quote that is not there settles nothing, and the reply shows what the line says. `ops-challenge-finding` §1a explains why a quote rather than a line number.

**What it costs, and the cheaper shape.** A verifier costs you turns at full context — reading its handoff and its rows — and that is the measured cost driver of delegation, not the worker's own turns. So verification works best as **one late batch**: when the work is done, `recall challenge` lists what is still unverified, worst first; hand a verifier the ids, about five per launch. Its handoff is the ids and their verdict words; the verdicts, the quoted grounds and who made them are already on the ledger, so a verified row needs no re-reading.

**Its own cap.** An engagement can set `maxVerifiers` in the scope: `pired-verify` launches are then counted against it rather than `maxAgents`, so verification never competes with work launches, and does not fall back on them when spent. `maxAgents: 0` with `maxVerifiers` above it is the verify-only configuration: you do all the work, and may launch verifiers. The operator may also set `verifier.model` to verify on another model than yours — theirs to set, never a launch override, because it sends client code to that provider.

**When the operator asked for specific test cases, do them yourself.** A direct request is addressed to you; answering it by spawning a child and relaying the result is slower, loses your context, and is not what was asked. Delegation belongs to the coverage loop you are driving on your own initiative — not to work someone just handed you.

## 1. When to delegate
Delegate work that is **noisy** (floods context) or **needs a fresh, skeptical pass**:
- **Isolated recon / enumeration** (`pired-scout`) — a full route sweep, a per-host service enum. The child does the grinding; you get back a distilled inventory + proposed hypotheses, not 4,000 lines.
- **Deep dive on one lead** (`pired-investigate`) — a single module you want traced end to end without it swamping your context.
- **Adversarial verification** (`pired-verify`) — two directions, both worth a child. Hand a borderline hypothesis to one whose job is to *break* it (the false-positive gate before a finding), and hand a *cleared* cell to one whose job is to break the clearance (§0b — the false-negative gate, which is the costlier miss).
- **Impact amplification** (`pired-escalate`) — once you have a few findings, have a worker trace what they unlock and try to chain them.

Do **not** delegate: the core planning/coverage loop, final finding decisions, or anything needing your accumulated context. Keep judgment in the parent.

## 2. How to hand off (give the child a clean, bounded task)
- **Record what you already know first.** The worker gets a bounded snapshot of the ledger (`recall context`), not your transcript, so a lead only reaches it if it is written down.
- **Pass the exact refs.** Put the exact file paths and record IDs in the task; the worker will `recall context` and read source by path.
- **One clear objective + explicit scope.** Name the target(s). The worker runs inside pired's scope gate, so it is guarded — but naming the boundary keeps the task unambiguous for the model.
- **Say what to return.** Ask for a *distilled* handoff: recorded surface + a short list of proposed hypotheses (scout), each id and its verdict word (verify), or the record IDs it wrote (investigate/escalate). The handoff is capped at ~200 words (60 for a verifier); the ledger carries the detail.

Example launches (`subagent` tool):
```json
{"agent":"pired-scout","task":"Map the attack surface of src/api/. Record each route/handler/input with its file, and propose hypotheses with their checklist class. Do not try to confirm anything."}
```
```json
{"agent":"pired-verify","task":"Try to REFUTE hypotheses y7 ('GET /api/user?id= is IDOR-able') and y9, one at a time. Read `recall challenge id=<id>` for each, inspect the code, and record each verdict on the hypothesis by id (confirmed|refuted|inconclusive) with basis=file:line."}
```
```json
{"agent":"pired-verify","task":"Verify findings f3, f5, f9, f12 and f14, one at a time: read `recall challenge id=<id>` for each, try to refute it from the source, and record each verdict on the finding by id with its grounds quoted."}
```

## 3. What to do with the result
- Read the worker's **distilled** return and its records (`recall hypotheses`, `recall findings`, `recall context`), not its steps. Trust the ledger over prose.
- A `pired-verify` verdict is already on the record, through the same evidence checks yours go through, so a verify task need not tell it to leave a status alone. A clearance it overturned comes with a finding linked by `hypothesisId` — `suspected` until a verdict is recorded on it by id — so weigh it and write it up (`ops-finding-writeup`). An `inconclusive` hypothesis or a still-`suspected` finding is an open item for you, and records it named as unchallenged were never reached. A verifier cannot change a `reported` finding's status; its verdict on one is in its handoff, for you to take to the operator.
- If the worker hit a wall needing the operator, it should have parked a `blocker` — pick it up via `recall blockers` and route around it.
- **A worker's return is a lead to weigh, never tested coverage until you have weighed it.** Keep the cross-component reasoning and the final severity judgment in the parent.

## 4. Limits and the fleet view
- **Foreground only, one at a time.** A worker blocks your turn until it returns, and there is no background/async delegation. Launch one worker per message: a second launch while one is still running is refused. This is deliberate, because it keeps the work accountable and sends one GPU one request at a time.
- **Depth 1.** A worker cannot delegate again; the gate refuses it.
- **Budgeted.** The engagement's `maxAgents` (default **0**, off; 8 is the suggested opt-in) caps the workers you may launch per session, and `maxVerifiers` (default 0) caps verifier launches separately when it is set (§0c); the `<delegation>` block states the numbers. Each worker runs for a bounded number of turns (scout/escalate 20, investigate 24, verify 40) and at most 45 minutes. After the last launch the rest is yours: settle what the ledger already holds — unchallenged findings, inconclusive leads, worker verdicts not yet acted on — then carry on with the rest of the method.
- **Scoped.** Worker tool calls pass through pired's scope gate, the same one you run under.

In the TUI, pi-subagents shows a persistent **FleetView** under the editor while work runs; from an empty editor its navigation keys expand it, and `/subagents-fleet` opens the live inspector to browse a child, read its transcript, or stop a run. pired refreshes its own panel when a worker finishes, and announces any blocker the worker parked.

## 5. Note on other pi-subagents agents
Only the four pired workers load pired and get `record`/`recall` on the shared ledger; a generic pi-subagents agent (a builtin or an external CLI runner) does not, and pired's gate refuses to launch it through the `subagent` tool. If you deliberately run such an agent by other means, it is unguarded: state the authorized boundary in its task, and treat any network action as work you authorized personally. This is the exception, not the path — prefer the four pired workers.

## 6. The payoff
- Parent context stays small → weak models don't drown and compaction keeps scope/findings.
- A second skeptical pass kills false positives before they reach the report, and re-checks clearances before they become silent false negatives.
- Distilled inventory/verdicts flow back into the same `record`/`recall` loop, so the engagement state stays single-source-of-truth — the delegation is only worth it once its result is recorded, not just reported in prose.

## References
- PTES — Vulnerability Analysis (Validation) — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/vulnerability_analysis.html (manual validation & correlation to cut false positives — the verify worker's job)
- Technical Guide to Information Security Testing and Assessment — NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final (validating findings and reducing false positives before reporting)
- PTES — Reporting — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/reporting.html (distilled inventory/verdicts feed the single-source report)
