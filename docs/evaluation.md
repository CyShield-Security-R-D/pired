# Evaluation

pired makes a testable claim — that coverage discipline lifts recall more than a bigger model does — so it carries the instrument to check it, and to say which parts of the claim the evidence actually reaches.

Three layers, answering different questions:

| | Asks | Cost |
|---|---|---|
| **Assay** (`eval/`) | Does the harness still hold its own rules? | < 100 ms, in CI |
| **Field** (`eval/field/`) | Does the challenge keep true findings and break false ones? | < 1 s, loopback only |
| **The benchmark** (`research/`) | Does the harness find more real bugs? | A full scan per arm |

## Assay — the harness's own tests

```bash
npm run assay
npm run check     # tsc + unit tests + assay
```

Scripted scenarios with deterministic assertions against `core/`'s pure functions and the in-memory fakes. No model, no network, no target repo — which is what lets it sit in CI beside the unit tests rather than in a nightly job nobody reads.

| Family | Asks |
|---|---|
| `scope` | Does the gate hold against direct, content-injected, ambiguous, and unauthorized targets — *and* does in-scope work still run? |
| `router` | Does `selectNext` keep returning workable cells as blocker density rises, without ever handing back blocked work? |
| `coverage` | Can the denominator every other metric is expressed in drift silently? |
| `continuity` | Does a cold restart over the same directory reconstruct the engagement exactly? |
| `ledger` | Does claimed evidence resolve — and does the detector still catch planted defects? |
| `grader` | Does the scorer classify every outcome correctly, and does key validation refuse assertions dressed as ground truth? |

### Three disciplines

**Positive controls.** Every detector probe plants defects it must catch. A detector that has silently stopped detecting anything otherwise passes forever.

**Known limits, pinned.** `core/scope.ts` states plainly that the gate is accident-prevention, not a sandbox. Those cases are marked `limit` and reported as `known-limit` rather than failing the build — but if the behaviour ever *changes*, in either direction, the case flips to a hard result. The documented boundary stays where it is documented, or the suite says so.

**Benign work is measured too.** `scope.false_blocks` counts in-scope work the gate refused, ratcheted to 0 alongside `scope.violations`. A gate that passes by blocking everything has failed differently.

### The ratchet

`eval/ratchet.json` holds a floor per metric. A change that regresses one fails the suite even when no individual case flipped. Floors move only via `npm run assay -- --update-ratchet`, which can **only tighten** — lowering a floor means editing the file and writing down why.

### Mutation testing

A suite that cannot fail is not testing anything, so Assay is mutation-tested: break a rule in `core/`, confirm it goes red, revert.

Thirteen mutations are known to be caught — six in `core/` (dropping the scope exclusion by host and by URL, removing the domain boundary check, returning blocked work from the router, dropping the evidence-path traversal guard, breaking last-write-wins, ignoring `appliesTo`) and seven in the grader. Two of the `core/` cases exist *because* mutation testing found the suite missing them.

The grader is mutation-tested hardest on purpose: every headline number flows through it, so a misclassification there is wrong in a way no individual result looks wrong.

## Field — the verification instrument

```bash
npm run assay:field
```

Assay and the benchmark are both about *discovery*: whether the harness holds its rules, and whether it finds bugs. Neither can say anything about whether a finding it produced is real, and until Field there was nothing in this repository that could — every corpus here is `review`, and `eval/forge` states in its own header that it is a plumbing fixture rather than a capability benchmark.

Field is a live target on an ephemeral loopback port, built to measure **verification, not discovery**. It says nothing about whether pired can find bugs.

### The matched pair

Every real bug in the target has a decoy beside it that produces the *same observation on the wire* and is correct behaviour.

| pair | the real bug | the decoy that looks identical |
|---|---|---|
| access control | `/api/notes/1` — ownership never checked | `/api/reports/1` — an internal dashboard every employee may read |
| sharing | — | `/api/docs/1` — cross-user access from a share grant |
| public | — | `/api/pages/1` — public by design; the no-credentials control *succeeds* |
| admin | `/internal/metrics` — user list, no session | `/admin` — a catch-all route that returns 200 for every path |
| xss | `/search` — reflected into HTML unencoded | `/api/echo` — reflected into JSON, never executes |
| injection | `/api/items` — the payload changes the predicate | `/api/sort` — a 500 on a quote, identical for every payload |

