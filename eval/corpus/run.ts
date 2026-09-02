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
import { existsSync } from "node:fs";
import { cp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { dedupe, engagementTelemetry, fromLedger, scoreFindings } from "../dvbank/score.ts";
import { scopeClause } from "./lib.ts";

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
	/** Application targets carry a scope; library targets do not. */
	scope?: string[];
	scope_files?: number;
	scope_loc?: number;
	surface?: "direct" | "indirect";
}

const corpusDir = arg("corpus", "/tmp/corpus");
const manifest = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")) as Entry[];
const only = arg("only", "");
// Comma-separated so a repeat experiment can pin one subset across passes.
const wanted = only.split(",").map((x) => x.trim()).filter(Boolean);
const targets = wanted.length ? manifest.filter((m) => wanted.some((w) => m.id.includes(w) || m.package.includes(w))) : manifest;

// The first two clauses were added after gradio spent an hour concluding
// "matches upstream Gradio 5.7.1 (no planted deviation found yet)" and recorded
// one inventory row, no hypotheses and no findings. The target IS upstream at a
// pre-fix commit, so matching a remembered release is guaranteed and proves
// nothing — the bug is in the release. The seal stops retrieval over the wire
// and does nothing about retrieval from weights.
//
// The last clause exists because that run put a genuinely good review into
// notes.md. Coverage is computed from the ledger; an unrecorded review is void.
//
// Neither clause asserts a vulnerability exists — that would be a hint.
const PROMPT =
	"Perform a security review of this codebase. This is production source from a real project, not a " +
	"modified or seeded copy: do not compare it against any upstream version you recall, and do not treat " +
	"\"matches upstream\" as evidence that code is safe — judge each sink on its own behaviour. Record the " +
	"surface you find, record hypotheses and their outcomes as you settle them, and record confirmed issues " +
	"as findings with cwe, severity and the exact file:line of the vulnerable sink. Notes are not a " +
	"substitute for recording: anything not in the ledger does not count.";

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
	engaged?: { surface: number; hypotheses: number; settled: number; findings: number };
}

/**
 * Keep one immutable copy of each target and restore from it before every run.
 *
 * Taken on first use, so it must be taken from a tree fetch.ts has just built —
 * snapshotting a dirty target would bake the contamination in permanently.
 */
/**
 * Kill anything still running inside a finished target.
 *
 * Identified by cwd — /proc/<pid>/cwd is the one link back to the target that
 * survives the parent's death — and narrowed to the agent's own processes so a
 * shell someone left open in the directory is not caught with them.
 */
async function reapStrays(target: string): Promise<number> {
	let killed = 0;
	const entries = await readdir("/proc").catch(() => [] as string[]);
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		const cwd = await readlink(`/proc/${entry}/cwd`).catch(() => "");
		if (cwd !== target) continue;
		const cmd = await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
		if (!/\bpi\b|pired|node/.test(cmd.replace(/\0/g, " "))) continue;
		try { process.kill(pid, "SIGKILL"); killed += 1; } catch { /* already gone */ }
	}
	return killed;
}

async function restorePristine(target: string): Promise<void> {
	const snap = `${target}.pristine`;
	if (!existsSync(snap)) {
		await cp(target, snap, { recursive: true });
		return;
	}
	await rm(target, { recursive: true, force: true });
	await cp(snap, target, { recursive: true });
}

/**
 * The seal must exempt the model endpoint and nothing else — and the model
 * endpoint is wherever the chosen provider actually lives.
 *
 * A hardcoded "openrouter.ai" blackholes LM Studio on the LAN, and a model that
 * cannot be reached looks precisely like a model that has wedged: the agent
 * produces nothing, the run times out, and the target gets written down as a
 * zero. Derive the exemption from the provider's own baseUrl so the seal follows
 * the provider instead of assuming one.
 */
