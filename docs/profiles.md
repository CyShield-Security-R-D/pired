# Profiles

A profile sets three things at once: what the agent is being asked to do, whether the scope gate is armed, and which checklist the coverage matrix is built from.

```bash
pired --profile review     # default
pired --profile recon
pired --profile pentest
```

Or, invoking pi directly: `pi -e <pired>/extensions/pired.ts --pired-profile pentest`.
(pired's launcher also loads `extensions/hosts.ts`, which is what puts "Add a custom provider…" in `/login`.)

## `review` — whitebox code audit

The default, and the one that works with no configuration at all.

- **Read-only.** Never modifies the target code.
- **No scope gate** (`mode: "off"`) — there is no network target to be off.
- **Checklist:** `code-review`.
- **Method:** trace untrusted input from sources to dangerous sinks — injection, deserialization, authz/IDOR, SSRF, path traversal, SSTI, hardcoded secrets — and cite exact `file:line` for every finding.

The prompt is explicit that SAST, secrets scanners, and SCA widen coverage fast but cannot see missing access control, IDOR, or business-logic flaws. Those cells stay untested until the agent reasons about the code by hand, and enumerating every entrypoint is how they get found.

## `recon` — map the surface

- **Scope gate armed** (`mode: "enforce"`); blocked until an authorized scope is present.
- **Checklist:** `web` or `network`, chosen from the scope's target kinds.
- **Method:** passive and light-active enumeration only. Do not exploit.
- **Tools it reaches for:** `subfinder`/`amass`, `dnsx`, `httpx`, `whatweb`, `curl`, `jq`.

Hosts, services, endpoints, parameters, and technologies are recorded as inventory — which is what gives a later pentest engagement a coverage matrix to work against. Promising leads are surfaced as `info` findings; exploitation is left to a pentest.

## `pentest` — find and prove

- **Scope gate armed** (`mode: "enforce"`); blocked until an authorized scope is present.
- **Checklist:** `web` or `network`.
- **Method:** recon, enumerate, hypothesize, confirm, record — at whatever depth and order the target warrants.
- **Tools it reaches for:** `nmap`, `httpx`, `ffuf`/`gobuster`, `nuclei`, `sqlmap`, `curl`, `jq`.

In-scope hosts only, request/response evidence for each attempt, and the **least-intrusive PoC**. No data loss, no DoS, nothing destructive unless the engagement explicitly authorizes it — and if a step would cross that line, the agent parks an approval blocker instead of running it. That blocker becomes a yes/no dialog in front of you. See [Blocker dialogs](ui.md#blocker-dialogs).

## What the profile decides

| | `review` | `recon` | `pentest` |
|---|---|---|---|
| Default scope mode | `off` | `enforce` | `enforce` |
| Authorized by default | yes | no | no |
| Network tools | n/a | gated | gated |
| Modifies the target | never | n/a | n/a |
| Checklist | `code-review` | `web` / `network` | `web` / `network` |
| Exploitation | n/a | no | yes, least-intrusive |

Checklist selection for the network profiles: targets containing domains or URLs give `web`; targets that are only IPs or CIDRs give `network`. The `api` checklist exists and can be selected by editing the engagement's `checklist.json`.

## What the profile does *not* decide

Everything else is the model's judgment, deliberately.

pired's prompt hands the model situational awareness — its durable memory, the coverage map, the scope facts — and the stakes, then trusts it to choose the approach. Methodology lives in on-demand [skills](skills.md) the model pulls in as reference, not an always-on wall of instructions.

The reason is future-proofing: a script written for a weaker model boxes in a stronger one. The invariants the prompt *does* encode are the durable ones — agent-not-toolbox, recall-first rigor, never-stall momentum, and the hard scope and safety boundaries.

## Running both halves

An engagement is rarely just one half. The same scope often buys a code review *and* a test, delivered as one report.

Run them as separate sessions against the same engagement workspace — set `workspace` in the scope file, or use the same engagement name — and findings, evidence, and coverage correlate across both, because they share one ontology and one matrix.
