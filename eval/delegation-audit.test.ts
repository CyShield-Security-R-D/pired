import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditCell, auditDelegation, formatAudit, summarizeAudits, type AuditInput } from "./delegation-audit.ts";

/*
 * Parent events and child sessions are excerpts of faux runs of pi 0.87.1 with
 * pi-subagents 0.71.0: a parent that records, delegates to a pired-shaped
 * runtime agent and recalls the child's finding; the child's session pinned
 * under the cell's child-sessions directory.
 */
type Row = Record<string, unknown>;

const RUN_ID = "c9cbc1e8-d449-4e0e-a74b-5ba5e3563c7a";
const CHILD_KEY = `${RUN_ID}/run-0`;
const SESSION = `${CHILD_KEY}/session.jsonl`;
const TASK = "Investigate the upload handler in src/upload.go:42 for hypothesis b50898; record what you find.";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (prompt: number, calls: Array<{ id: string; name: string; args?: Row }> = [], text = ""): Row => ({
	type: "message_end",
	message: {
		role: "assistant", usage: usage(prompt, 50), stopReason: calls.length ? "toolUse" : "stop", provider: "openai-codex", model: "gpt-6-luna",
		content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.args ?? {} }))],
	},
});
const start = (id: string, name: string, args: Row = {}): Row => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const end = (id: string, name: string, result: Row = { content: [], details: {} }, isError = false): Row => ({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
const childRow = (extra: Row = {}): Row => ({
	index: 0, agent: "pired-investigate", task: "[prompt redacted]", context: "fresh", exitCode: 0, outputState: "present", model: "openai-codex/gpt-6-luna",
	usage: { input: 1515, output: 43, cacheRead: 2966, cacheWrite: 1515, cost: 0, turns: 3 },
	sessionFile: `/cells/cell-03/child-sessions/${SESSION}`, ...extra,
});
const HANDOFF = "Recorded finding c0ffee (suspected) at src/upload.go:42. Unresolved: auth check.";
const subagentEnd = (id: string, row: Row = childRow(), runId = RUN_ID): Row => end(id, "subagent", {
	content: [{ type: "text", text: `Run fan-out: 1/64 used, 63 remaining\n${HANDOFF}\nMission: 1ab828d1 (completed)` }],
	details: { mode: "single", runId, timeoutMs: 1_800_000, results: [row] },
	usage: usage(1515, 43, 2966, 1515),
});
const subagentUpdate = (id: string, row: Row): Row => ({
	type: "tool_execution_update", toolCallId: id, toolName: "subagent",
	partialResult: { content: [{ type: "text", text: "(running...)" }], details: { mode: "single", runId: RUN_ID, results: [row] } },
});

let entrySeq = 0;
const entry = (type: string, fields: Row = {}): Row => ({ type, id: (++entrySeq).toString(16).padStart(8, "0"), parentId: null, timestamp: "2026-09-23T19:02:10.004Z", ...fields });
const reply = (u: Row, content: unknown[], stop = "stop", extra: Row = {}): Row => entry("message", {
	message: { role: "assistant", content, provider: "openai-codex", model: "gpt-6-luna", usage: u, stopReason: stop, timestamp: 1_790_190_130_069, ...extra },
});
const call = (id: string, name: string, args: Row = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolCallId: string, toolName: string, text: string, details?: Row, isError = false): Row => entry("message", {
	message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...(details ? { details } : {}), isError },
});
const recordResult = (toolCallId: string, id: string, kind = "finding") => result(toolCallId, "record", `Recorded ${kind} ${id}`, { id, kind, ids: [id], created: [id] });

/**
 * A child session. `records` are the turns (1-based) that call `record`; every
 * other turn before the last calls bash. The default is the faux child: a
 * record, a bash call and a handoff, 6,039 tokens over three replies.
 */
const childSession = (opts: { turns?: number; records?: number[]; handoff?: string; finalError?: string } = {}): string => {
	const turns = opts.turns ?? 3;
	const records = opts.records ?? [1];
	const rows: Row[] = [
		{ type: "session", version: 3, id: "01a0cfa5-9385-76cc-8e20-d7ece690978f", timestamp: "2026-09-23T19:02:10.001Z", cwd: "/work" },
		entry("model_change", { provider: "openai-codex", modelId: "gpt-6-luna" }),
		entry("thinking_level_change", { thinkingLevel: "medium" }),
		entry("message", { message: { role: "user", content: [{ type: "text", text: `Task: ${TASK}` }] } }),
	];
	const ids = ["c0ffee", "5eed01", "a1b2c3", "d4e5f6"];
	for (let t = 1; t <= turns; t++) {
		const u = t === 1 ? usage(1469, 15, 0, 1469) : t === turns ? usage(18, 20, 1497, 18) : usage(28, 8, 1469, 28);
		if (t === turns) {
			rows.push(opts.finalError
				? reply(u, [], "error", { errorMessage: opts.finalError })
				: reply(u, [{ type: "text", text: opts.handoff ?? HANDOFF }], "stop", { responseId: `resp_c_${t}` }));
		} else if (records.includes(t)) {
			rows.push(reply(u, [call(`tool:${t}`, "record", { kind: "finding" })], "toolUse", { responseId: `resp_c_${t}` }), recordResult(`tool:${t}`, ids[records.indexOf(t) % ids.length]!));
		} else {
			rows.push(reply(u, [call(`tool:${t}`, "bash", { command: "rg upload" })], "toolUse", { responseId: `resp_c_${t}` }), result(`tool:${t}`, "bash", "src/upload.go:42"));
		}
	}
	return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
};

/** pired's refusals past a worker's budget, as core/child.ts wrote them on the faux pired-scout run. */
const PAST_BUDGET = (agent: string, max: number) => `pired: ${agent} has used its ${max}-turn budget. Stop calling tools and hand back now. Your final message is the handoff.`;
const BUDGET_STOP = (agent: string, max: number) => `pired: ${agent} is 3 turns past its ${max}-turn budget and still calling tools, so this run is being stopped. Your final message is the handoff.`;

/**
 * A worker that kept calling bash past its budget until pired's gate stopped it,
 * the shape of the scratch replay (r3-harness-1/int/terminate): a record on turn
 * 1, bash until the budget, two refused turns, then the stop and no reply after
 * it. `ranPast` lets that many calls past the budget run, as a gate that did not
 * arm would.
 */
const budgetStoppedSession = (opts: { agent?: string; max?: number; ranPast?: number } = {}): string => {
	const agent = opts.agent ?? "pired-investigate";
	const max = opts.max ?? 24;
	const rows: Row[] = [
		{ type: "session", version: 3, id: "01a0cfd9-334b-74be-80ea-a5224c6fc236", timestamp: "2026-09-23T19:58:33.291Z", cwd: "/work" },
		entry("model_change", { provider: "openai-codex", modelId: "gpt-6-luna" }),
		entry("thinking_level_change", { thinkingLevel: "medium" }),
		entry("message", { message: { role: "user", content: [{ type: "text", text: `Task: ${TASK}` }] } }),
	];
	const last = max + 3 + (opts.ranPast ?? 0);
	for (let t = 1; t <= last; t++) {
		const u = t === 1 ? usage(1469, 15, 0, 1469) : usage(28, 8, 1469, 28);
		const name = t === 1 ? "record" : "bash";
		rows.push(reply(u, [call(`tool:${t}`, name, { command: "true" })], "toolUse", { responseId: `resp_b_${t}` }));
		if (t === 1) rows.push(recordResult(`tool:${t}`, "c0ffee"));
		else if (t <= max + (opts.ranPast ?? 0)) rows.push(result(`tool:${t}`, "bash", "(no output)"));
		else rows.push(result(`tool:${t}`, "bash", t < last ? PAST_BUDGET(agent, max) : BUDGET_STOP(agent, max), {}, true));
	}
	return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
};

/** Parent that records, delegates one pired worker with exact refs, then recalls the worker's finding. */
const delegatingRun = (overrides: Partial<AuditInput> = {}, args: Row = { agent: "pired-investigate", task: TASK }, row: Row = childRow()): AuditInput => ({
	parentEvents: [
		assistant(1000, [{ id: "r1", name: "record" }]),
		start("r1", "record", { kind: "hypothesis" }), end("r1", "record", { content: [{ type: "text", text: "Recorded hypothesis b50898" }], details: { id: "b50898" } }),
		assistant(1500, [{ id: "d1", name: "subagent", args }]),
		start("d1", "subagent", args), subagentUpdate("d1", { ...row, sessionFile: undefined }), subagentEnd("d1", row),
		assistant(2300, [{ id: "c1", name: "recall", args: { id: "c0ffee" } }]),
		start("c1", "recall", { id: "c0ffee" }), end("c1", "recall"),
		assistant(2600, [], "Done."),
	],
	childSessions: { [SESSION]: childSession() },
	ledgerIds: new Set(["b50898", "c0ffee"]),
	pathExists: (path) => path === "src/upload.go",
	...overrides,
});

describe("auditDelegation", () => {
	it("passes a run that records first, delegates one pired worker that records, and recalls what it recorded", () => {
		const audit = auditDelegation(delegatingRun());
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toEqual([]);
		expect(audit.reconciliationErrors).toEqual([]);
		expect(audit).toMatchObject({ delegated: true, calls: 1, parentTurns: 4, parentTurnsBeforeFirstDelegate: 1, parentRecordsBeforeFirstDelegate: 1, workerTokens: 6039 });
		const [c] = audit.subagentCalls;
		expect(c).toMatchObject({
			requestedAgent: "pired-investigate", agents: ["pired-investigate"], async: false, rejected: false, taskChars: TASK.length,
			ledgerRefs: ["b50898"], paths: ["src/upload.go:42"], unresolvedPaths: [], parentUsedRecords: true, parentPromptAtCall: 1500, parentPromptAfterCall: 2300,
		});
		expect(c!.handoffChars).toBe(`Run fan-out: 1/64 used, 63 remaining\n${HANDOFF}\nMission: 1ab828d1 (completed)`.length);
		expect(c!.children).toEqual([{
			childKey: CHILD_KEY, toolCallId: "d1", agent: "pired-investigate", status: "completed", ending: "handoff", outcome: "completed", sessionFound: true,
			turns: 3, maxTurns: 24, callsRefusedPastBudget: 0, callsRunPastBudget: 0, toolCalls: 2, toolErrors: 0, recordCalls: 1, recordIds: ["c0ffee"], recordKinds: { finding: 1 }, findingIds: ["c0ffee"],
			firstRecordTurn: 1, tokens: 6039, handoffWords: 9,
		}]);
		expect(audit.parentTokens).toBe(1000 + 1500 + 2300 + 2600 + 4 * 50);
	});

	it("notes a run that never delegated, since it measures the candidate's prompt rather than its workers", () => {
		const audit = auditDelegation({ ...delegatingRun(), parentEvents: [assistant(1000, [], "done")], childSessions: {} });
		expect(audit).toMatchObject({ delegated: false, calls: 0, parentTurnsBeforeFirstDelegate: null, parentRecordsBeforeFirstDelegate: null });
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toEqual(["the parent never delegated"]);
	});

	it("notes a parent that delegated before recording anything it knew, which the prompt advises and does not require", () => {
		const run = delegatingRun();
		const audit = auditDelegation({ ...run, parentEvents: run.parentEvents.slice(3) });
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toEqual(["the parent delegated before recording anything it knew"]);
	});

	it("flags a child on an agent other than pired's, such as pi-subagents' built-in worker", () => {
		const audit = auditDelegation(delegatingRun({}, { agent: "worker", task: TASK }, childRow({ agent: "worker" })));
		expect(audit.violations).toEqual([`child ${CHILD_KEY} (worker): not one of pired's agents`]);
		expect(auditDelegation({ ...delegatingRun({}, { agent: "worker", task: TASK }, childRow({ agent: "worker" })), agents: ["worker"] }).violations).toEqual([]);
	});

	it("notes a rejected launch without flagging it, because the gate refusing it is the contract working", () => {
		const run = delegatingRun();
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }]),
			start("d1", "subagent", { agent: "claude-code", task: TASK }),
			end("d1", "subagent", { content: [{ type: "text", text: "Delegation is limited to pired's agents" }], details: {} }, true),
			start("d2", "subagent", { agent: "pired-verify", task: TASK }),
			end("d2", "subagent", { content: [{ type: "text", text: "Subagent budget spent" }], details: {} }, true),
			assistant(1600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: {} });
		expect(audit.violations).toEqual([]);
		expect(audit.subagentCalls.map((c) => c.rejected)).toEqual([true, true]);
		expect(audit.notes).toEqual([
			"the parent never delegated",
			"subagent call d1 asked for claude-code, not a pired agent, and was rejected",
			"subagent call d2 (pired-verify) was rejected before a child started",
		]);
	});

	it("flags an async launch, whose child runs outside the parent's accounting", () => {
		// The shape pi-subagents returned for its built-in claude-code agent on a faux run.
		const asyncId = "d4f15283-03e8-49f8-a1b1-13292cce2d76";
		const run = delegatingRun();
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }]),
			start("d1", "subagent", { agent: "pired-verify", task: TASK, async: true }),
			end("d1", "subagent", { content: [{ type: "text", text: `Async: pired-verify [${asyncId}]` }], details: { mode: "single", runId: asyncId, results: [], asyncId } }),
			assistant(1600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: {} });
		expect(audit.violations).toEqual(["subagent call d1 launched an async run of pired-verify; pired's workers run in the foreground"]);
		expect(audit.reconciliationErrors.join(" ")).toContain("launched async run");
	});

	it("flags a child that made no durable record, and counts a note as one", () => {
		const bare = auditDelegation(delegatingRun({ childSessions: { [SESSION]: childSession({ records: [] }) } }));
		expect(bare.violations).toEqual([`child ${CHILD_KEY} (pired-investigate): made no durable record`]);
		expect(bare.workers[0]).toMatchObject({ recordCalls: 0, recordIds: [], firstRecordTurn: null });
		const noted = childSession({ records: [] }).replace('"name":"bash","arguments":{"command":"rg upload"}', '"name":"record","arguments":{"kind":"note"}')
			.replace('"toolName":"bash","content":[{"type":"text","text":"src/upload.go:42"}]', '"toolName":"record","content":[{"type":"text","text":"Noted."}],"details":{"kind":"note","created":["note"]}');
		const audit = auditDelegation(delegatingRun({ childSessions: { [SESSION]: noted } }));
		expect(audit.violations).toEqual([]);
		expect(audit.workers[0]).toMatchObject({ recordIds: [], recordKinds: { note: 1 }, firstRecordTurn: 1 });
	});

	it("flags a child that failed, reading it from the progress update because a failed call keeps no details", () => {
		const run = delegatingRun();
		const failed = childRow({ exitCode: 1, error: "529 overloaded", sessionFile: undefined });
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }]),
			start("d1", "subagent", { agent: "pired-investigate", task: TASK }), subagentUpdate("d1", failed),
			end("d1", "subagent", { content: [{ type: "text", text: "Run fan-out: 1/64 used, 63 remaining\n529 overloaded" }], details: {} }, true),
			assistant(1600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: { [SESSION]: childSession({ finalError: "529 overloaded" }) } });
		expect(audit.violations).toEqual([`child ${CHILD_KEY} (pired-investigate): ended failed: 529 overloaded`]);
		expect(audit.workers[0]).toMatchObject({ status: "failed", recordIds: ["c0ffee"], turns: 3 });
	});

	// Round-three review: the audit flagged every child that did not complete, so
	// a worker the design's own bounds stopped read as a broken contract.
	it("notes a worker pired's turn budget stopped as incomplete, not a violation", () => {
		const stopped = childRow({ exitCode: 1, error: `bash failed (exit 1): ${BUDGET_STOP("pired-investigate", 24)}`, sessionFile: undefined });
		const run = delegatingRun();
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }]),
			start("d1", "subagent", { agent: "pired-investigate", task: TASK }), subagentUpdate("d1", stopped),
			end("d1", "subagent", { content: [{ type: "text", text: `bash failed (exit 1): ${BUDGET_STOP("pired-investigate", 24)}` }], details: {} }, true),
			assistant(2300, [{ id: "c1", name: "recall", args: { id: "c0ffee" } }]), start("c1", "recall", { id: "c0ffee" }), end("c1", "recall"),
			assistant(2600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: { [SESSION]: budgetStoppedSession() } });
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toEqual([`child ${CHILD_KEY} (pired-investigate): stopped by pired's turn budget after 27 turns; its records stand and its spend is counted`]);
		expect(audit.workers[0]).toMatchObject({ status: "failed", ending: "budget-stop", outcome: "incomplete", maxTurns: 24, callsRefusedPastBudget: 3, callsRunPastBudget: 0 });
		expect(summarizeAudits([{ label: "a", audit }]).workersByOutcome).toEqual({ incomplete: 1 });
	});

	it("flags tool calls that ran after a worker's per-role budget, and a worker that went past the point pired stops it", () => {
		const stopped = childRow({ exitCode: 1, error: `bash failed (exit 1): ${BUDGET_STOP("pired-investigate", 24)}`, sessionFile: undefined });
		const run = delegatingRun();
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }]),
			start("d1", "subagent", { agent: "pired-investigate", task: TASK }), subagentUpdate("d1", stopped),
			end("d1", "subagent", { content: [{ type: "text", text: "failed" }], details: {} }, true),
			assistant(2600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: { [SESSION]: budgetStoppedSession({ ranPast: 2 }) } });
		expect(audit.violations).toEqual([
			`child ${CHILD_KEY} (pired-investigate): 2 tool call(s) ran after its 24-turn budget; pired's child gate refuses every call past it`,
			`child ${CHILD_KEY} (pired-investigate): 29 turns, past the 27 at which pired stops a 24-turn worker`,
		]);
	});

	it("notes calls refused past the budget when the worker then handed back on its own", () => {
		const rows = budgetStoppedSession().trimEnd().split("\n").slice(0, -2).map((line) => JSON.parse(line) as Row);
		rows.push(reply(usage(18, 20, 1497, 18), [{ type: "text", text: HANDOFF }], "stop", { responseId: "resp_b_hand" }));
		const audit = auditDelegation(delegatingRun({ childSessions: { [SESSION]: rows.map((row) => JSON.stringify(row)).join("\n") } }));
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toContain(`child ${CHILD_KEY} (pired-investigate): 2 call(s) refused past its 24-turn budget before it handed back`);
	});

	it("flags more workers than the session budget, from the scope when it sets one", () => {
		const run = delegatingRun();
		expect(auditDelegation({ ...run, maxAgents: 0 }).violations).toEqual(["the parent launched 1 workers, over the session budget of 0"]);
		expect(auditDelegation(run).violations).toEqual([]);
	});

	it("flags two workers that ran at the same time, since pi runs one reply's tool calls in parallel", () => {
		const second = `0d97e505-eafd-486e-b4a6-100d223d4953`;
		const run = delegatingRun();
		const other = childRow({ sessionFile: `/cells/cell-03/child-sessions/${second}/run-0/session.jsonl` });
		const parentEvents = [
			...run.parentEvents.slice(0, 3),
			assistant(1500, [{ id: "d1", name: "subagent" }, { id: "d2", name: "subagent" }]),
			start("d1", "subagent", { agent: "pired-investigate", task: TASK }), start("d2", "subagent", { agent: "pired-investigate", task: TASK }),
			subagentEnd("d1"), subagentEnd("d2", other, second),
			assistant(2300, [{ id: "c1", name: "recall", args: { id: "c0ffee" } }]), start("c1", "recall", { id: "c0ffee" }), end("c1", "recall"),
			assistant(2600, [], "Done."),
		];
		const audit = auditDelegation({ ...run, parentEvents, childSessions: { [SESSION]: childSession(), [`${second}/run-0/session.jsonl`]: childSession() } });
		expect(audit.violations).toEqual(["subagent calls d1 and d2 ran at the same time; pired's workers run one at a time"]);
		const serial = auditDelegation({ ...run, parentEvents: [...parentEvents.slice(0, 4), parentEvents[4]!, parentEvents[6]!, parentEvents[5]!, parentEvents[7]!, ...parentEvents.slice(8)], childSessions: { [SESSION]: childSession(), [`${second}/run-0/session.jsonl`]: childSession() } });
		expect(serial.violations).toEqual([]);
	});

	it("notes a late first record and a handoff past 200 words", () => {
		const long = Array.from({ length: 230 }, (_, i) => `w${i}`).join(" ");
		const audit = auditDelegation(delegatingRun({ childSessions: { [SESSION]: childSession({ turns: 12, records: [10], handoff: long }) } }));
		expect(audit.violations).toEqual([]);
		expect(audit.notes).toEqual([
			`child ${CHILD_KEY} (pired-investigate): first record at turn 10`,
			`child ${CHILD_KEY} (pired-investigate): handoff of 230 words`,
		]);
	});

	it("notes records the parent never names, and parent prompt growth far beyond a handoff", () => {
		const run = delegatingRun();
		const audit = auditDelegation({ ...run, parentEvents: [...run.parentEvents.slice(0, 7), assistant(12000, [], "Moving on to auth.")] });
		expect(audit.notes).toEqual([
			"subagent call d1: no later parent call or reply names its children's records (heuristic)",
			"subagent call d1: parent prompt grew 10500 tokens across the call",
		]);
		// A record ID inside a longer token is not a reference to it.
		const near = auditDelegation({ ...run, parentEvents: [...run.parentEvents.slice(0, 7), assistant(2300, [], "See c0ffeebabe.")] });
		expect(near.subagentCalls[0]!.parentUsedRecords).toBe(false);
	});

	it("reads ledger IDs and source paths from the task, and notes paths the target does not have (heuristic)", () => {
		const task = "Check src/missing.go, POST /api/upload and/or src/upload.go:42 (see upload.go) for b50898 and deadbe; docs at https://example.com/a.html.";
		const audit = auditDelegation(delegatingRun({ pathExists: (path) => path === "src/upload.go" || path === "upload.go" }, { agent: "pired-investigate", task }));
		expect(audit.subagentCalls[0]).toMatchObject({ ledgerRefs: ["b50898"], paths: ["src/upload.go:42", "upload.go"], unresolvedPaths: ["src/missing.go"] });
		expect(audit.notes).toContain("subagent call d1: task names paths not in the target (heuristic): src/missing.go");
	});

	it("reports reconciliation errors without turning them into violations", () => {
		const audit = auditDelegation(delegatingRun({ childSessions: { [SESSION]: childSession(), "0d97e505/run-0/session.jsonl": childSession() } }));
		expect(audit.reconciliationErrors).toEqual(["session file 0d97e505/run-0/session.jsonl is claimed by no subagent call"]);
		expect(audit.violations).toEqual([]);
		const missing = auditDelegation(delegatingRun({ childSessions: {} }));
		expect(missing.workers[0]).toMatchObject({ sessionFound: false, turns: 0, tokens: 0 });
		expect(missing.violations).toEqual([`child ${CHILD_KEY} (pired-investigate): made no durable record`]);
	});

	it("does not count management actions or subagents_enable as launches", () => {
		const run = delegatingRun();
		const parentEvents = [
			assistant(900, [{ id: "e1", name: "subagents_enable" }, { id: "l1", name: "subagent" }]),
			start("e1", "subagents_enable"), end("e1", "subagents_enable", { content: [{ type: "text", text: "Enabled: subagent." }], details: { enabled: true } }),
			start("l1", "subagent", { action: "list" }), end("l1", "subagent", { content: [{ type: "text", text: "pired-investigate" }], details: { mode: "management" } }),
			...run.parentEvents,
		];
		const audit = auditDelegation({ ...run, parentEvents });
		expect(audit.calls).toBe(1);
		expect(audit.subagentCalls.map((c) => c.toolCallId)).toEqual(["d1"]);
		expect(audit.violations).toEqual([]);
	});
});

