import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocationOnlyTruth, cli, formatPilot, passesFor, pilotSd } from "./v6-pilot-sd.ts";

type Row = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		const sealed = join(d, "sealed");
		if (existsSync(join(d, "sealed-locked"))) chmodSync(sealed, 0o755);
		rmSync(d, { recursive: true, force: true });
	}
});

const LINES = [10, 50, 90, 130];

/** One run: how many of its target's advisories it found (the first `found` of four). */
interface RunSpec { target: string; pass: number; arm: string; found: number; attempt?: number; valid?: boolean; reachedLimit?: boolean; fastEmpty?: boolean }

/**
 * A stage-1 grid: each target `app-<t>` has four one-label advisories in
 * `src/<t>.py` at LINES, and a patched twin with no labels. A run finds an
 * advisory by citing its line.
 */
function grid(runs: RunSpec[], options: { targets?: string[]; truthExtra?: Row; gridKind?: string; summary?: Row | null; citeIn?: (target: string) => string } = {}): string {
	const g = mkdtempSync(join(tmpdir(), "v6-pilot-"));
	dirs.push(g);
	const keys = join(g, "keys");
	mkdirSync(keys);
	const targets = options.targets ?? [...new Set(runs.map((r) => r.target))];
	for (const t of targets) {
		writeFileSync(join(keys, `app-${t}.truth.json`), JSON.stringify(LINES.map((line, i) => ({ id: `ADV-${t}-${i}-1`, advisory: `ADV-${t}-${i}`, file: `src/${t}.py`, line, line_range: [line, line + 2], cwes: ["CWE-89"], ...options.truthExtra }))));
		writeFileSync(join(keys, `app-${t}-patched.truth.json`), "[]");
	}
	const manifest = {
		gridKind: options.gridKind ?? "v6-stage1",
		targets: [
			...targets.map((t) => ({ id: t, name: `app-${t}` })),
			...targets.map((t) => ({ id: `${t}-patched`, name: `app-${t}-patched`, twinOf: t, fixed_regions: [{ file: `src/${t}.py`, line_range: [10, 12] }], scope_loc: 2000 })),
		],
		inputs: { truth: keys },
	};
	writeFileSync(join(g, "manifest.json"), JSON.stringify(manifest));
	// What the harness writes while the pilot is blind: the SD block, nothing of the arms.
	if (options.summary !== null) writeFileSync(join(g, "summary.json"), JSON.stringify(options.summary ?? { pilot: { blinded: true, validPairs: runs.length / 2, sd: 1 } }));
	runs.forEach((r, i) => {
		const dir = join(g, "runs", `cell-${i}`);
		mkdirSync(join(dir, "workspace"), { recursive: true });
		const file = r.target.endsWith("-patched") ? r.target.replace(/-patched$/, "") : r.target;
		const flags = r.reachedLimit === undefined && r.fastEmpty === undefined ? {} : { reachedLimit: r.reachedLimit ?? false, fastEmpty: r.fastEmpty ?? false, limitEffects: [] };
		writeFileSync(join(dir, "run.json"), JSON.stringify({ target: r.target, pass: r.pass, arm: r.arm, attempt: r.attempt ?? 1, valid: r.valid ?? true, ...flags, truePositives: r.found, findings: r.found, totalTokens: 1000 }));
		const path = options.citeIn?.(r.arm) ?? "src";
		const rows = LINES.slice(0, r.found).map((line, k) => ({ id: `F${k}`, title: "injection", target: `${path}/${file}.py:${line}` }));
		writeFileSync(join(dir, "workspace", "findings.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n"));
	});
	return g;
}

/** Both arms on every (target, pass), with per-arm find counts from the table. */
function pilotRuns(table: Array<[target: string, pass: number, baseline: number, candidate: number]>): RunSpec[] {
	return table.flatMap(([target, pass, b, c]) => [{ target, pass, arm: "baseline", found: b }, { target, pass, arm: "candidate", found: c }]);
}

const swapArms = (runs: RunSpec[]): RunSpec[] => runs.map((r) => ({ ...r, arm: r.arm === "baseline" ? "candidate" : r.arm === "candidate" ? "baseline" : r.arm }));

// Differences 1, 0, 2, 0 on alpha and beta: mean 0.75, SD 0.957, 7 passes. The arm totals are 6 and 9.
const TABLE: Array<[string, number, number, number]> = [["alpha", 1, 2, 3], ["alpha", 2, 1, 1], ["beta", 1, 2, 4], ["beta", 2, 1, 1]];

