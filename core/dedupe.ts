/**
 * Collapsing duplicates a workspace already has.
 *
 * `record` refuses to create a second row for something it can already name, but
 * that only helps a ledger written since. An engagement carried out before it
 * still holds whatever it accumulated: the same route recorded four times, one
 * coverage cell holding a proposal and the refutation that resolved it, the same
 * bug in the findings list twice under two wordings.
 *
 * This plans the repair and writes nothing. Three properties make it safe to run
 * on real client data:
 *
 *   - **Nothing is thrown away.** A loser is folded into its keeper with the same
 *     merge `record` uses — fields union, severity never falls — and then
 *     tombstoned, which is one more appended line above which every original
 *     still sits. A wrong sweep is undone by hand from the file itself.
 *   - **The oldest row wins.** It keeps its id and its createdAt, so anything
 *     that already points at it still does.
 *   - **References are carried over.** Tombstoning an element that hypotheses
 *     target would strand their cells: they would point at a row `read` no
 *     longer returns, the matrix would lose those columns, and coverage would
 *     silently drop work that was genuinely done. So every reference to a folded
 *     id is rewritten to the keeper first, and hypotheses are grouped after
 *     that, because retargeting is itself a way to discover two rows on one cell.
 *
 * Pure module: ledgers in, a plan out. The adapter shows it and, if the operator
 * says so, writes it.
 */

import { recordLabel } from "./browser.ts";
import { type Fields, findDuplicate, type IdentityKind, mergeRecord } from "./identity.ts";
import { type LedgerRecord, type LedgerStoreName as StoreName, RECORD_VERSION } from "./ontology.ts";

/** The ledgers a sweep reads, as `Workspace.read` returns them. */
export type Ledgers = Record<StoreName, LedgerRecord[]>;

export interface DuplicateGroup {
	store: StoreName;
	kind: IdentityKind;
	/** The row that survives, with everything folded into it. */
	keeper: LedgerRecord;
	/** The rows it absorbs, oldest first. */
	losers: LedgerRecord[];
	/** How the operator recognises what is being collapsed. */
	label: string;
}

export interface CompactionPlan {
	groups: DuplicateGroup[];
	/** Every line to append, by store, in the order it should be written. */
	writes: Array<{ store: StoreName; records: LedgerRecord[] }>;
	/** Rows rewritten because an id they referenced was folded away. */
	retargeted: number;
	/** Rows that will stop being returned by a read. */
	removed: number;
}

/**
 * Meta a merge must not carry over from a loser. `by` among it: the keeper is the
 * oldest row, so its author is the creator, and a fold that let the newest
 * loser's author win would credit the bug to whoever repeated it.
 */
const META = ["v", "id", "kind", "createdAt", "updatedAt", "deleted", "deletedReason", "duplicateOf", "by"];

function content(rec: Fields): Fields {
	const out: Fields = {};
	for (const [k, v] of Object.entries(rec)) if (!META.includes(k)) out[k] = v;
	return out;
}

const KIND_OF_STORE: Record<StoreName, IdentityKind | undefined> = {
	// Inventory holds five kinds; each row carries its own.
	inventory: undefined, hypotheses: "hypothesis", findings: "finding", blockers: "blocker", loot: "loot",
};

/**
 * Rows of one store, grouped by what they are.
 *
 * File order is age order, so the first occurrence is the keeper and everything
 * matching it afterwards is a loser. Matching is done against the keepers alone:
 * three copies of one route are one group of three, not two groups of two.
 */
function groupStore(store: StoreName, records: LedgerRecord[]): DuplicateGroup[] {
	const groups: DuplicateGroup[] = [];
	const keepers: Fields[] = [];
	const byKeeperId = new Map<string, DuplicateGroup>();
	for (const rec of records) {
		const kind = (KIND_OF_STORE[store] ?? (rec.kind as IdentityKind)) as IdentityKind;
		const hit = findDuplicate(kind, rec as unknown as Fields, keepers);
		if (hit) {
			const group = byKeeperId.get(hit.id as string);
			if (group) { group.losers.push(rec); continue; }
		}
		keepers.push(rec as unknown as Fields);
		const group: DuplicateGroup = { store, kind, keeper: rec, losers: [], label: recordLabel(rec) };
		byKeeperId.set(rec.id, group);
		groups.push(group);
	}
	return groups.filter((g) => g.losers.length > 0);
}

/** Fold the losers into the keeper, oldest first, so the newest wording survives. */
function fold(group: DuplicateGroup, now: string): LedgerRecord {
	let merged = content(group.keeper as unknown as Fields);
	for (const loser of group.losers) merged = mergeRecord(group.kind, merged, content(loser as unknown as Fields));
	return {
		...merged,
		v: RECORD_VERSION, id: group.keeper.id, kind: group.keeper.kind,
		createdAt: group.keeper.createdAt, updatedAt: now,
		...(group.keeper.by === undefined ? {} : { by: group.keeper.by }),
	} as unknown as LedgerRecord;
}

function tombstone(loser: LedgerRecord, keeperId: string, now: string): LedgerRecord {
	return {
		...loser, v: RECORD_VERSION, deleted: true, updatedAt: now,
		duplicateOf: keeperId, deletedReason: `folded into ${keeperId}`,
	} as unknown as LedgerRecord;
}

