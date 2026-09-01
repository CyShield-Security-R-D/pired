# Architecture

pired is a **ports-and-adapters** design with one governing constraint: the security engine has zero host imports.

```
core/          the security engine — no pi imports, no third-party, not even node builtins
extensions/
  pired.ts     the pi adapter: tools, scope gate, prompt, commands, UI
  hosts.ts     LLM providers: the "Add a custom provider…" entry in /login, and /provider
  lib/         node host services · core→pi tool bridge · provider registration
skills/        opt-in methodology (39)
checklists/    coverage class templates (4)
bin/           the launcher and the external panel renderer
themes/        the pired theme
eval/          the evaluation instrument
```

## Why the core has no imports

pired is deliberately an **adapter, not a fork**. The security logic — the ontology, the coverage model, the scope rules, the redaction, the prompt — should outlive any particular agent frontend, and the way to guarantee that is to make it structurally impossible for host details to leak in.

So `core/` imports nothing. Not pi, not a library, not `node:fs`. Everything it needs from the outside world is a method on a port.

The payoff is concrete and immediate: the entire core is unit-tested with fakes and **no real I/O** — an in-memory `Fs`, a controllable `Clock`, deterministic `Ids` — which is why the test suite runs in a quarter of a second. It also means the exact same renderer draws the panel in the TUI, in a tmux pane, and in a test, with colour and width measurement injected.

## The ports

Two directions, both small on purpose.

**Services the host provides to core:**

| Port | For |
|---|---|
| `Fs` | The workspace. `mode` on write, so loot lands `chmod 600`. |
| `Clock` | Timestamps. Controllable in tests. |
| `Ids` | Short stable record ids. Deterministic in tests. |

**Definitions core provides to the host:**

| Output | The adapter maps it to |
|---|---|
| `ToolDefinition` | a pi tool (`record`, `recall`) |
| `GateDecision` | pi's `tool_call` hook |
| The system prompt | appended to pi's assembled prompt |

## Modules

| Module | Does |
|---|---|
| `ontology.ts` | Every record type, status, and enum. The vocabulary. |
| `workspace.ts` | Append-only, versioned JSONL ledgers; artifacts; path safety. |
| `coverage.ts` | `checklist × surface = matrix`, gaps, `selectNext`, the percentage. |
| `scope.ts` | Scope parsing, target matching, the gate decision. |
| `tools.ts` | `record` and `recall`, as host-agnostic definitions. |
| `prompts.ts` | The security-operator prompt, per profile. |
| `redaction.ts` | Loot masking at export boundaries. |
| `stats.ts` | Derived engagement stats and the coverage view. |
| `export.ts` | The Markdown findings report. |
| `panel.ts` | The engagement panel renderer. |
| `coverage-panel.ts` | The coverage matrix renderer. |
| `statusline.ts` | Priority-based status-line layout. |

The last three are pure renderers: lines in, lines out, with colour and measurement injected. That is what lets `bin/pired-state.mjs` render the same panel outside the TUI without duplicating a single line of layout logic.

## Chaining, not replacing

The adapter is a good citizen in pi's extension chain:

- **The prompt is appended**, never replaced. pi hands over its fully-assembled prompt — its own instructions, loaded skills, project context, plus whatever earlier extensions contributed — and pired adds its security overlay to the end. Neither pi's base nor another extension's contribution is clobbered.
- **The status line carries other extensions' statuses** on a second line, exactly as pi's own footer does.
- **Every UI call is guarded.** A missing or older pi API disables a feature; it never breaks the session.
- **No sub-agent machinery**, and no dependency on any. pired cooperates with [pi-subagents](https://github.com/nicobailon/pi-subagents) when it is present and works fine without it.

## Testing

```bash
npm run check         # tsc --noEmit && vitest run --coverage && the assay probes
npm test              # vitest run
npm run test:coverage # vitest run --coverage
npm run typecheck     # tsc --noEmit
```

625 unit tests — 445 over the core, the rest over the pi adapter, the two
binaries and the grader — plus the [assay](evaluation.md) probes over the
harness itself. Coverage is measured and ratcheted; see [testing](testing.md)
for what is excluded and why.

Built test-first with fakes throughout. TypeScript is strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, and `erasableSyntaxOnly` — the last one because pi type-strips the extension at load rather than compiling it, so anything non-erasable would fail at runtime rather than at build.

`bin/launch.mjs` and `bin/state.mjs` are plain JavaScript, because they sit on the startup path of a CLI and a launcher that needs type-stripping to boot has one more way to fail before it can print anything. They are still typechecked: `allowJs` is on and their contracts are declared in JSDoc, so their tests are held to the same strictness as everything else.

## An AI agent, not a toolbox

pired ships **no scanners**. It owns no detection engines, and it makes no claim to reproducible, rule-count-comparable output.

What it does is drive the tools already on the box — `nmap`, `ffuf`, `curl`, `sqlmap`, `semgrep` — through `bash`, and put judgment on top: direct the tool, verify its hits, and chase what it cannot see (access control, IDOR, business logic). Heavy tooling is opt-in; a missing tool is *requested* via a blocker, not carried.

And pired drafts findings for an operator to verify. **The operator signs the report.**
