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

One more optional field, on engagements that work in passes (§5, ADR-018):

```jsonc
{ "v":1, "id":"f3a9", "kind":"finding", "createdAt":"...", "pass": 2 }
```

`pass` is the pass that **created** the row, and it is set on creation only — a
row corrected in pass 3 still reports the pass that found it, which is what makes
"what did this pass add" a measurement rather than a restatement. **Absent means
pass 1**, so a ledger written before passes existed and one on its first pass
read identically, and an engagement that does not run passes writes the field
never. It is written by the record path and deleted from caller input: a caller
that could assert which pass it was on could assert the coverage that goes with
it, the same rule `verification` follows (§8.3).

One more, on every row created since Phase 3 of delegation v6:

```jsonc
{ "v":1, "id":"f3a9", "kind":"finding", "createdAt":"...", "by": "pired-investigate" }
```

`by` is who **created** the row:

| `by` | written by |
|---|---|
| `lead` | the session's own model, through `record` |
| a worker's agent name (`pired-scout`, `pired-investigate`, `pired-verify`, `pired-escalate`) | a pired worker, named by its gate's identity; `worker` when the role could not be read |
| `scribe` | the scribe, writing the review into the ledger |
| `operator` | the `pired-ledger` CLI, run from outside any pired session |

The record path stamps it from what the host says is writing, and deletes it from
caller input, as it does `pass`. A caller that could name its author could pass a
worker's lead off as the lead's. It is set on creation only: a merge, an update by
id and the `/dedupe` sweep keep the creator. **Absent means unknown**, which is
every row written before it existed.

A finding also carries `contributors` once someone other than its creator has
changed it through a merge: the list of those authors, in the order they first
did, in `by`'s vocabulary. It is additive and set by the record path only. A
verification by any contributor, like one by the creator, is *verified by its
finder* (§8.3).

## 5. `manifest.json`

Single JSON object at the workspace root.

```jsonc
{
  "formatVersion": 1,
  "engagement": "acme-webapp-2026",
  "createdAt": "2026-08-23T14:00:00Z",
  "originPath": "/home/you/clients/acme/webapp",   // optional; see below
  "pass": 2,                                       // optional; see below
  "stores": {
    "inventory": 1, "hypotheses": 1, "findings": 1,
    "blockers": 1, "loot": 1, "sessions": 1
  }
}
```

`pass` is which pass is open, counting from 1, and **absent means 1**. It lives on
the manifest rather than in the session because a pass outlives a session — a
consultant closes the laptop mid-pass, and a counter that reset on restart would
hand the second morning's work the first morning's lens. Written by `/pass`; the
lens each pass runs under comes from `scope.json` (§6), not from here, because the
ladder is configuration and the count is state.

