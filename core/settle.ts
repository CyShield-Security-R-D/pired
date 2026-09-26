/**
 * Settling a session: `record kind=settle` (Phase 3, 3.2).
 *
 * A session that stops has so far had one way to say where it stands: prose,
 * and prose is where "shall I continue?" lives. research/12 measured 32 of 41
 * baseline and 31 of 37 candidate Luna runs ending by saying the review was
 * incomplete and offering to continue; unattended, such a run simply ends, and
 * what it left open is recoverable only by reading the closing paragraph.
 *
 * A settle is that closing written to the ledger: an outcome (finished, paused
 * or blocked), a note, and a remainder the harness computes from the ledger
 * itself — open cells, unmapped areas, unverified findings by who created
 * them, inconclusive hypotheses, open blockers and budget spent. The caller's
 * own account of what remains is never taken: a model that could write its
 * remainder could write it empty.
 *
 * It never refuses. Refusing a settle while work remains would turn a record
 * into a gate, and a gate on stopping is a step script by another name. The
 * reply lists what remains and says settling ends nothing; what to do about the
 * list stays the reviewer's call.
 *
 * Pure module: core imports only.
 */

import { deriveAreas, renderAreas, type AreasView } from "./areas.ts";
import { formatTokens } from "./budget.ts";
import { isUnchallenged } from "./challenge.ts";
import type {
	BlockerRecord,
	BudgetReading,
	CoverageCell,
	FindingRecord,
	HypothesisRecord,
	InventoryKind,
	InventoryRecord,
	SettleRecord,
	SettleRemainder,
} from "./ontology.ts";
import { DISPOSED_STATUSES, LEAD_AUTHOR, OPERATOR_AUTHOR, SCRIBE_AUTHOR } from "./ontology.ts";
import { computeCoverageView } from "./stats.ts";
import type { Workspace } from "./workspace.ts";

/** The key for rows written before `by` existed. */
export const UNKNOWN_AUTHOR = "(unknown)";

export interface SettleLedger {
	inventory: InventoryRecord[];
	surfaceKinds: InventoryKind[];
	/** The coverage matrix's cells, or undefined when there is no checklist to build one from. */
	cells: CoverageCell[] | undefined;
	hypotheses: HypothesisRecord[];
	findings: FindingRecord[];
	blockers: BlockerRecord[];
	/** The directory-only source listing, when the host has one. */
	dirs?: string[];
	root?: string;
	budget?: BudgetReading;
}

/**
 * One read of everything a settle, `recall status` or the tail block needs. The
 * matrix is the coverage view's, which attaches claims to elements recorded
 * after them, so the open-cell count agrees with the panel's.
 */
export async function readSettleLedger(
	ws: Workspace,
	opts: { surfaceKinds: InventoryKind[]; dirs?: string[]; root?: string; budget?: BudgetReading },
): Promise<SettleLedger> {
	const view = await computeCoverageView(ws, opts.surfaceKinds);
	return {
		inventory: await ws.read("inventory"),
		surfaceKinds: opts.surfaceKinds,
		cells: view?.matrix.cells,
		hypotheses: await ws.read("hypotheses"),
		findings: await ws.read("findings"),
		blockers: await ws.read("blockers"),
		...(opts.dirs ? { dirs: opts.dirs } : {}),
		...(opts.root ? { root: opts.root } : {}),
		...(opts.budget ? { budget: opts.budget } : {}),
	};
}

/** The areas view over the same ledger the remainder is computed from. */
export function settleAreas(ledger: SettleLedger): AreasView {
	return deriveAreas({
		inventory: ledger.inventory,
		surfaceKinds: ledger.surfaceKinds,
		cells: ledger.cells ?? [],
		// A disposed finding is a decision, not something an area still holds.
		findings: ledger.findings.filter((f) => !(DISPOSED_STATUSES as readonly string[]).includes(f.status)),
		...(ledger.dirs ? { dirs: ledger.dirs } : {}),
		...(ledger.root ? { root: ledger.root } : {}),
	});
}

/**
 * What remains, from the ledger alone. Each part is present only when there
 * is something to say or something was measured: an engagement with no
 * checklist has no cells to count, not zero open ones.
 */
export function settleRemainder(ledger: SettleLedger, areas: AreasView = settleAreas(ledger)): SettleRemainder {
	const out: SettleRemainder = {};
	if (ledger.cells) {
		out.openCells = ledger.cells.filter((c) => c.status === "not-tested" || c.status === "testing" || c.status === "blocked").length;
	}
	if (areas.unmapped.length > 0) out.unmappedAreas = areas.unmapped;
	const unverified: Record<string, string[]> = {};
	for (const f of ledger.findings) {
		if (!isUnchallenged(f)) continue;
		(unverified[f.by ?? UNKNOWN_AUTHOR] ??= []).push(f.id);
	}
	if (Object.keys(unverified).length > 0) out.unverified = unverified;
	const inconclusive = ledger.hypotheses.filter((h) => h.outcome === "inconclusive").map((h) => h.id);
	if (inconclusive.length > 0) out.inconclusive = inconclusive;
	const blockers = ledger.blockers.filter((b) => b.status === "open").map((b) => b.id);
	if (blockers.length > 0) out.openBlockers = blockers;
	if (ledger.budget) out.spent = { ...ledger.budget.spent };
	return out;
}

