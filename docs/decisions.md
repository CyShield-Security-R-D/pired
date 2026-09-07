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

---

## ADR-007 — A challenge can refuse to settle a finding, but never to keep one

**Status:** accepted · 2026-09-07

### Context

The operator prompt tells the agent that the costliest outcome is a missed vulnerability, and that
a plausible-but-unproven lead should be recorded rather than dropped — "verification calibrates
confidence and severity, it does not erase a lead". That is the right bet. It had a cost the ledger
never carried: a lead recorded as a hedge and a bug proven against a live target were both `open`,
rendered identically in `/findings` and in the export, and reached the client in one list.

pired flagged IDORs on the strength of one principal reading another's object, with nobody having
established that the principal was not *meant* to — a share link, a shared tenant, a collaborator
role, an admin. In the ledger such a claim looks identical to a proven bug, which is how a
false-positive IDOR reaches a report.

Two things follow from that, and the second is the one that shapes the design.

**Re-running the request cannot settle it.** An access-control finding is a claim about *intent*,
and intent is not in the response, not in the code, and not in any number of repeat requests. A
share link and a broken ownership check return the same 200.

**Nothing shape-based separates a good finding from a bad one.** Replaying three archived corpus
passes (218 findings, 201 with an extractable location, 30 landing in a truth window) against the
answer keys: description, remediation, impact and CWE are present on 100% of findings, so a
completeness check flags nothing; evidence is cited by 65% of findings that miss the key and 67% of
those that hit it; no finding cites a line outside its file. The best deterministic signal found —
whether the cited line's ±3 window contains an identifier from the finding's own prose — flags 22%
of findings that miss against 10% that hit, and applying it as a filter takes three passes from 2,
5 and 4 unique truth entries to 1, 3 and 2. It deletes half of everything true. A severity floor at
`high` costs those same passes 0, 3 and 2 entries.

(The keys are patch-derived, so "not in the key" is not "false" and the precision figures are lower
bounds — `research/04`. The relative claim is what matters here: the checks do not separate what the
key confirms from the rest.)

So verification cannot be a filter on the record. The discriminating information is in the target,
or — for the access-control classes — in the target model and the operator's head.

### Decision

A challenge pass with a **symmetric burden of proof and an asymmetric failure mode**.

- **To confirm:** the control case must have been run, and for the access-control classes
  entitlement must be settled. `core/challenge.ts` carries a per-class contract naming both.
- **To refute:** a cited basis is required (`file:line`, an evidence path, a model section), and the
  target must have been live when the challenge ran.
- **Missing either bar lands the finding on `suspected`** — not confirmed, not refuted, still in the
  ledger. `judge()` has no input that removes a finding.

`suspected` is a new status and the default for anything nobody has challenged; `refuted` is a new
disposed status, kept distinct from `false-positive` so the row can say whether the tool or the
consultant made the call. `FindingRecord` gains `source` (scanner · inferred · observed ·
reproduced) and `verification`.

The export separates confirmed from suspected and **renders refuted findings in their own section
with the grounds that broke them**.

Invocation is a pull: `recall challenge` for the queue, `recall challenge id=<id>` for the brief.
Nothing fires on its own, because re-running a proof is traffic against a client's production
system.

### Consequences

- Retaining refuted findings *is* the safety mechanism. A wrong refutation is visible in the
  document rather than a bug that quietly left it, and that is the only basis on which it is safe to
  let a machine challenge findings at all.
- A consultant can hand over a document whose confirmed section is defensible and whose suspected
  section is honestly labelled, instead of choosing between shipping everything and shipping nothing.
- The entitlement question routes to a `scope-clarification` blocker, which is already a dialog in
  front of the operator. Answering it in the target model's `actors`/`invariants` settles every
  later finding on the same surface.
- The brief is built from the record and the class contract, never from the conversation that
  produced the finding. The scribe — a pass that re-read the agent's own review buffer — cost 2.5x
  the wall clock and moved precision from 0.059 to 0.038 (`research/11`). A verifier that inherits
  the finder's reasoning agrees with it.
- `record` gains no required field and refuses nothing. It reports what a finding has not yet shown,
  per the standing directive to inform rather than script.

