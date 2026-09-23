---
name: ops-technical-writer
description: Use when findings need to read like a consultant's deliverable — write or delegate the description, business impact and remediation for a recorded finding, working from the full record rather than from memory.
---

# The technical writer pass

Goal: every finding a client receives says three things well — **what it is**, **what it costs them**, **what to do about it**. Testing produces the first; the other two are written, and they are the two that get skipped when the person writing has just spent an hour in a debugger.

This is a pass over findings that are already recorded. It changes no verdicts: severity, CWE, CVSS and status are the tester's, and a writer who disagrees with one says so rather than editing it.

## 0. Do it as a pass, not inline
Write the finding when you record it if you can. But the strongest version of this is a **separate pass at the end**, because writing for a client needs a different frame from testing: the reader is not you, has not seen the code, and is deciding whether to spend money.

`recall status` shows how many findings are recorded; `record` tells you at write time when one is not report-ready. Either way, the pass is: list them, open each one in full, rewrite the three sections, record them back.

```
recall findings                 # the list — ids, severities, titles
recall finding id=f3a9          # ONE finding, every field as recorded
record id=f3a9 description="…" impact="…" remediation="…"
```

A field that is already filled is not necessarily finished. The scribe pass copies an impact or a remediation across when the review stated one outright, and a reviewer's aside ("should use parameterised queries") is a note, not the remediation section of a report. Read what is there and raise it to the standard below rather than assuming a non-empty field is done.

`recall finding id=<id>` is what makes this possible: it returns the whole record — description, impact, remediation, repro, evidence, cwe, cvss, target — not the one-line summary the list shows. **Never rewrite a finding from memory of having tested it.** Read it back first; the ledger is the source of truth and your context may have been compacted since.

## 1. Delegate it when the `subagent` tool exists
A writing pass delegates well. The task is bounded, the input is a record rather than a conversation, and the child needs none of the parent's accumulated context (see `ops-delegation` for the general rules).

pired has no writer agent, and its gate launches only its own four workers. Use **`pired-investigate`**: it reads the finding's evidence and the source behind it, and it has `record` on the same ledger to write the fields back. Hand the child **the id, not the story**, because it reads the finding itself:

```json
{"agent":"pired-investigate","task":"Technical writing pass on finding f3a9 — no new testing. Run: recall finding id=f3a9, then read the evidence files and source it cites. Rewrite three fields to consulting standard and record them back with record id=f3a9: description (what the flaw is and where — file:line or route — and the mechanism, in plain language); impact (what it costs THIS client in their terms: records exposed, money moved, service lost, obligation breached; concrete and quantified where the evidence supports it); remediation (the concrete change that fixes it, specific to this codebase/stack). Do not change severity, cwe, cvss, status or target. Do not invent facts: use only what the record, its evidence and the source show. If a claim needs a number you do not have, say what would establish it instead of estimating. Hand back the finding id and one line per field on what changed; the fields themselves are in the ledger."}
```

Delegate **one finding per child**. A child given twelve findings writes twelve paragraphs of the same shape. A child given one reads the evidence.

If the `subagent` tool is not available, do exactly the same work inline. That covers a prompt with no `<delegation>` block, and an engagement with `maxAgents=0`. The standard below is the point, not the delegation.

## 2. Description — what it is
- Lead with the flaw, not the journey: "The `/api/user` endpoint returns any user's record when `id` is changed, because the handler never checks that the requested id belongs to the caller (`backend/routes/user_routes.py:41`)."
- Name the location the way the report cites it: `file:line` for code, `METHOD /path` for a route.
- Say the mechanism, not just the label. "SQL injection" is a category; "the search parameter is interpolated into the query string with an f-string before it reaches the driver" is a finding.
- Plain language. A reader who is not a specialist should follow it; a specialist should find nothing hand-waved.

## 3. Business impact — what it costs them
This is the paragraph that gets left out, and the one a manager reads. Write it in **their** terms:

- **Quantify from evidence.** "Any authenticated customer can read all ~40,000 customer records, including national ID numbers" beats "sensitive data exposure". If you saw the record count, use it; if you did not, say what you did see.
- **Name the asset and who reaches it.** Which data, which accounts, which system — and what an attacker needs first (nothing / any account / an admin).
- **Say what an attacker does with it**, one step past the bug: account takeover, fraudulent transfer, silent data destruction, a foothold into the internal network.
- **Regulatory and contractual weight when it genuinely applies** — personal data under GDPR, cardholder data under PCI DSS, health records under HIPAA. State the category of obligation, not a legal conclusion; you are flagging exposure, not advising counsel.
- **Do not restate the CVSS metrics.** "Confidentiality impact is high" tells the client nothing they can act on. The vector is already in the record.
- **Do not inflate.** If the exploit needs an insider with admin rights and physical access, say so — an impact paragraph a client can puncture in one question costs you the whole report.

## 4. Remediation — what to do
- **Concrete and specific to this stack.** "Use parameterised queries — replace the f-string in `user_routes.py:41` with a bound parameter (`cursor.execute("… WHERE id = %s", (user_id,))`)" beats "sanitize input", which is not a fix and reads as filler.
- **Fix the cause, not the instance**, and say when the pattern repeats elsewhere: "the same construction appears in three other handlers listed below."
- **Add the control, don't just remove the symptom**: for authorization bugs, the ownership check at the data-access layer; for secrets, rotation *and* moving them out of source; for injection, the parameterised API.
- **Order it when there is an order**: an immediate mitigation the client can ship today (revoke the key, disable the endpoint) and the durable fix.
- **Rotate what leaked.** Any finding involving a credential, key or token says so explicitly — a fix that leaves a leaked secret valid has fixed nothing.

## 5. Checks before you call it done
- Would a reader who has never seen the system understand what is broken, why it matters, and what to do? If not, which of the three sections is doing the least work?
- Is every claim in the impact paragraph supported by evidence in the record, or clearly marked as a bounded inference?
- Does the remediation name a change someone can make this sprint, in this codebase?
- Is the severity still right after writing the impact? Sometimes it is not — go back to `ops-severity-cvss` and change it deliberately, with the reason in the description.
- Secrets and live tokens do not belong in the prose: cite the evidence path (`ops-evidence`). Export redacts recorded loot, not what you paste into a description.

## References
- `ops-finding-writeup` — the fields a finding carries and how to record it
- `ops-severity-cvss` — severity, CVSS v4.0 vector, CWE
- `ops-evidence` — what to capture and how to cite it
- `ops-delegation` — the general rules for handing work to a child agent
