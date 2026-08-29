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

- The **status line** carries findings by severity, coverage, and open blockers, live.
- **`alt+p`** opens the [engagement panel](panel.md) — the whole ledger, from disk.
- **`/coverage`** opens the matrix: which vulnerability class has been settled against which piece of surface.

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