const PROVIDER = arg("provider", "openrouter");
const MODEL_HOST = await (async (): Promise<string> => {
	try {
		const cfg = JSON.parse(await readFile(join(process.env.HOME ?? "", ".pi", "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { baseUrl?: string }>;
		};
		const url = cfg.providers?.[PROVIDER]?.baseUrl;
		return url ? new URL(url).hostname : "";
	} catch {
		return "";
	}
})();
const NO_PROXY_HOSTS = ["localhost", "127.0.0.1", MODEL_HOST].filter(Boolean).join(",");
if (arg("sealed") !== "no") {
	process.stderr.write(`⦿ sealed · outbound HTTP blackholed except: ${NO_PROXY_HOSTS}\n`);
	if (!MODEL_HOST) process.stderr.write(`⚠ no baseUrl found for provider "${PROVIDER}" — the model may be unreachable under the seal\n`);
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
	// The agent runs with cwd = the target, so its PoC scripts, scanner output and
	// evidence files land *inside the tree it is reviewing*. Left there, the next
	// pass reviews a different codebase than the first one did — and so does the
	// other arm, since both read the same directory. Two independent harnesses
	// flipping the same target in the same direction is how this surfaced.
	//
	// Restore from a pristine snapshot before every run so each pass sees the
	// tree fetch.ts built, not what the previous agent left behind.
	await restorePristine(m.target);
	await pretrust(m.target);
	const started = Date.now();
	let ok = true;
	let error: string | undefined;
	// Held outside the try so the reaper below can still see the child after a
	// timeout throws.
	let child: { pid?: number } | undefined;
	try {
		const pending = run(process.execPath, [
			PIRED, "--profile", "review", "--provider", PROVIDER,
			"--model", arg("model", "qwen/qwen3.8-27b"),
			// Explicit, and high by default. This runner set no thinking level at all,
			// so it silently inherited `medium` from ~/.pi/agent/settings.json while
			// tui-drive.sh passed `high` — which means flarum's 174 settled hypotheses
			// and airflow's 2 were produced at different reasoning budgets, and the
			// comparison drawn between them was partly a comparison of this flag.
			"--thinking", arg("thinking", "high"),
			"--no-theme", "--target", m.target, "--prompt", PROMPT + scopeClause(m.scope),
		], {
			timeout: Number(arg("timeout", "1800000")), maxBuffer: 512 * 1024 * 1024, cwd: m.target,
			// The seal, in the runner rather than alongside it.
			//
			// Every target here is a pre-fix commit of a public project, so the fixed
			// release *is* the answer key: an agent that can reach pypi, npm or github
			// can download it and diff the answer out, and the pired transcripts showed
			// exactly that happening up to 34 times on a single target. That is
			// retrieval, not discovery, and it is the difference between a number that
			// means something and one that does not.
			//
			// This lived outside the runner during the first sealed experiment, which
			// is precisely how the codex arm ran unsealed for three full passes without
			// anyone noticing. A control that has to be remembered is not a control.
			// Blackhole outbound HTTP for the agent's shell commands; exempt only the
			// model endpoint and the local metering proxy. Byte-identical in intent to
			// the codex arm, so neither harness is advantaged by its seal.
			...(arg("sealed") === "no" ? {} : {
				env: {
					...process.env,
					HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1",
					https_proxy: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1",
					NO_PROXY: NO_PROXY_HOSTS,
					no_proxy: NO_PROXY_HOSTS,
				},
			}),
		});
		child = pending.child;
		pending.child.stdin?.end();
		await pending;
	} catch (err) {
		// A failure must never be reported as a measured zero — and the message has
		// to name the cause. An exec error's own message is just the command line,
		// so the child's stderr comes first; `killed` covers both a timeout and a
		// maxBuffer overrun, which are different problems and must not read alike.
		ok = false;
		const e = err as { stderr?: string; message?: string; killed?: boolean; code?: string; signal?: string };
		const stderr = String(e.stderr ?? "").trim();
		const msg = String(e.message ?? "").replace(/^Command failed:.*?(\n|$)/s, "").trim();
		const why = stderr || msg || String(e.code ?? "unknown");
		const kind = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
			? "output exceeded maxBuffer"
			: e.killed
				? `killed (timeout ${Number(arg("timeout", "1800000")) / 1000}s or buffer limit)`
				: "exited non-zero";
		// The signal is the whole story when a child dies silently: SIGTERM is
		// someone killing it, SIGKILL is usually the OOM killer, SIGSEGV is a crash.
		// Without it "killed: unknown" sends you looking at timeouts for no reason.
		const sig = e.signal ? ` signal=${e.signal}` : "";
		error = `${kind}${sig}: ${why.slice(0, 260).replace(/\s+/g, " ")}`;
	}
	// Reap anything still alive in this target before the next one starts.
	//
	// Node's `timeout` signals the DIRECT child only. pired.mjs died on every
	// timed-out target while the `pi` process it had spawned was reparented to
	// init and kept its socket to the model server open. Measured mid-run: three
	// live connections to a server that answers one call at a time, two of them
	// orphans from targets already written down as finished — so the corpus got
	// slower the further it went, and later targets were scored under contention
	// the earlier ones never saw.
	//
	// Matched by working directory rather than by process tree: by the time the
	// exec settles the orphan's parent is gone, so there is no tree left to walk.
	// Killing the group would be tidier, but execFile does not forward `detached`
	// to spawn, so the child never leads one.
	void child;
	const strays = await reapStrays(m.target);
	if (strays > 0) process.stderr.write(`  reaped ${strays} stray process(es) from ${name}\n`);

	const findings = dedupe(await fromLedger(engagementDir));
	const score = await scoreFindings(findings, join(corpusDir, `${name}-${RUN_ID}.report.json`), m.truth);
	// What the coverage machinery did, not just what it found. A run that records
	// no hypotheses did not exercise the thing under test, and reporting its recall
	// without that fact is how three passes of the library corpus came to look like
	// a harness result.
	const engaged = await engagementTelemetry(engagementDir);
	rows.push({
		...m, recall: score.recall ?? 0, precision: score.precision ?? 0,
		found: score.true_positives ?? 0, reported: findings.length,
		seconds: Math.round((Date.now() - started) / 1000), ok, error, engaged,
	});
	process.stderr.write(
		ok
			? `  ${m.id.padEnd(24)} recall ${(score.recall ?? 0).toFixed(2)}  found ${score.true_positives ?? 0}/${m.entries}  reported ${findings.length}  ` +
				`[surface ${engaged.surface} hyp ${engaged.hypotheses}/${engaged.settled} settled]${engaged.hypotheses === 0 ? " ⚠ MECHANISM IDLE" : ""}  ` +
				`${Math.round((Date.now() - started) / 1000)}s\n`
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

	// The pooled recall means nothing on its own if the harness never ran its own
	// method. State it next to the number rather than leaving it to be discovered
	// later from a transcript.
	const scored = rows.filter((r) => r.ok);
	const idle = scored.filter((r) => (r.engaged?.hypotheses ?? 0) === 0);
	const hyp = scored.reduce((a, r) => a + (r.engaged?.hypotheses ?? 0), 0);
	const settled = scored.reduce((a, r) => a + (r.engaged?.settled ?? 0), 0);
	process.stdout.write(`coverage engaged: ${hyp} hypotheses, ${settled} settled across ${scored.length} target(s)\n`);
	if (idle.length > 0) {
		process.stdout.write(
			`⚠ ${idle.length}/${scored.length} target(s) recorded ZERO hypotheses — on those the coverage\n` +
			`  mechanism never engaged, so their recall measures a plain reviewer, not this harness:\n` +
			`  ${idle.map((r) => r.id).join(", ")}\n`,
		);
	}
}
await writeFile(join(corpusDir, `scan-${RUN_ID}.json`), `${JSON.stringify(rows, null, 2)}\n`);
process.stdout.write(`raw → ${join(corpusDir, `scan-${RUN_ID}.json`)}\n`);
