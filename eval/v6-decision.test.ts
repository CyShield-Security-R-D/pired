import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bridgeDvsA, cli, decide, exportWorksheets, formatBridge, formatDecision, joinLabels, parseLabels, RULES, shipTable, stopping, worksheetKeys,
	type Decision, type Outcome,
} from "./v6-decision.ts";

type Row = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LINES = [10, 50, 90, 130];
const FP_LINES = [300, 340, 380];
const TARGETS = ["t1", "t2", "t3", "t4", "t5", "t6"];

/**
 * One run: the first `found` of its target's four advisories, then `fps`
 * claims the key does not label, or `rows` as given. `tokens: null` is a run
 * without a token count; `cost: null` one without a recorded cost.
 */
interface RunSpec { target: string; pass: number; arm: string; found: number; fps?: number; rows?: Row[]; tokens?: number | null; cost?: number | null; attempt?: number; stop?: Row; cell?: string; reachedLimit?: boolean; fastEmpty?: boolean }

const stop = (outcome: "finished" | "offered-to-continue", timeShare: number, leftWithOpenWork: boolean): Row => ({ outcome, evidence: [], crossCheck: null, workers: [], timeShare, leftWithOpenWork });

/** Both arms on every target × pass, from a function giving each arm's spec. */
function pairs(ref: string, sub: string, spec: (t: string, p: number) => [Partial<RunSpec>, Partial<RunSpec>], passes = 2, targets = TARGETS): RunSpec[] {
	return targets.flatMap((target) => Array.from({ length: passes }, (_, i) => i + 1).flatMap((pass) => {
		const [r, s] = spec(target, pass);
		return [{ target, pass, arm: ref, found: 1, ...r }, { target, pass, arm: sub, found: 1, ...s }];
	}));
}

/** A harness not-ready reason, as summary.decision.reasons carries it. */
const code = (c: string, keys?: string[]): Row => ({ code: c, reason: `${c} (test)`, ...(keys ? { keys } : {}) });

interface GridOptions {
	stage?: "v6-stage1" | "v6-stage2";
	amended?: boolean;
	/** The harness's reason codes; ready is true exactly when there are none. */
	codes?: Row[];
	summary?: Row;
	unions?: Row[];
	twins?: RunSpec[];
	truthExtra?: Row;
	/** Extra labels per target, beside the four advisories. */
	moreTruth?: (t: string) => Row[];
	/** Pairs the grid was built to run beyond those with runs. */
	expected?: string[];
}

/**
 * A v6 grid: each target `app-<t>` has four one-label advisories in
 * `src/<t>.py` at LINES and a neutral region at 500; a patched twin per target.
 * Stage 1 carries its pass-count amendment and stage 2 its adopted count
 * unless told otherwise, and summary.json is what the harness writes: a
 * decision block whose reasons are codes.
 */
