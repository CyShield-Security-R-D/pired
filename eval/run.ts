#!/usr/bin/env -S node --experimental-strip-types
/**
 * Assay CLI — one command for the T0 tier.
 *
 *   node --experimental-strip-types eval/run.ts [options]
 *
 *   --filter <substr>   run only probes whose family or name contains substr
 *   --verbose           show known-limit detail, not just failures
 *   --json              emit the machine-readable report instead of the terminal one
 *   --no-artifacts      skip writing the run artifact
 *   --update-ratchet    advance every floor to this run's values (an explicit act)
 *
 * Exit code is 1 on any failing case or ratchet breach, so this drops straight
 * into CI. The artifact under eval/artifacts/ is the durable record — every run
 * is reproducible from it, which is what the first benchmark lacked.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport, runProbes, tightenRatchet } from "./harness.ts";
import { PROBES } from "./probes/index.ts";
import type { RatchetBound } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RATCHET_PATH = join(HERE, "ratchet.json");

function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : undefined;
}

function commit(): string | undefined {
	try {
		return execSync("git rev-parse --short HEAD", { cwd: resolve(HERE, ".."), stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return undefined;
	}
}

const ratchet = JSON.parse(readFileSync(RATCHET_PATH, "utf8")) as Record<string, RatchetBound>;
const report = await runProbes(PROBES, ratchet, { filter: value("filter"), commit: commit() });

if (flag("json")) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
	process.stdout.write(`${formatReport(report, { verbose: flag("verbose") })}\n`);
}

if (!flag("no-artifacts")) {
	const stamp = report.startedAt.replace(/[:.]/g, "-");
	const dir = join(HERE, "artifacts", stamp);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	if (!flag("json")) process.stdout.write(`\nartifact  eval/artifacts/${stamp}/report.json\n`);
}

if (flag("update-ratchet")) {
	// Deliberate, reviewable, and only ever tightening — a floor cannot be lowered
	// by this flag, only by editing ratchet.json with an explanation.
	const next = tightenRatchet(ratchet, report.metrics);
	writeFileSync(RATCHET_PATH, `${JSON.stringify(next, null, 2)}\n`);
	process.stdout.write("ratchet tightened\n");
}

process.exit(report.totals.fail === 0 && report.ratchet.ok ? 0 : 1);
