/**
 * Secret redaction for export/share boundaries (PLAN.md §9).
 *
 * Loot secrets are stored in plaintext in the workspace (chmod 600) because the
 * agent must reuse them, but they must never leak through the boundaries that
 * leave the machine: report/findings export and any share path. This builds a
 * masker from the loot ledger that replaces each secret with `[REDACTED <handle>]`
 * (traceable, not just blanked). Registry-based masking keeps false positives at
 * zero — it only masks values the operator actually captured.
 *
 * Pure module: no ports, no I/O.
 */

import type { LootRecord } from "./ontology.ts";

/** Secrets shorter than this are skipped to avoid pathological over-masking of ordinary text. */
const MIN_SECRET_LENGTH = 4;

export interface Redactor {
	/** Replace every known secret in `text` with `[REDACTED <handle>]`. */
	mask(text: string): string;
	/** Recursively mask string values in an object/array, returning a new value. */
	maskDeep<T>(value: T): T;
}

export function buildRedactor(loot: LootRecord[]): Redactor {
	const pairs = loot
		.filter((l) => l.deleted !== true && typeof l.secret === "string" && l.secret.length >= MIN_SECRET_LENGTH)
		.map((l) => ({ secret: l.secret, handle: l.handle }))
		// Longest first so a secret that is a prefix of another cannot leave a tail behind.
		.sort((a, b) => b.secret.length - a.secret.length);

	const mask = (text: string): string => {
		if (!text) return text;
		let out = text;
		for (const { secret, handle } of pairs) {
			out = out.split(secret).join(`[REDACTED ${handle}]`);
		}
		return out;
	};

	const deep = (value: unknown): unknown => {
		if (typeof value === "string") return mask(value);
		if (Array.isArray(value)) return value.map(deep);
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(value)) out[key] = deep(val);
			return out;
		}
		return value;
	};

	return { mask, maskDeep: <T>(value: T): T => deep(value) as T };
}
