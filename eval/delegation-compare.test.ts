import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	accountCellUsage, AUTH_HORIZON_CAP_MS, AUTH_MARGIN_MS, benchmarkRuntimeOf, checkAuthHorizon, childProviderFailure, classifyInfra,
	credentialExpiry, decideInfra, fetchErrorsFromStderr, gridWorstCaseMs, isBrokerEnvVar, metricFromRecord, notLaunchedOutcome, ownerIsLive,
	parseComparePins, parseOwnerRecord, planResume, providerFailureTexts, resumeMismatches, runtimeMismatch, scopedSealCommand,
	startTimeFromStat, subagentConfigFor, toolSurfaceErrors, trackStream, type ProviderFailures,
} from "./delegation-compare.ts";
import { BENCHMARK_SETTINGS } from "./delegation-compare-entry.ts";
import { planSchedule } from "./delegation-compare-lib.ts";

// Per-file builders: a run record as the runner appends it to runs.jsonl, a
// manifest fragment as resume reads it back, pi's transcript events, and the
// provider-failure bundle the classifier reads. No shared fixtures, by house rule.
type Run = Record<string, unknown>;
const run = (key: string, arm: "baseline" | "candidate", valid: boolean, opts: { infra?: boolean; attempt?: number; reason?: string } = {}): Run => ({
	key, target: key.split("#")[0], pass: Number(key.split("#")[1]), arm, valid,
	infraFailure: opts.infra ?? false, infraReason: opts.reason ?? null, attempt: opts.attempt ?? 1,
});
const parentFails = (...parent: string[]): ProviderFailures => ({ parent, workers: [], fetchErrors: [] });
const reply = (stopReason: string, errorMessage?: string): Record<string, unknown> => ({
	type: "message_end", message: { role: "assistant", stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
});

describe("planResume", () => {
	// The GLM 1308 window that stopped the research grid must re-run only the arms
	// it actually broke, so a rerun does not re-spend the pairs that already passed.
	it("keeps a pair whose two arms are both valid rather than re-running it", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", true), run("A#1", "candidate", true),
		]);
		expect(plan.keepKeys).toContain("A#1");
		expect(plan.rerunKeys).not.toContain("A#1");
	});

	// A 1308/429 mid-grid leaves an arm invalid with infraFailure; that pair is the
	// one a resume re-runs, both arms, so the counterbalanced order is preserved.
	it("re-runs a pair with an arm invalidated for a provider-limit reason, both arms", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", true), run("A#1", "candidate", false, { infra: true }),
		]);
		expect(plan.rerunKeys).toContain("A#1");
		expect(plan.keepKeys).not.toContain("A#1");
		expect(plan.nextAttempt["A#1"]).toBe(2);
	});

	// The handoff forbids re-running a pair that failed on its own merits: a
	// candidate defect must keep the grid unapprovable, not be retried into a pass.
	it("blocks a pair with an arm invalid for a non-infrastructure reason and never re-runs it", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", false, { infra: false }), run("A#1", "candidate", true),
		]);
		expect(plan.blockedKeys).toEqual(["A#1"]);
		expect(plan.rerunKeys).not.toContain("A#1");
	});

	// A pair with no run yet (the grid stopped before reaching it) is missing, not
	// blocked: it must be launched on resume.
	it("re-runs a pair that has no run recorded for one of its arms", () => {
		const plan = planResume(planSchedule(["A"], 3), [run("A#2", "candidate", true)]);
		expect(plan.rerunKeys).toContain("A#2");
		expect(plan.nextAttempt["A#2"]).toBe(2);
		expect(plan.nextAttempt["A#3"]).toBe(1);
	});

	// Round-two review: a newest-per-arm rule kept this pair and compared the
	// attempt-2 baseline with the attempt-1 candidate, measured hours apart in a
	// different provider window. The pair's own highest attempt decides, and an
	// arm missing there sends both arms back, never a mix of attempts.
	it("re-runs both arms when the pair's highest attempt has only one arm, never pairing it with an older partner", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", false, { infra: true, attempt: 1 }),
			run("A#1", "candidate", true, { attempt: 1 }),
			run("A#1", "baseline", true, { attempt: 2 }),
		]);
		expect(plan.keepKeys).not.toContain("A#1");
		expect(plan.rerunKeys).toContain("A#1");
		expect(plan.nextAttempt["A#1"]).toBe(3);
		expect(plan.latest["A#1\u0000candidate"]).toBeUndefined();
	});

	it("keeps a re-run pair once both arms are valid at its highest attempt, carrying those attempt-2 records", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", false, { infra: true, attempt: 1 }),
			run("A#1", "candidate", true, { attempt: 1 }),
			run("A#1", "baseline", true, { attempt: 2 }),
			run("A#1", "candidate", true, { attempt: 2 }),
		]);
		expect(plan.keepKeys).toContain("A#1");
		expect((plan.latest["A#1\u0000baseline"] as Run).attempt).toBe(2);
		expect((plan.latest["A#1\u0000candidate"] as Run).attempt).toBe(2);
	});

	// An older non-infra failure is superseded only by a complete newer attempt;
	// a newer attempt whose one present arm failed on its own merits blocks.
	it("blocks a pair whose only arm at the highest attempt is invalid for a non-infrastructure reason", () => {
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "baseline", true, { attempt: 1 }), run("A#1", "candidate", false, { infra: true, attempt: 1 }),
			run("A#1", "candidate", false, { infra: false, attempt: 2 }),
		]);
		expect(plan.blockedKeys).toContain("A#1");
		expect(plan.reasons["A#1"]).toMatch(/attempt 2/);
	});

	// Round-two review: SIGHUP/Ctrl-C with five pairs in flight recorded every
	// in-flight arm non-infra, so the resume blocked all five and the grid could
	// never approve. An arm the runner stopped is a runner interruption.
	it("re-runs a pair whose arm the runner's own signal stopped", () => {
		const verdict = decideInfra({ valid: false, timedOut: false, stoppedByRunner: true, notLaunchedInterrupted: false, failures: parentFails() });
		expect(verdict).toEqual({ infra: true, reason: "runner interruption" });
		const plan = planResume(planSchedule(["A"], 3), [
			run("A#1", "candidate", false, { infra: verdict.infra, reason: verdict.reason }),
		]);
		expect(plan.rerunKeys).toContain("A#1");
		expect(plan.blockedKeys).not.toContain("A#1");
	});
});

