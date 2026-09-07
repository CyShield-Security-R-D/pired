---
name: ops-challenge-finding
description: Use when asked to verify, challenge or re-check findings before a report — re-run the proof, run the control case, settle entitlement, and update only with the operator's agreement.
---

# Challenging a finding

Goal: try to **break** a finding before a client reads it, without ever losing a real one. This is a pull, not a habit — run it when the operator asks, before `/report`, or when a finding was recorded from a scanner hit.

`recall challenge` lists what is unchallenged, worst first. `recall challenge id=<id>` returns the brief for one, already carrying the class contract and everything visible about it without touching the target.

## 0. Do it in a fresh context
A verifier that has already read the reasoning behind a claim agrees with it. Measured: the scribe pass, which re-read the agent's own review buffer, cost 2.5x the wall clock and moved precision from 0.059 to 0.038.

If a `spawn`/subagent tool is loaded (`ops-delegation`), hand the brief to a child and let it work from the record and the target alone. If not, work from `recall challenge id=<id>` and the code/target **without** re-reading your own notes about it.

## 1. The two bars, and why missing either is safe
- **To confirm:** run the control case and say what it returned.
- **To refute:** cite the grounds — a `file:line`, an evidence path, or the model section that settles it.
- **Miss either and the finding stays `suspected`.** It is not confirmed and it is not refuted. Nothing is deleted, ever. A refuted finding still appears in the report under its own heading with the grounds beside it, so a refutation that was itself wrong is visible rather than a bug that quietly left the document.

"I could not reproduce it" is not a refutation. Say what you ran and what came back.

## 2. Prove the target is alive before you conclude anything failed
Re-verifying a whole engagement on its last day, against a rotated credential or a target behind a new WAF rule, would refute every true finding it holds. **"The attack no longer works" and "I can no longer reach the target" are different verdicts.** Before any refutation:
```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://app.TARGET/"          # target up?
curl -sS -H "Cookie: $SESSION" "https://app.TARGET/api/me" | head        # session still valid?
```
If either fails, the verdict is `unresolved`, not `refuted`.

## 3. The control case is the whole job
A finding is not proven by the attack working. It is proven by the attack working **and the control failing**.

| class | the control that must fail |
|---|---|
| `idor` / `authz` | the same request with **no credentials at all**. If it also succeeds, the resource is public — there is no IDOR. Then a valid-but-unrelated id: a 200 for every id is a handler ignoring the parameter. |
| `sqli` | a true-payload and a false-payload must diverge, and the divergence must track the boolean. A 500 is an error, not injection. |
| `xss` | Content-Type is HTML and the payload lands **unencoded** in an executable position. Reflected-but-encoded is not XSS; a payload in a JSON body does not execute. |
| `ssrf` | an out-of-band callback fires, or a reachable/unreachable differential. A parameter that looks like a URL is not SSRF. |
| `redirect` | the `Location` header leaves the origin on a 3xx. A link in a body is not an open redirect. |
| `csrf` | the endpoint actually changes state and succeeds cross-site with no token — check `SameSite`, which defaults to Lax and defeats most of these. |
| `traversal` | the response contains a file from outside the root. A 500 is not traversal. |
| `default-creds` | the login yields an authenticated session that reaches something. A 200 on the login form is not a login. |
| `secrets` | use the credential. One that does not authenticate is a stale string. |

Save every re-run as evidence and cite it: `record kind=evidence name=<id>-control.txt content=...` returns the path.

## 4. Access control is a question about intent, and no request answers it
This is the one that ships false positives. Reading another user's object is a **bug when the reader was not entitled** and a **feature when they were** — a share link, a shared tenant, a collaborator role, an admin. The response is identical either way, so re-running it a hundred times settles nothing.

Ask: **who is this resource FOR?**
1. Check the target model: `recall model` — the `actors` and `invariants` sections exist for exactly this.
2. Read the code for a sharing feature, a `public` flag, team/org membership, a role check elsewhere on the same resource.
3. If neither answers it, that is a question for the operator, not something to resolve by testing. `record kind=blocker blockerType=scope-clarification question="Is a member of another team meant to be able to read /api/notes/{id}?"` — and the finding stays `suspected` until it is answered.

Write the answer into the model (`record kind=model section=actors`) rather than only into the finding: it settles every later finding on the same surface, not just this one.

## 5. Safety while re-testing
- **Re-run the read, never the write.** A finding proved by deleting a record is not re-verified by deleting another one. Review the captured evidence instead, and park an approval blocker if a real re-run is warranted.
- Every request still goes through the scope gate. It is not a way around it.
- Re-testing is traffic — detection risk and load on a client's production system. Challenge what matters, not everything.

## 6. Report the verdict; let the operator agree before you write
Say what you ran, what came back, and what it means. Then update:
```
record id=<id> status=confirmed  source=reproduced   # control ran, entitlement settled
record id=<id> status=refuted    reason="<the grounds — cite the file:line or evidence path>"
```
Set `source=` on every finding you touch — `scanner` (nobody re-issued it), `inferred` (no request behind it), `observed` (a response somebody saw), `reproduced` (observed twice with the control run). A consultant signing the report needs to know which is which.

**Ask before changing a finding's status**, especially one already `reported` — that is a claim the client has read, and withdrawing it is a conversation, not an edit. The most useful outcome is usually neither confirm nor refute: a corrected severity, a corrected location, or the proof it was always missing.
