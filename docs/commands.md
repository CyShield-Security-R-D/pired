# Commands and Keys

Everything pired adds to pi. pi's own commands (`/model`, `/reload`, sessions, …) are unchanged — see [pi's docs](https://pi.dev). The one pired reaches into is **`/login`**, which gains an entry for adding an arbitrary OpenAI-compatible provider; see [Models](models.md).

## Slash commands

| Command | Does |
|---|---|
| `/panel` | Toggle the [engagement panel](panel.md). It is shown by default. |
| `/panel <mode>` | Open it on a view: `state`, `coverage`, `findings`, `blockers`. |
| `/panel next` | Cycle views. |
| `/panel off` | Close it. |
| `/panel tmux` | Toggle the panel as a real tmux pane instead. |
| `/panel footer` | Toggle the footer-strip variant instead. |
| `/coverage` | Open the coverage matrix — checklist × surface. |
| `/surface` | Browse the recorded attack surface: one row per element, a coverage bar across the checklist, and drill-down into any element's classes. |
| `/hypotheses` | Browse every hypothesis — confirmed, refuted and open — with outcome filters and full detail. |
| `/findings` | Browse findings, worst first; select one to read its description, repro and evidence. |
| `/report` | Write findings to Markdown in the engagement workspace, with a Coverage section: what was settled, what was refuted, and what nobody reached. Prints the absolute path. |
| `/challenge` | What is still unverified: the queue of findings no challenge has settled, or `/challenge <id>` for the brief on one — the brief a fresh subagent can be handed. |
| `/pass` | Which pass is open, the lens it runs under and what that lens can still reach. `/pass next` opens the next rung; `/pass <lens>` opens a named one. Only on engagements that turned passes on. |
| `/blockers` | Browse what needs you: every parked question, waiting ones first, with `a` to answer the one under the cursor. |
| `/scribe` | Write the review into the ledger now — findings, surface, and a verdict on every checklist class. |
| `/scribe on` \| `off` \| `status` | Let it run by itself after every reply (off by default), or report its state. |
| `/scribe quick` | The cheap half only: findings and surface out of new review, no checklist roll-call. |
| `/extract` | The old name for `/scribe`, kept as an alias. |
| `/provider` | Manage providers in one form with Save, Cancel and Delete; opens presets on first use. |
| `/provider add` | Add a provider from a preset; paste model IDs or select them from a searchable list. |
| `/provider edit <id>` | Edit a provider's connection and model settings together, then save. |
| `/provider list` | Show the providers in `~/.pired/models.json` and the models each serves. |
| `/provider remove <id>` | Forget one, in pired's file, pi's mirror, and this session's picker. |

### The scribe, and why it exists

A review turn is asked to do two jobs at once: reason about the code, and call
`record` as it goes. Models do the first well and skip the second. Measured over
five live runs on one prompt and one model: **868 records, 0, 0, 868, 0.** Told
directly to *"record kind=finding with its cwe, severity and file:line"*, the
model replied with a well-formed findings list in prose — CWEs, severities,
CVSS vectors — and no tool call. The break is not in deciding what to record; it
is in emitting the call at all, late in a long conversation.

So the jobs are separated. Phase one reviews, uninterrupted, in prose. Phase two
— the scribe — makes a **fresh single-turn call** whose only job is to convert
that review into rows: the regime where a small model is reliable. It returns
**JSON, not a tool call**, because a tool call is the thing that does not get
emitted. The harness writes the rows through the same `record` tool the model
would have used, so validation, ids and coverage behave identically.

Two things the harness finishes on its own, because the scribe reliably omits
them: a finding's checklist `class` is recovered from its CWE (the checklist
already maps the two), and the **confirmed hypothesis a finding already
represents** is written alongside it — coverage is settled by hypothesis
outcomes, never by findings, so without it the matrix reads zero while the report
fills up.

#### Where it runs, and why it is off by default

The scribe is **off until you ask for it**, and that is a reversal — it used to
run automatically at the end of every turn. The reason is what a *turn* is. In
pi a turn is one assistant message plus its tool batch, not one exchange with
the operator, and the agent's own loop **awaits** the handler: a review that
reads thirty files ends thirty turns, and the gate clears on 2,000 characters of
new prose, which a single turn of visible thinking passes. So the harness stopped
the agent mid-loop for a whole second model call, over and over, on a local
server that answers one request at a time. That is not a background pass; it is
the harness taking the machine away from the work.

