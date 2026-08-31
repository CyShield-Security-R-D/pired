# Scope

The scope gate keeps `bash` and tool calls on authorized targets. It is what makes an offensive profile safe enough to run at all — and it has a boundary you must understand before you rely on it.

> **It is focus and accident-prevention, not a sandbox.** A determined bypass — shell tricks, encoding, an unusual tool — defeats it. The real boundary is the container and the network. Run pired inside a VM or container scoped to the engagement.

That is not a disclaimer bolted on; it is the reason the gate can afford to be a *readable* set of rules rather than an unauditable one.

## The scope file

`pired.scope.json`, in the project directory:

```jsonc
{
  "engagement": "acme-webapp-2026",
  "authorized": true,              // must be true for offensive tools in enforce mode
  "mode": "enforce",               // "enforce" | "warn" | "off"
  "workspace": "~/.pired/engagements/acme-webapp-2026",
  "targets": {
    "domains": ["*.acme.test", "acme.test"],
    "ips": ["10.10.10.5"],
    "cidrs": ["10.10.20.0/24"],
    "urls": ["https://app.acme.test/"]
  },
  "exclude": { "domains": ["admin.acme.test"], "ips": ["10.10.20.1"] }
}
```

The file is copied into the engagement workspace as `scope.json`, so an engagement carries its own authorization record. See [`FORMAT.md` §6](../FORMAT.md).

### Trust

**The scope file is loaded only when the project is trusted in pi.** An untrusted directory cannot authorize its own testing — otherwise cloning a repo would be enough to arm an offensive profile against whatever its scope file named.

If a scope is not loaded, pired falls back to a default: `review` gets `mode: "off"` and `authorized: true` (read-only work needs no gate); `recon` and `pentest` get `mode: "enforce"` and `authorized: false`, which blocks network tools until a real scope arrives.

## Modes

| Mode | Out-of-scope call | Unauthorized engagement |
|---|---|---|
| `enforce` | Blocked. | Network tools blocked. |
| `warn` | Allowed, flagged to the operator. | Allowed, flagged. |
| `off` | No gate. | No gate. |

`warn` is for the case where scope is genuinely ambiguous and you want to see what the agent would have done, not for routine use. The status line renders it in the warning colour precisely so it does not become invisible.

## Matching rules

Documented for interoperability — a scope file should mean the same thing to any tool that reads it.

| Kind | Rule |
|---|---|
| `domains` | `*.base` matches `base` and any subdomain. Otherwise exact. |
| `ips` | Exact match. |
| `cidrs` | IPv4 containment. |
| `urls` | Prefix match on the normalized URL. |
| `exclude` | **Wins over `targets`** — always. |

## What the gate sees

The gate inspects each tool call before it runs, extracting hosts and URLs from the arguments — including the command line of a `bash` call. Its decision is one of:

- **Allowed** — every resolved target is in scope.
- **Out of scope** — at least one target is not, and is named in the refusal.
- **Unresolved** — a network command whose target could not be determined. In `enforce` this is blocked: an unverifiable target is not the same as a safe one.

A refusal reaches the model as a tool result *and* the operator as a notification, because a silently blocked call is indistinguishable from an agent that simply chose not to act:

```
⛨ blocked: Out-of-scope target(s): evil.example. Only authorized targets in the engagement scope may be tested.
```

## Reading the state

The status line always shows the gate. See [The interface](ui.md#the-gate-indicator).

```
review                    no gate — read-only default
⛨ pentest·enforce         armed, authorized
⛨ pentest·warn            flagging, not blocking
⛨ pentest·unauthorized    armed, not authorized — network tools blocked
```

The panel's `scope` section adds the target counts, and `pired-state --json` exposes the whole thing for a status bar.

## Redaction

Loot secrets are stored in plaintext in the workspace because the agent has to reuse them, but they must never cross a boundary that leaves the machine. `/report` masks every captured secret in the exported Markdown, replacing it with `[REDACTED <handle>]` — traceable rather than merely blanked.

The masker is built from the loot ledger itself, so false positives are zero: it only masks values the operator actually captured. `recall loot` returns handles, never secrets, so a stray query cannot re-emit a credential into the transcript. See `core/redaction.ts`.

## Authorized use

pired is for authorized security work only. Only run it against systems you have written permission to test, keep that permission in the engagement record, and treat the scope file as documentation of it — not as a substitute for it.
