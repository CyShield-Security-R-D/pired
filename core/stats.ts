/**
 * Engagement stats derived from the workspace: findings by severity, coverage %,
 * surface size, open blockers. Pure data (no UI); adapters render it.
 */

import { computeCoverage } from "./coverage.ts";
import type { InventoryKind, Severity } from "./ontology.ts";
import type { Workspace } from "./workspace.ts";

const DEFAULT_SURFACE_KINDS: InventoryKind[] = ["endpoint", "host"];

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
	const inventory = await ws.read("inventory");
	const surfaceElements = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind));

	let coveragePct: number | undefined;
	const checklist = await ws.readChecklist();
	if (checklist) {
		const matrix = computeCoverage({
			classes: checklist.classes,
			elements: surfaceElements.map((r) => ({ id: r.id })),
			hypotheses: await ws.read("hypotheses"),
			openBlockers,
		});
		const total = matrix.cells.length;
		coveragePct = total > 0 ? Math.round(((matrix.counts.clear + matrix.counts.vulnerable) / total) * 100) : 0;
	}

	return {
		findings: bySeverity,
		findingsTotal: findings.length,
		coveragePct,
		surface: surfaceElements.length,
		blockers: openBlockers.length,
	};
}
