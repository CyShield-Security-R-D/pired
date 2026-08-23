---
name: recon-attack-surface
description: Use once recon inventory is collected to synthesize it — dedupe, cluster by tech, mark trust boundaries, and seed prioritized hypotheses to drive testing.
---

# Attack-surface synthesis & prioritization

Goal: turn raw inventory into a **prioritized, deduped target list** and a first set of hypotheses, so testing is systematic instead of ad-hoc. This is the bridge between recon and exploitation: you decide what to test first and let the coverage matrix (`recall gaps`) keep you honest. No new traffic is required here — it is analysis over what you already recorded.

## 0. Frame it in the loop
- Input: everything recorded by `recon-passive` / `recon-active-web` / `network-*`. Start from `recall inventory`, `recall coverage`, `recall gaps`.
- Output: a clustered target list (in `notes.md`), and `record kind=hypothesis` entries tagged with a checklist `class` for the highest-value targets.
- Coverage = checklist-classes x surface. Your job is to make sure every surface element has the *right* classes queued, then work `recall next` until `recall gaps` is empty.

## 1. Consolidate & dedupe the surface
```bash
recall inventory        # via the tool: list hosts/services/endpoints/params/tech
```
- Collapse duplicates: the same app reachable as `app.TARGET`, its IP, and a vhost is one target — keep one host record, note the aliases.
- Group endpoints by host; drop static assets (`.png/.css/.woff`) from the testable set — note them, don't queue them.
- Fill gaps in the graph: every endpoint should reference a `host`; every service a host+port. If an endpoint has no owning host recorded, add it.

## 2. Cluster by technology & shared infrastructure
Group targets so one insight applies to many:
- **By stack**: all WordPress hosts, all Spring Boot apps, all nginx+PHP, all hosts behind the same WAF/CDN. A CVE or default cred in one stack likely applies across the cluster.
- **By shared IP / netblock / vhost**: co-hosted apps share a trust and blast radius; a foothold on one may reach the others.
- **By auth model**: unauthenticated vs session vs bearer/API-key. Unauthenticated surface is tested first (highest reward, lowest friction).
- **By environment**: prod vs dev/staging/UAT. Non-prod is often weaker (debug on, default creds, no WAF) — flag it as high-priority.

Write the clusters to `notes.md` so the map persists:
```
record kind=note text="Clusters: (A) 3x Spring Boot on 10.10.20.0/24 — actuator exposed on 2; (B) WP farm behind Cloudflare; (C) dev.TARGET = staging, debug on. Priority: C > A > B."
```

## 3. Mark trust boundaries & likely-vulnerable classes
For each cluster, name where untrusted data crosses a boundary and which checklist classes that implies:
| Observation | Trust boundary | Seed these classes |
|-------------|----------------|--------------------|
| Endpoint takes an object id (`?id=`, `/users/N`) | user ↔ other users' data | `authz` (IDOR) |
| Input reflected / rendered | user ↔ browser | `xss` |
| Input reaches DB/query | user ↔ datastore | `sqli` |
| Server fetches a user-supplied URL | app ↔ internal network | `ssrf` |
| File/path param, upload | user ↔ filesystem | `path`/`lfi`, upload |
| Login / token / session cookie | anon ↔ authenticated | `auth`, session |
| Admin panel, actuator, debug | user ↔ privileged ops | authz, misconfig, `secrets` |
| Template/expression input | user ↔ server exec | `ssti`/deser |

## 4. Prioritize (impact x likelihood x effort)
Rank targets, not just bugs:
1. **Exposed high-impact** first: admin panels, auth endpoints, anything unauthenticated that mutates state or returns data.
2. **Weak-environment** clusters (dev/staging, default installs).
3. **Known-CVE stacks** (fingerprinted version with a public advisory) — quick, high-confidence.
4. Breadth-last: repetitive low-value endpoints.

## 5. Seed hypotheses for the top targets
Turn the priority list into testable hypotheses so `recall next` has real work:
```
record kind=hypothesis statement="GET /api/user?id= is IDOR-able (swap id -> other user's data)" target=e1 class=authz approach="log in as A, request B's id, compare"
record kind=hypothesis statement="dev.TARGET Spring actuator /env leaks secrets unauthenticated" target=h3 class=secrets approach="GET /actuator/env, check for credentials"
record kind=hypothesis statement="login form error-based SQLi on username" target=e4 class=sqli approach="single quote, observe error/timing"
```
Keep hypotheses concrete (a target, a class, a method to prove it). Don't over-seed — a handful of high-value hypotheses per cluster beats a hundred generic ones.

## 6. Drive coverage to completion
- `recall gaps` shows surface-element × class cells that are `not-tested` or `blocked`. Work them via `recall next`; never quit while gaps remain.
- Refuted hypotheses stay recorded (no re-test, and they document rigor). Update outcomes as you go.
- If a whole class needs operator input (e.g. authorization to run active checks), `record kind=blocker` on it — the cell goes `blocked`, and `recall next` routes you elsewhere so the engagement never stalls.
- Coverage must be **exhaustive, not sampled**: every surface element gets every applicable class queued (each `{id}`/`?id=` endpoint an `authz`/`idor` cell, each input-to-DB an `sqli` cell, etc.) — a class you never queue is a bug you can never find.
- Calibrate rather than discard: a hypothesis you probe but can't prove becomes `inconclusive` (or a `status=open` finding at low severity), retained and routed via `recall gaps` — never silently dropped. Refuted hypotheses stay recorded too, documenting rigor.
- When gaps are exhausted or all remaining cells are blocked, summarize the surface + open blockers rather than looping.

## References
- PTES — Intelligence Gathering (surface synthesis, target prioritization) — cite by name
- OWASP WSTG — Information Gathering & Threat Modeling (map trust boundaries to test classes) — cite by name
- OWASP API Security Top 10 — 2023 (clustering API surface by BOLA/BFLA/inventory) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- CWE — Common Weakness Enumeration (class → CWE mapping for seeded hypotheses) — https://cwe.mitre.org/
