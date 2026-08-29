/**
 * Score a pired ledger against DVBank's ground truth.
 *
 * Shared by the one-shot re-run and the compounding experiment. Extracted
 * because the compounding question — does a persisted ledger make session 3 add
 * findings rather than repeat session 1 — can only be asked against a key, and
 * DVBank is the only real key available.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Workspace } from "../../core/workspace.ts";
import { makeHostServices } from "../../extensions/lib/host.ts";

const run = promisify(execFile);
export const DVBANK = process.env.DVBANK ?? "/home/mamgad/DVBank";

export interface Finding {
	file: string;
	line?: number;
	cwe?: string;
	vuln_class?: string;
	severity?: string;
	message?: string;
}

/**
 * Recover benchmark-schema findings from pired's ledger. A finding is usable
 * only if a file:line can be found in its target, description, repro or
 * evidence — the grader matches on location, so a finding without one is
 * unscoreable however correct its prose.
 */
export async function fromLedger(engagementDir: string): Promise<Finding[]> {
	if (!existsSync(join(engagementDir, "findings.jsonl"))) return [];
	const ws = new Workspace(engagementDir, makeHostServices());
	const out: Finding[] = [];
	for (const f of await ws.read("findings")) {
		const hay = [f.target, f.description, f.repro, ...(f.evidence ?? [])].filter(Boolean).join(" ");
		const m = /([\w./-]+\.(?:py|js|jsx|ts|tsx)):(\d+)/.exec(hay);
		if (!m) continue;
		out.push({
			file: m[1] as string,
			line: Number(m[2]),
			cwe: f.cwe,
			vuln_class: f.class,
			severity: f.severity,
			message: f.title,
		});
	}
	return out;
}

/** One file+line is one claim, however many times it was reported. */
export function dedupe(findings: Finding[]): Finding[] {
	const seen = new Set<string>();
	return findings.filter((f) => {
		const key = `${f.file}:${f.line ?? 0}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export interface Score {
	recall: number;
	precision: number;
	f1: number;
	true_positives: number;
	total_findings: number;
}

export async function scoreFindings(findings: Finding[], outPath: string): Promise<Score> {
	const tmp = `${outPath}.findings.json`;
	await writeFile(tmp, JSON.stringify(findings, null, 2));
	try {
		await run("python3", [
			join(DVBANK, "eval/graders/detection_grader.py"),
			"--truth", join(DVBANK, "eval/ground_truth.json"),
			"--findings", tmp,
			"--decoys", join(DVBANK, "eval/decoys/manifest.json"),
			"--window", "3", "--out", outPath,
		], { maxBuffer: 1 << 26 });
		// Metrics are nested under `summary`; reading the top level scores a
		// perfect run at zero.
		const parsed = JSON.parse(await readFile(outPath, "utf8")) as { summary?: Score };
		return parsed.summary ?? { recall: 0, precision: 0, f1: 0, true_positives: 0, total_findings: 0 };
	} catch {
		return { recall: 0, precision: 0, f1: 0, true_positives: 0, total_findings: 0 };
	}
}
