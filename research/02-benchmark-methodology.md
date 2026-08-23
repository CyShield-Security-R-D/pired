# Benchmark Methodology

*How we measured whether pired + a local model competes with a frontier agent on security.*

## 1. The question

> Which **harness + model** finds more security vulnerabilities in a real codebase,
> and by how much? Specifically: can **pired + an open-weight 27B model
> (Qwen3.8 27B)** compete with **codex (a frontier coding agent + model)** — and how
> much of any difference is the *harness* versus the *model*?

To separate those two variables we ran **three arms**:

| Arm | Harness | Model | What it isolates |
|-----|---------|-------|------------------|
| **A** | pired (security layer on pi) | `qwen/qwen3.8-27b` (OpenRouter) | the full pired proposition |
| **B** | codex CLI | codex default (frontier) | a strong off-the-shelf agent |
| **C** | vanilla pi (no pired) | `qwen/qwen3.8-27b` (OpenRouter) | the base harness + same local model |

A vs C isolates the **harness effect** (same model, ± the pired security layer).
C vs B isolates the **model/agent gap** (bare local model vs frontier agent).
A vs B is the headline **pired-vs-codex** question.

## 2. The target: DVBank

We used **DVBank Lab**, an intentionally vulnerable full-stack banking application
that is *purpose-built as an AI security-evaluation benchmark*. It ships:

- **`eval/ground_truth.json`** — an answer key of **53 labeled vulnerabilities**,
  each with file, line range, CWE, OWASP 2021 category, class, and severity, with
  full OWASP Top-10 (A01–A10) coverage.
- **`eval/graders/detection_grader.py`** — a deterministic grader (precision /
  recall / F1, plus recall broken down by severity and OWASP category).
- **`eval/decoys/`** — six safe-but-suspicious files (parameterized SQL, safe
  deserializers, `md5(..., usedforsecurity=False)`, etc.) to measure over-reporting.
- **`eval/variants/clean/`** — a **de-leaked** copy of the app with answer-revealing
  comments/docstrings and the teaching `docs/`/`course/` stripped, and (critically)
  **line-preserving**, so the grader's truth line numbers still line up.

We chose the **static detection track** on the **clean variant**: it yields a fully
objective, reproducible score and directly answers "who finds more, and by how much."

## 3. Fairness controls

Everything except the harness+model was held identical:

- **Identical prompt.** Both/all arms received the *same* self-contained detection
  prompt (derived from the benchmark's own `tasks/detection.md`): review the tree,
  detection-only (no exploit, no patching), beware decoys, emit findings in the
  fixed schema. (See `data/prompt.detection.txt`.)
- **Identical output contract.** All arms emit an array conforming to
  `eval/schema/findings.schema.json` (`file` + `line`/`start_line`, optional
  `cwe`/`vuln_class`/`severity`/`message`).
- **Identical target.** Each arm reviewed a copy of the *same* de-leaked `clean/`
  tree + the six decoy files.
- **Identical grader.** One deterministic grader, `window = 3` lines, class-tolerant
  matching (`CWE-89` == `89`, `"SQL Injection"` == `sql-injection`), each truth
  entry matched at most once; a finding that omits the class fields still scores as a
  location match.

## 4. Contamination controls (no peeking at the answers)

DVBank is a public repo, so a capable agent could in principle read the answer key
or answer-revealing sources. We eliminated that structurally and then verified it:

1. **Isolated targets.** Each arm ran with its working directory set to a **fresh
   copy containing only** the de-leaked `clean/` tree + the six decoy `.py` files —
   and **nothing else**: no `ground_truth.json`, no decoy `manifest.json` (which
   labels the safe regions), no `docs/`/`course/`, no `eval/`, no `.git` history.
   An automated audit confirmed **zero** leakage files under each target.
2. **No path hints.** The prompt never mentions the answer key or the original repo,
   and the target tree contains no reference to either — so the agents have no way to
   know where the labels live.
3. **Post-hoc audit.** After each run we grepped its log for any access to
   `ground_truth` / `/eval/` / the original `DVBank` path. **All three arms: zero
   hits.** codex's read log showed it touched only target files.

We also validated the benchmark itself before running: feeding the answer key back
through the grader ("perfect oracle") scored **P / R / F1 = 1.0**, and a spot check
confirmed the de-leaked `clean/` variant is line-aligned with the truth (the JWT
`none`-algorithm sink sits exactly at its labeled lines, with the give-away comment
stripped).

## 5. Environment issues encountered (and how they were handled)

Running two different agent harnesses headless surfaced real operational friction —
documented here for reproducibility and because it did **not** affect the security
measurements:

- **codex sandbox can't write files here.** codex's `workspace-write` sandbox uses
  `bubblewrap`, which failed in this environment first on network-namespace setup
  (`bwrap: loopback: Failed RTM_NEWADDR`) and then on `setting up uid map: Permission
  denied`. codex could *read* the source fine but every *write* failed, so it could
  not produce `findings.json`. **Resolution:** run codex read-only and have it emit
  the findings JSON as its **final message** (captured via `-o`), which needs no file
  write. Identical security task and schema; only the delivery channel differs
  (disclosed). codex's analysis was unaffected.
- **pi project-trust hang.** pi prompts to trust an unknown directory; in headless
  mode with an open stdin it blocked indefinitely (8 minutes, ~0 CPU, no model
  connection) waiting for a trust answer. **Resolution:** pre-trust the target dirs
  in `~/.pi/agent/trust.json` and close stdin (`</dev/null`).
- **codex stdin hang.** `codex exec` with a prompt argument still tried to read
  stdin and blocked. **Resolution:** `</dev/null`.
- **Provider visibility for vanilla pi.** The OpenRouter/qwen model is registered by
  the pired extension, so vanilla pi couldn't see it. **Resolution:** a
  **provider-only shim** extension that registers *only* the provider (pure
  plumbing, no security features), keeping Arm C otherwise vanilla — pi's default
  agent prompt and default tools, no `record`/`recall`, no scope gate.

## 6. What the grader reports

For each arm: true/false positives, false negatives, precision, recall, F1, recall
by severity, recall by OWASP category, and (with `--decoys`) how many of the six
decoy traps were tripped. Raw per-arm findings and grader reports are in `data/`.

> **Note on precision.** The grader counts any finding not matching one of the 53
> keyed entries as a false positive. Some of those are defensible issues that simply
> aren't in the answer key, so the reported precision is a *conservative lower bound*
> for every arm — applied equally, so comparisons remain fair.
