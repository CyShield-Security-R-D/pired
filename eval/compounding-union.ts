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
	const ids = new Set((await readdir(dir)).map((f) => /^cmp-([a-z0-9]+)-/.exec(f)?.[1]).filter(Boolean));
	process.stderr.write(`--run required. Found: ${[...ids].join(", ")}\n`);
	process.exit(2);
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const rows: Array<{ arm: string; r: number; s: number; perSession: number; cumulative: number }> = [];

for (const arm of ["persisted", "wiped"] as const) {
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
for (const arm of ["persisted", "wiped"] as const) {
	const series = Array.from({ length: sessions }, (_, s) => mean(rows.filter((x) => x.arm === arm && x.s === s).map((x) => x.cumulative)));
	process.stdout.write(`  ${arm.padEnd(10)} ${series.map((v) => v.toFixed(3)).join("  →  ")}   Δ ${(series[series.length - 1]! - series[0]!).toFixed(3)}\n`);
}

process.stdout.write("\nper-session recall (that session's findings alone) — is each session getting better?\n");
for (const arm of ["persisted", "wiped"] as const) {
	const series = Array.from({ length: sessions }, (_, s) => mean(rows.filter((x) => x.arm === arm && x.s === s).map((x) => x.perSession)));
	process.stdout.write(`  ${arm.padEnd(10)} ${series.map((v) => v.toFixed(3)).join("  →  ")}   Δ ${(series[series.length - 1]! - series[0]!).toFixed(3)}\n`);
}

const finalCum = (arm: string): number[] => rows.filter((x) => x.arm === arm && x.s === sessions - 1).map((x) => x.cumulative);
const p = finalCum("persisted");
const w = finalCum("wiped");
process.stdout.write(`\nfinal cumulative recall · persisted ${p.map((v) => v.toFixed(3)).join(", ")} (mean ${mean(p).toFixed(3)})\n`);
process.stdout.write(`                          wiped     ${w.map((v) => v.toFixed(3)).join(", ")} (mean ${mean(w).toFixed(3)})\n`);
process.stdout.write(`                          gap       ${(mean(p) - mean(w)).toFixed(3)}\n`);
