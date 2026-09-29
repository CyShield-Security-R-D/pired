#!/usr/bin/env -S node --experimental-strip-types
/**
 * The pre-registered decision of the delegation v6 trial, for one comparison
 * (docs/delegation-v6-preregistration.md, "Decision rule" and "Analysis plan").
 *
 * - S vs A: stage 1, A (`main`, the incumbent) is the harness's `baseline`, S
 *   (the candidate solo) its `candidate`.
 * - D vs S and D vs M: stage 2, S is the `baseline`, D (the candidate
 *   delegating) the `candidate`, M (matched compute) the `matched` union.
 * - D vs A: reported only, never deciding, bridged through S across the stages
 *   (`bridgeDvsA`).
 *
 * Every difference is subject − reference: S − A, D − S, D − M.
 *
 * A comparison passes when all three rules hold:
 *
 * 1. True positives: the 95% app-clustered bootstrap interval (10,000
 *    resamples, seed 1, targets as clusters) on the mean per-pair difference in
 *    advisories found by the pinned grader's matching (rescore's
 *    `officialAdvisories`) has its lower bound above −0.3 (non-inferior); above
 *    0 it is superior. Every rescore location level, the any-of class level and
 *    unique labelled locations are reported as robustness and never decide.
 * 2. Precision: adjudicated precision of the presented tier, per arm and target
 *    over the unique issues the arm claimed across its paired runs there, pooled
 *    over targets as Σ valid ÷ Σ claimed issues; the subject's at least 0.85 of
 *    the reference's, with the ratio's app-clustered bootstrap interval beside
 *    it. Without adjudication labels, or with a presented claim unlabelled, the
 *    rule is pending and the comparison cannot pass; the key's precision over
 *    non-neutral claims is shown as a provisional indicator only. The key labels
 *    only known CVEs, so an arm that reports more real issues it does not list
 *    would read as less precise: that is why the rule is adjudicated
 *    (eval/adjudication.md).
 * 3. Cost: the upper bound of the same interval on the median per-pair log
 *    ratio of the gate's token metric is at most log(1.10), or log(1.5) when
 *    rule 1 shows superiority. The median, because pooled sums swung from 0.51
 *    to 2.86 on single Luna runs; the pooled ratio is reported beside it.
 *
 * Grid state comes from the harness's codes in summary.decision.reasons. An
 * abandoned pair makes every comparison using it inconclusive (a matched
 * session's only D vs M), with the full report still produced: a pair the grid
 * could not run is not a pair either arm won. Invalid and blocked pairs are
 * excluded by the harness's validity rules and listed. A grid a resume would
 * still change (interrupted, stopped, quota, credential, gave-up, an amendment
 * pending, blinded) or one that cannot be decided (exploratory, runtime
 * changed, amendments edited) is not ready, and then nothing is computed: a
 * stage-1 grid before its amendment is the blind pilot, and printing the
 * comparison would unblind it (eval/v6-pilot-sd.ts reads it blind).
 *
 * Reported and never deciding: stopping (3.2), the patched twins, the verifier
 * metrics, dollars, per-advisory find rates, McNemar, and per arm how many
 * paired runs reached the run limit or ended fast and empty (the v6 validity
 * policy keeps both valid) and how many counted their tokens as a lower bound
 * (a worker cut off at the limit). Rule 3 includes those pairs; it is reported
 * again without them as a sensitivity row that never decides.
 *
 * Adjudication runs in two steps around a judge that never sees an arm: `export`
 * writes a blind worksheet per target and a key map kept from the judge, and
 * `join` turns the judge's issues into the labels this reads (eval/adjudication.md,
 * "Worksheet and labels").
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { metricFromRecord } from "./delegation-compare.ts";
import { parseAmendments } from "./delegation-compare-grid.ts";
import { summarizeStops, type StopRow } from "./delegation-compare-stop.ts";
import {
	clusterBootstrap, clusterBootstrapStatistic, diffsByTarget, dropTwins, mcnemar, median, mulberry32, pairRuns, perIssueFindRate, twinIdsFromManifests,
	type Arm, type ArmPair, type Pair, type RunRecord,
} from "./paired.ts";
import {
	advisoryOf, claimOutcomes, currentRuns, LEVELS, ledgerFindingRows, ledgerFindingTexts, loadRegions, rescoreGrid, tiersOf,
	type ClaimTier, type Region, type RescoreRow, type Truth,
} from "./rescore.ts";
import { assertLocationOnlyTruth, OFFICIAL_LEVEL, toRecords } from "./v6-pilot-sd.ts";

type Row = Record<string, unknown>;
export type ArmLetter = "A" | "S" | "D" | "M";
export type ComparisonId = "S-vs-A" | "D-vs-S" | "D-vs-M";
type Stage = "v6-stage1" | "v6-stage2";

export const COMPARISONS: Record<ComparisonId, { stage: Stage; reference: ArmLetter; subject: ArmLetter }> = {
	"S-vs-A": { stage: "v6-stage1", reference: "A", subject: "S" },
	"D-vs-S": { stage: "v6-stage2", reference: "S", subject: "D" },
	"D-vs-M": { stage: "v6-stage2", reference: "M", subject: "D" },
};

/** The harness's arm names per stage kind (eval/delegation-compare.md, "v6 grids"). */
export const HARNESS_ARMS: Record<Stage, Partial<Record<ArmLetter, Arm>>> = {
	"v6-stage1": { A: "baseline", S: "candidate" },
	"v6-stage2": { S: "baseline", D: "candidate", M: "matched" },
};

export const RULES = { margin: -0.3, precisionRatio: 0.85, cost: Math.log(1.1), costIfSuperior: Math.log(1.5), iterations: 10000, seed: 1 } as const;
export const CLASS_LEVEL = "class any-of";

const readJson = (path: string): Row => JSON.parse(readFileSync(path, "utf8")) as Row;
const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// --- Grid state ------------------------------------------------------------------

/** Codes that a resume clears, or that mean the grid cannot be decided: either way, not ready. */
const NOT_READY_CODES = new Set(["interrupted", "drained", "stopped", "quota", "credential", "gave-up", "amendment-pending", "blinded", "exploratory", "runtime-changed", "amendment-mismatch"]);

export interface GridState {
	dir: string;
	notReady: string[];
	/** Gate pairs (target#pass) abandoned at the attempt ceiling: against every comparison of the stage. */
	gateAbandoned: string[];
	/** Pairs whose matched session was abandoned: against D vs M only. */
	matchedAbandoned: string[];
	/** The harness's invalid and blocked notes, listed beside the pairs excluded. */
	harnessExcluded: Array<{ code: string; keys: string[] }>;
	/** The gate pairs the grid was built to run, twins excluded. */
	expected: string[];
	/** Invalid matched unions, by pair, with the harness's reasons. */
	invalidUnions: Map<string, string[]>;
}

/**
 * The cells the grid was last built to run. manifest.json is written once, at launch, so on an
 * amended stage-1 grid it lists only the pilot's passes; each resume writes its own manifest with
 * the cells as amended. Reading the launch manifest printed "36 paired of 24 expected" for
 * v6-stage1-glm (2026-09-29), and would have left an unpaired pair of pass 3 out of `excluded`.
 */
function latestExpectedCells(dir: string, manifest: Row): unknown {
	const resumes = readdirSync(dir).map((f) => /^resume-(\d+)$/.exec(f)).filter((m) => m !== null).map((m) => Number(m[1])).sort((a, b) => b - a);
	for (const n of resumes) {
		const path = join(dir, `resume-${n}`, "manifest.json");
		if (!existsSync(path)) continue;
		const cells = readJson(path).expectedCells;
		if (Array.isArray(cells)) return cells;
	}
	return manifest.expectedCells;
}

const pairKeyOf = (a: unknown): string => String(isRow(a) ? a.key ?? a.session ?? "" : a).replace(/\/\d+$/, "");

/**
 * What a grid's manifest, amendments and summary say about deciding it. A
 * summary without codes (written before they existed) is read by its `ready`
 * flag alone, conservatively: not ready unless ready.
 */
