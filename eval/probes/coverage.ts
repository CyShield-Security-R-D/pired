/**
 * Coverage-semantics probes — the metric everything else is measured in.
 *
 * Recall@cell, the false-clear rate and the compounding slope are all expressed
 * against the coverage matrix, so a silent drift in what counts as a cell moves
 * every downstream number at once without any of them looking wrong. The unit
 * tests check these rules in isolation; this probe ratchets the *invariants*, so
 * a refactor cannot quietly redefine the denominator.
 *
 * Written the week `appliesTo` / `n/a` landed, for exactly that reason.
 */

import { computeCoverage, coveragePercent } from "../../core/coverage.ts";
import type { HypothesisRecord, InventoryKind } from "../../core/ontology.ts";
import type { CaseResult, Probe, ProbeResult } from "../types.ts";

const SCOPED = [
	{ id: "tls", appliesTo: ["host"] as InventoryKind[] },
	{ id: "sqli", appliesTo: ["endpoint", "param"] as InventoryKind[] },
];
const MIXED: Array<{ id: string; kind: InventoryKind }> = [
	{ id: "h1", kind: "host" },
	{ id: "e1", kind: "endpoint" },
];

const hyp = (id: string, target: string, cls: string, outcome: HypothesisRecord["outcome"]): HypothesisRecord => ({
	v: 1, id, kind: "hypothesis", createdAt: "t", statement: id, target, class: cls, outcome,
});

export const coverageProbe: Probe = {
	name: "coverage-semantics",
	family: "coverage",
	description: "The denominator every Assay metric is expressed in cannot drift silently.",
	async run(): Promise<ProbeResult> {
		const cases: CaseResult[] = [];
		const check = (id: string, ok: boolean, expected: string, actual: string, note?: string): void => {
			cases.push({ id, verdict: ok ? "pass" : "fail", expected, actual, note });
		};

		const m = computeCoverage({ classes: SCOPED, elements: MIXED, hypotheses: [], openBlockers: [] });
		check("applicability-shrinks-the-denominator", m.applicable === 2 && m.cells.length === 4,
			"4 cells, 2 applicable", `${m.cells.length} cells, ${m.applicable} applicable`,
			"positive control: if appliesTo is ignored these are equal and the metric silently inflates");

		const settled = computeCoverage({
			classes: SCOPED, elements: MIXED, hypotheses: [hyp("y1", "e1", "sqli", "refuted")], openBlockers: [],
		});
		check("percent-divides-by-applicable", coveragePercent(settled) === 50,
			"50% (1 of 2 askable)", `${coveragePercent(settled)}%`,
			"the raw 4-cell grid would read 25% — that difference is the whole point of the change");

		const evidenced = computeCoverage({
			classes: SCOPED, elements: MIXED, hypotheses: [hyp("y1", "h1", "sqli", "confirmed")], openBlockers: [],
		});
		const cell = evidenced.cells.find((c) => c.element === "h1" && c.class === "sqli");
		check("evidence-outranks-taxonomy", cell?.status === "vulnerable",
			"vulnerable", `${cell?.status}`,
			"a confirmed finding must never be hidden by an annotation calling its cell inapplicable");

		const none = computeCoverage({
			classes: [{ id: "tls", appliesTo: ["host"] as InventoryKind[] }],
			elements: [{ id: "e1", kind: "endpoint" }], hypotheses: [], openBlockers: [],
		});
		check("no-applicable-cells-is-zero-not-nan", coveragePercent(none) === 0 && none.applicable === 0,
			"0% with 0 applicable", `${coveragePercent(none)}% with ${none.applicable}`);

		const unannotated = computeCoverage({
			classes: [{ id: "tls" }, { id: "sqli" }], elements: MIXED, hypotheses: [], openBlockers: [],
		});
		check("unannotated-checklist-unchanged", unannotated.applicable === unannotated.cells.length,
			"every cell applicable", `${unannotated.applicable} of ${unannotated.cells.length}`,
			"an operator's own checklist without appliesTo must behave exactly as before");

		return {
			probe: "coverage-semantics",
			family: "coverage",
			cases,
			metrics: { "coverage.invariants_held": cases.filter((c) => c.verdict === "pass").length },
		};
	},
};