function grid(runs: RunSpec[], o: GridOptions = {}): string {
	const g = mkdtempSync(join(tmpdir(), "v6-decision-"));
	dirs.push(g);
	const keys = join(g, "keys");
	mkdirSync(keys);
	const stage = o.stage ?? "v6-stage1";
	const targets = [...new Set(runs.map((r) => r.target))];
	for (const t of targets) {
		writeFileSync(join(keys, `app-${t}.truth.json`), JSON.stringify([
			...LINES.map((line, i) => ({ id: `${t}-A${i}-1`, advisory: `${t}-A${i}`, file: `src/${t}.py`, line, line_range: [line, line + 2], cwes: ["CWE-79", "CWE-89"], ...o.truthExtra })),
			...(o.moreTruth?.(t) ?? []),
		]));
		writeFileSync(join(keys, `app-${t}.neutral.json`), JSON.stringify([{ advisory: `${t}-N`, file: `src/${t}.py`, line_range: [500, 505], why: "open, unlabelled" }]));
		writeFileSync(join(keys, `app-${t}-patched.truth.json`), "[]");
	}
	const expected = [...new Set([...runs.map((r) => `${r.target}#${r.pass}`), ...(o.expected ?? [])])];
	writeFileSync(join(g, "manifest.json"), JSON.stringify({
		gridKind: stage,
		targets: [
			...targets.map((t) => ({ id: t, name: `app-${t}` })),
			...targets.map((t) => ({ id: `${t}-patched`, name: `app-${t}-patched`, twinOf: t, fixed_regions: [{ file: `src/${t}.py`, line_range: [10, 12] }], scope_loc: 2000 })),
		],
		inputs: { truth: keys },
		expectedCells: [...expected.map((k) => ({ target: k.replace(/#\d+$/, ""), pass: Number(k.replace(/^.*#/, "")), key: k })), ...targets.map((t) => ({ target: `${t}-patched`, pass: 1, key: `${t}-patched#1` }))],
		...(stage === "v6-stage2" && o.amended !== false ? { passesFrom: { dir: "/stage1", gridKind: "v6-stage1", gridId: "s1", official: true, passes: 2 } } : {}),
		...(o.unions ? { matched: { mode: "follow", k: 3 } } : {}),
	}));
	if (stage === "v6-stage1" && o.amended !== false) {
		writeFileSync(join(g, "amendments.jsonl"), `${JSON.stringify({ kind: "fix-passes", at: "2026-10-01T00:00:00Z", from: 2, to: 2, by: "op@host", reason: "pilot rule", runsCompleted: 48, runsSha256: "a".repeat(64), summarySha256: null, resume: 1 })}\n`);
	}
	const codes = o.codes ?? [];
	writeFileSync(join(g, "summary.json"), JSON.stringify({
		decision: { rule: "v6 pre-registration", computedBy: "eval/v6-decision.ts", ready: codes.length === 0, notReadyReasons: codes.map((c) => c.reason), reasons: codes },
		breaker: { policy: {}, tripped: false, abandoned: codes.filter((c) => c.code === "abandoned").flatMap((c) => (c.keys as string[]).map((key) => ({ key, attempts: [] }))) },
		...(o.unions ? { matched: { unions: o.unions, sessions: { abandoned: [] } } } : {}),
		...o.summary,
	}));
	[...runs, ...(o.twins ?? [])].forEach((r, i) => {
		const cell = r.cell ?? `cell-${i}`;
		const dir = join(g, "runs", cell);
		mkdirSync(join(dir, "workspace"), { recursive: true });
		const tokens = r.tokens === undefined ? 1_000_000 : r.tokens;
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			key: `${r.target}#${r.pass}`, target: r.target, pass: r.pass, arm: r.arm, attempt: r.attempt ?? 1, valid: true, truePositives: r.found, findings: r.found + (r.fps ?? 0),
			// The gate reads the retry estimate; the metered count is deliberately different.
			totalTokens: tokens === null ? null : Math.round(tokens * 0.9), totalTokensWithRetryEstimate: tokens,
			usage: r.cost === null ? { valid: true } : { valid: true, costUsd: r.cost ?? 1.5 },
			...(r.target.endsWith("-patched") ? { twinOf: r.target.replace(/-patched$/, "") } : {}),
			stop: r.stop ?? stop("finished", 0.5, false),
			// What the v6 validity policy writes on every run it judges.
			...(r.reachedLimit === undefined && r.fastEmpty === undefined ? {} : { reachedLimit: r.reachedLimit ?? false, fastEmpty: r.fastEmpty ?? false, limitEffects: [] }),
		}));
		const file = `src/${r.target.replace(/-patched$/, "")}.py`;
		const rows = r.rows ?? [...LINES.slice(0, r.found), ...FP_LINES.slice(0, r.fps ?? 0)].map((line, k) => ({ id: `F${k}`, title: "injection", target: `${file}:${line}`, cwe: "CWE-89" }));
		writeFileSync(join(dir, "workspace", "findings.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n"));
	});
	return g;
}

/** Labels for every claim the builder makes: advisories valid, the extra claims as given. */
function labels(fpLabel = "wrong", targets = TARGETS): ReturnType<typeof parseLabels> {
	const raw: Row = {};
	for (const t of targets) {
		for (const line of LINES) raw[`${t}|src/${t}.py:${line}`] = "valid";
		for (const line of FP_LINES) raw[`${t}|src/${t}.py:${line}`] = fpLabel;
	}
	return parseLabels(raw);
}

describe("rule 1 and the outcome", () => {
	it("passes a candidate that finds the same advisories at the same cost with the same adjudicated precision (non-inferior, not superior)", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 2, fps: 1 }, { found: 2, fps: 1 }]))], labels());
		expect(d.outcome).toBe("passes");
		expect(d.rule1).toMatchObject({ level: "official", pairs: 12, targets: 6, mean: 0, lo: 0, hi: 0, nonInferior: true, superior: false });
		expect(d.rule2).toMatchObject({ status: "adjudicated", subject: 2 / 3, reference: 2 / 3, ratio: 1, pass: true });
		expect(d.rule3).toMatchObject({ median: 0, pass: true, relaxed: false });
		expect(d.pairs).toMatchObject({ expected: 12, paired: 12, abandoned: [], excluded: [] });
	});

	it("calls a candidate superior when the whole interval is above zero", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]))], labels());
		expect(d.outcome).toBe("superior");
		expect(d.rule1).toMatchObject({ mean: 1, lo: 1, superior: true });
	});

	it("fails rule 1 when the lower bound is at or below −0.3, whatever the other rules say", () => {
		// Half the targets lose one advisory: the mean is −0.5.
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 2 }, { found: ["t1", "t2", "t3"].includes(t) ? 1 : 2 }]))], labels());
		expect(d.outcome).toBe("fails");
		expect(d.rule1!.mean).toBeCloseTo(-0.5, 10);
		expect(d.rule1!.lo).toBeLessThanOrEqual(RULES.margin);
		expect(d.reasons.join(" ")).toMatch(/rule 1 fails/);
	});

	it("decides rule 1 on the pinned grader's matching: one claim near two advisories finds one, a basename collision finds one", () => {
		// A second advisory B four lines below A0's range: a claim at 13 is within ±3 of both.
		const moreTruth = (t: string) => [{ id: `${t}-B-1`, advisory: `${t}-B`, file: `src/${t}.py`, line: 16, line_range: [16, 16] }];
		const near = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 0 }, { rows: [{ id: "x", title: "t", target: `src/${t}.py:13` }] }]), { moreTruth })]);
		expect(near.rule1!.mean).toBe(1);
		expect(near.robustness!.advisories.find((x) => x.level === "line±3")!.mean).toBe(2);
		const collision = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 0 }, { rows: [{ id: "x", title: "t", target: `lib/${t}.py:50` }] }]))]);
		expect(collision.rule1!.mean).toBe(1);
		expect(collision.robustness!.advisories.find((x) => x.level === "line±3")!.mean).toBe(0);
	});

	it("reports every location level, the any-of class level and labelled locations as robustness", () => {
		const g = grid(pairs("baseline", "candidate", (t) => [{ found: 1 }, { rows: [{ id: "a", title: "x", target: `src/${t}.py:10`, cwe: "CWE-79" }, { id: "b", title: "y", target: `src/${t}.py:50`, cwe: "CWE-22" }] }]));
		const d = decide("S-vs-A", [g]);
		expect(d.robustness!.advisories.map((x) => x.level)).toEqual(["file", "point±3", "line±3", "line±10", "range-overlap", "class any-of"]);
		// CWE-79 is the advisory's first CWE here and CWE-89 the baseline's second: both count; CWE-22 is neither.
		expect(d.robustness!.advisories.find((x) => x.level === "class any-of")!.mean).toBe(0);
		expect(d.robustness!.labels.find((x) => x.level === "line±3")!.mean).toBe(1);
		expect(d.robustness!.advisories.find((x) => x.level === "file")!.mean).toBe(0);
	});

	it("reports rule 1 with each target left out in turn, as robustness that never decides", () => {
		// t1 carries the whole gain: +2 on both of its pairs, nothing elsewhere.
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 1 }, { found: t === "t1" ? 3 : 1 }]))], labels());
		expect(d.leaveOneTargetOut!.map((x) => x.left)).toEqual(TARGETS);
		expect(d.leaveOneTargetOut!.find((x) => x.left === "t1")).toMatchObject({ mean: 0, lo: 0, hi: 0, pairs: 10, targets: 5 });
		expect(d.leaveOneTargetOut!.find((x) => x.left === "t2")!.mean).toBeCloseTo(0.4, 10);
		expect(d.rule1).toMatchObject({ pairs: 12, targets: 6 });
		expect(d.rule1!.mean).toBeCloseTo(1 / 3, 10);
		expect(d.outcome).toBe("passes");
		expect(formatDecision(d, shipTable([d]))).toMatch(/leave one target out \(robustness, never deciding[^\n]*\n\s+without t1: 0\.000 \[0\.000, 0\.000\] over 10 pair/);
	});

	it("refuses a truth that carries classes: the official rule would then be class-sensitive", () => {
		const g = grid(pairs("baseline", "candidate", () => [{}, {}]), { truthExtra: { cwe: "CWE-89" } });
		expect(() => decide("S-vs-A", [g])).toThrow(/truth carries classes/);
	});
});

