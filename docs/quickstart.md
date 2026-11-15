# Quickstart

## Install

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
```

```powershell
# Windows
powershell -c "irm https://raw.githubusercontent.com/mamgad/pired/main/install.ps1 | iex"
```

Either one installs [pi](https://pi.dev) if it is missing (or upgrades one older than 0.86.1), installs pired, and puts the `pired` command on your PATH. Neither registers pired with pi. A bare `pi` does not load the security layer. That arrives only through `pired`, which passes it to pi with `-e` for that run ([ADR-017](decisions.md)).

The one thing the installers do register with pi is [pi-subagents](https://github.com/nicobailon/pi-subagents), the package pired delegates through ([Delegation](delegation.md)). It gets its own row in the plan, and it loads in every `pi`, not only in `pired`. A missing package is installed. An `npm:pi-subagents` below 0.71.0 is upgraded. A pinned or forked entry is left alone and reported. `PIRED_SKIP_SUBAGENTS=1` declines the row ([ADR-021](decisions.md)).

On macOS and Linux the script starts by surveying the box and printing the plan — every component, where it goes, and the exact PATH line it wants to add — then asks once before doing any of it:

```
  This will install

    + node       ~/.local/share/pired/node     v22 from nodejs.org, checksum-verified
    + pi         ~/.local/share/pired/bin      @earendil-works/pi-coding-agent
    + pired      ~/.local/share/pired/bin      from github:mamgad/pired
    + subagents  ~/.pi                         npm:pi-subagents — delegation, loads in every pi
    + PATH       ~/.bashrc                     export PATH="$HOME/.local/share/pired/bin:$PATH"

  Nothing runs as root. No daemon, no service, no shell hooks.
  Undo: rm -rf ~/.local/share/pired ~/.pired · pi remove npm:pi-subagents

  Proceed? [Y/n]
```

`--dry-run` prints that plan and changes nothing; `-y` (or `PIRED_YES=1`) skips the question, which is what you want in a provisioning script. With no terminal to ask at — a CI job, `curl … | sh` under a pipe — the plan is still printed and the install proceeds.

Run the installer again to update pired. From a clone, run `git pull --ff-only` first so the installer uses the updated checkout. Verification loads the installed extension through pi and checks that `--pired-profile` is registered; it needs no model credentials or network access.

If an earlier update reports `unknown option: --pired-profile` together with `failed to load extension`, update and rerun the installer. The profile error follows the extension failing to register its flags. A previous release imported a provider adapter through a path pi's loader could not resolve outside a development checkout. `pired --help` alone did not catch that failure; `pired -- --help` reaches pi and should list `--pired-profile` under its extension flags.

**Node.js ≥ 22.19** is required — pired's extension is TypeScript that pi type-strips at load — but on macOS and Linux you do not have to install it yourself. When the box has none, or has one too old, the script fetches the current v22 from nodejs.org, checks its SHA-256 against the release manifest, and unpacks it under `~/.local/share/pired/node`. It is a `.tar.gz` rather than the smaller `.tar.xz` on purpose: a minimal Ubuntu has no `xz`, and installing one would mean the `sudo` the script promised not to ask for. A vanilla Ubuntu has no `git` either, so a `github:` source is fetched over HTTPS from codeload instead of cloned.

Nothing runs as root, there is no daemon and no service, and everything written lives in `~/.local/share/pired`, `~/.pi` and `~/.pired`. The one thing it changes outside those is a single PATH line in your shell rc — shown in the plan, appended under its own `# pired` comment.

Windows has its own script, and expects Node.js ≥ 22.19 to be installed already — it does not fetch one for you. npm puts its global shims in the prefix itself rather than `prefix/bin` there, and PATH is a registry value rather than a line in a dotfile, so it offers to add the prefix to your user PATH instead of printing an `export` line for you to paste. It also checks for `bash`: pired drives the tools already on the box and pi runs them through `bash`, which a bare Windows install does not have, so the script points you at Git for Windows when none is found.

### From a clone

Clone first to read the installer before it runs. `./install.sh` installs the checkout it is sitting in, so the same route installs a branch you are working on:

```bash
git clone https://github.com/mamgad/pired.git && cd pired && ./install.sh
```

```powershell
# .\install.ps1 installs the checkout beside it
git clone https://github.com/mamgad/pired.git; cd pired; .\install.ps1
```

<details>
<summary>Other ways to install</summary>

**npm, directly:**

```bash
npm install -g --ignore-scripts github:mamgad/pired
pi install "$(npm root -g)/pired"     # optional: opt a bare `pi` in too
```

**As a pi package only** (no `pired` launcher):

```bash
pi install git:github.com/mamgad/pired
```

**Without installing anything** — one session, from a clone:

```bash
pi -e ./extensions/pired.ts -e ./extensions/hosts.ts --pired-profile review
```

**Installer environment:**

| Variable | Default | Meaning |
|---|---|---|
| `PIRED_SOURCE` | `github:mamgad/pired` | npm spec to install from — a fork, a tag, a local path. |
| `NPM_PREFIX` | npm's global root | Install somewhere else. When the script brings its own Node the default is `~/.local/share/pired`; when npm's root is not writable — a root-owned system node — it falls back to `~/.local` on its own and says so. |
| `PIRED_SKIP_PI` | unset | `1` to not install or upgrade pi. A pi kept below 0.86.1 this way also holds back the pi-subagents row, since pi-subagents 0.71 needs pi ≥ 0.86.1. |
| `PIRED_SKIP_SUBAGENTS` | unset | `1` to not install or upgrade pi-subagents. pired then runs without delegation. |
| `PIRED_YES` | unset | `1` to install without the confirmation prompt (same as `-y`). |
| `PIRED_NO_ANIM` | unset | `1` for plain line-at-a-time output instead of spinners. |

</details>

## Give it a model

A fresh install has none, and nothing else works until it does. Start it:

```bash
pired
```

Then **`/provider`** — or *"Add a custom provider…"*, the first row in pi's own `/login`. Point it at a server you are already running:

```
Which server   LM Studio · Ollama · llama.cpp · vLLM · OpenRouter · anything OpenAI-compatible
Base URL       192.168.1.20:1234/v1     (the scheme is filled in; a LAN address is http)
API token      Enter for none — or $ENV_VAR, stored as the reference, never the key
Model          pired asks the server what it serves and offers the list
```

It works out the context window and the reasoning format from what the server reports, writes `~/.pired/models.json` readable only by you, and puts the model in `/model` without a restart. Details, and the JSON if you would rather write it yourself, in [Models](models.md).

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

- The **[engagement panel](panel.md)**, top-right and up by default — the whole ledger, read from disk rather than from anything the model says. `/panel` (or `F6`) toggles it; `pired --no-panel` starts without it.
- The **status line** carries findings by severity, coverage, and open blockers, live.
- **`/coverage`** opens the matrix: which vulnerability class has been settled against which piece of surface.

> On macOS, Option+P types `π` rather than reaching pired, so the panel tells you `/panel to hide` there instead of naming the shortcut. Both do the same thing. [Details](commands.md#on-macos-altp-may-not-reach-pired).

When you want the report:

```
/report
```

which writes Markdown into the engagement workspace. `/findings` browses them on
screen instead — worst first, with drill-down into each one's evidence.

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

If the model you want is not there yet, add it from **`/login`** — pired puts *"Add a custom provider…"* in pi's own login list — or with **`/provider`**. Base URL, token, model: it asks the host what it serves and fills in the rest.

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
