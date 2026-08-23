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

## 8. One-paragraph summary

A security-tuned harness (pired) turned a cheap 27B open-weight model into a
vulnerability detector that **out-recalled a frontier coding agent and caught 100%
of critical bugs**, at **cost per vulnerability comparable to that frontier agent** (its extra recall
comes from more turns, not from being cheaper) — while the
frontier agent remained the more precise, lower-noise reviewer. The harness, not the
model size, accounted for most of the local model's capability; the remaining
frontier for all configurations is stateful business-logic vulnerability, which
points pired toward dynamic, exploit-in-the-loop evaluation next.
