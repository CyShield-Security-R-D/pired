# Coverage

Coverage is pired's rigor layer, and the reason an engagement does not end early. It is the answer to *"what have we actually looked at?"* — and, more usefully, *"what have we not?"*

```
checklist classes × recorded surface elements = the coverage matrix
```

One cell per (element, class) pair: *this vulnerability class, against this piece of attack surface.* A cell is settled when the agent has reasoned about that pair and recorded the outcome.

Coverage is **derived, never stored**. It is recomputed from the ledgers on every read, so it cannot drift from the evidence underneath it.

## The dependency worth understanding

**Coverage is over the surface you have recorded, not the surface that exists.**

An endpoint the agent never recorded has no cells at all. It cannot show as tested, it cannot show as a gap, and `recall gaps` cannot route to it. A review that records only findings leaves the matrix empty and its own coverage unmeasurable.

So an empty matrix is reported as empty, never as finished. `recall gaps` and `recall next` on a zero-denominator matrix say *"no surface recorded yet"* and name the fix, because "no gaps" and "coverage complete" are true of a completed engagement and of one that never started, and the agent is the party that can tell them apart.

This is a deliberate trade. pired cannot know what it was not told about — so the number it reports is honest about its own denominator rather than pretending to a completeness it cannot verify. It is why the system prompt pushes the agent to record inventory as it discovers it, and why the coverage view's empty state says *"no surface recorded yet — run recon, or record inventory"* rather than showing 100%.

## Cells and claims

A cell is the unit of coverage; a **claim** is the unit of reasoning, and they are not the same
number. `record` takes lists for `target` and `class` and writes the cross product, so one argument
— *"raw SQL queries interpolate registration input"* — asked of five routes is five cells and one
claim.