describe("classifyInfra", () => {
	// The exact strings pi reported in ~/.pi/agent/sessions (zai: 191 "Connection
	// error.", 65 "terminated", 19 "Request timed out."). The old number-and-word
	// patterns classed each as non-infra, so one routine stream drop blocked a
	// GLM pair for good; pi's own retry rule classes each as transient.
	it.each([
		"terminated",
		"Connection error.",
		"Request timed out.",
		"Stream ended without finish_reason",
		"Provider finish_reason: network_error",
		"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 5a1f in your message.",
		"Codex error: Our servers are currently overloaded. Please try again later.",
		"fetch failed",
		"WebSocket error",
	])("classes the provider message %j as transient infrastructure", (text) => {
		expect(classifyInfra(parentFails(text), false)).toMatchObject({ infra: true, reason: "transient provider failure" });
	});

	it("classes zai's 1302 request-rate 429 by its code", () => {
		const verdict = classifyInfra(parentFails('429: {"code":"1302","message":"Rate limit reached for requests"}'), false);
		expect(verdict).toMatchObject({ infra: true, reason: "zai 1302 request rate limit" });
		expect(verdict.exhausted).toBeUndefined();
	});

	// A spent quota is infrastructure, but a resume before the reset can only fail
	// again, so it is flagged for the runner to stop and say so.
	it.each([
		['429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-21 15:08:42"}', "provider quota exhausted"],
		['429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-09-15 21:21:07"}', "zai 1308 five-hour usage window"],
		["429: insufficient_quota", "provider quota exhausted"],
		["Codex error: The usage limit has been reached", "provider quota exhausted"],
	])("classes %j as an exhausted quota the runner must wait out", (text, reason) => {
		expect(classifyInfra(parentFails(text), false)).toMatchObject({ infra: true, reason, exhausted: true });
	});

	// Round-two review: a zai 429 inside a candidate worker never reached the
	// classifier, so the candidate's pair was blocked while the same 429 on a
	// baseline parent was re-run.
	it("reads a worker's provider failure the same way as the parent's", () => {
		const verdict = classifyInfra({ parent: [], workers: ['429: {"code":"1302","message":"Rate limit reached for requests"}'], fetchErrors: [] }, false);
		expect(verdict).toMatchObject({ infra: true, reason: "zai 1302 request rate limit" });
	});

	it("classes an undici or socket code from a benchmark_fetch_error line as transient", () => {
		expect(classifyInfra({ parent: [], workers: [], fetchErrors: [{ code: "UND_ERR_HEADERS_TIMEOUT", codes: [] }] }, false))
			.toMatchObject({ infra: true, reason: "transient network failure (UND_ERR_HEADERS_TIMEOUT)" });
		expect(classifyInfra({ parent: [], workers: [], fetchErrors: [{ codes: ["ECONNREFUSED"] }] }, false).infra).toBe(true);
	});

	// A truncated run is invalid but is the run's own outcome, not a transient the
	// resume may retry; the research notes an early stop is not a cheap success.
	it("never classes a timeout as infrastructure, even with a provider 429 on record", () => {
		expect(classifyInfra(parentFails('429: {"code":"1302"}'), true).infra).toBe(false);
		expect(decideInfra({ valid: false, timedOut: true, stoppedByRunner: true, notLaunchedInterrupted: false, failures: parentFails("terminated") }).infra).toBe(false);
	});

	// A deterministic request error is the run's own: a candidate that builds a bad
	// request must not be re-run into a pass.
	it("does not class a non-transient provider error such as a 400 as infrastructure", () => {
		expect(classifyInfra(parentFails('400: {"message":"invalid tool schema"}'), false).infra).toBe(false);
	});
});

