/**
 * Engagement stats derived from the workspace: findings by severity, coverage %,
 * surface size, open blockers. Pure data (no UI); adapters render it.
 */

import { computeCoverage, coveragePercent } from "./coverage.ts";
import type { Fields } from "./identity.ts";
import { attachToElements } from "./target.ts";
import { DISPOSED_STATUSES, type CoverageMatrix, type InventoryKind, type Severity } from "./ontology.ts";
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
