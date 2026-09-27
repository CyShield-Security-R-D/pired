#!/usr/bin/env -S node --experimental-strip-types
/**
 * Paired, per-issue analysis of a matched comparison.
 *
 * The v5 grids reported a mean TP difference per pair over 15 pairs, which
 * cannot detect an effect below about 0.6 TP/pair, and a total hides which
 * issues each arm finds: a candidate that trades two easy issues for two hard
 * ones scores the same as one that changed nothing. This reads the per-run
 * records eval/rescore.ts writes and reports:
 *
 * - how often each arm found each truth issue, over the pairs that ran it;
 * - McNemar's exact test over (pair × truth issue) units, which uses the
 *   discordant units only and so is not diluted by issues both arms always or
 *   never find;
 * - the mean per-pair TP difference with a cluster bootstrap interval that
 *   resamples targets first, because pairs on one target are not independent
 *   (the same easy issue shows up in every pass);
 * - the paired SD, the minimum effect the grid could detect, and how many pairs
 *   a +0.2 or +0.3 TP/pair effect would need.
 *
 * Everything but the CLI is pure. The input is read structurally and this file
 * does not import eval/rescore.ts, so either can change without the other.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The arms a grid can hold. `matched` (delegation v6, plan item 2.5) is the
 * candidate snapshot with delegation off at the candidate's token budget; its
 * row is the union of its k sessions, one per pair, as eval/rescore.ts writes it.
 */
export type Arm = "baseline" | "candidate" | "matched";

/**
 * Which two arms to pair: the reference first, the subject second. Every
 * difference reported is subject − reference. The default is the gate's own
 * pairing; `--arms matched,candidate` asks whether delegation beats a single
 * agent that spent the same tokens.
 */
export type ArmPair = readonly [reference: Arm, subject: Arm];
export const DEFAULT_ARMS: ArmPair = ["baseline", "candidate"];
const ARMS: readonly Arm[] = ["baseline", "candidate", "matched"];

/** One rescored run, as eval/rescore.ts writes it. Extra fields are ignored. */
export interface RunRecord {
	grid: string;
	target: string;
	pass: number;
	arm: string;
	attempt: number;
	officialTp?: number;
	claims?: number;
	tokens?: number;
	/** A run marked invalid never pairs; one without the field is taken as valid. */
	valid?: boolean;
	/** Truth ids matched at each matching level, e.g. `{ "line±3": ["T1"] }`. */
	matched: Record<string, string[]>;
	/** A patched twin's row (plan item 2.8) carries its target, or its control score: either marks it as a twin. */
	twinOf?: string;
	control?: unknown;
}

/**
 * The patched twins' target ids named in grid manifests (plan item 2.8): an
 * entry with `twinOf` or `fixed_regions`. A twin is its target's fix-commit
 * tree with no labels, run as a control; its rows are not pairs of the
 * comparison, and pairing them would add a zero-TP pair per pass and dilute
 * every effect and find rate.
 */
export function twinIdsFromManifests(paths: readonly string[], readFile: (path: string) => string): Set<string> {
	const out = new Set<string>();
	for (const path of paths) {
		const manifest = JSON.parse(readFile(path)) as { targets?: Array<{ id: string; twinOf?: unknown; fixed_regions?: unknown }> };
		for (const t of manifest.targets ?? []) if (t.twinOf !== undefined || t.fixed_regions !== undefined) out.add(t.id);
	}
	return out;
}

/** Rows split into the comparison's and the patched twins': a twin is named by id, or marks itself. */
export function dropTwins(records: readonly RunRecord[], twinIds: ReadonlySet<string> = new Set()): { kept: RunRecord[]; twins: RunRecord[] } {
	const isTwin = (r: RunRecord): boolean => twinIds.has(r.target) || r.twinOf !== undefined || r.control !== undefined;
	return { kept: records.filter((r) => !isTwin(r)), twins: records.filter(isTwin) };
}

/**
 * One pair's matched sets. The fields keep the gate's names: `baseline` holds
 * the reference arm's set and `candidate` the subject's, whichever arms were
 * paired.
 */
