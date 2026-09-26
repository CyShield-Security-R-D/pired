/**
 * The matched-compute arm (delegation v6, plan item 2.5): the candidate snapshot
 * with delegation off, run k times in fresh cells at the candidate's token
 * budget, its findings unioned and scored with the pinned scorer.
 *
 * Why it exists: the v5 trial could not say whether delegation adds anything
 * beyond spending more tokens. Its candidate spent more than the baseline on
 * most grids, and a single agent given the same extra tokens was never run, so a
 * candidate that found more could have been buying findings with compute that
 * any arm would have turned into findings. This arm spends the candidate's
 * tokens without delegating; the comparison that answers the question is
 * matched vs candidate, reported beside the gate and never inside it.
 *
 * Everything here is pure: the runner does the launching, the ledger reading
 * and the grading, and passes the results in.
 */
import { dedupe, type Finding } from "./dvbank/score.ts";
import {
	compareMatchedRuns, nextPairAction,
	type Arm, type ArmSummary, type ExpectedCell, type MatchedComparison, type PairRules, type QualityGate, type RangeMean, type RunMetric, type TargetSide,
} from "./delegation-compare-lib.ts";

/**
 * - `follow`: each pair's matched arm starts after that pair's candidate run has
 *   finished, and its total budget B is that run's measured tokens (the gate's
 *   metric: metered plus the retry estimate under a retry policy). Compute is
 *   matched per pair, at the price of running later than the pair.
 * - `fixed`: B is a pre-registered per-target number, so the arm need not wait
 *   for the candidate. It is for the concurrent runner of item 2.2; until then
 *   it runs in the same slot as `follow`, after the pair.
 */
export type MatchedMode = "follow" | "fixed";

export interface MatchedPolicy {
	mode: MatchedMode;
	/** The sessions B is first split over: session i ≤ k gets an even share of what is left. */
	k: number;
	/**
	 * The most sessions a pair may run. After the first k, while at least
	 * `floorShare` of B is unspent, another session runs with all of it.
	 */
	kMax: number;
	/** The share of B below which no further session is started. */
	floorShare: number;
	/** `fixed` only: B per target id, in tokens. */
	budgets?: Record<string, number>;
	/**
	 * An input snapshot other than the candidate's, for exploratory use. Absent,
	 * the arm runs the candidate snapshot, so that matched vs candidate differs
	 * only in delegation and not in the other product changes the baseline lacks.
	 */
	snapshot?: string;
}

export const DEFAULT_MATCHED_K = 3;
/** Past this many sessions a pair's matched arm alone outlasts the two arms it is compared with several times over. */
export const MAX_MATCHED_K = 8;
export const MAX_MATCHED_K_MAX = 16;
/** 5% of B: below it a fresh session would spend most of its budget re-reading the target. */
export const DEFAULT_FLOOR_SHARE = 0.05;

const POLICY_KEYS = new Set(["mode", "k", "kMax", "floorShare", "budgets", "snapshot"]);

const isTokenCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * The policy as a manifest stores it, read strictly: a resume must run the arm
 * its grid started with, so a malformed policy refuses rather than reading as
 * "no matched arm", and an unknown or missing key refuses rather than being
 * filled in.
 */
export function parseMatchedPolicy(value: unknown): MatchedPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("matched must be an object");
	const row = value as Record<string, unknown>;
	for (const key of Object.keys(row)) if (!POLICY_KEYS.has(key)) throw new Error(`matched has an unknown key ${key}`);
	if (row.mode !== "follow" && row.mode !== "fixed") throw new Error(`matched.mode must be "follow" or "fixed", got ${JSON.stringify(row.mode)}`);
	if (typeof row.k !== "number" || !Number.isSafeInteger(row.k) || row.k < 1 || row.k > MAX_MATCHED_K) throw new Error(`matched.k must be an integer from 1 to ${MAX_MATCHED_K}`);
	if (typeof row.kMax !== "number" || !Number.isSafeInteger(row.kMax) || row.kMax < row.k || row.kMax > MAX_MATCHED_K_MAX) throw new Error(`matched.kMax must be an integer from k to ${MAX_MATCHED_K_MAX}`);
	if (typeof row.floorShare !== "number" || !Number.isFinite(row.floorShare) || row.floorShare <= 0 || row.floorShare >= 1) throw new Error("matched.floorShare must be a share of B above 0 and below 1");
	const policy: MatchedPolicy = { mode: row.mode, k: row.k, kMax: row.kMax, floorShare: row.floorShare };
	if (row.mode === "fixed") {
		const budgets = row.budgets;
		if (!budgets || typeof budgets !== "object" || Array.isArray(budgets) || Object.keys(budgets).length === 0) throw new Error("matched.mode fixed needs a budget per target in matched.budgets");
		for (const [target, tokens] of Object.entries(budgets)) {
			if (!isTokenCount(tokens)) throw new Error(`matched.budgets.${target} must be a positive integer token count`);
			if (tokens < row.k) throw new Error(`matched.budgets.${target} is smaller than k, so a session's ceiling would be zero`);
		}
		policy.budgets = { ...(budgets as Record<string, number>) };
	} else if (row.budgets !== undefined) {
		throw new Error("matched.budgets is for mode fixed; mode follow takes each pair's budget from its candidate run");
	}
	if (row.snapshot !== undefined) {
		if (typeof row.snapshot !== "string" || !row.snapshot.startsWith("/")) throw new Error("matched.snapshot must be an absolute path");
		policy.snapshot = row.snapshot;
	}
	return policy;
}

