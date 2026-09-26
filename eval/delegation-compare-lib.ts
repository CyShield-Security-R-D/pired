/**
 * Pure accounting and comparison rules for the isolated matched assay.
 *
 * The candidate arm delegates through pi-subagents 0.71's `subagent` tool. Each
 * child is an in-process pi session that writes its own `session.jsonl` under
 * the directory the cell pins with `defaultSessionDir`, at
 * `<runId>/run-<index>/session.jsonl`. The runner calls, per cell:
 *
 *   observationsFromPiEvents(parentEvents)                   the parent's calls
 *   reconcileSubagentCalls(parentEvents, files, { sessionDir }) which child owns which file
 *   observationsFromChildSession(text, child.childKey)       each child's calls
 *   reconcileChildSession(child, session, expect)            whether that child may be scored
 *   accountUsage([...parent.observations, ...each session.observations])
 *   summarizeRetries([...parent.retries, ...each session.retries], policy, meteredCallCount(all))  under a retry policy only
 *
 * Signatures (stable; the runner codes against them):
 *
 *   observationsFromPiEvents(events: Row[], options?: { delegationTools?: readonly string[]; retry?: boolean }): PiUsageExtraction
 *   observationsFromChildSession(sessionJsonl: string | undefined, childKey: string, options?: { retry?: boolean }): ChildSessionExtraction
 *   summarizeRetries(attempts: readonly RetriedAttempt[], policy: { maxFailedAttempts; maxFailedAttemptRate }, meteredRequests: number): RetrySummary
 *   reconcileSubagentCalls(parentEvents: Row[], childSessionFiles: string[], options?: { sessionDir?: string; toolName?: string }): SubagentReconciliation
 *   reconcileChildSession(child: SubagentChild, session: ChildSessionExtraction | undefined, expect?: { model?: string; thinking?: string }): ChildVerdict
 *   childOutcome(child: Pick<SubagentChild, "status" | "error">, session: ChildSessionExtraction): { outcome: ChildOutcome; why?: string }
 *   childRecordIds(call: ChildToolCall): string[]
 */

// pi's own rules for which failed reply it retries and which it recovers by
// compaction, so a worker's session is read the way pi decided, not guessed.
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

export interface UsageObservation {
	/** Stable session-entry ID or worker-id/turn key. */
	id: string;
	usage?: Partial<UsageTotals>;
	origin: "parent" | "worker";
	/** Pi's cost estimate for this response, when it reported one. */
	costUsd?: number;
}

/** What a pi JSON event stream says about the parent's provider calls. */
export interface PiUsageExtraction {
	observations: UsageObservation[];
	/** Structural problems: the run cannot be scored. */
	errors: string[];
	/**
	 * Provider/compaction failures: the run cannot be scored. Each one also adds
	 * an observation without usage, because the failed call's true spend is
	 * unknown, so `accountUsage` refuses the run even for a caller that reads
	 * only its verdict.
	 */
	providerErrors: string[];
	/** Informational only (recovered overflow, fallback IDs used). */
	notes: string[];
	compactions: number;
	recoveredOverflows: number;
	missingResponseIds: number;
	/** Cache-warming calls (pi 0.86+ `usage` entries), each counted as a provider call. */
	cacheWarmings: number;
	/** Delegation tool results whose usage was left to the children's own sessions. */
	delegatedResults: number;
	finalStop: boolean;
	/** Failed attempts pi retried, recovered or not; present only with the `retry` option. */
	retries?: RetriedAttempt[];
}

/**
 * One failed provider attempt pi's agent retry replaced (ADR-033). Its
 * reply stays among the observations with whatever usage it reported, which is
 * usually none: codex sets usage only on `response.completed` and completions
 * on the last chunk, so a dropped stream reports zero.
 */
export interface RetriedAttempt {
	/** The observation ID of the failed reply, or `summary-retry:<n>` for a compaction attempt, which has no observation. */
	id: string;
	origin: "parent" | "worker";
	errorMessage?: string;
	/**
	 * Whether a completed reply (or, for a summary attempt, a completed
	 * compaction) followed the streak this attempt belongs to. An attempt in a
	 * streak that ran out or was cancelled is still listed, so the count of
	 * failed attempts does not shrink when the run fails.
	 */
	recovered: boolean;
	/** Tokens the attempt itself reported; already inside the metered totals. */
	meteredTokens: number;
	/**
	 * For an attempt that reported nothing, a lower bound on its spend (see
	 * `estimateBasis`); 0 when it reported usage or nothing sizes it.
	 */
	estimatedTokens: number;
	/**
	 * Where the estimate comes from.
	 * - `recovering-prompt`: the prompt (fresh, cached and cache-written input) of
	 *   the call that recovered the streak. pi omits the failed reply and resends
	 *   the same context, so that prompt is the failed attempt's, not a guess. For
	 *   a summary call it is the compaction that succeeded, since pi-ai resends
	 *   the same summary request. Not used when a compaction came in between,
	 *   which changes the context, nor for a split-turn compaction, whose usage
	 *   sums two summary calls.
	 * - `previous-reply`: no call recovered the streak, so the previous
	 *   completed reply's prompt plus output stands in. Measured on v4 and v5
	 *   parent streams it exceeded the next prompt in 1–3% of consecutive pairs
	 *   (median by 28–58 tokens), so it is close to, not strictly, a lower bound.
	 *   After a compaction it falls to the summary's output.
	 * - `none`: the attempt reported usage, or nothing sizes it (a first request
	 *   no reply followed, a summary call whose compaction failed).
	 */
	estimateBasis: "recovering-prompt" | "previous-reply" | "none";
}

/**
 * One run's failed provider attempts, parent and workers together, as the run
 * record reports them (ADR-033). `totalTokens` stays metered; the
 * estimate is carried beside it so neither number hides the other.
 */
export interface RetrySummary {
	/** Failed attempts pi retried. An unretried final failure is the run's error, not a count here. */
	attempts: number;
	recovered: number;
	unrecovered: number;
	bySource: Record<"parent" | "worker", { attempts: number; recovered: number; unrecovered: number }>;
	/** Usage the failed attempts reported themselves (already in totalTokens). */
	meteredTokens: number;
	/** Attempts that reported no usage. */
	unmeteredAttempts: number;
	/** The lower-bound estimate summed over the unmetered attempts (see RetriedAttempt.estimatedTokens). */
	estimatedTokens: number;
	/** Unmetered attempts with no estimate (see RetriedAttempt.estimateBasis). */
	unestimatedAttempts: number;
	/** The run-wide cap: max(floor, floor(rate x meteredRequests)), from the grid's retry policy. */
	cap: { floor: number; rate: number; meteredRequests: number; allowed: number };
	/** More failed attempts than the cap allows: the run is invalid, for infrastructure. */
	capExceeded: boolean;
}

/**
 * Sum one run's retried attempts against the policy's run-wide cap. pi's own
 * `maxRetries` resets on every good reply, so without this a provider that
 * drops every third request would be retried for the whole run and the run
 * would read as valid while a third of its requests went unmetered. The cap
 * grows with the run's metered requests, the same rule in both arms, so the arm
 * that makes more calls is not the one a fixed cap throws out more often.
 */
export function summarizeRetries(attempts: readonly RetriedAttempt[], policy: { maxFailedAttempts: number; maxFailedAttemptRate: number }, meteredRequests: number): RetrySummary {
	const bySource: RetrySummary["bySource"] = { parent: { attempts: 0, recovered: 0, unrecovered: 0 }, worker: { attempts: 0, recovered: 0, unrecovered: 0 } };
	let meteredTokens = 0;
	let unmeteredAttempts = 0;
	let estimatedTokens = 0;
	let unestimatedAttempts = 0;
	const allowed = Math.max(policy.maxFailedAttempts, Math.floor(policy.maxFailedAttemptRate * meteredRequests));
	for (const attempt of attempts) {
		const source = bySource[attempt.origin];
		source.attempts++;
		if (attempt.recovered) source.recovered++;
		else source.unrecovered++;
		meteredTokens += attempt.meteredTokens;
		if (attempt.meteredTokens > 0) continue;
		unmeteredAttempts++;
		estimatedTokens += attempt.estimatedTokens;
		if (attempt.estimatedTokens === 0) unestimatedAttempts++;
	}
	return {
		attempts: attempts.length, recovered: bySource.parent.recovered + bySource.worker.recovered,
		unrecovered: bySource.parent.unrecovered + bySource.worker.unrecovered, bySource,
		meteredTokens, unmeteredAttempts, estimatedTokens, unestimatedAttempts,
		cap: { floor: policy.maxFailedAttempts, rate: policy.maxFailedAttemptRate, meteredRequests, allowed },
		capExceeded: attempts.length > allowed,
	};
}

/**
 * Observations that reported spend: the metered provider calls. Beside the
 * entry's request log, the difference is the number of calls no usage covers,
 * including the ones no stream shows (a worker's failed compaction attempt).
 */
export function meteredCallCount(observations: readonly UsageObservation[]): number {
	return observations.filter((o) => o.usage !== undefined && reportsSpend(o.usage)).length;
}

export interface UsageAccounting {
	valid: boolean;
	errors: string[];
	parent: UsageTotals;
	worker: UsageTotals;
	total: UsageTotals;
	parentRequests: number;
	workerRequests: number;
	duplicateEvents: number;
	/** Diagnostic only: summed cost estimates, never the efficiency measure. */
	costUsd: number;
}

/** One tool call a child made, joined with the result its session persisted for it. */
export interface ChildToolCall {
	/** 1-based ordinal of the child's assistant reply that made the call. */
	turn: number;
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Absent when the session holds no result for the call. */
	isError?: boolean;
	resultText?: string;
	details?: unknown;
}

/**
 * How a child's session ended.
 *
 * - `handoff`: the last reply is `stop` or `length`; the child answered.
 * - `budget-stop`: the last reply called tools, every call has a persisted
 *   result, and every result is pired's turn-budget stop (core/child.ts
 *   `budgetRefusal` with `terminate`). pi ends the loop on a batch whose every
 *   result asks to terminate (agent-loop.js `shouldTerminateToolBatch`), so no
 *   request follows and every one the child sent is in the file.
 * - `aborted-between-requests`: the last reply is the empty, zero-usage `error`
 *   pi writes when a run is aborted before its next request goes out: pi-ai's
 *   lazyStream turns the aborted setup into a reply without calling the
 *   provider. That reply is not a provider call and is not counted.
 * - `cut-off`: anything else — a failed or aborted request, or a session that
 *   stops after tool results with no stop marker, which is where an in-flight
 *   request's reply is missing (measured below).
 */
export type ChildEnding = "handoff" | "budget-stop" | "aborted-between-requests" | "cut-off";

/**
 * The refusal core/child.ts `budgetRefusal` returns with `terminate` once a
 * worker is past its turn budget and its grace turns. Matched in the session's
 * last tool results and again in pi-subagents' row in the parent's transcript,
 * which reports the last tool error as `<tool> failed (exit 1): <text>`
 * (execution.js, detectSubagentError) — measured on a faux pired-scout run:
 * `bash failed (exit 1): pired: pired-scout is 3 turns past its 20-turn budget
 * and still calling tools, so this run is being stopped. …`. The test checks this
 * against the guard's own text, so a reworded refusal fails there, not here.
 */
export const PIRED_BUDGET_STOP = /pired: .{1,80}? is \d+ turns past its \d+-turn budget and still calling tools, so this run is being stopped/;

/**
 * The errorMessage of the reply pi writes when a run was aborted before its
 * next request was built: the AbortSignal's own reason ("This operation was
 * aborted"; "The operation was aborted" from Node's older AbortError). A request
 * aborted in flight reads differently: every pi-ai provider marks it `aborted`
 * (openai-completions.js `signal.aborted ? "aborted" : "error"`), never `error`.
 */
const ABORTED_BEFORE_REQUEST = /^(?:This|The) operation was aborted\.?$/;

