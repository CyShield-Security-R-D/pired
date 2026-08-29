/**
 * Grader probes — the scorer is itself a detector, so it gets planted defects.
 *
 * Every Assay headline number is produced by `grade()`. If it silently
 * misclassifies one outcome, every run scored afterwards is wrong in a way no
 * individual result looks wrong. So the fixture below drives the agent's matrix
 * to a known status in each cell, pairs it with a key of known truth, and
 * asserts the exact outcome for all twelve classifications — including the one
 * that matters most, a real vulnerability the agent settled as `clear`.
 */

import { computeCoverage } from "../../core/coverage.ts";
import type { BlockerRecord, HypothesisRecord, InventoryKind } from "../../core/ontology.ts";
import { alignMatrix, grade } from "../grade.ts";
import { validateKey } from "../key.ts";
import type { AnswerKey } from "../key.ts";
import type { CaseResult, Probe, ProbeResult } from "../types.ts";

const EP: InventoryKind = "endpoint";
const elements = [
	{ id: "e1", kind: EP },
	{ id: "e2", kind: EP },
];
// cNa applies to hosts only, so every (endpoint, cNa) cell is n/a — the lever
// that lets the fixture produce an `n/a` observation on demand.
const classes = [
	{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }, { id: "c5" }, { id: "c6" },
	{ id: "cNa", appliesTo: ["host"] as InventoryKind[] },
];

const hyp = (id: string, target: string, cls: string, outcome: HypothesisRecord["outcome"]): HypothesisRecord => ({
	v: 1, id, kind: "hypothesis", createdAt: "t", statement: id, target, class: cls, outcome,
});
const blk = (id: string, blocks: string[]): BlockerRecord => ({
	v: 1, id, kind: "blocker", createdAt: "t", type: "credential-request", question: id, priority: "high", status: "open", blocks,
});

const matrix = computeCoverage({
	classes,
	elements,
	hypotheses: [
		hyp("y1", "e1", "c1", "confirmed"),  // e1:c1 -> vulnerable
		hyp("y2", "e1", "c2", "refuted"),    // e1:c2 -> clear
		hyp("y3", "e1", "c4", "proposed"),   // e1:c4 -> testing
		hyp("y4", "e2", "c1", "confirmed"),  // e2:c1 -> vulnerable
		hyp("y5", "e2", "c2", "refuted"),    // e2:c2 -> clear
	],
	openBlockers: [blk("b1", ["e1:c5"])],   // e1:c5 -> blocked
});

const KEY: AnswerKey = {
	v: 1,
	target: "grader-fixture",
	cells: [
		{ element: "e1", class: "c1", truth: "vulnerable", sink: "a.py:1", strata: { stack: "python" } },
		{ element: "e1", class: "c2", truth: "vulnerable", sink: "a.py:2", strata: { stack: "python" } },
		{ element: "e1", class: "cNa", truth: "vulnerable", sink: "a.py:3", strata: { stack: "python" } },
		{ element: "e1", class: "c3", truth: "vulnerable", sink: "a.py:4", strata: { stack: "java" } },
		{ element: "e1", class: "c4", truth: "vulnerable", sink: "a.py:5", strata: { stack: "java" } },
		{ element: "e1", class: "c5", truth: "vulnerable", sink: "a.py:6", strata: { stack: "java" } },
		{ element: "e2", class: "c2", truth: "clear", why: "parameterized query" },
		{ element: "e2", class: "c1", truth: "clear", why: "ownership check present" },
		{ element: "e2", class: "c3", truth: "clear", why: "no sink on this route" },
		{ element: "e2", class: "cNa", truth: "n/a" },
		{ element: "e2", class: "c6", truth: "n/a" },
		{ element: "ghost", class: "c1", truth: "vulnerable", sink: "z.py:9", strata: { stack: "go" } },
		// alias: the agent recorded this surface as e1, the key names it canonically
		{ element: "POST /login", class: "c1", truth: "vulnerable", sink: "a.py:1", aliases: ["e1"], strata: { stack: "python" } },
	],
};

