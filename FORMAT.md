# pired — Engagement Workspace Format

> **Status: specification (design phase).** This documents the on-disk formats
> pired reads and writes. It is intentionally independent of any implementation:
> the formats are the artifact meant to outlive the code (see `PLAN.md` §3.1, §5).
> An engagement captured under this spec must remain readable and migratable by
> any future pired or third-party tool.

## 1. Principles

- **Disk is the source of truth.** All durable engagement state lives in files, not in a session transcript or a database.
- **Open, boring formats.** JSON, JSONL, and Markdown only. No binary, no proprietary container.
- **Append-only where possible.** Ledgers (`*.jsonl`) are append-only; "updates" are new records with the same `id` (last-write-wins on read). This is crash-safe and merge-friendly.
- **Branch-independent facts.** A record, once written, is a fact about the engagement, not about a conversation branch. Navigating a session backward never rewinds these files.
- **Tolerant readers.** Unknown fields are preserved, not dropped. A newer writer may add fields an older reader ignores.
- **Versioned + migratable.** Every store is versioned; migrations are forward-only and documented here.

## 2. Location

```
~/.pired/engagements/<name>/      # default; overridable via scope config `workspace`
```

`<name>` is the engagement id (slug of `scope.engagement`). The workspace is kept
**outside the target tree** so loot and notes never land in a repository under review.

## 3. Versioning

- The workspace root holds a `manifest.json` declaring `formatVersion` (integer) and per-store versions.
- **Every JSONL record also carries its own `v` (integer schema version)** so a single file can contain mixed versions during a migration and still be read safely.
- Current `formatVersion`: **1**. All record `v`: **1**.

Migration rules:

- Forward-only. A reader at version *N* can read records at version ≤ *N*.
- On load, pired may rewrite a store to the current version (append-only stores are rewritten atomically via temp-file + rename); the pre-migration file is retained as `<store>.v<old>.bak` until the next clean run.
- Removing or repurposing a field is a **major** format change (bump `formatVersion`) with a migration note in §12. Adding an optional field is **not** a version bump.

## 4. Common record shape (JSONL stores)

Every line in a `*.jsonl` store is one JSON object sharing this base:

```jsonc
{
  "v": 1,                      // record schema version
  "id": "f3a9",                // short, stable id, unique within its store
  "createdAt": "2026-08-23T14:02:11Z",   // ISO-8601 UTC
  "updatedAt": "2026-08-23T15:20:04Z",   // present when the record was superseded
  "kind": "...",               // discriminator (store-specific; see below)
  // ...store-specific fields
}
```

Read semantics: group by `id`, keep the record with the latest `createdAt`/`updatedAt`.
A record with `"deleted": true` (soft-delete tombstone) hides the id from reads.

Two optional fields travel with a tombstone, because a deletion is the one write
that leaves no visible trace and the file has to explain itself:

```jsonc
{
  "v":1, "id":"f3a9", "kind":"finding", "createdAt":"...", "updatedAt":"...",
  "deleted": true,
  "deletedReason": "recorded against the wrong engagement",
  "duplicateOf": "f2b1"        // set by the duplicate sweep: the id this row became
}
```

Nothing is removed from the file: every superseded line is still above the
tombstone, so a wrong deletion is undone by anyone who can open the ledger.
`record kind=<k> id=<id> delete=true reason="..."` writes one; the operator's
`/dedupe` sweep writes them for rows it folds together.

## 5. `manifest.json`

Single JSON object at the workspace root.

```jsonc
{
  "formatVersion": 1,
  "engagement": "acme-webapp-2026",
  "createdAt": "2026-08-23T14:00:00Z",
  "originPath": "/home/you/clients/acme/webapp",   // optional; see below
  "stores": {
    "inventory": 1, "hypotheses": 1, "findings": 1,
    "blockers": 1, "loot": 1
  }
}
```

`originPath` is the directory the engagement was first opened from, written once and never updated.
An engagement is keyed on that directory's basename, so `~/clientA/backend` and `~/clientB/backend`
resolve to one ledger; recording the origin is what lets a later session say so. **Optional, and its
absence means unknown rather than mismatched** — every engagement created before it existed has
none. Adding it is not a `formatVersion` bump (§3).

## 6. `scope.json`

Single JSON object — the authorized engagement scope. Canonical copy of the
`pired.scope.json` the engagement was launched with. See `PLAN.md` §8.