describe("rule 3, cost", () => {
	it("reads the gate metric (tokens with the retry estimate), not the metered count", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ tokens: 1_000_000 }, { tokens: 1_050_000 }]))], labels());
		expect(d.rule3!.median).toBeCloseTo(Math.log(1.05), 10);
		expect(d.rule3!.pooledRatio).toBeCloseTo(1.05, 10);
	});

	it("fails a non-inferior candidate that costs 20% more at the typical pair", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ tokens: 1_000_000 }, { tokens: 1_200_000 }]))], labels());
		expect(d.outcome).toBe("fails");
		expect(d.rule3).toMatchObject({ pass: false, relaxed: false, bound: Math.log(1.1) });
		expect(d.reasons.join(" ")).toMatch(/rule 3 fails/);
	});

	it("relaxes the bound to log(1.5) only when rule 1 shows superiority", () => {
		const superior = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 1, tokens: 1_000_000 }, { found: 2, tokens: 1_200_000 }]))], labels());
		expect(superior.outcome).toBe("superior");
		expect(superior.rule3).toMatchObject({ pass: true, relaxed: true, bound: Math.log(1.5) });
		const merely = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 1, tokens: 1_000_000 }, { found: 1, tokens: 1_200_000 }]))], labels());
		expect(merely.rule3).toMatchObject({ pass: false, relaxed: false });
		expect(merely.outcome).toBe("fails");
	});

	it("makes a pair without a token count inconclusive, not a failure of rule 3", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t, p) => [{}, { tokens: t === "t1" && p === 1 ? null : 1_000_000 }]))], labels());
		expect(d.outcome).toBe("inconclusive");
		expect(d.rule3).toMatchObject({ pass: null, missingTokens: 1, pairs: 11 });
		expect(d.reasons[0]).toMatch(/no token count/);
	});
});

