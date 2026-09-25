# Architecture decisions

One entry per decision that would otherwise be re-litigated. Each says what was true when the
decision was made, what was chosen, and what it costs — so a later reader can tell a considered
trade-off from an accident.

[Architecture](architecture.md) describes the shape of the system. This file records why the shape
is that way at the points where it could reasonably have gone another way.

**Status values:** `proposed` · `accepted` · `superseded by ADR-NNN` · `reversed`

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

### Measured since

`eval/field` was built to answer this and is described in [evaluation](evaluation.md#field--the-verification-instrument):
a live target where every real bug has a decoy beside it producing the same observation on the wire.
Against it, the contract here scores **sensitivity 1.00, specificity 1.00, resolution 0.70** with no
model in the loop — no real finding destroyed, no decoy blessed, and the three claims it declines to
settle are exactly the ones no request settles.

Two things the instrument changed as soon as it ran. It showed that the `idor` control as originally
shipped — unauthenticated probe plus an unrelated id — does **not** catch a share grant, and that a
third *principal* does; the contract now asks for one. And it showed the first version of the score
had a degenerate winner: suspecting every claim scored 1.00 on both rates, because it never asserts
anything wrong. `resolution` exists for that reason.

What is still not measured is whether an *agent* devises the right probe: the control comes from the
key, so this is the ceiling of the contract rather than a capability number. The code-review figures
above remain code-review figures, cited for the design argument they support.

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

## ADR-008 — A blocker's question travels in the dialog title, fitted to the terminal

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

---

## ADR-009 — One verification contract per checklist class, and the medium decides what proof looks like

**Status:** accepted · 2026-09-08

### Context

ADR-007 gives every weakness class a contract naming the control case that has to fail. The
contracts were written from a live web engagement and the checklists were written per target type,
and the two were never reconciled. Counted across the four shipped files: **16 of the 42
distinct class ids
resolved to no contract** and fell through to `GENERIC_CONTROL` — the whole of `code-review.json`'s
static half (`sca`, `iac`, `crypto`, `logging`, `reflection`, `codeinj`), five of the thirteen
network classes, the API classes `dataexposure`, `inventory` and `unsafe-consumption`, the generic
`injection` that `api.json` and `web.json` both ship, and `pathtrav`.

Two of those are the same claim under two names. `web.json` says `traversal`, `code-review.json` says
`pathtrav`; `record` already grew a spelling suggester for that exact pair after a live run spent a
third of a session working out why `traversal` settled no cell (`core/tools.ts`).

The test that should have caught all of it was named *"has a contract for every class the shipped
checklists name"* and asserted three ids by hand. A test whose name is a claim its body does not
check is worse than no test: it is the reason nobody looked.

Separately, and only visible once the static classes were written: `auditFinding` demands an HTTP
response from every finding that cites readable evidence. On `review` — the read-only profile that
needs no configuration, and therefore the one a first-time user runs — there is no wire. A finding
citing the snippet that contains the bug is told, blocking, that its evidence *"contains no HTTP
response. A request nobody kept the answer to proves nothing"*, and an access-control finding is told
its source excerpt "shows one authentication context". Both are demands the engagement cannot
satisfy, on the profile most likely to be somebody's first.

### Decision

1. **Write the fifteen missing contracts**, and route the sixteenth — `pathtrav` — to `traversal`
   through a `CLASS_ALIASES` map rather than duplicating the text. An alias may not shadow a real contract id
   and must point at one that exists.
2. **Make the test read the shipped checklists off disk** and assert that every class in every file
   resolves to exactly one contract. This is the only core test that touches the filesystem, and
   deliberately: a list of ids written into the test goes stale with the same edit that breaks the
   thing it was meant to catch.
3. **Classify the evidence instead of assuming it.** `evidenceShape` returns `wire` when a
   request or response is present, `static` when a `file:line` citation or a fenced excerpt is —
   counting the finding's own `target`/`locations` — and `neither` otherwise. The response check runs
   only on `wire`; the two-principals check, which is what an access-control control case looks like
   on the wire and nowhere else, runs only on `wire`; and `neither` blocks under its own gap kind,
   `unusable-evidence`.

### Consequences

- No finding stops being challenged. `static` evidence falls through to the recorded-control check,
  which is the right question for that medium — a code review proves an authorization claim by
  showing the guard the sibling operation has and this one does not.
- The blocking gap that used to fire on every code-review finding now fires only when the evidence
  genuinely leads nowhere, and says so in words a reviewer can act on.
- The new contracts carry ceilings on the classes whose base case is an observation — `sca` (a CVE in
  a package nothing calls), `outdated-service` (a banner is a version claim, and distributions
  backport), `inventory`, `crypto`, `logging`, `dns`, `snmp`, `unsafe-consumption`. Ceiling gaps are
  advisory, never blocking, so a finding that earns more than the ceiling is corrected rather than
  held.
- `segmentation` gets an `entitlement` question for the same reason `logic` has one: reachability
  with no stated policy behind it describes the network rather than finding anything wrong with it,
  and no probe answers which policy was meant to hold.

### Rejected

**A per-class `medium` field on the contract.** `sqli` and `authz` appear in both a live checklist
and `code-review.json`, so the medium is a property of the engagement and the evidence, not of the
class. Reading it off the evidence handles the mixed case for free and cannot be set wrong.

**Rewriting the existing contracts' control text.** `eval/field` scores the shipped contracts at
sensitivity 1.00 / specificity 1.00 / resolution 0.70 (ADR-007). Only `traversal` was touched, and
only to add the static reading it now owes `pathtrav`.

**Accepting any code-shaped text as a static citation.** An excerpt nobody can find again does not
let a challenger re-read the guard, which is the whole of what a static control case consists of. The
bar is a citation.

---

## ADR-010 — Both installers bring their own Node.js, and neither takes elevation to do it

**Status:** accepted

### Context

`install.sh` surveyed the box, printed a plan, asked once, and then installed Node.js when it was
missing or below 22.19 — a user-owned tarball under `~/.local/share/pired`, verified against
nodejs.org's `SHASUMS256.txt`. `install.ps1` did none of that. It hard-stopped:

    node not found. Install Node.js >= 22.19 and re-run.

and `README.md` documented the asymmetry as intended. The two scripts had also drifted apart on
consent. The shell script asks one question covering everything it is about to do, and says why:
*"a second prompt later for the PATH line would be asking twice for one decision."* The PowerShell
script asked nothing up front, started installing immediately, and asked a single mid-flight
question about PATH after the install had already happened.

The gap looked like a platform constraint but was not one. The canonical Windows Node install is the
MSI, which does need administrator — but nodejs.org ships a per-user `.zip` for every architecture in
the same checksum manifest the shell script already parses, and the PowerShell script already wrote
the user's PATH through `HKCU\Environment` without elevation.

### Decision

Both scripts survey, plan, ask once, and then install everything in the plan — Node.js included.

On Windows that means: the `node-vX.Y.Z-win-<arch>.zip` from the same `SHASUMS256.txt`, `Get-FileHash`
to verify it, `System.IO.Compression.ZipFile` to unpack it, and a **directory junction** at
`node\current`. A junction, not a symlink: creating a symlink needs administrator or Developer Mode,
a junction needs neither, and both give the property that an upgrade is one repoint and the PATH
entry never changes.

The npm prefix is the *parent* of the Node tree, not the tree itself — `%LOCALAPPDATA%\pired`, so the
next Node upgrade repoints the junction without taking pi and pired with it. This is the same reason
the shell script gives, and the same trap: under a private Node, `npm prefix --global` answers with
the versioned directory behind the junction.

The single approval now covers the PATH entries, so the trailing PATH prompt is gone.

### Consequences

- Windows needs two PATH entries where Unix needs one. The Windows zip puts `node.exe` and `npm.cmd`
  at the root of the extracted tree, so there is no `bin/` to collapse the runtime and the shims
  into, and a plain user cannot create the symlinks that would fake one. That is the honest cost.
- `PIRED_YES` and `PIRED_DRY_RUN` are environment variables rather than a `param()` block, because
  the documented install pipes the file into `iex`, which cannot pass arguments.
- A `pi` already on PATH is ignored when the run brings its own Node — it belongs to the runtime
  being stepped in front of, and counting it would leave the new Node without a pi at all. The shell
  script already guarded this with `[ "$DO_NODE" = 0 ]`; the port initially missed it.
- pi's own installer parks a standalone Node at `%LOCALAPPDATA%\pi-node\current` — read out of
  `pi.dev/install.ps1`, and the Windows counterpart of the `~/.local/share/pi-node` the shell script
  already adopts. Both are adopted when new enough, ours first, so the two installers do not each
  own a Node. Adoption also prepends the copy to `$env:PATH` in-process: pi puts its Node on the
  *user* PATH, which only reaches shells started afterwards, and this may be one that started
  before.
- Adopting pi's Node does **not** move the prefix to `%LOCALAPPDATA%\pired`. That is the prefix only
  for a tree this script owns and can upgrade; pi's copy keeps npm's own answer, which is what the
  shell script does in the same case.
- `Get-ComparablePath` normalises separator style as well as case and trailing slash. npm reports
  forward slashes for directories `Get-Command` reports with backslashes, and every PATH and prefix
  comparison in the script runs through it.
- TLS 1.2 is forced before the download. Windows PowerShell 5.1 inherits the .NET Framework's
  `SecurityProtocol`, which on an un-patched box is still TLS 1.0; nodejs.org refuses it, and the
  failure surfaces as "the underlying connection was closed" rather than as a protocol error.

### Verified since

The Windows-only half could not be exercised from the development box at all — `Invoke-PiredInstaller`
exits early off Win32, `Join-Path` will not synthesise a `C:\...` path, and neither `HKCU` nor a
directory junction exists to write. What *was* checked there, against PowerShell 7.6.6: the parse,
PSScriptAnalyzer, the manifest resolving x64/arm64/x86 off the live nodejs.org listing, a real
download-verify-unpack, and a tampered payload under an intact manifest being refused.

The rest was closed by a real install on a Windows box (2026-09-10), which completed successfully —
so the zip path, `Get-FileHash`, `Expand-Archive`/`ZipFile`, the junction at `node\current`, the
`HKCU\Environment` PATH write with its `WM_SETTINGCHANGE` broadcast, and the plan-and-approve flow
all work on the platform they were written for, without administrator.

Two branches remain unexercised and are not claimed: the `old` state, where a private Node is
installed to shadow one already on PATH, and any architecture other than the one that box runs.

### Rejected

**Installing Git for Windows when there is no `bash`.** pi runs every tool through bash, so a Windows
box without one cannot execute a single command — but Git for Windows is a ~250MB install that adds
shell integration and file associations, which is well outside what "no daemon, no service, no shell
hooks" can promise on someone's behalf. It stays a plan row and a pointer at `winget` or pi's own
managed copy.

**Using the MSI, elevating just for Node.** It is the one step that would have made the script ask
for administrator, and an installer for a security tool that takes rights it does not need teaches
the wrong habit on the very first command.

**Merging the two scripts.** npm's global layout and PATH storage differ enough that the merged
script would be mostly branches. They stay separate and are kept honest by this file.

---

## ADR-011 — Choosing models is a list you stand in, not a question repeated

**Status:** accepted

### Context

The add-a-host wizard collected models in a loop:

```
   ┌─ pick one model id
   │  context window? · output cap? · does it reason? · which wire format?
   └─ "Another model from this host?"  [Yes/No]
```

Adding three models meant answering that yes/no twice, and up to twelve questions besides. The
questions were asked one model at a time, so what had already been chosen was never on screen — the
confirm dialog's body was the only place it appeared, and only as prose. The operator's own
complaint was the "another model?" prompt, which is the part that reads as the tool asking
permission to continue doing the thing it was opened to do.

Editing was worse: there was none. `/provider` walked straight into the add wizard, `/provider list`
printed a summary, and everything else — a base URL that moved, a context window the probe guessed
wrong, a thinking format that turned out to be the other one — meant opening `~/.pired/models.json`
by hand and knowing the schema. That is the same wall the wizard exists to take down.

### Decision

**Picking is one screen that shows its own state.** `pickModels` draws every model the host serves
with `◉`/`○`, toggling on select and redrawing. Leaving is picking Done rather than answering No.
The same screen covers all three cases the loop needed branches for: a handful listed, hundreds
(narrowed by a search first, since pi's selector neither scrolls nor filters), and none at all —
where the list is empty and the only row asks for an id.

**The per-model questions are answered rather than asked.** `draftModel` takes what the probe
reported and defaults or guesses the rest; `reviewModels` puts the result up as one line per model
whose rows open the editor. Three or four questions per model become one screen for all of them.

**`guessReasoning` leans towards `false`.** The two mistakes are not equal. Marked `false` on a
reasoning model, the thinking leaks into the reply — untidy, and obvious the first time anyone reads
it. Marked `true` on a model that does not think, pired declares a wire format the model never sends,
and the failure is the one documented in `docs/models.md`: an empty reply, exit 0, nothing on screen
to say why. So only markers that name a reasoning model outright count, an `instruct` build is taken
at its word, and the review screen shows the answer before anything is written.

**`/provider` opens a manager once anything is configured.** `provider-editor.ts` is
`~/.pired/models.json` as menus: hosts, then a host's URL/token/API dialect, then its models, then
one model's parameters. Every row carries its current value, every edit writes immediately, and every
menu re-reads the file on redraw — so the screen shows what was saved rather than what the module
believes it saved.

### Consequences

- `editModelFields` is shared between the add flow's review screen and the editor. Reviewing a guess
  and correcting a saved model are the same act, and a second implementation would be a second place
  for `THINKING_FORMATS` to fall out of date.
- Turning reasoning off drops `compat` with it, so the file never carries a wire format for a model
  that was just declared not to think.
- A typed id gets a row of its own in the picker. Without one it could be added and never taken back
  off, which is worse than not being able to add it.
- The editor re-probes when adding models to an existing host, and holds back the ids already
  configured — offering one invites a duplicate the file has no way to tell apart.
- Both test suites now answer menus by naming a distinctive part of a row rather than repeating the
  whole label. A row carries its current value, so a script written against the full string would
  have to be rewritten every time a default moved.

### Rejected

**A custom TUI component with real keybindings** — checkboxes, a properties panel, arrow-key field
navigation. pi hands an extension four dialogs (`select`, `confirm`, `input`, `notify`) and the
`/login` callbacks hand over even less. The wizard is reachable from both, and is written against
that four-method `Prompter` precisely so it can be driven by a fake in a test. A component would work
in the command and not in `/login`, and would trade the tests for a flow verified by clicking.

**Guessing the thinking format silently and skipping the review screen.** It is one screen against
the failure mode this file already has an ADR's worth of comments about. Not worth it.

**Auto-installing nothing, and asking about everything, as before.** Keeping the questions but
reordering them was the smaller change and does not fix the complaint: the problem was being asked at
all, per model, with no view of what was already chosen.

---

## ADR-012 — The operator's message decides the turn; the methodology is not a standing order

**Status:** accepted

### Context

Saying `hello` to pired started a code review.

Nothing was wrong with the harness — the prompt was. Every instruction in it was written in the
imperative of an engagement already underway:

```
Work in passes. Pass 1 is where your best findings come from …
Enumerate the attack surface — every route/endpoint/input/sink …
… do not finish while a class is still unconsidered.
Before finishing, briefly note what you did not get to …
Momentum: … don't stall the whole engagement.
```

and nothing anywhere said that what the operator typed was what decided the turn. A capable model
reads `do not finish while a class is still unconsidered` as a standing order and begins covering the
floor off a greeting. The default `review` profile makes it worse, not better: the scope block ends
with *"Read-only local work (e.g. code review) is still fine"*, which reads as permission to start.

This is the same shape as ADR-002 — a prompt that was true sentence by sentence and wrong when read
as a whole — and it is not fixed by the model getting smarter, because the smarter model follows the
instructions more faithfully.

### Decision

Two paragraphs, both in `core/prompts.ts`.

The identity block establishes who is driving: the operator is in the room, their message decides the
turn, a greeting is answered as a greeting, an engagement begins when one is asked for, and
**nothing below outranks what they actually asked for**.

The methodology block is framed as method rather than trigger, and its `do not finish` is
disambiguated in place: it means do not abandon a job half-done, not do not stop when the operator
says stop.

The correction is deliberately *not* "be less proactive". Told to review something, it reviews it —
the same paragraph says so, and says to name the next step and wait only when the ask is genuinely
ambiguous. What changed is what the model treats as the instruction: the operator's message, not the
methodology.

### Consequences

- The invariant is asserted for all three profiles in `core/prompts.test.ts`, since the methodology
  block is shared and the failure was profile-independent.
- The `<pired-coverage>` block was investigated and cleared: it is only injected once the ledger has
  recorded surface, so on a fresh session it does not fire and was never part of this. Nothing else
  injects an opening user message.
- The prompt grows by two paragraphs on every turn of every session. Worth it: the failure it
  prevents is the first thing a new operator sees.

### Rejected

**Gating the methodology block on whether an engagement has started.** There is no such signal — a
workspace is opened at `session_start` for every session, so the block would either always render or
never. The framing sentence costs less and does not depend on state that does not exist.

**Deleting `do not finish while a class is still unconsidered`.** It is load-bearing for coverage
honesty, which is most of what the ledger is for. The problem was never the sentence; it was that
nothing scoped it to a job the operator had actually asked for.

---

## ADR-013 — A subagent reaches the ledger through a CLI, not through the extension

**Status:** superseded by ADR-027 · 2026-09-23

> The premise below — that `omitExtensionBindingsEnv` strips a child's extension
> bindings so a child never loads pired — is a misreading, corrected in ADR-027: it
> deletes one metadata env var, only for out-of-process runners, and a foreground child
> loads the extensions its agent lists. A child now gets `record`/`recall` directly
> through `extensions/child.ts`, so the `pired-ledger` CLI is no longer part of the
> delegation path. The history below is kept for the reasoning it records.

### Context

`ops-delegation` tells the operator to hand noisy recon and adversarial verification to a child, and
says the payoff arrives only once the child's result is *recorded* rather than reported in prose.
None of that could work.

pi-subagents spawns children with extension bindings deliberately stripped
(`omitExtensionBindingsEnv`), so **a child never loads pired**. It has no `record`, no `recall`, and
no scope gate. Everything the harness exists for is invisible to exactly the agents it tells you to
delegate to. This had already cost a measured incident: a child that could not resolve its model
reported `0 turns | 0 tokens | 0 tools` and the parent blocked on it forever — *"a silent deadlock at
~0% CPU that only an external timeout ends. Two full mlflow scans died this way."* The fix then was
mirroring providers into pi's own `models.json`, which made a child able to *think* and left it
unable to *write*.

Two things in the repo were also simply false. `ops-delegation` claimed **"Scope + auth are
inherited — a child cannot exceed the engagement's scope or authorization; it is not a way around the
gate."** The gate is `createScopeGate`, it lives in the parent's tool pipeline, and a child outside
the extension is outside it — so the document told the operator a delegated child was bounded when
nothing bounded it. And `extensions/lib/host.ts` pointed at a `subagents.ts` that does not exist.

### Decision

`bin/pired-ledger.mjs` — `record` and `recall` over `bash`, for a process with no extension.

It is deliberately **not** a reimplementation. It opens the same `Workspace`, builds the same tool
objects with `createCoreTools`, and hands them the same args the model would have given them, so a
child's `record` validates, allocates ids and appends through exactly the parent's code. `pired-state`
established this shape for reading — an extension-less process using pired's own derivation rather
than scraping the `.jsonl`, chosen so the panel and the TUI can never disagree. This is the write
half of the same argument.

Arguments are `key=value`, because that is already how the skills and the prompt write tool calls —
a child copying a line out of a skill should not have to translate it. A repeated key builds a list,
so `evidence` takes several without anyone hand-writing JSON in a shell.

`scope` reports what the engagement authorizes **and says it does not enforce it**. There is no
honest way for a CLI to bound a process that is free not to call it, and the correction to
`ops-delegation` now says so: restate the boundary in every handoff, and treat a delegated network
action as unguarded work you authorized personally.

### Consequences

- Values are coerced: a bare integer becomes a number and `true`/`false` become booleans, because
  `core/tools.ts` reads numbers with `typeof v === "number"` — a port arriving as the string `"80"`
  is not rejected, it is dropped, and the service lands with no port at all. Coercion stops at
  integers: guessing further would turn a version like `1.0` into something that matches nothing.
- Exit status is meaningful — `0` success, `1` the tool rejected the call, `2` usage or no engagement
  — so a child can branch on it instead of parsing prose.
- Verified end to end rather than by unit test alone: records written through the CLI are visible to
  `pired-state`'s own derivation, which is the property that matters. One ledger, no drift.
- A third binary to keep in `package.json`, `files`, and both installers' expectations.

### Rejected

**Letting the child write the `.jsonl` files directly with `write`/`bash`.** It is one line of
prompt and no code, and it gives up id allocation, validation, tombstones and the append discipline
the format depends on — the thing `pired-state` was deliberately built *not* to do.

**Loading pired's extension in the child.** `omitExtensionBindingsEnv` is pi-subagents' decision, not
pired's, and working around another package's deliberate isolation to inject a tool is the kind of
fix that breaks on their next release.

**Making the CLI enforce scope.** A gate a process may decline to call is not a gate. Reporting the
boundary honestly is worth more than a check that produces false confidence, and the safety fix is
the correction to `ops-delegation`, not a flag here.

---

## ADR-014 — A claim waiting for a second look is said out loud, and can be handed to a fresh agent

**Status:** accepted

### Context

ADR-007 built the contract that settles a finding and ADR-009 gave every checklist class its own
verification bar. Both work: against `eval/field` the contract scores sensitivity 1.00, specificity
1.00, resolution 0.70 with no model in the loop.

Nothing ever said a claim was waiting.

`suspected` is the default status precisely because an absent `verification` means *nobody has looked
twice* rather than *examined and cleared* — so a finding could sit unverified for an entire
engagement with the whole apparatus installed and idle. The standing `<pired-coverage>` block names
untested **cells** and says nothing about unverified **claims**, and the only entry point was `recall
challenge`, a tool call the reviewer had to think to make. That is the same failure the coverage
block was built for and measured at: 30 `read`, 20 `bash`, 3 `record` — and **1 `recall`** across
five sessions.

There was also no way for the operator to ask for a second look at one finding, and nothing to hand a
subagent when they wanted one — even though the brief had been shaped for exactly that since ADR-007,
built from the record and the class contract rather than from the conversation, because a verifier
that inherits the finder's reasoning agrees with it (precision 0.059 → 0.038, at 2.5× the wall
clock).

### Decision

**The standing brief says what is unverified**, beside what is untested. `unchallengedBrief` renders
one line naming the worst three and counting the rest; it is empty when nothing is waiting, so it
costs no prompt on an engagement that has none.

**`/challenge` is the on-demand trigger.** No argument lists the queue; an id prints that finding's
brief plus the one line needed to delegate it.

**`isUnchallenged` is exported and shared.** The `recall challenge` queue and the standing brief now
count with the same predicate — two copies would be two answers to the same question, which is the
argument `pired-state` already makes for reading through pired's own derivation rather than the
`.jsonl`.

Delegation names `pired-ledger` (ADR-013) rather than pasting the brief into a task string: a child
fetches its own brief, and a task prompt carrying a full brief is a task prompt nobody reads.

### Consequences

- The two triggers the operator asked for are both covered — on demand via `/challenge`, and by the
  agent's own judgement via the standing line — without either one *making* the decision. Choosing
  what to spend a challenge on stays the reviewer's call, for the reason invocation was a pull in the
  first place: re-running a proof touches the client's system again.
- Verified end to end through the CLI rather than by unit test alone: a child confirming without the
  control case was recorded `suspected` with the reason, the same child with a real blind-timing
  control (`;sleep 9` → 9.04s vs `;sleep 0` → 0.07s) was promoted to `confirmed`, and the finding
  left the queue. `verification` remains non-forgeable — `record` deletes any handed in.
- The brief grows with the engagement only up to three named findings; past that it is a count.

### Rejected

**Firing a challenge automatically once a finding lands.** It would re-run a proof against a client's
production system without anyone asking, which is the thing `recall challenge` was deliberately made
a pull to avoid. Saying a claim is waiting is not the same as settling it.

**Spawning the verifier from inside the extension.** `spawn` belongs to pi-subagents, not to pired,
and reaching for another package's tool from an extension is a coupling that breaks on their next
release. Naming the two commands a child needs is enough, and works whatever spawns it.

**A `verification` field the caller can set.** It is the one field that must not be forgeable — a
caller handing in the conclusion it is supposed to have earned is exactly the failure ADR-007 exists
to prevent. `record` deletes it and computes its own.

---

## ADR-015 — Firmware is a target type, not a new ontology

**Status:** accepted

### Context

pired covered `web`, `api`, `network` and `code-review`. A firmware image fits none of them, and the
obvious reading — that firmware needs its own inventory kinds, its own scope primitives and its own
weakness vocabulary — turns out to be mostly wrong.

Three things came out of the research that shaped this.

**The OWASP IoT Top 10 is dead.** The repo was archived in 2024 with `index.md` emptied, the canonical
PDF 404s, and no successor was ever published despite the original promising a two-year cadence. It
is reporting vocabulary a client recognises, not a coverage floor. The live artifacts are FSTM (how
to test firmware, 9 stages), ISVS (what controls must exist) and ISTG (test cases by device
component).

**The findings are not where the taxonomy points.** The hardware and boot-chain literature is
extensive, but ISE's SOHOpelessly Broken 2.0 found a web-application vulnerability in **13 of 13**
SOHO devices and root shell on 12; Talos found 44 vulnerabilities in the CGI and shell scripts of a
single router. Command injection in a vendor CGI binary is the highest-volume class by a wide margin,
and hardcoded credentials the most consistently reported. Invasive hardware work is rare in a paid
engagement because it destroys the unit and eats the budget.

**Version matching lies.** Vendor backports fix code without bumping the version string; stripping
and static linking against uClibc/musl defeat signatures; SDK code is compiled in but unreachable.
Industry SAST false-positive rates run 64–82% and no firmware CVE tool publishes a measured rate at
all — EMBA carries verifier modules precisely because raw string matching is known unreliable.

### Decision

**Firmware is a `targetType` with a checklist and four skills. The ontology does not change.**

The existing inventory kinds already carry firmware surface, and carry it well:

| Firmware thing | Record |
|---|---|
| Component + version (busybox 1.19.4) | `tech{name, version}` — an SBOM entry, and the row `sca` is asked of |
| CGI handler in the web root | `endpoint{file}` — `file` was added so a cell could name a place on disk |
| Device, emulated or real | `host` |
| Listening service | `service` |

**Most classes reuse the id they already had.** `cmdi` is `cmdi` whether the sink is a Rails
controller or a MIPS CGI binary, and it settles against the same bar. `firmware.json` names 19
classes and only **eight** are new — `memory-safety`, `update-signature`, `update-rollback`,
`no-update-path`, `secure-boot`, `debug-iface`, `debug-code`, `side-channel` — which are the ones
with no analogue in a web or code-review engagement. The rest are `default-creds`, `secrets`, `cmdi`,
`authn`, `traversal`, `unauth-service`, `tls`, `infodisclosure`, `crypto`, `sca`, `misconfig`.

**The eight new contracts encode the medium**, as ADR-009 requires. A static image cannot settle a
question about a running device, and emulation reaches a working service on 16% of images under
firmadyne and 79% under FirmAE — so "could not be confirmed dynamically" is an expected outcome, and
`memory-safety`'s control demands that a benign input of the same shape does *not* crash, because
QEMU rehosting produces faults from missing peripherals that look identical to an overflow.
`side-channel` is capped at medium without the attack actually performed.

**`scope.targetType` selects the checklist**, and the inference stays as the default for the two
cases the target shape genuinely settles. This also fixes a bug it exposed: `api.json` shipped with
13 classes that no code path could ever select, because an API engagement is a list of URLs and looks
exactly like a web one.

**`pickTargetType` moved to `core/scope.ts`** and is now tested. It was in the extension, where a
decision nothing can test goes quietly wrong — which is how `api.json` stayed unreachable without
anyone noticing.

### Consequences

- No new profile. A firmware engagement is `review` while it is static and `pentest` once something
  is emulated or a device is live; the gate posture those two carry is already the right one, and the
  firmware specifics live in the checklist and the skills.
- The skills say out loud that a CVE hit is a lead, not a finding, and that `checksec` output is
  severity context rather than a finding — there is no CWE for "unhardened binary" and a client
  cannot act on a list of missing flags.
- `capa` is named as unusable here (x86/x64 only, the ARM PR unmerged, MIPS never attempted) and
  `firmwalker`'s canonical repo is named as 404, so nobody wastes a session on either.
- The scope still cannot name a firmware artifact by file and hash, which is what a statement of work
  actually names. The skills work around it by recording the image as a `host` and its SHA-256 as a
  note. That is a real gap, left open deliberately rather than half-designed.

### Rejected

**New inventory kinds** (`image`, `binary`, `bootloader`, `update`). It is the shape the ISTG
component axis suggests, and it would ripple into `record`'s schema, coverage, the panel, export and
`FORMAT.md` for surface the existing five kinds already carry. The mapping above is not a workaround;
`tech{name, version}` genuinely *is* an SBOM entry.

**A `firmware` profile.** Profiles decide gate posture, not methodology, and firmware work moves
between read-only and live within one engagement.

**Seeding the checklist from OWASP IoT Top 10.** It is archived and its ten items are written as
categories for a report rather than as test cases with a control, which is what a coverage cell needs.

**Wiring EMBA as a backend.** It is genuinely scriptable and actively maintained, but it is an
orchestrator wrapping binwalk, radare2, cve-bin-tool and QEMU — running it under pired is an
orchestrator inside an orchestrator, and its mean run is ~14 hours on a 25MB image. Better named in a
skill as an optional deep scan than depended on.

---

## ADR-016 — A cleared cell is a claim too, and the fan-out that checks it is bounded

**Status:** accepted

### Context

ADR-007 made a finding earn `confirmed`. ADR-014 made it visible that a finding was waiting. Both act
on claims that something is **broken**. The opposite claim was never checked at all.

`core/coverage.ts:104` — a hypothesis recorded `refuted` turns its cell `clear`, and `clear` counts
toward the coverage percentage handed to the client. Nothing revisited it: `recall gaps` and
`recall next` route to `not-tested` by construction, so a settled cell is invisible to the router,
and there was no verb that could even enumerate one. A wrong clearance is the missed vulnerability
this whole system is built against, and it was the one verdict carrying no second look.

A first implementation of the hypothesis brief was reviewed before it shipped and failed on three
counts, each worth recording because each is a general trap:

1. **A capability with no trigger.** `recall challenge id=<hypothesis>` worked, and nothing routed to
   it — the same failure ADR-014 had just fixed for findings, repeated one commit later.
2. **No trace.** A full re-check left the row byte-identical, so "one agent said clear" and "two
   independent agents said clear" were the same ledger. The work could not be reported and the same
   cell would be handed out forever.
3. **Unbounded context.** Neighbouring findings were selected by class across the whole engagement
   with no cap, in a brief whose entire purpose is to be read by a child — the process in the system
   with the least context room.

Separately, `PLAN.md` §11 has listed hard caps as harness-owned since the beginning and nothing
implemented one. `spawn` sat in the gate's local-tools set and was waved straight through, so a model
that decided to fan out could spawn until something else ran out.

### Decision

**`recall cleared`** lists the cells a refutation settled, oldest first, excluding any already
re-checked. Oldest first is the sampling heuristic made mechanical: a cell cleared in the first hour
was cleared by an agent that had not yet read the code it was clearing.

**`hypothesisBrief`** inverts the framing — the job is to break the *clearance*, by finding the input
the refutation did not consider or the path it did not follow. It carries more of the ledger than the
finding brief does, and deliberately: a finding arrives with its own evidence, a cleared cell arrives
with almost nothing, so the value of the second look is everything the engagement has learned since.
Capped at six neighbours and six siblings, with the remainder as a count.

**`HypothesisRecord.verification`** records that a second pass ran and what it was grounded in —
`stands` when the clearance held, `amended` when it was overturned. It is deleted from caller input
and written by the record path, the same rule as a finding's. Unlike a finding's it is *not* judged
against a contract, because there is no control case for "clear"; it claims only that a second pass
happened and cites its basis, which is what it is entitled to claim.

**The gate counts spawns** and refuses past `scope.maxAgents`, default **8** per session, `0` to
disable delegation. Per session rather than per engagement because the gate is built at session start
and a counter is all it can honestly hold — a fresh session gets a fresh budget, which is what an
operator restarting a run expects.

**Delegating verification belongs to the coverage loop, not to a direct request.** When the operator
names the work, do the work; answering a direct request by spawning a child and relaying the result
is slower, loses the context that made the request answerable, and is not what was asked. This is
ADR-012's rule applied one level down.

### Consequences

- The three flaws above were found by reviewing the implementation before shipping it, and the
  forgeable-`verification` bug was found by a test written *for* that review. Both are the argument
  for the review, not against the design.
- `spawn` left the local-tools set. Anything the gate does not recognise as a spawn tool fails open —
  the cap never fires — which is the safer of the two mistakes but is why `scope.agentTools` exists.
  pired ships no spawn machinery, so it is recognising another package's tool by name.
- `recall challenge` now resolves a finding id first and a hypothesis id second, so its miss message
  names both stores.

### Rejected

**Nudging about cleared cells in the standing brief**, the way ADR-014 does for findings. Unverified
findings are few; cleared cells are one per settled cell and would be hundreds on a real engagement.
A line naming them every turn would be noise, and noise in that block is how the block stops being
read. `recall cleared` is a pull for the same reason challenging is.

**Judging a hypothesis verdict against a contract.** The contracts say what proves a class is
present. Nothing states what proves one absent, and inventing a bar would either be trivially
satisfiable or would make honest clearances impossible to record.

**Enforcing the agent cap per engagement rather than per session.** It would need the count in the
ledger and would make a restarted run inherit a spent budget with no obvious way to reset it. Per
session is weaker and predictable; the strong version is a config decision the operator can already
make by setting `maxAgents` low.

---

## ADR-017 — The installer leaves `pi` alone; `pired` is the only thing that loads pired

**Status:** accepted

### Context

Both installers ended with a registration step:

```sh
pi install "$(npm root -g)/pired"
```

The stated purpose was generous — "so a bare `pi` loads the security layer" — and it was checked
carefully, `pi list | grep pired` guarding against the case where `pi install` reports success and
records nothing. What it actually did was larger than the sentence, in three steps that are only
visible if you read pi's source rather than its flags:

1. `package.json` declares `pi.themes: ["./themes"]` next to `pi.extensions`. Registration is not
   per-resource: `package-manager.js:1804` loops every entry in `RESOURCE_TYPES` — extensions,
   skills, prompts, **themes** — so registering the extension also puts `themes/pired.json` on pi's
   global resource path and makes the name `pired` resolve in every pi run on the box.
2. `extensions/pired.ts` calls `ctx.ui.setTheme("pired")` on each TUI start. The guard was the
   comment "no-op unless the theme was loaded (e.g. by `pired run`)" — true right up until step 1
   made the name resolve, which is to say true until the installer ran.
3. pi's extension API persists a theme set **by name**. `interactive-mode.js:1907`:

   ```js
   const result = this.themeController.setThemeName(themeOrName);
   if (result.success) {
     if (this.settingsManager.getTheme() !== themeOrName) {
       this.settingsManager.setTheme(themeOrName);   // → save() → ~/.pi/agent/settings.json
     }
   }
   ```

So one installer run, plus one `pired` start, permanently rewrote `theme` in the operator's global
pi settings. Not for the pired session — for every `pi` they ever ran afterwards. The launcher was
never the culprit: `--use-theme` reaches `applyOverrides`, which merges into the in-memory `settings`
and never into `globalSettings`, so it cannot persist. The damage came entirely from the path the
installer opened.

The failure this prevents is small and infuriating: a consultant installs an assessment tool and
their editor's agent comes back a different colour, with no setting they remember changing and no
line in the installer's plan that says so.

### Decision

**The installers install `pired` and nothing else.** No `pi install`, no plan row for an extension,
no `~/.pi` in the undo hint — the scripts never write inside pi's directory and now do not claim to.
`pi` is the pi the operator installed. `pired` is pi plus the security layer, assembled with `-e` at
launch and gone when the process exits.

**Where the theme is applied, it is applied by instance, not by name.** `ctx.ui.getTheme("pired")`
returns a `Theme` or `undefined`, and `setTheme(Theme)` takes pi's `setThemeInstance` path, which
paints the run and writes nothing. Two properties fall out: a pi that never heard of pired gets
`undefined` and is left alone, and an operator who *deliberately* runs `pi install <pired>` gets the
theme for that session without their settings file being edited behind them.

### Consequences

- `pi install git:github.com/mamgad/pired` still exists and still works. It moved from something the
  installer did on your behalf to something you type — which is the difference between a default and
  a choice.
- A box that ran an older installer is still registered, and its `~/.pi/agent/settings.json` still
  carries `"theme": "pired"`. Neither is repaired automatically: unregistering is
  `pi remove <src>`, and the settings key is the operator's file to edit. An installer that reached
  into pi's settings to undo its own overreach would be committing the same category of act.
- The `pired` launcher is now the only supported entry point, so anything the security layer needs
  must be passed in `bin/launch.mjs`. That is already true of the profile, thinking level,
  `--approve` and the theme.

### Rejected

**Keeping registration and only fixing the theme write.** It fixes the loud symptom and leaves the
quiet one: a bare `pi` still silently loads a security-operator prompt, a scope gate and two extra
tools. Someone who installed an assessment harness did not thereby ask for their general-purpose
agent to be reshaped.

**Registration behind an installer flag** (`--register-pi`). A flag nobody passes is a code path
nobody tests, and the thing it would guard is one documented command the operator can already type.

**Dropping `pi.themes` from `package.json` instead.** It would break the deliberate `pi install`
route — which is a legitimate way to run pired — to fix an installer problem. The manifest is not
where the mistake was.

---

## ADR-018 — A pass has a lens, and the ledger withholds its own verdicts from the next one

**Status:** accepted · 2026-09-15

### Context

Two measurements in `research/` sit next to each other and point opposite ways.

`research/11` — on the application corpus, the union of three passes beats the mean of three passes
for every arm:

| arm | passes | mean | union |
|---|---|---:|---:|
| pired | 6, 4, 3 | 4.3 | **9/24** |
| codex | 4, 4, 4 | 4.0 | 8/24 |
| bare pi | 3, 3, 4 | 3.3 | 6/24 |

Roughly half of what any of these can find, it misses on a given pass, and the shape survives the
larger corpus (mean 5.3, union 11/42). That document's own rule is *three passes minimum, report the
range*.

`research/06` — a second pass over a **persisted** ledger buys none of it. Re-scored so both arms
measure the same quantity, cumulative recall at k=3 is 0.591 persisted against 0.591 wiped, a gap of
-0.000. What durable state did change is when the agent stops: final sessions ran 255s against 480s,
and one rollout ran **105 seconds and recorded zero new findings and zero new hypotheses** — it
opened a full ledger, concluded the work was done, and stopped. That document closes by naming the
remedy as a design change rather than a scoring fix: *the design must change so that a full ledger
drives further testing rather than a confident early exit*.

The mechanism is not mysterious. `recall gaps` and `recall next` route to `not-tested` by
construction (ADR-016), so once every cell carries a hypothesis the router is empty — and stopping is
the honest reading of an empty router. The union in the first table came from passes that could not
see each other's conclusions. Handing pass 2 pass 1's verdicts is the same failure the challenge
brief is built from the record rather than the conversation to avoid: a reviewer that inherits the
reasoning agrees with it.

`research/09` says what a later pass would have to do *differently* rather than merely again. Across
17 misses the file containing the missed entry was **opened in 17 of 17 and recorded as surface in 0
of 17**. A second pass routing on the same surface vocabulary as the first cannot reach any of them.

### Decision

**A pass is a unit of work with a lens**, and the lens is what makes pass N+1 structurally unable to
repeat pass N.

| lens | worklist |
|---|---|
| `route` | `recall gaps` — the present behaviour |
| `file` | files opened during an earlier pass and never recorded as surface |
| `invariant` | `model.md` invariants carrying no hypothesis against them |
| `adversarial` | `recall cleared` and the unchallenged queue — ADR-014 and ADR-016, given a place in the ladder |
| `credentialed` | the recorded surface re-run as each principal in `loot` |

**Facts carry forward; verdicts do not.** Inventory, the target model, loot, blockers and evidence
are what make a later pass cheaper than a cold one, and they are kept. A `refuted` hypothesis still
reads `clear` in the coverage number handed to the client — the report is unchanged — but it stops
counting as done work to the router, which above pass 1 returns cleared cells oldest-first
(ADR-016's sampling heuristic, promoted from a pull to a worklist) rather than returning nothing.

**Passes are off by default, and the ladder is configuration.** With no configuration there is one
`route` pass and today's behaviour exactly: no `<pass>` block in the prompt, no change to
`selectNext`, nothing new in the panel. An engagement opts in:

```json
{ "passes": { "enabled": true, "lenses": ["route", "file", "invariant", "adversarial"] } }
```

in `scope.json`, beside `maxAgents` and `agentTools`, because this is engagement policy and not a
global preference — a firmware teardown, a credentialed web retest and a one-hour triage do not want
the same ladder. `PIRED_PASSES=route,file` covers the headless case, the precedent being
`PIRED_SCRIBE`, which exists because an opt-in feature with no headless switch had three measured
passes silently comparing two configurations (`research/11`).

**`/pass [lens]` opens one**, taking the next lens in the ladder when none is named. Opening stays a
pull, for the reason challenging is one (ADR-014): a further pass spends the operator's budget and
touches the client's systems again.

**The pass number is written by the record path and deleted from caller input**, the rule
`verification` already follows. A model that could assert which pass it was on could assert the
coverage that goes with it. It lives on `RecordBase.pass` and in the manifest, which is what lets the
delta — what this pass added that the ledger did not already hold — be computed rather than argued.

**The precision guard is surfaced, not enforced.** "Do not open pass N+1 while pass N's unchallenged
queue is non-empty" is a line in the standing brief and never a refusal, on ADR-004's grounds. It
matters here more than elsewhere: pired's precision on the application corpus is 0.059 against bare
pi's 0.192, and a union multiplies false positives as readily as findings.

Placement follows the structural rule. `core/passes.ts` is pure — lens definitions,
`planPass(...) -> PassPlan`, and the delta — with `selectNext` taking the plan, the prompt block
rendered only above pass 1, and `/pass` plus the panel row in `extensions/`.

Two details the implementation settled.

**Naming a lens moves it; it does not overwrite a rung.** `/pass invariant` on a `route, file,
invariant, adversarial` ladder first overwrote rung 2, which silently dropped `file` from the session
for good — the operator asked to run one lens now and lost a different one entirely, with nothing
saying so. `promoteLens` moves the named lens to the open pass and keeps the rest of the ladder
behind it.

**The word collision is resolved in favour of the engagement.** The methodology block's
diverge/converge/capture stages are now **phases**, and `pass` means only the engagement-level unit.
The phase-1 sentence the prompt leans on — *"phase 1 is where your best findings come from"* — is
unchanged in force.

### Consequences

- **This ADR records a decision, not a result.** The recall payoff is unmeasured, and the design is
  falsifiable with an instrument that already exists: a third arm in `eval/compounding.ts` —
  `wiped` unioned, `persisted` naive, `persisted` lensed — scored on cumulative recall at k=3 and
  time-to-exit. It pays only if the lensed arm beats the unioned cold arm. Anything less means
  accumulation has been rebuilt and called learning, which is exactly the artifact `research/06`
  exists to record.
- An assay probe covers the router directly: plant a cleared cell, assert a pass-2 router never
  returns empty while one remains. A positive control in the sense `docs/evaluation.md` requires.
- `core/passes.ts` is pure and carries the lens vocabulary, the ladder, the per-lens worklist,
  `promoteLens`, the per-pass delta and the `/pass` view. The extension is left reading the
  workspace, bumping the manifest and drawing the result — the division `challengeCommand` already
  set.
- Default-off means the ratchets and the corpus keep measuring the current behaviour until an arm
  turns it on, so nothing already reported changes meaning.

### Rejected

**Opening pass 2 automatically when the router empties.** It spends budget and re-touches a client's
systems on the harness's initiative, and an empty router is also what the end of a finished job looks
like. Saying another pass is available is not the same as running one — the same line ADR-014 draws
around challenging.

**Making a cleared cell `not-tested` again.** It would repair the router by corrupting the number the
client is handed: work that was genuinely done would be reported as never attempted, and the coverage
percentage would fall as the engagement deepened. The verdict is right; what was wrong is that the
router treated it as terminal.

**A `passes` store in the ledger.** The pass is a counter on the manifest and a field on records that
already exist. A fifth store would need a format version, a renderer and a browser to hold one
integer and a string.

**A global setting in `~/.pired/`.** Every other engagement-shaped policy — scope mode, `maxAgents`,
`targetType`, `strictUnresolved` — lives in `scope.json` because it belongs to the engagement rather
than the operator, and a ladder inherited from last month's firmware job is the wrong default for
this week's retest.

**Nudging about available passes in the standing block.** ADR-016 rejected the same thing for cleared
cells and the argument is unchanged: a line that renders every turn on every engagement is how the
block stops being read.

---

## ADR-019 — The banner does not repeat what the rail is already saying

**Status:** accepted · 2026-09-19

### Context

The welcome entry is one block: the banner, then the coverage matrix drawn under it, with the
engagement rail floating to the right of both. It reserves enough rows for the editor to clear the
rail — about 21 — and `extensions/pired.ts` only draws the matrix when what is left over is worth
drawing into:

```ts
const room = rows - banner.length - 1;
const box = coverageView && room >= 7 ? renderCoveragePanel({ … }) : [];
```

So the banner's height is the matrix's budget, and nothing said so anywhere. Measured against the
widths `core/layout.ts` actually hands out:

| terminal | banner | banner rows | matrix gets | drew? |
|---|---:|---:|---:|---|
| 190 | 116 | 9 | 11 | 6 of 8 classes |
| 150 | 91 | 9 | 11 | 6 of 8 classes |
| **120** | **62** | **15** | **5** | **nothing — five blank rows** |
| 100 | 42 | 15 | 5 | nothing |

A 120-column terminal is an ordinary one, and on it pired's signature view — checklist × surface,
the whole rigor thesis — was replaced by blank space. Not because the matrix was too big: because
the banner above it was six rows taller than it needed to be, and the test failed by two.

Two things made it tall, and neither was load-bearing.

**The footer decided the layout.** `compactNeeds` required `TAGLINE + 3 + cmdRow` — 85 columns,
fixed, whatever the facts do — so any banner under about 145 columns was thrown into the stacked
layout. The stacked layout is 15 rows against the side-by-side layout's 9. A row that can simply
wrap was re-laying out the wordmark and the facts.

**A path was cut to a constant.** `shortPath(info.cwd, 44)` ran whatever column the path landed in,
and a path is the longest value in the block by a wide margin. At 62 columns the side-by-side layout
needed 62 and had 60. It missed by two, on a value that was already abbreviated.

And the row that survived all that was the one worth losing. With the rail up, `recorded` puts the
coverage percentage on screen for the **third** time — banner, coverage box, rail — and the findings
tally for the second.

### Decision

The banner takes `panelVisible`. When the rail is drawing the ledger, the banner drops its
`recorded` row: identity and the armed gate are what a banner is for, and state belongs to the view
that owns it. With `--no-panel` there is no rail and no coverage box, so the flag is off, the banner
is the only thing carrying those numbers, and it keeps them.

Alongside it, two layout facts stop being constants. `compactNeeds` is now the facts' width only —
the footer wraps itself in `footerLines`, stacking the tagline above the commands when the pair will
not fit, which costs two rows instead of six. And `pathMax` is the column the path lands in rather
than 44.

| terminal | banner rows | matrix gets | draws |
|---|---:|---:|---|
| 190 / 150 | 9 → **8** | 12 | **all 8 classes** |
| 120 | 15 → **10** | 10 | **5 of 8, then `+3 more`** |
| 100 / 85 | 15 / 16 | 5 / 4 | still nothing |

### Consequences

100- and 85-column terminals still get no matrix, and that is left alone. At 42 columns the banner
is already down to values without labels, so the rows would have to come out of the wordmark or the
air around it, and a matrix drawn into 40 columns is a class label and a four-cell bar. Blank rows
are the better answer there; if that changes, the lever is the narrow layout's four blank rows, not
the reservation.

Raising the reservation was rejected. It buys rows for the matrix by pushing the editor further down
the screen on every session for the life of the engagement, to fix a frame you see once.

`panelVisible` is a layout fact, so it sits on `BannerOptions` beside `minLines` rather than on
`BannerInfo`, which describes the engagement. The extension derives it from `bannerReserve() > 0` —
the same test that already means "the panel is off" — so the two cannot drift apart.

---

## ADR-020 — A tool result renders as one row, because pi paints rows and not strings

**Status:** accepted · 2026-09-21

### Context

`renderRecordResult` replaces pi's generic tool output with a single security-native line — a
recorded finding's severity first, because that is the engagement's product. It returned one string
and always meant one row. It never enforced one row, and pi's renderer gives it no help.

pi renders a tool result inside a `Box` (`pi-tui/dist/components/box.js`) that renders the child at
`width - 2`, measures the result with `visibleWidth`, fills it out to the frame width, and paints
`toolSuccessBg` across the whole thing. Every step of that treats the string as a row. A `\n` inside
it is not a line break the TUI knows about: the green fill opens on the first physical row, the
padding lands on the second, and pi's line accounting is off by one for everything drawn below —
the rail panel included. What the operator reports is a successful record tearing the panel.

`record` results are routinely multi-line, because `record` answers the model and not the operator.
`macroDigest` appends `\nEngagement: surface 34 · coverage 22% · …` to **every** successful write
(`core/tools.ts`), with a paragraph of second-person guidance above it for model sections and for
findings short of confirmation.

It looked intermittent because `truncateToWidth` bills a `\n` as one column, so a narrow frame cut
the summary before the newline and a wide one cut after it. The threshold is therefore per record
kind, five columns past the end of that kind's first line — measured, and the same +5 for all three:

| result | first line | tears from |
|---|---:|---:|
| `record kind=endpoint` | 37 cols | width 42 |
| `record kind=hypothesis` | 41 cols | width 46 |
| `record kind=model` | 118 cols | width 123 |

Physical rows emitted for what the renderer believed was one row, measured against pi's own `Box`
arithmetic with the strings `core/tools.ts` assembles verbatim:

| terminal | `kind=endpoint` | `kind=hypothesis` | `kind=model` |
|---|---:|---:|---:|
| 40 | 1 | 1 | 1 |
| 80 | **2** | **2** | 1 |
| 120 | **2** | **2** | 1 |
| 140 | **2** | **2** | **2** |
| 200 | **2** | **2** | **3** |

So an ordinary 120-column terminal tore a row on every hypothesis and every surface element — which
is most of what an engagement records — and looked clean on the model sections an operator writes
early. That ordering is why it read as random.

### Decision

The row is the summary's **first line only**, and the renderer enforces it rather than trusting its
input. `oneRow` (`core/transcript.ts`) takes that first line and replaces C0 controls and DEL with
spaces: a lone `\r` returns the cursor to column 0 and overprints the row, and a `\t` is three
columns to pi-tui and eight to the terminal. Both are the same off-by-n as the newline arriving by
another route, and a renderer that only defends against `\n` invites the next one.

Cutting the tail rather than wrapping it is the same reasoning as ADR-019, one surface
over: everything after the first line is addressed to the model in the second person — an operator
cannot act on `record kind=model section=what text="..."` — and the digest's numbers are already on
the operator's screen, in the status line always and in the rail when it is open. The model receives
the whole body unchanged; this cuts the transcript row, not the tool result.

The line moves to `core/transcript.ts`, leaving pi's `Component` shell in the extension.

### Consequences

- Findings are untouched. `recordDetails` carries `severity` and `title` only for findings, so a
  finding renders from `details` and never showed the summary. `oneRow` guards its title anyway,
  because a title is operator-supplied text and can be pasted.
- Anything else pired renders into a single-row component has the same exposure. `oneRow` is the
  shared answer; the footer's foreign-status flattening in `extensions/pired.ts` is the same defence
  written inline, before this was understood as a class of bug.
- A `record` summary whose useful content is on its second line would now be invisible to the
  operator. None is today, and the constraint is worth keeping: the first line of a tool summary is
  the part addressed to whoever is watching.

### Rejected

**Returning one array entry per line.** `render` returns `string[]`, so splitting the body and
letting `Box` paint each line would fix the tear and keep every word. It also undoes the thing the
renderer exists for: two to four rows of model-facing prose per `record`, in a transcript that on a
review gets one every few seconds, is the generic tool output that `renderRecordResult` was written
to replace. The bug was never that one row was the wrong shape — it was that nothing made the string
be one.

**Flattening the newlines into the single row instead of cutting at the first.** Keeps everything
and still cannot tear, but the row becomes `Recorded hypothesis H-7 (refuted) on E-12 Engagement:
surface 34 · coverage 22% · 180 test ca…` — the summary crowded off its own line by numbers the
status line is carrying two rows below, truncated mid-word.

---

## ADR-021 — The installers register pi-subagents, and only pi-subagents

**Status:** accepted · 2026-09-22 · reframed by ADR-027 · 2026-09-23

> The decision stands: the installers register pi-subagents and nothing else. ADR-027 adds
> version floors (`pi ≥ 0.86.1`, `pi-subagents ≥ 0.71.0`), which the installers enforce, now that
> delegation runs *only* through the package. It also corrects the `omitExtensionBindingsEnv`
> premise cited below. Foreground children now load pired's own tools directly. On
> pi-subagents ≥ 0.68 they also inherit the providers the parent registered, so the provider
> mirror is not what makes delegation work there. Before 0.68 it still is: an in-process child
> knew only pi's own providers, and the mirror is how it resolved pired's.

### Context

pired's system prompt contains a soft hint — *"if a sub-agent tool is available, delegate isolated
recon…"* — and `extensions/lib/providers.ts` carries ~80 lines whose whole purpose is making
delegation work: pi-subagents spawns async children with extension bindings deliberately withheld,
so the providers are mirrored into pi's own settings for those children to find. `research/07`
records what that cost when it was missing: **subagent delegation was broken for an entire corpus
run**, and two mlflow targets timed out at 30 minutes wedged behind it.

All of that machinery is dormant on a fresh install. `pi-subagents` is a third-party package, and
until now the installers did not mention it: the only pointer was a README section three screens
down from the install command. An operator who follows the quickstart gets a harness that hints at a
tool it does not have, and finds out during the first engagement that wanted one.

ADR-017 is the reason for the hesitation. It removed `pi install <pired>` from both installers
because registration is not per-resource — it put `themes/` on pi's global path too, and one `pired`
start then rewrote `theme` in `~/.pi/agent/settings.json` for every `pi` the operator ever ran
again. The rule that came out of it was *the scripts never write inside pi's directory*.

### Decision

**The installers register `npm:pi-subagents`, as a named row in the plan, and nothing else.**

The distinction ADR-017 turns on is *whose behaviour changes and whether anyone was asked*. That
decision is about pired reshaping a general-purpose `pi` that nobody pointed at pired. This is a
delegation extension the operator would otherwise install by hand from the README, by typing the
same command this row runs:

- It is a `+` row in the plan, naming `~/.pi` as where it writes, before the single confirmation.
- `PIRED_SKIP_SUBAGENTS=1` declines it, and the undo hint carries `pi remove npm:pi-subagents`
  exactly when the run is going to add it.
- A box that already has a subagents package registered — including a fork, of which the ecosystem
  has a dozen — is left alone.
- It runs after pired, and its failure is a warning carrying the retry command, never a failed
  install. pired works without it; that is the whole premise of depending on nothing.
- `pi install` exiting 0 is not taken as proof. The old registration step was guarded with
  `pi list | grep`, because pi can report success and record nothing, and that guard is the part of
  it worth keeping.

### Consequences

- The installers now write outside their own prefix, which they previously did not do at all. The
  plan row and the opt-out are what make that a choice rather than a surprise, and they are the
  parts with tests on them.
- A bare `pi` gains delegation tools it did not have. That is the cost, it is stated in the row
  (*"loads in every pi"*), and it is a general-purpose capability rather than a security-operator
  prompt and a scope gate.
- pired still ships no sub-agent machinery and takes no dependency on one. Nothing imports the
  package; the cooperation is the mirror in `providers.ts` and a sentence in the prompt.
- `install.test.ts` exists now, and runs the real `install.sh` under `/bin/sh`, dash and busybox
  against stub `npm` and `pi` binaries on a sandboxed PATH and HOME. `install.ps1` refuses to run
  off Windows, so its decision lives in `Get-SubagentsState` / `Test-SubagentsRegistered`, which any
  `pwsh` can call directly, and the rest is held to parity assertions against the shell script.

### Rejected

**Leaving it to the README.** The status quo. It is the honest ADR-017-shaped answer, and it is what
produced a corpus run where delegation was broken throughout and nobody noticed until the results
were graded. A capability the prompt promises should not be a documentation step.

**Installing it unconditionally, as a prerequisite.** Simpler code, one less branch. It also makes
an operator who does not want a third-party extension in their `pi` unable to say so except by not
running the installer — and the thing being installed is exactly the kind of package a consultant on
a client box is entitled to refuse.

**Registering it behind an opt-in flag** (`--with-subagents`). ADR-017 rejected flag-guarded
registration on the grounds that a flag nobody passes is a code path nobody tests. That reasoning
holds, and it argues for default-on with an opt-out: the path that runs on every install is the one
the tests exercise.

**Vendoring or reimplementing delegation.** Answered before this repo had an installer:
*"Why reimplement and not just use them as they are? I don't want to maintain any extra
dependencies."* (`research/01`).


---

## ADR-022 — Provider settings are a draft form with an explicit save

**Status:** accepted · 2026-09-23 · supersedes ADR-011's immediate field saves for the terminal manager

### Context

ADR-011 replaced repeated model questions with menus, but every provider field
still opened a separate prompt. Editing a URL saved it before the corresponding
token could be changed. The theme's red accent also colored ordinary dialog
prompts, making routine configuration look like an error.

### Decision

`/provider` uses a custom terminal component with a neutral border, editable
fields, preset defaults, and Save/Cancel/Delete actions. The component holds a
provider draft and calls the existing persistence adapter only on Save. Escape
from a changed provider asks whether to discard it; deletion defaults to keeping
the provider. Validation and save failures retain the draft.

Model IDs can be pasted in bulk or selected in a searchable, scrolling list.
Filtering preserves selections, and toggling a model preserves its customized
settings. Discovery is explicit so a hosted provider can receive its token
before the request is sent. Model metadata and compatibility helpers remain
shared with the existing wizard. Environment key references are resolved for
discovery but stored as references; rendered inputs mask tokens.

### Consequences

The terminal component lives in `extensions/lib/provider-panel.ts`, since it
owns pi input and rendering. File writes, registration, and mirroring stay in
`hosts.ts`. The callback-only `/login` path and hosts without `ui.custom` retain
the dialog fallback. The change is local to provider management; it does not
change the theme's accent for the rest of pired.

Tests drive the component with real terminal input sequences and exercise the
command through real temporary files, including create/edit/delete, model
registration and mirroring. Layout checks cover short and narrow terminals.


## ADR-023 — UI controls preserve focus, position, and explicit decisions

**Status:** accepted · 2026-09-23 · updates ADR-022’s theme scope

### Context

Alt+P was reported cycling models in Windows Terminal / PowerShell. pi rejects
extension shortcuts that collide with reserved model actions; the conflict is
reproducible with its real shortcut registry. The panel also depended on an
overlay completion callback that pops the top overlay, even when a newer dialog
has opened above the panel. Calling it after hiding the panel could dismiss an
unrelated form.

The browser spent a glyph-legend row that navigation had counted as content,
reset selection when returning from detail, and reset it again on refresh. Long
finding details in the rail were truncated rather than scrollable. Approval
cancellation had a data consequence: pi’s boolean confirm API returns false for
both Escape and denial, so cancelling recorded a decision the operator had not
made. Automatically opening those prompts also blocked awaited tool events and
competed with active forms.

### Decision

- F6 toggles the panel and F7 expands/restores it. Alt+P/Alt+M remain aliases;
  host model controls keep their bindings. The focused rail handles its own
  controls, and commands remain available when a terminal intercepts a key.
- The persistent rail closes by its own overlay handle. It does not invoke pi’s
  stack-pop completion callback after hiding. Pending opens carry a generation
  guard, including the disk refresh before opening. Panel commands refresh both
  counts and rows after external ledger edits. Overlay failures fall back to a
  footer view. Session changes reset
  the old rail and keyboard capture.
- Navigation and rendering share the browser’s content budget. Detail views
  retain their parent position; refresh follows record identity through sorting.
  Finding details wrap long paths and scroll with the frame and controls visible.
- Background questions produce one notification per session and remain in
  `/blockers`. Answering is an explicit action. Approvals offer Skip, Approve,
  and Deny, with Skip first; only explicit Approve/Deny choices settle them.
- Ordinary controls, links and activity use subdued blue. Error red remains
  reserved for error/severity roles and the brand mark. Neutral labels and
  selection backgrounds have more contrast.

### Consequences and validation

The rail’s custom promise is fire-and-forget: releasing its own handle and local
callbacks lets it be collected without popping another extension’s overlay.
This follows the installed host’s lifecycle behavior rather than assuming its
completion callback targets an identity.

Regression tests exercise pi’s actual shortcut registry and overlay stack,
Windows Terminal F6/F7 sequences, rapid toggles, session resets, asynchronous
failure, focused-panel input, background notifications, and real ledger writes
for explicit approval decisions. Pure renderer tests cover row budgets, long
evidence paths, preserving selection, and narrow exit hints. A native Windows
machine was not available; the Windows key sequences are exercised through the
installed key parser and extension registry.


## ADR-024 — Red is the identity; error state needs more than color

**Status:** accepted · 2026-09-23 · supersedes ADR-023’s blue palette only

### Context

Making all normal accents blue separated activity from failure but lost pired’s
identity as the red version of pi. A red brand does not require red form fields
or borders, and color alone cannot tell an operator whether an action failed.

### Decision

Use muted red for activity, links and active accents, brighter soft red for
thinking levels, and warm charcoal for selections. The wordmark keeps its bright
red. Failures and destructive actions retain saturated error red. Provider forms
keep neutral labels and borders; error and warning feedback starts with `!` and
states the problem or corrective action. Selection keeps its cursor marker.

Theme regressions check red hue, distinct activity/error output through pi’s
truecolor and 256-color conversion, and text contrast on the shipped dark and
selected backgrounds. Provider tests check neutral forms and corrective error
messages without relying on color. ADR-023’s keyboard, focus, navigation and
explicit-decision behavior remains in place.

## ADR-025 — Native workers share durable state and isolate conversation context

**Status:** superseded by ADR-027 · 2026-09-23 · never accepted

> The matched comparison this waited on (ADR-026) was overtaken by ADR-027: the native
> worker existed to route around a child that could not load pired, and no such child
> exists. `pired_delegate` and `extensions/lib/delegation.ts` are deleted; a foreground
> pi-subagents child carries `record`/`recall` and the scope gate through
> `extensions/child.ts`. Kept for the requirements it framed, which ADR-027 inherits
> (shared ledger, isolated context, bounded handoff, sequential foreground runs).

External subagents lose pired's extension bindings, tools and scope gate. A
prompt telling the parent to delegate cannot ensure its child can consult or
update the engagement. Local models also pay heavily for long transcripts and
concurrent requests to one GPU.

The extension now provides `pired_delegate`, with `investigate` and `verify`
roles. The distinct name avoids a collision with external `delegate` tools.
Each worker uses the parent's selected model and provider registry, current
source directory, scope and shared core `record`/`recall` tools. It receives a
bounded snapshot built from exact record IDs or source paths, including related
claims, model, checklist and open blockers. `recall context` refreshes that
snapshot from disk. Neither conversation history nor the loot ledger is
injected into the brief; source and evidence remain accessible on demand.

The host adapter owns the model loop. Workers expose no delegation tool, run
sequentially, and have turn, time and estimated input budgets. Every successful
record refreshes the parent's UI before the worker's next model request. Tool
output and progress events are saved in owner-only workspace artifacts, while
the parent receives at most 4,000 characters. A limit, cancellation or provider
failure returns an explicit unfinished state with references to retained work.
The existing scope gate applies to each worker tool call; its documented shell
indirection limits remain unchanged.

`completed` is an execution status, not a new verification authority. The
existing ledger rules still decide whether a finding is suspected or confirmed.
The parent owns cross-component reasoning and final judgment. Prompts require
surface and hypotheses to be recorded when discovered, followed by findings
when supported; the scribe remains an optional recovery path.

Regression tests exercise real shared workspaces and tool execution with
scripted model replies. A separate live synthetic assay checks early recording,
child source/shared-model access, parent recall, and bounded handoffs against
Luna and a configured local model. It measures orchestration behavior, not
vulnerability recall or a performance advantage. External pi-subagents and
`pired-ledger` remain supported under their existing, explicitly unguarded
child-process contract.

---

## ADR-026 — Native delegation is accepted on a pre-registered corpus margin, not on every target

**Status:** accepted · 2026-09-23 · governs the acceptance of ADR-027 (written for ADR-025)

> Written for ADR-025's native worker. ADR-027 replaced the candidate with pired's workers through
> pi-subagents and kept this rule unchanged. Read "ADR-025" below as "the candidate under test",
> which is now ADR-027's change. The protocol of record is `eval/delegation-compare.md`.

### Context

ADR-025 is accepted only if it finds vulnerabilities about as well as the baseline while spending
fewer tokens. In the operator's words: "similar quality with less tokens." The test is a matched
comparison (`eval/delegation-compare.ts`, protocol in `eval/delegation-compare.md`). It runs the
five research applications, three fixed passes per version, on GPT-6 Luna and GLM-5.3 Flash at medium
effort. It counts every parent, worker and compaction token.

The first draft of the protocol approved the candidate only when its observed mean true positives
and precision were no lower on *every* target. Resampling the research's own per-target runs showed
what that rule measures:
- A candidate of identical quality and 10% fewer tokens was approved in 8.4% of Luna grids and 7.3%
  of GLM grids, and in 0.7% of grids when both models had to pass.
- With three passes per target, and one or two labelled locations on four of the five targets,
  "no lower on every target" mostly measures noise.

Two further problems:
- **Precision as a mean of per-run ratios**, with a zero-claim run counted as 0, pointed both ways.
  It rejected a candidate with the same true positives over the same claims. It approved one that
  spent four times the claims for the same hits, because a single 1/1 run lifted its mean.
- **The research defines precision as pooled TP over claims.**

### Decision

The rule was fixed with the operator before any scored session. The candidate is approved on a model
when the grid is complete and official, and all of the following hold:
- Its pass-mean pooled true positives reach at least 85% of the baseline's.
- Its pooled precision (ΣTP/Σclaims over the grid) reaches at least 85% of the baseline's.
- On no target does every candidate pass find fewer true positives than the worst baseline pass.
- Its mean total tokens are lower.

ADR-025 is accepted only if both models approve. Per-target results, pooled precision per target and
token ranges are reported alongside, and each decision label names the part that failed.

### Consequences

The same resampling puts the rule's error rates, for both models together, at:

| Candidate's true positives | Chance of approval |
|---|---:|
| Identical to baseline | ~62% |
| 15% fewer | ~15% |
| 25% fewer | ~3% |

The margin chooses which error the experiment prefers; it does not remove either. Five passes would
move the identical-quality figure to ~77%, at 100 sessions instead of 60, and were declined.

The rates come from bootstrapping three historical runs per target, which understates variance, so
the real ones are somewhat worse. A rejection therefore does not show that the candidate is worse,
and an approval does not show that it is better. Both are screens on this corpus, and the retained
findings still need reading before either is believed.


### Amendment — a second approval path: finding more (2026-09-24, before any candidate run was graded)

The operator's original rule had two halves: accept if the results are **better**, or at the same
level with fewer tokens. The gate above implemented only the second. On 2026-09-24, with one baseline
run graded and no candidate run graded, the operator stated the first half explicitly: "it's ok to
spend more if we are going to find more." The live candidate sessions on GPT-6 Luna were delegating
heavily (scout, investigate, then verify) and spending several times the baseline's tokens, so this
path is the one the comparison could turn on, and it is fixed here before any candidate result.

A model's grid now approves the candidate on **either** path, both requiring the complete official
grid:

1. **Similar quality, fewer tokens** — the gate above, unchanged.
2. **Finds more** — candidate pass-mean pooled true positives at least **115%** of the baseline's
   and strictly greater; grid-pooled precision at least 85% of the baseline's; no target wholly
   below its baseline range; tokens not gated, and reported.

ADR-025/027 delegation is accepted only if **both** models approve, each by either path; the
summary names the path. Resampling the research's per-target runs (the same simulator) gives the
second path, for both models together, a chance of firing on an identical candidate of 3.4%, and
of catching a true +25% / +50% improvement of 58% / 95% (a 25% threshold would be 0.4% / 36% / 88%).

The harness code is not changed while the grids run — a `--resume` after a provider-quota stop
refuses when any pinned harness file differs — so the second path is applied to the finished
grids' `runs.jsonl` afterwards, by the same `compareMatchedRuns` extended with this rule.

### Amendment — a held-out guard against tuning on the graded corpus (2026-09-24, before any held-out run)

The v3 grids surfaced defects in the delegation design (ADR-028), and the next candidate fixes them.
Every one of those defects was found by reading runs on the five research applications, so the
next candidate is tuned on the corpus that grades it, however generally its fixes are written. The
operator's instruction was "DO NOT OVERFIT OVER THE CURRENT CORPUS".

Four further corpus applications have answer keys and pristine trees, and no run on them was read
during the diagnosis:

| application | language | labelled locations |
|---|---|---|
| filegator | PHP | 3 |
| CasaOS | Go | 3 |
| publify | Ruby | 12 |
| taguette | Python | 3 |

The manifest is `eval/heldout/manifest-2026-09-24.json` (sha256 `29d31fd9aa18…ed3705`); the answer keys
are the corpus's own `<name>.truth.json`, hashed in `eval/delegation-compare.md`.

The candidate that follows the v3 grids is accepted only if both of these hold:
- ADR-026's gate approves it on the official grid, both models, each by either path.
- A held-out grid shows no quality regression on either model. The grid is the four applications
  above, run on the same harness, baseline (496b190), models and effort, with three passes per
  target. No regression means:
  - candidate pass-mean pooled true positives are at least **85%** of the baseline's;
  - grid-pooled precision is at least **85%** of the baseline's.

Tokens are reported there, not gated; the official grid gates them. There is no per-target guard,
because three of the four applications have three labelled locations or fewer.

The held-out grid is exploratory in the harness's sense (not the research manifest), so it can only
veto, never approve. The official scorer decides it; a range-aware re-score is reported beside it
and decides nothing. Until the held-out grid is graded, no run on those four applications is read
to shape a fix. Its error rates are not simulated: the research has no per-target history for these
applications to resample.
### Amendment — the luna official grid is re-run with a 4-hour run limit (2026-09-24, before the re-run)

The v5 official luna grid could not be decided. Its LinkAce pass 3 **baseline** (the unchanged
pired@496b190) ran past the 2-hour per-run limit with 322 requests made, still working. The harness
classes a timeout as non-infrastructure, so the pair was blocked, and an official grid with a
blocked pair cannot approve. OpenAI answered about four times slower per request that night than in
v4: about 30 s against about 8 s, so a baseline that finished in 41 minutes in v4 did not finish in
120. One further run was held for 21 minutes by the model's own unbounded shell command, and only an
operator's kill kept it from timing out.

The operator chose a fresh official luna grid under the same gate, with two environment changes that
apply to both arms and are fixed here before it runs:
- the per-run limit is **4 hours** (`--timeout 14400000`);
- a `bash` call that names no timeout gets **900 s**, loaded in both arms' parent sessions
  (`eval/delegation-compare-bash-timeout.ts`). A timeout the model sets itself is kept.

Everything else is unchanged: the candidate is snapshot v4 (digest `826bd8d0…`), the baseline is
496b190, and the grid is the five research targets, three passes, at medium effort. The v5 official
luna pairs are reported as indicative only and are not pooled with the re-run. GLM keeps its v5
grid, which has had no timeout.

### Amendment — DeepSeek V4.1 Flash is a third model, reported as evidence, not gating (2026-09-24, before any DeepSeek grid)

On 2026-09-24 the operator added DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash`, served through
commandcode.ai's OpenAI-compatible endpoint) to the comparison. By then luna and GLM grids had
already reported pairs. This is recorded before any DeepSeek grid runs. The only DeepSeek traffic so
far is two one-line prompts, which confirmed the endpoint answers and that thinking engages at
medium effort.

DeepSeek runs both grids in the v5b environment:
- the official five research targets and the four held-out applications, three passes each;
- candidate snapshot v4 (`826bd8d0…`) against baseline 496b190, at medium effort;
- a 4-hour per-run limit and a 900 s default for `bash` calls that name no timeout, in both arms.

Its official grid is judged by this gate (either path) and its held-out grid by the held-out guard.
Both verdicts are reported, with the path named.

**Its verdicts do not enter the acceptance rule.** Delegation is still accepted only when GPT-6 Luna
and GLM-5.3 Flash both approve and the held-out guard vetoes neither. A DeepSeek approval cannot
stand in for a missing or failed priority model, and a DeepSeek rejection cannot veto them.

A gating model added after two grids have reported would move the acceptance bar in whichever
direction its result happened to fall. Fixing its weight now, before that result exists, prevents
that. Where DeepSeek disagrees with the priority models, the disagreement is reported for a reader
to weigh.

### Amendment — luna's official grid runs a third time, with a try-again infrastructure class (2026-09-24, before the v5c grid)

The v5b luna re-run was blocked after 7 matched pairs. Its filebrowser pass 3 baseline, the
unchanged 496b190, failed after two minutes on "Codex error: Unable to verify Daybreak Blue access.
Please try again." That is an entitlement check on OpenAI's side; the four other luna runs in flight
at the time kept working. pi's retry list does not match the message, so the harness classed it as
the run's own failure and blocked the pair, and a blocked pair keeps an official grid from approving.

The operator chose a fresh official luna grid, v5c, with one change to the classifier, fixed here
before it runs: a provider-originated error message that asks the client to try again ("please try
again") counts as infrastructure, and its pair re-runs whole. Measured in `~/.pi/agent/sessions`,
every provider message with that phrase was transient by its own wording: 20 codex overloads, which
pi already retries, and this one access check. The quota patterns run first, so a spent plan whose
message says "try again later" still stops the grid.

Everything else is v5b's:
- candidate snapshot v4 (`826bd8d0…`) against baseline 496b190;
- the five research targets, three passes each, at medium effort;
- the 4-hour per-run limit and the 900 s `bash` default;
- the same gate.

The v5b luna pairs are indicative only and are not pooled with v5c, as v5's were not pooled with v5b.

v5b's pairs so far are recorded here so the re-run cannot be read as a rescue. Over 7 matched pairs:
- true positives were 5 for both arms;
- the candidate's pooled precision was 53% of the baseline's;
- the candidate's mean tokens were 2.9 times the baseline's.

That result failed both approval paths. The re-run exists because of the block, not because of those
numbers.

GLM's v5 grids keep the harness they started with, because a resume refuses changed pins. If the same
message blocks a GLM pair, it will be reported as this gap, not re-classified after the fact.

### Amendment — GLM's remaining runs use z.ai's general API endpoint (2026-09-25, before they run)

pi's `zai` provider pointed at z.ai's Coding Plan endpoint (`https://api.z.ai/api/coding/paas/v4`).
Its quota was spent on 2026-09-24 and resets on 2026-09-28 at 09:15 UTC. The operator provided a z.ai
Start Plan voucher of 300M tokens, which bills through the general API endpoint
(`https://api.z.ai/api/paas/v4`).

From 2026-09-25 the provider points there. GLM's remaining official pairs and the held-out GLM grid
run on it until the voucher runs out or the grids end.

Nothing else changes:
- host `api.z.ai` and the same key;
- model `glm-5.3-flash`, with the same 200,000-token context window and 16,000-token output cap;
- thinking at medium;
- the same harness, candidate and baseline.

The harness pins only the endpoint's origin, which is unchanged, so the grid resumes under its
original pins.

Both arms of every pair run on the same endpoint, so each pair stays matched. The 7 official pairs
completed before the switch ran on the Coding Plan endpoint. The GLM summary will report how many
pairs ran on each.

If the voucher runs out, the balance error stops the grid as a quota stop. The remaining pairs then
run on the Coding Plan endpoint after its reset.

**Outcome, the same day:** the general endpoint refused the key with `1113 Insufficient balance or no
resource package`, because the voucher was not on that account's balance. Every GLM run there failed
within seconds as infrastructure, and no GLM pair completed on it. The provider was switched back to
the Coding Plan endpoint at 15:3x UTC on 2026-09-25. This amendment applies only if the voucher is
later credited to that key.

The voucher turned out to be ZCode's "Weekend Build" Start Plan. It is 300M tokens of `glm-5.3-flash`,
served at `zcode.z.ai/api/v1/zcode-plan/anthropic`. That endpoint accepted the credential but answered
`3007 captcha verify failed`: it is gated to the ZCode app. It was not used.

### Amendment — held-out GLM runs on commandcode.ai (2026-09-25, before it runs)

GLM cannot run on z.ai until 2026-09-28 09:15 UTC:
- the Coding Plan quota is spent until then;
- the general API has no balance on the key;
- the ZCode voucher is limited to the ZCode app.

commandcode.ai serves the same model as `z-ai/glm-5.3-flash`. One test call stopped normally with
thinking engaged. The larger `zai-org/GLM-5.3` and the `glm-5.3-flashx` variant it also lists are
different models and are not used.

The held-out GLM grid runs fresh on it now:
- the four held-out applications, three passes each;
- candidate snapshot v4 against baseline 496b190, at medium effort;
- the same harness as GLM's official grid, with its 2-hour per-run limit;
- the same 200,000-token context window and 16,000-token output cap as the `zai` entry.

The earlier held-out GLM grid, `heldout-2026-09-24-v5/glm`, never completed a pair and is superseded.

GLM's official grid stays on z.ai's Coding Plan, keeps its 7 pairs, and resumes after the reset. The
two GLM grids therefore run on different serving paths: z.ai directly, and a reseller whose upstream
is not known. The guard remains sound, because it compares candidate and baseline within its own
grid, and both arms share the endpoint. The two grids' absolute numbers are not pooled or compared.

---

## ADR-027 — Delegation is pi-subagents' in-process children, not a native worker

**Status:** provisional · 2026-09-23 · supersedes ADR-025 · supersedes ADR-013 · reframes ADR-021

> The design is settled, but whether the change is kept is not. Under ADR-026 it is kept only if
> the matched comparison (`eval/delegation-compare.md`) approves on both priority models, GPT-6 Luna
> and GLM-5.3 Flash, and the held-out guard vetoes neither. The candidate under test is frozen
> snapshot v4 (`826bd8d0…`), which carries ADR-028's fixes. A rejection means this change is not
> kept as it stands.
>
> On 2026-09-24 the operator merged this work to `main` while the grids were still running and
> before their verdict. The merge does not change what the grids measure, because they run the
> frozen snapshot, not `main`. Delegation ships on by default (`maxAgents` 8); `maxAgents: 0` turns
> it off (see `docs/delegation.md`).

### Context

ADR-013, ADR-021, ADR-025 and `research/07 §3` all rest on one sentence: *pi-subagents
spawns children with extension bindings deliberately stripped (`omitExtensionBindingsEnv`),
so a child never loads pired.* Everything downstream — the `pired-ledger` CLI, the
provider mirror, the native `pired_delegate` worker — was built to route around that.

The sentence is a misreading, and reading the package settles it.
`omitExtensionBindingsEnv` (`pi-subagents-0.71.0/.../runs/shared/extension-bindings.js`)
deletes exactly one environment variable, `PI_SUBAGENT_EXTENSION_BINDINGS` — a ≤16 KiB
JSON metadata blob a parent passes down — and returns the rest of the env untouched. It is
called only in the *out-of-process* runners (`external-cli-runner.js`, background
`async-execution.js`); a foreground child never goes through it. Since pi-subagents 0.65
a foreground child is an **in-process pi `AgentSession`**, not a spawned process, so there
is no env to strip in the first place. And pired is not an ambient extension that a child
would or would not inherit: `bin/launch.mjs` assembles it with one `pi -e <path>` per
extension (ADR-017), so "child disables ambient extensions" never bore on pired's own
loading. What is true, and all that was ever true, is narrower: a *packaged* agent
definition ships no `record`/`recall`, and a child launched with `extensions: []` loads
nothing — including any provider extension it needs to resolve its model. The
`0 turns | 0 tokens | 0 tools` deadlock in `research/07` was a child that could not
resolve its model, not a child that could not load pired.

An agent's `extensions: [<abs path>]` loads that extension into the in-process child, the
way `pi -e` does for the parent. So pired can give a child its own `record`, `recall` and
scope gate directly, with no CLI. On pi-subagents ≥ 0.68, where an in-process child inherits the
parent's registered providers, it needs no mirror either.

### Decision

**pired delegates only through pi-subagents. The supported and measured stack is pi 0.87.1 +
pi-subagents 0.71.0. The native worker is deleted.**

- Four agents, registered at runtime through pi-subagents' process-local event contract
  (`pi-subagents:runtime-agent-register:v1`), never by importing the package:
  `pired-scout` (attack-surface mapping — routes, handlers, inputs, trust boundaries,
  sinks), `pired-investigate` (deep dive on one lead), `pired-verify` (fresh adversarial
  refutation) and `pired-escalate` (impact amplification — chains existing findings into
  concrete paths, never inflating severity without one).
- Each agent's child loads `extensions/child.ts` (logic in `core/child.ts`, which imports
  only ports), binding `record`/`recall` to the parent's workspace and arming the scope
  gate at `maxAgents: 0`.
- `extensions/lib/delegation.ts`, `pired_delegate` and its activation are removed.
- Both installers enforce the floors, `pi ≥ 0.86.1` and `pi-subagents ≥ 0.71.0`. They install
  or upgrade an unpinned `npm:pi-subagents`, and leave a pinned or forked entry alone with a
  note. pired reads no version number. The agent definitions use the subset 0.66 and 0.71 both
  accept, so an older package still registers the workers. It costs the full `subagent` schema
  on every request, and pired tells the operator once when it sees that schema active without the
  lazy loader. Before 0.68 its children also resolve pired's providers only through the
  `~/.pi/agent/models.json` mirror (0.68 made in-process children inherit the parent's providers).

The measured facts behind this come from no-model runs with a scripted faux provider. Three
sources, and they show different things.

- **spike-core** (pi-subagents 0.66 on pi 0.84.2, a prototype child extension built from
  pired's core `record`/`recall` and scope gate). Unsealed, a child loaded through a runtime
  agent wrote a hypothesis into the **parent's** ledger (`recall` in the parent read it back).
  Its out-of-scope bash was blocked with pired's exact reason, and its nested `subagent` call
  found no such tool. The parent's `scope.json` and `process.env.PIRED_WORKSPACE` were unchanged
  afterward. Under the Landlock+seccomp seal (`eval/corpus/fs-seal.c`) the same script showed
  much less. The first launch named a session directory the seal did not grant, and failed with
  `EACCES`. The parent then consumed the scripted child steps itself: its own record, its own
  blocked `curl`, and a second launch. That second launch fell back to pi-subagents' default
  session directory inside the writable agent directory. There the child loaded, read the
  parent's scope and armed its gate, but it only returned a final message. So under the seal,
  spike-core shows only that a child loads and arms once its session directory is writable.
- **spike-latest** (pi-subagents 0.71 on pi 0.87.1) used a stand-in child extension: a
  record-like tool writing its own ledger file, and a gate hard-coded to one IP. It does not
  exercise pired's `record`/`recall` or scope gate. What it shows is 0.71's mechanics: a runtime
  agent's `extensions` load into the in-process foreground child, the tripwire below, and the
  lazy loader's overhead.
- **The real child extension on 0.71 / pi 0.87.1** is shown end to end by
  `extensions/child.test.ts`, which runs when `PIRED_TEST_PI_SUBAGENTS` names the package
  (docs/testing.md). The parent launches `pired-scout`. The child's record lands in the parent's
  ledger, and its out-of-scope bash is refused with the parent gate's reason and never runs. It
  sees no delegation tool. The parent's `scope.json` and `PIRED_WORKSPACE` are unchanged, and its
  usage is in its own `session.jsonl`. Under the seal it is shown by the comparison harness's
  delegation probe, which grants `<cell>/child-sessions`. There the record reaches the parent's
  ledger, out-of-scope bash is blocked, and the child session reconciles with the parent's
  `subagent` result. Nested-delegation refusal and scope/env integrity have not been measured
  under the seal.

What those runs established:

- The child extension is a **fail-closed tripwire** (spike-latest). An agent whose `tools`
  allowlist names `record` fails at agent_start if that extension does not load, so a child never
  runs half-armed. When `record` was absent from the allowlist *and* the gate extension was
  missing, the spike's out-of-scope bash executed (the `LEAKED` marker). That is why the allowlist
  must carry `record`.
- Parent overhead is a real cost and the reason delegation is opt-in in the prompt. The
  full `subagent` tool schema is ~5k tokens/request on 0.66 (~21k chars for `subagent`
  alone). 0.71's lazy loader shows the parent a ~0.5k-char `subagents_enable` stub until
  first use, cutting the standing cost to ~1.4k tokens. Hiding `bg_wait` (~4.4k chars,
  ~1.1k tokens) drops pi-subagents' residual to ~0.3k until the model first delegates. pired's
  own `<delegation>` block adds 1,886 characters (~470 tokens at four characters a token) to the
  system prompt on every request once the workers register (measured as
  `delegationBlock({}).length`). So the standing cost of having delegation available on 0.71 is
  about 0.8k tokens per request, not 0.3k.
- **The first wording did not get used.** The first `<delegation>` block called delegation
  "never required" and "for when your context gets noisy", next to pi-subagents' own "direct
  execution is the default; complexity alone never authorizes delegation". In the first
  official grid (2026-09-24, interrupted), four of five candidate sessions ran 18–97 turns of
  whole-application review on GPT-6 Luna and GLM-5.3 Flash without once calling
  `subagents_enable`; the fifth (Luna, filebrowser) enabled it in its first turn. A capture of
  the scored parent's prompt showed the block was present, so the cause was the model's
  reading, not a harness fault. The block now states the operator's authorization in
  pi-subagents' own terms ("applicable instructions") and informs the economics — every read
  is re-sent on every later request; a worker reads in a fresh context and returns 200 words —
  without requiring a single launch. The grid was restarted with the revised candidate; its
  interrupted runs are not mixed into the comparison.

### Consequences

- The pinned pi runtime moved 0.84.2 → 0.87.1. `extensions/lib/context-guard.ts` now
  handles both context shapes so a downgrade does not break the guard.
- pired stays foreground and synchronous by design (accountable, and kind to one GPU): the
  parent gate denies `async: true`, and pired hides `bg_wait` and `subagent_supervisor`
  from the parent's active tools, re-applied each `before_agent_start`.
- **The parent gate vets a launch against an allowlist, not a denylist.** A launch is
  `{agent, task}`, where `agent` is one of the four pired agents. The only additions allowed are
  a `cwd` inside the engagement directory, `async: false` and `context: "fresh"`. The last two
  restate the definition. Everything else is refused with a reason naming the field. The
  denylist it replaced missed fields that defeat the design. `gate` and `acceptance.verify` run a
  shell command on the host after the worker, through `spawn(…, {shell: true})`, outside every
  `tool_call` hook. In a review probe, a `gate` command wrote a marker file, while the same
  command through `bash` was refused. `model` with a `:level` suffix put a worker on another
  provider, which sends client code there. In the comparison, a model mismatch also invalidates
  the run and halts the grid. `context: "fork"` handed the worker the parent's whole transcript,
  and `sessionDir` moved its session out of the pinned directory. The schema has dozens of
  top-level keys and changed between 0.66 and 0.71. An allowlist fails closed on the next one.
- **Workers run one at a time, and the gate enforces it.** pi runs the tool calls of one
  assistant message in parallel unless a tool declares itself sequential. `subagent` does not,
  so two launches in one message ran two workers at once: a review probe showed their runs
  overlapping. The gate refuses a launch while one it allowed is still running. It releases the
  slot when that call ends, and refunds the budget when pi-subagents rejected the launch before
  any worker started.
- **A worker takes its scope from the parent in-process, never from `scope.json`.** The parent
  publishes a deep-frozen copy of the scope its own gate was built from, on `globalThis` under
  `Symbol.for("pired.parent-scope.v1")`, keyed by workspace. The child arms from that copy and
  refuses to start without it. The workspace's `scope.json` is written for the panel and
  `pired-state`, and the gated model can write it, since the scope gate does not police local
  paths. One edit would have re-armed every later worker with a wider scope while the parent's
  own gate stayed as it was.
- External runner agents (claude-code, codex-exec, cursor-agent, …) are denied by the
  parent gate, since only the four pired names pass it.
- pired still imports nothing from pi-subagents; the cooperation is the event contract and
  the `extensions: [child.ts]` path, nothing more.
- ADR-026's acceptance comparison re-runs **both** arms on 0.87.1: baseline is pired at
  `496b190` without pi-subagents, candidate is pired + pinned pi-subagents 0.71.0, both on
  pi 0.87.1 with cacheWarming off. The candidate is a snapshot of the current tree. Its digest
  goes into `eval/delegation-compare.pins.json` before any scored run, and until then every grid
  is exploratory. The native-worker snapshot pinned for ADR-025 (`675bd2ef…`) does not apply.

### Rejected

**The native worker (ADR-025).** It existed to solve a problem that was not there. Once a
child can load pired's own tools, a second delegation engine inside pired is glue to
maintain, a `complete()` loop to keep correct, and a divergence from the ecosystem every
operator already knows.

**A hybrid thin tool over pi-subagents' foreground delegation API.** pired keeps a small
`pired_delegate`-shaped tool and drives the worker from inside its `execute()`, hiding
pi-subagents' own model-facing tools — measured cheapest on 0.66 (parent tool schema ~7k
vs ~25k chars). It buys that by speaking pi-subagents' internal `prompt-template:subagent:*`
event names, which are not a contract. More glue against a private surface, for a saving 0.71's
lazy loader already delivers. (Its other drawback when it was rejected, one worker at a time, is
now the rule anyway: see Consequences.)

**Loading `pired.ts` unchanged into children.** The full extension in a child re-runs
pired's session bootstrap: with no engagement handed down it drops the scope gate back to
`off` and overwrites the parent's `scope.json`. A child gets `core/child.ts` — record,
recall and the gate, and nothing that writes engagement state.
---

## ADR-028 — Workers record verdicts, not rewrites; the ledger never loses an open lead

**Status:** provisional · 2026-09-24 · amends ADR-027 · accepted only under ADR-026 and its held-out amendment

> The first measured candidate of ADR-027 (the v3 snapshot) was not accepted. In the v4 grids it
> found as many true positives as the baseline on GPT-6 Luna, for about half the mean tokens, but at
> 75% of the baseline's precision. On GLM-5.3 Flash it found fewer (3 against 7 over five first-pass
> pairs). These rules are what reading those runs turned up. Whether they are kept is decided by the
> next grid and by the held-out guard in ADR-026's second amendment.

### Context

Nine read-only investigations of the finished v4 runs (all luna and GLM candidate cells, 64 workers)
traced the candidate's losses to its delegation mechanics, not to the model's reading of the code.
None of the five true positives GLM's candidate lost sat in code it never opened. Each of the
following mechanisms is general; the corpus appears here only as evidence.

- **A verifier could rewrite what it was sent to check.** An update by `id=` is last-write-wins by
  design: it is the operator's escape hatch for correcting a record. `pired-verify` had the same
  power. On GLM filebrowser pass 1, the candidate's ledger replayed to 4 true positives before its two
  verifiers ran and to 2 after. They re-recorded two findings with new descriptions, which dropped the
  investigator's cited locations. A verifier could also set operator dispositions (`false-positive`)
  with no basis, and one did.
- **A verdict had nowhere durable to go.** The verify mission said to record against the hypothesis.
  The challenge brief said to set the finding's status. Parents told verifiers not to change status.
  10 of 15 luna verify runs told to leave status alone left no verdict on any row, and 35 of 37
  candidate findings ended `suspected`. In a code review, the refutation bar demanded a live target
  that did not exist: `judge()` downgraded any refutation that said `live=false`. So an honest verifier
  could not refute, while baseline parents confirmed and refuted by asserting `live=true` on scopes
  with no target (17 of 18 of their verification records).
- **An open lead could be erased by a check that never looked at it.** A hypothesis is its
  `(target, class)` cell, and an implicit merge keeps the stronger outcome. `inconclusive` ranks below
  `refuted`, so a later refutation of a different mechanism in the same cell silently closed a lead
  that nobody had resolved. On GLM note-mark this was a stored-XSS lead ("cannot verify offline"); the
  baseline confirmed the same issue. The same code is in both arms.
- **Workers lost their own records.** The budget refusal blocked `record` along with everything else.
  17–18 worker `record` calls were refused at the budget line, 11 of them neither in the ledger nor in
  the handoff. 6 luna verifiers recorded nothing, 4 of them handing back early with a verdict in prose
  only. 12–19% of worker turns went to tools that could never succeed: `grep` and `find` failed on
  every call (45/45, 57/57) on a host without `rg`/`fd`, and pi-subagents' "use contact_supervisor
  first" prompt section led to 31 refused calls.
- **A spent worker budget handed everything left to the most expensive context.** The cap refusal
  said "do the rest here". 43.5% of luna candidate parent tokens were spent after the last worker. One
  run spent 65 requests and 11.7M tokens there, found 0 true positives, and added 8 claims. 23 of 25
  verify launches covered one finding, and all 5 cap refusals were verify launches.
- **The parent was told its context was a budget.** 4 of 5 GLM pass-1 candidates stopped with 12–49% of
  their test cases settled. They gave context-budget reasons that echo the delegation block's "your
  context is this review's scarcest budget … doing it yourself is often cheaper". No baseline run did.
  This is correlation: a pass-2 candidate with byte-identical text reached 100% coverage and scored
  best.

### Decision

- **A verifier records a verdict, never a rewrite** (`core/child.ts`, enforced in the child gate, which
  reads the ledger):
  - Its write on a finding must carry a `status`: `confirmed` (with `control`, and `entitlement` where the
    class needs it), `refuted` (with `basis`) or `suspected` (with `basis` or `control`: what it checked
    when it could not settle it). A `reason` alone is a note, never a verdict.
  - Title, description, location, severity, evidence lists and deletion are refused, with the reason.
  - A finding in an operator disposition (`reported`, `triaged`, `false-positive`, `accepted-risk`,
    `ignored`) keeps its status. The verifier may only add a grounded look.
  - It may create a finding only for a hypothesis it recorded `confirmed`, linked by that hypothesis's
    id, and only when the call duplicates no existing finding. That finding lands `suspected` unless it
    carries `confirmed` with the control case.
- **Scouts map and propose; they do not record findings.** Enforced the same way.
- **A verdict is durable whatever it is.**
  - An unsettled look (`status=suspected` with a basis or control) records an `unresolved` verification.
    It never moves a settled status and never replaces an earned verification; its grounds are added to
    the earned one's notes.
  - A verdict that misses its bar with no grounds at all writes nothing but the reply.
  - Only an earned verdict (stands, amended or refuted) on a settled status, a confirmed status or a
    disposed status takes a finding out of the challenge queue. Examined-but-unsettled findings stay in
    the queue, after the unexamined ones, labelled with what was checked.
  - In an engagement that lists no targets (`isSourceOnly`), a refutation grounded in a cited basis is
    accepted without `live`, and no reachability flag is stored. With targets listed, the reachability
    bar is unchanged.
- **An open lead is closed only by a check that names it** (`core/identity.ts`):
  - An implicit refutation does not move an `inconclusive` cell, and the held lead keeps its own method
    and evidence.
  - A new inconclusive lead reopens a cleared cell only on a single-cell write, and only over a clearance
    nobody re-checked. Different wording is not taken as a different mechanism in bulk. A reopen drops the
    clearance's verification.
  - The tool reply names every lead it held, reopened or kept closed, with the call that reopens one
    deliberately.
  - The explicit `id=` + basis re-check still moves it, and writes a verification.
- **Workers keep their records:**
  - The grace turns past a worker's budget still allow `record` and `recall`.
  - A worker's last `RECORD_RESERVE_TURNS` turns refuse every other tool until it has recorded
    something.
  - A worker about to hand back with nothing recorded gets one reminder at `agent_before_settle` and
    one more turn, and never a second reminder. What counts as recorded is a ledger row actually
    written: evidence files, notes and no-op repeats do not count, and for a verifier only a finding or
    hypothesis verdict does. A worker that established nothing is told it may hand back and say so.
  - Workers get the operator's toolset (`read`, `bash`, `record`, `recall`).
  - pi-subagents' supervisor section is stripped from their prompt.
- **Verify takes several findings.** One at a time, each verdict recorded before the next, the rest
  handed back as unchallenged. Its budget is 24 turns: one finding is still a tight check, and a
  measured 5-finding batch settled two in 16–18 turns.
- **The worker budget is in the plan, and spending it means wrapping up.** The delegation block
  states how many launches the engagement allows. The cap refusal no longer says "do the rest here":
  it asks the parent to settle what the ledger holds first (unchallenged findings, open leads,
  verdicts not yet acted on), and to prefer closing items to opening new surface. It is not a stop:
  one post-cap phase found a true positive.
- **Context is information, not a stopping rule.** The delegation block still says what reading costs
  and what a worker returns. It now says that a filling context is a reason to hand an area to a
  worker, and that when the review is done is decided by the method in the instructions.

### Rejected

- **Stripping disallowed keys from a verifier's update instead of refusing it.** The write would
  succeed while doing something other than what the model asked, and the model would not learn the
  boundary. A refusal costs one turn and says why.
- **Ending a worker's run when it records nothing.** Its work would be thrown away. A refusal that
  steers it to record keeps the work, and so does the one-time reminder before hand-back.
- **A hard stop after the worker cap.** It would have lost the post-cap true positive. Wrap-up
  guidance addresses the runaway without it.
- **Grounding cited line numbers, and repairing the scorer's handling of `file:lo-hi` ranges.** Both
  were measured to cost true positives. Both are driven by how the benchmark grades, so they are
  outside a change to delegation mechanics. The scorer defect is reported beside the verdict as a
  sensitivity check and is a separate decision.
- **Row provenance (`by` on every ledger write).** It would make "who vetted what" answerable, but it
  changes FORMAT.md, and nothing above depends on it.
