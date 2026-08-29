/**
 * The answer key — ground truth expressed in pired's own coordinates.
 *
 * Every other security benchmark ships its key as a flat list of findings and
 * then fights to match agent prose against it; eyeballvul reports that approach
 * saturating near 70% precision/recall because CVE descriptions are too terse to
 * compare conclusively. That ceiling is the label format, not the model.
 *
 * A cell key sidesteps it. For each `(element, class)` pair the key states what
 * is true, which makes grading a set comparison against the agent's own ledger —
 * deterministic, no judge model, and diagnostic: a miss is not "recall fell 4
 * points", it is "authz on POST endpoints, dismissed rather than untested".
 *
 * Pure module: types and validation only.
 */

import type { InventoryKind, Severity } from "../core/ontology.ts";

/** What is actually true of a cell. Mirrors the settled subset of CoverageStatus. */
export type TruthStatus = "vulnerable" | "clear" | "n/a";

export interface KeyCell {
	/** Surface element id as the target's inventory is expected to name it. */
	element: string;
	/** Checklist class id. */
	class: string;
	truth: TruthStatus;
	/**
	 * Other element ids an agent might reasonably have recorded for the same
	 * surface. Alignment failures are reported rather than silently scored as
	 * misses, but aliases keep honest naming differences out of the numbers.
	 */
	aliases?: string[];
	/** `file:line` of the vulnerable sink. Reserved for location-level grading. */
	sink?: string;
	/** Path to a PoC that fires on the vulnerable revision (Field corpus). */
	poc?: string;
	severity?: Severity;
	/**
	 * For `truth: "clear"` — why the class genuinely does not apply here. A clear
	 * cell without a reason is an assertion, not ground truth, and validation
	 * rejects it: this is what stops "we didn't find one" being recorded as "there
	 * isn't one".
	 */
	why?: string;
	/** Stratum labels (stack, idiom, …) for per-stratum reporting. */
	strata?: Record<string, string>;
}

export interface AnswerKey {
	v: 1;
	target: string;
	/** Inventory kinds this key's elements are drawn from. */
	surfaceKinds?: InventoryKind[];
	cells: KeyCell[];
}

const TRUTHS: TruthStatus[] = ["vulnerable", "clear", "n/a"];

/**
 * Validate a key hard. A malformed key silently mis-scores every run graded
 * against it, so every problem is collected and thrown together rather than
 * failing on the first.
 */
export function validateKey(raw: unknown): AnswerKey {
	const problems: string[] = [];
	const k = raw as Partial<AnswerKey>;

	if (!k || typeof k !== "object") throw new Error("key: not an object");
	if (k.v !== 1) problems.push(`key: unsupported version ${String(k.v)}`);
	if (typeof k.target !== "string" || !k.target) problems.push("key: missing target");
	if (!Array.isArray(k.cells) || k.cells.length === 0) problems.push("key: no cells");

	const seen = new Set<string>();
	for (const [i, c] of (k.cells ?? []).entries()) {
		const at = `key.cells[${i}]`;
		if (typeof c?.element !== "string" || !c.element) problems.push(`${at}: missing element`);
		if (typeof c?.class !== "string" || !c.class) problems.push(`${at}: missing class`);
		if (!TRUTHS.includes(c?.truth)) problems.push(`${at}: truth must be one of ${TRUTHS.join(", ")}`);
		if (c?.truth === "vulnerable" && !c.sink && !c.poc) {
			problems.push(`${at}: a vulnerable cell needs a sink or a poc — an unlocatable claim is not ground truth`);
		}
		if (c?.truth === "clear" && !c.why) {
			problems.push(`${at}: a clear cell needs a 'why' — otherwise "we found nothing" is being recorded as "there is nothing"`);
		}
		const id = `${c?.element}:${c?.class}`;
		if (seen.has(id)) problems.push(`${at}: duplicate cell ${id}`);
		seen.add(id);
	}

	if (problems.length > 0) throw new Error(`invalid answer key:\n  ${problems.join("\n  ")}`);
	return k as AnswerKey;
}
