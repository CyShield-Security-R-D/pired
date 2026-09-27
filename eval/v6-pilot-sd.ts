#!/usr/bin/env -S node --experimental-strip-types
/**
 * The blind internal pilot of the delegation v6 trial (pre-registration,
 * "Sample size"): after stage 1's two pilot passes, the pooled paired SD of
 * advisories found fixes how many passes per target the stage runs.
 *
 * The pass count is chosen from the SD alone, before anyone has seen which arm
 * is ahead. A pass count chosen after reading the difference is a stopping rule
 * fitted to the result: "the candidate is 0.2 ahead, three more passes should
 * make it significant". So this prints and writes three numbers and nothing
 * else: how many pairs were valid, the SD of their differences, and the pass
 * count the pre-registered rule gives. The SD is the same whichever arm is
 * ahead (swapping the arms negates every difference and leaves it unchanged),
 * and the other two do not depend on the differences at all. No mean, no arm
 * total, no per-target value, no sign.
 *
 * It reads the grid's runs, its manifest and the answer keys it names, as
 * eval/rescore.ts does, and never `<out>/sealed/`, where the harness keeps the
 * arms' numbers until the count is fixed. The full comparison is
 * eval/v6-decision.ts, which refuses a grid whose count is not yet fixed.
 *
 * A valid pair is what the harness recorded valid. Under the v6 validity
 * policy both stage kinds pin, that includes runs that reached the run limit
 * and fast empty runs: they are paired like any other, and their flags are not
 * read here, since how many each arm had would show which arm works longer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dropTwins, pairDiffs, pairRuns, sampleSd, twinIdsFromManifests, type ArmPair, type RunRecord } from "./paired.ts";
import { rescoreGrid, type RescoreRow, type Truth } from "./rescore.ts";

/**
 * The official rule of the v6 trial: the pinned grader's own matching, read
 * per advisory (rescore's `officialAdvisories`). The fresh corpus's truth is
 * location-only: its labels carry `cwes` for the re-scorer's class level but no
 * `cwe` or `vuln_class`, so the grader has no class to refuse a claim on. It
 * still differs from rescore's "line±3" advisory level, which is reported as
 * robustness: it matches basenames (`lib/app.py` credits a label in
 * `src/app.py`), and it credits one claim to one label, so a claim near two
 * advisories finds one. A key that carried classes would make the official
 * rule class-sensitive, and the pre-registration calls the truth location-only,
 * so `assertLocationOnlyTruth` refuses it rather than score a rule nobody
 * registered.
 */
export const OFFICIAL_LEVEL = "official";

/** Stage 1's arms as the harness names them: A (incumbent) is `baseline`, S (candidate solo) is `candidate`. */
export const STAGE1_ARMS: ArmPair = ["baseline", "candidate"];

/** The pre-registered rule: ⌈(1.96 + 0.84)² · SD² / 0.3² / 12⌉ passes, capped at 10, with the pilot's 2 as the floor. */
export const PILOT = { zSum: 1.96 + 0.84, effect: 0.3, targets: 12, cap: 10, floor: 2 } as const;

/** Throws when any answer key carries a class: the official rule would then not be the location level this reads. */
export function assertLocationOnlyTruth(truths: ReadonlyMap<string, readonly Truth[]>): void {
	const classed = [...truths.entries()].flatMap(([target, ts]) => ts.filter((t) => t.cwe !== undefined || t.vulnClass !== undefined).map((t) => `${target}:${t.id}`));
	if (classed.length) {
		throw new Error(`the truth carries classes (${classed.slice(0, 5).join(", ")}${classed.length > 5 ? ", …" : ""}): the official rule is then class-sensitive and "${OFFICIAL_LEVEL}" is not it; this analysis is for the location-only fresh corpus`);
	}
}

/**
 * Rescored rows as eval/paired.ts records, with `matched` read from the given
 * field: advisories found per level (the primary metric) or unique labels.
 * A twin's row keeps its control score, which marks it for dropTwins.
 */
export function toRecords(rows: readonly RescoreRow[], field: "advisoriesMatched" | "matched" = "advisoriesMatched"): RunRecord[] {
	return rows.map((r) => ({
		grid: r.grid, target: r.target, pass: r.pass, arm: r.arm, attempt: r.attempt, tokens: r.tokens,
		// Advisory records carry the official level beside the location levels.
		matched: field === "advisoriesMatched" ? { ...r.advisoriesMatched, [OFFICIAL_LEVEL]: r.officialAdvisories } : r.matched,
		...(r.control ? { control: r.control } : {}),
	}));
}

