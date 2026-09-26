import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	accountCellUsage, atHighestAttempt, attemptReport, AUTH_HORIZON_CAP_MS, AUTH_MARGIN_MS, benchmarkRuntimeOf, checkAuthHorizon, childProviderFailure, classifyInfra,
	credentialExpiry, decideInfra, DEFAULT_CANDIDATE_MAX_AGENTS, fetchErrorsFromStderr, gridWorstCaseMs, isBrokerEnvVar, metricFromRecord, notLaunchedOutcome, ownerIsLive,
	newManifest, optionsFromManifest, parseBreakerSpec, parseComparePins, parseOptions, parseOwnerRecord, planResume, providerFailureTexts, requestLogFromStderr,
	resumeMismatches, retryPolicyFromManifest, reviewScope, runPairs, runStop, runtimeMismatch, scopedSealCommand, startTimeFromStat, subagentConfigFor,
	toolSurfaceErrors, trackStream, workerCapReason,
	ceilingOf, ceilingProbeErrors, latestMatchedSessions, planMatchedResume, sessionRunOf, verifyCeiling,
	type GridStopState, type MatchedSessionSpec, type ProviderFailures, type RunOutcome,
} from "./delegation-compare.ts";
import { sessionBudget, type MatchedPolicy, type SessionState } from "./delegation-compare-matched.ts";
import { BENCHMARK_SETTINGS, DEFAULT_RETRY_POLICY } from "./delegation-compare-entry.ts";
import { DEFAULT_BREAKER, observationsFromChildSession, planSchedule, type Arm, type BreakerPolicy, type ScheduledPair } from "./delegation-compare-lib.ts";

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

	// v5b's luna filebrowser pass 3 baseline failed on this entitlement check, which
	// pi's list does not match; the pair was blocked and the gating grid with it.
	it("classes a provider message that asks the client to try again as infrastructure", () => {
		const verdict = classifyInfra(parentFails("Codex error: Unable to verify Daybreak Blue access. Please try again."), false);
		expect(verdict).toMatchObject({ infra: true, reason: "provider asked for a retry" });
		expect(verdict.exhausted).toBeUndefined();
	});

	it("still stops the grid on a spent plan whose message also says to try again", () => {
		expect(classifyInfra(parentFails("Codex error: The usage limit has been reached. Please try again later."), false))
			.toMatchObject({ infra: true, reason: "provider quota exhausted", exhausted: true });
	});

	it("never reads try-again text from a timed-out run as infrastructure", () => {
		expect(classifyInfra(parentFails("Please try again."), true).infra).toBe(false);
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

	// Design 2.1: with retries on, a run invalid for its own reason (here a fast
	// empty run) that had one drop pi recovered from would otherwise be re-run as
	// infrastructure, and a resume would spend a pair on a run that failed itself.
	it("does not class a run as infrastructure from a drop pi recovered", () => {
		const events = [
			reply("toolUse"), reply("error", "terminated"),
			{ type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 2000, errorMessage: "terminated" },
			reply("stop"), { type: "auto_retry_end", success: true, attempt: 1 },
		];
		const recovered = providerFailureTexts(events, { retry: true });
		expect(recovered).toEqual([]);
		const run = { valid: false, timedOut: false, stoppedByRunner: false, notLaunchedInterrupted: false };
		expect(decideInfra({ ...run, failures: parentFails(...recovered) }).infra).toBe(false);
		// Without a policy the same stream reads as v5 read it: a failure.
		expect(providerFailureTexts(events)).toEqual(["terminated"]);
		// A worker's recovered drop never reaches its provider errors, so the
		// child's failure (here its own empty answer) has no provider text either.
		const failed = { type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", stopReason: "error", errorMessage: "terminated", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } };
		const session = [
			{ type: "session", version: 3, id: "child-1", timestamp: "t", cwd: "/target" },
			{ type: "message", id: "e2", parentId: null, timestamp: "t", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", responseId: "c1", stopReason: "toolUse", content: [], usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22 } } },
			failed,
			{ type: "context_edit", id: "e4", parentId: "e3", timestamp: "t", targetId: "e3", replacement: null },
			{ type: "message", id: "e5", parentId: "e4", timestamp: "t", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", responseId: "c2", stopReason: "stop", content: [], usage: { input: 25, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 26 } } },
		].map((row) => JSON.stringify(row)).join("\n");
		const child = { childKey: "run-a/run-0", status: "failed" as const, error: "Subagent returned an empty final answer\nterminated" };
		const read = observationsFromChildSession(session, child.childKey, { retry: true });
		expect(read.providerErrors).toEqual([]);
		expect(childProviderFailure(child, read.providerErrors, child.error)).toEqual({});
		expect(childProviderFailure(child, observationsFromChildSession(session, child.childKey).providerErrors, child.error)).toEqual({ text: "terminated" });
	});

	it("keeps the text of a retry pi cancelled, or of the last attempt when the retries ran out", () => {
		const cancelled = [
			reply("toolUse"), reply("error", "Connection error."),
			{ type: "auto_retry_start", attempt: 1 },
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		];
		expect(providerFailureTexts(cancelled, { retry: true })).toEqual(["Connection error."]);
		const exhausted = [
			reply("error", "terminated"), { type: "auto_retry_start", attempt: 1 },
			reply("error", "Request timed out."),
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Request timed out." },
		];
		expect(providerFailureTexts(exhausted, { retry: true })).toEqual(["Request timed out."]);
		// A stream cut off during the backoff sleep did not recover either.
		expect(providerFailureTexts([reply("error", "terminated"), { type: "auto_retry_start", attempt: 1 }], { retry: true })).toEqual(["terminated"]);
	});
});

describe("retry cap and request log", () => {
	const run = { valid: false, timedOut: false, stoppedByRunner: false, notLaunchedInterrupted: false, failures: parentFails() };

	// pi recovers each drop, so a provider that kept dropping leaves no failure
	// text; without the cap the run would be blocked as the arm's own fault.
	it("classes a run past the retry cap as infrastructure though pi recovered every drop", () => {
		const verdict = decideInfra({ ...run, retry: { attempts: 13, cap: { floor: 12, rate: 0.1, meteredRequests: 98, allowed: 12 }, capExceeded: true } });
		expect(verdict).toMatchObject({ infra: true, reason: "retry cap exceeded" });
		expect(verdict.evidence).toBe("13 failed provider attempts; the policy allows 12 (max of 12 and 0.1 x 98 metered requests)");
		expect(decideInfra({ ...run, retry: { attempts: 12, cap: { floor: 12, rate: 0.1, meteredRequests: 98, allowed: 12 }, capExceeded: false } }).infra).toBe(false);
	});

	it("still never classes a timed-out run as infrastructure, past the cap or not", () => {
		expect(decideInfra({ ...run, timedOut: true, retry: { attempts: 20, cap: { floor: 12, rate: 0.1, meteredRequests: 98, allowed: 12 }, capExceeded: true } }).infra).toBe(false);
	});

	it("keeps a spent quota ahead of the cap, so the grid still stops for the reset", () => {
		const verdict = decideInfra({ ...run, failures: parentFails("insufficient_quota"), retry: { attempts: 20, cap: { floor: 12, rate: 0.1, meteredRequests: 98, allowed: 12 }, capExceeded: true } });
		expect(verdict).toMatchObject({ infra: true, exhausted: true });
	});

	it("counts only the provider's own requests from the entry's log, by status", () => {
		const stderr = [
			'{"type":"benchmark_request","n":1,"host":"api.z.ai","status":200,"msToHeaders":900}',
			'{"type":"benchmark_request","n":2,"host":"API.Z.AI:443","status":429,"msToHeaders":80}',
			'{"type":"benchmark_request","n":3,"host":"api.z.ai","status":null,"msToHeaders":30000}',
			'{"type":"benchmark_request","n":4,"host":"models.example.test","status":200,"msToHeaders":10}',
			'{"type":"benchmark_request","n":5,"status":200}',
			"benchmark_request api.z.ai 200",
		].join("\n");
		expect(requestLogFromStderr(stderr, ["api.z.ai"])).toEqual({ logged: 3, byStatus: { 200: 1, 429: 1, none: 1 } });
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

	// The snapshot digest was pinned and the cap it runs under was not, so
	// --candidate-max-agents 3 on the official grid made an acceptance decision
	// about a candidate nobody froze.
	it("pins the candidate's worker cap at eight and makes any other cap exploratory", async () => {
		const shipped = parseComparePins(await readFile(new URL("./delegation-compare.pins.json", import.meta.url), "utf8"));
		expect(shipped.candidateMaxAgents).toBe(8);
		expect(workerCapReason(8, 8)).toBeUndefined();
		expect(workerCapReason(8, 3)).toBe("candidate worker cap 3 is not the pinned 8");
		expect(workerCapReason(8, undefined)).toBe("candidate worker cap unstated is not the pinned 8");
		expect(workerCapReason(null, 8)).toMatch(/no candidate worker cap is pinned/);
		expect(parseComparePins(JSON.stringify(valid)).candidateMaxAgents).toBeNull();
		expect(() => parseComparePins(JSON.stringify({ ...valid, candidateMaxAgents: -1 }))).toThrow(/candidateMaxAgents/);
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

	// One drop in the parent and one in a worker, each recovered by pi's retry.
	const droppedParent = (): Record<string, unknown>[] => [
		{ type: "message_end", message: { role: "assistant", content: [], provider: "zai", model: "glm-5.3-flash", responseId: "p0", usage: usage(0, 0), stopReason: "error", errorMessage: "terminated", timestamp: 1 } },
		{ type: "auto_retry_start", attempt: 1, maxAttempts: 4, delayMs: 2000, errorMessage: "terminated" },
	];
	const droppedWorker = (): string => {
		const rows = sessionText().split("\n");
		const failed = { type: "message", id: "e5", parentId: "e3", timestamp: "t", message: { role: "assistant", provider: "zai", model: "glm-5.3-flash", stopReason: "error", errorMessage: "terminated", usage: usage(0, 0), content: [] } };
		const edit = { type: "context_edit", id: "e6", parentId: "e5", timestamp: "t", targetId: "e5", replacement: null };
		return [...rows.slice(0, 4), JSON.stringify(failed), JSON.stringify(edit), rows[4]].join("\n");
	};

	it("counts the parent's and a worker's recovered drops under a retry policy, with the estimate beside the metered total", async () => {
		const dir = await cellWithSession(droppedWorker());
		const events = [parentReply("p1", "toolUse"), ...subagentCall("call-1", { mode: "single", runId: "run-a", results: [childRow("run-a", dir)] }), ...droppedParent(), parentReply("p2", "stop")];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 }, { ...DEFAULT_RETRY_POLICY });
		expect(account.errors).toEqual([]);
		expect(account.usage.total.totalTokens).toBe(220 + 55);
		expect(account.retry).toMatchObject({
			attempts: 2, recovered: 2, unrecovered: 0, unmeteredAttempts: 2, capExceeded: false,
			bySource: { parent: { attempts: 1, recovered: 1, unrecovered: 0 }, worker: { attempts: 1, recovered: 1, unrecovered: 0 } },
			// Each attempt resent what the reply that recovered it sent: p2's prompt
			// of 100 for the parent, c2's 25 for the worker.
			estimatedTokens: 100 + 25,
		});
		expect(account.meteredCalls).toBe(4);
	});

	it("fails a run whose failed attempts, parent and workers together, pass the policy's cap", async () => {
		const dir = await cellWithSession(droppedWorker());
		const events = [parentReply("p1", "toolUse"), ...droppedParent(), ...subagentCall("call-1", { mode: "single", runId: "run-a", results: [childRow("run-a", dir)] }), parentReply("p2", "stop")];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 }, { ...DEFAULT_RETRY_POLICY, maxFailedAttempts: 1 });
		expect(account.retry?.capExceeded).toBe(true);
		expect(account.errors.join("\n")).toMatch(/2 failed provider attempts \(parent 1, workers 1\) exceed the retry policy's cap of 1 for a run of 4 metered requests/);
	});

	// Absent a policy the cell reads as every v5 cell did: a retry is a failure
	// whose spend is unknown, and the record carries no retry block.
	it("reads a cell without a retry policy as v5 did, with no retry block", async () => {
		const dir = await cellWithSession(droppedWorker());
		const events = [parentReply("p1", "toolUse"), ...droppedParent(), ...subagentCall("call-1", { mode: "single", runId: "run-a", results: [childRow("run-a", dir)] }), parentReply("p2", "stop")];
		const account = await accountCellUsage(events, { arm: "candidate", childSessionDir: dir }, expectRun, { subagentCalls: 1 });
		expect("retry" in account).toBe(false);
		expect("meteredCalls" in account).toBe(false);
		expect(account.errors.join("\n")).toMatch(/auto_retry_start: retries are disabled/);
		expect(account.errors.join("\n")).toMatch(/failed: terminated/);
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
		expect(metricFromRecord({ key: "A#1", target: "A", pass: 1, valid: false, totalTokens: null, totalTokensWithRetryEstimate: null }).totalTokens).toBeNaN();
	});

	// The gate reads metered tokens plus the estimate for unmetered attempts, so a
	// resumed pair compares on the same number a fresh one did; the metered-only
	// comparison beside it reads the metered count.
	it("gates a retried run's tokens on the estimate and reads the metered count only when asked", () => {
		const record = { key: "A#1", target: "A", pass: 1, valid: true, truePositives: 2, precisionLowerBound: 0.5, findings: 4, totalTokens: 1000, totalTokensWithRetryEstimate: 1400 };
		expect(metricFromRecord(record).totalTokens).toBe(1400);
		expect(metricFromRecord(record, "metered").totalTokens).toBe(1000);
		// A v5 record has no estimate; both readings are its metered count.
		const { totalTokensWithRetryEstimate: _, ...v5 } = record;
		expect(metricFromRecord(v5).totalTokens).toBe(1000);
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

	// Half a grid that read a retried attempt as a failure and half that read it
	// as a count would not compare.
	it("refuses a resume whose retry policy differs from the stopped grid's", () => {
		expect(resumeMismatches(manifest(), { ...manifest(), retryPolicy: { ...DEFAULT_RETRY_POLICY } })).toEqual(["retryPolicy"]);
		expect(resumeMismatches({ ...manifest(), retryPolicy: { ...DEFAULT_RETRY_POLICY } }, { ...manifest(), retryPolicy: { ...DEFAULT_RETRY_POLICY } })).toEqual([]);
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

describe("runStop", () => {
	// The only point where pi's message_end shape meets the stop classifier: a
	// renamed field there would label every run by an empty closing.
	const reply = (stopReason: string, text: string) => ({ type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }] } });

	it("reads the parent's last assistant reply and each worker's session from the harness's own shapes", () => {
		const events = [
			reply("toolUse", "Checking the login flow."),
			{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "Shall I?" }] } },
			reply("stop", "Two leads are recorded. If you want, I can test the refund path next."),
		];
		const session = { ending: "handoff", finalStop: "length", finalText: "Recorded one lead.", errors: [], providerErrors: ["retried"] };
		const stop = runStop({
			result: { exitCode: 0, signal: null, timedOut: false }, stoppedByRunner: false, events,
			telemetry: { surface: 3, hypotheses: 2, settled: 1 },
			children: [{ child: { childKey: "run-a/run-0", agent: "pired-investigate", status: "completed" }, session }] as never,
		});
		expect(stop.outcome).toBe("offered-to-continue");
		expect(stop.evidence).toEqual(["reader-address", "first-person-offer"]);
		expect(stop.crossCheck).toEqual({ surfaceCells: 3, hypotheses: 2, settledHypotheses: 1, openHypotheses: 1 });
		expect(stop.workers).toEqual([{ childKey: "run-a/run-0", agent: "pired-investigate", outcome: "error", evidence: ["last reply ended length"], sessionErrors: 1 }]);
	});

	it("reads a run that never launched as an error with no workers and no cross-check", () => {
		const stop = runStop({ launchError: "not launched: interrupted", stoppedByRunner: false, events: [], telemetry: undefined, children: [] });
		expect(stop).toEqual({ outcome: "error", evidence: ["not launched: interrupted"], crossCheck: null, workers: [] });
	});
});

describe("the candidate's worker cap", () => {
	// Builders: the required command line, and the manifest a fresh grid writes
	// from it, with the inputs block optionsFromManifest reads back on a resume.
	const argv = (...extra: string[]): string[] => [
		"--baseline", "/b", "--candidate", "/c", "--corpus", "/corpus", "--truth", "/truth", "--out", "/out",
		"--provider", "zai", "--model", "glm-5.3-flash", ...extra,
	];
	const options = (...extra: string[]) => {
		const parsed = parseOptions(argv(...extra));
		if (parsed === "help" || parsed.kind !== "run") throw new Error("expected a run");
		return parsed.options;
	};
	const stored = (opts: ReturnType<typeof options>): Record<string, unknown> => ({
		...newManifest(opts, "official"),
		inputs: { corpus: opts.corpus, truth: opts.truth, corpusManifest: { path: opts.manifestPath }, baseline: { path: opts.baseline }, candidate: { path: opts.candidate } },
		pins: { landlockWrapper: opts.fsSeal },
	});

	// Since ADR-029 pired's default cap is 0: a candidate cut from main under a
	// scope naming no cap would not delegate, and the grid would compare the
	// baseline with itself while reporting a delegation result.
	it("writes the cap into the candidate's scope, so a candidate cut from main still delegates", () => {
		expect(reviewScope("e", "/w", "candidate", 8)).toEqual({ engagement: "e", workspace: "/w", mode: "off", authorized: false, targets: {}, maxAgents: 8 });
		expect(reviewScope("e", "/w", "candidate", 0).maxAgents).toBe(0);
	});

	it("leaves the baseline's scope exactly as it was, naming no cap", () => {
		expect(reviewScope("e", "/w", "baseline", 8)).toEqual({ engagement: "e", workspace: "/w", mode: "off", authorized: false, targets: {} });
	});

	// A grid whose manifest predates the option wrote no maxAgents; its resume
	// must write the same scope, or its later pairs measure a different candidate.
	it("writes no cap for a grid whose manifest predates the option", () => {
		expect(reviewScope("e", "/w", "candidate", undefined)).not.toHaveProperty("maxAgents");
	});

	// Eight is what the v3/v4 snapshots defaulted to, so re-running one of them
	// without the flag delegates as its own grids did.
	it("defaults to the v3/v4 snapshots' own cap of eight and takes an explicit one", () => {
		expect(DEFAULT_CANDIDATE_MAX_AGENTS).toBe(8);
		expect(options().candidateMaxAgents).toBe(8);
		expect(options("--candidate-max-agents", "3").candidateMaxAgents).toBe(3);
		expect(options("--candidate-max-agents", "0").candidateMaxAgents).toBe(0);
	});

	it("refuses a cap that is not a non-negative integer", () => {
		for (const bad of ["-1", "2.5", "eight"]) expect(() => parseOptions(argv("--candidate-max-agents", bad))).toThrow(/--candidate-max-agents/);
	});

	it("pins the cap in the manifest and restores it on resume", () => {
		const manifest = stored(options("--candidate-max-agents", "5"));
		expect(manifest.candidateMaxAgents).toBe(5);
		expect(optionsFromManifest("/out", manifest).candidateMaxAgents).toBe(5);
	});

	// An old manifest must still load for a resume, and resume without a cap.
	it("restores no cap from a manifest that predates the option", () => {
		const manifest = stored(options());
		delete manifest.candidateMaxAgents;
		expect(optionsFromManifest("/out", manifest)).not.toHaveProperty("candidateMaxAgents");
	});

	it("refuses to resume from a manifest whose cap is malformed rather than reading it as absent", () => {
		expect(() => optionsFromManifest("/out", { ...stored(options()), candidateMaxAgents: -2 })).toThrow(/candidateMaxAgents/);
	});

	// Pairs measured under two caps are two candidates pooled into one comparison.
	it("refuses a resume whose cap differs from the one the grid started with", () => {
		const prior = { candidateMaxAgents: 8 };
		expect(resumeMismatches(prior, { candidateMaxAgents: 4 })).toEqual(["candidateMaxAgents"]);
		expect(resumeMismatches(prior, {})).toEqual(["candidateMaxAgents"]);
		expect(resumeMismatches({}, {})).toEqual([]);
	});
});

describe("runPairs", () => {
	// Builders: a scripted run outcome as runOne returns it, and a pair loop over
	// fake launches and a fake clock. Each launched arm takes ten minutes; a sleep
	// moves the clock by what it was asked for.
	type Kind = "valid" | "drop" | "broken" | "quota";
	const outcome = (pair: ScheduledPair, arm: Arm, attempt: number, kind: Kind): RunOutcome => {
		const valid = kind === "valid";
		const infraFailure = kind === "drop" || kind === "quota";
		return {
			metric: { key: pair.key, target: pair.target, pass: pair.pass, valid, truePositives: valid ? 1 : 0, precision: valid ? 0.5 : 0, totalClaims: valid ? 2 : 0, totalTokens: valid ? 1000 : Number.NaN },
			arm, cellId: `cell-${pair.key}-${arm}-${attempt}`, seconds: 600, infraFailure, ...(kind === "quota" ? { quotaExhausted: true } : {}),
			record: {
				key: pair.key, target: pair.target, pass: pair.pass, arm, attempt, valid, infraFailure,
				infraReason: kind === "drop" ? "transient provider error" : kind === "quota" ? "provider quota exhausted" : null,
				...(kind === "quota" ? { infraEvidence: "usage limit reached" } : {}),
			},
		};
	};
	const grid = (targets: string[], script: (key: string, arm: Arm, attempt: number) => Kind | "throw",
		opts: { breaker?: BreakerPolicy; official?: boolean; concurrency?: number; firstAttempt?: number; slow?: (key: string) => boolean } = {}) => {
		let clock = Date.UTC(2026, 8, 26, 12, 0);
		const launched: string[] = [];
		const settled: RunOutcome[] = [];
		const lines: string[] = [];
		const sleeps: number[] = [];
		const state: GridStopState = { aborted: false, stopInvalid: false, stopReason: undefined, quotaExhausted: undefined };
		const run = () => runPairs({
			pairs: planSchedule(targets, 1), firstAttempt: () => opts.firstAttempt ?? 1, concurrency: opts.concurrency ?? 1, official: opts.official ?? false,
			...(opts.breaker ? { breaker: opts.breaker } : {}),
			state,
			launch: async (pair, arm, attempt) => {
				launched.push(`${pair.key} ${arm} ${attempt}`);
				// A slow pair yields many times before it returns, so the other worker runs ahead of it.
				if (opts.slow?.(pair.key)) for (let i = 0; i < 50; i++) await Promise.resolve();
				clock += 10 * 60_000;
				const kind = script(pair.key, arm, attempt);
				if (kind === "throw") throw new Error("cell staging failed");
				return outcome(pair, arm, attempt, kind);
			},
			settle: async (o) => { settled.push(o); },
			report: async () => undefined,
			nowMs: () => clock,
			sleep: async (ms) => { sleeps.push(ms); clock += ms; },
			log: (line) => lines.push(line), warn: (line) => lines.push(line), out: "/grid",
		});
		return { run, launched, settled, lines, sleeps, state };
	};
	const allValid = (): Kind => "valid";

	// The rule every grid before --breaker ran under, kept exactly: no re-queue,
	// no breaker, and the first invalid run stops every later pair.
	it("without a breaker policy the grid still stops on the first invalid run", async () => {
		const g = grid(["A", "B", "C"], (key, arm) => key === "A#1" && arm === "baseline" ? "drop" : "valid");
		const result = await g.run();
		expect(g.launched).toEqual(["A#1 baseline 1"]);
		expect(g.settled.map((o) => [o.metric.key, o.arm, o.record.notLaunched === true])).toEqual([["A#1", "baseline", false], ["A#1", "candidate", true]]);
		expect(g.state.stopInvalid).toBe(true);
		expect(g.state.stopReason).toBe("stopped after an invalid baseline run of A pass 1 (infra: transient provider error)");
		expect(result).toEqual({ breaker: null, requeued: [], gaveUp: [], blocked: [], abandoned: [] });
		expect(g.sleeps).toEqual([]);
	});

	// Fail-fast with two pairs in flight, as grids ran it: the pair already in
	// flight finishes its second arm, the invalid arm's partner is not launched,
	// and no later pair starts.
	it("without a breaker, lets the pair in flight finish and launches nothing after the first invalid run", async () => {
		const g = grid(["A", "B", "C"], (key, arm) => key === "A#1" && arm === "baseline" ? "drop" : "valid", { concurrency: 2 });
		await g.run();
		expect([...g.launched].sort()).toEqual(["A#1 baseline 1", "B#1 baseline 1", "B#1 candidate 1"]);
		expect(g.settled.find((o) => o.metric.key === "A#1" && o.arm === "candidate")?.record.notLaunched).toBe(true);
		expect(g.state.stopReason).toBe("stopped after an invalid baseline run of A pass 1 (infra: transient provider error)");
	});

	// v5 lost a night to one dropped stream. With a breaker the dropped pair runs
	// again, both arms at attempt 2, once its cooldown has passed, and a pair of
	// the schedule that is ready goes first rather than the worker idling.
	it("re-queues an infrastructure-failed pair at the next attempt and finishes the grid", async () => {
		const g = grid(["A", "B", "C"], (key, arm, attempt) => key === "A#1" && arm === "candidate" && attempt === 1 ? "drop" : "valid", { breaker: DEFAULT_BREAKER });
		const result = await g.run();
		expect(g.launched).toEqual([
			"A#1 baseline 1", "A#1 candidate 1", "B#1 candidate 1", "B#1 baseline 1", "A#1 baseline 2", "A#1 candidate 2", "C#1 baseline 1", "C#1 candidate 1",
		]);
		expect(g.state.stopInvalid).toBe(false);
		expect(result.requeued).toEqual([{ key: "A#1", attempt: 2, notBefore: "2026-09-26T12:21:00.000Z", reason: "attempt 1: an arm failed for an infrastructure reason" }]);
		expect(result.breaker).toEqual({ tripped: false });
		// The valid attempt-1 baseline is not paired with the attempt-2 candidate.
		expect(atHighestAttempt(g.settled).filter((o) => o.metric.key === "A#1").map((o) => o.record.attempt)).toEqual([2, 2]);
	});

	// A cooldown with nothing else to run is waited out in short slices, so a
	// signal or another pair's trip is seen within a second.
	it("waits out the cooldown in one-second slices when only a re-queued pair is left", async () => {
		const g = grid(["A"], (_key, arm, attempt) => arm === "candidate" && attempt === 1 ? "drop" : "valid", { breaker: DEFAULT_BREAKER });
		await g.run();
		expect(g.launched.slice(-2)).toEqual(["A#1 baseline 2", "A#1 candidate 2"]);
		expect(g.sleeps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
		expect(g.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
	});

	// At the start of an outage the breaker spends C runs before it trips; a
	// partner never launched is not counted, or it would trip on half the evidence.
	it("stops launching once three consecutive infrastructure failures trip the breaker", async () => {
		const g = grid(["A", "B", "C", "D"], () => "drop", { breaker: DEFAULT_BREAKER });
		const result = await g.run();
		expect(g.launched).toEqual(["A#1 baseline 1", "B#1 candidate 1", "A#1 baseline 2"]);
		expect(g.state.stopInvalid).toBe(true);
		expect(g.state.stopReason).toMatch(/^circuit breaker tripped on the baseline run of A pass 1 attempt 2: 3 consecutive launched runs failed \(3 infrastructure\)/);
		expect(result.breaker?.tripped).toBe(true);
		expect(g.lines.some((l) => l.startsWith("BREAKER TRIPPED — ") && l.includes("--resume /grid"))).toBe(true);
	});

	// A resumed pair starts at its plan's next attempt. The cap and the cooldown
	// count this runner's attempts, so it gets four more, 60, 120 and 180 s apart.
	it("counts the cap and the cooldown from a resumed pair's first attempt in this runner", async () => {
		const g = grid(["A"], (_key, arm) => arm === "candidate" ? "drop" : "valid", { breaker: DEFAULT_BREAKER, firstAttempt: 3 });
		const result = await g.run();
		expect(g.launched.filter((l) => l.startsWith("A#1 candidate"))).toEqual(["A#1 candidate 3", "A#1 candidate 4", "A#1 candidate 5", "A#1 candidate 6"]);
		expect(result.requeued.map((r) => r.attempt)).toEqual([4, 5, 6]);
		expect(g.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000 + 120_000 + 180_000);
		expect(result.gaveUp).toEqual([{ key: "A#1", attempt: 6, reason: expect.stringMatching(/launched it 4 time\(s\), the cap of 4/) }]);
	});

	// A worker that finds the queue empty stops, while its partner still runs a
	// pair that will drop. That pair is re-queued by the worker still running it.
	it("does not strand a re-queued pair when the other worker has already stopped", async () => {
		const g = grid(["A", "B"], (key, arm, attempt) => key === "A#1" && arm === "candidate" && attempt === 1 ? "drop" : "valid",
			{ breaker: DEFAULT_BREAKER, concurrency: 2, slow: (key) => key === "A#1" });
		const result = await g.run();
		expect(g.launched.indexOf("B#1 baseline 1")).toBeLessThan(g.launched.indexOf("A#1 candidate 1"));
		expect(g.launched.slice(-2)).toEqual(["A#1 baseline 2", "A#1 candidate 2"]);
		expect(result.requeued.map((r) => r.key)).toEqual(["A#1"]);
		expect(atHighestAttempt(g.settled).every((o) => o.metric.valid)).toBe(true);
	});

	// An auto-resumer could otherwise re-run one pair forever. At the ceiling an
	// official grid stops, since its decision is fixed; an exploratory one goes on.
	it("abandons a pair failing at the attempt ceiling, stopping an official grid and not an exploratory one", async () => {
		const policy = { ...DEFAULT_BREAKER, attemptCeiling: 2 };
		const official = grid(["A", "B"], (key, arm) => key === "A#1" && arm === "candidate" ? "drop" : "valid", { breaker: policy, official: true, firstAttempt: 2 });
		const stopped = await official.run();
		expect(stopped.abandoned).toEqual([{ key: "A#1", attempt: 2, reason: expect.stringMatching(/2 is the attempt ceiling of 2/) }]);
		expect(official.state.stopReason).toBe("A#1 failed at the attempt ceiling of 2, so this official grid's decision is already incomplete_or_invalid");
		expect(official.launched.some((l) => l.startsWith("B#1"))).toBe(false);
		const exploratory = grid(["A", "B"], (key, arm) => key === "A#1" && arm === "candidate" ? "drop" : "valid", { breaker: policy, firstAttempt: 2 });
		const went = await exploratory.run();
		expect(went.abandoned.map((a) => a.key)).toEqual(["A#1"]);
		expect(exploratory.launched.filter((l) => l.startsWith("B#1"))).toHaveLength(2);
		expect(exploratory.state.stopInvalid).toBe(false);
	});

	it("gives up on a pair at the attempt cap and finishes the rest of the grid", async () => {
		const g = grid(["A", "B", "C"], (key, arm) => key === "A#1" && arm === "candidate" ? "drop" : "valid", { breaker: { ...DEFAULT_BREAKER, maxAttempts: 2 } });
		const result = await g.run();
		expect(g.launched.filter((l) => l.startsWith("A#1 candidate"))).toEqual(["A#1 candidate 1", "A#1 candidate 2"]);
		expect(g.launched.at(-1)).toBe("C#1 candidate 1");
		expect(result.gaveUp).toEqual([{ key: "A#1", attempt: 2, reason: expect.stringMatching(/the cap of 2, so only a --resume re-runs it$/) }]);
		expect(g.state.stopInvalid).toBe(false);
	});

	// A runner fault is a harness failure: in an official grid it blocks the pair
	// and fixes the decision, so the breaker stops the grid at once, as fail-fast did.
	it("stops an official grid at once on a runner fault and never re-queues it", async () => {
		const g = grid(["A", "B"], (key) => key === "A#1" ? "throw" : "valid", { breaker: DEFAULT_BREAKER, official: true });
		const result = await g.run();
		expect(g.launched).toEqual(["A#1 baseline 1"]);
		expect(g.settled[0]!.record.errors).toEqual(["runner fault: cell staging failed"]);
		expect(g.state.stopReason).toMatch(/official grid is invalid for a non-infrastructure reason/);
		expect(result.requeued).toEqual([]);
	});

	// An exploratory grid keeps going past one blocked pair, which is never re-run.
	it("keeps an exploratory grid going past a single non-infrastructure failure without re-running it", async () => {
		const g = grid(["A", "B"], (key, arm) => key === "A#1" && arm === "baseline" ? "broken" : "valid", { breaker: DEFAULT_BREAKER });
		const result = await g.run();
		expect(g.launched).toEqual(["A#1 baseline 1", "B#1 candidate 1", "B#1 baseline 1"]);
		expect(result).toMatchObject({ requeued: [], gaveUp: [], breaker: { tripped: false } });
		expect(result.blocked).toEqual([{ key: "A#1", attempt: 1, reason: "attempt 1: an arm is invalid for a non-infrastructure reason; it stays invalid" }]);
	});

	// Counting only infrastructure let a candidate that fails every run spend a
	// whole exploratory grid. Under the counterbalanced order its failures
	// alternate with valid baselines, so the window's rate, not the streak, stops it.
	it("stops an exploratory grid whose candidate fails every run within the first window", async () => {
		const g = grid(["A", "B", "C", "D", "E", "F"], (_key, arm) => arm === "candidate" ? "broken" : "valid", { breaker: DEFAULT_BREAKER });
		await g.run();
		expect(g.launched).toHaveLength(8);
		expect(g.launched.some((l) => l.startsWith("F#1"))).toBe(false);
		expect(g.state.stopReason).toMatch(/: 5 of 8 launched runs failed \(0 infrastructure\)/);
	});

	it("stops the grid on a spent quota with the quota's own reason and resume advice", async () => {
		const g = grid(["A", "B"], () => "quota", { breaker: DEFAULT_BREAKER });
		await g.run();
		expect(g.launched).toEqual(["A#1 baseline 1"]);
		expect(g.state.quotaExhausted).toBe("provider quota exhausted: usage limit reached");
		expect(g.state.stopReason).toMatch(/^provider quota exhausted on the baseline run of A pass 1 .*the quota must reset before --resume$/);
		expect(g.lines.filter((l) => l.startsWith("BREAKER TRIPPED"))).toEqual([]);
	});
});

describe("atHighestAttempt", () => {
	const row = (key: string, arm: string, attempt?: number) => ({ metric: { key }, record: { key, arm, ...(attempt === undefined ? {} : { attempt }) } });

	// compareMatchedRuns reads a repeated key as a duplicate run and the grid as
	// incomplete; a re-queued pair is compared at its last attempt only.
	it("keeps each pair's highest attempt only, in order", () => {
		const rows = [row("A#1", "baseline", 1), row("A#1", "candidate", 1), row("B#1", "baseline", 1), row("A#1", "baseline", 2), row("A#1", "candidate", 2)];
		expect(atHighestAttempt(rows).map((r) => `${r.metric.key} ${r.record.arm} ${String(r.record.attempt)}`)).toEqual(["B#1 baseline 1", "A#1 baseline 2", "A#1 candidate 2"]);
	});

	it("passes a fail-fast grid's outcomes through unchanged, rows without an attempt included", () => {
		const rows = [row("A#1", "baseline"), row("A#1", "candidate"), row("B#1", "candidate", 3), row("B#1", "baseline", 3)];
		expect(atHighestAttempt(rows)).toEqual(rows);
	});
});

describe("the breaker policy", () => {
	// Builders: the required command line, and the manifest a fresh grid writes
	// from it, with the inputs block optionsFromManifest reads back on a resume.
	const argv = (...extra: string[]): string[] => [
		"--baseline", "/b", "--candidate", "/c", "--corpus", "/corpus", "--truth", "/truth", "--out", "/out",
		"--provider", "openai-codex", "--model", "gpt-6-luna", ...extra,
	];
	const options = (...extra: string[]) => {
		const parsed = parseOptions(argv(...extra));
		if (parsed === "help" || parsed.kind !== "run") throw new Error("expected a run");
		return parsed.options;
	};
	const stored = (opts: ReturnType<typeof options>): Record<string, unknown> => ({
		...newManifest(opts, "official"),
		inputs: { corpus: opts.corpus, truth: opts.truth, corpusManifest: { path: opts.manifestPath }, baseline: { path: opts.baseline }, candidate: { path: opts.candidate } },
		pins: { landlockWrapper: opts.fsSeal },
	});

	// A resume that forgot the policy would fall back to fail-fast half-way
	// through a grid, and re-queue nothing.
	it("the policy survives a resume from the manifest", () => {
		const manifest = stored(options("--breaker", "consecutive=2,maxAttempts=3"));
		expect(manifest.breaker).toEqual({ ...DEFAULT_BREAKER, consecutive: 2, maxAttempts: 3 });
		expect(optionsFromManifest("/out", manifest).breaker).toEqual({ ...DEFAULT_BREAKER, consecutive: 2, maxAttempts: 3 });
		expect(optionsFromManifest("/out", stored(options("--breaker", "default"))).breaker).toEqual(DEFAULT_BREAKER);
	});

	// Every grid before the option ran fail-fast; its manifest must still load,
	// and a grid run without the option must write the manifest it always did.
	it("leaves a grid without --breaker, and an old manifest, on fail-fast", () => {
		expect(options()).not.toHaveProperty("breaker");
		expect(newManifest(options(), "official")).not.toHaveProperty("breaker");
		expect(optionsFromManifest("/out", stored(options()))).not.toHaveProperty("breaker");
	});

	it("refuses to resume from a manifest whose breaker is malformed rather than reading it as absent", () => {
		expect(() => optionsFromManifest("/out", { ...stored(options()), breaker: { ...DEFAULT_BREAKER, window: 0 } })).toThrow(/invalid breaker: .*window/);
	});

	it("refuses a resume whose breaker differs from the one the grid started with", () => {
		expect(resumeMismatches({ breaker: DEFAULT_BREAKER }, { breaker: { ...DEFAULT_BREAKER, rate: 0.25 } })).toEqual(["breaker"]);
		expect(resumeMismatches({ breaker: DEFAULT_BREAKER }, {})).toEqual(["breaker"]);
	});

	it("refuses a --breaker spec it cannot read, naming the option", () => {
		for (const bad of ["on", "rate=2", "window=8,window=9", "maxAttempt=4", "cooldownMs=", "rate=0.5=1"]) {
			expect(() => parseBreakerSpec(bad)).toThrow(/^--breaker: /);
		}
		expect(() => parseOptions(argv("--breaker"))).toThrow(/Missing value for --breaker/);
	});

	// A grid that re-queues runs longer than one attempt per pair; a horizon sized
	// for one attempt would let its OAuth token be refreshed inside a cell.
	it("sizes the auth horizon for every attempt and cooldown the breaker allows", () => {
		const official = { passes: 3, targets: 5, concurrency: 2, timeoutMs: 2 * 3_600_000 };
		expect(gridWorstCaseMs({ ...official, breaker: DEFAULT_BREAKER })).toBe(9 * (4 * 2 * 2 * 3_600_000 + 6 * 60_000));
		expect(gridWorstCaseMs(official)).toBe(36 * 3_600_000);
	});
});

describe("the attempt ceiling on resume", () => {
	// Builders: a run row as runs.jsonl holds it.
	const row = (key: string, arm: "baseline" | "candidate", attempt: number, valid: boolean, infra = !valid): Record<string, unknown> =>
		({ key, target: key.split("#")[0], pass: 1, arm, attempt, valid, infraFailure: infra, infraReason: infra ? "transient provider error" : null });

	// An auto-resumer that re-runs every infrastructure-failed pair never ends on
	// a pair that always drops; at the ceiling planResume stops offering it.
	it("abandons a pair still failing at the ceiling instead of re-running it, and only with a ceiling", () => {
		const runs = [row("A#1", "baseline", 16, true), row("A#1", "candidate", 16, false), row("B#1", "baseline", 3, true), row("B#1", "candidate", 3, false)];
		const plan = planResume(planSchedule(["A", "B"], 1), runs, 16);
		expect(plan.abandonedKeys).toEqual(["A#1"]);
		expect(plan.rerunKeys).toEqual(["B#1"]);
		expect(plan.reasons["A#1"]).toMatch(/16 is the attempt ceiling of 16/);
		// A grid without a breaker has no ceiling, and plans as it always did.
		const failFast = planResume(planSchedule(["A", "B"], 1), runs);
		expect(failFast.abandonedKeys).toEqual([]);
		expect(failFast.rerunKeys).toEqual(["A#1", "B#1"]);
		expect(failFast.nextAttempt["A#1"]).toBe(17);
	});
});

describe("attemptReport", () => {
	const row = (key: string, arm: "baseline" | "candidate", attempt: number, extra: Record<string, unknown>): Record<string, unknown> =>
		({ key, arm, attempt, valid: false, infraFailure: false, ...extra });

	// Which arm drops more has differed by grid (31/16, 22/8, 10/14 launched
	// infrastructure failures), so the report counts them per arm rather than
	// assume a direction; a partner never launched is not a failure it had.
	it("counts launched infrastructure failures per arm by reason, and each pair's highest attempt", () => {
		const rows = [
			row("A#1", "baseline", 1, { infraFailure: true, infraReason: "transient provider error" }),
			row("A#1", "candidate", 1, { infraFailure: true, infraReason: "partner arm baseline failed: x", notLaunched: true }),
			row("A#1", "candidate", 2, { infraFailure: true, infraReason: "zai 1308" }),
			row("A#1", "baseline", 2, { valid: true, seconds: 900, totalTokens: 5000 }),
			row("B#1", "candidate", 1, { infraFailure: true }),
		];
		const report = attemptReport(rows, []);
		expect(report.attemptsByPair).toEqual({ "A#1": 2, "B#1": 1 });
		expect(report.launchedInfraFailures).toEqual({ baseline: { "transient provider error": 1 }, candidate: { "zai 1308": 1, unstated: 1 } });
		expect(report.abandoned).toEqual([]);
	});

	it("lists every attempt of an abandoned pair with each arm's validity, reason, seconds and tokens", () => {
		const rows = [
			row("A#1", "candidate", 2, { infraFailure: true, infraReason: "zai 1308", seconds: 120, totalTokens: null }),
			row("A#1", "baseline", 1, { errors: ["runner fault: x"] }),
			row("A#1", "baseline", 2, { valid: true, seconds: 900, totalTokens: 5000 }),
		];
		expect(attemptReport(rows, ["A#1"]).abandoned).toEqual([{ key: "A#1", attempts: [
			{ attempt: 1, baseline: { launched: true, valid: false, infra: false, reason: "runner fault: x", seconds: null, tokens: null }, candidate: null },
			{ attempt: 2, baseline: { launched: true, valid: true, infra: false, reason: null, seconds: 900, tokens: 5000 }, candidate: { launched: true, valid: false, infra: true, reason: "zai 1308", seconds: 120, tokens: null } },
		] }]);
	});
});

describe("retry policy in the manifest", () => {
	type GridOptions = Parameters<typeof newManifest>[0];
	const options = (over: Partial<GridOptions> = {}): GridOptions => ({
		baseline: "/snap/base", candidate: "/snap/cand", corpus: "/corpus", truth: "/truth", out: "/out", provider: "zai", model: "glm-5.3-flash",
		thinking: "medium", passes: 3, concurrency: 2, timeoutMs: 7_200_000, selected: [], fsSeal: "/bin/seal", manifestPath: "/corpus/manifest.json",
		dryRun: false, ...over,
	});
	// What the preflight adds before a manifest is ever resumed.
	const preflighted = (manifest: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify({
		...manifest,
		inputs: { corpus: "/corpus", truth: "/truth", corpusManifest: { path: "/corpus/manifest.json" }, baseline: { path: "/snap/base" }, candidate: { path: "/snap/cand" } },
		pins: { landlockWrapper: "/bin/seal" },
	})) as Record<string, unknown>;

	it("records the policy a grid ran with and restores it on resume", () => {
		const manifest = newManifest(options({ retryPolicy: { ...DEFAULT_RETRY_POLICY } }), "live");
		expect(manifest.retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
		expect((manifest.runtimeConfiguration as Record<string, unknown>).settings).toMatchObject({ retry: { enabled: true, maxRetries: 4, provider: { maxRetries: 0 } } });
		expect(optionsFromManifest("/out", preflighted(manifest)).retryPolicy).toEqual(DEFAULT_RETRY_POLICY);
	});

	// Every v5 grid ran with retries off; its manifest has no policy and must
	// resume with retries off, not under a default a later harness picked.
	it("writes no policy and the v5 settings without one, and resumes an old manifest with retries off", () => {
		const manifest = newManifest(options(), "live");
		expect("retryPolicy" in manifest).toBe(false);
		expect((manifest.runtimeConfiguration as Record<string, unknown>).settings).toBe(BENCHMARK_SETTINGS);
		const restored = optionsFromManifest("/out", preflighted(manifest));
		expect("retryPolicy" in restored).toBe(false);
		expect(retryPolicyFromManifest({ retryPolicy: null })).toBeUndefined();
	});

	// A hand-edited manifest that turned transport retries on would hide failed
	// attempts from every count; the resume refuses rather than drop the policy.
	it("refuses to resume a manifest whose policy is malformed", () => {
		expect(() => retryPolicyFromManifest({ retryPolicy: { ...DEFAULT_RETRY_POLICY, providerMaxRetries: 2 } })).toThrow(/invalid retryPolicy: .*transport retries/);
		expect(() => optionsFromManifest("/out", preflighted({ ...newManifest(options(), "live"), retryPolicy: "on" }))).toThrow(/invalid retryPolicy/);
	});
});

describe("the matched-compute arm (plan 2.5)", () => {
	// Builders: the required command line, a manifest as a fresh grid writes it
	// and a resume reads it back, the default policy, and a matched session's run record.
	const argv = (...extra: string[]): string[] => [
		"--baseline", "/b", "--candidate", "/c", "--corpus", "/corpus", "--truth", "/truth", "--out", "/out",
		"--provider", "zai", "--model", "glm-5.3-flash", ...extra,
	];
	const options = (...extra: string[]) => {
		const parsed = parseOptions(argv(...extra));
		if (parsed === "help" || parsed.kind !== "run") throw new Error("expected a run");
		return parsed.options;
	};
	const stored = (opts: ReturnType<typeof options>): Record<string, unknown> => ({
		...newManifest(opts, "official"),
		inputs: { corpus: opts.corpus, truth: opts.truth, corpusManifest: { path: opts.manifestPath }, baseline: { path: opts.baseline }, candidate: { path: opts.candidate } },
		pins: { landlockWrapper: opts.fsSeal },
	});
	const POLICY: MatchedPolicy = { mode: "follow", k: 3, kMax: 6, floorShare: 0.05 };
	const sessionRecord = (key: string, attempt: number, index: number, sessionAttempt: number, valid: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		key, target: key.split("#")[0], pass: 1, arm: "matched", attempt, cellId: `m-${key}-${index}-${sessionAttempt}`, valid, infraFailure: !valid,
		matchedSession: { index, k: 3, kMax: 6, sessionAttempt, budget: 9000, ceiling: 3000, spentBefore: 0, budgetSource: "candidate", candidateCellId: "c1" },
		findings: valid ? 2 : 0, truePositives: valid ? 1 : 0, precisionLowerBound: valid ? 0.5 : 0, totalTokens: valid ? 3100 : null, ...extra,
	});

	describe("the option", () => {
		it("pins mode, k, kMax and the floor in the manifest, and a resume restores them", () => {
			const opts = options("--matched", "k=4");
			expect(opts.matched).toEqual({ mode: "follow", k: 4, kMax: 8, floorShare: 0.05 });
			const manifest = stored(opts);
			expect(manifest.matched).toEqual({ mode: "follow", k: 4, kMax: 8, floorShare: 0.05 });
			expect(typeof manifest.matchedResumePolicy).toBe("string");
			expect(optionsFromManifest("/out", manifest).matched).toEqual({ mode: "follow", k: 4, kMax: 8, floorShare: 0.05 });
		});

		it("refuses a resume whose matched policy changed", () => {
			const prior = stored(options("--matched", "follow"));
			expect(resumeMismatches(prior, stored(options("--matched", "k=2")))).toContain("matched");
			expect(resumeMismatches(prior, stored(options("--matched", "kMax=4")))).toContain("matched");
			expect(resumeMismatches(prior, stored(options()))).toContain("matched");
			expect(resumeMismatches(prior, prior)).toEqual([]);
			// The arm's snapshot is pinned by digest, as the other arms' are.
			const withInputs = (sha256: string) => ({ ...prior, inputs: { ...(prior.inputs as object), matched: { sha256, stagedDigest: "ms" } } });
			expect(resumeMismatches(withInputs("m1"), withInputs("m2"))).toEqual(["inputs.matched.sha256"]);
		});

		it("refuses to resume a manifest whose matched policy is malformed or partial", () => {
			expect(() => optionsFromManifest("/out", { ...stored(options()), matched: { mode: "follow", k: 0 } })).toThrow(/invalid matched policy: .*k must be/);
			expect(() => optionsFromManifest("/out", { ...stored(options()), matched: { mode: "follow", k: 3 } })).toThrow(/invalid matched policy: .*kMax/);
		});

		it("with the option absent, the manifest and the resumed options carry nothing new", () => {
			const opts = options();
			expect("matched" in opts).toBe(false);
			const manifest = stored(opts);
			expect("matched" in manifest).toBe(false);
			expect("matchedResumePolicy" in manifest).toBe(false);
			expect("matched" in optionsFromManifest("/out", manifest)).toBe(false);
			// An old manifest has no inputs.matched either, so a resume compares what it always did.
			expect(resumeMismatches(manifest, manifest)).toEqual([]);
		});

		it("takes an exploratory snapshot only with --matched", () => {
			expect(options("--matched", "follow", "--matched-snapshot", "/snaps/other").matched).toEqual({ ...POLICY, snapshot: "/snaps/other" });
			expect(() => options("--matched-snapshot", "/snaps/other")).toThrow(/needs --matched/);
		});

		it("sizes the OAuth worst case for the sessions after each pair's two arms", () => {
			const grid = { passes: 3, targets: 5, concurrency: 2, timeoutMs: 1000 };
			expect(gridWorstCaseMs({ ...grid, matchedSessions: 3 })).toBe(gridWorstCaseMs(grid) * 5 / 2);
			expect(gridWorstCaseMs({ ...grid, breaker: DEFAULT_BREAKER, matchedSessions: 3 })).toBeGreaterThan(gridWorstCaseMs({ ...grid, breaker: DEFAULT_BREAKER }));
		});

		it("refuses --matched with --breaker unless the OAuth horizon is stated, since their worst case is past the cap", () => {
			expect(() => options("--matched", "follow", "--breaker", "default")).toThrow(/--matched with --breaker needs --auth-horizon-hours/);
			expect(options("--matched", "follow", "--breaker", "default", "--auth-horizon-hours", "100").matched).toMatchObject({ k: 3 });
			// The official grid at the default k and kMax, 2 h per run: 576.9 h against the 168 h cap.
			const hours = gridWorstCaseMs({ passes: 3, targets: 5, concurrency: 2, timeoutMs: 2 * 3_600_000, breaker: DEFAULT_BREAKER, matchedSessions: 6 }) / 3_600_000;
			expect(hours).toBeCloseTo(576.9, 6);
			expect(hours).toBeGreaterThan(AUTH_HORIZON_CAP_MS / 3_600_000);
		});
	});

	describe("the cell", () => {
		it("states maxAgents 0 in the matched arm's scope and leaves the other arms' scopes as they were", () => {
			expect(reviewScope("e", "/w", "matched", 8).maxAgents).toBe(0);
			expect(reviewScope("e", "/w", "matched", undefined).maxAgents).toBe(0);
			expect(reviewScope("e", "/w", "candidate", 8).maxAgents).toBe(8);
			expect("maxAgents" in reviewScope("e", "/w", "baseline", 8)).toBe(false);
		});

		it("accepts the single agent's tools with or without pi-subagents' lazy loader, and never the eager schema", () => {
			const base = ["read", "bash", "edit", "write", "record", "recall"];
			expect(toolSurfaceErrors("matched", base)).toEqual([]);
			expect(toolSurfaceErrors("matched", [...base, "subagents_enable"])).toEqual([]);
			expect(toolSurfaceErrors("matched", [...base, "subagent"])).toEqual(["matched arm exposes subagent eagerly instead of through subagents_enable"]);
			expect(toolSurfaceErrors("matched", [...base, "pired_delegate"])).toEqual(["matched arm exposes pired_delegate, which pired hides"]);
			expect(toolSurfaceErrors("matched", ["read"])).toContain("matched arm does not expose record");
		});

		it("fails a matched session that launched a worker, since its scope turned delegation off", async () => {
			const dir = await mkdtemp(join(tmpdir(), "pired-matched-"));
			await mkdir(join(dir, "run-a", "run-0"), { recursive: true });
			await writeFile(join(dir, "run-a", "run-0", "session.jsonl"), "");
			const events = [{ type: "message_end", message: { role: "assistant", content: [], responseId: "p1", stopReason: "stop", timestamp: 1, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11 } } }];
			const account = await accountCellUsage(events, { arm: "matched", childSessionDir: dir }, { provider: "zai", model: "glm-5.3-flash", thinking: "medium" }, { subagentCalls: 0 });
			expect(account.errors.join("\n")).toMatch(/matched arm launched 0 worker\(s\) \(1 child session file\(s\)\); its scope states maxAgents 0/);
		});

		it("meters a session the ceiling cut and does not ask it to end on stop", async () => {
			const dir = await mkdtemp(join(tmpdir(), "pired-matched-"));
			const u = (n: number) => ({ input: n, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: n + 1 });
			const events = [
				{ type: "message_end", message: { role: "assistant", content: [], responseId: "p1", stopReason: "toolUse", timestamp: 1, usage: u(2000) } },
				{ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
			];
			const expectRun = { provider: "zai", model: "glm-5.3-flash", thinking: "medium" };
			const cut = await accountCellUsage(events, { arm: "matched", childSessionDir: dir }, expectRun, { subagentCalls: 0 }, undefined, { cut: true });
			expect(cut.errors).toEqual([]);
			expect(cut.usage.total.totalTokens).toBe(2001);
			const uncut = await accountCellUsage(events, { arm: "matched", childSessionDir: dir }, expectRun, { subagentCalls: 0 });
			expect(uncut.errors.join("\n")).toMatch(/stopReason=stop/);
		});

		it("labels a session the ceiling cut as budget", () => {
			const events = [{ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } }];
			const stop = runStop({ result: { exitCode: 0, signal: null, timedOut: false }, stoppedByRunner: false, events, telemetry: undefined, children: [], tokenCeiling: true });
			expect(stop).toMatchObject({ outcome: "budget", evidence: ["token ceiling"] });
		});

		it("reads the entry's ceiling line only when the cell had a ceiling, and requires it when the entry ran to its end", () => {
			const line = { type: "benchmark_token_ceiling", ceiling: 3000, metered: 3100, requests: 7, reached: true, reachedAtRequest: 7, reachedOn: "toolUse", cut: true };
			const ok = { exitCode: 0, timedOut: false };
			const errors: string[] = [];
			expect(ceilingOf([line], { tokenCeiling: 3000 }, ok, errors)).toEqual({ ceiling: 3000, metered: 3100, requests: 7, reached: true, reachedAtRequest: 7, reachedOn: "toolUse", cut: true });
			expect(errors).toEqual([]);
			const check = (events: Record<string, unknown>[], cell: { tokenCeiling?: number }, result = ok): string[] => {
				const found: string[] = [];
				ceilingOf(events, cell, result, found);
				return found;
			};
			expect(check([], {})).toEqual([]);
			expect(check([line], {})).toEqual(["a run without a token ceiling reported one"]);
			expect(check([], { tokenCeiling: 3000 })).toEqual(["the entry did not report its token ceiling"]);
			expect(check([], { tokenCeiling: 3000 }, { exitCode: null as unknown as number, timedOut: true })).toEqual([]);
			expect(check([line, line], { tokenCeiling: 3000 })).toEqual(["expected one token ceiling line, found 2"]);
			expect(check([line], { tokenCeiling: 2999 })).toEqual(["the entry ran under a token ceiling of 3000, not the cell's 2999"]);
		});
	});

	describe("the ceiling, verified against the transcript", () => {
		const msg = (tokens: number, stopReason = "toolUse") => ({ type: "message_end", message: { role: "assistant", stopReason, usage: { totalTokens: tokens } } });
		const dropped = { type: "message_end", message: { role: "assistant", stopReason: "error", content: [], usage: { totalTokens: 0 } } };
		const line = { ceiling: 1000, metered: 1200, requests: 2, reached: true, reachedAtRequest: 2 };

		it("accepts a transcript whose metered requests match the entry's line and stop at the crossing one", () => {
			expect(verifyCeiling([msg(600), { type: "tool_execution_end" }, msg(600), dropped], line, 1200)).toEqual([]);
			// A compaction the ceiling aborted at its start sent no request.
			expect(verifyCeiling([msg(600), msg(600), { type: "compaction_end", aborted: true }, dropped], line, 1200)).toEqual([]);
			expect(verifyCeiling([msg(300, "stop")], { ceiling: 1000, metered: 300, requests: 1, reached: false, reachedAtRequest: null }, 300)).toEqual([]);
		});

		it("makes the session invalid when the entry's line, the transcript and the accounting disagree", () => {
			expect(verifyCeiling([msg(600), msg(600)], { ...line, metered: 1100 }, 1200)).toEqual([expect.stringMatching(/meters 1200 tokens over 2 request\(s\); the entry's ceiling line says 1100 over 2/)]);
			expect(verifyCeiling([msg(600), msg(600)], line, 1300)).toEqual(["the accounting's parent total 1300 is not the 1200 tokens the ceiling metered"]);
			expect(verifyCeiling([msg(600), msg(600)], { ...line, reachedAtRequest: 1 }, 1200)).toEqual([expect.stringMatching(/reaches the ceiling at request 2; the entry's line says 1/)]);
		});

		it("makes the session invalid when a metered request followed the crossing one, or a compaction was aborted before it", () => {
			expect(verifyCeiling([msg(600), msg(600), msg(50)], { ...line, metered: 1250, requests: 3 }, 1250)).toEqual(["1 metered request(s) followed the one that reached the token ceiling"]);
			expect(verifyCeiling([msg(600), { type: "compaction_end", aborted: true }, msg(600)], line, 1200)).toEqual(["1 compaction(s) were aborted before the token ceiling was reached"]);
		});
	});

	describe("the preflight's ceiling probe", () => {
		const good = {
			requests: 1, line: { ceiling: 1, metered: 5000, requests: 1, reached: true, reachedAtRequest: 1, reachedOn: "toolUse", cut: true },
			ceilingErrors: [], accountingErrors: [], recorded: 1, recordedAfter: 0, stopOutcome: "budget",
		};

		it("passes when the crossing reply's record landed once, after one request, with a budget stop", () => {
			expect(ceilingProbeErrors(good)).toEqual([]);
		});

		it("fails when the abort came before the turn's tools, as an abort at message_end did", () => {
			expect(ceilingProbeErrors({ ...good, recorded: 0 })).toEqual([expect.stringMatching(/reached the ledger 0 time\(s\), not once: the abort did not wait for the turn's tools/)]);
		});

		it("fails when the model was asked twice, the accounting refused the cut, or the stop read as anything but budget", () => {
			expect(ceilingProbeErrors({ ...good, requests: 2, recordedAfter: 1, stopOutcome: "error", accountingErrors: ["parent did not finish"] })).toEqual([
				expect.stringMatching(/asked 2 time\(s\)/), "accounting: parent did not finish", "a request after the ceiling recorded to the ledger", expect.stringMatching(/as error, not budget/),
			]);
			expect(ceilingProbeErrors({ ...good, line: undefined })).toContain("the entry's ceiling line does not report a cut at the first request");
		});
	});

	describe("the pair loop", () => {
		// A scripted grid: every launch takes ten minutes of a fake clock; a matched
		// session's outcome carries its spec, as runOne's record does, and by
		// default spends 100 tokens past its ceiling.
		type Kind = "valid" | "drop" | "broken";
		const outcome = (pair: ScheduledPair, arm: Arm, attempt: number, kind: Kind, tokens: number, session?: MatchedSessionSpec): RunOutcome => {
			const valid = kind === "valid";
			return {
				metric: { key: pair.key, target: pair.target, pass: pair.pass, valid, truePositives: valid ? 1 : 0, precision: valid ? 0.5 : 0, totalClaims: valid ? 2 : 0, totalTokens: valid ? tokens : Number.NaN },
				arm, cellId: `${pair.key}-${arm}-${attempt}${session ? `-s${session.index}.${session.sessionAttempt}` : ""}`, seconds: 600, infraFailure: kind === "drop",
				record: { key: pair.key, target: pair.target, pass: pair.pass, arm, attempt, valid, infraFailure: kind === "drop", ...(session ? { matchedSession: session } : {}) },
			};
		};
		const grid = (script: (key: string, arm: Arm, session?: MatchedSessionSpec) => Kind, opts: {
			breaker?: BreakerPolicy; policy?: MatchedPolicy; official?: boolean; resume?: SessionState[];
			spend?: (session: MatchedSessionSpec) => number; failMatchedSettle?: boolean;
		} = {}) => {
			let clock = Date.UTC(2026, 8, 26, 12, 0);
			const launched: string[] = [];
			const specs: MatchedSessionSpec[] = [];
			const settled: RunOutcome[] = [];
			const lines: string[] = [];
			const state: GridStopState = { aborted: false, stopInvalid: false, stopReason: undefined, quotaExhausted: undefined };
			const policy = opts.policy ?? POLICY;
			const spend = opts.spend ?? ((session: MatchedSessionSpec) => session.ceiling + 100);
			const pairs = planSchedule(["A", "B"], 1);
			const run = () => runPairs({
				pairs: opts.resume ? [] : pairs, firstAttempt: () => 1, concurrency: 1, official: opts.official ?? false,
				...(opts.breaker ? { breaker: opts.breaker } : {}), state,
				launch: async (pair, arm, attempt) => {
					launched.push(`${pair.key} ${arm} ${attempt}`);
					clock += 10 * 60_000;
					return outcome(pair, arm, attempt, script(pair.key, arm), arm === "candidate" ? 9_000_002 : 4_000_000);
				},
				settle: async (o) => {
					if (opts.failMatchedSettle && o.arm === "matched") throw new Error("ENOSPC");
					settled.push(o);
				},
				report: async () => undefined,
				nowMs: () => clock,
				sleep: async (ms) => { clock += ms; },
				log: (line) => lines.push(line), warn: (line) => lines.push(line), out: "/grid",
				matched: {
					policy,
					budget: (pair, candidate) => sessionBudget(policy, pair.target, { valid: candidate.metric.valid, totalTokens: candidate.metric.totalTokens }),
					launch: async (pair, attempt, session) => {
						launched.push(`${pair.key} matched ${attempt} s${session.index}.${session.sessionAttempt}`);
						specs.push(session);
						clock += 10 * 60_000;
						return outcome(pair, "matched", attempt, script(pair.key, "matched", session), spend(session), session);
					},
					...(opts.resume ? { resume: [{ pair: pairs[0]!, attempt: 2, candidate: outcome(pairs[0]!, "candidate", 2, "valid", 6000), sessions: opts.resume }] } : {}),
				},
			});
			return { run, launched, specs, settled, lines, state };
		};
		const matchedOf = (g: { launched: string[] }, key: string) => g.launched.filter((l) => l.startsWith(`${key} matched`));

		it("follow mode runs the sessions after the pair's two arms, the first at the candidate's tokens over k", async () => {
			const g = grid(() => "valid");
			const result = await g.run();
			expect(g.launched.slice(0, 5)).toEqual(["A#1 baseline 1", "A#1 candidate 1", "A#1 matched 1 s1.1", "A#1 matched 1 s2.1", "A#1 matched 1 s3.1"]);
			expect(g.specs[0]).toEqual({ index: 1, k: 3, kMax: 6, sessionAttempt: 1, budget: 9_000_002, ceiling: 3_000_000, spentBefore: 0, budgetSource: "candidate", candidateCellId: "A#1-candidate-1" });
			// Each session ran 100 past its ceiling, so the next splits what is left: nothing is left after three.
			expect(g.specs.slice(0, 3).map((s) => [s.ceiling, s.spentBefore])).toEqual([[3_000_000, 0], [2_999_951, 3_000_100], [2_999_851, 6_000_151]]);
			expect(g.settled.filter((o) => o.arm === "matched")).toHaveLength(6);
			expect(result.matched).toEqual({ skipped: [], requeued: [], gaveUp: [], blocked: [], abandoned: [] });
		});

		it("rolls unspent budget over, and runs extra sessions with what is left up to kMax", async () => {
			// Every session stops on its own after 1,000 tokens, as a Luna run that offers to continue does.
			const g = grid(() => "valid", { spend: () => 1000 });
			await g.run();
			expect(matchedOf(g, "A#1")).toHaveLength(6);
			expect(g.specs.slice(0, 6).map((s) => s.ceiling)).toEqual([3_000_000, 4_499_501, 8_998_002, 8_997_002, 8_996_002, 8_995_002]);
		});

		it("starts no extra session once less than the floor of B is left", async () => {
			// Each spends 200 under its ceiling; 200 tokens are left after three, under 5% of B.
			const g = grid(() => "valid", { spend: (s) => s.ceiling - 200 });
			await g.run();
			expect(matchedOf(g, "A#1")).toHaveLength(3);
			expect(g.specs.slice(0, 3).map((s) => s.ceiling)).toEqual([3_000_000, 3_000_101, 3_000_301]);
		});

		it("runs no matched session after a pair that is not valid at its attempt", async () => {
			let dropped = false;
			const g = grid((key, arm) => {
				if (key === "A#1" && arm === "baseline" && !dropped) { dropped = true; return "drop"; }
				return "valid";
			}, { breaker: DEFAULT_BREAKER });
			await g.run();
			expect(g.launched.filter((l) => l.startsWith("A#1 matched 1"))).toEqual([]);
			// The re-queued pair takes its matched sessions with it.
			expect(g.launched.filter((l) => l.startsWith("A#1 matched 2"))).toHaveLength(3);
		});

		it("re-runs a failed session on its own, with its index's original ceiling, and keeps the others", async () => {
			let dropped = false;
			const g = grid((key, arm, session) => {
				if (arm === "matched" && key === "A#1" && session?.index === 2 && !dropped) { dropped = true; return "drop"; }
				return "valid";
			}, { breaker: DEFAULT_BREAKER });
			const result = await g.run();
			expect(matchedOf(g, "A#1")).toEqual(["A#1 matched 1 s1.1", "A#1 matched 1 s2.1", "A#1 matched 1 s2.2", "A#1 matched 1 s3.1"]);
			const second = g.specs.filter((s) => s.index === 2).slice(0, 2);
			expect(second.map((s) => [s.sessionAttempt, s.ceiling, s.spentBefore])).toEqual([[1, 2_999_951, 3_000_100], [2, 2_999_951, 3_000_100]]);
			expect(result.matched?.requeued).toEqual([{ session: "A#1/2", sessionAttempt: 2, notBefore: expect.any(String), reason: expect.stringMatching(/infrastructure/) }]);
			// The pair itself is not re-run: its two arms stay as they were.
			expect(g.launched.filter((l) => l.startsWith("A#1 baseline"))).toEqual(["A#1 baseline 1"]);
		});

		it("does not trip an official grid at once on a matched session's own failure, which leaves the gate open", async () => {
			const g = grid((key, arm, session) => arm === "matched" && key === "A#1" && session?.index === 1 ? "broken" : "valid", { breaker: DEFAULT_BREAKER, official: true });
			const result = await g.run();
			expect(g.state.stopInvalid).toBe(false);
			expect(result.matched?.blocked).toEqual([{ session: "A#1/1", sessionAttempt: 1, reason: expect.stringMatching(/the session is invalid for a non-infrastructure reason/) }]);
			// The arm cannot be valid for that pair, so its other sessions are not spent; the next pair runs.
			expect(matchedOf(g, "A#1")).toEqual(["A#1 matched 1 s1.1"]);
			expect(matchedOf(g, "B#1")).toHaveLength(3);
		});

		it("without a breaker a failed session stops the grid, marked as the matched arm's stop", async () => {
			const g = grid((key, arm) => arm === "matched" && key === "A#1" ? "drop" : "valid");
			await g.run();
			expect(g.state).toMatchObject({ stopInvalid: true, stoppedBy: "matched" });
			expect(g.launched.some((l) => l.startsWith("B#1"))).toBe(false);
		});

		it("withholds approval on a matched session's lost record, as on any harness-integrity failure", async () => {
			const g = grid(() => "valid", { failMatchedSettle: true });
			await g.run();
			expect(g.state.stopInvalid).toBe(true);
			expect(g.state.stopReason).toMatch(/bookkeeping write failed: ENOSPC/);
			expect(g.state.stoppedBy).toBeUndefined();
		});

		it("skips the arm, with the reason, when the budget cannot be set", async () => {
			const g = grid(() => "valid", { policy: { mode: "fixed", k: 3, kMax: 6, floorShare: 0.05, budgets: { B: 6000 } } });
			const result = await g.run();
			expect(result.matched?.skipped).toEqual([{ key: "A#1", attempt: 1, reason: "no pre-registered budget for A" }]);
			expect(g.specs.map((s) => [s.budget, s.ceiling, s.budgetSource])).toEqual([[6000, 2000, "fixed"], [6000, 1950, "fixed"], [6000, 1850, "fixed"]]);
		});

		it("a resume runs only a kept pair's owed session, at the ceiling its index first had", async () => {
			const g = grid(() => "valid", {
				resume: [
					{ index: 1, attempt: 1, valid: true, infra: false, tokens: 2000, ceiling: 2000 },
					{ index: 2, attempt: 1, valid: false, infra: true, tokens: Number.NaN, ceiling: 2000 },
					{ index: 3, attempt: 1, valid: true, infra: false, tokens: 2000, ceiling: 2000 },
				],
			});
			await g.run();
			expect(g.launched).toEqual(["A#1 matched 2 s2.2"]);
			expect(g.specs).toEqual([{ index: 2, k: 3, kMax: 6, sessionAttempt: 2, budget: 6000, ceiling: 2000, spentBefore: 2000, budgetSource: "candidate", candidateCellId: "A#1-candidate-2" }]);
		});

		it("without the matched loop the pair loop's result carries no matched block", async () => {
			const state: GridStopState = { aborted: false, stopInvalid: false, stopReason: undefined, quotaExhausted: undefined };
			const launched: string[] = [];
			const result = await runPairs({
				pairs: planSchedule(["A"], 1), firstAttempt: () => 1, concurrency: 1, official: false, state,
				launch: async (pair, arm, attempt) => { launched.push(arm); return outcome(pair, arm, attempt, "valid", 1000); },
				settle: async () => undefined, report: async () => undefined, nowMs: () => 0, sleep: async () => undefined,
				log: () => undefined, warn: () => undefined, out: "/grid",
			});
			expect("matched" in result).toBe(false);
			expect(launched).toEqual(["baseline", "candidate"]);
			expect("stoppedBy" in state).toBe(false);
		});
	});

	describe("resume and union bookkeeping", () => {
		it("reads each session at its own highest attempt within the pair's attempt, last row winning a tie", () => {
			const rows = [
				sessionRecord("A#1", 1, 1, 1, true),
				sessionRecord("A#1", 2, 1, 1, false),
				sessionRecord("A#1", 2, 1, 2, true, { cellId: "first" }),
				sessionRecord("A#1", 2, 1, 2, true, { cellId: "second" }),
				sessionRecord("A#1", 2, 3, 1, true),
				{ key: "A#1", arm: "candidate", attempt: 2, valid: true },
			];
			expect(latestMatchedSessions(rows, "A#1", 2).map((r) => [r.cellId, (r.matchedSession as { index: number }).index])).toEqual([["second", 1], ["m-A#1-3-1", 3]]);
		});

		it("resumes a kept pair that owes a session, and spends nothing on one whose session is blocked", () => {
			const candidate = (key: string, attempt: number) => ({ key, target: key.split("#")[0], arm: "candidate", attempt, valid: true, cellId: `c-${key}`, totalTokens: 9000 });
			const plan = { keepKeys: ["A#1", "B#1", "C#1", "D#1"], latest: {
				"A#1\u0000candidate": candidate("A#1", 2), "B#1\u0000candidate": candidate("B#1", 1),
				"C#1\u0000candidate": candidate("C#1", 1), "D#1\u0000candidate": candidate("D#1", 1),
			} };
			const runs = [
				// A: session 2 dropped for infrastructure; it is owed.
				sessionRecord("A#1", 2, 1, 1, true), sessionRecord("A#1", 2, 2, 1, false),
				// B: session 1 invalid on its own terms, sessions 2 and 3 valid.
				sessionRecord("B#1", 1, 1, 1, false, { infraFailure: false }), sessionRecord("B#1", 1, 2, 1, true), sessionRecord("B#1", 1, 3, 1, true),
				// C: session 1 invalid on its own terms, sessions 2 and 3 never ran (review): nothing more is spent.
				sessionRecord("C#1", 1, 1, 1, false, { infraFailure: false }),
				// D: three sessions spent all of B.
				...[1, 2, 3].map((i) => sessionRecord("D#1", 1, i, 1, true, { totalTokens: 3000 })),
			];
			const planned = planMatchedResume(plan, runs, POLICY, 16);
			expect(planned.resume).toEqual([{
				key: "A#1", attempt: 2, candidate: plan.latest["A#1\u0000candidate"],
				sessions: [
					{ index: 1, attempt: 1, valid: true, infra: false, tokens: 3100, ceiling: 3000 },
					{ index: 2, attempt: 1, valid: false, infra: true, tokens: Number.NaN, ceiling: 3000 },
				],
			}]);
			expect(planned.blocked).toEqual([
				{ session: "B#1/1", reason: expect.stringMatching(/non-infrastructure/) },
				{ session: "C#1/1", reason: expect.stringMatching(/non-infrastructure/) },
			]);
			expect(planned.abandoned).toEqual([]);
			expect(planned.skipped).toEqual([]);
		});

		it("reads a session record as the union needs it, with the gate's tokens and its ceiling", () => {
			const record = sessionRecord("A#1", 1, 2, 3, true, { totalTokensWithRetryEstimate: 3300, stop: { outcome: "budget" } });
			expect(sessionRunOf(record, [])).toEqual({ index: 2, attempt: 3, cellId: "m-A#1-2-3", valid: true, infra: false, ceiling: 3000, totalTokens: 3300, truePositives: 1, claims: 2, stop: "budget", findings: [] });
			expect(sessionRunOf(sessionRecord("A#1", 1, 1, 1, false))).toMatchObject({ valid: false, infra: true, stop: null, claims: 0 });
		});
	});
});
