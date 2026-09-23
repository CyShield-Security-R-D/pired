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
| `pired` | The wordmark: `pi` dim + `red` in the theme’s red role. Never dropped. |
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

**Shown by default.** A side rail with the whole ledger: coverage, scope, surface, hypotheses, findings, and anything blocked. State you have to summon is state you check less often than you should, so it is up from the first frame. `/panel` toggles it, `F6` does the same without leaving the editor, and `pired --no-panel` starts without it.

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
│  ● authorized · gate enforce                         │
│  domains 1 · cidrs 1                                 │
│                                                      │
├─ surface ────────────────────────────────────────────┤
│  host                  4  endpoint             31    │
│  param                88  service               6    │
│                                                      │
├─ hypotheses ─────────────────────────────────────────┤
│  ▲ confirmed                                      3  │
│  ● refuted                                       21  │
│  ◐ testing                                        1  │
│                                                      │
├─ findings ───────────────────────────────────────────┤
│  ! 1 confirmed, not written up                       │
│  ⬤ crit 1  ⬤ high 2  ⬤ med 3                         │
│  ▸ SQLi in /api/transfer amount                      │
│  ▸ IDOR on /api/accounts/{id}                        │
│                                                      │
│  12 evidence files                                   │
│                                  F7 expand · F6 hide │
╰──────────────────────────────────────────────────────╯
```

**Two sections, two units.** The coverage section counts **cells** — one weakness class asked of one recorded element — and the hypotheses section counts **claims**, the distinct pieces of reasoning behind them. `record` takes lists for `target` and `class` and writes the cross product, so one argument about authentication put to 44 endpoints is 44 cells and one claim. Reporting both under the word "confirmed" overstated what had been found by roughly eight times on a real engagement, which is why the headings are load-bearing: the section is what says which unit you are reading. See [ADR-001](decisions.md#adr-001--the-panel-counts-claims-the-coverage-bar-counts-cells).

The `!` line above the severity tally counts confirmed claims no finding has been written for. Confirming settles a coverage cell; only a finding reaches the client, and the two are separate acts — an engagement can sit at a full hypotheses ledger with `none recorded` under it. `/hypotheses` and its `u` filter is where you go from there. See [ADR-004](decisions.md#adr-004--confirmed-work-that-has-not-reached-the-report-is-surfaced-not-enforced).

It is anchored top-right and capped at half the screen height, so it covers older, already-read transcript rather than the live region you are actually reading. It never takes the keyboard.

The dim hint on the last row is reserved before the sections are laid out, so it survives even when the panel is full — the moment you most want to dismiss a panel is the moment it is most in the way. It is also **platform-aware**: `F7 expand · F6 hide` on Windows/Linux, and `/maximize` / `/panel` on macOS, where Option+P types `π` unless configured otherwise. A panel shown without being asked for must name an exit that works on the machine reading it. See [On macOS, `alt+p` may not reach pired](commands.md#on-macos-altp-may-not-reach-pired).

Full reference, including the other two placements and rendering it outside the TUI: **[The engagement panel](panel.md)**.

## The coverage view

`/coverage` opens the matrix as a browsable view: one row per vulnerability class, with a bar of per-element cells.

```
╭─ ⦿ coverage · acme-webapp ─────────────────────────────────────────╮
│                                           51% · 5 classes · 34 gaps │
├─────────────────────────────────────────────────────────────────────┤
│ ▸ Broken access control          ●●●▲●●········  6/14               │
│   SQL injection                  ●●●●●●●●●●····  10/14              │
│   SSRF                           ●●●···········  3/14               │
│   Cross-site scripting           ●●●●●●●●●●●●●●  14/14              │
│   Exposed secrets                ●●●⊘··········  3/14               │
├─────────────────────────────────────────────────────────────────────┤
│ ↑↓ move · ⏎ open class · tab surface · R reload · q close           │
╰─────────────────────────────────────────────────────────────────────╯
```

A bar rather than a true grid, because a bar simply shortens as the surface grows while a grid would have to drop whole columns. Each row ends in *settled / askable* for that class — `n/a` cells hold their slot in the bar so columns stay aligned, but they are out of the denominator, exactly as they are out of the coverage percentage.

Press `⏎` on a class to open it **down the surface**: one row per element, that class's cell, and the hypothesis that settled it — or `no hypothesis recorded` where a cell is settled with nothing behind it, which is worth seeing.

```
╭─ ⦿ Broken access control · acme-webapp ────────────────────────────╮
│                                     4/4 settled across 4 elements  │
├─────────────────────────────────────────────────────────────────────┤
│ ▸ ▲ POST /api/admin/report    admin report accepts any bearer token │
│   ● POST /api/profile/import  clear · no hypothesis recorded        │
│   ▲ GET /api/transactions     user_id is not scoped to the caller   │
├─────────────────────────────────────────────────────────────────────┤
│ ↑↓ move · ⏎ open · esc back · tab surface · q close                 │
╰─────────────────────────────────────────────────────────────────────╯
```

`tab` cycles coverage → surface → hypotheses → findings, so all four are one view with one chrome. The same matrix, laid out to fit a fixed number of rows and counting what it dropped, is what fills the [welcome screen](#the-welcome-screen) and what `pired-state` prints.

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

New blockers produce a notification once per session and appear in the panel. They do not interrupt an active form or block the agent on an unanswered modal. Open `/blockers` and press `a` to answer; the dialog is chosen from the blocker’s shape:

| Blocker | Dialog |
|---|---|
| `blockerType: "approval"` | Explicit `skip for now`, `Approve`, `Deny` choices. Skip is selected first; Escape leaves the blocker open. |
| Has `options: [...]` | A select, with `skip for now` appended. |
| Anything else | A free-text input. `credential-request` is prompted as a value stored in the workspace. |

The answer is written back to the same blocker record (`answer`, `answeredAt`, `answeredBy`), so the ledger stays the single source of truth and a resumed session sees the decision. Dismissing a dialog leaves the blocker open, which is the correct outcome — it was not answered; [`/blockers`](#what-needs-you) is the way back to it. A dialog that fails never takes the session with it.

And the answer reaches the **agent**. `recall blockers` lists only the open ones, so an answered blocker was a row nothing would read again: the agent parked a question, routed around it, and kept routing around it after it had been settled. Each decision is now put in front of the agent on its next request — once, then dropped, because an answer that is repeated in every request for the rest of the session stops being news and becomes furniture.

## Scope refusals

When the gate blocks a tool call, the refusal reaches the model as a tool result *and* the operator as a warning notification:

```
⛨ blocked: Out-of-scope target(s): evil.example. Only authorized targets in the engagement scope may be tested.
```

Both halves matter. A call that is silently blocked is indistinguishable from the agent simply choosing not to act, which is exactly the confusion that makes an operator stop trusting the gate.

## Working indicator, thinking, and window title

- **Spinner** — a subdued blue braille cycle (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80 ms, inked in the theme accent and re-inked on theme change.
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
- Blocker dialogs do not fire and `/blockers` cannot open a browser, so it reports what is waiting as a notification instead. Blockers can also be read with `recall blockers`, or with `pired-state --json`.
- `/report` behaves identically — it writes Markdown to the workspace either way.

## The engagement browser

`/surface`, `/hypotheses`, `/findings` and `/blockers` open the same browser at different entry points. The panel shows counts; this shows the records behind them.

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

`/findings` lists them worst severity first — recording order buries a critical under six info rows. `⏎` opens one in full: the title, then severity, CWE, class, target, status, description, repro steps and every evidence path, scrolling with `↑↓` when it runs past a screenful. `Tab` cycles the four views: coverage → surface → hypotheses → findings.

From the maximized panel, `⏎` hands off here. The panel is a dashboard — it tells you there are twelve findings; reading one properly is this view's job, and building a second selectable list inside a fixed layout would only duplicate it.

`/hypotheses` lists them flat, with `a` / `c` / `r` / `u` / `o` filtering to all, confirmed, refuted, unwritten, or open. A claim asked of many targets is written once with `↳` under it, because `record` fans one piece of reasoning across every target it applies to and the sentence would otherwise repeat down forty-four rows. **The refuted ones are the point.** Confirmed hypotheses become findings; refuted ones are the evidence that everything else was checked — the difference between "we found three bugs" and "we tested 174 hypotheses across 10 endpoints and three held". `⏎` opens one in full: statement, class, target, method, evidence path, and the finding it produced.

### What needs you

`/blockers` is the fifth view, and the only one whose rows are addressed to a person rather than describing the target. Every other list is a record of what the agent did; this one is the agent waiting.

```
⦿ blockers · acme-webapp                                 3 open · 1 answered
──────────────────────────────────────────────────────────────────────────
▸ ? high    scope clarification Is payments.acme.io in scope? It resolves …
  ? high    approval            Run the destructive delete PoC on /api/v2…
  ? medium  decision            Staging replica or prod?
  ✓ high    credential request  Admin credentials for the panel?
