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

**Status:** accepted

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
