import { describe, expect, it } from "vitest";
import type { CoverageMatrix, CoverageStatus } from "../core/ontology.ts";
import { alignMatrix, formatGrade, grade } from "./grade.ts";
import { validateKey, type AnswerKey, type KeyCell } from "./key.ts";

/**
 * The grader decides every number this project reports about itself, and until
 * now nothing checked it. A grader that is wrong in the agent's favour does not
 * look like a bug; it looks like a good result.
 *
 * The cases below are written around the miss taxonomy, because that is the
 * whole design point: recall alone says a bug was missed, not why, and the four
 * whys need different fixes. The one that matters most is the false clear —
 * "reached it, looked, said clean", where it was not.
 */

function key(cells: Array<Partial<KeyCell> & Pick<KeyCell, "element" | "class" | "truth">>): AnswerKey {
	return {
		v: 1,
		target: "fixture",
		cells: cells.map((c) => ({
			...(c.truth === "vulnerable" ? { sink: "a.py:1" } : {}),
			...(c.truth === "clear" ? { why: "not reachable" } : {}),
			...c,
		})) as KeyCell[],
	};
}

function matrix(cells: Array<[string, string, CoverageStatus]>): CoverageMatrix {
	return {
		cells: cells.map(([element, cls, status]) => ({ element, class: cls, status })),
		counts: {} as Record<CoverageStatus, number>,
		applicable: cells.length,
	};
}

describe("classifying one cell against the truth", () => {
	const cases: Array<[CoverageStatus | "absent", string]> = [
		["vulnerable", "hit"],
		["clear", "false-clear"],
		["n/a", "false-na"],
		["testing", "missed-inflight"],
		["blocked", "missed-blocked"],
		["not-tested", "missed-untested"],
	];

	for (const [observed, outcome] of cases) {
		it(`calls a truly vulnerable cell the agent left "${observed}" a ${outcome}`, () => {
			const g = grade(key([{ element: "e", class: "sqli", truth: "vulnerable" }]), matrix([["e", "sqli", observed as CoverageStatus]]));
			expect(g.cells[0]?.outcome).toBe(outcome);
		});
	}

	it("separates the miss that is a rigor failure from the miss that is a coverage failure", () => {
		// The distinction the whole taxonomy exists for: one of these agents looked
		// and was wrong; the other never looked. They need different fixes.
		const g = grade(
			key([
				{ element: "a", class: "sqli", truth: "vulnerable" },
				{ element: "b", class: "sqli", truth: "vulnerable" },
			]),
			matrix([["a", "sqli", "clear"], ["b", "sqli", "not-tested"]]),
		);
		expect(g.counts["false-clear"]).toBe(1);
		expect(g.counts["missed-untested"]).toBe(1);
	});

	it("rewards a correct refutation, which is the behaviour coverage exists to buy", () => {
		const g = grade(key([{ element: "e", class: "ssti", truth: "clear" }]), matrix([["e", "ssti", "clear"]]));
		expect(g.cells[0]?.outcome).toBe("true-clear");
	});

	it("calls a vulnerability reported where there is none an over-report", () => {
		const g = grade(key([{ element: "e", class: "ssti", truth: "clear" }]), matrix([["e", "ssti", "vulnerable"]]));
		expect(g.cells[0]?.outcome).toBe("over-report");
	});

	it("counts a truth-clear cell the agent never settled as open, not as a win", () => {
		const g = grade(key([{ element: "e", class: "ssti", truth: "clear" }]), matrix([["e", "ssti", "not-tested"]]));
		expect(g.cells[0]?.outcome).toBe("open");
	});

	it("agrees, or does not, about what was never a question", () => {
		const na = key([{ element: "e", class: "xxe", truth: "n/a" }]);
		expect(grade(na, matrix([["e", "xxe", "n/a"]])).cells[0]?.outcome).toBe("na-agree");
		expect(grade(na, matrix([["e", "xxe", "clear"]])).cells[0]?.outcome).toBe("na-over-scope");
		expect(grade(na, matrix([["e", "xxe", "vulnerable"]])).cells[0]?.outcome).toBe("over-report");
	});

	it("reports a cell the matrix has no counterpart for as unmatched, never as a miss", () => {
		// An alignment artifact must not be able to masquerade as a capability
		// failure — that is exactly what alignMatrix exists to prevent.
		const g = grade(key([{ element: "ghost", class: "sqli", truth: "vulnerable" }]), matrix([]));
		expect(g.cells[0]?.outcome).toBe("unmatched");
		expect(g.metrics.unmatched).toBe(1);
	});

	it("accepts an alias the key declares, so honest naming differences cost nothing", () => {
		const k = key([{ element: "GET /api/orders", class: "authz", truth: "vulnerable", aliases: ["/api/orders"] }]);
		expect(grade(k, matrix([["/api/orders", "authz", "vulnerable"]])).cells[0]?.outcome).toBe("hit");
	});
});