──────────────────────────────────────────────────────────────────────────
↑↓ move · ⏎ open · a answer · x dismiss · f open/all · tab coverage · q close
```

Waiting first, worst first, and inside a priority the longest wait at the top: a question parked an hour ago sitting under one parked a second ago is the wrong way round. `✓` is answered, `·` dismissed; both keep their place in the ledger and their answer in the detail, because what was decided three weeks ago is what a client asks about three months later.

`⏎` opens one in full — context, the options offered, the work ids it gates, and the answer with who gave it and when. `a` answers the row under the cursor from either the list or the detail; `x` dismisses it, for a question that is no longer a question; `f` hides everything already settled. Answering closes the overlay for the dialog and comes back to where you were, because a dialog cannot open under an overlay that owns the keyboard.

This replaced a forced march through those dialogs, one per open blocker. A modal shows one question, out of order, with no way to see what else is waiting, how long it has waited, or what was decided last time — which is a poor way to read anything, and worse when the answer has consequences.

### Keys

| Key | Does |
|---|---|
| `↑` `↓` / `k` `j` | move |
| `PgUp` `PgDn` | page |
| `g` `G` / `Home` `End` | first, last |
| `⏎` `→` `l` | drill in |
| `Esc` `←` `h` | back, and out of the browser at the top level |
| `Tab` / `Shift+Tab` | cycle views forward / backward, keeping the filter |
| `R` | refresh from disk, keeping the selected record |
| `a` `c` `r` `u` `o` | filter all / confirmed / refuted / unwritten / open (hypotheses) |
| `a` `x` `f` | answer, dismiss, waiting/all (blockers) |
| `q` | close |

Escape returns to the same list position. The row budget includes the glyph legend, so the selected row remains visible even in short terminals. Narrow views keep the exit hint first.

Outside the TUI — `--print`, RPC, JSON — the browser commands report the tallies as a notification instead, so a headless run is told what it would have seen.

## Filling the terminal

pi renders **inline in the scrollback** by default, so the editor sits after the last output rather than on the terminal's final row, and there is blank space beneath the whole UI. That is pi's `regular` TUI mode, and it keeps the conversation in scrollback where a normal shell leaves it.

To pin the layout to the terminal instead:

```bash
pired --fullscreen
```

which passes `--tui-mode fullscreen` to pi and takes the alternate screen. The editor then sits on the last row, the status line under it, and the panel rail runs the full height on the right — which is the layout the rail was drawn for.

The trade is scrollback: the alternate screen is discarded on exit, so the conversation does not stay in the terminal's history.

## The welcome banner

A session opens with the wordmark, the engagement it is about to work on, and the commands that open the views:

```
  █▀█ █ █▀█ █▀▀ █▀▄
  █▀▀ █ █▀▄ █▀▀ █ █
  ▀   ▀ ▀ ▀ ▀▀▀ ▀▀                          security assessment harness
  ──────────────────────────────────────────────────────────

  engagement   airflow-ftxin0
  directory    …/clients/acme/services/api
  profile      review · scope enforce
  model        qwen3.8-27b

  /surface   /hypotheses   /findings   /coverage   /panel
