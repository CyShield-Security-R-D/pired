/**
 * The run-validity policy a grid kind may pin (docs/adr-drafts/v6-run-validity.md).
 *
 * Without a policy a run is judged exactly as every v5 grid judged it: any
 * error the harness collected makes it invalid, a run that reached the run
 * limit ("timed out at …") and a fast empty run included. On an official grid
 * such a run blocks its pair, trips the breaker at once (ADR-031) and makes a
 * resume refuse.
 *
 * Under "v6" those two are read as what they are, the model's behaviour:
 *
 * - A run that reaches the run limit is valid and is scored on its ledger as
 *   it stood at the deadline. The ledger is durable while the run works, and
 *   the runner grades it only after the process group has closed and the
 *   cell's scope is reaped, so what is scored is what the run had recorded
 *   when it was stopped. The errors the stop itself causes (the timeout, the
 *   killed process's exit status, a parent reply or a worker call cut off in
 *   flight) are kept as `limitEffects`, not as errors. Its stop reason stays
 *   "budget" (ADR-030).
 * - A fast empty run is valid, with zero findings.
 *
 * Every other error stays an error: a leak, a tool-surface error, a runtime or
 * pin mismatch, harness bookkeeping, a scorer or grader failure, a launch
 * error. Those are the harness's integrity, not the model's behaviour, and on
 * an official grid one still trips the breaker at once.
 *
 * Excluding the two would bias the comparison against whichever arm works
 * longer or quits sooner, which is what the candidate's budget line (3.2)
 * changes: GPT-6 Luna ended about 40% of its v5 runs within five minutes.
 */

export type ValidityPolicy = "v6";
export const VALIDITY_POLICIES: readonly ValidityPolicy[] = ["v6"];

export const isValidityPolicy = (value: unknown): value is ValidityPolicy => VALIDITY_POLICIES.includes(value as ValidityPolicy);

/** A run shorter than this that recorded no finding and no hypothesis is a fast empty run. */
export const FAST_EMPTY_SECONDS = 120;
export const FAST_EMPTY_ERROR = "fast empty run (no findings or hypotheses under 120 seconds)";
export const limitError = (timeoutMs: number): string => `timed out at ${timeoutMs} ms`;

/**
 * The errors a stop at the run limit causes by itself, in the texts the
 * runner and its accounting write them:
 *
 * - the runner's own `timed out at <ms> ms`;
 * - the exit status of the process the runner stopped (pi exits 143 on SIGTERM);
 * - the parent's last reply was not a closing one, since it was cut off;
 * - a `subagent` call still running at the limit: it has no tool result, and
 *   its workers' session files are claimed by no finished call.
 *
 * The last two are the only ones that touch the token count: a worker cut off
 * in flight has spend that no tool result reports, so the run's tokens would
 * be an undercount, and they are withheld instead (`WORKER_IN_FLIGHT`).
 */
const LIMIT_EFFECTS: ReadonlyArray<{ pattern: RegExp; workerInFlight?: true }> = [
	{ pattern: /^timed out at \d+ ms$/ },
	{ pattern: /^process failed with exit=\S+ signal=\S+$/ },
	{ pattern: /^parent did not finish with an assistant stopReason=stop$/ },
	{ pattern: /^final assistant reply ended with \S+, not stop$/ },
	{ pattern: /^subagent call \S+ never ended$/, workerInFlight: true },
	{ pattern: /^session file .+ is claimed by no subagent call$/, workerInFlight: true },
];

export const WORKER_IN_FLIGHT = "tokens withheld: a worker was running at the limit, and its spend is in no tool result, so the count would be short";

export interface RunFacts {
	/** The grid's pinned policy; absent, today's rules. */
	policy?: ValidityPolicy;
	/** The runner stopped the run at the run limit. */
	timedOut: boolean;
	/** The ledger held no finding and no hypothesis, under FAST_EMPTY_SECONDS. */
	fastEmpty: boolean;
	/** Every error the harness collected, de-duplicated, the limit's and the fast-empty one included. */
	errors: readonly string[];
}

