#!/usr/bin/env -S node --experimental-strip-types
/**
 * The codex arm of the compounding experiment.
 *
 * codex has no engagement workspace, so it cannot have a persisted arm — it is
 * structurally a *wiped* arm driven by a frontier model. That is exactly the
 * comparison worth having: does a frontier agent with no memory beat a 27B that
 * carries its ledger forward?
 *
 * Same target, same grader, same key, same window, same session structure as
 * `compounding.ts`. Two differences, both forced and both disclosed:
 *
 *  1. **Prompt.** The compounding prompt instructs the agent to use `record` /
 *     `recall gaps`. codex has neither, so those clauses are dropped and the
 *     completeness nudge kept. Everything else about the task is identical.
 *  2. **Delivery channel.** codex's sandbox cannot write files in this
 *     environment (research/02 §5), so findings come back as the final message
 *     via `-o`, shaped by `--output-schema`. Identical schema, different pipe.
 *
 *   node eval/codex-arm.ts --rollouts 3 --sessions 3
 */

import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DVBANK, dedupe, scoreFindings } from "./dvbank/score.ts";
import type { Finding, Score } from "./dvbank/score.ts";

const exec = promisify(execFile);
const RUN_ID = Math.random().toString(36).slice(2, 8);

function arg(name: string, def?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : (def ?? "");
}

// The compounding prompt with the two pired-tool clauses removed. Dropping them
// is not a courtesy: leaving instructions for tools codex does not have would
// handicap it with impossible directions and make the comparison worthless.
const PROMPT =
	"Perform a security review of this codebase. Identify the surface, test your hypotheses, " +
	"and report confirmed issues as findings with cwe, severity and the exact file:line. " +
	"Check for gaps before you finish.";

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				// Strict structured outputs require every property to appear in
				// `required` — a partial list is rejected with invalid_json_schema
				// before the model is ever called. Unknown fields come back as "".
				required: ["file", "line", "cwe", "vuln_class", "severity", "message"],
				properties: {
					file: { type: "string", description: "Path relative to the review root" },
					line: { type: "integer" },
					cwe: { type: "string", description: "e.g. CWE-89; empty string if unknown" },
					vuln_class: { type: "string" },
					severity: { type: "string" },
					message: { type: "string" },
				},
			},
		},
	},
} as const;

async function buildTarget(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await cp(join(DVBANK, "eval/variants/clean"), dir, { recursive: true });
	await mkdir(join(dir, "decoys"), { recursive: true });
	for (const f of await readdir(join(DVBANK, "eval/decoys"))) {
		if (f.endsWith(".py")) await cp(join(DVBANK, "eval/decoys", f), join(dir, "decoys", f));
	}
}

interface SessionScore extends Score {
	ok: boolean;
	error?: string;
	findingsCount: number;
	seconds: number;
}

async function session(dir: string, workDir: string, name: string, s: number, schemaPath: string): Promise<SessionScore> {
	const started = Date.now();
	const outFile = join(workDir, `${name}-s${s}.last.json`);
	const empty = { recall: 0, precision: 0, f1: 0, true_positives: 0, total_findings: 0 };
	let ok = true;
	let error: string | undefined;

	try {
		const pending = exec(
			"codex",
			[
				"exec",
				"--skip-git-repo-check",
				"--ephemeral", // each session is independent: no carried session state
				"-s", "read-only",
				"-C", dir,
				"-o", outFile,
				"--output-schema", schemaPath,
				...(arg("model") ? ["-m", arg("model")] : []),
				PROMPT,
			],
			{ timeout: Number(arg("timeout", "1200000")), maxBuffer: 1 << 26, cwd: dir },
		);
		// `codex exec` reads stdin even when given a prompt argument, and blocks
		// forever on the open pipe execFile hands it (research/02 §5). execFile
		// takes no stdio option, so closing the stream is the only way to get the
		// `</dev/null` behaviour that makes it terminate.
		pending.child.stdin?.end();
		await pending;
	} catch (err) {
		ok = false;
		const e = err as { stderr?: string; message?: string; killed?: boolean };
		error = (e.killed ? `timeout: ` : "") + (e.stderr || e.message || "unknown").slice(0, 220).replace(/\s+/g, " ");
	}

	let findings: Finding[] = [];
	try {
		const raw = await readFile(outFile, "utf8");
		// The final message should be the schema'd object, but a model can wrap it
		// in prose or a fence. Recover the outermost JSON object rather than
		// scoring a parse failure as a zero.
		const m = /\{[\s\S]*\}/.exec(raw);
		const parsed = JSON.parse(m ? m[0] : raw) as { findings?: Finding[] };
		findings = dedupe(parsed.findings ?? []);
	} catch (e) {
		if (ok) {
			ok = false;
			error = `unparseable final message: ${(e as Error).message.slice(0, 120)}`;
		}
	}

	if (!ok) return { ...empty, ok, error, findingsCount: 0, seconds: Math.round((Date.now() - started) / 1000) };

	const score = await scoreFindings(findings, join(workDir, `${name}-s${s}.report.json`));
	return { ...score, ok, findingsCount: findings.length, seconds: Math.round((Date.now() - started) / 1000) };
}