```

**It says who you are, not how you are doing.** With the panel up there is a `recorded` row's worth of state — `41 surface · 12% covered · 2 findings` — that the rail is already carrying and the coverage matrix under the banner is carrying again, so the banner drops it. It comes back under `pired --no-panel`, where nothing else on the screen would say it.

That row is not free. The welcome entry draws the matrix only when the rows left under the banner can hold it, so the banner's height *is* the matrix's budget — and on a 120-column terminal the extra rows were the difference between the matrix and five blank lines. See [ADR-019](decisions.md#adr-019--the-banner-does-not-repeat-what-the-rail-is-already-saying).

Three rows of half blocks, not six of full ones. Block capitals are 34 columns wide and the space beside the panel is 27, so a full-height font could not sit next to the rail at all — and it reads as retro besides. The two tones are not decoration: the name is literally "pi" + "red", so red lands on the second half and the wordmark explains itself. The tagline is set against the art's **baseline** rather than its top, where it reads as a lockup instead of two unrelated things sharing a line.

### Sharing the terminal with the panel

The panel is a floating overlay: pi hands the banner the full terminal width and then paints the rail over its right-hand end. Left alone, that sliced the wordmark, the facts and the command list at the column where the rail begins.

So the banner takes only the columns left of the panel, and drops what does not fit there:

```
  █▀█ █ █▀█ █▀▀ █▀▄          ╭─ ⦿ pired ─────────────────────╮
  █▀▀ █ █▀▄ █▀▀ █ █          │  review · source audit        │
  ▀   ▀ ▀ ▀ ▀▀▀ ▀▀           │                               │
                             ├─ coverage ────────────────────┤
  ─────────────────────────  │  ░░░░░░░░░░░░░░░░░░░░░░ 0%    │

  pired                      │  0 of 76 cells · 76 gaps      │
  review · scope off         │                               │
  qwen3.8-27b                ├─ scope ───────────────────────┤
  4 surface · 7 findings     │  ● authorized off             │

  /surface  /hypotheses      ├─ surface ─────────────────────┤
  /surface   /hypotheses        │  host   1  endpoint   3  │
  /findings  /coverage          │                          │
  /panel                        │                          │