describe("provider-originated text only", () => {
	// Round-two review: the old classifier scanned harness messages and free
	// stderr, so "reports 1308 output tokens" read as a zai window and a Node stack
	// frame ending ":503:9" read as a provider 5xx; a candidate crash was re-run.
	it("ignores a stderr stack frame with :503 or :1308 and reads only benchmark_fetch_error lines", () => {
		const stderr = [
			"TypeError: cannot read properties of undefined",
			"    at runWorker (/cell/pired/extensions/lib/delegation.ts:503:9)",
			"    at file:///cell/pired/core/tools.ts:1308:4",
			'{"type":"benchmark_fetch_error","code":"ECONNRESET","syscall":"read"}',
			'{"type":"something_else","code":"ETIMEDOUT"}',
		].join("\n");
		expect(fetchErrorsFromStderr(stderr)).toEqual([{ code: "ECONNRESET", codes: [] }]);
		expect(classifyInfra({ parent: [], workers: [], fetchErrors: fetchErrorsFromStderr(stderr.split("\n").slice(0, 3).join("\n")) }, false).infra).toBe(false);
	});

	it("counts only fetch errors to the provider's own hosts, so a side-channel refresh cannot make a run re-runnable", () => {
		// The v3 smoke cell: a pi-subagents child's model-catalog refresh hit the
		// proxy blackhole three times (ECONNREFUSED) while its model calls worked.
		const stderr = [
			'{"type":"benchmark_fetch_error","host":"models.example.test","code":"ECONNREFUSED","syscall":"connect"}',
			'{"type":"benchmark_fetch_error","code":"ECONNREFUSED","syscall":"connect"}',
			'{"type":"benchmark_fetch_error","host":"api.z.ai","code":"ECONNRESET","syscall":"read"}',
		].join("\n");
		expect(fetchErrorsFromStderr(stderr, ["api.z.ai"])).toEqual([{ code: "ECONNRESET", codes: [], host: "api.z.ai" }]);
		const sideChannelOnly = fetchErrorsFromStderr(stderr.split("\n").slice(0, 2).join("\n"), ["api.z.ai"]);
		expect(sideChannelOnly).toEqual([]);
		expect(classifyInfra({ parent: [], workers: [], fetchErrors: sideChannelOnly }, false).infra).toBe(false);
	});

	it("takes only failing assistant replies and failed compactions from the transcript, never harness text", () => {
		const events = [
			reply("toolUse"),
			reply("error", "Connection error."),
			{ type: "compaction_end", reason: "threshold", errorMessage: "Request timed out." },
		];
		expect(new Set(providerFailureTexts(events))).toEqual(new Set(["Connection error.", "Request timed out."]));
		// A run invalid only for harness reasons (a usage defect naming 1308 tokens,
		// "500 malformed JSON event lines") has no provider text to classify.
		const harnessOnly = [reply("toolUse"), reply("stop")];
		expect(providerFailureTexts(harnessOnly)).toEqual([]);
		expect(decideInfra({ valid: false, timedOut: false, stoppedByRunner: false, notLaunchedInterrupted: false, failures: { parent: providerFailureTexts(harnessOnly), workers: [], fetchErrors: [] } }).infra).toBe(false);
	});

	// Model bash output reaches the transcript as tool results; a grep that prints
	// "rate limit exceeded" from a target's source must not make a run infra.
	it("never reads a tool result, so model-authored 'rate limit' text is not a provider failure", () => {
		const events = [
			{ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "429 rate limit exceeded; quota" }] } },
			{ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "rate limit" }] } },
			reply("toolUse"),
		];
		expect(providerFailureTexts(events)).toEqual([]);
	});

	// pi's overflow recovery retries the turn after compacting; that reply's error
	// is not the run's failure, exactly as observationsFromPiEvents accepts it.
	it("drops a context-overflow reply pi recovered by compaction", () => {
		const events = [
			reply("error", "Request timed out."),
			{ type: "compaction_end", reason: "overflow", willRetry: true, result: {} },
			reply("stop"),
		];
		expect(providerFailureTexts(events)).toEqual([]);
	});
});

