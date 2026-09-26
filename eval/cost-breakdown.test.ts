import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attribute, breakdownSessions, CHARS_PER_TOKEN, formatReport, gridRuns, main, parseArgs, parseSession, perPair, pooledContextRatio,
	reportGrid, runBreakdown, selectRuns, type GridRun, type RunBreakdown, type RunMeta,
} from "./cost-breakdown.ts";

/*
 * The parent transcript is pi's event stream (a finished message is a
 * `message_end`, and `message_start` repeats it); a child's session.jsonl is
 * pi's session file (a finished message is a `message` entry). Both shapes are
 * built here from the fields the v5c luna runs carry.
 */
type Row = Record<string, unknown>;

const TARGET = "/grid/runs/cell-01/target";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input, output, cacheRead, cacheWrite, reasoning: 0, totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const call = (id: string, name: string, args: Row = {}) => ({ type: "toolCall", id, name, arguments: args });
const assistantMsg = (u: Row, calls: Row[], at: number, text = ""): Row => ({
	role: "assistant", usage: u, timestamp: at, stopReason: calls.length ? "toolUse" : "stop",
	content: [...(text ? [{ type: "text", text }] : []), ...calls],
});
const resultMsg = (toolCallId: string, toolName: string, text: string, at: number): Row => ({
	role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: at,
});

/**
 * Parent stream: every message appears as message_start and message_end, as pi
 * emits them. A row that already has a `type` (a compaction_end) is an event
 * and goes in as it is.
 */
const stream = (...messages: Row[]): string => [
	{ type: "session", cwd: TARGET },
	...messages.flatMap((message) => typeof message.type === "string" ? [message] : [{ type: "message_start", message }, { type: "message_end", message }]),
].map((r) => JSON.stringify(r)).join("\n");
/** A completed compaction as pi's stream reports it: usage only on result. */
const compactionEnd = (totalTokens: number): Row => ({
	type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
	result: { summary: "summary text", firstKeptEntryId: "e1", tokensBefore: 90_000, usage: { input: totalTokens - 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens } },
});
/** Child session file: a header and one `message` entry per message. */
const sessionFile = (...messages: Row[]): string => [
	{ type: "session", cwd: TARGET },
	...messages.map((message, i) => ({ type: "message", id: String(i), parentId: null, timestamp: "2026-09-25T21:38:30.273Z", message })),
].map((r) => JSON.stringify(r)).join("\n");

const SECRET = "the finding text the output must never carry";

