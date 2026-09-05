import { describe, expect, it } from "vitest";
import type { EndpointRecord, FindingRecord, HypothesisRecord } from "./ontology.ts";
import { claimCounts, computeCoverageView, computeEngagementStats } from "./stats.ts";
import { makeFakeServices } from "./testing/fakes.ts";
import { Workspace } from "./workspace.ts";

describe("computeEngagementStats", () => {
	it("counts findings by severity and open blockers", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open("/ws/s", "s", svc);
		const f = (id: string, sev: FindingRecord["severity"]): FindingRecord => ({
			v: 1, id, kind: "finding", createdAt: "t", title: id, severity: sev, target: "e1", status: "open",
		});
		await ws.append("findings", f("a", "high"));
		await ws.append("findings", f("b", "high"));
		await ws.append("findings", f("c", "low"));
		await ws.append("blockers", { v: 1, id: "b1", kind: "blocker", createdAt: "t", type: "decision", question: "q", priority: "high", status: "open" });

		const stats = await computeEngagementStats(ws);
		expect(stats.findingsTotal).toBe(3);
		expect(stats.findings.high).toBe(2);
		expect(stats.findings.low).toBe(1);
		expect(stats.blockers).toBe(1);
	});

	it("computes coverage when a checklist and surface exist", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open("/ws/s2", "s", svc);
		const endpoint: EndpointRecord = { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path: "/x" };
		await ws.append("inventory", endpoint);
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }] });
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "authz", outcome: "confirmed" });

		const stats = await computeEngagementStats(ws);
		expect(stats.surface).toBe(1);
		expect(stats.coveragePct).toBe(100);
	});
});

describe("computeCoverageView applicability", () => {
	it("drops classes that do not apply to the recorded surface from coverage", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open("/ws/s3", "s", svc);
		const endpoint: EndpointRecord = { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path: "/x" };
		await ws.append("inventory", endpoint);
		await ws.writeChecklist({
			v: 1,
			targetType: "web",
			classes: [
				{ id: "authz", title: "Access control", appliesTo: ["endpoint"] },
				{ id: "tls", title: "TLS", appliesTo: ["host"] },
			],
		});
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "authz", outcome: "confirmed" });

		const view = await computeCoverageView(ws);
		expect(view?.matrix.cells).toHaveLength(2);
		expect(view?.matrix.applicable).toBe(1);
		// tls is unanswerable against an endpoint, so it must not drag this to 50%.
		expect((await computeEngagementStats(ws)).coveragePct).toBe(100);
	});
});


describe("claims recorded before the element they name", () => {
	/**
	 * `record` resolves a target when the row is written, which is too early on
	 * its own: the review reasons about a route and maps it a turn later, and the
	 * row keeps the raw label forever. Measured across the ledgers on one machine,
	 * 192 of dvbank's 207 unattached hypotheses named an element that its own
	 * inventory already held — 47 coverage cells of work that was done, recorded,
	 * and invisible.
	 */
	async function ledger(name: string) {
		const svc = makeFakeServices();
		const ws = await Workspace.open(`/ws/${name}`, name, svc);
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }] });
		// The claim first, the element second — the order a review actually
		// produces them in.
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "checked", target: "/api/register", class: "authz", outcome: "refuted" });
		const endpoint: EndpointRecord = { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h1", method: "POST", path: "/api/register" };
		await ws.append("inventory", endpoint);
		return ws;
	}

	it("counts the cell once the element exists", async () => {
		const ws = await ledger("late1");
		const view = await computeCoverageView(ws);
		expect(view?.matrix.cells[0]?.status).toBe("clear");
		expect((await computeEngagementStats(ws)).coveragePct).toBe(100);
	});

	it("adds nothing to the denominator while doing it", async () => {
		// The property that makes this safe to ship: resolving attaches claims to
		// elements that already exist and never invents one, so the number can only
		// rise, and it rises because work that was done is finally counted.
		const ws = await ledger("late2");
		const view = await computeCoverageView(ws);
		expect(view?.matrix.applicable).toBe(1);
		expect(view?.unattached).toBe(0);
	});

	it("reports the claims that still reach no cell", async () => {
		const ws = await ledger("late3");
		await ws.append("hypotheses", { v: 1, id: "y2", kind: "hypothesis", createdAt: "t", statement: "checked", target: "withUser", class: "authz", outcome: "refuted" });
		const view = await computeCoverageView(ws);
		// Said out loud rather than dropped: it is testing the percentage cannot
		// account for, and only the operator can decide whether the thing it names
		// should have been mapped as surface.
		expect(view?.unattached).toBe(1);
	});
});

/**
 * Measured on a real engagement: the panel read "confirmed 120" over a ledger
 * holding 15 distinct claims, because `record` writes the (target x class) cross
 * product and every row is a cell. Cells are what the coverage bar counts; this
 * is what the hypotheses section counts. ADR-001.
 */
describe("counting claims rather than the cells they were asked of", () => {
	function hyp(partial: Partial<HypothesisRecord> & Pick<HypothesisRecord, "id">): HypothesisRecord {
		return {
			v: 1, kind: "hypothesis", createdAt: "t", statement: "S", target: "e1",
			class: "sqli", outcome: "confirmed", ...partial,
		};
	}

	it("folds one claim asked of many targets into one", () => {
		const rows = ["e1", "e2", "e3", "e4"].map((target, i) =>
			hyp({ id: `h${i}`, target, statement: "Raw SQL queries interpolate registration input" }));
		expect(claimCounts(rows)).toEqual({ confirmed: 1 });
	});

	it("keeps the same words asked of a different class apart", () => {
		expect(claimCounts([
			hyp({ id: "h1", class: "sqli", statement: "User input reaches a sink" }),
			hyp({ id: "h2", class: "cmdi", statement: "User input reaches a sink" }),
		])).toEqual({ confirmed: 2 });
	});

	it("ignores whitespace and case, which a re-worded claim differs by and nothing else", () => {
		expect(claimCounts([
			hyp({ id: "h1", statement: "Raw SQL is interpolated" }),
			hyp({ id: "h2", target: "e2", statement: "  raw   sql IS interpolated  " }),
		])).toEqual({ confirmed: 1 });
	});

	it("counts a claim under each outcome it actually reached", () => {
		// Confirmed on one route and refuted on another is two facts about one
		// claim, not the same fact counted twice.
		expect(claimCounts([
			hyp({ id: "h1", target: "e1", outcome: "confirmed" }),
			hyp({ id: "h2", target: "e2", outcome: "refuted" }),
			hyp({ id: "h3", target: "e3", outcome: "refuted" }),
		])).toEqual({ confirmed: 1, refuted: 1 });
	});

	it("does not collapse every unwritten claim into one", () => {
		// A blank statement falls back to the row's own id. Two claims nobody
		// bothered to word are still two claims.
		expect(claimCounts([
			hyp({ id: "h1", statement: "" }),
			hyp({ id: "h2", target: "e2", statement: "   " }),
		])).toEqual({ confirmed: 2 });
	});

	it("has nothing to say about a row with no outcome yet", () => {
		expect(claimCounts([hyp({ id: "h1", outcome: undefined })])).toEqual({});
		expect(claimCounts([])).toEqual({});
	});
});