What runs in the hot path now is appending a string to an array. Everything else
moved:

- **`/scribe`** runs a full pass on demand — the roll-call included — and is the
  normal way to use it: review, then write it up.
- **`/scribe on`** runs the cheap half automatically, but only once pi has
  *settled* (`agent_settled` — no retry, compaction or follow-up left), never
  between the agent's own turns, and never awaited.
- **The moment you type**, an automatic pass in flight is abandoned. Its model
  call is dropped, which on a one-slot local server is also what hands the slot
  back to the agent you are now waiting on. Nothing is lost: the review is still
  buffered and the next idle moment picks it up.
- **The roll-call is not asked automatically.** It is one JSON row per checklist
  class, every pass, and until a review has been somewhere most of those rows are
  `not-considered` — rows the planner then discards. `/scribe` asks it, and asks
  only about classes with a cell still open.

The status line says which of the three states it is in — `✎ scribe off`,
`✎ scribe`, `✎ scribe…` while a pass is running — because a mode that is off by
default and costs a model call when it is not is a mode you should never have to
ask about. `/scribe status` also reports how much review is buffered. The setting
is session-scoped: a new session starts it off.

#### One thing, one row

The pass re-reads a buffer that only grows, so everything it wrote on the first
pass is offered again on the second. Three rules keep that from becoming a
ledger full of copies:

- **The plan reads the ledger first.** A finding, an element or a coverage cell
  that is already recorded is not offered at all — not offered, rather than
  written and folded, because a roll-call refutation fans across every element on
  the surface and forty elements is forty `record` calls a pass to conclude forty
  times that nothing changed. A row that *would* change something — a line number,
  an evidence path, a worse severity, a stronger verdict on a cell — still goes.
- **A reworded finding in the same place is the same finding.** `record` writes a
  near-duplicate and reports it, because when the *agent* records something that
  resembles an existing finding it may have found a second bug and recall is what
  cannot be recovered. The scribe is in a different position: it is transcribing
  prose it has already transcribed, so it folds instead, names what it folded, and
  stops only when the checklist classes say the two are different weaknesses.
- **A cell named two ways is one cell.** Measured on LinkAce, "setupHttpRequest"
  and "setupHttpRequest helper function" were two coverage cells for one thing —
  and neither resolved to an element, so neither settled anything. A target that
  contains another, on word boundaries, is now the same target.

The pass re-reads the same buffer each time it runs, so it is built to be cheap
to re-send: the window it hands the model is cut **at a turn boundary and in
chunks**, never slid character by character, so appending a turn leaves every
byte before it identical and the provider re-reads the prefix from its cache. The
retry, when a reply comes back as prose, is appended as a third message rather
than prepended as a new prompt, for the same reason. The call carries a cache key
of its own, derived from the engagement, so it does not share a stream with the
conversation.

### `/challenge` — what is still unverified

`suspected` is the default status because an absent verification means *nobody has looked twice*, not *examined and cleared*. The contract that settles a claim has existed since [ADR-007](decisions.md); what did not exist was anything to say a claim was waiting — so a finding could sit unverified for a whole engagement with the machinery installed and idle.

Two things now say it.

`/challenge` with no argument lists every live finding no challenge has settled, worst first. With an id it prints that finding's brief: what the class contract requires, the control case that has to fire, and the gaps already visible without touching the target.

The same line rides in the agent's standing context block, beside the coverage matrix — the matrix says which cells are untested, this says which claims are unverified.

**The brief is built from the record and the class contract, never from the conversation.** That is what makes it safe to hand to a subagent: it opens with *"You have not seen the reasoning that produced it and you do not need it."* A verifier that inherits the finder's reasoning agrees with it — measured at precision 0.059 → 0.038, for 2.5× the wall clock.

So a delegated verifier needs nothing from the parent conversation. Hand the finding to a
`pired-verify` worker, which loads pired's own tools and fetches its own brief:

```
subagent agent=pired-verify task="Refute or confirm finding f3; recall challenge id=f3 first."
```

The worker then, through pired's shared `record`/`recall`:

```
recall challenge id=f3                                    # the child fetches its own brief
record kind=finding id=f3 status=confirmed \
    control="blind timing: ;sleep 9 -> 9.04s vs ;sleep 0 -> 0.07s"
```

