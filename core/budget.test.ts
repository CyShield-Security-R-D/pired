import { describe, expect, it } from "vitest";
import { parseBudget } from "./budget.ts";
import type { EngagementScope } from "./ontology.ts";

function scope(budget?: unknown): EngagementScope {
	return { v: 1, engagement: "acme", authorized: true, mode: "enforce", targets: {}, ...(budget === undefined ? {} : { budget: budget as EngagementScope["budget"] }) };
}

describe("parseBudget", () => {
	it("reads no budget from a scope that states none, which is every scope written before it existed", () => {
		// Absent means no budget line at all: the default has to stay what every
		// measurement so far was taken against.
		expect(parseBudget(undefined)).toBeUndefined();
		expect(parseBudget(scope())).toBeUndefined();
		expect(parseBudget(scope({}))).toBeUndefined();
	});

	it("keeps whole, non-negative ceilings as stated", () => {
		expect(parseBudget(scope({ tokens: 20_000_000, minutes: 240 }))).toEqual({ tokens: 20_000_000, minutes: 240 });
		expect(parseBudget(scope({ minutes: 0 }))).toEqual({ minutes: 0 });
	});

	it("drops a ceiling that is not a whole count and keeps the one that is, rather than stating a guess", () => {
		// A ceiling the model is told is one something enforces; a misread one
		// would be stated to it as fact.
		expect(parseBudget(scope({ tokens: -5, minutes: 90 }))).toEqual({ minutes: 90 });
		expect(parseBudget(scope({ tokens: 1_000_000, minutes: "240" }))).toEqual({ tokens: 1_000_000 });
		expect(parseBudget(scope({ tokens: 2.5, minutes: Number.NaN }))).toBeUndefined();
		for (const bad of [null, 5, "20M", [1, 2]]) expect(parseBudget(scope(bad)), JSON.stringify(bad)).toBeUndefined();
	});
});
