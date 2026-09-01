# Testing

Two suites, and they answer different questions.

| | `npm test` | `npm run assay` |
|---|---|---|
| Asks | does the code do what it says | does the *harness* find bugs |
| Shape | unit tests over pure modules | probes over fixtures, with a ratchet |
| Runs in | milliseconds, no model | seconds, no model (T0 tier) |
| Lives in | `*.test.ts` beside the module | `eval/` |

`npm run check` runs both, plus `tsc --noEmit`. That is the gate.

## What is tested, and what deliberately is not

Coverage is measured over what ships — `core/`, `extensions/`, `bin/`, and the
grader — and enforced as a **ratchet** in `vitest.config.ts`: the floors sit
just under what is measured today, so the suite fails when coverage goes
backwards rather than when it fails to reach an aspiration. Raise them when you
raise the number; the same discipline as `eval/ratchet.json`.

Two files are excluded, and only two. `bin/pired.mjs` and `bin/pired-state.mjs`
are shells: read argv, touch the disk, spawn or print. Every decision they used
to make now lives in `bin/launch.mjs` and `bin/state.mjs`, which are measured at
~99%. What is left is the IO itself, and a test that mocked all of it would
assert only that the mocks were called.

`extensions/pired.ts` is *not* excluded, and it drags the global number down —
it is ~2000 lines of TUI rendering and pi wiring around a small amount of logic.
The honest way to raise that number is to keep moving the logic into `core/`
where it can be reached, which is what `planExtraction` and `applyPlan` are: the
extraction write path used to be a hundred lines of branching inside the
extension, where nothing could test which cells a verdict settles or whether a
rejected finding still settled a cell. Excluding the file would hide the same
gap while reporting a better number.

`extensions/hosts.ts` is the shape that argument asks for: the host wizard is a
sequence of decisions, so it lives in `extensions/lib/provider-wizard.ts` driven
by a four-method prompter, and the extension is the wiring that binds it to pi's
`/login` callbacks on one side and pi's dialogs on the other. Both are tested —
the wizard against a scripted transcript, the extension against the shapes pi
really uses, including a login prompt that *rejects* when dismissed rather than
resolving undefined.

## Where the interesting tests are

Most modules are tested the obvious way. These are the ones worth reading first,
because each exists to stop a specific failure that already happened:

- **`core/extract.test.ts`** — the second pass. What the extractor's plan implies
  (`planExtraction`) and what running it does (`applyPlan`): a targetless
  refutation fans across the surface but a targetless *confirmation* settles
  nothing; `not-considered` writes nothing at all; a rejected finding takes its
  derived hypothesis down with it, so no cell is ever confirmed with nothing in
  the report behind it. Also the review window, which is shaped by the prefix
  cache — see [commands.md](commands.md#extraction-and-why-it-exists).
- **`eval/grade.test.ts`** — the grader, which decides every number the project
  reports about itself. A grader that is wrong in the agent's favour does not
  look like a bug, it looks like a good result. The cases are written around the
  miss taxonomy, and around `validateKey` refusing a "clear" cell with no reason
  — the rule that stops *we found nothing* being recorded as *there is nothing*.
- **`bin/launch.test.ts`** — the launcher, which shipped two bugs in a fortnight
  (pi unreachable on Windows; pi's own flags needing a redundant `--`) while
  being the only shipping code with no test at all. Both are pure functions of
  argv and a platform string, and both are now pinned, including the cmd.exe
  quoting that keeps `C:\Users\Jane Doe` and a `&` in a prompt from becoming a
  second command.
- **`bin/state.test.ts`** — the `pired-state --json` shape, which is a published
  interface. A field quietly renamed breaks somebody's tmux pane and nothing
  else in the project would notice.
- **`extensions/hosts.test.ts`** — both doors into the host wizard, driven
  through the shapes pi actually uses. The `/login` one is the reason it exists:
  pi builds that list from registered providers, calls the chosen one's
  `login()` with callbacks that reject on dismissal, and expects a credential
  back — none of which is obvious from the types, and all of which the entry
  rests on. It also pins the two things a wrong wiring loses silently: the
  mirror an extension-less subagent resolves from, and the `0600` on a file that
  holds a client's token.
- **`extensions/lib/host.test.ts`** — the error semantics, not the delegation.
  The workspace decides "no engagement yet" from a swallowed `ENOENT` and the
  lock decides "someone else holds it" from a swallowed `EEXIST`; a swallowed
  errno is the kind of thing that becomes a wrong answer rather than a crash.

## Writing one

Test the module, not the extension. If a decision is hard to reach, that is the
finding — move it into `core/` as a pure function and test it there. The comment
on `planExtraction` says it plainly, and it was written after the fact:

> every one of those was a bug that hid in the extension where nothing could
> test it

Name the case after the behaviour and its reason, not after the function
(`"refuses to fan a targetless CONFIRMATION anywhere — 'present somewhere' is
not a cell"`), and put the failure it prevents in a comment when the reason is
not obvious from the name. A test whose name only says `works correctly` tells
the next person nothing about what breaks if they delete it.
