# Results

*DVBank static vulnerability-detection benchmark — three arms, one target, one grader.*

## 1. Models under test

| Arm | Harness | Model | Served via | Price (in / out per 1M tokens) |
|-----|---------|-------|------------|-------------------------------|
| **A** | pired (security layer on pi) | **`qwen/qwen3.8-27b`** | OpenRouter (Parasail) | $0.40 / $3.00 |
| **B** | OpenAI Codex CLI v0.147.0 | **`openai/gpt-5.6-sol`** | Codex | $2.00 / $10.00 |
| **C** | vanilla pi (provider-only shim) | **`qwen/qwen3.8-27b`** | OpenRouter (Parasail) | $0.40 / $3.00 |

## 2. Headline scores

| Metric | **A · pired + qwen3.8-27b** | **B · codex / gpt-5.6-sol** | **C · vanilla pi + qwen3.8-27b** |
|--------|:--:|:--:|:--:|
| Findings emitted | 62 | 45 | 55 |
| True positives (of 53) | **39** | 36 | 31 |
| False negatives | 14 | 17 | 22 |
| False positives | 23 | **9** | 24 |
| **Precision** | 0.629 | **0.800** | 0.564 |
| **Recall** | **0.736** | 0.679 | 0.585 |
| **F1** | 0.678 | **0.735** | 0.574 |
| Decoy false positives | **0 / 6** | **0 / 6** | **0 / 6** |

Recall by severity:

| Severity | A · pired+qwen | B · codex | C · vanilla+qwen |
|----------|:--:|:--:|:--:|
| **Critical** | **100%** | 93% | 79% |
| High | 67% | 63% | 63% |
| Medium | 67% | 56% | 33% |
| Low | 33% | 33% | 0% |

Every arm had **perfect decoy discipline** (0/6 traps tripped) — none of the three
was fooled by the safe-but-suspicious files.

## 3. The harness effect (A vs C — same model, ± pired)

This is the most important comparison in the study: **identical model
(`qwen3.8-27b`), identical target and prompt, the only difference being the pired
security layer.**

| | vanilla pi + qwen | **pired + qwen** | delta |
|---|:--:|:--:|:--:|
| Recall | 0.585 | **0.736** | **+0.151 (+26%)** |
| F1 | 0.574 | **0.678** | **+0.104 (+18%)** |
| True positives | 31 | **39** | **+8** |
| Critical recall | 79% | **100%** | **+21 pts** |

pired caught **10 vulnerabilities that vanilla pi missed on the same model**, while
vanilla caught only 2 that pired missed. The 10 pired unlocked include:

- **3 critical code-injection bugs** (`eval`/`exec`/compiled-`format` sinks) —
  `code-injection-calculate`, `code-injection-format-data`, `code-injection-run-script`.
- **All 4 cryptographic failures** — vanilla qwen found **0/4**, pired found **4/4**
  (MD5 password hashes, MD5/SHA-1 token/integrity hashes, SSN/PII exposure).
- `unrestricted-file-upload`, `insecure-session-cookie`, `log-injection-audit`.

The OWASP breakdown shows exactly where the pired system prompt steers attention:

| OWASP 2021 | A · pired | B · codex | C · vanilla | note |
|------------|:--:|:--:|:--:|------|
| A01 Broken Access Control | 7/12 | 8/12 | 7/12 | codex slightly ahead |
| **A02 Cryptographic Failures** | **4/4** | 1/4 | **0/4** | **pired dominates; vanilla found none** |
| A03 Injection | 13/14 | 13/14 | 10/14 | pired/codex tie; harness +3 over vanilla |
| A04 Insecure Design | 1/3 | 0/3 | 0/3 | only pired scored |
| A05 Security Misconfig | 6/9 | 7/9 | 6/9 | codex slightly ahead |
| A06 Vulnerable Components | 0/1 | 0/1 | 0/1 | all missed |
| A07 Auth Failures | 2/4 | 2/4 | 3/4 | vanilla oddly ahead by 1 |
| A08 Data Integrity | 3/3 | 3/3 | 3/3 | all perfect |
| A09 Logging Failures | 1/1 | 0/1 | 0/1 | only pired scored |
| A10 SSRF | 2/2 | 2/2 | 2/2 | all perfect |

**Interpretation:** the security-operator system prompt (which explicitly primes for
injection sinks, weak crypto/secrets, auth bypass, SSRF, deserialization) plus the
record/recall "don't stop while gaps remain" workflow is what converts a general
27B coding model into a materially stronger security reviewer — most visibly on
**cryptographic failures and code injection**, the categories a generic prompt
under-weights.

## 4. pired + qwen vs codex (A vs B)

