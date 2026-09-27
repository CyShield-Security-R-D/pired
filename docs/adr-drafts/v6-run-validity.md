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
  the stop itself causes are listed as `limitEffects` rather than `errors`, and only these: the
  timeout; exit 143 or 137, or SIGTERM or SIGKILL, which the runner's stop leaves; a parent reply
  cut off mid-turn; a `subagent` call still running; and that call's session file, only when it
  was counted (below) and a call was still out. A stray file under the session directory stays an
  error. Under the policy a waived limit no longer keeps the run from the infrastructure
  classifier, so a real provider failure in a limit run is infrastructure like any other.
- **A run that hung is not a limit run.** The runner records `idleAtLimitSeconds`, the time from the
  run's last sign of work (its last transcript line, or the last write to any worker session) to
  the deadline. A run silent for more than 30 minutes is flagged `stalled: true` and classed as
  infrastructure (`stalled: silent N min before the limit`), so the breaker re-queues its pair under
  the attempt ceiling rather than scoring a hang as work. Stalled runs are counted per arm.
- **A limit-reaching run with a worker in flight counts that worker's session, as a lower
  bound.** The worker's `subagent` call never ended, so no tool result carries its spend. Its
  session file, which reconciliation finds claimed by no call, is read instead: each completed
  reply is metered as a finished worker's is, and the same model, effort and usage checks apply.
  The reply it had in flight was never written, so the run's `totalTokens` stays a number but is a
  lower bound, flagged `tokensLowerBound: true` with each worker's key, completed replies and
  largest reply in `inFlightWorkers`. A worker stopped during a retry's backoff did not fail: the
  cancelled retry is noted and its estimate is already in the retry count. A worker's provider
  failure reaches the infrastructure classifier as a finished worker's does.
- **Under v6, a fast empty run is valid with zero findings, flagged `fastEmpty: true`, only when the
  harness let the model work.** `engagementTelemetry` reads a missing or unreadable workspace as
  zeros, so an empty ledger and a run the harness broke look alike. The run is kept only when
  pired's `manifest.json` is in the workspace for the cell's engagement, no pired tool (`record`,
  `recall`) returned an error and no call was blocked by the scope or worker gate, on the parent or
  any worker, and no tool result shows a seal denial (EACCES, EPERM, "Permission denied",
  "Operation not permitted"). Otherwise it stays invalid, with the reason beside the fast-empty
  error. Every scored cell also reports the tools its first request is offered (a
  `benchmark_tools` line), checked as the preflight probe's are, so a run with the wrong tool
  surface is invalid whether or not it was empty.
- **Every other invalid reason stays invalid,** and on an official grid still trips the breaker at
  once: a leak, a tool-surface error, a runtime or pin mismatch, harness bookkeeping (usage
  attribution, reconciliation, a malformed transcript line), a scorer or grader failure, a launch
  error. These are the harness's integrity, not the model's behaviour. The policy only removes
  errors it recognises as the stop's, and only on a run the runner stopped at the limit.
- **The counts are reported per arm.** `eval/v6-decision.ts` reports, for each arm of a
  comparison, how many paired runs reached the limit and how many ended fast and empty. They never
  decide. It also counts per arm the runs whose tokens are a lower bound and the runs that stalled.
  Rule 3 includes the lower-bound pairs, and is reported twice more, never deciding: without them,
  and with each cut-off worker's missing reply imputed at the size of its largest completed reply.
  `eval/v6-pilot-sd.ts` pairs these runs like any other and does not read the flags, since
  a per-arm count would show which arm works longer.

### Consequences

- An official v6 grid no longer stops, or refuses a resume, because a run worked to the limit or
  quit at once. Its breaker still trips at once on an integrity failure.
- A run cut off at the limit is scored on less work than it would have done with more time. That
  is the limit being part of the protocol, in both arms alike.
- A delegating arm that reaches the limit with a worker running has its cost understated by at
  most the replies in flight, one per worker cut off. Rule 3 includes those pairs, since leaving
  them out, or withholding their tokens, would make rule 3 inconclusive for the whole comparison
  the first time it happens. How much they matter is read from the excluding and imputed rows and
  the per-arm counts.
- A fast empty run that met a gate block or a seal denial stays invalid and, on an official grid,
  trips the breaker. That is deliberate: it cannot be told from a harness that kept the model out.
- A hang shorter than 30 minutes before the limit still counts as a limit run; the threshold is a
  choice, not a measurement.
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
  delegating arm's cost by whole worker sessions, which is the direction rule 3 guards against.
- **Withholding the tokens of such a run (null).** Under the pre-registration a pair with no token
  count makes rule 3 inconclusive, so one such run would leave the cost rule undecided for the whole
  comparison.
- **Keeping every fast empty run valid.** A run with no workspace, or one the seal or the gate
  refused, is empty because the harness failed, and would be scored as a model that chose to stop.
- **Treating any run at the limit as a limit run.** A run that hung an hour before the deadline
  would be scored as a run that worked for four.
- **Making the policy a global default.** The v5 grids were judged by the old rules; changing them
  under a v5 resume would make one grid run under two rules.
