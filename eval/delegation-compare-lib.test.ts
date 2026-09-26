import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createChildGuard, HANDOFF_GRACE_TURNS } from "../core/child.ts";
import { agentMarker, PIRED_AGENTS } from "../core/subagents.ts";
import {
	accountUsage, APPROVAL_DECISION, childRecordIds, compareMatchedRuns, contentText, createBreaker, DEFAULT_BREAKER, findLeaks, isOfficialGrid,
	leakTermsFor, meteredCallCount, nextPairAction, normalizePiUsage, observationsFromChildSession, observationsFromPiEvents, OFFICIAL_PASSES, OFFICIAL_TARGET_IDS,
	parseBreakerPolicy, piCostUsd, PIRED_BUDGET_STOP, planSchedule, QUALITY_MARGIN, reconcileChildSession, reconcileSubagentCalls, summarizeRetries,
	type ArmResult, type BreakerEvent, type ChildSessionExtraction, type ExpectedCell, type PairRules, type RetriedAttempt, type RunMetric, type SubagentChild,
	type UsageObservation,
} from "./delegation-compare-lib.ts";

const usage = (inputTokens: number, outputTokens: number) => ({
	inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
	cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
});

/** Pi's usage object as `message_end` and worker `response` rows carry it. */
const piUsage = (input: number, output: number, cacheRead = 0) => ({
	input, output, cacheRead, cacheWrite: 0, reasoning: 0, totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
});

/** The zero-filled usage every pi API starts a reply from; an errored reply keeps it. */
const zeroUsage = () => piUsage(0, 0);

type Event = Record<string, unknown>;

let clock = 1_790_169_286_000;
const reply = (opts: { id?: string; stop?: string; usage?: unknown; timestamp?: number; errorMessage?: string } = {}): Event => ({
	type: "message_end",
	message: {
		role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna",
		...("usage" in opts ? (opts.usage === undefined ? {} : { usage: opts.usage }) : { usage: piUsage(10, 2) }),
		stopReason: opts.stop ?? "stop",
		timestamp: opts.timestamp ?? clock++,
		...(opts.id ? { responseId: opts.id } : {}),
		...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
	},
});
const compactionEnd = (reason: string, result: unknown, extra: Event = {}): Event => ({
	type: "compaction_end", reason, result, aborted: false, willRetry: false, ...extra,
});

describe("accountUsage", () => {
	it("counts a repeated parent session response once", () => {
		const rows: UsageObservation[] = [
			{ id: "message-a", origin: "parent", usage: usage(100, 20) },
			{ id: "message-a", origin: "parent", usage: usage(100, 20) },
		];
		const result = accountUsage(rows);
		expect(result.valid).toBe(true);
		expect(result.parentRequests).toBe(1);
		expect(result.parent.totalTokens).toBe(120);
		expect(result.duplicateEvents).toBe(1);
	});

	it("adds each child response to the provider total without double-counting parent messages", () => {
		const result = accountUsage([
			{ id: "parent-1", origin: "parent", usage: usage(200, 50) },
			{ id: "worker-7:1", origin: "worker", usage: usage(80, 30) },
			{ id: "worker-7:2", origin: "worker", usage: usage(90, 25) },
		]);
		expect(result.valid).toBe(true);
		expect(result.parent.totalTokens).toBe(250);
		expect(result.worker.totalTokens).toBe(225);
		expect(result.total.totalTokens).toBe(475);
		expect(result.workerRequests).toBe(2);
	});

	it("rejects missing or conflicting usage instead of making a cheap zero", () => {
		expect(accountUsage([{ id: "bad", origin: "parent" }]).valid).toBe(false);
		const conflict = accountUsage([
			{ id: "m", origin: "parent", usage: usage(4, 1) },
			{ id: "m", origin: "parent", usage: usage(5, 1) },
		]);
		expect(conflict.valid).toBe(false);
		expect(conflict.errors.join(" ")).toContain("conflicting duplicate");
	});

	it("rejects a blank ID and an empty ledger rather than reporting a free run", () => {
		expect(accountUsage([{ id: " ", origin: "parent", usage: usage(1, 1) }]).errors.join(" ")).toContain("missing a stable ID");
		expect(accountUsage([]).valid).toBe(false);
	});

	it("refuses usage whose total is not the sum of its parts, even for a caller that reads only the verdict", () => {
		const result = accountUsage([
			{ id: "r1", origin: "parent", usage: { ...usage(48000, 900), totalTokens: 0 } },
			{ id: "w:1", origin: "worker", usage: usage(100, 10) },
		]);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(["parent response r1 reports totalTokens 0, not input + output + cache read + cache write = 48900"]);
		expect(accountUsage([{ id: "e", origin: "parent", usage: usage(0, 0) }, { id: "r", origin: "parent", usage: usage(5, 1) }]).valid).toBe(true);
	});

	it("sums pi's cost estimates as a diagnostic without letting them replace tokens", () => {
		const result = accountUsage([
			{ id: "a", origin: "parent", usage: usage(1, 1), costUsd: 0.25 },
			{ id: "b", origin: "worker", usage: usage(1, 1) },
		]);
		expect(result.costUsd).toBe(0.25);
		expect(result.total.totalTokens).toBe(4);
	});
});

describe("normalizePiUsage and piCostUsd", () => {
	it("maps pi's field names and keeps totalTokens as reported, cache reads included", () => {
		// Measured on a Luna reply: 785 input + 29 output + 7,680 cache read = 8,494.
		expect(normalizePiUsage({ input: 785, output: 29, cacheRead: 7680, cacheWrite: 0, reasoning: 0, totalTokens: 8494 })).toEqual({
			inputTokens: 785, outputTokens: 29, totalTokens: 8494, cacheReadTokens: 7680, cacheWriteTokens: 0, reasoningTokens: 0,
		});
	});

	it("reads an absent reasoning split as zero but an absent usage object as nothing", () => {
		expect(normalizePiUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })?.reasoningTokens).toBe(0);
		expect(normalizePiUsage(undefined)).toBeUndefined();
		expect(normalizePiUsage("8494")).toBeUndefined();
	});

	it("returns a cost only when pi reported a finite, non-negative total", () => {
		expect(piCostUsd(piUsage(1, 1))).toBe(0.001);
		expect(piCostUsd({ cost: { total: -1 } })).toBeUndefined();
		expect(piCostUsd({ cost: {} })).toBeUndefined();
		expect(piCostUsd(undefined)).toBeUndefined();
	});
});