describe("summarizeAudits", () => {
	it("reports how many runs delegated, workers by agent and status, and the workers' share of tokens", () => {
		const one = auditDelegation(delegatingRun());
		const none = auditDelegation({ ...delegatingRun(), parentEvents: [assistant(1000, [], "done")], childSessions: {} });
		const bare = auditDelegation(delegatingRun({ childSessions: { [SESSION]: childSession({ records: [] }) } }));
		const summary = summarizeAudits([{ label: "a", audit: one }, { label: "b", audit: none }, { label: "c", audit: bare }]);
		expect(summary).toMatchObject({
			runs: 3, runsThatDelegated: 2, calls: 2, workers: 2, workersByAgent: { "pired-investigate": 2 }, workersByStatus: { completed: 2 },
			workersWithoutRecords: 1, runsWithViolations: 1, violations: [`c: child ${CHILD_KEY} (pired-investigate): made no durable record`],
		});
		const parent = one.parentTokens + none.parentTokens + bare.parentTokens;
		expect(summary.workerTokenShare).toBeCloseTo((one.workerTokens + bare.workerTokens) / (parent + one.workerTokens + bare.workerTokens));
		expect(summarizeAudits([]).workerTokenShare).toBeNull();
	});
});

describe("formatAudit", () => {
	it("prints each call and child on one line, then reconciliation findings, violations and notes", () => {
		const text = formatAudit("cell-03", auditDelegation(delegatingRun({ childSessions: { [SESSION]: childSession({ records: [] }), "0d97e505/run-0/session.jsonl": childSession() } })));
		expect(text.split("\n")).toEqual([
			"cell-03: 1 subagent call(s), 1 child(ren) · parent 4 turns, 7600 tokens · children 6039 tokens",
			"  first child at parent turn 1 after 1 record(s)",
			"  call d1 pired-investigate · task 95 chars, 1 ledger ref(s), 1 path(s) · handoff 147 chars · parent prompt 1500 → 2300 · records used no",
			`    ${CHILD_KEY} pired-investigate completed · 3 turns · 0 record ID(s) {} · first record turn - · 6039 tokens · handoff 9 words`,
			"  reconciliation session file 0d97e505/run-0/session.jsonl is claimed by no subagent call",
			`  VIOLATION child ${CHILD_KEY} (pired-investigate): made no durable record`,
		]);
		const rejected = formatAudit("cell-04", auditDelegation({ ...delegatingRun(), parentEvents: [start("d1", "subagent", { agent: "claude-code", task: "src/x.go" }), end("d1", "subagent", { content: [], details: {} }, true)], childSessions: {} }));
		expect(rejected).toContain("cell-04: no delegation");
		expect(rejected).toContain("call d1 claude-code REJECTED");
		expect(rejected).toContain("note subagent call d1 asked for claude-code, not a pired agent, and was rejected");
	});
});