describe("parseSession", () => {
	it("counts each parent response once although the stream logs it at start and at end", () => {
		const parsed = parseSession(stream(
			assistantMsg(usage(1000, 10, 200, 50), [call("t1", "bash", { command: "ls" })], 1),
			resultMsg("t1", "bash", "abc", 2),
			assistantMsg(usage(100, 20, 1200), [], 3, "done"),
		));
		expect(parsed.responses.map((r) => r.usage)).toEqual([
			{ input: 1000, output: 10, cacheRead: 200, cacheWrite: 50, totalTokens: 1260 },
			{ input: 100, output: 20, cacheRead: 1200, cacheWrite: 0, totalTokens: 1320 },
		]);
		expect(parsed.toolCalls).toEqual([{ id: "t1", name: "bash", response: 0, at: 1 }]);
		expect(parsed.toolResults).toEqual([{ id: "t1", name: "bash", chars: 3, afterResponses: 1, at: 2 }]);
	});

	it("reads a child session file, whose messages are `message` entries rather than events", () => {
		const parsed = parseSession(sessionFile(
			{ role: "user", content: [{ type: "text", text: "task" }] },
			assistantMsg(usage(500, 5), [call("c1", "recall")], 10),
			resultMsg("c1", "recall", "xy", 11),
		));
		expect(parsed.responses).toHaveLength(1);
		expect(parsed.toolCalls.map((c) => c.name)).toEqual(["recall"]);
		expect(parsed.toolResults.map((t) => t.chars)).toEqual([2]);
	});

	it("keeps the read tool's path, resolved against the session cwd, and drops every other argument and all result text", () => {
		const parsed = parseSession(stream(
			assistantMsg(usage(1, 1), [call("r1", "read", { path: "app/a.php", offset: 3 }), call("b1", "bash", { command: SECRET })], 1),
			resultMsg("r1", "read", SECRET, 2),
		));
		expect(parsed.toolCalls[0]).toEqual({ id: "r1", name: "read", path: `${TARGET}/app/a.php`, response: 0, at: 1 });
		expect(parsed.toolCalls[1]).not.toHaveProperty("path");
		// The parse is what the report prints from, so nothing it keeps may hold the text.
		expect(JSON.stringify(parsed)).not.toContain(SECRET);
		expect(parsed.toolResults[0]?.chars).toBe(SECRET.length);
	});

	it("skips a torn last line instead of failing the whole run", () => {
		const text = `${stream(assistantMsg(usage(7, 1), [], 1))}\n{"type":"message_end","mess`;
		expect(parseSession(text).responses).toHaveLength(1);
	});

	it("keeps a completed compaction's usage, which pi reports only on compaction_end, so parent spend matches run.json", () => {
		const parsed = parseSession(stream(
			assistantMsg(usage(10, 1), [call("t1", "bash")], 1),
			resultMsg("t1", "bash", "ok", 2),
			compactionEnd(5_000),
			assistantMsg(usage(10, 1), [], 3),
		));
		expect(parsed.compactions).toEqual([{ totalTokens: 5_000, afterResponses: 1, afterResults: 1 }]);
		// The summary text is never kept.
		expect(JSON.stringify(parsed)).not.toContain("summary text");
	});

	it("reads only message_end rows from a file that holds both shapes, so an event stream that also logged its entries is not counted twice", () => {
		const message = assistantMsg(usage(100, 1), [], 1);
		const text = [
			{ type: "message", id: "0", parentId: null, message },
			{ type: "message_end", message },
		].map((r) => JSON.stringify(r)).join("\n");
		expect(parseSession(text).responses).toHaveLength(1);
	});
});