describe("the headline metrics", () => {
	it("scores recall over the truth-vulnerable cells", () => {
		const g = grade(
			key([
				{ element: "a", class: "sqli", truth: "vulnerable" },
				{ element: "b", class: "sqli", truth: "vulnerable" },
				{ element: "c", class: "sqli", truth: "clear" },
			]),
			matrix([["a", "sqli", "vulnerable"], ["b", "sqli", "not-tested"], ["c", "sqli", "clear"]]),
		);
		expect(g.metrics.recall).toBe(0.5);
	});

	it("measures the false-clear rate against what the agent CALLED clear, not against the key", () => {
		// This is the number a consultant is trusting: of the cells this run said
		// were clean, how many were not.
		const g = grade(
			key([
				{ element: "a", class: "sqli", truth: "vulnerable" },
				{ element: "b", class: "sqli", truth: "clear" },
				{ element: "c", class: "sqli", truth: "clear" },
				{ element: "d", class: "sqli", truth: "vulnerable" },
			]),
			matrix([["a", "sqli", "clear"], ["b", "sqli", "clear"], ["c", "sqli", "clear"], ["d", "sqli", "not-tested"]]),
		);
		expect(g.metrics.falseClearRate).toBe(0.3333);
		// And the dismissed rate against all real bugs: how much of the miss pile
		// is rigor rather than coverage.
		expect(g.metrics.dismissedRate).toBe(0.5);
	});

	it("scores precision over what the agent called vulnerable", () => {
		const g = grade(
			key([
				{ element: "a", class: "sqli", truth: "vulnerable" },
				{ element: "b", class: "sqli", truth: "clear" },
			]),
			matrix([["a", "sqli", "vulnerable"], ["b", "sqli", "vulnerable"]]),
		);
		expect(g.metrics.precision).toBe(0.5);
	});

	it("returns zero rather than NaN when a denominator is empty", () => {
		const g = grade(key([{ element: "a", class: "sqli", truth: "clear" }]), matrix([["a", "sqli", "not-tested"]]));
		expect(g.metrics.recall).toBe(0);
		expect(g.metrics.falseClearRate).toBe(0);
		expect(g.metrics.precision).toBe(0);
	});

	it("never credits a cell the key does not cover", () => {
		// The agent found something real that the key says nothing about. It is not
		// scored either way — a run must not be rewarded for cells nobody has
		// ground truth for.
		const g = grade(key([{ element: "a", class: "sqli", truth: "vulnerable" }]), matrix([
			["a", "sqli", "vulnerable"], ["z", "authz", "vulnerable"],
		]));
		expect(g.cells).toHaveLength(1);
		expect(g.metrics.precision).toBe(1);
	});
});

