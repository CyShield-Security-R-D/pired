# ADR draft (v6) — An operator pauses a grid by draining it, not by killing it

**Status:** draft · 2026-09-28 · operational only: harness change, no pin or rule other than the
harness hash · built on branch `p2/drain` · for grids started on this harness; a grid already
running on an earlier one cannot resume on it

### Context

- **The only pause was a kill.** SIGINT/SIGTERM/SIGHUP stops new launches and terminates the arms in
  flight. Each killed arm is recorded as a runner interruption (infrastructure), and its partner as
  not launched, so `--resume` re-runs the pair at the next attempt.
- **A kill also wastes finished work.** A pair runs its two arms one after the other in one worker.
  A pair whose first arm has finished and whose second is running loses both. At concurrency 4 and
  the v6 kinds' 4 h run limit, one pause could discard up to 16 run-hours of finished GPT-6 Luna
  arms, besides what the killed arms had run.
- **Each kill spends an attempt.** An interrupted attempt counts toward the breaker's attempt
  ceiling like any infrastructure failure. A few pauses at the wrong moment could bring a healthy
  pair near abandonment.
- **The operator needs to pause.** Multi-day grids meet machine shutdowns, and some operators run
  where sending a signal is awkward.

### Decision

- **Two drain levels. Neither launches a new pair, and neither kills anything.**
  - `pairs`: SIGUSR1, or `<out>/DRAIN` reading `pairs`. Every pair in flight finishes, including
    the second arm of a pair whose first arm is running or done. No finished arm is wasted. The
    wait is up to two run limits.
  - `arms`: SIGUSR2, or `DRAIN` reading `arms`. Only the arms already running finish, and no second
    arm starts. The wait is at most one run limit. A half-done pair's second arm is recorded
    `notLaunched`, `drained: true`, not infrastructure.
  - Escalation is one-way. `arms` after `pairs` tightens the drain. `pairs` after `arms` changes
    nothing, because a second arm may already be recorded as not launched.
- **The two levels answer the trade-off in the brief.** Finishing whole pairs saves each first arm
  but can take one more run limit. Stopping at the running arms bounds the wait but wastes those
  first arms. Neither is right for every shutdown, so the operator picks. `pairs` is the documented
  default, and a DRAIN file the runner cannot read as a level drains as `pairs`.
- **The DRAIN file** is read before every launch and once a heartbeat, and removed once taken, so
  the `--resume` that follows is not drained before it launches anything.
- **A drain is not a failure.**
  - A drained arm feeds neither the breaker nor the fail-fast stop.
  - A draining runner re-queues nothing.
  - `planResume` reads a drained arm as missing, so the pair is re-run whole at the next attempt:
    the pairing rule is unchanged, and attempts are never mixed.
  - The attempt a drain left half-done is not counted toward the ceiling (`drainedAttempts` in
    `nextPairAction`), in `planResume` and in the resumed runner alike.
- **Status and exit.** `progress.json` reads `draining`, then `drained`. `summary.json` records
  `drained: true` and a `drain` block (level, trigger, `requestedAt`, `finishedAt`, pairs `left`).
  Its `stopReason` reads `drained by operator (…)`. The v6 decision code is `drained`, which
  `eval/v6-decision.ts` reads as not ready. The runner exits 0.
  - The grid reads drained only when the drain left work and nothing else stopped it. A signal or
    a stop rule still names the state, and a drain that arrives after the last launch leaves a grid
    decided as usual.
- **SIGINT/SIGTERM/SIGHUP are unchanged.** A kill during a drain wins, and a drain after a kill is
  ignored.

### Consequences

- A pause costs at most the arms the operator chose to give up. With `pairs` that is nothing, and
  no pause brings a pair nearer to being abandoned.
- The drain changes no measurement, validity rule, pairing rule or pin. Only the harness hash moves,
  so a grid started before this change must still be paused the old way.
- A drain can take up to two run limits (`pairs`) or one (`arms`). A shutdown that cannot wait that
  long still has the kill.
- Matched sessions still owed when a drain arrives are not started. The pair stays in `left`, and
  `planMatchedResume` queues them on resume, as it already did for a stopped grid.
- Node reserves SIGUSR1 to start its inspector and documents that a listener may interfere with it.
  The runner listens only while it drives a grid, and the DRAIN file needs no signal at all.

### Rejected

- **One level only.** `pairs` alone gives an operator facing a hard shutdown no bounded wait.
  `arms` alone wastes a finished first arm per half-done pair on every pause.
- **Re-running a drained half-pair at the same attempt.** It would save the attempt number without
  a discount. But if the resume's first-arm row were lost, the resume's second arm would be paired
  with the first runner's first arm, measured in another provider window. That is the mixing
  planResume forbids.
- **Keeping the first arm and running only the missing one.** It breaks the pairing rule for the
  same reason.
- **Recording a drained arm as infrastructure.** It would feed the breaker and spend an attempt.
  Nothing failed.
- **Leaving the DRAIN file in place.** The resume would read it before its first launch and drain
  at once.