The verdict is judged against the class contract on the way in and **cannot be asserted** — `record` deletes any `verification` handed to it and computes its own. A confirmation with no control case is recorded as `suspected` with the reason, and the finding is kept exactly as it was.

Invocation stays a pull, deliberately: re-running a proof touches the client's system again, so nothing here fires on its own.

### `/pass` — working an engagement in more than one sweep

Measured on the application corpus, the union of three passes finds roughly twice
what the average pass finds — 9 of 24 truth entries against a mean of 4.3, and the
same shape for codex and bare pi. About half of what the harness can find, it
misses on any given pass.

Running it again over the same ledger does not collect that. `research/06` ran the
experiment: persisted and wiped arms tie at 0.591 cumulative recall, a gap of
-0.000, and the persisted arm's final sessions run about half as long — one of
them recorded zero new findings in 105 seconds. It opened a full ledger, found
`recall next` empty, and stopped. That is the honest reading of an empty router:
`gaps` and `next` route to `not-tested` by construction, so a settled matrix looks
like a finished engagement.

So a pass carries a **lens**, and the lens decides what it is allowed to look at:

| lens | what it routes to |
|---|---|
| `route` | test cases with no verdict — the matrix, unchanged |
| `file` | files the ledger names but never recorded as surface |
| `invariant` | rules in `model.md` that no hypothesis has tested |
| `adversarial` | unchallenged findings, then cleared cells, oldest first |
| `credentialed` | surface settled before the engagement held a credential |

Earlier passes' **facts** carry forward — the inventory, the target model, the
loot, the evidence — which is what makes a later pass cheaper than a cold one.
Their **verdicts** are what the next pass is there to re-open: a cell reading
`clear` still counts toward the coverage the client is handed, and stops counting
as done work to the router.

**Off unless you turn it on.** In `scope.json`:

```json
"passes": { "enabled": true, "lenses": ["route", "file", "invariant", "adversarial"] }
```

or `PIRED_PASSES=route,file,invariant,adversarial` for a headless run, the same
affordance `PIRED_SCRIBE` exists for. With neither, an engagement runs one `route`
pass and behaves exactly as it did before passes existed.

Opening one stays a pull. A further pass spends your budget and touches the
client's systems again, so `/pass next` is yours to type — the agent is told what
the next lens would reach and told the decision is yours. `recall pass` is the
agent's view of the same thing, and the ledger stamps which pass found each row,
so `/pass` can say what this one has actually added.

Opening a discovery pass while findings still carry no verdict says so and opens
anyway. A union of passes multiplies false positives as readily as findings, and
precision is where this harness is weakest — 0.059 on the application corpus
against bare pi's 0.192 — but what to spend the time on is your call, not the
harness's.

### `/blockers` — what needs you

The agent is built to never stall: it parks a question as a blocker and routes
around it. New questions produce a notification once per session and stay visible
in the panel. They do not open a dialog over an active form or pause the agent
while waiting for input. Open `/blockers` when you are ready to review them.

It is the same browser `/findings` opens, on the blockers ledger: a list you can
sit in rather than a queue you are put through. Waiting questions come first,
worst first, and the longest wait at the top of that; answered ones stay below
with what was decided and by whom. `⏎` opens one in full — its context, the
options offered, the work it gates, the answer it got.

| Key | Does |
|---|---|
| `a` | Answer the blocker under the cursor, in the dialog its shape calls for. |
| `x` | Dismiss it: this is no longer a question. The row keeps its history and stops being counted. |
| `f` | Toggle between what is still waiting and everything. |

Approvals offer `skip for now`, `Approve`, and `Deny`, with skip selected first.
Escape or skip leaves the question open; only an explicit decision is recorded.

Either answer or dismiss writes onto the same record, so the ledger stays the single source of
truth and a resumed session sees the decision. **The agent is told.** An answer
used to go into a row nothing would read again — `recall blockers` lists only the
open ones — so the agent kept routing around a question that had been settled an
hour ago. What you decide here is now put in front of it on its next request, once,
with no tool call and nothing for you to retype. Telling it in chat still works,
and so does having it close one out itself:
`record kind=blocker id=<id> status=answered answer=…`.

`/findings` reads, `/report` writes. It used to be the other way about — `/report`
browsed while `/findings` exported — so the noun did the verb's job. `/export` is
not available for the writer: pi already owns `/export`, `/copy` and `/share`.

## Keys inside a view

