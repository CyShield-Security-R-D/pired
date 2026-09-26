import { describe, expect, it } from "vitest";
import { BENCHMARK_SETTINGS, benchmarkSettings, DEFAULT_RETRY_POLICY, fetchHost, tokenCeilingMeter, validateRetryPolicy, watchTokenCeiling } from "./delegation-compare-entry.ts";

const policy = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...DEFAULT_RETRY_POLICY, ...over });

describe("benchmarkSettings", () => {
	it("returns the v5 settings object itself without a policy, so an old cell's settings.json hash cannot move", () => {
		expect(benchmarkSettings()).toBe(BENCHMARK_SETTINGS);
	});

	it("turns pi's agent retry on and pins transport retries at 0 under a policy", () => {
		expect(benchmarkSettings(DEFAULT_RETRY_POLICY)).toEqual({
			packages: [], compaction: { enabled: true }, cacheWarming: "off",
			retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 30_000, provider: { maxRetries: 0 } },
		});
		// The frozen v5 object is untouched.
		expect(BENCHMARK_SETTINGS.retry).toEqual({ enabled: false });
	});
});

describe("validateRetryPolicy", () => {
	it("accepts the v6 default", () => {
		expect(validateRetryPolicy(policy())).toEqual(DEFAULT_RETRY_POLICY);
	});

	it("refuses transport retries, which pi runs silently and reports no usage for", () => {
		expect(() => validateRetryPolicy(policy({ providerMaxRetries: 2 }))).toThrow(/transport retries/);
	});

	it("refuses a disabled policy, since an absent policy is how retries stay off", () => {
		expect(() => validateRetryPolicy(policy({ enabled: false }))).toThrow(/leave retryPolicy out/);
	});

	it("refuses a policy with no run-wide cap on failed attempts", () => {
		expect(() => validateRetryPolicy(policy({ maxFailedAttempts: 0 }))).toThrow(/maxFailedAttempts/);
		expect(() => validateRetryPolicy(policy({ maxRetries: 1.5 }))).toThrow(/maxRetries/);
		expect(() => validateRetryPolicy(policy({ baseDelayMs: -1 }))).toThrow(/baseDelayMs/);
		expect(() => validateRetryPolicy(policy({ maxFailedAttemptRate: 1.5 }))).toThrow(/maxFailedAttemptRate/);
		expect(() => validateRetryPolicy(policy({ maxFailedAttemptRate: undefined }))).toThrow(/maxFailedAttemptRate/);
		expect(() => validateRetryPolicy(null)).toThrow(/object/);
	});
});

describe("fetchHost", () => {
	it("logs the host of a provider call and never its path or query", () => {
		expect(fetchHost("https://API.example.com:8443/v1/acct-123/chat?key=secret")).toBe("api.example.com:8443");
		expect(fetchHost(new URL("https://api.example.com/x"))).toBe("api.example.com");
		expect(fetchHost({ url: "https://api.example.com/y" })).toBe("api.example.com");
		expect(fetchHost("not a url")).toBeUndefined();
	});
});

const reply = (totalTokens: number, stopReason = "toolUse") => ({ type: "message_end", message: { role: "assistant", stopReason, usage: { totalTokens } } });

describe("tokenCeilingMeter", () => {
	it("answers true once, on the reply whose cumulative metered usage first reaches the ceiling", () => {
		const meter = tokenCeilingMeter(1000);
		expect(meter.observe(reply(400))).toBe(false);
		expect(meter.observe(reply(599))).toBe(false);
		expect(meter.observe(reply(1))).toBe(true);
		// A reply already in flight when the abort landed is still metered, and never re-triggers.
		expect(meter.observe(reply(250))).toBe(false);
		expect(meter.state).toEqual({ ceiling: 1000, metered: 1250, requests: 4, reached: true, reachedAtRequest: 3, reachedOn: "toolUse", cut: true });
	});

	it("meters compactions and ignores user and tool messages, which cost nothing", () => {
		const meter = tokenCeilingMeter(500);
		expect(meter.observe({ type: "message_end", message: { role: "user", usage: { totalTokens: 9999 } } })).toBe(false);
		expect(meter.observe({ type: "message_end", message: { role: "toolResult", usage: { totalTokens: 9999 } } })).toBe(false);
		expect(meter.observe({ type: "compaction_end", result: { usage: { totalTokens: 300 } } })).toBe(false);
		expect(meter.observe({ type: "compaction_end", aborted: true })).toBe(false);
		expect(meter.observe({ type: "tool_execution_end" })).toBe(false);
		expect(meter.observe(reply(200))).toBe(true);
		expect(meter.state.requests).toBe(2);
	});

	it("says the ceiling did not cut a run whose reaching reply already ended it", () => {
		const meter = tokenCeilingMeter(100);
		expect(meter.observe(reply(150, "stop"))).toBe(true);
		expect(meter.state).toMatchObject({ reached: true, reachedOn: "stop", cut: false });
	});
});