`stores` lists every JSONL store the workspace holds. `sessions` (§8.6) holds settle records
rather than ledger rows: it is read by `recall status` and the benchmark's stop classifier, and
by nothing that counts coverage or findings. A manifest written before it lists no `sessions`, and
the store reads as empty.

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
  "exclude": { "domains": ["admin.acme.test"], "ips": ["10.10.20.1"] },
  "passes": {                      // optional; absent means one `route` pass
    "enabled": true,
    "lenses": ["route", "file", "invariant", "adversarial"]
  },
  "budget": { "tokens": 20000000, "minutes": 240 },   // optional (+ "deadline"); see below
  "maxVerifiers": 2,                                  // optional; see below
  "verifier": { "model": "provider/model-id" }        // optional; see below
}
```

`passes` is the ladder this engagement works through, one lens per pass, clamped
to the last rung past the end. Absent or `"enabled": false` is a single `route`
pass — today's behaviour exactly, and the behaviour every number in `research/`
was measured against. The lenses are `route` (the coverage matrix as it stands),
`file` (files the ledger names but never recorded as surface), `invariant` (rules
in `model.md` no hypothesis has tested), `adversarial` (unchallenged findings,
then cleared cells) and `credentialed` (surface settled before the engagement held
a credential). `PIRED_PASSES=route,file` overrides it for a headless run, and
`PIRED_PASSES=off` turns it off. See ADR-018.

`budget` holds one session's ceilings, per session like `maxAgents`: `tokens` across every model
call the session pays for — the lead's turns, its workers and verifiers, and the scribe — and
`minutes` of wall clock from the session's start. Each takes a non-negative integer; a value that
is not one is dropped, and either may be absent. Absent altogether means no budget and no budget
line, which is the default. When one is set, pired states it on every request, in the tail block
it refreshes after the cached prompt (never in the system prompt), as one line stating used and
left: "Budget: 12 of 45 min used, 33 left · 6.1M of 20M tokens used, 13.9M left." From 80% of
either ceiling it adds that the budget is a ceiling, not a target, and to record what is
established; at a ceiling it says to settle (§8.6), or, when the lead has settled and no work has
been written since, which outcome it settled with. pired enforces nothing: the
ceiling is stated, and whoever set it enforces it. An optional `deadline` (ISO 8601) is an
absolute stop time: when present, minutes spent are read as the ceiling less the minutes left
before it, so the count follows the clock that stops the session; with no `minutes`, the ceiling
is session start to the deadline. The benchmark harness writes the ceilings it enforces into the
candidate's scope only — the run's time limit as `minutes` and the launch time plus that limit as
`deadline` — and never one it does not; the baseline's scope carries no `budget`. `recall status`
repeats the line. See the 3.2 ADR.

`maxVerifiers` is declared by the Phase 3 groundwork and given its semantics by 3.1. It caps
verifier launches separately from `maxAgents`, takes a non-negative integer, and one that is not
reads as `0`, the rule `maxAgents` follows.

Above `0`, `maxVerifiers` is the number of `pired-verify` launches a session may
make, charged to it and not to `maxAgents`, so verification does not compete with
work launches; once spent it does not fall back on `maxAgents`. At `0` (the
default) a verifier is one more worker under `maxAgents`, as before. `maxAgents: 0`
with `maxVerifiers` above it is the verify-only configuration: the lead does the
work and may launch verifiers, nothing else.

`verifier.model` (`provider/id`) registers `pired-verify` on that model instead
of the parent's. It is set here by the operator only — a per-launch override is
still refused — because it sends client code to that model's provider. A value
not in `provider/id` form is ignored.

Matching rules (documented for interoperability): `*.base` matches `base` and any
subdomain; IPs match exactly; CIDRs use IPv4 containment; `exclude` wins over
`targets`. URL entries are prefix matches on the normalized URL.

## 7. `checklist.json`

Single JSON object — the vuln-class checklist for the engagement, seeded from a
target-type template (`web` / `api` / `network` / `code-review` / `firmware`) and editable.
The template is chosen by `scope.targetType` when set, else inferred from the target shape.
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
  "basis":["api/user.go:41: if req.ID != session.UserID"],  // the grounds the claim cites (ADR-040)
  "findingId":"f3a9"             // the finding that writes this up; set on either end of the link
}
```

Refuted and inconclusive hypotheses are **retained** (no-retest + report rigor).

