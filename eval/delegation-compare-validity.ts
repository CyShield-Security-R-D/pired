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
const LIMIT_EFFECTS: ReadonlyArray<{ pattern: RegExp; kind?: "call" | "file" }> = [
	{ pattern: /^timed out at \d+ ms$/ },
	// Only the statuses the runner's own stop leaves: pi's exit on SIGTERM (143),
	// the SIGKILL that follows it (137), or the signal itself.
	{ pattern: /^process failed with exit=(143|137) signal=\S+$/ },
	{ pattern: /^process failed with exit=\S+ signal=(SIGTERM|SIGKILL)$/ },
	{ pattern: /^parent did not finish with an assistant stopReason=stop$/ },
	{ pattern: /^final assistant reply ended with \S+, not stop$/ },
	{ pattern: /^subagent call \S+ never ended$/, kind: "call" },
	{ pattern: /^session file (.+) is claimed by no subagent call$/, kind: "file" },
];

/** A run silent this long before the deadline was not working at the limit: it hung. */
export const STALL_SECONDS = 30 * 60;

export const stalledReason = (idleSeconds: number): string => `stalled: silent ${Math.floor(idleSeconds / 60)} min before the limit`;

export interface RunFacts {
	/** The grid's pinned policy; absent, today's rules. */
	policy?: ValidityPolicy;
	/** The runner stopped the run at the run limit. */
	timedOut: boolean;
	/** The ledger held no finding and no hypothesis, under FAST_EMPTY_SECONDS. */
	fastEmpty: boolean;
	/** Every error the harness collected, de-duplicated, the limit's and the fast-empty one included. */
	errors: readonly string[];
	/** Workers still running at the limit whose sessions were counted (`inFlightWorkers`). */
	inFlightWorkers?: readonly InFlightWorker[];
	/** Why a fast empty run is not the model's own choice (`fastEmptyBlockers`); [] or absent when nothing stood in its way. */
	fastEmptyBlockers?: readonly string[];
	/** Seconds between the run's last activity (transcript line or worker session write) and the deadline; only on a run stopped at the limit. */
	idleAtLimitSeconds?: number;
}

/** What the v6 policy records beside `valid`; a grid without a policy writes none of it. */
export interface ValidityFlags {
	/** Stopped at the limit while still working; a stalled run is not one. */
	reachedLimit: boolean;
	/** A fast empty run the policy kept valid; false when something stood in the model's way. */
	fastEmpty: boolean;
	/** The errors the stop at the limit caused, kept out of `errors`. */
	limitEffects: string[];
	/** A worker was cut off in flight: the tokens count what its session holds, so they are a lower bound. */
	tokensLowerBound: boolean;
	/** Those workers whose sessions were counted, with their largest completed reply; [] when none had written one. */
	inFlightWorkers: Array<Omit<InFlightWorker, "file">>;
	/** Silent more than STALL_SECONDS before the deadline: infrastructure, not a limit run. */
	stalled: boolean;
	idleAtLimitSeconds: number | null;
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
	const idle = facts.timedOut && facts.idleAtLimitSeconds !== undefined ? facts.idleAtLimitSeconds : null;
	const stalled = idle !== null && idle > STALL_SECONDS;
	// A run that hung is not a run that worked to the limit: nothing is waived,
	// and inspectRun classes it as infrastructure.
	if (stalled) {
		const kept = [...errors, stalledReason(idle)];
		return { valid: false, errors: kept, flags: { reachedLimit: false, fastEmpty: false, limitEffects: [], tokensLowerBound: false, inFlightWorkers: [], stalled: true, idleAtLimitSeconds: idle } };
	}
	const blockers = facts.fastEmptyBlockers ?? [];
	const fastEmpty = facts.fastEmpty && blockers.length === 0;
	const counted = new Set((facts.inFlightWorkers ?? []).map((w) => w.file));
	const callInFlight = facts.timedOut && errors.some((e) => LIMIT_EFFECTS.some((x) => x.kind === "call" && x.pattern.test(e)));
	const limitEffects: string[] = [];
	const kept = errors.filter((error) => {
		if (fastEmpty && error === FAST_EMPTY_ERROR) return false;
		if (!facts.timedOut) return true;
		const effect = LIMIT_EFFECTS.find((e) => e.pattern.test(error));
		if (!effect) return true;
		// An unclaimed session is the stop's only when a call was still out and
		// its session was counted; any other is a file nothing accounts for.
		if (effect.kind === "file" && !(callInFlight && counted.has(effect.pattern.exec(error)![1]!))) return true;
		limitEffects.push(error);
		return false;
	});
	if (facts.fastEmpty && !fastEmpty) kept.push(...blockers.map((b) => `fast empty run not kept: ${b}`));
	return {
		valid: kept.length === 0, errors: kept,
		flags: {
			reachedLimit: facts.timedOut, fastEmpty, limitEffects, tokensLowerBound: callInFlight,
			inFlightWorkers: callInFlight ? (facts.inFlightWorkers ?? []).map(({ key, replies, largestReply }) => ({ key, replies, largestReply })) : [],
			stalled: false, idleAtLimitSeconds: idle,
		},
	};
}

