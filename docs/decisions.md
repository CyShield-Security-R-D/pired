# Architecture decisions

One entry per decision that would otherwise be re-litigated. Each says what was true when the
decision was made, what was chosen, and what it costs — so a later reader can tell a considered
trade-off from an accident.

[Architecture](architecture.md) describes the shape of the system. This file records why the shape
is that way at the points where it could reasonably have gone another way.

**Status values:** `accepted` · `superseded by ADR-NNN` · `reversed`

---

## ADR-001 — The panel counts claims; the coverage bar counts cells

**Status:** accepted · 2026-09-05

### Context

A hands-on assessment ran two `review` engagements against a Flask/React banking app. At one point
the panel read `▲ confirmed 120` while the ledger held **15 distinct claims**. The inflation is
structural, not a bug in the counter: `record` accepts lists for `target` and `class` and writes the
cross product (`core/tools.ts`), and hypothesis identity is `(target, class)` (`core/identity.ts`).
A hypothesis row *is* a coverage cell. One piece of reasoning about authentication, asked of 44
endpoints, is 44 rows.

Labelling 44 rows "confirmed" invites an operator to read 44 discovered vulnerabilities. On a
consultant's screen before a client call, that is a factor-of-eight overstatement.

Separately, `PanelData.coverage` — the `▲ n ● n ◐ n ⊘ n` row documented in `docs/ui.md` — exists in
the renderer and is set by **no caller**. The panel had a place to show cell counts honestly and
never used it.

### Decision

Give each section one unit and label it by its section:

- **coverage** owns cells. Populate the dead `PanelData.coverage` from `matrix.counts`.
- **hypotheses** owns claims. Count distinct `(class, normalised statement)` pairs.

Normalisation is trim, whitespace-collapse, lowercase. This is a display-layer rollup only.

### Consequences

- The hypotheses number drops sharply on existing engagements. That is the point; it was wrong before.
- `record`'s cross-product semantics are untouched. Cell identity stays `(target, class)`, which the
  dedupe sweep depends on.
- Two numbers now describe the same ledger. The section headings are what disambiguate them, so the
  headings are load-bearing and must not be dropped for width.

### Rejected

**Making the statement part of hypothesis identity.** It would fix the count at the source, but a
claim is refined as an engagement proceeds and re-wording it would fork the cell rather than update
it — turning one settled cell into two, one of them permanently stale.

---

## ADR-002 — A `review` engagement is not gated, and the prompt has to say so

**Status:** accepted · 2026-09-05

### Context

`scopeBlock` (`core/prompts.ts`) has two branches. The graceful one ends *"Read-only local work
(e.g. code review) is still fine"* and fires when scope is `undefined`. The strict one renders
`Authorized engagement: … no targets` followed by `Touch only these targets; anything else is out of
scope — stop and say so.`

`defaultScope` always returns an object, so the graceful branch is unreachable. Every `review`
session receives "no targets" and "touch only these targets" in the same breath.

A capable model reads that literally. On a fresh engagement the first prompt — *"what is this
engagement and what should I do first?"* — produced a refusal and a parked blocker, in the profile
the documentation describes as *"read-only, no network gate, works with no configuration."*
Directive prompts walk past it; orientation questions do not, and orientation is what a first-time
user types first.

### Decision

Select the branch on what the scope *says*, not on whether an object exists: emit the no-scope text
whenever the gate is off and no targets are listed.

### Consequences

- The failure mode is now the safe one. A `review` engagement says read-only local work is fine,
  because it is; a `recon`/`pentest` engagement is `enforce` and unauthorized by default and still
  refuses.
- The strict text is reserved for engagements that actually carry targets, where "touch only these"
  is true rather than vacuous.

---

## ADR-003 — The exported report resolves ids and carries its own coverage

**Status:** accepted · 2026-09-05

### Context

`exportFindingsMarkdown` renders `- Target: ${f.target}`, and `f.target` is an inventory id after
resolution. A client report therefore reads `- Target: 9d2fdd` — the one line naming *where the bug
is* is the one line the reader cannot use.

The export is also a findings list and nothing else. An engagement that recorded 231 refutations
ships none of them. Refuting a class is the work that separates pired from a scanner, and it stopped
at the machine boundary.

### Decision

1. Render the resolved element label, falling back to the raw value. `elementLabel` already exists
   (`core/browser.ts`) and already produces `POST /api/split-bill`; move it into `core/target.ts`,
   which already owns the id↔name relation, and re-export it so existing importers are untouched.
2. Append a `## Coverage` section built from `coverageBrief`, which already computes settled over
   applicable, classes cleared, and what is still untested.
3. Widen `ExportInput` with a `labelFor` callback rather than an inventory array, matching
   `renderCoverageBrief`'s existing signature instead of inventing a second convention.

### Consequences

