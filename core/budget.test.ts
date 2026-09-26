import { describe, expect, it } from "vitest";
import { budgetState, formatTokens, parseBudget, renderBudgetLine } from "./budget.ts";
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

function reading(ceiling: { tokens?: number; minutes?: number }, spent: { tokens?: number; minutes?: number }) {
	return { ceiling, spent };
}

describe("budgetState", () => {
	it("reports nothing when the reading states no ceiling, whatever was spent", () => {
		expect(budgetState(undefined)).toBeUndefined();
		expect(budgetState(reading({}, { tokens: 5_000_000, minutes: 30 }))).toBeUndefined();
	});

	it("states used and remaining for each stated unit, and lets the most-used unit set the level", () => {
		// Out of time with tokens to spare is out of time.
		const state = budgetState(reading({ tokens: 20_000_000, minutes: 240 }, { tokens: 2_000_000, minutes: 200 }));
		expect(state?.tokens).toEqual({ ceiling: 20_000_000, spent: 2_000_000, remaining: 18_000_000, fraction: 0.1 });
		expect(state?.minutes?.remaining).toBe(40);
		expect(state?.level).toBe("late");
	});

	it("reads a zero ceiling as wholly used and a missing or negative spend as nothing spent", () => {
		expect(budgetState(reading({ minutes: 0 }, {}))?.level).toBe("spent");
		expect(budgetState(reading({ tokens: 100 }, { tokens: -5 }))?.tokens).toMatchObject({ spent: 0, remaining: 100, fraction: 0 });
		expect(budgetState(reading({ tokens: 100 }, { tokens: 250 }))?.tokens?.remaining).toBe(0);
	});
});

describe("formatTokens", () => {
	it("floors a count into the units a reader skims, never rounding up to the ceiling", () => {
		expect(formatTokens(6_149_000)).toBe("6.1M");
		expect(formatTokens(20_000_000)).toBe("20M");
		expect(formatTokens(19_990_000)).toBe("19.9M");
		expect(formatTokens(143_800_000)).toBe("143M");
		expect(formatTokens(999_999)).toBe("999k");
		expect(formatTokens(3_450)).toBe("3.4k");
		expect(formatTokens(512)).toBe("512");
	});
});

describe("renderBudgetLine", () => {
	it("renders no budget line when the scope sets none, so an engagement without one reads exactly as before", () => {
		expect(renderBudgetLine(undefined)).toBe("");
		expect(renderBudgetLine(reading({}, { tokens: 1 }))).toBe("");
	});

	it("states used and remaining against the ceiling and calls it a ceiling, not a target", () => {
		const line = renderBudgetLine(reading({ tokens: 20_000_000, minutes: 240 }, { tokens: 6_100_000, minutes: 52.7 }));
		expect(line).toBe("Budget: 6.1M of 20M tokens · 52 of 240 min — a ceiling, not a target.");
		// Either unit may be absent: the line names only what the scope stated.
		expect(renderBudgetLine(reading({ minutes: 90 }, { tokens: 9_000_000, minutes: 10 }))).toBe("Budget: 10 of 90 min — a ceiling, not a target.");
		expect(renderBudgetLine(reading({ tokens: 2_500_000 }, {}))).toBe("Budget: 0 of 2.5M tokens — a ceiling, not a target.");
	});

	it("switches wording at 80% to recording what is established, and at the ceiling to settling", () => {
		const early = renderBudgetLine(reading({ minutes: 100 }, { minutes: 79 }));
		expect(early).not.toMatch(/record what is established|settle/);
		const late = renderBudgetLine(reading({ minutes: 100 }, { minutes: 80 }));
		expect(late).toContain("a ceiling, not a target.");
		expect(late).toContain("80% is used: record what is established.");
		expect(late).not.toContain("settle");
		const spent = renderBudgetLine(reading({ tokens: 1_000_000, minutes: 100 }, { tokens: 1_000_000, minutes: 5 }));
		expect(spent).toContain("The ceiling is reached: settle (`record kind=settle`)");
		expect(spent).not.toContain("record what is established");
	});
});