A harness cannot score well here by being suspicious, and cannot score well by being permissive. The only way through is the control that separates the pair.

### The key executes, and audits itself

Every other key in this repository is a list somebody wrote down. Field's runs. Each claim carries a `naive` probe — the observation that makes a reviewer write the finding, which must fire for **decoys as much as for real bugs**, because a decoy whose obvious probe already fails is a hint rather than a trap — and a `control` probe, whose answer must equal the truth.

For the pairs that no request can separate, the audit does not accept the label: it requires the twin's control to return the **same answer with the opposite truth**. That equality is an inseparability proof, and without it "entitlement" would just be a word excusing a probe nobody wrote.

### Three axes, because two have a degenerate winner

| | Asks | Failed by |
|---|---|---|
| **sensitivity** | Of the real bugs, how many survived the challenge? | refuting everything |
| **specificity** | Of the decoys, how many were not blessed? | confirming everything |
| **resolution** | How many claims were settled *correctly*? | suspecting everything |

The first version reported only the first two, and the instrument's first run showed `record-and-move-on` — suspect every claim — scoring a perfect 1.00 on both. A pass that concludes nothing asserts nothing wrong. `resolution` is what stops it winning, and it is the same discipline `scope.false_blocks` applies one layer down: a gate that passes by refusing all work has failed differently.

### What it measures today

The reference challenger runs the real contract from `core/challenge.ts` against the live target with **no model**, given the right probe and its honest result. That pins the design's own behaviour, so a later run with a model in the loop can be attributed to the agent rather than the contract.

| | sensitivity | specificity | resolution |
|---|:--:|:--:|:--:|
| **reference challenger** | **1.00** | **1.00** | 0.70 |
| confirm-everything | 1.00 | 0.00 | 0.40 |
| refute-everything | 0.00 | 1.00 | 0.60 |
| record-and-move-on | 1.00 | 1.00 | 0.00 |

No real finding destroyed and no decoy blessed. The three claims it does not settle are the ones no request settles — it parks the entitlement question with the operator instead of guessing, which is the behaviour ADR-007 is built around and the failure that put an unverified IDOR in a client's report.

### With a model in the loop

```bash
npm run assay:field-t1 -- --passes 3 --arm blind --arm spec
```

The model gets the finding, the brief `core/challenge.ts` builds for its class, credentials for the principals an engagement would hold, and one tool that reaches the target. It never sees a claim's truth, separator, trap or control — it has to work out which requests settle the claim. Its verdict then goes through `judge()` exactly as a real run would, and a downgrade is fed back in the same words `record` uses, so the agent gets the one chance to supply what was missing that the product already gives it.

Two arms, because the interesting variable is information rather than cleverness. **blind** has no target model, so the access-control pair is unanswerable and the correct behaviour is to leave it suspected. **spec** carries the actors and invariants a `model.md` would hold.

deepseek/deepseek-v4-flash-0731, three passes per arm, mean and range:

| arm | contract | sensitivity | specificity | resolution |
|---|---|---|---|---|
| blind | judged | 0.83 (0.75–1.00) | 0.89 (0.83–1.00) | 0.57 (0.40–0.80) |
| blind | raw, no contract | 0.75 (0.50–1.00) | 0.89 (0.83–1.00) | 0.73 (0.60–0.90) |
| **spec** | **judged** | **1.00** | **1.00** | 0.80 (0.70–0.90) |
| spec | raw, no contract | 1.00 | 1.00 | 0.97 (0.90–1.00) |

**The entitlement information is what separates the arms.** Given a target model the model never destroyed a real finding and never blessed a decoy across three passes. Without one it did both.

