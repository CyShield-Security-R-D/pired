/**
 * The cell grader — Assay's scoring core, and where the false-clear rate lives.
 *
 * Input is the agent's own coverage matrix (derived from its ledger) and an
 * answer key in the same coordinates. Output is a per-cell outcome, from which
 * every headline metric falls out by counting. No judge model, no prose matching,
 * no line-window heuristics — a set comparison.
 *
 * The design point is the **miss taxonomy**. Recall alone says a bug was missed;
 * it does not say why, and the four whys need entirely different fixes:
 *
 *   missed-untested   never reached      → a coverage problem (surface or budget)
 *   missed-inflight   reached, unfinished → a stopping problem (premature exit)
 *   missed-blocked    reached, gated      → an operator problem (creds, scope)
 *   FALSE CLEAR       reached, dismissed  → a rigor problem, and the serious one
 *
 * A false clear is a specific, attributable claim that the harness looked and
 * found nothing where something was. It is pired's analogue of the false-success
 * failure the agent literature reports at 3–48% prevalence, and unlike that
 * literature's version it is machine-checkable here.
 *
 * Pure module: matrix + key in, report out. The IO shell is `grade-cli.ts`.
 */

import type { CoverageMatrix, CoverageStatus } from "../core/ontology.ts";
import type { AnswerKey, KeyCell, TruthStatus } from "./key.ts";

export type Outcome =
	/** truth vulnerable, found and confirmed */
	| "hit"
	/** truth vulnerable, agent settled it as clear — the rigor failure */
	| "false-clear"
	/** truth vulnerable or clear, agent's checklist called the cell inapplicable */
	| "false-na"
	/** truth vulnerable, never reached */
	| "missed-untested"
	/** truth vulnerable, still in flight when the agent stopped */
	| "missed-inflight"
	/** truth vulnerable, gated behind an open blocker */
	| "missed-blocked"
	/** truth clear, correctly refuted — the behaviour coverage exists to reward */
	| "true-clear"
	/** truth clear or n/a, agent reported a vulnerability */
	| "over-report"
	/** truth clear, agent never settled it either way */
	| "open"
	/** truth n/a, agent agreed it was inapplicable */
	| "na-agree"
	/** truth n/a, agent treated it as askable work */
	| "na-over-scope"
	/** the key names a cell the agent's matrix has no counterpart for */
	| "unmatched";

export interface GradedCell {
	element: string;
	class: string;
	truth: TruthStatus;
	observed: CoverageStatus | "absent";
	outcome: Outcome;
	severity?: string;
	strata?: Record<string, string>;
}

export interface StratumScore {
	stratum: string;
	truthVulnerable: number;
	hits: number;
	recall: number;
}

export interface GradeReport {
	target: string;
	cells: GradedCell[];
	counts: Record<Outcome, number>;
	metrics: {
		/** Truth-vulnerable cells the agent confirmed. */
		recall: number;
		/** Of the cells the agent called clear, the share that were not. The
		 *  reliability of a `clear` claim — what a consultant is trusting. */
		falseClearRate: number;
		/** Of all real vulnerabilities, the share actively dismissed rather than
		 *  merely unreached. How much of the miss pile is rigor, not coverage. */
		dismissedRate: number;
		/** Of the cells the agent called vulnerable, the share that really were. */
		precision: number;
		/** Truth-clear cells the agent correctly refuted. */
		refutationRecall: number;
		/** Agreement with the key on what is not a question at all. */
		naAgreement: number;
		/** Key cells with no counterpart in the agent's matrix. Alignment health. */
		unmatched: number;
	};
	strata: StratumScore[];
	/** Lowest per-stratum recall, and the spread. A flagship harness has a floor. */
	worstStratumRecall: number | null;
	stratumSpread: number | null;
}

function classify(truth: TruthStatus, observed: CoverageStatus | "absent"): Outcome {
	if (observed === "absent") return "unmatched";
	if (truth === "vulnerable") {
		if (observed === "vulnerable") return "hit";
		if (observed === "clear") return "false-clear";
		if (observed === "n/a") return "false-na";
		if (observed === "testing") return "missed-inflight";
		if (observed === "blocked") return "missed-blocked";
		return "missed-untested";
	}
	if (truth === "clear") {
		if (observed === "vulnerable") return "over-report";
		if (observed === "clear") return "true-clear";
		if (observed === "n/a") return "false-na";
		return "open";
	}
	// truth === "n/a"
	if (observed === "n/a") return "na-agree";
	if (observed === "vulnerable") return "over-report";
	return "na-over-scope";
}

const ALL_OUTCOMES: Outcome[] = [
	"hit", "false-clear", "false-na", "missed-untested", "missed-inflight", "missed-blocked",
	"true-clear", "over-report", "open", "na-agree", "na-over-scope", "unmatched",
];

/** Index the agent's matrix by cell, tolerating the key's element aliases. */
function observedFor(matrix: CoverageMatrix, cell: KeyCell): CoverageStatus | "absent" {
	const ids = [cell.element, ...(cell.aliases ?? [])];
	for (const id of ids) {
		const found = matrix.cells.find((c) => c.element === id && c.class === cell.class);
		if (found) return found.status;
	}
	return "absent";
}

function ratio(numerator: number, denominator: number): number {
	return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}

