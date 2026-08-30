# The Interface

pired runs inside pi's TUI and keeps all of it — the transcript, `/model`, `/login`, sessions, autocomplete, MCP. On top of that it adds an interface for one job: making the state of an engagement visible without having to ask the agent about it.

That distinction runs through every screen below. **The transcript is the conversation; the ledger is the artifact.** A finding you can only see by scrolling back, or coverage you can only learn by asking the model to `recall gaps`, is a finding and a coverage number you will not check. So pired renders them itself, from the workspace on disk, not from anything the model says.

Everything here is TUI-only and individually guarded: in `-p` / print, RPC, and JSON modes the UI layer is skipped entirely and the same information arrives as notifications or plain text. A missing or older pi API disables a feature; it never breaks the session.

## Contents

- [The status line](#the-status-line)
- [The engagement panel](#the-engagement-panel)
- [The coverage view](#the-coverage-view)
- [Findings in the transcript](#findings-in-the-transcript)
- [Blocker dialogs](#blocker-dialogs)
- [Scope refusals](#scope-refusals)
- [Working indicator, thinking, and window title](#working-indicator-thinking-and-window-title)
- [Glyph vocabulary](#glyph-vocabulary)
- [Headless modes](#headless-modes)

## The status line

pired replaces pi's footer with a single line carrying the brand mark and live engagement state on the left, and session context on the right.

```
pired ⦿ acme-webapp · C1 H2 M3 · cov 62% · blockers 1 · ⛨ pentest·enforce      ctx 34% · qwen3.8-27b · main · /help
```

| Segment | Meaning |
|---|---|
| `pired` | The wordmark: `pi` dim + `red` in the theme accent. Never dropped. |
| `⦿ acme-webapp` | The engagement name. The last thing to be dropped. |
| `C1 H2 M3` | Findings by severity — critical, high, medium, low, info — each in its own colour. Falls back to `⚑3` when narrow, and `⚑ 0` when there are none. |
| `cov 62%` | Coverage of the applicable matrix. See [Coverage](coverage.md). |
| `blockers 1` | Open operator questions, in the warning colour. Only shown when non-zero. |
| `⛨ pentest·enforce` | The scope gate. See below. |
| `ctx 34%` | Context-window usage, with pi's own thresholds: warning past 70%, error past 90%. |
| `qwen3.8-27b` | The active model. |
| `main` | The git branch, updated live. |

The findings segment leads with the severity spread rather than a bare total, because the number an operator actually needs is *"is anything critical?"*, not *"how many rows exist?"*.

### The gate indicator

The one segment that separates pired from a coding agent is whether the scope gate is armed. In an enforcing profile you are one command away from a real client system, so armed states are **mandatory** segments: they shrink, but they are never dropped for space.

| Rendering | State |
|---|---|
| `review` (dim) | `mode: "off"` — no gate. The read-only default. |
| `⛨ pentest·enforce` (accent) | Gate active, engagement authorized. |
| `⛨ pentest·warn` (warning) | Out-of-scope calls are flagged but allowed through. |
| `⛨ pentest·unauthorized` (error) | Enforcing, but the scope is not marked authorized — network tools are blocked. |

### Narrowing

The line never exceeds the width pi hands it — a line that overflows corrupts the whole frame rather than just wrapping. Each segment has three gears: full text, a shorter `compact` form, then gone. As the terminal narrows they downshift and drop in priority order:

```
/help → branch → unarmed scope → model → coverage → context → findings → blockers → engagement
```

Anything without a priority — the wordmark, an armed gate — is mandatory and survives to the last column. Widths are measured with pi-tui's ANSI- and wide-character-aware measure, so CJK and emoji in an engagement name are counted correctly.

Other extensions' statuses are not swallowed: they are carried on a second line, exactly as pi's own footer does.

## The engagement panel

**Shown by default.** A side rail with the whole ledger: coverage, scope, surface, hypotheses, findings, and anything blocked. State you have to summon is state you check less often than you should, so it is up from the first frame. `/panel` toggles it, `alt+p` does the same without leaving the editor, and `pired --no-panel` starts without it.

```
╭─ ⦿ acme-webapp ──────────────────────────────────────╮
│  pentest · web application                           │
│                                                      │
├─ needs you ──────────────────────────────────────────┤
│  ! Test the password-reset flow against live email?  │
│                                                      │
├─ coverage ───────────────────────────────────────────┤
│  ███████████████░░░░░░░░░ 62%                        │
│  105 of 170 cells · 65 gaps                          │
│  ▲ 7  ● 98  ◐ 3  ⊘ 2                                 │
│                                                      │
├─ scope ──────────────────────────────────────────────┤
│  ● authorized enforce                                │
│  domains 1 · cidrs 1                                 │
│                                                      │
├─ surface ────────────────────────────────────────────┤
│  host                  4  endpoint             31    │
│  param                88  service               6    │
│                                                      │
├─ hypotheses ─────────────────────────────────────────┤
│  ▲ confirmed                                      7  │
│  ● refuted                                       98  │
│  ◐ testing                                        3  │
│                                                      │
├─ findings ───────────────────────────────────────────┤
│  ⬤ crit 1  ⬤ high 2  ⬤ med 3                         │
│  ▸ SQLi in /api/transfer amount                      │
│  ▸ IDOR on /api/accounts/{id}                        │
│                                                      │
│  12 evidence files                                   │
│                                        alt+p to hide │
╰──────────────────────────────────────────────────────╯
```

It is anchored top-right and capped at half the screen height, so it covers older, already-read transcript rather than the live region you are actually reading. It never takes the keyboard.

The dim hint on the last row is reserved before the sections are laid out, so it survives even when the panel is full — the moment you most want to dismiss a panel is the moment it is most in the way. It is also **platform-aware**: `alt+p to hide` where the terminal sends Meta, and `/panel to hide` on macOS, where Option+P types `π` instead unless the profile is configured otherwise. A panel shown without being asked for must name an exit that works on the machine reading it. See [On macOS, `alt+p` may not reach pired](commands.md#on-macos-altp-may-not-reach-pired).

Full reference, including the other two placements and rendering it outside the TUI: **[The engagement panel](panel.md)**.

## The coverage view

`/coverage` opens a centred overlay with the full matrix: one row per vulnerability class, with a bar of per-element cells.

```
⦿ coverage · acme-webapp                                   51%

Broken access cont  ●●●▲●●········                        6/14
SQL injection       ●●●●●●●●●●····                       10/14
SSRF                ●●●···········                        3/14
Cross-site scripti  ●●●●●●●●●●●●●●                       14/14
Exposed secrets     ●●●⊘··········                        3/14

● clear  ▲ vulnerable  ◐ testing  ⊘ blocked  · untested
70 cells · 34 gaps                                esc to close
```

A bar rather than a true grid, because a bar simply shortens as the surface grows while a grid would have to drop whole columns. Each row ends in *settled / askable* for that class — `n/a` cells hold their slot in the bar so columns stay aligned, but they are out of the denominator, exactly as they are out of the coverage percentage.

When the surface is wider than the bar, the overflow is marked inside the bar (`+18`) rather than past it. When the terminal is too narrow for bars at all, rows fall back to counts alone. Press `q`, `Esc`, or `Enter` to close.

Two empty states are worth knowing, because they are diagnostic:

- `no checklist seeded for this engagement` — no checklist template matched the target type.
- `no surface recorded yet — run recon, or record inventory` — the agent has recorded findings but no inventory, so there is nothing to be covered *of*. See [Coverage](coverage.md).

## Findings in the transcript

`record` is the only tool whose result pired renders itself. A recorded finding is the engagement's actual product, so its severity is the first thing in the line rather than generic tool output:

```
⦿ CRITICAL  SQL injection in /api/transfer amount parameter
```

Everything else `record` writes falls back to the tool's own dim summary. If the rendering throws for any reason it degrades to that summary — presentation must never break the transcript.

## Blocker dialogs

The harness is built never to stall: when the agent needs an operator decision it parks a `blocker` and routes around it via `recall next`. That only works if the blocker reaches a human — otherwise *"never stall"* quietly becomes *"never finish"*.

So the moment a blocker is recorded, pired asks. The dialog is chosen from the blocker's shape:

| Blocker | Dialog |
|---|---|
| `blockerType: "approval"` | A yes/no confirm. Nothing is pre-selected: this is the destructive-action case, where the wrong default is the expensive one. |
| Has `options: [...]` | A select, with `skip for now` appended. |
| Anything else | A free-text input. `credential-request` is prompted as a value stored in the workspace. |

The answer is written back to the same blocker record (`answer`, `answeredAt`, `answeredBy`), so the ledger stays the single source of truth and a resumed session sees the decision. Dismissing a dialog leaves the blocker open, which is the correct outcome — it was not answered. A dialog that fails never takes the session with it.

## Scope refusals

When the gate blocks a tool call, the refusal reaches the model as a tool result *and* the operator as a warning notification:

```
⛨ blocked: Out-of-scope target(s): evil.example. Only authorized targets in the engagement scope may be tested.
```

Both halves matter. A call that is silently blocked is indistinguishable from the agent simply choosing not to act, which is exactly the confusion that makes an operator stop trusting the gate.

## Working indicator, thinking, and window title

- **Spinner** — a red braille cycle (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80 ms, inked in the theme accent and re-inked on theme change.
- **Thinking** — hidden reasoning is labelled `thinking`. Depth is pi's, set with `--thinking` (the `pired` launcher defaults to `high`).
- **Window title** — set to `pired · <engagement>`, so a tab or a tmux window is identifiable when several engagements are open.

## Glyph vocabulary

One glyph means one thing everywhere in the tool — panel, coverage matrix, and status line all draw from the same set.

| Glyph | Meaning |
|---|---|
| `●` | clear — a cell settled by a refuted hypothesis |
| `▲` | vulnerable — settled by a confirmed hypothesis |
| `◐` | testing — in flight |
| `⊘` | blocked — waiting on an operator |
| `·` | not tested |
| `–` | n/a — the class does not apply to that element |
| `⦿` | the engagement, and a recorded finding |
| `⛨` | the scope gate |
| `⬤` | a severity tally |
| `▸` | a recent finding |
| `!` | something that needs you |

Colour carries meaning only — severity and outcome — never decoration. Everything structural is dim.

## Headless modes

`ctx.mode !== "tui"` disables the whole UI layer. In print (`-p`), RPC, and JSON modes:

- The status line is not installed; state is published through pi's `setStatus` instead, which is what pi's own footer renders.
- `/coverage` prints a one-line summary (`coverage 62% · 170 cells · 65 gaps`) instead of opening an overlay.
- Blocker dialogs do not fire. Blockers accumulate in the ledger and can be read with `recall blockers`, or with `pired-state --json`.
- `/findings` behaves identically — it writes Markdown to the workspace either way.

## The engagement browser

`/surface` and `/hypotheses` open the same browser at different entry points. The panel shows counts; this shows the records behind them.

```
surface · airflow-ftxin0                        6 elements · 25/45 settled
──────────────────────────────────────────────────────────────────────────
▸ endp DELETE /api/v2/pools              ▲·●–◐·●⊘●●  5/9
  endp GET /api/v2/dags                  ●●▲·●–◐·●⊘  5/9   ★1
  host airflow.local                     ––––––––––  0/0
──────────────────────────────────────────────────────────────────────────
↑↓ move · ⏎ open · tab hypotheses · q close
```

Rows are ordered **least-settled first** — the reason to open this view is to find what nothing has touched. An element with no applicable class sorts last: `0/0` is not the most neglected row in the engagement, it is a row with no work in it.

`⏎` on an element lists the checklist against it, one row per class, carrying the hypothesis that settled the cell:

```
▸ ● authz          role check enforced before the DAG list is returned
  ▲ ssrf           vulnerable · no hypothesis recorded
  · injection      not tested
  – path-traversal does not apply
```

A row never contradicts its glyph. Where a cell is settled but no hypothesis is recorded behind it, the row says so rather than reporting the cell untested.

`/hypotheses` lists them flat, with `a` / `c` / `r` / `o` filtering to all, confirmed, refuted, or open. **The refuted ones are the point.** Confirmed hypotheses become findings; refuted ones are the evidence that everything else was checked — the difference between "we found three bugs" and "we tested 174 hypotheses across 10 endpoints and three held". `⏎` opens one in full: statement, class, target, method, evidence path, and the finding it produced.

### Keys

| Key | Does |
|---|---|
| `↑` `↓` / `k` `j` | move |
| `PgUp` `PgDn` | page |
| `g` `G` / `Home` `End` | first, last |
| `⏎` `→` `l` | drill in |
| `Esc` `←` `h` | back, and out of the browser at the top level |
| `Tab` | switch between surface and hypotheses, keeping the filter |
| `a` `c` `r` `o` | filter all / confirmed / refuted / open |
| `q` | close |

Outside the TUI — `--print`, RPC, JSON — both commands report the tallies as a notification instead, so a headless run is told what it would have seen.

## Filling the terminal

pi renders **inline in the scrollback** by default, so the editor sits after the last output rather than on the terminal's final row, and there is blank space beneath the whole UI. That is pi's `regular` TUI mode, and it keeps the conversation in scrollback where a normal shell leaves it.

To pin the layout to the terminal instead:

```bash
pired --fullscreen
```

which passes `--tui-mode fullscreen` to pi and takes the alternate screen. The editor then sits on the last row, the status line under it, and the panel rail runs the full height on the right — which is the layout the rail was drawn for.

The trade is scrollback: the alternate screen is discarded on exit, so the conversation does not stay in the terminal's history.

## The welcome banner

A session opens with the mark, the engagement it is about to work on, and the four commands that open the views:

```
  ⦿  p i r e d                          security engagement harness
  ──────────────────────────────────────────────────────────

  engagement   airflow-ftxin0
  profile      review · scope enforce
  model        qwen3.8-27b
  recorded     41 surface · 12% covered · 2 findings

  /surface   /hypotheses   /coverage   /panel
```

`recorded` appears only when the engagement already holds work — a fresh one showing `0 surface · 0% covered` reads as a failed run rather than a starting point. The tagline drops before anything else as the terminal narrows, and under 28 columns only the mark and the name remain.

It is a **transcript entry**, not a widget: written once, scrolled away like any other, and — being a custom entry — never part of the model's context, so the greeting costs no tokens. There was a banner widget once and removing it was right; it held layout forever to repeat a brand the status line already carries.

Turn it off with `--pired-banner off`.

The banner also **reserves the height the panel occupies**. The panel is a floating overlay anchored top-right — it draws over whatever is beneath it, and pi owns the layout root, so the editor cannot be moved out of its way. In pi's inline mode the editor sits immediately after the last content, which on a fresh session put it around row 13, inside a panel spanning rows 1 to 21:

```
  ⦿  p i r e d               │  review · source audit               │
  ───────────────────────────│                                      │
  engagement   pired         ├─ coverage ───────────────────────────┤
─────────────────────────────│  ░░░░░░░░░░░░░░░░░░░░░░░░ 0%         │   ← the editor,
─────────────────────────────│  0 of 76 cells · 76 gaps             │     cut in half
```

The reservation is derived from the rail's own `maxHeight` and offset, so changing `PIRED_RAIL_HEIGHT` moves both together. It is zero when the panel is off, and capped to leave room for the editor and status line so a short terminal is never filled with blank lines — pushing the editor off the bottom would be a worse bug than the overlap it fixes.

### A clean start

pi prints a startup header listing every skill, prompt, extension and theme it loaded. pired ships 39 skills, so that header is a wall of text — and because the panel is a floating overlay anchored top-right, the wall ends up **behind** it, leaving both unreadable:

```
[Skills]                     │  0 of 76 cells · 76 gaps             │
  api-graphql, api-recon, api├─ scope ──────────────────────────────┤
network-post-exploit-notes, n│  ● authorized off                    │
```

pi already has the fix, as a setting rather than a flag:

```json
// ~/.pi/agent/settings.json
{ "quietStartup": true }
```

Default is `false`. `pi --verbose` shows the header again for a single run without changing the setting.

pired does **not** set this for you. It is a global pi setting that affects every session, pired or not, and a launcher that quietly rewrites your editor's configuration is the kind of thing that earns a tool a bad reputation. The banner covers the orientation the header was providing — engagement, profile, model, and the commands worth knowing — so turning it on is a preference, not a repair.

Worth knowing before you do: pi ships no `/skills` command, so the startup header is the only place that listing appears. Turning it off means checking `~/.pi/agent/settings.json` when you want to confirm what loaded.
