import { describe, expect, it } from "vitest";
import { budgetState, formatTokens, parseBudget, renderBudgetLine, SpendMeter, subagentTokens, usageTokens } from "./budget.ts";
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

	it("states used and remaining for each unit, minutes rounded so used and left sum to the ceiling", () => {
		const line = renderBudgetLine(reading({ tokens: 20_000_000, minutes: 45 }, { tokens: 6_100_000, minutes: 11.2 }));
		expect(line).toBe("Budget: 12 of 45 min used, 33 left · 6.1M of 20M tokens used, 13.9M left.");
		// Either unit may be absent: the line names only what the scope stated.
		expect(renderBudgetLine(reading({ minutes: 90 }, { tokens: 9_000_000, minutes: 10 }))).toBe("Budget: 10 of 90 min used, 80 left.");
		expect(renderBudgetLine(reading({ tokens: 2_500_000 }, {}))).toBe("Budget: 0 of 2.5M tokens used, 2.5M left.");
	});

	it("switches wording at 80% to recording what is established, and at the ceiling to settling", () => {
		const early = renderBudgetLine(reading({ minutes: 100 }, { minutes: 79 }));
		// Under 80% the numbers alone: "a ceiling, not a target" said on every
		// request from the start would be the budget talked about, not stated.
		expect(early).toBe("Budget: 79 of 100 min used, 21 left.");
		const late = renderBudgetLine(reading({ minutes: 100 }, { minutes: 80 }));
		expect(late).toContain("a ceiling, not a target.");
		expect(late).toContain("80% is used: record what is established.");
		expect(late).not.toContain("settle");
		const spent = renderBudgetLine(reading({ tokens: 1_000_000, minutes: 100 }, { tokens: 1_000_000, minutes: 5 }));
		expect(spent).toContain("a ceiling, not a target. The ceiling is reached: settle (`record kind=settle`)");
		expect(spent).not.toContain("record what is established");
	});

	it("says the session settled instead of asking it to settle again, once it has and has done no work since", () => {
		const line = renderBudgetLine(reading({ minutes: 100 }, { minutes: 130 }), "paused");
		expect(line).toBe("Budget: 100 of 100 min used, 0 left — a ceiling, not a target. The ceiling is reached; settled: paused.");
		// Below the ceiling nothing asks for a settle, so there is nothing to replace.
		expect(renderBudgetLine(reading({ minutes: 100 }, { minutes: 85 }), "paused")).toContain("85% is used: record what is established.");
	});
});

describe("counting spend", () => {
	it("reads a call's tokens from pi's total, or from the parts when a child reports no total", () => {
		expect(usageTokens({ input: 10, output: 5, cacheRead: 100, cacheWrite: 1, totalTokens: 116 })).toBe(116);
		// pi-subagents' child usage has no totalTokens.
		expect(usageTokens({ input: 10, output: 5, cacheRead: 100, cacheWrite: 1, cost: 0.2, turns: 3 })).toBe(116);
		for (const bad of [undefined, null, "12", { input: "10" }, { totalTokens: Number.NaN, output: -4 }]) expect(usageTokens(bad)).toBe(0);
	});

	it("sums the workers of one subagent call and reads nothing from a result that lists none", () => {
		const result = { content: [], details: { results: [{ usage: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0 } }, { usage: { totalTokens: 50 } }, {}, null] } };
		expect(subagentTokens(result)).toBe(1_250);
		expect(subagentTokens({ details: {} })).toBe(0);
		expect(subagentTokens(undefined)).toBe(0);
	});

	it("counts parent, worker and scribe tokens, a repeated tool end once, and minutes from the session's start", () => {
		const meter = new SpendMeter(1_000);
		meter.add("parent", 4_000_000);
		meter.once("call-1", "worker", 2_000_000);
		meter.once("call-1", "worker", 2_000_000);
		meter.add("scribe", 100_000);
		meter.add("parent", -5);
		expect(meter.tokens("parent")).toBe(4_000_000);
		expect(meter.tokens("worker")).toBe(2_000_000);
		expect(meter.tokens()).toBe(6_100_000);
		expect(meter.minutes(1_000 + 52 * 60_000)).toBe(52);
		expect(meter.minutes(0)).toBe(0);
		expect(meter.reading(undefined, 5_000)).toBeUndefined();
		const reading = meter.reading({ tokens: 20_000_000, minutes: 240 }, 1_000 + 52 * 60_000);
		expect(renderBudgetLine(reading)).toBe("Budget: 52 of 240 min used, 188 left · 6.1M of 20M tokens used, 13.9M left.");
	});
});

describe("a deadline the harness enforces (3.2 review)", () => {
	it("keeps a valid ISO deadline and drops one it cannot read", () => {
		expect(parseBudget(scope({ minutes: 120, deadline: "2026-09-26T12:00:00.000Z" }))).toEqual({ minutes: 120, deadline: "2026-09-26T12:00:00.000Z" });
		expect(parseBudget(scope({ deadline: "2026-09-26T12:00:00.000Z" }))).toEqual({ deadline: "2026-09-26T12:00:00.000Z" });
		expect(parseBudget(scope({ minutes: 5, deadline: "soon" }))).toEqual({ minutes: 5 });
	});

	it("reads minutes from the deadline, so a session that started late does not undercount the clock that stops it", () => {
		const deadline = Date.parse("2026-09-26T12:00:00.000Z");
		// pired's session started two minutes after the harness's timer.
		const meter = new SpendMeter(deadline - 118 * 60_000);
		const atStart = meter.reading({ minutes: 120, deadline: "2026-09-26T12:00:00.000Z" }, deadline - 118 * 60_000);
		expect(atStart?.spent.minutes).toBe(2);
		expect(meter.reading({ minutes: 120, deadline: "2026-09-26T12:00:00.000Z" }, deadline + 60_000)?.spent.minutes).toBe(120);
		// A deadline alone makes its own ceiling, from session start.
		const own = meter.reading({ deadline: "2026-09-26T12:00:00.000Z" }, deadline - 18 * 60_000);
		expect(own?.ceiling.minutes).toBe(118);
		expect(own?.spent.minutes).toBe(100);
	});
});