**The burden of proof does measurable work, and not enough of it.** Scoring the same passes with the contract removed drops blind sensitivity from 0.83 to 0.75: it rescued one real finding the model tried to refute with nothing behind it. Two got past it. The cost is the resolution column — 0.57 against 0.73 — which is the contract converting unsupported conclusions into `suspected`, on purpose.

### The hole this found

Blind specificity is 0.89 with the contract and 0.89 without it: **`judge()` prevented no false confirmation at all.** In two of three blind passes it confirmed `/api/reports/1` — the internal dashboard that is intended behaviour — and the entitlement it supplied reads:

> `"Established from the target model: report 1 has a single owner alice with no share/collaborator fields…"`

There is no target model in the blind arm. The model fabricated the provenance, then reasoned from the credentials blurb the harness supplies as engagement context.

`judge()` requires entitlement to be **non-empty**, not **grounded**. So the strongest guard in the design is satisfiable by an assertion, which is the original failure — an IDOR confirmed without establishing entitlement — surviving its own fix. `core/challenge.ts` already has `modelAnswersEntitlement()` for exactly this question and `judge()` does not call it; the fix is to require entitlement to cite where it came from, the way a refutation must cite `basis`, and to check that the citation resolves. That change is not made here, because changing the contract in the same commit that measures it would leave the new behaviour unmeasured.

### What it still does not measure

Whether an agent finds bugs. This is a verification instrument end to end: every claim is handed to it already written.


## The benchmark

A controlled, three-arm comparison on a ground-truth-labeled vulnerable banking application — 53 CWE/OWASP-tagged vulnerabilities, deterministic grader. Same target, same prompt, same grader; the only variable is harness + model.

| Arm | Harness | Model |
|---|---|---|
| **A** | pired | `qwen/qwen3.8-27b` |
| **B** | OpenAI Codex CLI | `openai/gpt-5.6-sol` |
| **C** | vanilla pi (provider shim only) | `qwen/qwen3.8-27b` |

Arm C is the one that matters: same model as A, without pired. The gap between them *is* the harness effect.

| | Recall | Precision | F1 | Critical |
|---|:--:|:--:|:--:|:--:|
| **A · pired + qwen3.8-27b** | **0.74** <sub>[0.70, 0.79]</sub> | 0.65 | 0.69 | **100%** |
| B · codex + gpt-5.6-sol | 0.68 | **0.80** | **0.74** | 93% |
| C · vanilla pi + qwen3.8-27b | 0.59 | 0.56 | 0.57 | 79% |

Arm A is n=5 with a 95% interval, from a re-run that reproduced the original single-run figures; B and C are single runs.

### What the benchmark establishes

**A security-tuned prompt beats a bigger model** on this task: the same 27B model went from F1 0.57 to 0.69 and from 79% to 100% critical recall, ahead of a frontier agent on recall and critical coverage.

**The result is not memorization.** Against a mutated variant — renamed routes, shifted line numbers, changed literals — recall was identical, with 0/6 decoys.

### What the benchmark does not establish

**That `record`/`recall` caused the lift.** The re-run graded the ledger alongside the emitted report and found **0.8 records per run** against 61 findings emitted: `findings.jsonl` was absent for four of five runs, and `hypotheses.jsonl` and `inventory.jsonl` for all five. The engagement apparatus was bypassed and detection held anyway, so the defensible attribution is the prompt.

This is not evidence that the ledger is worthless — it is evidence that **this benchmark never tested it**. A one-shot detection scan is the task least likely to benefit from durable cross-session state. The experiment that would settle it is the compounding one — three arms, k sessions, persisted versus wiped ledger — and it has not been run.

A later prompt revision (*explore-first + coverage floor*) scored 0.81 recall / 0.76 F1 in a **single** run. It is not in the table above: it has not been replicated, and the contamination control was never re-run against it.

Full methodology, per-category breakdown, exact token and cost accounting, and threats to validity: **[`research/`](../research/)**.

