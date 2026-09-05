/**
 * Engagement stats derived from the workspace: findings by severity, coverage %,
 * surface size, open blockers. Pure data (no UI); adapters render it.
 */

import { computeCoverage, coveragePercent } from "./coverage.ts";
import type { Fields } from "./identity.ts";
import { attachToElements, buildTargetIndex, resolveElementTarget } from "./target.ts";
import { DISPOSED_STATUSES, type CoverageMatrix, type FindingRecord, type HypothesisRecord, type InventoryKind, type InventoryRecord, type Severity } from "./ontology.ts";
import type { Workspace } from "./workspace.ts";

const DEFAULT_SURFACE_KINDS: InventoryKind[] = ["endpoint", "host"];

/** The coverage matrix plus the labels needed to render it. */
export interface CoverageView {
	matrix: CoverageMatrix;
	classes: Array<{ id: string; title: string }>;
	elementIds: string[];
	/**
	 * Claims that settle no cell: they name nothing in the inventory, or they name
	 * something that is not part of the surface this matrix measures.
	 *
	 * Shown rather than swallowed. It is testing that was done and recorded and
	 * that the number cannot see, and the operator is the only one who can decide
	 * whether the thing it names should have been mapped as surface in the first
	 * place.
	 */
	unattached: number;
}

/**
 * Derive the coverage matrix for the engagement's current surface, or undefined
 * when no checklist has been seeded yet. Shared by the stats rollup and the
 * `/coverage` panel so both read the same derivation.
 */
export async function computeCoverageView(
	ws: Workspace,
	surfaceKinds: InventoryKind[] = DEFAULT_SURFACE_KINDS,
): Promise<CoverageView | undefined> {
	const checklist = await ws.readChecklist();
	if (!checklist) return undefined;
	const inventory = await ws.read("inventory");
	// Kind travels with the element: computeCoverage needs it to apply each
	// class's `appliesTo` and mark the cells that are not questions at all.
	const elements = inventory
		.filter((r) => surfaceKinds.includes(r.kind as InventoryKind))
		.map((r) => ({ id: r.id, kind: r.kind as InventoryKind }));
	const elementIds = elements.map((e) => e.id);
	// Resolve targets against the inventory as it stands NOW.
	//
	// `record` resolves when a row is written, and that is too early on its own:
	// the element is often recorded after the claim about it, and a row that
	// failed to resolve then kept the raw label forever. Measured across the
	// ledgers on one machine, 192 of dvbank's 207 unattached hypotheses named an
	// element that its own inventory already held. This only attaches claims to
	// elements that exist, so the denominator cannot move — the numerator counts
	// work that was already recorded and could not be seen.
	const { hypotheses, unattached } = attachToElements(
		await ws.read("hypotheses"),
		inventory as unknown as Fields[],
	);
	const matrix = computeCoverage({
		classes: checklist.classes,
		elements,
		hypotheses,
		openBlockers: (await ws.read("blockers")).filter((b) => b.status === "open"),
	});
	// Counted after resolution, and over the matrix rather than over the
	// inventory: a claim that names nothing and a claim that names a param when
	// the surface is routes and hosts are both work this percentage cannot
	// account for, which is the question the number is being asked.
	void unattached;
	const inMatrix = new Set(elementIds);
	return {
		matrix,
		classes: checklist.classes.map((c) => ({ id: c.id, title: c.title || c.id })),
		elementIds,
		unattached: hypotheses.filter((h) => !inMatrix.has(h.target)).length,
	};
}

// Re-exported so existing importers keep their one import site; the definition
// lives in coverage.ts beside the matrix it measures.
export { coveragePercent };

export interface EngagementStats {
	/** By severity, open work only — disposed findings are not counted here. */
	findings: Record<Severity, number>;
	findingsTotal: number;
	/** Accepted, dismissed or set aside: still in the ledger, out of the count. */
	disposed: number;
	coveragePct?: number;
	surface: number;
	blockers: number;
}

/**
 * One claim, however many cells it was asked of.
 *
 * `record` takes lists for `target` and `class` and writes the cross product, and
 * hypothesis identity is `(target, class)` — so a row is a coverage cell, not a
 * piece of reasoning. One argument about authentication, put to 44 endpoints, is
 * 44 rows, and a panel that labelled them "confirmed 44" invited the operator to
 * read 44 discovered bugs. Measured on a real engagement: 120 confirmed rows
 * carrying 15 distinct claims.
 *
 * Cells are what the coverage bar counts. This is what the hypotheses section
 * counts, so the two numbers stop competing to describe the same ledger. A claim
 * asked of several cells and settled differently across them is counted under
 * each outcome it actually reached — that is two facts about one claim, not
 * double-counting. See ADR-001.
 */
/**
 * The identity of a claim: its class and its wording, however many cells it was
 * asked of. A blank statement falls back to the row's own id rather than
 * collapsing every unworded claim into one.
 */