export interface Pair {
	grid: string;
	target: string;
	pass: number;
	attempt: number;
	baseline: Set<string>;
	candidate: Set<string>;
}

export const DEFAULT_LEVEL = "line±3";

const pairKey = (r: { grid: string; target: string; pass: number }) => JSON.stringify([r.grid, r.target, r.pass]);

/**
 * Groups runs by (grid, target, pass) and keeps the groups where both arms ran.
 * Each arm contributes its highest attempt whatever its validity, and the pair
 * is kept only when both chosen runs are valid and their attempts agree. Picking
 * the highest *valid* attempt instead would let a superseded attempt 1 stand in
 * for an invalid attempt 2, pairing a run the grid itself had replaced; and a
 * baseline retried after a crash paired with the candidate's first attempt would
 * compare runs the grid never matched.
 *
 * A kept run without the requested level throws rather than reading as an empty
 * set: a mistyped `--level` otherwise prints b=0 c=0 p=1, SD 0 and MDE 0, which
 * reads as "no effect, fully powered" when nothing was measured at all.
 */
export function pairRuns(records: readonly RunRecord[], level: string = DEFAULT_LEVEL, arms: ArmPair = DEFAULT_ARMS): Pair[] {
	const groups = new Map<string, { baseline?: RunRecord; candidate?: RunRecord }>();
	for (const r of records) {
		// Any other arm is skipped, as an arm this file did not know always was.
		const slot = r.arm === arms[0] ? "baseline" : r.arm === arms[1] ? "candidate" : undefined;
		if (!slot) continue;
		const key = pairKey(r);
		const group = groups.get(key) ?? {};
		const held = group[slot];
		if (!held || r.attempt > held.attempt) group[slot] = r;
		groups.set(key, group);
	}
	const matchedAt = (r: RunRecord): Set<string> => {
		const ids = r.matched?.[level];
		if (!Array.isArray(ids)) throw new Error(`run ${pairKey(r)} ${r.arm} has no matched set at level "${level}"`);
		return new Set(ids);
	};
	const pairs: Pair[] = [];
	for (const { baseline, candidate } of groups.values()) {
		if (!baseline || !candidate || baseline.attempt !== candidate.attempt) continue;
		if (baseline.valid === false || candidate.valid === false) continue;
		pairs.push({
			grid: baseline.grid, target: baseline.target, pass: baseline.pass, attempt: baseline.attempt,
			baseline: matchedAt(baseline),
			candidate: matchedAt(candidate),
		});
	}
	return pairs.sort((a, b) => a.grid.localeCompare(b.grid) || a.target.localeCompare(b.target) || a.pass - b.pass);
}

/**
 * The truth ids that count for one target: the answer key's list when given,
 * joined with any id either arm matched. The union keeps a matched id from
 * vanishing when the list passed in is stale.
 */
function truthIdsFor(pairs: readonly Pair[], target: string, truthIdsByTarget?: ReadonlyMap<string, readonly string[]>): string[] {
	const ids = new Set(truthIdsByTarget?.get(target) ?? []);
	for (const p of pairs) if (p.target === target) for (const id of [...p.baseline, ...p.candidate]) ids.add(id);
	return [...ids].sort();
}

export interface FindRate { baseline: number; candidate: number; n: number }

/**
 * For each truth id, the number of pairs in which each arm found it, over the
 * `n` pairs that ran its target. Without the answer key an issue neither arm
 * ever found is invisible, so pass `truthIdsByTarget` to list it with zeros.
 * Truth ids are assumed unique across targets (the answer keys prefix them).
 */
export function perIssueFindRate(pairs: readonly Pair[], truthIdsByTarget?: ReadonlyMap<string, readonly string[]>): Map<string, FindRate> {
	const rates = new Map<string, FindRate>();
	const targets = [...new Set(pairs.map((p) => p.target))].sort();
	for (const target of targets) {
		const ids = truthIdsFor(pairs, target, truthIdsByTarget);
		for (const p of pairs) {
			if (p.target !== target) continue;
			for (const id of ids) {
				const rate = rates.get(id) ?? { baseline: 0, candidate: 0, n: 0 };
				rate.n++;
				if (p.baseline.has(id)) rate.baseline++;
				if (p.candidate.has(id)) rate.candidate++;
				rates.set(id, rate);
			}
		}
	}
	return rates;
}

