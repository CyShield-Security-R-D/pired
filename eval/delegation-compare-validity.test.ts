import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountCellUsage, decideInfra } from "./delegation-compare.ts";
import { DEFAULT_RETRY_POLICY } from "./delegation-compare-entry.ts";
import { createBreaker, DEFAULT_BREAKER } from "./delegation-compare-lib.ts";
import {
	FAST_EMPTY_ERROR, fastEmptyBlockers, inFlightWorkers, judgeRun, limitError, parentToolResults, runNumbers, stalledReason, STALL_SECONDS, VALIDITY_POLICY_TEXT,
	type InFlightWorker, type RunFacts, type ToolResult,
} from "./delegation-compare-validity.ts";

// Per-file builders: pi's transcript events and child sessions as a run stopped
// at the limit leaves them, the facts inspectRun hands the judge, and the
// grader's reading of a ledger. No shared fixtures, by house rule.
type Event = Record<string, unknown>;
const LIMIT_MS = 14_400_000;
const EXPECT = { provider: "openai-codex", model: "gpt-6-luna", thinking: "medium" };
const RUN_A = "0d97e505-eafd-486e-b4a6-100d223d4953";
const RUN_B = "c9cbc1e8-d449-4e0e-a74b-5ba5e3563c7a";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const usage = (input: number, output: number, cacheRead: number) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
let clock = 1_790_190_000_000;
const parentReply = (id: string, stopReason: string): Event => ({
	type: "message_end",
	message: { role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna", usage: usage(2_000, 300, 40_000), stopReason, timestamp: clock++, responseId: id },
});
const callStart = (id: string): Event => ({ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args: { agent: "pired-investigate", task: "Investigate the upload handler." } });
const childRow = (runId: string, dir: string): Event => ({ index: 0, agent: "pired-investigate", task: "[prompt redacted]", exitCode: 0, model: "openai-codex/gpt-6-luna", sessionFile: `${dir}/${runId}/run-0/session.jsonl` });
const progress = (id: string, runId: string, dir: string): Event => ({
	type: "tool_execution_update", toolCallId: id, toolName: "subagent",
	partialResult: { content: [{ type: "text", text: "(running...)" }], details: { mode: "single", runId, context: "fresh", results: [childRow(runId, dir)] } },
});
const callEnd = (id: string, runId: string, dir: string): Event => ({
	type: "tool_execution_end", toolCallId: id, toolName: "subagent", isError: false,
	result: { content: [{ type: "text", text: "Recorded finding c0ffee (suspected) at src/upload.go:42." }], details: { mode: "single", runId, results: [childRow(runId, dir)] } },
});

let seq = 0;
const entry = (type: string, fields: Event = {}): Event => ({ type, id: (++seq).toString(16).padStart(8, "0"), parentId: null, timestamp: "2026-09-27T10:00:00.000Z", ...fields });
const childReply = (id: string, stopReason: string, opts: { model?: string; tokens?: [number, number, number]; errorMessage?: string } = {}): Event => entry("message", {
	message: {
		role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: opts.model ?? "gpt-6-luna",
		usage: usage(...(opts.tokens ?? [1_000, 200, 30_000])), stopReason, responseId: id, timestamp: 1_790_190_130_069,
		...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
	},
});
const session = (thinking: string, ...rows: Event[]): string => [
	{ type: "session", version: 3, id: "01a0cfa5-9385-76cc-8e20-d7ece690978f", timestamp: "2026-09-27T10:00:00.000Z", cwd: "/work" },
	entry("model_change", { provider: "openai-codex", modelId: "gpt-6-luna" }),
	entry("thinking_level_change", { thinkingLevel: thinking }),
	entry("message", { message: { role: "user", content: [{ type: "text", text: "Task: investigate the upload handler." }] } }),
	...rows,
].map((row) => JSON.stringify(row)).join("\n") + "\n";

/**
 * A delegating run the runner stopped at the limit: worker A finished and was
 * claimed; worker B was still running (its call never ended), with two
 * completed replies in its session. `extra` adds files under the session dir.
 */
function cutRun(opts: { bRows?: Event[]; extra?: Record<string, string> } = {}): { dir: string; events: Event[] } {
	const dir = mkdtempSync(join(tmpdir(), "validity-cut-"));
	dirs.push(dir);
	const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); };
	write(`${RUN_A}/run-0/session.jsonl`, session("medium", childReply("a1", "toolUse"), childReply("a2", "stop")));
	write(`${RUN_B}/run-0/session.jsonl`, session("medium", ...(opts.bRows ?? [childReply("b1", "toolUse", { tokens: [1_000, 200, 30_000] }), childReply("b2", "toolUse", { tokens: [1_500, 400, 45_000] })])));
	for (const [rel, text] of Object.entries(opts.extra ?? {})) write(rel, text);
	const events = [
		parentReply("r1", "toolUse"), callStart("call_a"), progress("call_a", RUN_A, dir), callEnd("call_a", RUN_A, dir),
		parentReply("r2", "toolUse"), callStart("call_b"), progress("call_b", RUN_B, dir),
		// The stop: no end for call_b, and no closing reply.
	];
	return { dir, events };
}