export const graderProbe: Probe = {
	name: "cell-grader",
	family: "grader",
	description: "Every outcome classification, including the false clear, proven against a planted fixture.",
	async run(): Promise<ProbeResult> {
		const cases: CaseResult[] = [];
		const check = (id: string, ok: boolean, expected: string, actual: string, note?: string): void => {
			cases.push({ id, verdict: ok ? "pass" : "fail", expected, actual, note });
		};

		const key = validateKey(KEY);
		const report = grade(key, matrix);
		const outcomeOf = (element: string, cls: string): string =>
			report.cells.find((c) => c.element === element && c.class === cls)?.outcome ?? "MISSING";

		const expectations: Array<[string, string, string, string?]> = [
			["e1", "c1", "hit"],
			["e1", "c2", "false-clear", "the flagship: a real vulnerability the agent settled as clear"],
			["e1", "cNa", "false-na", "a real vulnerability hidden by an appliesTo annotation"],
			["e1", "c3", "missed-untested", "never reached — a coverage problem"],
			["e1", "c4", "missed-inflight", "reached but unfinished — a stopping problem"],
			["e1", "c5", "missed-blocked", "gated — an operator problem"],
			["e2", "c2", "true-clear", "a genuine refutation must be credited, not merely unpunished"],
			["e2", "c1", "over-report", "reported vulnerable where the key says clear"],
			["e2", "c3", "open", "truth clear, never settled either way"],
			["e2", "cNa", "na-agree"],
			["e2", "c6", "na-over-scope", "the checklist treats an inapplicable cell as work"],
			["ghost", "c1", "unmatched", "alignment failure must be visible, never scored as a miss"],
			["POST /login", "c1", "hit", "an alias resolves to the element the agent actually recorded"],
		];

		for (const [element, cls, want, note] of expectations) {
			const got = outcomeOf(element, cls);
			check(`classifies/${want}`, got === want, want, got, note);
		}

		// Metric arithmetic, counted off the fixture: eight truth-vulnerable cells
		// (six on e1, ghost, and the aliased one), of which two are hit. The ghost
		// cell stays in the denominator on purpose — an unmatched key cell is an
		// unfound vulnerability from the client's point of view, however it failed.
		check("metric/recall", report.metrics.recall === 0.25, "0.25 (2 hits of 8 truth-vulnerable)", `${report.metrics.recall}`);
		// cells observed clear = e1:c2 (false) + e2:c2 (true) = 2, of which 1 wrong
		check("metric/false-clear-rate", report.metrics.falseClearRate === 0.5,
			"0.5 — half of everything called clear was wrong", `${report.metrics.falseClearRate}`,
			"this is the reliability of a `clear` claim, which is what a consultant is trusting");
		check("metric/dismissed-rate", report.metrics.dismissedRate === 0.125,
			"0.125 (1 of 8 real bugs actively dismissed)", `${report.metrics.dismissedRate}`);
		check("metric/refutation-recall", report.metrics.refutationRecall === 0.3333,
			"0.3333 (1 of 3 truth-clear cells refuted)", `${report.metrics.refutationRecall}`);
		check("metric/unmatched-reported", report.metrics.unmatched === 1, "1", `${report.metrics.unmatched}`,
			"alignment health is reported separately so a naming mismatch never masquerades as a capability gap");

		// Stratification: python 2/4, java 0/3, go 0/1 -> worst 0, spread 0.5
		const python = report.strata.find((s) => s.stratum === "python");
		check("strata/per-stratum-recall", python?.recall === 0.5, "python 0.5 (2/4)", `${python?.recall}`);
		check("strata/worst-and-spread", report.worstStratumRecall === 0 && report.stratumSpread === 0.5,
			"worst 0, spread 0.5", `worst ${report.worstStratumRecall}, spread ${report.stratumSpread}`,
			"the floor and the spread are the answer to 'is this competence stack-specific?'");

		// Alignment: the agent's minted ids must resolve to the key's element names,
		// or a good run grades as all-unmatched — an artifact that looks like failure.
		const idMatrix = computeCoverage({
			classes: [{ id: "c1" }],
			elements: [{ id: "id7", kind: EP }],
			hypotheses: [hyp("z1", "id7", "c1", "confirmed")],
			openBlockers: [],
		});
		const idKey = validateKey({
			v: 1, target: "align", cells: [{ element: "GET /api/orders", class: "c1", truth: "vulnerable", sink: "a.py:1" }],
		});
		const alignedReport = grade(idKey, alignMatrix(idMatrix, [{ id: "id7", kind: "endpoint", method: "GET", path: "/api/orders" }], idKey));
		check("aligns/minted-ids-to-key-elements", alignedReport.counts.hit === 1 && alignedReport.counts.unmatched === 0,
			"hit via method+path resolution", `hit=${alignedReport.counts.hit} unmatched=${alignedReport.counts.unmatched}`,
			"pired mints its own record ids; without resolution every cell grades unmatched");

		// Key validation must refuse assertions dressed as ground truth.
		const rejects = (bad: unknown, why: string): void => {
			let threw = false;
			try {
				validateKey(bad);
			} catch {
				threw = true;
			}
			check(`validates/${why}`, threw, "rejected", threw ? "rejected" : "ACCEPTED");
		};
		rejects({ v: 1, target: "t", cells: [{ element: "e", class: "c", truth: "vulnerable" }] }, "vulnerable-without-sink-or-poc");
		rejects({ v: 1, target: "t", cells: [{ element: "e", class: "c", truth: "clear" }] }, "clear-without-a-reason");
		rejects({ v: 1, target: "t", cells: [
			{ element: "e", class: "c", truth: "n/a" }, { element: "e", class: "c", truth: "n/a" },
		] }, "duplicate-cells");

		return {
			probe: "cell-grader",
			family: "grader",
			cases,
			metrics: { "grader.classifications_held": cases.filter((c) => c.verdict === "pass").length },
		};
	},
};