describe("breakdownSessions", () => {
	const parent = parseSession(stream(
		assistantMsg(usage(12_000, 100), [call("s1", "subagent", { agent: "pired-investigate", task: SECRET })], 1_000),
		resultMsg("s1", "subagent", "x".repeat(400), 5_000),
		assistantMsg(usage(1_000, 50, 12_000), [call("r1", "read", { path: `${TARGET}/app/a.php` }), call("r2", "read", { path: `${TARGET}/app/b.php` })], 6_000),
		resultMsg("r1", "read", "y".repeat(80), 6_100),
		resultMsg("r2", "read", "z".repeat(30), 6_100),
		assistantMsg(usage(500, 20, 13_000), [], 7_000),
	));
	const child = parseSession(sessionFile(
		assistantMsg(usage(3_000, 30), [call("w1", "read", { path: "app/a.php" })], 2_000),
		resultMsg("w1", "read", "y".repeat(80), 2_100),
		assistantMsg(usage(200, 10, 3_000), [call("w2", "record")], 3_000),
		resultMsg("w2", "record", "ok", 3_100),
	));

	it("splits the parent's spend into requests, starting prompt, per-request context and output", () => {
		const b = breakdownSessions(parent, [child]);
		expect(b.requests).toBe(3);
		expect(b.firstRequestPromptTokens).toBe(12_000);
		expect(b.promptTokens).toBe(12_000 + 13_000 + 13_500);
		expect(b.meanContextPerRequest).toBeCloseTo(38_500 / 3);
		expect(b.outputTokens).toBe(170);
		expect(b.parentTotal).toBe(38_500 + 170);
	});

	it("counts workers' tokens and requests apart from the parent's", () => {
		const b = breakdownSessions(parent, [child]);
		expect(b.workerTotal).toBe(3_030 + 3_210);
		expect(b.workerRequests).toBe(2);
	});

	it("measures the subagent result as the handoff and prices it over every parent request that carried it", () => {
		const b = breakdownSessions(parent, [child]);
		expect(b.handoffChars).toBe(400);
		// Returned after the first response, so the two requests after it carry it.
		expect(b.handoffCarriedTokens).toBe(400 * 2 / CHARS_PER_TOKEN);
	});

	it("counts a parent read of a file a worker read earlier as a re-read, whatever relative form the worker used", () => {
		const b = breakdownSessions(parent, [child]);
		expect(b.rereads).toBe(1);
		expect(b.rereadChars).toBe(80);
	});

	it("does not count a parent read that came before the worker's read of the same file", () => {
		const early = parseSession(stream(assistantMsg(usage(1, 1), [call("r0", "read", { path: `${TARGET}/app/a.php` })], 500), resultMsg("r0", "read", "q", 501)));
		expect(breakdownSessions(early, [child]).rereads).toBe(0);
	});

	it("reports a run that never delegated with zero worker, handoff and re-read figures", () => {
		const b = breakdownSessions(parseSession(stream(assistantMsg(usage(9_000, 9), [], 1))), []);
		expect(b).toMatchObject({ requests: 1, workerTotal: 0, workerRequests: 0, handoffChars: 0, handoffCarriedTokens: 0, rereads: 0 });
	});

	it("takes the first request's prompt as input plus cache reads plus cache writes, not input alone", () => {
		// A cached provider reports most of the prompt as cacheRead; input alone would call a 1,000-token prompt 100.
		const b = breakdownSessions(parseSession(stream(assistantMsg(usage(100, 5, 700, 200), [], 1))), []);
		expect(b.firstRequestPromptTokens).toBe(1_000);
	});

	it("measures prompt growth per request so a longer run at the same growth is not read as heavier context", () => {
		// Prompts 1,000, 1,200, 1,400: F = 1,000 and g = 200 whatever the run length.
		const b = breakdownSessions(parseSession(stream(
			assistantMsg(usage(1_000, 0), [], 1), assistantMsg(usage(1_200, 0), [], 2), assistantMsg(usage(1_400, 0), [], 3),
		)), []);
		// 2 × (3,600 − 3 × 1,000) / 9: the exact per-run g, a little above the step because the sum starts at F, not F + g/2.
		expect(b.growthPerRequest).toBeCloseTo(2 * 600 / 9);
	});

	it("adds compaction spend to parentTotal and stops carrying a handoff at the compaction that summarised it", () => {
		const compacted = parseSession(stream(
			assistantMsg(usage(1_000, 10), [call("s1", "subagent")], 1),
			resultMsg("s1", "subagent", "h".repeat(800), 2),
			assistantMsg(usage(1_300, 10), [], 3),
			compactionEnd(4_000),
			assistantMsg(usage(600, 10), [], 4),
			assistantMsg(usage(700, 10), [], 5),
		));
		const b = breakdownSessions(compacted, []);
		expect(b).toMatchObject({ requests: 4, compactions: 1, compactionTokens: 4_000 });
		expect(b.parentTotal).toBe(1_010 + 1_310 + 610 + 710 + 4_000);
		// Carried by the one request between the handoff and the compaction, not by all three after it.
		expect(b.handoffCarriedTokens).toBe(800 / CHARS_PER_TOKEN);
	});

	it("counts a handoff returned after a compaction as carried to the end of the run", () => {
		const late = parseSession(stream(
			assistantMsg(usage(1, 1), [], 1), compactionEnd(10),
			assistantMsg(usage(1, 1), [call("s1", "subagent")], 2), resultMsg("s1", "subagent", "h".repeat(40), 3),
			assistantMsg(usage(1, 1), [], 4), assistantMsg(usage(1, 1), [], 5),
		));
		expect(breakdownSessions(late, []).handoffCarriedTokens).toBe(40 * 2 / CHARS_PER_TOKEN);
	});

	it("skips a parent read with no timestamp instead of guessing its order against the worker's", () => {
		const undated = parseSession(stream({ ...assistantMsg(usage(1, 1), [call("r0", "read", { path: `${TARGET}/app/a.php` })], 9_000), timestamp: null }));
		expect(breakdownSessions(undated, [child]).rereads).toBe(0);
	});

	it("reports zeros rather than NaN for an empty transcript", () => {
		const b = breakdownSessions(parseSession(""), []);
		expect(b.requests).toBe(0);
		expect(b.meanContextPerRequest).toBe(0);
		expect(b.firstRequestPromptTokens).toBe(0);
		expect(b.growthPerRequest).toBe(0);
	});
});

