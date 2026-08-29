#!/usr/bin/env -S node --experimental-strip-types
/**
 * Scan the real-app corpus and score each target against its own key.
 *
 * Unlike DVBank, these are upstream projects at their pre-fix commit and the key
 * comes from the maintainer's patch. Two consequences worth holding in mind when
 * reading the output:
 *
 * - Scale varies enormously. Flask is 83 files; Django is 2,869. Recall is not
 *   comparable across them, and a low Django number is a statement about review
 *   at scale, not about the harness being worse than it was on Flask.
 * - The key is patch-localized, not exploit-verified. It says where the bug was,
 *   precisely. It does not prove the bug fires, and it does not enumerate every
 *   other bug in the project — so a "false positive" here may well be a real
 *   finding the advisory simply is not about. Precision against these keys is a
 *   lower bound, more so than on DVBank.
 */

import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { dedupe, fromLedger, scoreFindings } from "../dvbank/score.ts";

const run = promisify(execFile);
const PIRED = new URL("../../bin/pired.mjs", import.meta.url).pathname;
const RUN_ID = Math.random().toString(36).slice(2, 8);

function arg(name: string, def?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return (i >= 0 && next && !next.startsWith("--") ? next : def) as string;
}

interface Entry {
	id: string;
	package: string;
	repo: string;
	published?: string;
	target: string;
	truth: string;
	entries: number;
}

const corpusDir = arg("corpus", "/tmp/corpus");
const manifest = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")) as Entry[];
const only = arg("only", "");
const targets = only ? manifest.filter((m) => m.id.includes(only) || m.package.includes(only)) : manifest;

const PROMPT =
	"Perform a security review of this codebase. Record the surface you find, record hypotheses and their " +
	"outcomes as you settle them, and record confirmed issues as findings with cwe, severity and the exact " +
	"file:line of the vulnerable sink.";

async function pretrust(dir: string): Promise<void> {
	const path = join(process.env.HOME ?? "", ".pi", "agent", "trust.json");
	let trust: Record<string, boolean> = {};
	try {
		trust = JSON.parse(await readFile(path, "utf8")) as Record<string, boolean>;
	} catch { /* none yet */ }
	trust[dir] = true;
	await writeFile(path, `${JSON.stringify(trust, null, 2)}\n`);
}

interface Row extends Entry {
	recall: number;
	precision: number;
	found: number;
	reported: number;
	seconds: number;
	ok: boolean;
	error?: string;
}

const rows: Row[] = [];
process.stderr.write(`⦿ corpus scan · ${targets.length} target(s) · ${RUN_ID}\n\n`);

const jobs = targets.map((m) => async (): Promise<void> => {
	// pired derives the engagement name from the TARGET DIRECTORY'S BASENAME, not
	// from anything the caller passes. Inventing a name here meant the runner
	// cleared one directory, pired wrote to another, and every scan read findings
	// from a path that never existed — reporting 0 found for runs that had
	// actually worked. Follow pired's own rule instead of assuming.
	const name = basename(m.target);
	const engagementDir = join(process.env.HOME ?? "", ".pired", "engagements", name);
	await rm(engagementDir, { recursive: true, force: true });
	await pretrust(m.target);
	const started = Date.now();
	let ok = true;
	let error: string | undefined;
	try {
		const pending = run(process.execPath, [
			PIRED, "--profile", "review", "--provider", arg("provider", "openrouter"),
			"--model", arg("model", "qwen/qwen3.8-27b"),
			"--no-theme", "--target", m.target, "--prompt", PROMPT,
		], { timeout: Number(arg("timeout", "1800000")), maxBuffer: 512 * 1024 * 1024, cwd: m.target });
		pending.child.stdin?.end();
		await pending;
	} catch (err) {
		// A failure must never be reported as a measured zero — and the message has
		// to name the cause. An exec error's own message is just the command line,
		// so the child's stderr comes first; `killed` covers both a timeout and a
		// maxBuffer overrun, which are different problems and must not read alike.
		ok = false;
		const e = err as { stderr?: string; message?: string; killed?: boolean; code?: string };
		const stderr = String(e.stderr ?? "").trim();
		const msg = String(e.message ?? "").replace(/^Command failed:.*?(\n|$)/s, "").trim();
		const why = stderr || msg || String(e.code ?? "unknown");
		const kind = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
			? "output exceeded maxBuffer"
			: e.killed
				? `killed (timeout ${Number(arg("timeout", "1800000")) / 1000}s or buffer limit)`
				: "exited non-zero";
		error = `${kind}: ${why.slice(0, 260).replace(/\s+/g, " ")}`;
	}
	const findings = dedupe(await fromLedger(engagementDir));
	const score = await scoreFindings(findings, join(corpusDir, `${name}-${RUN_ID}.report.json`), m.truth);
	rows.push({
		...m, recall: score.recall ?? 0, precision: score.precision ?? 0,
		found: score.true_positives ?? 0, reported: findings.length,
		seconds: Math.round((Date.now() - started) / 1000), ok, error,
	});
	process.stderr.write(
		ok
			? `  ${m.id.padEnd(24)} recall ${(score.recall ?? 0).toFixed(2)}  found ${score.true_positives ?? 0}/${m.entries}  reported ${findings.length}  ${Math.round((Date.now() - started) / 1000)}s\n`
			: `  ${m.id.padEnd(24)} FAILED — ${error}\n`,
	);
});

let cursor = 0;
await Promise.all(
	Array.from({ length: Math.min(Number(arg("concurrency", "3")), jobs.length) }, async () => {
		for (;;) {
			const j = jobs[cursor++];
			if (!j) return;
			await j();
		}
	}),
);

rows.sort((a, b) => a.id.localeCompare(b.id));
const good = rows.filter((r) => r.ok);
process.stdout.write(`\n⦿ real-app corpus · ${good.length}/${rows.length} scanned\n\n`);
process.stdout.write(`${"target".padEnd(26)}${"bugs".padEnd(8)}${"found".padEnd(7)}${"recall".padEnd(8)}${"reported".padEnd(10)}time\n`);
for (const r of rows) {
	process.stdout.write(
		r.ok
			? `${r.id.slice(0, 25).padEnd(26)}${String(r.entries).padEnd(8)}${String(r.found).padEnd(7)}${r.recall.toFixed(2).padEnd(8)}${String(r.reported).padEnd(10)}${r.seconds}s\n`
			: `${r.id.slice(0, 25).padEnd(26)}FAILED — ${r.error}\n`,
	);
}
if (good.length > 0) {
	const totalFound = good.reduce((a, r) => a + r.found, 0);
	const totalBugs = good.reduce((a, r) => a + r.entries, 0);
	process.stdout.write(`\npooled: ${totalFound}/${totalBugs} known bug locations found (${(totalFound / totalBugs).toFixed(3)})\n`);
}
await writeFile(join(corpusDir, `scan-${RUN_ID}.json`), `${JSON.stringify(rows, null, 2)}\n`);
process.stdout.write(`raw → ${join(corpusDir, `scan-${RUN_ID}.json`)}\n`);
