#!/usr/bin/env -S node --experimental-strip-types
/**
 * DVBank detection benchmark, re-run against the current harness.
 *
 * Faithful to research/02: isolated target (the de-leaked clean/ tree plus the
 * six decoys and nothing else), the original detection prompt verbatim, the
 * official grader at window=3.
 *
 * It also applies the five corrections research/04 §7b asked for and the
 * original run could not:
 *   1. raw AND backend-scoped precision are both reported, since the key is
 *      backend-only while the prompt requests frontend too
 *   2. findings are de-duplicated before grading, removing the structural
 *      advantage a noisier arm gets under line-window matching
 *   3. n rollouts with the spread reported, not a single run
 *   4. every target is audited for answer-key leakage before the agent sees it
 *   5. the ledger is graded alongside the emitted report, which is new — it
 *      asks whether what pired *recorded* matches what it *claimed*
 */

import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Workspace } from "../../core/workspace.ts";
import { makeHostServices } from "../../extensions/lib/host.ts";

const run = promisify(execFile);
const DVBANK = process.env.DVBANK ?? "/home/mamgad/DVBank";
const PIRED = new URL("../../bin/pired.mjs", import.meta.url).pathname;
const RUN_ID = Math.random().toString(36).slice(2, 8);

function arg(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}

/** Only the de-leaked tree and the decoys. Nothing that could reveal an answer. */
async function buildTarget(dir: string): Promise<string[]> {
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await cp(join(DVBANK, "eval/variants/clean"), dir, { recursive: true });
	await mkdir(join(dir, "decoys"), { recursive: true });
	for (const f of await readdir(join(DVBANK, "eval/decoys"))) {
		if (f.endsWith(".py")) await cp(join(DVBANK, "eval/decoys", f), join(dir, "decoys", f));
	}
	// Leakage audit: the manifest labels safe regions, the key holds the answers,
	// and docs/course explain the bugs. None may exist under the target.
	const banned = ["ground_truth.json", "manifest.json", "docs", "course", "eval", ".git", "flags.json"];
	const found: string[] = [];
	const walk = async (d: string): Promise<void> => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			if (banned.includes(e.name)) found.push(join(d, e.name));
			if (e.isDirectory()) await walk(join(d, e.name));
		}
	};
	await walk(dir);
	return found;
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

interface Finding { file: string; line?: number; start_line?: number; cwe?: string; vuln_class?: string; severity?: string; message?: string }

