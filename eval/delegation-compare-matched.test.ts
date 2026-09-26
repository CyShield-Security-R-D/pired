import { describe, expect, it } from "vitest";
import type { Finding } from "./dvbank/score.ts";
import type { ExpectedCell, RunMetric } from "./delegation-compare-lib.ts";
import {
	budgetRatios, DEFAULT_MATCHED_K, matchedComparisons, median, metricOfUnion, nextSessionStep, parseMatchedPolicy, parseMatchedSpec, scoreUnion,
	sessionBudget, targetsWithoutBudget, unionFindings, type MatchedPolicy, type SessionRun, type SessionState, type UnionGrade,
} from "./delegation-compare-matched.ts";

// Synthetic targets and findings; no corpus label or benchmark run is read here.
const finding = (file: string, line: number): Finding => ({ file, line, message: `claim at ${file}:${line}` });

const POLICY: MatchedPolicy = { mode: "follow", k: 3, kMax: 6, floorShare: 0.05 };

/** A valid session that spent its whole ceiling of 3,000 tokens. */
const session = (index: number, extra: Partial<SessionRun> = {}): SessionRun => ({
	index, attempt: 1, cellId: `cell-${index}`, valid: true, infra: false, ceiling: 3000, totalTokens: 3000, truePositives: 1, claims: 2, stop: "budget",
	findings: [finding("src/a.ts", 10 * index), finding("src/shared.ts", 5)], ...extra,
});

/** A grader that counts a claim as a true positive when its line is in `hits`; it records what it was handed. */
const grader = (hits: number[]) => {
	const seen: Finding[][] = [];
	const grade = async (findings: Finding[]): Promise<UnionGrade> => {
		seen.push(findings);
		const tp = findings.filter((f) => hits.includes(f.line ?? -1)).length;
		return { ok: true, truePositives: tp, totalFindings: findings.length, precision: findings.length ? tp / findings.length : 0 };
	};
	return { grade, seen };
};

const union = (sessions: SessionRun[], grade: (f: Finding[]) => Promise<UnionGrade>, budget: number | null = 9000) =>
	scoreUnion({ key: "T1#1", target: "T1", pass: 1, attempt: 2, policy: POLICY, budget, sessions, grade });

describe("parseMatchedSpec and parseMatchedPolicy", () => {
	it("defaults to follow mode over three sessions, up to twice as many, stopping below 5% of B", () => {
		expect(parseMatchedSpec("follow")).toEqual({ mode: "follow", k: DEFAULT_MATCHED_K, kMax: 6, floorShare: 0.05 });
		expect(parseMatchedSpec("k=5")).toEqual({ mode: "follow", k: 5, kMax: 10, floorShare: 0.05 });
		expect(parseMatchedSpec("k=2,kMax=2,floor=0.1")).toEqual({ mode: "follow", k: 2, kMax: 2, floorShare: 0.1 });
	});

	it("reads a fixed mode's pre-registered budget per target", () => {
		expect(parseMatchedSpec("mode=fixed,k=2,budget.T1=4000000,budget.T2=3000000")).toEqual({ mode: "fixed", k: 2, kMax: 4, floorShare: 0.05, budgets: { T1: 4_000_000, T2: 3_000_000 } });
	});

	it("carries an exploratory snapshot override, which must be absolute", () => {
		expect(parseMatchedSpec("follow", "/snapshots/other")).toEqual({ mode: "follow", k: 3, kMax: 6, floorShare: 0.05, snapshot: "/snapshots/other" });
		expect(() => parseMatchedSpec("follow", "relative/path")).toThrow(/absolute/);
	});

	it("refuses a spec its own resume would refuse", () => {
		expect(() => parseMatchedSpec("fixed")).toThrow(/budget per target/);
		expect(() => parseMatchedSpec("k=0")).toThrow(/k must be/);
		expect(() => parseMatchedSpec("k=9")).toThrow(/k must be/);
		expect(() => parseMatchedSpec("k=3,kMax=2")).toThrow(/kMax must be/);
		expect(() => parseMatchedSpec("kMax=17")).toThrow(/kMax must be/);
		expect(() => parseMatchedSpec("floor=0")).toThrow(/floorShare/);
		expect(() => parseMatchedSpec("floor=1")).toThrow(/floorShare/);
		expect(() => parseMatchedSpec("k=2,k=3")).toThrow(/twice/);
		expect(() => parseMatchedSpec("mode=sometimes")).toThrow(/mode/);
		expect(() => parseMatchedSpec("budget.T1=100")).toThrow(/for mode fixed/);
		expect(() => parseMatchedSpec("ceiling=100")).toThrow(/unknown key/);
		expect(() => parseMatchedSpec("mode=fixed,k=3,budget.T1=2")).toThrow(/smaller than k/);
		expect(() => parseMatchedSpec("k")).toThrow(/k=v pairs/);
	});

	it("reads a manifest's policy strictly, so a malformed or partial one never reads as no matched arm", () => {
		expect(parseMatchedPolicy({ ...POLICY })).toEqual(POLICY);
		expect(() => parseMatchedPolicy(null)).toThrow(/object/);
		expect(() => parseMatchedPolicy({ ...POLICY, sessions: 3 })).toThrow(/unknown key sessions/);
		expect(() => parseMatchedPolicy({ mode: "follow", k: 3 })).toThrow(/kMax/);
		expect(() => parseMatchedPolicy({ ...POLICY, mode: "fixed", budgets: { T1: -5 } })).toThrow(/positive integer/);
	});

	it("names the targets a fixed policy has no budget for", () => {
		expect(targetsWithoutBudget(parseMatchedSpec("mode=fixed,budget.T1=900"), ["T1", "T2"])).toEqual(["T2"]);
		expect(targetsWithoutBudget(parseMatchedSpec("follow"), ["T1", "T2"])).toEqual([]);
	});
});

