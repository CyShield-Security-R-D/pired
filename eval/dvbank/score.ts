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

	// A finding often names its file only through the inventory element it targets
	// ("target": "e1587b" -> endpoint path src/requests/utils.py). Resolving that
	// recovers findings that are perfectly well located but whose file lives one
	// hop away, which the raw text scan drops.
	//
	// Deliberately conservative: the file may come from the inventory, but the
	// LINE must appear in the finding itself. Inventing a line would let a
	// file-only finding land inside a truth window by accident, which inflates
	// recall — a worse failure than under-counting.
	const inventory = new Map<string, string>();
	for (const r of await ws.read("inventory")) {
		const rec = r as unknown as { id: string; path?: string; value?: string };
		const file = rec.path ?? rec.value;
		if (file && /\.(?:py|pyi|js|jsx|ts|tsx|go|rb|php|java|cs|rs|kt|scala)$/.test(file)) inventory.set(rec.id, file);
	}

	const out: Finding[] = [];
	for (const f of await ws.read("findings")) {
		const hay = [f.target, f.description, f.repro, f.title, ...(f.evidence ?? [])].filter(Boolean).join(" ");
		let m = /([\w./-]+\.(?:py|pyi|js|jsx|ts|tsx|go|rb|php|java|cs|rs|kt|scala)):(\d+)/.exec(hay);
		if (!m) {
			// file from the inventory + a line stated in the finding's own text
			const viaInventory = f.target ? inventory.get(f.target) : undefined;
			const line = /\bline[s]?\s+(\d+)/i.exec(hay);
			if (viaInventory && line) m = [hay, viaInventory, line[1]!] as unknown as RegExpExecArray;
		}
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

/**
 * @param truthPath ground truth to score against. Defaults to DVBank's key; the
 *   real-app corpus passes its own per-target file, which the grader accepts
 *   unchanged (verified: an oracle built from a corpus truth file scores 1.0).
 */
export async function scoreFindings(findings: Finding[], outPath: string, truthPath?: string): Promise<Score> {
	const tmp = `${outPath}.findings.json`;

	// Corpus truth is built from OSV advisories, which carry a file and a line
	// range but no CWE or vuln_class. The grader's class_matches() allows a
	// location-only match ONLY when the finding omits both class fields; a
	// finding that supplies a CWE falls through to equality checks against a
	// truth class that does not exist, and is scored as a miss.
	//
	// So against classless truth, reporting a CWE — exactly what both harnesses
	// are prompted to do — guarantees a false negative. Strip the class fields
	// in that case so matching is location-only, which is the only thing this
	// truth can actually support. DVBank's own key carries classes and is
	// untouched.
	let scored = findings;
	if (truthPath) {
		const truth = JSON.parse(await readFile(truthPath, "utf8")) as Array<Record<string, unknown>>;
		const classless = truth.every((t) => !t.cwe && !t.vuln_class);
		if (classless) scored = findings.map(({ cwe: _c, vuln_class: _v, ...rest }) => rest);
	}
	await writeFile(tmp, JSON.stringify(scored, null, 2));
	try {
		await run("python3", [
			join(DVBANK, "eval/graders/detection_grader.py"),
			"--truth", truthPath ?? join(DVBANK, "eval/ground_truth.json"),
			"--findings", tmp,
			...(truthPath ? [] : ["--decoys", join(DVBANK, "eval/decoys/manifest.json")]),
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

/**
 * What the coverage machinery actually did, independent of what it found.
 *
 * Every sealed library run scored some recall and recorded **zero hypotheses**:
 * the mechanism under test never engaged, and the number that came out was a
 * measurement of a plain reviewer with a weaker model. Recall alone cannot tell
 * those two situations apart, which is how a corpus spent three passes measuring
 * the wrong thing before a contradiction with DVBank surfaced it.
 *
 * Reported beside recall from now on. A run with zero hypotheses is a void
 * result, not a low score.
 */
export interface EngagementTelemetry {
	surface: number;
	hypotheses: number;
	settled: number;
	findings: number;
	/**
	 * Distinct reasoning behind the settled cells.
	 *
	 * `record` takes lists for target and class and writes the cross product, so
	 * one judgement can settle a hundred cells. Measured on filebrowser: 1,438
	 * refutations from 44 distinct statements, a 33x multiplier — and one of those
	 * 44 was "command execution is by design with proper access controls",
	 * replicated 103 times over the code the advisory was actually about.
	 *
	 * Reporting cells alone makes 44 acts of reasoning look like near-complete
	 * coverage. Reporting both makes the amplification visible.
	 */
	judgements: number;
	/** The largest number of cells a single statement settled. */
	widest: number;
}

export async function engagementTelemetry(engagementDir: string): Promise<EngagementTelemetry> {
	const empty = { surface: 0, hypotheses: 0, settled: 0, findings: 0, judgements: 0, widest: 0 };
	if (!existsSync(engagementDir)) return empty;
	try {
		const ws = new Workspace(engagementDir, makeHostServices());
		const hyps = await ws.read("hypotheses");
		return {
			surface: (await ws.read("inventory")).length,
			hypotheses: hyps.length,
			// Settled means the cell moved: a proposal nobody tested leaves the
			// matrix exactly as open as it was.
			settled: hyps.filter((h) => h.outcome === "confirmed" || h.outcome === "refuted").length,
			judgements: new Set(hyps.map((h) => `${h.outcome}:${h.statement ?? ""}`)).size,
			widest: hyps.reduce((max, h) => {
				const n = hyps.filter((o) => o.statement === h.statement && o.outcome === h.outcome).length;
				return n > max ? n : max;
			}, 0),
			findings: (await ws.read("findings")).length,
		};
	} catch {
		return empty;
	}
}
