---
name: ops-scope-safety
description: Use to operate safely and in-scope — read pired.scope.json, know the scope gate's limits, handle out-of-scope finds, and gate intrusive/destructive actions.
---

# Operating safely & in-scope

Goal: stay strictly within authorized targets, never stall the engagement, and gate anything intrusive/destructive behind operator approval. The scope gate helps, but it is **focus/accident-prevention, not a sandbox** — you are the primary control.

## 1. The scope gate is a seatbelt, not a wall
- Real isolation is the container/VM/network pired runs inside. The gate does best-effort extraction of URLs/hostnames/IPv4 from your `bash` commands and tool args, and blocks out-of-scope targets — but a shell variable, indirection, or encoding defeats it (PLAN.md §8, principle 5).
- Therefore: **treat every command as if there were no gate.** Read the scope, target only what's authorized, and don't rely on being stopped.

## 2. Read `pired.scope.json` before acting
The authorized scope lives in `pired.scope.json` (loaded when the project is trusted) and is mirrored to the workspace. Key fields:
```jsonc
{
  "engagement": "acme-webapp-2026",
  "authorized": false,              // MUST be true for offensive/network tools in enforce mode
  "mode": "enforce",                // "enforce" | "warn" | "off"
  "targets": { "domains": ["*.acme.test"], "ips": ["10.10.10.5"], "cidrs": ["10.10.20.0/24"], "urls": ["https://app.acme.test/"] },
  "exclude":  { "domains": ["admin.acme.test"], "ips": ["10.10.20.1"] }
}
```
Matching rules (know them so you self-police):
- `*.base` matches `base` and any subdomain; bare IPs match exactly; CIDRs use IPv4 containment; URL entries are prefix matches on the normalized URL.
- **`exclude` wins over `targets`** — an excluded host is off-limits even if it matches a target pattern.
- `authorized !== true` ⇒ network/offensive tools are blocked in `enforce` mode until the operator sets it true. In headless/print mode there is no prompt — it stays blocked unless the file says `authorized: true`.
- `strictUnresolved: true` ⇒ a recognized network command whose target can't be parsed is blocked (fail-closed); default is fail-open (allowed but flagged "scope unverified").

Check it early: `recall` surfaces scope; when in doubt, read the file. If no scope is loaded, only read-only local work (e.g. code review) is safe.

## 3. Modes
- **enforce** — out-of-scope targets are blocked; unauthorized-while-`authorized:false` network tools are blocked. This is the default operating assumption.
- **warn** — flagged but allowed; you must self-enforce.
- **off** — no gating; you are the only control. Behave as if in `enforce`.

## 4. Handling out-of-scope discoveries
Recon leaks neighbors — a passive source lists a sibling domain, a foothold can reach another subnet. Rules:
- **Do not touch it.** No requests, scans, or logins against anything not matching `targets` (and not in `exclude`).
- **Record it as a note** so the lead isn't lost: `record kind=note text="Passive DNS shows acme-internal.net (out of scope) co-hosted on 203.0.113.5"`.
- If it looks in-mission (clearly the client's, likely meant to be in scope), raise a **scope-clarification blocker** and keep working elsewhere:
```
record kind=blocker blockerType=scope-clarification priority=medium \
  question="acme-internal.net resolves to an in-scope IP but isn't listed in targets. Is it in scope?" \
  context="Found via reverse DNS on 203.0.113.5 during passive recon." blocks=["acme-internal.net"]
```

## 5. Authorization gate for intrusive / destructive actions
Some actions are in-scope by target but still need explicit sign-off. Before running any of these, `record kind=blocker blockerType=approval` and route around it:
- Active exploitation beyond a benign single-request PoC; brute force / password spraying; write/modify operations; data exfiltration/dumps.
- Anything destructive: deleting/altering data, stopping services, DoS-style load, `-T5`/high-rate scans on fragile targets, intrusive NSE `--script` categories.
- Post-exploitation lateral movement / privilege escalation (see `network-post-exploit-notes`).
- Never take a destructive action on assumption — no engagement authorizes data loss unless it says so explicitly.

## 6. Never stall — momentum via blockers
Blockers are async (PLAN.md §7.1): parking one gates a **work item**, not the whole engagement.
```
record kind=blocker blockerType=approval priority=high \
  question="Approve active SQLi confirmation on /login (single benign payload)?" \
  context="Error-based SQLi strongly suspected; needs approval for an active check." \
  options=["approve","deny"] blocks=["y12"]
```
- After parking, call `recall next` — it returns the next *unblocked* work; the gated coverage cell shows `blocked`, not `not-tested`.
- The operator answers this session or later (via `/answer <id>`, the `pired answer` subcommand, or editing `blockers.jsonl`); you pick it up on the next `recall`.
- **Bias to momentum:** prefer proceeding under a *stated assumption* + a low-priority confirm-blocker over stopping — reserve real blockers for what only a human can decide (authorize escalation, provide creds, resolve material scope ambiguity).
- Blockers dedupe on (question + blocks) — don't re-raise the same one. When no unblocked work remains, stop and summarize open blockers by priority instead of spinning.
- **Parked ≠ abandoned.** A blocker is a durable record that `recall` keeps resurfacing until it's answered; the gated work item stays on the board (`blocked`, not dropped), so routing around it loses nothing. The failure mode to avoid is *stalling* the whole engagement on one gate — not the gate itself.

## 7. Missing tools
pired ships no security tools; you run them via `bash` and they may be absent (principle 8). If a needed tool is missing: try an alternative, `record kind=note` the gap, and for a *critical* one `record kind=blocker blockerType=input question="install nmap?"`. Request installation as an operator-approved action; never install heavy tooling unprompted.

## Quick checklist before any network action
- [ ] Target matches `targets` and is not in `exclude`.
- [ ] `authorized: true` (for offensive/network tools in enforce mode).
- [ ] Action is non-destructive and within the benign-PoC line — else `approval` blocker parked.
- [ ] Rate/intrusiveness appropriate for the target; no DoS.
- [ ] Out-of-scope neighbors recorded as notes, not touched.

## References
- PTES — Pre-engagement Interactions — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/preengagement_interactions.html (scope definition, rules of engagement, Permission-to-Test / authorization)
- PTES — Post Exploitation — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/post_exploitation.html (rules of engagement governing lateral movement / destructive actions)
- Technical Guide to Information Security Testing and Assessment — NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final (§3–§5 planning, rules of engagement, and coordination boundaries)
