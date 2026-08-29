#!/usr/bin/env -S node --experimental-strip-types
/**
 * Re-score a completed corpus run against its own truth files.
 *
 * Exists because the first corpus runs were graded before the classless-truth
 * fix in `dvbank/score.ts`. Corpus truth comes from OSV advisories, which carry
 * a file and a line range but no CWE, and the grader only permits a
 * location-only match when the finding omits its class fields — so a finding
 * that reported a CWE, which is exactly what both harnesses are prompted to do,
 * was scored as a miss. Every corpus zero was that.
 *
 * Findings are already on disk, so re-scoring costs nothing and no model is
 * called. Reads whatever the arm produced:
 *   codex  → <work>/<id>-<run>.last.json   ({"findings":[...]})
 *   pired  → the engagement ledger for the target's basename
 *
 *   node eval/corpus/rescore.ts --arm codex --work /tmp/corpus-codex
 *   node eval/corpus/rescore.ts --arm pired
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dedupe, fromLedger, scoreFindings } from "../dvbank/score.ts";
import type { Finding } from "../dvbank/score.ts";

const arg = (n: string, d = ""): string => {
	const i = process.argv.indexOf(`--${n}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : d;
};

interface Entry { id: string; package: string; repo: string; target: string; truth: string; entries: number }

/** Unique findings in the ledger, however they are worded. */
async function recordedCount(target: string): Promise<number> {
	const dir = join(homedir(), ".pired", "engagements", basename(target));
	if (!existsSync(join(dir, "findings.jsonl"))) return 0;
	const { Workspace } = await import("../../core/workspace.ts");
	const { makeHostServices } = await import("../../extensions/lib/host.ts");
	const ws = new Workspace(dir, makeHostServices());
	return (await ws.read("findings")).length;
}

const corpusDir = arg("corpus", "/tmp/corpus");
const arm = arg("arm", "pired");
const workDir = arg("work", arm === "codex" ? "/tmp/corpus-codex" : "/tmp/corpus-rescore");
const manifest = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")) as Entry[];

async function codexFindings(id: string): Promise<Finding[] | undefined> {
	const files = (await readdir(workDir).catch(() => [])).filter((f) => f.startsWith(`${id}-`) && f.endsWith(".last.json"));
	if (files.length === 0) return undefined;
	try {
		const raw = await readFile(join(workDir, files[files.length - 1]!), "utf8");
		const m = /\{[\s\S]*\}/.exec(raw);
		return dedupe((JSON.parse(m ? m[0] : raw) as { findings?: Finding[] }).findings ?? []);
	} catch {
		return undefined;
	}
}

async function piredFindings(target: string): Promise<Finding[] | undefined> {
	const dir = join(homedir(), ".pired", "engagements", basename(target));
	if (!existsSync(join(dir, "findings.jsonl"))) return undefined;
	return dedupe(await fromLedger(dir));
}

interface Row { id: string; repo: string; truth: number; found: number; recall: number; reported: number; recorded: number }
const rows: Row[] = [];
const missing: string[] = [];

for (const m of manifest) {
	const findings = arm === "codex" ? await codexFindings(m.id) : await piredFindings(m.target);
	if (findings === undefined) {
		// No output at all is not a zero score — it is an absent measurement, and
		// pooling it as 0 recall is how a broken run becomes a published number.
		missing.push(m.id);
		continue;
	}
	const truth = JSON.parse(await readFile(m.truth, "utf8")) as unknown[];
	const score = await scoreFindings(findings, join(workDir, `rescore-${m.id}.report.json`), m.truth);
	// How many findings the arm actually recorded, against how many carried a
	// location the grader can place. The gap is a measurement floor, not a
	// detection failure, and hiding it would overstate how much the arm missed.
	const recorded = arm === "pired" ? await recordedCount(m.target) : findings.length;
	rows.push({ id: m.id, repo: m.repo, truth: truth.length, found: score.true_positives, recall: score.recall, reported: findings.length, recorded });
}

process.stdout.write(`\n⦿ corpus · ${arm} · re-scored with classless-truth matching\n\n`);
process.stdout.write(`${"target".padEnd(22)}${"repo".padEnd(24)}${"truth".padStart(6)}${"found".padStart(6)}${"recall".padStart(8)}${"scored".padStart(8)}${"recorded".padStart(10)}\n`);
for (const r of [...rows].sort((a, b) => b.recall - a.recall || a.id.localeCompare(b.id))) {
	process.stdout.write(`${r.id.padEnd(22)}${r.repo.slice(0, 23).padEnd(24)}${String(r.truth).padStart(6)}${String(r.found).padStart(6)}${r.recall.toFixed(2).padStart(8)}${String(r.reported).padStart(8)}${String(r.recorded).padStart(10)}\n`);
}

const truthTotal = rows.reduce((a, r) => a + r.truth, 0);
const foundTotal = rows.reduce((a, r) => a + r.found, 0);
process.stdout.write(`\n  scored targets      ${rows.length}/${manifest.length}${missing.length ? ` (no output: ${missing.join(", ")})` : ""}\n`);
process.stdout.write(`  pooled recall       ${foundTotal}/${truthTotal} = ${truthTotal ? (foundTotal / truthTotal).toFixed(3) : "n/a"}\n`);
process.stdout.write(`  targets with a hit  ${rows.filter((r) => r.found > 0).length}/${rows.length}\n`);
process.stdout.write(`  findings scored     ${rows.length ? (rows.reduce((a, r) => a + r.reported, 0) / rows.length).toFixed(1) : "n/a"} mean\n`);
const rec = rows.reduce((a, r) => a + r.recorded, 0);
const sc = rows.reduce((a, r) => a + r.reported, 0);
if (rec > sc) {
	process.stdout.write(`  findings recorded   ${(rec / rows.length).toFixed(1)} mean — ${rec - sc} carried no line the grader could place\n`);
}
