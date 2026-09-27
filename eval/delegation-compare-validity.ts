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
 * - A worker still running at the limit has no tool result, so its spend is
 *   read from its own session file: the replies it completed before the stop.
 *   A reply it had in flight is not in the file, so the run's tokens are a
 *   lower bound, flagged `tokensLowerBound` with the workers' keys.
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

import { observationsFromChildSession, type RetriedAttempt, type UsageObservation } from "./delegation-compare-lib.ts";

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
 * The last two mean a worker was cut off in flight: its spend is in no tool
 * result, and is counted from its session file instead (`inFlightWorkers`),
 * which makes the run's tokens a lower bound.
 */
const LIMIT_EFFECTS: ReadonlyArray<{ pattern: RegExp; workerInFlight?: true }> = [
	{ pattern: /^timed out at \d+ ms$/ },
	{ pattern: /^process failed with exit=\S+ signal=\S+$/ },
	{ pattern: /^parent did not finish with an assistant stopReason=stop$/ },
	{ pattern: /^final assistant reply ended with \S+, not stop$/ },
	{ pattern: /^subagent call \S+ never ended$/, workerInFlight: true },
	{ pattern: /^session file .+ is claimed by no subagent call$/, workerInFlight: true },
];

export interface RunFacts {
	/** The grid's pinned policy; absent, today's rules. */
	policy?: ValidityPolicy;
	/** The runner stopped the run at the run limit. */
	timedOut: boolean;
	/** The ledger held no finding and no hypothesis, under FAST_EMPTY_SECONDS. */
	fastEmpty: boolean;
	/** Every error the harness collected, de-duplicated, the limit's and the fast-empty one included. */
	errors: readonly string[];
	/** The keys of workers still running at the limit whose sessions were counted (`inFlightWorkers`). */
	inFlightWorkers?: readonly string[];
}

/** What the v6 policy records beside `valid`; a grid without a policy writes none of it. */
export interface ValidityFlags {
	reachedLimit: boolean;
	fastEmpty: boolean;
	/** The errors the stop at the limit caused, kept out of `errors`. */
	limitEffects: string[];
	/** A worker was cut off in flight: the tokens count what its session holds, so they are a lower bound. */
	tokensLowerBound: boolean;
	/** The keys of those workers whose sessions were counted; [] when none had written one. */
	inFlightWorkers: string[];
}

export interface Validity {
	valid: boolean;
	errors: string[];
	/** Present only under a policy, so a record without one keeps its bytes. */
	flags?: ValidityFlags;
}

export function judgeRun(facts: RunFacts): Validity {
	const errors = [...facts.errors];
	if (facts.policy === undefined) return { valid: errors.length === 0, errors };
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
	return {
		valid: kept.length === 0, errors: kept,
		flags: { reachedLimit: facts.timedOut, fastEmpty: facts.fastEmpty, limitEffects, tokensLowerBound: workerInFlight, inFlightWorkers: workerInFlight ? [...facts.inFlightWorkers ?? []] : [] },
	};
}

/** The grader's result as inspectRun reads it. */
export type Graded = { ok: true; truePositives: number; totalFindings: number; precision: number } | { ok: false };

/**
 * A run's scored numbers. They come from the grader's reading of the ledger
 * whatever the verdict, as they always have, so a limit-reaching run is scored
 * on what it recorded by the deadline. Only a valid run whose spend is
 * attributed carries a token count; JSON has no NaN, so the record writes null.
 */
export function runNumbers(validity: Pick<Validity, "valid">, graded: Graded | undefined, usage: { valid: boolean; totalTokens: number } | undefined, retryEstimate = 0): {
	truePositives: number; totalClaims: number; precision: number; totalTokens: number; totalTokensWithRetryEstimate: number;
} {
	const ok = graded?.ok === true ? graded : undefined;
	const totalTokens = validity.valid && usage?.valid ? usage.totalTokens : Number.NaN;
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
		"spend is in no tool result, so the replies its session file holds are counted instead, and " +
		"the run's tokens are a lower bound, flagged tokensLowerBound:true with the workers' keys " +
		"(inFlightWorkers). A fast empty run (no " +
		"findings or hypotheses under 120 seconds) is valid with zero findings, flagged fastEmpty:true. " +
		"Every other invalid reason (a leak, a tool-surface error, a runtime or pin mismatch, harness " +
		"bookkeeping, a scorer or grader failure, a launch error) stays invalid, and on an official " +
		"grid still trips the breaker at once. The resume policy's other rules are unchanged.",
};

/** A worker still running when the run was stopped at the limit, as its session file shows it. */
export interface InFlightWorker { key: string; file: string; replies: number }

/**
 * The spend of workers cut off at the limit, from their session files. Their
 * `subagent` call never ended, so no tool result names them, and the files are
 * the ones reconciliation found claimed by no call. Each completed reply is
 * metered as a finished worker's is; the reply in flight was never written, so
 * the sum is a lower bound. The checks that make a worker's tokens comparable
 * still apply: a reply from another model or at another effort is an error,
 * as are a malformed session and a provider failure, since those are the
 * harness's integrity whatever stopped the run. Only `session.jsonl` files are
 * read; anything else stays unclaimed.
 */
export function inFlightWorkers(files: readonly string[], read: (file: string) => string | undefined, expect: { model: string; thinking: string }, options: { retry?: boolean } = {}): {
	workers: InFlightWorker[]; observations: UsageObservation[]; errors: string[]; notes: string[]; retries: RetriedAttempt[];
} {
	const out = { workers: [] as InFlightWorker[], observations: [] as UsageObservation[], errors: [] as string[], notes: [] as string[], retries: [] as RetriedAttempt[] };
	for (const file of files) {
		if (!file.endsWith("/session.jsonl")) continue;
		const key = file.slice(0, -"/session.jsonl".length);
		const session = observationsFromChildSession(read(file), key, options);
		const who = `child ${key} (in flight at the limit)`;
		out.observations.push(...session.observations);
		// The session ends on the reply before the one the stop cut off: that is
		// the stop's doing, and is noted; every other session error stands.
		// A worker stopped before its first reply completed has none in its file.
		const cutOff = session.turns === 0 ? `child ${key}: no assistant reply in the session`
			: session.ending === "cut-off" ? `child ${key}: final assistant reply ended with ${String(session.finalStop)}, not stop or length` : undefined;
		for (const error of session.errors) (error === cutOff ? out.notes : out.errors).push(error);
		out.errors.push(...session.providerErrors);
		out.notes.push(...session.notes, `${who}: ${session.turns} completed repl${session.turns === 1 ? "y" : "ies"} counted from its session; the reply in flight is not, so the run's tokens are a lower bound`);
		out.retries.push(...session.retries ?? []);
		for (const model of session.models) if (model !== expect.model) out.errors.push(`${who}: replies came from ${model}, not ${expect.model}`);
		for (const level of new Set(session.thinkingLevels)) if (level !== expect.thinking) out.errors.push(`${who}: ran thinking ${level}, not ${expect.thinking}`);
		out.workers.push({ key, file, replies: session.turns });
	}
	return out;
}
