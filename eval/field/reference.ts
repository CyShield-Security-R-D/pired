/**
 * The reference challenger — what the design permits, with no model involved.
 *
 * SCOPE. The control probe here comes from the key, so this measures the
 * **ceiling of the contract in `core/challenge.ts`**: given that the right
 * probe was run and its result reported honestly, what does the design
 * conclude? It is not a measure of whether an agent devises the right probe —
 * that question needs a model and a live run, and it is the tier above this one.
 *
 * The distinction matters because the two failures have different owners. A
 * false confirmation here is a hole in the contract; a false confirmation with
 * a model in the loop could be either the contract or the agent. Separating
 * them is why this exists: it pins the design's own behaviour so that a later
 * model run can be attributed.
 *
 * Entitlement is deliberately withheld. No request produces it — that is the
 * property the inseparable pair proves — so the reference challenger reports
 * everything a request can establish and nothing it cannot, which is exactly
 * the position a replay-based verifier is in.
 */

import { judge } from "../../core/challenge.ts";
import type { FindingRecord } from "../../core/ontology.ts";
import { CLAIMS, type Claim } from "./claims.ts";
import type { Disposition } from "./score.ts";

const AT = "2026-09-08T00:00:00Z";

function disposition(status: string): Disposition {
	return status === "confirmed" || status === "refuted" ? status : "suspected";
}

export interface ReferenceRow {
	claim: string;
	controlFired: boolean;
	disposition: Disposition;
	/** Present when the design declined to settle it, and why. */
	declined?: string;
}

export async function runReference(base: string, claims: Claim[] = CLAIMS): Promise<{ rows: ReferenceRow[]; verdicts: Record<string, Disposition> }> {
	const rows: ReferenceRow[] = [];
	const verdicts: Record<string, Disposition> = {};

	for (const c of claims) {
		const fired = await c.control(base).catch(() => false);
		const finding = { v: 1, kind: "finding", createdAt: AT, ...c.finding } as FindingRecord;
		const outcome = judge(finding, fired
			? {
				verdict: "stands",
				live: true,
				control: `the class control was run against ${base} and the claim survived it`,
			}
			: {
				verdict: "refuted",
				live: true,
				control: "the class control was run and the claim did not survive it",
				basis: [`${c.finding.target}: the control case returned the answer that makes this not a finding`],
			}, AT);
		const d = disposition(outcome.status);
		verdicts[c.id] = d;
		rows.push({ claim: c.id, controlFired: fired, disposition: d, ...(outcome.downgraded ? { declined: outcome.downgraded } : {}) });
	}
	return { rows, verdicts };
}