describe("rule 2, precision", () => {
	it("is pending adjudication without labels: the comparison cannot pass, and the key's precision is shown only as provisional", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 2, fps: 2 }, { found: 2, fps: 1 }]))]);
		expect(d.outcome).toBe("pending adjudication");
		expect(d.rule2).toMatchObject({ status: "pending adjudication", subject: null, reference: null, pass: null });
		expect(d.rule2!.provisional.subject).toBeCloseTo(2 / 3, 10);
		expect(d.rule2!.provisional.reference).toBeCloseTo(0.5, 10);
		const text = formatDecision(d, shipTable([d]));
		expect(text).toMatch(/PENDING ADJUDICATION/);
		expect(text).toMatch(/provisional, key-based, never used to pass/);
	});

	it("leaves neutral claims out of the provisional precision", () => {
		const g = grid(pairs("baseline", "candidate", (t) => [{ found: 1 }, { rows: [{ id: "a", title: "x", target: `src/${t}.py:10` }, { id: "b", title: "y", target: `src/${t}.py:502` }] }]));
		expect(decide("S-vs-A", [g]).rule2!.provisional.subject).toBe(1);
	});

	it("counts precision per arm and target over the unique issues claimed across its runs, pooled over targets", () => {
		// The candidate adds one wrong claim on pass 1 only. Per run that is 4 valid of 5; per target it is 2 of 3.
		const g = grid(pairs("baseline", "candidate", (_t, p) => [{ found: 2 }, { found: 2, fps: p === 1 ? 1 : 0 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.rule2).toMatchObject({ subject: 2 / 3, reference: 1, claimedIssues: { subject: 18, reference: 12 } });
		expect(d.rule2!.ratio).toBeCloseTo(2 / 3, 10);
		expect(d.outcome).toBe("fails");
	});

	it("stays pending while any presented claim is unlabelled", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 2 }, { found: 2, fps: 1 }]));
		const d = decide("S-vs-A", [g], parseLabels(Object.fromEntries(TARGETS.flatMap((t) => LINES.map((l) => [`${t}|src/${t}.py:${l}`, "valid"])))));
		expect(d.outcome).toBe("pending adjudication");
		// One unique unlabelled claim per target.
		expect(d.rule2!.unlabelledClaims).toBe(6);
	});

	it("fails below 0.85 of the comparator's precision, with the ratio's app-clustered bootstrap interval reported", () => {
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 2 }, { found: 2, fps: 2 }]))], labels("not-security"));
		expect(d.outcome).toBe("fails");
		expect(d.rule2).toMatchObject({ subject: 0.5, reference: 1, ratio: 0.5, pass: false, ratioLo: 0.5, ratioHi: 0.5 });
	});

	it("counts claims the judge grouped into one issue once, and valid-mislocated only in the loose reading", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 1, fps: 2 }]));
		const raw: Row = {};
		for (const t of TARGETS) {
			raw[`${t}|src/${t}.py:10`] = "valid";
			raw[`${t}|src/${t}.py:300`] = { label: "valid-mislocated", issue: `${t}-x` };
			raw[`${t}|src/${t}.py:340`] = { label: "valid-mislocated", issue: `${t}-x` };
		}
		const d = decide("S-vs-A", [g], parseLabels(raw));
		expect(d.rule2).toMatchObject({ subject: 0.5, loose: { subject: 1, reference: 1 } });
	});

	it("refuses labels outside the rubric, an issue carrying two labels, and a key the worksheet never listed", () => {
		expect(() => parseLabels({ k: "maybe" })).toThrow(/not one of/);
		expect(() => parseLabels([])).toThrow(/JSON object/);
		expect(() => parseLabels({ a: { label: "valid", issue: "i" }, b: { label: "wrong", issue: "i" } })).toThrow(/issue "i" carries two labels/);
		expect(() => parseLabels({ "t1|a.py:1": "valid" }, new Set(["t1|a.py:2"]))).toThrow(/not a claim of the worksheet/);
	});

	it("reports the all, suspected and confirmed tiers beside the presented tier", () => {
		const rows = (t: string) => [
			{ id: "a", title: "x", target: `src/${t}.py:10`, status: "confirmed" },
			{ id: "b", title: "y", target: `src/${t}.py:300`, status: "refuted" },
			{ id: "c", title: "z", target: `src/${t}.py:340` },
		];
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 1 }, { rows: rows(t) }]))], labels());
		const tier = (name: string) => d.precisionTiers!.find((x) => x.tier === name)!;
		expect(tier("all").subject).toBeCloseTo(1 / 3, 10);
		expect(tier("presented").subject).toBe(0.5);
		expect(tier("confirmed").subject).toBe(1);
		expect(tier("suspected").subject).toBe(0);
	});
});

