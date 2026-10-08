<div align="center">

<img src="docs/banner.svg" alt="pired — security assessment harness: review, recon and pentest profiles, with a live coverage panel" width="100%">

**A security assessment harness for consultants — whitebox review and blackbox testing in one workspace, with coverage tracking that won't let an engagement end early.**

*Runs on your own hardware, so client code never leaves the box. An AI agent, not a toolbox: it ships no scanners; it drives the ones you already have.*

`review` · `recon` · `pentest` — as a [pi](https://pi.dev) extension

</div>

---

## Why pired

A consultant under NDA often *cannot* paste client source into a frontier API — that is a contract term, not a preference. And an engagement is rarely just one half: the same scope buys a code review *and* a test, delivered as one report. pired is built for that shape of work — a thin, durable **security layer** on top of the [pi coding agent](https://pi.dev) (an engagement workspace, a scope gate, a security-operator prompt, and two tools, `record`/`recall`) driving the environment's own tools (`nmap`, `ffuf`, `curl`, `sqlmap`, `semgrep`, …) through `bash`.

Three claims:

- **It runs on your hardware.** Tuned for ~30B open-weight models (Qwen3.8 27B, Gemma 3 27B, DeepSeek), so client code never leaves the engagement box — and it still beats a frontier agent on recall and critical coverage (below). Frontier and subscription models work too, where the engagement allows them.
- **Coverage discipline, not vibes.** `checklist × inventory = coverage → hypotheses → findings`. That matrix is a **test plan**: one cell — one weakness class asked of one recorded element — is one test case, a hypothesis is that case run and given a verdict, and `recall gaps` is the list still outstanding, keeping the agent testing while any remain — and *ruling a class out* recorded as real work, which a findings list cannot express. What the benchmark shows is the security prompt lifting a 27B model past a frontier agent on recall; whether the ledger compounds on top of that is stated as open, below.
- **One workspace, both halves of the engagement.** `review` for whitebox, `recon`/`pentest` for blackbox, over a single engagement ontology, so findings, evidence, and coverage correlate across the whole job instead of living in two disconnected tools.

**What pired is not.** Not a scanner: it owns no detection engines and makes no claim to reproducible, rule-count-comparable output. Not the assessment: it drafts findings for an operator to verify, and the operator signs the report. Two principles keep it that way:

- **An AI agent, not a toolbox.** No bundled scanners. Heavy tooling is opt-in; missing tools are *requested*, not carried.
- **Built to last.** A harness-agnostic **ports & adapters** core with *zero* host imports, so the security engine outlives any single agent frontend.

---

## The benchmark result

A **ground-truth-labeled vulnerable banking app** (53 CWE/OWASP-tagged vulnerabilities, deterministic grader). Same target, same prompt, same grader — the only variable is **harness + model**.

| | Recall | Precision | F1 | Critical recall | Cost/scan |
|---|:--:|:--:|:--:|:--:|:--:|
| **pired + Qwen3.8 27B** *(local)* | **0.74** <sub>[0.70, 0.79]</sub> | 0.65 | 0.69 | **100%** | ~$0.26 |
| codex + gpt-5.6-sol *(frontier)* | 0.68 | **0.80** | **0.74** | 93% | ~$0.19 |
| vanilla pi + Qwen3.8 27B *(no pired)* | 0.59 | 0.56 | 0.57 | 79% | ~$0.16 |

pired's row is **n=5 with a 95% interval**, from an independent re-run ([`research/05`](./research/05-rerun-2026-08.md)) that reproduced the original single-run figures. The baselines are single runs. Scored on the same key, pired's precision rises to 0.73 and F1 to 0.74 once the arms stop being penalised for reporting real frontend bugs the key cannot score.

### What this establishes

**A security-tuned prompt is worth more than a bigger model.** The same 27B model went from F1 **0.57 → 0.69** and critical coverage **79% → 100%**, beating a frontier agent on recall (0.74 vs 0.68) and on critical recall, at a fraction of its parameter count. The gains land where a generic prompt is weak: all cryptographic-failure bugs (4/4 vs 0/4 for the bare model), plus business-logic and design flaws it previously walked past.

**It is genuine, not memorized.** Re-run against a **mutated** variant — renamed routes, shifted line numbers, changed literals, built to defeat training-data recall — recall was **identical**, at 100% critical and 0/6 decoys. The score did not move.

The trade-off is honest: pired leads on **recall and critical coverage**, the frontier agent leads on **raw precision**, and F1 is a tie once scoped to what the key can score.

### What it does not establish

**That the `record`/`recall` machinery caused the lift.** The re-run graded the ledger alongside the report and found it essentially unused — **0.8 records per run** against 61 findings emitted. The engagement apparatus was bypassed, and detection held anyway. So the supported attribution is the *prompt*, not the coverage ledger.

That is not evidence the ledger is worthless; it is evidence that **this benchmark never tested it**. A one-shot detection scan is the task least likely to need durable cross-session state. The experiment that would settle it — persisted versus wiped ledger across k sessions — is built and has not been run.

One further caveat we would rather state than have found: a later prompt revision (*explore-first + coverage floor*) scored **0.81 recall / 0.76 F1** in a **single** run ([`research/03 §5d`](./research/03-results.md)). It is promising, not replicated, and the contamination control above was never re-run against it — so it is not the number in the table.

### The number that matters most

Measured against **real CVEs in real software** — 17 targets built from maintainer security patches, scanning the code immediately before the fix — recall roughly **halves**:

| | teaching app *(DVBank)* | real CVEs *(corpus)* |
|---|:--:|:--:|
| **pired + Qwen3.8 27B** | 0.71–0.74 | **0.25–0.30** |
| codex + gpt-5.6-sol | 0.68 | 0.26 |

**Any claim built on the teaching-app number overstates real-world capability by about 2×**, for both harnesses equally. That gap is the single most important calibration in this project.

The ranges are not decoration. Run pired three times over the same targets and it changes its answer on **half of them**; run codex three times and it reproduces on **5 of 6**. Recall differences of a few points sit inside pired's own run-to-run spread, so we do not claim a ranking.

One caveat matters more than the ranking, and it generalises beyond this project: **a network-capable agent can retrieve the answer.** The corpus is built from pre-patch commits, so the released version *is* the key — and the transcripts show up to 34 `pip download` / `git clone` / `diff -ru` attempts per target. `.git` and changelog stripping cannot prevent that.

Re-run with the network denied through pired's own scope gate and targets restored from pristine snapshots, **pooled recall held at 0.250** — but the two hits took ~1000 seconds of genuine analysis each, against ~150 seconds for the runs that gave up. The score survives the seal; the *method* changes completely. `jinja-1475` is the clean result: full recall, sealed, on a bug codex missed 3/3. See [`research/07`](./research/07-corpus-2026-08.md).

Full methodology, per-category breakdown, exact token/cost accounting, and threats to validity: **[`research/`](./research/)**.

---

## Install

**Nothing yet?** One line, on a box with nothing on it:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
```

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/mamgad/pired/main/install.ps1 | iex"
```

Both scripts survey the box, print exactly what they will install and where, ask once, and then do all of it — Node.js when it is missing or older than 22.19, pi, pired, and the PATH entry that makes the command typeable. **They do not register pired with pi**: `pi` stays the pi you already had, and the security layer arrives only when you type `pired`, which passes it to pi with `-e` for that run (ADR-017). What they do register with pi is two third-party packages, each a row in the plan with its own opt-out: [pi-subagents](#sub-agents) and [pi-mcp-adapter](#mcp). On macOS and Linux `--dry-run` prints the plan and stops and `-y` skips the question; on Windows those are `PIRED_DRY_RUN=1` and `PIRED_YES=1`, because the documented `irm | iex` install has no way to pass arguments.

**It never asks for root.** A vanilla Ubuntu has neither Node nor git, and neither absence is worth a `sudo`: Node comes from nodejs.org as a checksum-verified user-owned tarball under `~/.local/share/pired`, and a `github:` source is fetched over HTTPS when there is no git to clone with. Everything it writes lives in `~/.local/share/pired` and `~/.pired` — `rm -rf` those two and the box is as it was. `~/.pi` is pi's own: the installer writes there only to register pi-subagents and pi-mcp-adapter, and the plan's undo line says how to take each back out. No daemon, no service, no shell hooks beyond the one PATH line it shows you first.

Windows gets its own script because npm lays a global install out differently there and PATH is a registry value, not a line in a dotfile. **It never needs administrator either.** The MSI from nodejs.org does, so it is not used: Node arrives as the per-user `.zip`, checksum-verified against the same `SHASUMS256.txt`, unpacked under `%LOCALAPPDATA%\pired` and pointed at by a directory junction — none of which needs elevation, and neither does the `HKCU` PATH entry. The one thing it will not install for you is `bash`: pi runs the tools through it, but Git for Windows is a ~250MB install with shell integration and file associations, so the script reports it and points you at `winget` or pi's own managed copy.

```bash
pired          # review the current directory
```

**Already have pi?** pired is an ordinary pi package — one command, no npm global, no launcher:

```bash
pi install git:github.com/mamgad/pired
pi                                       # the security layer is loaded
```

That registers it in `~/.pi/agent/settings.json`, and every later `pi` starts with the security layer. It pulls no dependencies of its own — pi supplies the modules the extension imports — and `pi config` lists what it contributed (the extension and the `pired` theme) if you ever want to switch either off. `pi remove git:github.com/mamgad/pired` undoes it.

### Which route

| | what it gives you | writes |
|---|---|---|
| `pi install <src>` | user-wide: every `pi` session loads the security layer | `~/.pi/agent/settings.json` |
| `pi install -l <src>` | this project only — commit `.pi/settings.json` and a teammate's first trusted `pi` installs it for them | `.pi/settings.json` |
| `pi -e <src>` | one session, from a temporary clone | nothing |
| `install.sh` / `install.ps1` | the `pired` and `pired-state` launchers on top of the package, plus Node.js itself when the box has none — a bare `pi` is left untouched | npm global + PATH |

`<src>` is any pi package source: `git:github.com/mamgad/pired`, an npm spec, or a path to a checkout (`pi install ~/src/pired` — recorded as a path, not copied, so your edits are live on the next start).

The launcher is the only behavioural difference. `pired` starts pi with the profile, thinking level, `--approve`, the `pired` theme and the target directory already set; from a package install you pass what you want yourself:

```bash
pired --profile pentest                                                 # launcher
pi --pired-profile pentest --thinking high --use-theme pired --approve   # bare pi
```

### Beta access

The repository is private for now, so the `curl` line above cannot fetch anonymously — it starts working when the repo goes public. **If you have been granted repository access**, both of these work today over your GitHub SSH key:

```bash
# already have pi — install straight from the private repo
pi install git:git@github.com:mamgad/pired

# no pi yet, or you want the launchers — clone and run the installer
git clone git@github.com:mamgad/pired.git && cd pired && ./install.sh
```

```powershell
# the same, on Windows
git clone git@github.com:mamgad/pired.git; cd pired; .\install.ps1
```

Both need `ssh -T git@github.com` to authenticate. Over HTTPS instead, use `pi install https://github.com/mamgad/pired` or `npm install -g git+https://github.com/mamgad/pired.git` with a credential helper or token.

<details>
<summary>Other ways to install</summary>

```bash
# npm global — the launchers, without the installer script
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"        # optional: opt a bare `pi` in too

# project-local, for one engagement
pi install -l git:github.com/mamgad/pired

# one session, from a clone, installing nothing
pi -e ./extensions/pired.ts -e ./extensions/hosts.ts --pired-profile review
```

Both installers keep an existing pi at or above 0.86.1 and upgrade an older one; `PIRED_SKIP_PI=1` forces the skip, `PIRED_SOURCE` chooses what to install from, and `NPM_PREFIX` picks the prefix. They register pi-subagents and then pi-mcp-adapter with pi; `PIRED_SKIP_SUBAGENTS=1` and `PIRED_SKIP_MCP=1` decline each.

</details>

pired rides pi's full frontend — TUI, `/model` switching, `/login`, themes, sessions, autocomplete, MCP — and adds the security layer on top.

## Quickstart

**First, give it a model.** Start `pired` and run **`/provider`** — or pick *"Add a custom provider…"* from pi's own `/login`. It asks for the base URL and token of a server you are already running (LM Studio, Ollama, llama.cpp, vLLM, or anything OpenAI-compatible), asks that server what it serves, and registers it into `/model`. See [Models](./docs/models.md).

```bash
# review the code in the current project (read-only, no network gate)
pi -e ./extensions/pired.ts -e ./extensions/hosts.ts --pired-profile review -p "audit ./src for injection and auth bugs"
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

- **Findings** — `/findings` browses them and `/report` exports a Markdown report; engagement state lives in `~/.pired/engagements/<name>/` (see [`FORMAT.md`](./FORMAT.md)).

- **The report carries its own coverage** — the exported Markdown ends with what was tested, not only what was found: cases settled, the hypotheses that ruled a class out against specific surface, and the classes and surface nobody reached, named rather than counted. A findings list answers "what did you find" and cannot answer "what did you look at", and the second question is what separates an assessment from a scanner run. Targets read as `POST /api/split-bill` rather than as the inventory id behind them.

- **Report-grade findings** — a finding carries what the flaw is, what it costs the client in their terms, and the concrete fix; `record` says which of the three is still missing, and the exported report marks an unwritten section rather than quietly leaving it out. CVSS vectors are validated against the version they claim — v4.0 by default, v3.1 when an engagement requires it — so a v3.1 vector cannot enter the ledger under a v4.0 label. `recall finding id=<id>` reads one back in full, which is what a rewrite pass (inline, or handed to a `pired-investigate` worker — see `skills/ops-technical-writer`) works from.

- **Correcting the ledger** — tell the agent a finding is not real, that the client has accepted the risk, or to set it aside, and it records the decision as a status with your reason; the finding keeps its place in the report and leaves the open count. A row that should never have been recorded can be retired outright. Nothing is erased: the ledger is append-only, so every version is still in the file above the tombstone. `/dedupe` folds duplicates an older engagement already accumulated into one row each, moving every reference onto the surviving id so no coverage is lost — it shows what it would do and writes only when you say so.

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
│  105 of 170 cases · 65 gaps                          │
│  ▲ 7  ● 98  ◐ 3  ⊘ 2                                 │
│                                                      │
├─ scope ──────────────────────────────────────────────┤
│  ● authorized · gate enforce                         │
│  domains 1 · cidrs 1                                 │
│                                                      │
├─ findings ───────────────────────────────────────────┤
│  ! 1 confirmed, not written up                       │
│  ⬤ crit 1  ⬤ high 2  ⬤ med 3                         │
│  ▸ SQLi in /api/transfer amount                      │
│                                                      │
│                                  F7 expand · F6 hide │
╰──────────────────────────────────────────────────────╯
```

`/panel` or `F6` toggles it; `F7` or `/maximize` expands it for reading and scrolling. Use F6/F7 in Windows Terminal / PowerShell to avoid Alt+P model-binding conflicts. Legacy Alt shortcuts remain available where supported; macOS hints show the command fallbacks. `pired --no-panel` starts without it.

The coverage section counts **cells** and the hypotheses section counts **claims** — `record` fans one piece of reasoning across every target it applies to, so the two are different numbers over the same ledger — and the `!` line counts confirmed claims that no finding has been written for yet, because confirming settles a cell and only a finding reaches the client.

Alongside it: a status line carrying findings-by-severity, coverage and the **armed state of the scope gate**; `/coverage` for the full checklist × surface matrix; and notifications for new questions, without interrupting an active form. `/blockers` lists every parked question, waiting ones first, with explicit answer and dismiss actions. Escape from an approval leaves it unanswered.

The panel also renders outside the TUI — `pired-state --watch` for a tmux pane, `--json` for your own status bar. Full tour: **[docs/ui.md](./docs/ui.md)**.

### The same thing, running

A whitebox `review` of **DVBank** — the ground-truth-labeled vulnerable banking app from the benchmark above — driven by a 27B model on the local box. It opens on the engagement it is about to run, and the brief that sets the rule the rest of the session is judged against: *anything not in the ledger does not count.*

<img src="docs/demo-prompt.gif" alt="pired opening on the dvbank engagement: the review profile, the local 27B model, an empty coverage panel, and the operator typing the brief" width="100%">

Then it works. The agent greps for sinks and settles test cases while the panel counts surface, hypotheses and findings as they land:

<img src="docs/demo-review.gif" alt="pired reviewing DVBank: a grep for injection sinks, with the engagement panel counting surface, hypotheses and findings as they are recorded" width="100%">

And the artifact it leaves behind — hypotheses browsable by class, including the ones it *refuted*, and a finding opened to its CWE, severity and exact target:

<img src="docs/demo-ledger.gif" alt="the pired ledger: the hypotheses browser filtered by class, and a critical finding opened to CWE-640, class authn and target auth_routes.py" width="100%">

The counters are the agent's own claims, recorded as it worked. What survives an independent grader is a separate question, and the honest answer is [the benchmark](#the-benchmark-result) — not the panel.

## Documentation

**[docs/](./docs/)** — [quickstart](./docs/quickstart.md) · [the interface](./docs/ui.md) · [the panel](./docs/panel.md) · [coverage](./docs/coverage.md) · [scope](./docs/scope.md) · [profiles](./docs/profiles.md) · [tools](./docs/tools.md) · [workspace](./docs/workspace.md) · [skills](./docs/skills.md) · [models](./docs/models.md) · [theme](./docs/theme.md) · [commands](./docs/commands.md) · [architecture](./docs/architecture.md) · [testing](./docs/testing.md) · [evaluation](./docs/evaluation.md)

## Models

Model selection is pi's — use **`/model`** (and Ctrl+P). pired registers any custom OpenAI-compatible providers from `~/.pired/models.json` (LM Studio, Ollama, llama.cpp, OpenRouter, proxies) into that picker, alongside your built-in and subscription models.

Adding one is a wizard rather than a JSON file: pired puts **"Add a custom provider…"** in pi's own **`/login`** list, and **`/provider`** opens the same thing by name. It asks for the base URL and token, asks the host what models it serves, works out the context window and the reasoning format, writes `~/.pired/models.json` `0600`, and registers the host without a restart. A token given as `$ENV_VAR` is stored as the reference, not the key.

```json
{ "providers": [ { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_KEY",
  "models": [ { "id": "qwen/qwen3.8-27b", "contextWindow": 265000, "reasoning": true } ] } ] }
```

---

## How it works

pired treats an engagement as **durable, disk-backed state** — *trust the workspace, not the model's memory*:

```
checklist × inventory = coverage → hypotheses → findings
                                     + loot / notes / evidence / artifacts / blockers
```

- **`record`** writes hypotheses, findings, inventory, loot, and blockers to an append-only, versioned JSONL workspace.
- **`recall`** queries it (`recall next`, `recall gaps`) so the agent keeps testing while coverage gaps remain. This is the harness's central bet; see [what the benchmark does and does not establish](#what-it-does-not-establish).
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
bin/           pired (launcher) · pired-state (the panel, outside the TUI) · pired-ledger (record/recall from outside pi)
skills/  checklists/   opt-in methodology (web, api, network, code-review)
themes/        the pired theme
docs/          the documentation
eval/          assay — the harness's own test instrument
research/      the benchmark: methodology, results, data
FORMAT.md  PLAN.md
```

## Sub-agents

pired delegates through [**pi-subagents**](https://github.com/nicobailon/pi-subagents) when it is installed; without it pired works as before and simply does not delegate. The supported stack is `pi-subagents ≥ 0.71.0` on `pi ≥ 0.86.1`, which is what the installers enforce and what was measured. An older pi-subagents, such as 0.66, still registers the workers. But it sends the full `subagent` tool schema with every request, while 0.71's lazy loader keeps the parent's standing cost small. At session start pired registers four security-operator agents — **`pired-scout`** (attack-surface mapping), **`pired-investigate`** (deep dive on one lead), **`pired-verify`** (adversarial refutation) and **`pired-escalate`** (impact amplification) — and, on an engagement that opts in by setting `maxAgents` in its scope file, or for one run with `pired --agents 8` or `/agents 8` in the TUI, authorizes the model to use them without forcing it to. **Delegation is off by default:** in v5's pre-registered trial it found about as many true positives as the single agent at a higher cost and lower precision ([ADR-029](docs/decisions.md)). In v6 it helped slightly on GLM-5.3 Flash, but on GPT-6 Luna the delegating session stopped after a median 20 minutes and found fewer bugs ([ADR-039](docs/decisions.md)).

A child is an in-process foreground pi session that loads pired's own `record`/`recall` bound to the parent's workspace and arms the engagement scope gate: its records are durable immediately, and the parent reads them back with `recall`. Children start fresh, share no conversation history, run one at a time, have per-role turn and time budgets, and return a short handoff. The parent gate refuses any agent that is not one of the four, so external runners (claude-code, codex-exec, …) cannot be launched. See [Delegation](docs/delegation.md) and [ADR-027](docs/decisions.md).

`recall query=context refs=["src/routes.ts"]` retrieves the relevant shared model, surface, claims and blockers after delegation or compaction. A worker's durable output is what it records in the ledger and saves under `evidence/`. pi-subagents keeps the worker's transcript and run artifacts under pi's own session directory (`~/.pi/agent/sessions/…`, or the OS temp directory), not in the owner-only engagement workspace.

The installers register the package with pi and require a compatible version; `PIRED_SKIP_SUBAGENTS=1` declines it (delegation is then unavailable). To install it separately:

```bash
pi install npm:pi-subagents
```

Unlike pired itself, this one *is* registered with pi, so it loads in every `pi` run rather than only in `pired`. See [ADR-021](docs/decisions.md).

## MCP

[**pi-mcp-adapter**](https://github.com/nicobailon/pi-mcp-adapter) gives pi's model the MCP servers you configure, through one proxy tool. The installers register it with pi after pi-subagents, and update a registered `npm:pi-mcp-adapter` older than **2.33.0**. The floor is the scope gate's: pired checks every MCP call against the engagement scope through the adapter's approval broker, and before 2.33.0 the adapter did not send the broker a call it had cached as approved for the session, so one session grant let later calls past the check. A version pinned below the floor, or a fork, is left alone, and the installer says what the scope check needs from it. `PIRED_SKIP_MCP=1` declines it. To install it separately:

```bash
pi install npm:pi-mcp-adapter
```

Like pi-subagents, it is registered with pi, so it loads in every `pi` run rather than only in `pired`.

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