| Key | Does |
|---|---|
| `↑` `↓` / `k` `j` | Move the cursor, or scroll a detail pane. |
| `PgUp` `PgDn` | A screenful at a time. |
| `Home` `End` / `g` `G` | Top, bottom. |
| `⏎` / `→` / `l` | Open the row under the cursor. |
| `esc` / `←` / `h` | Back out one level; at the top level, close. |
| `tab` / `shift+tab` | Cycle views forward / backward: coverage → surface → hypotheses → findings → blockers. |
| `a` `c` `r` `o` | Filter hypotheses: all, confirmed, refuted, open. |
| `a` `x` `f` | In blockers: answer, dismiss, or toggle waiting/all. |
| `R` | Re-read the ledger — the agent may have recorded more since you opened it. |
| `q` | Close. |

Escape returns to the previous list position. `R` preserves the selected record
when fresh data changes the sort order.

## Keys

| Key | Does |
|---|---|
| `F6` | Toggle the engagement panel. |
| `F7` | Expand or restore the panel. |
| `alt+p` / `alt+m` | Legacy toggle / expand aliases, where the host accepts them. |

Use **F6 and F7 in Windows Terminal / PowerShell**. pi reserves model shortcuts
before loading extension bindings, so an `Alt+P` model binding can win over the
panel alias. pired preserves those model controls; the function keys avoid the
collision and also work while the expanded panel holds focus. `/panel` and
`/maximize` are command fallbacks if a terminal intercepts a function key.

### On macOS, `alt+p` may not reach pired

Terminal.app and iTerm2 send **Option+P as `π`** by default, not as Meta. The keypress never becomes `alt+p`, so the shortcut does nothing and a `π` lands in your prompt.

Use `F6` / `F7` (with Fn if needed), or the commands. For the legacy Alt aliases:

- **`/panel`** and **`/maximize`** work throughout the terminal UI. The panel advertises these commands on macOS and `F6` / `F7` elsewhere.
- **Enable Option as Meta**, if you want the shortcut:
  - *Terminal.app* — Settings → Profiles → Keyboard → **Use Option as Meta Key**.
  - *iTerm2* — Settings → Profiles → Keys → Left Option key → **Esc+**.
  - *Ghostty* — `macos-option-as-alt = true`.
  - *WezTerm* — `send_composed_key_when_left_alt_is_pressed = false`.

Extension shortcuts are registered by literal key, not as named keybinding actions, so these shortcuts are **not** rebindable through `~/.pi/agent/keybindings.json`. Use `/panel` where the shortcut does not reach you.

## The `pired` launcher

`pired` is a thin wrapper that starts pi with the extension, the theme, and visible thinking already set up.

```bash
pired [--profile review|recon|pentest] [--provider NAME] [--model ID]
      [--target DIR] [--thinking off|low|medium|high|max] [--no-theme]
      [--no-panel] [--prompt "one-shot"] [-- <extra pi args>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--profile` | `review` | The engagement profile. See [Profiles](profiles.md). |
