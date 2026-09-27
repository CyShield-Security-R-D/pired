import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cli, decide, formatDecision, parseLabels, RULES, shipTable, stopping, type Decision } from "./v6-decision.ts";

type Row = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LINES = [10, 50, 90, 130];
const FP_LINES = [300, 340, 380];
const TARGETS = ["t1", "t2", "t3", "t4", "t5", "t6"];

/** One run: the first `found` of its target's four advisories, then `fps` claims the key does not label. */
interface RunSpec { target: string; pass: number; arm: string; found: number; fps?: number; tokens?: number; attempt?: number; stop?: Row; cell?: string }

const stop = (outcome: "finished" | "offered-to-continue", timeShare: number, leftWithOpenWork: boolean): Row => ({ outcome, evidence: [], crossCheck: null, workers: [], timeShare, leftWithOpenWork });

/** Both arms on every target × pass, from a function giving each arm's spec. */
function pairs(ref: string, sub: string, spec: (t: string, p: number) => [Partial<RunSpec>, Partial<RunSpec>], passes = 2, targets = TARGETS): RunSpec[] {
	return targets.flatMap((target) => Array.from({ length: passes }, (_, i) => i + 1).flatMap((pass) => {
		const [r, s] = spec(target, pass);
		return [{ target, pass, arm: ref, found: 1, ...r }, { target, pass, arm: sub, found: 1, ...s }];
	}));
}

interface GridOptions { stage?: "v6-stage1" | "v6-stage2"; amended?: boolean; summary?: Row; unions?: Row[]; twins?: RunSpec[]; truthExtra?: Row }

/**
 * A v6 grid: each target `app-<t>` has four one-label advisories in
 * `src/<t>.py` at LINES and a neutral region at 500; a patched twin per target.
 * Stage 1 carries its pass-count amendment and stage 2 its adopted count
 * unless told otherwise, and summary.json says the grid is ready.
 */
function grid(runs: RunSpec[], o: GridOptions = {}): string {
	const g = mkdtempSync(join(tmpdir(), "v6-decision-"));
	dirs.push(g);
	const keys = join(g, "keys");
	mkdirSync(keys);
	const stage = o.stage ?? "v6-stage1";
	const targets = [...new Set(runs.map((r) => r.target))];
	for (const t of targets) {
		writeFileSync(join(keys, `app-${t}.truth.json`), JSON.stringify(LINES.map((line, i) => ({ id: `${t}-A${i}-1`, advisory: `${t}-A${i}`, file: `src/${t}.py`, line, line_range: [line, line + 2], ...o.truthExtra }))));
		writeFileSync(join(keys, `app-${t}.neutral.json`), JSON.stringify([{ advisory: `${t}-N`, file: `src/${t}.py`, line_range: [500, 505], why: "open, unlabelled" }]));
		writeFileSync(join(keys, `app-${t}-patched.truth.json`), "[]");
	}
	writeFileSync(join(g, "manifest.json"), JSON.stringify({
		gridKind: stage,
		targets: [
			...targets.map((t) => ({ id: t, name: `app-${t}` })),
			...targets.map((t) => ({ id: `${t}-patched`, name: `app-${t}-patched`, twinOf: t, fixed_regions: [{ file: `src/${t}.py`, line_range: [10, 12] }], scope_loc: 2000 })),
		],
		inputs: { truth: keys },
		...(stage === "v6-stage2" && o.amended !== false ? { passesFrom: { dir: "/stage1", gridKind: "v6-stage1", gridId: "s1", official: true, passes: 2 } } : {}),
		...(o.unions ? { matched: { mode: "follow", k: 3 } } : {}),
	}));
	if (stage === "v6-stage1" && o.amended !== false) {
		writeFileSync(join(g, "amendments.jsonl"), `${JSON.stringify({ kind: "fix-passes", at: "2026-10-01T00:00:00Z", from: 2, to: 2, by: "op@host", reason: "pilot rule", runsCompleted: 48, runsSha256: "a".repeat(64), summarySha256: null, resume: 1 })}\n`);
	}
	writeFileSync(join(g, "summary.json"), JSON.stringify({ decision: { rule: "v6 pre-registration", ready: true, notReadyReasons: [] }, breaker: { abandoned: [] }, ...(o.unions ? { matched: { unions: o.unions, sessions: { abandoned: [] } } } : {}), ...o.summary }));
	[...runs, ...(o.twins ?? [])].forEach((r, i) => {
		const cell = r.cell ?? `cell-${i}`;
		const dir = join(g, "runs", cell);
		mkdirSync(join(dir, "workspace"), { recursive: true });
		const tokens = r.tokens ?? 1_000_000;
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			key: `${r.target}#${r.pass}`, target: r.target, pass: r.pass, arm: r.arm, attempt: r.attempt ?? 1, valid: true, truePositives: r.found, findings: r.found + (r.fps ?? 0),
			// The gate reads the retry estimate; the metered count is deliberately different.
			totalTokens: Math.round(tokens * 0.9), totalTokensWithRetryEstimate: tokens,
			...(r.target.endsWith("-patched") ? { twinOf: r.target.replace(/-patched$/, "") } : {}),
			stop: r.stop ?? stop("finished", 0.5, false),
		}));
		const file = `src/${r.target.replace(/-patched$/, "")}.py`;
		const rows = [...LINES.slice(0, r.found), ...FP_LINES.slice(0, r.fps ?? 0)].map((line, k) => ({ id: `F${k}`, title: "injection", target: `${file}:${line}` }));
		writeFileSync(join(dir, "workspace", "findings.jsonl"), rows.map((x) => JSON.stringify(x)).join("\n"));
	});
	return g;
}

