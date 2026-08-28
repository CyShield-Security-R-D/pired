# The Development of pired

*pi(red) — an engagement harness for security consultants, built on the pi coding agent*

## 1. Goal and motivation

**pired** is an engagement harness for security consultants doing authorized work —
whitebox code review and blackbox testing in one workspace. The design goal was a
*handy, minimal* security layer that runs well on **local / open-weight models**
(e.g. Qwen3.8 27B, Gemma 3 27B, DeepSeek), so client code never leaves the
engagement box, as well as on subscription models (OpenAI Codex) where the
engagement allows them — rather than a heavyweight, model-hungry framework.

The project was framed against existing tools such as **Strix**, but with a
deliberately different stance:

> **"Our agent should never bundle tools — we are an AI agent, not a testing tool."**

pired ships **no** heavy security tooling. At most it exposes basic, versatile
capabilities and drives the *environment's* tools (nmap, ffuf, curl, sqlmap,
semgrep, …) through `bash`. Heavy tooling is opt-in via separate packs; when a
needed tool is missing, the agent asks the operator to install it rather than
carrying it. The intelligence lives in the model + the workflow, not in a bundled
scanner.

## 2. Design philosophy: "a design that lives long"

An explicit requirement was **longevity** — *"a design that will live long, not
something that easily gets deprecated."* That drove two decisions:

### 2.1 Ports & adapters (hexagonal) architecture

The security logic lives in a **harness-agnostic `core/`** with *zero* imports from
any specific agent host. Everything the core needs from the outside world is
expressed as a small **port** interface (`Fs`, `Clock`, `Ids`, `ToolDefinition`,
`Gate`, …). A thin **adapter** binds those ports to a concrete host.

```
core/            harness-agnostic security core  (no pi imports, fully unit-tested)
  ontology.ts      the engagement data model + on-disk format version
  workspace.ts     append-only JSONL store engine (disk = source of truth)
  scope.ts         scope matching + the tool-call gate
  redaction.ts     credential/secret redaction for exports
  coverage.ts      attack-surface coverage math
  tools.ts         the record / recall tools (core logic)
  prompts.ts       the security-operator system prompt builder
  stats.ts         engagement statistics
  export.ts        findings -> Markdown
extensions/      the pi bridge (adapter)
  pired.ts         registers tools, scope gate, prompt, /findings; wires ports to pi
  lib/host.ts      NodeFs / SystemClock / RandomIds
  lib/tools.ts     core ToolDefinition -> pi ToolDefinition
  lib/providers.ts registers custom OpenAI-compatible providers into pi's /model picker
```

Because `core/` knows nothing about pi, the security engine survives a change of
host. If pi's API changes, only the thin adapter moves.

### 2.2 Build *on* pi, don't fork it

An early plan (decision "B") was a standalone binary with its own TUI, model
picker, login, sessions, etc. That was **abandoned** in favour of decision "A":
ship pired as a **pi package/extension** and inherit pi's entire frontend — TUI,
`/model` switching, `/login`, themes, sessions, slash-command autocomplete, MCP.

The reasoning: re-implementing a coding agent's frontend is a large, perpetually
out-of-date surface. Riding pi means pired is a *security layer*, not a second agent
to maintain. The `core/` from the abandoned plan was reused wholesale.

### 2.3 Depend on nothing you don't have to

For sub-agents (delegated recon, adversarial confirmation), pired **reuses the
existing `pi-subagents` package** rather than reinventing it:

> *"Why reimplement and not just use them as they are? I don't want to maintain any
> extra dependencies."*