const cell = (dir: string) => ({ arm: "candidate" as const, childSessionDir: dir });
/** What inspectRun collects for a run the runner stopped: its own two lines, then the accounting's. */
async function stoppedRun(run: { dir: string; events: Event[] }, limit = true) {
	const accounting = await accountCellUsage(run.events, cell(run.dir), EXPECT, { subagentCalls: 2 }, { ...DEFAULT_RETRY_POLICY }, limit ? { limit: true } : {});
	return { accounting, errors: [limitError(LIMIT_MS), "process failed with exit=143 signal=none", ...accounting.errors] };
}

const facts = (over: Partial<RunFacts> = {}): RunFacts => ({ timedOut: false, fastEmpty: false, errors: [], ...over });
const ledger = (truePositives: number, totalFindings: number) => ({ ok: true as const, truePositives, totalFindings, precision: totalFindings ? truePositives / totalFindings : 0 });
const NO_FLAGS = { reachedLimit: false, fastEmpty: false, limitEffects: [], tokensLowerBound: false, inFlightWorkers: [], stalled: false, idleAtLimitSeconds: null };

describe("a run stopped at the limit, as the accounting reads it", () => {
	it("leaves the cut-off parent, the call still out and its unclaimed session as its errors, and nothing else", async () => {
		const { errors, accounting } = await stoppedRun(cutRun(), false);
		expect(errors).toEqual([
			limitError(LIMIT_MS), "process failed with exit=143 signal=none",
			"final assistant reply ended with toolUse, not stop",
			"parent did not finish with an assistant stopReason=stop",
			"subagent call call_b never ended",
			`session file ${RUN_B}/run-0/session.jsonl is claimed by no subagent call`,
		]);
		expect(accounting.inFlight).toBeUndefined();
	});

	// Claimed and in flight are disjoint: worker A is accounted through its call, B from its file, neither twice.
	it("counts the in-flight worker's completed replies once, beside the claimed worker's, under {limit: true}", async () => {
		const { accounting } = await stoppedRun(cutRun());
		expect(accounting.inFlight).toEqual([{ key: `${RUN_B}/run-0`, file: `${RUN_B}/run-0/session.jsonl`, replies: 2, largestReply: 46_900 }]);
		expect(accounting.children.map((c) => c.child.childKey)).toEqual([`${RUN_A}/run-0`]);
		expect(accounting.usage.valid).toBe(true);
		expect(accounting.usage.worker.totalTokens).toBe(2 * 31_200 + 31_200 + 46_900);
		expect(accounting.usage.parent.totalTokens).toBe(2 * 42_300);
	});

	it("lists an in-flight worker's retried attempts in the run's retry summary", async () => {
		const failed = childReply("b2", "error", { tokens: [0, 0, 0], errorMessage: "terminated" });
		const { accounting } = await stoppedRun(cutRun({ bRows: [childReply("b1", "toolUse"), failed, entry("context_edit", { targetId: failed.id, replacement: null })] }));
		expect(accounting.retry?.bySource.worker.attempts).toBe(1);
		expect(accounting.retry?.attempts).toBe(1);
	});

	it("leaves a stray unclaimed file that is not a session as an error the policy does not waive", async () => {
		const run = cutRun({ extra: { [`${RUN_B}/run-0/progress.json`]: "{}" } });
		const { errors, accounting } = await stoppedRun(run);
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight }));
		expect(judged.valid).toBe(false);
		expect(judged.errors).toEqual([`session file ${RUN_B}/run-0/progress.json is claimed by no subagent call`]);
	});

	it("routes an in-flight worker's provider failure to the classifier, so it is infrastructure like any other", async () => {
		const { errors, accounting } = await stoppedRun(cutRun({ bRows: [childReply("b1", "toolUse"), childReply("b2", "error", { tokens: [0, 0, 0], errorMessage: "503 upstream connect error, please retry" })] }));
		expect(accounting.childProviderErrors.map((e) => e.childKey)).toEqual([`${RUN_B}/run-0`]);
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight }));
		expect(judged.valid).toBe(false);
		// Under v6 the waived limit is not a reason to skip the classifier (timedOut: false).
		const infra = decideInfra({ valid: false, timedOut: false, stoppedByRunner: false, notLaunchedInterrupted: false, failures: { parent: [], workers: accounting.childProviderErrors.map((e) => e.text), fetchErrors: [] } });
		expect(infra.infra).toBe(true);
	});
});

