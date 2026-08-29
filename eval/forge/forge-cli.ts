#!/usr/bin/env -S node --experimental-strip-types
/**
 * Generate a Forge target and its answer key.
 *
 *   node --experimental-strip-types eval/forge/forge-cli.ts \
 *     --out /tmp/target --seed 7 --routes 6 --vuln-rate 0.4
 *
 * Writes the tree plus `answer.key.json` beside it (outside the target dir, so
 * the agent under evaluation can never read it), and runs the artifact audit.
 * A build that fails the audit is reported and exits non-zero: a corpus whose
 * bugs are lexically distinguishable from its decoys is not measuring security.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { auditSites } from "./audit.ts";
import { generate } from "./generate.ts";
import type { ForgeSpec, Stack } from "./types.ts";
import { PYTHON_FLASK } from "./templates/python-flask.ts";

function value(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}

const out = value("out");
if (!out) {
	process.stderr.write("usage: forge-cli.ts --out <dir> [--seed N] [--routes N] [--vuln-rate 0..1]\n");
	process.exit(2);
}

const spec: ForgeSpec = {
	seed: Number(value("seed", String(Date.now() % 100000))),
	stack: (value("stack", "python-flask") as Stack),
	routes: Number(value("routes", "6")),
	vulnRate: Number(value("vuln-rate", "0.4")),
	maxTaintDepth: Number(value("max-taint-depth", "2")),
};

const target = generate(spec);
mkdirSync(out, { recursive: true });
for (const [rel, content] of Object.entries(target.files)) {
	const path = join(out, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

// The key lives OUTSIDE the target tree. Contamination control is structural
// here — the agent's working directory simply does not contain the answers.
const keyPath = value("key", `${out}.key.json`) as string;
writeFileSync(keyPath, `${JSON.stringify(target.key, null, 2)}\n`);

// Audit every template's rendered pair, not just the ones this seed emitted:
// the question is whether the generator leaks, not whether one target did.
const ctx = { route: { method: "GET" as const, path: "/api/x", handler: "h", param: "q", jsonOnly: false }, taintDepth: 1, rng: () => 0.5 };
const vulnSites = PYTHON_FLASK.map((t) => t.vulnerable(ctx).body);
const safeSites = PYTHON_FLASK.map((t) => t.safe(ctx).body);
void vulnSites; void safeSites;
// The gate compares rendered sites against this target's ordinary handlers —
// same granularity, same file, same style. That is the LAVA question.
const audit = auditSites(
	target.siteBodies.length > 0 ? target.siteBodies : vulnSites,
	safeSites,
	target.fillerBodies,
);

const vulnCells = target.key.cells.filter((c) => c.truth === "vulnerable").length;
const clearCells = target.key.cells.filter((c) => c.truth === "clear").length;
const naCells = target.key.cells.filter((c) => c.truth === "n/a").length;

process.stdout.write(`⦿ forge · ${spec.stack} · seed ${spec.seed}\n\n`);
process.stdout.write(`  target      ${out}  (${Object.keys(target.files).length} files)\n`);
process.stdout.write(`  key         ${keyPath}\n`);
process.stdout.write(`  cells       ${target.key.cells.length}  (${vulnCells} vulnerable · ${clearCells} clear · ${naCells} n/a)\n`);
process.stdout.write(`  taint       depths ${[...new Set(target.sites.map((s) => s.taintDepth))].sort().join(", ")}\n\n`);
process.stdout.write(`  artifact audit\n`);
process.stdout.write(`    clone index     ${audit.cloneIndex}  (gate: <= ${audit.cloneCeiling})  ${audit.passed ? "PASS" : "FAIL — same-class sites are near-clones; the corpus has less breadth than it reports"}\n`);
process.stdout.write(`    injection AUC   ${audit.injectionAuc}  (diagnostic — high is expected; sinks are lexically distinctive)\n`);
process.stdout.write(`    bug/fix AUC     ${audit.bugFixAuc}  (diagnostic — separability of vulnerable from safe)\n`);
process.stdout.write(`    strongest tells ${audit.topTells.slice(0, 5).map((t) => t.token).join(", ")}\n`);
process.exit(audit.passed ? 0 : 1);