const zero = (): RunBreakdown => ({
	requests: 0, firstRequestPromptTokens: 0, meanContextPerRequest: 0, promptTokens: 0, growthPerRequest: 0, outputTokens: 0,
	compactions: 0, compactionTokens: 0, parentTotal: 0,
	workerTotal: 0, workerRequests: 0, handoffChars: 0, handoffCarriedTokens: 0, rereads: 0, rereadChars: 0,
});
const run = (meta: Partial<RunMeta>, b: Partial<RunBreakdown> = {}): GridRun => ({
	meta: { arm: "baseline", target: "t1", pass: 1, attempt: 1, valid: true, ...meta },
	breakdown: { ...zero(), ...b },
});

describe("selectRuns", () => {
	it("keeps only the highest attempt of a cell, so a retried cell is not weighed twice", () => {
		const { latest } = selectRuns([run({ attempt: 1 }), run({ attempt: 2 }, { requests: 5 })]);
		expect(latest.map((r) => r.breakdown.requests)).toEqual([5]);
	});

	it("drops a cell whose highest attempt is invalid rather than falling back to an older valid one", () => {
		const { latest } = selectRuns([run({ attempt: 1 }), run({ attempt: 2, valid: false })]);
		expect(latest).toEqual([]);
	});

	it("pairs arms only when both are valid at the same highest attempt", () => {
		const { pairs } = selectRuns([
			run({ target: "a" }), run({ target: "a", arm: "candidate" }),
			run({ target: "b" }), run({ target: "b", arm: "candidate", attempt: 2 }),
			run({ target: "c" }), run({ target: "c", arm: "candidate", valid: false }),
		]);
		expect(pairs.map((p) => p.candidate.meta.target)).toEqual(["a"]);
	});
});

/** A run whose prompts start at F and grow by exactly g per request: prompt sum R × F + g × R² / 2. */
const grown = (requests: number, first: number, g: number, extra: Partial<RunBreakdown> = {}): RunBreakdown => {
	const promptTokens = requests * first + g * requests ** 2 / 2;
	return { ...zero(), requests, firstRequestPromptTokens: first, promptTokens, growthPerRequest: g, parentTotal: promptTokens, ...extra };
};

describe("attribute", () => {
	it("splits the extra parent tokens exactly into turn count, starting prompt, faster growth and output", () => {
		const baseline = { ...zero(), requests: 10, promptTokens: 100_000, firstRequestPromptTokens: 5_000, outputTokens: 1_000, parentTotal: 101_000 };
		const candidate = { ...zero(), requests: 12, promptTokens: 156_000, firstRequestPromptTokens: 6_000, outputTokens: 1_500, parentTotal: 157_500, handoffCarriedTokens: 4_000 };
		const a = attribute([{ baseline, candidate }]);
		expect(a.extraParentTokens).toBe(56_500);
		// g_b = (100,000 − 50,000) / 50 = 1,000; g_c = (156,000 − 72,000) / 72.
		expect(a.growth.baseline).toBe(1_000);
		expect(a.turnCount).toBeCloseTo(2 * 5_000 + 1_000 * (72 - 50));
		expect(a.startingPrompt).toBe(12 * 1_000);
		expect(a.fasterGrowth).toBeCloseTo(12_000);
		expect(a.handoffPayloadEstimate).toBe(4_000);
		expect(a.otherGrowth).toBeCloseTo(8_000);
		expect(a.output).toBe(500);
		expect(a.residual).toBeCloseTo(0);
	});

	it("puts the extra of a longer run at the same per-turn growth into the turn-count term, not into heavier context", () => {
		// Mean context rises from 2,000 to 3,000 here only because the run is longer;
		// the old split called that 20,000 tokens of heavier context.
		const a = attribute([{ baseline: grown(10, 1_000, 200), candidate: grown(20, 1_000, 200) }]);
		expect(a.extraParentTokens).toBe(40_000);
		expect(a.turnCount).toBe(40_000);
		expect(a.startingPrompt).toBe(0);
		expect(a.fasterGrowth).toBe(0);
	});

	it("pools the pairs rather than summing per-pair splits, so a short candidate against a long baseline does not swing the turn term", () => {
		const pairs = [
			{ baseline: grown(10, 1_000, 100), candidate: grown(20, 1_000, 100) },
			{ baseline: grown(40, 2_000, 100), candidate: grown(10, 2_000, 100) },
		];
		const pooled = attribute(pairs);
		const summed = pairs.map((p) => attribute([p]).turnCount).reduce((x, y) => x + y, 0);
		expect(pooled.extraParentTokens).toBe(-110_000);
		expect(summed).toBe(-110_000);
		// Pooled, part of the difference is the candidate's lighter request mix (a lower weighted starting prompt).
		expect(pooled.turnCount).toBe(-20 * 1_800 + 100 * (250 - 850));
		expect(pooled.startingPrompt).toBeCloseTo(-14_000);
		expect(pooled.turnCount + pooled.startingPrompt).toBeCloseTo(-110_000);
	});

	it("carries compaction summaries as their own term so they do not land in the residual", () => {
		const a = attribute([{ baseline: grown(4, 100, 0), candidate: grown(4, 100, 0, { compactionTokens: 900, parentTotal: 400 + 900 }) }]);
		expect(a.compaction).toBe(900);
		expect(a.residual).toBe(0);
	});

	it("attributes nothing, and divides by nothing, over no pairs", () => {
		expect(attribute([])).toMatchObject({ extraParentTokens: 0, turnCount: 0, startingPrompt: 0, fasterGrowth: 0, residual: 0, growth: { baseline: 0, candidate: 0 } });
	});
});