describe("sessionBudget", () => {
	it("follow mode sets B from the candidate run's tokens", () => {
		expect(sessionBudget(POLICY, "T1", { valid: true, totalTokens: 9_000_001 })).toEqual({ ok: true, budget: 9_000_001, source: "candidate" });
	});

	it("gives no budget when the pair's candidate run measured none", () => {
		expect(sessionBudget(POLICY, "T1", { valid: false, totalTokens: Number.NaN })).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid/) });
		expect(sessionBudget(POLICY, "T1", undefined).ok).toBe(false);
		expect(sessionBudget(POLICY, "T1", { valid: true, totalTokens: 0 })).toMatchObject({ ok: false, reason: expect.stringMatching(/no tokens/) });
	});

	it("fixed mode reads the pre-registered budget and ignores the candidate", () => {
		const policy = parseMatchedSpec("mode=fixed,k=4,budget.T1=8000");
		expect(sessionBudget(policy, "T1", undefined)).toEqual({ ok: true, budget: 8000, source: "fixed" });
		expect(sessionBudget(policy, "T2", { valid: true, totalTokens: 5000 })).toMatchObject({ ok: false, reason: "no pre-registered budget for T2" });
	});
});

describe("nextSessionStep", () => {
	const ran = (index: number, tokens: number, extra: Partial<SessionState> = {}): SessionState => ({ index, attempt: 1, valid: true, infra: false, tokens, ceiling: 0, ...extra });

	it("follow mode splits B over k for the first session", () => {
		expect(nextSessionStep(POLICY, 9_000_001, [])).toEqual({ kind: "run", index: 1, attempt: 1, ceiling: 3_000_000, spentBefore: 0 });
	});

	it("rolls a session's unspent budget over to the sessions after it", () => {
		// Session 1 stopped on its own after 600 of its 3,000; session 2 gets half of the 8,400 left.
		expect(nextSessionStep(POLICY, 9000, [ran(1, 600)])).toEqual({ kind: "run", index: 2, attempt: 1, ceiling: 4200, spentBefore: 600 });
		expect(nextSessionStep(POLICY, 9000, [ran(1, 600), ran(2, 1000)])).toEqual({ kind: "run", index: 3, attempt: 1, ceiling: 7400, spentBefore: 1600 });
	});

	it("runs extra sessions with all that is left while it is at least the floor, up to kMax", () => {
		const three = [ran(1, 1000), ran(2, 1000), ran(3, 1000)];
		expect(nextSessionStep(POLICY, 9000, three)).toEqual({ kind: "run", index: 4, attempt: 1, ceiling: 6000, spentBefore: 3000 });
		// 400 left of 9,000 is under the 5% floor (450): the arm is done.
		expect(nextSessionStep(POLICY, 9000, [ran(1, 3000), ran(2, 3000), ran(3, 2600)])).toEqual({ kind: "done", sessions: 3, spent: 8600 });
		// kMax sessions have run, whatever is left.
		const six = [1, 2, 3, 4, 5, 6].map((i) => ran(i, 100));
		expect(nextSessionStep(POLICY, 9000, six)).toEqual({ kind: "done", sessions: 6, spent: 600 });
	});

	it("re-runs a failed session with its index's original ceiling", () => {
		const step = nextSessionStep(POLICY, 9000, [ran(1, 600), { ...ran(2, 0, { valid: false, infra: true, ceiling: 4200 }) }]);
		expect(step).toEqual({ kind: "run", index: 2, attempt: 2, ceiling: 4200, spentBefore: 600 });
	});

	it("reads each session at its own highest attempt", () => {
		expect(nextSessionStep({ ...POLICY, k: 1, kMax: 1 }, 9000, [ran(1, 0, { attempt: 1, valid: false, infra: true }), ran(1, 9000, { attempt: 2 })])).toEqual({ kind: "done", sessions: 1, spent: 9000 });
	});

	it("spends nothing more once a session is blocked, even with later sessions still missing", () => {
		// Session 1 invalid for a non-infrastructure reason; sessions 2 and 3 never ran.
		const step = nextSessionStep(POLICY, 9000, [ran(1, 0, { valid: false, infra: false })]);
		expect(step).toMatchObject({ kind: "blocked", index: 1, reason: expect.stringMatching(/the session is invalid for a non-infrastructure reason/) });
	});

	it("abandons the arm when a session fails at the attempt ceiling, before re-running any other", () => {
		const step = nextSessionStep(POLICY, 9000, [ran(1, 0, { valid: false, infra: true }), ran(2, 0, { attempt: 16, valid: false, infra: true })], { attemptCeiling: 16 });
		expect(step).toMatchObject({ kind: "abandoned", index: 2, reason: expect.stringMatching(/the session is abandoned/) });
	});
});

