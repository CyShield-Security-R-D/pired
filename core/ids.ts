/**
 * Minting ids that do not collide with a row already in the store.
 *
 * A store keeps only the latest line per id (FORMAT.md §4), so an id drawn a
 * second time does not add a row — it silently replaces whatever finding or
 * hypothesis held it before, with a different record. The host draws 6 hex
 * characters (16^6 ids), which is not "unique enough": computed exactly, the
 * chance that some two draws in one store match is 0.74% at 500 rows (1 run in
 * 135 — the rate at which the old host test that asserted 500 unique draws
 * failed), 2.9% at 1,000 and 11.2% at 2,000. A bulk hypothesis write (class x
 * element) reaches those sizes on a real engagement.
 *
 * So uniqueness is checked here, against the store as it stands inside the
 * writer's lock and against ids minted earlier in the same write, rather than
 * by lengthening the id: existing ledgers and FORMAT.md stay valid as written.
 */

import type { Ids } from "./ports.ts";

/**
 * Draw from `ids` until one is not `taken`.
 *
 * Throws after `attempts` draws, rather than returning an id that would
 * overwrite a record. Reaching that is not a real outcome: 64 draws that all
 * land on taken ids in a 5,000-row store is a ~10^-226 event, so the throw is
 * there to turn a broken id source (one that repeats forever) into an error
 * instead of data loss.
 */
export function freshId(ids: Ids, taken: (id: string) => boolean, attempts = 64): string {
	for (let i = 0; i < attempts; i++) {
		const id = ids.newId();
		if (!taken(id)) return id;
	}
	throw new Error(
		`could not mint an unused id after ${attempts} attempts — the id source keeps returning ids already in the store; ` +
			"nothing was written, so no record was overwritten",
	);
}

/**
 * A minting function for one write: fresh against `existing` and against every
 * id it has already handed out, so two rows of one bulk write never share an id.
 */
export function idMinter(ids: Ids, existing: Iterable<{ id: string }>): () => string {
	const taken = new Set<string>();
	for (const row of existing) taken.add(row.id);
	return () => {
		const id = freshId(ids, (candidate) => taken.has(candidate));
		taken.add(id);
		return id;
	};
}