describe("observationsFromPiEvents", () => {
	it("normalizes terminal assistant responses using responseId and provider field names", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(10, 2) }),
			reply({ id: "r2", stop: "stop", usage: piUsage(20, 3) }),
		]);
		expect(parsed.finalStop).toBe(true);
		expect(parsed.errors).toEqual([]);
		expect(parsed.observations.map((o) => o.id)).toEqual(["r1", "r2"]);
		const result = accountUsage(parsed.observations);
		expect(result.valid).toBe(true);
		expect(result.parent).toMatchObject({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
		expect(result.costUsd).toBeCloseTo(0.002);
	});

	it("ignores message_update and agent_end snapshots, which repeat usage already on message_end", () => {
		// On the Qwen assay the update snapshots summed to 428,544 tokens against
		// 142,641 on the terminal events: reading them triples the parent.
		const parsed = observationsFromPiEvents([
			{ type: "message_start", message: { role: "assistant", usage: piUsage(10, 0) } },
			{ type: "message_update", usage: piUsage(10, 1) },
			{ type: "message_update", usage: piUsage(10, 2) },
			reply({ id: "r1", usage: piUsage(10, 2) }),
			{ type: "turn_end", message: { role: "assistant", usage: piUsage(10, 2) } },
			{ type: "agent_end", messages: [{ role: "assistant", usage: piUsage(10, 2) }] },
			{ type: "message_end", message: { role: "user", content: "go" } },
		]);
		expect(parsed.observations).toHaveLength(1);
		expect(accountUsage(parsed.observations).parent.totalTokens).toBe(12);
	});

	it("counts a repeated reply once and rejects a repeat whose usage disagrees", () => {
		const echoed = reply({ id: "r1", timestamp: 5 });
		const parsed = observationsFromPiEvents([echoed, echoed]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.notes.join(" ")).toContain("repeated");
		const counted = accountUsage(parsed.observations);
		expect(counted.parentRequests).toBe(1);
		expect(counted.duplicateEvents).toBe(1);

		const conflicting = observationsFromPiEvents([reply({ id: "r1", timestamp: 5, usage: piUsage(10, 2) }), reply({ id: "r1", timestamp: 5, usage: piUsage(11, 2) })]);
		expect(accountUsage(conflicting.observations).valid).toBe(false);
	});

	it("refuses two replies that share a responseId but not a timestamp, since merging them drops a real call", () => {
		const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse", timestamp: 1 }), reply({ id: "r1", timestamp: 2 })]);
		expect(parsed.errors.join(" ")).toContain("names two replies");
	});

	it("gives replies without a responseId ordinal IDs and never merges two of them", () => {
		const parsed = observationsFromPiEvents([
			reply({ stop: "toolUse", usage: piUsage(10, 2) }),
			reply({ stop: "stop", usage: piUsage(10, 2) }),
		]);
		expect(parsed.observations.map((o) => o.id)).toEqual(["assistant#1", "assistant#2"]);
		expect(parsed.missingResponseIds).toBe(2);
		expect(parsed.notes).toHaveLength(2);
		const result = accountUsage(parsed.observations);
		expect(result.parentRequests).toBe(2);
		expect(result.parent.totalTokens).toBe(24);
		expect(result.duplicateEvents).toBe(0);
	});

	it("rejects a reply with no usage object instead of counting it as zero", () => {
		const parsed = observationsFromPiEvents([reply({ id: "r1", usage: undefined })]);
		expect(parsed.errors.join(" ")).toContain("carries no usage");
		expect(accountUsage(parsed.observations).valid).toBe(false);
	});

	it("rejects a completed reply that reports zero tokens, the shape of a provider that sent no usage frame", () => {
		const parsed = observationsFromPiEvents([reply({ id: "r1", usage: zeroUsage() })]);
		expect(parsed.errors.join(" ")).toContain("reports zero tokens");
	});

	it("rejects a completed reply whose total is not the sum of its parts, the shape of a Responses frame without total_tokens", () => {
		// pi-ai reads `total_tokens || 0`, so the frame books 48,900 tokens of parts and a zero total.
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: { ...piUsage(48000, 900), totalTokens: 0 } }),
			reply({ id: "r2" }),
		]);
		expect(parsed.errors).toEqual(["assistant reply r1 (toolUse) reports totalTokens 0, not input + output + cache read + cache write = 48900"]);
		const counted = observationsFromPiEvents([reply({ id: "r1", usage: { ...piUsage(10, 2), totalTokens: 11 } })]);
		expect(counted.errors.join(" ")).toContain("totalTokens 11");
	});

	it("rejects a completed reply that read no prompt, the shape of a Completions frame without prompt_tokens", () => {
		// pi-ai reads `prompt_tokens || 0` and computes the total from the parts, so the identity holds on 900 output alone.
		const parsed = observationsFromPiEvents([reply({ id: "r1", usage: piUsage(0, 900) })]);
		expect(parsed.errors).toEqual(["assistant reply r1 (stop) reports 900 output tokens but no prompt tokens"]);
	});

	it("accepts a completed reply whose whole prompt was a cache read or a cache write", () => {
		const cached = observationsFromPiEvents([reply({ id: "r1", usage: piUsage(0, 12, 7680) })]);
		expect(cached.errors).toEqual([]);
		const written = observationsFromPiEvents([reply({ id: "r1", usage: { ...piUsage(0, 12), cacheWrite: 4000, totalTokens: 4012 } })]);
		expect(written.errors).toEqual([]);
		expect(accountUsage(written.observations).total.totalTokens).toBe(4012);
	});

	it("allows an errored reply to report nothing but not to report an inconsistent total", () => {
		const zero = observationsFromPiEvents([reply({ stop: "error", usage: zeroUsage(), errorMessage: "529 overloaded" })]);
		expect(zero.errors.join(" ")).not.toContain("reports");
		const skewed = observationsFromPiEvents([
			reply({ stop: "error", usage: { ...piUsage(5000, 0), totalTokens: 0 }, errorMessage: "prompt is too long" }),
			compactionEnd("overflow", { summary: "s", usage: piUsage(40, 8) }, { willRetry: true }),
			reply({ id: "r2" }),
		]);
		expect(skewed.recoveredOverflows).toBe(1);
		expect(skewed.errors).toEqual(["assistant reply assistant#1 (error) reports totalTokens 0, not input + output + cache read + cache write = 5000"]);
		expect(accountUsage(skewed.observations).valid).toBe(false);
	});

	it("counts compaction_end usage once and ignores the entry echo of the same compaction", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(10, 2) }),
			{ type: "compaction_start", reason: "threshold" },
			compactionEnd("threshold", { summary: "s", usage: piUsage(5, 1) }),
			{ type: "entry_appended", entry: { type: "compaction", id: "c1", usage: piUsage(5, 1) } },
			reply({ id: "r2", usage: piUsage(3, 1) }),
		]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.compactions).toBe(1);
		expect(parsed.observations.map((o) => o.id)).toEqual(["r1", "compaction:1", "r2"]);
		expect(accountUsage(parsed.observations).total.totalTokens).toBe(22);
	});

	it("rejects a compaction entry that no completed compaction_end accounts for", () => {
		const parsed = observationsFromPiEvents([
			{ type: "entry_appended", entry: { type: "compaction", id: "c1" } },
			reply({ id: "r1" }),
		]);
		expect(parsed.errors.join(" ")).toContain("compaction entries");
	});

	it("invalidates an aborted, failed or result-less summary, whose calls may have spent unreported tokens", () => {
		const cases: Event[] = [
			compactionEnd("threshold", undefined, { aborted: true }),
			compactionEnd("threshold", undefined, { errorMessage: "Auto-compaction failed: Summarization failed: 529" }),
			compactionEnd("manual", undefined),
		];
		for (const failure of cases) {
			const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), failure, reply({ id: "r2" })]);
			expect(parsed.providerErrors).toHaveLength(1);
			expect(parsed.compactions).toBe(1);
			expect(accountUsage(parsed.observations).valid).toBe(false);
		}
	});

	it("rejects a summary that reports no usage or zero tokens", () => {
		const missing = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), compactionEnd("threshold", { summary: "s" }), reply({ id: "r2" })]);
		expect(missing.errors.join(" ")).toContain("reports no usage");
		expect(accountUsage(missing.observations).valid).toBe(false);
		const zero = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), compactionEnd("threshold", { summary: "s", usage: zeroUsage() }), reply({ id: "r2" })]);
		expect(zero.errors.join(" ")).toContain("zero tokens");
	});

	it("accepts a split-turn summary's combined usage but rejects one whose total drops a call", () => {
		// compact() sums the history and turn-prefix calls field by field, so two
		// consistent calls stay consistent; a total short of its parts lost one.
		const combined = { ...piUsage(9000, 700, 1000), reasoning: 0 };
		const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), compactionEnd("threshold", { summary: "s", usage: combined }), reply({ id: "r2" })]);
		expect(parsed.errors).toEqual([]);
		const short = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), compactionEnd("threshold", { summary: "s", usage: { ...combined, totalTokens: 6000 } }), reply({ id: "r2" })]);
		expect(short.errors).toEqual(["compaction 1 (threshold) reports totalTokens 6000, not input + output + cache read + cache write = 10700"]);
	});

	it("treats a recovered context overflow as a retried turn, not a provider error, and still counts its usage", () => {
		// agent-session.js: the overflow reply is persisted on message_end, then
		// _runAutoCompaction("overflow", true) compacts and the turn is retried.
		const parsed = observationsFromPiEvents([
			reply({ stop: "error", usage: zeroUsage(), errorMessage: "context_length_exceeded: prompt is too long" }),
			{ type: "turn_end" }, { type: "agent_end", messages: [], willRetry: false },
			{ type: "compaction_start", reason: "overflow" },
			compactionEnd("overflow", { summary: "s", usage: piUsage(40, 8) }, { willRetry: true }),
			reply({ id: "r2", usage: piUsage(12, 3) }),
		]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.recoveredOverflows).toBe(1);
		expect(parsed.notes.join(" ")).toContain("overflowed");
		const result = accountUsage(parsed.observations);
		expect(result.valid).toBe(true);
		expect(result.parentRequests).toBe(3);
		expect(result.parent.totalTokens).toBe(63);
	});

	it("counts the spent tokens of a truncated length reply that pi recovered by compacting", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "length", usage: piUsage(900, 0, 100) }),
			compactionEnd("overflow", { summary: "s", usage: piUsage(40, 8) }, { willRetry: true }),
			reply({ id: "r2", usage: piUsage(12, 3) }),
		]);
		expect(parsed.recoveredOverflows).toBe(1);
		expect(parsed.providerErrors).toEqual([]);
		expect(accountUsage(parsed.observations).parent.totalTokens).toBe(1063);
	});

	it("leaves an overflow failed when its recovery compaction fails", () => {
		const parsed = observationsFromPiEvents([
			reply({ stop: "error", usage: zeroUsage(), errorMessage: "prompt is too long" }),
			compactionEnd("overflow", undefined, { errorMessage: "Context overflow recovery failed after one compact-and-retry attempt." }),
		]);
		expect(parsed.recoveredOverflows).toBe(0);
		expect(parsed.providerErrors).toHaveLength(2);
		expect(parsed.finalStop).toBe(false);
	});

	it("rejects an overflow retry with no failed reply before it", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse" }),
			compactionEnd("overflow", { summary: "s", usage: piUsage(4, 1) }, { willRetry: true }),
			reply({ id: "r2" }),
		]);
		expect(parsed.errors.join(" ")).toContain("no failed or truncated reply");
	});

	it("reports an unrecovered provider error or abort, whose true spend is unknown", () => {
		const errored = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse" }),
			reply({ stop: "error", usage: zeroUsage(), errorMessage: "529 overloaded" }),
			reply({ id: "r3" }),
		]);
		expect(errored.providerErrors.join(" ")).toContain("529 overloaded");
		expect(accountUsage(errored.observations).valid).toBe(false);
		const aborted = observationsFromPiEvents([reply({ stop: "aborted", usage: zeroUsage() })]);
		expect(aborted.providerErrors.join(" ")).toContain("aborted");
		expect(aborted.finalStop).toBe(false);
	});

	it("requires the final reply to stop, so a killed or stalled run is not scored", () => {
		expect(observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" })]).errors.join(" ")).toContain("not stop");
		expect(observationsFromPiEvents([{ type: "agent_start" }]).errors).toEqual(["no assistant reply in the stream"]);
		const truncated = observationsFromPiEvents([reply({ id: "r1", stop: "length" })]);
		expect(truncated.providerErrors).toEqual([]);
		expect(truncated.finalStop).toBe(false);
	});

	it("rejects a stop reason print mode never ends a turn with", () => {
		expect(observationsFromPiEvents([reply({ id: "r1", stop: "deferred" }), reply({ id: "r2" })]).errors.join(" ")).toContain("unexpected stopReason deferred");
	});

	it("invalidates any retry event, because retries are disabled and the discarded attempt's usage is lost", () => {
		for (const type of ["auto_retry_start", "auto_retry_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]) {
			const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), { type, attempt: 1 }, reply({ id: "r2" })]);
			expect(parsed.providerErrors).toHaveLength(1);
			expect(accountUsage(parsed.observations).valid).toBe(false);
		}
	});

	it("accepts a transient failure pi retried and counts the failed attempt's reported usage", () => {
		// v5 lost whole runs to one dropped stream pi could have retried; with a
		// policy the failed attempt is kept, with the usage it did report.
		const events = [
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10, 50) }),
			reply({ id: "r2", stop: "error", usage: piUsage(40, 0), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 2000, errorMessage: "terminated" },
			{ type: "entry_appended", entry: { type: "context_edit", id: "e1", targetId: "m2", replacement: null } },
			reply({ id: "r3" }),
			{ type: "auto_retry_end", success: true, attempt: 1 },
		];
		const parsed = observationsFromPiEvents(events, { retry: true });
		expect(parsed.errors).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.retries).toEqual([{ id: "r2", origin: "parent", errorMessage: "terminated", recovered: true, meteredTokens: 40, estimatedTokens: 0, estimateBasis: "none" }]);
		const result = accountUsage(parsed.observations);
		expect(result.valid).toBe(true);
		expect(result.parent.totalTokens).toBe(160 + 40 + 12);
	});

	it("estimates an unmetered attempt from the prompt of the reply that recovered it", () => {
		// pi omits the failed reply and resends the same context, so the recovering
		// reply's prompt is the failed attempt's. Counting it as zero would flatter
		// the arm that retries more.
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10, 50) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1, errorMessage: "terminated" },
			reply({ id: "r3", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 2, errorMessage: "terminated" },
			reply({ id: "r4", stop: "toolUse", usage: piUsage(140, 12, 60) }),
			{ type: "auto_retry_end", success: true, attempt: 2 },
		], { retry: true });
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.retries?.map((r) => [r.id, r.meteredTokens, r.estimatedTokens, r.estimateBasis])).toEqual([["r2", 0, 200, "recovering-prompt"], ["r3", 0, 200, "recovering-prompt"]]);
	});

	// The review found 75 of 1,095 v5c luna worker replies were first requests;
	// with only the previous reply to go on, those were never estimated.
	it("estimates a failed first request from the reply that recovered it", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			reply({ id: "r2", stop: "toolUse", usage: piUsage(4_400, 30) }),
			reply({ id: "r3" }),
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.estimatedTokens, r.estimateBasis])).toEqual([[4_400, "recovering-prompt"]]);
	});

	it("falls back to the previous reply's prompt plus output when no reply recovered the streak", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10, 50) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.estimatedTokens, r.estimateBasis, r.recovered])).toEqual([[160, "previous-reply", false]]);
		// A first request no reply followed has nothing to size it.
		const first = observationsFromPiEvents([
			reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		], { retry: true });
		expect(first.retries?.map((r) => [r.estimatedTokens, r.estimateBasis])).toEqual([[0, "none"]]);
	});

	// The shape pi 0.87.1 prints in JSON mode: the failed reply's turn and agent
	// run end before _prepareRetry emits auto_retry_start, and the context edit
	// and the next run's start events come between the retry and its reply.
	it("pairs a retry with its failed reply across the turn, agent and entry events pi prints between them", () => {
		const parsed = observationsFromPiEvents([
			{ type: "agent_start" }, { type: "turn_start" },
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			{ type: "turn_end" }, { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "turn_end" }, { type: "agent_end", messages: [] },
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 2000, errorMessage: "terminated" },
			{ type: "entry_appended", entry: { type: "context_edit", id: "e7", parentId: "e6", timestamp: "t", targetId: "e6", replacement: null } },
			{ type: "agent_start" }, { type: "turn_start" }, { type: "message_start", message: { role: "assistant" } },
			reply({ id: "r3", stop: "stop", usage: piUsage(120, 8) }),
			{ type: "auto_retry_end", success: true, attempt: 1 }, { type: "turn_end" }, { type: "agent_end", messages: [] },
		], { retry: true });
		expect(parsed.errors).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.retries?.map((r) => [r.id, r.recovered, r.estimatedTokens])).toEqual([["r2", true, 120]]);
	});

	// Hitting the retry limit used to book one failure twice: once at
	// auto_retry_end and again for the same reply at the end of the stream.
	it("fails a streak that ran out once, for its last reply", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "turn_end" }, { type: "agent_end" },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "terminated" },
		], { retry: true });
		expect(parsed.providerErrors).toEqual(["assistant reply r2 failed: terminated"]);
		expect(parsed.observations.filter((o) => o.id.startsWith("unaccounted") || o.id.startsWith("retry-end"))).toHaveLength(1);
	});

	it("still refuses retry events when the retry policy is off", () => {
		const events = [reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }), { type: "auto_retry_start", attempt: 1 }, reply({ id: "r2" })];
		const off = observationsFromPiEvents(events);
		expect(off.retries).toBeUndefined();
		expect(off.providerErrors.length).toBeGreaterThan(0);
		expect(accountUsage(off.observations).valid).toBe(false);
	});

	it("leaves the run invalid when the retries run out", () => {
		// pi gives up after maxRetries: the last failed reply has no auto_retry_start and ends the run.
		const exhausted = observationsFromPiEvents([
			reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
		], { retry: true });
		expect(exhausted.providerErrors.join(" ")).toContain("r2 failed: terminated");
		expect(accountUsage(exhausted.observations).valid).toBe(false);
		const cancelled = observationsFromPiEvents([
			reply({ id: "r1", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		], { retry: true });
		expect(cancelled.providerErrors.join(" ")).toContain("Retry cancelled");
	});

	it("refuses a retry event with no failed reply before it, which this reader does not understand", () => {
		const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), { type: "auto_retry_start", attempt: 1 }, reply({ id: "r2" })], { retry: true });
		expect(parsed.errors.join(" ")).toContain("no failed reply before it");
	});

	it("keeps an overflow recovery apart from a retry", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "context_length_exceeded" }),
			compactionEnd("overflow", { summary: "s", usage: piUsage(50, 5) }, { willRetry: true }),
			reply({ id: "r3" }),
		], { retry: true });
		expect(parsed.recoveredOverflows).toBe(1);
		expect(parsed.retries).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
	});

	it("estimates a failed summary call from the compaction that succeeded, since pi-ai resends the same request", () => {
		// The previous reply's prompt includes kept messages a summary call does
		// not send, so it would not be a lower bound; the successful call is.
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			{ type: "summarization_retry_scheduled", attempt: 1, errorMessage: "terminated" },
			{ type: "summarization_retry_attempt_start", attempt: 2 },
			{ type: "summarization_retry_finished" },
			compactionEnd("threshold", { summary: "s", usage: piUsage(50, 5) }),
			reply({ id: "r2" }),
		], { retry: true });
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.retries).toEqual([{ id: "summary-retry:1", origin: "parent", errorMessage: "terminated", recovered: true, meteredTokens: 0, estimatedTokens: 50, estimateBasis: "recovering-prompt" }]);
	});

	it("leaves a split-turn compaction's failed call unestimated, since its usage sums two summary calls", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			{ type: "summarization_retry_scheduled", attempt: 1, errorMessage: "terminated" },
			compactionEnd("threshold", { summary: "history\n\n---\n\n**Turn Context (split turn):**\n\nprefix", usage: piUsage(90, 9) }),
			reply({ id: "r2" }),
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.recovered, r.estimatedTokens, r.estimateBasis])).toEqual([[true, 0, "none"]]);
	});

	it("leaves a summary call's retry unrecovered when the compaction still fails", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			{ type: "summarization_retry_scheduled", attempt: 1, errorMessage: "terminated" },
			{ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "terminated" },
			reply({ id: "r2" }),
		], { retry: true });
		expect(parsed.retries?.map((r) => r.recovered)).toEqual([false]);
		expect(parsed.providerErrors.join(" ")).toContain("failed: terminated");
	});

	it("marks every attempt of a streak pi gave up on as unrecovered, so a failed run does not lose its count", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			reply({ id: "r3", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 2 },
			reply({ id: "r4", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_end", success: false, attempt: 2, finalError: "terminated" },
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.id, r.recovered])).toEqual([["r2", false], ["r3", false]]);
		expect(accountUsage(parsed.observations).valid).toBe(false);
	});

	it("lowers the fallback after a compaction to the summary the next prompt still carries", () => {
		// The history the summary replaced is not resent, so the reply before the
		// compaction would overstate a later failed attempt and stop being a lower bound.
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(180_000, 900) }),
			compactionEnd("threshold", { summary: "s", usage: piUsage(170_000, 3_000) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.estimatedTokens, r.estimateBasis])).toEqual([[3_000, "previous-reply"]]);
	});

	// A compaction between the retry and its reply changes what the reply sent,
	// so the reply's prompt is not the failed attempt's; the fallback stands.
	it("does not size an attempt from a reply a compaction came before", () => {
		const parsed = observationsFromPiEvents([
			reply({ id: "r1", stop: "toolUse", usage: piUsage(180_000, 900) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
			{ type: "auto_retry_start", attempt: 1 },
			compactionEnd("threshold", { summary: "s", usage: piUsage(170_000, 3_000) }),
			reply({ id: "r3", stop: "stop", usage: piUsage(20_000, 50) }),
		], { retry: true });
		expect(parsed.retries?.map((r) => [r.recovered, r.estimatedTokens, r.estimateBasis])).toEqual([[true, 180_900, "previous-reply"]]);
	});

	it("gives the same output with the retry option off as with no option, for a stream with no retry in it", () => {
		const events = [
			reply({ id: "r1", stop: "toolUse", usage: piUsage(100, 10) }),
			compactionEnd("threshold", { summary: "s", usage: piUsage(50, 5) }),
			reply({ id: "r2", stop: "error", usage: zeroUsage(), errorMessage: "terminated" }),
		];
		expect(JSON.stringify(observationsFromPiEvents(events, { retry: false }))).toBe(JSON.stringify(observationsFromPiEvents(events)));
		expect(JSON.stringify(observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1" })]), CHILD_KEY, { retry: false })))
			.toBe(JSON.stringify(observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1" })]), CHILD_KEY)));
	});

	it("counts a branch summary once by entry ID and notes that print mode should not produce one", () => {
		const summary = { type: "entry_appended", entry: { type: "branch_summary", id: "b1", usage: piUsage(7, 1) } };
		const parsed = observationsFromPiEvents([summary, summary, reply({ id: "r1" })]);
		expect(parsed.notes.join(" ")).toContain("branch-summary:b1");
		const result = accountUsage(parsed.observations);
		expect(result.parent.totalTokens).toBe(20);
		expect(result.duplicateEvents).toBe(1);
		const unnamed = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "branch_summary", usage: piUsage(7, 1) } }, reply({ id: "r1" })]);
		expect(unnamed.errors.join(" ")).toContain("no ID");
		const unmetered = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "branch_summary", id: "b2" } }, reply({ id: "r1" })]);
		expect(unmetered.errors.join(" ")).toContain("reports no usage");
		const unprompted = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "branch_summary", id: "b3", usage: piUsage(0, 5) } }, reply({ id: "r1" })]);
		expect(unprompted.errors).toEqual(["branch-summary:b3 reports 5 output tokens but no prompt tokens"]);
	});

	it("ignores extension custom entries and context edits but rejects a tool result that reports provider usage", () => {
		const custom = observationsFromPiEvents([
			{ type: "entry_appended", entry: { type: "custom", customType: "pired-welcome" } },
			{ type: "entry_appended", entry: { type: "context_edit", id: "e1", targetId: "m1", replacement: null } },
			reply({ id: "r1" }),
		]);
		expect(custom.errors).toEqual([]);
		const spending = observationsFromPiEvents([
			{ type: "message_end", message: { role: "toolResult", toolName: "read", usage: piUsage(50, 5) } },
			{ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [] } },
			reply({ id: "r1" }),
		]);
		expect(spending.errors).toEqual(["tool result read reports provider usage outside this accounting"]);
	});

	it("leaves a subagent result's usage to the child's session instead of booking it to the parent", () => {
		// pi-subagents sums the child's replies onto its tool result and pi 0.87
		// copies that onto the toolResult message: 6,039 on a faux run, the exact
		// sum of the child's three session replies. Counting it here double-books the child.
		const childSum = { input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515, totalTokens: 6039, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const parsed = observationsFromPiEvents([
			reply({ id: "resp_p_2", stop: "toolUse", usage: piUsage(3000, 40) }),
			{ type: "message_end", message: { role: "toolResult", toolName: "subagent", toolCallId: "t1", content: [], usage: childSum } },
			reply({ id: "resp_p_3", usage: piUsage(3200, 10) }),
		]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.delegatedResults).toBe(1);
		expect(accountUsage(parsed.observations).parent.totalTokens).toBe(3040 + 3210);
		const renamed = observationsFromPiEvents([
			{ type: "message_end", message: { role: "toolResult", toolName: "subagent", usage: childSum } },
			reply({ id: "r1" }),
		], { delegationTools: ["delegate"] });
		expect(renamed.errors).toEqual(["tool result subagent reports provider usage outside this accounting"]);
	});

	it("counts a cache-warming usage entry once by entry ID, since each warm is a real provider call", () => {
		const warm = { type: "entry_appended", entry: { type: "usage", id: "w1", kind: "cache_warm", provider: "openai-codex", model: "gpt-6-luna", usage: piUsage(0, 1, 30000) } };
		const parsed = observationsFromPiEvents([reply({ id: "r1", stop: "toolUse" }), warm, warm, reply({ id: "r2" })]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.cacheWarmings).toBe(2);
		expect(parsed.notes).toContain("usage:w1 (cache_warm) counted as a provider call");
		const counted = accountUsage(parsed.observations);
		expect(counted.parentRequests).toBe(3);
		expect(counted.duplicateEvents).toBe(1);
		expect(counted.parent.cacheReadTokens).toBe(30000);
		const unnamed = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "usage", kind: "cache_warm", usage: piUsage(0, 1, 30000) } }, reply({ id: "r1" })]);
		expect(unnamed.errors).toEqual(["usage entry has no ID"]);
		const unmetered = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "usage", id: "w2", kind: "cache_warm" } }, reply({ id: "r1" })]);
		expect(unmetered.errors).toEqual(["usage:w2 reports no usage"]);
		expect(accountUsage(unmetered.observations).valid).toBe(false);
		const promptless = observationsFromPiEvents([{ type: "entry_appended", entry: { type: "usage", id: "w3", kind: "cache_warm", usage: piUsage(0, 1) } }, reply({ id: "r1" })]);
		expect(promptless.errors).toEqual(["usage:w3 reports 1 output tokens but no prompt tokens"]);
	});

	it("ignores system messages, which pi 0.87 also ends on the stream", () => {
		const parsed = observationsFromPiEvents([{ type: "message_end", message: { role: "system", content: "", sections: {} } }, reply({ id: "r1" })]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.observations).toHaveLength(1);
	});

	it("rejects a message_end that carries no message", () => {
		expect(observationsFromPiEvents([{ type: "message_end" }, reply({ id: "r1" })]).errors).toContain("message_end carries no message");
	});
});

