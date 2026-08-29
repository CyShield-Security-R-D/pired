/**
 * Continuity probes — "memory that outlives the turn", measured across a cold
 * restart.
 *
 * The system prompt tells the model to trust the workspace over its own memory.
 * That is only true if a brand-new process, given nothing but the directory,
 * reconstructs the same engagement. Here a restart is simulated exactly: a
 * second `Workspace` instance is opened over the same filesystem with no shared
 * state, and every store, derived view and update rule is compared.
 *
 * Resumption fidelity is the metric — the share of persisted state a cold start
 * recovers.
 */

import { computeCoverageView } from "../../core/stats.ts";
import { makeFakeServices } from "../../core/testing/fakes.ts";
import { Workspace } from "../../core/workspace.ts";
import type { EndpointRecord, FindingRecord, HypothesisRecord } from "../../core/ontology.ts";
import type { CaseResult, Probe, ProbeResult } from "../types.ts";

const DIR = "/ws/continuity";

export const continuityProbe: Probe = {
	name: "cold-restart-fidelity",
	family: "continuity",
	description: "A second process opening the same directory reconstructs the engagement exactly.",
	async run(): Promise<ProbeResult> {
		const cases: CaseResult[] = [];
		const svc = makeFakeServices();

		// --- session 1 -------------------------------------------------------
		const s1 = await Workspace.open(DIR, "acme", svc);
		const ep = (id: string, path: string): EndpointRecord => ({
			v: 1, id, kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path,
		});
		await s1.append("inventory", ep("e1", "/login"));
		await s1.append("inventory", ep("e2", "/admin"));
		await s1.append("inventory", ep("e3", "/orders"));
		await s1.writeChecklist({
			v: 1,
			targetType: "web",
			classes: [
				{ id: "authz", title: "Access control", appliesTo: ["endpoint"] },
				{ id: "sqli", title: "SQL injection", appliesTo: ["endpoint", "param"] },
			],
		});
		const hyp = (id: string, target: string, cls: string, outcome: HypothesisRecord["outcome"]): HypothesisRecord => ({
			v: 1, id, kind: "hypothesis", createdAt: "t", statement: id, target, class: cls, outcome,
		});
		await s1.append("hypotheses", hyp("y1", "e1", "sqli", "proposed"));
		await s1.append("hypotheses", hyp("y2", "e2", "authz", "confirmed"));
		await s1.append("findings", {
			v: 1, id: "f1", kind: "finding", createdAt: "t", title: "IDOR on /admin", severity: "high", target: "e2", status: "open",
		} satisfies FindingRecord);
		await s1.appendNote("session one findings");

		// An in-flight hypothesis resolved later in the same session: last write wins.
		await s1.append("hypotheses", hyp("y1", "e1", "sqli", "refuted"));
		// A record retracted via tombstone.
		await s1.append("inventory", { ...ep("e3", "/orders"), deleted: true } as EndpointRecord & { deleted: true });

		const before = {
			inventory: (await s1.read("inventory")).map((r) => r.id).sort(),
			hypotheses: (await s1.read("hypotheses")).length,
			findings: (await s1.read("findings")).length,
			notes: (await s1.readNotes()).trim(),
			coverage: (await computeCoverageView(s1))?.matrix,
		};

		// --- cold restart ----------------------------------------------------
		// New instance, same fs, nothing carried over in memory.
		const s2 = new Workspace(DIR, svc);
		const after = {
			inventory: (await s2.read("inventory")).map((r) => r.id).sort(),
			hypotheses: (await s2.read("hypotheses")).length,
			findings: (await s2.read("findings")).length,
			notes: (await s2.readNotes()).trim(),
			coverage: (await computeCoverageView(s2))?.matrix,
		};

		const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
		const checks: Array<[string, boolean, string, string]> = [
			["inventory-survives", eq(before.inventory, after.inventory), before.inventory.join(","), after.inventory.join(",")],
			["tombstone-survives", !after.inventory.includes("e3"), "e3 absent", after.inventory.join(",")],
			["hypotheses-survive", before.hypotheses === after.hypotheses, `${before.hypotheses}`, `${after.hypotheses}`],
			["findings-survive", before.findings === after.findings, `${before.findings}`, `${after.findings}`],
			["notes-survive", before.notes === after.notes, before.notes, after.notes],
			["checklist-survives", (await s2.readChecklist())?.classes.length === 2, "2 classes", `${(await s2.readChecklist())?.classes.length}`],
			["coverage-identical", eq(before.coverage, after.coverage), "same matrix", eq(before.coverage, after.coverage) ? "same matrix" : "diverged"],
		];

		let recovered = 0;
		for (const [id, ok, exp, act] of checks) {
			if (ok) recovered += 1;
			cases.push({ id, verdict: ok ? "pass" : "fail", expected: exp, actual: act });
		}

		// Last-write-wins must resolve the same way after a restart, or the agent
		// re-tests settled work.
		const y1 = (await s2.read("hypotheses")).find((h) => h.id === "y1");
		cases.push({
			id: "update-semantics-survive",
			verdict: y1?.outcome === "refuted" ? "pass" : "fail",
			expected: "y1 outcome=refuted (last write wins)",
			actual: `${y1?.outcome}`,
			note: "if an update does not survive restart, settled cells reopen and work is redone",
		});

		// Positive control: prove the restarted workspace reads disk rather than a
		// cached snapshot — a write through s1 after the restart must be visible in s2.
		await s1.append("findings", {
			v: 1, id: "f2", kind: "finding", createdAt: "t", title: "late finding", severity: "low", target: "e1", status: "open",
		} satisfies FindingRecord);
		const sees = (await s2.read("findings")).some((f) => f.id === "f2");
		cases.push({
			id: "reads-disk-not-cache",
			verdict: sees ? "pass" : "fail",
			expected: "a concurrent append is visible",
			actual: sees ? "visible" : "not visible",
			note: "positive control: without this the comparisons above could pass on a stale in-memory copy",
		});

		const fidelity = recovered / checks.length;
		return {
			probe: "cold-restart-fidelity",
			family: "continuity",
			cases,
			metrics: { "continuity.resumption_fidelity": Number(fidelity.toFixed(3)) },
		};
	},
};