describe("perPair", () => {
	const pair = (target: string, b: RunBreakdown, c: RunBreakdown) => ({ target, pass: 1, baseline: b, candidate: c });

	it("reports the median pair and the largest pair's share, since a few very long runs dominate the pooled shares", () => {
		const view = perPair([
			pair("a", grown(10, 1_000, 0), grown(11, 1_000, 0)),
			pair("b", grown(10, 1_000, 0), grown(10, 1_100, 0)),
			pair("c", grown(10, 1_000, 0), grown(100, 1_000, 0)),
		], 1_000 + 1_000 + 90_000);
		expect(view.medianExtra).toBe(1_000);
		expect(view.medianShare.turnCount).toBe(1);
		expect(view.medianShare.startingPrompt).toBe(0);
		expect(view.largest).toEqual({ target: "c", pass: 1, extra: 90_000, shareOfPooled: 90_000 / 92_000 });
	});

	it("has no median and no largest pair over no pairs", () => {
		const view = perPair([], 0);
		expect(view).toMatchObject({ medianExtra: null, largest: null });
		expect(view.medianShare.turnCount).toBeNull();
	});
});

describe("pooledContextRatio", () => {
	it("is null, not Infinity, when the baseline made no requests and the candidate did", () => {
		expect(pooledContextRatio([{ baseline: zero(), candidate: grown(5, 100, 0) }])).toBeNull();
	});

	it("is null over no pairs and weighs context by request otherwise", () => {
		expect(pooledContextRatio([])).toBeNull();
		// Per-run means 100 and 300 average to 200; weighted by 1 and 3 requests it is 250.
		const ratio = pooledContextRatio([
			{ baseline: grown(2, 100, 0), candidate: grown(1, 100, 0) },
			{ baseline: grown(2, 100, 0), candidate: grown(3, 300, 0) },
		]);
		expect(ratio).toBe(250 / 100);
	});
});