`basis` is what the reviewer cited for the claim, as given — not checked on write. It travels with
the claim it grounds: a re-record of the same claim adds to it, and an outcome moved by id without a
basis drops it with `method` and `evidence`. A second look's grounds are written to the row's
`verification`, never here. Rows written before ADR-040 have no `basis`; the write path dropped it.

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
  "hypothesisId":"y7"            // the hypothesis this writes up; set on either end of the link
}
```

A link between a finding and its hypothesis is written on both rows: recording either one with the
other's id (`hypothesisId` on the finding, `findingId` on the hypothesis) also sets the other end,
unless that end already names a different record, which is left as it was (ADR-040). Rows written
before ADR-040 may carry only the end that was named.

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

Four more `verification` fields are declared by the Phase 3 groundwork and judged by a
later change (3.1):

```jsonc
"verification": {
  "verdict": "refuted", "at": "...", "basis": ["api/notes.py:40"],
  "by": "pired-verify",          // who judged it, in the vocabulary of `by` (§4)
  "path":   [{ "at": "api/notes.py:12", "quote": "note = Note.get(request.args['id'])" }],
  "guards": [{ "at": "api/notes.py:40", "quote": "if note.owner_id != user.id: abort(404)" }],
  "tier": "static"               // "static" | "executed"; derived by pired, never taken from the caller
}
```

`path` is the hops from source to sink, and `guards` the checks examined. Each
entry is a cited `file:line` and the text quoted from it.

**The grounded contract (3.1).** The model sends `path`, `guards` and `basis` as
string lists of `"file:line: verbatim text"` (`file:lo-hi: text` for a range of
at most 7 lines); pired stores `path` and `guards` as `{at, quote}` (plus
`commentOnly: true` for a quote that is only a comment) and leaves `basis` as
sent. On write, the record tool reads each cited file under the engagement root
— the lead's directory, whatever cwd a worker was launched in — trying the path,
then the path from the writer's cwd, then the basename; two files of one name
are reported as ambiguous. Only on an engagement with a live target is the
workspace's `evidence/` read as well. A quote is *grounded* when, after
whitespace is normalised, it appears within 3 lines of the cited line **and**
occurs at most 3 times in its file, with a floor of 6 non-space characters: a
line the file repeats (`return nil, err`) cannot identify one, and a guard it
has once (`if not user:`) can. These numbers were fixed before any v6 run and
are not tuned on corpus runs. `at` is stored relative to the engagement root.

- Any ungrounded quote: the verdict is `unresolved` and the status does not move;
  the reply prints the text actually at the cited line. `path` and `guards` are
  kept only when every quote was grounded. The unresolved verification records
  `attempted` (the verdict the caller asked for) and `ungrounded` (how many
  quotes missed), so downgrade rates are counts.
- Confirming on an engagement with no live target (no targets in `scope.json`):
  `control` plus a `path` of at least two grounded hops, the first the source and
  the last the sink. With a live target the bar is unchanged: `control`, and
  `entitlement` for the access-control classes; there a `path` entry that is not
  a quote (a route) is dropped with a note.
- Refuting with no live target: `basis` plus at least one grounded quote, in
  `basis`, `guards` or `path` — the guard, or the line that makes it not a
  finding. With a live target: `basis`, and a target that was reachable.
- `tier` is `executed` only on an engagement with a live target, when the
  verification was live against it or cites a saved exchange with it (a request
  and its response); otherwise `static`, and always `static` on a review of
  source. It is written on an earned verdict only, and it is a label, not a gate.
- `by` is who made the verification, stamped from where the call ran. A finding
  is *independently verified* when `verification.by` is neither its `by` nor any
  of its `contributors` (authors whose merge changed it); otherwise it was
  *verified by its finder*. The scribe counts as the lead, whose buffer it
  transcribes.
- Once a verification has settled a finding, its finders may not change its
  `status`, `title`, `description`, `target` or `severity` by id (a grounded look
  is still allowed), and any merge into it keeps its status and verification.

**Who may write what.** Enforced by the child gate and the record tool, by
refusing with a reason rather than stripping (ADR-028):

| writer | may do |
|---|---|
| lead (and its scribe) | Anything. Its confirm and refute are judged; a self-confirmation is kept and labelled "verified by its finder". |
| `pired-scout` | No findings. |
| `pired-investigate`, `pired-escalate`, and a worker whose role could not be read (`worker`) | Create findings, which land `suspected`. `status=confirmed` or `refuted` is refused, as are the operator's dispositions. By id, only findings it recorded, and not their status or claim once a verification settled them; a create that merges into another author's finding is allowed, keeps that finding's status and adds the writer to its `contributors`. |
| `pired-verify` | `confirmed`, `refuted` or `suspected` on a finding by id, with grounds (its keys: `status`, `basis`, `path`, `guards`, `control`, `entitlement`, `live`, `reason`). A finding it creates (for a hypothesis it confirmed) lands `suspected`: no confirming in the write that creates the row. |
| every worker | No `kind=settle`. |
| operator (`pired-ledger`) | Anything, as the lead. |

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

### 8.6 `sessions.jsonl` — how sessions were settled

Written by `record kind=settle outcome=finished|paused|blocked note="…"` (3.2): where a session
leaves the engagement. `finished` says the work given is done, `paused` that work remains the
session could still do, `blocked` that what remains needs the operator.

```jsonc
{
  "v":1, "id":"s1", "kind":"settle", "createdAt":"...", "by":"lead",
  "outcome":"paused",            // "finished" | "paused" | "blocked"
  "note":"auth routes left; the admin panel needs a credential",
  "remainder":{                  // computed by pired from the ledger; a caller's is ignored
    "openCells":12, "unmappedAreas":["src/admin"],
    "unverified":{ "pired-investigate":["f3","f9"] },
    "inconclusive":["y4"], "openBlockers":["b2"],
    "spent":{ "tokens":6100000, "minutes":52 }
  }
}
```

- **Only `outcome` and `note` are the caller's.** `remainder` is computed by pired from the
  ledger when the settle is written: coverage cells not settled (`openCells`, absent when there is
  no checklist), source directories with no recorded surface (`unmappedAreas`, when the host has a
  directory listing), unchallenged findings keyed by the `by` that created them (`unverified`;
  `(unknown)` for rows written before `by`), `inconclusive` hypotheses, `openBlockers`, and what
  the session had `spent` when a budget is set. A remainder sent with the call is never read. A
  part with nothing in it is omitted.
- **It never refuses** on what remains, and ends nothing: the session goes on, and the reply
  lists the remainder and the areas (§12) in full.
- **Append-only history.** A settle is never updated or deleted (`delete=true` is refused); a
  later settle is another row. The last one is the one with the latest `createdAt`.
- **Only the lead settles.** The record tool refuses `kind=settle` from any author but `lead` — a
  worker, the scribe, the operator's CLI — and a worker's child refuses it too. Readers (`recall
  status`, the benchmark telemetry) take the newest settle whose `by` is `lead` and ignore any other.
- **Superseded:** a settle followed by ledger writes by anyone but `scribe` or `operator` —
  created, or updated (`updatedAt`) after it — no longer describes where the session stopped. The
  benchmark's stop classifier reads it that way; the file itself is not changed. *An
  approximation:* a row keeps its creator's `by` through updates, and there is no `updatedBy`, so
  a scribe's or the operator's update to a row the lead created counts as work after the settle,
  and a lead's update to a scribe-created row does not. The benchmark runs the scribe off, and the
  operator does not write during a benchmark run.

An engagement written before this store existed has no `sessions.jsonl`, and reads
as having no settles.

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
- **Areas** group the recorded surface into places (`core/areas.ts`, 3.2). An element's area is the
  directory of its `file`; with no file, its host (a param with no file goes where its endpoint
  does); with neither, one area for surface with no file or host. Past 20 directories, every
  directory is cut to the deepest depth that leaves 20 or fewer, so each element is still counted
  somewhere. Each area's status comes from its coverage cells, `n/a` excluded: `settled` when every
  cell is clear or vulnerable, `untested` when none has been touched, `blocked` when what is not
  settled is all blocked, else `in progress`; with a count of the findings (not disposed) whose
  target or location falls in it. A `file` that resolves outside the source root (an absolute path
  elsewhere, or one climbing out with `..`) goes to one area of its own and marks nothing in the
  tree as mapped. Given a directory-only listing of the source tree, the listed directories with no
  recorded surface in or below them are **unmapped**, outermost only — and only once some surface
  names a file in the tree. pired takes that listing (of the session's cwd, skipping hidden,
  dependency, build and runtime-state directories) only for a source-only engagement, or once a
  `file` is recorded: on a live target the cwd is not what is reviewed. Areas are
  shown bounded in the tail block, in full in a settle's reply, and in `recall status`; they rank
  nothing and are never stored.
- **`recall` summaries** (coverage, gaps, next, …) are projections over these files, not stored artifacts.

## 13. Migration log

- `formatVersion 1` — initial specification. No prior versions.
- `formatVersion 1`, Phase 3 groundwork — `by` on every created row (§4); the
  `budget` and `maxVerifiers` scope fields (§6); `verification.by`, `path`, `guards`
  and `tier` (§8.3); the `sessions` store (§5, §8.6). All additive and optional, so
  no version bump: a workspace written before them reads unchanged, its rows with
  no author and no `sessions.jsonl`.
- `formatVersion 1`, Phase 3 item 3.1 — the grounded verification contract and the
  who-writes-what rules (§8.3), `maxVerifiers` enforced and the optional
  `verifier.model` (§6). Additive: no field changes meaning for a row written
  before it, and a verification with no `by`, `path`, `guards` or `tier` reads as
  one whose author and tier are unknown. Later in 3.1: `contributors` on findings
  (§4), `commentOnly` on a stored quote, and `attempted` and `ungrounded` on an
  unresolved verification (§8.3) — additive in the same way.

- `formatVersion 1`, 3.2 — `sessions.jsonl` is written (`record kind=settle`, §8.6) and the scope
  `budget` is read and stated (§6); areas are derived (§12). Additive, no version bump: a
  workspace with no `sessions.jsonl` has no settles, and a scope with no `budget` shows no line.

*(Future breaking changes append here with the old→new field mapping and reader behavior.)*
