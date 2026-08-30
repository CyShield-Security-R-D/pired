import { describe, expect, it } from "vitest";
import {
	buildBrowserModel, initialState, reduceBrowser, renderBrowser, visibleHypotheses,
} from "./browser.ts";
import type { BrowserModel, BrowserState } from "./browser.ts";
import type { CoverageCell, FindingRecord, HypothesisRecord, InventoryRecord } from "./ontology.ts";

const CLASSES = [
	{ id: "authz", title: "authz" },
	{ id: "idor", title: "idor" },
	{ id: "ssrf", title: "ssrf" },
];

const inventory = [
	{ id: "e1", kind: "endpoint", method: "GET", path: "/api/v2/dags", host: "h1" },
	{ id: "e2", kind: "endpoint", method: "POST", path: "/api/v2/connections", host: "h1" },
	{ id: "h1", kind: "host", value: "airflow.local" },
] as unknown as InventoryRecord[];

const cells = [
	{ element: "e1", class: "authz", status: "clear" },
	{ element: "e1", class: "idor", status: "vulnerable" },
	{ element: "e1", class: "ssrf", status: "not-tested" },
	{ element: "e2", class: "authz", status: "not-tested" },
	{ element: "e2", class: "idor", status: "not-tested" },
	{ element: "e2", class: "ssrf", status: "n/a" },
] as CoverageCell[];

const hypotheses = [
	{ id: "hy1", kind: "hypothesis", class: "authz", target: "e1", outcome: "refuted", statement: "role check enforced before list" },
	{ id: "hy2", kind: "hypothesis", class: "idor", target: "e1", outcome: "confirmed", statement: "dag_id not scoped to caller", findingId: "f1" },
] as unknown as HypothesisRecord[];

const findings = [{ id: "f1", kind: "finding", title: "IDOR", severity: "high", target: "e1" }] as unknown as FindingRecord[];

const model: BrowserModel = buildBrowserModel({
	engagement: "airflow", classes: CLASSES, cells, inventory, hypotheses, findings,
});

/** ASCII stand-in: no colour, so assertions are about layout only. */
const opts = (state: BrowserState, width = 80, height = 10) => ({
	model, state, width, height,
	ink: (_t: string, s: string) => s,
	measure: (s: string) => s.length,
	truncate: (s: string, w: number) => (s.length > w ? s.slice(0, w) : s),
});

describe("buildBrowserModel", () => {
	it("labels each inventory kind the way it names itself", () => {
		expect(model.surface.map((s) => s.label)).toContain("GET /api/v2/dags");
		expect(model.surface.map((s) => s.label)).toContain("airflow.local");
	});

	it("counts n/a out of the denominator but keeps it in the bar", () => {
		const e2 = model.surface.find((s) => s.id === "e2");
		expect(e2?.statuses).toHaveLength(3);
		expect(e2?.askable).toBe(2); // ssrf is n/a
		expect(e2?.settled).toBe(0);
	});

	it("orders least-settled first, so untested rows are not buried", () => {
		expect(model.surface[0]?.id).toBe("e2");
	});

	it("attributes findings to their target element", () => {
		expect(model.surface.find((s) => s.id === "e1")?.findings).toBe(1);
	});

	it("tallies outcomes for the header", () => {
		expect(model.counts).toEqual({ all: 2, confirmed: 1, refuted: 1, open: 0 });
	});
});

describe("reduceBrowser", () => {
	it("moves and clamps at both ends", () => {
		let s = initialState();
		s = reduceBrowser(s, "up", model, 10) as BrowserState;
		expect(s.cursor).toBe(0);
		s = reduceBrowser(s, "bottom", model, 10) as BrowserState;
		expect(s.cursor).toBe(model.surface.length - 1);
		s = reduceBrowser(s, "down", model, 10) as BrowserState;
		expect(s.cursor).toBe(model.surface.length - 1);
	});

	it("scrolls by the least that keeps the cursor visible", () => {
		let s = initialState();
		for (let i = 0; i < 3; i++) s = reduceBrowser(s, "down", model, 2) as BrowserState;
		expect(s.cursor).toBe(2);
		expect(s.scroll).toBe(1); // viewport 2, cursor 2 => window [1,2]
	});

	it("drills surface -> element -> hypothesis and back out again", () => {
		// Select e1 by identity, not by position: the ordering is least-settled
		// first and a positional assumption breaks whenever that ranking changes.
		const target = model.surface.findIndex((r) => r.id === "e1");
		let s: BrowserState = { ...initialState(), cursor: target };
		const el = model.surface[target]!.id;
		s = reduceBrowser(s, "in", model, 10) as BrowserState;
		expect(s.view).toBe("element");
		expect(s.elementId).toBe(el);
		s = reduceBrowser(s, "in", model, 10) as BrowserState; // class row 0 = authz
		expect(s.view).toBe("hypothesis");
		s = reduceBrowser(s, "out", model, 10) as BrowserState;
		expect(s.view).toBe("element");
		s = reduceBrowser(s, "out", model, 10) as BrowserState;
		expect(s.view).toBe("surface");
		expect(reduceBrowser(s, "out", model, 10)).toBe("close");
	});

	it("stays put on a class with no hypothesis rather than opening something else", () => {
		let s: BrowserState = { ...initialState("element"), elementId: "e2", cursor: 0 };
		s = reduceBrowser(s, "in", model, 10) as BrowserState;
		expect(s.view).toBe("element");
	});

	it("filters, and resets the cursor so it cannot point past a shorter list", () => {
		let s: BrowserState = { ...initialState("hypotheses"), cursor: 1 };
		s = reduceBrowser(s, "filter:confirmed", model, 10) as BrowserState;
		expect(s.filter).toBe("confirmed");
		expect(s.cursor).toBe(0);
		expect(visibleHypotheses(model, s)).toHaveLength(1);
	});

	it("tab switches lists and keeps the filter", () => {
		const s = reduceBrowser({ ...initialState("surface"), filter: "refuted" }, "switch", model, 10) as BrowserState;
		expect(s.view).toBe("hypotheses");
		expect(s.filter).toBe("refuted");
	});

	it("q closes from anywhere", () => {
		expect(reduceBrowser(initialState("hypotheses"), "close", model, 10)).toBe("close");
	});
});