const sessions = Number(arg("sessions", "3"));
const rollouts = Number(arg("rollouts", "3"));
const workDir = arg("work", "/tmp/codex-arm");
await mkdir(workDir, { recursive: true });
const schemaPath = join(workDir, "schema.json");
await writeFile(schemaPath, JSON.stringify(SCHEMA, null, 2));

process.stderr.write(`codex arm · ${rollouts} rollouts x ${sessions} sessions = ${rollouts * sessions} runs · ${RUN_ID}\n\n`);

const all: Array<{ rollout: number; s: number; score: SessionScore }> = [];
const jobs = Array.from({ length: rollouts }, (_, i) => async () => {
	const name = `codex-${RUN_ID}-r${i}`;
	const dir = join(workDir, name);
	// codex has no memory between sessions, so the target is rebuilt once and
	// each session re-reviews it — the wiped condition, by construction.
	await buildTarget(dir);
	for (let s = 0; s < sessions; s++) {
		const score = await session(dir, workDir, name, s, schemaPath);
		all.push({ rollout: i, s, score });
		process.stdout.write(
			score.ok
				? `  codex r${i} s${s}: recall ${score.recall.toFixed(3)} precision ${score.precision.toFixed(3)} (${score.findingsCount} findings, ${score.seconds}s)\n`
				: `  codex r${i} s${s}: FAILED — ${score.error}\n`,
		);
	}
});

const concurrency = Math.min(Number(arg("concurrency", "3")), jobs.length);
let next = 0;
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		for (;;) {
			const i = next++;
			if (i >= jobs.length) return;
			await jobs[i]!();
		}
	}),
);

const failed = all.filter((r) => !r.score.ok);
process.stdout.write(`\n⦿ codex arm · DVBank · n=${rollouts} rollouts · k=${sessions} sessions\n\n`);
if (failed.length > 0) {
	// A summary computed over failed sessions looks like a measurement and is not
	// one. Say so before any number is printed.
	process.stdout.write(`⚠ ${failed.length}/${all.length} sessions FAILED — these are not measurements.\n\n`);
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
for (let s = 0; s < sessions; s++) {
	const ok = all.filter((r) => r.s === s && r.score.ok);
	if (ok.length === 0) {
		process.stdout.write(`  s${s}: no successful sessions\n`);
		continue;
	}
	process.stdout.write(
		`  s${s} (n=${ok.length}): recall ${mean(ok.map((r) => r.score.recall)).toFixed(3)} · precision ${mean(ok.map((r) => r.score.precision)).toFixed(3)} · findings ${mean(ok.map((r) => r.score.findingsCount)).toFixed(1)}\n`,
	);
}

await writeFile(join(workDir, `codex-${RUN_ID}.json`), `${JSON.stringify(all, null, 2)}\n`);
process.stdout.write(`\nraw → ${join(workDir, `codex-${RUN_ID}.json`)}\n`);
