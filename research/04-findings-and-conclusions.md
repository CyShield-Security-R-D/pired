# Findings & Conclusions

*What this research established about pired, local models, and security agents.*

## 1. The central finding: the harness is worth more than the model (for recall)

On identical inputs, wrapping a **27B open-weight model** (`qwen3.8-27b`) in the
**pired security layer** moved it from **F1 0.574 → 0.678** and **recall
0.585 → 0.736** — and pushed it *past* a frontier agent (`gpt-5.6-sol` via codex,
recall 0.679) on recall and on critical coverage (100% vs 93%).

Quantitatively, the pired harness closed **~65% of the F1 gap** between the bare
local model and the frontier agent, and **more than 100% of the recall gap** (it
overtook). The security-operator system prompt plus the record/recall
"keep-testing-until-gaps-close" workflow — *not* a bigger model — is what did it.

> **Validated (v2).** Acting on the audit, a generic explore-first + coverage-floor + precise-capture method was added to pired's prompt. On the same model/target it lifted F1 0.678 -> 0.761 and recall 0.74 -> 0.81 (100% critical, decoys 0/6), cracking four bugs previously missed by all three arms — while *improving* the most creative category (Insecure Design 0->2). Confirmation that the harness, not the model, was the limiter. See 03 §5d. (One mechanical regression: SCA needs a deterministic seed, not a prompt line.)

**Implication:** for vulnerability *detection*, investing in the harness (prompting,
workflow, coverage discipline) is a higher-leverage, far cheaper lever than
investing in a bigger model. A good harness on a cheap local model is competitive
with a frontier agent.

## 2. Where the harness helps most

The gains concentrate in exactly the categories a generic coding prompt
under-weights:

- **Cryptographic failures (A02): 0/4 → 4/4.** Vanilla qwen found *zero* weak-hash /
  secret-exposure bugs; pired found all of them. This is the single clearest
  demonstration of prompt-driven coverage.
- **Injection (A03): 10/14 → 13/14**, including three critical `eval`/`exec`
  code-injection sinks the vanilla run walked past.
- **Insecure design (A04) and logging (A09):** only the pired arm scored at all.

The mechanism is explicit priming: pired's prompt enumerates the sink classes and
insists the agent not stop while coverage gaps remain, so the model systematically
sweeps categories a one-shot "find bugs" prompt neglects.

## 3. pired + local model vs codex: pick your error

- **pired + qwen** is the better **detector**: highest recall (0.736), **100% of
  criticals**, +3 true positives over codex — at the cost of more noise (23 false
  positives, precision 0.63).
- **codex / gpt-5.6-sol** is the better **balanced reviewer**: highest precision
  (0.80) and F1 (0.735), a third the false positives — but it missed a critical IDOR
  and has lower recall.

For an **authorized penetration test / audit**, where a *missed* critical is far
more expensive than an extra item to triage, the recall-and-criticals profile of
**pired + qwen is the more valuable one** — and it costs a fraction as much. For a
CI gate where false positives erode trust, codex's precision is attractive. The two
are complementary: a plausible production setup is **pired + a local model for broad
recall, with a higher-precision pass to rank/deduplicate.**

## 4. Cost — the harness trades tokens for coverage

Exact token accounting (from the OpenRouter logs) revised an early assumption. Per
token, `qwen3.8-27b` is 5×/3.3× cheaper than `gpt-5.6-sol` — but **turn count
dominates cost**, because each agent turn re-sends the growing context:

| | Turns | Total tokens | Cost / scan | Cost / vuln |
|---|:--:|:--:|:--:|:--:|
| pired + qwen3.8-27b | 17 | 498,794 | **$0.262** *(exact)* | 0.67¢ |
| codex / gpt-5.6-sol | — | 55,272 *(CLI)* | ~$0.19 *(est.)* | 0.53¢ |
| vanilla pi + qwen3.8-27b | 16 | 413,505 | **$0.158** *(exact)* | 0.51¢ |

