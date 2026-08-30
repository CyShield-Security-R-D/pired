# Quickstart

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
```

That installs [pi](https://pi.dev) if it is missing, installs pired, and registers pired's extension with pi so a bare `pi` loads the security layer too. No sudo, no daemon, no state outside `~/.pi` and `~/.pired`.

Requires **Node.js ≥ 22.19** — pired's extension is TypeScript that pi type-strips at load.

### Beta access

The repository is private for now, so `curl` cannot fetch the script anonymously — the one-liner above starts working when the repo goes public. **If you have been granted repository access**, both of these work today over your GitHub SSH key:

```bash
# one command, if you already have pi
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"        # so a bare `pi` loads it too

# or clone — ./install.sh installs the checkout it is sitting in
git clone git@github.com:mamgad/pired.git && cd pired && ./install.sh
```

Both authenticate with your GitHub SSH key; check it with `ssh -T git@github.com`. Over HTTPS instead, use `npm install -g git+https://github.com/mamgad/pired.git` with a credential helper or token.

<details>
<summary>Other ways to install</summary>

**npm, directly:**

```bash
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"     # optional: auto-load in plain `pi`
```

**As a pi package only** (no `pired` launcher):

```bash
pi install git:github.com/mamgad/pired
```

**Without installing anything** — one session, from a clone:

```bash
pi -e ./extensions/pired.ts --pired-profile review
```

**Installer environment:**

| Variable | Default | Meaning |
|---|---|---|
| `PIRED_SOURCE` | `github:mamgad/pired` | npm spec to install from — a fork, a tag, a local path. |
| `NPM_PREFIX` | npm's global root | Install somewhere else. |
| `PIRED_SKIP_PI` | unset | `1` to not install pi. |

</details>

Check it:

```bash
pired --profile review --prompt "list the entrypoints in this repo"
```

## A whitebox review

In the project you want audited:

```bash
pired
```

That is the `review` profile: read-only, no network gate, works with no configuration. It never modifies the target code.

Ask for what you want:

```
audit ./src for injection and auth bugs
```

While it works, three things are worth watching:

- The **[engagement panel](panel.md)**, top-right and up by default — the whole ledger, read from disk rather than from anything the model says. `/panel` (or `alt+p`) toggles it; `pired --no-panel` starts without it.
- The **status line** carries findings by severity, coverage, and open blockers, live.
- **`/coverage`** opens the matrix: which vulnerability class has been settled against which piece of surface.

> On macOS, Option+P types `π` rather than reaching pired, so the panel tells you `/panel to hide` there instead of naming the shortcut. Both do the same thing. [Details](commands.md#on-macos-altp-may-not-reach-pired).

When you want the report:

```
/findings
```

which writes Markdown into the engagement workspace.

## A blackbox engagement

`recon` and `pentest` drive network tools, so they are **blocked until an authorized scope is present**. Drop a `pired.scope.json` in the project:

```json
{
  "engagement": "acme-webapp",
  "authorized": true,
  "mode": "enforce",
  "targets": {
    "domains": ["*.acme.test"],
    "cidrs": ["10.10.20.0/24"]
  },
  "exclude": { "urls": ["https://app.acme.test/admin/"] }
}
```

The scope file is only loaded when the project is **trusted** in pi — an untrusted directory cannot authorize its own testing.

```bash
pired --profile pentest
```

The status line will show `⛨ pentest·enforce`. If it shows `⛨ pentest·unauthorized`, the scope is missing, untrusted, or not marked `authorized`.

Full semantics, matching rules, and what the gate does *not* protect against: [Scope](scope.md).

## Where the engagement lives

```
~/.pired/engagements/<engagement>/
```

Append-only, versioned JSONL ledgers plus evidence and artifacts. It survives the session, so a resumed engagement picks up its coverage, findings, and answered blockers. See [The workspace](workspace.md) and [`FORMAT.md`](../FORMAT.md).

The engagement name comes from the scope file, or from the target directory's basename.

## Pick a model

Model selection is pi's — `/model`, or `Ctrl+P`. pired additionally registers any OpenAI-compatible providers from `~/.pired/models.json` (LM Studio, Ollama, llama.cpp, OpenRouter, proxies) into that picker.

pired is tuned for ~30B open-weight models so client code never has to leave the engagement box. See [Models](models.md).

## Next

- [Profiles](profiles.md) — what `review`, `recon`, and `pentest` each change.
- [The interface](ui.md) — everything on screen.
- [Coverage](coverage.md) — what the percentage actually measures.
- [Commands and keys](commands.md) — the full command, flag, and environment reference.

## Resuming

Two things persist, and only one of them needs a flag.

**The engagement resumes on its own.** pired names it after the target directory's basename, so pointing at the same directory reopens the same workspace — every hypothesis, finding and coverage cell intact:

```bash
pired --target ~/work/acme-app
```

Nothing to remember, no id to pass. `ls ~/.pired/engagements/` lists what exists, and `pired-state --engagement <name>` prints its state without launching anything.

**The conversation is pi's**, and pired forwards any flag it does not own:

```bash
pired -r                    # pick a session to resume
pired -c                    # continue the last one here
pired --session <id>        # a specific one
```

A bare `pi -r` starts **without pired** — the extension is injected by pired's launcher with `-e`, so pi on its own knows nothing about it. Resume through `pired` and the extension comes with it.

The engagement is the durable half. A transcript records how you got there; `findings.jsonl` and `hypotheses.jsonl` are the work product, and a cold start with no transcript loses nothing that matters — the assay tests exactly that as `continuity.resumption_fidelity`.
