/**
 * Which recorded element a target names.
 *
 * A hypothesis settles a coverage cell only when its target IS an element id,
 * and the model does not write ids — it writes what it is looking at:
 * "/api/register", "POST /api/login", "backend/auth.py", "SignupHandler". So
 * every place that has to turn one into the other reads this module, and there
 * is one answer rather than one per caller.
 *
 * Two callers, and the second is why this exists as its own module. `record`
 * resolves a target when the row is WRITTEN. That is too early on its own: the
 * element is often recorded after the claim about it — the review reasons about
 * a route and maps it a turn later — and a row that failed to resolve then kept
 * the raw label forever. Measured across the ledgers on one machine: 192 of
 * dvbank's 207 unattached hypotheses named an element that exists in its
 * inventory, 38 of filebrowser's 54, and every one of them was work the coverage
 * matrix could not see. So coverage resolves again when it is COMPUTED, against
 * the inventory as it stands.
 *
 * Read-time resolution can only attach a claim to an element that already
 * exists. It never invents one, so the matrix's denominator cannot move: a
 * lookup that fails leaves the row exactly where it was.
 *
 * Pure module: records in, ids out.
 */

import type { Fields } from "./identity.ts";

/** Lowercased, whitespace-collapsed, no trailing slash — the form two spellings share. */
function key(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const k = v.trim().toLowerCase().replace(/\s+/g, " ").replace(/\/+$/, "");
	return k.length > 0 ? k : undefined;
}

/**
 * Every way a recorded element might be named.
 *
 * Its id, its path, its path with the method in front, its value, its name. A
 * route recorded as `{method: "GET", path: "/api/x"}` answers to "/api/x" and to
 * "GET /api/x", because the review writes both.
 */
export function elementKeys(rec: Fields): string[] {
	const out: string[] = [];
	const push = (v: unknown): void => {
		const k = key(v);
		if (k && !out.includes(k)) out.push(k);
	};
	push(rec.id);
	push(rec.path);
	if (typeof rec.method === "string" && typeof rec.path === "string") push(`${rec.method} ${rec.path}`);
	push(rec.value);
	push(rec.name);
	return out;
}

/**
 * The inventory, keyed for lookup.
 *
 * `named` keeps the non-id keys in a list as well, for the containment pass —
 * which has to compare against whole names rather than hit a hash.
 */
export interface TargetIndex {
	byKey: Map<string, string>;
	named: Array<{ id: string; name: string }>;
}

export function buildTargetIndex(inventory: Fields[]): TargetIndex {
	const byKey = new Map<string, string>();
	const named: Array<{ id: string; name: string }> = [];
	for (const rec of inventory) {
		const id = typeof rec.id === "string" ? rec.id : undefined;
		if (!id) continue;
		for (const k of elementKeys(rec)) {
			if (!byKey.has(k)) byKey.set(k, id);
			if (k !== id.toLowerCase()) named.push({ id, name: k });
		}
	}
	return { byKey, named };
}

/** The shortest name that can identify anything. Below this, a match is a coincidence. */
const NAME_MIN = 4;

/** Does `name` appear inside `phrase` as a whole word rather than as a fragment? */
function namesWithin(name: string, phrase: string): boolean {
	if (name.length < NAME_MIN) return false;
	const at = phrase.indexOf(name);
	if (at < 0) return false;
	const before = at === 0 ? " " : (phrase[at - 1] ?? " ");
	const after = at + name.length >= phrase.length ? " " : (phrase[at + name.length] ?? " ");
	return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * The element this target names, or undefined when nothing recorded does.
 *
 * The order is by how certain each step is, and it stops at the first answer:
 *
 *   1. the target as written — an id, a path, "METHOD /path", a host, a name
 *   2. a route inside prose: "POST /api/login (line 30)" names /api/login
 *   3. the same target without a line number, then by its basename: a review
 *      writes "share.go" where the tree has "http/share.go"
 *   4. an element whose name sits inside the target as a whole word —
 *      "CheckLinksCommand link checking" is the CheckLinksCommand element, and
 *      "user" is not the "users" one
 *
 * Step 4 answers only when the candidates are one element described at two
 * lengths. Two different elements named in one phrase get no answer at all: a
 * cell attached to the wrong element is worse than one attached to nothing,
 * because it reads as tested work that was never done.
 */
export function resolveElementTarget(target: unknown, index: TargetIndex): string | undefined {
	const k = key(target);
	if (k === undefined) return undefined;
	const exact = index.byKey.get(k);
	if (exact) return exact;

	const path = /(\/[^\s?#)]*)/.exec(k)?.[1];
	if (path) {
		const hit = index.byKey.get(path.replace(/\/+$/, "")) ?? index.byKey.get(path);
		if (hit) return hit;
	}

	const noLine = k.replace(/:\d+(?:-\d+)?$/, "");
	const byNoLine = index.byKey.get(noLine);
	if (byNoLine) return byNoLine;
	const base = noLine.split("/").pop();
	if (base && base !== noLine) {
		const hit = index.byKey.get(base);
		if (hit) return hit;
	}

	const matches: Array<{ id: string; name: string }> = [];
	for (const cand of index.named) {
		if (namesWithin(cand.name, k) || namesWithin(k, cand.name)) matches.push(cand);
	}
	if (matches.length === 0) return undefined;
	// The most specific element that fits, but only when the others it beat are
	// the same thing described more briefly: "FetchController" inside
	// "FetchController::htmlKeywordsFromUrl" is one element named two ways, while
	// "handler" and "handlers" both named in one phrase are two, and choosing
	// between them would attach a cell to an element nobody tested.
	const longest = matches.reduce((a, b) => (b.name.length > a.name.length ? b : a));
	// Two elements recorded under the SAME name is the one case nesting cannot
	// settle — they are equally good answers, so there is no answer. It happens on
	// a ledger that already holds duplicate elements, and attaching a cell to
	// whichever came first would build a coverage claim on top of that mistake.
	if (matches.some((m) => m.id !== longest.id && m.name === longest.name)) return undefined;
	const nested = matches.every((m) => m.id === longest.id || namesWithin(m.name, longest.name));
	return nested ? longest.id : undefined;
}

/**
 * Attach every claim it can to the element it names.
 *
 * Returns the hypotheses with resolved targets, and the number that still name
 * nothing recorded. That count is the honest residue and is worth showing: a
 * claim attached to nothing is testing that was done, recorded, and cannot be
 * seen — and the operator is the only one who can decide whether the thing it
 * names should have been mapped as surface.
 */
export function attachToElements<T extends { target: string }>(
	hypotheses: T[],
	inventory: Fields[],
): { hypotheses: T[]; unattached: number } {
	const index = buildTargetIndex(inventory);
	let unattached = 0;
	const out = hypotheses.map((h) => {
		if (index.byKey.get(key(h.target) ?? "") === h.target) return h; // already an id
		const hit = resolveElementTarget(h.target, index);
		if (!hit) { unattached += 1; return h; }
		return hit === h.target ? h : { ...h, target: hit };
	});
	return { hypotheses: out, unattached };
}