describe("childProviderFailure", () => {
	const zai429 = '429: {"code":"1302","message":"Rate limit reached for requests"}';
	const failedChild = { childKey: "run-a/run-0", status: "failed" as const, error: zai429 };

	it("reads a failed child's provider error when the parent's subagent row carries the same text", () => {
		expect(childProviderFailure(failedChild, [`child run-a/run-0: assistant reply r2 failed: ${zai429}`], "")).toEqual({ text: zai429 });
	});

	// The child-session directory is writable from inside the seal; a failure the
	// parent's transcript never carried is not evidence of what the provider said.
	it("ignores a session's failure text that the parent's transcript does not carry", () => {
		const verdict = childProviderFailure({ ...failedChild, error: "exit 1" }, [`child run-a/run-0: assistant reply r2 failed: ${zai429}`], "Subagent pired-scout failed: exit 1");
		expect(verdict.text).toBeUndefined();
		expect(verdict.note).toMatch(/not in the parent's subagent result/);
	});

	// A child that failed on its own terms (an empty final answer) has no errored
	// reply; its message is pi-subagents' own and must not be classified at all.
	it("reads nothing from a child that failed without a failed provider reply", () => {
		expect(childProviderFailure({ ...failedChild, error: "Subagent returned an empty final answer" }, [], "")).toEqual({});
	});

	it("reads nothing from a completed child", () => {
		expect(childProviderFailure({ ...failedChild, status: "completed" }, [`child run-a/run-0: assistant reply r2 failed: ${zai429}`], zai429)).toEqual({});
	});
});

describe("toolSurfaceErrors", () => {
	const base = ["read", "bash", "edit", "write", "record", "recall"];

	it("accepts the baseline's six tools and the candidate's six plus the lazy loader", () => {
		expect(toolSurfaceErrors("baseline", base)).toEqual([]);
		expect(toolSurfaceErrors("candidate", [...base, "subagents_enable"])).toEqual([]);
	});

	// The first SDK entry passed a tools allowlist that dropped record/recall from
	// BOTH arms; a check on the delegation difference alone passed it.
	it("rejects either arm without pired's record and recall", () => {
		expect(toolSurfaceErrors("baseline", ["read", "bash", "edit", "write"])).toEqual(["baseline arm does not expose record", "baseline arm does not expose recall"]);
		expect(toolSurfaceErrors("candidate", ["read", "bash", "edit", "write", "subagents_enable"])).toHaveLength(2);
	});

	// pi-subagents 0.71 adds bg_wait and subagent_supervisor to every parent;
	// pired is foreground-only and hides them. pired_delegate is the deleted
	// native worker, so a candidate still showing it is the ADR-025 snapshot.
	it("rejects a candidate that shows a tool pired hides", () => {
		const errors = toolSurfaceErrors("candidate", [...base, "subagents_enable", "bg_wait", "subagent_supervisor", "pired_delegate"]);
		expect(errors).toEqual([
			"candidate arm exposes bg_wait, which pired hides",
			"candidate arm exposes subagent_supervisor, which pired hides",
			"candidate arm exposes pired_delegate, which pired hides",
		]);
	});

	// Without PI_PACKAGE_DIR the loader cannot verify the host and pi-subagents
	// registers the full subagent schema (~18k characters) on every request.
	it("rejects a candidate that registered subagent eagerly instead of through the loader", () => {
		expect(toolSurfaceErrors("candidate", [...base, "subagent"])).toEqual([
			"candidate arm does not expose subagents_enable",
			"candidate arm exposes subagent eagerly instead of through subagents_enable",
		]);
	});

	it("rejects a baseline that loaded pi-subagents or anything else", () => {
		expect(toolSurfaceErrors("baseline", [...base, "subagents_enable"])).toEqual(["baseline arm exposes unexpected tool(s) subagents_enable"]);
	});
});

describe("comparison pins", () => {
	const valid = { baselineCommit: "496b1900c2fae2d63ba8378b3c3f56a4b49f317c", candidateDigest: null, candidateFrozenAt: null, piSubagents: { dir: "eval/artifacts/pi-subagents-0.71.0", version: "0.71.0", digest: "a".repeat(64) } };

	it("parses the pins file the runner ships", async () => {
		const pins = parseComparePins(await readFile(new URL("./delegation-compare.pins.json", import.meta.url), "utf8"));
		expect(pins.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(pins.piSubagents.version).toBe("0.71.0");
		expect(pins.candidateDigest === null || /^[0-9a-f]{64}$/.test(pins.candidateDigest)).toBe(true);
	});

	// A candidate that is not frozen yet is null, and reads as exploratory; it
	// must never be mistaken for a digest that some snapshot could match.
	it("keeps an unfrozen candidate as null rather than a matchable value", () => {
		expect(parseComparePins(JSON.stringify(valid)).candidateDigest).toBeNull();
		expect(() => parseComparePins(JSON.stringify({ ...valid, candidateDigest: "" }))).toThrow(/candidateDigest/);
	});

	it("refuses a pins file without a pi-subagents tree digest", () => {
		expect(() => parseComparePins(JSON.stringify({ ...valid, piSubagents: { dir: "x", version: "0.71.0" } }))).toThrow(/piSubagents/);
	});
});

describe("cell configuration", () => {
	// pi's default "streaming" warming sends its own requests; a warm that fails
	// leaves no entry at all, so the count is complete only with warming off.
	it("runs both arms without retries or cache warming and with compaction on", () => {
		expect(BENCHMARK_SETTINGS).toEqual({ packages: [], compaction: { enabled: true }, retry: { enabled: false }, cacheWarming: "off" });
	});

	// pi-subagents 0.71's resolveAsyncByDefault is `config.asyncByDefault !== false`:
	// left out, a launch without `async` would run in the background, outside the
	// parent's transcript.
	it("pins worker sessions to the cell and keeps launches in the foreground", () => {
		expect(subagentConfigFor("/cell/child-sessions")).toEqual({ defaultSessionDir: "/cell/child-sessions", asyncByDefault: false, artifactDir: "temp" });
	});
});

describe("trackStream", () => {
	const line = (event: Record<string, unknown>): string => JSON.stringify(event);
	const start = (id: string, toolName: string) => line({ type: "tool_execution_start", toolCallId: id, toolName, args: {} });
	const end = (id: string, toolName: string, isError = false) => line({ type: "tool_execution_end", toolCallId: id, toolName, isError, result: {} });

	// The audit's "records before delegating" reads these counts; a stream that
	// still watched pired_delegate would report every candidate as never delegating.
	it("counts subagent launches, the loader, and the records written before the first launch", () => {
		const { stream, onLine } = trackStream();
		const lines = [
			start("r1", "record"), end("r1", "record"),
			start("e1", "subagents_enable"), end("e1", "subagents_enable"),
			start("r2", "record"), end("r2", "record", true),
			start("s1", "subagent"), line({ type: "tool_execution_update", toolCallId: "s1", toolName: "subagent" }), end("s1", "subagent"),
			start("r3", "record"), end("r3", "record"), "not json",
		];
		lines.forEach((l, i) => onLine(l, 1000 + i));
		expect(stream).toMatchObject({
			subagentCalls: 1, enableCalls: 1, subagentUpdates: 1, recordCalls: 3, recordWrites: 2,
			recordWritesBeforeFirstSubagent: 1, firstSubagentAt: 1006, firstRecordAt: 1001, malformedJsonLines: 1,
		});
	});
});

describe("accountCellUsage", () => {
	const usage = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	const parentReply = (id: string, stopReason: string, u = usage(100, 10)): Record<string, unknown> => ({
		type: "message_end", message: { role: "assistant", content: [], provider: "zai", model: "glm-5.3-flash", responseId: id, usage: u, stopReason, timestamp: 1 },
	});
	const childRow = (runId: string, sessionDir: string, extra: Record<string, unknown> = {}) => ({
		agent: "pired-scout", index: 0, exitCode: 0, model: "zai/glm-5.3-flash", thinking: "medium",
		usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, turns: 2 }, sessionFile: `${sessionDir}/${runId}/run-0/session.jsonl`, ...extra,
	});
	const subagentCall = (id: string, details: Record<string, unknown>): Record<string, unknown>[] => [
		{ type: "tool_execution_start", toolCallId: id, toolName: "subagent", args: { agent: "pired-scout", task: "map routes" } },
		{ type: "tool_execution_end", toolCallId: id, toolName: "subagent", isError: false, result: { content: [{ type: "text", text: "handoff" }], details } },
	];
	const sessionText = (model = { provider: "zai", model: "glm-5.3-flash" }): string => [
		{ type: "session", version: 3, id: "child-1", timestamp: "t", cwd: "/target" },
		{ type: "thinking_level_change", id: "e1", parentId: null, timestamp: "t", thinkingLevel: "medium" },
		{ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", ...model, responseId: "c1", stopReason: "toolUse", usage: usage(25, 3), content: [{ type: "toolCall", id: "t1", name: "record", arguments: { kind: "endpoint" } }] } },
		{ type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "toolResult", toolCallId: "t1", toolName: "record", isError: false, content: [{ type: "text", text: "Recorded endpoint E-1" }] } },
		{ type: "message", id: "e4", parentId: "e3", timestamp: "t", message: { role: "assistant", ...model, responseId: "c2", stopReason: "stop", usage: usage(25, 2), content: [{ type: "text", text: "E-1 recorded" }] } },
	].map((row) => JSON.stringify(row)).join("\n");
	const expectRun = { provider: "zai", model: "glm-5.3-flash", thinking: "medium" };
	const cellWithSession = async (text?: string): Promise<string> => {
		const dir = await mkdtemp(join(tmpdir(), "pired-cell-"));
		if (text !== undefined) {
			await mkdir(join(dir, "run-a", "run-0"), { recursive: true });
			await writeFile(join(dir, "run-a", "run-0", "session.jsonl"), text);
		}
		return dir;
	};

	it("counts each worker reply once, from the worker's own session, beside the parent's", async () => {
		const dir = await cellWithSession(sessionText());
		const events = [parentReply("p1", "toolUse"), ...subagentCall("call-1", { mode: "single", runId: "run-a", results: [childRow("run-a", dir)] }), parentReply("p2", "stop")];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect(account.errors).toEqual([]);
		expect(account.usage.parentRequests).toBe(2);
		expect(account.usage.workerRequests).toBe(2);
		expect(account.usage.total.totalTokens).toBe(220 + 55);
		expect(account.childSessionFiles).toEqual(["run-a/run-0/session.jsonl"]);
	});

	// The child-session directory is writable from inside the seal; a session no
	// call in the parent's transcript launched is not the candidate's spend.
	it("refuses a session file no subagent call claims", async () => {
		const dir = await cellWithSession(sessionText());
		const account = await accountCellUsage([parentReply("p1", "stop")], { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 0 });
		expect(account.errors.join("\n")).toMatch(/claimed by no subagent call/);
	});

	// A worker on another model is a different experiment; its tokens do not compare.
	it("refuses a worker whose replies came from another model", async () => {
		const dir = await cellWithSession(sessionText({ provider: "openai-codex", model: "gpt-6-luna" }));
		const events = [parentReply("p1", "toolUse"), ...subagentCall("call-1", { mode: "single", runId: "run-a", results: [childRow("run-a", dir)] }), parentReply("p2", "stop")];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect(account.errors.join("\n")).toMatch(/replies came from openai-codex\/gpt-6-luna, not zai\/glm-5.3-flash/);
	});

	// The baseline does not load pi-subagents: a child session or a subagent call
	// there means the wrong snapshot ran, and its tokens would land in the wrong arm.
	it("refuses a baseline run that left a child session or called subagent", async () => {
		const dir = await cellWithSession(sessionText());
		const account = await accountCellUsage([parentReply("p1", "stop")], { arm: "baseline", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect(account.errors).toContain("baseline arm produced 1 child session file(s)");
		expect(account.errors).toContain("baseline arm made 1 subagent call(s)");
	});

	it("accepts a baseline run with no child sessions directory at all", async () => {
		const account = await accountCellUsage([parentReply("p1", "stop")], { arm: "baseline", childSessionDir: join(tmpdir(), `absent-${Date.now()}`) }, expectRun, { subagentCalls: 0 });
		expect(account.errors).toEqual([]);
		expect(account.usage.valid).toBe(true);
	});

	// Round-three review: a worker stopped by pired's own turn budget ended on
	// toolUse, the run was invalid as non-infrastructure, the runner stopped
	// launching pairs, and a resume of the official grid refused. Shape of the
	// scratch replay: the call ends in error with empty details, the child's row
	// only on the last progress update, the stop text in both places.
	it("counts a worker pired's turn budget stopped, so one looping worker does not end the grid", async () => {
		const stop = "pired: pired-scout is 3 turns past its 20-turn budget and still calling tools, so this run is being stopped. Your final message is the handoff.";
		const rows = [
			{ type: "session", version: 3, id: "child-1", timestamp: "t", cwd: "/target" },
			{ type: "thinking_level_change", id: "e1", parentId: null, timestamp: "t", thinkingLevel: "medium" },
			{ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", responseId: "c1", stopReason: "toolUse", usage: usage(25, 3), content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "true" } }] } },
			{ type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: stop }] } },
		];
		const dir = await cellWithSession(rows.map((row) => JSON.stringify(row)).join("\n"));
		const row = childRow("run-a", dir, { exitCode: 1, error: `bash failed (exit 1): ${stop}`, sessionFile: undefined, usage: { input: 25, output: 3, cacheRead: 0, cacheWrite: 0, turns: 1 } });
		const events = [
			parentReply("p1", "toolUse"),
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "subagent", args: { agent: "pired-scout", task: "map routes" } },
			{ type: "tool_execution_update", toolCallId: "call-1", toolName: "subagent", partialResult: { content: [], details: { mode: "single", runId: "run-a", results: [row] } } },
			{ type: "tool_execution_end", toolCallId: "call-1", toolName: "subagent", isError: true, result: { content: [{ type: "text", text: `bash failed (exit 1): ${stop}` }], details: {} } },
			parentReply("p2", "stop"),
		];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect(account.errors).toEqual([]);
		expect(account.children[0]!.verdict).toMatchObject({ accepted: true, outcome: "incomplete" });
		expect(account.usage.workerRequests).toBe(1);
		// And without the parent finishing normally it is still no valid run.
		const unfinished = await accountCellUsage(events.slice(0, 4), { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect(unfinished.errors).toContain("parent did not finish with an assistant stopReason=stop");
	});
});

describe("OAuth horizon", () => {
	const HOUR = 3_600_000;
	const now = Date.parse("2026-09-23T20:00:00Z");
	const codex = (expiresInHours: number): string => JSON.stringify({
		"openai-codex": { type: "oauth", access: "eyJ.secret-access.sig", refresh: "rt_secret-refresh", expires: now + expiresInHours * HOUR, accountId: "acct" },
	});
	const officialWorstCase = gridWorstCaseMs({ passes: 3, targets: 5, concurrency: 2, timeoutMs: 2 * HOUR });
	const check = (text: string | undefined, extra: { provider?: string; requestedHours?: number; worstCaseMs?: number } = {}) => checkAuthHorizon({
		provider: extra.provider ?? "openai-codex", credential: credentialExpiry(text, extra.provider ?? "openai-codex"),
		worstCaseMs: extra.worstCaseMs ?? officialWorstCase, nowMs: now, piCli: "/repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		...(extra.requestedHours === undefined ? {} : { requestedHours: extra.requestedHours }),
	});

	it("sizes the official grid's worst case as three passes of three waves of two two-hour arms", () => {
		expect(officialWorstCase).toBe(36 * HOUR);
	});

	it("reads only the expiry out of the shared auth store, never a token", () => {
		expect(credentialExpiry(codex(29), "openai-codex")).toEqual({ kind: "oauth", expiresAt: now + 29 * HOUR });
		expect(credentialExpiry(JSON.stringify({ zai: { type: "api_key", key: "k" } }), "zai")).toEqual({ kind: "static" });
		expect(credentialExpiry("{}", "openai-codex")).toEqual({ kind: "missing" });
		expect(credentialExpiry(undefined, "openai-codex")).toEqual({ kind: "missing" });
		expect(credentialExpiry("not json", "openai-codex").kind).toBe("unreadable");
		expect(credentialExpiry(JSON.stringify({ "openai-codex": { type: "oauth" } }), "openai-codex").kind).toBe("unreadable");
	});

	// Round-three review: every cell shares one codex access token, so they all
	// reach its expiry together, and a worker refreshes under its cell's own lock.
	// The operator's token had 29 h left against a 36 h official grid.
	it("refuses a grid whose codex token expires inside its worst case, naming the refresh command and no secret", () => {
		const verdict = check(codex(29));
		expect(verdict.ok).toBe(false);
		expect(verdict.record).toMatchObject({ checked: true, remainingHours: 29, worstCaseHours: 36, source: "worst case", ok: false });
		expect(verdict.error).toContain("auth print-bearer-token --provider openai-codex --min-expiry 37h > /dev/null");
		expect(verdict.error).toContain("Running pi once is not enough");
		expect(`${verdict.error} ${JSON.stringify(verdict.record)}`).not.toMatch(/secret|eyJ|rt_/);
	});

	it("accepts a token that outlives the worst case plus pi's refresh window and the preflight", () => {
		expect(check(codex(36 + AUTH_MARGIN_MS / HOUR)).ok).toBe(true);
		expect(check(codex(36.5)).ok).toBe(false);
		expect(check(codex(240)).record).toMatchObject({ ok: true, requiredHours: 36.58 });
	});

	it("lets the operator state a shorter horizon, and records that it did", () => {
		const verdict = check(codex(29), { requestedHours: 12 });
		expect(verdict.ok).toBe(true);
		expect(verdict.record.source).toBe("--auth-horizon-hours");
	});

	it("caps the computed horizon at what a refreshed token can meet, and says so", () => {
		const verdict = check(codex(200), { worstCaseMs: 400 * HOUR });
		expect(verdict.ok).toBe(true);
		expect(verdict.record).toMatchObject({ source: "worst case, capped", worstCaseHours: 400 });
		expect(verdict.record.requiredHours).toBeCloseTo((AUTH_HORIZON_CAP_MS + AUTH_MARGIN_MS) / HOUR, 2);
	});

	it("skips a provider without an OAuth credential, but refuses codex without one", () => {
		expect(check("{}", { provider: "zai" })).toMatchObject({ ok: true, record: { checked: false, credential: "missing" } });
		expect(check("{}").ok).toBe(false);
		expect(check("{}").error).toContain("no openai-codex OAuth credential");
		expect(check("not json").ok).toBe(false);
	});
});

describe("runtimeMismatch", () => {
	const line = { type: "benchmark_runtime", provider: "zai", model: "glm-5.3-flash", thinking: "medium", requestedThinking: "medium", supportedThinking: ["off", "low", "medium", "high"] };

	it("accepts the run the grid asked for", () => {
		expect(runtimeMismatch(line, { provider: "zai", model: "glm-5.3-flash", thinking: "medium" })).toBeUndefined();
	});

	// Round-three review: under pi's built-in catalog glm-5.3-flash has no medium,
	// so the session ran high while the line repeated the request, and every
	// worker registered at high then failed its thinking check.
	it("refuses a session whose effective thinking level is not the requested one, naming what the model supports", () => {
		expect(runtimeMismatch({ ...line, thinking: "high", supportedThinking: ["low", "high", "max"] }, { provider: "zai", model: "glm-5.3-flash", thinking: "medium" }))
			.toBe("the session's effective thinking level is high, not the requested medium (the model supports low, high, max)");
		expect(runtimeMismatch({ ...line, model: "glm-5.3" }, { provider: "zai", model: "glm-5.3-flash", thinking: "medium" })).toBe("ran zai/glm-5.3, not zai/glm-5.3-flash");
		expect(runtimeMismatch(undefined, { provider: "zai", model: "glm-5.3-flash", thinking: "medium" })).toBe("no runtime line");
	});
});

describe("notLaunchedOutcome", () => {
	const pair = planSchedule(["A"], 1)[0]!;
	const outcome = (valid: boolean, infra: boolean) => ({
		metric: { key: "A#1", target: "A", pass: 1, valid, truePositives: 0, precision: 0, totalClaims: 0, totalTokens: Number.NaN },
		arm: "candidate" as const, cellId: "c", seconds: 30, record: run("A#1", "candidate", valid, { infra, reason: infra ? "transient provider failure" : undefined }), infraFailure: infra,
	});

	// Round-two review: after a first arm failed in minute one, the partner still
	// ran for up to two hours though no policy could use it.
	it("records the partner of an infra-failed first arm as infra, so a resume re-runs both", () => {
		const partner = notLaunchedOutcome(pair, "baseline", 1, outcome(false, true), false);
		expect(partner.record).toMatchObject({ arm: "baseline", valid: false, notLaunched: true, infraFailure: true });
		const plan = planResume(planSchedule(["A"], 1), [run("A#1", "candidate", false, { infra: true }), partner.record]);
		expect(plan.rerunKeys).toEqual(["A#1"]);
	});

	it("records the partner of a non-infra first arm as non-infra, so the pair stays blocked", () => {
		const partner = notLaunchedOutcome(pair, "baseline", 1, outcome(false, false), false);
		expect(partner.infraFailure).toBe(false);
		expect(planResume(planSchedule(["A"], 1), [run("A#1", "candidate", false), partner.record]).blockedKeys).toEqual(["A#1"]);
	});

	it("records a partner skipped by the runner's stop signal as a runner interruption", () => {
		expect(notLaunchedOutcome(pair, "baseline", 1, outcome(true, false), true).record).toMatchObject({ infraFailure: true, infraReason: "runner interruption" });
	});
});

describe("metricFromRecord", () => {
	// A resumed pair's kept record must reconstruct the same RunMetric the live run
	// produced, so the comparison treats a carried pair exactly like a fresh one.
	it("reads truePositives, precision, claims and tokens back out of a valid record", () => {
		const metric = metricFromRecord({ key: "A#1", target: "A", pass: 1, valid: true, truePositives: 2, precisionLowerBound: 0.5, findings: 4, totalTokens: 1000 });
		expect(metric).toEqual({ key: "A#1", target: "A", pass: 1, valid: true, truePositives: 2, precision: 0.5, totalClaims: 4, totalTokens: 1000 });
	});

	// An invalid run serializes totalTokens as null; it must read back as NaN, never
	// as a zero that the comparison would treat as a free run.
	it("reads a null token count as NaN, not as a zero-cost run", () => {
		expect(metricFromRecord({ key: "A#1", target: "A", pass: 1, valid: false, totalTokens: null }).totalTokens).toBeNaN();
	});
});

describe("resumeMismatches", () => {
	const runtime = { provider: "zai", model: "glm-5.3-flash", api: "openai-completions", endpoint: "https://api.z.ai", contextWindow: 200000, maxTokens: 16000, thinking: "medium" };
	const manifest = (): Record<string, unknown> => ({
		pins: { runtime: "r", benchmarkRuntime: { ...runtime } }, prompt: "p", promptSha256ByTarget: { A: "x" }, schedule: [{ key: "A#1" }], passes: 3,
		provider: { provider: "zai", model: "glm-5.3-flash", baseHost: "api.z.ai", allowedHosts: ["localhost", "127.0.0.1", "api.z.ai"] },
		requested: { provider: "zai", model: "glm-5.3-flash", thinking: "medium", passes: 3, only: [] },
		inputs: {
			sourceSha256: { A: "h" }, truthSha256: { A: "t" }, corpusManifest: { sha256: "cm" },
			baseline: { sha256: "b", stagedDigest: "bs" }, candidate: { sha256: "c", stagedDigest: "cs" },
		},
	});

	// A resume that measured the same rules against the same inputs must proceed.
	it("finds no mismatch between a manifest and an identical recomputation", () => {
		expect(resumeMismatches(manifest(), manifest())).toEqual([]);
	});

	// A snapshot, key, harness or grader that moved since the stopped grid must
	// refuse the resume; a changed pin and a changed staged digest are both caught.
	it("names each identity field that changed since the stopped grid", () => {
		const fresh = manifest();
		(fresh.pins as Record<string, unknown>).runtime = "different";
		((fresh.inputs as Record<string, unknown>).candidate as Record<string, unknown>).stagedDigest = "other";
		expect(resumeMismatches(manifest(), fresh)).toEqual(["pins", "inputs.candidate.stagedDigest"]);
	});

	// Round-two review: models.json was read live and never pinned, so a resume
	// after a contextWindow edit ran re-run pairs under a different compaction
	// trigger. The probe-resolved runtime is compared under its own name.
	it("refuses a resume whose probe-resolved model runtime differs, naming it apart from the harness pins", () => {
		const fresh = manifest();
		((fresh.pins as Record<string, unknown>).benchmarkRuntime as Record<string, unknown>).contextWindow = 128000;
		(fresh.provider as Record<string, unknown>).baseHost = "open.bigmodel.cn";
		expect(resumeMismatches(manifest(), fresh)).toEqual(["pins.benchmarkRuntime", "provider"]);
	});

	// The candidate arm loads the pinned pi-subagents tree; a re-install between
	// two halves of a grid is a different candidate, and the refusal names it.
	// Round-three review: the audit writes summary.json's delegation section and
	// was not pinned; the limits it reads from core/ are pinned by value.
	it("refuses a resume whose delegation-audit limits changed", () => {
		const prior = manifest();
		(prior.pins as Record<string, unknown>).delegationAuditLimits = { maxTurns: { "pired-scout": 20 }, handoffGraceTurns: 2, maxAgents: 8 };
		const fresh = manifest();
		(fresh.pins as Record<string, unknown>).delegationAuditLimits = { maxTurns: { "pired-scout": 24 }, handoffGraceTurns: 2, maxAgents: 8 };
		expect(resumeMismatches(prior, fresh)).toEqual(["pins"]);
	});

	it("names a changed pi-subagents tree apart from the harness pins", () => {
		const prior = manifest();
		(prior.pins as Record<string, unknown>).piSubagentsSha256 = "a";
		const fresh = manifest();
		(fresh.pins as Record<string, unknown>).piSubagentsSha256 = "b";
		expect(resumeMismatches(prior, fresh)).toEqual(["pins.piSubagents"]);
	});

	// Round-two review: a refused resume wrote its fresh pins over manifest.json,
	// so the second resume compared new with new and passed. The original is now
	// never rewritten, so the same comparison refuses every time.
	it("keeps refusing a changed pin on a second resume, because the original manifest is the reference both times", () => {
		const original = manifest();
		const fresh = manifest();
		(fresh.pins as Record<string, unknown>).runtime = "edited";
		expect(resumeMismatches(original, fresh)).toEqual(["pins"]);
		expect(resumeMismatches(original, manifest())).toEqual([]);
		expect(resumeMismatches(original, fresh)).toEqual(["pins"]);
	});
});

describe("benchmarkRuntimeOf", () => {
	it("keeps the model-definition fields in one fixed order so two runs compare byte for byte", () => {
		const a = benchmarkRuntimeOf({ type: "benchmark_runtime", maxTokens: 16000, provider: "zai", model: "m", api: "x", endpoint: "e", thinking: "medium", contextWindow: 200000 });
		const b = benchmarkRuntimeOf({ contextWindow: 200000, thinking: "medium", endpoint: "e", api: "x", model: "m", provider: "zai", maxTokens: 16000 });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("owner record", () => {
	// comm (field 2) may hold spaces and ")"; counting from the first ")" would
	// read the wrong field and treat a live runner as stale.
	it("reads the start time from /proc/<pid>/stat field 22 even when comm holds spaces and parentheses", () => {
		const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
		fields[22 - 3] = "987654";
		expect(startTimeFromStat(`1234 (node (x) y) ${fields.join(" ")}`)).toBe("987654");
		expect(startTimeFromStat("garbage")).toBeUndefined();
	});

	// A pid alone is not an identity: a reused pid, or a live process that is not
	// this runner, must not keep a grid claimed forever.
	it("treats the owner as live only when pid start time and title both match", () => {
		const recorded = parseOwnerRecord('{"pid":42,"startTime":"100","title":"pired-compare","mode":"live","claimedAt":"t"}')!;
		expect(ownerIsLive(recorded, { startTime: "100", title: "pired-compare" })).toBe(true);
		expect(ownerIsLive(recorded, { startTime: "101", title: "pired-compare" })).toBe(false);
		expect(ownerIsLive(recorded, { startTime: "100", title: "bash" })).toBe(false);
		expect(ownerIsLive(recorded, {})).toBe(false);
		expect(parseOwnerRecord("")).toBeUndefined();
	});
});

describe("sealed environment", () => {
	// Round-two review: the live pilot cell's environ held
	// DBUS_STARTER_ADDRESS=unix:path=/run/user/1000/bus after the session address
	// had been dropped.
	it("drops every DBUS_* variable, not only the session bus address", () => {
		for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK"]) expect(isBrokerEnvVar(key)).toBe(true);
		expect(isBrokerEnvVar("HOME")).toBe(false);
	});

	// systemd-run needs the user bus to create the scope, but the command it execs
	// inherits systemd-run's environment (measured, plus INVOCATION_ID); the env -u
	// wrapper keeps the bus address out of the sealed process.
	it("hands systemd-run the bus variables and strips them before fs-seal runs", () => {
		const scoped = scopedSealCommand("/tmp/seal", ["--read", "/usr", "--", "node", "entry.ts"], { PATH: "/usr/bin", HOME: "/h" },
			{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", XDG_RUNTIME_DIR: "/run/user/1", DBUS_STARTER_ADDRESS: "unix:path=/x" }, "pired-cell-abc");
		expect(scoped.command).toBe("systemd-run");
		expect(scoped.args.slice(0, 6)).toEqual(["--user", "--scope", "--quiet", "--collect", "--unit=pired-cell-abc", "--"]);
		expect(scoped.args.slice(6)).toEqual(["/usr/bin/env", "-u", "DBUS_SESSION_BUS_ADDRESS", "-u", "XDG_RUNTIME_DIR", "-u", "INVOCATION_ID", "/tmp/seal", "--read", "/usr", "--", "node", "entry.ts"]);
		expect(scoped.env).toEqual({ PATH: "/usr/bin", HOME: "/h", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus", XDG_RUNTIME_DIR: "/run/user/1" });
		expect(scoped.unit).toBe("pired-cell-abc");
	});
});