pired therefore ships **no** sub-agent machinery and takes **no** dependency on one.
Its system prompt contains a soft hint ("if a sub-agent tool is available, delegate
isolated recon…") so it cooperates with `pi-subagents` when present, and works fine
without it.

## 3. The engagement model (ontology)

pired treats an engagement as durable, disk-backed state — *trust the workspace,
not the model's memory*:

```
checklist  ×  inventory   =  coverage  ->  hypotheses  ->  findings
                                              +loot / notes / evidence / artifacts / blockers
```

- **inventory** — hosts, services, endpoints, parameters, technologies discovered.
- **checklist** — the methodology items to test.
- **coverage** — checklist × inventory: what has actually been tested vs. gaps.
- **hypotheses** — candidate issues to confirm or refute.
- **findings** — confirmed vulnerabilities (promoted from hypotheses).
- **loot** — captured secrets/credentials (stored with restrictive permissions).
- **blockers** — non-blocking, async operator decisions (authorization, creds,
  scope clarifications) recorded so the engagement never stalls waiting.

State is written to `~/.pired/engagements/<name>/` as **append-only JSONL** with a
versioned format (see `FORMAT.md`): "updates" are new records with the same id
(last-write-wins on read); single-object files are written atomically via
temp-file + rename; writers serialize through an advisory lock.

The model interacts with this through two tools — **`record`** (write a
hypothesis/finding/inventory/loot/blocker) and **`recall`** (query state, e.g.
`recall next`, `recall gaps`) — plus `/findings` to export a Markdown report.

## 4. The scope gate

pired includes a **scope gate** that keeps the agent on authorized targets. Its
stated role is important and deliberately humble:

> The gate is **focus / accident-prevention, NOT a sandbox.** It extracts candidate
> targets from freeform `bash` commands and tool arguments and checks them against
> the authorized list. A determined bypass (shell variables, encoding, indirection)
> defeats it; the real boundary is the container/network.

Scope is declared in a `pired.scope.json` (loaded only when the project is trusted)
with targets (domains/ips/cidrs/urls), exclusions, an enforcement `mode`
(`off`/`warn`/`enforce`), and an `authorized` flag that must be `true` before any
network testing runs. Profiles tune defaults: `review` (code audit, no network
gate), `recon` and `pentest` (network blocked until an authorized scope is present).

## 5. Test-driven development

pired was built **test-first** with vitest and **fake ports** (an in-memory `Fs`,
a controllable `Clock`, deterministic `Ids`), so the entire `core/` is exercised
with no real I/O. At the time of this research the suite stood at **89 passing
tests** across eight modules (coverage, export, prompts, redaction, scope, stats,
tools, workspace) with a clean `tsc --noEmit`.

TDD paid off directly in the hardening pass below: every fix was expressed first as
a failing test encoding the exact bypass vector, then made to pass.

## 6. Model setup

pired is model-agnostic and rides pi's provider system. Three routes were wired:

1. **OpenAI Codex** — reused the operator's existing pi Codex web login
   (CredentialStore over `~/.pi/agent/auth.json`); no re-auth needed.
2. **OpenRouter** — `qwen/qwen3.8-27b` (1M context, reasoning + tools), added as a
   custom OpenAI-compatible provider via `~/.pired/models.json`. This is the model
   used for the local-model arm of the benchmark.
3. **LM Studio** — the same Qwen model served on a LAN box,
   128k context / 8k max output.

Custom providers are registered into pi's own `/model` picker by
`lib/providers.ts`, so they appear alongside built-in and subscription models.

## 7. pired reviewing itself — the hardening pass

As a real exercise of the harness, pired (running `pi-subagents` + a code-review
model) reviewed **its own `core/`**. The review surfaced **8 legitimate findings**.
The two the operator prioritised were fixed first, then a re-focused adversarial
re-review drove a second, deeper round. All fixes were made test-first.

**Round 1 — the two prioritised bugs**

- **URL-exclusion bug (`scope.ts`)** — `ScopeTargets.urls` (targets *and*
  exclusions) were never consulted; URL scoping silently did nothing. Fixed by
  adding `isUrlInScope()` with path-boundary-aware prefix matching, wired into both
  the `bash` command check and the tool-argument gate.
- **Loot chmod race (`workspace.ts`)** — the loot ledger was created by `appendFile`
  (umask-default permissions) and only *then* `chmod 600`, leaving a window where
  plaintext secrets were world/group-readable. Fixed by creating the file `0600`
  before the first write, and tightening a pre-existing permissive file *before*
  appending.

**Round 2 — deeper variants the adversarial re-review found (several in the code the
first fix touched)**

- **URL canonicalization** — raw prefix matching let `..%2f`/dot-segment and
  malformed-escape tricks slip past URL scope. Added tolerant percent-decoding +
  dot-segment resolution + authority normalization (drop userinfo and the scheme's
  default port).
- **IPv4 spelling** — exact excluded IPs used string equality while CIDRs used
  numeric matching, so `127.0.0.01` evaded an exclusion for `127.0.0.1`. Switched to
  numeric comparison.
- **Shell-punctuation evasion** — `(curl evil)` / `;curl` / `$(curl …)` dodged
  network-tool detection. Tokenization now splits on shell metacharacters.
- **Recursive tool-arg extraction** — the gate only inspected shallow allowlisted
  keys. It now walks nested args (depth-bounded, cycle-safe): a `scheme://` URL is
  caught under any key, while bare hosts are harvested only from target-ish keys so
  filenames like `config.yaml` aren't mistaken for hosts.
- **`strictUnresolved` policy flag** — a network command with an unparseable target
  (`curl localhost`, a shell var) fails **open** by default (don't block legitimate
  commands), but can now fail **closed** under `enforce` when the operator opts in.

The exercise validated the harness end-to-end: pired found real bugs in its own
code, recorded them to an engagement workspace, and the workflow drove them to
fixes — exactly the loop it is meant to support.

## 8. Compatibility with the pi ecosystem

pired uses only the **public** `ExtensionAPI` (registers `record`/`recall`,
`/findings`, the `pired-profile` flag, and providers; hooks `session_start`,
`before_agent_start`, `tool_call`, `turn_end`) and imports only *type* symbols from
the pi package. It is a good ecosystem citizen: `setActiveTools` is additive (never
clobbers other extensions' tools), the `before_agent_start` handler **chains** onto
`event.systemPrompt` (so pi's base prompt and other extensions' contributions are
preserved rather than replaced), status uses a namespaced key, and its tool/command
names don't collide with the installed `pi-subagents` / other packages. Duplicate
tool registration is non-fatal in pi (a per-extension `Map`), so even a name clash
degrades gracefully.
