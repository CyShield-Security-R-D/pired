#!/usr/bin/env -S node --experimental-strip-types
/**
 * Live progress for a running eval.
 *
 * An eval run is opaque while it happens: a model works for twenty minutes and
 * the only signal is that a process still exists. But pired writes its ledger as
 * it goes, so the workspace *is* the progress bar — record counts growing is the
 * agent working, and record counts static for minutes is the agent stuck.
 *
 * Polls the engagement directories and emits a line only when something changes,
 * so it can be piped into a monitor without drowning it. Designed for exactly
 * the question "is this still doing anything, and how far along is it".
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

function arg(name: string, def: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}

const ENGAGEMENTS = join(process.env.HOME ?? "", ".pired", "engagements");
const match = arg("match", "");
const intervalMs = Number(arg("interval", "20000"));
const idleWarnMs = Number(arg("idle-warn", "180000"));

async function countLines(path: string): Promise<number> {
	try {
		const raw = await readFile(path, "utf8");
		return raw.split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

interface Snapshot {
	inv: number;
	hyp: number;
	find: number;
	evid: number;
	mtime: number;
}

async function snapshot(dir: string): Promise<Snapshot> {
	const [inv, hyp, find] = await Promise.all([
		countLines(join(dir, "inventory.jsonl")),
		countLines(join(dir, "hypotheses.jsonl")),
		countLines(join(dir, "findings.jsonl")),
	]);
	let evid = 0;
	let mtime = 0;
	try {
		evid = (await readdir(join(dir, "evidence"))).length;
	} catch { /* none yet */ }
	for (const f of ["inventory.jsonl", "hypotheses.jsonl", "findings.jsonl"]) {
		const st = await stat(join(dir, f)).catch(() => undefined);
		if (st) mtime = Math.max(mtime, st.mtimeMs);
	}
	return { inv, hyp, find, evid, mtime };
}

const seen = new Map<string, Snapshot>();
const started = Date.now();
let idleAnnounced = new Set<string>();

for (;;) {
	let dirs: string[] = [];
	try {
		// Regex, not substring: a corpus spans several advisory prefixes and an
		// unfiltered watch drowns the channel in every historical engagement.
		const re = match ? new RegExp(match) : undefined;
		dirs = (await readdir(ENGAGEMENTS)).filter((d) => (re ? re.test(d) : true));
	} catch { /* no engagements yet */ }

	for (const d of dirs) {
		const dir = join(ENGAGEMENTS, d);
		const now = await snapshot(dir);
		const prev = seen.get(d);
		const changed = !prev || prev.inv !== now.inv || prev.hyp !== now.hyp || prev.find !== now.find || prev.evid !== now.evid;

		if (changed) {
			const delta = prev
				? ` (+${now.inv - prev.inv} inv, +${now.hyp - prev.hyp} hyp, +${now.find - prev.find} find)`
				: " started";
			const mins = ((Date.now() - started) / 60000).toFixed(1);
			process.stdout.write(
				`[${mins}m] ${d}  inv=${now.inv} hyp=${now.hyp} findings=${now.find} evidence=${now.evid}${delta}\n`,
			);
			seen.set(d, now);
			idleAnnounced.delete(d);
		} else if (prev && now.mtime > 0 && Date.now() - now.mtime > idleWarnMs && !idleAnnounced.has(d)) {
			// Silence is ambiguous — a long think and a hang look identical from
			// outside. Say so once rather than leaving the run looking healthy.
			process.stdout.write(
				`[idle] ${d} — no ledger writes for ${Math.round((Date.now() - now.mtime) / 60000)}m (thinking, or stuck)\n`,
			);
			idleAnnounced.add(d);
		}
	}
	await new Promise((r) => setTimeout(r, intervalMs));
}