function claimKey(h: HypothesisRecord): string {
	const text = (h.statement ?? "").trim().replace(/\s+/g, " ").toLowerCase();
	return `${h.class ?? ""}\u0000${text || h.id}`;
}

export function claimCounts(hypotheses: HypothesisRecord[]): Record<string, number> {
	const seen = new Map<string, Set<string>>();
	for (const h of hypotheses) {
		if (!h.outcome) continue;
		const key = claimKey(h);
		const set = seen.get(h.outcome) ?? new Set<string>();
		set.add(key);
		seen.set(h.outcome, set);
	}
	const out: Record<string, number> = {};
	for (const [outcome, set] of seen) out[outcome] = set.size;
	return out;
}

/** One coverage cell, as a string two ledgers can be joined on. */
function cellKey(target: string, cls: string): string {
	return `${target}\u0000${cls}`;
}

/**
 * Confirmed work that has not reached the report.
 *
 * Confirming a hypothesis and writing a finding are separate acts, and only the
 * second reaches the client. Measured on a real engagement: the ledger held 120
 * confirmed cells and zero findings, and every surface agreed there was nothing
 * — the panel said "none recorded", `/findings` said the same, and `/report`
 * declined to write. Given time the model did write nine of the ten confirmed
 * classes up, so it is a window rather than a hole; it is a window an operator
 * can ship a report in.
 *
 * The unit is the CLAIM, not the cell. `record` fans one piece of reasoning
 * across every target it applies to, and a reviewer who writes that finding up
 * writes it once — so on the engagement this was built against, a cell-level
 * count called 13 of 14 claims unwritten when the true answer was one. A claim
 * is written up when any of its cells has a finding; the rows it did not name
 * individually are the same argument, not further work owed.
 *
 * The join is by cell, because the link fields cannot be relied on:
 * `FindingRecord.hypothesisId` and `HypothesisRecord.findingId` both exist and
 * neither was populated once in the whole run, so a count that depended on them
 * would read zero forever. An explicit link is honoured when it is there, and
 * otherwise a finding covers a hypothesis when they name the same element and
 * the same class.
 *
 * Targets are resolved through the same rules the coverage matrix uses, so a
 * claim written as "/api/login" and a finding written against that element's id
 * are recognised as the same cell rather than counted as unwritten. A disposed
 * finding covers nothing: an accepted risk or a dismissed false positive is a
 * decision about a claim, not a write-up of it. See ADR-004.
 */
export function unwrittenHypotheses(
	hypotheses: HypothesisRecord[],
	findings: FindingRecord[],
	inventory: InventoryRecord[] = [],
): Set<string> {
	const index = buildTargetIndex(inventory as unknown as Fields[]);
	const resolve = (t: unknown): string | undefined =>
		typeof t === "string" ? (resolveElementTarget(t, index) ?? t) : undefined;

	const covered = new Set<string>();
	const linked = new Set<string>();
	for (const f of findings) {
		if (isDisposed(f.status)) continue;
		if (f.hypothesisId) linked.add(f.hypothesisId);
		const target = resolve(f.target);
		if (target && f.class) covered.add(cellKey(target, f.class));
	}

	// First pass: which claims are represented in the report at all.
	const confirmed = hypotheses.filter((h) => h.outcome === "confirmed");
	const writtenClaims = new Set<string>();
	for (const h of confirmed) {
		const target = resolve(h.target);
		const byCell = target !== undefined && h.class !== undefined && covered.has(cellKey(target, h.class));
		if (h.findingId || linked.has(h.id) || byCell) writtenClaims.add(claimKey(h));
	}

	// Second pass: every row of a claim nothing was written for.
	const out = new Set<string>();
	for (const h of confirmed) {
		if (!writtenClaims.has(claimKey(h))) out.add(h.id);
	}
	return out;
}

/** Is this finding settled — accepted, dismissed or set aside — rather than open work? */
export function isDisposed(status: string | undefined): boolean {
	return (DISPOSED_STATUSES as readonly string[]).includes(status ?? "");
}

export async function computeEngagementStats(
	ws: Workspace,
	surfaceKinds: InventoryKind[] = DEFAULT_SURFACE_KINDS,
): Promise<EngagementStats> {
	// Disposed findings leave the count without leaving the ledger. An accepted
	// risk and a dismissed false positive are decisions, not open work, and a
	// header number that can only ever go up is one the operator stops reading.
	const all = await ws.read("findings");
	const findings = all.filter((f) => !isDisposed(f.status));
	const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	for (const f of findings) bySeverity[f.severity] += 1;

	const openBlockers = (await ws.read("blockers")).filter((b) => b.status === "open");
	const view = await computeCoverageView(ws, surfaceKinds);
	const inventory = await ws.read("inventory");
	const surfaceElements = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind));

	return {
		findings: bySeverity,
		findingsTotal: findings.length,
		disposed: all.length - findings.length,
		coveragePct: view ? coveragePercent(view.matrix) : undefined,
		surface: surfaceElements.length,
		blockers: openBlockers.length,
	};
}
