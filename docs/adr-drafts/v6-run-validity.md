# ADR draft (v6) — A run that reaches the limit, or ends fast and empty, is a valid run of the v6 grids

**Status:** draft · 2026-09-27 · pinned as `validity: "v6"` on both v6 grid kinds in
`eval/delegation-compare.pins.json`; to be frozen with `docs/delegation-v6-preregistration.md`
("Analysis plan", *Run validity*) · amends, for grids under the policy only, the validity rules
ADR-026 inherits and the breaker's trigger in ADR-031 · built on branch `p2/validity`

### Context

- **Two of the harness's invalid reasons are the model's behaviour.** A run the runner stops at the
  run limit is recorded `timed out at <ms> ms`, and a run that records no finding and no hypothesis
  in under 120 seconds is a `fast empty run`. Both are invalid today, never infrastructure, so on an
  official grid either one blocks its pair, trips the breaker at once (ADR-031) and makes every
  later resume refuse.
- **Both are what v6 measures.** GPT-6 Luna ended about 40% of its v5 runs within five minutes
  (ADR draft 3.2), and the candidate's budget line (3.2) exists to make it work longer. The first
  held-out run to hit the 2 h limit, Luna's CasaOS pass 1 candidate, was still working with 396
  requests made and a quarter of its test cases settled (ADR-026, held-out amendment).
- **Excluding them biases the comparison.** A pair is kept only when both arms are valid. Dropping
  the runs that reached the limit drops exactly the pairs where one arm worked longest; dropping
  fast empty runs drops the pairs where one arm quit. Whichever arm does more of either loses its
  most characteristic runs from the sample, and 3.2 is designed to change both.
- **One such run would stop a multi-day grid.** At a 4 h limit and 72 pairs per stage, a single
  limit-reaching run in either arm trips the breaker and leaves the official grid unable to decide.
- The held-out amendment of ADR-026 already scored a run that hit the limit on its ledger as it
  stood at the limit, in both arms alike, by hand. This makes that rule the harness's, for the
  kinds that pin it.

### Decision

- **A kind-pinned validity policy.** A grid kind may pin `validity: "v6"`; `kindFlags` emits
  `--validity v6`, the manifest records `validity` and the policy's text as `validityPolicy`, and a
  resume under other rules is refused. A kind grid launched without the flag, or a kindless grid
  launched with it, is exploratory. Absent, every run is judged by the v5 rules and every record
  and manifest keeps its bytes.
- **Under v6, a run that reaches the run limit is valid.** It is scored by the pinned scorer on its
  ledger as it stood at the deadline: the ledger is durable while the run works, and the runner
  grades it only after the process group has closed and the cell's scope is reaped, as it always
  has. It is flagged `reachedLimit: true`, and its stop reason stays `budget` (ADR-030). The errors
  the stop itself causes are listed as `limitEffects` rather than `errors`: the timeout, the
  stopped process's exit status, a parent reply cut off mid-turn, and a `subagent` call still
  running with its workers' session files.
- **A limit-reaching run with a worker in flight carries no token count.** That worker's spend is
  in no tool result, so a count would be short, and short on the delegating arm. Its
  `totalTokens` is null, and the pre-registration's rule applies: a pair with no token count makes
  rule 3 inconclusive, not failed.
- **Under v6, a fast empty run is valid with zero findings,** flagged `fastEmpty: true`.
- **Every other invalid reason stays invalid,** and on an official grid still trips the breaker at
  once: a leak, a tool-surface error, a runtime or pin mismatch, harness bookkeeping (usage
  attribution, reconciliation, a malformed transcript line), a scorer or grader failure, a launch
  error. These are the harness's integrity, not the model's behaviour. The policy only removes
  errors it recognises as the stop's, and only on a run the runner stopped at the limit.
- **The counts are reported per arm.** `eval/v6-decision.ts` reports, for each arm of a
  comparison, how many paired runs reached the limit and how many ended fast and empty. They never
  decide. `eval/v6-pilot-sd.ts` pairs these runs like any other and does not read the flags, since
  a per-arm count would show which arm works longer.

### Consequences

- An official v6 grid no longer stops, or refuses a resume, because a run worked to the limit or
  quit at once. Its breaker still trips at once on an integrity failure.
- A run cut off at the limit is scored on less work than it would have done with more time. That
  is the limit being part of the protocol, in both arms alike.
- Rule 3 can become inconclusive when the delegating arm reaches the limit with a worker running.
  How often is measured by the counts above and by the null token counts; accounting a cut-off
  worker's session directly would remove it, and is not done here.
- A transcript line truncated by the SIGKILL that follows SIGTERM by 5 s would still invalidate the
  run. pi exits on SIGTERM after disposing its runtime, and its stdout to a pipe is synchronous on
  Linux, so this should be rare; it is left as an integrity failure rather than guessed at.

### Rejected

- **Keeping both invalid and re-running them.** A re-run of a limit-reaching pair re-draws until
  both arms finish in time, which selects the shorter runs of the arm that works longer: the same
  bias, paid for twice.
- **Classing them as infrastructure.** Infrastructure is read only from provider-originated text
  (ADR-031's classifier); a limit or an empty run is neither, and re-queuing them has the problem
  above.
- **Waiving every error on a run that reached the limit.** A leak or a wrong model in the last
  minutes of a run is as much an integrity failure as in its first. The waiver is limited to the
  texts the stop produces.
- **Counting a limit run's tokens without its in-flight workers.** It would understate the
  delegating arm's cost, which is the direction rule 3 guards against.
- **Making the policy a global default.** The v5 grids were judged by the old rules; changing them
  under a v5 resume would make one grid run under two rules.
