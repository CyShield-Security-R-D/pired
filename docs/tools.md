# Tools: `record` and `recall`

pired adds exactly two tools. Everything else the agent uses — `bash`, file reads, whatever else pi and your other extensions provide — is unchanged.

The premise is *trust the workspace, not the model's memory*. `record` writes engagement state to an append-only, versioned JSONL workspace; `recall` reads it back. Both survive the turn, the session, and a compaction.

## `record`

One tool for all state; the `kind` picks the shape.

| `kind` | Required | Also takes |
|---|---|---|
| `model` | `section`, `text` | the target model — `section` is one of `what`, `actors`, `invariants`, `boundaries`, `flows` |
| `note` | `text` | |
| `evidence` | `name`, `content` | — writes the file and **returns the path to cite** |
| `host` | `value` | `ip`, `tech[]` |
| `service` | `host`, `port` | `proto`, `name` |
| `endpoint` | `path` | `host`, `method`, `params[]`, `auth` |
| `param` | `name` | `endpoint`, `location` |
| `tech` | `name` | `host`, `version` |
| `hypothesis` | `statement`, `target`, `class` | `approach`, `outcome`, `evidence`, `basis[]`, `findingId` |
| `finding` | `title`, `severity`, `target` | `class`, `cwe`, `cvss`, `description`, `repro`, `evidence[]`, `status`, `source`, `hypothesisId` |
| `blocker` | `question` | `blockerType`, `priority`, `options[]`, `blocks[]`, `context` |
| `loot` | `handle`, `secret` | `lootType`, `username`, `target`, `source` |

Pass `id` to update an existing record. `handle` belongs to loot only; it is never a record's id.
A finding names the hypothesis it writes up with `hypothesisId`, and the link is written on both rows.

- `severity`: `info` | `low` | `medium` | `high` | `critical`
- `outcome`: `proposed` | `testing` | `confirmed` | `refuted` | `inconclusive`
- `priority`: `low` | `medium` | `high`

### When a call is wrong

Every reply says what happened (ADR-040).

- **Refused.** The call is a tool error. It names the field to fix and, for a missing required field, gives
  the call to send instead, built from the one that was sent. Nothing is written by a refused call. A call
  refused for the same reason as the one before it is told so, and one sent again unchanged is told it will
  be refused again.
- **Recorded, with fields dropped.** The reply starts `Not stored:` and names each field the write did not
  keep, with the reason: a field the kind does not take, a value outside the set a field takes, a field
  pired sets itself. Everything else in the call was recorded.
- **Read under another name.** When the canonical field is absent, the call is read the way agents
  commonly send it, and the reply ends `Read this call as: …`. A canonical field that was sent always wins.
  - `kind` is inferred when the call leaves it out and its fields fit exactly one kind, or the call names an
    existing record by `id`. Otherwise the call is refused, with the kinds its fields fit.
  - On an endpoint, `endpoint` is read as `path`, and a request line (`POST /api/login`) as `method` and `path`.
  - On a model section, `value` or `content` is read as `text`.
  - On a finding, `file` or `location` is read as `target`, where a finding's location goes.
  - A record id sent as `handle`, `hypothesis`, `hypothesis_id` or `finding` is read by the kind of record
    it names. A finding sent with a hypothesis's id as its own `id` is recorded as a new finding linked to it.
    Before ADR-040, it was minted under the hypothesis's id, in the other store.

### How the pieces connect

This is the part that makes coverage work, and it is worth reading even if you never call these tools yourself — it is what the agent is being asked to do.

**Coverage is your checklist's classes × the surface *you have recorded*.** A host or endpoint that was never recorded has no cells, so it can never show as tested and `recall gaps` cannot route to it. Record the surface as you discover it.

**A cell is settled by a hypothesis outcome, not by a finding.** `confirmed` marks it vulnerable; `refuted` marks it clear. Ruling a class out is real work and only counts if the refutation is recorded — otherwise the cell stays untested no matter how carefully it was examined.

**Refutations are recorded in bulk.** Settling one cell per call would be hundreds of calls, so `target` and `class` both accept lists and the cross product is recorded in one call — one call, several classes, the single reason they share.

**A confirmed hypothesis should also become a finding**, tagged with the same `class`, so the finding maps back to its cell.

### The bigger picture, and why it is not a ledger row