export function gridState(dir: string, stage: Stage): GridState {
	const manifest = readJson(join(dir, "manifest.json"));
	if (manifest.gridKind !== stage) throw new Error(`${dir} is grid kind ${JSON.stringify(manifest.gridKind ?? null)}; this comparison reads "${stage}"`);
	const twins = twinIdsFromManifests([join(dir, "manifest.json")], (p) => readFileSync(p, "utf8"));
	const gate = (k: string) => k !== "" && !twins.has(k.replace(/#\d+$/, ""));
	const notReady: string[] = [];
	if (stage === "v6-stage1") {
		const path = join(dir, "amendments.jsonl");
		const rows = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown) : [];
		if (!parseAmendments(rows).length) notReady.push("amendment-pending: the pass count was not fixed by an amendment (amendments.jsonl has none); the grid is still the blind pilot");
	} else if (!isRow(manifest.passesFrom)) {
		notReady.push("the pass count was not adopted from stage 1 (the manifest has no passesFrom)");
	}
	const summaryPath = join(dir, "summary.json");
	const summary = existsSync(summaryPath) ? readJson(summaryPath) : undefined;
	const decision = isRow(summary?.decision) ? summary.decision : undefined;
	const codes = Array.isArray(decision?.reasons) ? (decision.reasons as unknown[]).filter(isRow) : undefined;
	const gateAbandoned = new Set<string>();
	const harnessExcluded: GridState["harnessExcluded"] = [];
	if (!summary) notReady.push("no summary.json: the grid has not finished");
	else if (isRow(summary.pilot) && summary.pilot.blinded === true) notReady.push("blinded: summary.json is still the blind pilot's");
	else if (!decision) notReady.push("summary.json carries no v6 decision block");
	else if (codes) {
		for (const c of codes) {
			const code = String(c.code);
			const keys = Array.isArray(c.keys) ? c.keys.map(String) : [];
			if (code === "abandoned") keys.map(pairKeyOf).filter(gate).forEach((k) => gateAbandoned.add(k));
			else if (code === "invalid" || code === "blocked") harnessExcluded.push({ code, keys });
			else if (NOT_READY_CODES.has(code)) notReady.push(`${code}: ${String(c.reason ?? "")}`);
			else notReady.push(`unknown harness code ${code}: ${String(c.reason ?? "")}`);
		}
	} else if (decision.ready !== true) {
		const why = Array.isArray(decision.notReadyReasons) ? decision.notReadyReasons.map(String) : ["summary.json does not say the grid is ready"];
		notReady.push(...why.map((w) => `harness (no reason codes): ${w}`));
	}
	// The breaker block lists abandoned pairs too; either source counts.
	if (isRow(summary?.breaker) && Array.isArray(summary.breaker.abandoned)) summary.breaker.abandoned.map(pairKeyOf).filter(gate).forEach((k) => gateAbandoned.add(k));
	const matched = isRow(summary?.matched) ? summary.matched : {};
	const sessions = isRow(matched.sessions) ? matched.sessions : {};
	const matchedAbandoned = [...(Array.isArray(sessions.abandoned) ? sessions.abandoned : []), ...(Array.isArray(sessions.resumeAbandoned) ? sessions.resumeAbandoned : [])].map(pairKeyOf).filter(gate);
	const invalidUnions = new Map<string, string[]>();
	for (const u of Array.isArray(matched.unions) ? (matched.unions as unknown[]).filter(isRow) : []) {
		if (u.valid !== true) invalidUnions.set(`${String(u.target)}#${String(u.pass)}`, Array.isArray(u.reasons) ? u.reasons.map(String) : []);
	}
	const cells = latestExpectedCells(dir, manifest);
	const expected = Array.isArray(cells)
		? [...new Set((cells as unknown[]).filter(isRow).map((c) => `${String(c.target)}#${String(c.pass)}`).filter(gate))].sort(byCodePoint)
		: [];
	return { dir, notReady, gateAbandoned: [...gateAbandoned].sort(byCodePoint), matchedAbandoned: [...new Set(matchedAbandoned)].sort(byCodePoint), harnessExcluded, expected, invalidUnions };
}

// --- Rows and claims -----------------------------------------------------------------

/** The ledgers a row was read from: its cell, or a matched union's sessions. */
const runDirs = (r: RescoreRow): string[] => (r.sessions ?? [r.cell]).map((cell) => join(r.grid, "runs", cell));

/** One claim as precision and the worksheet enumerate it: a finding's citation, by its start line. */
export interface ClaimEntry { key: string; file: string; line: number; tiers: ClaimTier[]; text: { title?: string; description?: string; cwe?: string; vulnClass?: string } }

/**
 * Every claim of a row, every tier, refuted rows included: the one enumeration
 * the precision rule and the adjudication worksheet share, so a label always
 * names a claim precision counts. The key is `file:line` at the citation's start,
 * as the pinned scorer dedupes.
 */
export function enumerateClaims(row: RescoreRow): ClaimEntry[] {
	return runDirs(row).flatMap((dir) => {
		const texts = ledgerFindingTexts(dir);
		return ledgerFindingRows(dir).flatMap((f, i) => {
			const t = texts[i] ?? {};
			const text = { ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), ...(f.cwe ? { cwe: f.cwe } : {}), ...(f.vulnClass ? { vulnClass: f.vulnClass } : {}) };
			return f.citations.map((c) => ({ key: `${c.file}:${c.lo}`, file: c.file, line: c.lo, tiers: tiersOf(f.status, f.independent), text }));
		});
	});
}

interface Scored {
	rows: RescoreRow[];
	truths: Map<string, Truth[]>;
	neutral: Map<string, Region[]>;
	twinIds: Set<string>;
	/** Every current valid run.json. */
	runs: Row[];
}

function scoreGrids(gridDirs: string[]): Scored {
	const out: Scored = { rows: [], truths: new Map(), neutral: new Map(), twinIds: new Set(), runs: [] };
	for (const dir of gridDirs) {
		const scored = rescoreGrid(dir);
		assertLocationOnlyTruth(scored.truths);
		out.rows.push(...scored.rows);
		for (const [t, ts] of scored.truths) out.truths.set(t, ts);
		const manifest = readJson(join(dir, "manifest.json")) as { targets: Array<{ id: string; name: string }>; inputs: { truth: string } };
		for (const t of manifest.targets) out.neutral.set(t.id, loadRegions(join(manifest.inputs.truth, `${t.name}.neutral.json`)));
		for (const id of twinIdsFromManifests([join(dir, "manifest.json")], (p) => readFileSync(p, "utf8"))) out.twinIds.add(id);
		const runs = readdirSync(join(dir, "runs")).flatMap((cell) => existsSync(join(dir, "runs", cell, "run.json")) ? [readJson(join(dir, "runs", cell, "run.json"))] : []);
		out.runs.push(...currentRuns(runs));
	}
	return out;
}

const isTwinRow = (r: RescoreRow, twinIds: ReadonlySet<string>) => twinIds.has(r.target) || r.control !== undefined;

// --- Rule 1 ---------------------------------------------------------------------------

export interface DiffInterval { level: string; pairs: number; targets: number; mean: number; lo: number; hi: number }
export interface Rule1 extends DiffInterval { nonInferior: boolean; superior: boolean }

function diffInterval(records: RunRecord[], level: string, arms: ArmPair): DiffInterval {
	const pairs = pairRuns(records, level, arms);
	const boot = clusterBootstrap(diffsByTarget(pairs), RULES.iterations, RULES.seed);
	return { level, pairs: pairs.length, targets: new Set(pairs.map((p) => p.target)).size, mean: boot.mean, lo: boot.lo, hi: boot.hi };
}

export function rule1(records: RunRecord[], arms: ArmPair): Rule1 {
	const d = diffInterval(records, OFFICIAL_LEVEL, arms);
	return { ...d, nonInferior: d.pairs > 0 && d.lo > RULES.margin, superior: d.pairs > 0 && d.lo > 0 };
}

/** Advisory records with the class level added; label records with its labels. */
function withClass(rows: RescoreRow[], labels: boolean): RunRecord[] {
	return toRecords(rows, labels ? "matched" : "advisoriesMatched").map((rec, i) => ({ ...rec, matched: { ...rec.matched, [CLASS_LEVEL]: labels ? rows[i]!.classAnyOf.labels : rows[i]!.classAnyOf.advisories } }));
}

// --- Rule 2 ---------------------------------------------------------------------------

export const RUBRIC = ["valid", "valid-mislocated", "not-security", "guarded", "wrong", "unverifiable"] as const;
export type RubricLabel = (typeof RUBRIC)[number];

/** `{ "<target>|<file>:<line>": { label, issue } }`, as `join` writes it. */
export type Labels = Map<string, { label: RubricLabel; issue: string }>;

/**
 * Adjudication labels. A bare label string is accepted as its own issue. Refused:
 * a label outside the rubric, one issue carrying two labels (the judge labels
 * issues, so that is a join error), and, given the worksheet's keys, a key the
 * worksheet never listed (a label for a claim no arm made).
 */
export function parseLabels(raw: unknown, worksheetKeys?: ReadonlySet<string>): Labels {
	if (!isRow(raw)) throw new Error("adjudication labels: expected a JSON object mapping claim keys to labels");
	const out: Labels = new Map();
	const issueLabel = new Map<string, RubricLabel>();
	for (const [key, v] of Object.entries(raw)) {
		const label = isRow(v) ? v.label : v;
		if (!RUBRIC.includes(label as RubricLabel)) throw new Error(`adjudication labels: "${key}" has label ${JSON.stringify(label)}, not one of ${RUBRIC.join(", ")}`);
		if (worksheetKeys && !worksheetKeys.has(key)) throw new Error(`adjudication labels: "${key}" is not a claim of the worksheet`);
		const issue = isRow(v) && typeof v.issue === "string" ? v.issue : key;
		const held = issueLabel.get(issue);
		if (held !== undefined && held !== label) throw new Error(`adjudication labels: issue "${issue}" carries two labels (${held}, ${String(label)})`);
		issueLabel.set(issue, label as RubricLabel);
		out.set(key, { label: label as RubricLabel, issue });
	}
	return out;
}