- **Redaction must widen with it.** `redactedSorted` masks only the `findings` array. Element labels
  and coverage text are new strings from the ledger and an inventory record can carry a secret — a
  param named for a token, a host value with credentials in the URL. The redactor is built once and
  applied to the whole input before anything is rendered. This invariant is the reason the change is
  worth reviewing carefully.
- `core/export.ts` stays pure. The coverage view and the label map are computed in the `/report`
  handler and passed in; the exporter never imports `Workspace`.

---

## ADR-004 — Confirmed work that has not reached the report is surfaced, not enforced

**Status:** accepted · 2026-09-05

### Context

Confirming a hypothesis and writing a finding are separate acts, and only the second reaches the
client. During the assessment the ledger held 120 confirmed cells and zero findings, and every
surface agreed there was nothing: the panel said `none recorded`, `/findings` said `no findings
recorded`, and `/report` declined to write. Left to finish, the model did eventually write up nine
of ten confirmed classes — so it is a window, not a permanent hole. It is a window an operator can
ship a report in.

Both link fields already exist — `FindingRecord.hypothesisId` and `HypothesisRecord.findingId` — and
neither was populated once in the whole run. Nothing joins them.

### Decision

Compute the join **by cell** rather than depending on the model to write the link — a finding covers
a hypothesis when they name the same element and the same class, with an explicit `findingId` or
`hypothesisId` honoured when present — but count in **claims**, not cells: a claim is written up when
*any* of its cells has a finding.

Surface it in three places — an `unwritten` filter in `/hypotheses`, a count in the panel's findings
section, and an informational line in `record`'s result.

### Consequences

- The count is honest with zero cooperation from the model, because it reads cells rather than links.
- `record` gains no required field and blocks nothing. This follows the project's standing directive
  to inform rather than script: a harness that refuses to record a finding without a hypothesis id
  teaches the model to invent one.
- Claim identity is the wording, as in ADR-001, so two ways of saying the same thing are two claims.
  On the reference ledger that costs one false positive out of three. The error is in the direction
  of prompting a look, which is what the number is for.

### Corrected during implementation

The first version counted **cells**, and on the reference ledger reported 13 of 14 claims unwritten
when the true answer was one. `record` fans one piece of reasoning across every target it applies to,
and a reviewer writes that finding once — so a claim written up against two of its five endpoints
read as unwritten on the other three. A number that cries wolf on its first engagement is a number
the operator learns to ignore, which is worse than not having it. Counting claims gives 3, and the
one class the assessment had identified by hand as never written up (`reflection`) is among them.

### Rejected

**Auto-linking on write.** Matching by `(target, class)` at record time would set `hypothesisId`
silently and sometimes wrongly — two claims can share a cell — and a wrong link in an append-only
ledger is harder to notice than a missing one.

---

## ADR-005 — Engagement collisions are reported, never resolved automatically

**Status:** accepted · 2026-09-05

### Context

An engagement is keyed on `basename(cwd)` and stored at `~/.pired/engagements/<name>/`. Nothing
records which directory it came from and nothing warns on reuse, so `~/clientA/backend` and
`~/clientB/backend` append to the same append-only ledger. For a tool whose first promise is that
client code never leaves the box, cross-client contamination inside the box is the wrong failure to
leave open.

### Decision

Record `originPath` in `manifest.json` at creation. When a session opens an engagement whose
recorded path differs from the current directory, say so in the banner and notify. Change nothing on
disk.

### Consequences

- Existing engagements have no `originPath` and must not warn. Absence means "unknown", not "mismatch".
- The operator resolves it with the `engagement` or `workspace` field in the scope file, both of
  which already exist.

### Rejected

**Keying the directory on name + a hash of the absolute path.** It makes collisions impossible, and
it breaks every existing `~/.pired/engagements/<name>` path, every doc that names one, and needs a
migration — a large blast radius for a problem a warning solves.

---

## ADR-006 — Launcher decisions live in `launch.mjs` and `state.mjs`

**Status:** accepted · pre-existing, recorded here because new work must follow it

### Context

`bin/pired.mjs` and `bin/pired-state.mjs` are excluded from coverage (`vitest.config.ts`) on the
stated grounds that every decision they used to make now lives in `bin/launch.mjs` and
`bin/state.mjs`, which are held to a 95/90/95/95 ratchet. The launcher had previously shipped two
bugs in a fortnight — pi unfindable on Windows, and a redundant `--` to reach pi's own flags — both
pure functions of their inputs, and neither would have survived a test.

### Decision

New launcher behaviour — `--help` text, profile validation, engagement selection — goes in the
testable modules and is *called* from the entry scripts, which stay shells: read argv, touch the
disk, spawn or print.

### Consequences

- Usage strings are exported constants rather than inline heredocs, so they are covered.
- `pired --profile pentst` silently becoming `review` was asserted as intended behaviour in
  `bin/launch.test.ts`. Reversing it means deliberately rewriting that test, not deleting it: the
  fallback direction was safe, the silence was not, and `review` is the one profile that
  pre-authorizes the scope gate.