describe("without a validity policy", () => {
	// v5 grids and every grid before the option: byte-identical verdicts.
	it("keeps a limit-reaching run invalid with every error it had, and writes no flag", async () => {
		const { errors } = await stoppedRun(cutRun(), false);
		const judged = judgeRun(facts({ timedOut: true, errors }));
		expect(judged).toEqual({ valid: false, errors });
		expect("flags" in judged).toBe(false);
	});

	it("keeps a fast empty run invalid", () => {
		expect(judgeRun(facts({ fastEmpty: true, errors: [FAST_EMPTY_ERROR] }))).toEqual({ valid: false, errors: [FAST_EMPTY_ERROR] });
	});

	it("reads a clean run as valid and changes nothing", () => {
		expect(judgeRun(facts())).toEqual({ valid: true, errors: [] });
	});

	it("carries no token count for an invalid run, and the grader's numbers whatever the verdict, as inspectRun always wrote them", () => {
		const numbers = runNumbers(judgeRun(facts({ timedOut: true, errors: [limitError(LIMIT_MS)] })), ledger(3, 5), { valid: true, totalTokens: 9_000_000 }, 400);
		expect(numbers).toMatchObject({ truePositives: 3, totalClaims: 5, precision: 0.6 });
		expect(numbers.totalTokens).toBeNaN();
		expect(numbers.totalTokensWithRetryEstimate).toBeNaN();
	});
});