export interface TierCounts { valid: number; validLoose: number; issues: number; unlabelled: number; tp: number; fp: number; neutral: number }
const ZERO: TierCounts = { valid: 0, validLoose: 0, issues: 0, unlabelled: 0, tp: 0, fp: 0, neutral: 0 };
const addCounts = (a: TierCounts, b: TierCounts): TierCounts => ({ valid: a.valid + b.valid, validLoose: a.validLoose + b.validLoose, issues: a.issues + b.issues, unlabelled: a.unlabelled + b.unlabelled, tp: a.tp + b.tp, fp: a.fp + b.fp, neutral: a.neutral + b.neutral });

/**
 * One arm on one target, one tier: the unique claims across its runs, as the
 * key scores them (neutral set aside) and as the judge's issues, each issue
 * once however many runs or rows claimed it.
 */
export function armTargetCounts(target: string, claims: readonly ClaimEntry[], tier: ClaimTier, truth: Truth[], neutral: Region[], labels?: Labels): TierCounts {
	const unique = [...new Map(claims.filter((c) => c.tiers.includes(tier)).map((c) => [c.key, c])).values()];
	const key = claimOutcomes(unique.map((c) => ({ file: c.file, line: c.line })), truth, neutral);
	const issues = new Map<string, RubricLabel>();
	let unlabelled = 0;
	for (const c of unique) {
		const l = labels?.get(`${target}|${c.key}`);
		if (l) issues.set(l.issue, l.label);
		else unlabelled++;
	}
	const ls = [...issues.values()];
	return { valid: ls.filter((l) => l === "valid").length, validLoose: ls.filter((l) => l === "valid" || l === "valid-mislocated").length, issues: issues.size, unlabelled, ...key };
}

export interface TierPrecision {
	tier: ClaimTier;
	status: "adjudicated" | "pending adjudication";
	subject: number | null;
	reference: number | null;
	/** subject ÷ reference, and its 95% app-clustered bootstrap interval. */
	ratio: number | null;
	ratioLo: number | null;
	ratioHi: number | null;
	/** With `valid-mislocated` counted valid (eval/adjudication.md). Reported only. */
	loose: { subject: number | null; reference: number | null };
	claimedIssues: { subject: number; reference: number };
	unlabelledClaims: number;
	/** The key's precision over non-neutral claims: provisional, never used to pass. */
	provisional: { subject: number | null; reference: number | null; ratio: number | null };
}
export interface Rule2 extends TierPrecision { pass: boolean | null }

const share = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const ratioOf = (s: number | null, r: number | null): number | null => (s === null || r === null || r === 0 ? null : s / r);

/** One tier's precision from per-target units (one per target: the subject's and the reference's counts). */
export function tierPrecision(tier: ClaimTier, units: Map<string, Array<{ s: TierCounts; r: TierCounts }>>, adjudicated: boolean): TierPrecision {
	const all = [...units.values()].flat();
	const s = all.reduce((a, u) => addCounts(a, u.s), ZERO);
	const r = all.reduce((a, u) => addCounts(a, u.r), ZERO);
	const provisional = { subject: share(s.tp, s.tp + s.fp), reference: share(r.tp, r.tp + r.fp) };
	const unlabelledClaims = s.unlabelled + r.unlabelled;
	const base = { tier, claimedIssues: { subject: s.issues, reference: r.issues }, unlabelledClaims, provisional: { ...provisional, ratio: ratioOf(provisional.subject, provisional.reference) } };
	if (!adjudicated || unlabelledClaims > 0) {
		return { ...base, status: "pending adjudication", subject: null, reference: null, ratio: null, ratioLo: null, ratioHi: null, loose: { subject: null, reference: null } };
	}
	const boot = clusterBootstrapStatistic(units, (xs) => {
		const t = xs.reduce((a, u) => ({ sv: a.sv + u.s.valid, si: a.si + u.s.issues, rv: a.rv + u.r.valid, ri: a.ri + u.r.issues }), { sv: 0, si: 0, rv: 0, ri: 0 });
		return t.sv / t.si / (t.rv / t.ri);
	}, RULES.iterations, RULES.seed);
	const subject = share(s.valid, s.issues);
	const reference = share(r.valid, r.issues);
	return {
		...base, status: "adjudicated", subject, reference, ratio: ratioOf(subject, reference),
		ratioLo: Number.isFinite(boot.lo) ? boot.lo : null, ratioHi: Number.isFinite(boot.hi) ? boot.hi : null,
		loose: { subject: share(s.validLoose, s.issues), reference: share(r.validLoose, r.issues) },
	};
}

export function rule2(presented: TierPrecision): Rule2 {
	// Written as a product so a comparator at zero precision cannot divide by it.
	const pass = presented.status === "pending adjudication" ? null : (presented.subject ?? 0) >= RULES.precisionRatio * (presented.reference ?? 0);
	return { ...presented, pass };
}

// --- Rule 3 ---------------------------------------------------------------------------

/**
 * The gate's token metric for one row, as the harness reads it
 * (metricFromRecord, "gate"): run.json `totalTokensWithRetryEstimate` — metered
 * tokens plus the lower-bound estimate for failed attempts pi retried that
 * reported no usage — falling back to `totalTokens` on a grid without a retry
 * policy. A matched union's `tokens` is already the sum of its sessions' gate
 * metric (summary.json's matched unions).
 */
export function gateTokens(row: RescoreRow): number {
	if (row.sessions) return row.tokens;
	return metricFromRecord(readJson(join(row.grid, "runs", row.cell, "run.json")) as never, "gate").totalTokens;
}

export interface Rule3 { pairs: number; missingTokens: number; median: number; lo: number; hi: number; bound: number; relaxed: boolean; pass: boolean | null; pooledRatio: number | null }

export function rule3(logRatios: Map<string, number[]>, missingTokens: number, superior: boolean, pooled: { subject: number; reference: number }): Rule3 {
	const boot = clusterBootstrapStatistic(logRatios, median, RULES.iterations, RULES.seed);
	const bound = superior ? RULES.costIfSuperior : RULES.cost;
	const pairs = [...logRatios.values()].flat().length;
	return {
		pairs, missingTokens, median: boot.value, lo: boot.lo, hi: boot.hi, bound, relaxed: superior,
		// A pair without a token count leaves the rule undecided, not failed.
		pass: missingTokens > 0 || pairs === 0 ? null : boot.hi <= bound,
		pooledRatio: pooled.reference > 0 ? pooled.subject / pooled.reference : null,
	};
}

// --- Reported, never deciding --------------------------------------------------------

export interface ArmStopping { runs: number; offeredToContinue: number; offeredRate: number | null; unclassified: number; medianTimeShare: number | null; leftWithOpenWork: number; judged: number; leftWithOpenWorkShare: number | null }
export interface Stopping {
	arms: Partial<Record<ArmLetter, ArmStopping>>;
	/** Subject − reference. */
	delta: { offeredRate: number | null; leftWithOpenWorkShare: number | null; medianTimeShare: number | null };
	/** The open-work share moves with the text-test rate (same sign, not zero). */
	sameDirection: boolean | null;
	/**
	 * 3.2's stopping condition: the offered rate falls, the share of runs left
	 * with time and open work falls, and the median time share does not fall. A
	 * settle wording that only changes how a closing reads moves the first alone.
	 */
	passesStopping: boolean | null;
}

export function stopping(rows: StopRow[], ref: ArmLetter, sub: ArmLetter): Stopping {
	const summary = summarizeStops(rows).valid;
	const arms: Stopping["arms"] = {};
	for (const arm of [ref, sub]) {
		const c = summary.runs[arm];
		const st = summary.stopping[arm];
		const classified = c ? c.error + c.budget + c["turn-cap"] + c["offered-to-continue"] + c.finished : 0;
		arms[arm] = {
			runs: classified + (c?.unclassified ?? 0), offeredToContinue: c?.["offered-to-continue"] ?? 0, offeredRate: c ? share(c["offered-to-continue"], classified) : null, unclassified: c?.unclassified ?? 0,
			medianTimeShare: st?.medianTimeShare ?? null, leftWithOpenWork: st?.leftWithOpenWork ?? 0, judged: st?.judged ?? 0, leftWithOpenWorkShare: st ? share(st.leftWithOpenWork, st.judged) : null,
		};
	}
	const d = (k: "offeredRate" | "leftWithOpenWorkShare" | "medianTimeShare"): number | null => (arms[sub]![k] === null || arms[ref]![k] === null ? null : arms[sub]![k]! - arms[ref]![k]!);
	const delta = { offeredRate: d("offeredRate"), leftWithOpenWorkShare: d("leftWithOpenWorkShare"), medianTimeShare: d("medianTimeShare") };
	const known = delta.offeredRate !== null && delta.leftWithOpenWorkShare !== null;
	return {
		arms, delta,
		sameDirection: known ? Math.sign(delta.offeredRate!) !== 0 && Math.sign(delta.offeredRate!) === Math.sign(delta.leftWithOpenWorkShare!) : null,
		passesStopping: known && delta.medianTimeShare !== null ? delta.offeredRate! < 0 && delta.leftWithOpenWorkShare! < 0 && delta.medianTimeShare >= 0 : null,
	};
}