| | pired + qwen | codex / gpt-5.6-sol | winner |
|---|:--:|:--:|:--:|
| Recall | **0.736** | 0.679 | pired (+0.057) |
| Precision | 0.629 | **0.800** | codex (+0.171) |
| F1 | 0.678 | **0.735** | codex (+0.057) |
| Critical recall | **100%** | 93% | pired |

Head-to-head on the 53 truth vulns: **32 caught by both, 7 only by pired+qwen, 4
only by codex, 10 by neither.** codex missed one **critical** — `broken-access-split-bill`
(an IDOR at `transaction_routes.py:203` that debits an arbitrary account); pired
caught it.

**Two different profiles:** pired+qwen is the stronger *detector* (higher recall,
all criticals, but noisier — 23 false positives); codex is the stronger *balanced
reviewer* (far fewer false positives → higher precision and F1). Which is "better"
depends on whether a missed vulnerability or a wasted-triage false positive costs
you more.

## 5. The hard tail — missed by all three

Nine vulnerabilities defeated every arm, clustering in **business-logic and
design-level** classes that pure static pattern-matching struggles with:
`biz-logic-negative-amount`, `race-double-spend`, `csrf-quickpay`,
`host-header-reset-poisoning`, `predictable-reset-token` (caught only by vanilla),
`insecure-temp-file`, `stored-xss-upload-serve`, `broken-access-list-users`,
`broken-access-delete-user`, `vulnerable-dependencies`. These are the frontier for
all three configurations.

## 5b. Contamination resistance (mutated variant)

To rule out memorization of public DVBank, we re-ran **pired + qwen3.8-27b** against
the **mutated** variant — the same vulnerabilities relocated by renamed
routes/functions, shifted line numbers, and changed literals — graded with the
manifest remap. If the earlier score were memorization, mutation would collapse it.

| pired + qwen3.8-27b | True positives | Precision | Recall | F1 | Critical recall |
|---|:--:|:--:|:--:|:--:|:--:|
| Clean variant | 39 | 0.629 | **0.736** | 0.678 | 100% |
| **Mutated variant** | 39 | 0.661 | **0.736** | **0.696** | 100% |

**Recall is identical (0.736, the same 39 true positives); critical recall stays
100%; F1 is marginally higher on mutated (fewer false positives).** The score did not
move. This is strong evidence that the detection is *genuine capability, not recall
of the public benchmark* — and it validates the whole comparison against a
memorization confound. (Run audited clean: 0 answer-key/manifest references.)

## 6. Cost (exact token accounting)

Per-token rates: `gpt-5.6-sol` costs **5× (input) / 3.3× (output)** what
`qwen3.8-27b` costs. But per-token price is not the whole story — **turn count**
dominates, because each agent turn re-sends the growing context.

Exact figures for the qwen arms come from the OpenRouter request logs; codex is its
CLI-reported total priced at list rate.

| | Turns | Input tok (billed) | Output tok | Total tok | **Cost / scan** | Cost / real vuln |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| **pired + `qwen3.8-27b`** | 17 | 485,130 | 13,664 | 498,794 | **$0.262** *(exact)* | 0.67¢ |
| **codex / `gpt-5.6-sol`** | — | — | — | 55,272 *(CLI)* | ~$0.19 *(est.)* | 0.53¢ |
| **vanilla pi + `qwen3.8-27b`** | 16 | 401,513 | 11,992 | 413,505 | **$0.158** *(exact)* | 0.51¢ |

**The "local model is far cheaper" claim is only half true.** Per token qwen is
5×/3.3× cheaper, but pired's **17-turn** record/recall workflow re-sends context ~17
times (485k billed input tokens), so its **total scan cost ($0.26) is slightly
*higher* than codex (~$0.19)**, and its **cost per real vulnerability (0.67¢) is a
touch above codex's (0.53¢)**. The leaner vanilla-qwen run ($0.16) is the cheapest
per scan. In short: **pired trades tokens (more turns) for coverage** — it buys +26%
recall and 100% critical coverage at roughly codex-level cost, not at a discount.

> **Notes.** (1) The qwen costs are *exact* (OpenRouter per-request logs); codex's
> dollar figure is *estimated* at list price (its plan is a subscription) and its
> 55k count almost certainly benefits from OpenAI prompt-caching that the
> qwen/Parasail path did not get — so the raw token gap (499k vs 55k) overstates any
> efficiency difference; compare on **cost**, not raw tokens. (2) Precision is a
> conservative lower bound for every arm (non-keyed findings all count against it).

*Raw per-arm findings and grader reports: see [`data/`](./data/). Consolidated
3-way analysis: [`data/analysis.3way.json`](./data/analysis.3way.json).*
