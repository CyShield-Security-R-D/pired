#!/usr/bin/env -S node --experimental-strip-types
/**
 * Grade a real engagement workspace against an answer key.
 *
 *   node --experimental-strip-types eval/grade-cli.ts \
 *     --workspace ~/.pired/engagements/acme --key eval/fixtures/example.key.json
 *
 *   --stratum-by <dim>       group per-stratum recall by this label (default: stack)
 *   --max-false-clear <n>    exit 1 if the false-clear rate exceeds n (for CI)
 *   --json                   machine-readable report
 *
 * This is the T1 entry point: the same `grade()` the probes exercise, pointed at
 * output a model actually produced. Nothing about the scoring changes between
 * the two — which is the reason the fixture-driven probe is worth having.
 */

import { readFileSync } from "node:fs";
import { computeCoverageView } from "../core/stats.ts";
import { Workspace } from "../core/workspace.ts";
import { makeHostServices } from "../extensions/lib/host.ts";
import { alignMatrix, formatGrade, grade } from "./grade.ts";
import { validateKey } from "./key.ts";

function value(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : undefined;
}

const workspaceDir = value("workspace");
const keyPath = value("key");
if (!workspaceDir || !keyPath) {
	process.stderr.write("usage: grade-cli.ts --workspace <dir> --key <file.json>\n");
	process.exit(2);
}

const key = validateKey(JSON.parse(readFileSync(keyPath, "utf8")));
const services = makeHostServices();
const ws = new Workspace(workspaceDir, services);

const view = await computeCoverageView(ws, key.surfaceKinds);
if (!view) {
	process.stderr.write(
		`no checklist in ${workspaceDir} — coverage cannot be derived, so there is nothing to grade.\n`,
	);
	process.exit(2);
}

const inventory = (await ws.read("inventory")) as unknown as Parameters<typeof alignMatrix>[1];
const aligned = alignMatrix(view.matrix, inventory, key);
const report = grade(key, aligned, value("stratum-by") ?? "stack");

if (process.argv.includes("--json")) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	process.stdout.write(`${formatGrade(report)}\n`);
}

const cap = value("max-false-clear");
if (cap !== undefined && report.metrics.falseClearRate > Number(cap)) {
	process.stderr.write(`\nfalse-clear rate ${report.metrics.falseClearRate} exceeds ${cap}\n`);
	process.exit(1);
}
