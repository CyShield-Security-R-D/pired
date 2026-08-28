# pired — Plan (v1 shared core)

> **ARCHITECTURE UPDATE — supersedes §2 and §3.1 (decision B).** pired shipped as
> a **pi package / extension** (option A), NOT the standalone binary (option B).
> The reasoning: option B meant reimplementing pi's frontend (model switching,
> TUI, autocomplete, login…), which was wasted effort. Because `core/` is
> harness-agnostic behind ports, the pivot reused it unchanged; only the thin
> adapter layer was swapped. Concretely:
> - **Kept:** all of `core/` (ontology, workspace, coverage, scope, redaction,
>   tools, prompts, stats, export) — zero pi imports, tested.
> - **Added:** `extensions/pired.ts` + `extensions/lib/` — bridges core onto pi's
>   ExtensionAPI (scope gate via `tool_call`, security prompt via
>   `before_agent_start`, engagement bootstrap on `session_start`, `record`/`recall`
>   tools, findings status, `/findings`, and local-model registration via
>   `pi.registerProvider`). pired now inherits pi's TUI, `/model`, `/login`,
>   themes, sessions, autocomplete, MCP.
> - **Removed:** the standalone adapter (`adapters/standalone/`), the hand-rolled
>   TUI, the CLI, and the reinvented `spawn`/`SubagentRunner`/`Llm` ports.
> - **Sub-agents:** delegated to the external **pi-subagents** package (installed
>   separately; pired takes no dependency and ships no agent code).
>
> Everything below about the ontology, workspace/format, scope model, tools, and
> state decisions still holds. The §2/§3.1 "standalone on pi-agent-core + pi-ai"
> framing is historical.

> Status: **proposal for sign-off.** Every open decision below is resolved to a
> recommended default; red-line anything you disagree with. No implementation
> starts until this is agreed. (`lib/scope.ts` and `lib/prompts.ts` already exist
> as a throwaway sketch of the approach and will be rewritten to match this doc.)

## 1. Goal

An engagement harness — "pi(red)" — for **security consultants** doing authorized
work: whitebox code review and blackbox testing in one workspace, tuned to run on
local models (~30B class: Qwen3-32B / Qwen3-30B-A3B, Gemma 3 27B, DeepSeek) so
client code never leaves the engagement box. It adds a rigor/anti-amnesia state
layer, scope enforcement, and a small structured subagent layer.

The audience is the operator who signs the report. pired is a force multiplier for
their judgment — it drafts findings they verify — **not the assessment itself**, and
**not a scanner**: detection engines stay the operator's, driven through `bash`.

> **Superseded.** This section originally specified a **standalone binary** on
> `pi-agent-core` + `pi-ai`, "not a fork and not a plugin inside pi's CLI (§2)".
> pired shipped as a pi extension — see the architecture note at the top.

Non-goals for v1: autonomous end-to-end operation, a rich TUI, scanner
tool-wrappers, report generation. Those are staged (§13).

## 2. Substrate decision: domain core + pi as an **adapter**, not a fork

pired's identity is the **engagement domain** (§6 ontology) + **open, versioned
data formats** (§5). Harnesses are replaceable adapters over that core. pi is the
first and best adapter, not the foundation. This is the primary longevity
decision — see §3.1.

- **Chosen (decision B): the primary and only v1 adapter is standalone**, built on `pi-agent-core` + `pi-ai` — the small, fundamental, slow-moving surfaces. pired ships as its **own binary**, not inside pi's CLI. Chosen for performance, reliability, and future-compatibility. No `pi-coding-agent` dependency.
- From those libraries pired reuses, as a library, the durable substrate: the agent loop, built-in file/bash tools, JSONL sessions, compaction, and skills — without pi's CLI, TUI, or extension host.
- **Conscious trade:** we give up pi-coding-agent's ready-made extension ecosystem, slash-command host, session picker, and TUI. pired's *own* extensibility (profiles, subagent roles, checklists, skills as data — §10/§11) is preserved because it lives in `core` and is read directly, independent of any host's plugin system.
- **Frontend is ours to build:** v1 = headless (**print/JSON**) + a minimal interactive **REPL**; a richer terminal UI comes later via `pi-tui` (a standalone, reusable library — no coding-agent dependency). A pi-coding-agent *convenience* adapter to run pired inside pi's TUI remains possible later, but is not built now.
- The core does not know which adapter is running it, so the standalone binding stays swappable.