/** Labels for every claim the builder can make: advisories valid, the extra claims as given. */
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
		const g = grid(pairs("baseline", "candidate", () => [{ found: 2, fps: 1 }, { found: 2, fps: 1 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("passes");
		expect(d.rule1).toMatchObject({ level: "official", pairs: 12, targets: 6, mean: 0, lo: 0, hi: 0, nonInferior: true, superior: false });
		expect(d.rule2).toMatchObject({ status: "adjudicated", subject: 2 / 3, reference: 2 / 3, ratio: 1, pass: true });
		expect(d.rule3).toMatchObject({ median: 0, pass: true, relaxed: false });
	});

	it("calls a candidate superior when the whole interval is above zero", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("superior");
		expect(d.rule1).toMatchObject({ mean: 1, lo: 1, superior: true });
	});

	it("fails rule 1 when the lower bound is at or below −0.3, whatever the other rules say", () => {
		// Half the targets lose one advisory: the mean is −0.5.
		const g = grid(pairs("baseline", "candidate", (t) => [{ found: 2 }, { found: ["t1", "t2", "t3"].includes(t) ? 1 : 2 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("fails");
		expect(d.rule1!.mean).toBeCloseTo(-0.5, 10);
		expect(d.rule1!.lo).toBeLessThanOrEqual(RULES.margin);
		expect(d.reasons.join(" ")).toMatch(/rule 1 fails/);
	});

	it("counts an advisory, not its labels, as the official rule's unit, and reports labelled locations beside it", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 3 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.robustness!.advisories.map((x) => x.level)).toEqual(["file", "point±3", "line±3", "line±10", "range-overlap"]);
		expect(d.robustness!.labels.find((x) => x.level === "line±3")!.mean).toBe(2);
		// At the file level every run touches every label of its file.
		expect(d.robustness!.advisories.find((x) => x.level === "file")!.mean).toBe(0);
	});

	it("refuses a truth that carries classes: the official rule would then not be line±3", () => {
		const g = grid(pairs("baseline", "candidate", () => [{}, {}]), { truthExtra: { cwe: "CWE-89" } });
		expect(() => decide("S-vs-A", [g])).toThrow(/truth carries classes/);
	});
});

describe("rule 3, cost", () => {
	it("reads the gate metric (tokens with the retry estimate), not the metered count", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ tokens: 1_000_000 }, { tokens: 1_050_000 }]));
		const d = decide("S-vs-A", [g], labels());
		expect(d.rule3!.median).toBeCloseTo(Math.log(1.05), 10);
		expect(d.rule3!.pooledRatio).toBeCloseTo(1.05, 10);
	});

	it("fails a non-inferior candidate that costs 20% more at the typical pair", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ tokens: 1_000_000 }, { tokens: 1_200_000 }]));
		const d = decide("S-vs-A", [g], labels());
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
});