describe("grid state and the pairs a comparison lost", () => {
	it("makes a comparison with a pair abandoned at the attempt ceiling inconclusive, with the full report still produced", () => {
		const runs = pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]).filter((r) => !(r.target === "t1" && r.pass === 2));
		const g = grid(runs, { expected: ["t1#2"], codes: [code("abandoned", ["t1#2", "t1-patched#1"])] });
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("inconclusive");
		// A twin's abandoned pair is a control, not a pair of the comparison.
		expect(d.pairs).toMatchObject({ expected: 12, paired: 11, abandoned: [`${g}: t1#2`], excluded: [] });
		expect(d.rule1!.superior).toBe(true);
		expect(d.rule3!.pass).toBe(true);
		expect(formatDecision(d, shipTable([d]))).toMatch(/rule 1 ·[\s\S]*rule 3 ·/);
	});

	it("excludes and lists invalid and blocked pairs, which the harness's validity rules exclude, and decides on the rest", () => {
		const runs = pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]).filter((r) => !(r.target === "t2" && r.pass === 1 && r.arm === "candidate"));
		const g = grid(runs, { codes: [code("invalid", ["t2#1: candidate invalid"]), code("blocked", ["t2#1"])] });
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("superior");
		expect(d.pairs!.excluded).toEqual([{ key: `${g}: t2#1`, why: "S has no valid run at the pair's latest attempt" }]);
		expect(d.pairs!.harnessExcluded.map((h) => h.code)).toEqual(["invalid", "blocked"]);
	});

	it("is not ready, and computes nothing, while stage 1's pass count is not fixed: that grid is still the blind pilot", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]), { amended: false, codes: [code("amendment-pending")], summary: { pilot: { blinded: true } } });
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("not ready");
		expect(d.notReady.join(" ")).toMatch(/not fixed by an amendment/);
		expect(d.rule1).toBeUndefined();
		expect(formatDecision(d, shipTable([d]))).not.toMatch(/rule 1 ·|advisories found per pair|superior \(/);
	});

	it("is not ready on a code a resume clears or one that keeps the grid from a decision, and on a summary without codes that is not ready", () => {
		const two = (o: GridOptions) => grid(pairs("baseline", "candidate", () => [{}, {}]), { stage: "v6-stage2", ...o });
		for (const c of ["interrupted", "stopped", "quota", "credential", "gave-up", "exploratory", "runtime-changed", "amendment-mismatch", "something-new"]) {
			const d = decide("D-vs-S", [two({ codes: [code(c, c === "gave-up" ? ["t1#1"] : undefined)] })]);
			expect([c, d.outcome]).toEqual([c, "not ready"]);
		}
		expect(decide("D-vs-S", [two({ amended: false })]).notReady.join(" ")).toMatch(/no passesFrom/);
		expect(decide("D-vs-S", [two({ summary: { decision: { ready: false, notReadyReasons: ["corpus not frozen"] } } })]).notReady.join(" ")).toMatch(/no reason codes\): corpus not frozen/);
		const g = two({});
		rmSync(join(g, "summary.json"));
		expect(decide("D-vs-S", [g]).outcome).toBe("not ready");
	});

	it("refuses a grid of the wrong stage for the comparison", () => {
		expect(() => decide("D-vs-S", [grid(pairs("baseline", "candidate", () => [{}, {}]))])).toThrow(/this comparison reads "v6-stage2"/);
	});
});

describe("stage 2 arms", () => {
	/** A stage-2 grid with S, D and a matched union of three sessions per pair. */
	function stage2(o: { unionValid?: (t: string, p: number) => boolean; codes?: Row[]; matchedAbandoned?: Row[] } = {}): string {
		const runs: RunSpec[] = [];
		const unions: Row[] = [];
		for (const t of TARGETS) for (const pass of [1, 2]) {
			runs.push({ target: t, pass, arm: "baseline", found: 1 }, { target: t, pass, arm: "candidate", found: 2, tokens: 900_000 });
			const cells = [0, 1, 2].map((k) => `m-${t}-${pass}-${k}`);
			cells.forEach((cell, k) => runs.push({ target: t, pass, arm: "matched", found: k === 0 ? 1 : 0, tokens: 300_000, cell }));
			const valid = o.unionValid?.(t, pass) ?? true;
			unions.push({ valid, reasons: valid ? [] : ["session 2 reports no tokens"], target: t, pass, attempt: 1, sessions: cells.map((cellId) => ({ cellId })), truePositives: 1, totalClaims: 1, totalTokens: valid ? 1_000_000 : null });
		}
		return grid(runs, { stage: "v6-stage2", unions, codes: o.codes, summary: { matched: { unions, sessions: { abandoned: o.matchedAbandoned ?? [] } } } });
	}

	it("pairs D (the harness's candidate) against M (the matched union), reading the union's summed gate tokens", () => {
		const g = stage2();
		const dm = decide("D-vs-M", [g], labels());
		expect(dm).toMatchObject({ reference: { arm: "M", harnessArm: "matched" }, subject: { arm: "D", harnessArm: "candidate" }, outcome: "superior" });
		expect(dm.rule1).toMatchObject({ pairs: 12, mean: 1 });
		expect(dm.rule3!.median).toBeCloseTo(Math.log(0.9), 10);
		// Each matched session is a run for stopping and for dollars.
		expect(dm.stopping!.arms.M!.runs).toBe(36);
		expect(dm.dollars!.M).toEqual({ usd: 54, runs: 36, unrecorded: 0 });
		expect(decide("D-vs-S", [g], labels())).toMatchObject({ reference: { arm: "S", harnessArm: "baseline" }, outcome: "superior" });
	});

	it("counts a matched session's abandonment against D vs M only, never against D vs S", () => {
		const g = stage2({ unionValid: (t, p) => !(t === "t2" && p === 1), matchedAbandoned: [{ session: "t2#1/1", sessionAttempt: 16, reason: "ceiling" }] });
		const dm = decide("D-vs-M", [g], labels());
		expect(dm.outcome).toBe("inconclusive");
		expect(dm.pairs!.abandoned).toEqual([`${g}: t2#1`]);
		const ds = decide("D-vs-S", [g], labels());
		expect(ds.outcome).toBe("superior");
		expect(ds.pairs).toMatchObject({ paired: 12, abandoned: [] });
	});

	it("counts a gate pair's abandonment against every comparison that uses the pair", () => {
		const g = stage2({ codes: [code("abandoned", ["t3#2"])] });
		expect(decide("D-vs-S", [g], labels()).outcome).toBe("inconclusive");
		expect(decide("D-vs-M", [g], labels()).outcome).toBe("inconclusive");
	});

	it("lists an invalid matched union as an excluded pair of D vs M, with the harness's reason, and not of D vs S", () => {
		const g = stage2({ unionValid: (t, p) => !(t === "t4" && p === 2) });
		const dm = decide("D-vs-M", [g], labels());
		expect(dm.pairs).toMatchObject({ expected: 12, paired: 11, abandoned: [] });
		expect(dm.pairs!.excluded).toEqual([{ key: `${g}: t4#2`, why: "M union invalid (session 2 reports no tokens)" }]);
		expect(decide("D-vs-S", [g], labels()).pairs!.excluded).toEqual([]);
	});
});

