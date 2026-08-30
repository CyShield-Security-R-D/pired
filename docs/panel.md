# The Engagement Panel

The panel is pired's view of the ledger — coverage, scope, surface, hypotheses, findings, and anything blocked — rendered from the workspace on disk rather than from anything the agent says.

It exists because the alternative is worse. Without it, the only way to see coverage is to ask the model to run `recall gaps` and to believe the answer. The ledger is the operator's artifact; it should not be reachable only through the thing it is meant to keep honest.

**It is shown by default** — state you have to summon is state you check less often than you should.

```
/panel          toggle it
alt+p           the same, without leaving the editor (see the macOS note below)
/panel coverage jump straight to a view
/panel next     cycle views
/panel off      close it
pired --no-panel  start without it
```

## Contents

- [Turning it off](#turning-it-off)
- [Placements](#placements)
- [Modes](#modes)
- [Sections](#sections)
- [Sizing](#sizing)
- [Outside the TUI: `pired-state`](#outside-the-tui-pired-state)
- [Where the data comes from](#where-the-data-comes-from)

## Turning it off

```bash
pired --no-panel                      # this session
pi -e …/pired.ts --pired-panel off    # invoking pi directly
```

`/panel` closes it for the session too, and it stays closed until you ask for it again.

## Placements

Three, in preference order. `/panel` picks the first; the others are explicit.

### The inline rail (default)

`/panel` or `alt+p`. A framed overlay pinned to the **top-right** of the TUI, at most half the screen tall.

It floats over the transcript rather than reflowing it — pi's layout root belongs to pi — so *where* it sits decides what it costs you. The newest output and the editor are at the bottom, which is the part you are reading; anchoring to the top covers older, already-read lines instead. `maxHeight` keeps a long panel from creeping down into the live region.

It is a view, not a prompt: it is created non-capturing and immediately unfocused, so it never takes a keystroke meant for the agent.

The frame carries the engagement name in its top edge, tmux-style, and a dim dismiss hint on the last row. That hint's row is reserved *before* the sections are laid out, so it cannot be squeezed out by a full panel — which is exactly when you would want it.

### The hint is platform-aware

| Platform | Hint |
|---|---|
| macOS | `/panel to hide` |
| everything else | `alt+p to hide` |

Terminal.app and iTerm2 send **Option+P as `π`**, not as Meta, so on a default Mac the shortcut never arrives and pressing it types a character into your prompt. A panel that appears without being asked for must name an exit that actually works on the machine reading it, so a Mac is told the command instead. The shortcut still fires wherever the terminal does send Meta — including on a Mac configured for it. See [Commands and keys](commands.md#on-macos-altp-may-not-reach-pired).

### The tmux pane

`/panel tmux`, when pired is running inside tmux. Splits a real pane beside the TUI (`split-window -h -d`, focus stays in the TUI) running `pired-state --watch`. Costs terminal width but reflows the TUI properly instead of covering it, and survives independently of the session. `/panel tmux` again closes it.

### The footer strip

`/panel footer`. The panel rendered above the status line, budgeted to 8 lines. It predates the rail and is kept because it needs neither a multiplexer nor screen real estate on the right.

## Modes

| Mode | Shows |
|---|---|
| `state` | Everything: coverage, scope, surface, hypotheses, findings. The default. |
| `coverage` | The coverage bar and cell counts alone. |
| `findings` | The severity tally and up to 12 recent findings. |
| `blockers` | Open operator questions, or `nothing blocked`. |

`/panel <mode>` switches and opens in one step — there is no state where naming a view leaves it hidden. `/panel next` cycles.

## Sections

**`needs you`** — open blockers, at most three plus a `+N more`. It sits directly under the header in every mode but `findings`, and is **never dropped for space**. A blocker is the one line that needs a human; losing it to a short terminal would defeat the point of showing it.

**`coverage`** — a bar, the settled/applicable count, gaps, and the per-status tally. See [Coverage](coverage.md) for what settles a cell.

**`scope`** — `● authorized` or `○ NOT authorized`, the gate mode, and how many targets of each kind are in scope.

**`surface`** — the recorded inventory by kind, in two columns so a wide surface does not run down the whole rail.

**`hypotheses`** — outcomes by count, right-aligned so the eye can scan the numbers without reading them.

**`findings`** — the severity tally, then recent finding titles (3 in `state`, 12 in `findings`).

**footer** — the evidence-file count, then the dismiss hint.

Sections are dropped from the bottom when space runs short. Blockers and the hint are the exceptions.

## Sizing

| Variable | Default | Meaning |
|---|---|---|
| `PIRED_RAIL_WIDTH` | scales with the terminal (see below), `64` (tmux) | Panel width in columns. Naming one wins outright. |
| `PIRED_RAIL_HEIGHT` | `50%` | Inline rail height: `N` rows or `N%` of the screen. Anything else falls back to `50%`. |

Below 24 columns the frame is dropped rather than mangled; below 12 the panel renders nothing at all. Every framed line is padded to exactly the panel width — a ragged right edge reads as a rendering bug rather than a style.

### The rail and the banner share the terminal

Both used to be fixed: 56 columns of rail, and the banner took what was left. That reads well at 85 columns, which is what it was designed at, and badly at either extreme — at 175 the rail was a sliver still truncating every finding title with sixty columns of nothing beside it, and at 70 it refused to shrink, so the banner gave up and the rail painted over the wordmark.

`core/layout.ts` holds the arithmetic, in one place and under test:

| Terminal | Rail | Banner |
|---|---|---|
| 60 | 32 | 26 |
| 70 | 42 | 26 |
| 85 | 56 | 27 |
| 120 | 56 | 62 |
| 175 | 67 | 106 |
| 400 | 88 | 310 |

The rail takes 38% of the screen, wants at least 56 columns and never exceeds 88 — a side panel that keeps growing stops being one — and yields below its preferred width rather than crowd the banner out. `PIRED_RAIL_WIDTH` overrides all of it: someone who names a width has a reason.

Two consequences inside the panel. Prose — a finding title — takes every column it is given, which is the point. Tables do not: a label and its count are capped to a 44-column measure, like the coverage bar's 24, because a table that grows with the screen puts "tech" at one edge and its "1" at the other. And the surface grid drops to one column until there are more than three kinds to spread.

The banner is a lockup, not a stretch: 72 columns wide wherever the terminal ends, with the tagline, the rule and the facts sharing one right edge. It picks its layout by measuring what fits rather than by a breakpoint — the old fixed 40 meant a 100-column terminal chose the labelled layout and then truncated its own last two rows.

## Outside the TUI: `pired-state`

The same panel, from the same code, rendered anywhere: a second terminal, a tmux pane, a status bar, a CI log.

```bash
pired-state                       # newest engagement, framed, 44 columns
pired-state --mode findings       # pick a view
pired-state --engagement acme     # pick an engagement
pired-state --watch --every 5     # redraw on an interval
pired-state --width 80 --lines 40 # size it
pired-state --no-frame            # drop the border
pired-state --json                # the underlying data, unrendered
```

With no `--engagement` it picks the most recently modified engagement under `~/.pired/engagements/`.

`--json` emits exactly the structure the renderer consumes — engagement, type, scope, coverage, surface, hypotheses, findings, recent findings, open blockers, evidence count — which is the supported way to drive your own status bar or dashboard.

## Where the data comes from

The panel reads the workspace ledgers and pired's own derived stats — the same `computeEngagementStats` and `computeCoverageView` the agent's `recall` uses. Nothing is threaded through the model.

`bin/pired-state.mjs` imports pired's `core/` directly rather than parsing the `.jsonl` files itself. An earlier version scraped the ledgers, which meant the panel and the TUI could disagree about the same engagement; going through the same derivation makes that impossible.

The renderer itself (`core/panel.ts`) is a pure module: colour, width measurement, and truncation are injected, so it renders identically in the TUI overlay, a tmux pane, and a unit test.

## Maximizing

`alt+m` (or `/maximize`) grows the rail to 70% width and 90% height and makes it scrollable. Press it again — or `esc` — to restore.

```
↑ ↓  /  k j      select a finding (scroll, when there are none)
⏎  →  l          read the selected finding in full
esc  ←  h        back to the list
PgUp PgDn        scroll a page
g G / Home End   first, last
alt+m / q        restore
```

Selecting a finding and pressing `⏎` replaces the list with that finding in full — severity, CWE, class, target, status, description, repro steps and every evidence path — **in the same frame**. The rail stays one surface: you never leave it to find out what a row meant, and there is no second overlay to discover.

The restored rail shows three findings and three blockers, because that is what fits. Maximized it shows **all** of them — height alone is not what makes a view readable, the content has to arrive too. A panel that grew to forty rows and still rendered three findings would scroll nothing and look like a rendering bug.

`↓ N more` sits on the bottom edge while there is content below. If nothing scrolls, there is genuinely nothing below: on a small engagement the whole panel already fits.

It is still a side panel, not a takeover. The transcript stays visible on the left, which is the point — you are usually reading the panel *against* something the agent just said.

Two behaviours worth knowing:

**It captures the keyboard only while maximized**, and toggling *rebuilds* the overlay rather than resizing it. `nonCapturing` is fixed when an overlay is created, and `unfocus()` only releases to the next *capturing* overlay — so a rail opened as a view can never be handed the keyboard by changing its options later. Maximizing tears the overlay down and opens a new one in the mode wanted.

**The rail answers for `alt+m` itself.** pi routes extension shortcuts through the editor, so while the maximized rail holds focus the registered shortcut never fires. Without the rail handling that key, maximize would be a toggle that only went one way. pi routes extension shortcuts through the *editor*, so while the rail holds the keyboard none of them reach their handlers — which is why the rail answers for `alt+m` itself, and why hiding a maximized panel with `alt+p` means pressing `esc` first.

**The size is a live read, not a re-render.** `ui.custom` resolves `overlayOptions` exactly once: the function form is called when the overlay is shown and never again. pi-tui, though, re-reads the fields of the object that resolution produced on every frame. So the rail hands pi a single object whose `width`, `maxHeight` and `nonCapturing` are getters over the current mode — that, and not the repaint, is what resizes a panel that is already open. Returning a fresh object from a function looks equivalent and silently does nothing after the first frame: the panel lays out a full screen of content into an overlay still capped at half of one, and pi slices off everything past the cap, including the `↓ N more` line that would have told you content was missing.

**Both frame edges stay pinned** while the body moves, so the box does not appear to lose its lid every time you scroll. An out-of-range offset is clamped rather than rejected — a held-down arrow key stops cleanly at the end instead of emptying the frame.