describe("the pre-registered pass count", () => {
	it("gives about 11 passes at an SD of 1.2 and caps it at 10, as the pre-registration's worked example says", () => {
		expect(passesFor(1.2)).toEqual({ formula: 11, passes: 10, amendment: "extend-passes" });
	});

	it("gives 6 passes at v5c's measured SD of 0.88", () => {
		expect(passesFor(0.88)).toEqual({ formula: 6, passes: 6, amendment: "extend-passes" });
	});

	it("never goes below the pilot's own 2 passes, and records that as fixing the count rather than extending it", () => {
		expect(passesFor(0)).toEqual({ formula: 0, passes: 2, amendment: "fix-passes" });
		expect(passesFor(0.5)).toEqual({ formula: 2, passes: 2, amendment: "fix-passes" });
	});

	it("does not add a pass for floating-point noise on a whole-number result", () => {
		// SD² chosen so 7.84 · SD² / 1.08 is exactly 3 on paper.
		expect(passesFor(Math.sqrt((3 * 1.08) / 7.84)).formula).toBe(3);
	});
});

describe("pilotSd", () => {
	it("measures the pooled paired SD of advisories found over the valid pairs only, dropping twins, invalid runs and mismatched attempts", () => {
		const runs = [
			...pilotRuns(TABLE),
			// A twin's rows would add zero-difference pairs and shrink the SD.
			{ target: "alpha-patched", pass: 1, arm: "baseline", found: 1 }, { target: "alpha-patched", pass: 1, arm: "candidate", found: 1 },
			// An invalid candidate: the pair does not count.
			{ target: "gamma", pass: 1, arm: "baseline", found: 1 }, { target: "gamma", pass: 1, arm: "candidate", found: 4, valid: false },
			// A baseline retried once, paired with a first-attempt candidate: not a pair.
			{ target: "gamma", pass: 2, arm: "baseline", found: 0, attempt: 2 }, { target: "gamma", pass: 2, arm: "candidate", found: 4 },
		];
		const r = pilotSd(grid(runs));
		expect(r.validPairs).toBe(4);
		expect(r.pooledPairedSd).toBeCloseTo(Math.sqrt(((1 - 0.75) ** 2 + 0.75 ** 2 + 1.25 ** 2 + 0.75 ** 2) / 3), 10);
		expect(r.level).toBe("official");
	});

	it("counts advisories by the pinned grader's matching, so a basename collision counts as it does officially", () => {
		// The candidate cites lib/<t>.py: the grader credits it by basename, the line±3 level would not.
		const g = grid(pilotRuns(TABLE), { citeIn: (arm) => (arm === "candidate" ? "lib" : "src") });
		expect(pilotSd(g).pooledPairedSd).toBeCloseTo(pilotSd(grid(pilotRuns(TABLE))).pooledPairedSd, 10);
	});

	it("counts an advisory once however many of its labels a run hits", () => {
		const g = grid([{ target: "alpha", pass: 1, arm: "baseline", found: 0 }, { target: "alpha", pass: 1, arm: "candidate", found: 2 }, { target: "alpha", pass: 2, arm: "baseline", found: 0 }, { target: "alpha", pass: 2, arm: "candidate", found: 0 }]);
		// Both of the candidate's finds are relabelled as one advisory: the difference is 1, not 2.
		const key = join(g, "keys", "app-alpha.truth.json");
		const labels = JSON.parse(readFileSync(key, "utf8")) as Row[];
		writeFileSync(key, JSON.stringify(labels.map((l, i) => (i < 2 ? { ...l, advisory: "ADV-shared" } : l))));
		expect(pilotSd(g).pooledPairedSd).toBeCloseTo(Math.SQRT1_2, 10);
	});

	it("refuses a truth that carries classes, because the official rule would then not be the location level it reads", () => {
		expect(() => pilotSd(grid(pilotRuns(TABLE), { truthExtra: { cwe: "CWE-89" } }))).toThrow(/truth carries classes/);
		expect(() => assertLocationOnlyTruth(new Map([["t", [{ id: "x", file: "a.py", line: 1, lo: 1, hi: 1, vulnClass: "sqli" }]]]))).toThrow(/t:x/);
	});

	it("refuses a grid the harness did not summarise blind, since a count fixed after the numbers were shown is not blind", () => {
		expect(() => pilotSd(grid(pilotRuns(TABLE), { summary: null }))).toThrow(/no pilot.blinded/);
		expect(() => pilotSd(grid(pilotRuns(TABLE), { summary: { comparison: {} } }))).toThrow(/no pilot.blinded/);
	});

	it("refuses a grid that is not stage 1, and one with fewer than two valid pairs", () => {
		expect(() => pilotSd(grid(pilotRuns(TABLE), { gridKind: "v6-stage2" }))).toThrow(/not "v6-stage1"/);
		expect(() => pilotSd(grid(pilotRuns(TABLE.slice(0, 1))))).toThrow(/at least two valid pairs/);
	});
});