describe("reported, never deciding", () => {
	it("reads the offered-to-continue rate by the text test in every arm, beside the arm-neutral co-primary", () => {
		const g = grid(pairs("baseline", "candidate", (_t, p) => [
			{ stop: p === 1 ? stop("offered-to-continue", 0.3, true) : stop("finished", 0.6, false) },
			{ stop: stop("finished", 0.9, false) },
		]));
		const s = decide("S-vs-A", [g], labels()).stopping!;
		expect(s.arms.A).toMatchObject({ runs: 12, offeredToContinue: 6, offeredRate: 0.5, leftWithOpenWork: 6, judged: 12 });
		expect(s.arms.S).toMatchObject({ offeredRate: 0, medianTimeShare: 0.9, leftWithOpenWorkShare: 0 });
		expect(s).toMatchObject({ delta: { offeredRate: -0.5 }, sameDirection: true, passesStopping: true });
	});

	it("credits 3.2 on stopping only when the offered rate and the open-work share both fall and the time share does not", () => {
		const row = (arm: string, outcome: "finished" | "offered-to-continue", share: number, open: boolean) => ({ arm, key: arm, valid: true, stop: stop(outcome, share, open) });
		expect(stopping([row("A", "offered-to-continue", 0.5, false), row("S", "finished", 0.5, false)], "A", "S")).toMatchObject({ sameDirection: false, passesStopping: false });
		expect(stopping([row("A", "offered-to-continue", 0.5, true), row("S", "finished", 0.4, false)], "A", "S")).toMatchObject({ sameDirection: true, passesStopping: false });
		expect(stopping([row("A", "offered-to-continue", 0.5, true), row("S", "finished", 0.5, false)], "A", "S")).toMatchObject({ passesStopping: true });
	});

	it("reports the patched twins per arm and keeps them out of pairs, stopping and precision", () => {
		const twins: RunSpec[] = [
			{ target: "t1-patched", pass: 1, arm: "baseline", found: 1 },
			{ target: "t1-patched", pass: 1, arm: "candidate", found: 0, fps: 2 },
		];
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 1 }]), { twins })], labels());
		expect(d.twins).toEqual({ A: { runs: 1, hitsNearFixedRegions: 1, claims: 1, meanClaimsPerKloc: 0.5 }, S: { runs: 1, hitsNearFixedRegions: 0, claims: 2, meanClaimsPerKloc: 1 } });
		expect(d.pairs).toMatchObject({ expected: 12, paired: 12 });
		expect(d.stopping!.arms.A!.runs).toBe(12);
		expect(d.outcome).toBe("passes");
	});

	it("reports the verifier's rejected true positives and downgrades, dollars when recorded, and per-advisory find rates", () => {
		const rows = (t: string) => [
			{ id: "a", title: "x", target: `src/${t}.py:10`, status: "refuted", verification: { verdict: "refuted", by: "verifier", at: "1", attempted: "confirmed" } },
			{ id: "b", title: "y", target: `src/${t}.py:50` },
		];
		const d = decide("S-vs-A", [grid(pairs("baseline", "candidate", (t) => [{ found: 1, cost: null }, { rows: rows(t), cost: 2 }]))], labels());
		expect(d.verifier!.S).toMatchObject({ refutedRows: 12, rejectedLabels: 12, rejectedShare: 0.5, verifications: 12, downgraded: 12, downgradeRate: 1 });
		expect(d.verifier!.A).toMatchObject({ refutedRows: 0, rejectedShare: 0 });
		expect(d.dollars).toEqual({ A: { usd: null, runs: 12, unrecorded: 12 }, S: { usd: 24, runs: 12, unrecorded: 0 } });
		expect(d.findRates!.find((r) => r.advisory === "t1-A1")).toEqual({ advisory: "t1-A1", reference: 0, subject: 2, n: 2 });
		expect(d.mcnemar).toMatchObject({ b: 0, c: 12 });
		expect(formatDecision(d, shipTable([d]))).toMatch(/A: not recorded \(12 of 12 run\(s\) without a cost\)/);
	});
});

