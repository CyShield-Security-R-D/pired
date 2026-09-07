/**
 * Scoring a challenge pass — the two errors, kept apart.
 *
 * A verification pass has two ways to be wrong and they are not
 * interchangeable, so this never collapses them into one number:
 *
 *   FALSE REFUTATION — a real vulnerability the challenge broke. The
 *     catastrophic one: the finding leaves the client's report and the bug
 *     stays in production. This is `grade.ts`'s false-clear, one layer up, and
 *     it is ratcheted to zero for the same reason.
 *
 *   FALSE CONFIRMATION — a decoy the challenge blessed. The one that shipped:
 *     an unverified IDOR presented to a client as a proven finding.
 *
 * `suspected` is a correct answer to both. A challenge that cannot settle a
 * claim and says so has done its job; only asserting a wrong conclusion counts
 * against it. That asymmetry is deliberate and it is what `core/challenge.ts`
 * implements — insufficient proof lands on `suspected` in either direction.
 *
 * Those two rates alone are not a scoreboard, and the instrument said so the
 * first time it was run: suspecting every claim scores a perfect 1.00 on both,
 * because it never asserts anything wrong. So there is a third axis —
 * `resolution`, the share of claims settled *correctly* — and the three
 * together have no degenerate winner. Confirm-everything takes sensitivity,
 * refute-everything takes specificity, suspect-everything takes both and
 * resolves nothing.
 *
 * This is the discipline `scope.false_blocks` already applies one layer down: a
 * gate that passes by refusing all work has failed differently, and so has a
 * challenge that passes by concluding nothing.
 *
 * Pure module: claims and verdicts in, a report out.
 */

import type { Claim, Separator } from "./claims.ts";

/** What the challenge concluded about a claim. Anything else counts as suspected. */
export type Disposition = "confirmed" | "refuted" | "suspected";

export interface Bucket {
	/** Claims of this kind in the set. */
	total: number;
	confirmed: number;
	refuted: number;
	suspected: number;
}

export interface FieldScore {
	vulnerable: Bucket;
	clear: Bucket;
	/**
	 * Of the real vulnerabilities, the share the challenge did not break.
	 * The number that must not fall.
	 */
	sensitivity: number;
	/** Of the decoys, the share the challenge did not bless. */
	specificity: number;
	/**
	 * The share of claims settled correctly — vulnerable confirmed, clear
	 * refuted. The axis that stops "suspect everything" from winning: it is the
	 * safe answer, and a pass that never gets past it has told the operator
	 * nothing they did not already know.
	 */
	resolution: number;
	/** Real vulnerabilities marked refuted. Ratcheted to zero. */
	falseRefutations: string[];
	/** Decoys marked confirmed. */
	falseConfirmations: string[];
	/**
	 * The same two rates over only the pairs that no request can separate.
	 *
	 * Reported apart from the rest because they measure a different thing: not
	 * whether the challenge ran the right probe, but whether it refused to
	 * conclude without settling entitlement. A harness that scores well on
	 * `control` pairs and badly here is one that re-runs requests and calls it
	 * verification.
	 */
	entitlement: { sensitivity: number; specificity: number; total: number };
}

function bucket(): Bucket { return { total: 0, confirmed: 0, refuted: 0, suspected: 0 }; }

function rate(n: number, d: number): number {
	return d === 0 ? 1 : Math.round((n / d) * 1000) / 1000;
}

export function scoreField(claims: Claim[], verdicts: Record<string, Disposition>): FieldScore {
	const vulnerable = bucket();
	const clear = bucket();
	const falseRefutations: string[] = [];
	const falseConfirmations: string[] = [];
	let entVulnKept = 0, entVulnTotal = 0, entClearCaught = 0, entClearTotal = 0;
	let resolved = 0;

	for (const c of claims) {
		const d = verdicts[c.id] ?? "suspected";
		const b = c.truth === "vulnerable" ? vulnerable : clear;
		b.total += 1;
		b[d] += 1;
		const entitlementPair = c.separator === ("entitlement" satisfies Separator);
		if ((c.truth === "vulnerable" && d === "confirmed") || (c.truth === "clear" && d === "refuted")) resolved += 1;
		if (c.truth === "vulnerable") {
			if (d === "refuted") falseRefutations.push(c.id);
			if (entitlementPair) { entVulnTotal += 1; if (d !== "refuted") entVulnKept += 1; }
		} else {
			if (d === "confirmed") falseConfirmations.push(c.id);
			if (entitlementPair) { entClearTotal += 1; if (d !== "confirmed") entClearCaught += 1; }
		}
	}

	return {
		vulnerable, clear,
		sensitivity: rate(vulnerable.total - falseRefutations.length, vulnerable.total),
		specificity: rate(clear.total - falseConfirmations.length, clear.total),
		resolution: rate(resolved, claims.length),
		falseRefutations, falseConfirmations,
		entitlement: {
			sensitivity: rate(entVulnKept, entVulnTotal),
			specificity: rate(entClearCaught, entClearTotal),
			total: entVulnTotal + entClearTotal,
		},
	};
}

/**
 * What the degenerate strategies score, so a real run has something to beat.
 *
 * `confirm-everything` is the behaviour the shipped report came from and it
 * scores a perfect 1.0 sensitivity. `refute-everything` scores a perfect 1.0
 * specificity and destroys every real finding. `record-and-move-on` scores 1.0
 * on both and resolves nothing at all. A run that does not beat all three on
 * the axis each of them fails is not doing verification.
 */
export const BASELINES: Record<string, Disposition> = {
	"confirm-everything": "confirmed",
	"refute-everything": "refuted",
	"record-and-move-on": "suspected",
};

export function scoreBaseline(claims: Claim[], all: Disposition): FieldScore {
	return scoreField(claims, Object.fromEntries(claims.map((c) => [c.id, all])));
}
