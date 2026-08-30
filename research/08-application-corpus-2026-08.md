# 08 · The application corpus

*August 2026*

## Why the library corpus was the wrong instrument

`research/07` reported a sealed result: on eight real library CVEs, codex found
4/8 and pired found 2/8. Taken at face value that is a two-to-one deficit against
a frontier model. Taken together with DVBank — where the same pired build scored
0.736 against codex's 0.679 — it is a contradiction, and the contradiction is the
interesting part.

The explanation is in pired's own type system:

```ts
INVENTORY_KINDS = ["host", "service", "endpoint", "param", "tech"]
```

Every noun is a network or web concept. The `code-review` checklist declares its
classes against those same kinds — `endpoint` 17 times, `param` 10, `host` 6.
There is no `file`, no `function`, no `sink`. pired's coverage model is
`checklist classes × recorded surface`, and a parsing library presents none of
that surface.

It is visible in the recorded data. Reviewing `psf/requests`, pired wrote:

```
kind=host      repo:requests (psf/requests 2.32.3, Python HTTP client library)
kind=endpoint  src/requests/sessions.py:Session.request/send/prepare_request/…
kind=endpoint  src/requests/models.py:PreparedRequest.prepare_url/…
```

A repository recorded as a host; Python modules recorded as endpoints. The agent
was shoehorning a library into a vocabulary built for a web application. And
across **every** sealed library run the ledger recorded **zero hypotheses and
zero findings** — the mechanism under test never engaged at all.

So the 0.250 is substantially a measurement of ontology mismatch. It says the
harness has no purchase on library CVEs, which is true and worth knowing, but it
does not say what it was built to say.

## The decision

Two options were on the table:

**A.** Change the target class — benchmark the harness on the work it is built
for, which is application review and web pentest.

**B.** Extend the harness into vulnerability research — new skills and agents for
library-shaped bugs.

**A was chosen.** B is much larger than it appears: skills are prompts, but the
mechanism is the inventory-by-checklist matrix. Adding VR skills without VR
inventory kinds leaves that matrix indexing on nothing, and the runs would look
exactly like the ones already recorded — zero hypotheses, a plain reviewer with a
weaker model. Real VR support means new nouns (`file`, `function`, `sink`,
`trust-boundary`), a checklist keyed to them, and a depth-first stopping rule
instead of a breadth-first one. That is a second product sharing a runtime, and
it is the wrong thing to build while the primary claim has no matching benchmark.

## Why changing targets does not make the corpus synthetic

This was the obvious objection and it deserves a direct answer.

The library corpus earned its credibility from a five-step chain, and
`eval/corpus/lib.ts` now holds that chain as **one** implementation shared by
both corpora:

```
real advisory id  →  real fix commit  →  checkout at sha^1
                  →  the maintainer's own diff is the answer key
                  →  history, changelogs and advisory mentions stripped
```

Not one of those steps depends on the repo being a library. The only thing that
made the first corpus library-shaped was its *selector*: a hand-typed list of
package names from PyPI, which is a registry of libraries.

`eval/corpus/fetch-apps.ts` changes the selector and nothing else. Every target
still traces to a public advisory ID, a public repository, and a public commit
SHA; anyone can re-derive the key with one `git diff`.

## What the application corpus adds

### 1. A classifier, so the seed list only decides where to look

The seed list names open-source projects that ship a running web application, but
it does not admit anything. Admission is re-derived from the checkout: a route
registration is the one signal a library cannot fake, so route density is the
discriminator (≥ 3 files) and templates, migrations or a server entry point are
required as corroboration.

`--classify DIR` runs that rule against a tree already on disk, which is how it
was tested against known answers:

| target | verdict | routes |
|---|---|---|
| `psf/requests` | not an application | 0 |
| `pallets/jinja2` (×2) | not an application | 0 |
| `andialbrecht/sqlparse` | not an application | 0 |
| DVBank | **application** | 4 |

The first version of that rule failed the positive control: it matched literal
variable names (`app`, `router`, `bp`) and DVBank registers its routes on
`@auth_bp.route`, `@admin_bp.route` — names the project chose. It scored 0 route
files on a web application. The patterns now match any identifier, and the HTTP
verb forms additionally require a path literal beginning with `/`, so
`config.get("key")` and `session.get("https://…")` do not turn every library that
makes a request into an "application".

### 2. A surface tier

A bug in a route handler and a bug in a crypto helper are both real, but only the
first is what an application review is scoped to find. Both are kept; each target
records `direct` or `indirect` so a run can select on it rather than blending the
two into one number.

### 3. A scope

Gitea is roughly 1.5M lines. "Find one bug in the whole repository inside a
wall-clock budget" is a lottery; "find one bug in the directory we already told
you it is in" is not a question. Scope is the **largest** directory subtree that
stays under a file cap, and the file and line counts go into the manifest so
every target states its haystack-to-needle ratio instead of assuming it.

The first implementation took the first subtree that fit, which on airflow meant
241 files against a cap of 1200 — five times smaller than the budget allows, and
narrow enough to have handed over the subsystem. Scope now widens to sibling
directories in name order until the cap is reached: the same target became 683
files and 118,006 lines.

Both arms are told about the scope in byte-identical words, from one shared
`scopeClause()`; two hand-written variants would have turned a harness comparison
into a prompt comparison.

## Two defects found while building it

**Abbreviated commit SHAs.** `git fetch origin <short-sha>` fails outright — a
remote can only serve an object named in full — and OSV does reference short
commit URLs. Those advisories were dropping out of *both* corpora silently, so
the yield looked like a property of the ecosystem rather than a bug in the
fetcher. `resolveSha()` expands them through the GitHub API at build time, which
is not the sealed part of the experiment.

**The seal was not in the runner.** During the first sealed experiment the
network blackhole was applied alongside `run.ts` rather than inside it. That is
precisely how the codex arm ran unsealed for three full passes before anyone
noticed. Both runners now carry the seal themselves, with matching `--sealed no`
escape hatches. A control that has to be remembered is not a control.

This matters more here than it did for libraries: a Gitea or Grafana advisory is
far more widely written about than a sqlparse one, so an unsealed application run
would be even more prone to retrieval than the runs that produced `research/07`'s
retracted ranking.