```jsonc
{
  "v": 1,
  "engagement": "acme-webapp-2026",
  "authorized": false,             // must be true for offensive tools in enforce mode
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

Matching rules (documented for interoperability): `*.base` matches `base` and any
subdomain; IPs match exactly; CIDRs use IPv4 containment; `exclude` wins over
`targets`. URL entries are prefix matches on the normalized URL.

## 7. `checklist.json`

Single JSON object — the vuln-class checklist for the engagement, seeded from a
target-type template (`web` / `api` / `network` / `code-review`) and editable.
Drives the coverage matrix (§9 of this doc, `PLAN.md` §6).

```jsonc
{
  "v": 1,
  "targetType": "web",
  "classes": [
    { "id": "authz",   "title": "Broken access control / IDOR", "cwe": ["CWE-639","CWE-284"] },
    { "id": "sqli",    "title": "SQL injection",                "cwe": ["CWE-89"] },
    { "id": "ssrf",    "title": "Server-side request forgery",  "cwe": ["CWE-918"] },
    { "id": "xss",     "title": "Cross-site scripting",         "cwe": ["CWE-79"] },
    { "id": "secrets", "title": "Exposed secrets / keys",       "cwe": ["CWE-798"] }
    // ...
  ]
}
```

## 8. Ledgers

### 8.1 `inventory.jsonl` — the attack surface (what EXISTS)

```jsonc
{ "v":1, "id":"h1", "kind":"host",     "createdAt":"...", "value":"app.acme.test", "ip":"10.10.20.7", "tech":["nginx","node"] }
{ "v":1, "id":"s1", "kind":"service",  "createdAt":"...", "host":"h1", "port":443, "proto":"tcp", "name":"https" }
{ "v":1, "id":"e1", "kind":"endpoint", "createdAt":"...", "host":"h1", "method":"GET", "path":"/api/user", "params":["id"], "auth":"session" }
```

`kind` ∈ `host` | `service` | `endpoint` | `param` | `tech`. Endpoints/params are
the surface elements coverage is computed over.

### 8.2 `hypotheses.jsonl` — test cases, executed (what was DONE)

```jsonc
{
  "v":1, "id":"y7", "kind":"hypothesis", "createdAt":"...", "updatedAt":"...",
  "statement":"GET /api/user?id= is IDOR-able",
  "target":"e1",                 // surface element (inventory id) or raw target string
  "class":"authz",               // checklist class id
  "method":"Swapped id to another user's; observed response",
  "outcome":"refuted",           // "proposed" | "testing" | "confirmed" | "refuted" | "inconclusive"
  "evidence":"evidence/y7-idor.txt",
  "findingId":"f3a9"             // set when outcome=confirmed and a finding was created
}
```

Refuted and inconclusive hypotheses are **retained** (no-retest + report rigor).

### 8.3 `findings.jsonl` — the defect ledger

```jsonc
{
  "v":1, "id":"f3a9", "kind":"finding", "createdAt":"...", "updatedAt":"...",
  "title":"IDOR in /api/user allows reading other users",
  "severity":"high",             // "info" | "low" | "medium" | "high" | "critical"
  "target":"e1",
  "class":"authz",
  "cwe":"CWE-639",
  "cvss":"CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N",  // v4.0 by default; v3.1 accepted
  "description":"...",           // what the flaw is and where
  "impact":"...",                // what it costs the client, in their terms
  "remediation":"...",           // the concrete change that fixes it
  "repro":"1. Log in as user A ... 2. GET /api/user?id=<B> ...",
  "evidence":["evidence/f3a9-req.http","artifacts/f3a9-screenshot.png"],
  "status":"confirmed",          // see below
  "reason":"client accepted; compensating control in the WAF",  // why it carries that status
  "source":"reproduced",         // "scanner" | "inferred" | "observed" | "reproduced"
  "verification":{               // written by a challenge, never by the reviewer that made the claim
    "verdict":"stands",          // "stands" | "amended" | "refuted" | "unresolved"
    "at":"2026-09-07T14:02:11Z",
    "control":"same request with no cookie returned 401; an unrelated note id returned 404",
    "entitlement":"model.md actors: notes are private to their owner; there is no sharing feature",
    "basis":["evidence/f3a9-anon.txt"],
    "live":true
  },
  "hypothesisId":"y7"
}
```

`status` is one of `suspected`, `open`, `confirmed`, `triaged`, `reported`,
`refuted`, `false-positive`, `accepted-risk`, `ignored`. The last four are
*disposed*: the finding stays in the ledger and in the report, keeps its history,
and leaves the open-findings count that the header, the statusline and `recall
status` show. They are how a decision — the client accepted the risk, the
operator judged it not real, it was set aside — is recorded without deleting
anything, and `reason` is what a client asks about three months later. Deleting
is the separate act, and it is for a row that should never have been recorded at
all.

`suspected` is the default, and it means nobody has challenged this yet. It
exists because the operator prompt asks the agent to record a plausible lead
rather than drop one, and until there was a word for that state a hedge and a
proven bug were both `open` and reached the client in one list. `confirmed` has
to be earned: the class's control case was run and, for the access-control
classes, entitlement was established. `refuted` is a challenge breaking the
finding on cited grounds — kept distinct from `false-positive`, which is the
operator's own judgement, because "who decided this was not real, the tool or the
consultant?" is a question the row has to be able to answer.

`source` says how the claim arose before anybody challenged it, so a consultant
signing a report can tell a scanner line nobody re-issued from a hand-built
proof.

`verification` is written by the challenge pass. `control` is the load-bearing
field: a finding is not proven by the attack working, it is proven by the attack
working **and** the control failing — an IDOR whose unauthenticated control also
succeeds is a public resource. A refutation carries `basis`; one without it is
recorded as `unresolved` and settles nothing. See [ADR-007](docs/decisions.md).

`description`, `impact` and `remediation` are the three sections a client's report
is read for — what it is, what it costs us, what we do about it — and the export
writes all three whether or not they were recorded, marking an unwritten one
rather than omitting it. A finding missing any of them is not report-ready, and
`record` says so at the moment it is cheap to fix.

`cvss` is validated on write against the version its own prefix claims: `CVSS:4.0`
(the default) or `CVSS:3.1` (for an engagement that requires it). The two are
different metric sets — v4.0 has no Scope, adds Attack Requirements, and splits
impact across the vulnerable system (VC/VI/VA) and the systems it reaches next
(SC/SI/SA) — so a vector cannot be converted by editing the prefix, and one that
mismatches its version is rejected instead of stored.

Findings are a subset of confirmed hypotheses. `cwe`/`cvss` align with the stable
standards named in `PLAN.md` §3.1; findings export can render SARIF from these.

### 8.4 `blockers.jsonl` — parked operator questions (async)

```jsonc
{
  "v":1, "id":"b2", "kind":"blocker", "createdAt":"...", "updatedAt":"...",
  "type":"approval",             // "decision" | "input" | "approval" | "scope-clarification" | "credential-request"
  "question":"Approve an active SQLi confirmation against /login (single benign payload)?",
  "context":"Error-based SQLi strongly suspected; needs approval for an active check.",
  "options":["approve","deny"],  // optional (for type=decision/approval)
  "blocks":["y12"],              // work items (hypothesis/coverage-cell/target ids) this gates
  "priority":"high",             // "low" | "medium" | "high"
  "status":"open",               // "open" | "answered" | "dismissed"
  "answer":"approve",            // present when answered
  "answeredAt":"...", "answeredBy":"operator"
}
```

Blockers are deduped by (`question` + `blocks`). Answering (via the app or by
editing this file directly) sets `status:"answered"` + `answer`; the agent resumes
the gated work on its next `recall`. See `PLAN.md` §7.1.

### 8.5 `loot.jsonl` — credentials / secrets

> **Sensitive.** This file holds plaintext secrets and MUST be `chmod 600`. It is
> never auto-shared. Redaction applies only at export/share boundaries (`PLAN.md` §9).

```jsonc
{
  "v":1, "id":"c1", "kind":"loot", "createdAt":"...",
  "handle":"cred:web-admin",     // stable reference used instead of reprinting the secret
  "type":"password",             // "password" | "hash" | "token" | "apikey" | "cookie" | "key"
  "username":"admin",
  "secret":"S3cr3t!",            // plaintext (file is chmod 600)
  "target":"h1",
  "source":"y5",                 // how it was obtained (hypothesis/evidence ref)
  "notes":"Reused on SSH"
}
```

Elsewhere (context, notes, reports) secrets are referred to by `handle`; the raw
`secret` value is masked at every export/share boundary.

## 9. `model.md`

The target model: what the system is for, who its actors are, the invariants
that must hold, where untrusted data crosses in, and the flows that matter.

Markdown with one `##` heading per section, rendered in a fixed order —
`what`, `actors`, `invariants`, `boundaries`, `flows` — followed by any section
a hand edit has added. Unlike every other store here, a section is **replaced**
on write rather than appended: the ledgers hold atoms that accumulate, while an
understanding of the target is a draft that gets corrected, and keeping the
superseded version would leave the agent reading two answers.

