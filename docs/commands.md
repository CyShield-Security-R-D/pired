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
| `/report` | Write findings to Markdown in the engagement workspace. |
| `/blockers` | Walk the open blockers — what needs you — one dialog at a time, including ones already dismissed. |
| `/extract` | Convert the review into ledger records now. Runs automatically when a turn leaves the checklist unanswered. |
| `/extract off` \| `on` \| `status` | Turn the automatic second pass off or on for this session, or report its state. |
| `/provider` | Add an LLM provider — base URL, model, token — the same wizard `/login` opens. |
| `/provider list` | Show the providers in `~/.pired/models.json` and the models each serves. |
| `/provider remove <id>` | Forget one, in pired's file, pi's mirror, and this session's picker. |

### Extraction, and why it exists

A review turn is asked to do two jobs at once: reason about the code, and call
`record` as it goes. Models do the first well and skip the second. Measured over
five live runs on one prompt and one model: **868 records, 0, 0, 868, 0.** Told
directly to *"record kind=finding with its cwe, severity and file:line"*, the
model replied with a well-formed findings list in prose — CWEs, severities,
CVSS vectors — and no tool call. The break is not in deciding what to record; it
is in emitting the call at all, late in a long conversation.

So the jobs are separated. Phase one reviews, uninterrupted, in prose. When a
turn ends having recorded nothing, phase two makes a **fresh single-turn call**
whose only job is to convert that review into rows — the regime where a small
model is reliable — and it returns **JSON, not a tool call**, because a tool call
is the thing that does not get emitted. The harness writes the rows through the
same `record` tool the model would have used, so validation, ids and coverage
behave identically.

Two things the harness finishes on its own, because the extractor reliably omits
them: a finding's checklist `class` is recovered from its CWE (the checklist
already maps the two), and the **confirmed hypothesis a finding already
represents** is written alongside it — coverage is settled by hypothesis
outcomes, never by findings, so without it the matrix reads zero while the report
fills up.

`/extract` runs the same pass by hand, and `/extract off` stops it running
itself — for a demo, a slow provider, or an engagement being driven by hand. It
disables only the *automatic* pass: asking for one by name keeps working, which
is the difference between turning a reviewer off and taking it away. The setting
is session-scoped; a new session starts it back on, and `/extract status`
reports it along with how much review is buffered.

The pass re-reads the same buffer every turn, so it is built to be cheap to
re-send: the window it hands the model is cut **at a turn boundary and in
chunks**, never slid character by character, so appending a turn leaves every
byte before it identical and the provider re-reads the prefix from its cache. The
retry, when a reply comes back as prose, is appended as a third message rather
than prepended as a new prompt, for the same reason. The call carries a cache key
of its own, derived from the engagement, so it does not share a stream with the
conversation.

### `/blockers` — what needs you

The agent is built to never stall: it parks a question as a blocker and routes
around it. The dialog fires the moment one is recorded, which is also the moment
the operator has the context — but an operator who is mid-thought dismisses it,
and the blocker correctly stays open. `/blockers` is the way back to it. It walks
every open blocker, including the ones already waved away, and writes each answer
onto the same record, so the ledger stays the single source of truth and a
resumed session sees the decision.

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
| `tab` | Cycle surface → hypotheses → findings. |
| `a` `c` `r` `o` | Filter hypotheses: all, confirmed, refuted, open. |
| `R` | Re-read the ledger — the agent may have recorded more since you opened it. |
| `q` | Close. |

## Keys

| Key | Does |
|---|---|
| `alt+p` | Toggle the engagement panel. |

`alt+p` rather than a `ctrl+` chord because every `ctrl+letter` is already taken by pi or readline — `ctrl+g` was registered and silently skipped as a conflict.

### On macOS, `alt+p` may not reach pired

Terminal.app and iTerm2 send **Option+P as `π`** by default, not as Meta. The keypress never becomes `alt+p`, so the shortcut does nothing and a `π` lands in your prompt.

Two ways out, and you do not need either:

- **`/panel`** works on every platform and every terminal. That is why the panel's own hint reads `/panel to hide` on macOS and `alt+p to hide` elsewhere — the instruction on screen is always one that works on the machine reading it.
- **Enable Option as Meta**, if you want the shortcut:
  - *Terminal.app* — Settings → Profiles → Keyboard → **Use Option as Meta Key**.
  - *iTerm2* — Settings → Profiles → Keys → Left Option key → **Esc+**.
  - *Ghostty* — `macos-option-as-alt = true`.
  - *WezTerm* — `send_composed_key_when_left_alt_is_pressed = false`.

Extension shortcuts are registered by literal key, not as named keybinding actions, so `alt+p` is **not** rebindable through `~/.pi/agent/keybindings.json`. Use `/panel` where the shortcut does not reach you.

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
| `-- …` | — | Everything after `--` is passed to pi verbatim. |

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

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PIRED_RAIL_WIDTH` | `56` inline, `64` tmux | Panel width in columns. |
| `PIRED_RAIL_HEIGHT` | `50%` | Inline rail height: `N` rows or `N%`. Invalid values fall back to `50%`. |
| `PI_BIN` | `pi` | The pi binary the `pired` launcher spawns. |
| `TMUX` | — | Set by tmux; `/panel tmux` requires it. |

The panel's start-up visibility is a flag rather than an environment variable: `--pired-panel on|off`, or `pired --no-panel`.

Installer variables are in [Quickstart](quickstart.md#install).

## Agent tools

The agent has two tools beyond pi's own. They are documented in full at [Tools](tools.md).

```
record   kind=note|evidence|host|service|endpoint|param|tech
              |hypothesis|finding|blocker|loot
recall   query=status|next|coverage|surface|gaps|inventory|hypotheses
              |findings|loot|blockers|notes
```

## Files pired reads

| Path | What |
|---|---|
| `./pired.scope.json` | The engagement scope. Loaded only when the project is trusted. See [Scope](scope.md). |
| `~/.pired/models.json` | Custom OpenAI-compatible providers. See [Models](models.md). |
| `~/.pired/engagements/<name>/` | The engagement workspace. See [The workspace](workspace.md). |
| `<pired>/checklists/*.json` | Checklist templates seeded per target type. |
| `<pired>/skills/*/SKILL.md` | The methodology layer. See [Skills](skills.md). |