So the "local model is far cheaper" story is **only half true**: pired's 17-turn
record/recall workflow re-sends context ~17×, pushing its **scan cost ($0.26)
slightly above codex's (~$0.19)** and its **cost per vulnerability (0.67¢) just above
codex's (0.53¢)**. The cheap per-token rate is real, but pired spends it on more
turns. The honest statement: **pired buys +26% recall and 100% critical coverage for
roughly codex-level cost — not at a discount.** (The lean vanilla-qwen run is the
cheapest per scan at $0.16, but with much lower recall.)

A clear efficiency lever falls out of this: pired's cost is dominated by re-sent
context across turns, so **prompt-caching the local endpoint and/or trimming the
record/recall turn count would cut its cost substantially** without touching recall.

## 5. The frontier for everyone: business logic

Nine vulnerabilities were missed by **all three** arms — negative-amount and
double-spend business-logic flaws, a double-spend race, CSRF, host-header reset
poisoning, an insecure temp file, stored-XSS-on-serve, broken-access list/delete,
and vulnerable dependencies. These are **stateful, cross-request, design-level**
issues that static, single-file pattern reasoning does not reach. This marks the
next investment for pired: coverage items and (crucially) the **agentic CTF /
dynamic-exploitation track**, where a running target lets the agent *test* business
logic rather than only read it.

## 6. What this validated about pired's design

- The **ports & adapters** split paid off operationally: the same harness ran
  headless against an isolated target with no code changes, and the security logic
  is fully unit-tested independently of the host.
- The **"AI agent, not a toolbox"** stance held up: pired shipped no scanner, yet the
  model + workflow out-recalled a frontier agent. The value was in orchestration,
  not bundled tools.
- The **record/recall engagement workflow** is not ceremony — it measurably improved
  coverage over an unstructured review of the same model.

## 7. Threats to validity (stated plainly)

- **Precision is a lower bound.** The grader counts any non-keyed finding as a false
  positive; some are defensible issues absent from the 53-item key. Applied equally,
  so comparisons are fair, but absolute precision understates all three arms.
- **One target, one run each.** DVBank is a single (if broad) application; a single
  run per arm. Results are directional, not a leaderboard. Re-running the
  contamination-resistant **mutated** variant and averaging multiple seeds would
  tighten the estimates.
- **Output-channel difference for codex.** codex could not write files in this
  environment (its `bwrap` sandbox failed), so it returned findings as its final
  message rather than `findings.json`. Identical task and schema; the analysis was
  unaffected, but it is a difference worth noting.
