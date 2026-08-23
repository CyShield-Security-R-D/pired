import { describe, expect, it } from "vitest";
import { computeCoverage, findGaps, selectNext } from "./coverage.ts";
import type { BlockerRecord, CoverageMatrix, HypothesisRecord } from "./ontology.ts";

const classes = [{ id: "authz" }, { id: "sqli" }];
const elements = [{ id: "e1" }, { id: "e2" }];

function hyp(id: string, target: string, cls: string, outcome: HypothesisRecord["outcome"]): HypothesisRecord {
	return { v: 1, id, kind: "hypothesis", createdAt: "t", statement: id, target, class: cls, outcome };
}

function blk(id: string, blocks: string[]): BlockerRecord {
	return { v: 1, id, kind: "blocker", createdAt: "t", type: "decision", question: id, priority: "medium", status: "open", blocks };
}

function cell(m: CoverageMatrix, element: string, cls: string) {
	const c = m.cells.find((x) => x.element === element && x.class === cls);
	if (!c) throw new Error(`no cell ${element}:${cls}`);
	return c;
}

describe("computeCoverage", () => {
	it("is all not-tested with no hypotheses", () => {
		const m = computeCoverage({ classes, elements, hypotheses: [], openBlockers: [] });
		expect(m.cells).toHaveLength(4);
		expect(m.counts["not-tested"]).toBe(4);
	});

	it("marks a confirmed hypothesis cell vulnerable", () => {
		const m = computeCoverage({ classes, elements, hypotheses: [hyp("y1", "e1", "authz", "confirmed")], openBlockers: [] });
		expect(cell(m, "e1", "authz").status).toBe("vulnerable");
		expect(cell(m, "e1", "sqli").status).toBe("not-tested");
	});

	it("maps refuted to clear and proposed to testing", () => {
		const m = computeCoverage({
			classes,
			elements,
			hypotheses: [hyp("y1", "e1", "authz", "refuted"), hyp("y2", "e2", "sqli", "proposed")],
			openBlockers: [],
		});
		expect(cell(m, "e1", "authz").status).toBe("clear");
		expect(cell(m, "e2", "sqli").status).toBe("testing");
	});

	it("blocks every cell of an element-level blocker", () => {
		const m = computeCoverage({ classes, elements, hypotheses: [], openBlockers: [blk("b1", ["e1"])] });
		expect(cell(m, "e1", "authz").status).toBe("blocked");
		expect(cell(m, "e1", "sqli").status).toBe("blocked");
		expect(cell(m, "e2", "authz").status).toBe("not-tested");
		expect(cell(m, "e1", "authz").blockerIds).toContain("b1");
	});

	it("blocks a single cell for a cell-level blocker", () => {
		const m = computeCoverage({ classes, elements, hypotheses: [], openBlockers: [blk("b1", ["e2:sqli"])] });
		expect(cell(m, "e2", "sqli").status).toBe("blocked");
		expect(cell(m, "e2", "authz").status).toBe("not-tested");
	});

	it("resolves a blocker that references a hypothesis id", () => {
		const m = computeCoverage({
			classes,
			elements,
			hypotheses: [hyp("y9", "e1", "sqli", "proposed")],
			openBlockers: [blk("b1", ["y9"])],
		});
		expect(cell(m, "e1", "sqli").status).toBe("blocked");
	});

	it("lets a confirmed finding win over a blocker", () => {
		const m = computeCoverage({
			classes,
			elements,
			hypotheses: [hyp("y1", "e1", "authz", "confirmed")],
			openBlockers: [blk("b1", ["e1"])],
		});
		expect(cell(m, "e1", "authz").status).toBe("vulnerable");
	});
});

describe("findGaps", () => {
	it("returns not-tested and blocked cells with reasons", () => {
		const m = computeCoverage({
			classes,
			elements,
			hypotheses: [hyp("y1", "e1", "authz", "confirmed")],
			openBlockers: [blk("b1", ["e2:sqli"])],
		});
		const gaps = findGaps(m)
			.map((g) => `${g.element}:${g.class}:${g.reason}`)
			.sort();
		expect(gaps).toEqual(["e1:sqli:not-tested", "e2:authz:not-tested", "e2:sqli:blocked"]);
	});
});

describe("selectNext", () => {
	it("skips blocked cells and returns an actionable one", () => {
		const m = computeCoverage({ classes, elements: [{ id: "e1" }], hypotheses: [], openBlockers: [blk("b1", ["e1:authz"])] });
		expect(selectNext(m)?.class).toBe("sqli");
	});

	it("returns undefined when nothing is actionable", () => {
		const m = computeCoverage({
			classes: [{ id: "authz" }],
			elements: [{ id: "e1" }],
			hypotheses: [hyp("y1", "e1", "authz", "confirmed")],
			openBlockers: [],
		});
		expect(selectNext(m)).toBeUndefined();
	});
});