/** "6.1M tokens · 52 min", or "" when nothing was measured. */
export function renderSpent(spent: SettleRemainder["spent"]): string {
	if (!spent) return "";
	const parts: string[] = [];
	if (spent.tokens !== undefined) parts.push(`${formatTokens(spent.tokens)} tokens`);
	if (spent.minutes !== undefined) parts.push(`${Math.floor(spent.minutes)} min`);
	return parts.join(" · ");
}

/** The remainder as lines, one per part that holds something. */
export function remainderLines(r: SettleRemainder): string[] {
	const lines: string[] = [];
	if (r.openCells !== undefined) lines.push(`- test cases not settled (untested, in progress or blocked): ${r.openCells}`);
	if (r.unverified) {
		const by = Object.entries(r.unverified).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([who, ids]) => `${who}: ${ids.join(", ")}`);
		lines.push(`- findings nobody has challenged, by who recorded them — ${by.join("; ")}`);
	}
	if (r.inconclusive) lines.push(`- inconclusive hypotheses: ${r.inconclusive.join(", ")}`);
	if (r.openBlockers) lines.push(`- open blockers: ${r.openBlockers.join(", ")}`);
	if (r.unmappedAreas) lines.push(`- source directories with no recorded surface: ${r.unmappedAreas.join(", ")}`);
	const spent = renderSpent(r.spent);
	if (spent) lines.push(`- spent so far: ${spent}`);
	return lines;
}

/**
 * The reply to a settle. It restates the remainder in full, the areas in
 * full, and says in plain words that the session goes on: a settle is a
 * record of where things stand, not a way out.
 */
export function renderSettleReply(record: SettleRecord, areas: AreasView, ignoredRemainder: boolean): string {
	const lines = [
		`Settled ${record.id} (${record.outcome})${record.note ? `: ${record.note}` : "."}`,
		"Settling records where the engagement stands; it does not end the session. The ledger is where the next session starts.",
	];
	const remainder = remainderLines(record.remainder);
	lines.push(remainder.length > 0 ? "What remains, computed from the ledger:" : "The ledger shows nothing open.", ...remainder);
	const listed = renderAreas(areas);
	if (listed.length > 0) lines.push("Areas:", ...listed);
	if (ignoredRemainder) lines.push("The remainder sent with this call was not used: what is recorded is the ledger's own.");
	return lines.join("\n");
}

/**
 * The lead's newest settle, or undefined when it has none. Only the lead's
 * count: the record tool refuses anyone else's, and a row by another author
 * (written around it, or before that refusal) must not stand for the session.
 */
export function lastSettle(settles: SettleRecord[]): SettleRecord | undefined {
	return settles
		.filter((s) => s.by === LEAD_AUTHOR)
		.reduce<SettleRecord | undefined>((last, s) => (!last || s.createdAt >= last.createdAt ? s : last), undefined);
}

/** One line for `recall status`. */
export function renderLastSettle(record: SettleRecord | undefined): string {
	if (!record) return "settled    never";
	const r = record.remainder;
	const open: string[] = [];
	if (r.openCells !== undefined) open.push(`${r.openCells} open cell(s)`);
	const unverified = Object.values(r.unverified ?? {}).reduce((n, ids) => n + ids.length, 0);
	if (unverified > 0) open.push(`${unverified} unchallenged finding(s)`);
	if (r.inconclusive?.length) open.push(`${r.inconclusive.length} inconclusive`);
	if (r.openBlockers?.length) open.push(`${r.openBlockers.length} open blocker(s)`);
	if (r.unmappedAreas?.length) open.push(`${r.unmappedAreas.length} unmapped dir(s)`);
	return `settled    ${record.outcome} at ${record.createdAt}${record.note ? ` — ${record.note}` : ""}${open.length > 0 ? ` (left: ${open.join(", ")})` : ""}`;
}

/**
 * Writes that are not the session working on: the scribe transcribes review
 * the lead already wrote, and the operator answers from outside it.
 */
const NOT_WORK: ReadonlySet<string> = new Set([SCRIBE_AUTHOR, OPERATOR_AUTHOR]);

/**
 * Ledger rows written after `at`, by anyone but the scribe or the operator: the
 * work that supersedes a settle. A model that settles and then keeps going did
 * not stop where it settled, so the settle does not describe its stop (the
 * stop classifier, ADR-030 as amended by 3.2). A row's latest version is read,
 * so an update after the settle counts as a write after it.
 */
export function writesAfter(at: string, rows: Array<{ createdAt?: string; updatedAt?: string; by?: string }>): number {
	return rows.filter((r) => !NOT_WORK.has(r.by ?? "") && ((r.updatedAt ?? r.createdAt ?? "") > at)).length;
}

/**
 * The outcome of the lead's last settle when no work has been written since,
 * else undefined. The budget line reads it at the ceiling, so a session that
 * has settled is told it has rather than asked again every request.
 */
export async function standingSettle(ws: Workspace): Promise<SettleRecord["outcome"] | undefined> {
	const last = lastSettle(await ws.read("sessions"));
	if (!last) return undefined;
	const rows = [
		...(await ws.read("inventory")), ...(await ws.read("hypotheses")), ...(await ws.read("findings")),
		...(await ws.read("blockers")), ...(await ws.read("loot")),
	];
	return writesAfter(last.createdAt, rows) === 0 ? last.outcome : undefined;
}
