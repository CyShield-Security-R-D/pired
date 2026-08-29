/**
 * Router probes — the "never stall" claim, measured mechanically.
 *
 * pired's momentum guarantee is that an engagement routes around blocked work
 * rather than fixating on it. `selectNext` is the mechanism, and it is pure, so
 * the guarantee is testable without a model: sweep blocker density from 0 to
 * 100% and assert the router keeps handing back actionable cells until there
 * genuinely are none, and never hands back a cell that cannot be worked.
 *
 * The waste ratio is the metric that matters operationally: the share of the
 * matrix that is blocked yet still surfaced as work.
 */

import { computeCoverage, findGaps, selectNext } from "../../core/coverage.ts";
import type { BlockerRecord, InventoryKind } from "../../core/ontology.ts";
import type { CaseResult, Probe, ProbeResult } from "../types.ts";

const CLASSES = [{ id: "authz" }, { id: "sqli" }, { id: "xss" }, { id: "logic" }];

function elements(n: number): Array<{ id: string; kind: InventoryKind }> {
	return Array.from({ length: n }, (_, i) => ({ id: `e${i}`, kind: "endpoint" as InventoryKind }));
}

function blocker(id: string, blocks: string[]): BlockerRecord {
	return {
		v: 1,
		id,
		kind: "blocker",
		createdAt: "t",
		type: "decision",
		question: id,
		priority: "medium",
		status: "open",
		blocks,
	};
}

/** Block the first `share` of elements outright (element-level blockers gate every cell). */
function matrixAt(share: number, elementCount = 10) {
	const els = elements(elementCount);
	const blockedCount = Math.round(elementCount * share);
	const openBlockers = els.slice(0, blockedCount).map((e, i) => blocker(`b${i}`, [e.id]));
	return computeCoverage({ classes: CLASSES, elements: els, hypotheses: [], openBlockers });
}

export const routerProbe: Probe = {
	name: "non-blocking-router",
	family: "router",
	description: "selectNext keeps returning actionable work as blocker density rises, and never returns blocked work.",
	async run(): Promise<ProbeResult> {
		const cases: CaseResult[] = [];
		let worstWaste = 0;

		for (const share of [0, 0.2, 0.5, 0.8]) {
			const m = matrixAt(share);
			const next = selectNext(m);
			const actionable = m.cells.filter((c) => c.status === "not-tested" || c.status === "testing").length;

			cases.push({
				id: `density/${Math.round(share * 100)}%/returns-actionable`,
				verdict: next !== undefined && actionable > 0 ? "pass" : actionable === 0 && next === undefined ? "pass" : "fail",
				expected: actionable > 0 ? "a cell is returned" : "no cell is returned",
				actual: next ? `${next.element}:${next.class} (${next.status})` : "undefined",
			});

			cases.push({
				id: `density/${Math.round(share * 100)}%/never-blocked`,
				verdict: next === undefined || (next.status !== "blocked" && next.status !== "n/a") ? "pass" : "fail",
				expected: "returned cell is workable",
				actual: next ? next.status : "undefined",
				note: "handing back blocked work is the stall this guarantee exists to prevent",
			});

			const waste = m.cells.length > 0 ? m.counts.blocked / m.cells.length : 0;
			worstWaste = Math.max(worstWaste, waste);
		}

		// Fully blocked: the router must admit there is nothing to do rather than loop.
		const all = matrixAt(1);
		cases.push({
			id: "density/100%/terminates",
			verdict: selectNext(all) === undefined ? "pass" : "fail",
			expected: "undefined — nothing is workable",
			actual: selectNext(all) ? "a cell was returned" : "undefined",
			note: "positive control: if this passes trivially the sweep above proves nothing",
		});

		// Blocked work must stay visible as a gap, or routing around it becomes dropping it.
		const half = matrixAt(0.5);
		const gaps = findGaps(half);
		const blockedGaps = gaps.filter((g) => g.reason === "blocked").length;
		cases.push({
			id: "blocked-work-stays-visible",
			verdict: blockedGaps === half.counts.blocked ? "pass" : "fail",
			expected: `${half.counts.blocked} blocked cells reported as gaps`,
			actual: `${blockedGaps}`,
			note: "routing around a blocker must not delete it from the engagement's todo list",
		});

		return {
			probe: "non-blocking-router",
			family: "router",
			cases,
			metrics: { "router.worst_waste_ratio": Number(worstWaste.toFixed(3)) },
		};
	},
};