export interface TwinArm { runs: number; hitsNearFixedRegions: number; claims: number; meanClaimsPerKloc: number | null }

export function twinScores(rows: RescoreRow[], letterOf: (arm: string) => ArmLetter | undefined): Partial<Record<ArmLetter, TwinArm>> {
	const out: Partial<Record<ArmLetter, TwinArm>> = {};
	const perKloc: Partial<Record<ArmLetter, number[]>> = {};
	for (const r of rows) {
		const arm = letterOf(r.arm);
		if (!arm || !r.control) continue;
		const t = (out[arm] ??= { runs: 0, hitsNearFixedRegions: 0, claims: 0, meanClaimsPerKloc: null });
		t.runs++;
		t.hitsNearFixedRegions += r.control.hits;
		t.claims += r.control.claims;
		if (r.control.perKloc !== null) (perKloc[arm] ??= []).push(r.control.perKloc);
	}
	for (const [arm, xs] of Object.entries(perKloc) as Array<[ArmLetter, number[]]>) out[arm]!.meanClaimsPerKloc = xs.reduce((a, b) => a + b, 0) / xs.length;
	return out;
}

export interface VerifierArm {
	/** Rows ever refuted, and the labels they matched at line±3: rejected true positives. */
	refutedRows: number;
	rejectedLabels: number;
	/** Rejected labels over all labels the arm matched at line±3. */
	rejectedShare: number | null;
	verifications: number;
	downgraded: number;
	onQuotes: number;
	downgradeRate: number | null;
	quoteDowngradeRate: number | null;
}

/** The verifier's numbers over an arm's paired rows, from rescore's everRefuted slice and verdict counts. */
export function verifierMetrics(rows: RescoreRow[]): VerifierArm {
	const sum = (f: (r: RescoreRow) => number) => rows.reduce((n, r) => n + f(r), 0);
	const rejectedLabels = sum((r) => r.everRefuted.matched["line±3"].length);
	const verifications = sum((r) => r.verdicts.verifications);
	const downgraded = sum((r) => r.verdicts.downgraded);
	const onQuotes = sum((r) => r.verdicts.onQuotes);
	return {
		refutedRows: sum((r) => r.everRefuted.claims), rejectedLabels, rejectedShare: share(rejectedLabels, sum((r) => r.matched["line±3"].length)),
		verifications, downgraded, onQuotes, downgradeRate: share(downgraded, verifications), quoteDowngradeRate: share(onQuotes, verifications),
	};
}

/** Dollars as pi recorded them (run.json `usage.costUsd`); null when any run of the arm has none. */
export function dollars(rows: RescoreRow[]): { usd: number | null; runs: number; unrecorded: number } {
	let usd = 0;
	let runs = 0;
	let unrecorded = 0;
	for (const r of rows) for (const dir of runDirs(r)) {
		runs++;
		const path = join(dir, "run.json");
		const cost = existsSync(path) ? (readJson(path).usage as Row | undefined)?.costUsd : undefined;
		if (typeof cost === "number" && Number.isFinite(cost)) usd += cost;
		else unrecorded++;
	}
	return { usd: unrecorded ? null : usd, runs, unrecorded };
}

/**
 * How many of an arm's paired runs the v6 validity policy kept that the v5
 * rules would have dropped: runs that reached the run limit (scored on their
 * ledger at the deadline) and fast empty runs (valid, zero findings). Both are
 * the model's behaviour, and the arm that works longer or quits sooner has
 * more of them, so they are counted per arm beside the rules. Reported, never
 * deciding. A matched union counts each of its sessions.
 */
export interface ValidityCounts {
	runs: number; reachedLimit: number; fastEmpty: number;
	/** Runs stopped at the limit with a worker in flight: their tokens count that worker's completed replies only. */
	tokensLowerBound: number;
	/**
	 * Runs, at any attempt, silent more than 30 minutes before the limit: stalled
	 * infrastructure the harness re-ran, so none is paired. Counted per arm
	 * because a hang may follow one arm's behaviour.
	 */
	stalled?: number;
}

const runJsons = (r: RescoreRow): Row[] => runDirs(r).map((dir) => join(dir, "run.json")).map((path) => (existsSync(path) ? readJson(path) : {}));

/** Whether any run behind a row (a matched union's sessions included) counted its tokens as a lower bound. */
export const lowerBoundTokens = (r: RescoreRow): boolean => runJsons(r).some((run) => run.tokensLowerBound === true);

/** A row's imputed missing spend: each cut-off worker's largest completed reply, once per worker. */
export function imputedReplies(r: RescoreRow): number {
	return runJsons(r).reduce((n, run) => n + (Array.isArray(run.inFlightWorkers) ? (run.inFlightWorkers as Row[]).reduce((m, w) => m + (typeof w.largestReply === "number" ? w.largestReply : 0), 0) : 0), 0);
}

/** Every run.json of an arm in the grids, at any attempt, that the harness classed as stalled. */
export function stalledCount(gridDirs: readonly string[], arm: string): number {
	let n = 0;
	for (const dir of gridDirs) for (const cell of existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")) : []) {
		const path = join(dir, "runs", cell, "run.json");
		if (!existsSync(path)) continue;
		const run = readJson(path);
		if (run.arm === arm && run.stalled === true) n++;
	}
	return n;
}

export function validityCounts(rows: RescoreRow[]): ValidityCounts {
	const out: ValidityCounts = { runs: 0, reachedLimit: 0, fastEmpty: 0, tokensLowerBound: 0 };
	for (const r of rows) for (const run of runJsons(r)) {
		out.runs++;
		if (run.reachedLimit === true) out.reachedLimit++;
		if (run.fastEmpty === true) out.fastEmpty++;
		if (run.tokensLowerBound === true) out.tokensLowerBound++;
	}
	return out;
}

// --- The decision ---------------------------------------------------------------------

export type Outcome = "not ready" | "inconclusive" | "fails" | "pending adjudication" | "passes" | "superior";

export interface PairAccount {
	expected: number;
	paired: number;
	abandoned: string[];
	excluded: Array<{ key: string; why: string }>;
	harnessExcluded: Array<{ grid: string; code: string; keys: string[] }>;
}

export interface Decision {
	comparison: ComparisonId;
	reference: { arm: ArmLetter; harnessArm: Arm };
	subject: { arm: ArmLetter; harnessArm: Arm };
	grids: string[];
	outcome: Outcome;
	reasons: string[];
	notReady: string[];
	pairs?: PairAccount;
	rule1?: Rule1;
	robustness?: { advisories: DiffInterval[]; labels: DiffInterval[] };
	/**
	 * Rule 1's estimate and interval with each target left out in turn. With 12
	 * apps and no sealed confirmation set, this is how a result carried by one
	 * app shows. Robustness only: it never decides.
	 */
	leaveOneTargetOut?: Array<DiffInterval & { left: string }>;
	rule2?: Rule2;
	/** Every reported tier: all, presented (rule 2's), suspected, confirmed. */
	precisionTiers?: TierPrecision[];
	rule3?: Rule3;
	/**
	 * Rule 3 again without the pairs where either arm's tokens are a lower bound
	 * (a worker cut off at the limit). Sensitivity only: rule 3 above includes
	 * them, and this never decides.
	 */
	rule3ExcludingLowerBound?: Rule3 & { excludedPairs: number };
	/**
	 * Rule 3 with each cut-off worker's missing reply imputed at the size of its
	 * largest completed reply: the conservative reading of a lower bound.
	 * Reported, never deciding.
	 */
	rule3ImputedInFlight?: Rule3 & { imputedRuns: number };
	mcnemar?: { b: number; c: number; p: number };
	findRates?: Array<{ advisory: string; reference: number; subject: number; n: number }>;
	stopping?: Stopping;
	twins?: Partial<Record<ArmLetter, TwinArm>>;
	verifier?: Partial<Record<ArmLetter, VerifierArm>>;
	dollars?: Partial<Record<ArmLetter, { usd: number | null; runs: number; unrecorded: number }>>;
	/** Paired runs that reached the limit, and fast empty ones, per arm (the v6 validity policy). Reported only. */
	validity?: Partial<Record<ArmLetter, ValidityCounts>>;
}

const REPORTED_TIERS: ClaimTier[] = ["all", "presented", "suspected", "confirmed"];

