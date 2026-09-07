#!/usr/bin/env -S node --experimental-strip-types
/**
 * Field CLI — audit the instrument, and show what the degenerate strategies score.
 *
 *   npm run assay:field
 *   npm run assay:field -- --verdicts path/to/verdicts.json
 *
 * The verdicts file is `{ "<claim id>": "confirmed" | "refuted" | "suspected" }`,
 * which is what a challenge run over this target produces. Without one, the
 * command audits the key and prints the baselines — useful on its own, because
 * the baselines are what any real run has to beat.
 */

import { readFileSync } from "node:fs";
import { auditFieldTarget } from "./audit.ts";
import { CLAIMS } from "./claims.ts";
import { runReference } from "./reference.ts";
import { startTarget } from "./target.ts";
import { BASELINES, type Disposition, scoreBaseline, scoreField } from "./score.ts";

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : undefined;
};

const report = await auditFieldTarget();

console.log(`⦿ field · ${CLAIMS.length} claims · ${report.claims.filter((c) => c.truth === "vulnerable").length} real, ${report.claims.filter((c) => c.truth === "clear").length} decoys\n`);
for (const c of report.claims) {
	const mark = c.ok ? "●" : "✗";
	console.log(`${mark} ${c.claim.padEnd(16)} ${c.truth.padEnd(11)} separated by ${c.separator}${c.problem ? `\n    ${c.problem}` : ""}`);
}
console.log(
	`\n${report.entitlementBound} of ${CLAIMS.length} claims are separated by entitlement alone — ` +
	"no request distinguishes them, which is the ceiling on any check built out of replaying requests.",
);

if (!report.ok) {
	console.error("\nFAIL · the key does not describe the target. This is an instrument defect, not a result.");
	process.exit(1);
}

console.log("\nbaselines");
for (const [name, all] of Object.entries(BASELINES)) {
	const s = scoreBaseline(CLAIMS, all as Disposition);
	console.log(`  ${name.padEnd(20)} sensitivity ${s.sensitivity.toFixed(2)}  specificity ${s.specificity.toFixed(2)}  resolution ${s.resolution.toFixed(2)}`);
}

// The design's own ceiling, measured rather than asserted.
const target = await startTarget();
try {
	const { rows, verdicts } = await runReference(target.url);
	const s = scoreField(CLAIMS, verdicts);
	console.log("\nreference challenger · the contract in core/challenge.ts, given the right probe and no model");
	console.log(`  sensitivity              ${s.sensitivity.toFixed(2)}   real findings kept`);
	console.log(`  specificity              ${s.specificity.toFixed(2)}   decoys not blessed`);
	console.log(`  resolution               ${s.resolution.toFixed(2)}   claims settled correctly`);
	if (s.falseRefutations.length > 0) console.log(`  FALSE REFUTATIONS        ${s.falseRefutations.join(", ")}`);
	if (s.falseConfirmations.length > 0) console.log(`  false confirmations      ${s.falseConfirmations.join(", ")}`);
	const declined = rows.filter((r) => r.disposition === "suspected");
	if (declined.length > 0) {
		console.log(`\n  ${declined.length} claim(s) the design declined to settle from requests alone:`);
		for (const r of declined) console.log(`    ${r.claim.padEnd(16)} ${r.declined ?? ""}`);
	}
} finally {
	await target.close();
}

const path = arg("verdicts");
if (path) {
	const verdicts = JSON.parse(readFileSync(path, "utf8")) as Record<string, Disposition>;
	const s = scoreField(CLAIMS, verdicts);
	console.log(`\nrun · ${path}`);
	console.log(`  sensitivity              ${s.sensitivity.toFixed(2)}   (real findings kept)`);
	console.log(`  specificity              ${s.specificity.toFixed(2)}   (decoys not blessed)`);
	console.log(`  resolution               ${s.resolution.toFixed(2)}   (claims actually settled, correctly)`);
	console.log(`  entitlement sensitivity  ${s.entitlement.sensitivity.toFixed(2)}`);
	console.log(`  entitlement specificity  ${s.entitlement.specificity.toFixed(2)}`);
	if (s.falseRefutations.length > 0) console.log(`  FALSE REFUTATIONS        ${s.falseRefutations.join(", ")}  ← real bugs this destroyed`);
	if (s.falseConfirmations.length > 0) console.log(`  false confirmations      ${s.falseConfirmations.join(", ")}`);
	process.exit(s.falseRefutations.length > 0 ? 1 : 0);
}

console.log("\nPASS · the key describes the target");