describe("rule 2, precision", () => {
	it("is pending adjudication without labels: the comparison cannot pass, and the key's precision is shown only as provisional", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 2, fps: 2 }, { found: 2, fps: 1 }]));
		const d = decide("S-vs-A", [g]);
		expect(d.outcome).toBe("pending adjudication");
		expect(d.rule2).toMatchObject({ status: "pending adjudication", subject: null, reference: null, pass: null });
		expect(d.rule2!.provisional.subject).toBeCloseTo(2 / 3, 10);
		expect(d.rule2!.provisional.reference).toBeCloseTo(0.5, 10);
		const text = formatDecision(d, shipTable([d]));
		expect(text).toMatch(/PENDING ADJUDICATION/);
		expect(text).toMatch(/provisional, key-based, never used to pass/);
	});

	it("leaves neutral claims out of the provisional precision", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 1 }]));
		// One claim in the neutral region on t1's first candidate run.
		writeFileSync(join(g, "runs", "cell-1", "workspace", "findings.jsonl"), [`{"id":"a","title":"x","target":"src/t1.py:10"}`, `{"id":"b","title":"y","target":"src/t1.py:502"}`].join("\n"));
		expect(decide("S-vs-A", [g]).rule2!.provisional.subject).toBe(1);
	});

	it("stays pending while any presented claim is unlabelled", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 2 }, { found: 2, fps: 1 }]));
		const d = decide("S-vs-A", [g], parseLabels(Object.fromEntries(TARGETS.flatMap((t) => LINES.map((l) => [`${t}|src/${t}.py:${l}`, "valid"])))));
		expect(d.outcome).toBe("pending adjudication");
		expect(d.rule2!.unlabelledClaims).toBe(12);
	});

	it("fails when the candidate's adjudicated precision is below 0.85 of the comparator's, with the ratio's bootstrap bound reported", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 2 }, { found: 2, fps: 2 }]));
		const d = decide("S-vs-A", [g], labels("not-security"));
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
		expect(() => parseLabels({ k: "maybe" })).toThrow(/not one of/);
		expect(() => parseLabels([])).toThrow(/JSON object/);
	});
});

describe("readiness and abandoned pairs", () => {
	it("makes a comparison with a pair abandoned at the attempt ceiling inconclusive, never passing, even when every rule holds", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]), { summary: { breaker: { abandoned: [{ key: "t1#3", attempts: [] }, { key: "t1-patched#1", attempts: [] }] } } });
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("inconclusive");
		// A twin's abandoned pair is a control, not a pair of the comparison.
		expect(d.abandoned).toEqual([`${g}: t1#3`]);
		expect(d.rule1!.superior).toBe(true);
	});

	it("is not ready, and computes nothing, while stage 1's pass count is not fixed by its amendment: that grid is still the blind pilot", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]), { amended: false });
		const d = decide("S-vs-A", [g], labels());
		expect(d.outcome).toBe("not ready");
		expect(d.notReady.join(" ")).toMatch(/not fixed by an amendment/);
		expect(d.rule1).toBeUndefined();
		const text = formatDecision(d, shipTable([d]));
		expect(text).not.toMatch(/rule 1|mean|superior \(/);
	});

	it("is not ready when stage 2 did not adopt stage 1's count, when summary.json is blinded or missing, or when the harness says so", () => {
		const two = (o: GridOptions) => grid(pairs("baseline", "candidate", () => [{}, {}]), { stage: "v6-stage2", ...o });
		expect(decide("D-vs-S", [two({ amended: false })]).notReady.join(" ")).toMatch(/no passesFrom/);
		expect(decide("D-vs-S", [two({ summary: { pilot: { blinded: true } } })]).notReady.join(" ")).toMatch(/blinded/);
		expect(decide("D-vs-S", [two({ summary: { decision: { ready: false, notReadyReasons: ["corpus not frozen"] } } })]).notReady.join(" ")).toMatch(/harness: corpus not frozen/);
		const g = two({});
		rmSync(join(g, "summary.json"));
		expect(decide("D-vs-S", [g]).outcome).toBe("not ready");
	});

	it("refuses a grid of the wrong stage for the comparison", () => {
		expect(() => decide("D-vs-S", [grid(pairs("baseline", "candidate", () => [{}, {}]))])).toThrow(/this comparison reads "v6-stage2"/);
	});
});

