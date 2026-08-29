#!/usr/bin/env -S node --experimental-strip-types
/**
 * Run an Assay experiment.
 *
 *   node --experimental-strip-types eval/experiment-cli.ts \
 *     --target <dir> --rollouts 5 --sessions 1 --preset instrumentation
 *
 * Presets:
 *   instrumentation  one arm, n rollouts — measures how reliably the ledger gets
 *                    populated at all. Answers "is the harness instrumented?",
 *                    which has to be yes before any coverage metric means anything.
 *   compounding      three arms x k sessions — the flagship: does a persisted
 *                    ledger convert repeated sessions into accumulated coverage,
 *                    or does wiping it between sessions score the same?
 */

import { writeFileSync } from "node:fs";
import { runExperiment, sessionSeries, summarize } from "./experiment.ts";
import type { Arm, ExperimentSpec, MetricKey } from "./experiment.ts";

function value(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}

const provider = value("provider", "openrouter") as string;
const model = value("model", "qwen/qwen3.8-27b") as string;
const preset = value("preset", "instrumentation");
const target = value("target");
if (!target) {
	process.stderr.write("usage: experiment-cli.ts --target <dir> [--preset instrumentation|compounding]\n");
	process.exit(2);
}

const ARMS: Record<string, Arm[]> = {
	instrumentation: [{ label: "pired", provider, model }],
	compounding: [
		{ label: "ledger-persisted", provider, model },
		{ label: "ledger-wiped", provider, model, wipeBetweenSessions: true },
	],
};

const spec: ExperimentSpec = {
	target,
	prompt: value("prompt", "Perform a security review of this codebase.") as string,
	sessions: Number(value("sessions", preset === "compounding" ? "3" : "1")),
	rollouts: Number(value("rollouts", "5")),
	arms: ARMS[preset as string] ?? ARMS.instrumentation as Arm[],
	timeoutMs: Number(value("timeout", "900000")),
};

const METRICS: MetricKey[] = [
	"inventory", "hypotheses", "findings", "cells", "settledCells",
	"coveragePct", "evidenceBackingRate", "findingsClassed",
];

process.stderr.write(
	`assay experiment · ${preset} · ${spec.arms.length} arm(s) x ${spec.rollouts} rollouts x ${spec.sessions} session(s) = ${spec.arms.length * spec.rollouts * spec.sessions} runs\n\n`,
);

const started = Date.now();
const results = await runExperiment(spec, Number(value("concurrency", "3")));
const summary = summarize(results, METRICS);

for (const [arm, metrics] of Object.entries(summary)) {
	process.stdout.write(`${arm}\n`);
	for (const [metric, iv] of Object.entries(metrics)) {
		// A 95% interval that spans zero on a rate metric means the behaviour is
		// not reliable, however good the mean looks.
		const flag = iv.lo === 0 && iv.hi > 0 ? "  ← unreliable (CI includes 0)" : "";
		process.stdout.write(`  ${metric.padEnd(20)} ${String(iv.mean).padStart(8)}  [${iv.lo}, ${iv.hi}]  n=${iv.n}${flag}\n`);
	}
	process.stdout.write("\n");
}

if (spec.sessions > 1) {
	process.stdout.write("per-session coverage (the compounding view)\n");
	for (const [arm, series] of Object.entries(sessionSeries(results, "coveragePct"))) {
		process.stdout.write(`  ${arm.padEnd(20)} ${series.map((iv) => `${iv.mean}`).join("  →  ")}\n`);
	}
	process.stdout.write("\n");
}

const failed = results.flatMap((r) => r.sessions).filter((s) => !s.ok).length;
process.stdout.write(`${results.length} rollouts · ${failed} session(s) errored or timed out · ${Math.round((Date.now() - started) / 1000)}s\n`);

const out = value("out");
if (out) {
	writeFileSync(out, `${JSON.stringify({ spec, results, summary }, null, 2)}\n`);
	process.stdout.write(`raw → ${out}\n`);
}