/** What one child's `session.jsonl` says about its provider calls and its work. */
export interface ChildSessionExtraction {
	childKey: string;
	/** The session header's ID. */
	sessionId?: string;
	/** Origin "worker", IDs namespaced `<childKey>/...`. */
	observations: UsageObservation[];
	/** Structural problems: the run cannot be scored. */
	errors: string[];
	/** Provider failures whose spend is unknown: the run cannot be scored. Each also adds an observation without usage. */
	providerErrors: string[];
	notes: string[];
	/** Assistant replies, which is what pi-subagents counts as the child's turns. */
	turns: number;
	compactions: number;
	cacheWarmings: number;
	recoveredOverflows: number;
	missingResponseIds: number;
	/** `context_edit` entries: retry and overflow omissions, which pi-subagents' own usage sum leaves out. */
	contextEdits: number;
	/** Failed attempts pi retried and recovered from; present only with the `retry` option. */
	retries?: RetriedAttempt[];
	/** The last assistant reply's stopReason; undefined when the session holds no reply. */
	finalStop?: string;
	/** How the session ended (see ChildEnding). */
	ending: ChildEnding;
	/** Text of the last assistant reply: the child's handoff. */
	finalText: string;
	/** Distinct `provider/model` pairs the replies came from, in order of first use. */
	models: string[];
	/** Every `thinking_level_change` the session recorded, in order. */
	thinkingLevels: string[];
	toolCalls: ChildToolCall[];
	/** Summed usage of the assistant replies alone, the quantity pi-subagents reports for the child. */
	replyUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * How a child ended, from pi-subagents' result row. `failed` is any non-zero
 * exit the flags below do not name: a provider error, an empty final answer, a
 * tripwire at agent_start.
 */
export type ChildStatus = "completed" | "failed" | "timed-out" | "interrupted" | "detached" | "stopped";

/** One child a `subagent` call launched, and the file its session must be in. */
export interface SubagentChild {
	toolCallId: string;
	runId: string;
	/** pi-subagents' launch-order identity within the run. */
	index: number;
	/** `<runId>/run-<index>`: the child's directory under the pinned session dir and its observation namespace. */
	childKey: string;
	/** `<childKey>/session.jsonl`, relative to the pinned session dir. */
	sessionPath: string;
	agent: string;
	status: ChildStatus;
	/**
	 * `result` when the call's final details listed the child. `update` when the
	 * call ended in error: pi-subagents throws on a failed child (tool-result.js
	 * `finalizeToolResult`), pi keeps only the message, and the last progress
	 * update is the only row that still names the run and the child.
	 */
	source: "result" | "update";
	exitCode?: number;
	error?: string;
	/** pi-subagents' `provider/model` for the child, as it reported it. */
	model?: string;
	thinking?: string;
	/** pi-subagents' own sum over the child's replies; a cross-check, never the count. */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number };
	/** The absolute path pi-subagents reported, when it reported one. */
	reportedSessionFile?: string;
	sessionFound: boolean;
}

export interface SubagentCall {
	toolCallId: string;
	isError: boolean;
	/** `agent` from the call's arguments; a management action has none. */
	requestedAgent?: string;
	action?: string;
	task?: string;
	/** Asked for (`async: true`) or launched (`details.asyncId`) as a background run. */
	async: boolean;
	mode?: string;
	runId?: string;
	children: SubagentChild[];
	/** Everything the parent's context received from the call. */
	resultText: string;
}

export interface SubagentReconciliation {
	calls: SubagentCall[];
	/** Every launched child, in call order. */
	children: SubagentChild[];
	errors: string[];
	notes: string[];
}

/**
 * What a child's run amounts to.
 *
 * - `completed`: it handed back and pi-subagents says so.
 * - `incomplete`: one of the bounds the design puts on a worker stopped it —
 *   pired's turn budget or pi-subagents' worker timeout — and every request it
 *   sent is answered in its session. The bound is part of the candidate under
 *   test, so its tokens count like any other worker's.
 * - `failed`: it ended on its own terms (an empty final answer, a last tool
 *   error) with every request answered.
 * - `unaccounted`: paused, detached, stopped from outside, cut off mid-request,
 *   or its session disagrees with how the parent saw it end. Its spend is not
 *   known, so the run cannot be scored.
 */
export type ChildOutcome = "completed" | "incomplete" | "failed" | "unaccounted";

export interface ChildVerdict {
	/** The child's status allows scoring and its session accounts for every call it made. */
	accepted: boolean;
	/** Set when accepted. */
	outcome?: Exclude<ChildOutcome, "unaccounted">;
	/** This function's own findings; the session's errors are the caller's to report. */
	errors: string[];
	notes: string[];
}

const zero = (): UsageTotals => ({
	inputTokens: 0, outputTokens: 0, totalTokens: 0,
	cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
});

function hasCompleteUsage(value: Partial<UsageTotals> | undefined): value is UsageTotals {
	return Boolean(value && [
		value.inputTokens, value.outputTokens, value.totalTokens,
		value.cacheReadTokens, value.cacheWriteTokens, value.reasoningTokens,
	].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0));
}

function sameUsage(a: UsageTotals, b: UsageTotals): boolean {
	return (Object.keys(a) as Array<keyof UsageTotals>).every((k) => a[k] === b[k]);
}

/**
 * Pi's provider usage (`input`, `output`, `cacheRead`, `cacheWrite`,
 * `reasoning?`, `totalTokens`) in this module's names. `totalTokens` already
 * includes cache reads (measured: 785 + 29 + 7,680 = 8,494 on a Luna response)
 * and reasoning is a split of output, so neither is added a second time.
 */
export function normalizePiUsage(value: unknown): Partial<UsageTotals> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Record<string, unknown>;
	return {
		inputTokens: usage.input as number,
		outputTokens: usage.output as number,
		totalTokens: usage.totalTokens as number,
		cacheReadTokens: usage.cacheRead as number,
		cacheWriteTokens: usage.cacheWrite as number,
		// Pi declares reasoning optional; zero means the provider did not report a split.
		reasoningTokens: (usage.reasoning ?? 0) as number,
	};
}

/** Pi's per-response cost estimate. Diagnostic only: a coding-plan provider reports 0. */
export function piCostUsd(value: unknown): number | undefined {
	const total = (value as { cost?: { total?: unknown } } | undefined)?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Why a usage object cannot be the provider's whole record of one call, or
 * undefined when it can. `completed` is false only for a reply pi marked
 * `error`/`aborted`, which may honestly report nothing.
 *
 * Every pi API starts a reply from a zero-filled usage object and overwrites it
 * from the provider's usage frame, reading each missing field as 0. So a lost
 * frame (a local server without `include_usage`, a dropped final chunk) books a
 * successful call that costs nothing, and a frame missing one field books a
 * complete-looking undercount: pi-ai 0.84.2 reads `total_tokens || 0` on the
 * Responses path (`openai-responses-shared.js` 450), giving
 * `{input: 48000, output: 900, totalTokens: 0}`, and `prompt_tokens || 0` on
 * the Completions path (`openai-completions.js` 1107), giving output alone.
 * Each is the cheap success this assay must not report.
 *
 * Both APIs the assay runs keep totalTokens = input + output + cacheRead +
 * cacheWrite. Completions computes it that way from the clamped parts
 * (`openai-completions.js` 1118-1127). Responses subtracts cached and
 * cache-write tokens from `input_tokens` (`openai-responses-shared.js` 445) and
 * copies the provider's `total_tokens`, which OpenAI defines as
 * `input_tokens + output_tokens`; codex reaches that code for both SSE and
 * WebSocket (`openai-codex-responses.js` 473, 1180). A split-turn compaction
 * sums its two calls field by field (`compaction.js` 52-64), which keeps the
 * identity. Measured: it holds on all 50 completed parent replies (29 Luna,
 * 15 Qwen, 6 GLM) and all 60 worker responses (37 Luna, 17 Qwen, 6 GLM) in
 * eval/artifacts, and each of them read prompt tokens. The three errored Luna
 * replies there report all zeros, which the identity also allows.
 *
 * Re-read on pi-ai 0.87.1 for the two priority models: gpt-6-luna takes the
 * codex Responses path, which still reads `total_tokens || 0`
 * (`openai-responses-shared.js` 450) and sets `responseId` from `response.id`;
 * glm-5.3-flash (zai) takes the Completions path, which still sums the parts
 * (`openai-completions.js` 1184) and sets `responseId` from the first chunk's `id`.
 *
 * A completed call sent at least the system prompt, so it read prompt tokens.
 * An errored reply keeps the zero-filled object when the provider billed
 * nothing, which is why a recovered overflow's reply may be all zeros.
 */
function usageDefect(usage: UsageTotals, completed: boolean): string | undefined {
	const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	const parts = prompt + usage.outputTokens;
	if (completed && parts === 0 && usage.totalTokens === 0) return "zero tokens";
	if (usage.totalTokens !== parts) return `totalTokens ${usage.totalTokens}, not input + output + cache read + cache write = ${parts}`;
	if (completed && prompt === 0) return `${usage.outputTokens} output tokens but no prompt tokens`;
	return undefined;
}

/** Whether a usage object books any tokens at all. */
function reportsSpend(value: unknown): boolean {
	const usage = normalizePiUsage(value);
	return Boolean(usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens].some((n) => typeof n === "number" && n > 0));
}

/** Stop reasons of a reply the agent loop accepted. `error`/`aborted` are failures; `pending`/`deferred` never end a print-mode turn. */
const COMPLETED_STOPS = new Set(["stop", "toolUse", "length"]);

/** The tool pi-subagents registers. Its result carries the usage of the children it ran. */
export const SUBAGENT_TOOL = "subagent";

export interface PiEventsOptions {
	/**
	 * Tools whose results carry their children's usage. pi-subagents sums each
	 * child's replies into the tool result (subagent-executor.js
	 * `withAggregatedToolUsage`) and pi-agent-core 0.87 copies it onto the
	 * toolResult message (agent-loop.js `createToolResultMessage`). Measured on a
	 * faux run: 6,039 tokens on the result, the exact sum of the child's three
	 * session replies. Counting it here as well would book the child twice; it is
	 * counted once, from the child's own session.
	 */
	delegationTools?: readonly string[];
	/**
	 * The grid runs under a retry policy: a failed reply followed by
	 * `auto_retry_start` is a retried attempt, not a failure. Off, a retry event
	 * is a failure as before and the output is unchanged.
	 */
	retry?: boolean;
}

/** A call's whole prompt: fresh, cached and cache-written input. */
function promptOf(usage: Partial<UsageTotals> | undefined): number {
	return usage ? num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) : 0;
}

/** A reply's whole prompt plus its output. */
function promptPlusOutput(usage: Partial<UsageTotals>): number {
	return promptOf(usage) + num(usage.outputTokens);
}

/**
 * Whether pi 0.87.1 retries this failed reply: agent-session.js
 * `_isRetryableError`, which never retries a context overflow (those go to
 * compaction) and otherwise defers to pi-ai's retryable list.
 */
function piRetries(reply: { errorMessage?: string; provider?: string }): boolean {
	const message = { role: "assistant", stopReason: "error", errorMessage: reply.errorMessage ?? "", provider: reply.provider } as unknown as AssistantMessage;
	return !isContextOverflow(message) && isRetryableAssistantError(message);
}

/** One retried attempt awaiting the call that ends its streak. */
type StreakEntry = { attempt: RetriedAttempt; sameContext: boolean };

/**
 * Close a streak on the call that recovered it. Each unmetered attempt whose
 * context no compaction changed since takes that call's prompt: pi resent the
 * same request. The others keep their fallback.
 */
function recoverStreak(streak: StreakEntry[], prompt: number): void {
	for (const { attempt, sameContext } of streak) {
		attempt.recovered = true;
		if (sameContext && attempt.meteredTokens === 0 && prompt > 0) {
			attempt.estimatedTokens = prompt;
			attempt.estimateBasis = "recovering-prompt";
		}
	}
}

/** The fields a new attempt's estimate starts from: the fallback, or nothing. */
function fallbackEstimate(meteredTokens: number, fallback: number): Pick<RetriedAttempt, "estimatedTokens" | "estimateBasis"> {
	return meteredTokens > 0 || fallback <= 0 ? { estimatedTokens: 0, estimateBasis: "none" } : { estimatedTokens: fallback, estimateBasis: "previous-reply" };
}

/**
 * A compaction that cut a turn in half summarizes the history and the turn's
 * prefix in two calls and reports their usage summed (compaction.js `compact`,
 * the "Turn Context (split turn)" marker), so its prompt overstates either one.
 */
const SPLIT_TURN_MARKER = "**Turn Context (split turn):**";

