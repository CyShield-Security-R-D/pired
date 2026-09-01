/**
 * Engagement stats derived from the workspace: findings by severity, coverage %,
 * surface size, open blockers. Pure data (no UI); adapters render it.
 */

import { computeCoverage, coveragePercent } from "./coverage.ts";
import { DISPOSED_STATUSES, type CoverageMatrix, type InventoryKind, type Severity } from "./ontology.ts";
import type { Workspace } from "./workspace.ts";

const DEFAULT_SURFACE_KINDS: InventoryKind[] = ["endpoint", "host"];

/** The coverage matrix plus the labels needed to render it. */
export interface CoverageView {
	matrix: CoverageMatrix;
	classes: Array<{ id: string; title: string }>;
	elementIds: string[];
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
	const matrix = computeCoverage({
		classes: checklist.classes,
		elements,
		hypotheses: await ws.read("hypotheses"),
		openBlockers: (await ws.read("blockers")).filter((b) => b.status === "open"),
	});
	return { matrix, classes: checklist.classes.map((c) => ({ id: c.id, title: c.title || c.id })), elementIds };
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