/** ln C(n, k) by summing logs, exact enough for the counts a grid produces and immune to overflow. */
function logChoose(n: number, k: number): number {
	let sum = 0;
	for (let i = 1; i <= k; i++) sum += Math.log(n - k + i) - Math.log(i);
	return sum;
}

/** Exact two-sided binomial p for `b` against `c` under p = 1/2. */
export function exactBinomialTwoSided(b: number, c: number): number {
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	const logHalfN = -n * Math.LN2;
	let tail = 0;
	for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) + logHalfN);
	return Math.min(1, 2 * tail);
}

/**
 * McNemar's exact test over (pair × truth id) units: `b` counts units the
 * baseline found and the candidate missed, `c` the reverse. Concordant units
 * carry no information about the difference and are ignored, which is why this
 * sees an effect the mean over pairs smears across every issue.
 */
export function mcnemar(pairs: readonly Pair[], truthIdsByTarget?: ReadonlyMap<string, readonly string[]>): { b: number; c: number; p: number } {
	let b = 0;
	let c = 0;
	const idsByTarget = new Map<string, string[]>();
	for (const p of pairs) {
		let ids = idsByTarget.get(p.target);
		if (!ids) { ids = truthIdsFor(pairs, p.target, truthIdsByTarget); idsByTarget.set(p.target, ids); }
		for (const id of ids) {
			const inBase = p.baseline.has(id);
			const inCand = p.candidate.has(id);
			if (inBase && !inCand) b++;
			else if (inCand && !inBase) c++;
		}
	}
	return { b, c, p: exactBinomialTwoSided(b, c) };
}

/** Candidate TP minus baseline TP per pair, TP being the matched-set size at the pairing level. */
export function pairDiffs(pairs: readonly Pair[]): number[] {
	return pairs.map((p) => p.candidate.size - p.baseline.size);
}

/** Groups the per-pair differences by target, the unit the bootstrap resamples. */
export function diffsByTarget(pairs: readonly Pair[]): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const p of pairs) {
		const list = out.get(p.target) ?? [];
		list.push(p.candidate.size - p.baseline.size);
		out.set(p.target, list);
	}
	return out;
}

