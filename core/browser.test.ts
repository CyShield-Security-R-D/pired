import { describe, expect, it } from "vitest";
import {
	buildBrowserModel, contentWidth, detailRowCount, initialState, reduceBrowser, renderBrowser, visibleHypotheses,
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

const findings = [
	{ id: "f1", kind: "finding", title: "IDOR on dag list", severity: "high", target: "e1", cwe: "CWE-639", description: "dag_id is not scoped to the caller", repro: "GET /api/v2/dags?dag_id=other", evidence: ["evidence/idor.txt"] },
	{ id: "f2", kind: "finding", title: "No dependency pins", severity: "info" },
	{ id: "f3", kind: "finding", title: "Secrets to stdout", severity: "medium", target: "telegram.py:55" },
] as unknown as FindingRecord[];

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

	it("names the view in the frame's top edge and tallies underneath", () => {
		const [edge, tally] = renderBrowser(opts(initialState()));
		// The title sits in the box edge the way the rail sets its own; the count
		// is its own row beneath, so a narrow frame truncates the title and not
		// the number.
		expect(edge).toContain("surface · airflow");
		expect(tally).toContain("3 elements");
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
		// top edge + tally + rule + 1 row + rule + legend + bottom edge
		expect(body).toHaveLength(7);
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

describe("findings", () => {
	it("orders worst first, not by recording order", () => {
		// Recording order buries a critical under six info rows, which is the
		// opposite of what the list is for.
		expect(model.findings.map((f) => f.severity)).toEqual(["high", "medium", "info"]);
	});

	it("resolves a target through the inventory, and keeps a raw one as given", () => {
		expect(model.findings.find((f) => f.id === "f1")?.targetLabel).toBe("GET /api/v2/dags");
		expect(model.findings.find((f) => f.id === "f3")?.targetLabel).toBe("telegram.py:55");
	});

	it("shows an em dash for a finding with no target at all", () => {
		expect(model.findings.find((f) => f.id === "f2")?.targetLabel).toBe("—");
	});

	it("drills into a finding and back out", () => {
		let s = initialState("findings");
		s = reduceBrowser(s, "in", model, 10) as BrowserState;
		expect(s.view).toBe("finding");
		expect(s.findingId).toBe("f1");
		s = reduceBrowser(s, "out", model, 10) as BrowserState;
		expect(s.view).toBe("findings");
	});

	it("puts severity, cwe, target, description and evidence in the detail", () => {
		const text = renderBrowser(opts({ ...initialState("finding"), findingId: "f1" })).join("\n");
		expect(text).toContain("high");
		expect(text).toContain("CWE-639");
		expect(text).toContain("GET /api/v2/dags");
		expect(text).toContain("dag_id is not scoped");
		expect(text).toContain("evidence/idor.txt");
	});

	it("tab cycles coverage -> surface -> hypotheses -> findings -> coverage", () => {
		let s = initialState("coverage");
		for (const expected of ["surface", "hypotheses", "findings", "coverage"]) {
			s = reduceBrowser(s, "switch", model, 10) as BrowserState;
			expect(s.view).toBe(expected);
		}
	});

	it("never emits a line wider than the width it was given", () => {
		for (const v of ["findings", "finding"] as const) {
			for (const w of [40, 70, 110]) {
				const st = { ...initialState(v), findingId: "f1" };
				for (const l of renderBrowser(opts(st, w))) expect(l.length).toBeLessThanOrEqual(w);
			}
		}
	});
});

describe("a detail view scrolls, because its footer says it does", () => {
	// rowCount returned 0 for "finding" and "hypothesis", so move() clamped the
	// cursor to 0 and scroll never advanced: everything past the first screenful
	// of a finding's description, repro and evidence was unreachable while the
	// footer advertised "↑↓ scroll".
	const wordy = Array.from({ length: 40 }, (_, i) => `line ${i} of a long description`).join(" ");
	const big = buildBrowserModel({
		engagement: "airflow", classes: CLASSES, cells, inventory, hypotheses,
		findings: [{
			id: "f1", kind: "finding", title: "IDOR on dag list", severity: "high", target: "e1",
			cwe: "CWE-639", description: wordy, repro: "GET /api/v2/dags?dag_id=other",
			evidence: ["evidence/idor.txt", "evidence/idor2.txt"],
		}] as unknown as FindingRecord[],
	});
	const at = (state: BrowserState) => ({ ...opts(state), model: big });
	const state: BrowserState = { ...initialState("findings"), view: "finding", findingId: "f1" };

	it("counts more lines than fit the viewport", () => {
		expect(detailRowCount(at(state))).toBeGreaterThan(10);
	});

	it("advances the window on down, and lands at the end on bottom", () => {
		const total = detailRowCount(at(state));
		const down = reduceBrowser(state, "down", big, 10, total);
		expect(down).not.toBe("close");
		expect((down as BrowserState).scroll).toBe(1);

		const end = reduceBrowser(state, "bottom", big, 10, total);
		expect((end as BrowserState).scroll).toBe(total - 10);
	});

	it("renders a later slice once scrolled", () => {
		const total = detailRowCount(at(state));
		const top = renderBrowser(at(state));
		const moved = reduceBrowser(state, "pageDown", big, 10, total) as BrowserState;
		expect(renderBrowser(at(moved))).not.toEqual(top);
	});

	it("leads with the title, not the severity", () => {
		const body = renderBrowser(at(state));
		const title = body.findIndex((l) => l.includes("IDOR on dag list"));
		const sev = body.findIndex((l) => l.includes("high"));
		expect(title).toBeGreaterThan(-1);
		expect(title).toBeLessThan(sev);
	});
});

describe("the cursor row is painted, not just inked", () => {
	it("uses the background painter when one is supplied", () => {
		const painted: string[] = [];
		const lines = renderBrowser({
			...opts(initialState("surface")),
			highlight: (s) => { painted.push(s); return `[${s}]`; },
		});
		expect(painted).toHaveLength(1);
		expect(lines.some((l) => l.includes("["))).toBe(true);
	});

	it("falls back to the selected tone when no painter is given", () => {
		const lines = renderBrowser(opts(initialState("surface")));
		expect(lines.some((l) => l.startsWith("▸") || l.includes("▸"))).toBe(true);
	});
});

describe("the coverage matrix is a browser view, not a wall", () => {
	// It was a static overlay: its whole input handler closed it. The matrix is
	// the transpose of the surface view and the model already carries it, so the
	// class-major rows come from surface[].statuses rather than a second build.
	it("has one row per checklist class", () => {
		const lines = renderBrowser(opts(initialState("coverage")));
		for (const c of CLASSES) expect(lines.join("\n")).toContain(c.title);
	});

	it("scrolls, where the static overlay could not", () => {
		const s = reduceBrowser(initialState("coverage"), "down", model, 2) as BrowserState;
		expect(s.cursor).toBe(1);
	});

	it("drills from a class into that class down the surface, and back out", () => {
		let s = reduceBrowser(initialState("coverage"), "in", model, 10) as BrowserState;
		expect(s.view).toBe("class");
		expect(s.classId).toBe(CLASSES[0]?.id);
		// One row per surface element, which is the column of the matrix.
		expect(renderBrowser(opts(s)).join("\n")).toContain("/api/v2/dags");
		s = reduceBrowser(s, "out", model, 10) as BrowserState;
		expect(s.view).toBe("coverage");
	});

	it("returns to the class it came from when backing out of a hypothesis", () => {
		let s = { ...initialState("coverage"), cursor: 0 } as BrowserState;
		s = reduceBrowser(s, "in", model, 10) as BrowserState;        // -> class authz
		expect(s.view).toBe("class");
		// The surface is ordered least-settled first, so row 0 is e2 — which has no
		// authz hypothesis. That cell is a gap, and a gap correctly opens nothing.
		expect(reduceBrowser(s, "in", model, 10)).toEqual(s);
		const onE1 = model.surface.findIndex((el) => el.id === "e1");
		s = reduceBrowser(s, "down", model, 10) as BrowserState;
		expect(s.cursor).toBe(onE1);
		s = reduceBrowser(s, "in", model, 10) as BrowserState;
		expect(s.view).toBe("hypothesis");
		s = reduceBrowser(s, "out", model, 10) as BrowserState;
		expect(s.view).toBe("class");
	});

	it("says what is missing rather than drawing an empty grid", () => {
		const bare = buildBrowserModel({ engagement: "x", classes: CLASSES, cells: [], inventory: [], hypotheses: [], findings: [] });
		const lines = renderBrowser({ ...opts(initialState("coverage")), model: bare });
		expect(lines.join("\n")).toContain("no surface recorded yet");
	});
});

describe("viewport state never crosses a view boundary", () => {
	// cursor/scroll mean a ROW in a list and a LINE in a detail. Carrying one into
	// the other rendered an empty findings list after backing out of a scrolled
	// finding, and opened a finding halfway down its own body.
	const wordy = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
	const many = buildBrowserModel({
		engagement: "t", classes: CLASSES, cells, inventory, hypotheses,
		findings: Array.from({ length: 12 }, (_, i) => ({
			id: `f${i}`, kind: "finding", title: `Finding ${i}`, severity: "high",
			target: "e1", cwe: "CWE-89", description: wordy, evidence: ["evidence/a.txt"],
		})) as unknown as FindingRecord[],
	});
	const at = (s: BrowserState) => ({ ...opts(s), model: many });

	it("returns to a populated list after scrolling a detail", () => {
		let s: BrowserState = initialState("findings");
		s = reduceBrowser(s, "in", many, 8, 0) as BrowserState;
		const total = detailRowCount(at(s));
		for (let i = 0; i < 12; i++) s = reduceBrowser(s, "down", many, 8, total) as BrowserState;
		expect(s.scroll).toBeGreaterThan(0);
		s = reduceBrowser(s, "out", many, 8, total) as BrowserState;
		expect(s.scroll).toBe(0);
		expect(renderBrowser(at(s)).filter((l) => l.includes("Finding "))).not.toHaveLength(0);
	});

	it("opens a detail at its top, from anywhere in the list", () => {
		let s: BrowserState = initialState("findings");
		for (let i = 0; i < 9; i++) s = reduceBrowser(s, "down", many, 3, 0) as BrowserState;
		s = reduceBrowser(s, "in", many, 3, 0) as BrowserState;
		expect(s.scroll).toBe(0);
	});

	it("counts detail lines at the width the renderer wraps at", () => {
		// A 4-column disagreement between counter and renderer left the last lines
		// of a finding — its evidence paths — permanently unreachable.
		const s: BrowserState = { ...initialState("findings"), view: "finding", findingId: "f0" };
		const counted = detailRowCount({ ...at(s), width: 72 });
		const rendered = renderBrowser({ ...at(s), width: 72, height: 999 }).length - 6;
		expect(counted).toBe(rendered);
		expect(contentWidth(72)).toBe(68);
	});
});

describe("the frame never outgrows the rows it was given", () => {
	it("honours maxLines, and drops the box before it drops the content", () => {
		for (const budget of [20, 12, 9, 7]) {
			const lines = renderBrowser({ ...opts(initialState("surface")), maxLines: budget });
			expect(lines.length).toBeLessThanOrEqual(budget);
		}
		// Below the chrome's own floor a bare list beats a frame with no bottom.
		const tiny = renderBrowser({ ...opts(initialState("surface")), maxLines: 4 });
		expect(tiny.length).toBeLessThanOrEqual(4);
		expect(tiny.join("")).not.toContain("╰");
	});

	it("does not promise rows behind an empty state", () => {
		const bare = buildBrowserModel({ engagement: "x", classes: CLASSES, cells: [], inventory: [], hypotheses: [], findings: [] });
		const lines = renderBrowser({ ...opts(initialState("coverage")), model: bare, height: 10 });
		expect(lines.join("\n")).not.toMatch(/↓ \d+ more/);
	});
});

describe("the overlay is opaque", () => {
	// An overlay is composited over the transcript and the rail. The unframed
	// browser padded nothing, so the screen underneath showed through: a recorded
	// session renders "recorsurface · dvbank" — the word "record" from the
	// transcript with the title written over it — and the rail's "─────┤" down the
	// right of every row. Every emitted line must therefore fill the full width.
	it("emits lines of exactly the requested width, in every view", () => {
		for (const v of ["surface", "findings", "coverage", "hypotheses"] as const) {
			for (const w of [60, 80, 104]) {
				for (const l of renderBrowser({ ...opts(initialState(v), w, 6) })) {
					expect(l).toHaveLength(w);
				}
			}
		}
	});
});
