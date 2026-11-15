/**
 * Stopping telemetry for the v6 harness (3.2): coverage cells still open, and
 * the run's last `record kind=settle` with the ledger writes that followed it.
 *
 * It lives beside the pinned scorer, not in it. eval/dvbank/score.ts must stay
 * byte-identical to the research-pinned 7d43f0d implementation, and the first
 * v6 dry run refused to start because these readers had been added to it. The
 * harness merges this module's result into engagementTelemetry's.
 */
import { existsSync } from "node:fs";
import { Workspace } from "../../core/workspace.ts";
import { lastSettle, writesAfter } from "../../core/settle.ts";
import { computeCoverageView } from "../../core/stats.ts";
import type { SettleRemainder } from "../../core/ontology.ts";
import { makeHostServices } from "../../extensions/lib/host.ts";

export interface SettleTelemetry {
	/** Coverage cells not settled, when the engagement has a checklist. */
	openCells?: number;
	/**
	 * The last `record kind=settle` and how many ledger writes, by anyone but
	 * the scribe or the operator, came after it. Absent when none was written.
	 */
	lastSettle?: { outcome: string; at: string; note?: string; by?: string; laterWrites: number; remainder: SettleRemainder };
}

/** Both readings for one engagement; `{}` when it has neither, or cannot be read. */
export async function settleTelemetry(engagementDir: string): Promise<SettleTelemetry> {
	if (!existsSync(engagementDir)) return {};
	try {
		const ws = new Workspace(engagementDir, makeHostServices());
		return { ...(await openCellsTelemetry(ws)), ...(await lastSettleTelemetry(ws)) };
	} catch {
		return {};
	}
}

/**
 * Coverage cells not settled (untested, in progress or blocked), for the
 * arm-neutral stopping measure: a run that stops with time left and open cells
 * stopped early whether or not it said so. Nothing without a checklist.
 */
async function openCellsTelemetry(ws: Workspace): Promise<{ openCells?: number }> {
	const view = await computeCoverageView(ws);
	if (!view) return {};
	return { openCells: view.matrix.counts["not-tested"] + view.matrix.counts.testing + view.matrix.counts.blocked };
}

/**
 * The run's last settle, with the ledger writes that followed it, for the stop
 * classifier (eval/delegation-compare-stop.ts). Nothing when the run wrote none,
 * which is every baseline run: the baseline has no settle.
 */
async function lastSettleTelemetry(ws: Workspace): Promise<Pick<SettleTelemetry, "lastSettle">> {
	const last = lastSettle(await ws.read("sessions"));
	if (!last) return {};
	const rows = [
		...(await ws.read("inventory")), ...(await ws.read("hypotheses")), ...(await ws.read("findings")),
		...(await ws.read("blockers")), ...(await ws.read("loot")),
	];
	return {
		lastSettle: {
			outcome: last.outcome, at: last.createdAt, ...(last.note ? { note: last.note } : {}), ...(last.by ? { by: last.by } : {}),
			laterWrites: writesAfter(last.createdAt, rows), remainder: last.remainder,
		},
	};
}