| `--provider` | — | Provider id from `~/.pired/models.json` or pi's own. |
| `--model` | — | Model id. |
| `--target` | `.` | Directory to run in — the engagement's working directory. |
| `--thinking` | `high` | Reasoning depth. |
| `--no-theme` | — | Keep your own pi theme instead of pired's. |
| `--no-panel` | — | Start without the engagement panel (it is shown by default). |
| `--prompt` | — | One-shot prompt (pi's `-p`), for scripted runs. |
| `--help` | — | pired's own flags. `pired -- --help` still reaches pi's. |
| `-- …` | — | Everything after `--` is passed to pi verbatim. |

An unrecognised profile is refused rather than coerced: `pired --profile pentst` exits non-zero
and names the three. `review` is the one profile that pre-authorizes the scope gate, so silently
falling back to it turned a typo into a read-only audit that started up looking exactly like the
pentest that was asked for.

The launcher always passes `--approve`. To run pired without it, invoke pi directly:

```bash
pi -e /path/to/pired/extensions/pired.ts -e /path/to/pired/extensions/hosts.ts --pired-profile pentest
pi -e /path/to/pired/extensions/pired.ts --pired-panel off   # what --no-panel maps to  (hosts.ts is the second -e)
```

## `pired-state`

Render the panel outside the TUI — a second terminal, a tmux pane, a status bar, a dashboard.

```bash
pired-state [--engagement NAME] [--mode state|coverage|findings|blockers]
            [--width N] [--lines N] [--no-frame] [--watch [--every SECONDS]]
            [--json]
```

Defaults to the most recently modified engagement under `~/.pired/engagements/`. `--json` emits the underlying data structure. See [The engagement panel](panel.md#outside-the-tui-pired-state).

## Delegation

pired registers four agents with [pi-subagents](https://github.com/nicobailon/pi-subagents) — `pired-scout`, `pired-investigate`, `pired-verify`, `pired-escalate` — and the model launches them with the `subagent` tool. A child is an in-process foreground pi session that loads pired's own `record`/`recall` bound to the parent's workspace and arms the engagement scope gate, so its records reach the ledger the parent reads. There is no delegation CLI: a child holds the real tools, not a `bash` shim. See [Delegation](delegation.md) and [ADR-027](decisions.md).

```
subagent agent=pired-scout       task="Map the auth surface under src/api."
subagent agent=pired-investigate task="Deep-dive f3's endpoint e_search; recall it first."
subagent agent=pired-verify      task="Refute finding f3; recall challenge id=f3 first."
subagent agent=pired-escalate    task="Chain the open findings; cite record IDs and file:line."
```

The parent keeps the plan, cross-component reasoning and final severity judgment; the prompt authorizes delegation but never forces it.

### Subagent budget

```jsonc
{ "maxAgents": 8 }   // in the scope file
```

Delegation is **opt-in**. `maxAgents` defaults to **0**, which disables it: the launcher is hidden from the model and the gate refuses every launch. Set it, 8 is the suggested cap, to let a session delegate. It was on at 8 by default until the pre-registered trial that was to justify that did not ([ADR-029](decisions.md)). Each launch the gate allows counts against it, and one that pi-subagents rejects before a worker starts is refunded. Past the budget the gate refuses with a reason, and the work continues in the current session. It is per session rather than per engagement because the gate is built at session start, so a restarted run gets a fresh budget.

The parent gate allows a `subagent` launch in one shape only: `{agent, task}`, where `agent` is one of the four pired agents. The only additions it accepts are a `cwd` inside the engagement directory, and `async: false` or `context: "fresh"`, which restate the definition. Every other field is refused with a reason that names it. That covers `gate` and `acceptance`, whose verify commands run on the host outside the scope gate. It also covers `model` and thinking overrides, `context: "fork"`, `sessionDir`, per-call limits, fan-outs and workflow scripts. Workers run one at a time: a launch while another is still running is refused. Agent and config management is refused. Read-only `list`/`status`/`doctor` are allowed and uncounted. External runner agents (claude-code, codex-exec, cursor-agent, …) are therefore refused.

The child fails closed the other way. Its `tools` allowlist names `record`, and pi-subagents fails a child at start if that tool's extension did not load, so a child never runs with the gate off. The gate reports the boundary; it is not a shell sandbox, so restate the authorized targets in every task. See [Delegation](delegation.md#what-the-gate-and-the-child-enforce) and [`ops-delegation`](skills.md).

`agentTools` is for other packages. `spawn` and `delegate` are counted against the same budget, one per call, and `agentTools` adds more names to that count. `subagent` is not on the list, because it goes through the launch check above. A tool name the gate does not recognise **fails open**: the cap never fires for it.

### Verifier cap

```jsonc
{ "maxVerifiers": 2 }   // in the scope file
```

Independent verification can be allowed without allowing delegated work. `maxVerifiers` defaults to **0**, and at 0 a `pired-verify` launch counts against `maxAgents` like any other worker, so with both at 0 nothing launches. Above 0, `pired-verify` launches are charged to their own cap. A late batch of verification is then never refused because the work launches were spent, and it doesn't spend them either. With `maxAgents` 0 and `maxVerifiers` above it, the session is verify-only: `pired-verify` is the one launch allowed. Either way, a confirmation counts as *independently verified* only when it comes from someone other than the finding's finders, and only on quotes that `record` finds in the cited file ([ADR-036](decisions.md), [draft 3.1](adr-drafts/3.1-grounded-verification.md)).

## Session budget and settle

```jsonc
{ "budget": { "minutes": 240, "tokens": 20000000, "deadline": "2026-10-01T18:00:00Z" } }   // any of the three
```

A session that can't see its budget can't tell a ceiling from a target. In the v5 trial, 32 of 41 baseline Luna runs ended by saying the review was incomplete and offering to continue, and unattended, the run simply ends ([research/12](../research/12-delegation-trial-2026-09.md)). With `budget` in the scope, one line in the per-request context block states what is used and what is left, for example "Budget: 12 of 45 min used, 33 left · 6.1M of 20M tokens used, 13.9M left".
- **From 80%** of the most-used ceiling, the line adds that it is a ceiling, not a target, and that what is established should be recorded.
- **At the ceiling,** it asks the session to settle.
- **pired enforces nothing:** the ceiling is stated, not imposed.
- **Tokens** count the lead, its workers and verifiers, and the scribe.
- **Minutes** run from session start, or up to `deadline` when one is set.
- **Without `budget`** there is no line, and nothing changes.

```
record kind=settle outcome=finished|paused|blocked note="…"
```

A settle records where the session left the engagement. The caller supplies only the outcome and the note. pired computes everything else from the ledger: open cells, unmapped areas, unchallenged findings, inconclusive hypotheses, open blockers and budget spent. The next session can then read what remains without trusting the model's own summary of it. Settling does not end the session, only the lead settles, and a settle is never edited or deleted ([ADR-036](decisions.md), [draft 3.2](adr-drafts/3.2-budget-and-settle.md)).

## `pired-ledger`

`record` and `recall`, for a process that never loaded pired's extension: a shell script, CI, or an agent you started outside pi yourself (Claude Code, Codex, Cursor). pired's gate refuses to launch such runners through the `subagent` tool.

pired's own agents do not need it: they load `extensions/child.ts` and get the real tools and the scope gate (see [delegation](delegation.md)). This is the same two tools, over the same `Workspace`, through the same `core/tools.ts` code the extension calls, reached over `bash`.

```bash
pired-ledger recall <query> [key=value]...
pired-ledger record <key=value>...
pired-ledger scope
            [--engagement NAME] [--json]
```

```bash
pired-ledger recall gaps
pired-ledger recall challenge id=f3
pired-ledger record kind=endpoint host=h1 method=GET path=/api/user file=api/user.go
pired-ledger record kind=finding title="SQLi in /search" severity=high target=e_search \
    class=sqli cwe=CWE-89 evidence=core/search.js:42 evidence=core/db.js:9
```

Repeating a key builds a list, as `evidence` does above. Exit status is `0` on success, `1` when the tool rejected the call, `2` for a usage error or a missing engagement.

`scope` prints what the engagement authorizes — and says plainly that it reports the boundary rather than enforcing one. **Scope does not reach a process outside pi**: `createScopeGate` runs in pi's tool pipeline, and a script or external runner is outside the gate. Restate the authorized targets in every handoff. See [`ops-delegation`](skills.md).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PIRED_RAIL_WIDTH` | `56` inline, `64` tmux | Panel width in columns. |
| `PIRED_RAIL_HEIGHT` | `50%` | Inline rail height: `N` rows or `N%`. Invalid values fall back to `50%`. |
| `PI_BIN` | `pi` | The pi binary the `pired` launcher spawns. |
| `PIRED_PASSES` | — | The pass ladder for a headless run: `route,file,invariant,adversarial`, or `off`. Overrides `scope.json`. |
| `TMUX` | — | Set by tmux; `/panel tmux` requires it. |

The panel's start-up visibility is a flag rather than an environment variable: `--pired-panel on|off`, or `pired --no-panel`.

Installer variables are in [Quickstart](quickstart.md#install).

## Agent tools

The agent has two tools beyond pi's own. They are documented in full at [Tools](tools.md).

```
record   kind=note|evidence|host|service|endpoint|param|tech
              |hypothesis|finding|blocker|loot
recall   query=status|next|coverage|surface|gaps|cleared|pass|inventory
              |hypotheses|findings|finding|challenge|loot|blockers|notes
              |model|context
```

## Files pired reads

| Path | What |
|---|---|
| `./pired.scope.json` | The engagement scope. Loaded only when the project is trusted. See [Scope](scope.md). |
| `~/.pired/models.json` | Custom OpenAI-compatible providers. See [Models](models.md). |
| `~/.pired/engagements/<name>/` | The engagement workspace. See [The workspace](workspace.md). |
| `<pired>/checklists/*.json` | Checklist templates seeded per target type. |
| `<pired>/skills/*/SKILL.md` | The methodology layer. See [Skills](skills.md). |