/** Fields that hold an id of another record, by kind. */
const REFERENCES: Partial<Record<string, string[]>> = {
	hypothesis: ["target", "findingId"],
	finding: ["target", "hypothesisId"],
	blocker: ["blocks"],
	loot: ["target"],
	param: ["endpoint"],
	service: ["host"],
	endpoint: ["host"],
	tech: ["host"],
};

/**
 * Rewrite one reference through the remap.
 *
 * A blocker's `blocks` entries are element ids, hypothesis ids, or `id:class`
 * cell coordinates — the last of which has to be remapped by its prefix or the
 * blocker stops gating the cell it was parked on.
 */
function retargetValue(value: unknown, remap: Map<string, string>): unknown {
	if (Array.isArray(value)) return value.map((v) => retargetValue(v, remap));
	if (typeof value !== "string") return value;
	const direct = remap.get(value);
	if (direct) return direct;
	const cut = value.indexOf(":");
	if (cut > 0) {
		const head = remap.get(value.slice(0, cut));
		if (head) return head + value.slice(cut);
	}
	return value;
}

/** The record with every folded id rewritten, or the record itself when none was. */
function retarget(rec: LedgerRecord, remap: Map<string, string>): LedgerRecord {
	const fields = REFERENCES[rec.kind] ?? [];
	let out: Fields | undefined;
	for (const field of fields) {
		const before = (rec as unknown as Fields)[field];
		if (before === undefined) continue;
		const after = retargetValue(before, remap);
		if (JSON.stringify(after) === JSON.stringify(before)) continue;
		out = out ?? { ...(rec as unknown as Fields) };
		out[field] = after;
	}
	return (out ?? rec) as LedgerRecord;
}

const STORES: StoreName[] = ["inventory", "hypotheses", "findings", "blockers", "loot"];

/**
 * What a sweep would do to this workspace.
 *
 * Two rounds, because the first one changes the answer to the second: folding
 * inventory moves hypotheses onto the keeper's id, and two hypotheses that were
 * on different elements can turn out to be on one cell.
 */
export function planCompaction(ledgers: Ledgers, now: string): CompactionPlan {
	const remap = new Map<string, string>();
	const groups: DuplicateGroup[] = [];

	// Round one: the surface, and the references into it.
	const inventoryGroups = groupStore("inventory", ledgers.inventory ?? []);
	for (const g of inventoryGroups) for (const l of g.losers) remap.set(l.id, g.keeper.id);
	groups.push(...inventoryGroups);

	const current: Ledgers = { inventory: [], hypotheses: [], findings: [], blockers: [], loot: [] };
	const changed = new Set<string>();
	let retargeted = 0;
	for (const store of STORES) {
		for (const rec of ledgers[store] ?? []) {
			const next = retarget(rec, remap);
			if (next !== rec) { retargeted += 1; changed.add(`${store}:${rec.id}`); }
			current[store].push(next);
		}
	}

	// Round two: everything keyed on something that just moved.
	for (const store of STORES) {
		if (store === "inventory") continue;
		groups.push(...groupStore(store, current[store]));
	}

	const writes: Array<{ store: StoreName; records: LedgerRecord[] }> = [];
	let removed = 0;
	for (const store of STORES) {
		const records: LedgerRecord[] = [];
		const inGroup = new Set<string>();
		for (const group of groups) {
			if (group.store !== store) continue;
			// The keeper is folded from the retargeted copies, so a sweep never writes
			// back a reference it has just invalidated.
			const live = current[store];
			const keeper = live.find((r) => r.id === group.keeper.id) ?? group.keeper;
			const losers = group.losers.map((l) => live.find((r) => r.id === l.id) ?? l);
			records.push(fold({ ...group, keeper, losers }, now));
			inGroup.add(group.keeper.id);
			for (const loser of losers) {
				records.push(tombstone(loser, group.keeper.id, now));
				inGroup.add(loser.id);
				removed += 1;
			}
		}
		// A row that was only retargeted still needs its line, unless a group above
		// already wrote it.
		for (const rec of current[store]) {
			if (inGroup.has(rec.id) || !changed.has(`${store}:${rec.id}`)) continue;
			records.push({ ...rec, v: RECORD_VERSION, updatedAt: now } as LedgerRecord);
		}
		if (records.length > 0) writes.push({ store, records });
	}

	return { groups, writes, retargeted, removed };
}

/** The sweep as the operator reads it: what would be folded, and into what. */
export function describePlan(plan: CompactionPlan): string[] {
	if (plan.groups.length === 0) return ["No duplicates found — every row in this workspace is already one thing."];
	const lines: string[] = [];
	for (const g of plan.groups) {
		lines.push(`${g.kind} ${g.keeper.id}  ${g.label}`);
		for (const l of g.losers) lines.push(`  ← ${l.id}  ${recordLabel(l)}`);
	}
	lines.push("");
	lines.push(
		`${plan.groups.length} group(s), ${plan.removed} row(s) folded away` +
		(plan.retargeted > 0 ? `, ${plan.retargeted} reference(s) moved to the surviving id` : "") + ".",
	);
	return lines;
}
