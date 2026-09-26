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
	it("aborts between requests: once, right after the reaching reply ends, so no request is left unmetered", () => {
		const listeners: Array<(event: unknown) => void> = [];
		const log: string[] = [];
		const session = {
			subscribe(listener: (event: unknown) => void) { listeners.push(listener); return () => { listeners.length = 0; }; },
			abort: async () => { log.push("abort"); },
		};
		const watch = watchTokenCeiling(session, 1000);
		const emit = (event: unknown, label: string) => { log.push(label); for (const l of [...listeners]) l(event); };
		emit(reply(600), "reply 1");
		emit({ type: "tool_execution_end" }, "tool 1");
		emit(reply(600), "reply 2");
		emit({ type: "message_end", message: { role: "assistant", stopReason: "error", usage: { totalTokens: 0 } } }, "aborted before request");
		expect(log).toEqual(["reply 1", "tool 1", "reply 2", "abort", "aborted before request"]);
		expect(watch.state).toMatchObject({ metered: 1200, requests: 3, reachedAtRequest: 2, cut: true });
		watch.stop();
		expect(listeners).toHaveLength(0);
	});

	it("never aborts a session that stays under its ceiling", () => {
		let aborted = 0;
		let listener: ((event: unknown) => void) | undefined;
		watchTokenCeiling({ subscribe: (l) => { listener = l; return () => undefined; }, abort: async () => { aborted++; } }, 10_000);
		for (let i = 0; i < 5; i++) listener?.(reply(1000));
		listener?.(reply(1000, "stop"));
		expect(aborted).toBe(0);
	});
});