/**
 * --matched's value: "follow", "fixed", or k=v pairs over mode follow, k = 3,
 * kMax = 2k and floor = 0.05. A fixed budget is `budget.<target id>=<tokens>`.
 * Validated by the rule the manifest is read back with, so a grid cannot start
 * under a policy its own resume would refuse.
 */
export function parseMatchedSpec(spec: string, snapshot?: string): MatchedPolicy {
	const policy: Record<string, unknown> = { mode: "follow", k: DEFAULT_MATCHED_K, floorShare: DEFAULT_FLOOR_SHARE };
	const text = spec.trim();
	if (text === "follow" || text === "fixed") policy.mode = text;
	else {
		const seen = new Set<string>();
		const budgets: Record<string, number> = {};
		for (const part of text.split(",")) {
			const [key, value, extra] = part.split("=").map((x) => x.trim());
			if (!key || value === undefined || value === "" || extra !== undefined) throw new Error(`--matched: expected "follow", "fixed" or k=v pairs, got "${part}"`);
			if (seen.has(key)) throw new Error(`--matched: ${key} is given twice`);
			seen.add(key);
			if (key === "mode") policy.mode = value;
			else if (key === "k") policy.k = Number(value);
			else if (key === "kMax") policy.kMax = Number(value);
			else if (key === "floor") policy.floorShare = Number(value);
			else if (key.startsWith("budget.") && key.length > "budget.".length) budgets[key.slice("budget.".length)] = Number(value);
			else throw new Error(`--matched: unknown key ${key}`);
		}
		if (Object.keys(budgets).length) policy.budgets = budgets;
	}
	if (policy.kMax === undefined && typeof policy.k === "number") policy.kMax = Math.min(2 * policy.k, MAX_MATCHED_K_MAX);
	if (snapshot !== undefined) policy.snapshot = snapshot;
	// The manifest's own key order, so a pinned policy reads the same however it was typed.
	const ordered = Object.fromEntries(["mode", "k", "kMax", "floorShare", "budgets", "snapshot"].filter((k) => policy[k] !== undefined).map((k) => [k, policy[k]]));
	try {
		return parseMatchedPolicy(ordered);
	} catch (error) {
		throw new Error(`--matched: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Targets a fixed policy names no budget for; always empty under `follow`. */
export function targetsWithoutBudget(policy: MatchedPolicy, targetIds: readonly string[]): string[] {
	return policy.mode === "fixed" ? targetIds.filter((id) => !isTokenCount(policy.budgets?.[id])) : [];
}

export type SessionBudget =
	| { ok: true; budget: number; source: "candidate" | "fixed" }
	| { ok: false; reason: string };

/**
 * B for one pair. Under `follow` a candidate run that is not valid has no
 * measured tokens, so the arm has no budget and is not run.
 */
export function sessionBudget(policy: MatchedPolicy, target: string, candidate: { valid: boolean; totalTokens: number } | undefined): SessionBudget {
	if (policy.mode === "fixed") {
		const fixed = policy.budgets?.[target];
		return isTokenCount(fixed) ? { ok: true, budget: fixed, source: "fixed" } : { ok: false, reason: `no pre-registered budget for ${target}` };
	}
	if (!candidate?.valid) return { ok: false, reason: "the pair's candidate run is not valid, so it measured no budget" };
	if (!Number.isFinite(candidate.totalTokens) || candidate.totalTokens <= 0) return { ok: false, reason: "the pair's candidate run reports no tokens" };
	return { ok: true, budget: Math.round(candidate.totalTokens), source: "candidate" };
}

/** One session's latest run at its pair's attempt, as the plan reads it. */
export interface SessionState {
	index: number;
	/** The session's own attempt. */
	attempt: number;
	valid: boolean;
	infra: boolean;
	/** The gate's metric for a valid session; ignored for an invalid one. */
	tokens: number;
	/** The ceiling the index was first launched with; a re-run keeps it. */
	ceiling: number;
}

export type SessionStep =
	| { kind: "run"; index: number; attempt: number; ceiling: number; spentBefore: number }
	| { kind: "done"; sessions: number; spent: number }
	| { kind: "blocked" | "abandoned"; index: number; reason: string };

/**
 * The matched arm's next session, from the sessions it has run.
 *
 * - **Rollover.** Session i ≤ k gets floor((B − spent) / (k − i + 1)), where
 *   spent is the valid sessions' tokens before it. A fixed split of B / k would
 *   leave a session that stops early (about 40% of Luna runs end within five
 *   minutes, research/12) with its share unspent, and the arm below the
 *   candidate's compute for a reason that is not the single agent's.
 * - **Extra sessions.** After the first k, while at least floorShare × B is
 *   left and fewer than kMax sessions have run, one more session runs with all
 *   of what is left.
 * - **Re-runs.** A session that failed for infrastructure re-runs at attempt + 1
 *   with its index's original ceiling, so a drop does not move the split.
 * - **A blocked or abandoned session ends the arm** (review): nothing more is
 *   spent on a union that could never be valid.
 */
export function nextSessionStep(policy: Pick<MatchedPolicy, "k" | "kMax" | "floorShare">, budget: number, sessions: readonly SessionState[], rules: Pick<PairRules, "attemptCeiling"> = {}): SessionStep {
	const latest = new Map<number, SessionState>();
	for (const s of sessions) {
		const held = latest.get(s.index);
		// Two rows at one attempt resolve to the last written, as in planResume.
		if (!held || s.attempt >= held.attempt) latest.set(s.index, s);
	}
	for (const s of [...latest.values()].sort((a, b) => a.index - b.index)) {
		if (s.valid) continue;
		const action = nextPairAction(s.attempt, [{ valid: false, infra: s.infra }], rules);
		const reason = action.kind === "keep" ? "" : action.reason.replace("an arm", "the session").replace("the pair is", "the session is");
		if (action.kind === "blocked" || action.kind === "abandoned") return { kind: action.kind, index: s.index, reason };
	}
	let spent = 0;
	for (let index = 1; index <= policy.kMax; index++) {
		const s = latest.get(index);
		if (s?.valid) { spent += s.tokens; continue; }
		if (s) return { kind: "run", index, attempt: s.attempt + 1, ceiling: s.ceiling, spentBefore: spent };
		const left = budget - spent;
		let ceiling: number;
		if (index <= policy.k) ceiling = Math.floor(left / (policy.k - index + 1));
		else if (left >= policy.floorShare * budget) ceiling = Math.floor(left);
		else return { kind: "done", sessions: index - 1, spent };
		if (ceiling < 1) return { kind: "done", sessions: index - 1, spent };
		return { kind: "run", index, attempt: 1, ceiling, spentBefore: spent };
	}
	return { kind: "done", sessions: policy.kMax, spent };
}

/**
 * The union of the sessions' findings, deduplicated with the pinned scorer's own
 * rule (one file+line is one claim), exactly as eval/compounding-union.ts
 * accumulates the wiped arm's sessions. The union raises claims as well as true
 * positives, which is why its precision is reported beside its TP.
 */
export function unionFindings(sessions: ReadonlyArray<readonly Finding[]>): Finding[] {
	return dedupe(sessions.flatMap((findings) => [...findings]));
}

/** One matched session's latest run, as the union needs it. */
export interface SessionRun {
	/** 1..kMax. */
	index: number;
	/** The session's own attempt; a failed session re-runs alone. */
	attempt: number;
	cellId: string;
	valid: boolean;
	infra: boolean;
	/** The ceiling it ran under. */
	ceiling: number;
	/** The gate's metric; NaN when the session is not valid. */
	totalTokens: number;
	truePositives: number;
	claims: number;
	/** The ADR-030 outcome, when classified. */
	stop: string | null;
	/** The session's findings as the pinned adapter read its ledger; needed only when every session is valid. */
	findings?: readonly Finding[];
}

export type UnionGrade =
	| { ok: true; truePositives: number; totalFindings: number; precision: number }
	| { ok: false; error: string };

export interface MatchedUnion {
	key: string;
	target: string;
	pass: number;
	/** The pair attempt whose candidate run set the budget. */
	attempt: number;
	k: number;
	kMax: number;
	budget: number | null;
	valid: boolean;
	/** Why the arm is not valid; empty when it is. */
	reasons: string[];
	sessions: Array<Omit<SessionRun, "findings">>;
	/** Scored on the union with the pinned scorer: the official number. Zero when not valid. */
	truePositives: number;
	totalClaims: number;
	precision: number;
	/** Sum over the sessions; null when the arm is not valid. */
	totalTokens: number | null;
	/** Findings submitted to the scorer after deduplication across sessions. */
	submittedFindings: number;
	/** The same sessions' claims before the cross-session deduplication. */
	claimsBeforeUnion: number;
}

/**
 * The arm is valid only when the session plan is done (nextSessionStep) and
 * every session it ran is valid, one latest run per index; a failed session is
 * re-run on its own, and until the plan is done the arm has no number. Tokens
 * are the sum over the sessions, TP and claims the pinned scorer's on the
 * deduplicated union.
 */
export async function scoreUnion(input: {
	key: string; target: string; pass: number; attempt: number;
	policy: Pick<MatchedPolicy, "k" | "kMax" | "floorShare">;
	budget: number | null;
	sessions: readonly SessionRun[];
	grade: (findings: Finding[]) => Promise<UnionGrade>;
}): Promise<MatchedUnion> {
	const reasons: string[] = [];
	const byIndex = new Map<number, SessionRun>();
	for (const s of input.sessions) {
		if (!Number.isSafeInteger(s.index) || s.index < 1 || s.index > input.policy.kMax) reasons.push(`session index ${s.index} is outside 1..${input.policy.kMax}`);
		else if (byIndex.has(s.index)) reasons.push(`session ${s.index} is given twice`);
		else byIndex.set(s.index, s);
	}
	const sessions = [...byIndex.values()].sort((a, b) => a.index - b.index);
	if (input.budget === null) reasons.push("the arm has no budget");
	else if (!reasons.length) {
		const step = nextSessionStep(input.policy, input.budget, sessions.map((s) => ({ index: s.index, attempt: s.attempt, valid: s.valid, infra: s.infra, tokens: s.totalTokens, ceiling: s.ceiling })));
		if (step.kind === "run") reasons.push(byIndex.has(step.index) ? `session ${step.index} (attempt ${step.attempt - 1}) is not valid` : `session ${step.index} has no run`);
		else if (step.kind !== "done") reasons.push(`session ${step.index}: ${step.reason}`);
	}
	for (const s of sessions) {
		if (!s.valid) continue;
		if (!Number.isFinite(s.totalTokens) || s.totalTokens <= 0) reasons.push(`session ${s.index} reports no tokens`);
		else if (!s.findings) reasons.push(`session ${s.index}'s findings were not read`);
	}
	const base = {
		key: input.key, target: input.target, pass: input.pass, attempt: input.attempt, k: input.policy.k, kMax: input.policy.kMax,
		budget: input.budget,
		sessions: sessions.map(({ findings: _findings, ...rest }) => rest),
		claimsBeforeUnion: sessions.reduce((n, s) => n + (s.findings?.length ?? 0), 0),
	};
	const invalid = (why: string[]): MatchedUnion => ({ ...base, valid: false, reasons: why, truePositives: 0, totalClaims: 0, precision: 0, totalTokens: null, submittedFindings: 0 });
	if (reasons.length) return invalid(reasons);
	const union = unionFindings(sessions.map((s) => s.findings!));
	const graded = await input.grade(union).catch((error: unknown): UnionGrade => ({ ok: false, error: `union grading failed: ${error instanceof Error ? error.message : String(error)}` }));
	if (!graded.ok) return { ...invalid([graded.error]), submittedFindings: union.length };
	return {
		...base, valid: true, reasons: [],
		truePositives: graded.truePositives, totalClaims: graded.totalFindings, precision: graded.precision,
		totalTokens: sessions.reduce((n, s) => n + s.totalTokens, 0), submittedFindings: union.length,
	};
}

/** The union as the comparison reads a run. */
export function metricOfUnion(u: MatchedUnion): RunMetric {
	return {
		key: u.key, target: u.target, pass: u.pass, valid: u.valid,
		truePositives: u.truePositives, precision: u.precision, totalClaims: u.totalClaims,
		totalTokens: u.totalTokens ?? Number.NaN,
	};
}

export function median(xs: readonly number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface BudgetRatio {
	/** Per pair with a valid matched arm and a valid candidate run: matched tokens / candidate tokens. */
	perPair: Array<{ key: string; matchedTokens: number; candidateTokens: number; ratio: number }>;
	/** The median of the per-pair ratios; robust to one long run, which a pooled ratio is not. */
	median: number | null;
}

/**
 * How closely the arm matched the candidate's compute. Under `follow` each
 * session stops at its first reply past B / k, so the ratio sits a little above
 * 1 when every session ran to its ceiling, and below 1 when sessions finished
 * early; under `fixed` it is whatever the pre-registered budget turned out to be
 * against the candidate this grid ran. Reported, never corrected for.
 */
export function budgetRatios(matched: readonly RunMetric[], candidate: readonly RunMetric[]): BudgetRatio {
	const byKey = new Map(candidate.filter((c) => c.valid && Number.isFinite(c.totalTokens) && c.totalTokens > 0).map((c) => [c.key, c]));
	const perPair = matched.flatMap((m) => {
		const c = byKey.get(m.key);
		if (!m.valid || !c || !Number.isFinite(m.totalTokens)) return [];
		return [{ key: m.key, matchedTokens: m.totalTokens, candidateTokens: c.totalTokens, ratio: m.totalTokens / c.totalTokens }];
	}).sort((a, b) => a.key.localeCompare(b.key));
	return { perPair, median: median(perPair.map((p) => p.ratio)) };
}

/**
 * One of the comparisons reported beside the gate, labelled by arm. The gate's
 * `decision` is dropped: it names an approval, and these comparisons approve
 * nothing. `gate` is kept as a description (the subject's TP and precision
 * against 85% of the reference's); it gates nothing here.
 */
export interface ArmComparison {
	reference: Arm;
	subject: Arm;
	complete: boolean;
	official: boolean;
	missingOrInvalid: string[];
	pairedRuns: number;
	arms: Partial<Record<Arm, ArmSummary>>;
	/** subject − reference, per complete pass. */
	pairedDelta: { truePositives: RangeMean; precision: RangeMean; totalTokens: RangeMean };
	targets: Array<{ target: string; reference: TargetSide; subject: TargetSide; subjectRangeBelowReference: boolean }>;
	gate: QualityGate;
	meanTokenReductionObserved: boolean;
	tokenRangesSeparated: boolean;
}

function relabel(c: MatchedComparison, reference: Arm, subject: Arm): ArmComparison {
	const rename = (s: string): string => s.replace(/^baseline /, `${reference} `).replace(/^candidate /, `${subject} `);
	return {
		reference, subject, complete: c.complete, official: c.official,
		missingOrInvalid: c.missingOrInvalid.map(rename), pairedRuns: c.pairedRuns,
		arms: { [reference]: c.baseline, [subject]: c.candidate },
		pairedDelta: c.pairedDelta,
		targets: c.targets.map((t) => ({ target: t.target, reference: t.baseline, subject: t.candidate, subjectRangeBelowReference: t.candidateRangeBelowBaseline })),
		gate: c.gate, meanTokenReductionObserved: c.meanTokenReductionObserved, tokenRangesSeparated: c.tokenRangesSeparated,
	};
}

/**
 * The two comparisons the arm exists for, on the same expected cells as the
 * gate. matched vs candidate asks whether delegation beats a single agent that
 * spent the same tokens (delta = candidate − matched); matched vs baseline asks
 * what the extra tokens alone bought over the baseline (delta = matched −
 * baseline). The gate itself, baseline vs candidate, is computed as before and
 * is not touched.
 */
export function matchedComparisons(baseline: RunMetric[], candidate: RunMetric[], matched: RunMetric[], expected: ExpectedCell[]): { matchedVsCandidate: ArmComparison; matchedVsBaseline: ArmComparison } {
	return {
		matchedVsCandidate: relabel(compareMatchedRuns(matched, candidate, expected), "matched", "candidate"),
		matchedVsBaseline: relabel(compareMatchedRuns(baseline, matched, expected), "baseline", "matched"),
	};
}