/** mulberry32: a small seeded PRNG, so the same input always prints the same interval. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** Linear-interpolated percentile of a sorted array. */
function percentile(sorted: readonly number[], q: number): number {
	if (!sorted.length) return 0;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Two-stage cluster bootstrap of the mean per-pair difference: resample targets
 * with replacement, then pairs within each drawn target. Resampling pairs
 * directly would treat five passes on one app as five independent apps and
 * print an interval narrower than the grid supports. Returns the observed mean
 * and a 95% percentile interval.
 */
export function clusterBootstrap(byTarget: ReadonlyMap<string, readonly number[]>, iterations = 10000, seed = 1): { mean: number; lo: number; hi: number } {
	const clusters = [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d).filter((d) => d.length > 0);
	const observed = mean(clusters.flat());
	if (!clusters.length) return { mean: 0, lo: 0, hi: 0 };
	const rand = mulberry32(seed);
	const draw = (n: number) => Math.floor(rand() * n);
	const means: number[] = [];
	for (let it = 0; it < iterations; it++) {
		let sum = 0;
		let count = 0;
		for (let t = 0; t < clusters.length; t++) {
			const cluster = clusters[draw(clusters.length)]!;
			for (let j = 0; j < cluster.length; j++) { sum += cluster[draw(cluster.length)]!; count++; }
		}
		means.push(sum / count);
	}
	means.sort((a, b) => a - b);
	return { mean: observed, lo: percentile(means, 0.025), hi: percentile(means, 0.975) };
}

/**
 * The same two-stage resampling as clusterBootstrap, for any statistic of the
 * resampled units (a median of log ratios, a ratio of pooled sums) rather than
 * the mean of numbers. It draws in the same order from the same generator, so
 * with the mean as the statistic it prints clusterBootstrap's interval.
 * Additive (eval/v6-decision.ts): clusterBootstrap is left as it was. A
 * resample whose statistic is not finite (a ratio over an empty denominator) is
 * left out of the percentiles and counted in `dropped`.
 */
export function clusterBootstrapStatistic<T>(byTarget: ReadonlyMap<string, readonly T[]>, statistic: (units: readonly T[]) => number, iterations = 10000, seed = 1): { value: number; lo: number; hi: number; dropped: number } {
	const clusters = [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, d]) => d).filter((d) => d.length > 0);
	const value = statistic(clusters.flat());
	if (!clusters.length) return { value, lo: Number.NaN, hi: Number.NaN, dropped: 0 };
	const rand = mulberry32(seed);
	const draw = (n: number) => Math.floor(rand() * n);
	const stats: number[] = [];
	let dropped = 0;
	for (let it = 0; it < iterations; it++) {
		const units: T[] = [];
		for (let t = 0; t < clusters.length; t++) {
			const cluster = clusters[draw(clusters.length)]!;
			for (let j = 0; j < cluster.length; j++) units.push(cluster[draw(cluster.length)]!);
		}
		const s = statistic(units);
		if (Number.isFinite(s)) stats.push(s);
		else dropped++;
	}
	stats.sort((a, b) => a - b);
	return stats.length ? { value, lo: percentile(stats, 0.025), hi: percentile(stats, 0.975), dropped } : { value, lo: Number.NaN, hi: Number.NaN, dropped };
}

/** The median of numbers (the mean of the middle two for an even count); NaN for none. */
export function median(xs: readonly number[]): number {
	if (!xs.length) return Number.NaN;
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Sample standard deviation (n − 1); 0 for fewer than two values. */
export function sampleSd(xs: readonly number[]): number {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const Z_ALPHA_2 = 1.959964;
const Z_POWER_80 = 0.841621;

/** z quantile by Acklam's rational approximation, for alpha and power other than the defaults. */
function zQuantile(p: number): number {
	const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
	const low = 0.02425;
	if (p < low) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
	}
	if (p > 1 - low) return -zQuantile(1 - p);
	const q = p - 0.5;
	const r = q * q;
	return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** z_{1−α/2} + z_{power}; the stated constants at the defaults, so the printed numbers match the plan's. */
function zSum(alpha: number, power: number): number {
	const za = alpha === 0.05 ? Z_ALPHA_2 : zQuantile(1 - alpha / 2);
	const zb = power === 0.8 ? Z_POWER_80 : zQuantile(power);
	return za + zb;
}

/** The smallest mean paired difference a two-sided test on `n` pairs detects at the given power. */
export function minDetectableEffect(sd: number, n: number, alpha = 0.05, power = 0.8): number {
	if (n <= 0) return Infinity;
	return (zSum(alpha, power) * sd) / Math.sqrt(n);
}

/** Pairs needed to detect `effect` given the paired SD: the inverse of minDetectableEffect, rounded up. */
export function pairsNeeded(sd: number, effect: number, alpha = 0.05, power = 0.8): number {
	if (effect <= 0) return Infinity;
	return Math.ceil(((zSum(alpha, power) * sd) / effect) ** 2);
}

export interface PairedReport {
	level: string;
	/** Present only when the pairing is not the default baseline vs candidate. */
	arms?: ArmPair;
	/** The grids the pairs came from; the CLI reports one grid at a time. */
	grids: string[];
	pairs: number;
	targets: number;
	findRates: Array<{ id: string } & FindRate>;
	mcnemar: { b: number; c: number; p: number };
	meanDiff: number;
	ci: { lo: number; hi: number };
	sd: number;
	mde: number;
	pairsFor02: number;
	pairsFor03: number;
}

export function analyze(records: readonly RunRecord[], level: string = DEFAULT_LEVEL, truthIdsByTarget?: ReadonlyMap<string, readonly string[]>, arms: ArmPair = DEFAULT_ARMS): PairedReport {
	const pairs = pairRuns(records, level, arms);
	const rates = perIssueFindRate(pairs, truthIdsByTarget);
	const diffs = pairDiffs(pairs);
	const boot = clusterBootstrap(diffsByTarget(pairs));
	const sd = sampleSd(diffs);
	const isDefault = arms[0] === DEFAULT_ARMS[0] && arms[1] === DEFAULT_ARMS[1];
	return {
		level,
		...(isDefault ? {} : { arms }),
		grids: [...new Set(pairs.map((p) => p.grid))].sort(),
		pairs: pairs.length,
		targets: new Set(pairs.map((p) => p.target)).size,
		findRates: [...rates.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, r]) => ({ id, ...r })),
		mcnemar: mcnemar(pairs, truthIdsByTarget),
		meanDiff: boot.mean,
		ci: { lo: boot.lo, hi: boot.hi },
		sd,
		mde: minDetectableEffect(sd, pairs.length),
		pairsFor02: pairsNeeded(sd, 0.2),
		pairsFor03: pairsNeeded(sd, 0.3),
	};
}

