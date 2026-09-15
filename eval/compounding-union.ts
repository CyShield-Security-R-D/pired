#!/usr/bin/env -S node --experimental-strip-types
/**
 * Re-score the compounding run so both arms are measured on the same quantity.
 *
 * `compounding.ts` scores each session from the engagement ledger. The persisted
 * arm's ledger is never wiped, so by session k it holds the **union** of every
 * session's findings; the wiped arm's is cleared each session, so it holds
 * **one** session's. Comparing them directly compares a union of k draws against
 * a single draw — which rises for any stochastic process and says nothing about
 * memory.
 *
 * This unions the wiped arm's per-session findings the same way the persisted
 * ledger accumulates them, so the surviving difference (if any) is what durable
 * state actually bought.
 *
 * The `lensed` arm (ADR-018) is measured against the same bar, and the bar is
 * `wiped`, not `persisted`. Reaching the union of k cold scans is what
 * accumulation does by itself — that is the artifact this file was written to
 * catch — so a lensed arm that ties with wiped has bought nothing, however far
 * above the persisted arm's per-session line it looks in the raw output.
 *
 *   node eval/compounding-union.ts --run qwzox4
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dedupe, scoreFindings } from "./dvbank/score.ts";
import type { Finding } from "./dvbank/score.ts";

const arg = (n: string, d = ""): string => {
	const i = process.argv.indexOf(`--${n}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : d;
};

const dir = arg("work", "/tmp/compounding");
const run = arg("run");
const sessions = Number(arg("sessions", "3"));
const rollouts = Number(arg("rollouts", "3"));

const load = async (name: string): Promise<Finding[]> => {
	try {
		return JSON.parse(await readFile(join(dir, `${name}.report.json.findings.json`), "utf8")) as Finding[];
	} catch {
		return [];
	}
};

if (!run) {
	// A missing work directory is the common case for someone reading this file
	// before running the experiment, and it used to answer with an unhandled
	// rejection from readdir instead of the usage line it already had.
	const files = await readdir(dir).catch(() => [] as string[]);
	const ids = new Set(files.map((f) => /^cmp-([a-z0-9]+)-/.exec(f)?.[1]).filter(Boolean));
	process.stderr.write(
		ids.size > 0
			? `--run required. Found: ${[...ids].join(", ")}\n`
			: `--run required, and no runs are in ${dir}. Produce one with: node eval/compounding.ts\n`,
	);
	process.exit(2);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const ARMS = ["persisted", "wiped", "lensed"] as const;
type Arm = (typeof ARMS)[number];

const rows: Array<{ arm: string; r: number; s: number; perSession: number; cumulative: number }> = [];

/** Arms with no rows are arms that were not run — an older run, or a shorter one. */
const ran = (arm: Arm): boolean => rows.some((x) => x.arm === arm);

for (const arm of ARMS) {
	for (let r = 0; r < rollouts; r++) {
		let acc: Finding[] = [];
		for (let s = 0; s < sessions; s++) {
			const name = `cmp-${run}-${arm}-r${r}-s${s}`;
			const f = await load(name);
			// The persisted ledger is already cumulative on disk, so its per-session
			// figure is recovered by diffing rather than by summing.
			acc = dedupe([...acc, ...f]);
			const perSession = (await scoreFindings(f, join(dir, `union-${name}-single.json`))).recall;
			const cumulative = (await scoreFindings(acc, join(dir, `union-${name}-cum.json`))).recall;
			rows.push({ arm, r, s, perSession, cumulative });
		}
	}
}

process.stdout.write(`\n⦿ compounding, re-scored on a common basis · run ${run}\n\n`);
process.stdout.write("cumulative recall (union of sessions 0..s) — the fair comparison\n");
for (const arm of ARMS.filter(ran)) {
	const series = Array.from({ length: sessions }, (_, s) => mean(rows.filter((x) => x.arm === arm && x.s === s).map((x) => x.cumulative)));
	process.stdout.write(`  ${arm.padEnd(10)} ${series.map((v) => v.toFixed(3)).join("  →  ")}   Δ ${(series[series.length - 1]! - series[0]!).toFixed(3)}\n`);
}

process.stdout.write("\nper-session recall (that session's findings alone) — is each session getting better?\n");
for (const arm of ARMS.filter(ran)) {
	const series = Array.from({ length: sessions }, (_, s) => mean(rows.filter((x) => x.arm === arm && x.s === s).map((x) => x.perSession)));
	process.stdout.write(`  ${arm.padEnd(10)} ${series.map((v) => v.toFixed(3)).join("  →  ")}   Δ ${(series[series.length - 1]! - series[0]!).toFixed(3)}\n`);
}

const finalCum = (arm: string): number[] => rows.filter((x) => x.arm === arm && x.s === sessions - 1).map((x) => x.cumulative);
const w = finalCum("wiped");
process.stdout.write("\nfinal cumulative recall\n");
for (const arm of ARMS.filter(ran)) {
	const v = finalCum(arm);
	process.stdout.write(`  ${arm.padEnd(10)} ${v.map((x) => x.toFixed(3)).join(", ")} (mean ${mean(v).toFixed(3)})\n`);
}

// Every gap is against `wiped`, and the reason is the whole point of this file:
// a union of k draws rises for any stochastic process, so the arm that unions k
// COLD draws is the only honest baseline for an arm whose ledger accumulates.
// Comparing persisted to lensed would compare two accumulating arms and flatter
// both.
if (ran("wiped")) {
	process.stdout.write("\ngap against the wiped union — the only baseline that is not itself accumulating\n");
	for (const arm of ARMS.filter((a) => a !== "wiped").filter(ran)) {
		const v = finalCum(arm);
		process.stdout.write(`  ${arm.padEnd(10)} ${(mean(v) - mean(w)).toFixed(3)}\n`);
	}
	if (ran("lensed")) {
		process.stdout.write(
			"\nADR-018 pays only if `lensed` is above 0 here. A tie means accumulation was\n" +
			"rebuilt and called learning, which is the artifact research/06 recorded.\n",
		);
	}
}