describe("per-stratum recall", () => {
	const k = key([
		{ element: "a", class: "sqli", truth: "vulnerable", strata: { stack: "python" } },
		{ element: "b", class: "sqli", truth: "vulnerable", strata: { stack: "python" } },
		{ element: "c", class: "sqli", truth: "vulnerable", strata: { stack: "java" } },
	]);

	it("answers whether the competence is stack-specific", () => {
		const g = grade(k, matrix([["a", "sqli", "vulnerable"], ["b", "sqli", "vulnerable"], ["c", "sqli", "not-tested"]]));
		expect(g.strata).toEqual([
			{ stratum: "java", truthVulnerable: 1, hits: 0, recall: 0 },
			{ stratum: "python", truthVulnerable: 2, hits: 2, recall: 1 },
		]);
	});

	it("reports the floor and the spread, because a flagship harness has a floor", () => {
		const g = grade(k, matrix([["a", "sqli", "vulnerable"], ["b", "sqli", "vulnerable"], ["c", "sqli", "not-tested"]]));
		expect(g.worstStratumRecall).toBe(0);
		expect(g.stratumSpread).toBe(1);
	});

	it("buckets unlabelled cells rather than dropping them", () => {
		const g = grade(key([{ element: "a", class: "sqli", truth: "vulnerable" }]), matrix([["a", "sqli", "vulnerable"]]));
		expect(g.strata[0]?.stratum).toBe("unlabelled");
	});

	it("has no floor to report when the key holds no vulnerable cell", () => {
		const g = grade(key([{ element: "a", class: "sqli", truth: "clear" }]), matrix([["a", "sqli", "clear"]]));
		expect(g.worstStratumRecall).toBeNull();
		expect(g.stratumSpread).toBeNull();
	});
});

describe("aligning the agent's ids onto the key's names", () => {
	const k = key([{ element: "GET /api/orders", class: "authz", truth: "vulnerable" }]);

	it("renames a minted id to the surface's own identity", () => {
		// pired mints "id7"; a key can only be written in the surface's own words.
		// Without this every cell grades unmatched and a good run scores zero.
		const aligned = alignMatrix(
			matrix([["id7", "authz", "vulnerable"]]),
			[{ id: "id7", kind: "endpoint", method: "GET", path: "/api/orders" }],
			k,
		);
		expect(aligned.cells[0]?.element).toBe("GET /api/orders");
		expect(grade(k, aligned).cells[0]?.outcome).toBe("hit");
	});

	it("matches on a bare path when the key was written without a method", () => {
		const bare = key([{ element: "/api/orders", class: "authz", truth: "vulnerable" }]);
		const aligned = alignMatrix(matrix([["id7", "authz", "vulnerable"]]), [{ id: "id7", path: "/api/orders" }], bare);
		expect(aligned.cells[0]?.element).toBe("/api/orders");
	});

	it("matches a host by value and a tech by name", () => {
		const hosts = key([{ element: "10.0.0.1", class: "misconfig", truth: "clear" }]);
		const aligned = alignMatrix(matrix([["id1", "misconfig", "clear"]]), [{ id: "id1", value: "10.0.0.1" }], hosts);
		expect(aligned.cells[0]?.element).toBe("10.0.0.1");
	});

	it("matches through an alias the key declares", () => {
		const aliased = key([{ element: "orders", class: "authz", truth: "vulnerable", aliases: ["GET /api/orders"] }]);
		const aligned = alignMatrix(
			matrix([["id7", "authz", "vulnerable"]]),
			[{ id: "id7", method: "GET", path: "/api/orders" }],
			aliased,
		);
		expect(aligned.cells[0]?.element).toBe("orders");
	});

	it("leaves the matrix alone when nothing lines up, rather than half-renaming it", () => {
		const before = matrix([["id7", "authz", "vulnerable"]]);
		expect(alignMatrix(before, [{ id: "id7", path: "/nowhere" }], k)).toBe(before);
	});

	it("keeps an id it could not map, so the miss is visible as unmatched", () => {
		const aligned = alignMatrix(
			matrix([["id7", "authz", "vulnerable"], ["id9", "sqli", "clear"]]),
			[{ id: "id7", method: "GET", path: "/api/orders" }],
			k,
		);
		expect(aligned.cells[1]?.element).toBe("id9");
	});
});

