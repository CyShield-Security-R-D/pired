---
name: ops-finding-writeup
description: Use when promoting a confirmed hypothesis to a finding — how to write a complete, report-grade record kind=finding and de-dupe against existing ones.
---

# Writing report-grade findings

Goal: a `record kind=finding` that a client could act on without asking you a single follow-up question — clear title, correct target, CWE, justified severity, a description that explains impact, exact reproduction steps, evidence paths, and remediation. Findings are the deliverable; everything else is scaffolding.

## Record everything — nothing gets dropped
A complete ledger is a goal in itself: every issue you **confirm** *or* **strongly suspect** gets captured, and even thin leads are retained rather than forgotten. Match the record *type* to your confidence — don't discard a lead just because it isn't nailed down.
- **Confirmed** hypothesis → a full `record kind=finding` (below). Update the source hypothesis outcome to `confirmed` and link it (`hypothesisId`); set the hypothesis's `findingId` too so the chain is bidirectional.
- **Strongly suspected but not yet proven** → still record it — as an *unconfirmed / low-confidence* finding (leave `status=open`, pick an honest severity, and say in the description exactly what's unproven) plus a `blocker` for the step you can't take; or keep it as a live hypothesis. Never silently drop a plausible issue because you ran out of time to confirm it.
- **Plausible but unconfirmed lead** → keep it as a hypothesis with `outcome=inconclusive` (retained, resurfaced by `recall gaps`); in the `recon` profile, promising-but-unexploited leads are recorded at severity `info`. Ideas you disproved are marked `refuted` — also retained, for rigor.
- Before wrapping up, `recall gaps` / `recall hypotheses` to confirm no inconclusive lead was left un-recorded. Completeness first; the de-dup step below keeps breadth from turning into noise.

## Anatomy of a good finding
```
record kind=finding \
  title="IDOR in GET /api/user lets any user read others' PII" \
  severity=high \
  target=e1 \
  class=authz \
  cwe=CWE-639 \
  cvss="CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N" \
  description="The /api/user endpoint returns any account by numeric id with no ownership check (backend/routes/user_routes.py:41). The handler reads the id straight from the query string and fetches that row, never comparing it to the session's own user." \
  impact="Any customer with a login can read every other customer's name, email, postal address and national ID — roughly 40,000 records — by incrementing a number. That is the whole customer database in the hands of anyone who can register, and it is personal data under GDPR." \
  remediation="Scope the query to the caller: fetch by session user id, or add an ownership check at the data-access layer before returning the row. The same pattern appears in three other handlers listed in the evidence; fix them together rather than patching this endpoint alone." \
  repro="1. Log in as attacker (id 1002). 2. GET /api/user?id=1001 with attacker's session cookie. 3. Response returns user 1001's full profile. 4. Increment id to enumerate all users." \
  evidence=["evidence/y7-userA.txt","evidence/y7-userB.txt"] \
  status=confirmed \
  hypothesisId=y7
```

Field-by-field:
- **title** — specific and impact-bearing: *what* + *where* + *what an attacker gains*. Not "IDOR bug" but "IDOR in /api/user lets any user read others' PII".
- **severity** — `info|low|medium|high|critical`, justified by real impact and exploitability. See `ops-severity-cvss` to choose and defend it.
- **target** — the inventory element id (`e1`, `h3`, `s4`) so it ties to the surface; a raw string only if nothing in inventory fits (then consider recording the surface element first).
- **class** — the checklist class id (`authz`, `sqli`, ...); this is what marks the coverage cell `vulnerable`.
- **cwe** — the single most specific CWE (`CWE-639` not just `CWE-284`). Map via `ops-severity-cvss`.
- **cvss** — optional but preferred: a full **v4.0** vector string (v3.1 only when the engagement requires it — `record` validates against the version the prefix claims and rejects a mismatch). Built in `ops-severity-cvss`.
- **description** — what the flaw *is* and where: the mechanism, the location as `file:line` or `METHOD /path`, in plain language. Not the journey you took to find it.
- **impact** — what it costs **this client**, in their terms: the records exposed, the money moved, the service lost, the obligation breached. Quantify from evidence ("~40,000 customer records including national IDs"), never by restating the CVSS metrics ("confidentiality impact is high" tells them nothing). This is the paragraph that gets skipped and the one a manager reads — see `ops-technical-writer`.
- **remediation** — the concrete change that fixes it, specific to this codebase: the control to add, the call to replace. Never "sanitize input". Fix the cause, name the other places the pattern appears, and say explicitly when a leaked credential must be rotated.
- **repro** — numbered, copy-pasteable steps a third party can follow to reproduce, including preconditions (which account, which cookie). Reproducibility is what separates a finding from a guess.
- **evidence** — workspace-relative paths to the request/response captures and screenshots that prove it (see `ops-evidence`). Every finding should have at least one.
- **status** — `open` → `confirmed` → `triaged` → `reported`. Three statuses settle a finding instead: `false-positive` when it fails to hold, `accepted-risk` when the client accepts it, `ignored` when the operator sets it aside. All three keep the row and the history and take a `reason` — record the operator's words, not your paraphrase — and take the finding out of the open count. Use them when the operator says so; do not settle a finding on your own judgement.

## De-dupe before you record
- `recall findings` first. If the same root cause already exists (e.g. IDOR on several endpoints of one API from one missing check), prefer **one** finding describing the class with multiple affected endpoints over N near-identical findings.
- Genuinely distinct root causes = distinct findings, even if similar-looking.
- To correct/enrich an existing finding, pass its `id` to `record` to update it in place rather than creating a duplicate (last-write-wins on the id).
- `record` checks identity before it creates anything, so re-recording something already in the ledger updates it rather than adding a row. It will tell you which id it matched; that id is what you pass to change it further.
- `record id=<id> delete=true reason="..."` retires a row for good. It is for what should never have been recorded — a mistake, or something the operator asked you to remove. A finding that is real but will not be acted on is a *status*, never a deletion: deleting it takes it out of the report the client reads. The operator's own `/dedupe` sweep is what repairs a workspace that already accumulated duplicates.

## Confirmation gate (avoid false positives)
- Never promote on a scanner/SAST hit alone — reproduce it by hand and save the evidence first. Raw tool output is a lead, not a finding — but don't drop the lead either: keep it as a hypothesis (`outcome=inconclusive`) so it survives to be retested.
- If a subagent/`spawn` tool exists, hand borderline hypotheses to an adversarial `verify` agent to try to refute them; only survivors become findings (see `ops-delegation`).
- State confidence honestly. If impact is likely but unproven, say so and consider `medium`/`info` with a note, or keep it a hypothesis with a blocker for the missing step.

## After recording
- Confirm the coverage cell flipped to `vulnerable` (`recall coverage`).
- Keep testing: one finding doesn't end the class — `recall gaps` / `recall next`.
- Export with `/report` when asked (`/findings` browses them); secrets are auto-masked at export (see `ops-loot-credentials`).

## References
- PTES — Reporting — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/reporting.html (report-grade finding structure: impact, reproduction, remediation)
- Technical Guide to Information Security Testing and Assessment — NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final (analyzing findings, evidence, reporting)
- CWE List — MITRE — https://cwe.mitre.org/ (pick the single most specific `cwe`)
- CVSS v4.0 Specification Document — FIRST — https://www.first.org/cvss/v4-0/specification-document (the `cvss` vector; scoring and the v3.1 fallback in `ops-severity-cvss`)