describe("reportGrid", () => {
	it("means each arm over its valid runs and takes ratios over matched pairs only", () => {
		const report = reportGrid("g", [
			run({ target: "a" }, { requests: 10, parentTotal: 100 }),
			run({ target: "a", arm: "candidate" }, { requests: 15, parentTotal: 150, handoffChars: 300 }),
			// Unpaired: in the baseline mean, out of the ratio.
			run({ target: "b" }, { requests: 30, parentTotal: 900 }),
		]);
		expect(report.runs).toEqual({ baseline: 2, candidate: 1 });
		expect(report.pairs).toBe(1);
		expect(report.means.baseline.requests).toBe(20);
		expect(report.means.candidate.requests).toBe(15);
		expect(report.ratios.requests).toBe(1.5);
		expect(report.ratios.parentTotal).toBe(1.5);
		// A baseline that never hands off has no ratio to report, not Infinity.
		expect(report.ratios.handoffChars).toBeNull();
		expect(formatReport(report)).toContain("matched pairs 1");
	});

	it("counts runs whose parentTotal disagrees with run.json's canonical parent spend, so a missed spend source shows up", () => {
		const report = reportGrid("g", [
			run({ target: "a", canonicalParentTotal: 100 }, { parentTotal: 100 }),
			run({ target: "b", canonicalParentTotal: 500 }, { parentTotal: 440 }),
			run({ target: "c" }, { parentTotal: 7 }),
		]);
		expect(report.reconciliation).toEqual({ checked: 2, mismatched: 1, gap: 60 });
		expect(formatReport(report)).toContain("checked 2, mismatched 1, gap 60");
	});

	it("labels re-reads as a read-tool lower bound and says the attribution uses the request-weighted context", () => {
		const text = formatReport(reportGrid("g", [run({}, grown(2, 10, 0)), run({ arm: "candidate" }, grown(3, 10, 0))]));
		expect(text).toContain("rereads (read tool, >=)");
		expect(text).toContain("request-weighted, used below");
		expect(text).toContain("largest pair t1 pass 1");
	});
});

describe("parseArgs", () => {
	it("takes every non-flag argument as a grid and the one after --json as the output path", () => {
		expect(parseArgs(["g1", "--json", "out.json", "g2"])).toEqual({ grids: ["g1", "g2"], jsonOut: "out.json" });
		expect(parseArgs(["g1"])).toEqual({ grids: ["g1"] });
	});

	it("refuses no grid, or --json with no path, rather than treating the flag as a grid", () => {
		expect(parseArgs([])).toBeNull();
		expect(parseArgs(["g1", "--json"])).toBeNull();
		expect(parseArgs(["--json", "--x", "g1"])).toBeNull();
	});
});

