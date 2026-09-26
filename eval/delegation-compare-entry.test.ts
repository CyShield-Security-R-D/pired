import { describe, expect, it } from "vitest";
import { BENCHMARK_SETTINGS, benchmarkSettings, DEFAULT_RETRY_POLICY, fetchHost, validateRetryPolicy } from "./delegation-compare-entry.ts";

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