/** What the v6 policy records beside `valid`; a grid without a policy writes none of it. */
export interface ValidityFlags {
	reachedLimit: boolean;
	fastEmpty: boolean;
	/** The errors the stop at the limit caused, kept out of `errors`, plus WORKER_IN_FLIGHT when it applies. */
	limitEffects: string[];
}

export interface Validity {
	valid: boolean;
	errors: string[];
	/** Present only under a policy, so a record without one keeps its bytes. */
	flags?: ValidityFlags;
	/** Whether the run's token count may be reported: false when a worker's spend at the limit is unknown. */
	tokensCounted: boolean;
}

export function judgeRun(facts: RunFacts): Validity {
	const errors = [...facts.errors];
	if (facts.policy === undefined) return { valid: errors.length === 0, errors, tokensCounted: true };
	const limitEffects: string[] = [];
	let workerInFlight = false;
	const kept = errors.filter((error) => {
		if (facts.fastEmpty && error === FAST_EMPTY_ERROR) return false;
		if (!facts.timedOut) return true;
		const effect = LIMIT_EFFECTS.find((e) => e.pattern.test(error));
		if (!effect) return true;
		limitEffects.push(error);
		if (effect.workerInFlight) workerInFlight = true;
		return false;
	});
	if (workerInFlight) limitEffects.push(WORKER_IN_FLIGHT);
	return {
		valid: kept.length === 0, errors: kept, tokensCounted: !workerInFlight,
		flags: { reachedLimit: facts.timedOut, fastEmpty: facts.fastEmpty, limitEffects },
	};
}

/** The grader's result as inspectRun reads it. */
export type Graded = { ok: true; truePositives: number; totalFindings: number; precision: number } | { ok: false };

/**
 * A run's scored numbers. They come from the grader's reading of the ledger
 * whatever the verdict, as they always have, so a limit-reaching run is scored
 * on what it recorded by the deadline. Only a valid run whose spend is fully
 * attributed carries a token count; JSON has no NaN, so the record writes null.
 */
export function runNumbers(validity: Pick<Validity, "valid" | "tokensCounted">, graded: Graded | undefined, usage: { valid: boolean; totalTokens: number } | undefined, retryEstimate = 0): {
	truePositives: number; totalClaims: number; precision: number; totalTokens: number; totalTokensWithRetryEstimate: number;
} {
	const ok = graded?.ok === true ? graded : undefined;
	const totalTokens = validity.valid && validity.tokensCounted && usage?.valid ? usage.totalTokens : Number.NaN;
	return {
		truePositives: ok ? ok.truePositives : 0, totalClaims: ok ? ok.totalFindings : 0, precision: ok ? ok.precision : 0,
		totalTokens, totalTokensWithRetryEstimate: totalTokens + retryEstimate,
	};
}

/**
 * What a manifest pinned with a policy says about it, verbatim, beside the
 * resume policy (whose text predates the policy and describes the rules
 * without one).
 */
export const VALIDITY_POLICY_TEXT: Record<ValidityPolicy, string> = {
	v6:
		"Run validity v6: a run that reaches the run limit is valid and scored on its ledger as it " +
		"stood at the deadline, graded after its process group has closed and its scope is reaped; it " +
		"is flagged reachedLimit:true, its stop reason stays budget, and the errors the stop itself " +
		"caused (the timeout, the stopped process's exit status, a parent reply or a subagent call cut " +
		"off in flight) are listed as limitEffects. When a worker was still running at the limit its " +
		"tokens are withheld (null), since its spend is in no tool result. A fast empty run (no " +
		"findings or hypotheses under 120 seconds) is valid with zero findings, flagged fastEmpty:true. " +
		"Every other invalid reason (a leak, a tool-surface error, a runtime or pin mismatch, harness " +
		"bookkeeping, a scorer or grader failure, a launch error) stays invalid, and on an official " +
		"grid still trips the breaker at once. The resume policy's other rules are unchanged.",
};