describe("auditCell", () => {
	let dir: string | undefined;
	afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

	it("reads a cell's transcript, ledger, target and pinned child sessions from disk", () => {
		dir = mkdtempSync(join(tmpdir(), "pired-audit-"));
		const run = delegatingRun();
		writeFileSync(join(dir, "transcript.jsonl"), [...run.parentEvents.map((e) => JSON.stringify(e)), "not json", ""].join("\n"));
		mkdirSync(join(dir, "workspace"));
		writeFileSync(join(dir, "workspace", "hypotheses.jsonl"), `${JSON.stringify({ id: "b50898", kind: "hypothesis" })}\n`);
		mkdirSync(join(dir, "target", "src"), { recursive: true });
		writeFileSync(join(dir, "target", "src", "upload.go"), "package main\n");
		mkdirSync(join(dir, "child-sessions", CHILD_KEY), { recursive: true });
		writeFileSync(join(dir, "child-sessions", SESSION), childSession());
		const audit = auditCell(dir);
		expect(audit.violations).toEqual([]);
		expect(audit.reconciliationErrors).toEqual([]);
		expect(audit.subagentCalls[0]).toMatchObject({ ledgerRefs: ["b50898"], paths: ["src/upload.go:42"] });
		expect(audit.workers[0]).toMatchObject({ recordIds: ["c0ffee"], tokens: 6039 });
		// Pointed at a directory that does not exist, the launched child has no session.
		const elsewhere = auditCell(dir, { childSessions: join(dir, "absent") });
		expect(elsewhere.reconciliationErrors.join(" ")).toContain("has no session");
	});
});
