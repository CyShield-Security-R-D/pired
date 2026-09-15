#!/usr/bin/env -S node --experimental-strip-types
/**
 * The compounding experiment.
 *
 * The claim the whole ledger architecture rests on: a consultant does not run
 * one scan, they work an engagement over days, and durable state should make
 * repetition *compound* rather than merely repeat. A 2026 study of pentesting
 * agents in the wild found the opposite for agents without one — some
 * accumulated false positives faster than findings, making repeated runs
 * "potentially counterproductive".
 *
 * Three arms, same model, same target, k sessions each:
 *   persisted  the engagement workspace carries across sessions
 *   wiped      the workspace is deleted at every session boundary
 *   lensed     the workspace carries, and each session opens the next PASS
 *
 * The wiped arm is the ablation that matters. It runs pired identically —
 * same prompt, same tools, same everything — and removes only durable memory,
 * which is the confound the original A-vs-C comparison could never separate.
 *
 * The lensed arm is ADR-018 under test. `persisted` and `lensed` differ by one
 * thing: a `pired-ledger pass next` between sessions, which moves the router off
 * the coverage matrix and onto a lens that can reach work the matrix cannot see.
 * It pays only if it beats the WIPED arm's union — the bar `compounding-union.ts`
 * computes — because reaching the union of k cold scans is what accumulation
 * does on its own, and calling that learning is the artifact this whole file
 * exists to have caught once already.
 *
 * Scored against DVBank's key, so the outcome is *finding real bugs*, not
 * filling in cells. The primary statistic is a slope: does session 3 add
 * findings the ledger did not already hold, and does precision survive it?
 *
 * Note on the prompt. The published benchmark used a prompt that asks for a
 * findings.json file; re-running it showed the agent complies and never calls
 * `record`, leaving the ledger empty. That prompt would measure nothing here, so
 * this uses the engagement-shaped instruction instead.
 */

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DVBANK, dedupe, fromLedger, scoreFindings } from "./dvbank/score.ts";
import type { Score } from "./dvbank/score.ts";

const run = promisify(execFile);
const PIRED = new URL("../bin/pired.mjs", import.meta.url).pathname;
const LEDGER = new URL("../bin/pired-ledger.mjs", import.meta.url).pathname;

const ARMS = ["persisted", "wiped", "lensed"] as const;
type Arm = (typeof ARMS)[number];

/**
 * The ladder the lensed arm works through, one lens per session.
 *
 * Passed as PIRED_PASSES rather than written into a scope file so the arm's only
 * difference from `persisted` stays visible in one place. `credentialed` is left
 * out because DVBank is a code review with no loot to re-run anything as, and a
 * rung that is empty by construction would dilute the comparison rather than
 * test it.
 */
const LENSES = "route,file,invariant,adversarial";
const RUN_ID = Math.random().toString(36).slice(2, 8);

function arg(name: string, def?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return (i >= 0 && next && !next.startsWith("--") ? next : def) as string;
}

const PROMPT =
	"Perform a security review of this codebase. Use the engagement workspace: record the surface you find, " +
	"record hypotheses and their outcomes as you settle them, and record confirmed issues as findings with cwe, " +
	"severity and the exact file:line. Check `recall gaps` before you finish.";

async function buildTarget(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await cp(join(DVBANK, "eval/variants/clean"), dir, { recursive: true });
	await mkdir(join(dir, "decoys"), { recursive: true });
	for (const f of await readdir(join(DVBANK, "eval/decoys"))) {
		if (f.endsWith(".py")) await cp(join(DVBANK, "eval/decoys", f), join(dir, "decoys", f));
	}
}

async function pretrust(dir: string): Promise<void> {
	const path = join(process.env.HOME ?? "", ".pi", "agent", "trust.json");
	let trust: Record<string, boolean> = {};
	try {
		trust = JSON.parse(await readFile(path, "utf8")) as Record<string, boolean>;
	} catch { /* none yet */ }
	trust[dir] = true;
	await writeFile(path, `${JSON.stringify(trust, null, 2)}\n`);
}