describe("the v6 validity policy", () => {
	// GPT-6 Luna reached the 2 h limit still working (the v5 held-out CasaOS run);
	// dropping such a run drops the arm that works longest.
	it("counts a run that reaches the run limit as valid, flags it, and keeps the stop's own errors as limit effects", async () => {
		const { errors, accounting } = await stoppedRun(cutRun());
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight, idleAtLimitSeconds: 40 }));
		expect(judged.valid).toBe(true);
		expect(judged.errors).toEqual([]);
		expect(judged.flags).toEqual({
			reachedLimit: true, fastEmpty: false, limitEffects: errors, stalled: false, idleAtLimitSeconds: 40,
			// Worker B's spend is its session's completed replies: a lower bound.
			tokensLowerBound: true, inFlightWorkers: [{ key: `${RUN_B}/run-0`, replies: 2, largestReply: 46_900 }],
		});
	});

	it("scores a limit-reaching run from its ledger at the deadline and counts the tokens metered up to it", async () => {
		const { errors, accounting } = await stoppedRun(cutRun());
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight }));
		expect(runNumbers(judged, ledger(2, 4), { valid: accounting.usage.valid, totalTokens: accounting.usage.total.totalTokens }, 500)).toEqual({
			truePositives: 2, totalClaims: 4, precision: 0.5, totalTokens: 2 * 42_300 + 3 * 31_200 + 46_900, totalTokensWithRetryEstimate: 2 * 42_300 + 3 * 31_200 + 46_900 + 500,
		});
	});

	it("flags the tokens a lower bound even when the worker in flight had written no session yet", () => {
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), "subagent call call_b never ended"] }));
		expect(judged.valid).toBe(true);
		expect(judged.flags).toMatchObject({ tokensLowerBound: true, inFlightWorkers: [] });
	});

	// A hung run is not one that worked to the limit: it is re-queued as infrastructure.
	it("classes a run silent more than 30 minutes before the limit as stalled infrastructure, not a limit run", async () => {
		const { errors, accounting } = await stoppedRun(cutRun());
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight, idleAtLimitSeconds: STALL_SECONDS + 60 }));
		expect(judged.valid).toBe(false);
		expect(judged.errors.at(-1)).toBe("stalled: silent 31 min before the limit");
		expect(judged.flags).toMatchObject({ reachedLimit: false, stalled: true, idleAtLimitSeconds: STALL_SECONDS + 60, limitEffects: [] });
		const infra = decideInfra({ valid: false, timedOut: true, stoppedByRunner: false, notLaunchedInterrupted: false, failures: { parent: [], workers: [], fetchErrors: [] }, stalled: judged.errors.at(-1)! });
		expect(infra).toEqual({ infra: true, reason: stalledReason(STALL_SECONDS + 60) });
		// Infrastructure is not blocked: the breaker counts it and re-queues the pair.
		expect(createBreaker({ ...DEFAULT_BREAKER }).record({ atMs: Number.NaN, valid: false, infra: true, exhausted: false, blocked: false })).toEqual({ tripped: false });
		expect(judgeRun(facts({ policy: "v6", timedOut: true, errors, inFlightWorkers: accounting.inFlight, idleAtLimitSeconds: STALL_SECONDS })).valid).toBe(true);
	});

	it("waives only the exit statuses the runner's stop leaves", () => {
		for (const status of ["process failed with exit=143 signal=none", "process failed with exit=137 signal=none", "process failed with exit=null signal=SIGKILL", "process failed with exit=null signal=SIGTERM"]) {
			expect(judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), status] })).valid, status).toBe(true);
		}
		for (const status of ["process failed with exit=1 signal=none", "process failed with exit=null signal=SIGSEGV"]) {
			expect(judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), status] })).errors, status).toEqual([status]);
		}
	});

	it("waives an unclaimed session only when a call was still out and that session was counted", () => {
		const file = `${RUN_B}/run-0/session.jsonl`;
		const unclaimed = `session file ${file} is claimed by no subagent call`;
		const worker: InFlightWorker = { key: `${RUN_B}/run-0`, file, replies: 1, largestReply: 10 };
		expect(judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), unclaimed], inFlightWorkers: [worker] })).errors).toEqual([unclaimed]);
		expect(judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), "subagent call c never ended", unclaimed] })).errors).toEqual([unclaimed]);
		expect(judgeRun(facts({ policy: "v6", timedOut: true, errors: [limitError(LIMIT_MS), "subagent call c never ended", unclaimed], inFlightWorkers: [worker] })).valid).toBe(true);
	});

	// Luna ended about 40% of its v5 runs within five minutes: quitting early is behaviour under test.
	it("counts a fast empty run as valid with zero findings, flagged fastEmpty, when nothing stood in its way", () => {
		const judged = judgeRun(facts({ policy: "v6", fastEmpty: true, errors: [FAST_EMPTY_ERROR], fastEmptyBlockers: [] }));
		expect(judged).toEqual({ valid: true, errors: [], flags: { ...NO_FLAGS, fastEmpty: true } });
		expect(runNumbers(judged, ledger(0, 0), { valid: true, totalTokens: 40_000 })).toMatchObject({ truePositives: 0, totalClaims: 0, totalTokens: 40_000 });
	});

	// A run the seal or the gate stopped, or one with no workspace, did not choose to stop.
	it("keeps a fast empty run invalid, with the reason, when the harness may have kept it from working", () => {
		const judged = judgeRun(facts({ policy: "v6", fastEmpty: true, errors: [FAST_EMPTY_ERROR], fastEmptyBlockers: ["pired's manifest.json is missing from the workspace"] }));
		expect(judged.valid).toBe(false);
		expect(judged.errors).toEqual([FAST_EMPTY_ERROR, "fast empty run not kept: pired's manifest.json is missing from the workspace"]);
		expect(judged.flags!.fastEmpty).toBe(false);
	});

	it("flags every run it judges, so a clean run reads reachedLimit false and fastEmpty false", () => {
		expect(judgeRun(facts({ policy: "v6" }))).toEqual({ valid: true, errors: [], flags: NO_FLAGS });
	});

	// Harness integrity is not model behaviour: on an official grid these still
	// trip the breaker at once (ADR-031), because the run stays invalid.
	it("still trips an official grid's breaker at once on a leak, and not on a run that reached the limit", async () => {
		const { errors, accounting } = await stoppedRun(cutRun());
		const breakerAfter = (all: string[]) => {
			const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: all, inFlightWorkers: accounting.inFlight }));
			const infra = decideInfra({ valid: judged.valid, timedOut: false, stoppedByRunner: false, notLaunchedInterrupted: false, failures: { parent: [], workers: [], fetchErrors: [] } }).infra;
			return createBreaker({ ...DEFAULT_BREAKER }).record({ atMs: Number.NaN, valid: judged.valid, infra, exhausted: false, blocked: !judged.valid && !infra });
		};
		expect(breakerAfter([...errors, "answer-key leak: CVE-2025-1234 in the target copy"])).toEqual({ tripped: true, reason: expect.stringMatching(/invalid for a non-infrastructure reason/) });
		expect(breakerAfter(errors)).toEqual({ tripped: false });
	});

	it("keeps every harness-integrity error invalid: tool surface, runtime and pins, bookkeeping, the scorer, the launch", async () => {
		const { errors: limit, accounting } = await stoppedRun(cutRun());
		const integrity = [
			"first request: candidate arm does not expose record",
			"expected one first-request tool list, found 0",
			"SDK runtime did not match the request: model gpt-6 is not gpt-6-luna",
			"external grader changed after preflight",
			"baseline arm made 2 subagent call(s)",
			"child run-1/0 (worker): replies came from openai/gpt-5, not openai-codex/gpt-6-luna",
			"provider usage attribution is incomplete",
			"3 malformed JSON event lines",
			"ledger/scorer inspection failed: ENOENT",
			"the cell's agent settings.json changed during the run",
			"a scored run emitted a probe report",
			"spawn pi ENOENT",
		];
		for (const error of integrity) {
			for (const timedOut of [false, true]) {
				const judged = judgeRun(facts({ policy: "v6", timedOut, errors: timedOut ? [...limit, error] : [error], inFlightWorkers: accounting.inFlight }));
				expect(judged.valid, error).toBe(false);
				expect(judged.errors, error).toEqual([error]);
			}
		}
	});

	// A run that did not reach the limit has no stop to blame its exit status on.
	it("keeps a failed exit or an unfinished parent invalid when the run did not reach the limit", () => {
		const errors = ["process failed with exit=143 signal=none", "parent did not finish with an assistant stopReason=stop"];
		const judged = judgeRun(facts({ policy: "v6", errors }));
		expect(judged.errors).toEqual(errors);
		expect(judged.flags!.limitEffects).toEqual([]);
	});

	it("does not waive the fast-empty text on a run that was not fast and empty", () => {
		expect(judgeRun(facts({ policy: "v6", errors: [FAST_EMPTY_ERROR] })).valid).toBe(false);
	});

	it("states the policy verbatim for the manifest, naming the flags and what stays invalid", () => {
		for (const text of [/reachedLimit:true/, /fastEmpty:true/, /tokensLowerBound:true/, /stalled/, /trips the breaker at once/]) expect(VALIDITY_POLICY_TEXT.v6).toMatch(text);
	});
});

