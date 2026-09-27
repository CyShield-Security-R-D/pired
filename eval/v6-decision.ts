#!/usr/bin/env -S node --experimental-strip-types
/**
 * The pre-registered decision of the delegation v6 trial, for one comparison
 * (docs/delegation-v6-preregistration.md, "Decision rule" and "Analysis plan").
 *
 * - S vs A: stage 1, A (`main`, the incumbent) is the harness's `baseline`, S
 *   (the candidate solo) its `candidate`.
 * - D vs S and D vs M: stage 2, S is the `baseline`, D (the candidate
 *   delegating) the `candidate`, M (matched compute) the `matched` union.
 *
 * Every difference is subject − reference: S − A, D − S, D − M.
 *
 * A comparison passes when all three rules hold:
 *
 * 1. True positives: the 95% app-clustered bootstrap interval (10,000
 *    resamples, seed 1, targets as clusters) on the mean per-pair difference in
 *    advisories found at the official rule has its lower bound above −0.3
 *    (non-inferior); above 0 it is superior. The same at every other rescore
 *    level, and unique labelled locations at every level, are reported as
 *    robustness and never decide.
 * 2. Precision: the adjudicated precision of the presented tier is at least
 *    0.85 of the comparator's, the ratio's bootstrap bound beside it. Without
 *    adjudication labels the rule is pending, and the comparison cannot pass;
 *    the key's precision over non-neutral claims is shown as a provisional
 *    indicator only. The key labels only known CVEs, so an arm that reports
 *    more real issues the key does not list would read as less precise: that
 *    is why the rule is adjudicated (eval/adjudication.md).
 * 3. Cost: the upper bound of the same interval on the median per-pair log
 *    ratio of the gate's token metric is at most log(1.10), or log(1.5) when
 *    rule 1 shows superiority. The median, because pooled sums swung from 0.51
 *    to 2.86 on single Luna runs; the pooled ratio is reported beside it.
 *
 * A pair abandoned at the attempt ceiling makes the comparison inconclusive,
 * never passing: a pair the grid could not run is not a pair either arm won. A
 * grid whose pass count was not fixed by its amendment is not ready, and then
 * nothing is computed: a stage-1 grid before its amendment is the blind pilot,
 * and printing the comparison would unblind it (eval/v6-pilot-sd.ts reads it
 * blind).
 *
 * Reported and never deciding: stopping (3.2's offered-to-continue rate by the
 * ADR-030 text test in every arm, beside the arm-neutral co-primary), and the
 * patched twins (claims near the fixed regions, and claims per KLOC), which
 * have no labels and never enter precision.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { metricFromRecord } from "./delegation-compare.ts";
import { parseAmendments } from "./delegation-compare-grid.ts";
import { summarizeStops, type StopRow } from "./delegation-compare-stop.ts";
import { clusterBootstrap, clusterBootstrapStatistic, diffsByTarget, dropTwins, mcnemar, median, pairRuns, twinIdsFromManifests, type Arm, type ArmPair, type RunRecord } from "./paired.ts";
import { claimKeys, claimOutcomes, currentRuns, LEVELS, ledgerFindingRows, loadRegions, rescoreGrid, tiersOf, type Region, type RescoreRow, type Truth } from "./rescore.ts";
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

// --- Readiness -------------------------------------------------------------------

export interface GridState {
	dir: string;
	notReady: string[];
	/** Pair keys (target#pass) abandoned at the attempt ceiling, twins excluded. */
	abandoned: string[];
}

const readJson = (path: string): Row => JSON.parse(readFileSync(path, "utf8")) as Row;
const isRow = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Whether a grid can be decided, and the pairs it abandoned. Not ready: the
 * pass count is not fixed (stage 1 without its amendment, stage 2 without the
 * count it adopted), the summary is missing or still blinded, or the harness
 * says it is not ready for this rule.
 */