/** Collapse repeats of the same sink: one file+line is one claim. */
function dedupe(findings: Finding[]): Finding[] {
	const seen = new Set<string>();
	const out: Finding[] = [];
	for (const f of findings) {
		const key = `${f.file}:${f.line ?? f.start_line ?? 0}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(f);
	}
	return out;
}

/** Backend-only, matching what the answer key can actually score. */
const backendOnly = (fs: Finding[]): Finding[] => fs.filter((f) => (f.file ?? "").includes("backend/"));

/** Derive the benchmark schema from pired's own ledger. */
async function fromLedger(engagementDir: string): Promise<Finding[]> {
	if (!existsSync(join(engagementDir, "findings.jsonl"))) return [];
	const ws = new Workspace(engagementDir, makeHostServices());
	const out: Finding[] = [];
	for (const f of await ws.read("findings")) {
		// pired records target/evidence as text; recover file:line where present.
		const hay = [f.target, f.description, f.repro, ...(f.evidence ?? [])].filter(Boolean).join(" ");
		const m = /([\w./-]+\.(?:py|js|jsx|ts|tsx)):(\d+)/.exec(hay);
		if (!m) continue;
		out.push({ file: m[1] as string, line: Number(m[2]), cwe: f.cwe, vuln_class: f.class, severity: f.severity, message: f.title });
	}
	return out;
}

async function grade(findings: Finding[], out: string): Promise<Record<string, number>> {
	const tmp = `${out}.findings.json`;
	await writeFile(tmp, JSON.stringify(findings, null, 2));
	try {
		await run("python3", [
			join(DVBANK, "eval/graders/detection_grader.py"),
			"--truth", join(DVBANK, "eval/ground_truth.json"),
			"--findings", tmp, "--decoys", join(DVBANK, "eval/decoys/manifest.json"),
			"--window", "3", "--out", out,
		], { maxBuffer: 1 << 26 });
	} catch { /* grader prints to stdout on some paths */ }
	try {
		// The grader nests its metrics under `summary`; reading the top level
		// returns undefined for every one and scores a perfect run at 0.000.
		const parsed = JSON.parse(await readFile(out, "utf8")) as { summary?: Record<string, number> };
		return parsed.summary ?? {};
	} catch {
		return {};
	}
}

// --- main -------------------------------------------------------------------

const rollouts = Number(arg("rollouts", "5"));
const workDir = arg("work", "/tmp/dvbank-rerun") as string;
const prompt = await readFile(new URL("../../research/data/prompt.detection.txt", import.meta.url).pathname, "utf8");
await mkdir(workDir, { recursive: true });

process.stderr.write(`DVBank re-run · ${rollouts} rollouts · run ${RUN_ID}\n\n`);

const rows: Array<{ rollout: number; report: Record<string, number>; scoped: Record<string, number>; ledger: Record<string, number>; emitted: number; recorded: number }> = [];

/** Rollouts are independent; run them together or n=5 takes hours. */
async function rollout(i: number): Promise<void> {
		const name = `dvbank-${RUN_ID}-r${i}`;
		const dir = join(workDir, name);
		const leaks = await buildTarget(dir);
		if (leaks.length > 0) {
			process.stderr.write(`r${i}: LEAKAGE — ${leaks.join(", ")}\n`);
			return;
		}
		await pretrust(dir);
		const engagementDir = join(process.env.HOME ?? "", ".pired", "engagements", name);
		await rm(engagementDir, { recursive: true, force: true });

		const started = Date.now();
		try {
			const pending = run(process.execPath, [
				PIRED, "--profile", "review", "--provider", arg("provider", "openrouter") as string,
				"--model", arg("model", "qwen/qwen3.8-27b") as string,
				"--no-theme", "--target", dir, "--prompt", prompt,
			], { timeout: Number(arg("timeout", "1800000")), maxBuffer: 1 << 26, cwd: dir });
			pending.child.stdin?.end();
			await pending;
		} catch { /* partial output is still gradeable */ }

		let emitted: Finding[] = [];
		try {
			emitted = JSON.parse(await readFile(join(dir, "findings.json"), "utf8")) as Finding[];
		} catch { /* the agent may not have written it */ }
		const ledger = await fromLedger(engagementDir);

		const d = dedupe(emitted);
		rows.push({
			rollout: i,
			report: await grade(d, join(workDir, `${name}.report.json`)),
			scoped: await grade(backendOnly(d), join(workDir, `${name}.scoped.json`)),
			ledger: await grade(dedupe(ledger), join(workDir, `${name}.ledger.json`)),
			emitted: d.length,
			recorded: ledger.length,
		});
		process.stderr.write(`r${i} done in ${Math.round((Date.now() - started) / 1000)}s — emitted ${d.length}, ledger ${ledger.length}\n`);
}

const concurrency = Number(arg("concurrency", String(rollouts)));
let cursor = 0;
await Promise.all(
	Array.from({ length: Math.min(concurrency, rollouts) }, async () => {
		for (;;) {
			const i = cursor++;
			if (i >= rollouts) return;
			await rollout(i);
		}
	}),
);
rows.sort((a, b) => a.rollout - b.rollout);

const stat = (xs: number[]): string =>
	xs.length === 0 ? "—" : `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)} [${Math.min(...xs).toFixed(3)}, ${Math.max(...xs).toFixed(3)}]`;
const col = (k: string, pick: (r: (typeof rows)[number]) => Record<string, number>): string =>
	stat(rows.map((r) => Number(pick(r)[k] ?? 0)).filter((x) => !Number.isNaN(x)));

process.stdout.write(`\n⦿ DVBank detection · current harness · n=${rows.length}\n\n`);
for (const [label, pick] of [
	["emitted report (raw)", (r: (typeof rows)[number]) => r.report],
	["emitted report (backend-scoped)", (r: (typeof rows)[number]) => r.scoped],
	["pired ledger", (r: (typeof rows)[number]) => r.ledger],
] as const) {
	process.stdout.write(`${label}\n`);
	for (const m of ["recall", "precision", "f1"]) {
		process.stdout.write(`  ${m.padEnd(10)} ${col(m, pick)}\n`);
	}
	process.stdout.write("\n");
}
process.stdout.write(`findings per run — emitted ${stat(rows.map((r) => r.emitted))} · recorded in ledger ${stat(rows.map((r) => r.recorded))}\n`);
await writeFile(join(workDir, `summary-${RUN_ID}.json`), `${JSON.stringify(rows, null, 2)}\n`);
process.stdout.write(`raw → ${join(workDir, `summary-${RUN_ID}.json`)}\n`);
