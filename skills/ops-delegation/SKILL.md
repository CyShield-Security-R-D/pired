---
name: ops-delegation
description: Use when a spawn/sub-agent tool exists — delegate noisy recon and adversarial verification to a child to keep parent context clean and cut false positives.
---

# Delegating to sub-agents

Goal: use a child agent to keep the **parent's context clean** and to **reduce false positives**, not for raw parallelism. The two big wins on local models are context isolation (a noisy enumeration burns the child's context, and only a distilled result returns) and adversarial verification (a fresh agent tries to *refute* a hypothesis before it becomes a finding).

## 0. Availability
pired ships **no** sub-agent machinery itself. Delegation exists only if a `spawn`/subagent tool is loaded (e.g. the external **pi-subagents** package: roles like scout, reviewer, oracle, worker, researcher, delegate; or pired's documented `investigate`/`verify` roles). First check your tool list:
- If a `spawn`-style tool is present, use it as below.
- If not, don't fabricate it — do the work inline but apply the same discipline: capture raw output to `evidence/`, distill into `record`, and self-review hypotheses adversarially before promoting them.

## 1. When to delegate
Delegate work that is **noisy** (floods context) or **needs a fresh, skeptical pass**:
- **Isolated recon / enumeration** — a full subdomain sweep, a directory brute, per-host service enum. The child does the grinding; you get back a distilled inventory + proposed hypotheses, not 4,000 lines.
- **Adversarial verification** — hand a borderline hypothesis to a child whose job is to *break* it: try to refute, demand reproducible evidence, return `confirmed | refuted | inconclusive` with proof. This is the false-positive gate before a finding.
- **Bounded research** — "what CVEs affect nginx 1.18 + this module?" — answered in a child, summary returned.

Do **not** delegate: the core planning/coverage loop, final finding decisions, or anything needing your accumulated context. Keep judgment in the parent.

## 2. How to hand off (give the child a clean, bounded task)
- **One clear objective + explicit scope.** Name the exact target(s) and the authorized scope; the child inherits the engagement workspace but re-state the boundary in the task.
- **Say what to return.** Ask for a *distilled* result: recorded inventory + a short list of proposed hypotheses (for recon), or a verdict + evidence path (for verify). Not a transcript.
- **Point it at the workspace.** The child should `record` inventory/hypotheses directly to the shared workspace and save raw output to `evidence/` — so results are durable, not just in its reply.

Example task prompts:
```
spawn role=investigate task="Enumerate services on 10.10.20.7 (in scope: 10.10.20.0/24). Record hosts/services/tech to inventory, save raw scans to evidence/. Return only: open services + 3-5 proposed hypotheses with checklist classes. Do not exploit."
```
```
spawn role=verify task="Try to REFUTE hypothesis y7: 'GET /api/user?id= is IDOR-able'. Reproduce with two accounts, capture request/response to evidence/. Return confirmed|refuted|inconclusive with the evidence path. Do not record a finding — report the verdict."
```

## 3. What to do with the result
- Read the child's **distilled** return, not its internal steps. Trust the workspace it wrote (`recall inventory` / `recall hypotheses`) over prose.
- On a `verify` verdict: `confirmed` → promote to a finding yourself (see `ops-finding-writeup`) and mark the hypothesis; `refuted`/`inconclusive` → update the hypothesis outcome (retained, no re-test).
- If the child hit a wall needing the operator, it should have parked a `blocker` — pick it up via `recall blockers` and route around it.

## 4. Invariants & limits (don't fight them)
Harness-owned in `enforce` mode (PLAN.md §11):
- **Depth 1** — sub-agents cannot spawn sub-agents. Don't design multi-level plans.
- **Caps** — a few per turn, a bounded number per engagement, plus a per-child token ceiling. Spend delegation where isolation/verification pays off, not on trivial tasks.
- **Scope + auth are inherited** — a child cannot exceed the engagement's scope or authorization; it is not a way around the gate.
- **Sequential, not parallel** — locally one GPU serves serially, so delegation buys cleanliness and rigor, not speed. Don't fan out expecting concurrency.

## 5. The payoff
- Parent context stays small → weak models don't drown and compaction keeps scope/findings.
- A second skeptical pass kills false positives before they reach the report.
- Distilled inventory/verdicts flow back into the same `record`/`recall` loop, so the engagement state stays single-source-of-truth.