Every other record is an atom: one endpoint, one cell, one bug. Atoms are what
coverage counts, but they do not add up to an understanding of the target — and
the understanding is what produces a good hypothesis in the first place. Nothing
held it, so it lived in the context window and died at the first compaction:
findings survived, the theory that found them did not.

`record kind=model` is where it lives now.

```
record kind=model section=what        text="A retail payments API. Holds balances, moves money between customers."
record kind=model section=invariants  text="A balance never goes negative. A refund never exceeds its payment."
```

Two things make it different from everything else here:

**A section is replaced, not appended.** This is the one record you are meant to
rewrite. An observation is true forever; an understanding is a draft that gets
corrected, and stacking revisions would leave the agent reading two answers and
picking one.

**It is injected into every future session.** A cold start reads it before doing
anything else, so a resumed engagement begins already knowing the target instead
of re-deriving it. That is also why it is budgeted — a document that grows
without limit is charged on every turn of every session that follows.

**Invariants are hypothesis generators.** "A balance never goes negative" is a
question about what makes one go negative, asked of a specific endpoint. These
are the bugs that no checklist lists and no scanner sees, which is why the class
of miss they belong to — access control, IDOR, business logic — is the one this
harness is measured on.

### The engagement, on every write

Every `record` ends with a line saying where the engagement now stands:

```
Recorded finding f3 [high] IDOR on /api/user
Engagement: surface 41 · coverage 38% · 112 test cases outstanding · 6 findings · 2 open blockers.
```

The operator has always had this — the panel redraws on every write. The agent,
which is the thing deciding what to do next, could only see it by stopping to
ask. It rides on the tool result rather than in the system prompt deliberately:
these numbers move on every write, and a block that changes every turn at the
front of the context invalidates the cache behind it, while the same line at the
tail costs nothing. It is derived from the view the panel renders, so the number
the agent reasons from and the number on screen cannot drift apart.

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
| `finding` | With `id=<finding>`, one finding in full: description, impact, remediation, repro, evidence, CWE, CVSS, target. |
| `cleared` | Cells a refutation settled, oldest first, for a second look. `class=` narrows it. |
| `pass` | Which pass is open, the lens it runs under, and what that lens can reach. A single-pass engagement says so and points back at coverage. |
| `challenge` | What is unchallenged, worst first. With `id=<finding>`, the brief for breaking that one: the class's control case, the entitlement question, and what its evidence does not yet show. |
| `blockers` | Open blockers only. |
| `loot` | **Handles only** — never secrets. |
| `notes` | The engagement notebook. |
| `model` | The target model, or how to write one if there is none. |
| `context` | A bounded snapshot of the shared state: the model, the checklist, surface, hypotheses, findings and open blockers. `refs=[…]` narrows it to exact ledger IDs or source paths. It is rebuilt from disk on every call, so a worker sees what another just recorded. It carries no transcript and no loot secrets. |

`next` and `gaps` are the ones that keep an engagement honest: they are how the agent stays systematic and avoids quitting early.

On an engagement that works in [passes](commands.md#pass--working-an-engagement-in-more-than-one-sweep), `next` routes by the open lens instead of by the matrix, and a settled matrix is reported as the end of the route sweep rather than the end of the work. `gaps` keeps answering about the matrix in every pass — a `gaps` that quietly answered something else would be a second derivation of the same question.

This is the harness's central bet, and it is worth being precise about its evidence: the published benchmark **did not test it**. The detection lift it measured is attributable to the security-tuned prompt, because in the re-run the ledger was barely written to and detection held anyway. A one-shot scan is the task least likely to need durable state. See [Evaluation](evaluation.md#what-the-benchmark-does-not-establish).

## Blockers and momentum

The harness is built never to stall. When the agent needs an operator decision, a credential, or a scope call, it records a `blocker` and routes around it via `recall next`.

`blocks[]` names what the blocker gates — a hypothesis id, a cell key (`element:class`), or an element id — and those cells go `blocked` in the matrix, which keeps them out of the "settled" count and out of `recall next`.

In the TUI the blocker becomes a dialog immediately, and your answer is written back to the same record. See [Blocker dialogs](ui.md#blocker-dialogs).

## Durability

Every record carries a version, an id, and a timestamp; updates append rather than overwrite. Nothing is derived and stored — coverage, gaps, and stats are recomputed from the ledgers on every read, so they cannot drift from the evidence.

The full on-disk contract is [`FORMAT.md`](../FORMAT.md).