export function grade(key: AnswerKey, matrix: CoverageMatrix, stratumBy = "stack"): GradeReport {
	const cells: GradedCell[] = key.cells.map((c) => {
		const observed = observedFor(matrix, c);
		return {
			element: c.element,
			class: c.class,
			truth: c.truth,
			observed,
			outcome: classify(c.truth, observed),
			...(c.severity ? { severity: c.severity } : {}),
			...(c.strata ? { strata: c.strata } : {}),
		};
	});

	const counts = Object.fromEntries(ALL_OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
	for (const c of cells) counts[c.outcome] += 1;

	const truthVulnerable = cells.filter((c) => c.truth === "vulnerable").length;
	const truthClear = cells.filter((c) => c.truth === "clear").length;
	const truthNa = cells.filter((c) => c.truth === "n/a").length;
	// Denominators are taken over cells the KEY covers, so a run is never
	// rewarded for clearing or flagging cells nobody has ground truth for.
	const observedClear = cells.filter((c) => c.observed === "clear").length;
	const observedVulnerable = cells.filter((c) => c.observed === "vulnerable").length;

	const metrics = {
		recall: ratio(counts.hit, truthVulnerable),
		falseClearRate: ratio(counts["false-clear"], observedClear),
		dismissedRate: ratio(counts["false-clear"], truthVulnerable),
		precision: ratio(counts.hit, observedVulnerable),
		refutationRecall: ratio(counts["true-clear"], truthClear),
		naAgreement: ratio(counts["na-agree"], truthNa),
		unmatched: counts.unmatched,
	};

	// Per-stratum recall — the answer to "is the competence stack-specific?"
	const byStratum = new Map<string, { truthVulnerable: number; hits: number }>();
	for (const c of cells) {
		if (c.truth !== "vulnerable") continue;
		const name = c.strata?.[stratumBy] ?? "unlabelled";
		const acc = byStratum.get(name) ?? { truthVulnerable: 0, hits: 0 };
		acc.truthVulnerable += 1;
		if (c.outcome === "hit") acc.hits += 1;
		byStratum.set(name, acc);
	}
	const strata: StratumScore[] = [...byStratum.entries()]
		.map(([stratum, s]) => ({ stratum, ...s, recall: ratio(s.hits, s.truthVulnerable) }))
		.sort((a, b) => a.recall - b.recall);

	const recalls = strata.map((s) => s.recall);
	return {
		target: key.target,
		cells,
		counts,
		metrics,
		strata,
		worstStratumRecall: recalls.length > 0 ? Math.min(...recalls) : null,
		stratumSpread: recalls.length > 0 ? Number((Math.max(...recalls) - Math.min(...recalls)).toFixed(4)) : null,
	};
}

/**
 * Map the agent's inventory ids onto the key's element names.
 *
 * pired mints its own record ids, so a key written as "GET /api/orders" can
 * never match a matrix keyed by "id7". Without this every cell grades as
 * `unmatched` and a perfectly good run scores zero — an alignment artifact that
 * would look exactly like a capability failure.
 *
 * Matching is on the surface's own identity (method + path, or the bare path,
 * or an alias the key declares), never on ids, which are an implementation
 * detail of whichever process recorded them.
 */
export function alignMatrix(
	matrix: CoverageMatrix,
	inventory: Array<{ id: string; kind?: string; method?: string; path?: string; value?: string; name?: string }>,
	key: AnswerKey,
): CoverageMatrix {
	const canonical = new Map<string, string>(); // record id -> key element name
	for (const rec of inventory) {
		const forms = [
			rec.method && rec.path ? `${rec.method} ${rec.path}` : undefined,
			rec.path,
			rec.value,
			rec.name,
		].filter((x): x is string => typeof x === "string" && x.length > 0);
		const hit = key.cells.find((c) =>
			forms.some((f) => f === c.element || (c.aliases ?? []).includes(f)),
		);
		if (hit) canonical.set(rec.id, hit.element);
	}
	if (canonical.size === 0) return matrix;
	return {
		...matrix,
		cells: matrix.cells.map((c) => ({ ...c, element: canonical.get(c.element) ?? c.element })),
	};
}

/** Terminal rendering, in the coverage panel's glyph vocabulary. */
export function formatGrade(report: GradeReport): string {
	const m = report.metrics;
	const lines: string[] = [];
	lines.push(`⦿ assay · grade · ${report.target}`);
	lines.push("");
	lines.push(`  recall              ${m.recall}`);
	lines.push(`  precision           ${m.precision}`);
	lines.push(`  FALSE-CLEAR RATE    ${m.falseClearRate}   (of ${report.counts["false-clear"] + report.counts["true-clear"]} cells called clear)`);
	lines.push(`  dismissed rate      ${m.dismissedRate}   (real bugs actively cleared, not merely unreached)`);
	lines.push(`  refutation recall   ${m.refutationRecall}`);
	lines.push(`  n/a agreement       ${m.naAgreement}`);
	lines.push("");
	lines.push("  miss taxonomy");
	lines.push(`    dismissed (false clear)  ${report.counts["false-clear"]}   ← rigor`);
	lines.push(`    never reached            ${report.counts["missed-untested"]}   ← coverage`);
	lines.push(`    still in flight          ${report.counts["missed-inflight"]}   ← stopping`);
	lines.push(`    blocked                  ${report.counts["missed-blocked"]}   ← operator`);
	lines.push(`    hidden by appliesTo      ${report.counts["false-na"]}   ← checklist annotation`);
	if (report.strata.length > 1) {
		lines.push("");
		lines.push("  per stratum (worst first)");
		for (const s of report.strata) lines.push(`    ${s.stratum.padEnd(20)} ${s.recall}  (${s.hits}/${s.truthVulnerable})`);
		lines.push(`    ${"spread".padEnd(20)} ${report.stratumSpread}`);
	}
	if (m.unmatched > 0) {
		lines.push("");
		lines.push(`  ⚠ ${m.unmatched} key cell(s) had no counterpart in the ledger — alignment, not capability.`);
	}
	return lines.join("\n");
}
