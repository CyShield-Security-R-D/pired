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