describe("runs the v6 validity policy keeps", () => {
	// Excluding them would bias the comparison against the arm that works longer
	// or quits sooner, so they count as pairs and their numbers show per arm.
	it("pairs limit-reaching and fast empty runs like any other and reports how many each arm had, without letting them decide", () => {
		const flagged = grid(pairs("baseline", "candidate", (t, p) => [
			p === 1 ? { found: 0, fastEmpty: true } : { found: 1, fastEmpty: false },
			{ found: 2, reachedLimit: t === "t1" || t === "t2" },
		]));
		const d = decide("S-vs-A", [flagged], labels());
		expect(d.pairs!.paired).toBe(12);
		expect(d.validity).toEqual({ A: { runs: 12, reachedLimit: 0, fastEmpty: 6 }, S: { runs: 12, reachedLimit: 4, fastEmpty: 0 } });
		// The same runs without the flags decide the same way: the counts are reported only.
		const plain = decide("S-vs-A", [grid(pairs("baseline", "candidate", (_t, p) => [{ found: p === 1 ? 0 : 1 }, { found: 2 }]))], labels());
		expect(plain.validity).toEqual({ A: { runs: 12, reachedLimit: 0, fastEmpty: 0 }, S: { runs: 12, reachedLimit: 0, fastEmpty: 0 } });
		expect(d.outcome).toBe(plain.outcome);
		expect(d.rule1).toEqual(plain.rule1);
		expect(formatDecision(d, shipTable([d]))).toMatch(/S: 4 of 12 paired run\(s\) reached the run limit \(scored on the ledger at the deadline\); 0 ended fast and empty/);
	});
});

describe("the ship table and the CLI", () => {
	const decision = (comparison: Decision["comparison"], outcome: Outcome, nonInferior = true): Decision => ({
		comparison, reference: { arm: "A", harnessArm: "baseline" }, subject: { arm: "S", harnessArm: "candidate" }, grids: [], outcome, reasons: [], notReady: [],
		rule1: { level: "official", pairs: 1, targets: 1, mean: 0, lo: nonInferior ? 0 : -1, hi: 0, nonInferior, superior: false },
	});

	it("fills the staging row and each ship decision from the comparisons decided, and leaves the rest undecided", () => {
		expect(shipTable([decision("S-vs-A", "passes")]).map((r) => r.status)).toEqual(["met", "met", "undecided: D vs S not computed; undecided: D vs M not computed", "undecided: D vs M not computed"]);
		// Non-inferior on rule 1 but failing on cost: stage 2 still runs, Phase 3 does not ship.
		expect(shipTable([decision("S-vs-A", "fails", true)]).map((r) => r.status).slice(0, 2)).toEqual(["met", "not met"]);
		expect(shipTable([decision("S-vs-A", "fails", false)])[0]!.status).toBe("not met");
		expect(shipTable([decision("S-vs-A", "inconclusive")])[0]!.status).toBe("undecided: S vs A is inconclusive");
		expect(shipTable([decision("D-vs-S", "superior"), decision("D-vs-M", "passes")]).map((r) => r.status).slice(2)).toEqual(["met", "not met"]);
		expect(shipTable([decision("D-vs-S", "passes"), decision("D-vs-M", "fails")]).map((r) => r.status).slice(2)).toEqual(["not met", "met"]);
		expect(shipTable([decision("D-vs-S", "fails")])[2]!.status).toBe("not met");
	});

	it("never meets both 'delegation may become the default' and 'delegation stays opt-in'", () => {
		const outcomes: Outcome[] = ["not ready", "inconclusive", "fails", "pending adjudication", "passes", "superior"];
		for (const ds of outcomes) for (const dm of outcomes) {
			const [, , becomesDefault, staysOptIn] = shipTable([decision("D-vs-S", ds), decision("D-vs-M", dm)]).map((r) => r.status);
			expect([ds, dm, becomesDefault === "met" && staysOptIn === "met"]).toEqual([ds, dm, false]);
		}
	});

	it("writes the decision as JSON and a text report, folds in other decisions, and exits 1 when not ready", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]));
		const written = new Map<string, string>();
		const io = { readFile: () => JSON.stringify(decision("D-vs-S", "passes")), write: (p: string, t: string) => void written.set(p, t) };
		const r = cli(["--comparison", "S-vs-A", "--grid", g, "--with", "other.json"], io);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/OUTCOME: PENDING ADJUDICATION/);
		const json = JSON.parse(written.get(join(g, "v6-decision-S-vs-A.json"))!) as { outcome: string; ship: Array<{ status: string }> };
		expect(json.outcome).toBe("pending adjudication");
		expect(json.ship[2]!.status).toMatch(/D vs M not computed/);
		expect(written.get(join(g, "v6-decision-S-vs-A.txt"))).toBe(r.out);
		const blind = grid(pairs("baseline", "candidate", () => [{}, {}]), { amended: false, codes: [code("amendment-pending")] });
		expect(cli(["--comparison", "S-vs-A", "--grid", blind, "--out", join(blind, "x")], io).code).toBe(1);
		expect(cli(["--comparison", "X-vs-Y", "--grid", g], io).code).toBe(2);
		expect(cli(["--comparison", "S-vs-A", "--grid", g, "--labels", "l.json"], io).out).toMatch(/--labels needs --keymap/);
		expect(cli(["--bogus", "x"], io).code).toBe(2);
	});
});