describe("validating an answer key", () => {
	const cell = { element: "a", class: "sqli", truth: "vulnerable" as const, sink: "a.py:1" };

	it("accepts a well-formed key", () => {
		expect(validateKey({ v: 1, target: "t", cells: [cell] }).cells).toHaveLength(1);
	});

	it("rejects a vulnerable cell nobody can locate", () => {
		// An unlocatable claim is not ground truth.
		expect(() => validateKey({ v: 1, target: "t", cells: [{ element: "a", class: "sqli", truth: "vulnerable" }] }))
			.toThrow(/sink or a poc/);
	});

	it("rejects a clear cell with no reason — the point of the whole format", () => {
		// Otherwise "we found nothing" is recorded as "there is nothing", which is
		// the exact failure a cell key exists to make impossible.
		expect(() => validateKey({ v: 1, target: "t", cells: [{ element: "a", class: "sqli", truth: "clear" }] }))
			.toThrow(/needs a 'why'/);
	});

	it("rejects a duplicate cell, which would be counted twice", () => {
		expect(() => validateKey({ v: 1, target: "t", cells: [cell, cell] })).toThrow(/duplicate cell/);
	});

	it("rejects an unknown truth value", () => {
		expect(() => validateKey({ v: 1, target: "t", cells: [{ ...cell, truth: "probably" }] })).toThrow(/truth must be/);
	});

	it("rejects an unsupported version, an empty key and a non-object", () => {
		expect(() => validateKey({ v: 2, target: "t", cells: [cell] })).toThrow(/unsupported version/);
		expect(() => validateKey({ v: 1, target: "t", cells: [] })).toThrow(/no cells/);
		expect(() => validateKey(null)).toThrow(/not an object/);
	});

	it("collects every problem at once, because fixing keys one throw at a time is the slow way", () => {
		try {
			validateKey({ v: 1, cells: [{ class: "sqli", truth: "clear" }] });
			expect.unreachable("should have thrown");
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).toContain("missing target");
			expect(msg).toContain("missing element");
			expect(msg).toContain("needs a 'why'");
		}
	});
});

describe("the graded report as an operator reads it", () => {
	const g = grade(
		key([
			{ element: "a", class: "sqli", truth: "vulnerable", strata: { stack: "python" } },
			{ element: "b", class: "authz", truth: "vulnerable", strata: { stack: "java" } },
			{ element: "c", class: "ssti", truth: "clear" },
		]),
		matrix([["a", "sqli", "vulnerable"], ["b", "authz", "clear"], ["c", "ssti", "clear"]]),
	);

	it("leads with the target and the headline rates", () => {
		const out = formatGrade(g);
		expect(out).toContain("assay · grade · fixture");
		expect(out).toContain("recall");
		expect(out).toContain("precision");
	});

	it("shouts the false-clear rate, and says what its denominator was", () => {
		// The number a consultant is trusting does not get to be one row among ten.
		const out = formatGrade(g);
		expect(out).toContain("FALSE-CLEAR RATE");
		expect(out).toMatch(/of 2 cells called clear/);
	});

	it("prints the miss taxonomy with the fix each miss points at", () => {
		const out = formatGrade(g);
		expect(out).toContain("← rigor");
		expect(out).toContain("← coverage");
		expect(out).toContain("← stopping");
		expect(out).toContain("← operator");
	});

	it("breaks recall out per stratum, worst first, once there is more than one", () => {
		const out = formatGrade(g);
		expect(out).toContain("per stratum (worst first)");
		expect(out.indexOf("java")).toBeLessThan(out.indexOf("python"));
	});

	it("says nothing about strata when there is only one to say it about", () => {
		const single = grade(key([{ element: "a", class: "sqli", truth: "vulnerable" }]), matrix([["a", "sqli", "vulnerable"]]));
		expect(formatGrade(single)).not.toContain("per stratum");
	});

	it("warns about unmatched cells as alignment, explicitly not as capability", () => {
		const unaligned = grade(key([{ element: "ghost", class: "sqli", truth: "vulnerable" }]), matrix([]));
		expect(formatGrade(unaligned)).toContain("alignment, not capability");
	});

	it("keeps quiet about alignment when everything lined up", () => {
		expect(formatGrade(g)).not.toContain("alignment, not capability");
	});
});