/** A tool result as the fast-empty check reads it, from the parent's transcript or a worker's session. */
export interface ToolResult { side: "parent" | "worker"; tool: string; isError: boolean; text: string }

/** pired's own tools: an error from one means the ledger refused the model, not that the model chose to stop. */
const PIRED_TOOL = /^(record|recall|pired\b|pired_)/;
/**
 * The texts a blocked call's result carries: pi writes the gate's reason (or
 * "Tool execution was blocked") as an error result. These are the scope gate's
 * (core/scope.ts) and the worker gate's (core/child.ts) reasons.
 */
const GATE_BLOCK = /^(Tool execution was blocked|Out-of-scope target\(s\):|Subagent launch|Subagent management action|Delegation is disabled|Only pired workers may be launched|A worker's cwd must be|A pired worker launched from this session|Engagement is not marked authorized|pired workers |pired worker is not armed|pired: )/;
/** What the Landlock seal's refusal looks like from inside a tool. */
const SEAL_DENIAL = /EACCES|EPERM|Permission denied|Operation not permitted/;

/**
 * Why a fast empty run may not be the model's own choice: the harness may have
 * kept it from working. Kept valid only when pired's workspace exists for the
 * cell's engagement (engagementTelemetry reads a missing one as zeros), no
 * pired tool or gate refused a call, and no tool met the seal. Empty when
 * nothing stood in its way.
 */
export function fastEmptyBlockers(input: { manifest: string | undefined; engagement: string; results: readonly ToolResult[] }): string[] {
	const out: string[] = [];
	if (input.manifest === undefined) out.push("pired's manifest.json is missing from the workspace");
	else {
		let parsed: unknown;
		try { parsed = JSON.parse(input.manifest); } catch { parsed = undefined; }
		const engagement = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).engagement : undefined;
		if (engagement === undefined) out.push("pired's manifest.json is unreadable or names no engagement");
		else if (engagement !== input.engagement) out.push(`pired's manifest.json names engagement ${String(engagement)}, not ${input.engagement}`);
	}
	const line = (text: string): string => text.split("\n")[0]!.slice(0, 200);
	for (const r of input.results) {
		if (r.isError && PIRED_TOOL.test(r.tool)) out.push(`${r.side} ${r.tool} call failed: ${line(r.text)}`);
		else if (r.isError && GATE_BLOCK.test(r.text)) out.push(`${r.side} ${r.tool} call was blocked: ${line(r.text)}`);
		if (SEAL_DENIAL.test(r.text)) out.push(`${r.side} ${r.tool} call met a seal denial: ${line(r.text.slice(Math.max(0, r.text.search(SEAL_DENIAL) - 80)))}`);
	}
	return [...new Set(out)];
}