Rejected: hard fork (fights 271 releases of velocity for no core-semantics change, and couples longevity to pi's pre-1.0 API); reinventing the loop/provider layer from scratch (becomes a stale mini-pi — its own deprecation risk); reinventing Strix (autonomous-first, its own framework, less model-portable).

## 3. Design principles

1. **Minimal core, data-driven.** Ship strong defaults; make modes, subagent roles, and checklists declarative config the user overrides/extends. pired is a *tunable framework*, not a fixed tool.
2. **Local-model first.** Tiny always-on prompt, tiny active tool set, methodology in on-demand skills, parse-and-summarize everything, thinking low by default.
3. **Rigor over vibes.** Explicit inventory → coverage → hypotheses → findings pipeline so a weak model stays systematic and doesn't quit early or loop.
4. **Configure behavior, not safety.** Prompts/models/tools/soft-caps are configurable. Scope enforcement, authorization, workspace inheritance, subagent depth, and hard caps are harness-owned and NOT config-toggleable in `enforce` mode.
5. **Honest boundaries.** The scope guard is focus/accident-prevention, not a sandbox. Real isolation is the container/VM/network pired runs inside.
6. **Built to outlive its host.** The value lives in a harness-agnostic core and open, versioned formats; the harness binding is a thin, replaceable adapter (§3.1).
7. **Never stall the engagement.** Blockers needing the operator are parked as async state; the agent routes around them and resumes when they are answered, whenever that is — even in a later session (§7.1).
8. **Agent, not a toolbox.** The default build ships no heavy or specialized tooling. The model-facing surface is the host's built-in file/bash tools plus pired's cognitive tools (`record`/`recall`/`spawn` — memory, coverage, delegation), and at most a few *basic, versatile* tools if a real need appears (e.g. a generic HTTP request). Scanners and exploit tooling are the operator's, reached through `bash`, or added later as opt-in **tool packs** — separately-installable bundles of tools/roles/checklists/skills — never baked into core. Keeping raw tool output out of context is agent behavior (bash truncation + `evidence/` capture + a distilled `record`), never a bundled wrapper. And when the agent needs a tool that is missing, pired is **dependency-aware** — it surfaces it (a notice to the agent to adapt, and for critical tools a parked blocker to the operator to install or advise) rather than failing silently.

9. **Trust the model; inform, don't micromanage (future-proofing).** The harness's leverage is *situational awareness* — durable memory, the coverage map, scope facts, and on-demand reference skills — not a rigid procedure. Encode **what matters and why** (the stakes, the boundaries, what tools and scanners can and cannot see) and let the model's intelligence choose the approach, so the same harness gets *better as models get smarter* instead of being capped by a script written for a weaker one. The always-on prompt is suggestive and informing; deep methodology is reference the model pulls in and adapts, never a mandatory checklist. **Corollary — use tools, don't self-rely:** trusting the model includes trusting it to reach for the right external tool (semgrep/SAST for code review, nmap/enumeration for network, fuzzers/nuclei for web) rather than reasoning in its head; the model drives tools for breadth and ground truth, then applies judgment on top (direct them, verify hits, chase what they can't see — access control, IDOR, logic). This does **not** loosen principle 4: hard scope/authorization/safety boundaries stay firm regardless of how capable the model is.

## 3.1 Longevity architecture (ports & adapters)

The explicit goal is a design that does **not** get deprecated when pi (pre-1.0,
fast-moving, "no backward-compat guarantees") churns or pivots.

**One boundary, held firmly:**

```
        ┌─────────────────────────────────────────────┐
        │  core/  (harness-agnostic, ZERO pi imports)  │
        │  ontology · workspace stores · coverage      │
        │  scope · redaction · tool/role/checklist     │
        │  definitions (data + pure execute) · prompts │
        └───────────────▲──────────────────▲───────────┘
             ports:      │  (small, stable) │
        ToolHost · Gate · SystemPrompt · LLM(for subagents/summaries) · Clock/FS
                         │                  │
        ┌────────────────┴────────────────┐   ┌───────┴───────────────────────┐
        │ adapters/standalone/   (v1)      │   │ adapters/pi/  (optional, later)│
        │ pi-agent-core + pi-ai directly   │   │ binds ports to pi-coding-agent │
        │ own binary; small stable surface │   │ ExtensionAPI (churny)          │
        └──────────────────────────────────┘   └────────────────────────────────┘
```

- **`core/` has zero pi imports** and is unit-tested with no pi runtime. It is the thing that lives 10 years.
- The **port contract is deliberately small and conceptually universal** across agent harnesses: register a tool, gate a tool call, contribute a system-prompt block, run a sub-LLM, read/write files. Any competent harness can satisfy it.
- **Dependency ladder, most→least durable:** `pi-ai` (provider abstraction — safe to depend on directly) > `pi-agent-core` (loop + harness tools/sessions/compaction) > `pi-coding-agent` ExtensionAPI (richest, churniest). **v1 binds only the top two;** the coding-agent layer is never a dependency unless the optional `adapters/pi/` is built later.
- **Formats are the real long-lived artifact** (§5): versioned JSONL + markdown, documented in `FORMAT.md`, migratable — modeled on how pi versions its own session format.
- **Standards over young protocols:** SARIF (findings/code-review export), CWE/CVSS (classification), Agent Skills spec (skills). MCP is an *optional future adapter*, never a foundation.
- **Deliberately not built:** a general multi-harness plugin framework on day one. That over-abstraction is its own fragility. Exactly one real adapter now (`standalone`), with the boundary clean enough that a second (`pi`) is a weekend, not a rewrite. The boundary is kept honest cheaply by testing `core/` against fake ports (no pi-agent-core/pi-ai runtime) — so if it compiles and passes with fakes, it provably doesn't leak.

## 4. Package layout

```
pired/
  PLAN.md
  FORMAT.md                    # versioned spec for the workspace/ontology formats (the durable artifact)
  package.json                 # standalone binary; deps: pi-ai, pi-agent-core (NOT pi-coding-agent)
  bin/pired                    # CLI entrypoint
  pired.scope.example.json

  core/                        # harness-agnostic. ZERO pi imports. Unit-tested without a pi runtime.
    ports.ts        # the small stable contract: ToolHost, Gate, SystemPromptSink, Llm, Fs/Clock
    ontology.ts     # types + schema versions for inventory/hypotheses/findings/loot/coverage
    workspace.ts    # engagement workspace: read/append/query versioned jsonl stores (+ locking)
    coverage.ts     # derive coverage matrix + gaps from checklist × inventory × hypotheses
    scope.ts        # scope model, matching, target extraction
    redaction.ts    # secret registry + masking for export/share
    prompts.ts      # security-operator prompt blocks per profile
    tools.ts        # record / recall / spawn definitions (schema + pure execute over ports)
    subagents.ts    # role discovery + spawn orchestration over the Llm port
    export.ts       # findings -> markdown / json / SARIF

  adapters/
    standalone/     # v1 primary. The ONLY place pi-agent-core / pi-ai are imported.
      agent.ts      # Agent loop wiring, tool registration, scope+auth gate (beforeToolCall), subagents (nested Agent)
      session.ts    # JSONL session storage + compaction from pi-agent-core/harness
      provider.ts   # pi-ai model/provider setup (llama.cpp / Ollama / DeepSeek) — satisfies the Llm port
    pi/             # (optional, later) convenience adapter to run pired inside pi's TUI/extension host

  cli/               # pired's own frontend (v1)
    main.ts         # arg parse, engagement bootstrap, mode selection
    print.ts        # headless print / JSON output
    repl.ts         # minimal interactive loop (readline); rich pi-tui TUI is a later polish
    commands.ts     # /status /blockers /answer /dismiss + `pired answer <eng> <id> …` subcommand

  profiles/          # built-in modes (pentest.md, recon.md, review.md) — data, overridable
  agents/            # built-in subagent roles (investigate.md, verify.md) — data, overridable
  checklists/        # built-in vuln-class checklists (web/api/network/code-review .json) — data
  skills/            # on-demand methodology (web-recon, etc.)
```

`core/` depends only on Node stdlib + `pi-ai` types (via the `Llm` port).
`adapters/standalone/` is the only place `pi-agent-core` + `pi-ai` runtimes are
imported. No `pi-coding-agent` dependency in v1.

## 5. Engagement workspace (disk-backed, cross-session)

Engagement state outlives any single session and must survive resume across
days. **Disk is the source of truth**, and engagement facts are
**branch-independent**: navigating to an earlier point in a session must never
make the agent "forget" a captured credential or discovered host.

Default location **outside the target tree** (so loot never lands in a repo you
review): `~/.pired/engagements/<name>/`, overridable via scope config.

```
~/.pired/engagements/<name>/
  manifest.json       # formatVersion + per-store versions (see FORMAT.md)
  scope.json          # engagement scope (mirror/canonical copy)
  checklist.json      # seeded from a template, editable
  notes.md            # running analyst notes (append/read)
  inventory.jsonl     # hosts / services / endpoints / params / tech
  hypotheses.jsonl    # test cases + outcomes (confirmed/refuted/inconclusive)
  findings.jsonl      # confirmed vulns: severity, target, cwe, repro, evidence, status
  blockers.jsonl      # parked operator questions/approvals (async; answerable across sessions)
  loot.jsonl          # credentials/secrets (chmod 600)
  evidence/           # raw tool output, request/response dumps
  artifacts/          # screenshots, dumped files, PoC scripts
  sessions/           # (optional) pi session files linked into the bundle
```

Stores are append-only JSONL with file locking (safe for concurrent subagent
writes). Loaded into context at session start via `recall`. Coverage is
**derived**, not stored, so it can't drift.

**Format is a versioned spec, not an implementation detail.** Every store carries
a `schemaVersion`; `FORMAT.md` documents the record shapes and a migration path,
modeled on pi's own versioned/migratable session format. Goal: an engagement
captured today is readable and migratable by any future pired (or third-party
tool), independent of the code that wrote it. This spec — not the pi binding — is
the artifact meant to live longest.

## 6. State ontology

```
checklist (vuln classes, per target type)      "the SHOULD"
      ×
inventory (discovered surface)                 "what EXISTS"
      =
coverage matrix   cell = (surface × class) → not-tested | testing | clear | vulnerable | n/a
      ▲
      │ each test attempt updates a cell
hypotheses / test cases  {statement, target, class, method, outcome, evidence}   "what was DONE"
      │
      └─ confirmed ──► finding (report-grade)                                     "what's REAL"

  loot · notes · evidence · artifacts  (supporting state)
```

- **Inventory ≠ coverage.** Coverage = checklist × inventory with statuses filled by hypothesis outcomes.
- **Refuted hypotheses are retained** — prevents re-testing and documents rigor ("tested for X → not vulnerable") in the report.
- **Findings are a subset** — only confirmed hypotheses graduate, keeping the ledger clean.
- **Checklist is target-type-aware** — surfaces classes you didn't think to test, not just ones someone remembered.

## 7. Tool surface (minimal for local models)

Three tools total plus one non-tool hook. Flat schemas, `StringEnum`, no deep nesting.

| Tool | Purpose |
|------|---------|
| `record` | Write engagement state. `kind` ∈ {note, host, endpoint, hypothesis, loot, finding, **blocker**}. Writes through to the workspace store. |
| `recall` | Query workspace. `query` ∈ {**next**, coverage, gaps, inventory, hypotheses, findings, loot, notes, **blockers**}. `next` returns the next *unblocked* work item. Returns compact summaries. |
| `spawn` | Run a subagent. `role` = `StringEnum` built from configured roles; `task` = string. §11. |

Scope guard is a pre-tool-call **gate** (the `Gate` port; bound to pi-agent-core's
`beforeToolCall`), not a tool — it gates `bash` and any tool arg with
url/target/host/ip fields. Built-in file tools come from `pi-agent-core` as a
library (`read/bash/edit/write` + search); `grep/find/ls` are pired-provided or
run via `bash`. pired only changes which are active per mode.

`/status` command: prints coverage + gaps + finding + open-blocker counts (the anti-quit-early view).
`/blockers`: list open blockers by priority. `/answer <id> <text|choice>`: answer one (resumes gated work). `/dismiss <id> [reason]`: drop one.
`/findings export [path]`: Markdown + JSON (SARIF deferred to code-review polish).

## 7.1 Async blockers (never stall the engagement)

Operating rule: **nothing blocks the whole agent — only specific work items.**
When the agent needs the operator (a decision, a missing credential, scope
clarification, or approval for an intrusive/destructive step) it does not open a
modal and wait. It:

1. **Parks a blocker** — `record kind=blocker` writes `{id, kind: decision|input|approval|scope-clarification|credential-request, question, context, options?, blocks:[workRef], priority, status:open}` to `blockers.jsonl`.
2. **Routes around it** — `recall query=next` returns the next *unblocked* gap (coverage cells / hypotheses whose work items have no open blocker). Blocked coverage cells get a distinct `blocked` status, not `not-tested`.
3. **Resumes on answer — whenever it comes** — the operator answers via `/answer <id> …` (or `/dismiss`), this session or a later one. An answer injects a follow-up to resume the gated work (pi follow-up queue); across sessions the answer sits in the workspace and is picked up on the next `recall`. The operator can even answer by editing `blockers.jsonl` directly.

Guards:
- **Bias to momentum** — prefer *proceed under a stated assumption + a low-priority confirm-blocker* over stopping. Reserve real blockers for what only a human can decide (authorize escalation, provide creds, resolve material scope ambiguity).
- **Hard gates block the action, not the engagement** — out-of-scope / unauthorized-intrusive actions become `approval`/`scope` blockers on that action; the agent continues other work.
- **Don't spin** — when no unblocked work remains, stop and summarize open blockers by priority. Blockers are deduped by question + workRef so the agent never re-raises the same one.

Split across the boundary: the park/route-around/resume **logic is `core`**
(harness-agnostic — blocker records, `next` selection, resumption). Only the
**surfacing is adapter-level**. Under the v1 standalone adapter: the REPL shows an
open-blocker line + `/blockers`; print/JSON ends the run with an open-blocker
summary; and because blockers are durable files, the operator can answer a running
*or* stopped engagement with the decoupled `pired answer <engagement> <id> "…"`
subcommand, which the agent picks up on its next `recall`. (This file-based answer
path is cleaner under B than it would be inside a live TUI.)

## 8. Scope + authorization

Config `pired.scope.json` (project-local honored only when the project is trusted):

```json
{
  "engagement": "acme-webapp-2026",
  "authorized": false,
  "mode": "enforce",
  "workspace": "~/.pired/engagements/acme-webapp-2026",
  "targets": { "domains": ["*.acme.test"], "ips": [], "cidrs": ["10.10.20.0/24"], "urls": [] },
  "exclude": { "domains": ["admin.acme.test"] }
}
```

Enforcement (`mode`: `enforce` | `warn` | `off`):
- Best-effort extract URLs / hostnames / IPv4 from the command; out-of-scope target → **block** with reason.
- Network tool + no resolvable target → allow but flag "scope unverified" (avoids being useless; honest about the limit).
- `authorized !== true` → all network-tool commands **blocked** until the scope file is explicitly set authorized. In the REPL, startup prompts to confirm written authorization; **print/JSON has no prompt, so it stays blocked unless the file says `authorized: true`** (explicit opt-in the operator controls).

Documented plainly as focus/accident-prevention, not a sandbox.

## 9. Credential handling

- Stored in `loot.jsonl` (chmod 600), plaintext where the agent must reuse it.
- **Handle-based reference** (`cred:web-admin`) so reuse doesn't reprint plaintext across the transcript.
- **Redaction at the boundaries that leave the machine**: mask known secrets in report/findings export and in any share/publish path pired provides. Loot never auto-shares. Local session JSONL may contain what the model saw (fine, local); the leak vectors are export and share/publish.
- Display-time masking in the REPL: **off by default, configurable on** (operators usually want to see what they captured).

## 10. Modes = profiles (configurable)

A mode is a *profile* composing: prompt block + active tool set + checklist + available subagent roles + model routing. Built-in, overridable in `profiles/`.

| Profile | Active tools (default) | Notes |
|---------|------------------------|-------|
| `pentest` | read, bash, grep, find, ls, write, record, recall, spawn | scope-guarded; least-intrusive PoC; no destructive actions unless engagement authorizes |
| `recon` | read, bash, grep, find, ls, record, recall, spawn | passive/light enumeration, no exploit |
| `review` | read, grep, find, ls, bash, record, recall, spawn | read-only code audit; bash for semgrep/opengrep; findings cite file:line |

Toggle via `--profile <name>` flag and a `/mode` command (plan-mode-style).

## 11. Subagents (configurable, harness-shaped)

Declarative roles (markdown + frontmatter), discovered layered + trust-gated:
`built-in < ~/.pired/agents/ < .pired/agents/ (trusted) < engagement workspace`, rightmost same-name wins.

```markdown
---
name: investigate
description: Isolated recon/enumeration; returns distilled inventory + hypotheses.
model: local/qwen3-32b     # optional; defaults to parent model (per-role routing)
thinking: off
tools: [read, bash, grep, find, recall, record]
maxTokens: 40000
---
<role system prompt>
```

Exposed as the single `spawn` tool with `role` = config-driven `StringEnum`.

v1 built-in roles:
- **`investigate`** — isolated enumeration of a target; returns distilled inventory + proposed hypotheses (context-isolation win, the key local-model lever).
- **`verify`** — adversarially try to refute a hypothesis; returns confirmed/refuted/inconclusive + evidence; updates coverage; confirmed → finding (false-positive gate).

Value locally is **context isolation + false-positive reduction**, not parallelism
(one local GPU serves serially — fan-out is deferred until the runtime gives real
concurrency, e.g. API or multiple endpoints).

**Harness-owned invariants (not config-toggleable in `enforce`):** scope + auth +
workspace inheritance; depth = 1 (no subagents spawning subagents); hard caps
(max 3/turn, 8/engagement by default; per-subagent token ceiling). Configurable:
prompt, model, thinking, tool set, soft caps.

## 12. Local-model tuning

- Active tool set target ≤ 8; `record`/`recall`/`spawn` + a few builtins.
- Grammar/JSON-constrained tool calls (llama.cpp GBNF; pi experimental strict mode) for Gemma; rely on native tool calling for Qwen3/DeepSeek with grammar as fallback.
- Small always-on prompt; methodology in on-demand skills (progressive disclosure).
- Keep raw tool output out of context by behavior, not wrappers: bash truncates automatically, the agent redirects raw output to `evidence/`, and pulls only distilled summaries into context via `record`/`note` (principle 8).
- Thinking `off`/`low` for tool-heavy phases; reserve reasoning for planning/`verify`. Qwen3 `/think`, DeepSeek-R1 → thinking; Gemma → off.
- Security-tuned compaction: keep scope, confirmed findings, current target/phase, gaps, next steps.
- Provider is config, set up directly through `pi-ai`: llama.cpp / Ollama via an `openai-completions` provider (`baseUrl` to the local server), DeepSeek via its built-in provider. Documented, not hard-coded.

## 13. v1 scope vs deferred

**v1 (this plan):** standalone pired binary on `pi-agent-core` + `pi-ai`; world-class `pi-tui` TUI + headless print/JSON; scope + auth gate; engagement workspace + `record`/`recall`; coverage/gaps + `/status`; checklists (templates); `pentest`/`recon`/`review` profiles + prompt injection; two configurable subagent roles + `spawn`; credential redaction on export/share; findings export (MD+JSON); local-model provider setup (llama.cpp/Ollama/DeepSeek).

**Deferred (v1.1+):** optional `pi-coding-agent` convenience adapter; opt-in tool packs (separately-installable tools/roles/checklists/skills, incl. heavy security tooling); background job orchestration; SARIF export; report generation; autonomy loop with coverage-gated stop; parallel subagent fan-out.

## 14. Decisions — resolved defaults (red-line these)

| # | Decision | Default |
|---|----------|---------|
| 1 | Bash scope enforcement | Best-effort extract + block out-of-scope; allow-with-warning when unresolvable |
| 2 | Headless authorization | Blocked unless scope file `authorized: true` |
| 3 | Tool policy | No heavy/specialized tools in core. Default surface = host file/bash + record/recall/spawn (+ optional basic versatile tools if needed). Specialized tooling → opt-in tool packs later (principle 8) |
| 4 | Smoke testing | Install pi locally and run pired end-to-end during build |
| 5 | Location / name | `/home/mamgad/pired`; package name `pired` (npm `@pired/harness` if scoped) |
| 6 | Workspace location | `~/.pired/engagements/<name>/` (out of target tree), overridable |
| 7 | Tool granularity | Unified `record`/`recall` (+`spawn`) |
| 8 | Credential redaction | Mask at export/share; TUI display masking off by default |
| 9 | Durability vs branching | Disk-backed, branch-independent facts |
| 10 | Checklist | Ship templates seeding editable `checklist.json` |
| 11 | Coverage | Derived at query time |
| 12 | Completion gating | v1 `/status` gap report; coverage-gated stop deferred |
| 13 | Refuted hypotheses | Retained (no-retest + report rigor) |
| 14 | Subagents | Yes; v1 roles `investigate`, `verify` |
| 15 | Orchestration style | Harness-shaped: single `spawn`, config-driven role enum |
| 16 | Parallelism | Sequential by default; fan-out deferred |
| 17 | Per-role model routing | Allowed via role config |
| 18 | Caps | Depth 1; 3/turn, 8/engagement; per-subagent token ceiling |
| 19 | Config precedence | built-in < user < project(trusted) < engagement; rightmost wins |
| 20 | Architecture | Ports & adapters: harness-agnostic `core/` (zero pi imports) + thin `adapters/standalone/`; one boundary, not a plugin framework |
| 21 | Adapter (chosen: **B**) | v1 binds `pi-agent-core` + `pi-ai` as a standalone binary (perf/reliability/future-compat). No `pi-coding-agent` dep. Optional `pi` convenience adapter later |
| 27 | Frontend | **World-class TUI** built on `pi-tui` (reusable standalone lib), plus headless print/JSON. A polished interactive UI is a v1 goal, not deferred |
| 28 | Testing | **TDD**: every core module has tests-first against fake ports; `core/` runs with zero pi runtime. Runner: vitest. Gate: `npm run check` (tsc + vitest) |
| 29 | Tool packs | Heavy/specialized tooling ships as opt-in, separately-installable packs (extra ToolDefinitions/roles/checklists/skills); core supports loading them but bundles none. Deferred |
| 30 | Tool availability & escalation | Dependency-aware: missing tool → notice to agent + (critical) parked blocker. Agent may request installation or a more capable tool/pack as an operator-approved action (install via bash only when permitted). Expected tools configurable per profile |
| 22 | Formats | Versioned JSONL/markdown, documented in `FORMAT.md`, migratable; the longest-lived artifact |
| 23 | Standards | SARIF (findings/review export), CWE/CVSS (classification), Agent Skills (skills); MCP optional-adapter-only |
| 24 | Human-in-loop | Non-blocking: park blocker → route around → async resume; never a modal stall |
| 25 | Blocker durability | `blockers.jsonl` records; answerable across sessions or by direct file edit |
| 26 | Momentum bias | Prefer assumption + low-priority confirm-blocker over stopping; hard gates block the action, not the engagement |

## 15. Build order (once agreed)

Core first (the durable part), adapter + CLI last (the replaceable part).

1. `FORMAT.md` + `core/ontology.ts` + `core/ports.ts` — nail the versioned formats and the small port contract before anything binds to them.
2. `core/` pure logic (workspace stores, scope, coverage, redaction, prompts, tools, export) + unit tests with **fake ports** — no `pi-agent-core`/`pi-ai` runtime.
3. `adapters/standalone/provider.ts` + `session.ts` — pi-ai model/provider setup; pi-agent-core JSONL sessions + compaction.
4. `adapters/standalone/agent.ts` + `cli/` — Agent loop wiring, tool registration, scope+auth gate, `record`/`recall`, `/status`; print/JSON + minimal REPL.
5. `checklists/` + `profiles/` built-ins; wire coverage into `recall`/`status`.
6. `core/subagents.ts` + standalone `spawn` (nested `Agent`), invariants, `investigate`/`verify`.
7. Redaction on export/share; `/findings export` (MD+JSON, SARIF stub); `pired answer` async-blocker subcommand.
8. Smoke test end-to-end against a local model (llama.cpp/Ollama) on a benign local target and a sample repo.

## 16. Still open for you

Resolved: name = **pired**; adapter = **B (standalone on `pi-agent-core` + `pi-ai`)**; frontend = **world-class `pi-tui` TUI** + headless print/JSON; **TDD** with vitest + fake ports; **tools** = no heavy tooling in core, dependency-aware with operator-approved install/escalation, heavy tooling via opt-in packs (decisions 3, 29, 30).

Resolved: first end-to-end smoke target = **code review** (read-only, local, no scope/authorization friction; run the `review` profile against a real codebase).

Still open: none blocking.