describe("the blind output", () => {
	const run = (g: string): { out: string; written: string } => {
		let written = "";
		const { code, out } = cli([g], (_path, text) => { written = text; });
		expect(code).toBe(0);
		return { out, written };
	};

	it("leaks no direction: no mean, no arm name or total, no target, and the same bytes when the arms are swapped", () => {
		const forward = run(grid(pilotRuns(TABLE)));
		const backward = run(grid(swapArms(pilotRuns(TABLE))));
		const strip = (s: string) => s.replace(/--resume \S+/, "--resume <grid>");
		expect(strip(backward.out)).toBe(strip(forward.out));
		expect(backward.written).toBe(forward.written);
		for (const text of [forward.out, forward.written]) {
			// The mean difference (0.75) in any rounding, and a sign in front of any number.
			expect(text).not.toMatch(/0\.75|\.750|mean|average/i);
			expect(text).not.toMatch(/(^|[\s:=(])[+−-]\d/m);
			// Arm names and per-arm totals (4 and 7), per-target ids.
			expect(text).not.toMatch(/baseline|candidate|incumbent/i);
			expect(text).not.toMatch(/alpha|beta/);
			expect(text).not.toMatch(/\b[69]\b/);
		}
		expect(Object.keys(JSON.parse(forward.written) as Row).sort()).toEqual(["amendment", "formula", "level", "metric", "passes", "pooledPairedSd", "validPairs"]);
		expect(forward.out).toContain("valid pairs: 4");
		expect(forward.out).toContain("pooled paired SD: 0.957");
	});

	// Under the v6 validity policy a run that reached the limit, or ended fast and
	// empty, is a valid run: the pilot pairs it like any other, and flagging it
	// neither changes the SD nor lets which arm had it show.
	it("counts limit-reaching and fast empty runs as valid pairs, with the same bytes whichever arm had them", () => {
		const flag = (runs: RunSpec[]): RunSpec[] => runs.map((r) => (r.arm === "candidate" && r.target === "alpha" ? { ...r, reachedLimit: true } : r.arm === "baseline" && r.pass === 2 ? { ...r, fastEmpty: true, found: 0 } : r));
		const table: Array<[string, number, number, number]> = [["alpha", 1, 2, 3], ["alpha", 2, 0, 1], ["beta", 1, 2, 4], ["beta", 2, 0, 1]];
		const forward = run(grid(flag(pilotRuns(table))));
		const backward = run(grid(swapArms(flag(pilotRuns(table)))));
		const plain = run(grid(pilotRuns(table)));
		const strip = (s: string) => s.replace(/--resume \S+/, "--resume <grid>");
		expect(forward.out).toContain("valid pairs: 4");
		expect(strip(backward.out)).toBe(strip(forward.out));
		expect(backward.written).toBe(forward.written);
		expect(forward.written).toBe(plain.written);
		expect(forward.out).not.toMatch(/limit|fast|empty/i);
	});

	it("never opens <out>/sealed/, where the harness keeps the arms' numbers until the count is fixed", () => {
		const g = grid(pilotRuns(TABLE));
		mkdirSync(join(g, "sealed"));
		writeFileSync(join(g, "sealed", "comparison.json"), JSON.stringify({ meanDiff: 0.75 }));
		writeFileSync(join(g, "sealed-locked"), "");
		chmodSync(join(g, "sealed"), 0o000);
		// Any read under sealed/ now throws EACCES.
		expect(run(g).out).toContain("valid pairs: 4");
	});

	it("writes its JSON beside the grid by default, or where --out says", () => {
		const g = grid(pilotRuns(TABLE));
		const paths: string[] = [];
		cli([g], (p) => paths.push(p));
		cli([g, "--out", join(g, "x.json")], (p) => paths.push(p));
		expect(paths).toEqual([join(g, "v6-pilot-sd.json"), join(g, "x.json")]);
		expect(cli([], () => undefined).code).toBe(2);
	});

	it("tells the operator which amendment to record, with the rule's inputs as its reason", () => {
		const text = formatPilot({ metric: "m", level: "line±3", validPairs: 24, pooledPairedSd: 0.88, formula: 6, passes: 6, amendment: "extend-passes" });
		expect(text).toContain("--extend-passes 6");
		expect(text).toContain("(extend-passes)");
	});
});
