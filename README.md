<div align="center">

# pi(red)

**An engagement harness for security consultants — whitebox review and blackbox testing in one workspace, with coverage tracking that won't let an engagement end early.**

*Runs on your own hardware, so client code never leaves the box. An AI agent, not a toolbox: it ships no scanners; it drives the ones you already have.*

`review` · `recon` · `pentest` — as a [pi](https://pi.dev) extension

</div>

---

## Why pired

A consultant under NDA often *cannot* paste client source into a frontier API — that is a contract term, not a preference. And an engagement is rarely just one half: the same scope buys a code review *and* a test, delivered as one report. pired is built for that shape of work — a thin, durable **security layer** on top of the [pi coding agent](https://pi.dev) (an engagement workspace, a scope gate, a security-operator prompt, and two tools, `record`/`recall`) driving the environment's own tools (`nmap`, `ffuf`, `curl`, `sqlmap`, `semgrep`, …) through `bash`.

Three claims:

- **It runs on your hardware.** Tuned for ~30B open-weight models (Qwen3.8 27B, Gemma 3 27B, DeepSeek), so client code never leaves the engagement box — and it still beats a frontier agent on recall (below). Frontier and subscription models work too, where the engagement allows them.
- **Coverage discipline, not vibes.** `checklist × inventory = coverage → hypotheses → findings`, with `recall gaps` keeping the agent testing while gaps remain. Per the benchmark, this — not a bigger model — is where the recall lift came from.
- **One workspace, both halves of the engagement.** `review` for whitebox, `recon`/`pentest` for blackbox, over a single engagement ontology, so findings, evidence, and coverage correlate across the whole job instead of living in two disconnected tools.

**What pired is not.** Not a scanner: it owns no detection engines and makes no claim to reproducible, rule-count-comparable output. Not the assessment: it drafts findings for an operator to verify, and the operator signs the report. Two principles keep it that way:

- **An AI agent, not a toolbox.** No bundled scanners. Heavy tooling is opt-in; missing tools are *requested*, not carried.
- **Built to last.** A harness-agnostic **ports & adapters** core with *zero* host imports, so the security engine outlives any single agent frontend.

---

## The headline result

We benchmarked pired on a **ground-truth-labeled vulnerable banking app** (53 CWE/OWASP-tagged vulnerabilities, deterministic grader). Same target, same prompt, same grader — the only variable is **harness + model**.

| | Recall | Precision | F1 | Critical recall | Cost/scan |
|---|:--:|:--:|:--:|:--:|:--:|
| **pired + Qwen3.8 27B** *(local)* | **0.81** | 0.72 | **0.76** | **100%** | ~$0.26 |
| codex + gpt-5.6-sol *(frontier)* | 0.68 | **0.80** | 0.73 | 93% | ~$0.19 |
| vanilla pi + Qwen3.8 27B *(no pired)* | 0.59 | 0.56 | 0.57 | 79% | ~$0.16 |

**Two findings stand out:**

1. **The harness is worth more than the model.** Wrapping the *same* 27B model in pired lifted recall **0.59 → 0.81** and F1 **0.57 → 0.76**, with critical coverage **79% → 100%** — surpassing a frontier agent on both recall and F1. The lift comes from an *explore-first, then coverage-floor* method — the model reasons openly, then a checklist floor and a precise-capture step ensure nothing systematic is skipped — not from a bigger model. The gains land where a generic prompt is weak: all cryptographic-failure bugs (4/4 vs 0/4 for the bare model), plus business-logic and design flaws it previously walked past.
2. **It's genuine, not memorized.** Re-run on a **mutated** variant (renamed routes, shifted lines, changed literals) built to defeat training-data recall, pired + Qwen scored an **identical 0.74 recall / 100% critical** — the score didn't move.

The trade-off is honest: pired + a local model now leads on **recall, F1, and critical coverage**; the frontier agent keeps an edge on **raw precision** (fewer false positives). Full methodology, per-category breakdown, the harness-improvement experiment, exact token/cost accounting, and threats to validity are in **[`research/`](./research/)**.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
```

Installs [pi](https://pi.dev) if it is missing, installs pired, and registers the extension so a bare `pi` loads the security layer too. Needs Node.js >= 22.19. No sudo, no daemon, no state outside `~/.pi` and `~/.pired`.

```bash
pired          # review the current directory
```

### Beta access

The repository is private for now, so the `curl` line above cannot fetch anonymously — it starts working when the repo goes public. **If you have been granted repository access**, both of these work today over your GitHub SSH key:

```bash
# one command, if you already have pi
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"        # so a bare `pi` loads it too

# or clone — ./install.sh installs the checkout it is sitting in
git clone git@github.com:mamgad/pired.git && cd pired && ./install.sh
```

Both need `ssh -T git@github.com` to authenticate. Over HTTPS instead, use `npm install -g git+https://github.com/mamgad/pired.git` with a credential helper or token.

<details>
<summary>Other ways to install</summary>

```bash
# npm, directly
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"        # optional: auto-load in plain `pi`

# as a pi package only (no `pired` launcher)
pi install git:github.com/mamgad/pired

# one session, from a clone, installing nothing
pi -e ./extensions/pired.ts --pired-profile review
```

</details>

pired rides pi's full frontend — TUI, `/model` switching, `/login`, themes, sessions, autocomplete, MCP — and adds the security layer on top.

## Quickstart

```bash
# review the code in the current project (read-only, no network gate)
pi -e ./extensions/pired.ts --pired-profile review -p "audit ./src for injection and auth bugs"
```

- **Profiles** — `--pired-profile review | recon | pentest` (default `review`).
  - `review` — read-only code audit, no network gate; works with no config.
  - `recon` / `pentest` — network testing, **blocked until** an authorized scope is present.
- **Scope** — drop a `pired.scope.json` (loaded only when the project is trusted):

  ```json
  {
    "engagement": "acme-webapp",
    "authorized": true,
    "mode": "enforce",
    "targets": { "domains": ["*.acme.test"], "cidrs": ["10.10.20.0/24"] },
    "exclude": { "urls": ["https://app.acme.test/admin/"] }
  }
  ```

- **Findings** — `/findings` exports a Markdown report; engagement state lives in `~/.pired/engagements/<name>/` (see [`FORMAT.md`](./FORMAT.md)).

## The interface

The transcript is the conversation; the ledger is the artifact. Coverage you can only learn by asking the model to `recall gaps` is coverage you will not check — so pired renders it itself, from disk, and puts it on screen **by default**:

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
├─ findings ───────────────────────────────────────────┤
│  ⬤ crit 1  ⬤ high 2  ⬤ med 3                         │
│  ▸ SQLi in /api/transfer amount                      │
│                                                      │
│                                        alt+p to hide │
╰──────────────────────────────────────────────────────╯
```

`/panel` toggles it, `alt+p` does the same without leaving the editor, and `pired --no-panel` starts without it. The dismiss hint is platform-aware — macOS terminals send Option+P as `π` rather than as Meta, so a Mac is told `/panel to hide` instead of a key it cannot press.

Alongside it: a status line carrying findings-by-severity, coverage and the **armed state of the scope gate**; `/coverage` for the full checklist × surface matrix; and blocker dialogs that put the agent's parked questions in front of you the moment they are recorded, so "never stall" doesn't quietly become "never finish".

The panel also renders outside the TUI — `pired-state --watch` for a tmux pane, `--json` for your own status bar. Full tour: **[docs/ui.md](./docs/ui.md)**.

## Documentation

**[docs/](./docs/)** — [quickstart](./docs/quickstart.md) · [the interface](./docs/ui.md) · [the panel](./docs/panel.md) · [coverage](./docs/coverage.md) · [scope](./docs/scope.md) · [profiles](./docs/profiles.md) · [tools](./docs/tools.md) · [workspace](./docs/workspace.md) · [skills](./docs/skills.md) · [models](./docs/models.md) · [theme](./docs/theme.md) · [commands](./docs/commands.md) · [architecture](./docs/architecture.md) · [evaluation](./docs/evaluation.md)

## Models

Model selection is pi's — use **`/model`** (and Ctrl+P). pired registers any custom OpenAI-compatible providers from `~/.pired/models.json` (LM Studio, Ollama, llama.cpp, OpenRouter, proxies) into that picker, alongside your built-in and subscription models.

```json
{ "providers": [ { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-…",
  "models": [ { "id": "qwen/qwen3.8-27b", "contextWindow": 1000000, "reasoning": true } ] } ] }
```

---

## How it works

pired treats an engagement as **durable, disk-backed state** — *trust the workspace, not the model's memory*:

```
checklist × inventory = coverage → hypotheses → findings
                                     + loot / notes / evidence / artifacts / blockers
```

- **`record`** writes hypotheses, findings, inventory, loot, and blockers to an append-only, versioned JSONL workspace.
- **`recall`** queries it (`recall next`, `recall gaps`) so the agent keeps testing while coverage gaps remain — the discipline that drove the recall gains above.
- The **scope gate** keeps `bash` and tool calls on authorized targets. It is **focus / accident-prevention, not a sandbox** — a determined bypass (shell tricks, encoding) defeats it; the real boundary is the container/network. Run pired inside a VM/container scoped to the engagement.

## Architecture

A harness-agnostic **`core/`** (zero pi imports, fully unit-tested) behind a thin pi adapter, so the security logic survives a change of host.

```
core/          security engine — no host imports, test-first (162 tests)
  ontology · workspace · scope · redaction · coverage · tools · prompts · stats
  export · panel · coverage-panel · statusline   (renderers are pure too)
extensions/
  pired.ts     the pi extension (tools, scope gate, prompt, UI, commands, providers)
  lib/         node host services · core->pi tool bridge · provider registration
bin/           pired (launcher) · pired-state (the panel, outside the TUI)
skills/  checklists/   opt-in methodology (web, api, network, code-review)
themes/        the pired theme
docs/          the documentation
eval/          assay — the harness's own test instrument
research/      the benchmark: methodology, results, data
FORMAT.md  PLAN.md
```

## Sub-agents

pired ships **no** sub-agent machinery and takes **no** dependency on one. For delegated recon or adversarial confirmation, install [**pi-subagents**](https://github.com/nicobailon/pi-subagents) — pired cooperates with it when present and works fine without it.

```bash
pi install npm:pi-subagents
```

---

## Development

Built **test-first** with vitest and fake ports (in-memory `Fs`, controllable `Clock`, deterministic `Ids`) — the entire core is exercised with no real I/O.

```bash
npm run check      # tsc --noEmit && vitest run && assay   (162 tests, 87 probes)
npm run assay      # the harness's own probes — see docs/evaluation.md
```

## Security & authorized use

pired is for **authorized** security work only. The scope gate is focus/accident-prevention, not a containment boundary — run pired inside a container or VM scoped to the engagement, and only against systems you are authorized to test.

## License

MIT