describe("runBreakdown and gridRuns", () => {
	let dir: string | undefined;
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

	const writeRun = (grid: string, cell: string, meta: Row, transcript: string, children: Record<string, string> = {}) => {
		const runDir = join(grid, "runs", cell);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "run.json"), JSON.stringify(meta));
		writeFileSync(join(runDir, "transcript.jsonl"), transcript);
		for (const [rel, text] of Object.entries(children)) {
			mkdirSync(join(runDir, "child-sessions", rel, ".."), { recursive: true });
			writeFileSync(join(runDir, "child-sessions", rel), text);
		}
		return runDir;
	};

	it("reads the parent transcript and every nested child session of a run directory", () => {
		dir = mkdtempSync(join(tmpdir(), "cost-breakdown-"));
		const runDir = writeRun(dir, "c1", { arm: "candidate", target: "t", pass: 1, attempt: 1, valid: true },
			stream(assistantMsg(usage(100, 1), [], 1)),
			{ "u1/run-0/session.jsonl": sessionFile(assistantMsg(usage(10, 1), [], 2)), "u2/run-0/session.jsonl": sessionFile(assistantMsg(usage(20, 1), [], 3)) });
		expect(runBreakdown(runDir)).toMatchObject({ requests: 1, workerRequests: 2, workerTotal: 32 });
	});

	it("lists every run with its metadata and skips a directory without a readable run.json", () => {
		dir = mkdtempSync(join(tmpdir(), "cost-breakdown-"));
		writeRun(dir, "c1", { arm: "baseline", target: "t", pass: 2, attempt: 3, valid: true }, stream(assistantMsg(usage(100, 1), [], 1)));
		writeRun(dir, "c2", { arm: "candidate", target: "t", pass: 2, attempt: 3, valid: false }, "");
		mkdirSync(join(dir, "runs", "junk"));
		const runs = gridRuns(dir).sort((a, b) => a.meta.arm.localeCompare(b.meta.arm));
		expect(runs.map((r) => r.meta)).toEqual([
			{ arm: "baseline", target: "t", pass: 2, attempt: 3, valid: true },
			{ arm: "candidate", target: "t", pass: 2, attempt: 3, valid: false },
		]);
		expect(runs[0]?.breakdown.requests).toBe(1);
	});

	it("reads run.json's canonical parent total for the reconciliation, and leaves it out when run.json has none", () => {
		dir = mkdtempSync(join(tmpdir(), "cost-breakdown-"));
		writeRun(dir, "c1", { arm: "baseline", target: "t", pass: 1, attempt: 1, valid: true, usage: { parent: { totalTokens: 101 } } }, stream(assistantMsg(usage(100, 1), [], 1)));
		writeRun(dir, "c2", { arm: "candidate", target: "t", pass: 1, attempt: 1, valid: true }, stream(assistantMsg(usage(100, 1), [], 1)));
		const runs = gridRuns(dir).sort((a, b) => a.meta.arm.localeCompare(b.meta.arm));
		expect(runs[0]?.meta.canonicalParentTotal).toBe(101);
		expect(runs[1]?.meta).not.toHaveProperty("canonicalParentTotal");
	});

	it("prints the report and writes the JSON file from the command line, returning a usage error for bad arguments", () => {
		dir = mkdtempSync(join(tmpdir(), "cost-breakdown-"));
		writeRun(dir, "b", { arm: "baseline", target: "t", pass: 1, attempt: 1, valid: true }, stream(assistantMsg(usage(100, 1), [], 1)));
		writeRun(dir, "c", { arm: "candidate", target: "t", pass: 1, attempt: 1, valid: true }, stream(assistantMsg(usage(150, 1), [], 1)));
		const out: string[] = [];
		const jsonOut = join(dir, "out.json");
		expect(main([dir, "--json", jsonOut], (t) => out.push(t))).toBe(0);
		expect(out.join("")).toContain("matched pairs 1");
		const written = JSON.parse(readFileSync(jsonOut, "utf8")) as Array<{ pairs: number; attribution: { extraParentTokens: number } }>;
		expect(written[0]).toMatchObject({ pairs: 1, attribution: { extraParentTokens: 50 } });
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		expect(main([], () => {})).toBe(2);
		stderr.mockRestore();
	});

	it("returns no runs for a grid without a runs directory", () => {
		dir = mkdtempSync(join(tmpdir(), "cost-breakdown-"));
		expect(gridRuns(dir)).toEqual([]);
	});
});

describe("a grid with a matched arm (plan 2.5)", () => {
	it("counts the matched arm's sessions apart and never pairs them against the baseline", () => {
		const report = reportGrid("g", [
			run({}, { requests: 4 }), run({ arm: "candidate" }, { requests: 6 }),
			run({ arm: "matched", session: 1 }, { requests: 3 }), run({ arm: "matched", session: 2 }, { requests: 3 }), run({ arm: "matched", session: 3 }, { requests: 3 }),
		]);
		expect(report.runs).toEqual({ baseline: 1, candidate: 1, matched: 3 });
		expect(report.pairs).toBe(1);
		expect(report.ratios.requests).toBe(1.5);
		expect(formatReport(report)).toContain("matched-arm sessions 3");
	});

	it("keeps each session's own highest attempt instead of collapsing a pair's sessions into one", () => {
		// Session 2 failed and re-ran alone inside the pair's attempt 1.
		const { latest } = selectRuns([
			run({ arm: "matched", session: 1, sessionAttempt: 1 }), run({ arm: "matched", session: 2, sessionAttempt: 1, valid: false }),
			run({ arm: "matched", session: 2, sessionAttempt: 2 }, { requests: 7 }),
		]);
		expect(latest.map((r) => [r.meta.session, r.meta.sessionAttempt, r.breakdown.requests])).toEqual([[1, 1, 0], [2, 2, 7]]);
	});

	it("reports a two-arm grid exactly as before", () => {
		const report = reportGrid("g", [run({}), run({ arm: "candidate" })]);
		expect(report.runs).toEqual({ baseline: 1, candidate: 1 });
		expect(formatReport(report)).not.toContain("matched-arm");
	});
});
