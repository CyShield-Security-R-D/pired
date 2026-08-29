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