/** The pass count the pre-registered rule gives for an SD, and the amendment kind that records it. */
export function passesFor(sd: number): { formula: number; passes: number; amendment: "extend-passes" | "fix-passes" } {
	const raw = (PILOT.zSum ** 2 * sd ** 2) / PILOT.effect ** 2 / PILOT.targets;
	// Rounding error must not add a pass: a value that is a whole number on paper
	// can land a hair above it in floating point (1.96 + 0.84 is not exactly 2.8).
	const formula = Math.max(0, Math.ceil(raw - 1e-9));
	const passes = Math.max(PILOT.floor, Math.min(PILOT.cap, formula));
	return { formula, passes, amendment: passes <= PILOT.floor ? "fix-passes" : "extend-passes" };
}

/** Everything the pilot may show. Nothing here reveals which arm is ahead. */
export interface PilotResult {
	metric: string;
	level: string;
	validPairs: number;
	pooledPairedSd: number;
	/** ⌈(1.96 + 0.84)² · SD² / 0.3² / 12⌉ before the cap and floor. */
	formula: number;
	passes: number;
	amendment: "extend-passes" | "fix-passes";
}

/**
 * The pilot's numbers from a stage-1 grid. The SD is pooled over every valid
 * pair, as eval/paired.ts computes the paired SD and as the v5c figure of 0.88
 * the pre-registration starts from was computed; a within-target pooled SD
 * would drop the between-app spread the app-clustered interval pays for.
 */
export function pilotSd(gridDir: string): PilotResult {
	const manifestPath = join(gridDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { gridKind?: unknown };
	if (manifest.gridKind !== "v6-stage1") throw new Error(`the pilot is stage 1's: ${gridDir} is grid kind ${JSON.stringify(manifest.gridKind ?? null)}, not "v6-stage1"`);
	// The pilot reads a grid the harness summarised blind, and only such a grid:
	// on one summarised in the open the numbers were already shown, and a pass
	// count fixed from it would not be blind.
	const summaryPath = join(gridDir, "summary.json");
	const pilot = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, "utf8")) as { pilot?: { blinded?: unknown } }).pilot : undefined;
	if (typeof pilot?.blinded !== "boolean") throw new Error(`${gridDir}: summary.json has no pilot.blinded; the pilot reads only a stage-1 grid the harness summarised blind`);
	const { rows, truths } = rescoreGrid(gridDir);
	assertLocationOnlyTruth(truths);
	const { kept } = dropTwins(toRecords(rows), twinIdsFromManifests([manifestPath], (p) => readFileSync(p, "utf8")));
	const diffs = pairDiffs(pairRuns(kept, OFFICIAL_LEVEL, STAGE1_ARMS));
	if (diffs.length < 2) throw new Error(`the pilot needs at least two valid pairs to measure an SD; ${gridDir} has ${diffs.length}`);
	const sd = sampleSd(diffs);
	return { metric: "advisories found per pair (the pinned grader's matching), paired difference (direction withheld)", level: OFFICIAL_LEVEL, validPairs: diffs.length, pooledPairedSd: sd, ...passesFor(sd) };
}

export function formatPilot(r: PilotResult): string {
	const reason = `pre-registered pilot rule: pooled paired SD ${r.pooledPairedSd.toFixed(3)} over ${r.validPairs} valid pairs; ceil(2.8^2 * SD^2 / 0.3^2 / 12) = ${r.formula}, capped at 10, floor 2 -> ${r.passes}`;
	return [
		`v6 pilot (blind): ${r.metric}, at the ${r.level} rule (location-only truth)`,
		`valid pairs: ${r.validPairs}`,
		`pooled paired SD: ${r.pooledPairedSd.toFixed(3)}`,
		`passes per target: ceil((1.96 + 0.84)^2 * SD^2 / 0.3^2 / 12) = ${r.formula}; capped at 10, floor 2 -> ${r.passes} (${r.amendment})`,
		`amend once: eval/delegation-compare.ts --resume <this grid> --extend-passes ${r.passes} --extend-reason "${reason}"`,
	].join("\n");
}

const USAGE = "Usage: v6-pilot-sd.ts <stage-1 grid dir> [--out <path>]   (default <grid>/v6-pilot-sd.json)\n";

/** The CLI with its writer injected: returns the exit code and what to print. */
export function cli(argv: readonly string[], write: (path: string, text: string) => void): { code: number; out: string } {
	let grid: string | undefined;
	let out: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--out") out = argv[++i];
		else if (!grid) grid = argv[i];
	}
	if (!grid) return { code: 2, out: USAGE };
	const result = pilotSd(grid);
	write(out ?? join(grid, "v6-pilot-sd.json"), `${JSON.stringify(result, null, 2)}\n`);
	return { code: 0, out: `${formatPilot(result)}\n` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const { code, out } = cli(process.argv.slice(2), (path, text) => writeFileSync(path, text));
		(code ? process.stderr : process.stdout).write(out);
		process.exitCode = code;
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