/**
 * Extract only terminal provider responses from pi's JSON session-event stream.
 *
 * Re-read against pi 0.87.1 (pi-agent-core `agent-loop.js`, `agent-session.js`,
 * `cache-warmer.js`). `message_end` and `compaction_end` keep the 0.84.2 shapes
 * the rules below were written for (`compaction_end` at agent-session.js 1958,
 * 1972, 2083, 2242, 2258); what changed is listed after them.
 *
 * Measured against pi 0.84.2 (`agent-loop.js`, `agent-session.js`):
 *
 * - Each assistant reply reaches the stream once, as `message_end`. The
 *   `message_update`, `turn_end` and `agent_end` events repeat snapshots of the
 *   same usage and would double it, so they are never read.
 * - Errored and aborted replies also end in `message_end`, carrying the
 *   zero-filled usage every pi API starts from (or `EMPTY_USAGE` when the run
 *   itself threw), usually without a `responseId`. Absent usage is still an
 *   error here: zero is only proven for pi's own objects, not for a truncated
 *   or foreign stream.
 * - Context-overflow recovery: the failed reply (`stopReason` `error` with an
 *   overflow message, or a recoverable `length`) is persisted on `message_end`,
 *   then `_checkCompaction` runs `compaction_start`/`compaction_end` with
 *   reason `overflow` and `willRetry: true`, and the turn is retried. Only that
 *   exact pattern counts as recovered; the reply's own usage is still counted.
 *   A second overflow, or a failed summary, ends in a `compaction_end` with no
 *   result, which is a provider failure.
 * - Compaction usage lives only on `compaction_end.result.usage`. `compact()`
 *   makes one summary call, or two when the cut splits a turn (history summary,
 *   then turn-prefix summary), and returns `combineUsage` of both
 *   (`compaction.js` 583-617), so one observation per `compaction_end` covers
 *   every call it made. If the second call fails the first one's usage is lost
 *   with the thrown error, which is why a result-less `compaction_end` must
 *   invalidate rather than count as zero.
 * - `entry_appended` fires only for extension `appendEntry` custom entries in
 *   this version. A compaction entry arriving there would be an echo of a
 *   `compaction_end` already counted; a branch summary would not otherwise
 *   appear, so it is counted by its entry ID.
 * - The benchmark disables retries, so `retryAssistantCall` makes one attempt
 *   per call. Any `auto_retry_*` or `summarization_retry_*` event means an
 *   attempt failed and was replaced, and pi reports no usage for the attempt it
 *   discarded. Under a retry policy (the `retry` option, ADR-033) those
 *   events are read instead: each failed attempt goes into `retries` with the
 *   usage it reported and a lower-bound estimate, and only a streak pi gave up
 *   on (`auto_retry_end` success: false, or a final error with no retry after
 *   it) fails the run.
 *
 * What pi 0.87.1 added:
 *
 * - A toolResult message may carry `usage`. Only a delegation tool's is
 *   expected (see `PiEventsOptions`); any other is still refused.
 * - `entry_appended` also fires for context edits (retry and overflow
 *   omissions), turn-boundary drafts, and cache-warming `usage` entries. A warm
 *   is a real provider call replayed with a one-token output cap
 *   (cache-warmer.js `refresh`), so each is counted by its entry ID. A warm that
 *   fails is swallowed without an entry, so its spend cannot be seen at all: the
 *   runner must set `cacheWarming: "off"` for the count to be complete.
 * - A compaction entry on `entry_appended` is now an extension's boundary draft
 *   (`_applyBoundaryDrafts`), which has no `compaction_end`. Its summary calls,
 *   if any, are the extension's own, so it stays refused below.
 * - `system` messages reach `message_end`; like user messages they cost nothing.
 */
export function observationsFromPiEvents(events: Array<Record<string, unknown>>, options: PiEventsOptions = {}): PiUsageExtraction {
	const out: PiUsageExtraction = {
		observations: [], errors: [], providerErrors: [], notes: [],
		compactions: 0, recoveredOverflows: 0, missingResponseIds: 0, cacheWarmings: 0, delegatedResults: 0, finalStop: false,
	};
	const delegationTools = new Set(options.delegationTools ?? [SUBAGENT_TOOL]);
	const fail = (reason: string, id = `unaccounted:${out.providerErrors.length + 1}`) => {
		out.providerErrors.push(reason);
		out.observations.push({ id, origin: "parent" });
	};
	let assistants = 0;
	let lastStop: string | undefined;
	// A failed or truncated reply whose meaning depends on what follows it: pi's
	// overflow recovery turns it into a retried turn, anything else leaves it failed.
	let pending: { id: string; stopReason: string; errorMessage?: string } | undefined;
	const settle = () => {
		if (pending?.stopReason === "error") fail(`assistant reply ${pending.id} failed: ${pending.errorMessage || "provider error"}`);
		pending = undefined;
	};
	const timestamps = new Map<string, unknown>();
	let summaries = 0;
	let echoes = 0;
	const retry = options.retry === true;
	if (retry) out.retries = [];
	// The last reply that reported spend, and the failed reply awaiting its retry
	// event: pi emits auto_retry_start after the failed reply's message_end.
	let lastPromptPlusOutput = 0;
	let lastReply: { id: string; usage?: Partial<UsageTotals> } | undefined;
	// Attempts whose streak has not yet ended in a completed reply (or, for
	// summary calls, a completed compaction). A streak that runs out leaves them
	// unrecovered, with their fallback estimate.
	let streak: StreakEntry[] = [];
	let summaryStreak: StreakEntry[] = [];
	let summaryRetries = 0;
	// Set by auto_retry_start, cleared by the next reply: a streak cancelled in
	// between has no reply of its own to fail.
	let awaitingRetry = false;
	const retried = (id: string, usage: Partial<UsageTotals> | undefined, errorMessage: string | undefined, fallback: number): StreakEntry => {
		const meteredTokens = usage && reportsSpend(usage) ? num(usage.totalTokens) : 0;
		const attempt: RetriedAttempt = {
			id, origin: "parent", ...(errorMessage === undefined ? {} : { errorMessage }), recovered: false,
			meteredTokens, ...fallbackEstimate(meteredTokens, fallback),
		};
		out.retries!.push(attempt);
		return { attempt, sameContext: true };
	};
	for (const event of events) {
		switch (event.type) {
			case "message_end": {
				const message = event.message;
				if (!isRow(message)) {
					out.errors.push("message_end carries no message");
					break;
				}
				if (message.role === "toolResult") {
					// A delegation tool's usage is its children's, counted from their
					// sessions. Any other tool reporting usage spent provider tokens
					// this ledger does not attribute.
					if (reportsSpend(message.usage)) {
						if (delegationTools.has(String(message.toolName))) out.delegatedResults++;
						else out.errors.push(`tool result ${String(message.toolName)} reports provider usage outside this accounting`);
					}
					break;
				}
				if (message.role !== "assistant") break;
				settle();
				assistants++;
				awaitingRetry = false;
				const stopReason = typeof message.stopReason === "string" ? message.stopReason : "missing";
				let id: string;
				if (isName(message.responseId)) {
					id = message.responseId;
					if (timestamps.has(id)) {
						// Print mode emits each reply once, so a repeat with the same
						// timestamp can only be the same reply seen twice. A different
						// timestamp is a second provider call reusing the ID: merging
						// the two would drop a real request.
						if (timestamps.get(id) === message.timestamp) out.notes.push(`responseId ${id} repeated; counted once`);
						else out.errors.push(`responseId ${id} names two replies with different timestamps`);
					}
					timestamps.set(id, message.timestamp);
				} else {
					// Each reply's message_end is emitted exactly once, so its ordinal is
					// an honest identity. No two fallback rows are ever merged.
					id = `assistant#${assistants}`;
					out.missingResponseIds++;
					out.notes.push(`assistant reply ${assistants} has no responseId; counted as ${id}`);
				}
				const usage = normalizePiUsage(message.usage);
				const costUsd = piCostUsd(message.usage);
				out.observations.push({ id, origin: "parent", ...(usage ? { usage } : {}), ...(costUsd === undefined ? {} : { costUsd }) });
				if (retry) {
					// Read before this reply updates it: a retried attempt is estimated from the reply before it.
					lastReply = { id, ...(usage ? { usage } : {}) };
				}
				if (!usage) out.errors.push(`assistant reply ${id} carries no usage`);
				else if (hasCompleteUsage(usage)) {
					const defect = usageDefect(usage, COMPLETED_STOPS.has(stopReason));
					if (defect) out.errors.push(`assistant reply ${id} (${stopReason}) reports ${defect}`);
				}
				if (stopReason === "aborted") fail(`assistant reply ${id} was aborted`);
				else if (stopReason === "error" || stopReason === "length") {
					pending = { id, stopReason, ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}) };
				} else if (!COMPLETED_STOPS.has(stopReason)) out.errors.push(`assistant reply ${id} ended with unexpected stopReason ${stopReason}`);
				lastStop = stopReason;
				if (retry && stopReason !== "error" && usage && reportsSpend(usage)) lastPromptPlusOutput = promptPlusOutput(usage);
				// pi closes a streak on the next reply that is not an error
				// (agent-session.js, auto_retry_end success: true). An aborted reply
				// is not a recovery here: it fails the run above.
				if (retry && COMPLETED_STOPS.has(stopReason)) {
					recoverStreak(streak, promptOf(usage));
					streak = [];
				}
				break;
			}
			case "compaction_end": {
				const n = ++out.compactions;
				const reason = typeof event.reason === "string" ? event.reason : "unknown";
				const result = event.result;
				if (event.aborted === true || !isRow(result) || event.errorMessage !== undefined) {
					const why = event.aborted === true ? "was aborted" : typeof event.errorMessage === "string" ? `failed: ${event.errorMessage}` : "returned no result";
					fail(`compaction ${n} (${reason}) ${why}`, `compaction:${n}`);
					summaryStreak = [];
					break;
				}
				summaries++;
				const usage = normalizePiUsage(result.usage);
				const costUsd = piCostUsd(result.usage);
				out.observations.push({ id: `compaction:${n}`, origin: "parent", ...(usage ? { usage } : {}), ...(costUsd === undefined ? {} : { costUsd }) });
				if (retry) {
					const split = typeof result.summary === "string" && result.summary.includes(SPLIT_TURN_MARKER);
					recoverStreak(summaryStreak, split ? 0 : promptOf(usage));
					summaryStreak = [];
					// A reply retried across this compaction is resent with the summary
					// in place of the history, so the recovering reply's prompt is no
					// longer the failed attempt's.
					for (const entry of streak) entry.sameContext = false;
					// The next prompt carries the summary, not the history it replaced,
					// so the previous reply no longer bounds a failed attempt from below.
					lastPromptPlusOutput = num(usage?.outputTokens);
				}
				if (!usage) out.errors.push(`compaction ${n} (${reason}) reports no usage`);
				else if (hasCompleteUsage(usage)) {
					const defect = usageDefect(usage, true);
					if (defect) out.errors.push(`compaction ${n} (${reason}) reports ${defect}`);
				}
				if (reason === "overflow" && event.willRetry === true) {
					if (pending) {
						out.recoveredOverflows++;
						out.notes.push(`assistant reply ${pending.id} (${pending.stopReason}) overflowed the context; compaction ${n} recovered it and the turn was retried`);
						pending = undefined;
					} else out.errors.push(`compaction ${n} retried an overflow with no failed or truncated reply before it`);
				}
				break;
			}
			case "entry_appended": {
				const entry = event.entry;
				if (!isRow(entry)) break;
				if (entry.type === "compaction") echoes++;
				else if (entry.type === "branch_summary") {
					if (!isName(entry.id)) {
						out.errors.push("branch summary entry has no ID");
						break;
					}
					const id = `branch-summary:${entry.id}`;
					const usage = normalizePiUsage(entry.usage);
					const costUsd = piCostUsd(entry.usage);
					out.observations.push({ id, origin: "parent", ...(usage ? { usage } : {}), ...(costUsd === undefined ? {} : { costUsd }) });
					if (!usage) out.errors.push(`${id} reports no usage`);
					else if (hasCompleteUsage(usage)) {
						const defect = usageDefect(usage, true);
						if (defect) out.errors.push(`${id} reports ${defect}`);
					}
					out.notes.push(`${id} counted; branch summaries are not expected in print mode`);
				} else if (entry.type === "usage") {
					if (!isName(entry.id)) {
						out.errors.push("usage entry has no ID");
						break;
					}
					const id = `usage:${entry.id}`;
					const usage = normalizePiUsage(entry.usage);
					const costUsd = piCostUsd(entry.usage);
					out.observations.push({ id, origin: "parent", ...(usage ? { usage } : {}), ...(costUsd === undefined ? {} : { costUsd }) });
					if (!usage) out.errors.push(`${id} reports no usage`);
					else if (hasCompleteUsage(usage)) {
						// pi appends the entry only for a warm that did not fail, so it completed.
						const defect = usageDefect(usage, true);
						if (defect) out.errors.push(`${id} reports ${defect}`);
					}
					if (entry.kind === "cache_warm") out.cacheWarmings++;
					out.notes.push(`${id} (${String(entry.kind)}) counted as a provider call`);
				}
				break;
			}
			case "auto_retry_start":
				if (!retry) {
					fail(`${event.type}: retries are disabled, so a retry means a failed attempt whose usage pi does not report`);
					break;
				}
				// pi retries only a reply that ended in error (agent-session.js
				// _prepareRetry); anything else before this event is a stream this
				// reader does not understand.
				if (pending?.stopReason === "error" && lastReply?.id === pending.id) {
					streak.push(retried(pending.id, lastReply.usage, pending.errorMessage, lastPromptPlusOutput));
					awaitingRetry = true;
					out.notes.push(`assistant reply ${pending.id} failed (${pending.errorMessage || "provider error"}); pi retried it (attempt ${String(event.attempt)})`);
					pending = undefined;
				} else out.errors.push(`auto_retry_start (attempt ${String(event.attempt)}) with no failed reply before it`);
				break;
			case "auto_retry_end":
				if (!retry) {
					fail(`${event.type}: retries are disabled, so a retry means a failed attempt whose usage pi does not report`);
					break;
				}
				// success: false ends a streak that did not recover. When the retries
				// ran out, the last failed reply is still pending and fails the run
				// once, below. Only a streak cancelled during its backoff, with no
				// reply after the retry, has nothing else to fail.
				if (event.success !== true && awaitingRetry && !pending) {
					fail(`auto_retry_end: retry streak ended without success: ${typeof event.finalError === "string" ? event.finalError : "unknown"}`, `retry-end:${out.providerErrors.length + 1}`);
				}
				awaitingRetry = false;
				break;
			case "summarization_retry_scheduled":
				if (!retry) {
					fail(`${event.type}: retries are disabled, so a retry means a failed attempt whose usage pi does not report`);
					break;
				}
				// A failed summary call: pi discards its usage. Its prompt is the part
				// of the history being summarized, so no reply sizes it; the
				// compaction that succeeds does (recoverStreak). A streak that runs
				// out ends in a compaction_end with an errorMessage, a failure above.
				summaryStreak.push(retried(`summary-retry:${++summaryRetries}`, undefined, typeof event.errorMessage === "string" ? event.errorMessage : undefined, 0));
				break;
			case "summarization_retry_attempt_start":
			case "summarization_retry_finished":
				if (retry) break;
				fail(`${event.type}: retries are disabled, so a retry means a failed attempt whose usage pi does not report`);
				break;
		}
	}
	settle();
	if (echoes > summaries) out.errors.push(`${echoes} compaction entries but only ${summaries} completed compaction_end events`);
	out.finalStop = lastStop === "stop";
	if (assistants === 0) out.errors.push("no assistant reply in the stream");
	else if (!out.finalStop) out.errors.push(`final assistant reply ended with ${lastStop}, not stop`);
	return out;
}

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** The text parts of a message's or tool result's content, joined. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => isRow(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
}