describe("watchTokenCeiling", () => {
	// A fake session that logs what the watcher does between the events it is sent.
	const fakeSession = () => {
		const listeners: Array<(event: unknown) => void> = [];
		const log: string[] = [];
		const session = {
			subscribe(listener: (event: unknown) => void) { listeners.push(listener); return () => { listeners.length = 0; }; },
			abort: async () => { log.push("abort"); },
			abortCompaction: () => { log.push("abort compaction"); },
		};
		const emit = (event: unknown, label: string) => { log.push(label); for (const l of [...listeners]) l(event); };
		return { session, emit, log, listeners };
	};
	const recordCall = { type: "toolCall", id: "t1", name: "record", arguments: { kind: "endpoint", path: "/login" } };
	const crossing = { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [recordCall], usage: { totalTokens: 600 } } };

	it("lets the crossing reply's record call run, and aborts at that turn's end, before the next request", () => {
		const f = fakeSession();
		const watch = watchTokenCeiling(f.session, 1000);
		f.emit(reply(600), "reply 1");
		f.emit({ type: "turn_end" }, "turn 1 end");
		f.emit(crossing, "reply 2 (crosses, calls record)");
		f.emit({ type: "tool_execution_start", toolName: "record" }, "record runs");
		f.emit({ type: "tool_execution_end", toolName: "record", isError: false }, "record lands");
		f.emit({ type: "turn_end" }, "turn 2 end");
		f.emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [], usage: { totalTokens: 0 } } }, "request 3 never sent");
		// The abort comes after the record call finished, never between the reply and its tools.
		expect(f.log).toEqual(["reply 1", "turn 1 end", "reply 2 (crosses, calls record)", "record runs", "record lands", "turn 2 end", "abort", "request 3 never sent"]);
		// The empty reply of the request never sent is not a metered request.
		expect(watch.state).toMatchObject({ metered: 1200, requests: 2, reachedAtRequest: 2, cut: true });
		watch.stop();
		expect(f.listeners).toHaveLength(0);
	});

	it("aborts at once when a compaction reaches the ceiling, and aborts any compaction that starts after it", () => {
		const f = fakeSession();
		watchTokenCeiling(f.session, 1000);
		f.emit(reply(900), "reply 1");
		f.emit({ type: "compaction_start", reason: "threshold" }, "compaction 1 starts");
		f.emit({ type: "compaction_end", result: { usage: { totalTokens: 200 } } }, "compaction 1 ends (crosses)");
		f.emit({ type: "compaction_start", reason: "threshold" }, "compaction 2 starts");
		expect(f.log).toEqual(["reply 1", "compaction 1 starts", "compaction 1 ends (crosses)", "abort", "compaction 2 starts", "abort compaction"]);
	});

	it("never aborts a session that stays under its ceiling, nor a compaction before it", () => {
		const f = fakeSession();
		watchTokenCeiling(f.session, 10_000);
		for (let i = 0; i < 5; i++) { f.emit(reply(1000), `reply ${i}`); f.emit({ type: "turn_end" }, "turn end"); }
		f.emit({ type: "compaction_start" }, "compaction starts");
		f.emit(reply(1000, "stop"), "last reply");
		f.emit({ type: "turn_end" }, "turn end");
		expect(f.log.filter((l) => l.startsWith("abort"))).toEqual([]);
	});
});
