/**
 * Engagement stats derived from the workspace: findings by severity, coverage %,
 * surface size, open blockers. Pure data (no UI); adapters render it.
 */

import { computeCoverage } from "./coverage.ts";
import type { CoverageMatrix, InventoryKind, Severity } from "./ontology.ts";
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
	const elementIds = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind)).map((r) => r.id);
	const matrix = computeCoverage({
		classes: checklist.classes,
		elements: elementIds.map((id) => ({ id })),
		hypotheses: await ws.read("hypotheses"),
		openBlockers: (await ws.read("blockers")).filter((b) => b.status === "open"),
	});
	return { matrix, classes: checklist.classes.map((c) => ({ id: c.id, title: c.title || c.id })), elementIds };
}

/** Share of cells that are settled (clear or vulnerable), as a whole percent. */
export function coveragePercent(matrix: CoverageMatrix): number {
	const total = matrix.cells.length;
	return total > 0 ? Math.round(((matrix.counts.clear + matrix.counts.vulnerable) / total) * 100) : 0;
}

export interface EngagementStats {
	findings: Record<Severity, number>;
	findingsTotal: number;
	coveragePct?: number;
	surface: number;
	blockers: number;
}

export async function computeEngagementStats(
	ws: Workspace,
	surfaceKinds: InventoryKind[] = DEFAULT_SURFACE_KINDS,
): Promise<EngagementStats> {
	const findings = await ws.read("findings");
	const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	for (const f of findings) bySeverity[f.severity] += 1;

	const openBlockers = (await ws.read("blockers")).filter((b) => b.status === "open");
	const view = await computeCoverageView(ws, surfaceKinds);
	const inventory = await ws.read("inventory");
	const surfaceElements = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind));

	return {
		findings: bySeverity,
		findingsTotal: findings.length,
		coveragePct: view ? coveragePercent(view.matrix) : undefined,
		surface: surfaceElements.length,
		blockers: openBlockers.length,
	};
}
