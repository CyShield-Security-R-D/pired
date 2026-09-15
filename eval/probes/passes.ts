/**
 * Pass probes — the claim that a settled matrix is not a finished engagement.
 *
 * `research/06` measured the failure this family exists to catch. A session
 * opened a persisted ledger, found every applicable cell settled, and stopped:
 * 105 seconds, zero new findings, zero new hypotheses. Nothing was broken —
 * `selectNext` routes to `not-tested` by construction, so an exhausted matrix
 * really does mean the route sweep is done, and the agent read that correctly.
 *
 * ADR-018's answer is that a pass carries a lens and later lenses route to work
 * the matrix cannot see. That is a claim about pure functions, so it is testable
 * here with no model and no target: sweep the share of cells that have been
 * cleared, and assert that where the route sweep runs dry with clearances
 * outstanding, the adversarial lens does not.
 *
 * Two positive controls hold the family honest. A lens that always returned
 * something would pass the sweep trivially, so the drained case asserts the
 * queue empties once every clearance has had its second look. And the whole
 * mechanism has to be inert when it is off, so pass 1's worklist is asserted
 * equal to the matrix's own gap list, cell for cell.
 */

import { computeCoverage, findGaps, selectNext } from "../../core/coverage.ts";
import type { CoverageMatrix, HypothesisRecord, InventoryKind, PassLens } from "../../core/ontology.ts";
import { lensForPass, planPass, promoteLens, resolveLadder } from "../../core/passes.ts";
import type { CaseResult, Probe, ProbeResult } from "../types.ts";

const CLASSES = [{ id: "authz" }, { id: "sqli" }, { id: "xss" }, { id: "logic" }];
const ELEMENTS: Array<{ id: string; kind: InventoryKind }> = Array.from(
	{ length: 5 },
	(_, i) => ({ id: `e${i}`, kind: "endpoint" as InventoryKind }),
);

function cleared(element: string, cls: string, i: number, recheckedd = false): HypothesisRecord {
	return {
		v: 1,
		id: `h${i}`,
		kind: "hypothesis",
		createdAt: `2026-09-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
		statement: `no sink of this class is reachable on ${element}`,
		target: element,
		class: cls,
		outcome: "refuted",
		...(recheckedd ? { verification: { verdict: "stands" as const, at: "2026-09-02T00:00:00Z", basis: [`${element}.go:1`] } } : {}),
	};
}

/** Clear `share` of the matrix, optionally marking every clearance re-checked. */
function at(share: number, recheckedd = false): { matrix: CoverageMatrix; hypotheses: HypothesisRecord[] } {
	const hypotheses: HypothesisRecord[] = [];
	let i = 0;
	for (const el of ELEMENTS) {
		for (const cls of CLASSES) {
			if (i / (ELEMENTS.length * CLASSES.length) < share) hypotheses.push(cleared(el.id, cls.id, i, recheckedd));
			i += 1;
		}
	}
	return {
		matrix: computeCoverage({ classes: CLASSES, elements: ELEMENTS, hypotheses, openBlockers: [] }),
		hypotheses,
	};
}

export const passesProbe: Probe = {
	name: "pass-lenses",
	family: "passes",
	description: "A settled matrix ends the route sweep, not the engagement: later lenses route to work the matrix cannot see.",
	async run(): Promise<ProbeResult> {
		const cases: CaseResult[] = [];
		let stalls = 0;

		// Inertness. With nothing configured there is no ladder, and pass 1's
		// worklist is the matrix's own gap list — so an engagement that never opted
		// in behaves exactly as it did before passes existed. Every number in
		// research/ was measured against that behaviour.
		cases.push({
			id: "off-by-default/no-ladder",
			verdict: resolveLadder(undefined) === undefined && resolveLadder({ enabled: false }) === undefined ? "pass" : "fail",
			expected: "no ladder without configuration",
			actual: String(resolveLadder(undefined)),
		});

		const half = at(0.5);
		const routePlan = planPass({ pass: 1, lens: "route", matrix: half.matrix });
		const untested = findGaps(half.matrix).filter((g) => g.reason === "not-tested");
		cases.push({
			id: "off-by-default/pass-1-is-the-matrix",
			verdict: routePlan.total === untested.length
				&& routePlan.items.every((it, i) => it.ref === `${untested[i]?.element}:${untested[i]?.class}`)
				? "pass"
				: "fail",
			expected: `${untested.length} cells, in matrix order`,
			actual: `${routePlan.total} cells`,
			note: "the route lens must not become a second derivation of the gap list",
		});

		// The sweep. As clearances accumulate the route sweep empties; a stall is a
		// point where it is empty, clearances are outstanding, and the next lens has
		// nothing either. That is the 105-second session, mechanically.
		for (const share of [0, 0.25, 0.5, 0.75, 1]) {
			const { matrix, hypotheses } = at(share);
			const routeNext = selectNext(matrix);
			const adversarial = planPass({ pass: 2, lens: "adversarial", matrix, hypotheses });
			const outstanding = hypotheses.filter((h) => h.verification === undefined).length;
			const stalled = routeNext === undefined && outstanding > 0 && adversarial.total === 0;
			if (stalled) stalls += 1;

			cases.push({
				id: `cleared/${Math.round(share * 100)}%/work-remains`,
				verdict: stalled ? "fail" : "pass",
				expected: outstanding > 0 ? "some lens can reach the outstanding clearances" : "nothing outstanding",
				actual: `route=${routeNext ? "cell" : "empty"} adversarial=${adversarial.total}`,
				note: share === 1 ? "the exhausted-matrix case: research/06's session stopped here" : undefined,
			});

			cases.push({
				id: `cleared/${Math.round(share * 100)}%/every-clearance-reachable`,
				verdict: adversarial.total === outstanding ? "pass" : "fail",
				expected: `${outstanding} unverified clearances reachable`,
				actual: `${adversarial.total}`,
			});
		}

		// Positive control: a lens that always returned work would pass the sweep
		// without testing anything. Once every clearance has had its second look the
		// queue must actually drain.
		const done = at(1, true);
		const drained = planPass({ pass: 2, lens: "adversarial", matrix: done.matrix, hypotheses: done.hypotheses });
		cases.push({
			id: "drains/rechecked-clearances-leave-the-queue",
			verdict: drained.total === 0 ? "pass" : "fail",
			expected: "0 — every clearance has been through a second look",
			actual: `${drained.total}`,
			note: "positive control: if the lens cannot empty, the sweep above proves nothing",
		});

		// The ladder is an order, and reordering it must never cost a rung.
		const ladder: PassLens[] = ["route", "file", "invariant", "adversarial"];
		let lost = 0;
		for (let pass = 1; pass <= 6; pass += 1) {
			for (const lens of ladder) {
				const moved = promoteLens(ladder, pass, lens);
				if (!ladder.every((l) => moved.includes(l))) lost += 1;
				if (lensForPass(moved, pass) !== lens) lost += 1;
			}
		}
		cases.push({
			id: "ladder/promoting-a-lens-loses-nothing",
			verdict: lost === 0 ? "pass" : "fail",
			expected: "every rung survives, and the named lens lands on the open pass",
			actual: `${lost} violation(s)`,
			note: "it once overwrote the rung, dropping a lens from the session with nothing saying so",
		});

		return {
			probe: "pass-lenses",
			family: "passes",
			cases,
			metrics: {
				"passes.router_stalls": stalls,
				"passes.cases": cases.length,
			},
		};
	},
};
