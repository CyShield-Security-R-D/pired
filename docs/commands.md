# Commands and Keys

Everything pired adds to pi. pi's own commands (`/model`, `/login`, `/reload`, sessions, …) are unchanged — see [pi's docs](https://pi.dev).

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
pi -e /path/to/pired/extensions/pired.ts --pired-profile pentest
pi -e /path/to/pired/extensions/pired.ts --pired-panel off   # what --no-panel maps to
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