/** Why an expected pair has no pair: which arm is missing, or the matched union's reasons. */
function whyExcluded(key: string, grid: string, rows: RescoreRow[], arms: ArmPair, letters: [ArmLetter, ArmLetter], invalidUnions: Map<string, string[]>): string {
	const target = key.replace(/#\d+$/, "");
	const pass = Number(key.replace(/^.*#/, ""));
	const out: string[] = [];
	arms.forEach((arm, i) => {
		if (rows.some((r) => r.grid === grid && r.target === target && r.pass === pass && r.arm === arm)) return;
		const union = arm === "matched" ? invalidUnions.get(key) : undefined;
		out.push(union ? `${letters[i]} union invalid (${union.join("; ") || "no reason given"})` : `${letters[i]} has no valid run at the pair's latest attempt`);
	});
	if (!out.length) out.push("the arms are valid at different attempts");
	return out.join("; ");
}

export function decide(comparison: ComparisonId, gridDirs: string[], labels?: Labels): Decision {
	const spec = COMPARISONS[comparison];
	const harness = HARNESS_ARMS[spec.stage];
	const arms: ArmPair = [harness[spec.reference]!, harness[spec.subject]!];
	const letters: [ArmLetter, ArmLetter] = [spec.reference, spec.subject];
	const head = { comparison, reference: { arm: spec.reference, harnessArm: arms[0] }, subject: { arm: spec.subject, harnessArm: arms[1] }, grids: gridDirs };
	const states = gridDirs.map((d) => gridState(d, spec.stage));
	const notReady = states.flatMap((s) => s.notReady.map((w) => `${s.dir}: ${w}`));
	if (notReady.length) return { ...head, outcome: "not ready", reasons: ["not ready: nothing is computed until every grid is ready"], notReady };

	const letterOf = (arm: string): ArmLetter | undefined => (Object.entries(harness) as Array<[ArmLetter, Arm]>).find(([, a]) => a === arm)?.[0];
	const scored = scoreGrids(gridDirs);
	const { twinIds } = scored;
	const keptRows = scored.rows.filter((r) => !isTwinRow(r, twinIds));
	const kept = dropTwins(toRecords(keptRows), twinIds).kept;

	// Pairs, expected pairs and what became of the rest (review, major 3).
	const pairs = pairRuns(kept, OFFICIAL_LEVEL, arms);
	const pairedKeys = new Set(pairs.map((p) => `${p.grid}\u0000${p.target}#${p.pass}`));
	const usesMatched = arms.includes("matched");
	const abandoned: string[] = [];
	const excluded: PairAccount["excluded"] = [];
	for (const s of states) {
		// A gate pair's abandonment counts against every comparison of the stage; a matched session's only against D vs M.
		const hit = new Set([...s.gateAbandoned, ...(usesMatched ? s.matchedAbandoned : [])]);
		for (const k of [...hit].sort(byCodePoint)) abandoned.push(`${s.dir}: ${k}`);
		for (const k of s.expected) {
			if (pairedKeys.has(`${s.dir}\u0000${k}`) || hit.has(k)) continue;
			excluded.push({ key: `${s.dir}: ${k}`, why: whyExcluded(k, s.dir, keptRows, arms, letters, s.invalidUnions) });
		}
	}
	const account: PairAccount = {
		expected: states.reduce((n, s) => n + s.expected.length, 0), paired: pairs.length, abandoned, excluded,
		harnessExcluded: states.flatMap((s) => s.harnessExcluded.map((h) => ({ grid: s.dir, ...h }))),
	};

	const r1 = rule1(kept, arms);
	const robustness = {
		advisories: [...LEVELS, CLASS_LEVEL].map((l) => diffInterval(withClass(keptRows, false), l, arms)),
		labels: [...LEVELS, CLASS_LEVEL].map((l) => diffInterval(withClass(keptRows, true), l, arms)),
	};

	const leaveOneTargetOut = [...new Set(pairs.map((p) => p.target))].sort(byCodePoint)
		.map((left) => ({ left, ...diffInterval(kept.filter((r) => r.target !== left), OFFICIAL_LEVEL, arms) }));

	const rowOf = (p: Pair, arm: Arm): RescoreRow => {
		const hit = keptRows.filter((r) => r.grid === p.grid && r.target === p.target && r.pass === p.pass && r.arm === arm && r.attempt === p.attempt);
		if (hit.length !== 1) throw new Error(`pair ${p.grid} ${p.target}#${p.pass}: expected one ${arm} row at attempt ${p.attempt}, found ${hit.length}`);
		return hit[0]!;
	};
	const pairRows = pairs.map((p) => ({ p, ref: rowOf(p, arms[0]), sub: rowOf(p, arms[1]) }));

	// Precision: one unit per target, each arm's unique claims across its paired runs there (review, major 5).
	const claimCache = new Map<RescoreRow, ClaimEntry[]>();
	const claimsOf = (rs: RescoreRow[]) => rs.flatMap((r) => {
		if (!claimCache.has(r)) claimCache.set(r, enumerateClaims(r));
		return claimCache.get(r)!;
	});
	const targets = [...new Set(pairs.map((p) => p.target))].sort(byCodePoint);
	const precisionTiers = REPORTED_TIERS.map((tier) => {
		const units = new Map(targets.map((t) => {
			const here = pairRows.filter((x) => x.p.target === t);
			const truth = scored.truths.get(t) ?? [];
			const neutral = scored.neutral.get(t) ?? [];
			return [t, [{ s: armTargetCounts(t, claimsOf(here.map((x) => x.sub)), tier, truth, neutral, labels), r: armTargetCounts(t, claimsOf(here.map((x) => x.ref)), tier, truth, neutral, labels) }]];
		}));
		return tierPrecision(tier, units, labels !== undefined);
	});
	const r2 = rule2(precisionTiers.find((t) => t.tier === "presented")!);

	// Rule 3 counts a pair whose tokens are a lower bound like any other; the
	// sensitivity row leaves those pairs out and never decides.
	const costRule = (rows: typeof pairRows, tokensOf: (r: RescoreRow) => number = gateTokens) => {
		const logRatios = new Map<string, number[]>();
		let missingTokens = 0;
		const pooled = { subject: 0, reference: 0 };
		for (const { p, ref, sub } of rows) {
			const [ts, tr] = [tokensOf(sub), tokensOf(ref)];
			if (!(Number.isFinite(ts) && Number.isFinite(tr) && ts > 0 && tr > 0)) { missingTokens++; continue; }
			pooled.subject += ts;
			pooled.reference += tr;
			logRatios.set(p.target, [...(logRatios.get(p.target) ?? []), Math.log(ts / tr)]);
		}
		return rule3(logRatios, missingTokens, r1.superior, pooled);
	};
	const r3 = costRule(pairRows);
	const exact = pairRows.filter((x) => !lowerBoundTokens(x.ref) && !lowerBoundTokens(x.sub));
	const r3Sensitivity = { ...costRule(exact), excludedPairs: pairRows.length - exact.length };
	// The conservative reading: each cut-off worker's missing reply imputed at the
	// size of its largest completed one. Reported, never deciding.
	const imputed = pairRows.reduce((n, x) => n + (lowerBoundTokens(x.ref) ? 1 : 0) + (lowerBoundTokens(x.sub) ? 1 : 0), 0);
	const r3Imputed = { ...costRule(pairRows, (r) => gateTokens(r) + imputedReplies(r)), imputedRuns: imputed };
	const stalledRuns = Object.fromEntries(letters.map((letter, i) => [letter, stalledCount(gridDirs, arms[i]!)]));

	const reasons: string[] = [];
	if (!r1.nonInferior && pairs.length) reasons.push(`rule 1 fails: the lower bound ${r1.lo.toFixed(3)} is not above ${RULES.margin}`);
	if (r3.pass === false) reasons.push(`rule 3 fails: the upper bound ${r3.hi.toFixed(3)} exceeds log(${r3.relaxed ? "1.5" : "1.10"}) = ${r3.bound.toFixed(3)}`);
	if (r2.pass === false) reasons.push(`rule 2 fails: precision ratio ${r2.ratio === null ? "n/a" : r2.ratio.toFixed(3)} is below ${RULES.precisionRatio}`);
	const inconclusive = [
		...(abandoned.length ? [`${abandoned.length} pair(s) abandoned at the attempt ceiling: the comparison is inconclusive, never passing`] : []),
		...(pairs.length === 0 ? ["no valid pairs"] : []),
		...(r3.missingTokens ? [`${r3.missingTokens} pair(s) have no token count: rule 3 cannot be decided`] : []),
	];
	let outcome: Outcome;
	if (inconclusive.length) {
		outcome = "inconclusive";
		reasons.unshift(...inconclusive);
	} else if (reasons.length) outcome = "fails";
	else if (r2.pass === null) {
		outcome = "pending adjudication";
		reasons.push(`rule 2 is pending adjudication${r2.unlabelledClaims ? ` (${r2.unlabelledClaims} presented claim(s) unlabelled)` : ""}: rules 1 and 3 hold, and the comparison cannot pass until it is judged`);
	} else {
		outcome = r1.superior ? "superior" : "passes";
		reasons.push(r1.superior ? "all three rules hold, and rule 1's lower bound is above 0" : "all three rules hold (non-inferior)");
	}

	const truthIds = new Map(targets.map((t) => [t, [...new Set((scored.truths.get(t) ?? []).map(advisoryOf))]]));
	const stopRows: StopRow[] = scored.runs.flatMap((r) => {
		const arm = letterOf(String(r.arm));
		return (arm === spec.reference || arm === spec.subject) && r.twinOf === undefined && !twinIds.has(String(r.target))
			? [{ arm, key: String(r.key ?? `${String(r.target)}#${String(r.pass)}`), valid: true, stop: r.stop }] : [];
	});
	const armRows = (side: "ref" | "sub") => pairRows.map((x) => x[side]);
	return {
		...head, outcome, reasons, notReady, pairs: account, rule1: r1, robustness, leaveOneTargetOut, rule2: r2, precisionTiers, rule3: r3, rule3ExcludingLowerBound: r3Sensitivity, rule3ImputedInFlight: r3Imputed,
		mcnemar: mcnemar(pairs, truthIds),
		findRates: [...perIssueFindRate(pairs, truthIds).entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([advisory, x]) => ({ advisory, reference: x.baseline, subject: x.candidate, n: x.n })),
		stopping: stopping(stopRows, spec.reference, spec.subject),
		twins: twinScores(scored.rows.filter((r) => isTwinRow(r, twinIds)), letterOf),
		verifier: { [spec.reference]: verifierMetrics(armRows("ref")), [spec.subject]: verifierMetrics(armRows("sub")) },
		dollars: { [spec.reference]: dollars(armRows("ref")), [spec.subject]: dollars(armRows("sub")) },
		validity: {
			[spec.reference]: { ...validityCounts(armRows("ref")), stalled: stalledRuns[spec.reference]! },
			[spec.subject]: { ...validityCounts(armRows("sub")), stalled: stalledRuns[spec.subject]! },
		},
	};
}

// --- D vs A, bridged and reported only -------------------------------------------------

export interface Bridge {
	comparison: "D-vs-A";
	outcome: "reported" | "not ready";
	notReady: string[];
	grids: { stage1: string; stage2: string };
	/** (D − S₂) + (S₁ − A) per (target, pass index), targets resampled jointly across both grids. */
	bridged?: DiffInterval;
	/** S₂ − S₁ on the same (target, pass index): the drift check. */
	drift?: DiffInterval;
	note: string;
}

/**
 * D vs A never ran as one pair, so it is estimated through S, which ran in
 * both stages: (D − S₂) + (S₁ − A), paired by target and pass index, with each
 * target's bridged values resampled as one cluster so both grids move together.
 * S₂ − S₁ sits beside it: the same snapshot run twice, so anything but noise
 * there (a provider or corpus drift between the stages) is in the bridge too.
 */
export function bridgeDvsA(stage1: string, stage2: string): Bridge {
	const note = "reported only, never deciding (pre-registration: D vs A is reported)";
	const notReady = [...gridState(stage1, "v6-stage1").notReady.map((w) => `${stage1}: ${w}`), ...gridState(stage2, "v6-stage2").notReady.map((w) => `${stage2}: ${w}`)];
	if (notReady.length) return { comparison: "D-vs-A", outcome: "not ready", notReady, grids: { stage1, stage2 }, note };
	const records = (dir: string) => {
		const s = scoreGrids([dir]);
		return dropTwins(toRecords(s.rows.filter((r) => !isTwinRow(r, s.twinIds))), s.twinIds).kept;
	};
	const one = pairRuns(records(stage1), OFFICIAL_LEVEL, ["baseline", "candidate"]);
	const two = pairRuns(records(stage2), OFFICIAL_LEVEL, ["baseline", "candidate"]);
	const key = (p: Pair) => `${p.target}#${p.pass}`;
	const byKey = new Map(one.map((p) => [key(p), p]));
	const bridged = new Map<string, number[]>();
	const drift = new Map<string, number[]>();
	for (const p2 of two) {
		const p1 = byKey.get(key(p2));
		if (!p1) continue;
		bridged.set(p2.target, [...(bridged.get(p2.target) ?? []), (p2.candidate.size - p2.baseline.size) + (p1.candidate.size - p1.baseline.size)]);
		drift.set(p2.target, [...(drift.get(p2.target) ?? []), p2.baseline.size - p1.candidate.size]);
	}
	const interval = (m: Map<string, number[]>): DiffInterval => {
		const b = clusterBootstrap(m, RULES.iterations, RULES.seed);
		return { level: OFFICIAL_LEVEL, pairs: [...m.values()].flat().length, targets: m.size, mean: b.mean, lo: b.lo, hi: b.hi };
	};
	return { comparison: "D-vs-A", outcome: "reported", notReady: [], grids: { stage1, stage2 }, bridged: interval(bridged), drift: interval(drift), note };
}

// --- The ship table ------------------------------------------------------------------

export interface ShipRow { outcome: string; action: string; status: string }

const decided = (d?: Decision): boolean => !!d && ["passes", "superior", "fails"].includes(d.outcome);
const passed = (d?: Decision): boolean | undefined => (decided(d) ? d!.outcome !== "fails" : undefined);

/**
 * The pre-registration's staging and ship decisions, filled in from whichever
 * comparisons are decided. "Delegation may become the default" needs D to pass
 * against S and against M, all three rules each; "stays opt-in" is D not
 * passing against M. They read the same D vs M outcome with opposite
 * conditions, so both can never be met.
 */
export function shipTable(decisions: readonly Decision[]): ShipRow[] {
	const by = (c: ComparisonId) => decisions.find((d) => d.comparison === c);
	const status = (met: boolean | undefined, pending: string) => (met === undefined ? pending : met ? "met" : "not met");
	const undecided = (d: Decision | undefined, name: string) => (d ? `undecided: ${name} is ${d.outcome}` : `undecided: ${name} not computed`);
	const sa = by("S-vs-A");
	const ds = by("D-vs-S");
	const dm = by("D-vs-M");
	const staged = sa?.rule1 && !["not ready", "inconclusive"].includes(sa.outcome) ? sa.rule1.nonInferior : undefined;
	const [dsPass, dmPass] = [passed(ds), passed(dm)];
	const both = dsPass === false || dmPass === false ? false : dsPass === undefined || dmPass === undefined ? undefined : true;
	const waiting = [decided(ds) ? "" : undecided(ds, "D vs S"), decided(dm) ? "" : undecided(dm, "D vs M")].filter(Boolean).join("; ");
	return [
		{ outcome: "S non-inferior to A on rule 1", action: "stage 2 runs; otherwise stage 2 does not run", status: status(staged, undecided(sa, "S vs A")) },
		{ outcome: "S passes against A", action: "Phase 3's single-agent changes can ship to `main`", status: status(passed(sa), undecided(sa, "S vs A")) },
		{ outcome: "D passes against S and D passes against M", action: "delegation may become the default again, by a new ADR citing this trial", status: status(both, waiting) },
		{ outcome: "D does not pass against M", action: "delegation stays opt-in: it adds nothing that the same tokens do not buy solo", status: status(dmPass === undefined ? undefined : !dmPass, undecided(dm, "D vs M")) },
	];
}

// --- Adjudication worksheet and labels -----------------------------------------------

/** Wording that names the orchestration, which would reveal the arm (eval/adjudication.md, "Blinding"). */
const ORCHESTRATION = /\b(?:scouts?|workers?|sub-?agents?|verifiers?|delegat\w*|lead|orchestrat\w*)\b/gi;
const blind = (s: string): string => s.replace(ORCHESTRATION, "[…]");

export interface Worksheet { target: string; seed: number; rubric: readonly string[]; claims: Array<{ id: string; file: string; line: number; statements: Array<{ title?: string; description?: string; cwe?: string; class?: string }> }> }
export interface KeyMap { seed: number; grids: string[]; targets: Record<string, Record<string, string>> }

/**
 * The blind worksheets for every target of the grids: each unique claim (the
 * enumeration precision counts, every tier, refuted rows included) with its
 * location and what the rows citing it said, shuffled under a recorded seed
 * and given blind ids. No arm, run, pass, author, status or verification; the
 * key map from blind id to claim key is written apart and kept from the judge.
 * Patched twins have no labels to be precise against and are left out.
 */
export function exportWorksheets(gridDirs: string[], seed = 1): { worksheets: Worksheet[]; keymap: KeyMap } {
	const scored = scoreGrids(gridDirs);
	const byTarget = new Map<string, Map<string, ClaimEntry[]>>();
	for (const r of scored.rows.filter((row) => !isTwinRow(row, scored.twinIds))) {
		const claims = byTarget.get(r.target) ?? new Map<string, ClaimEntry[]>();
		for (const c of enumerateClaims(r)) claims.set(c.key, [...(claims.get(c.key) ?? []), c]);
		byTarget.set(r.target, claims);
	}
	const rand = mulberry32(seed);
	const worksheets: Worksheet[] = [];
	const keymap: KeyMap = { seed, grids: gridDirs, targets: {} };
	for (const target of [...byTarget.keys()].sort(byCodePoint)) {
		const entries = [...byTarget.get(target)!.entries()].sort(([a], [b]) => byCodePoint(a, b));
		for (let i = entries.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[entries[i], entries[j]] = [entries[j]!, entries[i]!];
		}
		const map: Record<string, string> = {};
		const claims = entries.map(([key, cs], i) => {
			const id = `C${String(i + 1).padStart(3, "0")}`;
			map[id] = key;
			const statements = [...new Map(cs.map((c) => {
				const s = { ...(c.text.title ? { title: blind(c.text.title) } : {}), ...(c.text.description ? { description: blind(c.text.description) } : {}), ...(c.text.cwe ? { cwe: c.text.cwe } : {}), ...(c.text.vulnClass ? { class: c.text.vulnClass } : {}) };
				return [JSON.stringify(s), s] as const;
			})).entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([, s]) => s);
			return { id, file: cs[0]!.file, line: cs[0]!.line, statements };
		});
		worksheets.push({ target, seed, rubric: RUBRIC, claims });
		keymap.targets[target] = map;
	}
	return { worksheets, keymap };
}

/**
 * The judge's answer, `{ target: { issues: { id: { label, quotes } }, claims: { blindId: issueId } } }`,
 * joined through the key map to the labels `decide` reads. A verdict without a
 * quoted line is recorded as `unverifiable` (eval/adjudication.md, "What the
 * judge has"). A blind id the judge left out stays unlabelled, which keeps
 * rule 2 pending; one it invented, or an issue it never defined, is refused.
 */
export function joinLabels(keymap: KeyMap, judged: unknown): Record<string, { label: RubricLabel; issue: string }> {
	if (!isRow(judged)) throw new Error("judged: expected an object keyed by target");
	const out: Record<string, { label: RubricLabel; issue: string }> = {};
	for (const [target, answer] of Object.entries(judged)) {
		const map = keymap.targets[target];
		if (!map) throw new Error(`judged: target ${target} is not in the key map`);
		if (!isRow(answer) || !isRow(answer.issues) || !isRow(answer.claims)) throw new Error(`judged: ${target} needs issues and claims`);
		for (const [blindId, issueId] of Object.entries(answer.claims)) {
			const key = map[blindId];
			if (!key) throw new Error(`judged: ${target} labels ${blindId}, which the worksheet never listed`);
			const issue = answer.issues[String(issueId)];
			if (!isRow(issue)) throw new Error(`judged: ${target} assigns ${blindId} to issue ${String(issueId)}, which it never defined`);
			if (!RUBRIC.includes(issue.label as RubricLabel)) throw new Error(`judged: ${target} issue ${String(issueId)} has label ${JSON.stringify(issue.label)}`);
			const quoted = Array.isArray(issue.quotes) && issue.quotes.some((q) => typeof q === "string" && q.trim() !== "");
			out[`${target}|${key}`] = { label: quoted ? (issue.label as RubricLabel) : "unverifiable", issue: `${target}/${String(issueId)}` };
		}
	}
	return out;
}

/** The claim keys the worksheet lists: labels for anything else are refused. */
export function worksheetKeys(keymap: KeyMap): Set<string> {
	return new Set(Object.entries(keymap.targets).flatMap(([t, m]) => Object.values(m).map((k) => `${t}|${k}`)));
}

// --- Report and CLI ------------------------------------------------------------------

const f = (x: number | null | undefined, digits = 3): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(digits));
const interval = (d: DiffInterval) => `${f(d.mean)} [${f(d.lo)}, ${f(d.hi)}] over ${d.pairs} pair(s), ${d.targets} target(s)`;

export function formatDecision(d: Decision, ship: ShipRow[]): string {
	const L: string[] = [
		`v6 decision · ${d.subject.arm} vs ${d.reference.arm} (${d.subject.harnessArm} − ${d.reference.harnessArm}) · ${d.grids.join(", ")}`,
		`OUTCOME: ${d.outcome.toUpperCase()}`,
		...d.reasons.map((r) => `  ${r}`),
		...d.notReady.map((r) => `  not ready · ${r}`),
	];
	if (d.pairs) {
		const p = d.pairs;
		L.push(`pairs: ${p.paired} paired of ${p.expected} expected · ${p.abandoned.length} abandoned · ${p.excluded.length} excluded`);
		for (const a of p.abandoned) L.push(`  abandoned · ${a}`);
		for (const e of p.excluded) L.push(`  excluded · ${e.key}: ${e.why}`);
		for (const h of p.harnessExcluded) L.push(`  harness ${h.code} · ${h.grid}: ${h.keys.slice(0, 6).join("; ")}${h.keys.length > 6 ? " …" : ""}`);
	}
	if (d.rule1 && d.robustness && d.rule2 && d.rule3 && d.precisionTiers) {
		const { rule1: r1, rule2: r2, rule3: r3 } = d;
		L.push(
			"",
			`rule 1 · advisories found per pair, the pinned grader's matching (official; location-only truth): ${interval(r1)} · 95% app-clustered bootstrap, ${RULES.iterations} resamples, seed ${RULES.seed}`,
			`  non-inferior (lo > ${RULES.margin}): ${r1.nonInferior ? "yes" : "no"} · superior (lo > 0): ${r1.superior ? "yes" : "no"}${d.mcnemar ? ` · McNemar over advisories b=${d.mcnemar.b} c=${d.mcnemar.c} p=${f(d.mcnemar.p, 4)}` : ""}`,
			"  robustness, never deciding:",
			...d.robustness.advisories.map((x) => `    advisories ${x.level}: ${interval(x)}`),
			...d.robustness.labels.map((x) => `    labelled locations ${x.level}: ${interval(x)}`),
			...(d.leaveOneTargetOut?.length ? [`  leave one target out (robustness, never deciding; lo > ${RULES.margin} in ${d.leaveOneTargetOut.filter((x) => x.lo > RULES.margin).length} of ${d.leaveOneTargetOut.length}):`] : []),
			...(d.leaveOneTargetOut ?? []).map((x) => `    without ${x.left}: ${interval(x)}`),
			"",
			r2.status === "adjudicated"
				? `rule 2 · adjudicated precision, presented tier, unique issues per arm and target: ${d.subject.arm} ${f(r2.subject)} vs ${d.reference.arm} ${f(r2.reference)} · ratio ${f(r2.ratio)} [${f(r2.ratioLo)}, ${f(r2.ratioHi)}] · needs ≥ ${RULES.precisionRatio}: ${r2.pass ? "yes" : "no"}`
				: `rule 2 · PENDING ADJUDICATION${r2.unlabelledClaims ? ` (${r2.unlabelledClaims} presented claim(s) unlabelled)` : ""}`,
			...d.precisionTiers.map((t) => `  ${t.tier}: ${t.status === "adjudicated" ? `adjudicated ${f(t.subject)} vs ${f(t.reference)} (ratio ${f(t.ratio)} [${f(t.ratioLo)}, ${f(t.ratioHi)}]; with valid-mislocated ${f(t.loose.subject)} vs ${f(t.loose.reference)})` : "pending adjudication"} · provisional, key-based, never used to pass: ${f(t.provisional.subject)} vs ${f(t.provisional.reference)}`),
			"",
			`rule 3 · median per-pair log ratio of gate tokens (totalTokensWithRetryEstimate): ${f(r3.median, 4)} [${f(r3.lo, 4)}, ${f(r3.hi, 4)}] over ${r3.pairs} pair(s) · upper bound ≤ log(${r3.relaxed ? "1.5, relaxed by superiority" : "1.10"}) = ${f(r3.bound, 4)}: ${r3.pass === null ? "undecided" : r3.pass ? "yes" : "no"}${r3.missingTokens ? ` · ${r3.missingTokens} pair(s) without tokens` : ""}`,
			`  pooled token ratio (reported, not deciding): ${f(r3.pooledRatio)}`,
			...(d.rule3ExcludingLowerBound ? [(() => {
				const x = d.rule3ExcludingLowerBound;
				return `  without the ${x.excludedPairs} pair(s) whose tokens are a lower bound (sensitivity, never deciding): ${f(x.median, 4)} [${f(x.lo, 4)}, ${f(x.hi, 4)}] over ${x.pairs} pair(s): ${x.pass === null ? "undecided" : x.pass ? "yes" : "no"}`;
			})()] : []),
			...(d.rule3ImputedInFlight ? [(() => {
				const x = d.rule3ImputedInFlight;
				return `  with each cut-off worker's missing reply imputed at its largest completed reply, over ${x.imputedRuns} run(s) (conservative, never deciding): ${f(x.median, 4)} [${f(x.lo, 4)}, ${f(x.hi, 4)}] over ${x.pairs} pair(s): ${x.pass === null ? "undecided" : x.pass ? "yes" : "no"}`;
			})()] : []),
		);
	}
	if (d.stopping) {
		const s = d.stopping;
		L.push("", "stopping (reported; 3.2's condition):");
		for (const [arm, a] of Object.entries(s.arms)) L.push(`  ${arm}: offered to continue (text test) ${a.offeredToContinue}/${a.runs - a.unclassified} = ${f(a.offeredRate)} · median time share ${f(a.medianTimeShare)} · stopped with time left and open work ${a.leftWithOpenWork}/${a.judged} = ${f(a.leftWithOpenWorkShare)}${a.unclassified ? ` · ${a.unclassified} unclassified` : ""}`);
		L.push(`  Δ ${d.subject.arm} − ${d.reference.arm}: offered ${f(s.delta.offeredRate)} · open-work share ${f(s.delta.leftWithOpenWorkShare)} · time share ${f(s.delta.medianTimeShare)} · same direction: ${s.sameDirection === null ? "n/a" : s.sameDirection ? "yes" : "no"} · 3.2 passes on stopping: ${s.passesStopping === null ? "n/a" : s.passesStopping ? "yes" : "no"}`);
	}
	if (d.verifier) {
		L.push("", "verifier (reported):");
		for (const [arm, v] of Object.entries(d.verifier)) L.push(`  ${arm}: ${v.refutedRows} refuted row(s) matching ${v.rejectedLabels} label(s) (${f(v.rejectedShare)} of its line±3 labels) · ${v.verifications} verification(s), downgraded ${f(v.downgradeRate)}, on quotes ${f(v.quoteDowngradeRate)}`);
	}
	if (d.validity) {
		L.push("", "run validity (reported; the v6 policy keeps these runs valid, never deciding):");
		for (const [arm, x] of Object.entries(d.validity)) L.push(`  ${arm}: ${x.reachedLimit} of ${x.runs} paired run(s) reached the run limit (scored on the ledger at the deadline); ${x.fastEmpty} ended fast and empty; ${x.tokensLowerBound} counted tokens as a lower bound (a worker cut off at the limit)${x.stalled ? `; ${x.stalled} run(s) stalled before the limit and were re-run as infrastructure` : ""}`);
	}
	if (d.dollars) {
		L.push("", "dollars (reported; pi's usage.costUsd):");
		for (const [arm, x] of Object.entries(d.dollars)) L.push(`  ${arm}: ${x.usd === null ? `not recorded (${x.unrecorded} of ${x.runs} run(s) without a cost)` : `$${x.usd.toFixed(2)} over ${x.runs} run(s)`}`);
	}
	if (d.twins) {
		L.push("", "patched twins (reported, never in precision):");
		const arms = Object.entries(d.twins);
		if (!arms.length) L.push("  none in these arms");
		for (const [arm, t] of arms) L.push(`  ${arm}: ${t.hitsNearFixedRegions} claim(s) within ±3 of a fixed region · ${t.claims} claim(s) over ${t.runs} run(s) · ${f(t.meanClaimsPerKloc)} claims/KLOC`);
	}
	if (d.findRates?.length) {
		L.push("", `per-advisory find rate (${d.reference.arm} / ${d.subject.arm} / pairs):`);
		for (const r of d.findRates) L.push(`  ${r.advisory}\t${r.reference}\t${r.subject}\t${r.n}`);
	}
	L.push("", "ship decisions (pre-registration):");
	for (const r of ship) L.push(`  [${r.status}] ${r.outcome} → ${r.action}`);
	return L.join("\n");
}

export function formatBridge(b: Bridge): string {
	if (!b.bridged || !b.drift) return [`v6 · D vs A (bridged) · ${b.outcome.toUpperCase()}`, ...b.notReady.map((r) => `  not ready · ${r}`)].join("\n");
	return [
		`v6 · D vs A, bridged through S · ${b.note}`,
		`  (D − S₂) + (S₁ − A), advisories per pair: ${interval(b.bridged)}`,
		`  drift S₂ − S₁ (the same snapshot in both stages): ${interval(b.drift)}`,
	].join("\n");
}

const USAGE = `Usage:
  v6-decision.ts --comparison S-vs-A|D-vs-S|D-vs-M --grid <dir> [--grid <dir>]... [--labels <labels.json> --keymap <keymap.json>] [--with <decision.json>]... [--out <prefix>]
  v6-decision.ts --comparison D-vs-A --grid <stage-1 dir> --grid <stage-2 dir> [--out <prefix>]
  v6-decision.ts export --grid <dir>... [--seed 1] --out <dir>      (worksheets/<target>.json for the judge; keymap.json kept from it)
  v6-decision.ts join --keymap <keymap.json> --judged <judged.json> --out <labels.json>
`;

interface IO { readFile: (p: string) => string; write: (p: string, text: string) => void }

export function cli(argv: readonly string[], io: IO): { code: number; out: string } {
	const mode = argv[0] === "export" || argv[0] === "join" ? argv[0] : "decide";
	const args = mode === "decide" ? argv : argv.slice(1);
	const one: Record<string, string> = {};
	const grids: string[] = [];
	const others: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const next = args[++i] ?? "";
		if (a === "--grid") grids.push(next);
		else if (a === "--with") others.push(next);
		else if (["--comparison", "--labels", "--keymap", "--judged", "--out", "--seed"].includes(a)) one[a.slice(2)] = next;
		else return { code: 2, out: `unknown argument ${a}\n${USAGE}` };
	}
	if (mode === "export") {
		if (!grids.length || !one.out) return { code: 2, out: USAGE };
		const { worksheets, keymap } = exportWorksheets(grids, one.seed ? Number(one.seed) : 1);
		for (const w of worksheets) io.write(join(one.out, "worksheets", `${w.target}.json`), `${JSON.stringify(w, null, 2)}\n`);
		io.write(join(one.out, "keymap.json"), `${JSON.stringify(keymap, null, 2)}\n`);
		return { code: 0, out: `wrote ${worksheets.length} worksheet(s), ${worksheets.reduce((n, w) => n + w.claims.length, 0)} claim(s), to ${join(one.out, "worksheets")}; keep ${join(one.out, "keymap.json")} from the judge\n` };
	}
	if (mode === "join") {
		if (!one.keymap || !one.judged || !one.out) return { code: 2, out: USAGE };
		const labels = joinLabels(JSON.parse(io.readFile(one.keymap)) as KeyMap, JSON.parse(io.readFile(one.judged)));
		io.write(one.out, `${JSON.stringify(labels, null, 2)}\n`);
		return { code: 0, out: `wrote ${Object.keys(labels).length} label(s) to ${one.out}\n` };
	}
	const comparison = one.comparison;
	if (comparison === "D-vs-A") {
		if (grids.length !== 2) return { code: 2, out: USAGE };
		const [s1, s2] = readJson(join(grids[0]!, "manifest.json")).gridKind === "v6-stage1" ? [grids[0]!, grids[1]!] : [grids[1]!, grids[0]!];
		const bridge = bridgeDvsA(s1, s2);
		const text = formatBridge(bridge);
		const prefix = one.out ?? join(s2, "v6-decision-D-vs-A");
		io.write(`${prefix}.json`, `${JSON.stringify(bridge, null, 2)}\n`);
		io.write(`${prefix}.txt`, `${text}\n`);
		return { code: bridge.outcome === "not ready" ? 1 : 0, out: `${text}\n` };
	}
	if (!comparison || !(comparison in COMPARISONS) || !grids.length) return { code: 2, out: USAGE };
	if (one.labels && !one.keymap) return { code: 2, out: `--labels needs --keymap: a label is accepted only for a claim the worksheet listed\n${USAGE}` };
	const labels = one.labels ? parseLabels(JSON.parse(io.readFile(one.labels)), worksheetKeys(JSON.parse(io.readFile(one.keymap!)) as KeyMap)) : undefined;
	const decision = decide(comparison as ComparisonId, grids, labels);
	const ship = shipTable([decision, ...others.map((p) => JSON.parse(io.readFile(p)) as Decision).filter((d) => d.comparison !== decision.comparison && d.comparison in COMPARISONS)]);
	const text = formatDecision(decision, ship);
	const prefix = one.out ?? join(grids[0]!, `v6-decision-${comparison}`);
	io.write(`${prefix}.json`, `${JSON.stringify({ ...decision, ship }, null, 2)}\n`);
	io.write(`${prefix}.txt`, `${text}\n`);
	return { code: decision.outcome === "not ready" ? 1 : 0, out: `${text}\n` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const write = (p: string, t: string) => { mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p, t); };
		const { code, out } = cli(process.argv.slice(2), { readFile: (p) => readFileSync(p, "utf8"), write });
		(code === 2 ? process.stderr : process.stdout).write(out);
		process.exitCode = code;
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
