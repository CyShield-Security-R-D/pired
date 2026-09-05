import { describe, expect, it } from "vitest";
import type { EndpointRecord, FindingRecord, HypothesisRecord, InventoryRecord } from "./ontology.ts";
import { claimCounts, computeCoverageView, computeEngagementStats, unwrittenHypotheses } from "./stats.ts";
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

/**
 * The ledger held 120 confirmed cells and zero findings, and the panel,
 * /findings and /report all said there was nothing. ADR-004.
 */
describe("confirmed work that has not reached the report", () => {
	function hyp(partial: Partial<HypothesisRecord> & Pick<HypothesisRecord, "id">): HypothesisRecord {
		return {
			v: 1, kind: "hypothesis", createdAt: "t", statement: "S", target: "e1",
			class: "sqli", outcome: "confirmed", ...partial,
		};
	}
	function fnd(partial: Partial<FindingRecord> & Pick<FindingRecord, "id">): FindingRecord {
		return {
			v: 1, kind: "finding", createdAt: "t", title: "T", severity: "high",
			target: "e1", class: "sqli", status: "confirmed", ...partial,
		};
	}

	it("counts a confirmed claim nobody wrote up", () => {
		expect([...unwrittenHypotheses([hyp({ id: "h1" })], [])]).toEqual(["h1"]);
	});

	it("says nothing about refuted or in-flight claims", () => {
		// Refuting a class is finished work; it belongs in the coverage section of
		// the report, not in a list of things still owed to the client.
		const rows = [hyp({ id: "h1", outcome: "refuted" }), hyp({ id: "h2", outcome: "proposed" })];
		expect(unwrittenHypotheses(rows, []).size).toBe(0);
	});

	it("treats a finding on the same cell as the write-up, with no link recorded", () => {
		// Both link fields exist and neither was populated once across a whole
		// engagement, so a count that depended on them would read zero forever.
		expect(unwrittenHypotheses([hyp({ id: "h1" })], [fnd({ id: "f1" })]).size).toBe(0);
	});

	it("honours an explicit link even when the cells do not match", () => {
		const rows = [hyp({ id: "h1", target: "e1", class: "sqli" })];
		const found = [fnd({ id: "f1", target: "e9", class: "authz", hypothesisId: "h1" })];
		expect(unwrittenHypotheses(rows, found).size).toBe(0);
		// And the other direction, which is the field the hypothesis carries.
		expect(unwrittenHypotheses([hyp({ id: "h2", findingId: "f9" })], []).size).toBe(0);
	});

	it("does not let a different class on the same element count as the write-up", () => {
		const found = [fnd({ id: "f1", target: "e1", class: "authz" })];
		expect([...unwrittenHypotheses([hyp({ id: "h1", class: "sqli" })], found)]).toEqual(["h1"]);
	});

	it("joins a claim written as a route to a finding written against the element id", () => {
		// Resolution follows the same rules the matrix uses, so the two ledgers
		// agree about what a cell is.
		const inventory: InventoryRecord[] = [
			{ v: 1, kind: "endpoint", id: "e1", createdAt: "t", host: "h", method: "POST", path: "/api/login" },
		];
		const rows = [hyp({ id: "h1", target: "POST /api/login" })];
		expect(unwrittenHypotheses(rows, [fnd({ id: "f1", target: "e1" })], inventory).size).toBe(0);
	});

	// A reviewer writes one finding for one argument, not one per endpoint it was
	// asked of. Counting cells called 13 of 14 claims unwritten on a real ledger
	// where the true answer was one.
	it("treats a claim as written once any of its cells has a finding", () => {
		const rows = ["e1", "e2", "e3"].map((target, i) =>
			hyp({ id: `h${i}`, target, statement: "Raw SQL is interpolated" }));
		expect(unwrittenHypotheses(rows, [fnd({ id: "f1", target: "e1" })]).size).toBe(0);
	});

	it("still owes the claims that were fanned out beside it and never written", () => {
		const rows = [
			hyp({ id: "h1", target: "e1", statement: "Raw SQL is interpolated" }),
			hyp({ id: "h2", target: "e2", statement: "Raw SQL is interpolated" }),
			hyp({ id: "h3", target: "e1", class: "ssrf", statement: "url param is fetched server-side" }),
			hyp({ id: "h4", target: "e2", class: "ssrf", statement: "url param is fetched server-side" }),
		];
		// The sqli claim is covered; the ssrf one is not, and both of its rows are
		// owed because they are the same unwritten argument.
		expect([...unwrittenHypotheses(rows, [fnd({ id: "f1", target: "e1" })])].sort())
			.toEqual(["h3", "h4"]);
	});

	it("does not let a dismissed finding stand in for a write-up", () => {
		// An accepted risk or a false positive is a decision about a claim, not a
		// write-up of it — and the report would carry neither.
		const found = [fnd({ id: "f1", status: "false-positive" })];
		expect([...unwrittenHypotheses([hyp({ id: "h1" })], found)]).toEqual(["h1"]);
	});
});

