import { describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage.ts";
import { renderCoveragePanel, type Tone } from "./coverage-panel.ts";
import type { HypothesisRecord } from "./ontology.ts";
import type { CoverageView } from "./stats.ts";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const measure = (s: string): number => strip(s).length;
const truncate = (s: string, w: number): string => (measure(s) <= w ? s : strip(s).slice(0, w));
const ink = (_tone: Tone, text: string): string => text; // colourless stand-in

const hyp = (id: string, target: string, cls: string, outcome: HypothesisRecord["outcome"]): HypothesisRecord => ({
	v: 1, id, kind: "hypothesis", createdAt: "t", statement: id, target, class: cls, outcome,
});

function view(elements: string[], classes: string[], hypotheses: HypothesisRecord[] = []): CoverageView {
	return {
		matrix: computeCoverage({
			classes: classes.map((id) => ({ id })),
			elements: elements.map((id) => ({ id })),
			hypotheses,
			openBlockers: [],
		}),
		classes: classes.map((id) => ({ id, title: id })),
		elementIds: elements,
	};
}

const render = (v: CoverageView, width: number): string[] =>
	renderCoveragePanel({ view: v, engagement: "acme", width, ink, measure, truncate });

describe("renderCoveragePanel", () => {
	const v = view(["/login", "/admin", "/api/tx"], ["authz", "injection", "crypto"], [
		hyp("h1", "/login", "authz", "refuted"),
		hyp("h2", "/admin", "authz", "confirmed"),
		hyp("h3", "/login", "injection", "testing"),
	]);

	it("never emits a line wider than the panel", () => {
		for (const width of [120, 80, 60, 40, 30, 20, 12, 6, 1]) {
			for (const line of render(v, width)) expect(measure(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders one row per checklist class with per-class counts", () => {
		const lines = render(v, 80);
		for (const cls of ["authz", "injection", "crypto"]) {
			expect(lines.some((l) => l.includes(cls))).toBe(true);
		}
		// authz: /login refuted (clear) + /admin confirmed (vulnerable) = 2 settled of 3
		expect(lines.find((l) => l.includes("authz"))).toContain("2/3");
		expect(lines.find((l) => l.includes("crypto"))).toContain("0/3");
	});

	it("shows cell glyphs reflecting status", () => {
		const authz = render(v, 80).find((l) => l.includes("authz")) ?? "";
		expect(authz).toContain("●"); // clear
		expect(authz).toContain("▲"); // vulnerable
		expect(authz).toContain("·"); // untested
	});

	it("marks the overflow when the surface exceeds the bar", () => {
		const wide = view(Array.from({ length: 40 }, (_, i) => `/e${i}`), ["authz"]);
		const line = render(wide, 46).find((l) => l.includes("authz")) ?? "";
		expect(line).toMatch(/\+\d+/);
		expect(measure(line)).toBeLessThanOrEqual(46);
	});

	it("falls back to bare counts when too narrow for a bar", () => {
		const lines = render(v, 20);
		const authz = lines.find((l) => l.includes("authz")) ?? "";
		expect(authz).toContain("2/3");
	});

	it("explains an empty surface instead of drawing an empty grid", () => {
		const lines = render(view([], ["authz"]), 60).join("\n");
		expect(lines).toContain("no surface recorded");
	});

	it("explains a missing checklist", () => {
		const lines = render(view(["/login"], []), 60).join("\n");
		expect(lines).toContain("no checklist");
	});
});

describe("renderCoveragePanel with n/a cells", () => {
	// tls applies to hosts only, sqli to endpoints only: each row has one askable
	// cell and one that is not a question at all.
	const scoped: CoverageView = {
		matrix: computeCoverage({
			classes: [
				{ id: "tls", appliesTo: ["host"] },
				{ id: "sqli", appliesTo: ["endpoint"] },
			],
			elements: [
				{ id: "h1", kind: "host" },
				{ id: "e1", kind: "endpoint" },
			],
			hypotheses: [hyp("h1y", "e1", "sqli", "refuted")],
			openBlockers: [],
		}),
		classes: [
			{ id: "tls", title: "tls" },
			{ id: "sqli", title: "sqli" },
		],
		elementIds: ["h1", "e1"],
	};

	it("counts each row over its askable cells only", () => {
		const lines = render(scoped, 60).map(strip);
		expect(lines.find((l) => l.trim().startsWith("tls"))).toMatch(/0\/1$/);
		expect(lines.find((l) => l.trim().startsWith("sqli"))).toMatch(/1\/1$/);
	});

	it("still paints an n/a glyph in the bar so columns stay aligned", () => {
		const lines = render(scoped, 60).map(strip);
		const tls = lines.find((l) => l.trim().startsWith("tls")) ?? "";
		const sqli = lines.find((l) => l.trim().startsWith("sqli")) ?? "";
		expect(tls).toContain("–");
		expect(sqli).toContain("–");
		expect(tls.length).toBe(sqli.length);
	});

	it("summarises and grades over applicable cells, not the whole grid", () => {
		const lines = render(scoped, 60).map(strip);
		// 1 settled of 2 askable; the raw 4-cell grid would read 25% / "4 cells".
		expect(lines[0]).toContain("50%");
		expect(lines.at(-1)).toContain("2 test cases");
	});

	it("shows the n/a key in the legend only when one exists", () => {
		expect(render(scoped, 80).map(strip).join("\n")).toContain("n/a");
		expect(render(view(["e1"], ["sqli"]), 80).map(strip).join("\n")).not.toContain("n/a");
	});
});

describe("the welcome screen's copy", () => {
	// The panel floats, so the editor has to clear it, so the welcome entry is as
	// tall as the panel. These options are what let the matrix fill those rows
	// instead of blank ones.
	const v = view(["/login", "/admin", "/api/tx"], ["authz", "injection", "crypto", "ssrf", "supply chain"], [
		hyp("h1", "/login", "authz", "refuted"),
		hyp("h2", "/admin", "authz", "confirmed"),
	]);
	const boxed = (width: number, maxLines: number): string[] =>
		renderCoveragePanel({ view: v, engagement: "acme", width, frame: true, maxLines, ink, measure, truncate });

	it("draws itself in the rail's box, with the heading in the border", () => {
		const lines = boxed(60, 20);
		// `⦿ view · engagement`, the same shape the rail and the browser use.
		expect(lines[0]).toContain("⦿ coverage");
		expect(lines[0]).toContain("acme");
		// The heading row and the blank under it go back to the matrix.
		expect(lines[1]).toContain("authz");
	});

	it("keeps the percentage, on the summary row rather than the title", () => {
		const lines = boxed(60, 20);
		expect(lines[0]).not.toContain("%");
		expect(lines.join("\n")).toMatch(/\d+% · \d+ test cases/);
	});

	it("never exceeds the rows it was given, and says what it dropped", () => {
		for (const budget of [8, 10, 12, 20]) {
			expect(boxed(60, budget).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
		}
		// Five classes into seven rows: two rows of frame, the legend, the summary,
		// and what is left goes to classes with the remainder counted.
		const tight = boxed(60, 7).map(strip).join("\n");
		expect(tight).toMatch(/\+\d+ more classes/);
		// One row more and they all fit, which is the row the blank above the
		// legend used to take.
		expect(boxed(60, 9).map(strip).join("\n")).not.toMatch(/more classes/);
	});

	it("keeps a row's counts next to its bar rather than at the far edge", () => {
		// Three elements is a three-cell bar; padded to the panel's width instead,
		// the counts ended up eighty columns from the class they count.
		// The frame pads every row to its border, so the question is where the
		// counts sit, not how long the line is.
		const row = strip(boxed(100, 20).find((l) => l.includes("authz")) as string);
		expect(row.indexOf("2/3")).toBeGreaterThan(0);
		expect(row.indexOf("2/3")).toBeLessThan(40);
	});

	it("says what to do when there is no surface yet, in the same box", () => {
		const empty = renderCoveragePanel({
			view: view([], ["authz"]), engagement: "acme", width: 60, frame: true, maxLines: 12,
			ink, measure, truncate,
		});
		expect(empty.join("\n")).toContain("no surface recorded");
		expect(empty[0]).toContain("⦿ coverage");
	});

	it("only offers a dismiss hint to something that can be dismissed", () => {
		expect(render(v, 60).join("\n")).not.toContain("esc to close");
		const overlay = renderCoveragePanel({ view: v, engagement: "acme", width: 60, hint: "esc to close", ink, measure, truncate });
		expect(overlay.join("\n")).toContain("esc to close");
	});
});