const f = (x: number, digits = 3) => (Number.isFinite(x) ? x.toFixed(digits) : String(x));

/** Ids and counts only: finding text never reaches the report. */
export function formatReport(r: PairedReport): string {
	const [ref, sub] = r.arms ?? DEFAULT_ARMS;
	const lines = [`paired analysis at ${r.level}: ${r.pairs} pair(s) over ${r.targets} target(s)`, `grid: ${r.grids.join(", ") || "(none)"}`, "", `truth id\t${ref}\t${sub}\tn`];
	for (const row of r.findRates) lines.push(`${row.id}\t${row.baseline}\t${row.candidate}\t${row.n}`);
	lines.push(
		"",
		`McNemar: b=${r.mcnemar.b} (${ref} only) c=${r.mcnemar.c} (${sub} only) p=${f(r.mcnemar.p, 4)}`,
		`mean diff per pair (${sub} − ${ref}): ${f(r.meanDiff)} TP, 95% cluster bootstrap CI [${f(r.ci.lo)}, ${f(r.ci.hi)}]`,
		`paired SD: ${f(r.sd)}`,
		`minimum detectable effect (α=0.05, power 0.8): ${f(r.mde)} TP/pair`,
		`pairs needed for +0.2 TP/pair: ${r.pairsFor02}; for +0.3 TP/pair: ${r.pairsFor03}`,
	);
	return lines.join("\n");
}

export interface CliArgs { file?: string; level: string; grid?: string; manifests: string[]; arms?: ArmPair }

/** `--arms <reference>,<subject>`: two different known arms, or a throw naming them. */
export function parseArms(text: string): ArmPair {
	const parts = text.split(",").map((x) => x.trim());
	const known = (a: string | undefined): a is Arm => ARMS.includes(a as Arm);
	if (parts.length !== 2 || !known(parts[0]) || !known(parts[1]) || parts[0] === parts[1]) {
		throw new Error(`--arms takes two different arms of ${ARMS.join(", ")} as <reference>,<subject>, got "${text}"`);
	}
	return [parts[0], parts[1]];
}

export function parseArgs(argv: readonly string[]): CliArgs {
	let file: string | undefined;
	let level = DEFAULT_LEVEL;
	let grid: string | undefined;
	let arms: ArmPair | undefined;
	const manifests: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--level") level = argv[++i] ?? level;
		else if (a === "--grid") grid = argv[++i];
		else if (a === "--manifest") { const m = argv[++i]; if (m) manifests.push(m); }
		else if (a === "--arms") arms = parseArms(argv[++i] ?? "");
		else if (!file) file = a;
	}
	return { file, level, grid, manifests, ...(arms ? { arms } : {}) };
}