/**
 * Entry types a pi 0.87.1 session file holds that carry no usage
 * (session-manager.d.ts `SessionEntry`). Any other type fails the session: a
 * later pi that adds a usage-bearing entry must not read as spending nothing.
 */
const INERT_ENTRY_TYPES = new Set(["model_change", "session_info", "custom", "custom_message", "label"]);

/**
 * Normalize one child's `session.jsonl` into observations and a record of its work.
 *
 * pi's SessionManager writes the file as the child runs: every message on
 * `message_end`, compaction and branch-summary entries with the usage of the
 * calls that produced them, and a `usage` entry per cache warm. Nothing is
 * written before the first assistant reply exists (session-manager.js
 * `_persist`), so a session file means at least one provider call reached
 * `message_end`.
 *
 * Each reply is held to the parent's rules: complete usage, a total equal to
 * its parts, a prompt on every completed call, and an `error` or `aborted`
 * reply is a provider failure whose true spend is unknown. Two rules differ
 * because the file has no events:
 *
 * - Overflow recovery leaves the failed reply, a `context_edit` omitting it, a
 *   compaction entry, then the retried reply (agent-session.js
 *   `_omitRecoveryAttempt`, `_runAutoCompaction`). The compaction entry does
 *   not record its reason, so an errored reply counts as recovered only when a
 *   compaction entry follows it and another reply follows that. An auto-retry
 *   leaves the same shape without the compaction and stays a failure, unless
 *   the `retry` option says the grid ran under a retry policy: then an `error`
 *   reply a context edit omits, followed by another reply, is a retried
 *   attempt listed in `retries`, its reported usage still counted.
 * - The last reply must be `stop` or `length`, or the session must end on one
 *   of the two bounded stops whose spend is fully in the file (ChildEnding).
 *   Anything else is a child cut off mid-loop, and an `error` or `aborted` reply
 *   is also a provider failure.
 *
 * The bounded stops were measured on faux pired workers under pi-subagents
 * 0.71.0 and pi 0.87.1 (scratch replays of the real entry):
 * - turn budget: 23 `toolUse` replies, the last batch answered with pired's stop
 *   text, no further reply; pi-subagents reports the child `failed` with that
 *   text as its error.
 * - timeout during a tool: the tool result "Command aborted", then an `error`
 *   reply with zero usage, no content and "This operation was aborted"; the
 *   faux provider was never called for it. pi-subagents reports `timedOut`.
 * - timeout during a request: the session simply stops after the previous tool
 *   results. The request in flight never reached `message_end`, so its spend is
 *   nowhere in the file, which is why a session that stops after tool results
 *   without pired's stop text stays `cut-off`.
 *
 * A header naming a `parentSession` is a fork. It starts with a copy of the
 * parent's history, replies and usage included, and counting it would book the
 * parent's calls a second time.
 */