/*
 * Child sessions and parent events below are excerpts of faux runs of pi 0.87.1
 * with pi-subagents 0.71.0 (a pired-shaped runtime agent, its session pinned by
 * defaultSessionDir), trimmed to the fields the readers use. The usage numbers
 * are the ones those runs recorded.
 */
const RUN_ID = "c9cbc1e8-d449-4e0e-a74b-5ba5e3563c7a";
const CHILD_KEY = `${RUN_ID}/run-0`;
const PINNED = "/cells/cell-03/child-sessions";

let entrySeq = 0;
const entry = (type: string, fields: Event = {}): Event => ({
	type, id: (++entrySeq).toString(16).padStart(8, "0"), parentId: null, timestamp: "2026-09-23T19:02:10.004Z", ...fields,
});
const sessionHeader = (extra: Event = {}): Event => ({ type: "session", version: 3, id: "01a0cfa5-9385-76cc-8e20-d7ece690978f", timestamp: "2026-09-23T19:02:10.001Z", cwd: "/work", ...extra });
/** Pi's usage as a child reply carries it; the faux runs wrote the prompt as cache writes and reads. */
const childUsage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
	input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const childReply = (opts: { id?: string; stop?: string; usage?: unknown; content?: unknown[]; errorMessage?: string; model?: string } = {}): Event => entry("message", {
	message: {
		role: "assistant", content: opts.content ?? [], api: "openai-codex-responses", provider: "openai-codex", model: opts.model ?? "gpt-6-luna",
		...("usage" in opts ? (opts.usage === undefined ? {} : { usage: opts.usage }) : { usage: childUsage(28, 8, 1469, 28) }),
		stopReason: opts.stop ?? "stop", timestamp: 1_790_190_130_069,
		...(opts.id ? { responseId: opts.id } : {}),
		...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
	},
});
const toolCall = (id: string, name: string, args: Event) => ({ type: "toolCall", id, name, arguments: args });
const childResult = (toolCallId: string, toolName: string, text: string, details?: unknown, isError = false): Event => entry("message", {
	message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...(details === undefined ? {} : { details }), isError, timestamp: 1_790_190_130_070 },
});
const jsonl = (rows: Event[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** The start of every child session: header, model, effort, name, system prompt, task. */
const preamble = (thinking = "medium"): Event[] => [
	sessionHeader(),
	entry("model_change", { provider: "openai-codex", modelId: "gpt-6-luna" }),
	entry("thinking_level_change", { thinkingLevel: thinking }),
	entry("session_info", { name: `subagent-pired-investigate-${RUN_ID}-1` }),
	entry("message", { message: { role: "system", content: "", sections: { preamble: "<active_agent name=\"pired-investigate\"/>" } } }),
	entry("message", { message: { role: "user", content: [{ type: "text", text: "Task: Investigate the upload handler in src/upload.go:42 for hypothesis b50898; record what you find." }] } }),
];

/** The faux child that recorded a finding, ran one bash call and handed back: 3 replies, 6,039 tokens. */
const finishedChild = (): Event[] => [
	...preamble(),
	childReply({ id: "resp_c_3", stop: "toolUse", usage: childUsage(1469, 15, 0, 1469), content: [toolCall("tool:1", "record", { kind: "finding", title: "Upload path traversal" })] }),
	childResult("tool:1", "record", "Recorded finding c0ffee", { id: "c0ffee", kind: "finding", ids: ["c0ffee"], created: ["c0ffee"] }),
	childReply({ id: "resp_c_4", stop: "toolUse", usage: childUsage(28, 8, 1469, 28), content: [toolCall("tool:2", "bash", { command: "echo in-scope" })] }),
	childResult("tool:2", "bash", "in-scope\n"),
	childReply({ id: "resp_c_5", usage: childUsage(18, 20, 1497, 18), content: [{ type: "text", text: "Recorded finding c0ffee (suspected) at src/upload.go:42. Unresolved: auth check." }] }),
];

/** pired's two refusals past a worker's budget, as core/child.ts wrote them on the faux pired-scout run. */
const HANDOFF_ASK = "Your final message is the handoff: at most 200 words listing the record IDs you wrote, the evidence paths, your verdicts, and what is still unresolved.";
const PAST_BUDGET = `pired: pired-scout has used its 20-turn budget. Stop calling tools and hand back now. ${HANDOFF_ASK}`;
const BUDGET_STOP = `pired: pired-scout is 3 turns past its 20-turn budget and still calling tools, so this run is being stopped. ${HANDOFF_ASK}`;

/**
 * The faux pired-scout that kept calling bash past its 20-turn budget (scratch
 * replay of the real entry, r3-harness-1/int/terminate): 23 toolUse replies, the
 * 21st and 22nd told to hand back, the 23rd's call refused with terminate, and
 * no reply after it. 6,017 input + 138 output + 125,896 cache read + 6,018 cache
 * write, the sums pi-subagents reported for it.
 */
const budgetStoppedChild = (): Event[] => {
	const rows = [...preamble()];
	for (let t = 1; t <= 23; t++) {
		const usage = t === 1 ? childUsage(5552, 6, 0, 5552) : t <= 21 ? childUsage(16, 6, 5552 + 16 * (t - 2), 16) : t === 22 ? childUsage(72, 6, 5872, 73) : childUsage(73, 6, 5944, 73);
		rows.push(childReply({ id: `probe-child-${t + 2}`, stop: "toolUse", usage, content: [toolCall(`tool:b${t}`, "bash", { command: "true" })] }));
		rows.push(t <= 20 ? childResult(`tool:b${t}`, "bash", "(no output)") : childResult(`tool:b${t}`, "bash", t < 23 ? PAST_BUDGET : BUDGET_STOP, {}, true));
	}
	return rows;
};

/**
 * pi-subagents' worker timeout, replayed on the real entry with a 4-second
 * per-call timeout in place of the 15-minute one (scratch fix3-harness/int).
 * Landing during a tool: the tool result "Command aborted", then the empty
 * `error` reply pi writes without calling the provider. Landing during a
 * request: the session stops after the previous tool result; the request in
 * flight never reached the file.
 */
const timedOutDuringTool = (): Event[] => [
	...preamble(),
	childReply({ id: "probe-child-4", stop: "toolUse", usage: childUsage(5554, 25, 0, 5554), content: [toolCall("tool:t1", "record", { kind: "endpoint", method: "GET", path: "/pired-probe-7dbde83f", file: "README.md" })] }),
	childResult("tool:t1", "record", "Recorded endpoint 39461b\nEngagement: surface 1 · coverage 0% · 17 test cases outstanding.", { id: "39461b", kind: "endpoint", ids: ["39461b"] }),
	childReply({ id: "probe-child-5", stop: "toolUse", usage: childUsage(55, 10, 5554, 55), content: [toolCall("tool:t2", "bash", { command: "sleep 30; echo slept" })] }),
	childResult("tool:t2", "bash", "Command aborted", {}, true),
	childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "This operation was aborted" }),
];
const timedOutDuringRequest = (): Event[] => timedOutDuringTool().slice(0, 8);

