import { describe, expect, it } from "vitest";
import type { EndpointRecord, FindingRecord } from "./ontology.ts";
import { computeCoverageView, computeEngagementStats } from "./stats.ts";
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