export function observationsFromChildSession(sessionJsonl: string | undefined, childKey: string, options: { retry?: boolean } = {}): ChildSessionExtraction {
	const out: ChildSessionExtraction = {
		childKey, observations: [], errors: [], providerErrors: [], notes: [],
		turns: 0, compactions: 0, cacheWarmings: 0, recoveredOverflows: 0, missingResponseIds: 0, contextEdits: 0,
		ending: "cut-off", finalText: "", models: [], thinkingLevels: [], toolCalls: [],
		replyUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const who = `child ${childKey}`;
	const retry = options.retry === true;
	if (retry) out.retries = [];
	// The last good reply's prompt plus output: the fallback estimate for an
	// attempt no completed reply followed.
	let lastPromptPlusOutput = 0;
	// Retried attempts not yet followed by a completed reply.
	let streak: StreakEntry[] = [];
	const error = (message: string) => out.errors.push(`${who}: ${message}`);
	const note = (message: string) => out.notes.push(`${who}: ${message}`);
	const fail = (reason: string) => {
		out.providerErrors.push(`${who}: ${reason}`);
		out.observations.push({ id: `${childKey}/unaccounted:${out.providerErrors.length}`, origin: "worker" });
	};
	/** One provider call's observation, checked the way the parent's are. */
	const meter = (id: string, raw: unknown, label: string, completed: boolean, missing = "reports no usage"): Partial<UsageTotals> | undefined => {
		const usage = normalizePiUsage(raw);
		const costUsd = piCostUsd(raw);
		out.observations.push({ id: `${childKey}/${id}`, origin: "worker", ...(usage ? { usage } : {}), ...(costUsd === undefined ? {} : { costUsd }) });
		if (!usage) error(`${label} ${missing}`);
		else if (!hasCompleteUsage(usage)) error(`${label} reports incomplete usage`);
		else {
			const defect = usageDefect(usage, completed);
			if (defect) error(`${label} reports ${defect}`);
		}
		return usage;
	};

	if (!sessionJsonl?.trim()) {
		error("session.jsonl is missing or empty");
		return out;
	}
	const rows: Array<{ line: number; row: Row }> = [];
	for (const [index, line] of sessionJsonl.split("\n").entries()) {
		if (!line.trim()) continue;
		let row: unknown;
		try { row = JSON.parse(line); } catch { row = undefined; }
		if (isRow(row) && typeof row.type === "string") rows.push({ line: index + 1, row });
		else error(`session line ${index + 1} is not a JSON entry`);
	}
	const header = rows[0]?.row;
	if (header?.type !== "session") error(`first entry is ${String(header?.type ?? "missing")}, not the session header`);
	else {
		if (isName(header.id)) out.sessionId = header.id;
		if (header.version !== 3) error(`session version ${String(header.version)}; this reader knows version 3`);
		if (isName(header.parentSession)) error(`session forks ${header.parentSession}; its copied history would book the parent's replies again`);
	}

	const entryIds = new Set<string>();
	const responseIds = new Set<string>();
	const calls = new Map<string, ChildToolCall>();
	// The last reply: whether it is the empty reply of an abort that never became
	// a request, and which tool calls it made, decide how the session ended.
	let last: { id: string; observation: number; empty: boolean; calls: ChildToolCall[] } | undefined;
	// A failed or truncated reply whose meaning depends on what follows it.
	let pending: {
		id: string; stopReason: string; errorMessage?: string; entryId: string; usage?: Partial<UsageTotals>; provider?: string;
		/** The fallback estimate as it stood when this reply failed. */
		fallback: number;
	} | undefined;
	let compactedSincePending = false;
	// Whether a context_edit omitted the pending reply's entry outright. The file
	// has no auto_retry events, so this omission is the only mark pi's retry
	// leaves (agent-session.js _omitRecoveryAttempt). An edit that replaces the
	// entry (an extension's boundary draft) is not one.
	let omittedPending = false;
	const settle = (retried: boolean) => {
		if (!pending) return;
		// pi's retry and its overflow recovery leave the same omission, and pi
		// picks one by the failed reply's text. Read that way, a threshold
		// compaction pi runs before the retried request (agent-session.js
		// _compactBeforeNextAssistantResponse) does not turn a retry into an
		// overflow recovery.
		const piRetried = retry && omittedPending && pending.stopReason === "error" && piRetries(pending);
		if (piRetried) {
			const meteredTokens = pending.usage && reportsSpend(pending.usage) ? num(pending.usage.totalTokens) : 0;
			const attempt: RetriedAttempt = {
				id: `${childKey}/${pending.id}`, origin: "worker", ...(pending.errorMessage === undefined ? {} : { errorMessage: pending.errorMessage }),
				recovered: false, meteredTokens, ...fallbackEstimate(meteredTokens, pending.fallback),
			};
			out.retries!.push(attempt);
			if (retried) {
				streak.push({ attempt, sameContext: !compactedSincePending });
				note(`assistant reply ${pending.id} failed (${pending.errorMessage || "provider error"}); pi omitted it and retried the turn`);
			} else {
				// The session ended during the backoff: listed and counted, as the
				// parent's cancelled attempt is, and the worker failed.
				fail(`assistant reply ${pending.id} failed: ${pending.errorMessage || "provider error"}; pi's retry of it never ran`);
			}
		} else if (retried && compactedSincePending) {
			out.recoveredOverflows++;
			note(`assistant reply ${pending.id} (${pending.stopReason}) overflowed the context; a compaction recovered it and the turn was retried`);
		} else if (pending.stopReason === "error") fail(`assistant reply ${pending.id} failed: ${pending.errorMessage || "provider error"}`);
		pending = undefined;
	};
	for (const [position, { line, row }] of rows.entries()) {
		if (row.type === "session") {
			if (position > 0) error(`line ${line} is a second session header`);
			continue;
		}
		if (!isName(row.id)) {
			error(`line ${line} (${String(row.type)}) has no entry ID`);
			continue;
		}
		if (entryIds.has(row.id)) error(`entry ID ${row.id} appears twice`);
		entryIds.add(row.id);
		switch (row.type) {
			case "message": {
				const message = row.message;
				if (!isRow(message)) {
					error(`message entry ${row.id} carries no message`);
					break;
				}
				if (message.role === "toolResult") {
					const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
					if (call) {
						call.isError = message.isError === true;
						call.resultText = contentText(message.content);
						call.details = message.details;
					}
					if (reportsSpend(message.usage)) error(`tool result ${String(message.toolName)} reports provider usage outside this accounting`);
					break;
				}
				if (message.role !== "assistant") break;
				settle(true);
				const turn = ++out.turns;
				const stopReason = typeof message.stopReason === "string" ? message.stopReason : "missing";
				let id: string;
				if (isName(message.responseId)) {
					id = message.responseId;
					// A session file holds each reply once; a second entry with the same
					// ID is either a copy (double count) or a second call (merged away).
					if (responseIds.has(id)) error(`responseId ${id} names two replies`);
					responseIds.add(id);
				} else {
					// The entry ID is unique within the file, so it is an honest identity.
					id = `entry:${row.id}`;
					out.missingResponseIds++;
					note(`assistant reply ${turn} has no responseId; counted as ${id}`);
				}
				const usage = meter(id, message.usage, `assistant reply ${id} (${stopReason})`, COMPLETED_STOPS.has(stopReason), "carries no usage");
				const content = Array.isArray(message.content) ? message.content : [];
				last = {
					id, observation: out.observations.length - 1, calls: [],
					empty: content.every((part) => isRow(part) && part.type === "text" && !String(part.text ?? "").trim()) && !reportsSpend(message.usage) && Boolean(usage),
				};
				if (usage) {
					out.replyUsage.input += num(usage.inputTokens);
					out.replyUsage.output += num(usage.outputTokens);
					out.replyUsage.cacheRead += num(usage.cacheReadTokens);
					out.replyUsage.cacheWrite += num(usage.cacheWriteTokens);
				}
				if (typeof message.provider === "string" && typeof message.model === "string") {
					const model = `${message.provider}/${message.model}`;
					if (!out.models.includes(model)) out.models.push(model);
				}
				for (const part of content) {
					if (!isRow(part) || part.type !== "toolCall" || !isName(part.id) || typeof part.name !== "string") continue;
					const call: ChildToolCall = { turn, id: part.id, name: part.name, arguments: isRow(part.arguments) ? part.arguments : {} };
					out.toolCalls.push(call);
					last.calls.push(call);
					calls.set(part.id, call);
				}
				out.finalText = contentText(message.content);
				out.finalStop = stopReason;
				if (stopReason === "aborted") fail(`assistant reply ${id} was aborted`);
				else if (stopReason === "error" || stopReason === "length") {
					pending = {
						id, stopReason, entryId: row.id, fallback: lastPromptPlusOutput, ...(usage ? { usage } : {}),
						...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
						...(typeof message.provider === "string" ? { provider: message.provider } : {}),
					};
					compactedSincePending = false;
					omittedPending = false;
				} else if (!COMPLETED_STOPS.has(stopReason)) error(`assistant reply ${id} ended with unexpected stopReason ${stopReason}`);
				if (retry && stopReason !== "error" && usage && reportsSpend(usage)) lastPromptPlusOutput = promptPlusOutput(usage);
				if (retry && COMPLETED_STOPS.has(stopReason)) {
					recoverStreak(streak, promptOf(usage));
					streak = [];
				}
				break;
			}
			case "compaction": {
				out.compactions++;
				compactedSincePending = pending !== undefined;
				const usage = meter(`compaction:${row.id}`, row.usage, `compaction ${row.id}`, true);
				if (retry) {
					// The next prompt carries the summary, not the history it replaced:
					// neither the previous reply nor the recovering one sizes an
					// attempt made before this point.
					lastPromptPlusOutput = num(usage?.outputTokens);
					for (const entry of streak) entry.sameContext = false;
				}
				break;
			}
			case "branch_summary":
				meter(`branch-summary:${row.id}`, row.usage, `branch summary ${row.id}`, true);
				note(`branch summary ${row.id} counted; a foreground child is not expected to branch`);
				break;
			case "usage":
				// pi appends the entry only for a warm that did not fail, so it completed.
				meter(`usage:${row.id}`, row.usage, `usage entry ${row.id} (${String(row.kind)})`, true);
				if (row.kind === "cache_warm") out.cacheWarmings++;
				break;
			case "context_edit":
				out.contextEdits++;
				if (pending && row.targetId === pending.entryId && row.replacement === null) omittedPending = true;
				break;
			case "thinking_level_change":
				if (typeof row.thinkingLevel === "string") out.thinkingLevels.push(row.thinkingLevel);
				break;
			default:
				if (!INERT_ENTRY_TYPES.has(row.type as string)) error(`unknown entry type ${String(row.type)} at line ${line}`);
		}
	}
	// The empty `error` reply of an abort that landed between requests: pi built
	// no request for it, so it is neither a failure nor a provider call.
	if (last && pending?.id === last.id && pending.stopReason === "error" && last.empty && ABORTED_BEFORE_REQUEST.test(pending.errorMessage ?? "")) {
		out.observations.splice(last.observation, 1);
		pending = undefined;
		out.ending = "aborted-between-requests";
		note(`assistant reply ${last.id} is the empty reply pi writes when a run is aborted before its next request is sent; no provider call was made for it, so it is not counted`);
	}
	settle(false);
	if (out.finalStop === "stop" || out.finalStop === "length") out.ending = "handoff";
	else if (out.finalStop === "toolUse" && last?.calls.length && last.calls.every((c) => c.isError === true && PIRED_BUDGET_STOP.test(c.resultText ?? ""))) {
		out.ending = "budget-stop";
		note(`the session ends on pired's turn-budget stop after ${out.turns} replies; every call it made is answered in the file`);
	}
	if (out.turns === 0) error("no assistant reply in the session");
	else if (out.ending === "cut-off") error(`final assistant reply ended with ${out.finalStop}, not stop or length`);
	return out;
}

/** Ledger IDs a successful `record` call wrote or matched: `details.ids`, or `details.id` for a single row. */
export function childRecordIds(call: ChildToolCall): string[] {
	if (call.name !== "record" || call.isError !== false || !isRow(call.details)) return [];
	const ids = Array.isArray(call.details.ids) ? call.details.ids.filter(isName) : [];
	if (isName(call.details.id) && !ids.includes(call.details.id)) ids.push(call.details.id);
	return ids;
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 300) ?? "";

/**
 * How a child ended, from its pi-subagents row. A child listed only on a
 * progress update belongs to a call that ended in error, so it failed even when
 * that update was sent before the failure and still says exit 0.
 */
function childStatus(row: Row, source: SubagentChild["source"]): ChildStatus {
	if (row.detached === true) return "detached";
	if (row.interrupted === true) return "interrupted";
	if (row.timedOut === true) return "timed-out";
	if (row.stopped === true) return "stopped";
	return source === "result" && row.exitCode === 0 && !isName(row.error) ? "completed" : "failed";
}

const relative = (path: string): string => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");

/**
 * Match every `subagent` call to the child sessions on disk, one file per child.
 *
 * pi-subagents 0.71 writes a foreground child's session at
 * `<sessionRoot>/<runId>/run-<index>/session.jsonl`, where `sessionRoot` is the
 * configured `defaultSessionDir` (subagent-executor.js 6691-6724), and reports
 * that path as `details.results[].sessionFile` once the file exists
 * (execution.js 1873). `details.runId` names the call's run and `index` is each
 * child's launch-order identity (types.d.ts `SingleResult`), so the key
 * `<runId>/run-<index>` is derived from structured fields, never from prose.
 * `childSessionFiles` lists every file under the pinned directory, relative to it.
 *
 * A call that ends in error has lost its details: pi-subagents throws on any
 * `isError` result (tool-result.js `finalizeToolResult`) and pi keeps only the
 * message. Measured on faux runs: `details: {}` both for a child whose second
 * reply was a 529 and for one that returned an empty answer after three
 * replies, with each child's session on disk. The children of such a call are
 * read from its last `tool_execution_update`, which still carries the run ID
 * and each child's row (measured: `exitCode: 1`, progress `failed`). A call
 * rejected before launch (unknown agent, the scope gate, argument validation)
 * sends no update and names no child.
 *
 * Each of these makes the run unscoreable:
 * - a call that never ended, ended twice, or has lifecycle events out of order;
 * - an async launch (`details.asyncId`): the child runs after the call returns,
 *   so its spend lands outside the parent's transcript. Measured: pi-subagents'
 *   built-in `claude-code` agent launched that way, with `results: []`;
 * - a launched child without a run ID and index, or claimed by two calls;
 * - a child whose session is not in the pinned directory, or whose reported
 *   path is not the pinned one (a fork's session lives beside the parent's);
 * - a child with no session file. pi writes the file with the first reply, so
 *   such a child never got one: a harness failure (a missing tool, an
 *   unresolvable model), not the candidate's behaviour;
 * - a session file no call claims.
 *
 * `subagents_enable` and management actions (`action: "list"`, `"status"`, ...)
 * launch nothing and are ordinary parent tool calls.
 */
export function reconcileSubagentCalls(parentEvents: Row[], childSessionFiles: string[], options: { sessionDir?: string; toolName?: string } = {}): SubagentReconciliation {
	const toolName = options.toolName ?? SUBAGENT_TOOL;
	const errors: string[] = [];
	const notes: string[] = [];
	type Track = { args: Row; lastUpdate?: Row; end?: Row; ends: number };
	const tracks = new Map<string, Track>();
	for (const event of parentEvents) {
		if (event.toolName !== toolName) continue;
		if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") continue;
		const id = event.toolCallId;
		if (!isName(id)) {
			errors.push(`${toolName} ${event.type} has no toolCallId`);
			continue;
		}
		const track = tracks.get(id);
		if (event.type === "tool_execution_start") {
			if (track) errors.push(`${toolName} call ${id} started twice`);
			else tracks.set(id, { args: isRow(event.args) ? event.args : {}, ends: 0 });
			continue;
		}
		if (!track) {
			errors.push(`${toolName} call ${id} ${event.type === "tool_execution_end" ? "ended" : "updated"} without starting`);
			continue;
		}
		if (event.type === "tool_execution_update") {
			if (track.end) errors.push(`${toolName} call ${id} updated after it ended`);
			else if (isRow(event.partialResult) && isRow(event.partialResult.details)) track.lastUpdate = event.partialResult.details;
			continue;
		}
		if (++track.ends > 1) errors.push(`${toolName} call ${id} ended twice`);
		else track.end = event;
	}

	const sessionDir = options.sessionDir?.replace(/\/+$/, "");
	const files = new Set(childSessionFiles.map(relative));
	const claims = new Map<string, string>();
	const calls: SubagentCall[] = [];
	const children: SubagentChild[] = [];
	for (const [id, track] of tracks) {
		const args = track.args;
		const call: SubagentCall = {
			toolCallId: id, isError: track.end?.isError === true,
			...(isName(args.agent) ? { requestedAgent: args.agent } : {}),
			...(isName(args.action) ? { action: args.action } : {}),
			...(typeof args.task === "string" ? { task: args.task } : {}),
			async: args.async === true, children: [], resultText: "",
		};
		calls.push(call);
		if (!track.end) {
			errors.push(`${toolName} call ${id} never ended`);
			continue;
		}
		const result = isRow(track.end.result) ? track.end.result : {};
		call.resultText = contentText(result.content);
		const final = isRow(result.details) ? result.details : undefined;
		const finalRows = Array.isArray(final?.results) ? final.results : undefined;
		const source: SubagentChild["source"] = !call.isError || finalRows?.length ? "result" : "update";
		const details = source === "result" ? final : track.lastUpdate;
		const rows: unknown[] = Array.isArray(details?.results) ? details.results : [];
		if (typeof details?.mode === "string") call.mode = details.mode;
		if (isName(details?.runId)) call.runId = details.runId;
		if (isName(final?.asyncId)) call.async = true;

		if (!call.isError && !finalRows && !call.action) errors.push(`${toolName} call ${id} succeeded without a results list`);
		if (call.async && !call.isError) errors.push(`${toolName} call ${id} launched async run ${String(final?.asyncId ?? call.runId ?? "?")}; its children run after the call returns, outside this accounting`);
		else if (call.async) notes.push(`${toolName} call ${id} asked for an async run and was rejected`);
		if (call.mode === "workflow") errors.push(`${toolName} call ${id} ran a workflow, which this accounting does not map to child sessions`);
		if (call.isError && rows.length === 0) notes.push(`${toolName} call ${id} was rejected before launching a child: ${firstLine(call.resultText)}`);

		for (const raw of rows) {
			if (!isRow(raw)) {
				errors.push(`${toolName} call ${id} lists a child that is not an object`);
				continue;
			}
			const agent = isName(raw.agent) ? raw.agent : "(unnamed)";
			const index = raw.index;
			if (!call.runId || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
				errors.push(`${toolName} call ${id} launched ${agent} without a run ID and index, so its session cannot be found`);
				continue;
			}
			const childKey = `${call.runId}/run-${index}`;
			const sessionPath = `${childKey}/session.jsonl`;
			const status = childStatus(raw, source);
			const errorText = isName(raw.error) ? raw.error : status === "completed" ? undefined : firstLine(call.resultText) || undefined;
			const usage = isRow(raw.usage) ? raw.usage : undefined;
			const child: SubagentChild = {
				toolCallId: id, runId: call.runId, index, childKey, sessionPath, agent, status, source,
				...(typeof raw.exitCode === "number" ? { exitCode: raw.exitCode } : {}),
				...(errorText ? { error: errorText } : {}),
				...(isName(raw.model) ? { model: raw.model } : {}),
				...(isName(raw.thinking) ? { thinking: raw.thinking } : {}),
				...(usage ? { usage: { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), turns: num(usage.turns) } } : {}),
				...(isName(raw.sessionFile) ? { reportedSessionFile: raw.sessionFile } : {}),
				sessionFound: files.has(sessionPath),
			};
			const prior = claims.get(sessionPath);
			if (prior !== undefined) {
				errors.push(`child ${childKey} is claimed by ${toolName} calls ${prior} and ${id}`);
				continue;
			}
			claims.set(sessionPath, id);
			if (child.reportedSessionFile) {
				const pinned = sessionDir ? child.reportedSessionFile === `${sessionDir}/${sessionPath}` : child.reportedSessionFile.endsWith(`/${sessionPath}`);
				if (!pinned) errors.push(`child ${childKey} reports its session at ${child.reportedSessionFile}, not the pinned ${sessionDir ?? "<session dir>"}/${sessionPath}`);
			}
			if (!child.sessionFound) {
				const tokens = child.usage ? child.usage.input + child.usage.output + child.usage.cacheRead + child.usage.cacheWrite : 0;
				errors.push(tokens > 0
					? `child ${childKey} (${agent}) has no session at ${sessionPath}, yet pi-subagents reports ${tokens} tokens for it`
					: `child ${childKey} (${agent}) has no session at ${sessionPath}: it ended ${status} before its first reply${child.error ? ` (${firstLine(child.error)})` : ""}`);
			}
			call.children.push(child);
			children.push(child);
		}
	}
	for (const file of files) if (!claims.has(file)) errors.push(`session file ${file} is claimed by no ${toolName} call`);
	return { calls, children, errors, notes };
}