/**
 * The grids `selector` names: an exact match first, then a path suffix, and only
 * then a substring. A bare substring alone would make `v5` select v5, v5b and
 * v5c together, pooling three candidate snapshots into one report.
 */
export function selectGrids(grids: readonly string[], selector: string): string[] {
	const exact = grids.filter((g) => g === selector);
	if (exact.length) return exact;
	const trimmed = selector.replace(/\/+$/, "");
	const suffix = grids.filter((g) => g.replace(/\/+$/, "").endsWith(`/${trimmed}`));
	if (suffix.length) return suffix;
	return grids.filter((g) => g.includes(selector));
}

/**
 * Truth ids per target from grid manifests: `targets[{id, name}]` names the
 * answer key `<inputs.truth>/<name>.truth.json`. Without them the find-rate
 * table hides every issue no run found, which are exactly the hard ones.
 */
export function truthIdsFromManifests(paths: readonly string[], readFile: (path: string) => string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const path of paths) {
		const manifest = JSON.parse(readFile(path)) as { targets: Array<{ id: string; name: string }>; inputs: { truth: string } };
		for (const t of manifest.targets) {
			const raw = JSON.parse(readFile(join(manifest.inputs.truth, `${t.name}.truth.json`))) as unknown;
			const items = (Array.isArray(raw) ? raw : (raw as { vulnerabilities?: unknown[] }).vulnerabilities ?? []) as Array<{ id: unknown }>;
			out.set(t.id, [...new Set([...(out.get(t.id) ?? []), ...items.map((v) => String(v.id))])]);
		}
	}
	return out;
}

const USAGE = "Usage: paired.ts <rescore.json> [--level line±3] [--grid <name|suffix|substring>] [--manifest <grid>/manifest.json]... [--arms baseline,candidate|matched,candidate|baseline,matched]\n";

/**
 * The CLI with its I/O injected: returns the exit code and what to print.
 * Prints one report per grid: pairs of the same app from two grids ran
 * different snapshots or models, so pooling them would merge them into one
 * bootstrap cluster and one find-rate row without a word.
 */
export function cli(argv: readonly string[], readFile: (path: string) => string): { code: number; out: string } {
	let args: CliArgs;
	try { args = parseArgs(argv); } catch (error) { return { code: 2, out: `${error instanceof Error ? error.message : String(error)}\n${USAGE}` }; }
	const { file, level, grid, manifests, arms } = args;
	if (!file) return { code: 2, out: USAGE };
	const all = JSON.parse(readFile(file)) as RunRecord[];
	const allGrids = [...new Set(all.map((r) => r.grid))].sort();
	const chosen = grid ? new Set(selectGrids(allGrids, grid)) : new Set(allGrids);
	// Patched twins are controls, never pairs (plan item 2.8).
	const { kept: records, twins } = dropTwins(all.filter((r) => chosen.has(r.grid)), manifests.length ? twinIdsFromManifests(manifests, readFile) : undefined);
	if (!records.length) return { code: 2, out: `no records for --grid ${grid ?? ""}; grids in input:\n${allGrids.map((g) => `  ${g}`).join("\n")}\n` };
	if (!records.some((r) => Array.isArray(r.matched?.[level]))) {
		const levels = [...new Set(records.flatMap((r) => Object.keys(r.matched ?? {})))].sort();
		return { code: 2, out: `no record has level "${level}"; levels in input: ${levels.join(", ") || "(none)"}\n` };
	}
	const truth = manifests.length ? truthIdsFromManifests(manifests, readFile) : undefined;
	const reports = [...chosen].sort().map((g) => formatReport(analyze(records.filter((r) => r.grid === g), level, truth, arms)));
	const note = twins.length ? `dropped ${twins.length} patched-twin row(s): controls, not pairs of the comparison\n\n` : "";
	return { code: 0, out: `${note}${reports.join("\n\n")}\n` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const { code, out } = cli(process.argv.slice(2), (path) => readFileSync(path, "utf8"));
		(code ? process.stderr : process.stdout).write(out);
		process.exitCode = code;
	} catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