describe("unionFindings and scoreUnion", () => {
	it("dedupes across sessions before scoring, with the pinned scorer's file+line rule", async () => {
		// Three sessions each claim src/shared.ts:5; the union submits it once.
		const { grade, seen } = grader([5, 20]);
		const u = await union([session(1), session(2), session(3)], grade);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.map((f) => `${f.file}:${f.line}`)).toEqual(["src/a.ts:10", "src/shared.ts:5", "src/a.ts:20", "src/a.ts:30"]);
		expect(u).toMatchObject({ valid: true, truePositives: 2, totalClaims: 4, precision: 0.5, submittedFindings: 4, claimsBeforeUnion: 6, totalTokens: 9000, attempt: 2, k: 3, kMax: 6 });
		expect(u.sessions.map((s) => s.index)).toEqual([1, 2, 3]);
		expect(u.sessions[0]).not.toHaveProperty("findings");
		expect(metricOfUnion(u)).toEqual({ key: "T1#1", target: "T1", pass: 1, valid: true, truePositives: 2, precision: 0.5, totalClaims: 4, totalTokens: 9000 });
	});

	it("unions the same way eval/compounding-union.ts accumulates sessions", () => {
		expect(unionFindings([[finding("x", 1), finding("x", 1)], [finding("x", 1), finding("y", 2)]]).map((f) => `${f.file}:${f.line}`)).toEqual(["x:1", "y:2"]);
	});

	it("counts an extra session the rollover owed, and is invalid until it has run", async () => {
		const { grade } = grader([]);
		// The first three spent 3,000 of 9,000 between them, so a fourth is owed the 6,000 left.
		const short = [session(1, { totalTokens: 1000 }), session(2, { totalTokens: 1000 }), session(3, { totalTokens: 1000 })];
		expect((await union(short, grade)).reasons).toEqual(["session 4 has no run"]);
		const u = await union([...short, session(4, { totalTokens: 5800, ceiling: 6000 })], grade);
		expect(u).toMatchObject({ valid: true, totalTokens: 8800 });
	});

	it("marks the arm invalid when one session is, and never grades it", async () => {
		const { grade, seen } = grader([5]);
		const u = await union([session(1), session(2, { valid: false, infra: true, totalTokens: Number.NaN, attempt: 3 }), session(3)], grade);
		expect(u.valid).toBe(false);
		expect(u.reasons).toEqual(["session 2 (attempt 3) is not valid"]);
		expect(u.totalTokens).toBeNull();
		expect(seen).toHaveLength(0);
		expect(metricOfUnion(u).valid).toBe(false);
		expect(Number.isNaN(metricOfUnion(u).totalTokens)).toBe(true);
	});

	it("marks the arm invalid when a session is missing, repeated or out of range, or it had no budget", async () => {
		const { grade } = grader([]);
		expect((await union([session(1), session(3)], grade)).reasons).toEqual(["session 2 has no run"]);
		expect((await union([session(1), session(1), session(2), session(3)], grade)).reasons).toEqual(["session 1 is given twice"]);
		expect((await union([session(1), session(2), session(3), session(7)], grade)).reasons).toEqual(["session index 7 is outside 1..6"]);
		expect((await union([session(1), session(2), session(3, { totalTokens: 0 })], grade)).reasons).toContain("session 3 reports no tokens");
		expect((await union([session(1), session(2), session(3, { findings: undefined })], grade)).reasons).toEqual(["session 3's findings were not read"]);
		expect((await union([], grade, null)).reasons).toEqual(["the arm has no budget"]);
		expect((await union([session(1, { valid: false, infra: false })], grade)).reasons).toEqual([expect.stringMatching(/^session 1: .*non-infrastructure/)]);
	});

	it("marks the arm invalid when the pinned scorer cannot grade the union", async () => {
		const failing = async (): Promise<UnionGrade> => ({ ok: false, error: "pinned scorer did not produce a readable report" });
		const u = await union([session(1), session(2), session(3)], failing);
		expect(u).toMatchObject({ valid: false, reasons: ["pinned scorer did not produce a readable report"], submittedFindings: 4 });
		const throwing = async (): Promise<UnionGrade> => { throw new Error("python missing"); };
		expect((await union([session(1), session(2), session(3)], throwing)).reasons).toEqual(["union grading failed: python missing"]);
	});
});