### Not yet measured

There is no pentest evaluation instrument in this repository. `eval/corpus`, DVBank and the misses
analysis are all `review`; `eval/forge` states in its own header that it is a plumbing fixture, not
a capability benchmark. The numbers above are code-review numbers and are cited for the design
argument they support, not as evidence about live testing. `KeyCell.poc` is the hook a Field corpus
would hang off, and the honest test of this feature is sensitivity and specificity measured against
one: does it keep findings whose PoC still fires, and kill deliberately bogus ones. Until that
exists, the safety property is structural rather than measured — which is why it is structural.

### Rejected

**Deleting or hiding refuted findings.** It makes a wrong refutation invisible, which converts a
verification feature into a machine for losing real bugs.

**A severity floor, or any confidence score computed from the record.** Measured above: both cost
more true findings than they remove false ones, because at this precision the noise and the signal
have the same shape.

**Blocking `record` until a finding is proven.** A finding the tool argued the reviewer out of
writing is worth less than one recorded honestly as `suspected`. This follows ADR-004.

**Running the challenge automatically at `/report`.** Re-testing is traffic, detection risk and load
on a client's production system, and on a timed engagement that is the operator's call.

---

## ADR-007 — A blocker's question travels in the dialog title, fitted to the terminal

**Status:** accepted · 2026-09-07

### Context

An operator reported seeing the choices and no question when pired asked them to settle a blocker.

pi's extension dialogs render exactly one string of prose. `ExtensionSelectorComponent` draws its
`title` and its options and nothing else; `ExtensionInputComponent` takes a placeholder and names the
parameter `_placeholder` — it never reads it. Only `confirm` accepts a second string, and pi
implements it by joining the pair (`showExtensionConfirm` builds `${title}\n${message}`) and handing
the result to the same selector.

`answerOne` was built as though all three took a title and a detail. It passed `pired · decision` as
the title and left `question` and `context` in a `detail` argument that two of the three shapes
discard. So the `approval` path — the one shape that happened to match pi's API — showed the
question, and `decision`, `input`, `scope-clarification` and `credential-request` did not. The
browser's detail pane has led with the question since it was written (`blockerLines`,
`core/browser.ts`); the dialog was the one place that did not.

### Decision

Build the dialog in `core/dialog.ts` and put the question in the title, which is the string every
shape renders. The heading (`pired · <type>`) leads, the question follows, the context follows that.

The prose is then fitted to the terminal, because the selector is a plain `Container`: it draws every
line it is handed, has no viewport of its own, and pi's main screen shows the last `rows` lines it
rendered. Untrimmed prose therefore trades the reported bug for its mirror image — the question on
screen and the choices scrolled off the top. The budget is the terminal's rows less pi's own frame
(six rows, plus the key-hint line, which wraps to two below about 44 columns), less the options, less
three rows for pired's footer. What does not fit is replaced by a marker naming `/blockers`, which
holds the untruncated record.

Precedence under pressure is question, then context, then heading — the heading is only the
blocker's type, and an operator can answer without it. The last row is never surrendered: pi renders
the title through `theme.fg`, so even an empty title arrives as ANSI codes and costs a line, and
that line is better spent on the first line of the question than on a blank.

### Consequences

- The extension passes `railTui.terminal` dimensions in, for the reason `railRows` gives: on a pipe
  or inside a multiplexer `process.stdout` describes a different screen.
- `SELECT_FRAME`/`INPUT_FRAME` and the two hint strings encode pi's component internals. They were
  measured against the real components, and `extensions/pired.test.ts` renders through those
  components so the numbers cannot drift silently.
- A dialog can still overflow when pi's own frame plus the options exceeds the terminal — eight
  choices need seventeen rows before any prose. pired contributes one row to that case and no more.

### Rejected

**Sending the question through `ui.notify` before opening the dialog.** It survives one frame, is
gone before the operator reads the options, and pi's status line replaces the previous message in
place — the same reason `describeUnready` rides on a line that is already being printed.

**A custom component via `ui.custom`.** It would give a scrollable context pane, and it would mean
owning selection, focus, and key handling for a dialog pi already draws correctly. The rail earns
that cost because pi has no side panel; a picker is not the same case.