describe("the adjudication worksheet and labels", () => {
	it("writes blind worksheets from the claims precision counts: every tier, no arm, run, author or status, shuffled under a recorded seed", () => {
		const rows = (t: string) => [
			{ id: "a", title: "worker found sqli", description: "the verifier saw input reach the query", target: `src/${t}.py:10`, status: "refuted", by: "worker-3", cwe: "CWE-89" },
			{ id: "b", title: "xss", target: `src/${t}.py:300`, status: "confirmed", by: "lead" },
		];
		const g = grid(pairs("baseline", "candidate", (t) => [{ found: 1 }, { rows: rows(t) }]));
		const { worksheets, keymap } = exportWorksheets([g], 7);
		expect(worksheets.map((w) => w.target)).toEqual(TARGETS);
		const w = worksheets[0]!;
		expect(w.claims.map((c) => `${c.file}:${c.line}`).sort()).toEqual(["src/t1.py:10", "src/t1.py:300"]);
		const text = JSON.stringify(worksheets);
		for (const leak of ["baseline", "candidate", "refuted", "confirmed", "worker", "verifier", "lead", "cell-", "pass"]) expect([leak, text.includes(leak)]).toEqual([leak, false]);
		expect(w.claims.find((c) => c.line === 10)!.statements).toContainEqual({ title: "[…] found sqli", description: "the […] saw input reach the query", cwe: "CWE-89" });
		expect(keymap.targets.t1![w.claims[0]!.id]).toBe(`${w.claims[0]!.file}:${w.claims[0]!.line}`);
		expect(exportWorksheets([g], 7)).toEqual({ worksheets, keymap });
	});

	it("joins the judge's issues through the key map, records a verdict without a quote as unverifiable, and refuses invented ids", () => {
		const keymap = { seed: 1, grids: [], targets: { t1: { C001: "src/t1.py:10", C002: "src/t1.py:300", C003: "src/t1.py:340" } } };
		const judged = { t1: { issues: { i1: { label: "valid", quotes: ["q = f'SELECT {x}'"] }, i2: { label: "wrong", quotes: [] } }, claims: { C001: "i1", C002: "i2" } } };
		expect(joinLabels(keymap, judged)).toEqual({ "t1|src/t1.py:10": { label: "valid", issue: "t1/i1" }, "t1|src/t1.py:300": { label: "unverifiable", issue: "t1/i2" } });
		expect(() => joinLabels(keymap, { t1: { issues: {}, claims: { C009: "i1" } } })).toThrow(/never listed/);
		expect(() => joinLabels(keymap, { t1: { issues: {}, claims: { C001: "i9" } } })).toThrow(/never defined/);
		expect(() => joinLabels(keymap, { t9: { issues: {}, claims: {} } })).toThrow(/not in the key map/);
		expect(worksheetKeys(keymap)).toEqual(new Set(["t1|src/t1.py:10", "t1|src/t1.py:300", "t1|src/t1.py:340"]));
	});

	it("round-trips export, a judge's answer and join into an adjudicated decision through the CLI", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 1, fps: 1 }]));
		const files = new Map<string, string>();
		const io = { readFile: (p: string) => files.get(p)!, write: (p: string, t: string) => void files.set(p, t) };
		expect(cli(["export", "--grid", g, "--out", "adj"], io).code).toBe(0);
		const keymap = JSON.parse(files.get(join("adj", "keymap.json"))!) as { targets: Record<string, Record<string, string>> };
		const judged = Object.fromEntries(Object.entries(keymap.targets).map(([t, m]) => [t, {
			issues: { ok: { label: "valid", quotes: ["line"] }, no: { label: "wrong", quotes: ["line"] } },
			claims: Object.fromEntries(Object.entries(m).map(([id, key]) => [id, key.endsWith(":300") ? "no" : "ok"])),
		}]));
		files.set("judged.json", JSON.stringify(judged));
		expect(cli(["join", "--keymap", join("adj", "keymap.json"), "--judged", "judged.json", "--out", "labels.json"], io).code).toBe(0);
		const r = cli(["--comparison", "S-vs-A", "--grid", g, "--labels", "labels.json", "--keymap", join("adj", "keymap.json"), "--out", "d"], io);
		const d = JSON.parse(files.get("d.json")!) as Decision;
		expect(d.rule2).toMatchObject({ status: "adjudicated", subject: 0.5, reference: 1 });
		expect(r.out).toMatch(/OUTCOME: FAILS/);
	});
});

describe("D vs A, bridged and reported only", () => {
	it("estimates (D − S₂) + (S₁ − A) by target and pass, with the drift S₂ − S₁ beside it", () => {
		const s1 = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]));
		const s2 = grid(pairs("baseline", "candidate", () => [{ found: 3 }, { found: 3 }]), { stage: "v6-stage2" });
		const b = bridgeDvsA(s1, s2);
		expect(b).toMatchObject({ outcome: "reported", bridged: { mean: 1, pairs: 12, targets: 6 }, drift: { mean: 1 } });
		expect(formatBridge(b)).toMatch(/never deciding[\s\S]*drift S₂ − S₁/);
		const files = new Map<string, string>();
		const r = cli(["--comparison", "D-vs-A", "--grid", s2, "--grid", s1, "--out", "b"], { readFile: () => "", write: (p, t) => void files.set(p, t) });
		expect(r.code).toBe(0);
		expect(JSON.parse(files.get("b.json")!)).toMatchObject({ comparison: "D-vs-A", outcome: "reported" });
		expect(bridgeDvsA(grid(pairs("baseline", "candidate", () => [{}, {}]), { amended: false }), s2).outcome).toBe("not ready");
		expect(readFileSync(join(s1, "manifest.json"), "utf8")).toMatch(/v6-stage1/);
	});
});
