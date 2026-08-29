# Commands and Keys

Everything pired adds to pi. pi's own commands (`/model`, `/login`, `/reload`, sessions, …) are unchanged — see [pi's docs](https://pi.dev).

## Slash commands

| Command | Does |
|---|---|
| `/panel` | Toggle the [engagement panel](panel.md). |
| `/panel <mode>` | Open it on a view: `state`, `coverage`, `findings`, `blockers`. |
| `/panel next` | Cycle views. |
| `/panel off` | Close it. |
| `/panel tmux` | Toggle the panel as a real tmux pane instead. |
| `/panel footer` | Toggle the footer-strip variant instead. |
| `/coverage` | Open the coverage matrix — checklist × surface. |
| `/findings` | Export findings to Markdown in the engagement workspace. |

## Keys

| Key | Does |
|---|---|
| `alt+p` | Toggle the engagement panel. |

`alt+p` rather than a `ctrl+` chord because every `ctrl+letter` is already taken by pi or readline — `ctrl+g` was registered and silently skipped as a conflict.

Rebind it like any pi keybinding, in `~/.pi/agent/keybindings.json`, then `/reload`.

## The `pired` launcher

`pired` is a thin wrapper that starts pi with the extension, the theme, and visible thinking already set up.

```bash
pired [--profile review|recon|pentest] [--provider NAME] [--model ID]
      [--target DIR] [--thinking off|low|medium|high|max] [--no-theme]
      [--prompt "one-shot"] [-- <extra pi args>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--profile` | `review` | The engagement profile. See [Profiles](profiles.md). |
| `--provider` | — | Provider id from `~/.pired/models.json` or pi's own. |
| `--model` | — | Model id. |
| `--target` | `.` | Directory to run in — the engagement's working directory. |
| `--thinking` | `high` | Reasoning depth. |
| `--no-theme` | — | Keep your own pi theme instead of pired's. |
| `--prompt` | — | One-shot prompt (pi's `-p`), for scripted runs. |
| `-- …` | — | Everything after `--` is passed to pi verbatim. |

The launcher always passes `--approve`. To run pired without it, invoke pi directly:

```bash
pi -e /path/to/pired/extensions/pired.ts --pired-profile pentest
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

Installer variables are in [Quickstart](quickstart.md#install).

## Agent tools

The agent has two tools beyond pi's own. They are documented in full at [Tools](tools.md).

```
record   kind=note|evidence|host|service|endpoint|param|tech
              |hypothesis|finding|blocker|loot
recall   query=next|coverage|gaps|inventory|hypotheses|findings
              |loot|blockers|notes
```

## Files pired reads

| Path | What |
|---|---|
| `./pired.scope.json` | The engagement scope. Loaded only when the project is trusted. See [Scope](scope.md). |
| `~/.pired/models.json` | Custom OpenAI-compatible providers. See [Models](models.md). |
| `~/.pired/engagements/<name>/` | The engagement workspace. See [The workspace](workspace.md). |
| `<pired>/checklists/*.json` | Checklist templates seeded per target type. |
| `<pired>/skills/*/SKILL.md` | The methodology layer. See [Skills](skills.md). |