| Document | Contents |
|---|---|
| [01 — Development](../research/01-pired-development.md) | Goals, architecture, ontology, the self-review hardening pass. |
| [02 — Methodology](../research/02-benchmark-methodology.md) | The three arms, fairness and contamination controls, the grader. |
| [03 — Results](../research/03-results.md) | Scores, the harness effect, OWASP breakdown, the hard tail. |
| [04 — Findings](../research/04-findings-and-conclusions.md) | Harness > model for recall, cost reality, the business-logic frontier. **Its §6 record/recall claim is superseded by 05.** |
| [05 — Re-run](../research/05-rerun-2026-08.md) | An independent replication at n=5 — and the ledger grading that showed the workflow was never exercised. |
| [06 — Compounding](../research/06-compounding-2026-08.md) | Persisted vs wiped ledger over k sessions: **no measurable recall benefit**, and the scoring artifact that first suggested otherwise. |
| [07 — Real-app corpus](../research/07-corpus-2026-08.md) | 17 real CVEs with maintainer patches as ground truth: recall halves versus the teaching app, and the harnesses are complementary. |
| [08 — Application corpus](../research/08-application-corpus-2026-08.md) | Why the library corpus was measuring ontology mismatch rather than the harness, and the application corpus built to replace it. |
| [09 — Misses](../research/09-misses-2026-08.md) | Every missed bug so far, per target: what it was, what the ledger shows, and what was reported instead. Engagement predicts detection; the misses all live off the request surface. |

## Two corpora, one answer key

Both corpora in `eval/corpus/` are built from real, disclosed vulnerabilities the same way, and `lib.ts` holds that derivation once so the two cannot drift:

```
real advisory id  →  real fix commit  →  checkout at sha^1
                  →  the maintainer's own diff is the answer key
                  →  history, changelogs and advisory mentions stripped
```

What differs is the target class, and that turned out to matter more than anything else about the instrument.

| | `fetch.ts` — libraries | `fetch-apps.ts` — applications |
|---|---|---|
| Selected by | package name in a registry | route density in the checkout |
| Surface | none pired can record | hosts, endpoints, params |
| Scope | whole repo (small) | largest subtree under a file cap |
| Measures | deep single-function logic bugs | review at engagement scale |

pired's coverage model is `checklist classes × recorded surface`, and its surface vocabulary is `host / service / endpoint / param / tech`. A parsing library presents none of that, and the sealed library runs recorded **zero hypotheses** — the mechanism under test never engaged. The library corpus is kept because a harness that cannot do library CVEs should say so with a number, but the application corpus is the one that measures the claim.

Both fetchers seal the agent's network themselves rather than relying on a wrapper: every target is a pre-fix commit of a public project, so the fixed release *is* the answer key, and an agent that can reach a package index can diff the answer out instead of finding it.

```bash
node eval/corpus/fetch-apps.ts --dry                 # what would be admitted, and why
node eval/corpus/fetch-apps.ts --classify <dir>      # run the admission rule against a checkout
node eval/corpus/fetch-apps.ts --limit 1 --max 5     # build
```

## Grading your own engagement

Assay can grade a real engagement workspace against an answer key, in pired's own coordinates — cell keys, not a findings list — which is what makes a false *clear* measurable at all:

```bash
npm run assay:grade -- --workspace ~/.pired/engagements/<name> --key <key.json>
```

That distinction is the point. A findings-list grader can only tell you what was found. A cell-keyed grader can tell you what was **claimed clear but was not** — the failure mode that matters most in a security engagement, and the one a recall number alone hides.

## Honesty about what is measured

Two things worth stating plainly, because the instrument is only useful if its limits are known:

- **pired is not a scanner.** It owns no detection engines and makes no claim to reproducible, rule-count-comparable output against one.
- **A benchmark is one target.** The corpus work in `eval/corpus/` exists to widen that — real applications with maintainer security patches as ground truth — and where a result has not been produced, the research says so rather than implying one.
- **A benchmark can measure the wrong thing entirely.** The library corpus produced a clean, sealed, reproducible number that was substantially about pired's ontology not fitting its targets. It took a contradiction with DVBank to notice. Coverage engagement — hypotheses recorded, cells settled — is reported alongside recall now, because a run where the mechanism never fires is a void result, not a low score.
