/**
 * Coverage: derived, never stored (FORMAT.md §11, PLAN.md §6).
 *
 * coverage = checklist classes × surface elements, with each cell's status
 * derived from hypothesis outcomes and open blockers. This is the rigor layer's
 * output: `gaps` drives "what to test next", and `selectNext` drives the
 * non-blocking router (skip blocked work, do the next actionable cell).
 *
 * Pure module: arrays in, matrix out. No ports, no I/O.
 */

import { COVERAGE_STATUSES } from "./ontology.ts";
import type {
	BlockerRecord,
	CoverageCell,
	CoverageGap,
	CoverageMatrix,
	CoverageStatus,
	HypothesisRecord,
	InventoryKind,
} from "./ontology.ts";

export interface CoverageInput {
	/** Checklist classes to test (the "should"), with their optional applicability. */
	classes: Array<{ id: string; appliesTo?: InventoryKind[] }>;
	/** Surface elements to cover (inventory ids — the "exists"), with their kind. */
	elements: Array<{ id: string; kind?: InventoryKind }>;
	hypotheses: HypothesisRecord[];
	/** Blockers with status "open" only. */
	openBlockers: BlockerRecord[];
}

function cellKey(element: string, cls: string): string {
	return `${element}:${cls}`;
}

/**
 * Is this class askable of this element kind? Unannotated classes apply to
 * everything, and an element of unknown kind is always in — both fail open, so
 * a missing annotation can never silently shrink the denominator.
 */
function applies(appliesTo: InventoryKind[] | undefined, kind: InventoryKind | undefined): boolean {
	if (!appliesTo || appliesTo.length === 0) return true;
	if (!kind) return true;
	return appliesTo.includes(kind);
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
	const existing = map.get(key);
	if (existing) existing.push(value);
	else map.set(key, [value]);
}

export function computeCoverage(input: CoverageInput): CoverageMatrix {
	// Index hypotheses by their (element:class) cell.
	const hypByCell = new Map<string, HypothesisRecord[]>();
	const hypById = new Map<string, HypothesisRecord>();
	for (const h of input.hypotheses) {
		hypById.set(h.id, h);
		const key = cellKey(h.target, h.class);
		const list = hypByCell.get(key);
		if (list) list.push(h);
		else hypByCell.set(key, [h]);
	}

	// Resolve open blockers to the elements/cells they gate.
	const blockersByElement = new Map<string, string[]>();
	const blockersByCell = new Map<string, string[]>();
	for (const b of input.openBlockers) {
		for (const ref of b.blocks ?? []) {
			if (ref.includes(":")) {
				pushInto(blockersByCell, ref, b.id);
			} else if (hypById.has(ref)) {
				const h = hypById.get(ref);
				if (h) pushInto(blockersByCell, cellKey(h.target, h.class), b.id);
			} else {
				pushInto(blockersByElement, ref, b.id);
			}
		}
	}

	const counts = Object.fromEntries(COVERAGE_STATUSES.map((s) => [s, 0])) as Record<CoverageStatus, number>;
	const cells: CoverageCell[] = [];

	for (const el of input.elements) {
		for (const cls of input.classes) {
			const key = cellKey(el.id, cls.id);
			const hyps = hypByCell.get(key) ?? [];
			const blockerIds = [...(blockersByCell.get(key) ?? []), ...(blockersByElement.get(el.id) ?? [])];

			let status: CoverageStatus;
			if (hyps.some((h) => h.outcome === "confirmed")) {
				// Evidence outranks taxonomy: a confirmed hypothesis stays visible even
				// on a cell the checklist calls inapplicable. If someone landed SQLi on
				// a "host", the annotation is wrong — never hide a finding behind it.
				status = "vulnerable";
			} else if (!applies(cls.appliesTo, el.kind)) {
				status = "n/a";
			} else if (blockerIds.length > 0) {
				status = "blocked";
			} else if (hyps.some((h) => h.outcome === "proposed" || h.outcome === "testing" || h.outcome === "inconclusive")) {
				status = "testing";
			} else if (hyps.some((h) => h.outcome === "refuted")) {
				status = "clear";
			} else {
				status = "not-tested";
			}

			const cell: CoverageCell = { element: el.id, class: cls.id, status };
			if (hyps.length > 0) cell.hypothesisIds = hyps.map((h) => h.id);
			if (status === "blocked" && blockerIds.length > 0) cell.blockerIds = blockerIds;
			cells.push(cell);
			counts[status] += 1;
		}
	}

	return { cells, counts, applicable: cells.length - counts["n/a"] };
}

/**
 * Share of askable cells that are settled (clear or vulnerable), as a whole
 * percent. Lives here rather than in stats.ts so the panel can measure without
 * importing the workspace-facing module.
 */
export function coveragePercent(matrix: CoverageMatrix): number {
	const total = matrix.applicable;
	return total > 0 ? Math.round(((matrix.counts.clear + matrix.counts.vulnerable) / total) * 100) : 0;
}

/** Cells that still need work: not yet tested, or blocked pending the operator. */
export function findGaps(matrix: CoverageMatrix): CoverageGap[] {
	const gaps: CoverageGap[] = [];
	for (const c of matrix.cells) {
		if (c.status === "not-tested") gaps.push({ element: c.element, class: c.class, reason: "not-tested" });
		else if (c.status === "blocked") gaps.push({ element: c.element, class: c.class, reason: "blocked" });
	}
	return gaps;
}

/** The next actionable cell for the non-blocking router: prefer untested, then in-progress; skip blocked. */
export function selectNext(matrix: CoverageMatrix): CoverageCell | undefined {
	return matrix.cells.find((c) => c.status === "not-tested") ?? matrix.cells.find((c) => c.status === "testing");
}