export function gridState(dir: string, stage: Stage): GridState {
	const manifest = readJson(join(dir, "manifest.json"));
	if (manifest.gridKind !== stage) throw new Error(`${dir} is grid kind ${JSON.stringify(manifest.gridKind ?? null)}; this comparison reads "${stage}"`);
	const notReady: string[] = [];
	if (stage === "v6-stage1") {
		const path = join(dir, "amendments.jsonl");
		const rows = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown) : [];
		if (!parseAmendments(rows).length) notReady.push("the pass count was not fixed by an amendment (amendments.jsonl has none): the grid is still the blind pilot");
	} else if (!isRow(manifest.passesFrom)) {
		notReady.push("the pass count was not adopted from stage 1 (the manifest has no passesFrom)");
	}
	const summaryPath = join(dir, "summary.json");
	const summary = existsSync(summaryPath) ? readJson(summaryPath) : undefined;
	if (!summary) notReady.push("no summary.json: the grid has not finished");
	else if (isRow(summary.pilot) && summary.pilot.blinded === true) notReady.push("summary.json is still blinded");
	else if (!isRow(summary.decision) || summary.decision.ready !== true) {
		const why = isRow(summary.decision) && Array.isArray(summary.decision.notReadyReasons) ? summary.decision.notReadyReasons.map(String) : ["summary.json does not say the grid is ready"];
		notReady.push(...why.map((w) => `harness: ${w}`));
	}
	const twins = twinIdsFromManifests([join(dir, "manifest.json")], (p) => readFileSync(p, "utf8"));
	const pairKey = (a: unknown): string => String(isRow(a) ? a.key ?? a.session ?? "" : a).replace(/\/\d+$/, "");
	const matchedSessions = isRow(summary?.matched) && isRow(summary.matched.sessions) ? summary.matched.sessions : {};
	const abandoned = [
		...(isRow(summary?.breaker) && Array.isArray(summary.breaker.abandoned) ? summary.breaker.abandoned : []),
		...(Array.isArray(matchedSessions.abandoned) ? matchedSessions.abandoned : []),
		...(Array.isArray(matchedSessions.resumeAbandoned) ? matchedSessions.resumeAbandoned : []),
	].map(pairKey).filter((k) => k && !twins.has(k.replace(/#\d+$/, "")));
	return { dir, notReady, abandoned: [...new Set(abandoned)].sort() };
}

// --- Rule 1 ---------------------------------------------------------------------------

export interface DiffInterval { level: string; pairs: number; targets: number; mean: number; lo: number; hi: number }
export interface Rule1 extends DiffInterval { nonInferior: boolean; superior: boolean; mcnemar: { b: number; c: number; p: number } }

function diffInterval(records: RunRecord[], level: string, arms: ArmPair): DiffInterval {
	const pairs = pairRuns(records, level, arms);
	const boot = clusterBootstrap(diffsByTarget(pairs), RULES.iterations, RULES.seed);
	return { level, pairs: pairs.length, targets: new Set(pairs.map((p) => p.target)).size, mean: boot.mean, lo: boot.lo, hi: boot.hi };
}

export function rule1(records: RunRecord[], arms: ArmPair): Rule1 {
	const d = diffInterval(records, OFFICIAL_LEVEL, arms);
	return { ...d, nonInferior: d.pairs > 0 && d.lo > RULES.margin, superior: d.pairs > 0 && d.lo > 0, mcnemar: mcnemar(pairRuns(records, OFFICIAL_LEVEL, arms)) };
}

// --- Rule 2 ---------------------------------------------------------------------------

export const RUBRIC = ["valid", "valid-mislocated", "not-security", "guarded", "wrong", "unverifiable"] as const;
export type RubricLabel = (typeof RUBRIC)[number];

/**
 * Adjudication labels (eval/adjudication.md): `{ "<target>|<file>:<line>": label }`,
 * or `{ label, issue }` where the judge grouped claims into one issue. A claim
 * key is the deduped `file:line` the pinned scorer grades (claimKeys).
 * Duplicates of one issue count once per run, so recording an issue three
 * times buys nothing.
 */
export type Labels = Map<string, { label: RubricLabel; issue: string }>;

export function parseLabels(raw: unknown): Labels {
	if (!isRow(raw)) throw new Error("adjudication labels: expected a JSON object mapping claim keys to labels");
	const out: Labels = new Map();
	for (const [key, v] of Object.entries(raw)) {
		const label = isRow(v) ? v.label : v;
		if (!RUBRIC.includes(label as RubricLabel)) throw new Error(`adjudication labels: "${key}" has label ${JSON.stringify(label)}, not one of ${RUBRIC.join(", ")}`);
		out.set(key, { label: label as RubricLabel, issue: isRow(v) && typeof v.issue === "string" ? v.issue : key });
	}
	return out;
}

interface PrecisionCounts { valid: number; validLoose: number; issues: number; tp: number; fp: number; neutral: number; unlabelled: number }
const ZERO: PrecisionCounts = { valid: 0, validLoose: 0, issues: 0, tp: 0, fp: 0, neutral: 0, unlabelled: 0 };
const add = (a: PrecisionCounts, b: PrecisionCounts): PrecisionCounts => ({ valid: a.valid + b.valid, validLoose: a.validLoose + b.validLoose, issues: a.issues + b.issues, tp: a.tp + b.tp, fp: a.fp + b.fp, neutral: a.neutral + b.neutral, unlabelled: a.unlabelled + b.unlabelled });

/** The ledgers a row was read from: its cell, or a matched union's sessions. */
const runDirs = (r: RescoreRow): string[] => (r.sessions ?? [r.cell]).map((cell) => join(r.grid, "runs", cell));

/** One run's presented tier: adjudicated issues and the key's outcomes, both over the same deduped claims. */
export function presentedCounts(row: RescoreRow, truth: Truth[], neutral: Region[], labels?: Labels): PrecisionCounts {
	const claims = runDirs(row).flatMap(ledgerFindingRows)
		.filter((f) => tiersOf(f.status, f.independent).includes("presented"))
		.flatMap((f) => f.citations.map((c) => ({ file: c.file, line: c.lo })));
	const key = claimOutcomes(claims, truth, neutral);
	const issues = new Map<string, RubricLabel>();
	let unlabelled = 0;
	for (const k of claimKeys(claims)) {
		const l = labels?.get(`${row.target}|${k}`);
		if (!l) { unlabelled++; continue; }
		issues.set(l.issue, l.label);
	}
	const labelled = [...issues.values()];
	return { valid: labelled.filter((l) => l === "valid").length, validLoose: labelled.filter((l) => l === "valid" || l === "valid-mislocated").length, issues: issues.size, ...key, unlabelled };
}

export interface Rule2 {
	status: "adjudicated" | "pending adjudication";
	subject: number | null;
	reference: number | null;
	/** subject ÷ reference, and its 95% bootstrap interval. */
	ratio: number | null;
	ratioLo: number | null;
	ratioHi: number | null;
	pass: boolean | null;
	/** With `valid-mislocated` counted valid (eval/adjudication.md). Reported only. */
	loose: { subject: number | null; reference: number | null };
	unlabelledClaims: number;
	/** The key's precision over non-neutral presented claims: provisional, never used to pass. */
	provisional: { subject: number | null; reference: number | null; ratio: number | null };
}

const share = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const ratioOf = (s: number | null, r: number | null): number | null => (s === null || r === null || r === 0 ? null : s / r);

export function rule2(units: Map<string, Array<{ s: PrecisionCounts; r: PrecisionCounts }>>, adjudicated: boolean): Rule2 {
	const all = [...units.values()].flat();
	const s = all.reduce((a, u) => add(a, u.s), ZERO);
	const r = all.reduce((a, u) => add(a, u.r), ZERO);
	const provisional = { subject: share(s.tp, s.tp + s.fp), reference: share(r.tp, r.tp + r.fp) };
	const base = { loose: { subject: share(s.validLoose, s.issues), reference: share(r.validLoose, r.issues) }, unlabelledClaims: s.unlabelled + r.unlabelled, provisional: { ...provisional, ratio: ratioOf(provisional.subject, provisional.reference) } };
	if (!adjudicated || base.unlabelledClaims > 0) {
		return { status: "pending adjudication", subject: null, reference: null, ratio: null, ratioLo: null, ratioHi: null, pass: null, ...base, loose: { subject: null, reference: null } };
	}
	const subject = share(s.valid, s.issues);
	const reference = share(r.valid, r.issues);
	const boot = clusterBootstrapStatistic(units, (xs) => {
		const t = xs.reduce((a, u) => ({ sv: a.sv + u.s.valid, si: a.si + u.s.issues, rv: a.rv + u.r.valid, ri: a.ri + u.r.issues }), { sv: 0, si: 0, rv: 0, ri: 0 });
		return t.sv / t.si / (t.rv / t.ri);
	}, RULES.iterations, RULES.seed);
	// Written as a product so a comparator at zero precision cannot divide by it.
	const pass = (subject ?? 0) >= RULES.precisionRatio * (reference ?? 0);
	return { status: "adjudicated", subject, reference, ratio: ratioOf(subject, reference), ratioLo: Number.isFinite(boot.lo) ? boot.lo : null, ratioHi: Number.isFinite(boot.hi) ? boot.hi : null, pass, ...base };
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

export interface Rule3 { pairs: number; missingTokens: number; median: number; lo: number; hi: number; bound: number; relaxed: boolean; pass: boolean; pooledRatio: number | null }

export function rule3(logRatios: Map<string, number[]>, missingTokens: number, superior: boolean, pooled: { subject: number; reference: number }): Rule3 {
	const boot = clusterBootstrapStatistic(logRatios, median, RULES.iterations, RULES.seed);
	const bound = superior ? RULES.costIfSuperior : RULES.cost;
	const pairs = [...logRatios.values()].flat().length;
	return {
		pairs, missingTokens, median: boot.value, lo: boot.lo, hi: boot.hi, bound, relaxed: superior,
		// A pair without a token count cannot be certified cheap.
		pass: pairs > 0 && missingTokens === 0 && boot.hi <= bound,
		pooledRatio: pooled.reference > 0 ? pooled.subject / pooled.reference : null,
	};
}

// --- Stopping and twins (reported) ---------------------------------------------------

export interface ArmStopping { runs: number; offeredToContinue: number; offeredRate: number | null; unclassified: number; medianTimeShare: number | null; leftWithOpenWork: number; judged: number; leftWithOpenWorkShare: number | null }
export interface Stopping {
	arms: Partial<Record<ArmLetter, ArmStopping>>;
	/** Subject − reference. */
	delta: { offeredRate: number | null; leftWithOpenWorkShare: number | null; medianTimeShare: number | null };
	/** The co-primary (runs left with time and open work) moves the same way as the text-test rate. */
	sameDirection: boolean | null;
	/** 3.2's stopping condition: fewer offers to continue, and the co-primary agreeing. */
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
	const sameDirection = delta.offeredRate === null || delta.leftWithOpenWorkShare === null ? null : Math.sign(delta.offeredRate) !== 0 && Math.sign(delta.offeredRate) === Math.sign(delta.leftWithOpenWorkShare);
	return { arms, delta, sameDirection, passesStopping: sameDirection === null ? null : sameDirection && delta.offeredRate! < 0 };
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

// --- The decision ---------------------------------------------------------------------

export type Outcome = "not ready" | "inconclusive" | "fails" | "pending adjudication" | "passes" | "superior";

export interface Decision {
	comparison: ComparisonId;
	reference: { arm: ArmLetter; harnessArm: Arm };
	subject: { arm: ArmLetter; harnessArm: Arm };
	grids: string[];
	outcome: Outcome;
	reasons: string[];
	notReady: string[];
	abandoned: string[];
	rule1?: Rule1;
	robustness?: { advisories: DiffInterval[]; labels: DiffInterval[] };
	rule2?: Rule2;
	rule3?: Rule3;
	stopping?: Stopping;
	twins?: Partial<Record<ArmLetter, TwinArm>>;
}

export function decide(comparison: ComparisonId, gridDirs: string[], labels?: Labels): Decision {
	const spec = COMPARISONS[comparison];
	const harness = HARNESS_ARMS[spec.stage];
	const arms: ArmPair = [harness[spec.reference]!, harness[spec.subject]!];
	const head = { comparison, reference: { arm: spec.reference, harnessArm: arms[0] }, subject: { arm: spec.subject, harnessArm: arms[1] }, grids: gridDirs };
	const states = gridDirs.map((d) => gridState(d, spec.stage));
	const notReady = states.flatMap((s) => s.notReady.map((w) => `${s.dir}: ${w}`));
	const abandoned = states.flatMap((s) => s.abandoned.map((k) => `${s.dir}: ${k}`));
	if (notReady.length) return { ...head, outcome: "not ready", reasons: ["not ready: nothing is computed until every grid is ready"], notReady, abandoned };

	const letterOf = (arm: string): ArmLetter | undefined => (Object.entries(harness) as Array<[ArmLetter, Arm]>).find(([, a]) => a === arm)?.[0];
	const rows: RescoreRow[] = [];
	const truths = new Map<string, Truth[]>();
	const neutral = new Map<string, Region[]>();
	const twinIds = new Set<string>();
	const stopRows: StopRow[] = [];
	for (const dir of gridDirs) {
		const scored = rescoreGrid(dir);
		assertLocationOnlyTruth(scored.truths);
		rows.push(...scored.rows);
		for (const [t, ts] of scored.truths) truths.set(t, ts);
		const manifest = readJson(join(dir, "manifest.json")) as { targets: Array<{ id: string; name: string }>; inputs: { truth: string } };
		for (const t of manifest.targets) neutral.set(t.id, loadRegions(join(manifest.inputs.truth, `${t.name}.neutral.json`)));
		for (const id of twinIdsFromManifests([join(dir, "manifest.json")], (p) => readFileSync(p, "utf8"))) twinIds.add(id);
		const runs = readdirSync(join(dir, "runs")).flatMap((cell) => existsSync(join(dir, "runs", cell, "run.json")) ? [readJson(join(dir, "runs", cell, "run.json"))] : []);
		for (const r of currentRuns(runs)) {
			const arm = letterOf(String(r.arm));
			if ((arm === spec.reference || arm === spec.subject) && r.twinOf === undefined && !twinIds.has(String(r.target))) stopRows.push({ arm, key: String(r.key ?? `${String(r.target)}#${String(r.pass)}`), valid: true, stop: r.stop });
		}
	}
	const { kept, twins } = dropTwins(toRecords(rows), twinIds);
	const keptRows = rows.filter((r) => !twinIds.has(r.target) && !r.control);
	const labelRecords = dropTwins(toRecords(keptRows, "matched"), twinIds).kept;

	const r1 = rule1(kept, arms);
	const robustness = {
		advisories: LEVELS.map((l) => diffInterval(kept, l, arms)),
		labels: LEVELS.map((l) => diffInterval(labelRecords, l, arms)),
	};

	// The pairs, with each arm's row, for rules 2 and 3.
	const pairs = pairRuns(kept, OFFICIAL_LEVEL, arms);
	const rowOf = (grid: string, target: string, pass: number, arm: Arm, attempt: number): RescoreRow => {
		const hit = keptRows.filter((r) => r.grid === grid && r.target === target && r.pass === pass && r.arm === arm && r.attempt === attempt);
		if (hit.length !== 1) throw new Error(`pair ${grid} ${target}#${pass}: expected one ${arm} row at attempt ${attempt}, found ${hit.length}`);
		return hit[0]!;
	};
	const precisionUnits = new Map<string, Array<{ s: PrecisionCounts; r: PrecisionCounts }>>();
	const logRatios = new Map<string, number[]>();
	let missingTokens = 0;
	const pooled = { subject: 0, reference: 0 };
	for (const p of pairs) {
		const ref = rowOf(p.grid, p.target, p.pass, arms[0], p.attempt);
		const sub = rowOf(p.grid, p.target, p.pass, arms[1], p.attempt);
		const truth = truths.get(p.target) ?? [];
		const regions = neutral.get(p.target) ?? [];
		const units = precisionUnits.get(p.target) ?? [];
		units.push({ s: presentedCounts(sub, truth, regions, labels), r: presentedCounts(ref, truth, regions, labels) });
		precisionUnits.set(p.target, units);
		const [ts, tr] = [gateTokens(sub), gateTokens(ref)];
		if (!(Number.isFinite(ts) && Number.isFinite(tr) && ts > 0 && tr > 0)) { missingTokens++; continue; }
		pooled.subject += ts;
		pooled.reference += tr;
		logRatios.set(p.target, [...(logRatios.get(p.target) ?? []), Math.log(ts / tr)]);
	}
	const r2 = rule2(precisionUnits, labels !== undefined);
	const r3 = rule3(logRatios, missingTokens, r1.superior, pooled);

	const reasons: string[] = [];
	let outcome: Outcome;
	if (abandoned.length) {
		outcome = "inconclusive";
		reasons.push(`${abandoned.length} pair(s) abandoned at the attempt ceiling: the comparison is inconclusive, never passing`);
	} else if (pairs.length === 0) {
		outcome = "inconclusive";
		reasons.push("no valid pairs");
	} else {
		if (!r1.nonInferior) reasons.push(`rule 1 fails: the lower bound ${r1.lo.toFixed(3)} is not above ${RULES.margin}`);
		if (!r3.pass) reasons.push(`rule 3 fails: the upper bound ${r3.hi.toFixed(3)} exceeds log(${r3.relaxed ? "1.5" : "1.10"}) = ${r3.bound.toFixed(3)}${missingTokens ? `, and ${missingTokens} pair(s) have no token count` : ""}`);
		if (r2.pass === false) reasons.push(`rule 2 fails: precision ratio ${r2.ratio === null ? "n/a" : r2.ratio.toFixed(3)} is below ${RULES.precisionRatio}`);
		if (reasons.length) outcome = "fails";
		else if (r2.status === "pending adjudication") {
			outcome = "pending adjudication";
			reasons.push(`rule 2 is pending adjudication${r2.unlabelledClaims ? ` (${r2.unlabelledClaims} presented claim(s) unlabelled)` : ""}: rules 1 and 3 hold, and the comparison cannot pass until it is judged`);
		} else {
			outcome = r1.superior ? "superior" : "passes";
			reasons.push(r1.superior ? "all three rules hold, and rule 1's lower bound is above 0" : "all three rules hold (non-inferior)");
		}
	}
	return {
		...head, outcome, reasons, notReady, abandoned, rule1: r1, robustness, rule2: r2, rule3: r3,
		stopping: stopping(stopRows, spec.reference, spec.subject), twins: twinScores(twins.length ? rows.filter((r) => twinIds.has(r.target) || r.control) : [], letterOf),
	};
}

// --- The ship table ------------------------------------------------------------------

export interface ShipRow { outcome: string; action: string; status: string }

const passed = (d?: Decision): boolean | undefined => (d === undefined || !["passes", "superior", "fails"].includes(d.outcome) ? undefined : d.outcome !== "fails");

/** The pre-registration's ship decisions, filled in from whichever comparisons are decided. */
export function shipTable(decisions: readonly Decision[]): ShipRow[] {
	const by = (c: ComparisonId) => decisions.find((d) => d.comparison === c);
	const status = (met: boolean | undefined, pending: string) => (met === undefined ? pending : met ? "met" : "not met");
	const sa = by("S-vs-A");
	const ds = by("D-vs-S");
	const dm = by("D-vs-M");
	const dmNonInferior = dm?.rule1 && !["not ready", "inconclusive"].includes(dm.outcome) ? dm.rule1.nonInferior : undefined;
	const dsPass = passed(ds);
	const row2 = dsPass === false || dmNonInferior === false ? false : dsPass === undefined || dmNonInferior === undefined ? undefined : true;
	const dmPass = passed(dm);
	const undecided = (d: Decision | undefined, name: string) => (d ? `undecided: ${name} is ${d.outcome}` : `undecided: ${name} not computed`);
	return [
		{ outcome: "S passes against A", action: "Phase 3's single-agent changes can ship to `main`", status: status(passed(sa), undecided(sa, "S vs A")) },
		{ outcome: "D passes against S and D is at least non-inferior to M", action: "delegation may become the default again, by a new ADR citing this trial", status: status(row2, `${undecided(ds, "D vs S")}; ${undecided(dm, "D vs M")}`) },
		{ outcome: "D does not pass against M", action: "delegation stays opt-in: it adds nothing that the same tokens do not buy solo", status: status(dmPass === undefined ? undefined : !dmPass, undecided(dm, "D vs M")) },
	];
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
		...d.abandoned.map((r) => `  abandoned · ${r}`),
	];
	if (d.rule1 && d.robustness && d.rule2 && d.rule3) {
		const r1 = d.rule1;
		const r2 = d.rule2;
		const r3 = d.rule3;
		L.push(
			"",
			`rule 1 · advisories found per pair at ${r1.level} (official; location-only truth): ${interval(r1)} · 95% app-clustered bootstrap, ${RULES.iterations} resamples, seed ${RULES.seed}`,
			`  non-inferior (lo > ${RULES.margin}): ${r1.nonInferior ? "yes" : "no"} · superior (lo > 0): ${r1.superior ? "yes" : "no"} · McNemar b=${r1.mcnemar.b} c=${r1.mcnemar.c} p=${f(r1.mcnemar.p, 4)}`,
			"  robustness, never deciding (on this truth the class-free ±3 level is the official one; point±3 is its point form):",
			...d.robustness.advisories.map((x) => `    advisories ${x.level}: ${interval(x)}`),
			...d.robustness.labels.map((x) => `    labelled locations ${x.level}: ${interval(x)}`),
			"",
			r2.status === "adjudicated"
				? `rule 2 · adjudicated precision, presented tier: ${d.subject.arm} ${f(r2.subject)} vs ${d.reference.arm} ${f(r2.reference)} · ratio ${f(r2.ratio)} [${f(r2.ratioLo)}, ${f(r2.ratioHi)}] · needs ≥ ${RULES.precisionRatio}: ${r2.pass ? "yes" : "no"} · with valid-mislocated ${f(r2.loose.subject)} vs ${f(r2.loose.reference)}`
				: `rule 2 · PENDING ADJUDICATION${r2.unlabelledClaims ? ` (${r2.unlabelledClaims} presented claim(s) unlabelled)` : ""}`,
			`  provisional, key-based, never used to pass: presented-tier precision without neutral claims ${d.subject.arm} ${f(r2.provisional.subject)} vs ${d.reference.arm} ${f(r2.provisional.reference)} (ratio ${f(r2.provisional.ratio)})`,
			"",
			`rule 3 · median per-pair log ratio of gate tokens (totalTokensWithRetryEstimate): ${f(r3.median, 4)} [${f(r3.lo, 4)}, ${f(r3.hi, 4)}] over ${r3.pairs} pair(s) · upper bound ≤ log(${r3.relaxed ? "1.5, relaxed by superiority" : "1.10"}) = ${f(r3.bound, 4)}: ${r3.pass ? "yes" : "no"}${r3.missingTokens ? ` · ${r3.missingTokens} pair(s) without tokens` : ""}`,
			`  pooled token ratio (reported, not deciding): ${f(r3.pooledRatio)}`,
		);
	}
	if (d.stopping) {
		const s = d.stopping;
		L.push("", "stopping (reported; 3.2's condition):");
		for (const [arm, a] of Object.entries(s.arms)) L.push(`  ${arm}: offered to continue (text test) ${a.offeredToContinue}/${a.runs - a.unclassified} = ${f(a.offeredRate)} · median time share ${f(a.medianTimeShare)} · stopped with time left and open work ${a.leftWithOpenWork}/${a.judged} = ${f(a.leftWithOpenWorkShare)}${a.unclassified ? ` · ${a.unclassified} unclassified` : ""}`);
		L.push(`  Δ ${d.subject.arm} − ${d.reference.arm}: offered ${f(s.delta.offeredRate)} · open-work share ${f(s.delta.leftWithOpenWorkShare)} · time share ${f(s.delta.medianTimeShare)} · co-primary same direction as the text-test rate: ${s.sameDirection === null ? "n/a" : s.sameDirection ? "yes" : "no"} · 3.2 passes on stopping: ${s.passesStopping === null ? "n/a" : s.passesStopping ? "yes" : "no"}`);
	}
	if (d.twins) {
		L.push("", "patched twins (reported, never in precision):");
		const arms = Object.entries(d.twins);
		if (!arms.length) L.push("  none in these arms");
		for (const [arm, t] of arms) L.push(`  ${arm}: ${t.hitsNearFixedRegions} claim(s) within ±3 of a fixed region · ${t.claims} claim(s) over ${t.runs} run(s) · ${f(t.meanClaimsPerKloc)} claims/KLOC`);
	}
	L.push("", "ship decisions (pre-registration):");
	for (const r of ship) L.push(`  [${r.status}] ${r.outcome} → ${r.action}`);
	return L.join("\n");
}

const USAGE = "Usage: v6-decision.ts --comparison S-vs-A|D-vs-S|D-vs-M --grid <dir> [--grid <dir>]... [--labels <adjudication.json>] [--with <other decision.json>]... [--out <prefix>]\n";

export function cli(argv: readonly string[], io: { readFile: (p: string) => string; write: (p: string, text: string) => void }): { code: number; out: string } {
	let comparison: string | undefined;
	let labelsPath: string | undefined;
	let out: string | undefined;
	const grids: string[] = [];
	const others: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i] ?? "";
		if (a === "--comparison") comparison = next();
		else if (a === "--grid") grids.push(next());
		else if (a === "--labels") labelsPath = next();
		else if (a === "--with") others.push(next());
		else if (a === "--out") out = next();
		else return { code: 2, out: `unknown argument ${a}\n${USAGE}` };
	}
	if (!comparison || !(comparison in COMPARISONS) || !grids.length) return { code: 2, out: USAGE };
	const labels = labelsPath ? parseLabels(JSON.parse(io.readFile(labelsPath))) : undefined;
	const decision = decide(comparison as ComparisonId, grids, labels);
	const ship = shipTable([decision, ...others.map((p) => JSON.parse(io.readFile(p)) as Decision).filter((d) => d.comparison !== decision.comparison)]);
	const text = formatDecision(decision, ship);
	const prefix = out ?? join(grids[0]!, `v6-decision-${comparison}`);
	io.write(`${prefix}.json`, `${JSON.stringify({ ...decision, ship }, null, 2)}\n`);
	io.write(`${prefix}.txt`, `${text}\n`);
	return { code: decision.outcome === "not ready" ? 1 : 0, out: `${text}\n` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const { code, out } = cli(process.argv.slice(2), { readFile: (p) => readFileSync(p, "utf8"), write: (p, t) => writeFileSync(p, t) });
		(code === 2 ? process.stderr : process.stdout).write(out);
		process.exitCode = code;
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