/**
 * What a child's run amounts to (ChildOutcome), from pi-subagents' row and the
 * way its session ended.
 *
 * A bounded stop needs evidence from both sides. The session shows the spend is
 * whole; the row, which the parent's transcript carries and the sealed process
 * cannot rewrite, shows the bound actually fired: pired's stop text in the row's
 * error for the turn budget, pi-subagents' `timedOut` flag for the timeout. A
 * session that claims one without the other is unaccounted.
 */
export function childOutcome(child: Pick<SubagentChild, "status" | "error">, session: ChildSessionExtraction): { outcome: ChildOutcome; why?: string } {
	if (child.status === "interrupted" || child.status === "detached" || child.status === "stopped") {
		const why = child.status === "detached" ? "it kept running outside the call"
			: child.status === "interrupted" ? "it was paused mid-run"
			: "it was cut off before completion";
		return { outcome: "unaccounted", why: `ended ${child.status}; ${why}, so its session is not its whole spend` };
	}
	switch (session.ending) {
		case "handoff":
			return { outcome: child.status === "completed" ? "completed" : child.status === "timed-out" ? "incomplete" : "failed" };
		case "budget-stop":
			// The timeout can also fire in the moments between the stop and pi-subagents settling the child.
			return PIRED_BUDGET_STOP.test(child.error ?? "") || child.status === "timed-out"
				? { outcome: "incomplete" }
				: { outcome: "unaccounted", why: `its session ends on pired's turn-budget stop, but pi-subagents' row in the parent's transcript does not report that stop (it ended ${child.status}${child.error ? `: ${firstLine(child.error)}` : ""})` };
		case "aborted-between-requests":
			return child.status === "timed-out"
				? { outcome: "incomplete" }
				: { outcome: "unaccounted", why: `its session ends on a run aborted between requests, but pi-subagents reports it ${child.status}, not timed out` };
		default:
			// The session's own errors say how it was cut off.
			return { outcome: "unaccounted" };
	}
}

/**
 * Whether one child leaves its run scoreable.
 *
 * - `completed` is accepted.
 * - `failed` is accepted when the session accounts for every call. A provider
 *   failure already fails the session (an `error` or `aborted` reply), so what
 *   remains is a child that made its calls and then failed on its own terms: an
 *   empty final answer, a last tool error. That is the candidate's outcome, and
 *   rejecting it would keep only the runs whose workers went well.
 * - A child stopped by pired's turn budget or by pi-subagents' worker timeout is
 *   accepted as `incomplete` when every request it sent is answered in its
 *   session (childOutcome). Rejected, one looping worker ended the whole grid:
 *   the run was invalid for a non-infrastructure reason, the runner stopped
 *   launching pairs, and a resume of the official grid refused.
 * - `interrupted`, `detached` and `stopped` are rejected: the child is paused,
 *   still running, or was cut off, so its remaining spend is not in the file.
 *   So is a timeout that fired during a request: that request's reply never
 *   reached the file, or reached it as `aborted` with unknown spend.
 *
 * pi-subagents' row is carried by the parent's transcript, which the sealed
 * process cannot rewrite; the session is written from inside the seal. So the
 * row's reply count and token sums must match the session. The exception is a
 * session with compactions or context edits: pi-subagents re-sums the agent's
 * in-memory messages (usage-reconciliation.js), which both rewrite. Measured on
 * a faux child: 3 replies and 1,515 + 43 + 2,966 + 1,515 tokens on both sides.
 *
 * `expect` names the parent's model and thinking level; a child on another is a
 * different experiment and its tokens do not compare.
 */
export function reconcileChildSession(child: SubagentChild, session: ChildSessionExtraction | undefined, expect: { model?: string; thinking?: string } = {}): ChildVerdict {
	const errors: string[] = [];
	const notes: string[] = [];
	const who = `child ${child.childKey} (${child.agent})`;
	if (!session) return { accepted: false, errors: [`${who}: no session to account`], notes };
	const clean = session.errors.length === 0 && session.providerErrors.length === 0;
	const ended = childOutcome(child, session);
	if (ended.why) errors.push(`${who}: ${ended.why}`);
	else if (clean && ended.outcome !== "completed" && ended.outcome !== "unaccounted") {
		const bound = session.ending === "budget-stop" ? "stopped by pired's turn budget"
			: child.status === "timed-out" ? "stopped by pi-subagents' worker timeout"
			: "ended failed";
		notes.push(`${who}: ${bound}${child.error ? ` (${firstLine(child.error)})` : ""}; its session accounts for every call, so its tokens count as ${ended.outcome}`);
	}
	if (child.source === "result" && child.usage) {
		const row = child.usage;
		const file = session.replyUsage;
		const same = row.turns === session.turns && row.input === file.input && row.output === file.output && row.cacheRead === file.cacheRead && row.cacheWrite === file.cacheWrite;
		if (!same) {
			const sum = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => u.input + u.output + u.cacheRead + u.cacheWrite;
			const message = `${who}: pi-subagents reported ${row.turns} replies and ${sum(row)} tokens; the session holds ${session.turns} and ${sum(file)}`;
			if (session.compactions + session.contextEdits > 0) notes.push(`${message} (compactions and context edits rewrite what pi-subagents re-sums)`);
			else errors.push(message);
		}
	}
	if (expect.model) for (const model of session.models) if (model !== expect.model) errors.push(`${who}: replies came from ${model}, not ${expect.model}`);
	if (expect.thinking) {
		if (session.thinkingLevels.length === 0) errors.push(`${who}: its session records no thinking level`);
		for (const level of new Set(session.thinkingLevels)) if (level !== expect.thinking) errors.push(`${who}: ran thinking ${level}, not ${expect.thinking}`);
	}
	const accepted = clean && errors.length === 0 && ended.outcome !== "unaccounted";
	return { accepted, ...(accepted && ended.outcome !== "unaccounted" ? { outcome: ended.outcome } : {}), errors, notes };
}

/**
 * Count provider responses exactly once. Parent session messages and worker
 * response events have separate ledgers, so each gets its own ID namespace.
 * Repeated identical rows are ignored; conflicting or unidentifiable rows make
 * the run invalid instead of silently changing the denominator.
 */
export function accountUsage(observations: UsageObservation[]): UsageAccounting {
	const errors: string[] = [];
	const seen = new Map<string, UsageTotals>();
	const parent = zero();
	const worker = zero();
	let parentRequests = 0;
	let workerRequests = 0;
	let duplicateEvents = 0;
	let costUsd = 0;
	for (const observation of observations) {
		if (!observation.id.trim()) {
			errors.push(`${observation.origin} response is missing a stable ID`);
			continue;
		}
		if (!hasCompleteUsage(observation.usage)) {
			errors.push(`${observation.origin} response ${observation.id} has incomplete usage`);
			continue;
		}
		// The extractors already report this; repeating it here keeps a caller that
		// reads only `valid` from summing a total that drops a frame's missing field.
		// The prompt check needs the stop reason, so it stays with the extractors.
		const defect = usageDefect(observation.usage, false);
		if (defect) errors.push(`${observation.origin} response ${observation.id} reports ${defect}`);
		const key = `${observation.origin}:${observation.id}`;
		const prior = seen.get(key);
		if (prior) {
			if (!sameUsage(prior, observation.usage)) errors.push(`conflicting duplicate usage for ${key}`);
			else duplicateEvents++;
			continue;
		}
		seen.set(key, observation.usage);
		const target = observation.origin === "parent" ? parent : worker;
		for (const k of Object.keys(target) as Array<keyof UsageTotals>) target[k] += observation.usage[k];
		if (observation.origin === "parent") parentRequests++;
		else workerRequests++;
		costUsd += observation.costUsd ?? 0;
	}
	const total = zero();
	for (const k of Object.keys(total) as Array<keyof UsageTotals>) total[k] = parent[k] + worker[k];
	return { valid: errors.length === 0 && seen.size > 0, errors, parent, worker, total, parentRequests, workerRequests, duplicateEvents, costUsd };
}

/**
 * The only grid whose result may be read as the acceptance decision: the five
 * research targets, three fixed passes. A `--only` subset or extra passes still
 * produce a comparison, labelled exploratory, so a favourable slice cannot pass
 * for the corpus result.
 */
export const OFFICIAL_TARGET_IDS: readonly string[] = [
	"CVE-2025-52903", "CVE-2025-62721", "CVE-2022-39281", "CVE-2024-22417", "CVE-2026-40262",
];
export const OFFICIAL_PASSES = 3;

export function isOfficialGrid(expected: ExpectedCell[]): boolean {
	const want = new Set(OFFICIAL_TARGET_IDS.flatMap((target) =>
		Array.from({ length: OFFICIAL_PASSES }, (_, i) => `${target}\u0000${i + 1}`)));
	const got = new Set(expected.map((cell) => `${cell.target}\u0000${cell.pass}`));
	return expected.length === want.size && got.size === want.size && [...want].every((cell) => got.has(cell));
}

export type Arm = "baseline" | "candidate";

export interface ScheduledPair {
	index: number;
	target: string;
	pass: number;
	key: string;
	order: [Arm, Arm];
}

/**
 * Pass-major, so pass 1 of every target finishes before pass 3 of any: a run
 * stopped part-way leaves whole passes, and repetitions of one target are not
 * all in flight together against the same provider window. Arm order flips by
 * pass and target, so each target runs baseline-first and candidate-first.
 */
export function planSchedule(targetIds: string[], passes: number): ScheduledPair[] {
	const pairs: ScheduledPair[] = [];
	for (let pass = 1; pass <= passes; pass++) {
		for (const [t, target] of targetIds.entries()) {
			const baselineFirst = (pass - 1 + t) % 2 === 0;
			pairs.push({
				index: pairs.length, target, pass, key: `${target}#${pass}`,
				order: baselineFirst ? ["baseline", "candidate"] : ["candidate", "baseline"],
			});
		}
	}
	return pairs;
}

/**
 * The circuit breaker's numbers (v6 item 2.3), pinned into the manifest as
 * `breaker` so a resume runs under the rule its grid started with. Without one
 * the runner keeps its fail-fast rule: the first invalid run stops new launches.
 * In the v5 trial that rule let one dropped stream stop a grid, and one pair
 * took 14 attempts across resumes (research/12, *The benchmark's own cost*).
 */
