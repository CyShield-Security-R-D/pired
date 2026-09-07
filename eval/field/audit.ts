/**
 * Auditing the key — the step that makes a Field number worth quoting.
 *
 * `eval/forge` documents the failure this exists to prevent: a generated target
 * whose key marked a cell vulnerable in code that could never run, with nothing
 * downstream able to tell. A key nobody checks is an assertion.
 *
 * Here the key executes, so it can be checked against the thing it describes.
 * Two properties are asserted on every claim, and a breach is an instrument
 * defect rather than a harness result:
 *
 *   1. **The naive probe succeeds.** For decoys as much as for real bugs — that
 *      is what makes them a matched pair. A decoy whose obvious probe already
 *      fails is not a trap; it is a hint, and it would flatter every harness
 *      that scored against it.
 *   2. **The control agrees with the truth.** A claim marked vulnerable whose
 *      control does not fire is a broken fixture, not a hard case.
 */

import { CLAIMS, type Claim } from "./claims.ts";
import { startTarget } from "./target.ts";

export interface ClaimAudit {
	claim: string;
	class: string;
	truth: Claim["truth"];
	separator: Claim["separator"];
	naive: boolean;
	control: boolean;
	/** Both properties held. */
	ok: boolean;
	problem?: string;
}

export interface AuditReport {
	claims: ClaimAudit[];
	ok: boolean;
	/** Pairs no request can separate — reported because it bounds what any replay-based check can achieve. */
	entitlementBound: number;
}

export async function auditClaims(base: string, claims: Claim[] = CLAIMS): Promise<AuditReport> {
	const control = new Map<string, boolean>();
	const naive = new Map<string, boolean>();
	for (const c of claims) {
		naive.set(c.id, await c.naive(base).catch(() => false));
		control.set(c.id, await c.control(base).catch(() => false));
	}
	const byId = new Map(claims.map((c) => [c.id, c]));

	const out: ClaimAudit[] = claims.map((c) => {
		const n = naive.get(c.id) === true;
		const ctl = control.get(c.id) === true;
		let problem: string | undefined;
		if (!n) {
			problem = "the naive probe does not fire — this claim is not a matched pair, and scoring against it flatters every harness";
		} else if (c.separator === "control") {
			// A claim that says a request settles it has to prove that here.
			if (ctl !== (c.truth === "vulnerable")) problem = `the control returned ${ctl} for a claim marked ${c.truth}`;
		} else {
			// A claim that says NO request settles it has to prove that too, and the
			// proof is a twin: same control answer, opposite truth. Without the twin
			// "entitlement" would just be a label excusing a probe nobody wrote.
			const twin = c.inseparableFrom ? byId.get(c.inseparableFrom) : undefined;
			if (!twin) problem = "marked inseparable but names no twin — the claim is unfalsifiable as written";
			else if (twin.truth === c.truth) problem = `twin ${twin.id} carries the same truth, so the pair proves nothing`;
			else if (control.get(twin.id) !== ctl) {
				problem = `the control separates this from ${twin.id} (${ctl} vs ${control.get(twin.id)}) — it is not inseparable, and should be marked separator: "control"`;
			}
		}
		return { claim: c.id, class: c.class, truth: c.truth, separator: c.separator, naive: n, control: ctl, ok: problem === undefined, ...(problem ? { problem } : {}) };
	});

	return {
		claims: out,
		ok: out.every((c) => c.ok),
		entitlementBound: claims.filter((c) => c.separator === "entitlement").length,
	};
}

/** Boot the target, audit, shut down. */
export async function auditFieldTarget(): Promise<AuditReport> {
	const target = await startTarget();
	try {
		return await auditClaims(target.url);
	} finally {
		await target.close();
	}
}
