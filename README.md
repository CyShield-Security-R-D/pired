<div align="center">

# pi(red)

**A security-testing harness for authorized pentesting, secure code review, and research — built to run on local, open-weight models.**

*An AI agent, not a toolbox. It ships no scanners; it drives the ones you already have.*

`pentest` · `code-review` · `recon` — as a [pi](https://pi.dev) extension

</div>

---

## Why pired

Most security "AI tools" bundle a pile of scanners and wrap a model around them. **pired takes the opposite bet:** the intelligence belongs in the *model and the workflow*, not in bundled tooling. pired adds a thin, durable **security layer** on top of the [pi coding agent](https://pi.dev) — an engagement workspace, a scope gate, a security-operator prompt, and two tools (`record`/`recall`) — and lets the agent drive the environment's own tools (`nmap`, `ffuf`, `curl`, `sqlmap`, `semgrep`, …) through `bash`.

Three principles shape it:

- **AI agent, not a testing tool.** No bundled scanners. Heavy tooling is opt-in; missing tools are *requested*, not carried.
- **Local-model-first.** Tuned to run well on ~30B open-weight models (Qwen3.8 27B, Gemma 3 27B, DeepSeek) as well as frontier/subscription models.
- **Built to last.** A harness-agnostic **ports & adapters** core with *zero* host imports, so the security engine outlives any single agent frontend.

---

## The headline result

We benchmarked pired on a **ground-truth-labeled vulnerable banking app** (53 CWE/OWASP-tagged vulnerabilities, deterministic grader). Same target, same prompt, same grader — the only variable is **harness + model**.

| | Recall | Precision | F1 | Critical recall | Cost/scan |
|---|:--:|:--:|:--:|:--:|:--:|
| **pired + Qwen3.8 27B** *(local)* | **0.74** | 0.63 | 0.68 | **100%** | ~$0.26 |
| codex + gpt-5.6-sol *(frontier)* | 0.68 | **0.80** | **0.73** | 93% | ~$0.19 |
| vanilla pi + Qwen3.8 27B *(no pired)* | 0.59 | 0.56 | 0.57 | 79% | ~$0.16 |

**Two findings stand out:**

1. **The harness is worth more than the model (for recall).** Wrapping the *same* 27B model in pired lifted recall **0.59 → 0.74** and critical coverage **79% → 100%** — overtaking a frontier agent on both, and closing ~65% of the F1 gap to it. The gains concentrate exactly where a generic prompt is weak: it found **all** cryptographic-failure bugs (4/4 vs 0/4 for vanilla) and 3 critical code-injection sinks the bare model walked past.
2. **It's genuine, not memorized.** Re-run on a **mutated** variant (renamed routes, shifted lines, changed literals) built to defeat training-data recall, pired + Qwen scored an **identical 0.74 recall / 100% critical** — the score didn't move.

The trade-off is honest: pired + a local model is the stronger **detector** (higher recall, no missed criticals, but noisier); the frontier agent is the stronger **precision/F1** reviewer. Full methodology, per-category breakdown, exact token/cost accounting, and threats to validity are in **[`research/`](./research/)**.

---

## Install

Requires [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`).

```bash
# try it in one session, no install:
pi -e ./extensions/pired.ts --pired-profile review

# install so it auto-loads everywhere:
pi install git:github.com/mamgad/pired
pi            # then pick a model with /model
```

pired rides pi's full frontend — TUI, `/model` switching, `/login`, themes, sessions, autocomplete, MCP — and adds the security layer on top.

## Quickstart

```bash
# review the code in the current project (read-only, no network gate)
pi -e ./extensions/pired.ts --pired-profile review -p "audit ./src for injection and auth bugs"
```

- **Profiles** — `--pired-profile pentest | recon | review` (default `review`).
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
core/          security engine — no host imports, test-first (89 tests)
  ontology · workspace · scope · redaction · coverage · tools · prompts · stats · export
extensions/
  pired.ts     the pi extension (tools, scope gate, prompt, /findings, providers)
  lib/         node host services · core->pi tool bridge · provider registration
skills/  checklists/   opt-in methodology (web, api, network, code-review)
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
npm run check      # tsc --noEmit && vitest run   (89 tests)
```

## Security & authorized use

pired is for **authorized** security work only. The scope gate is focus/accident-prevention, not a containment boundary — run pired inside a container or VM scoped to the engagement, and only against systems you are authorized to test.

## License

MIT