interface SessionScore extends Score {
	session: number;
	ledgerFindings: number;
	hypotheses: number;
	durationMs: number;
	/**
	 * False when the session did not actually run. A measurement harness must
	 * never let a failure look like a result: eighteen runs once returned recall
	 * 0.000 across both arms, which read as a clean null finding and was in fact
	 * an HTTP 402 on the first request of every one of them.
	 */
	ok: boolean;
	error?: string;
}

async function rollout(arm: Arm, index: number, sessions: number, workDir: string): Promise<{ arm: string; rollout: number; scores: SessionScore[] }> {
	const name = `cmp-${RUN_ID}-${arm}-r${index}`;
	const dir = join(workDir, name);
	await buildTarget(dir);
	await pretrust(dir);
	const engagementDir = join(process.env.HOME ?? "", ".pired", "engagements", name);
	await rm(engagementDir, { recursive: true, force: true });

	const scores: SessionScore[] = [];
	for (let s = 0; s < sessions; s++) {
		// The ablation: wiping removes durable memory and nothing else.
		if (s > 0 && arm === "wiped") await rm(engagementDir, { recursive: true, force: true });
		// The treatment: the lensed arm keeps everything the persisted arm keeps
		// and additionally advances the ladder, so session s runs under lens s.
		// Its failure is recorded rather than swallowed — an arm that silently
		// stopped advancing would be the persisted arm wearing another name, and
		// would read as a null result for the feature rather than for the harness.
		if (s > 0 && arm === "lensed") {
			try {
				await run(process.execPath, [LEDGER, "--engagement", name, "pass", "next"], {
					env: { ...process.env, PIRED_PASSES: LENSES },
					timeout: 60000,
				});
			} catch (err) {
				process.stderr.write(`  lensed r${index} s${s}: could not open the pass — ${(err as Error).message.slice(0, 160)}\n`);
			}
		}
		const started = Date.now();
		let ok = true;
		let error: string | undefined;
		try {
			const pending = run(process.execPath, [
				PIRED, "--profile", "review", "--provider", arg("provider", "openrouter"),
				"--model", arg("model", "qwen/qwen3.8-27b"),
				"--no-theme", "--target", dir, "--prompt", PROMPT,
			], {
				timeout: Number(arg("timeout", "1200000")),
				maxBuffer: 1 << 26,
				cwd: dir,
				// Only the lensed arm gets a ladder. The other two run the harness
				// exactly as every earlier number in research/ was measured against.
				env: arm === "lensed" ? { ...process.env, PIRED_PASSES: LENSES } : process.env,
			});
			pending.child.stdin?.end();
			await pending;
		} catch (err) {
			// Partial output is still scoreable, but the failure has to survive to
			// the summary or a broken run is reported as a measured zero.
			ok = false;
			const e = err as { stderr?: string; message?: string; killed?: boolean };
			// Prefer the child's stderr — the cause. The exec error's own message is
			// just the command line, which says nothing about why it failed.
			const stderr = String(e.stderr ?? "").trim();
			const why = stderr || String(e.message ?? "").replace(/^Command failed:.*?(\n|$)/s, "").trim() || "unknown";
			error = (e.killed ? `timeout after ${arg("timeout", "1200000")}ms: ` : "") + why.slice(0, 220).replace(/\s+/g, " ");
		}

		const findings = dedupe(await fromLedger(engagementDir));
		const score = await scoreFindings(findings, join(workDir, `${name}-s${s}.report.json`));
		let hypotheses = 0;
		try {
			hypotheses = (await readFile(join(engagementDir, "hypotheses.jsonl"), "utf8")).trim().split("\n").filter(Boolean).length;
		} catch { /* none recorded */ }
		scores.push({ ...score, session: s, ledgerFindings: findings.length, hypotheses, durationMs: Date.now() - started, ok, error });
		process.stderr.write(
			ok
				? `  ${arm} r${index} s${s}: recall ${score.recall?.toFixed(3)} precision ${score.precision?.toFixed(3)} (${findings.length} findings, ${hypotheses} hyps)\n`
				: `  ${arm} r${index} s${s}: FAILED — ${error}\n`,
		);
	}
	return { arm, rollout: index, scores };
}

