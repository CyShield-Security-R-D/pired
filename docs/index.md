# pired Documentation

pired is an engagement harness for security consultants: a whitebox code review and a blackbox test in one workspace, with coverage tracking that will not let an engagement end early.

It is a **security layer on top of [pi](https://pi.dev)** — an engagement workspace, a scope gate, a security-operator prompt, and two tools (`record` / `recall`) — driving the tools already on your box (`nmap`, `ffuf`, `curl`, `sqlmap`, `semgrep`, …) through `bash`. It ships no scanners of its own.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/mamgad/pired/main/install.sh | sh
```

Then, in the project you want reviewed:

```bash
pired
```

For the full first-run flow, including blackbox engagements, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) — install, run a first review, run a first pentest.
- [Profiles](profiles.md) — `review`, `recon`, `pentest`, and what each one changes.
- [Scope](scope.md) — the scope file, the matching rules, and what the gate does and does not protect.
- [Coverage](coverage.md) — checklist × surface, how a cell is settled, and how the percentage is computed.
- [Commands and keys](commands.md) — slash commands, shortcuts, CLI flags, environment variables.

## Interface

pired rides pi's full TUI and adds a security-operator interface on top of it.

- [The interface](ui.md) — the whole UI surface: status line, panel, coverage view, dialogs, transcript rendering.
- [The engagement panel](panel.md) — the side rail: modes, sections, placements, and rendering it outside the TUI.
- [Theme](theme.md) — the `pired` theme, and how to use your own.

## Engagement

- [Tools: `record` and `recall`](tools.md) — the agent's durable memory, and how to query it.
- [The workspace](workspace.md) — where an engagement lives on disk and what is in it.
- [Skills and checklists](skills.md) — the opt-in methodology layer.
- [Models](models.md) — local and hosted models, and `~/.pired/models.json`.

## Reference

- [Architecture](architecture.md) — ports and adapters, and why the security core has no host imports.
- [Evaluation](evaluation.md) — assay, the ratchet, and the benchmark research.
- [Workspace format](../FORMAT.md) — the on-disk record format, versioned and documented for interoperability.

## Authorized use

pired is for authorized security work only. The scope gate is focus and accident-prevention, **not** a containment boundary — a determined bypass defeats it. Run pired inside a container or VM scoped to the engagement, and only against systems you are authorized to test. See [Scope](scope.md).
