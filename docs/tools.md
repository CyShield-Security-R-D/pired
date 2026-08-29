# Tools: `record` and `recall`

pired adds exactly two tools. Everything else the agent uses — `bash`, file reads, whatever else pi and your other extensions provide — is unchanged.

The premise is *trust the workspace, not the model's memory*. `record` writes engagement state to an append-only, versioned JSONL workspace; `recall` reads it back. Both survive the turn, the session, and a compaction.

## `record`

One tool for all state; the `kind` picks the shape.

| `kind` | Required | Also takes |
|---|---|---|
| `note` | `text` | |
| `evidence` | `name`, `content` | — writes the file and **returns the path to cite** |
| `host` | `value` | `ip`, `tech[]` |
| `service` | `host`, `port` | `proto`, `name` |
| `endpoint` | `path` | `host`, `method`, `params[]`, `auth` |
| `param` | `name` | `endpoint`, `location` |
| `tech` | `name` | `host`, `version` |
| `hypothesis` | `statement`, `target`, `class` | `approach`, `outcome`, `evidence` |
| `finding` | `title`, `severity`, `target` | `class`, `cwe`, `cvss`, `description`, `repro`, `evidence[]`, `status` |
| `blocker` | `question` | `blockerType`, `priority`, `options[]`, `blocks[]`, `context` |
| `loot` | `handle`, `secret` | `lootType`, `username`, `target`, `source` |

Pass `id` to update an existing record.

- `severity`: `info` | `low` | `medium` | `high` | `critical`
- `outcome`: `proposed` | `testing` | `confirmed` | `refuted` | `inconclusive`
- `priority`: `low` | `medium` | `high`

### How the pieces connect

This is the part that makes coverage work, and it is worth reading even if you never call these tools yourself — it is what the agent is being asked to do.

**Coverage is your checklist's classes × the surface *you have recorded*.** A host or endpoint that was never recorded has no cells, so it can never show as tested and `recall gaps` cannot route to it. Record the surface as you discover it.

**A cell is settled by a hypothesis outcome, not by a finding.** `confirmed` marks it vulnerable; `refuted` marks it clear. Ruling a class out is real work and only counts if the refutation is recorded — otherwise the cell stays untested no matter how carefully it was examined.

**Refutations are recorded in bulk.** Settling one cell per call would be hundreds of calls, so `target` and `class` both accept lists and the cross product is recorded in one call — one call, several classes, the single reason they share.

**A confirmed hypothesis should also become a finding**, tagged with the same `class`, so the finding maps back to its cell.

### Evidence is a path, not a blob

```
record kind=evidence name="sqli-login.txt" content="<raw output>"
  → evidence/sqli-login.txt
record kind=finding title="SQLi in login" ... evidence=["evidence/sqli-login.txt"]
```

Evidence fields are **workspace-relative paths to files that exist**, never inline text. Paths are verified on write: a finding or hypothesis citing a path that does not resolve is **rejected**. Cite only what was actually saved, or omit the field.

This keeps raw tool output out of the context window — the agent carries its read on what matters, not the dump — while leaving the dump itself attached to the record that depends on it.

### In the transcript

A recorded finding renders with its severity first, because a finding is the engagement's actual product:

```
⦿ CRITICAL  SQL injection in /api/transfer amount parameter
```

## `recall`

```
recall query=<query> [limit=50]
```

| Query | Returns |
|---|---|
| `next` | The next actionable cell — untested first, then in-flight, skipping blocked. |
| `gaps` | Untested and blocked cells. |
| `coverage` | The matrix summary, plus vulnerable and blocked cells by name. |
| `inventory` | Recorded surface. |
| `hypotheses` | Each with outcome, class, target. |
| `findings` | Each with severity, status, target. |
| `blockers` | Open blockers only. |
| `loot` | **Handles only** — never secrets. |
| `notes` | The engagement notebook. |

`next` and `gaps` are the ones that keep an engagement honest: they are how the agent stays systematic and avoids quitting early. Per the benchmark, this discipline — not a bigger model — is where the recall lift came from. See [Evaluation](evaluation.md).

## Blockers and momentum

The harness is built never to stall. When the agent needs an operator decision, a credential, or a scope call, it records a `blocker` and routes around it via `recall next`.

`blocks[]` names what the blocker gates — a hypothesis id, a cell key (`element:class`), or an element id — and those cells go `blocked` in the matrix, which keeps them out of the "settled" count and out of `recall next`.

In the TUI the blocker becomes a dialog immediately, and your answer is written back to the same record. See [Blocker dialogs](ui.md#blocker-dialogs).

## Durability

Every record carries a version, an id, and a timestamp; updates append rather than overwrite. Nothing is derived and stored — coverage, gaps, and stats are recomputed from the ledgers on every read, so they cannot drift from the evidence.

The full on-disk contract is [`FORMAT.md`](../FORMAT.md).
