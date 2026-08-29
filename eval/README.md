# Assay — pired's evaluation instrument

`npm run assay`

The **T0 tier**: scripted scenarios with deterministic assertions against `core/`'s
pure functions and the in-memory fakes. No model, no network, no target repo — the
whole suite runs in under 100ms, which is what lets it sit in CI beside the unit
tests rather than in a nightly job nobody reads.

## What it covers today

| Family | Asks |
|---|---|
| `scope` | Does the gate hold against direct, content-injected, ambiguous and unauthorized targets — *and* does in-scope work still run? |
| `router` | Does `selectNext` keep returning workable cells as blocker density rises, without ever handing back blocked work? |
| `coverage` | Can the denominator every other metric is expressed in drift silently? |
| `continuity` | Does a cold restart over the same directory reconstruct the engagement exactly? |
| `ledger` | Does claimed evidence resolve — and does the detector still catch planted defects? |
| `grader` | Does the scorer classify every outcome correctly, and does key validation refuse assertions dressed as ground truth? |

## Three disciplines

**Positive controls.** Every detector probe plants defects it must catch. A detector
that has silently stopped detecting anything otherwise passes forever.

**Known limits, pinned.** `core/scope.ts` states plainly that the gate is
accident-prevention, not a sandbox, and that indirection defeats it. Those cases are
marked `limit` and reported as `known-limit` rather than failing the build — but if
the behaviour ever *changes*, in either direction, the case flips to a hard result.
The documented boundary stays where it is documented, or the suite says so.

**Benign work is measured too.** `scope.false_blocks` counts in-scope work the gate
refused, ratcheted to 0 alongside `scope.violations`. A gate that passes by blocking
everything has failed differently.

## The ratchet

`ratchet.json` holds a floor (or ceiling) per metric. A change that regresses one
fails the suite even when no individual case flipped. Floors move only via an
explicit `npm run assay -- --update-ratchet`, which can *only tighten* — lowering a
floor means editing the file and writing down why.

## Verifying the suite itself

A suite that cannot fail is not testing anything. Mutation-test it: break a rule in
`core/`, confirm Assay goes red, revert. Thirteen mutations are known to be
caught: six in `core/` — dropping the scope exclusion (host and URL paths both),
removing the domain boundary check, returning blocked work from the router,
dropping the evidence-path traversal guard, breaking last-write-wins, ignoring
`appliesTo` — and seven in the grader itself, including misfiling a false clear,
ignoring aliases, swapping the false-clear denominator, and scoring an
`appliesTo` annotation that hides a real bug as agreement.

Two of the `core/` cases exist *because* mutation testing found the suite missing
them. The grader is mutation-tested hardest on purpose: every headline number
flows through it, so a misclassification there is wrong in a way no individual
result looks wrong.

## Flags

```
--filter <substr>    only probes whose family or name matches
--verbose            show known-limit detail, not just failures
--json               machine-readable report
--no-artifacts       skip writing eval/artifacts/<stamp>/report.json
--update-ratchet     advance floors to this run's values
```

Exit code is 1 on any failing case or ratchet breach.

## Grading a real engagement

```
npm run assay:grade -- --workspace ~/.pired/engagements/acme --key eval/fixtures/example.key.json
```

Ground truth is an **answer key in pired's own coordinates** — for each
`(element, class)` cell, what is actually true. That makes scoring a set
comparison against the agent's own ledger: deterministic, no judge model, and no
inherited ceiling from matching prose against terse CVE descriptions.

The key format enforces two disciplines at validation time:

- A `vulnerable` cell needs a `sink` or a `poc`. An unlocatable claim is not
  ground truth.
- A `clear` cell needs a `why`. Otherwise "we found nothing" quietly becomes
  "there is nothing", and the key starts scoring the harness against its own
  blind spots.

### What comes out

```
  recall              0.3333
  precision           1
  FALSE-CLEAR RATE    0.5   (of 2 cells called clear)
  dismissed rate      0.3333

  miss taxonomy
    dismissed (false clear)  1   ← rigor
    never reached            0   ← coverage
    still in flight          1   ← stopping
    blocked                  0   ← operator
    hidden by appliesTo      0   ← checklist annotation
```

**The miss taxonomy is the point.** Recall says a bug was missed; it does not say
why, and the four whys need different fixes. A cell marked `clear` that holds a
real vulnerability is a specific, attributable claim that the harness looked and
found nothing where something was — that is the false clear, and it is a rigor
failure, not a coverage one.

Two rates are reported because they answer different questions:

- **`falseClearRate`** — of everything the agent called clear, how much was wrong.
  The reliability of a `clear` claim; this is what a consultant is trusting.
- **`dismissedRate`** — of all real vulnerabilities, how many were actively
  dismissed rather than merely unreached. How much of the miss pile is rigor.

`unmatched` is reported separately: a key cell with no counterpart in the ledger
is an alignment problem, and must never masquerade as a capability gap. Cells may
carry `aliases` for honest naming differences, and `strata` labels for
per-stratum recall, the worst-stratum floor and the spread.

## Not yet built

T0 is one tier of three. Still open: the Forge generator (stage 3), the
compounding experiment (stage 4), and every model-in-the-loop probe — which
includes the **destructive-action gate**. Worth knowing: that rule currently lives
only in the system prompt. There is no mechanical gate for it the way there is for
scope, so it cannot be probed at T0 at all.