/** The parent's tool results, from the transcript's `tool_execution_end` events. */
export function parentToolResults(events: ReadonlyArray<Record<string, unknown>>): ToolResult[] {
	return events.filter((e) => e.type === "tool_execution_end").map((e) => {
		const result = e.result && typeof e.result === "object" ? e.result as Record<string, unknown> : {};
		const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
		return { side: "parent" as const, tool: String(e.toolName ?? ""), isError: e.isError === true, text: content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("\n") };
	});
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
		"caused (the timeout, exit 143/137 or SIGTERM/SIGKILL, a parent reply or a subagent call cut " +
		"off in flight, and that call's counted session) are listed as limitEffects. When a worker was " +
		"still running at the limit its spend is in no tool result, so the replies its session file " +
		"holds are counted instead, and the run's tokens are a lower bound, flagged " +
		"tokensLowerBound:true with the workers' keys and largest replies (inFlightWorkers). A run " +
		"silent (no transcript line, no worker session write) for more than 30 minutes before the " +
		"deadline is not a limit run: it is flagged stalled:true and is infrastructure, re-run under " +
		"the attempt ceiling. A fast empty run (no findings or hypotheses under 120 seconds) is valid " +
		"with zero findings, flagged fastEmpty:true, only when pired's manifest is in the workspace for " +
		"the cell's engagement, no pired tool or gate refused a call, and no tool met a seal denial; " +
		"otherwise it stays invalid with the reason. Every scored run's first-request tools are checked " +
		"as the probe's are. Every other invalid reason (a leak, a tool-surface error, a runtime or pin " +
		"mismatch, harness bookkeeping, a scorer or grader failure, a launch error) stays invalid, and " +
		"on an official grid still trips the breaker at once. The resume policy's other rules are " +
		"unchanged.",
};

/** A worker still running when the run was stopped at the limit, as its session file shows it. */
export interface InFlightWorker { key: string; file: string; replies: number; largestReply: number }

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
	/** Provider failures of those workers, for the infrastructure classifier as a finished worker's are. */
	providerErrors: Array<{ childKey: string; text: string }>;
} {
	const out = { workers: [] as InFlightWorker[], observations: [] as UsageObservation[], errors: [] as string[], notes: [] as string[], retries: [] as RetriedAttempt[], providerErrors: [] as Array<{ childKey: string; text: string }> };
	for (const file of files) {
		if (!file.endsWith("/session.jsonl")) continue;
		const key = file.slice(0, -"/session.jsonl".length);
		const session = observationsFromChildSession(read(file), key, options);
		const who = `child ${key} (in flight at the limit)`;
		// A worker stopped during a retry's backoff: the failed attempt is already
		// in its retries with an estimate, and the retry never ran because the run
		// was stopped, not because the provider gave up. Noted, and its unaccounted
		// placeholder dropped, so it neither fails the run nor voids its usage.
		const last = session.providerErrors.length;
		const backoff = last > 0 && /; pi's retry of it never ran$/.test(session.providerErrors[last - 1]!) ? `${key}/unaccounted:${last}` : undefined;
		const providerErrors = backoff ? session.providerErrors.slice(0, -1) : session.providerErrors;
		if (backoff) out.notes.push(`${session.providerErrors[last - 1]!} (stopped at the limit during the backoff; its retry estimate is counted)`);
		out.observations.push(...session.observations.filter((o) => o.id !== backoff));
		// The session ends on the reply before the one the stop cut off: that is
		// the stop's doing, and is noted; every other session error stands.
		// A worker stopped before its first reply completed has none in its file.
		const cutOff = session.turns === 0 ? `child ${key}: no assistant reply in the session`
			: session.ending === "cut-off" ? `child ${key}: final assistant reply ended with ${String(session.finalStop)}, not stop or length` : undefined;
		for (const error of session.errors) (error === cutOff ? out.notes : out.errors).push(error);
		out.errors.push(...providerErrors);
		out.providerErrors.push(...providerErrors.map((text) => ({ childKey: key, text })));
		out.notes.push(...session.notes, `${who}: ${session.turns} completed repl${session.turns === 1 ? "y" : "ies"} counted from its session; the reply in flight is not, so the run's tokens are a lower bound`);
		out.retries.push(...session.retries ?? []);
		for (const model of session.models) if (model !== expect.model) out.errors.push(`${who}: replies came from ${model}, not ${expect.model}`);
		for (const level of new Set(session.thinkingLevels)) if (level !== expect.thinking) out.errors.push(`${who}: ran thinking ${level}, not ${expect.thinking}`);
		const largestReply = session.observations.filter((o) => o.id !== backoff).reduce((max, o) => Math.max(max, Number(o.usage?.totalTokens ?? 0)), 0);
		out.workers.push({ key, file, replies: session.turns, largestReply });
	}
	return out;
}