The panel splits them deliberately: the coverage section counts cells, the hypotheses section counts
claims, keyed on `(class, statement)` with whitespace and case normalised. Reporting both under the
word "confirmed" overstated what a real engagement had found by roughly eight times. The same
distinction decides when confirmed work counts as written up — a claim is written up when *any* of
its cells has a finding, because a reviewer writes one finding for one argument, not one per
endpoint. See [ADR-001](decisions.md#adr-001--the-panel-counts-claims-the-coverage-bar-counts-cells)
and [ADR-004](decisions.md#adr-004--confirmed-work-that-has-not-reached-the-report-is-surfaced-not-enforced).

## Cell statuses

| Status | Glyph | Means |
|---|---|---|
| `vulnerable` | `▲` | A hypothesis on this cell was **confirmed**. |
| `n/a` | `–` | The class does not apply to this element's kind. |
| `blocked` | `⊘` | An open blocker gates this cell or its element. |
| `testing` | `◐` | A hypothesis is `proposed`, `testing`, or `inconclusive`. |
| `clear` | `●` | A hypothesis was **refuted** — the class was ruled out here. |
| `not-tested` | `·` | Nothing has been recorded for this pair. |

Precedence is that order, top to bottom. Two of the rules carry real opinions:

**Confirmed beats `n/a`.** Evidence outranks taxonomy. If someone lands SQL injection on something the checklist calls a "host", the annotation is wrong — a finding is never hidden behind a classification.

**Blocked beats in-flight.** A cell waiting on an operator is not progress, and should not read as progress.

## What settles a cell

**A hypothesis outcome — not a finding.**

```
outcome: "confirmed"  →  vulnerable
outcome: "refuted"    →  clear
```

That is the design's sharpest edge: **ruling a class out is real work, and it only counts if you record the refutation.** Looking carefully at an endpoint and concluding it is fine leaves the cell `not-tested` unless the refutation is written down. The matrix measures recorded reasoning, not effort.

Settling one cell per call would mean hundreds of calls, so `record` accepts lists for `target` and `class` and records the cross product in one call — refutations are recorded in the shape they were reasoned in: one call, several classes, the single reason they share.

A confirmed hypothesis should *also* be recorded as a finding, tagged with the same `class`, so the finding maps back to its cell.

### The target has to name an element

A cell is keyed on `(element, class)`, so a hypothesis settles one only when its
target resolves to a recorded element. The model does not write ids — it writes
what it is looking at (`/api/register`, `POST /api/login`, `backend/auth.py`,
`CheckLinksCommand`) — so `record` resolves the target when the row is written.

That alone was not enough, because of *when* things get recorded. A review
reasons about a route and maps it as surface a turn later; the claim written
first kept the raw label forever, and nothing ever looked again. Measured across
the engagement ledgers on one machine: **192 of dvbank's 207 unattached
hypotheses named an element its own inventory already held**, and 38 of
filebrowser's 54. That is work that was done, recorded, and that the number could
not see — while the agent, reading `recall gaps` each turn, was told to go and do
it again.

So coverage resolves targets a second time, when the matrix is **computed**,
against the inventory as it stands ([`core/target.ts`](../core/target.ts)). Both
passes share one set of rules: the target as written, a route inside prose, the
target without its line number, its basename, and finally an element whose name
sits inside the target as a whole word — `CheckLinksCommand link checking` is the
`CheckLinksCommand` element, `user` is not the `users` one, and two different
elements named in one phrase get no answer at all, because a cell attached to the
wrong element reads as tested work that nobody did.

**Resolution never invents an element.** It can only attach a claim to something
already recorded, so the denominator cannot move: the percentage rises when work
that was already done is finally counted, and never because the matrix was
reshaped underneath you. On the ledgers above the effect was `+3` cells on
a client engagement, `+9` on filebrowser, `+47` on dvbank, and no denominator changed.

What is left over is reported rather than dropped. The `/coverage` summary reads
`… · 7 claims settle no cell` whenever recorded hypotheses reach no cell — they
name something nobody mapped, or something outside the surface this matrix
measures. It is the honest gap between the ledger and the number, and closing it
is a decision only the operator can make: map the thing as surface, or accept
that the reasoning about it is not a test case.

## Applicability: `appliesTo` and `n/a`

Not every class is askable of every element. "SQL injection" against a `tech` record is not an untested cell; it is a meaningless one, and counting it as a gap makes the denominator a lie.

A checklist class may declare what it applies to:

```jsonc
{
  "id": "sqli",
  "title": "SQL injection",
  "cwe": ["CWE-89"],
  "appliesTo": ["endpoint", "param"]
}
```

Cells outside that set become `n/a`. They keep their slot in the coverage bar so columns stay aligned across rows, but they are **out of the denominator**.

Both directions fail open: a class with no `appliesTo`, or an element with no recorded kind, is always in. A missing annotation can never silently shrink the denominator and inflate the percentage.

## The percentage

```
coverage % = (clear + vulnerable) / applicable

applicable = total cells − n/a cells
```

Rounded to a whole percent; `0%` when there is nothing applicable to cover.

So the number means: **the share of askable cells that have been settled either way.** In-flight, blocked, and untested cells all count against it. It is not "percent of tests passed" and not "percent of the code read" — it is percent of the *question space* closed.

## Gaps

```
gaps = not-tested + blocked
```

`recall gaps` lists them; `recall next` returns the next actionable cell, preferring `not-tested`, then `testing`, and **skipping blocked** — that is the non-blocking router. Work that is waiting on a human never stalls the engagement; it is parked and routed around.

## Checklists

The checklist is seeded once per engagement from a bundled template, chosen by target type:

| Profile / scope | Target type |
|---|---|
| `targetType` set in the scope file | whatever it says |
| `review` | `code-review` |
| Targets include domains or URLs | `web` |
| Targets are IPs or CIDRs only | `network` |

The shape of a scope settles exactly two of these. An API engagement is a list of URLs and looks identical to a web one; a firmware engagement names no network target at all. So `api.json` and `firmware.json` are reachable only by saying so:

```jsonc
{ "v": 1, "engagement": "acme-cam", "authorized": true, "mode": "off", "targetType": "firmware", "targets": {} }
```

An existing checklist is **never** clobbered — edit `checklist.json` in the workspace to add, remove, or annotate classes for a specific engagement. A malformed template is non-fatal: coverage simply stays uncomputed rather than taking the session down.

See [Skills and checklists](skills.md) and [`FORMAT.md` §7](../FORMAT.md).

## Seeing it

- **`/coverage`** — the full matrix, one row per class, with `⏎` into a class to see it down the whole surface. See [The interface](ui.md#the-coverage-view).
- **`F6`** — the [panel](panel.md), for the summary and gap count.
- **`pired-state --json`** — the numbers, for a status bar or a script.
- **`recall status` / `recall coverage` / `recall surface` / `recall gaps`** — what the agent sees, and it is the *same* view: `recall coverage` renders the matrix through the renderer `/coverage` uses, so the operator and the agent cannot be looking at two different numbers.

## Engagement types

The model is the same for whitebox and blackbox work; only the axes change.

| | Surface elements | Classes |
|---|---|---|
| **Code review** | Entrypoints, routes, modules, sinks recorded as inventory | Weakness classes: injection, authz, crypto, secrets, deserialization … |
| **Web / API pentest** | Hosts, endpoints, parameters, services, tech | OWASP-style classes against each |
| **Network pentest** | Hosts, services, ports | Service-level classes |

Which is why coverage correlates across both halves of an engagement: one matrix, one ontology, one number.