const metric = (key: string, target: string, pass: number, tp: number, claims: number, tokens: number, valid = true): RunMetric => ({
	key, target, pass, valid, truePositives: tp, totalClaims: claims, precision: claims ? tp / claims : 0, totalTokens: tokens,
});

describe("budgetRatios", () => {
	it("reports the realised budget ratio per pair and its median", () => {
		const r = budgetRatios(
			[metric("T1#1", "T1", 1, 2, 4, 1100), metric("T2#1", "T2", 1, 1, 2, 800), metric("T3#1", "T3", 1, 1, 2, 3000), metric("T4#1", "T4", 1, 0, 0, Number.NaN, false)],
			[metric("T1#1", "T1", 1, 2, 3, 1000), metric("T2#1", "T2", 1, 1, 2, 1000), metric("T3#1", "T3", 1, 1, 2, 1000), metric("T4#1", "T4", 1, 1, 1, 1000)],
		);
		expect(r.perPair.map((p) => [p.key, p.ratio])).toEqual([["T1#1", 1.1], ["T2#1", 0.8], ["T3#1", 3]]);
		// The median, not the pooled ratio: one long run (T3) does not move it.
		expect(r.median).toBe(1.1);
	});

	it("has no median without a pair", () => {
		expect(budgetRatios([], []).median).toBeNull();
		expect(median([1, 3])).toBe(2);
	});
});

describe("matchedComparisons", () => {
	const cells: ExpectedCell[] = [{ key: "T1#1", target: "T1", pass: 1 }, { key: "T2#1", target: "T2", pass: 1 }];
	const baseline = [metric("T1#1", "T1", 1, 1, 2, 1000), metric("T2#1", "T2", 1, 1, 2, 1000)];
	const candidate = [metric("T1#1", "T1", 1, 2, 3, 2000), metric("T2#1", "T2", 1, 1, 2, 2000)];
	const matched = [metric("T1#1", "T1", 1, 3, 6, 2100), metric("T2#1", "T2", 1, 1, 3, 1900)];

	it("reports matched vs candidate and matched vs baseline, labelled by arm and approving nothing", () => {
		const { matchedVsCandidate, matchedVsBaseline } = matchedComparisons(baseline, candidate, matched, cells);
		expect(matchedVsCandidate).toMatchObject({ reference: "matched", subject: "candidate", complete: true, pairedRuns: 2 });
		expect(matchedVsCandidate).not.toHaveProperty("decision");
		// candidate − matched: 3 TP against 4.
		expect(matchedVsCandidate.pairedDelta.truePositives.mean).toBe(-1);
		expect(matchedVsCandidate.arms.matched?.truePositives.mean).toBe(4);
		expect(matchedVsBaseline).toMatchObject({ reference: "baseline", subject: "matched" });
		expect(matchedVsBaseline.pairedDelta.totalTokens.mean).toBe(2000);
		expect(matchedVsBaseline.targets.map((t) => t.target)).toEqual(["T1", "T2"]);
	});

	it("names a missing matched run by its arm, not by the gate's arm names", () => {
		const { matchedVsCandidate } = matchedComparisons(baseline, candidate, [matched[0]!, metric("T2#1", "T2", 1, 0, 0, Number.NaN, false)], cells);
		expect(matchedVsCandidate.complete).toBe(false);
		expect(matchedVsCandidate.missingOrInvalid).toEqual(["T2#1"]);
		const extra = matchedComparisons(baseline, candidate, [...matched, metric("T9#1", "T9", 1, 0, 0, 5)], cells);
		expect(extra.matchedVsCandidate.missingOrInvalid).toContain("matched unexpected T9#1");
		expect(extra.matchedVsBaseline.missingOrInvalid).toContain("matched unexpected T9#1");
	});
});
