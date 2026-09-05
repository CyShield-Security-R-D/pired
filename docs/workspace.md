# The Workspace

An engagement is durable, disk-backed state. It survives the turn, the session, a compaction, and a machine reboot — which is what lets a long engagement be resumed, audited, and handed to a colleague.

```
~/.pired/engagements/<engagement>/
```

Overridable with `workspace` in the scope file. The engagement name comes from the scope file, or from the target directory's basename.

The workspace is kept **outside the target tree** so loot and notes never land in a repository under review.

## Layout

```
~/.pired/engagements/acme-webapp/
  manifest.json        format + per-store versions + the directory it came from
  scope.json           the authorized scope, as loaded
  checklist.json       the vuln classes for this engagement
  inventory.jsonl      the attack surface — what EXISTS
  hypotheses.jsonl     test cases — what was DONE
  findings.jsonl       confirmed vulns — what's REAL
  blockers.jsonl       parked operator questions
  loot.jsonl           credentials and secrets (chmod 600)
  model.md             the target model — what the system IS
  notes.md             freeform, timestamped
  evidence/            raw tool output backing findings
  artifacts/           screenshots, PoCs, the exported report
```

## The three ledgers that matter

The ontology is deliberately small, and the split between the first three is the whole design:

| Ledger | Question it answers |
|---|---|
| `inventory.jsonl` | What **exists**? Hosts, services, endpoints, params, tech. |
| `hypotheses.jsonl` | What was **done**? A test case, its class, its target, its outcome. |
| `findings.jsonl` | What is **real**? Confirmed vulnerabilities, with evidence. |

Coverage is the first two multiplied together. Findings are the product. Keeping them separate is what makes "we looked and it was fine" recordable — a claim no findings list can express. See [Coverage](coverage.md).

## And the one file that is not a ledger

`model.md` answers a fourth question the ledgers cannot: what **is** this thing?

Every record above is an atom — one endpoint, one cell, one bug — and atoms are
what coverage counts, but they never add up to an understanding of the target.
That understanding is what produces a good hypothesis in the first place, and
before `model.md` it had nowhere to live: it sat in the context window and died
at the first compaction, so the findings survived and the theory that found them
did not.

It is written a section at a time — `what`, `actors`, `invariants`,
`boundaries`, `flows` — and a section is **replaced** on write, not appended.
That is the opposite rule to every ledger here, and deliberately: an observation
stays true, an understanding gets corrected, and a stack of superseded drafts is
worse than none. It is carried into the system prompt of every later session, so
a resumed engagement starts already knowing the target. See [Tools](tools.md).

## Append-only and versioned

Every line is one JSON object carrying its own schema version, a short stable id, and a UTC timestamp. Updates **append**; reads group by id and keep the newest. A record with `"deleted": true` is a tombstone that hides the id.

Two consequences worth relying on:

- **The history is intact.** A finding's severity changing from `high` to `critical` leaves both records; the engagement can be audited, not just read.
- **Concurrent writers do not corrupt it.** Two sessions against one workspace append rather than rewrite.

Nothing derived is ever stored. Coverage, gaps, `recall next`, and the panel's numbers are all recomputed from the ledgers on read, so they cannot drift from the evidence underneath them.

## Evidence and artifacts

- `evidence/` — raw tool output and request/response dumps backing a finding or hypothesis. Created with `record kind=evidence`, which returns the path to cite.
- `artifacts/` — screenshots, dumped files, PoC scripts, and the Markdown report written by `/report`.

Records reference these by **workspace-relative path**, and the path is verified on write — a citation that does not resolve is rejected. There is no index file: the referencing record *is* the index.

## Reading it yourself

The workspace is plain text and meant to be read.

```bash
cd ~/.pired/engagements/acme-webapp
jq -r 'select(.severity=="critical") | .title' findings.jsonl
jq -r '[.class, .target, .outcome] | @tsv' hypotheses.jsonl | sort | uniq -c
pired-state --engagement acme-webapp --json | jq .coveragePct
```

## Format contract

The on-disk format is specified, versioned, and documented for interoperability — including the migration rules and the exact shape of every record type — in **[`FORMAT.md`](../FORMAT.md)**.

Forward-only migrations: a reader at version *N* reads records at version ≤ *N*. Adding an optional field is not a version bump; removing or repurposing one is.