describe("what may have kept a fast empty run from working", () => {
	const manifest = (engagement = "review-0123") => JSON.stringify({ formatVersion: 1, engagement, createdAt: "2026-09-27T10:00:00Z", stores: {} });
	const result = (over: Partial<ToolResult>): ToolResult => ({ side: "parent", tool: "bash", isError: false, text: "", ...over });
	const blockers = (over: { manifest?: string | undefined; results?: ToolResult[] } = {}) => fastEmptyBlockers({ manifest: "manifest" in over ? over.manifest : manifest(), engagement: "review-0123", results: over.results ?? [] });

	it("finds nothing when pired's workspace is there and no tool was refused", () => {
		expect(blockers({ results: [result({ text: "src/app.py" }), result({ tool: "record", text: "Recorded surface s1" })] })).toEqual([]);
	});

	// engagementTelemetry reads a missing workspace as zeros: an empty run and a run with no ledger look alike.
	it("names a missing, unreadable or foreign manifest", () => {
		expect(blockers({ manifest: undefined })).toEqual(["pired's manifest.json is missing from the workspace"]);
		expect(blockers({ manifest: "{" })).toEqual(["pired's manifest.json is unreadable or names no engagement"]);
		expect(blockers({ manifest: manifest("other") })).toEqual(["pired's manifest.json names engagement other, not review-0123"]);
	});

	it("names an error from a pired tool, on either side", () => {
		expect(blockers({ results: [result({ side: "worker", tool: "record", isError: true, text: "Ledger locked\nmore" })] })).toEqual(["worker record call failed: Ledger locked"]);
		expect(blockers({ results: [result({ tool: "recall", isError: true, text: "workspace not initialised" })] })).toEqual(["parent recall call failed: workspace not initialised"]);
	});

	it("names a call the scope gate blocked", () => {
		expect(blockers({ results: [result({ isError: true, text: "Out-of-scope target(s): 10.0.0.1. Only authorized targets in the engagement scope may be tested." })] }))
			.toEqual(["parent bash call was blocked: Out-of-scope target(s): 10.0.0.1. Only authorized targets in the engagement scope may be tested."]);
		expect(blockers({ results: [result({ isError: true, text: "Tool execution was blocked" })] })).toEqual(["parent bash call was blocked: Tool execution was blocked"]);
		// An ordinary failed command is the model's own.
		expect(blockers({ results: [result({ isError: true, text: "grep: no match\nexit code 1" })] })).toEqual([]);
	});

	it("names a seal denial, even in a result that is not an error", () => {
		expect(blockers({ results: [result({ text: "ls: cannot open directory '/target': Permission denied" })] })).toEqual(["parent bash call met a seal denial: ls: cannot open directory '/target': Permission denied"]);
		expect(blockers({ results: [result({ side: "worker", tool: "read", isError: true, text: "EACCES: permission denied, open '/target/app.py'" })] })[0]).toMatch(/^worker read call met a seal denial: EACCES/);
	});

	it("reads the parent's tool results from the transcript", () => {
		expect(parentToolResults([
			{ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Tool execution was blocked" }] } },
			{ type: "message_end", message: { role: "assistant" } },
		])).toEqual([{ side: "parent", tool: "bash", isError: true, text: "Tool execution was blocked" }]);
	});
});

describe("the spend of a worker cut off at the limit", () => {
	const E = { model: "openai-codex/gpt-6-luna", thinking: "medium" };
	const FILE = `${RUN_B}/run-0/session.jsonl`;

	it("counts the replies the worker completed before the stop, and names it by its key and largest reply", () => {
		const flight = inFlightWorkers([FILE], () => session("medium", childReply("r1", "toolUse"), childReply("r2", "toolUse", { tokens: [3_000, 100, 20_000] })), E);
		expect(flight.workers).toEqual([{ key: `${RUN_B}/run-0`, file: FILE, replies: 2, largestReply: 31_200 }]);
		expect(flight.observations.map((o) => [o.origin, o.usage?.totalTokens])).toEqual([["worker", 31_200], ["worker", 23_100]]);
		expect(flight.errors).toEqual([]);
		expect(flight.notes.at(-1)).toMatch(/2 completed replies counted from its session; the reply in flight is not, so the run's tokens are a lower bound/);
	});

	// The worker's tokens compare only when it ran the parent's model and effort, cut off or not.
	it("still refuses a worker on another model or effort", () => {
		const flight = inFlightWorkers([FILE], () => session("high", childReply("r1", "toolUse", { model: "gpt-5" })), E);
		expect(flight.errors).toEqual([
			`child ${RUN_B}/run-0 (in flight at the limit): replies came from openai-codex/gpt-5, not openai-codex/gpt-6-luna`,
			`child ${RUN_B}/run-0 (in flight at the limit): ran thinking high, not medium`,
		]);
	});

	it("notes a worker stopped before its first reply completed, and counts nothing for it", () => {
		const flight = inFlightWorkers([FILE], () => session("medium"), E);
		expect(flight.errors).toEqual([]);
		expect(flight.observations).toEqual([]);
		expect(flight.workers).toEqual([{ key: `${RUN_B}/run-0`, file: FILE, replies: 0, largestReply: 0 }]);
		expect(flight.notes[0]).toBe(`child ${RUN_B}/run-0: no assistant reply in the session`);
	});

	// A worker stopped in a retry's backoff did not fail: the stop cancelled the retry.
	it("notes a worker stopped during a retry's backoff, keeps its retry estimate, and does not fail it", () => {
		const failed = childReply("r2", "error", { tokens: [0, 0, 0], errorMessage: "terminated" });
		const flight = inFlightWorkers([FILE], () => session("medium", childReply("r1", "toolUse"), failed, entry("context_edit", { targetId: failed.id, replacement: null })), E, { retry: true });
		expect(flight.errors).toEqual([]);
		expect(flight.providerErrors).toEqual([]);
		expect(flight.retries.map((r) => [r.recovered, r.estimatedTokens])).toEqual([[false, 31_200]]);
		expect(flight.observations.every((o) => o.usage !== undefined)).toBe(true);
		expect(flight.notes.join("\n")).toMatch(/pi's retry of it never ran \(stopped at the limit during the backoff; its retry estimate is counted\)/);
	});

	it("keeps every other session error, such as a completed reply without usage", () => {
		const bare = entry("message", { message: { role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna", stopReason: "toolUse", responseId: "r9", timestamp: 1_790_190_130_069 } });
		expect(inFlightWorkers([FILE], () => session("medium", bare), E).errors).toEqual([`child ${RUN_B}/run-0: assistant reply r9 (toolUse) carries no usage`]);
	});

	it("reads only session files, and counts none for a file that is not one", () => {
		expect(inFlightWorkers([`${RUN_B}/run-0/progress.json`], () => "{}", E)).toEqual({ workers: [], observations: [], errors: [], notes: [], retries: [], providerErrors: [] });
	});
});