export interface BreakerPolicy {
	/** C: this many launched runs in a row that fail trip the breaker. */
	consecutive: number;
	/** R: a failed share at or above this, over the last `window` launched runs, trips it. */
	rate: number;
	/** N: the runs the rate is read over. It is read only once N runs are in. */
	window: number;
	/** A pair re-queued after its n-th failed attempt in this runner waits n × cooldownMs. */
	cooldownMs: number;
	/** The most attempts one runner makes at a pair; past it only a --resume re-runs the pair. */
	maxAttempts: number;
	/**
	 * K: the highest attempt number a pair may reach, across every resume. A pair
	 * still failing at K is abandoned, and an official grid holding one cannot
	 * approve. Without it an auto-resumer could re-run one pair forever. 16
	 * because v5c Luna's worst pair needed 14 attempts; a ceiling of 4 would have
	 * abandoned 7 of its 15 pairs.
	 */
	attemptCeiling: number;
}

export const DEFAULT_BREAKER: Readonly<BreakerPolicy> = { consecutive: 3, rate: 0.5, window: 8, cooldownMs: 60_000, maxAttempts: 4, attemptCeiling: 16 };

const BREAKER_FIELDS = ["consecutive", "rate", "window", "cooldownMs", "maxAttempts", "attemptCeiling"] as const;

/**
 * Validate a breaker policy read back from a manifest or built from the command
 * line, and return it with its fields in one fixed order, so two manifests
 * holding the same policy compare byte for byte. An unknown field is refused:
 * a misspelt `maxAttempt` read as "use the default" would change the rule
 * without anyone having chosen to.
 */
export function parseBreakerPolicy(value: unknown): BreakerPolicy {
	if (!isRow(value)) throw new Error("the breaker policy is not an object");
	for (const key of Object.keys(value)) if (!(BREAKER_FIELDS as readonly string[]).includes(key)) throw new Error(`the breaker policy has an unknown field: ${key}`);
	const field = (key: typeof BREAKER_FIELDS[number], ok: (n: number) => boolean, what: string): number => {
		const n = value[key];
		if (typeof n !== "number" || !Number.isFinite(n) || !ok(n)) throw new Error(`the breaker policy's ${key} must be ${what}`);
		return n;
	};
	const whole = (min: number) => (n: number): boolean => Number.isSafeInteger(n) && n >= min;
	return {
		consecutive: field("consecutive", whole(1), "an integer of at least 1"),
		rate: field("rate", (n) => n > 0 && n <= 1, "a share above 0 and at most 1"),
		window: field("window", whole(1), "an integer of at least 1"),
		cooldownMs: field("cooldownMs", whole(0), "a non-negative integer of milliseconds"),
		maxAttempts: field("maxAttempts", whole(1), "an integer of at least 1"),
		attemptCeiling: field("attemptCeiling", whole(1), "an integer of at least 1"),
	};
}

/** One launched run, as the breaker sees it. A partner that was not launched is not an event: nothing reached the provider. */
export interface BreakerEvent {
	/** When the run ended; it only dates the trip. */
	atMs: number;
	valid: boolean;
	/** Invalid for an infrastructure reason (the run record's infraFailure). */
	infra: boolean;
	/** A provider quota or usage window is spent. */
	exhausted: boolean;
	/** Invalid for a non-infrastructure reason in an official grid: that pair stays invalid, so the grid cannot approve. */
	blocked: boolean;
}

export interface BreakerVerdict { tripped: boolean; reason?: string }

/**
 * The circuit breaker that replaces fail-fast when a grid names a policy. It
 * trips at once on a spent quota, since nothing launched before the reset can
 * succeed, and on a blocked run, since the official decision is then already
 * incomplete_or_invalid and every further pair would spend tokens on a fixed
 * outcome. Otherwise it trips when `consecutive` launched runs in a row fail,
 * or when at least a `rate` share of the last `window` launched runs failed,
 * read only once the window is full: two drops in the first three runs are a
 * 67% rate that says nothing yet. A valid run ends the streak.
 *
 * Every failed launch counts, whatever its cause. In an official grid a
 * failure that is not infrastructure is blocked and has already tripped it, so
 * what is left to count there is infrastructure. In an exploratory grid it is
 * not blocked, and counting only infrastructure let a candidate that times out
 * every run spend the whole grid, and let timeouts between drops dilute the
 * rate below R. The reason says how many of the failures were infrastructure.
 * Once tripped it stays tripped. Pure: it keeps its own counts and reads no clock.
 */
export function createBreaker(policy: BreakerPolicy): { record(event: BreakerEvent): BreakerVerdict; readonly verdict: BreakerVerdict } {
	let streak = 0;
	let streakInfra = 0;
	const recent: Array<{ failed: boolean; infra: boolean }> = [];
	let verdict: BreakerVerdict = { tripped: false };
	const trip = (why: string, atMs: number): BreakerVerdict => {
		verdict = { tripped: true, reason: Number.isFinite(atMs) ? `${why} (at ${new Date(atMs).toISOString()})` : why };
		return verdict;
	};
	return {
		get verdict() { return verdict; },
		record(event: BreakerEvent): BreakerVerdict {
			if (verdict.tripped) return verdict;
			if (event.exhausted) return trip("the provider's quota or usage window is spent", event.atMs);
			if (event.blocked) return trip("a run of this official grid is invalid for a non-infrastructure reason, so its decision is already incomplete_or_invalid", event.atMs);
			const failed = !event.valid;
			const infra = failed && event.infra;
			recent.push({ failed, infra });
			if (recent.length > policy.window) recent.shift();
			if (failed) { streak++; if (infra) streakInfra++; } else { streak = 0; streakInfra = 0; }
			if (streak >= policy.consecutive) return trip(`${streak} consecutive launched runs failed (${streakInfra} infrastructure)`, event.atMs);
			const failures = recent.filter((r) => r.failed).length;
			if (recent.length === policy.window && failures / policy.window >= policy.rate) {
				return trip(`${failures} of ${policy.window} launched runs failed (${recent.filter((r) => r.infra).length} infrastructure), at or above the ${policy.rate} rate`, event.atMs);
			}
			return verdict;
		},
	};
}

/** One arm's run at a pair's attempt, as the pairing rule reads it. */
export interface ArmResult { valid: boolean; infra: boolean }

export type PairAction =
	| { kind: "keep" }
	| { kind: "blocked"; reason: string }
	| { kind: "rerun"; attempt: number; notBeforeMs: number; reason: string }
	| { kind: "give-up"; reason: string }
	| { kind: "abandoned"; reason: string };

/** The rules a grid with a breaker adds to the pairing rule. */
export interface PairRules {
	/** K, the policy's attemptCeiling. Absent for a grid without a breaker, which has no ceiling. */
	attemptCeiling?: number;
	/** The runner's own re-queue. Absent for planResume. */
	requeue?: RequeueContext;
}

/** What a runner that re-queues pairs itself adds: its policy, the time, and how often it has launched this pair. */
export interface RequeueContext {
	policy: Pick<BreakerPolicy, "cooldownMs" | "maxAttempts">;
	atMs: number;
	/** Attempts at this pair launched by this runner, the one that just ended included. */
	attemptsThisRun: number;
}

/**
 * What happens to a pair after its `attempt` (0 when it has no run), judged
 * from both arms' runs at that attempt only. Shared by planResume, which asks
 * between runners, and by the runner, which asks as each pair ends when the
 * grid has a breaker. The pairing rule is the same for both: a pair counts
 * only when both arms are valid at the same attempt, so anything else re-runs
 * both arms.
 *
 * - An arm invalid for a non-infrastructure reason blocks the pair. It is never
 *   re-run: that would chase a candidate defect with more tokens, and select
 *   the arm by its survival.
 * - An arm missing, or invalid for an infrastructure reason, re-runs the pair
 *   at attempt + 1, unless the attempt is already the ceiling K: then the pair
 *   is abandoned, for planResume and the runner alike, so an auto-resume loop
 *   ends. With a requeue context the runner first waits cooldownMs × its own
 *   attempt count, and gives up at maxAttempts, leaving the pair for --resume:
 *   in v5 one pair took 14 attempts, and a pair that keeps failing while the
 *   rest of the grid passes is a question for the operator.
 */
export function nextPairAction(attempt: number, arms: ReadonlyArray<ArmResult | undefined>, rules: PairRules = {}): PairAction {
	if (arms.some((r) => r && !r.valid && !r.infra)) {
		return { kind: "blocked", reason: `attempt ${attempt}: an arm is invalid for a non-infrastructure reason; it stays invalid` };
	}
	const missing = arms.some((r) => !r);
	if (!missing && arms.every((r) => r?.valid)) return { kind: "keep" };
	const reason = missing
		? (attempt === 0 ? "the pair has no run yet" : `attempt ${attempt}: an arm has no run at that attempt`)
		: `attempt ${attempt}: an arm failed for an infrastructure reason`;
	if (rules.attemptCeiling !== undefined && attempt >= rules.attemptCeiling) {
		return { kind: "abandoned", reason: `${reason}; ${attempt} is the attempt ceiling of ${rules.attemptCeiling}, so the pair is abandoned and the grid cannot approve` };
	}
	const { requeue } = rules;
	if (!requeue) return { kind: "rerun", attempt: attempt + 1, notBeforeMs: 0, reason };
	if (requeue.attemptsThisRun >= requeue.policy.maxAttempts) {
		return { kind: "give-up", reason: `${reason}; this runner has launched it ${requeue.attemptsThisRun} time(s), the cap of ${requeue.policy.maxAttempts}, so only a --resume re-runs it` };
	}
	return { kind: "rerun", attempt: attempt + 1, notBeforeMs: requeue.atMs + requeue.policy.cooldownMs * requeue.attemptsThisRun, reason };
}

/** Advisory identifiers for one target. The project name is not a label: the source already says it. */
export function leakTermsFor(target: { id: string; aliases?: unknown }): string[] {
	const aliases = Array.isArray(target.aliases) ? target.aliases.map(String) : [];
	return [...new Set([target.id, ...aliases].map((t) => t.trim()).filter(Boolean))];
}

/**
 * Advisory-shaped identifiers, in any separator style and anywhere in a
 * string. The earlier `\b…\b` form missed `run_CVE-2025-52903` (no word
 * boundary between `_` and `C`) and stopped at the first match, so a second
 * advisory after the target's own went unreported.
 */
const ADVISORY_ID = /CVE[-_ ]?\d{4}[-_ ]?\d{4,}|GHSA(?:[-_ ]?[23456789cfghjmpqrvwx]{4}){3}/gi;
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Every string the host hands the sealed process — paths, engagement name,
 * config, environment — checked for this target's advisory IDs and for any
 * advisory-shaped identifier at all. Returns `label: term` per hit.
 */
export function findLeaks(haystacks: Record<string, string>, terms: string[]): string[] {
	const hits: string[] = [];
	// Separator-blind matching only for identifier-length terms: `cve_2025_52903`
	// is the same leak, but a short alias squashed this way would match anywhere.
	const wanted = terms.filter((term) => term.trim()).map((term) => ({ term, lower: term.toLowerCase(), key: squash(term) }));
	for (const [label, text] of Object.entries(haystacks)) {
		const lower = text.toLowerCase();
		const flat = squash(text);
		const found = new Set<string>();
		for (const { term, lower: t, key } of wanted) if (lower.includes(t) || (key.length >= 8 && flat.includes(key))) found.add(term);
		for (const [match] of text.matchAll(ADVISORY_ID)) if (!wanted.some(({ key }) => key === squash(match))) found.add(match);
		for (const term of found) hits.push(`${label}: ${term}`);
	}
	return hits;
}

export interface RunMetric {
	key: string;
	target: string;
	pass: number;
	valid: boolean;
	truePositives: number;
	precision: number;
	totalClaims: number;
	totalTokens: number;
}

export interface RangeMean { mean: number; min: number; max: number; n: number }

export interface ExpectedCell { key: string; target: string; pass: number }

function stats(xs: number[]): RangeMean {
	return {
		mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
		min: xs.length ? Math.min(...xs) : 0,
		max: xs.length ? Math.max(...xs) : 0,
		n: xs.length,
	};
}