// --- main -------------------------------------------------------------------

const sessions = Number(arg("sessions", "3"));
const rollouts = Number(arg("rollouts", "3"));
const workDir = arg("work", "/tmp/compounding");
await mkdir(workDir, { recursive: true });

const jobs: Array<() => Promise<Awaited<ReturnType<typeof rollout>>>> = [];
for (const arm of ARMS) {
	for (let i = 0; i < rollouts; i++) jobs.push(() => rollout(arm, i, sessions, workDir));
}

process.stderr.write(`compounding · ${ARMS.length} arms x ${rollouts} rollouts x ${sessions} sessions = ${jobs.length * sessions} runs · ${RUN_ID}\n\n`);

const results: Array<Awaited<ReturnType<typeof rollout>>> = [];
let cursor = 0;
await Promise.all(
	Array.from({ length: Math.min(Number(arg("concurrency", "6")), jobs.length) }, async () => {
		for (;;) {
			const i = cursor++;
			const job = jobs[i];
			if (!job) return;
			results.push(await job());
		}
	}),
);

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const series = (arm: string, key: keyof SessionScore): number[] =>
	Array.from({ length: sessions }, (_, s) =>
		mean(results.filter((r) => r.arm === arm).map((r) => Number(r.scores[s]?.[key] ?? 0))),
	);

const allSessions = results.flatMap((r) => r.scores);
const failed = allSessions.filter((s) => !s.ok);

process.stdout.write(`\n⦿ compounding · DVBank · n=${rollouts} per arm · k=${sessions}\n\n`);

if (failed.length > 0) {
	process.stdout.write(`⚠ ${failed.length}/${allSessions.length} sessions FAILED — these are not measurements.\n`);
	const reasons = new Map<string, number>();
	for (const f of failed) reasons.set(f.error ?? "unknown", (reasons.get(f.error ?? "unknown") ?? 0) + 1);
	for (const [reason, n] of reasons) process.stdout.write(`   ${n}x  ${reason}\n`);
	process.stdout.write("\n");
}

// A summary computed over failed sessions is worse than no summary: it looks
// like a null result and reads as evidence.
if (failed.length === allSessions.length) {
	process.stdout.write("Every session failed. No result — fix the cause above and re-run.\n");
	await writeFile(join(workDir, `summary-${RUN_ID}.json`), `${JSON.stringify(results, null, 2)}\n`);
	process.exit(1);
}
for (const key of ["recall", "precision", "ledgerFindings", "hypotheses"] as const) {
	process.stdout.write(`${key}\n`);
	for (const arm of ARMS) {
		const s = series(arm, key);
		process.stdout.write(`  ${arm.padEnd(10)} ${s.map((x) => x.toFixed(3)).join("  →  ")}   Δ ${(s[s.length - 1]! - s[0]!).toFixed(3)}\n`);
	}
	process.stdout.write("\n");
}

const slope = (arm: Arm): string => {
	const r = series(arm, "recall");
	return ((r[r.length - 1]! - r[0]!) / Math.max(sessions - 1, 1)).toFixed(4);
};
process.stdout.write(`slope (recall gain per session): ${ARMS.map((a) => `${a} ${slope(a)}`).join(" · ")}\n`);
process.stdout.write(
	"\nThese are per-session ledger scores and the persisted and lensed arms accumulate;\n" +
	`re-score them on a common basis before reading anything into it:\n  node eval/compounding-union.ts --run ${RUN_ID}\n`,
);
await writeFile(join(workDir, `summary-${RUN_ID}.json`), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`raw → ${join(workDir, `summary-${RUN_ID}.json`)}\n`);