describe("stage 2 arms", () => {
	it("pairs D (the harness's candidate) against M (the matched union), reading the union's summed gate tokens", () => {
		const runs: RunSpec[] = [];
		const unions: Row[] = [];
		for (const t of TARGETS) for (const pass of [1, 2]) {
			runs.push({ target: t, pass, arm: "baseline", found: 1 }, { target: t, pass, arm: "candidate", found: 2, tokens: 900_000 });
			const cells = [0, 1, 2].map((k) => `m-${t}-${pass}-${k}`);
			cells.forEach((cell, k) => runs.push({ target: t, pass, arm: "matched", found: k === 0 ? 1 : 0, tokens: 300_000, cell }));
			unions.push({ valid: true, target: t, pass, attempt: 1, sessions: cells.map((cellId) => ({ cellId })), truePositives: 1, totalClaims: 1, totalTokens: 1_000_000 });
		}
		const g = grid(runs, { stage: "v6-stage2", unions });
		const dm = decide("D-vs-M", [g], labels());
		expect(dm).toMatchObject({ reference: { arm: "M", harnessArm: "matched" }, subject: { arm: "D", harnessArm: "candidate" } });
		expect(dm.rule1).toMatchObject({ pairs: 12, mean: 1 });
		expect(dm.rule3!.median).toBeCloseTo(Math.log(0.9), 10);
		expect(dm.outcome).toBe("superior");
		// Each matched session is a run for stopping.
		expect(dm.stopping!.arms.M!.runs).toBe(36);
		const ds = decide("D-vs-S", [g], labels());
		expect(ds).toMatchObject({ reference: { arm: "S", harnessArm: "baseline" }, outcome: "superior" });
	});

	it("treats a matched session abandoned at the ceiling as an abandoned pair", () => {
		const g = grid(pairs("baseline", "candidate", () => [{}, {}]), { stage: "v6-stage2", unions: [], summary: { matched: { unions: [], sessions: { abandoned: [{ session: "t2#1/1", sessionAttempt: 16, reason: "x" }] } } } });
		const d = decide("D-vs-M", [g]);
		expect(d.abandoned).toEqual([`${g}: t2#1`]);
		expect(d.outcome).toBe("inconclusive");
	});
});

describe("reported, never deciding", () => {
	it("reads the offered-to-continue rate by the text test in every arm, beside the arm-neutral co-primary, and says whether they agree", () => {
		const g = grid(pairs("baseline", "candidate", (_t, p) => [
			{ stop: p === 1 ? stop("offered-to-continue", 0.3, true) : stop("finished", 0.6, false) },
			{ stop: stop("finished", 0.9, false) },
		]));
		const s = decide("S-vs-A", [g], labels()).stopping!;
		expect(s.arms.A).toMatchObject({ runs: 12, offeredToContinue: 6, offeredRate: 0.5, leftWithOpenWork: 6, judged: 12 });
		expect(s.arms.S).toMatchObject({ offeredRate: 0, medianTimeShare: 0.9, leftWithOpenWorkShare: 0 });
		expect(s.delta.offeredRate).toBe(-0.5);
		expect(s).toMatchObject({ sameDirection: true, passesStopping: true });
	});

	it("does not credit 3.2 on stopping when the text-test rate falls but the co-primary does not", () => {
		const rows = [
			{ arm: "A", key: "1", valid: true, stop: stop("offered-to-continue", 0.5, false) },
			{ arm: "S", key: "1", valid: true, stop: stop("finished", 0.5, false) },
		];
		expect(stopping(rows, "A", "S")).toMatchObject({ sameDirection: false, passesStopping: false });
	});

	it("reports the patched twins per arm, near-fix claims and claims per KLOC, and keeps them out of pairs and precision", () => {
		const twins: RunSpec[] = [
			{ target: "t1-patched", pass: 1, arm: "baseline", found: 1 },
			{ target: "t1-patched", pass: 1, arm: "candidate", found: 0, fps: 2 },
		];
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 1 }]), { twins });
		const d = decide("S-vs-A", [g], labels());
		expect(d.twins).toEqual({ A: { runs: 1, hitsNearFixedRegions: 1, claims: 1, meanClaimsPerKloc: 0.5 }, S: { runs: 1, hitsNearFixedRegions: 0, claims: 2, meanClaimsPerKloc: 1 } });
		expect(d.rule1!.pairs).toBe(12);
		expect(d.stopping!.arms.A!.runs).toBe(12);
		expect(d.outcome).toBe("passes");
	});
});