```

The label column goes first — `engagement` beside `pired` spends eleven of twenty-seven columns explaining what the value already says. Coverage goes next, because the panel is rendering the same number three columns to the right. The commands wrap rather than running off the edge.

`recorded` appears only when the engagement already holds work: a fresh one showing `0 surface · 0% covered` reads as a failed run rather than a starting point.

`directory` is the working directory, collapsed against home. The engagement name defaults to that directory's basename, so on its own it cannot tell two checkouts of the same repository apart — and which tree an engagement is pointed at is the first thing to be sure of. A long path is cut from the front, since `…/acme/services/api` identifies more than `~/clients/acme/…` does. It is dropped in the narrow layout, where every row counts and the path mostly repeats the name above it. Note that the ledgers do **not** live there: they are under `~/.pired/engagements/<name>`, or wherever `workspace` in the scope file points.

### Clearing the editor

The banner also **reserves the height the panel occupies**. pi owns the layout root, so the editor cannot be moved out of an overlay's way, and in inline mode it sits immediately after the last content — on a fresh session that put it around row 13, inside a panel spanning rows 1 to 21. Padding the banner to the panel's height is what puts the editor below it.

The reservation is the height the panel *actually draws*, not the height it is allowed to draw: a fresh engagement's panel is a third of a busy one's, and reserving the cap regardless is a wall of blank rows. It is zero when the panel is off, and capped to leave room for the editor and status line — filling a short terminal with blank lines would push the editor off the bottom, which is worse than the overlap it fixes.

### What goes in those rows

The banner sits at the top of them, and the rows under it hold **the coverage matrix** — the same `checklist × surface` matrix `/coverage` browses, laid out to fit a fixed number of rows, in the same box the rail is drawn in, indented to the wordmark's margin and ending where the banner's rule ends.

Blank rows were the wrong answer to a question the layout was already asking. The reservation exists whatever we do, the matrix is the harness's whole thesis, and a welcome screen that shows where the work stands is worth more than one that shows a wordmark and a hole. On an engagement with no surface yet it says so in the same box — *no surface recorded yet — run recon, or record inventory* — which is the one thing a new engagement needs told.

It fits itself to the rows it is given: classes fill what is left after the legend and the summary, and any that do not fit are counted on a line of their own rather than dropped, since silently showing three classes out of nine would misreport the work. Under seven rows there is no room for a box worth drawing, so the banner pads as it used to — which is what a narrow terminal gets, its banner being five rows taller.

It stops one row short of the reservation, which is the reservation's own margin before the editor. Entry line *n* lands beside rail line *n* — the rail's offset from the top of the screen is the same offset the transcript starts at, so it cancels — and the two boxes therefore close on the same row when the entry fills everything but that margin. Near-alignment reads worse than none at all, so this is arithmetic rather than a guess; it took two screenshots to settle, because reasoning about it from the code got the offset backwards twice.

On a conversation of any length the transcript fills that area anyway; this is only what the welcome screen looks like before it does.

It is all a **transcript entry**, not a widget: written once, scrolled away like any other, and — being a custom entry — never part of the model's context, so the greeting costs no tokens. There was a banner widget once and removing it was right; it held layout forever to repeat a brand the status line already carries.

Turn it off with `--pired-banner off`.

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