The order is fixed because this file is injected into the system prompt. A
document that reshuffled itself on every write would move the cached prefix
behind it every turn.

```markdown
# Target model

## what
A retail payments API. Holds customer balances and moves money between them.

## invariants
A balance never goes negative. A refund never exceeds its original payment.
```

## 10. `notes.md`

Freeform Markdown, append-oriented. Convention: timestamped `##` sections so
appends are unambiguous and human-diffable.

```markdown
## 2026-08-23T14:10Z
Login uses a legacy session cookie without SameSite. Worth an CSRF pass on state-changing endpoints.
```

## 11. `evidence/` and `artifacts/`

- `evidence/` — raw tool output and request/response dumps that back findings/hypotheses. Filenames should embed the referencing id, e.g. `evidence/y7-idor.txt`.
- `artifacts/` — screenshots, dumped files, PoC scripts, e.g. `artifacts/f3a9-screenshot.png`.
- Records reference these by **workspace-relative path**. No separate index file is required; the referencing record is the index.

## 12. Derived data (never stored)

- **Coverage matrix** = `checklist.classes` × inventory surface elements — a **test plan**, where one cell is one test case (this class, asked of this element), a hypothesis is that case executed, and a gap is a case not yet run. Each cell's status is derived from `hypotheses` outcomes (`not-tested` | `testing` | `clear` | `vulnerable` | `blocked` | `n/a`). A cell is `blocked` when an open blocker in `blockers.jsonl` gates it. Coverage is recomputed on read so it can never drift from the ledgers.
- **`recall` summaries** (coverage, gaps, next, …) are projections over these files, not stored artifacts.

## 13. Migration log

- `formatVersion 1` — initial specification. No prior versions.

*(Future breaking changes append here with the old→new field mapping and reader behavior.)*