describe("the ship table and the CLI", () => {
	const decision = (comparison: Decision["comparison"], outcome: Decision["outcome"], nonInferior = true): Decision => ({
		comparison, reference: { arm: "A", harnessArm: "baseline" }, subject: { arm: "S", harnessArm: "candidate" }, grids: [], outcome, reasons: [], notReady: [], abandoned: [],
		rule1: { level: "line±3", pairs: 1, targets: 1, mean: 0, lo: nonInferior ? 0 : -1, hi: 0, nonInferior, superior: false, mcnemar: { b: 0, c: 0, p: 1 } },
	});

	it("fills each ship decision from the comparisons decided, and leaves the rest undecided", () => {
		expect(shipTable([decision("S-vs-A", "passes")]).map((r) => r.status)).toEqual(["met", "undecided: D vs S not computed; undecided: D vs M not computed", "undecided: D vs M not computed"]);
		const full = shipTable([decision("S-vs-A", "fails"), decision("D-vs-S", "superior"), decision("D-vs-M", "fails", true)]);
		expect(full.map((r) => r.status)).toEqual(["not met", "met", "met"]);
		const noDelegation = shipTable([decision("D-vs-S", "passes"), decision("D-vs-M", "fails", false)]);
		expect(noDelegation.map((r) => r.status).slice(1)).toEqual(["not met", "met"]);
		expect(shipTable([decision("S-vs-A", "pending adjudication")])[0]!.status).toBe("undecided: S vs A is pending adjudication");
	});

	it("writes the decision as JSON and a text report, folds in other decisions for the ship table, and exits 1 when not ready", () => {
		const g = grid(pairs("baseline", "candidate", () => [{ found: 1 }, { found: 2 }]));
		const written = new Map<string, string>();
		const other = join(g, "other.json");
		writeFileSync(other, JSON.stringify(decision("D-vs-S", "passes")));
		const io = { readFile: (p: string) => (p === other ? JSON.stringify(decision("D-vs-S", "passes")) : ""), write: (p: string, t: string) => void written.set(p, t) };
		const r = cli(["--comparison", "S-vs-A", "--grid", g, "--with", other], io);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/OUTCOME: PENDING ADJUDICATION/);
		const json = JSON.parse(written.get(join(g, "v6-decision-S-vs-A.json"))!) as { outcome: string; ship: Array<{ status: string }> };
		expect(json.outcome).toBe("pending adjudication");
		expect(json.ship[1]!.status).toMatch(/D vs M not computed/);
		expect(written.get(join(g, "v6-decision-S-vs-A.txt"))).toBe(r.out);
		const blind = grid(pairs("baseline", "candidate", () => [{}, {}]), { amended: false });
		expect(cli(["--comparison", "S-vs-A", "--grid", blind, "--out", join(blind, "x")], io).code).toBe(1);
		expect(cli(["--comparison", "X-vs-Y", "--grid", g], io).code).toBe(2);
		expect(cli(["--bogus"], io).code).toBe(2);
	});
});