/**
 * The acceptance margin, fixed with the user on 2026-09-23 before any scored run
 * (ADR-026). The earlier rule, "no lower observed mean on every target", was
 * simulated on the research's own per-target runs: it approved a candidate of
 * identical quality in 0.7% of two-model grids, so a rejection carried no
 * information. At 85% the same simulation approves an identical candidate in
 * about 62% of grids, one with 15% fewer true positives in about 15%, and one
 * with 25% fewer in about 3%. Three passes cannot separate those further; the
 * margin states which error the experiment prefers, it does not remove them.
 */
export const QUALITY_MARGIN = 0.85;

export const APPROVAL_DECISION = "candidate_fewer_tokens_within_quality_margin";

export type ComparisonDecision =
	| typeof APPROVAL_DECISION
	| "quality_below_margin"
	| "no_token_reduction"
	| "quality_below_margin_and_no_token_reduction"
	| "exploratory_not_decisive"
	| "incomplete_or_invalid";

export interface ArmSummary {
	/** True positives pooled over each complete pass's targets, ranged across passes. */
	truePositives: RangeMean;
	/** Each pass's pooled TP/claims, ranged across passes. Reported, not gated. */
	precision: RangeMean;
	/** Parent + worker + compaction tokens pooled per pass, ranged across passes. */
	totalTokens: RangeMean;
	/** ΣTP/Σclaims over the whole grid, the research's definition; null when nothing was claimed. */
	pooledPrecision: number | null;
	claims: number;
}

export interface TargetSide {
	truePositives: RangeMean;
	claims: number;
	/** ΣTP/Σclaims over this target's passes; null when nothing was claimed, never 0. */
	pooledPrecision: number | null;
	totalTokens: RangeMean;
}

export interface QualityGate {
	margin: number;
	/** Candidate pass-mean TP must reach this: margin × baseline pass-mean TP. */
	truePositiveFloor: number;
	/** Candidate pooled precision must reach this; null when the baseline claimed nothing. */
	precisionFloor: number | null;
	/** null when the grid is incomplete: not evaluated, which is not the same as failed. */
	truePositivesWithinMargin: boolean | null;
	precisionWithinMargin: boolean | null;
	/** Targets where every candidate pass found fewer TP than the worst baseline pass. */
	targetsBelowBaselineRange: string[];
	qualityWithinMargin: boolean | null;
}

export interface MatchedComparison {
	complete: boolean;
	/** The exact five-target, three-pass grid. Anything else is exploratory. */
	official: boolean;
	missingOrInvalid: string[];
	pairedRuns: number;
	baseline: ArmSummary;
	candidate: ArmSummary;
	pairedDelta: { truePositives: RangeMean; precision: RangeMean; totalTokens: RangeMean };
	targets: Array<{ target: string; baseline: TargetSide; candidate: TargetSide; candidateRangeBelowBaseline: boolean }>;
	gate: QualityGate;
	meanTokenReductionObserved: boolean;
	tokenRangesSeparated: boolean;
	decision: ComparisonDecision;
}

/** Float sums in a different order must not turn a tie into a loss. */
const TIE = 1e-9;

export function compareMatchedRuns(baselineRuns: RunMetric[], candidateRuns: RunMetric[], expectedCells: ExpectedCell[]): MatchedComparison {
	const expected = expectedCells.map((cell) => cell.key).sort();
	const expectedByKey = new Map(expectedCells.map((cell) => [cell.key, cell]));
	const expectedGrid = new Set(expectedCells.map((cell) => `${cell.target}\u0000${cell.pass}`));
	const expectedTargets = new Set(expectedCells.map((cell) => cell.target));
	const expectedPasses = new Set(expectedCells.map((cell) => cell.pass));
	const expectedIsRectangular = expected.length > 0 && expectedByKey.size === expected.length &&
		expectedGrid.size === expectedTargets.size * expectedPasses.size;
	const duplicates = (runs: RunMetric[]): string[] => {
		const seen = new Set<string>();
		const repeated = new Set<string>();
		for (const run of runs) { if (seen.has(run.key)) repeated.add(run.key); seen.add(run.key); }
		return [...repeated].sort();
	};
	const bDuplicates = duplicates(baselineRuns);
	const cDuplicates = duplicates(candidateRuns);
	const b = new Map(baselineRuns.map((r) => [r.key, r]));
	const c = new Map(candidateRuns.map((r) => [r.key, r]));
	const unexpected = [
		...baselineRuns.filter((r) => !expected.includes(r.key)).map((r) => `baseline unexpected ${r.key}`),
		...candidateRuns.filter((r) => !expected.includes(r.key)).map((r) => `candidate unexpected ${r.key}`),
		...bDuplicates.map((key) => `baseline duplicate ${key}`),
		...cDuplicates.map((key) => `candidate duplicate ${key}`),
	];
	const metricIsValid = (r: RunMetric | undefined, key: string, arm: string): boolean => {
		if (!r?.valid) return false;
		const descriptor = expectedByKey.get(key);
		if (!descriptor || descriptor.target !== r.target || descriptor.pass !== r.pass) {
			unexpected.push(`${arm} identity mismatch ${key}`);
			return false;
		}
		const values = [r.truePositives, r.precision, r.totalClaims, r.totalTokens];
		if (values.some((n) => !Number.isFinite(n) || n < 0) || r.precision > 1 || r.truePositives > r.totalClaims) {
			unexpected.push(`${arm} invalid metric values ${key}`);
			return false;
		}
		// A scored run made at least one provider call, which read a prompt. Zero
		// is what an empty or lost usage ledger sums to, and it would enter the
		// token mean as the cheapest run in the grid.
		if (r.totalTokens <= 0) {
			unexpected.push(`${arm} reports no tokens ${key}`);
			return false;
		}
		const expectedPrecision = r.totalClaims === 0 ? 0 : r.truePositives / r.totalClaims;
		if (Math.abs(r.precision - expectedPrecision) > 1e-6) {
			unexpected.push(`${arm} inconsistent precision ${key}`);
			return false;
		}
		return true;
	};
	const invalidKeys = expected.filter((key) => {
		const baselineValid = metricIsValid(b.get(key), key, "baseline");
		const candidateValid = metricIsValid(c.get(key), key, "candidate");
		return !baselineValid || !candidateValid;
	});
	const missingOrInvalid = [
		...invalidKeys,
		...unexpected,
		...(!expectedIsRectangular ? ["expected target/pass grid is duplicated or incomplete"] : []),
	];
	const pairs = expected.flatMap((key) => {
		const left = b.get(key);
		const right = c.get(key);
		const descriptor = expectedByKey.get(key);
		const baselineValid = metricIsValid(left, key, "baseline");
		const candidateValid = metricIsValid(right, key, "candidate");
		return baselineValid && candidateValid && left && right && descriptor && left.target === right.target && left.pass === right.pass
			? [{ left, right }]
			: [];
	});
	const targetSet = new Set(pairs.map(({ left }) => left.target));
	const passSet = new Set(pairs.map(({ left }) => left.pass));
	const observedGrid = new Set(pairs.map(({ left }) => `${left.target}\u0000${left.pass}`));
	const uniformGrid = [...expectedGrid].every((cell) => observedGrid.has(cell)) && observedGrid.size === expectedGrid.size &&
		[...passSet].every((pass) => pairs.filter(({ left }) => left.pass === pass).length === targetSet.size);
	const complete = expected.length > 0 && missingOrInvalid.length === 0 && pairs.length === expected.length && uniformGrid;
	// The primary range is across complete passes, each pooling all targets. This
	// matches the study's pass-level reporting and avoids presenting 15 target
	// sessions as 15 independent full-corpus replications.
	type Side = "left" | "right";
	const passes = [...passSet].sort((x, y) => x - y);
	const inPass = (pass: number) => pairs.filter(({ left }) => left.pass === pass);
	const sum = (rows: typeof pairs, side: Side, field: "truePositives" | "totalClaims" | "totalTokens") =>
		rows.reduce((n, pair) => n + pair[side][field], 0);
	// Pooled, never a mean of per-run ratios: a zero-claim run counted as 0
	// precision rejected a candidate with the same TP over the same claims, and
	// one lucky 1/1 run approved a candidate that spent four times the claims.
	const ratio = (tp: number, claims: number): number | null => claims > 0 ? tp / claims : null;
	const armSummary = (side: Side): ArmSummary => {
		const claims = sum(pairs, side, "totalClaims");
		return {
			truePositives: stats(passes.map((pass) => sum(inPass(pass), side, "truePositives"))),
			precision: stats(passes.map((pass) => ratio(sum(inPass(pass), side, "truePositives"), sum(inPass(pass), side, "totalClaims")) ?? 0)),
			totalTokens: stats(passes.map((pass) => sum(inPass(pass), side, "totalTokens"))),
			pooledPrecision: ratio(sum(pairs, side, "truePositives"), claims),
			claims,
		};
	};
	const bs = armSummary("left");
	const cs = armSummary("right");
	const targetSide = (rows: typeof pairs, side: Side): TargetSide => ({
		truePositives: stats(rows.map((pair) => pair[side].truePositives)),
		claims: sum(rows, side, "totalClaims"),
		pooledPrecision: ratio(sum(rows, side, "truePositives"), sum(rows, side, "totalClaims")),
		totalTokens: stats(rows.map((pair) => pair[side].totalTokens)),
	});
	const targets = [...targetSet].sort().map((target) => {
		const rows = pairs.filter(({ left }) => left.target === target);
		const baseline = targetSide(rows, "left");
		const candidate = targetSide(rows, "right");
		return { target, baseline, candidate, candidateRangeBelowBaseline: candidate.truePositives.max < baseline.truePositives.min };
	});
	const pairedDelta = {
		truePositives: stats(passes.map((pass) => sum(inPass(pass), "right", "truePositives") - sum(inPass(pass), "left", "truePositives"))),
		precision: stats(passes.map((pass) =>
			(ratio(sum(inPass(pass), "right", "truePositives"), sum(inPass(pass), "right", "totalClaims")) ?? 0) -
			(ratio(sum(inPass(pass), "left", "truePositives"), sum(inPass(pass), "left", "totalClaims")) ?? 0))),
		totalTokens: stats(passes.map((pass) => sum(inPass(pass), "right", "totalTokens") - sum(inPass(pass), "left", "totalTokens"))),
	};
	const truePositiveFloor = QUALITY_MARGIN * bs.truePositives.mean;
	const precisionFloor = bs.pooledPrecision === null ? null : QUALITY_MARGIN * bs.pooledPrecision;
	// An incomplete grid leaves the gate unevaluated rather than failed: a stopped
	// grid whose candidate cleared both floors printed "BELOW" for both.
	const truePositivesWithinMargin = complete ? cs.truePositives.mean >= truePositiveFloor - TIE : null;
	// A candidate that claimed nothing has no precision; it is held to the floor
	// as 0, and its TP of 0 fails the TP floor anyway unless the baseline found nothing.
	const precisionWithinMargin = complete ? precisionFloor === null || (cs.pooledPrecision ?? 0) >= precisionFloor - TIE : null;
	const targetsBelowBaselineRange = targets.filter((t) => t.candidateRangeBelowBaseline).map((t) => t.target);
	const gate: QualityGate = {
		margin: QUALITY_MARGIN, truePositiveFloor, precisionFloor,
		truePositivesWithinMargin, precisionWithinMargin, targetsBelowBaselineRange,
		qualityWithinMargin: complete ? truePositivesWithinMargin === true && precisionWithinMargin === true && targetsBelowBaselineRange.length === 0 : null,
	};
	const meanTokenReductionObserved = complete && cs.totalTokens.mean < bs.totalTokens.mean;
	// Strict, transparent separation: every candidate pass is below every
	// baseline pass. Overlapping ranges remain a mean-only observation.
	const tokenRangesSeparated = complete && cs.totalTokens.max < bs.totalTokens.min;
	const official = isOfficialGrid(expectedCells);
	const decision: ComparisonDecision = !complete ? "incomplete_or_invalid"
		: !official ? "exploratory_not_decisive"
		: gate.qualityWithinMargin === true && meanTokenReductionObserved ? APPROVAL_DECISION
		: !gate.qualityWithinMargin && !meanTokenReductionObserved ? "quality_below_margin_and_no_token_reduction"
		: !gate.qualityWithinMargin ? "quality_below_margin"
		: "no_token_reduction";
	return {
		complete, official, missingOrInvalid, pairedRuns: pairs.length,
		baseline: bs, candidate: cs, pairedDelta, targets, gate,
		meanTokenReductionObserved, tokenRangesSeparated, decision,
	};
}
