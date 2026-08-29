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

This is a deliberate trade. pired cannot know what it was not told about — so the number it reports is honest about its own denominator rather than pretending to a completeness it cannot verify. It is why the system prompt pushes the agent to record inventory as it discovers it, and why the coverage view's empty state says *"no surface recorded yet — run recon, or record inventory"* rather than showing 100%.

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
| `review` | `code-review` |
| Targets include domains or URLs | `web` |
| Targets are IPs or CIDRs only | `network` |

An existing checklist is **never** clobbered — edit `checklist.json` in the workspace to add, remove, or annotate classes for a specific engagement. A malformed template is non-fatal: coverage simply stays uncomputed rather than taking the session down.

See [Skills and checklists](skills.md) and [`FORMAT.md` §7](../FORMAT.md).

## Seeing it

- **`/coverage`** — the full matrix, one row per class. See [The interface](ui.md#the-coverage-view).
- **`alt+p`** — the [panel](panel.md), for the summary and gap count.
- **`pired-state --json`** — the numbers, for a status bar or a script.
- **`recall coverage` / `recall gaps`** — what the agent sees.

## Engagement types

The model is the same for whitebox and blackbox work; only the axes change.

| | Surface elements | Classes |
|---|---|---|
| **Code review** | Entrypoints, routes, modules, sinks recorded as inventory | Weakness classes: injection, authz, crypto, secrets, deserialization … |
| **Web / API pentest** | Hosts, endpoints, parameters, services, tech | OWASP-style classes against each |
| **Network pentest** | Hosts, services, ports | Service-level classes |

Which is why coverage correlates across both halves of an engagement: one matrix, one ontology, one number.