describe("renderBrowser", () => {
	it("never emits a line wider than the width it was given", () => {
		for (const view of ["surface", "hypotheses"] as const) {
			for (const w of [40, 60, 100]) {
				const lines = renderBrowser(opts({ ...initialState(view) }, w));
				for (const l of lines) expect(l.length).toBeLessThanOrEqual(w);
			}
		}
	});

	it("shows the settled tally and element count in the surface header", () => {
		const [head] = renderBrowser(opts(initialState()));
		expect(head).toContain("surface · airflow");
		expect(head).toContain("3 elements");
	});

	it("says plainly when nothing has been recorded", () => {
		const empty = buildBrowserModel({ engagement: "x", classes: CLASSES, cells: [], inventory: [], hypotheses: [], findings: [] });
		const lines = renderBrowser({ ...opts(initialState()), model: empty });
		expect(lines.join("\n")).toContain("no surface recorded yet");
	});

	it("names the idle mechanism rather than showing an empty list", () => {
		const empty = buildBrowserModel({ engagement: "x", classes: CLASSES, cells, inventory, hypotheses: [], findings: [] });
		const lines = renderBrowser({ ...opts(initialState("hypotheses")), model: empty });
		expect(lines.join("\n")).toContain("coverage mechanism has not engaged");
	});

	it("renders only the viewport slice", () => {
		const body = renderBrowser(opts(initialState(), 80, 1));
		// header(2) + 1 row + footer(2)
		expect(body).toHaveLength(5);
	});

	it("shows a class with no hypothesis as not tested", () => {
		const lines = renderBrowser(opts({ ...initialState("element"), elementId: "e2" }));
		expect(lines.join("\n")).toContain("not tested");
	});

	it("puts statement, class and target in the detail view", () => {
		const lines = renderBrowser(opts({ ...initialState("hypothesis"), hypothesisId: "hy2" })).join("\n");
		expect(lines).toContain("dag_id not scoped to caller");
		expect(lines).toContain("idor");
		expect(lines).toContain("/api/v2/dags");
	});

	it("degrades to a message instead of a broken layout when too narrow", () => {
		expect(renderBrowser(opts(initialState(), 20)).join("")).toContain("too narrow");
	});
});

describe("ordering", () => {
	it("sorts an element with no askable class last, not first", () => {
		// 0/0 is not the most neglected row in the engagement — it is a row with no
		// work in it, and ranking it above an untested endpoint inverts the order.
		const ids = model.surface.map((s) => s.id);
		expect(ids.indexOf("h1")).toBe(ids.length - 1);
		expect(ids[0]).toBe("e2");
	});
});

describe("element rows never contradict their glyph", () => {
	it("states the status when no hypothesis carries the text", () => {
		// A cell can be settled by work that was never recorded as a hypothesis.
		// Rendering that as "not tested" beside a `clear` glyph said both at once.
		const cells2 = [{ element: "e1", class: "ssrf", status: "clear" }] as CoverageCell[];
		const m = buildBrowserModel({ engagement: "x", classes: CLASSES, cells: cells2, inventory, hypotheses: [], findings: [] });
		const lines = renderBrowser({
			...opts({ ...initialState("element"), elementId: "e1" }), model: m,
		}).join("\n");
		expect(lines).toContain("clear · no hypothesis recorded");
		expect(lines).not.toContain("clear · no hypothesis recorded\nnot tested");
	});
});
