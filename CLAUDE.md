# pired — working notes for agents

A security assessment harness for consultants, shipped as a [pi](https://pi.dev) extension:
engagement workspace, scope gate, security-operator prompt, and two tools (`record` / `recall`).
It owns no scanners; it drives the ones already on the box through `bash`.

## Read these before changing anything

- **[docs/decisions.md](docs/decisions.md) — architecture decisions.** Why the system is shaped the
  way it is at the points where it could reasonably have gone another way, including what was
  rejected and why. **Add an entry when you make a decision a later reader would otherwise
  re-litigate**, and reference the ADR number in the commit.
- [docs/architecture.md](docs/architecture.md) — the ports-and-adapters shape.
- [FORMAT.md](FORMAT.md) — the on-disk ledger format.

## The one structural rule

`core/` imports **nothing** — not pi, not a library, not `node:fs`. Everything from the outside world
arrives on a port (`Fs`, `Clock`, `Ids`). This is what lets the whole core be unit-tested with fakes
and no real I/O, and what lets the same renderer draw the panel in the TUI, in a tmux pane, and in a
test. Host wiring lives in `extensions/`; node services live in `extensions/lib/`.

## Where logic belongs

| Put it here | Not here | Why |
|---|---|---|
| `core/*.ts` | `extensions/pired.ts` | The extension is ~2400 lines of TUI and pi wiring and drags the global coverage ratchet down. The stated remedy is to keep moving logic out, not to exclude the file. |
| `bin/launch.mjs`, `bin/state.mjs` | `bin/pired.mjs`, `bin/pired-state.mjs` | The entry scripts are excluded from coverage on the grounds that every decision lives in the tested modules. See ADR-006. |

## Tests

`npm run check` = typecheck + vitest + coverage ratchets + the eval assay. Ratchets are floors set
just under what is measured today, so the suite fails when coverage goes *backwards*:

- `core/**` — 90 statements / 78 branches / 92 functions / 94 lines
- `bin/**/*.mjs` — 95 / 90 / 95 / 95

Tests sit beside their module as `<name>.test.ts`, imports carry explicit `.ts` extensions, and each
file declares its own small record builders — there are no shared fixtures. `core/testing/fakes.ts`
holds port fakes only. Test names are prose sentences describing the behaviour and usually the bug it
prevents; comments cite the shipped regression. Match that register.

## Prose voice

The docs and code comments explain the failure a choice prevents, often with measured numbers, and
avoid marketing register. Keep it. When a number is claimed, it should be one that was actually
measured — `research/` is the standard.