- **qwen cost is estimated,** not metered (see the results doc's measurement note).

## 7b. Methodology audit — blind spots (both directions)

A post-hoc audit of the artifacts found measurement biases pushing **both ways**.
None are large enough to overturn the qualitative story, but together they mean the
pired-vs-codex F1 gap is **not robust** and should not be over-read.

### The largest: frontend scope mismatch (penalized the qwen arms)

The shared prompt asked reviewers to cover `backend/` **and `frontend/`**, but the
answer key is **backend-only** — so every frontend finding is an automatic false
positive. The two qwen arms each reported **7 real frontend bugs** (`eval` of
untrusted input, DOM-XSS via `dangerouslySetInnerHTML`, `postMessage` without origin
check); **codex reported none**. Excluding out-of-labeled-scope frontend findings:

| | Recall | Precision (official → scope-normalized) | F1 (official → normalized) |
|---|:--:|:--:|:--:|
| pired + qwen | 0.736 | 0.629 → **0.709** | 0.678 → **0.722** |
| codex | 0.679 | 0.800 (unchanged) | 0.735 (unchanged) |
| vanilla + qwen | 0.585 | 0.564 → 0.646 | 0.574 → 0.614 |

**The F1 gap between pired+qwen and codex collapses from 0.057 to 0.013 — a tie —
once the arms are no longer penalized for finding real bugs the benchmark cannot
score.** codex's precision lead is *partly an artifact of it not reporting frontend*,
not sharper discrimination. (Counter-view, for honesty: one could argue codex's focus
on the labeled scope is good judgment — but the prompt explicitly requested frontend,
so the arms that complied were penalized.)

### Biases that DEFLATED pired (understated it)

- **Frontend scope mismatch** (above) — ~+0.044 F1 for pired when corrected.
- **Real-but-unkeyed / duplicate FPs.** Several pired "false positives"
  (`hardcoded-secret`, `debug-mode`, `hardcoded-credentials`) correspond to vulns
  that *are* in the key (`hardcoded-secrets-block`, `debug-mode-enabled`) but were
  matched on a sibling line — i.e. duplicate reports of *real* vulns, not false
  alarms. Precision is a lower bound, more so for the arm that emits more findings.

### Biases that INFLATED pired (overstated it)

- **Finding density × line-window matching.** pired emitted the most findings (62;
  26 on `admin_routes.py`). With a +/-3-line window and class-tolerant matching, a
  noisier arm gets more coincidental-overlap chances. The class-match requirement
  limits this, but it structurally favors the arm that sprays more findings.
- **Prompt hint-list.** The prompt enumerated the vuln classes to look for, inflating
  recall on *enumerated* classes; the ~9 vulns missed by all arms are exactly the
  non-enumerated tail (business logic, race, CSRF, host-header). The benchmark
  under-measures open-ended discovery. (Applied equally to all arms.)

### Biases that INFLATED codex (overstated it)

- **codex was never mutation-tested.** Only the pired arm got the memorization
  control (the mutated variant). codex — a frontier model, the likeliest to have
  public DVBank in its training data — was scored **only on the clean variant**, so
  its score may carry a memorization advantage that pired's mutation-validated score
  does not. This is an **asymmetric control** and the single most important fix.
- **De-leak blank-line beacon.** The clean/mutated variants preserve line numbers by
  leaving blank lines where answer-marking comments were stripped — a faint
  "something was here" signal. Affects all arms; pired's stable mutated score
  suggests limited exploitation.

### Minor / neutral

- **Single run for codex & vanilla** (the pired arm's reproducibility band is
  ~+/-0.02 F1; the others were run once).
- **codex output channel** — findings came back as a final message (its sandbox
  could not write files here). The run stopped naturally (not truncated), but a
  message has practical length limits that a file does not, which could slightly cap
  codex's finding count.
- **Basename matching** — harmless here (all target files have unique basenames).

### What we do NOT do

We deliberately **do not** replace the official numbers with the scope-normalized
ones — that would be moving the goalposts toward pired. The official table stands;
this section is the caveat around it.

### The defensible claim

Not "codex wins F1." Rather: **pired+qwen and codex are roughly F1-comparable
(~0.72 vs ~0.735 once scope-normalized); pired leads on recall and critical coverage;
codex is cleaner on raw precision; and the residual gap sits inside the combined
uncertainty of the scope mismatch, an uncontrolled memorization confound for codex,
and single-run variance.**

### Fixes for a future run (no overfitting)

1. Scope the prompt to backend-only, or add frontend ground-truth labels.
2. Run codex **and** vanilla on the mutated variant too — symmetric memorization control.
3. Report raw **and** scope-normalized precision.
4. De-duplicate findings before grading (collapse multiple hits on one sink).
5. Average 3+ runs per arm and report the band, as done for the pired arm.

## 8. One-paragraph summary

A security-tuned harness (pired) turned a cheap 27B open-weight model into a
vulnerability detector that **out-recalled a frontier coding agent and caught 100%
of critical bugs**, at **cost per vulnerability comparable to that frontier agent** (its extra recall
comes from more turns, not from being cheaper) — while the
frontier agent remained the more precise, lower-noise reviewer. The harness, not the
model size, accounted for most of the local model's capability; the remaining
frontier for all configurations is stateful business-logic vulnerability, which
points pired toward dynamic, exploit-in-the-loop evaluation next.