describe("observationsFromChildSession", () => {
	it("counts each reply of a finished child once under its run key, to the token pi-subagents reported", () => {
		const parsed = observationsFromChildSession(jsonl(finishedChild()), CHILD_KEY);
		expect(parsed.errors).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.observations.map((o) => o.id)).toEqual([`${CHILD_KEY}/resp_c_3`, `${CHILD_KEY}/resp_c_4`, `${CHILD_KEY}/resp_c_5`]);
		expect(parsed).toMatchObject({ turns: 3, finalStop: "stop", sessionId: "01a0cfa5-9385-76cc-8e20-d7ece690978f", models: ["openai-codex/gpt-6-luna"], thinkingLevels: ["medium"] });
		expect(parsed.replyUsage).toEqual({ input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515 });
		expect(parsed.finalText).toContain("Recorded finding c0ffee");
		const counted = accountUsage(parsed.observations);
		expect(counted.valid).toBe(true);
		expect(counted.workerRequests).toBe(3);
		expect(counted.worker.totalTokens).toBe(6039);
		expect(counted.parentRequests).toBe(0);
	});

	it("joins each tool call to its persisted result and reads the ledger IDs a record call wrote", () => {
		const parsed = observationsFromChildSession(jsonl(finishedChild()), CHILD_KEY);
		expect(parsed.toolCalls.map((c) => [c.turn, c.name, c.isError])).toEqual([[1, "record", false], [2, "bash", false]]);
		expect(parsed.toolCalls.map(childRecordIds)).toEqual([["c0ffee"], []]);
		// A hypothesis cross product returns several IDs; a refused write returns none.
		expect(childRecordIds({ turn: 1, id: "t", name: "record", arguments: {}, isError: false, details: { kind: "hypothesis", ids: ["a1", "b2"], created: ["b2"] } })).toEqual(["a1", "b2"]);
		expect(childRecordIds({ turn: 1, id: "t", name: "record", arguments: {}, isError: false, details: { kind: "note", created: ["note"] } })).toEqual([]);
		expect(childRecordIds({ turn: 1, id: "t", name: "record", arguments: {}, isError: true, details: { id: "c0ffee" } })).toEqual([]);
		expect(childRecordIds({ turn: 1, id: "t", name: "record", arguments: {} })).toEqual([]);
	});

	it("fails a child whose second reply was a 529, because that call's true spend is unknown", () => {
		// The faux 529 still booked 28 input + 1,469 cache read + 28 cache write; a real one may book nothing.
		const rows = [...finishedChild().slice(0, 8), childReply({ stop: "error", usage: childUsage(28, 0, 1469, 28), errorMessage: "529 overloaded" })];
		const parsed = observationsFromChildSession(jsonl(rows), CHILD_KEY);
		expect(parsed.providerErrors).toEqual([`child ${CHILD_KEY}: assistant reply entry:${String(rows.at(-1)!.id)} failed: 529 overloaded`]);
		expect(parsed.errors).toContain(`child ${CHILD_KEY}: final assistant reply ended with error, not stop or length`);
		expect(accountUsage(parsed.observations).valid).toBe(false);
	});

	it("fails an aborted final reply, the shape a timeout during a request leaves", () => {
		const parsed = observationsFromChildSession(jsonl([...preamble(), childReply({ stop: "aborted", usage: childUsage(0, 0, 0, 0), errorMessage: "This operation was aborted" })]), CHILD_KEY);
		expect(parsed.providerErrors.join(" ")).toContain("was aborted");
		expect(accountUsage(parsed.observations).valid).toBe(false);
	});

	it("accepts a final length reply, whose spend is reported, and rejects a final tool call, a child cut off mid-loop", () => {
		const truncated = observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1", stop: "length", usage: childUsage(900, 8192, 0, 0) })]), CHILD_KEY);
		expect(truncated.errors).toEqual([]);
		expect(truncated.providerErrors).toEqual([]);
		const cut = observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1", stop: "toolUse", content: [toolCall("t1", "bash", {})] })]), CHILD_KEY);
		expect(cut.errors).toEqual([`child ${CHILD_KEY}: final assistant reply ended with toolUse, not stop or length`]);
		expect(cut.ending).toBe("cut-off");
		expect(truncated.ending).toBe("handoff");
	});

	// Round-three review: the session of a worker pired's own turn budget stopped
	// ended on toolUse, the run was invalid as non-infrastructure, and one looping
	// worker ended the official grid.
	it("reads a worker stopped by pired's turn budget as a whole session, all 23 replies counted", () => {
		const parsed = observationsFromChildSession(jsonl(budgetStoppedChild()), CHILD_KEY);
		expect(parsed.errors).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed).toMatchObject({ ending: "budget-stop", finalStop: "toolUse", turns: 23 });
		expect(parsed.replyUsage).toEqual({ input: 6017, output: 138, cacheRead: 125896, cacheWrite: 6018 });
		const counted = accountUsage(parsed.observations);
		expect(counted.valid).toBe(true);
		expect(counted.workerRequests).toBe(23);
		expect(counted.worker.totalTokens).toBe(6017 + 138 + 125896 + 6018);
	});

	it("does not read a last batch as pired's stop unless every result in it carries the stop", () => {
		const rows = budgetStoppedChild();
		rows[rows.length - 1] = childResult("tool:b23", "bash", PAST_BUDGET, {}, true);
		expect(observationsFromChildSession(jsonl(rows), CHILD_KEY)).toMatchObject({ ending: "cut-off", errors: [`child ${CHILD_KEY}: final assistant reply ended with toolUse, not stop or length`] });
		const twoCalls = budgetStoppedChild();
		twoCalls[twoCalls.length - 2] = childReply({ id: "probe-child-25", stop: "toolUse", usage: childUsage(73, 6, 5944, 73), content: [toolCall("tool:b23", "bash", { command: "true" }), toolCall("tool:b24", "read", { path: "x" })] });
		expect(observationsFromChildSession(jsonl(twoCalls), CHILD_KEY).ending).toBe("cut-off");
		expect(observationsFromChildSession(jsonl([...twoCalls, childResult("tool:b24", "read", BUDGET_STOP, {}, true)]), CHILD_KEY).ending).toBe("budget-stop");
	});

	it("reads a timeout that landed during a tool as a whole session, and does not count pi's empty reply as a request", () => {
		const parsed = observationsFromChildSession(jsonl(timedOutDuringTool()), CHILD_KEY);
		expect(parsed.errors).toEqual([]);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed).toMatchObject({ ending: "aborted-between-requests", finalStop: "error", turns: 3 });
		expect(parsed.notes.join(" ")).toContain("no provider call was made for it");
		const counted = accountUsage(parsed.observations);
		expect(counted.valid).toBe(true);
		expect(counted.workerRequests).toBe(2);
		expect(counted.worker.totalTokens).toBe(11133 + 5674);
	});

	it("keeps a timeout that landed during a request cut off, because that request's reply never reached the file", () => {
		const parsed = observationsFromChildSession(jsonl(timedOutDuringRequest()), CHILD_KEY);
		expect(parsed.ending).toBe("cut-off");
		expect(parsed.errors).toEqual([`child ${CHILD_KEY}: final assistant reply ended with toolUse, not stop or length`]);
	});

	it("keeps an empty error reply a provider failure unless its text is the abort's own", () => {
		const rows = timedOutDuringTool();
		rows[rows.length - 1] = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: '429 {"error":{"code":"1302"}}' });
		const rateLimited = observationsFromChildSession(jsonl(rows), CHILD_KEY);
		expect(rateLimited.ending).toBe("cut-off");
		expect(rateLimited.providerErrors).toHaveLength(1);
		const spent = timedOutDuringTool();
		spent[spent.length - 1] = childReply({ stop: "error", usage: childUsage(28, 0, 1469, 28), errorMessage: "This operation was aborted" });
		expect(observationsFromChildSession(jsonl(spent), CHILD_KEY).providerErrors).toHaveLength(1);
	});

	it("treats an overflow the session recovered by compacting as a retried turn and counts the summary", () => {
		// agent-session.js: the failed reply stays in the file, a context edit omits
		// it, the overflow compaction is appended with its usage, and the turn retries.
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "context_length_exceeded" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(),
			failed,
			entry("context_edit", { targetId: failed.id, replacement: null }),
			entry("compaction", { summary: "s", firstKeptEntryId: "x", tokensBefore: 190000, usage: childUsage(40000, 900, 0, 0) }),
			childReply({ id: "r2", usage: childUsage(12, 3, 3000, 0) }),
		]), CHILD_KEY);
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.errors).toEqual([]);
		expect(parsed).toMatchObject({ recoveredOverflows: 1, compactions: 1, contextEdits: 1 });
		expect(parsed.notes.join(" ")).toContain("overflowed the context");
		const counted = accountUsage(parsed.observations);
		expect(counted.valid).toBe(true);
		expect(counted.workerRequests).toBe(3);
		expect(counted.worker.totalTokens).toBe(40900 + 3015);
	});

	it("keeps an auto-retried error a failure, since only a compaction marks a recovered overflow", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "429 rate limited" });
		const parsed = observationsFromChildSession(jsonl([...preamble(), failed, entry("context_edit", { targetId: failed.id, replacement: null }), childReply({ id: "r2" })]), CHILD_KEY);
		expect(parsed.providerErrors.join(" ")).toContain("429 rate limited");
		expect(parsed.recoveredOverflows).toBe(0);
		const unretried = observationsFromChildSession(jsonl([...preamble(), failed, entry("compaction", { usage: childUsage(40, 8, 0, 0) })]), CHILD_KEY);
		expect(unretried.providerErrors.join(" ")).toContain("429 rate limited");
	});

	it("treats a worker's error reply omitted by a context edit and followed by a reply as a retried attempt", () => {
		// A worker's session file has no auto_retry events; the context edit pi
		// appends for the failed attempt is the only mark the retry leaves.
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const rows = [
			...preamble(),
			childReply({ id: "r1", stop: "toolUse", usage: childUsage(28, 8, 1469, 28), content: [toolCall("tool:1", "bash", { command: "ls" })] }),
			childResult("tool:1", "bash", "a\n"),
			failed,
			entry("context_edit", { targetId: failed.id, replacement: null }),
			childReply({ id: "r2", usage: childUsage(40, 6, 1469, 30) }),
		];
		const parsed = observationsFromChildSession(jsonl(rows), CHILD_KEY, { retry: true });
		expect(parsed.providerErrors).toEqual([]);
		expect(parsed.errors).toEqual([]);
		// The recovering reply resent the same context, so its prompt sizes the attempt.
		expect(parsed.retries).toEqual([{
			id: `${CHILD_KEY}/entry:${String(failed.id)}`, origin: "worker", errorMessage: "terminated", recovered: true,
			meteredTokens: 0, estimatedTokens: 40 + 1469 + 30, estimateBasis: "recovering-prompt",
		}]);
		expect(accountUsage(parsed.observations).valid).toBe(true);
		// Off, the same file is a failure, as every v5 grid read it.
		const off = observationsFromChildSession(jsonl(rows), CHILD_KEY);
		expect(off.retries).toBeUndefined();
		expect(off.providerErrors.join(" ")).toContain("terminated");
	});

	it("keeps a worker's error a failure under the retry policy when no context edit omits it or no reply follows", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const unomitted = observationsFromChildSession(jsonl([...preamble(), failed, childReply({ id: "r2" })]), CHILD_KEY, { retry: true });
		expect(unomitted.providerErrors.join(" ")).toContain("terminated");
		const otherTarget = observationsFromChildSession(jsonl([...preamble(), failed, entry("context_edit", { targetId: "elsewhere", replacement: null }), childReply({ id: "r2" })]), CHILD_KEY, { retry: true });
		expect(otherTarget.providerErrors.join(" ")).toContain("terminated");
	});

	// The parent lists an attempt whose retry pi cancelled and counts it toward
	// the cap; a worker whose session ends after the omission used to list
	// nothing, so the same event counted in one arm's workers and not the other.
	it("lists a worker's omitted reply as an unrecovered attempt when the session ends before the retry, and fails the worker", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(), childReply({ id: "r1", stop: "toolUse", usage: childUsage(28, 8, 1469, 28) }),
			failed, entry("context_edit", { targetId: failed.id, replacement: null }),
		]), CHILD_KEY, { retry: true });
		expect(parsed.retries?.map((r) => [r.recovered, r.estimatedTokens, r.estimateBasis])).toEqual([[false, 28 + 8 + 1469 + 28, "previous-reply"]]);
		expect(parsed.providerErrors).toEqual([`child ${CHILD_KEY}: assistant reply entry:${String(failed.id)} failed: terminated; pi's retry of it never ran`]);
		expect(accountUsage(parsed.observations).valid).toBe(false);
	});

	// pi also writes context edits for an extension's boundary drafts, which
	// replace an entry rather than omit it; only an omission is pi's retry.
	it("does not read a context edit that replaces the failed reply as a retry", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(), failed,
			entry("context_edit", { targetId: failed.id, replacement: { role: "assistant", content: [{ type: "text", text: "draft" }] } }),
			childReply({ id: "r2" }),
		]), CHILD_KEY, { retry: true });
		expect(parsed.retries).toEqual([]);
		expect(parsed.providerErrors.join(" ")).toContain("failed: terminated");
	});

	it("leaves a worker's retried attempt unrecovered when its next attempt also fails and the session ends", () => {
		const first = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const second = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(), childReply({ id: "r1", stop: "toolUse", usage: childUsage(28, 8, 1469, 28) }),
			first, entry("context_edit", { targetId: first.id, replacement: null }), second,
		]), CHILD_KEY, { retry: true });
		expect(parsed.retries?.map((r) => r.recovered)).toEqual([false]);
		expect(parsed.providerErrors.join(" ")).toContain(`entry:${String(second.id)} failed: terminated`);
	});

	it("lowers a worker's fallback after a compaction to the summary the next prompt carries", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(), childReply({ id: "r1", stop: "toolUse", usage: childUsage(28, 8, 150_000, 28) }),
			entry("compaction", { summary: "s", firstKeptEntryId: "x", tokensBefore: 150000, usage: childUsage(40000, 900, 0, 0) }),
			failed, entry("context_edit", { targetId: failed.id, replacement: null }),
		]), CHILD_KEY, { retry: true });
		expect(parsed.retries?.map((r) => [r.estimatedTokens, r.estimateBasis])).toEqual([[900, "previous-reply"]]);
	});

	// pi can run a threshold compaction before the retried request
	// (_compactBeforeNextAssistantResponse). The shape then matches an overflow
	// recovery; the error text decides, since pi never retries an overflow.
	it("keeps a worker's retry a retry when a threshold compaction lands between the omission and the next reply", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "terminated" });
		const rows = [
			...preamble(), childReply({ id: "r1", stop: "toolUse", usage: childUsage(28, 8, 150_000, 28) }),
			failed, entry("context_edit", { targetId: failed.id, replacement: null }),
			entry("compaction", { summary: "s", firstKeptEntryId: "x", tokensBefore: 150000, usage: childUsage(40000, 900, 0, 0) }),
			childReply({ id: "r2", usage: childUsage(12, 3, 3000, 0) }),
		];
		const parsed = observationsFromChildSession(jsonl(rows), CHILD_KEY, { retry: true });
		expect(parsed.recoveredOverflows).toBe(0);
		expect(parsed.providerErrors).toEqual([]);
		// The compaction changed what the next reply sent, so the fallback stands.
		expect(parsed.retries?.map((r) => [r.recovered, r.estimatedTokens, r.estimateBasis])).toEqual([[true, 28 + 8 + 150_000 + 28, "previous-reply"]]);
		// Without a policy the same file reads as v5 read it: an overflow recovery.
		expect(observationsFromChildSession(jsonl(rows), CHILD_KEY).recoveredOverflows).toBe(1);
	});

	it("keeps a worker's overflow recovery apart from a retry under the retry policy", () => {
		const failed = childReply({ stop: "error", usage: childUsage(0, 0, 0, 0), errorMessage: "context_length_exceeded" });
		const parsed = observationsFromChildSession(jsonl([
			...preamble(), failed,
			entry("context_edit", { targetId: failed.id, replacement: null }),
			entry("compaction", { summary: "s", firstKeptEntryId: "x", tokensBefore: 190000, usage: childUsage(40000, 900, 0, 0) }),
			childReply({ id: "r2", usage: childUsage(12, 3, 3000, 0) }),
		]), CHILD_KEY, { retry: true });
		expect(parsed.recoveredOverflows).toBe(1);
		expect(parsed.retries).toEqual([]);
	});

	it("rejects a forked session, whose copied history would book the parent's replies again", () => {
		const rows = finishedChild();
		rows[0] = sessionHeader({ parentSession: "/home/op/.pi/sessions/parent.jsonl" });
		expect(observationsFromChildSession(jsonl(rows), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: session forks /home/op/.pi/sessions/parent.jsonl; its copied history would book the parent's replies again`]);
	});

	it("rejects a missing, empty, malformed or headerless session instead of reading it as free", () => {
		for (const text of [undefined, "", "\n \n"]) {
			const parsed = observationsFromChildSession(text, CHILD_KEY);
			expect(parsed.errors).toEqual([`child ${CHILD_KEY}: session.jsonl is missing or empty`]);
			expect(accountUsage(parsed.observations).valid).toBe(false);
		}
		const lines = jsonl(finishedChild()).split("\n");
		lines.splice(7, 0, "{\"type\":\"message\",\"id\":");
		expect(observationsFromChildSession(lines.join("\n"), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: session line 8 is not a JSON entry`]);
		expect(observationsFromChildSession(jsonl(finishedChild().slice(1)), CHILD_KEY).errors).toContain(`child ${CHILD_KEY}: first entry is model_change, not the session header`);
		const old = finishedChild();
		old[0] = sessionHeader({ version: 2 });
		expect(observationsFromChildSession(jsonl(old), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: session version 2; this reader knows version 3`]);
		expect(observationsFromChildSession(jsonl([...finishedChild(), sessionHeader()]), CHILD_KEY).errors.join(" ")).toContain("second session header");
		expect(observationsFromChildSession(jsonl(preamble()), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: no assistant reply in the session`]);
	});

	it("rejects an unknown entry type, so a later pi's usage-bearing entry cannot read as free", () => {
		const parsed = observationsFromChildSession(jsonl([...finishedChild(), entry("provider_charge", { usage: childUsage(5, 1, 0, 0) })]), CHILD_KEY);
		expect(parsed.errors).toEqual([`child ${CHILD_KEY}: unknown entry type provider_charge at line 12`]);
		const inert = observationsFromChildSession(jsonl([...finishedChild(), entry("label", { targetId: "x", label: "l" }), entry("custom", { customType: "pired" }), entry("custom_message", { customType: "pired", content: "c", display: false })]), CHILD_KEY);
		expect(inert.errors).toEqual([]);
	});

	it("counts compaction, branch summary and cache-warm entries as provider calls and refuses them without usage", () => {
		const parsed = observationsFromChildSession(jsonl([
			...finishedChild().slice(0, 7),
			entry("compaction", { id: "cmp00001", summary: "s", usage: childUsage(9000, 700, 1000, 0) }),
			entry("usage", { id: "warm0001", kind: "cache_warm", provider: "openai-codex", model: "gpt-6-luna", usage: childUsage(0, 1, 3000, 0) }),
			entry("branch_summary", { id: "brs00001", fromId: "x", summary: "s", usage: childUsage(50, 5, 0, 0) }),
			...finishedChild().slice(7),
		]), CHILD_KEY);
		expect(parsed.errors).toEqual([]);
		expect(parsed).toMatchObject({ compactions: 1, cacheWarmings: 1 });
		expect(parsed.observations.map((o) => o.id)).toEqual(expect.arrayContaining([`${CHILD_KEY}/compaction:cmp00001`, `${CHILD_KEY}/usage:warm0001`, `${CHILD_KEY}/branch-summary:brs00001`]));
		expect(accountUsage(parsed.observations).worker.totalTokens).toBe(6039 + 10700 + 3001 + 55);
		// The reply sum pi-subagents reports leaves those calls out.
		expect(parsed.replyUsage).toEqual({ input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515 });
		const unmetered = observationsFromChildSession(jsonl([...finishedChild(), entry("compaction", { id: "cmp00002", summary: "s", fromHook: true })]), CHILD_KEY);
		expect(unmetered.errors).toEqual([`child ${CHILD_KEY}: compaction cmp00002 reports no usage`]);
		expect(accountUsage(unmetered.observations).valid).toBe(false);
	});

	it("names a reply without a responseId by its entry ID and refuses a responseId on two replies", () => {
		const bare = childReply({ usage: childUsage(18, 20, 1497, 18) });
		const parsed = observationsFromChildSession(jsonl([...preamble(), bare]), CHILD_KEY);
		expect(parsed.observations.map((o) => o.id)).toEqual([`${CHILD_KEY}/entry:${String(bare.id)}`]);
		expect(parsed.missingResponseIds).toBe(1);
		const twice = observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1", stop: "toolUse" }), childReply({ id: "r1" })]), CHILD_KEY);
		expect(twice.errors).toEqual([`child ${CHILD_KEY}: responseId r1 names two replies`]);
	});

	it("holds each reply to the parent's usage rules", () => {
		const one = (usage: unknown, stop = "stop") => observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1", stop, usage })]), CHILD_KEY).errors;
		expect(one(undefined)).toEqual([`child ${CHILD_KEY}: assistant reply r1 (stop) carries no usage`]);
		expect(one({ input: 5, output: 1 })).toEqual([`child ${CHILD_KEY}: assistant reply r1 (stop) reports incomplete usage`]);
		expect(one({ ...childUsage(48000, 900, 0, 0), totalTokens: 0 })).toEqual([`child ${CHILD_KEY}: assistant reply r1 (stop) reports totalTokens 0, not input + output + cache read + cache write = 48900`]);
		expect(one(childUsage(0, 900, 0, 0))).toEqual([`child ${CHILD_KEY}: assistant reply r1 (stop) reports 900 output tokens but no prompt tokens`]);
		expect(one(childUsage(0, 0, 0, 0))).toEqual([`child ${CHILD_KEY}: assistant reply r1 (stop) reports zero tokens`]);
		expect(observationsFromChildSession(jsonl([...preamble(), childReply({ id: "r1", stop: "deferred" }), childReply({ id: "r2" })]), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: assistant reply r1 ended with unexpected stopReason deferred`]);
	});

	it("rejects a tool result that reports provider usage, since a child cannot delegate", () => {
		const rows = finishedChild();
		const spending = entry("message", { message: { role: "toolResult", toolCallId: "tool:2", toolName: "subagent", content: [], usage: childUsage(50, 5, 0, 0), isError: false } });
		const parsed = observationsFromChildSession(jsonl([...rows.slice(0, 9), spending, ...rows.slice(9)]), CHILD_KEY);
		expect(parsed.errors).toEqual([`child ${CHILD_KEY}: tool result subagent reports provider usage outside this accounting`]);
	});

	it("rejects entries without an ID and an entry ID used twice", () => {
		const rows = finishedChild();
		const anonymous = { type: "label", parentId: null, timestamp: "2026-09-23T19:02:10.004Z", targetId: "x" };
		expect(observationsFromChildSession(jsonl([...rows, anonymous]), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: line 12 (label) has no entry ID`]);
		expect(observationsFromChildSession(jsonl([...rows, { ...rows[3]! }]), CHILD_KEY).errors).toEqual([`child ${CHILD_KEY}: entry ID ${String(rows[3]!.id)} appears twice`]);
		expect(observationsFromChildSession(jsonl([...rows, entry("message", {})]), CHILD_KEY).errors.join(" ")).toContain("carries no message");
	});
});

/** pi-subagents' result row for the finished faux child. */
const childRow = (extra: Event = {}): Event => ({
	index: 0, agent: "pired-investigate", task: "[prompt redacted]", sessionName: "pired-investigate: Investigate the upload handler in src/upload.go:42 for hy...",
	context: "fresh", exitCode: 0, outputState: "present", model: "openai-codex/gpt-6-luna",
	usage: { input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515, cost: 0, turns: 3 },
	sessionFile: `${PINNED}/${CHILD_KEY}/session.jsonl`,
	...extra,
});
const callStart = (id: string, args: Event = { agent: "pired-investigate", task: "Investigate the upload handler in src/upload.go:42 for hypothesis b50898; record what you find." }): Event => ({ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args });
const progress = (id: string, row: Event, runId = RUN_ID): Event => ({
	type: "tool_execution_update", toolCallId: id, toolName: "subagent",
	partialResult: { content: [{ type: "text", text: "(running...)" }], details: { mode: "single", runId, context: "fresh", results: [row] } },
});
const callEnd = (id: string, details: Event, text = "Run fan-out: 1/64 used, 63 remaining\nRecorded finding c0ffee (suspected) at src/upload.go:42. Unresolved: auth check.\nMission: 1ab828d1-193c-4368-b01d-94dfdf5d7bb5 (completed)", isError = false): Event => ({
	type: "tool_execution_end", toolCallId: id, toolName: "subagent", isError,
	result: { content: [{ type: "text", text }], details },
});
const completedCall = (id = "tool:p2", row: Event = childRow(), runId = RUN_ID): Event[] => [
	callStart(id),
	progress(id, { ...row, exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, sessionFile: undefined }, runId),
	callEnd(id, { mode: "single", runId, timeoutMs: 1_800_000, results: [row], totalChildUsage: row.usage }),
];
/** A child that failed: pi-subagents throws, pi keeps only the message, and details come back empty. */
const failedCall = (id: string, lastRow: Event, text: string): Event[] => [callStart(id), progress(id, lastRow), callEnd(id, {}, text, true)];
const SESSION = `${CHILD_KEY}/session.jsonl`;

describe("reconcileSubagentCalls", () => {
	it("maps a completed call's child to the session pinned at <runId>/run-<index>", () => {
		const report = reconcileSubagentCalls(completedCall(), [SESSION], { sessionDir: PINNED });
		expect(report.errors).toEqual([]);
		expect(report.children).toEqual([{
			toolCallId: "tool:p2", runId: RUN_ID, index: 0, childKey: CHILD_KEY, sessionPath: SESSION, agent: "pired-investigate",
			status: "completed", source: "result", exitCode: 0, model: "openai-codex/gpt-6-luna",
			usage: { input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515, turns: 3 },
			reportedSessionFile: `${PINNED}/${SESSION}`, sessionFound: true,
		}]);
		expect(report.calls[0]).toMatchObject({ toolCallId: "tool:p2", isError: false, requestedAgent: "pired-investigate", async: false, mode: "single", runId: RUN_ID });
		expect(report.calls[0]!.resultText).toContain("Recorded finding c0ffee");
		// A listing with a leading ./ names the same file.
		expect(reconcileSubagentCalls(completedCall(), [`./${SESSION}`]).errors).toEqual([]);
	});

	it("reads a failed call's child from its last progress update, since pi keeps only the error message", () => {
		const text = "Run fan-out: 1/64 used, 63 remaining\n529 overloaded\n\nOutput artifact: /tmp/a/ab56d105_pired-investigate_0_output.md\nMission: 12e04c26 (failed)";
		const last = childRow({ exitCode: 1, error: "529 overloaded", usage: { input: 1497, output: 15, cacheRead: 1469, cacheWrite: 1497, cost: 0, turns: 2 }, sessionFile: undefined, progress: { status: "failed" } });
		const report = reconcileSubagentCalls(failedCall("tool:p2", last, text), [SESSION]);
		expect(report.errors).toEqual([]);
		expect(report.children[0]).toMatchObject({ childKey: CHILD_KEY, status: "failed", source: "update", exitCode: 1, error: "529 overloaded", sessionFound: true });
		// An update sent before the failure still says exit 0; the call's error decides.
		const stale = reconcileSubagentCalls(failedCall("tool:p2", childRow({ sessionFile: undefined }), text), [SESSION]);
		expect(stale.children[0]).toMatchObject({ status: "failed", error: "Run fan-out: 1/64 used, 63 remaining" });
	});

	it("names no child for a call rejected before launch, and notes why", () => {
		const text = "Unknown agent: pired-nonexistent\nEffective cwd: /work\nConsulted agent-definition directories:";
		const report = reconcileSubagentCalls([callStart("tool:p2", { agent: "pired-nonexistent", task: "t" }), callEnd("tool:p2", {}, text, true)], []);
		expect(report.errors).toEqual([]);
		expect(report.children).toEqual([]);
		expect(report.notes).toEqual(["subagent call tool:p2 was rejected before launching a child: Unknown agent: pired-nonexistent"]);
	});

	it("rejects an async launch, whose child spends after the call returns", () => {
		// pi-subagents' built-in claude-code agent launched this way on a faux run.
		const asyncId = "d4f15283-03e8-49f8-a1b1-13292cce2d76";
		const report = reconcileSubagentCalls([
			callStart("tool:p2", { agent: "claude-code", task: "t" }),
			callEnd("tool:p2", { mode: "single", runId: asyncId, results: [], asyncId, asyncDir: `/tmp/async-subagent-runs/${asyncId}` }, "Run fan-out: 1/64 used, 63 remaining\nAsync: claude-code [d4f15283]"),
		], []);
		expect(report.errors).toEqual([`subagent call tool:p2 launched async run ${asyncId}; its children run after the call returns, outside this accounting`]);
		expect(report.calls[0]!.async).toBe(true);
		const refused = reconcileSubagentCalls([callStart("tool:p2", { agent: "pired-verify", task: "t", async: true }), callEnd("tool:p2", {}, "Blocked: async delegation is not part of pired's design", true)], []);
		expect(refused.errors).toEqual([]);
		expect(refused.notes).toContain("subagent call tool:p2 asked for an async run and was rejected");
	});

	it("rejects a child with no session file, whether or not pi-subagents reports tokens for it", () => {
		const spent = reconcileSubagentCalls(completedCall(), []);
		expect(spent.errors).toEqual([`child ${CHILD_KEY} (pired-investigate) has no session at ${SESSION}, yet pi-subagents reports 6039 tokens for it`]);
		// pi writes the file with the first reply, so this child never got one: a tripwire, not the model.
		const idle = childRow({ exitCode: 1, error: "Required child extension failed to load", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, sessionFile: undefined });
		const tripped = reconcileSubagentCalls(failedCall("tool:p2", idle, "Run fan-out: 1/64 used\nRequired child extension failed to load"), []);
		expect(tripped.errors).toEqual([`child ${CHILD_KEY} (pired-investigate) has no session at ${SESSION}: it ended failed before its first reply (Required child extension failed to load)`]);
	});

	it("rejects a session file no call claims, whose spend the parent never saw", () => {
		const report = reconcileSubagentCalls(completedCall(), [SESSION, "0d97e505-eafd-486e-b4a6-100d223d4953/run-0/session.jsonl"]);
		expect(report.errors).toEqual(["session file 0d97e505-eafd-486e-b4a6-100d223d4953/run-0/session.jsonl is claimed by no subagent call"]);
	});

	it("rejects a reported session outside the pinned directory, where a fork's session would be", () => {
		const fork = childRow({ sessionFile: "/home/op/.pi/sessions/parent/forks/2026-09-23.jsonl" });
		expect(reconcileSubagentCalls(completedCall("tool:p2", fork), [SESSION], { sessionDir: `${PINNED}/` }).errors).toEqual([
			`child ${CHILD_KEY} reports its session at /home/op/.pi/sessions/parent/forks/2026-09-23.jsonl, not the pinned ${PINNED}/${SESSION}`,
		]);
		expect(reconcileSubagentCalls(completedCall("tool:p2", fork), [SESSION]).errors).toEqual([
			`child ${CHILD_KEY} reports its session at /home/op/.pi/sessions/parent/forks/2026-09-23.jsonl, not the pinned <session dir>/${SESSION}`,
		]);
		const elsewhere = childRow({ sessionFile: `/tmp/other/${SESSION}` });
		expect(reconcileSubagentCalls(completedCall("tool:p2", elsewhere), [SESSION], { sessionDir: PINNED }).errors).toHaveLength(1);
	});

	it("reports lifecycle faults: never ended, ended twice, events without a start or an ID", () => {
		const [start, update, end] = completedCall();
		const report = reconcileSubagentCalls([
			callEnd("tool:p0", {}),
			progress("tool:p9", childRow()),
			start!, start!, update!, end!, end!, progress("tool:p2", childRow()),
			callStart("tool:p3"),
			{ type: "tool_execution_start", toolName: "subagent" },
			{ type: "tool_execution_end", toolName: "read", toolCallId: "tool:r1" },
		], [SESSION]);
		expect(report.errors).toEqual([
			"subagent call tool:p0 ended without starting",
			"subagent call tool:p9 updated without starting",
			"subagent call tool:p2 started twice",
			"subagent call tool:p2 ended twice",
			"subagent call tool:p2 updated after it ended",
			"subagent tool_execution_start has no toolCallId",
			"subagent call tool:p3 never ended",
		]);
	});

	it("rejects a launched child without a run ID or index, and one claimed by two calls", () => {
		const noRun = [callStart("tool:p2"), callEnd("tool:p2", { mode: "single", results: [childRow()] })];
		expect(reconcileSubagentCalls(noRun, []).errors).toEqual(["subagent call tool:p2 launched pired-investigate without a run ID and index, so its session cannot be found"]);
		const noIndex = [callStart("tool:p2"), callEnd("tool:p2", { mode: "single", runId: RUN_ID, results: [childRow({ index: -1 }), "junk"] })];
		expect(reconcileSubagentCalls(noIndex, []).errors).toEqual([
			"subagent call tool:p2 launched pired-investigate without a run ID and index, so its session cannot be found",
			"subagent call tool:p2 lists a child that is not an object",
		]);
		const twice = reconcileSubagentCalls([...completedCall("tool:p2"), ...completedCall("tool:p4")], [SESSION]);
		expect(twice.errors).toEqual([`child ${CHILD_KEY} is claimed by subagent calls tool:p2 and tool:p4`]);
		expect(twice.children).toHaveLength(1);
	});

	it("rejects a success without a results list and a workflow launch, but passes management actions and subagents_enable", () => {
		expect(reconcileSubagentCalls([callStart("tool:p2"), callEnd("tool:p2", {})], []).errors).toEqual(["subagent call tool:p2 succeeded without a results list"]);
		const listing = reconcileSubagentCalls([
			{ type: "tool_execution_start", toolCallId: "tool:e1", toolName: "subagents_enable", args: {} },
			{ type: "tool_execution_end", toolCallId: "tool:e1", toolName: "subagents_enable", result: { content: [{ type: "text", text: "Enabled: subagent." }], details: { enabled: true } }, isError: false },
			callStart("tool:p2", { action: "list" }), callEnd("tool:p2", { mode: "management" }, "pired-investigate, pired-verify"),
		], []);
		expect(listing.errors).toEqual([]);
		expect(listing.calls).toEqual([expect.objectContaining({ toolCallId: "tool:p2", action: "list", children: [] })]);
		const workflow = reconcileSubagentCalls([callStart("tool:p2", { workflowScript: "runs.run(...)" }), callEnd("tool:p2", { mode: "workflow", runId: RUN_ID, results: [] })], []);
		expect(workflow.errors).toEqual(["subagent call tool:p2 ran a workflow, which this accounting does not map to child sessions"]);
	});

	it("reads interrupted, detached, timed-out and stopped children from pi-subagents' flags", () => {
		for (const [flag, status] of [["interrupted", "interrupted"], ["detached", "detached"], ["timedOut", "timed-out"], ["stopped", "stopped"]] as const) {
			const report = reconcileSubagentCalls(completedCall("tool:p2", childRow({ [flag]: true })), [SESSION]);
			expect(report.children[0]!.status).toBe(status);
		}
		expect(reconcileSubagentCalls(completedCall("tool:p2", childRow({ exitCode: 0, error: "Subagent produced no output" })), [SESSION]).children[0]!.status).toBe("failed");
	});

	it("matches a custom tool name", () => {
		const renamed = completedCall().map((event) => ({ ...event, toolName: "delegate" }));
		expect(reconcileSubagentCalls(renamed, [SESSION], { toolName: "delegate" }).children).toHaveLength(1);
		expect(reconcileSubagentCalls(renamed, [SESSION]).children).toHaveLength(0);
	});
});

describe("reconcileChildSession", () => {
	const child = (extra: Partial<SubagentChild> = {}): SubagentChild => ({ ...reconcileSubagentCalls(completedCall(), [SESSION]).children[0]!, ...extra });
	const finished = (): ChildSessionExtraction => observationsFromChildSession(jsonl(finishedChild()), CHILD_KEY);
	const expectParent = { model: "openai-codex/gpt-6-luna", thinking: "medium" };

	it("accepts a completed child whose session matches pi-subagents' row, model and effort", () => {
		expect(reconcileChildSession(child(), finished(), expectParent)).toEqual({ accepted: true, outcome: "completed", errors: [], notes: [] });
	});

	it("accepts a failed child whose session accounts for every call, as the candidate's own outcome", () => {
		// The faux child that answered with empty text after three replies: pi-subagents
		// reports "Subagent produced no output", and every call it made is in the file.
		const rows = finishedChild();
		rows[rows.length - 1] = childReply({ id: "resp_c_5", usage: childUsage(18, 0, 1497, 18), content: [{ type: "text", text: "" }] });
		const verdict = reconcileChildSession(child({ status: "failed", source: "update", error: "Subagent produced no output (possible model cold-start or empty response)." }), observationsFromChildSession(jsonl(rows), CHILD_KEY), expectParent);
		expect(verdict).toMatchObject({ accepted: true, outcome: "failed", errors: [] });
		expect(verdict.notes).toEqual([`child ${CHILD_KEY} (pired-investigate): ended failed (Subagent produced no output (possible model cold-start or empty response).); its session accounts for every call, so its tokens count as failed`]);
	});

	it("rejects a child whose session holds a provider failure, leaving that error to the session's own list", () => {
		const rows = [...finishedChild().slice(0, 8), childReply({ stop: "error", usage: childUsage(28, 0, 1469, 28), errorMessage: "529 overloaded" })];
		const session = observationsFromChildSession(jsonl(rows), CHILD_KEY);
		const verdict = reconcileChildSession(child({ status: "failed", source: "update", error: "529 overloaded" }), session, expectParent);
		expect(verdict).toEqual({ accepted: false, errors: [], notes: [] });
		expect(session.providerErrors).toHaveLength(1);
	});

	// Round-three review: pired's own bounds made the run unscoreable, so a single
	// looping or slow worker ended an official grid that could not be resumed.
	it("accepts a worker stopped by pired's turn budget as incomplete when the parent's row reports the stop", () => {
		const row = child({
			agent: "pired-scout", status: "failed", source: "update", exitCode: 1,
			error: `bash failed (exit 1): ${BUDGET_STOP.slice(0, 200)}`, usage: { input: 6017, output: 138, cacheRead: 125896, cacheWrite: 6018, turns: 23 },
		});
		const verdict = reconcileChildSession(row, observationsFromChildSession(jsonl(budgetStoppedChild()), CHILD_KEY), expectParent);
		expect(verdict).toMatchObject({ accepted: true, outcome: "incomplete", errors: [] });
		expect(verdict.notes).toEqual([`child ${CHILD_KEY} (pired-scout): stopped by pired's turn budget (bash failed (exit 1): ${BUDGET_STOP.slice(0, 200).trim()}); its session accounts for every call, so its tokens count as incomplete`]);
	});

	// The session file is writable from inside the seal; the parent's transcript is not.
	it("rejects a session that ends on pired's stop when the parent's row does not report one", () => {
		const verdict = reconcileChildSession(child({ status: "failed", source: "update", error: "Subagent produced no output" }), observationsFromChildSession(jsonl(budgetStoppedChild()), CHILD_KEY), expectParent);
		expect(verdict.accepted).toBe(false);
		expect(verdict.errors).toEqual([`child ${CHILD_KEY} (pired-investigate): its session ends on pired's turn-budget stop, but pi-subagents' row in the parent's transcript does not report that stop (it ended failed: Subagent produced no output)`]);
	});

	it("accepts a timeout that landed between requests as incomplete, and only when pi-subagents reports the timeout", () => {
		const session = observationsFromChildSession(jsonl(timedOutDuringTool()), CHILD_KEY);
		const timedOut = child({ status: "timed-out", source: "update", exitCode: 1, error: "Subagent timed out after 900000ms.", usage: { input: 5609, output: 35, cacheRead: 5554, cacheWrite: 5609, turns: 3 } });
		const verdict = reconcileChildSession(timedOut, session, expectParent);
		expect(verdict).toMatchObject({ accepted: true, outcome: "incomplete", errors: [] });
		expect(verdict.notes[0]).toContain("stopped by pi-subagents' worker timeout (Subagent timed out after 900000ms.)");
		const failed = reconcileChildSession({ ...timedOut, status: "failed" }, session, expectParent);
		expect(failed.accepted).toBe(false);
		expect(failed.errors).toEqual([`child ${CHILD_KEY} (pired-investigate): its session ends on a run aborted between requests, but pi-subagents reports it failed, not timed out`]);
	});

	it("rejects a timeout that landed during a request, leaving the reason to the session's own list", () => {
		const session = observationsFromChildSession(jsonl(timedOutDuringRequest()), CHILD_KEY);
		const verdict = reconcileChildSession(child({ status: "timed-out", source: "update", error: "Subagent timed out after 900000ms." }), session, expectParent);
		expect(verdict).toEqual({ accepted: false, errors: [], notes: [] });
		expect(session.errors).toHaveLength(1);
	});

	it("matches pired's stop in the refusal the child guard actually writes, and not in its first warning", async () => {
		const guard = createChildGuard();
		guard.arm({ v: 1, engagement: "e", authorized: true, mode: "enforce", targets: { ips: ["127.0.0.1"] } } as Parameters<typeof guard.arm>[0]);
		const scout = PIRED_AGENTS.find((a) => a.name === "pired-scout")!;
		guard.identify(agentMarker(scout.name));
		for (let i = 0; i <= scout.maxTurns; i++) guard.turnStarted();
		const warned = await guard.check({ name: "bash", args: { command: "true" } });
		expect(warned.terminate).toBeUndefined();
		expect(PIRED_BUDGET_STOP.test(warned.reason ?? "")).toBe(false);
		for (let i = 0; i < HANDOFF_GRACE_TURNS; i++) guard.turnStarted();
		const stopped = await guard.check({ name: "bash", args: { command: "true" } });
		expect(stopped.terminate).toBe(true);
		expect(PIRED_BUDGET_STOP.test(stopped.reason ?? "")).toBe(true);
		expect(stopped.reason).toBe(BUDGET_STOP);
	});

	it("rejects an interrupted, detached or stopped child, whose session is not its whole spend", () => {
		for (const status of ["interrupted", "detached", "stopped"] as const) {
			const verdict = reconcileChildSession(child({ status }), finished());
			expect(verdict.accepted).toBe(false);
			expect(verdict.errors[0]).toContain(`ended ${status}`);
		}
		expect(reconcileChildSession(child({ status: "timed-out" }), finished()).accepted).toBe(true);
	});

	it("rejects a session whose replies disagree with pi-subagents' row, unless compaction rewrote what the row sums", () => {
		const trimmed = observationsFromChildSession(jsonl([...finishedChild().slice(0, 9), childReply({ id: "resp_c_5", usage: childUsage(10, 20, 1497, 18) })]), CHILD_KEY);
		const verdict = reconcileChildSession(child(), trimmed);
		expect(verdict.accepted).toBe(false);
		expect(verdict.errors).toEqual([`child ${CHILD_KEY} (pired-investigate): pi-subagents reported 3 replies and 6039 tokens; the session holds 3 and 6031`]);
		const compacted = observationsFromChildSession(jsonl([...finishedChild().slice(0, 9), entry("compaction", { usage: childUsage(900, 40, 0, 0) }), childReply({ id: "resp_c_5", usage: childUsage(10, 20, 1497, 18) })]), CHILD_KEY);
		const relaxed = reconcileChildSession(child(), compacted);
		expect(relaxed.accepted).toBe(true);
		expect(relaxed.notes[0]).toContain("compactions and context edits rewrite what pi-subagents re-sums");
		// A failed call's row comes from a progress update that may predate the last reply, so it is not compared.
		expect(reconcileChildSession(child({ source: "update", status: "failed" }), trimmed).errors).toEqual([]);
	});

	it("rejects a child that ran another model or effort, which is a different experiment", () => {
		const other = observationsFromChildSession(jsonl([...preamble("low"), childReply({ id: "r1", model: "gpt-6-luna-mini", usage: childUsage(1469, 15, 0, 1469) })]), CHILD_KEY);
		expect(reconcileChildSession(child({ usage: undefined }), other, expectParent).errors).toEqual([
			`child ${CHILD_KEY} (pired-investigate): replies came from openai-codex/gpt-6-luna-mini, not openai-codex/gpt-6-luna`,
			`child ${CHILD_KEY} (pired-investigate): ran thinking low, not medium`,
		]);
		const unrecorded = observationsFromChildSession(jsonl([sessionHeader(), ...finishedChild().slice(3)]), CHILD_KEY);
		expect(reconcileChildSession(child(), unrecorded, { thinking: "medium" }).errors).toEqual([`child ${CHILD_KEY} (pired-investigate): its session records no thinking level`]);
	});

	it("rejects a child with no session to account", () => {
		expect(reconcileChildSession(child(), undefined)).toEqual({ accepted: false, errors: [`child ${CHILD_KEY} (pired-investigate): no session to account`], notes: [] });
	});
});

describe("contentText", () => {
	it("joins text parts, keeps a plain string, and reads anything else as empty", () => {
		expect(contentText([{ type: "text", text: "a" }, { type: "toolCall", id: "t" }, { type: "text", text: "b" }])).toBe("ab");
		expect(contentText("plain")).toBe("plain");
		expect(contentText(undefined)).toBe("");
	});
});

describe("planSchedule", () => {
	it("runs every target's pass before any target's next pass", () => {
		const plan = planSchedule([...OFFICIAL_TARGET_IDS], OFFICIAL_PASSES);
		expect(plan).toHaveLength(15);
		expect(plan.map((p) => p.pass)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
		expect(plan.map((p) => p.index)).toEqual([...plan.keys()]);
		expect(plan[0]).toMatchObject({ target: "CVE-2025-52903", pass: 1, key: "CVE-2025-52903#1" });
	});

	it("runs each target in both arm orders and keeps first-arm counts within one over the grid", () => {
		const plan = planSchedule([...OFFICIAL_TARGET_IDS], OFFICIAL_PASSES);
		for (const target of OFFICIAL_TARGET_IDS) {
			const firsts = new Set(plan.filter((p) => p.target === target).map((p) => p.order[0]));
			expect(firsts).toEqual(new Set(["baseline", "candidate"]));
		}
		for (const pair of plan) expect(new Set(pair.order)).toEqual(new Set(["baseline", "candidate"]));
		const baselineFirst = plan.filter((p) => p.order[0] === "baseline").length;
		expect(Math.abs(baselineFirst - (plan.length - baselineFirst))).toBeLessThanOrEqual(1);
	});
});

describe("createBreaker", () => {
	// Builders: one launched run as the breaker sees it, a minute apart, so a
	// trip's reason carries the time of the run that tripped it.
	let minute = 0;
	const event = (kind: "valid" | "drop" | "timeout" | "quota" | "blocked"): BreakerEvent => ({
		atMs: Date.UTC(2026, 8, 26, 12, minute++), valid: kind === "valid",
		infra: kind === "drop" || kind === "quota", exhausted: kind === "quota", blocked: kind === "blocked",
	});
	const feed = (kinds: Array<Parameters<typeof event>[0]>, policy = DEFAULT_BREAKER) => {
		const breaker = createBreaker(policy);
		const verdicts = kinds.map((kind) => breaker.record(event(kind)));
		return { breaker, verdicts, trippedAt: verdicts.findIndex((v) => v.tripped) };
	};

	// An outage at the start of a grid: every run drops. Three in a row is the
	// pre-registered C, and the third is where the grid must stop launching.
	it("trips after three consecutive infrastructure failures", () => {
		const { verdicts, trippedAt } = feed(["valid", "drop", "drop", "drop"]);
		expect(trippedAt).toBe(3);
		expect(verdicts[3]!.reason).toMatch(/^3 consecutive launched runs failed \(3 infrastructure\) \(at 2026-09-26T\d\d:\d\d:00\.000Z\)$/);
	});

	// v5 stopped a whole grid on one dropped stream (research/12). Scattered drops
	// among valid runs are what re-queuing is for, not a reason to stop.
	it("does not trip on isolated drops among valid runs", () => {
		const { breaker, trippedAt } = feed(["drop", "valid", "valid", "drop", "valid", "valid", "valid", "drop", "valid", "valid", "drop", "valid"]);
		expect(trippedAt).toBe(-1);
		expect(breaker.verdict).toEqual({ tripped: false });
	});

	// Two drops in the first three runs are a 67% rate that says nothing yet; the
	// rate is read only over a full window of N runs.
	it("trips on the window failure rate only once the window is full", () => {
		expect(feed(["drop", "valid", "drop"]).trippedAt).toBe(-1);
		// Four drops in eight, never three in a row: the eighth run fills the window at exactly R.
		const { verdicts, trippedAt } = feed(["drop", "valid", "drop", "drop", "valid", "valid", "valid", "drop"]);
		expect(trippedAt).toBe(7);
		expect(verdicts[7]!.reason).toMatch(/^4 of 8 launched runs failed \(4 infrastructure\), at or above the 0\.5 rate/);
		// The window slides: old drops fall out, and three in the last eight is under R.
		expect(feed(["drop", "drop", "valid", "valid", "valid", "valid", "drop", "valid", "valid", "drop"]).trippedAt).toBe(-1);
	});

	// Nothing launched before a quota or usage window resets can succeed, so the
	// first spent-quota run stops the grid without waiting for a streak.
	it("trips at once on a quota stop", () => {
		const { verdicts, trippedAt } = feed(["valid", "quota"]);
		expect(trippedAt).toBe(1);
		expect(verdicts[1]!.reason).toMatch(/quota or usage window is spent/);
	});

	// A blocked pair already fixes an official grid at incomplete_or_invalid;
	// every further pair would spend up to two hours per arm on a known outcome.
	it("trips at once on a non-infrastructure invalid run of an official grid", () => {
		expect(feed(["blocked"]).trippedAt).toBe(0);
	});

	// Counting only infrastructure let an exploratory grid whose candidate times
	// out every run spend all of its ~36 h; a timeout is a failed launch too.
	it("counts a non-infrastructure failure of an exploratory grid as a failure, so repeated timeouts trip it", () => {
		const { verdicts, trippedAt } = feed(["timeout", "timeout", "timeout", "timeout"]);
		expect(trippedAt).toBe(2);
		expect(verdicts[2]!.reason).toMatch(/^3 consecutive launched runs failed \(0 infrastructure\)/);
		expect(feed(["drop", "drop", "timeout"]).trippedAt).toBe(2);
	});

	// Three drops in eight is under R, and read as infrastructure alone the
	// timeouts between them diluted the window into never tripping.
	it("does not let timeouts between drops dilute the failure rate", () => {
		const { verdicts, trippedAt } = feed(["drop", "timeout", "valid", "drop", "timeout", "valid", "drop", "valid"]);
		expect(trippedAt).toBe(7);
		expect(verdicts[7]!.reason).toMatch(/^5 of 8 launched runs failed \(3 infrastructure\)/);
	});

	it("stays tripped, keeping the reason of the run that tripped it", () => {
		const { breaker, verdicts } = feed(["quota", "valid", "valid"]);
		expect(verdicts[2]).toEqual(verdicts[0]);
		expect(breaker.verdict.tripped).toBe(true);
	});

	it("reads its numbers from the policy it was given", () => {
		expect(feed(["drop"], parseBreakerPolicy({ ...DEFAULT_BREAKER, consecutive: 1 })).trippedAt).toBe(0);
	});
});

describe("parseBreakerPolicy", () => {
	// Resume compares policies with JSON.stringify, so a policy written with its
	// fields in another order must come back in the one fixed order.
	it("returns the policy in one fixed field order", () => {
		const shuffled = { attemptCeiling: 16, maxAttempts: 4, cooldownMs: 60_000, window: 8, rate: 0.5, consecutive: 3 };
		expect(JSON.stringify(parseBreakerPolicy(shuffled))).toBe(JSON.stringify(DEFAULT_BREAKER));
	});

	// A misspelt field read as "use the default" would change the rule unseen.
	it("refuses an unknown field, a missing one and an out-of-range value", () => {
		expect(() => parseBreakerPolicy({ ...DEFAULT_BREAKER, maxAttempt: 4 })).toThrow(/unknown field: maxAttempt/);
		const { window: _dropped, ...noWindow } = DEFAULT_BREAKER;
		expect(() => parseBreakerPolicy(noWindow)).toThrow(/window/);
		expect(() => parseBreakerPolicy({ ...DEFAULT_BREAKER, rate: 0 })).toThrow(/rate/);
		expect(() => parseBreakerPolicy({ ...DEFAULT_BREAKER, consecutive: 2.5 })).toThrow(/consecutive/);
		expect(() => parseBreakerPolicy({ ...DEFAULT_BREAKER, cooldownMs: -1 })).toThrow(/cooldownMs/);
		expect(() => parseBreakerPolicy({ ...DEFAULT_BREAKER, attemptCeiling: 0 })).toThrow(/attemptCeiling/);
		expect(() => parseBreakerPolicy([])).toThrow(/not an object/);
	});
});

describe("nextPairAction", () => {
	// Builders: an arm's run at one attempt, and the requeue context a runner with
	// the default policy passes as a pair ends at 12:00.
	const valid: ArmResult = { valid: true, infra: false };
	const dropped: ArmResult = { valid: false, infra: true };
	const broken: ArmResult = { valid: false, infra: false };
	const noon = Date.UTC(2026, 8, 26, 12, 0);
	const runner = (attemptsThisRun: number): PairRules => ({ attemptCeiling: DEFAULT_BREAKER.attemptCeiling, requeue: { policy: DEFAULT_BREAKER, atMs: noon, attemptsThisRun } });

	it("keeps a pair whose two arms are valid at the same attempt", () => {
		expect(nextPairAction(2, [valid, valid], runner(2))).toEqual({ kind: "keep" });
	});

	// Both arms re-run, so a valid partner is never paired with an arm measured
	// in another provider window; the wait grows with each failed attempt.
	it("re-queues at the next attempt after the cooldown", () => {
		expect(nextPairAction(1, [valid, dropped], runner(1))).toEqual({
			kind: "rerun", attempt: 2, notBeforeMs: noon + 60_000, reason: "attempt 1: an arm failed for an infrastructure reason",
		});
		expect(nextPairAction(3, [dropped, dropped], runner(3))).toMatchObject({ kind: "rerun", attempt: 4, notBeforeMs: noon + 180_000 });
	});

	// v5 spent 14 attempts on one pair. Past the cap the runner moves on, and the
	// pair waits for the operator's --resume.
	it("stops re-queuing at the attempt cap", () => {
		const action = nextPairAction(4, [dropped, valid], runner(4));
		expect(action.kind).toBe("give-up");
		expect(action.kind === "give-up" ? action.reason : "").toMatch(/the cap of 4, so only a --resume re-runs it$/);
	});

	// The cap counts this runner's attempts: a resumed pair at attempt 5 gets its
	// own, or the first drop after a resume would stall it as fail-fast did.
	it("counts the cap from the attempt this runner started the pair at", () => {
		expect(nextPairAction(5, [dropped, valid], runner(1))).toMatchObject({ kind: "rerun", attempt: 6, notBeforeMs: noon + 60_000 });
	});

	// Re-running a harness or candidate failure would chase a defect with tokens
	// and select the arm by its survival.
	it("never re-queues a non-infrastructure failure", () => {
		for (const arms of [[broken, valid], [dropped, broken], [broken, undefined]]) {
			expect(nextPairAction(1, arms, runner(1))).toEqual({
				kind: "blocked", reason: "attempt 1: an arm is invalid for a non-infrastructure reason; it stays invalid",
			});
		}
	});

	// Without a ceiling an auto-resumer could re-run one pair forever. At K the
	// pair is abandoned for the runner and for planResume alike, so the loop ends.
	it("abandons a pair still failing at the attempt ceiling, with or without a requeue context", () => {
		expect(nextPairAction(15, [dropped, valid], runner(1))).toMatchObject({ kind: "rerun", attempt: 16 });
		const atCeiling = nextPairAction(16, [dropped, valid], runner(1));
		expect(atCeiling.kind).toBe("abandoned");
		expect(atCeiling.kind === "abandoned" ? atCeiling.reason : "").toMatch(/16 is the attempt ceiling of 16, so the pair is abandoned and the grid cannot approve$/);
		expect(nextPairAction(16, [valid, undefined], { attemptCeiling: 16 }).kind).toBe("abandoned");
		// The ceiling decides before the per-runner cap, and never touches a kept or blocked pair.
		expect(nextPairAction(16, [dropped, valid], runner(4)).kind).toBe("abandoned");
		expect(nextPairAction(16, [valid, valid], runner(1)).kind).toBe("keep");
		expect(nextPairAction(16, [broken, valid], runner(1)).kind).toBe("blocked");
	});

	// planResume asks without a context: the resume is itself the decision to
	// spend more, so there is no wait and no cap.
	it("re-runs at the next attempt with no wait and no cap when asked without a requeue context", () => {
		expect(nextPairAction(9, [dropped, valid])).toEqual({ kind: "rerun", attempt: 10, notBeforeMs: 0, reason: "attempt 9: an arm failed for an infrastructure reason" });
		expect(nextPairAction(0, [undefined, undefined])).toMatchObject({ kind: "rerun", attempt: 1, reason: "the pair has no run yet" });
		expect(nextPairAction(2, [valid, undefined])).toMatchObject({ kind: "rerun", attempt: 3, reason: "attempt 2: an arm has no run at that attempt" });
	});
});

describe("isOfficialGrid", () => {
	const official = (): ExpectedCell[] => planSchedule([...OFFICIAL_TARGET_IDS], OFFICIAL_PASSES).map(({ key, target, pass }) => ({ key, target, pass }));

	it("accepts only the exact five-target, three-pass grid", () => {
		expect(isOfficialGrid(official())).toBe(true);
		expect(isOfficialGrid(official().reverse())).toBe(true);
	});

	it("rejects a subset, an extra pass, a duplicated cell and a substituted target", () => {
		expect(isOfficialGrid(official().slice(0, 12))).toBe(false);
		expect(isOfficialGrid([...official(), { key: "CVE-2025-52903#4", target: "CVE-2025-52903", pass: 4 }])).toBe(false);
		expect(isOfficialGrid([...official().slice(0, 14), official()[0]!])).toBe(false);
		expect(isOfficialGrid(official().map((c) => c.target === "CVE-2026-40262" ? { ...c, target: "CVE-2020-0001" } : c))).toBe(false);
	});
});

describe("leak checks", () => {
	it("derives trimmed, de-duplicated advisory terms from a target and its aliases", () => {
		expect(leakTermsFor({ id: "CVE-2025-52903", aliases: [" GHSA-3q2w-5c6v-8j4r ", "CVE-2025-52903", ""] })).toEqual(["CVE-2025-52903", "GHSA-3q2w-5c6v-8j4r"]);
		expect(leakTermsFor({ id: "CVE-2025-52903", aliases: "not a list" })).toEqual(["CVE-2025-52903"]);
	});

	it("catches the target ID in any case or separator style, and its alias", () => {
		const terms = leakTermsFor({ id: "CVE-2025-52903", aliases: ["GHSA-3q2w-5c6v-8j4r"] });
		expect(findLeaks({ cwd: "/tmp/cells/run-cve-2025-52903/work" }, terms)).toEqual(["cwd: CVE-2025-52903"]);
		expect(findLeaks({ workspace: "/tmp/cells/run_CVE_2025_52903" }, terms)).toEqual(["workspace: CVE-2025-52903"]);
		expect(findLeaks({ prompt: "see ghsa-3q2w-5c6v-8j4r" }, terms)).toEqual(["prompt: GHSA-3q2w-5c6v-8j4r"]);
	});

	it("catches any advisory-shaped ID, including one after the target's own", () => {
		const terms = ["CVE-2025-52903"];
		expect(findLeaks({ env: "PIRED_ENGAGEMENT=CVE-2024-22417" }, terms)).toEqual(["env: CVE-2024-22417"]);
		expect(findLeaks({ env: "CVE-2025-52903 and CVE-2022-39281" }, terms)).toEqual(["env: CVE-2025-52903", "env: CVE-2022-39281"]);
		expect(findLeaks({ path: "/x/GHSA-aaaa-bbbb-cccc" }, terms)).toEqual([]);
		expect(findLeaks({ path: "/x/GHSA-2222-3333-4444" }, terms)).toEqual(["path: GHSA-2222-3333-4444"]);
	});

	it("passes a clean opaque path and a short alias that is not an identifier", () => {
		expect(findLeaks({ cwd: "/tmp/pired-compare/cell-07/b/work", workspace: "/tmp/pired-compare/cell-07/b/ledger" }, ["CVE-2025-52903"])).toEqual([]);
		expect(findLeaks({ cwd: "/tmp/c/f-m/work" }, ["fm"])).toEqual([]);
	});
});

const run = (key: string, target: string, pass: number, tp: number, precision: number, tokens: number, valid = true): RunMetric => ({
	key, target, pass, valid, truePositives: tp, precision, totalClaims: tp + 2, totalTokens: tokens,
});

/** The official five targets x three passes, as the runner schedules them. */
const officialCells = (): ExpectedCell[] => planSchedule([...OFFICIAL_TARGET_IDS], OFFICIAL_PASSES).map(({ key, target, pass }) => ({ key, target, pass }));
const runsFor = (cells: ExpectedCell[], tp: number, tokens: (cell: ExpectedCell, i: number) => number) =>
	cells.map((cell, i) => run(cell.key, cell.target, cell.pass, tp, tp / (tp + 2), tokens(cell, i)));

/** A run with an explicit claim count, for precision cases the tp+2 builder cannot express. */
const claimed = (cell: ExpectedCell, tp: number, claims: number, tokens: number): RunMetric => ({
	key: cell.key, target: cell.target, pass: cell.pass, valid: true, truePositives: tp,
	totalClaims: claims, precision: claims ? tp / claims : 0, totalTokens: tokens,
});

describe("compareMatchedRuns", () => {
	it("approves the complete official grid when quality holds and tokens fall", () => {
		const cells = officialCells();
		const report = compareMatchedRuns(runsFor(cells, 1, () => 1000), runsFor(cells, 1, () => 700), cells);
		expect(report.complete).toBe(true);
		expect(report.official).toBe(true);
		expect(report.pairedRuns).toBe(15);
		expect(report.gate.qualityWithinMargin).toBe(true);
		expect(report.gate.truePositiveFloor).toBeCloseTo(QUALITY_MARGIN * 5);
		expect(report.meanTokenReductionObserved).toBe(true);
		expect(report.tokenRangesSeparated).toBe(true);
		expect(report.candidate.totalTokens.mean).toBe(3500);
		expect(report.pairedDelta.totalTokens.mean).toBe(-1500);
		expect(report.decision).toBe(APPROVAL_DECISION);
	});

	it("labels identical numbers on a subset exploratory, so a favourable slice cannot pass for the corpus", () => {
		const cells = officialCells().filter((cell) => cell.target !== "CVE-2022-39281");
		const report = compareMatchedRuns(runsFor(cells, 1, () => 1000), runsFor(cells, 1, () => 700), cells);
		expect(report.complete).toBe(true);
		expect(report.official).toBe(false);
		expect(report.gate.qualityWithinMargin).toBe(true);
		expect(report.meanTokenReductionObserved).toBe(true);
		expect(report.decision).toBe("exploratory_not_decisive");
	});

	it("invalidates an unmatched or failed cell pair", () => {
		const report = compareMatchedRuns([run("a:1", "a", 1, 0, 0, 0, false)], [], [{ key: "a:1", target: "a", pass: 1 }]);
		expect(report.complete).toBe(false);
		expect(report.decision).toBe("incomplete_or_invalid");
		expect(report.missingOrInvalid).toEqual(["a:1"]);
	});

	it("leaves the gate unevaluated on an incomplete grid instead of reporting a quality failure", () => {
		const cells = officialCells();
		const candidate = runsFor(cells, 2, () => 700).slice(1);
		const report = compareMatchedRuns(runsFor(cells, 1, () => 1000), candidate, cells);
		expect(report.complete).toBe(false);
		expect(report.gate.truePositivesWithinMargin).toBeNull();
		expect(report.gate.precisionWithinMargin).toBeNull();
		expect(report.gate.qualityWithinMargin).toBeNull();
		expect(report.decision).toBe("incomplete_or_invalid");
	});

	it("approves a candidate that loses one true positive in one pass, which is inside the 15% margin", () => {
		const cells = officialCells();
		// Baseline: 2 TP on every target, 10 per pass. Candidate: one target drops
		// to 1 TP in pass 3 only — 29 of 30, and its range still meets the baseline's.
		const candidate = cells.map((cell) => claimed(cell, cell.target === "CVE-2024-22417" && cell.pass === 3 ? 1 : 2, 4, 700));
		const report = compareMatchedRuns(cells.map((cell) => claimed(cell, 2, 4, 1000)), candidate, cells);
		expect(report.candidate.truePositives.mean).toBeCloseTo(29 / 3);
		expect(report.gate.targetsBelowBaselineRange).toEqual([]);
		expect(report.decision).toBe(APPROVAL_DECISION);
	});

	it("rejects a cheaper candidate whose pass-mean true positives fall below 85% of the baseline", () => {
		const cells = officialCells();
		// 10 TP per pass against 8, 9 and 8: mean 8.33 is under the 8.5 floor, and
		// no single target falls below its baseline range, so only the margin decides.
		const lose = new Map([[1, ["CVE-2025-52903", "CVE-2025-62721"]], [2, ["CVE-2025-52903"]], [3, ["CVE-2024-22417", "CVE-2026-40262"]]]);
		const candidate = cells.map((cell) => claimed(cell, lose.get(cell.pass)!.includes(cell.target) ? 1 : 2, 4, 700));
		const report = compareMatchedRuns(cells.map((cell) => claimed(cell, 2, 4, 1000)), candidate, cells);
		expect(report.gate.targetsBelowBaselineRange).toEqual([]);
		expect(report.gate.truePositivesWithinMargin).toBe(false);
		expect(report.meanTokenReductionObserved).toBe(true);
		expect(report.decision).toBe("quality_below_margin");
	});

	it("rejects a candidate that keeps its true positives by claiming far more, since pooled precision falls past the margin", () => {
		const cells = officialCells();
		const report = compareMatchedRuns(cells.map((cell) => claimed(cell, 2, 4, 1000)), cells.map((cell) => claimed(cell, 2, 8, 700)), cells);
		expect(report.gate.truePositivesWithinMargin).toBe(true);
		expect(report.candidate.pooledPrecision).toBe(0.25);
		expect(report.gate.precisionFloor).toBeCloseTo(QUALITY_MARGIN * 0.5);
		expect(report.gate.precisionWithinMargin).toBe(false);
		expect(report.decision).toBe("quality_below_margin");
	});

	it("withholds approval when one target's candidate range lies wholly below its baseline range, even though the pooled mean holds", () => {
		const cells = officialCells();
		const candidate = cells.map((cell) => cell.target === "CVE-2024-22417"
			? run(cell.key, cell.target, cell.pass, 0, 0, 700)
			: run(cell.key, cell.target, cell.pass, 2, 0.5, 700));
		const report = compareMatchedRuns(runsFor(cells, 1, () => 1000), candidate, cells);
		expect(report.candidate.truePositives.mean).toBeGreaterThan(report.baseline.truePositives.mean);
		expect(report.gate.targetsBelowBaselineRange).toEqual(["CVE-2024-22417"]);
		expect(report.decision).toBe("quality_below_margin");
	});

	it("names a missing token saving separately from a quality failure", () => {
		const cells = officialCells();
		const dearer = compareMatchedRuns(runsFor(cells, 1, () => 1000), runsFor(cells, 1, () => 1200), cells);
		expect(dearer.gate.qualityWithinMargin).toBe(true);
		expect(dearer.decision).toBe("no_token_reduction");
		const both = compareMatchedRuns(runsFor(cells, 2, () => 1000), runsFor(cells, 1, () => 1000), cells);
		expect(both.decision).toBe("quality_below_margin_and_no_token_reduction");
	});

	it("does not penalize a zero-claim run when the target's pooled TP and claims are unchanged", () => {
		// Review case A: 1/2 three times against 0/0, 2/4, 1/2. Averaging per-run
		// ratios scored the zero-claim run as 0 and rejected an identical candidate.
		const cells = officialCells();
		const baseline = cells.map((cell) => claimed(cell, 1, 2, 1000));
		const shape = new Map([[1, [0, 0]], [2, [2, 4]], [3, [1, 2]]]);
		const candidate = cells.map((cell) => cell.target === "CVE-2025-52903"
			? claimed(cell, shape.get(cell.pass)![0]!, shape.get(cell.pass)![1]!, 700)
			: claimed(cell, 1, 2, 700));
		const report = compareMatchedRuns(baseline, candidate, cells);
		const target = report.targets.find((t) => t.target === "CVE-2025-52903")!;
		expect(target.candidate.pooledPrecision).toBe(0.5);
		expect(report.candidate.pooledPrecision).toBe(report.baseline.pooledPrecision);
		expect(report.decision).toBe(APPROVAL_DECISION);
	});

	it("reports a target's precision as pooled TP over claims, so one lucky 1/1 run cannot hide four times the claims", () => {
		// Review case B: 3 TP over 15 claims against 3 TP over 61. A mean of per-run
		// ratios put the candidate ahead (0.356 vs 0.200); pooled, it is 0.049.
		const cells = officialCells();
		const b = new Map([[1, [1, 5]], [2, [1, 5]], [3, [1, 5]]]);
		const c = new Map([[1, [1, 1]], [2, [1, 30]], [3, [1, 30]]]);
		const pick = (m: Map<number, number[]>, cell: ExpectedCell, tokens: number) => cell.target === "CVE-2025-52903"
			? claimed(cell, m.get(cell.pass)![0]!, m.get(cell.pass)![1]!, tokens) : claimed(cell, 1, 2, tokens);
		const report = compareMatchedRuns(cells.map((cell) => pick(b, cell, 1000)), cells.map((cell) => pick(c, cell, 700)), cells);
		const target = report.targets.find((t) => t.target === "CVE-2025-52903")!;
		expect(target.baseline.pooledPrecision).toBeCloseTo(0.2);
		expect(target.candidate.pooledPrecision).toBeCloseTo(3 / 61);
	});

	it("leaves precision ungated when the baseline claimed nothing at all", () => {
		const cells = officialCells();
		const report = compareMatchedRuns(cells.map((cell) => claimed(cell, 0, 0, 1000)), cells.map((cell) => claimed(cell, 0, 3, 700)), cells);
		expect(report.baseline.pooledPrecision).toBeNull();
		expect(report.gate.precisionFloor).toBeNull();
		expect(report.decision).toBe(APPROVAL_DECISION);
	});

	it("treats the same precisions summed in a different order as a tie, not a loss", () => {
		const cells = officialCells();
		const claims = [3, 7, 11];
		const baseline = cells.map((cell) => claimed(cell, 1, claims[cell.pass - 1]!, 1000));
		const candidate = cells.map((cell) => claimed(cell, 1, claims[(cell.pass + 1) % 3]!, 700));
		const report = compareMatchedRuns(baseline, candidate, cells);
		expect(report.gate.precisionWithinMargin).toBe(true);
		expect(report.decision).toBe(APPROVAL_DECISION);
	});

	it("keeps overlapping token ranges distinct from a consistent saving", () => {
		const cells = officialCells();
		const report = compareMatchedRuns(
			runsFor(cells, 1, (cell) => cell.pass === 2 ? 700 : 1000),
			runsFor(cells, 1, (cell) => cell.pass === 2 ? 1000 : 700),
			cells,
		);
		expect(report.meanTokenReductionObserved).toBe(true);
		expect(report.tokenRangesSeparated).toBe(false);
	});

	it("rejects duplicate target/pass rows and inconsistent metrics", () => {
		const cells = [
			{ key: "a:1", target: "a", pass: 1 },
			{ key: "b:1", target: "b", pass: 1 },
		];
		const baseline = [run("a:1", "a", 1, 1, 1 / 3, 100), run("b:1", "a", 1, 1, 1 / 3, 100)];
		const candidate = [run("a:1", "a", 1, 1, 1 / 3, 80), run("b:1", "b", 1, 1, 0.9, 80)];
		const report = compareMatchedRuns(baseline, candidate, cells);
		expect(report.complete).toBe(false);
		expect(report.decision).toBe("incomplete_or_invalid");
		expect(report.missingOrInvalid.some((x) => x.includes("identity mismatch"))).toBe(true);
		expect(report.missingOrInvalid.some((x) => x.includes("inconsistent precision"))).toBe(true);
	});

	it("rejects repeated, unexpected and out-of-range rows", () => {
		const cells = officialCells();
		const baseline = [...runsFor(cells, 1, () => 1000), run(cells[0]!.key, cells[0]!.target, cells[0]!.pass, 1, 1 / 3, 1000), run("extra#1", "extra", 1, 1, 1 / 3, 1)];
		const candidate = [
			...runsFor(cells, 1, () => 700).map((r, i) => i === 1 ? { ...r, truePositives: 5, totalClaims: 3, precision: 5 / 3 } : r),
			run(cells[2]!.key, cells[2]!.target, cells[2]!.pass, 1, 1 / 3, 1),
		];
		const report = compareMatchedRuns(baseline, candidate, cells);
		expect(report.decision).toBe("incomplete_or_invalid");
		expect(report.missingOrInvalid).toEqual(expect.arrayContaining([
			`baseline duplicate ${cells[0]!.key}`,
			`candidate duplicate ${cells[2]!.key}`,
			"baseline unexpected extra#1",
			`candidate invalid metric values ${cells[1]!.key}`,
		]));
	});

	it("rejects a run that reports no tokens, which is what a lost usage ledger sums to", () => {
		const cells = officialCells();
		const candidate = runsFor(cells, 1, (_, i) => i === 4 ? 0 : 700);
		const report = compareMatchedRuns(runsFor(cells, 1, () => 1000), candidate, cells);
		expect(report.complete).toBe(false);
		expect(report.decision).toBe("incomplete_or_invalid");
		expect(report.missingOrInvalid).toEqual([cells[4]!.key, `candidate reports no tokens ${cells[4]!.key}`]);
	});

	it("rejects a duplicated expected grid", () => {
		const cells = [...officialCells(), officialCells()[0]!];
		const report = compareMatchedRuns(runsFor(cells.slice(0, 15), 1, () => 1000), runsFor(cells.slice(0, 15), 1, () => 700), cells);
		expect(report.complete).toBe(false);
		expect(report.missingOrInvalid).toContain("expected target/pass grid is duplicated or incomplete");
	});
});

describe("summarizeRetries", () => {
	const attempt = (over: Partial<RetriedAttempt> = {}): RetriedAttempt => ({ id: "r", origin: "parent", recovered: true, meteredTokens: 0, estimatedTokens: 0, estimateBasis: "none", ...over });

	it("counts attempts per source, recovered or not, with metered usage and the estimate apart", () => {
		const summary = summarizeRetries([
			attempt({ id: "p1", meteredTokens: 40 }),
			attempt({ id: "p2", estimatedTokens: 1_200 }),
			attempt({ id: "w1", origin: "worker", recovered: false, estimatedTokens: 800 }),
			attempt({ id: "summary-retry:1" }),
		], { maxFailedAttempts: 12, maxFailedAttemptRate: 0.1 }, 98);
		expect(summary).toEqual({
			attempts: 4, recovered: 3, unrecovered: 1,
			bySource: { parent: { attempts: 3, recovered: 3, unrecovered: 0 }, worker: { attempts: 1, recovered: 0, unrecovered: 1 } },
			meteredTokens: 40, unmeteredAttempts: 3, estimatedTokens: 2_000, unestimatedAttempts: 1,
			cap: { floor: 12, rate: 0.1, meteredRequests: 98, allowed: 12 }, capExceeded: false,
		});
	});

	// pi's maxRetries resets on every good reply; a provider that dropped every
	// third request would otherwise be retried all run and the run read as valid.
	it("flags a run with more failed attempts than the run-wide cap, parent and workers together", () => {
		const attempts = [attempt(), attempt(), attempt({ origin: "worker" })];
		expect(summarizeRetries(attempts, { maxFailedAttempts: 3, maxFailedAttemptRate: 0 }, 50).capExceeded).toBe(false);
		expect(summarizeRetries(attempts, { maxFailedAttempts: 2, maxFailedAttemptRate: 0 }, 50).capExceeded).toBe(true);
	});

	// A fixed cap throws out long runs first, and the arm that makes more calls
	// has more of them (v5c luna: 117 requests a valid candidate run, 98 a
	// baseline one); each run it throws out is re-run as infrastructure.
	it("scales the cap with the run's metered requests, never below the floor", () => {
		const thirteen = Array.from({ length: 13 }, () => attempt());
		const policy = { maxFailedAttempts: 12, maxFailedAttemptRate: 0.1 };
		expect(summarizeRetries(thirteen, policy, 98)).toMatchObject({ cap: { allowed: 12 }, capExceeded: true });
		expect(summarizeRetries(thirteen, policy, 139)).toMatchObject({ cap: { allowed: 13 }, capExceeded: false });
		expect(summarizeRetries(thirteen, policy, 0)).toMatchObject({ cap: { allowed: 12 }, capExceeded: true });
	});

	it("counts only observations that reported spend as metered calls", () => {
		expect(meteredCallCount([
			{ id: "a", origin: "parent", usage: usage(10, 2) },
			{ id: "b", origin: "parent", usage: usage(0, 0) },
			{ id: "c", origin: "worker" },
		])).toBe(1);
	});
});

describe("the v5 reading, without a retry policy", () => {
	// Inputs and outputs captured from the extractor at b8ba1e8, before any retry
	// code existed. Comparing the option-off path with itself would pass however
	// the retry work changed it; comparing with v5 pins what every old grid read.
	const golden = JSON.parse(readFileSync(new URL("./fixtures/delegation-compare-lib.v5-golden.json", import.meta.url), "utf8")) as {
		cases: Array<{ name: string; kind: "parent" | "worker"; events?: Array<Record<string, unknown>>; session?: string; childKey?: string; output: unknown }>;
	};

	it("covers parent streams and worker sessions with retries, overflows and context edits in them", () => {
		expect(golden.cases.filter((c) => c.kind === "parent").length).toBeGreaterThanOrEqual(8);
		expect(golden.cases.filter((c) => c.kind === "worker").length).toBeGreaterThanOrEqual(8);
	});

	for (const c of golden.cases) {
		it(`reproduces the v5 output byte for byte, with no option and with retry off: ${c.kind} ${c.name}`, () => {
			const expected = JSON.stringify(c.output);
			if (c.kind === "parent") {
				expect(JSON.stringify(observationsFromPiEvents(c.events!))).toBe(expected);
				expect(JSON.stringify(observationsFromPiEvents(c.events!, { retry: false }))).toBe(expected);
			} else {
				expect(JSON.stringify(observationsFromChildSession(c.session, c.childKey!))).toBe(expected);
				expect(JSON.stringify(observationsFromChildSession(c.session, c.childKey!, { retry: false }))).toBe(expected);
			}
		});
	}
});
