#!/usr/bin/env -S node --experimental-strip-types
/**
 * Fresh applications for the delegation v6 acceptance run (docs/delegation-v6-plan.md, item 4.1).
 *
 * The v5 trial graded delegation on five official targets and guarded it with
 * four held-out ones. Every one of those, and every other project the pool in
 * /home/mamgad/corpus holds, has since been named in pired's research, diagnosed
 * or tuned against. A v6 verdict measured on them would partly measure how well
 * the harness was fitted to them. So the acceptance run draws applications
 * pired has never been graded on, by a procedure written down before the draw:
 * a selector who picks by hand brings what they know about each project into
 * the result, and nobody can tell afterwards how much.
 *
 * The procedure, in order:
 *
 *   1. **Pool.** Every CVE record in an OSV bulk export that carries a reference
 *      explicitly typed FIX to a GitHub commit (`pool`). The export is hashed and
 *      the derived pool is committed, so the draw can be repeated after OSV has
 *      moved on.
 *   2. **Exclusions.** Every repository named anywhere pired's development
 *      touched (`exclusions`): the official and held-out manifests (names only),
 *      the old pool and every run directory and log under it, and every
 *      research, docs and eval note in the repository's whole history.
 *   3. **Metadata filters** over the whole pool: one repository, exactly one fix
 *      commit, a publication date, not excluded, and optionally a publication
 *      cutoff that is kept only if the pool stays large enough (`dateRuleHolds`).
 *   4. **A seeded walk** (`draw`): repositories in mulberry32 order, each tried on
 *      up to three of its advisories in a second seeded order, admitted when the
 *      checkout passes every eligibility rule and its language has room. The
 *      walk stops when the draw and its clean-code controls are full.
 *   5. **Truth** (`truth`) for the drawn targets: labels from the fix diffs on the
 *      vulnerable tree under the hygiene rules below, plus every other advisory
 *      of the same project still open in that tree (the multikey rule).
 *
 * Nothing is re-drawn after results are seen. A re-draw, for any reason, is a
 * new entry under `variants` in selection.json, never a replacement.
 *
 * The module splits in two. Everything above `// --- IO` is pure — pool
 * derivation, the shuffle, the filters, label hygiene, the class rule, the walk
 * with its evaluator injected — and is what select-fresh.test.ts covers. The IO
 * half drives git and the filesystem and is exercised by running it.
 *
 *   node --experimental-strip-types eval/corpus/select-fresh.ts pool --zip GIT-all.zip --headers h.txt --out eval/corpus/fresh/pool.json
 *   node --experimental-strip-types eval/corpus/select-fresh.ts exclusions --out eval/corpus/fresh/exclusions.json
 *   node --experimental-strip-types eval/corpus/select-fresh.ts draw --seed 20260926 --work DIR
 *   node --experimental-strip-types eval/corpus/select-fresh.ts truth --work DIR
 *   node --experimental-strip-types eval/corpus/select-fresh.ts materialise --work DIR --out CORPUS
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { COMMIT_RE, LEAK_NAMES, NON_SOURCE, SOURCE_EXT, VENDORED, classify, countLines, mapRangeBack, resolveSha, stripLeakage, walk } from "./lib.ts";
import type { Advisory, TruthEntry } from "./lib.ts";

// --- parameters ---------------------------------------------------------------

/**
 * Bumped whenever a rule below changes meaning. Recorded in every manifest and
 * in the verdict cache key, so a cached verdict from an older rule set can never
 * be replayed into a newer draw.
 */
export const RULES_VERSION = 2;
// v1 (5cac587): the draw recorded as variant 1 in selection.json.
// v2: an independent review of variant 1, before any model run, found
// non-applications admitted and import-only edits labelled. v2 adds the
// service rules (isService), the vendored-file rule (isVendoredFile), server-
// only route shapes (lib.ts ROUTE_RE) and import-only hunks (importOnly).

/**
 * The size range, in lines of application source (lib.ts walk(): the corpus's
 * own definition of scope_loc), of the five official v5 targets: whoogle-search
 * 3,650 to LinkAce 38,977. A fresh target outside it would change the task's
 * difficulty along an axis the comparison is not about.
 */
export const SIZE_RANGE: readonly [number, number] = [3_650, 38_977];

/**
 * A tree with more source files than this is rejected before its blobs are
 * fetched. To fit under the 38,977-line ceiling it would need fewer than 13
 * lines per file; the largest official target has 922 files. The bound exists
 * so a walk that meets a monorepo does not download it.
 */
export const MAX_SOURCE_FILES = 3_000;

/**
 * The widest a label may be. Research/12: 7 of the 24 official labels spanned
 * more than 31 lines and the widest 501, and a ±3 window applied to a 501-line
 * range credits almost any claim in the file — Luna v5c scored 8 against 12
 * with wide ranges and 2 against 3 at ±3 around the labelled line itself.
 */
export const LABEL_MAX_LINES = 31;

/**
 * Hunks of one file closer than this merge into one label, if the merged label
 * still fits LABEL_MAX_LINES. Six is two ±3 windows: labels any closer would
 * share a claim between them, and one claim would be graded as two finds.
 */
export const MERGE_GAP = 6;

/**
 * An advisory whose fix yields more labels than this is treated as a refactor
 * or a release diff rather than a patch. Keeping it would let one advisory
 * dominate its target's key, and which of its edits are the vulnerability and
 * which are incidental cannot be told without reading it — judgement this
 * procedure does not make. The official targets carry 1 to 4 labels per
 * advisory; the bound is three times the largest.
 */
export const MAX_LABELS_PER_ADVISORY = 12;

/** Advisories tried per repository before the repository counts as ineligible. */
export const TRIES_PER_REPO = 3;

export const DEFAULT_N = 12;
export const DEFAULT_CONTROLS = 2;
export const DEFAULT_SEED = 20260926;

/**
 * The publication cutoff tried first. Later publication makes it less likely
 * that the fix is in a model's training data; none of the three v6 models
 * publishes a cutoff, so this reduces the risk rather than removing it. The
 * cutoff is kept only if `dateRuleHolds`, which is the instruction this
 * procedure was written to: filter on date only if at least three times the
 * needed applications survive it.
 */
export const DEFAULT_PUBLISHED_SINCE = "2026-01-01";

// --- pool ---------------------------------------------------------------------

/** One OSV record, as much of it as the pool reads. */
export interface OsvRecord {
	id: string;
	published?: string;
	aliases?: string[];
	references?: Array<{ type?: string; url?: string }>;
	database_specific?: { cwe_ids?: string[] };
	severity?: Array<{ type?: string; score?: string }>;
}

/** One advisory in the pool. `fixes` are "owner/repo@sha" in the URL's case. */
export interface PoolAdvisory {
	id: string;
	aliases: string[];
	published: string | null;
	cwe: string[];
	/** CVSS v3 qualitative rating from the record's vector, or null when it has none. */
	severity: string | null;
	fixes: string[];
}

export const repoOf = (fix: string): string => fix.slice(0, fix.lastIndexOf("@"));
export const shaOf = (fix: string): string => fix.slice(fix.lastIndexOf("@") + 1);
export const repoKey = (repo: string): string => repo.toLowerCase();

/**
 * The pool entry for one OSV record, or undefined when it cannot be one.
 *
 * CVE records only: the GIT export also carries GSD, UVI and PYSEC mirrors of
 * the same vulnerabilities, and admitting them would count one bug several
 * times. Only references typed FIX: an untyped commit reference is often the
 * release, and bludit's CVE-2026-25099/25100/25101 all point at a "chore: bump
 * version" commit (research/10) — a key built from that holds no vulnerability.
 * NVD's placeholder classes (NVD-CWE-Other, NVD-CWE-noinfo) are not classes.
 */
export function poolAdvisory(rec: OsvRecord): PoolAdvisory | undefined {
	if (!/^CVE-\d{4}-\d+$/.test(rec.id)) return undefined;
	const fixes: string[] = [];
	for (const ref of rec.references ?? []) {
		if (ref.type !== "FIX" || !ref.url) continue;
		const m = COMMIT_RE.exec(ref.url);
		if (!m) continue;
		const fix = `${m[1]}/${(m[2] as string).replace(/\.git$/i, "")}@${(m[3] as string).toLowerCase()}`;
		if (!fixes.some((f) => f.toLowerCase() === fix.toLowerCase())) fixes.push(fix);
	}
	if (fixes.length === 0) return undefined;
	const published = /^\d{4}-\d{2}-\d{2}/.test(rec.published ?? "") ? (rec.published as string).slice(0, 10) : null;
	const vector = (rec.severity ?? []).find((s) => s.type === "CVSS_V3" && s.score)?.score;
	return {
		id: rec.id,
		aliases: [...new Set((rec.aliases ?? []).filter((a) => a && a !== rec.id))].sort(),
		published,
		cwe: [...new Set((rec.database_specific?.cwe_ids ?? []).filter((c) => /^CWE-\d+$/.test(c)))],
		severity: vector ? cvss3Rating(vector) : null,
		fixes: fixes.sort(),
	};
}

/**
 * The CVSS v3.x base score of a vector, per the v3.1 specification, or
 * undefined for a vector it cannot read. Computed rather than taken from the
 * record because OSV's CVE records carry the vector only.
 */
export function cvss3Score(vector: string): number | undefined {
	const m = new Map(vector.split("/").slice(1).map((kv) => kv.split(":") as [string, string]));
	const W: Record<string, Record<string, number>> = {
		AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
		AC: { L: 0.77, H: 0.44 },
		UI: { N: 0.85, R: 0.62 },
		CIA: { H: 0.56, L: 0.22, N: 0 },
	};
	const scope = m.get("S");
	const pr = m.get("PR");
	const prW = pr === "N" ? 0.85 : pr === "L" ? (scope === "C" ? 0.68 : 0.62) : pr === "H" ? (scope === "C" ? 0.5 : 0.27) : undefined;
	const av = W.AV?.[m.get("AV") ?? ""];
	const ac = W.AC?.[m.get("AC") ?? ""];
	const ui = W.UI?.[m.get("UI") ?? ""];
	const c = W.CIA?.[m.get("C") ?? ""];
	const i = W.CIA?.[m.get("I") ?? ""];
	const a = W.CIA?.[m.get("A") ?? ""];
	if ((scope !== "U" && scope !== "C") || [prW, av, ac, ui, c, i, a].some((x) => x === undefined)) return undefined;
	const iss = 1 - (1 - (c as number)) * (1 - (i as number)) * (1 - (a as number));
	const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
	const exploit = 8.22 * (av as number) * (ac as number) * (prW as number) * (ui as number);
	if (impact <= 0) return 0;
	const roundUp = (x: number): number => {
		const n = Math.round(x * 100_000);
		return n % 10_000 === 0 ? n / 100_000 : (Math.floor(n / 10_000) + 1) / 10;
	};
	return roundUp(Math.min(scope === "U" ? impact + exploit : 1.08 * (impact + exploit), 10));
}

export function cvss3Rating(vector: string): string | null {
	const s = cvss3Score(vector);
	if (s === undefined) return null;
	return s === 0 ? "none" : s < 4 ? "low" : s < 7 ? "medium" : s < 9 ? "high" : "critical";
}

/** Canonical JSON: keys sorted at every depth, so equal data hashes equal. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash a manifest records for a pool: its advisories, in id order, canonically. */
export function poolHash(advisories: readonly PoolAdvisory[]): string {
	return sha256(canonical([...advisories].sort((a, b) => a.id.localeCompare(b.id))));
}

// --- seeded order -------------------------------------------------------------

/** mulberry32: a small, well-known PRNG, chosen so the draw can be re-derived in any language. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** Fisher–Yates over a copy, driven by `rand`. */
export function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

/** FNV-1a, for deriving one stream per repository from the draw's seed. */
export function fnv1a(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/**
 * The walk's repository order: sorted first, so the pool's file order cannot
 * matter, then shuffled by the seed.
 */
export function repoOrder(repos: Iterable<string>, seed: number): string[] {
	return seededShuffle([...repos].sort(), mulberry32(seed));
}

/**
 * The order a repository's advisories are tried in. Its own stream, derived
 * from the seed and the repository, so it does not depend on how many
 * repositories the walk examined before this one.
 */
export function advisoryOrder<T extends { advisory: { id: string } }>(repo: string, candidates: readonly T[], seed: number): T[] {
	const sorted = [...candidates].sort((a, b) => a.advisory.id.localeCompare(b.advisory.id));
	return seededShuffle(sorted, mulberry32((seed ^ fnv1a(repo)) >>> 0));
}

// --- metadata filters -----------------------------------------------------------

export interface FilterCount { filter: string; advisories: number; repos: number }

/** An advisory that passed every metadata filter, with its one fix resolved. */
export interface Candidate { advisory: PoolAdvisory; repo: string; sha: string }

/**
 * The filters that need no checkout, applied to the whole pool, with the count
 * after each. Exactly one fix commit: with two, which parent is "the vulnerable
 * version" is a choice, and a backport on a release branch makes it a wrong one.
 */
export function metadataFilter(
	pool: readonly PoolAdvisory[],
	excluded: ReadonlySet<string>,
	publishedSince?: string,
): { candidates: Map<string, Candidate[]>; counts: FilterCount[] } {
	type Row = { a: PoolAdvisory; repos: string[] };
	const counts: FilterCount[] = [];
	const tally = (filter: string, rows: Row[]): Row[] => {
		counts.push({ filter, advisories: rows.length, repos: new Set(rows.flatMap((r) => r.repos)).size });
		return rows;
	};
	let rows: Row[] = pool.map((a) => ({ a, repos: [...new Set(a.fixes.map((f) => repoKey(repoOf(f))))] }));
	rows = tally("pool: CVE record with a FIX-typed GitHub commit", rows);
	rows = tally("fix commits in one repository", rows.filter((r) => r.repos.length === 1));
	rows = tally("exactly one fix commit", rows.filter((r) => r.a.fixes.length === 1));
	rows = tally("publication date recorded", rows.filter((r) => r.a.published !== null));
	rows = tally("repository not excluded", rows.filter((r) => !excluded.has(r.repos[0] as string)));
	if (publishedSince) rows = tally(`published on or after ${publishedSince}`, rows.filter((r) => (r.a.published as string) >= publishedSince));
	const candidates = new Map<string, Candidate[]>();
	for (const { a, repos } of rows) {
		const key = repos[0] as string;
		const fix = a.fixes[0] as string;
		candidates.set(key, [...(candidates.get(key) ?? []), { advisory: a, repo: repoOf(fix), sha: shaOf(fix) }]);
	}
	return { candidates, counts };
}

/** Publication years, for the distribution the manifest reports. */
export function yearHistogram(dates: Iterable<string | null>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const d of dates) {
		const y = d ? d.slice(0, 4) : "unknown";
		out[y] = (out[y] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Wilson score lower bound for a binomial proportion. */
export function wilsonLower(successes: number, trials: number, z = 1.96): number {
	if (trials === 0) return 0;
	const p = successes / trials;
	const z2 = z * z;
	const centre = p + z2 / (2 * trials);
	const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
	return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

/**
 * Whether a publication cutoff may stay: the eligible repositories it leaves,
 * estimated from the walk's own yield at its 95% Wilson lower bound, must be
 * at least three times what the draw needs. Estimated, because counting every
 * eligible repository exactly would mean fetching the whole pool.
 */
export function dateRuleHolds(eligible: number, examined: number, candidateRepos: number, needed: number): { holds: boolean; lower: number; estimate: number; required: number } {
	const lower = wilsonLower(eligible, examined);
	const estimate = Math.floor(lower * candidateRepos);
	return { holds: estimate >= 3 * needed, lower, estimate, required: 3 * needed };
}

// --- exclusions -----------------------------------------------------------------

/**
 * Token positions in lower-cased text, so a few thousand repository names can
 * be looked up in tens of megabytes of notes without a scan per name.
 */
export function mentionIndex(text: string): { text: string; at: Map<string, number[]> } {
	const lower = text.toLowerCase();
	const at = new Map<string, number[]>();
	for (const m of lower.matchAll(/[a-z0-9]+/g)) {
		const list = at.get(m[0]);
		if (list) list.push(m.index);
		else at.set(m[0], [m.index]);
	}
	return { text: lower, at };
}

/**
 * Does `phrase` occur in the indexed text with no letter or digit on either
 * side? `whoogle-search` is found in `benbusby_whoogle-search-03n6cv`, which is
 * how the old pool names its run directories; `note` is not found in `notes`.
 */
export function mentions(index: { text: string; at: Map<string, number[]> }, phrase: string): boolean {
	const p = phrase.toLowerCase();
	const first = /^[a-z0-9]+/.exec(p)?.[0];
	if (!first) return index.text.includes(p);
	for (const pos of index.at.get(first) ?? []) {
		if (index.text.startsWith(p, pos) && !/[a-z0-9]/.test(index.text[pos + p.length] ?? "")) return true;
	}
	return false;
}

/**
 * The phrases that count as naming a repository. In notes: its slug either
 * way it is written, or its bare name — pired's research writes "filebrowser",
 * not "filebrowser/filebrowser". In the old pool's run logs and directory
 * names only the slugs, because those files also quote whole source trees,
 * where a bare name like `server` or `core` means nothing.
 */
export function namePhrases(repo: string, bare: boolean): string[] {
	const [owner, name] = repo.toLowerCase().split("/") as [string, string];
	const out = [`${owner}/${name}`, `${owner}_${name}`];
	if (bare) out.push(name);
	return out;
}

// --- label hygiene ----------------------------------------------------------------

/**
 * The extensions the pinned scorer (eval/dvbank/score.ts, fromLedger) can read
 * a claimed location from. A label anywhere else can never be matched.
 */
export const SCORER_EXT = /\.(?:py|pyi|js|jsx|ts|tsx|go|rb|php|java|cs|rs|kt|scala)$/i;

/** Code the scorer cannot read. A fix there is real but unscoreable, and is counted, not labelled. */
export const OTHER_CODE_EXT = /\.(?:mjs|cjs|vue|svelte|c|h|cc|cpp|cxx|hpp|hh|swift|m|mm|lua|pl|pm|ex|exs|erl|hrl|hs|clj|cljs|dart|groovy|sh|bash|sql)$/i;

/** Minified bundles are generated. A fix that rebuilds one is not a location in it. */
const GENERATED = /\.min\.(?:js|css)$|(^|\/)(?:bundle|vendor)\.[\w.-]*js$/i;

export function isLabelFile(path: string): boolean {
	return SCORER_EXT.test(path) && !NON_SOURCE.test(path) && !VENDORED.test(`/${path}`) && !GENERATED.test(path);
}

/** A file lib.ts walk() counts as source, decided from its path alone. */
export function isWalkSource(path: string): boolean {
	return !VENDORED.test(`/${path}`) && SOURCE_EXT.test(path) && !NON_SOURCE.test(path);
}

/**
 * A changed line that changes code, as opposed to a comment or whitespace. A
 * fix that only rewords comments near the bug touches no code and cannot be
 * labelled. `#[` and `#!` are PHP/Rust attributes and shebangs, not comments.
 */
export function isCodeLine(text: string): boolean {
	const t = text.trim();
	if (t === "") return false;
	if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("<!--")) return false;
	if (t.startsWith("#") && !/^#[[!]/.test(t)) return false;
	return true;
}

export interface Hunk {
	/** Pre-image path, or null for a file the fix added. */
	oldFile: string | null;
	/** Post-image path, or null for a file the fix deleted. */
	newFile: string | null;
	oldStart: number; oldLen: number; newStart: number; newLen: number;
	removed: string[]; added: string[];
}

function diffPath(field: string, prefix: string): string | null {
	const raw = field.split("\t")[0] as string;
	// A quoted path carries escapes this parser does not decode. Dropping the
	// hunk fails closed: an unlabelled edit, never a label on the wrong file.
	if (raw === "/dev/null" || raw.startsWith("\"") || !raw.startsWith(prefix)) return null;
	return raw.slice(prefix.length);
}

/**
 * Hunks of a `git diff --unified=0`. Content lines are consumed by the counts
 * in the hunk header, not by their first character: a removed SQL comment
 * `-- x` renders as `--- x` and would otherwise read as a new file header.
 */
export function parseZeroContextDiff(diff: string): Hunk[] {
	const hunks: Hunk[] = [];
	let oldFile: string | null = null;
	let newFile: string | null = null;
	let cur: Hunk | undefined;
	let remOld = 0;
	let remNew = 0;
	for (const line of diff.split("\n")) {
		if (cur && (remOld > 0 || remNew > 0)) {
			if (line.startsWith("-") && remOld > 0) { cur.removed.push(line.slice(1)); remOld -= 1; continue; }
			if (line.startsWith("+") && remNew > 0) { cur.added.push(line.slice(1)); remNew -= 1; continue; }
			if (line.startsWith("\\")) continue;
		}
		if (line.startsWith("diff --git ")) { cur = undefined; oldFile = null; newFile = null; continue; }
		if (line.startsWith("--- ")) { oldFile = diffPath(line.slice(4), "a/"); cur = undefined; continue; }
		if (line.startsWith("+++ ")) { newFile = diffPath(line.slice(4), "b/"); cur = undefined; continue; }
		const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!h) continue;
		const oldLen = h[2] === undefined ? 1 : Number(h[2]);
		const newLen = h[4] === undefined ? 1 : Number(h[4]);
		cur = { oldFile, newFile, oldStart: Number(h[1]), oldLen, newStart: Number(h[3]), newLen, removed: [], added: [] };
		remOld = oldLen;
		remNew = newLen;
		hunks.push(cur);
	}
	return hunks;
}

/**
 * The lines a hunk occupies on one side. A pure insertion occupies nothing, so
 * it is placed at the line it was inserted after — the missing check belongs
 * there, and keyFromPatch places it the same way.
 */
export function hunkRange(h: Hunk, side: "pre" | "post"): [number, number] {
	const start = side === "pre" ? h.oldStart : h.newStart;
	const len = side === "pre" ? h.oldLen : h.newLen;
	if (len > 0) return [start, start + len - 1];
	const at = Math.max(start, 1);
	return [at, at];
}

export interface Label {
	advisory: string;
	file: string;
	range: [number, number];
	/** The span before capping; equal to `range` unless `capped`. */
	raw: [number, number];
	capped: boolean;
	hunks: number;
}

/**
 * The lines of a file that belong to import statements, 1-based.
 *
 * Read from the whole file because a hunk of `git diff -U0` has no context: in
 * Go's `import (` block or a Python `from x import (` list, a changed line
 * reads `"strings"` or `    helper,` and is recognisable as an import only
 * from the statement around it. Line-based and per language; a statement it
 * cannot bracket is left out, so an edit it is unsure of stays code.
 */
export function importLines(path: string, text: string): Set<number> {
	const lines = text.split("\n");
	const out = new Set<number>();
	const lang = languageOf(path);
	const mark = (from: number, to: number): void => { for (let k = from; k <= to; k++) out.add(k + 1); };
	/** The first line at or after `i` for which `done` holds, within 200 lines. */
	const until = (i: number, done: (t: string) => boolean): number | undefined => {
		for (let j = i; j < Math.min(lines.length, i + 200); j++) if (done(lines[j] ?? "")) return j;
		return undefined;
	};
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i] ?? "";
		let end: number | undefined;
		if (lang === "Python") {
			if (/^\s*(?:from\s+[\w.]+\s+import\b|import\s+[\w.])/.test(t)) {
				if (t.includes("(") && !t.includes(")")) end = until(i, (x) => x.includes(")"));
				else {
					end = i;
					while (/\\\s*$/.test(lines[end] ?? "") && end + 1 < lines.length) end++;
				}
			}
		} else if (lang === "JavaScript/TypeScript") {
			if (/^\s*import\b(?!\s*\()/.test(t)) end = until(i, (x) => /\bfrom\s*['"`]|^\s*import\s+['"]|\brequire\s*\(/.test(x));
			else if (/^\s*(?:const|let|var)\s+[\w$\s{},:]+=\s*require\s*\(\s*['"`][^'"`]+['"`]\s*\)\s*;?\s*$/.test(t) || /^\s*require\s*\(\s*['"]/.test(t)) end = i;
			else if (/^\s*(?:const|let|var)\s*\{\s*$/.test(t)) {
				const j = until(i + 1, (x) => /[};]/.test(x));
				if (j !== undefined && /\}\s*=\s*require\s*\(/.test(lines[j] ?? "")) end = j;
			}
		} else if (lang === "Go") {
			if (/^\s*import\s*\(/.test(t)) end = until(i, (x) => /^\s*\)/.test(x));
			else if (/^\s*import\s+(?:[\w.]+\s+)?"/.test(t)) end = i;
		} else if (lang === "PHP") {
			if (/^\s*use\s+[\\\w]/.test(t) || /^\s*(?:require|include)(?:_once)?\b/.test(t)) end = until(i, (x) => x.includes(";"));
		} else if (lang === "Ruby") {
			if (/^\s*require(?:_relative)?[\s(]+['"]/.test(t)) end = i;
		} else if (lang === "Java" || lang === "Kotlin" || lang === "Scala") {
			if (/^\s*import\s/.test(t)) end = t.includes("{") && !t.includes("}") ? until(i, (x) => x.includes("}")) : i;
		} else if (lang === "C#") {
			if (/^\s*(?:global\s+)?using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[\w.<>]+)?\s*;/.test(t)) end = i;
		} else if (lang === "Rust") {
			if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s/.test(t)) end = until(i, (x) => x.includes(";"));
			else if (/^\s*extern\s+crate\s/.test(t)) end = i;
		}
		if (end !== undefined) { mark(i, end); i = end; }
	}
	return out;
}

/**
 * Does this hunk change nothing but imports? `pre` and `post` are the import
 * lines of the file on each side (importLines). A hunk that adds an import and
 * a check is code; one that only adds the import the check elsewhere needs is
 * not a location of the bug. Without both files' import lines the hunk counts
 * as code.
 */
export function importOnly(h: Hunk, pre?: ReadonlySet<number>, post?: ReadonlySet<number>): boolean {
	const removed = h.removed.map((t, i) => [t, h.oldStart + i] as const).filter(([t]) => isCodeLine(t));
	const added = h.added.map((t, j) => [t, h.newStart + j] as const).filter(([t]) => isCodeLine(t));
	if (removed.length + added.length === 0) return false;
	if ((removed.length > 0 && !pre) || (added.length > 0 && !post)) return false;
	return removed.every(([, n]) => pre?.has(n)) && added.every(([, n]) => post?.has(n));
}

/** Import lines per file on each side of a fix, as the IO layer loads them. */
export interface ImportSides { pre: ReadonlyMap<string, ReadonlySet<number>>; post: ReadonlyMap<string, ReadonlySet<number>> }

/**
 * Labels from a fix's hunks, under the hygiene rules:
 *
 *  - only files the scorer reads, outside tests, docs, examples, vendored and
 *    generated code; code hunks elsewhere are counted as `unscoreable`;
 *  - only hunks that change a code line, and not only imports (`imports`
 *    counts the hunks dropped for that);
 *  - hunks of one file merge when at most MERGE_GAP lines apart and the result
 *    fits LABEL_MAX_LINES; a label never spans more than LABEL_MAX_LINES — a
 *    run of several hunks is split at hunk boundaries, and a single hunk wider
 *    than that is capped to its first LABEL_MAX_LINES lines.
 *
 * `side` "pre" labels the vulnerable tree; "post" gives the fixed regions of a
 * patched twin.
 */
export function labelsFromHunks(
	advisory: string,
	hunks: readonly Hunk[],
	side: "pre" | "post" = "pre",
	sides?: ImportSides,
): { labels: Label[]; unscoreable: number; imports: number } {
	const byFile = new Map<string, Array<[number, number]>>();
	let unscoreable = 0;
	let imports = 0;
	for (const h of hunks) {
		const file = side === "pre" ? h.oldFile : h.newFile;
		if (!file) continue;
		if (![...h.removed, ...h.added].some(isCodeLine)) continue;
		if (!isLabelFile(file)) {
			if ((SCORER_EXT.test(file) || OTHER_CODE_EXT.test(file)) && !NON_SOURCE.test(file) && !VENDORED.test(`/${file}`) && !GENERATED.test(file)) unscoreable += 1;
			continue;
		}
		if (sides && importOnly(h, h.oldFile ? sides.pre.get(h.oldFile) : undefined, h.newFile ? sides.post.get(h.newFile) : undefined)) {
			imports += 1;
			continue;
		}
		byFile.set(file, [...(byFile.get(file) ?? []), hunkRange(h, side)]);
	}
	const labels: Label[] = [];
	for (const [file, ranges] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
		ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		let cur: { lo: number; hi: number; n: number } | undefined;
		const flush = (): void => {
			if (cur) labels.push({ advisory, file, range: [cur.lo, cur.hi], raw: [cur.lo, cur.hi], capped: false, hunks: cur.n });
			cur = undefined;
		};
		for (const [lo, hi] of ranges) {
			if (hi - lo + 1 > LABEL_MAX_LINES) {
				flush();
				labels.push({ advisory, file, range: [lo, lo + LABEL_MAX_LINES - 1], raw: [lo, hi], capped: true, hunks: 1 });
				continue;
			}
			if (cur && lo - cur.hi - 1 <= MERGE_GAP && Math.max(cur.hi, hi) - cur.lo + 1 <= LABEL_MAX_LINES) {
				cur.hi = Math.max(cur.hi, hi);
				cur.n += 1;
				continue;
			}
			flush();
			cur = { lo, hi, n: 1 };
		}
		flush();
	}
	return { labels, unscoreable, imports };
}

/**
 * The regions of a fix for a NEUTRAL record: where a claim is neither a true
 * nor a false positive because it points at an open advisory the key could
 * not label. The same file and hunk rules as labels (scorer files, code, not
 * import-only), merged at MERGE_GAP, but never capped or split: a neutral
 * region only forgives, so the fix's whole extent is the honest width.
 */
export function neutralRegions(advisory: string, hunks: readonly Hunk[], sides?: ImportSides): Label[] {
	const byFile = new Map<string, Array<[number, number]>>();
	for (const h of hunks) {
		if (!h.oldFile || !isLabelFile(h.oldFile) || ![...h.removed, ...h.added].some(isCodeLine)) continue;
		if (sides && importOnly(h, sides.pre.get(h.oldFile), h.newFile ? sides.post.get(h.newFile) : undefined)) continue;
		byFile.set(h.oldFile, [...(byFile.get(h.oldFile) ?? []), hunkRange(h, "pre")]);
	}
	const out: Label[] = [];
	for (const [file, ranges] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
		ranges.sort((a, b) => a[0] - b[0]);
		let cur: [number, number] | undefined;
		for (const r of ranges) {
			if (cur && r[0] - cur[1] - 1 <= MERGE_GAP) cur = [cur[0], Math.max(cur[1], r[1])];
			else {
				if (cur) out.push({ advisory, file, range: cur, raw: cur, capped: false, hunks: 1 });
				cur = [r[0], r[1]];
			}
		}
		if (cur) out.push({ advisory, file, range: cur, raw: cur, capped: false, hunks: 1 });
	}
	return out;
}

/**
 * The id an OSV record is known by here: its own if it is a CVE, else the
 * first CVE among its aliases, else its own. GSD and UVI mirror CVEs, and one
 * vulnerability must not be recorded twice.
 */
export function canonicalId(rec: { id: string; aliases?: string[] }): string {
	if (/^CVE-/.test(rec.id)) return rec.id;
	return (rec.aliases ?? []).filter((a) => /^CVE-/.test(a)).sort()[0] ?? rec.id;
}

/** A record's FIX-typed commits in one repository, as shas. */
export function fixCommitsIn(rec: OsvRecord, repo: string): string[] {
	const shas = (rec.references ?? [])
		.filter((r) => r.type === "FIX" && r.url)
		.map((r) => COMMIT_RE.exec(r.url as string))
		.filter((m): m is RegExpExecArray => !!m && repoKey(`${m[1]}/${(m[2] as string).replace(/\.git$/i, "")}`) === repoKey(repo))
		.map((m) => (m[3] as string).toLowerCase());
	return [...new Set(shas)];
}

/**
 * Would lib.ts stripLeakage delete this file when the target is built? It
 * deletes files named like release notes and any file that mentions the
 * advisory. A label on a deleted file is a guaranteed miss that says nothing
 * about the reviewer, so such a label is dropped (or, for the advisory a
 * target was drawn for, the advisory is ineligible).
 */
export function wouldStrip(path: string, text: string, ids: readonly string[]): boolean {
	if (path.split("/").some((part) => LEAK_NAMES.some((re) => re.test(part)))) return true;
	const lower = text.toLowerCase();
	return ids.some((id) => id && lower.includes(id.toLowerCase()));
}

/** Two labels with the same file and range are one location, whichever advisory brought it. */
export function dedupeLabels(labels: readonly Label[]): Label[] {
	const seen = new Set<string>();
	return labels.filter((l) => {
		const key = `${l.file}:${l.range[0]}-${l.range[1]}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** A fresh truth entry: the official shape without class fields, plus the advisory and its classes. */
export interface FreshTruthEntry {
	id: string;
	title: string;
	severity: string;
	file: string;
	line: number;
	line_range: [number, number];
	/** The advisory this label belongs to; an advisory is found when any of its labels is. */
	advisory: string;
	/** Every CWE of the advisory, for a re-scorer's class level with any-of matching. */
	cwes: string[];
}

/**
 * Truth entries, classless for the pinned grader.
 *
 * Variant 1 put the advisory's first CWE on every label. OSV sorts an
 * advisory's CWE ids as text, so the first is not the primary: one target was
 * labelled CWE-200 where its advisory's weakness is CWE-22, another CWE-266
 * where it is CWE-285. And once any label carries a class the grader refuses a
 * location-correct claim naming another (research/12). So no entry carries
 * `cwe` or `vuln_class`, which makes the official score location-only, and each
 * carries `cwes` — all of its advisory's classes — for a re-scorer that wants a
 * class level and can match any of them.
 */
export function toTruth(labels: readonly Label[], advisories: ReadonlyMap<string, PoolAdvisory>): FreshTruthEntry[] {
	const n = new Map<string, number>();
	return labels.map((l): FreshTruthEntry => {
		const k = (n.get(l.advisory) ?? 0) + 1;
		n.set(l.advisory, k);
		const a = advisories.get(l.advisory);
		return {
			id: `${l.advisory}-${k}`,
			title: l.advisory,
			severity: a?.severity ?? "unknown",
			file: l.file,
			line: l.range[0],
			line_range: [l.range[0], l.range[1]],
			advisory: l.advisory,
			cwes: [...(a?.cwe ?? [])].sort((x, y) => Number(x.slice(4)) - Number(y.slice(4))),
		};
	});
}

/**
 * Move another advisory's labels onto the reviewed tree (the multikey rule,
 * eval/corpus/multikey.ts): `diffs` maps a file to `git diff -U0 <reviewed>
 * <fix^1> -- <file>`. A label whose lines changed in between is not the same
 * code and is dropped, as is one whose file is absent from the map.
 */
export function mapLabelsBack(labels: readonly Label[], diffs: ReadonlyMap<string, string>): { kept: Label[]; dropped: Label[] } {
	const kept: Label[] = [];
	const dropped: Label[] = [];
	for (const l of labels) {
		const diff = diffs.get(l.file);
		const range = diff === undefined ? undefined : mapRangeBack(diff, l.range);
		if (!range) { dropped.push(l); continue; }
		const shift = range[0] - l.range[0];
		kept.push({ ...l, range, raw: [l.raw[0] + shift, l.raw[1] + shift] });
	}
	return { kept, dropped };
}

// --- application ------------------------------------------------------------------

/**
 * Folders whose contents say nothing about what the project deploys: tests,
 * docs, examples, fixtures, mocks, archives. Variant 1 counted them. One
 * drawn target's only server entry was `Archive/Web Version/BACKEND/server.js`,
 * and another's templates and routes came from `examples/` and `__fixtures__/`.
 */
export const NON_SERVICE = /(^|\/)(?:tests?|__tests__|specs?|e2e|testdata|test[-_]data|docs?|documentation|examples?|samples?|demos?|fixtures?|__fixtures__|mocks?|__mocks__|archives?|archived)(\/|$)/i;

/** Is the file inside a NON_SERVICE folder? Only its folders are tested, never its name. */
export function inNonServiceFolder(path: string): boolean {
	return NON_SERVICE.test(path.split("/").slice(0, -1).join("/"));
}

/**
 * A file that deploys a service: a Dockerfile, a compose file, a Helm chart or
 * a Procfile, at most three levels deep and outside NON_SERVICE folders. A
 * framework or a library has none of its own; an application its maintainers
 * run has at least one. All five official targets carry a Dockerfile or a
 * compose file at depth 1.
 */
export function isDeployMarker(path: string): boolean {
	if (path.split("/").length > 3 || inNonServiceFolder(path)) return false;
	const name = path.split("/").pop() ?? "";
	if (/\.dockerignore$/i.test(name)) return false;
	return /^Dockerfile(?:[.-][\w.-]+)?$/i.test(name) || /\.dockerfile$/i.test(name) || COMPOSE_NAME.test(name)
		|| /^Chart\.ya?ml$/.test(name) || name === "Procfile";
}
const COMPOSE_NAME = /^(docker-)?compose([-.][\w.-]+)?\.ya?ml$/i;

/**
 * A third-party library's banner in a file's first 15 lines: a `/*!`
 * preserved comment, or a comment naming something at a semantic version
 * (`* Vue.js v2.6.14`). A project's own licence header names no version, so it
 * does not count.
 */
export function libraryBanner(text: string): boolean {
	const head = text.split("\n", 15);
	if (/^\s*\/\*!/.test(head.find((l) => l.trim() !== "") ?? "")) return true;
	return head.some((l) => /^\s*(?:\/\*+!?|\*|\/\/|#)\s*.{0,60}?\b[A-Za-z][\w.-]*\s+v?\d+\.\d+\.\d+\b/.test(l));
}

/** Longer than this, a single source file is treated as vendored. */
export const VENDORED_MAX_LINES = 5_000;

/**
 * A source file that is someone else's code, wherever it sits: over
 * VENDORED_MAX_LINES lines, or opening with a library banner. Variant 1
 * measured size and language over them. One drawn Go application counted as
 * JavaScript because `internal/view/assets/js/vue.js`, 11,912 lines, outweighed
 * its Go. Such files are left out of size, language and routes.
 */
export function isVendoredFile(text: string): boolean {
	return text.split("\n").length > VENDORED_MAX_LINES || libraryBanner(text);
}

const PREPOSITION = /^(?:on|with|using|built|powered|by|based|in|of|from|to|via|atop|upon|around|over|for|into|uses|runs|and\s+a)$/i;
/** Collections an application keeps, which READMEs also call libraries. */
const COLLECTION = /^(?:media|photos?|music|books?|videos?|games?|comics?|manga|audio|e-?books?|movies?|images?|files?|documents?|reading|podcasts?|recipes?|prompts?|component|asset|content|digital|personal)$/i;
/** The kinds of project the rule rejects, with an optional hyphenated qualifier ("web-framework"). */
const KIND = String.raw`((?:[\w.]+-)?(?:frameworks?|librar(?:y|ies)|sdks?|toolkits?))`;

/** README text as prose: image alt text kept, tags, badges, links and emphasis removed. */
function readmeProse(line: string): string {
	return line
		.replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ")
		.replace(/<[^>]+>/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.trim();
}

/**
 * The phrase in which a README's first 40 lines call the project a framework,
 * a library, an SDK or a toolkit, or undefined when they do not.
 *
 * Two shapes count. "X is a|an|the … framework" anywhere in the 40 lines; and
 * a tagline — a heading, or one of the first ten lines of prose — that is, or
 * follows a name and a separator, "a|an|the … framework". Up to five words may
 * sit between the article and the noun, none of them a preposition: "a web app
 * built on the Gin framework" describes an application. "A photo library" is a
 * collection, not code.
 */
export function frameworkPhrase(readme: string): string | undefined {
	const lines = readme.split("\n", 40).map(readmeProse).filter((l) => l.length > 0);
	const find = (line: string, anchored: boolean): string | undefined => {
		// The noun is inside the pattern, so the lazy middle grows until it
		// reaches one; a pattern that took any word as the noun would stop at
		// "a lightweight" and never see "web-framework".
		const middle = String.raw`((?:[\w.+/#'-]+\s+){0,5}?)`;
		const re = anchored
			? new RegExp(String.raw`(?:^#*\s*|[\w)\]]\s*[:|]\s+|[\w)\]]\s+[—–-]\s+)((?:an?|the)\s+` + middle + KIND + String.raw`)\b`, "gi")
			: new RegExp(String.raw`\b(?:is|as)\s+((?:an?|the|our)\s+` + middle + KIND + String.raw`)\b`, "gi");
		for (const m of line.matchAll(re)) {
			const noun = m[3] ?? "";
			const middle = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
			if (middle.some((w) => PREPOSITION.test(w))) continue;
			if (/librar/i.test(noun) && middle.length > 0 && COLLECTION.test(middle.at(-1) as string)) continue;
			return (m[1] ?? "").trim();
		}
		return undefined;
	};
	for (const [i, line] of lines.entries()) {
		const hit = find(line, false) ?? (i < 10 || line.startsWith("#") ? find(line, true) : undefined);
		if (hit) return hit;
	}
	return undefined;
}

/** What the service rules read, all from paths except the README and the route files' contents. */
export interface ServiceFacts {
	/** Source files with a server route registration, outside NON_SERVICE folders and not vendored. */
	routeFiles: number;
	templates: boolean;
	migrations: boolean;
	server: boolean;
	/** Deployable-service markers found (isDeployMarker). */
	deploy: string[];
	/** The README's framework/library phrase, if it has one. */
	readmeKind?: string;
}

const TEMPLATE_PATH = /(^|\/)(templates?|views?|layouts)(\/|$)|\.(html|htm|j2|jinja2?|tmpl|gohtml|erb|blade\.php|twig|hbs|ejs)$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic|Migrations)(\/|$)/i;
const SERVER_PATH = /(^|\/)(manage\.py|wsgi\.py|asgi\.py|routes\.rb|server\.(js|ts|go)|main\.go|Dockerfile|docker-compose\.ya?ml|index\.php|artisan)$/i;

/**
 * Service facts from a tree's paths, the route files lib.ts classify() found,
 * the files judged vendored and the README. The templates, migration and
 * server-entry patterns are lib.ts's, applied only outside NON_SERVICE folders.
 */
export function serviceFacts(all: readonly string[], source: readonly string[], routeFiles: readonly string[], vendored: ReadonlySet<string>, readme?: string): ServiceFacts {
	const service = all.filter((p) => !inNonServiceFolder(p));
	const src = new Set(source);
	return {
		routeFiles: routeFiles.filter((f) => src.has(f) && !vendored.has(f) && !inNonServiceFolder(f)).length,
		templates: service.some((p) => TEMPLATE_PATH.test(p)),
		migrations: service.some((p) => MIGRATION_PATH.test(p)),
		server: service.some((p) => SERVER_PATH.test(p)),
		deploy: all.filter(isDeployMarker).sort(),
		...(readme !== undefined && frameworkPhrase(readme) ? { readmeKind: frameworkPhrase(readme) } : {}),
	};
}

/**
 * The service rules, in the order the walk applies them: a served application
 * (a server route in a source file, and two of templates, migrations, a server
 * entry — calibrated on the five official targets, which have 1 to 3 route
 * source files and two or three corroborations), a deployable service, and a
 * README that does not call the project a framework or a library.
 */
export function serviceVerdict(f: ServiceFacts): { filter: "served application" | "deployable service" | "not a framework or library"; detail: string } | undefined {
	const corroborated = [f.templates && "templates", f.migrations && "migrations", f.server && "server entry"].filter(Boolean) as string[];
	if (f.routeFiles < 1 || corroborated.length < 2) {
		return { filter: "served application", detail: `${f.routeFiles} route source file(s); ${corroborated.length > 0 ? corroborated.join(", ") : "no templates, migrations or server entry"}` };
	}
	if (f.deploy.length === 0) return { filter: "deployable service", detail: "no Dockerfile, compose file, Chart.yaml or Procfile at depth 3 or less" };
	if (f.readmeKind) return { filter: "not a framework or library", detail: `README: "${f.readmeKind.slice(0, 80)}"` };
	return undefined;
}

/** The root README, preferring Markdown, from a tree listing. */
export function readmePath(all: readonly string[]): string | undefined {
	const root = all.filter((p) => !p.includes("/") && /^readme(\.(md|markdown|rst|txt|adoc|org))?$/i.test(p));
	return root.find((p) => /\.(md|markdown)$/i.test(p)) ?? root.sort()[0];
}

// --- language -----------------------------------------------------------------

/**
 * Code extensions by language. The scorer's languages first; the rest are
 * outside its list and are named so a project written in them is seen as
 * such, rather than as the few thousand lines of Python in its tooling.
 */
const LANGUAGE_EXTENSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["Python", ["py", "pyi"]],
	["JavaScript/TypeScript", ["js", "jsx", "mjs", "cjs", "ts", "tsx"]],
	["Go", ["go"]],
	["Ruby", ["rb"]],
	["PHP", ["php"]],
	["Java", ["java"]],
	["Kotlin", ["kt", "kts"]],
	["Scala", ["scala"]],
	["C#", ["cs"]],
	["Rust", ["rs"]],
	["C/C++", ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"]],
	["Vue/Svelte", ["vue", "svelte"]],
	["Swift", ["swift"]],
	["Objective-C", ["m", "mm"]],
	["Elixir", ["ex", "exs"]],
	["Erlang", ["erl", "hrl"]],
	["Lua", ["lua"]],
	["Perl", ["pl", "pm"]],
	["Dart", ["dart"]],
	["Haskell", ["hs"]],
	["Clojure", ["clj", "cljs"]],
	["Groovy", ["groovy"]],
	["Shell", ["sh", "bash"]],
];

const LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = LANGUAGE_EXTENSIONS.map(([lang, exts]) => [new RegExp(`\\.(?:${exts.join("|")})$`, "i"), lang] as const);

/** Languages whose files the scorer reads. JavaScript and TypeScript are one stratum. */
export const SCORER_LANGUAGES: ReadonlySet<string> = new Set(["Python", "JavaScript/TypeScript", "Go", "Ruby", "PHP", "Java", "Kotlin", "Scala", "C#", "Rust"]);

export function languageOf(path: string): string | undefined {
	return LANGUAGES.find(([re]) => re.test(path))?.[1];
}

/**
 * Sparse-checkout patterns for every code file languageOf() recognises, case
 * folded by character class because the extension tests are case-insensitive.
 *
 * Every eligibility rule reads either a path or a code file: size and the
 * route test read source, the language count reads code, templates,
 * migrations and server entries are decided from paths alone. Checking out
 * only code keeps the walk from downloading what no rule reads — one game's
 * card images held a single checkout for more than eleven minutes.
 */
export function sparsePatterns(): string[] {
	const fold = (ext: string): string => [...ext].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join("");
	// The root README too, which the framework rule reads.
	return [...LANGUAGE_EXTENSIONS.flatMap(([, exts]) => exts.map((e) => `*.${fold(e)}`)), `/${fold("readme")}*`];
}

/** One line of `git ls-tree -r -z` output, parsed. */
export interface TreeEntry { mode: string; path: string }

export function parseLsTree(out: string): TreeEntry[] {
	return out.split("\0").filter(Boolean).map((row) => {
		const tab = row.indexOf("\t");
		return { mode: row.slice(0, row.indexOf(" ")), path: row.slice(tab + 1) };
	});
}

/**
 * What lib.ts walk() would return for a clean checkout of the tree, computed
 * from its listing instead of the disk: the same vendored and hidden paths
 * skipped, the same source test. Submodules (mode 160000) are directories
 * with nothing in them in a checkout, so they are not files here either.
 */
export function walkFromListing(entries: readonly TreeEntry[]): { all: string[]; source: string[] } {
	const all = entries.filter((e) => e.mode !== "160000" && !VENDORED.test(`/${e.path}`)).map((e) => e.path);
	return { all, source: all.filter((p) => SOURCE_EXT.test(p) && !NON_SOURCE.test(p)) };
}

/** The language with the most lines; ties go to name order so the answer never depends on file order. */
export function dominantLanguage(lines: ReadonlyMap<string, number>): string | undefined {
	let best: [string, number] | undefined;
	for (const [lang, n] of [...lines].sort(([a], [b]) => a.localeCompare(b))) {
		if (n > 0 && (!best || n > best[1])) best = [lang, n];
	}
	return best?.[0];
}

// --- the walk -------------------------------------------------------------------

export const WALK_FILTERS = [
	"source obtainable at the parent commit",
	"size within the official range",
	"served application",
	"deployable service",
	"not a framework or library",
	"language in the scorer's list",
	"labellable fix",
	"fix not diffuse",
	"labels survive leak stripping",
] as const;
export type WalkFilter = (typeof WALK_FILTERS)[number];

export const CONTROL_FILTERS = [
	"history obtainable",
	"no other known advisory open in the fixed tree",
	"fixed tree obtainable",
	"fixed tree within the official range",
	"fixed tree is a served application",
	"fixed tree language in the scorer's list",
] as const;
export type ControlFilter = (typeof CONTROL_FILTERS)[number];

export interface Eligible {
	ok: true;
	advisory: string;
	/** The fix commit, full. */
	fix: string;
	/** Its first parent: the tree reviewed. */
	parent: string;
	language: string;
	scopeFiles: number;
	scopeLoc: number;
	routes: number;
	labels: Label[];
	unscoreable: number;
	/** Hunks dropped as import-only (rules v2). */
	importOnly?: number;
	/** Deployable-service markers found (rules v2). */
	deploy?: string[];
	/** Source files left out of measurement as vendored (rules v2). */
	vendored?: number;
}
export interface Ineligible { ok: false; advisory: string; filter: WalkFilter; detail: string }
export type Verdict = Eligible | Ineligible;

export interface ControlEligible { ok: true; advisory: string; commit: string; language: string; scopeFiles: number; scopeLoc: number; routes: number; fixedRegions: Label[] }
export interface ControlIneligible { ok: false; advisory: string; filter: ControlFilter; detail: string }
export type ControlVerdict = ControlEligible | ControlIneligible;

export interface DrawPorts {
	/** Every eligibility rule, for one advisory of one repository. */
	evaluate(repo: string, candidate: Candidate): Promise<Verdict>;
	/** The control rules, for an advisory already found eligible. */
	evaluateControl(repo: string, candidate: Candidate, eligible: Eligible): Promise<ControlVerdict>;
	/** Called once per examined repository when the walk no longer needs its checkout. */
	release?(repo: string, kept: boolean): Promise<void>;
	progress?(line: string): void;
}

export interface DrawOptions { n: number; controls: number; maxPerLanguage: number; triesPerRepo: number; concurrency: number; seed: number }

export type WalkOutcome = "admitted" | "control" | "ineligible" | "language stratum full" | "control ineligible";

export interface WalkStep {
	repo: string;
	outcome: WalkOutcome;
	verdicts: Array<{ advisory: string; ok: boolean; filter?: string; detail?: string }>;
	chosen?: string;
}

export interface DrawResult {
	targets: Array<{ repo: string; candidate: Candidate; verdict: Eligible }>;
	controls: Array<{ repo: string; candidate: Candidate; verdict: Eligible; control: ControlEligible }>;
	steps: WalkStep[];
	/** Repositories examined, and how many had an eligible advisory: the walk's yield. */
	examined: number;
	eligible: number;
	/** Examined advisories that failed, by the first rule they failed. */
	failures: Record<string, number>;
	exhausted: boolean;
}

/**
 * The seeded walk. Repositories are taken in `order`; each is tried on up to
 * `triesPerRepo` of its advisories in their own seeded order, and the first
 * eligible advisory stands for it. An eligible repository is admitted unless
 * its language already holds `maxPerLanguage` places, so no language exceeds
 * half the draw. Once the draw is full, the walk continues for the clean-code
 * controls on repositories not already drawn.
 *
 * Evaluation runs `concurrency` repositories ahead, but every decision is made
 * in walk order from verdicts that do not depend on the draw's state, so the
 * result is the same at any concurrency.
 */
export async function drawSequential(
	order: readonly string[],
	candidatesOf: (repo: string) => Candidate[],
	ports: DrawPorts,
	opts: DrawOptions,
): Promise<DrawResult> {
	const result: DrawResult = { targets: [], controls: [], steps: [], examined: 0, eligible: 0, failures: {}, exhausted: false };
	const perLanguage = new Map<string, number>();
	const evaluateRepo = async (repo: string): Promise<Array<{ candidate: Candidate; verdict: Verdict }>> => {
		const out: Array<{ candidate: Candidate; verdict: Verdict }> = [];
		for (const candidate of advisoryOrder(repo, candidatesOf(repo), opts.seed).slice(0, opts.triesPerRepo)) {
			const verdict = await ports.evaluate(repo, candidate);
			out.push({ candidate, verdict });
			if (verdict.ok) break;
		}
		return out;
	};
	const pending = new Map<number, Promise<Array<{ candidate: Candidate; verdict: Verdict }>>>();
	const launch = (i: number): void => {
		const repo = order[i];
		if (repo !== undefined && !pending.has(i)) pending.set(i, evaluateRepo(repo));
	};
	const full = (): boolean => result.targets.length >= opts.n && result.controls.length >= opts.controls;
	let i = 0;
	for (; i < order.length && !full(); i++) {
		for (let k = i; k < i + Math.max(1, opts.concurrency); k++) launch(k);
		const repo = order[i] as string;
		const tried = await (pending.get(i) as Promise<Array<{ candidate: Candidate; verdict: Verdict }>>);
		pending.delete(i);
		result.examined += 1;
		for (const { verdict } of tried) {
			if (!verdict.ok) result.failures[verdict.filter] = (result.failures[verdict.filter] ?? 0) + 1;
		}
		const step: WalkStep = {
			repo,
			outcome: "ineligible",
			verdicts: tried.map(({ verdict }) => verdict.ok
				? { advisory: verdict.advisory, ok: true }
				: { advisory: verdict.advisory, ok: false, filter: verdict.filter, detail: verdict.detail }),
		};
		const hit = tried.find(({ verdict }) => verdict.ok) as { candidate: Candidate; verdict: Eligible } | undefined;
		let kept = false;
		if (hit) {
			result.eligible += 1;
			step.chosen = hit.verdict.advisory;
			if (result.targets.length < opts.n) {
				const used = perLanguage.get(hit.verdict.language) ?? 0;
				if (used >= opts.maxPerLanguage) step.outcome = "language stratum full";
				else {
					perLanguage.set(hit.verdict.language, used + 1);
					result.targets.push({ repo, candidate: hit.candidate, verdict: hit.verdict });
					step.outcome = "admitted";
					kept = true;
				}
			} else {
				// A control needs the whole history to show no other advisory is
				// still open, so it is checked only here, never speculatively.
				step.outcome = "control ineligible";
				const eligibleTries = tried.filter(({ verdict }) => verdict.ok) as Array<{ candidate: Candidate; verdict: Eligible }>;
				for (const { candidate, verdict } of eligibleTries) {
					const control = await ports.evaluateControl(repo, candidate, verdict);
					if (control.ok) {
						result.controls.push({ repo, candidate, verdict, control });
						step.outcome = "control";
						kept = true;
						break;
					}
					step.verdicts.push({ advisory: control.advisory, ok: false, filter: control.filter, detail: control.detail });
				}
			}
		}
		result.steps.push(step);
		ports.progress?.(`${String(result.examined).padStart(4)} ${step.outcome.padEnd(22)} ${repo}${step.chosen ? ` ${step.chosen}` : ""}`);
		await ports.release?.(repo, kept);
	}
	result.exhausted = !full();
	// Evaluations launched ahead of the stopping point still hold checkouts;
	// let them finish and release them so nothing is left half-written.
	for (const [j, p] of pending) {
		await p.catch(() => []);
		const repo = order[j];
		if (repo !== undefined) await ports.release?.(repo, false);
	}
	return result;
}

/** The target directory name: owner_repo plus a tag derived from the advisory, as fetch-apps.ts does. */
export function targetName(repo: string, advisory: string): string {
	const tag = [...advisory].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36).slice(0, 6);
	return `${repo.replace("/", "_")}-${tag}`.replace(/[^\w.-]/g, "_");
}

// --- IO -------------------------------------------------------------------------
//
// Everything below touches git, the network or the disk. It runs only when this
// file is executed, never when a test imports the module.

const exec = promisify(execFile);
const HERE = dirname(new URL(import.meta.url).pathname);
const FRESH = join(HERE, "fresh");
const REPO_ROOT = resolve(HERE, "../..");

// A repository that was deleted or made private answers a clone with a
// credential prompt, which would hang the walk forever. Refuse prompts instead.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GCM_INTERACTIVE: "never" };

/**
 * A failed git call, carrying the tail of git's own stderr and whether the
 * process was killed for its timeout — never the command line. Variant 1
 * matched a transient-failure pattern against Node's error message, which
 * quotes the command and so the work path; `5\d\d` matched the digits of the
 * scratch directory, and every fetch failure read as transient.
 */
export class GitError extends Error {
	readonly stderrTail: string;
	readonly timedOut: boolean;
	constructor(stderrTail: string, timedOut: boolean) {
		super(stderrTail);
		this.stderrTail = stderrTail;
		this.timedOut = timedOut;
	}
}

/** git's stderr lines that mean the network failed, not the repository. */
const TRANSIENT_STDERR = /Could not resolve host|Connection (?:timed out|reset|refused)|Failed to connect|Couldn't connect to server|Operation (?:timed out|too slow)|timed out after|Empty reply from server|Recv failure|early EOF|RPC failed|HTTP\/2 stream|The requested URL returned error: (?:5\d\d|429)|remote end hung up unexpectedly|unexpected disconnect|gnutls_handshake|SSL_ERROR|SSL connect error|TLS connection|could not fetch [0-9a-f]+ from promisor remote/i;

export function isTransientGitFailure(err: unknown): boolean {
	if (err instanceof GitError) return err.timedOut || TRANSIENT_STDERR.test(err.stderrTail);
	// resolveSha's GitHub API errors: a rate limit or a server error is the network's.
	return /GitHub (?:403|429|5\d\d)\b/.test(String((err as Error)?.message ?? ""));
}

/** The last lines of a stderr, joined, at most 300 characters. */
export function stderrTail(stderr: string): string {
	return stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ").slice(-300);
}

/**
 * git with the settings every call here needs. The proxy is cleared for the
 * reason multikey.ts gives: the development machine's global config names a
 * SOCKS proxy that is usually down, and every fetch then fails in 0 ms.
 */
async function git(dir: string, args: string[], timeout = 600_000): Promise<string> {
	try {
		const { stdout } = await exec("git", [
			"-C", dir, "-c", "http.proxy=", "-c", "https.proxy=", "-c", "core.quotePath=false", "-c", "advice.detachedHead=false", ...args,
		], { env: GIT_ENV, timeout, maxBuffer: 1 << 28 });
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string; killed?: boolean; signal?: string | null; code?: unknown };
		const tail = stderrTail(String(e.stderr ?? ""));
		throw new GitError(tail || `git ${args[0]} exited ${String(e.code ?? e.signal ?? "abnormally")}`, Boolean(e.killed) || e.signal === "SIGTERM");
	}
}

/**
 * A fetch retried on the failures that are about the network rather than the
 * repository. Without the retry a dropped connection would read as "source not
 * obtainable", and the same seed could draw differently on a worse day.
 */
async function fetchRetrying(dir: string, args: string[], timeout: number): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try { await git(dir, ["fetch", "--quiet", ...args], timeout); return; }
		catch (err) {
			if (!isTransientGitFailure(err) || attempt >= 3) throw err;
			await new Promise((r) => setTimeout(r, 5_000 * attempt));
		}
	}
}

function argOf(argv: string[], name: string, fallback?: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

interface PoolFile { source: Record<string, unknown>; rule: string; sha256: string; advisories: PoolAdvisory[] }

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

/** One advisory per line: diffable, and small enough to commit. */
function poolText(pool: PoolFile): string {
	const head = { source: pool.source, rule: pool.rule, sha256: pool.sha256 };
	return `{\n"source": ${JSON.stringify(head.source)},\n"rule": ${JSON.stringify(head.rule)},\n"sha256": ${JSON.stringify(head.sha256)},\n"advisories": [\n${pool.advisories.map((a) => JSON.stringify(a)).join(",\n")}\n]\n}\n`;
}

// --- pool ---

async function cmdPool(argv: string[]): Promise<void> {
	const zip = argOf(argv, "zip");
	const out = argOf(argv, "out", join(FRESH, "pool.json")) as string;
	if (!zip) throw new Error("usage: pool --zip <OSV GIT all.zip> [--headers <curl -D file>] [--url URL] [--out pool.json]");
	const headersText = argOf(argv, "headers") ? await readFile(argOf(argv, "headers") as string, "utf8") : "";
	const header = (name: string): string | undefined => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "im").exec(headersText)?.[1];
	const zipHash = createHash("sha256").update(await readFile(zip)).digest("hex");
	const tmp = join(dirname(resolve(zip)), `.pool-extract-${process.pid}`);
	await rm(tmp, { recursive: true, force: true });
	await mkdir(tmp, { recursive: true });
	try {
		await exec("unzip", ["-q", "-o", zip, "CVE-*", "-d", tmp], { timeout: 1_800_000, maxBuffer: 1 << 26 });
		const files = (await readdir(tmp)).filter((f) => f.endsWith(".json")).sort();
		const advisories: PoolAdvisory[] = [];
		for (const f of files) {
			const rec = JSON.parse(await readFile(join(tmp, f), "utf8")) as OsvRecord;
			const a = poolAdvisory(rec);
			if (a) advisories.push(a);
		}
		advisories.sort((a, b) => a.id.localeCompare(b.id));
		const pool: PoolFile = {
			source: {
				url: argOf(argv, "url", "https://osv-vulnerabilities.storage.googleapis.com/GIT/all.zip"),
				last_modified: header("last-modified") ?? null,
				etag: header("etag") ?? null,
				zip_sha256: zipHash,
				cve_records: files.length,
			},
			rule: "CVE-* records of the OSV GIT export with at least one reference typed FIX to a github.com/<owner>/<repo>/commit/<sha> URL",
			sha256: poolHash(advisories),
			advisories,
		};
		await mkdir(dirname(out), { recursive: true });
		await writeFile(out, poolText(pool));
		process.stdout.write(`pool: ${advisories.length} advisories from ${files.length} CVE records · sha256 ${pool.sha256.slice(0, 16)} → ${out}\n`);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
}

// --- exclusions ---

/** Default sources: the paths on the machine where pired was developed. */
const OFFICIAL_MANIFEST = "/home/mamgad/pired-v5c/eval/artifacts/claude-handoff-2026-09-23/research/corpus/manifest.json";
const HELDOUT_MANIFEST = "/home/mamgad/pired/eval/heldout/manifest-2026-09-24.json";
const OLD_POOL = "/home/mamgad/corpus";
const DEV_CHECKOUTS = ["DVBank", "DVBLab", "DVWA", "WebGoat", "juice-shop"].map((d) => `/home/mamgad/${d}`);

/** The note paths whose every historical version is scanned for names. */
const NOTE_PATHSPECS = ["research", "docs", "eval/*.md", "eval/corpus/*.ts", "*.md"];

/**
 * Paths never scanned: this procedure's own outputs (they name the drawn
 * targets, so scanning them would exclude the draw from itself), and the
 * held-out directory, whose manifest is read for names only, below.
 */
const NOT_SCANNED = /^(eval\/corpus\/fresh(\/|\.md$)|eval\/corpus\/select-fresh|eval\/heldout\/|eval\/artifacts\/)/;

async function listPaths(root: string, depth: number): Promise<string[]> {
	const out: string[] = [];
	const rec = async (dir: string, d: number): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const p = join(dir, e.name);
			out.push(relative(root, p));
			if (e.isDirectory() && d < depth) await rec(p, d + 1);
		}
	};
	await rec(root, 1);
	return out.sort();
}

async function cmdExclusions(argv: string[]): Promise<void> {
	const poolPath = argOf(argv, "pool", join(FRESH, "pool.json")) as string;
	const out = argOf(argv, "out", join(FRESH, "exclusions.json")) as string;
	const officialPath = argOf(argv, "official", OFFICIAL_MANIFEST) as string;
	const heldoutPath = argOf(argv, "heldout", HELDOUT_MANIFEST) as string;
	const oldPool = argOf(argv, "old-pool", OLD_POOL) as string;
	const gitRepo = argOf(argv, "repo", REPO_ROOT) as string;

	const pool = await readJson<PoolFile>(poolPath);
	const poolRepos = [...new Set(pool.advisories.flatMap((a) => a.fixes.map((f) => repoKey(repoOf(f)))))].sort();
	const matched = new Map<string, Set<string>>();
	const mark = (repo: string, why: string): void => {
		const k = repoKey(repo);
		matched.set(k, (matched.get(k) ?? new Set()).add(why));
	};
	const sources: Array<Record<string, unknown>> = [];

	// 1–2. The graded targets. Held-out: id, name, repo and package only.
	const targets: Array<Record<string, string>> = [];
	for (const [label, path] of [["official v5 manifest", officialPath], ["held-out manifest", heldoutPath]] as const) {
		const raw = await readFile(path, "utf8");
		const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
		for (const r of rows) {
			const t = { source: label, id: String(r.id ?? ""), name: String(r.name ?? ""), repo: String(r.repo ?? r.package ?? "") };
			targets.push(t);
			if (t.repo) mark(t.repo, label);
		}
		sources.push({ source: label, path, sha256: sha256(raw), targets: rows.length });
	}

	// 3. The old pool: its index, and every directory, run log and note in it.
	const index = await readJson<Record<string, unknown>>(join(oldPool, "index.json"));
	for (const repo of Object.keys(index)) mark(repo, "old pool index.json");
	const slugTexts: string[] = [];
	const paths = await listPaths(oldPool, 3);
	slugTexts.push(paths.join("\n"));
	let scannedFiles = 0;
	for (const e of await readdir(oldPool, { withFileTypes: true })) {
		if (!e.isFile()) continue;
		const p = join(oldPool, e.name);
		const st = await stat(p);
		if (st.size > 64 * 1024 * 1024) continue;
		const text = await readFile(p, "utf8").catch(() => "");
		if (text.includes("\u0000")) continue;
		slugTexts.push(text);
		scannedFiles += 1;
	}
	const slugIndex = mentionIndex(slugTexts.join("\n"));
	for (const repo of poolRepos) if (namePhrases(repo, false).some((p) => mentions(slugIndex, p))) mark(repo, "old pool run directories and logs");
	sources.push({ source: "old pool", path: oldPool, paths: paths.length, top_level_files: scannedFiles, rule: "owner/repo or owner_repo anywhere in a path name (depth 3) or top-level file" });

	// 4. Every version of every note in the repository's history, on every branch.
	const raw = await git(gitRepo, ["log", "--all", "--format=", "--raw", "--no-abbrev", "--", ...NOTE_PATHSPECS], 600_000);
	const blobs = new Map<string, string>();
	for (const line of raw.split("\n")) {
		const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]{40}) \w+\t(.+)$/.exec(line);
		if (!m || /^0+$/.test(m[1] as string)) continue;
		const path = (m[2] as string).split("\t").pop() as string;
		if (NOT_SCANNED.test(path)) continue;
		blobs.set(m[1] as string, path);
	}
	const heads = (await git(gitRepo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).trim().split("\n").filter(Boolean);
	const noteTexts: string[] = [];
	for (const blob of [...blobs.keys()].sort()) noteTexts.push(await git(gitRepo, ["cat-file", "blob", blob]));
	const noteIndex = mentionIndex(noteTexts.join("\n"));
	for (const repo of poolRepos) {
		const phrases = namePhrases(repo, true);
		if (phrases.slice(0, 2).some((p) => mentions(noteIndex, p))) mark(repo, "pired notes (slug)");
		else if (mentions(noteIndex, phrases[2] as string)) mark(repo, "pired notes (bare name)");
	}
	sources.push({ source: "pired notes", repo: gitRepo, pathspecs: NOTE_PATHSPECS, not_scanned: NOT_SCANNED.source, blobs: blobs.size, heads, sha256: sha256([...blobs.keys()].sort().join("\n")) });

	// 5. Deliberately vulnerable applications checked out beside pired.
	for (const dir of DEV_CHECKOUTS) {
		const url = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
		const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\s*$/.exec(url.trim());
		if (m) mark(`${m[1]}/${m[2]}`, "development checkout");
		sources.push({ source: "development checkout", path: dir, remote: url.trim() || null });
	}

	const repos = [...matched].map(([repo, why]) => ({ repo, why: [...why].sort() })).sort((a, b) => a.repo.localeCompare(b.repo));
	const inPool = repos.filter((r) => poolRepos.includes(r.repo)).length;
	const byWhy: Record<string, number> = {};
	for (const r of repos) for (const w of r.why) byWhy[w] = (byWhy[w] ?? 0) + 1;
	const doc = {
		rule: "A repository is excluded, whole, if any of its advisories or its name appears in a source below. When unsure, exclude.",
		pool_sha256: pool.sha256,
		sources,
		targets,
		counts: { excluded: repos.length, in_pool: inPool, by_source: byWhy },
		repos,
	};
	const text = `${JSON.stringify({ ...doc, sha256: sha256(canonical(repos.map((r) => r.repo))) }, null, 1)}\n`;
	await writeFile(out, text);
	process.stdout.write(`exclusions: ${repos.length} repositories (${inPool} in the pool) → ${out}\n${JSON.stringify(byWhy)}\n`);
}

// --- draw ---

interface ExclusionsFile { sha256: string; repos: Array<{ repo: string }> }

function workPaths(work: string, repo: string): { git: string; verdict: string; tree: string } {
	const slug = repoKey(repo).replace("/", "__");
	return { git: join(work, "git", slug), verdict: join(work, "verdicts", `${slug}.json`), tree: join(work, "tree", slug) };
}

async function ensureRepo(dir: string, repo: string): Promise<void> {
	if (existsSync(join(dir, ".git"))) return;
	await mkdir(dir, { recursive: true });
	await git(dir, ["init", "--quiet"]);
	await git(dir, ["remote", "add", "origin", `https://github.com/${repo}.git`]);
	// A partial clone: commits and trees now, blobs only for what is checked out.
	await git(dir, ["config", "remote.origin.promisor", "true"]);
	await git(dir, ["config", "remote.origin.partialclonefilter", "blob:none"]);
}

async function fullSha(dir: string, repo: string, sha: string): Promise<string> {
	if (sha.length === 40) return sha;
	const local = await git(dir, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).catch(() => "");
	if (local.trim().length === 40) return local.trim();
	const [owner, name] = repo.split("/") as [string, string];
	return resolveSha(owner, name, sha);
}

interface TreeFacts { scopeFiles: number; scopeLoc: number; language: string | undefined; service: ServiceFacts; vendored: number }

/** Only code and the root README in the working tree from here on (see sparsePatterns). */
async function sparseOn(dir: string): Promise<void> {
	await git(dir, ["config", "core.sparseCheckout", "true"]);
	await git(dir, ["config", "core.sparseCheckoutCone", "false"]);
	await mkdir(join(dir, ".git", "info"), { recursive: true });
	await writeFile(join(dir, ".git", "info", "sparse-checkout"), `${sparsePatterns().join("\n")}\n`);
}

/** The whole tree again, for truth and for materialising a target. */
async function fullCheckout(dir: string, commit: string): Promise<void> {
	if ((await git(dir, ["config", "--get", "core.sparseCheckout"]).catch(() => "")).trim() === "true") {
		await git(dir, ["sparse-checkout", "disable"], 1_800_000);
	}
	await git(dir, ["checkout", "--quiet", "--force", "--detach", commit], 1_800_000);
}

/** A codeload tarball larger than this is abandoned for the git path, which fetches code blobs only. */
const TARBALL_MAX_BYTES = 300 * 1024 * 1024;

/** How long codeload may take to start a tarball, or pause inside one, before the git path is used instead. */
const TARBALL_STALL_MS = 60_000;

/**
 * The tree at `commit` from codeload.github.com, extracted into `dest`, or
 * false whenever codeload does not deliver it promptly and whole: an error
 * status, a response that does not start or stalls for TARBALL_STALL_MS, a
 * tarball over TARBALL_MAX_BYTES, a tar failure. False never decides a verdict:
 * the caller then takes the git path, which is the reference. So a codeload
 * problem only costs time, and is never mistaken for a fact about the
 * candidate or for a network failure.
 *
 * Why: partway through the second walk GitHub's partial-clone blob fetches
 * slowed from seconds to minutes per checkout (29.6 s for one tree whose
 * tarball took 4 s), which would have stretched the walk over hours. The
 * tarball is the same tree; treeFacts checks that it is, path by path.
 */
async function extractTarball(repo: string, commit: string, dest: string): Promise<boolean> {
	await rm(dest, { recursive: true, force: true });
	await mkdir(dest, { recursive: true });
	const abort = new AbortController();
	let timer = setTimeout(() => abort.abort(), TARBALL_STALL_MS);
	const touch = (): void => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), TARBALL_STALL_MS); };
	const tar = spawn("tar", ["-xzf", "-", "--strip-components=1", "-C", dest], { stdio: ["pipe", "ignore", "ignore"] });
	tar.stdin.on("error", () => undefined);
	const closed = new Promise<number>((done) => tar.on("close", (code) => done(code ?? 1)));
	const give = async (): Promise<boolean> => { tar.kill(); await closed; return false; };
	try {
		const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${commit}`, { signal: abort.signal });
		if (!res.ok || !res.body) return await give();
		let bytes = 0;
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			touch();
			bytes += chunk.length;
			if (bytes > TARBALL_MAX_BYTES) return await give();
			if (!tar.stdin.write(chunk)) await new Promise((r) => tar.stdin.once("drain", r));
		}
		tar.stdin.end();
		return (await closed) === 0;
	} catch {
		return await give();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Does the extracted tree hold every path the listing names? `git archive`,
 * which codeload serves, leaves out paths marked `export-ignore`; such a tree
 * is not the reviewed tree, and the git path is used instead.
 */
async function holdsListing(root: string, entries: readonly TreeEntry[]): Promise<boolean> {
	for (const e of entries) {
		if (e.mode === "160000") continue;
		if (!(await lstat(join(root, e.path)).then(() => true, () => false))) return false;
	}
	return true;
}

/**
 * Measure the tree at `commit` the way the corpus measures a target.
 *
 * Paths come from the tree's git listing. Contents come from the codeload
 * tarball when `repo` and `treeDir` are given and the tarball holds the
 * listing exactly; otherwise from a sparse git checkout of code and the root
 * README. Every rule reads a path, a code file or the README, so both give the
 * same facts; `recheck` compares verdicts across the two. Each code file is
 * read once, for its line count and for whether it is vendored
 * (isVendoredFile); vendored files are left out of size, language and routes.
 */
async function treeFacts(dir: string, commit: string, repo?: string, treeDir?: string): Promise<(TreeFacts & { root: string }) | { tooMany: number }> {
	const entries = parseLsTree(await git(dir, ["ls-tree", "-r", "-z", "--full-tree", commit]));
	const w = walkFromListing(entries);
	if (w.source.length > MAX_SOURCE_FILES) return { tooMany: w.source.length };
	let root = dir;
	if (repo && treeDir && await extractTarball(repo, commit, treeDir) && await holdsListing(treeDir, entries)) root = treeDir;
	else {
		await sparseOn(dir);
		await git(dir, ["checkout", "--quiet", "--force", "--detach", commit], 1_800_000);
	}
	const lines = new Map<string, number>();
	const vendored = new Set<string>();
	for (const f of new Set([...w.source, ...w.all.filter((p) => languageOf(p) && !NON_SOURCE.test(p))])) {
		const text = await readFile(join(root, f), "utf8").catch(() => "");
		lines.set(f, text.length === 0 ? 0 : text.split("\n").length);
		if (isVendoredFile(text)) vendored.add(f);
	}
	const source = w.source.filter((f) => !vendored.has(f));
	const byLanguage = new Map<string, number>();
	for (const [f, n] of lines) {
		if (vendored.has(f) || NON_SOURCE.test(f)) continue;
		const lang = languageOf(f) as string;
		byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + n);
	}
	const cls = await classify(root, w);
	const readme = readmePath(w.all);
	const readmeText = readme ? await readFile(join(root, readme), "utf8").catch(() => undefined) : undefined;
	return {
		scopeFiles: source.length,
		scopeLoc: source.reduce((n, f) => n + (lines.get(f) ?? 0), 0),
		language: dominantLanguage(byLanguage),
		service: serviceFacts(w.all, w.source, cls.routeFiles, vendored, readmeText),
		vendored: vendored.size,
		root,
	};
}

/** Import lines of every scorer-readable file a set of hunks touches, on both sides. */
async function importSides(dir: string, hunks: readonly Hunk[], from: string, to: string): Promise<ImportSides> {
	const pre = new Map<string, Set<number>>();
	const post = new Map<string, Set<number>>();
	for (const h of hunks) {
		if (h.oldFile && isLabelFile(h.oldFile) && !pre.has(h.oldFile)) pre.set(h.oldFile, importLines(h.oldFile, await git(dir, ["show", `${from}:${h.oldFile}`]).catch(() => "")));
		if (h.newFile && isLabelFile(h.newFile) && !post.has(h.newFile)) post.set(h.newFile, importLines(h.newFile, await git(dir, ["show", `${to}:${h.newFile}`]).catch(() => "")));
	}
	return { pre, post };
}

/**
 * Labels for the change `from`..`to`, with each touched file's import lines
 * loaded from both sides so import-only hunks can be dropped (importOnly).
 */
async function fixLabels(dir: string, advisory: string, from: string, to: string, side: "pre" | "post" = "pre"): Promise<{ labels: Label[]; unscoreable: number; imports: number }> {
	const hunks = parseZeroContextDiff(await git(dir, ["diff", "--unified=0", "--no-color", from, to]));
	return labelsFromHunks(advisory, hunks, side, await importSides(dir, hunks, from, to));
}

/**
 * An open advisory's fix regions (neutralRegions), moved onto the reviewed
 * tree by the multikey rule; regions whose code changed in between cannot be
 * placed and are counted, not guessed.
 */
async function regionsOnReviewed(dir: string, advisory: string, fixParent: string, fix: string, reviewed: string): Promise<{ kept: Label[]; unplaced: number }> {
	const hunks = parseZeroContextDiff(await git(dir, ["diff", "--unified=0", "--no-color", fixParent, fix]));
	const regions = neutralRegions(advisory, hunks, await importSides(dir, hunks, fixParent, fix));
	if (fixParent === reviewed) return { kept: regions, unplaced: 0 };
	const diffs = new Map<string, string>();
	for (const file of new Set(regions.map((r) => r.file))) diffs.set(file, await git(dir, ["diff", "--unified=0", "--no-color", reviewed, fixParent, "--", file]));
	const { kept, dropped } = mapLabelsBack(regions, diffs);
	return { kept, unplaced: dropped.length };
}

const inRange = (loc: number): boolean => loc >= SIZE_RANGE[0] && loc <= SIZE_RANGE[1];

function cacheFileOf(work: string, repo: string, c: Candidate): string {
	return `${workPaths(work, repo).verdict}.${c.advisory.id}.${c.sha.slice(0, 12)}.v${RULES_VERSION}`;
}

const errDetail = (err: unknown): string => String((err as Error)?.message ?? err).split("\n")[0]?.slice(0, 300) ?? "";

/**
 * Run `fn`, retrying a network failure (isTransientGitFailure) twice with a
 * pause, and stopping the walk if it persists. A verdict must be a fact about
 * the candidate: recording "not obtainable" because DNS failed for a minute
 * would make the same seed draw differently on a worse day. A stopped walk has
 * written nothing and resumes from the verdict cache.
 */
async function withNetworkRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try { return await fn(); }
		catch (err) {
			if (!isTransientGitFailure(err)) throw err;
			if (attempt >= 3) throw new Error(`network failure on ${what} after 3 attempts; the walk stops here and resumes from the cache: ${errDetail(err)}`);
			await new Promise((r) => setTimeout(r, 15_000 * attempt));
		}
	}
}

async function evaluateCandidate(work: string, repo: string, c: Candidate, useCache = true): Promise<Verdict> {
	const id = c.advisory.id;
	const paths = workPaths(work, repo);
	const cacheFile = cacheFileOf(work, repo, c);
	if (useCache && existsSync(cacheFile)) return readJson<Verdict>(cacheFile);
	const fail = (filter: WalkFilter, detail: string): Ineligible => ({ ok: false, advisory: id, filter, detail });
	const once = async (): Promise<Verdict> => {
		await ensureRepo(paths.git, c.repo);
		const fix = await fullSha(paths.git, c.repo, c.sha);
		await fetchRetrying(paths.git, ["--depth", "2", "--filter=blob:none", "origin", fix], 900_000);
		const parent = (await git(paths.git, ["rev-parse", "--verify", `${fix}^1`])).trim();
		const facts = await treeFacts(paths.git, parent, c.repo, paths.tree);
		if ("tooMany" in facts) return fail("size within the official range", `${facts.tooMany} source files`);
		if (!inRange(facts.scopeLoc)) return fail("size within the official range", `${facts.scopeLoc} loc${facts.vendored > 0 ? `, ${facts.vendored} vendored file(s) left out` : ""}`);
		const service = serviceVerdict(facts.service);
		if (service) return fail(service.filter, service.detail);
		if (!facts.language || !SCORER_LANGUAGES.has(facts.language)) return fail("language in the scorer's list", facts.language ?? "no code");
		const { labels, unscoreable, imports } = await fixLabels(paths.git, id, parent, fix);
		if (labels.length === 0) {
			return fail("labellable fix", imports > 0 ? `${imports} import-only hunk(s) and no other code change in a file the scorer reads`
				: unscoreable > 0 ? `${unscoreable} code hunk(s), none in a file the scorer reads` : "no code line changed in a source file");
		}
		if (labels.length > MAX_LABELS_PER_ADVISORY) return fail("fix not diffuse", `${labels.length} labels`);
		const ids = [id, ...c.advisory.aliases];
		for (const l of labels) {
			const text = await readFile(join(facts.root, l.file), "utf8").catch(() => undefined);
			if (text === undefined) return fail("labellable fix", `${l.file} absent from the parent tree`);
			if (wouldStrip(l.file, text, ids)) return fail("labels survive leak stripping", l.file);
		}
		return {
			ok: true, advisory: id, fix, parent, language: facts.language, scopeFiles: facts.scopeFiles, scopeLoc: facts.scopeLoc,
			routes: facts.service.routeFiles, labels, unscoreable, importOnly: imports, deploy: facts.service.deploy, vendored: facts.vendored,
		};
	};
	let verdict: Verdict;
	try { verdict = await withNetworkRetry(`${repo} ${id}`, once); }
	catch (err) {
		if (/the walk stops here/.test(String((err as Error).message))) throw err;
		// Any other failure — a deleted repository, a commit GitHub will not
		// serve, a root commit with no parent — is a fact about the candidate.
		verdict = fail("source obtainable at the parent commit", errDetail(err));
	}
	if (useCache) {
		await mkdir(dirname(cacheFile), { recursive: true });
		await writeFile(cacheFile, JSON.stringify(verdict));
	}
	return verdict;
}

async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
	try { await git(dir, ["merge-base", "--is-ancestor", a, b]); return true; }
	catch { return false; }
}

const hasCommit = (dir: string, sha: string): Promise<boolean> =>
	git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);

/**
 * The project's whole history, blob-less, with `commits` present in it. The
 * walk's checkouts are two commits deep; ancestry questions — is this other
 * advisory still open here? — need everything. A verdict replayed from the
 * cache may also have had its checkout released, so this starts from nothing
 * when it has to.
 */
async function ensureHistory(dir: string, repo: string, commits: readonly string[]): Promise<void> {
	await ensureRepo(dir, repo);
	if (existsSync(join(dir, ".git", "shallow"))) await fetchRetrying(dir, ["--filter=blob:none", "--unshallow", "origin"], 1_800_000);
	else if (!(await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false)) && !existsSync(join(dir, ".git", "refs", "remotes", "origin"))) {
		await fetchRetrying(dir, ["--filter=blob:none", "origin"], 1_800_000);
	}
	for (const c of commits) {
		if (!(await hasCommit(dir, c))) await fetchRetrying(dir, ["--filter=blob:none", "origin", c], 1_800_000);
	}
}

/** Another advisory's fix, resolved in the local history, or "" when it is not there. */
async function resolveInHistory(dir: string, repo: string, sha: string): Promise<string> {
	const full = await fullSha(dir, repo, sha).catch(() => "");
	if (!full) return "";
	if (await hasCommit(dir, full)) return full;
	// Branch heads carry most fixes; one landed only on a tag or a pull ref
	// is fetched by name before it is given up on.
	await fetchRetrying(dir, ["--filter=blob:none", "origin", full], 900_000).catch(() => undefined);
	return (await hasCommit(dir, full)) ? full : "";
}

async function evaluateControl(work: string, pool: readonly PoolAdvisory[], repo: string, c: Candidate, e: Eligible): Promise<ControlVerdict> {
	return withNetworkRetry(`${repo} ${c.advisory.id} (control)`, () => evaluateControlOnce(work, pool, repo, c, e));
}

async function evaluateControlOnce(work: string, pool: readonly PoolAdvisory[], repo: string, c: Candidate, e: Eligible): Promise<ControlVerdict> {
	const id = c.advisory.id;
	const dir = workPaths(work, repo).git;
	const fail = (filter: ControlFilter, detail: string): ControlIneligible => ({ ok: false, advisory: id, filter, detail });
	try { await ensureHistory(dir, c.repo, [e.fix]); }
	catch (err) {
		if (isTransientGitFailure(err)) throw err;
		return fail("history obtainable", errDetail(err));
	}
	// Every other advisory of this project in the pool, whatever the metadata
	// filters made of it: a control is clean only if all of them are fixed in it.
	const others = pool.filter((a) => a.id !== id && a.fixes.some((f) => repoKey(repoOf(f)) === repoKey(repo)));
	for (const a of others) {
		for (const f of a.fixes.filter((x) => repoKey(repoOf(x)) === repoKey(repo))) {
			const full = await resolveInHistory(dir, c.repo, shaOf(f));
			if (!full) return fail("no other known advisory open in the fixed tree", `${a.id}: fix ${shaOf(f).slice(0, 12)} not in the history`);
			if (!(await isAncestor(dir, full, e.fix))) return fail("no other known advisory open in the fixed tree", `${a.id} fixed after or beside it`);
		}
	}
	let facts: (TreeFacts & { root: string }) | { tooMany: number };
	try { facts = await treeFacts(dir, e.fix, c.repo, workPaths(work, repo).tree); }
	catch (err) {
		if (isTransientGitFailure(err)) throw err;
		return fail("fixed tree obtainable", errDetail(err));
	}
	if ("tooMany" in facts) return fail("fixed tree within the official range", `${facts.tooMany} source files`);
	if (!inRange(facts.scopeLoc)) return fail("fixed tree within the official range", `${facts.scopeLoc} loc`);
	const service = serviceVerdict(facts.service);
	if (service) return fail("fixed tree is a served application", `${service.filter}: ${service.detail}`);
	if (!facts.language || !SCORER_LANGUAGES.has(facts.language)) return fail("fixed tree language in the scorer's list", facts.language ?? "no code");
	const fixedRegions = (await fixLabels(dir, id, e.parent, e.fix, "post")).labels;
	return { ok: true, advisory: id, commit: e.fix, language: facts.language, scopeFiles: facts.scopeFiles, scopeLoc: facts.scopeLoc, routes: facts.service.routeFiles, fixedRegions };
}

interface Selection {
	procedure: string;
	rules_version: number;
	seed: number;
	parameters: Record<string, unknown>;
	pool: Record<string, unknown>;
	exclusions: Record<string, unknown>;
	date_rule: Record<string, unknown>;
	counts: { metadata: FilterCount[]; walk: Record<string, unknown> };
	published: Record<string, unknown>;
	targets: Array<Record<string, unknown>>;
	controls: Array<Record<string, unknown>>;
	walk: WalkStep[];
	variants: unknown[];
}

async function runWalk(pool: PoolFile, excluded: Set<string>, since: string | undefined, seed: number, opts: DrawOptions, work: string) {
	const { candidates, counts } = metadataFilter(pool.advisories, excluded, since);
	const order = repoOrder(candidates.keys(), seed);
	const ports: DrawPorts = {
		evaluate: (repo, c) => evaluateCandidate(work, repo, c),
		evaluateControl: (repo, c, e) => evaluateControl(work, pool.advisories, repo, c, e),
		release: async (repo, kept) => {
			await rm(workPaths(work, repo).tree, { recursive: true, force: true });
			if (!kept) await rm(workPaths(work, repo).git, { recursive: true, force: true });
		},
		progress: (line) => process.stdout.write(`${line}\n`),
	};
	const result = await drawSequential(order, (repo) => candidates.get(repo) ?? [], ports, opts);
	return { candidates, counts, result };
}

async function cmdDraw(argv: string[]): Promise<void> {
	const poolPath = argOf(argv, "pool", join(FRESH, "pool.json")) as string;
	const exclPath = argOf(argv, "exclusions", join(FRESH, "exclusions.json")) as string;
	const out = argOf(argv, "out", join(FRESH, "selection.json")) as string;
	const work = resolve(argOf(argv, "work", "/tmp/pired-fresh-work") as string);
	const seed = Number(argOf(argv, "seed", String(DEFAULT_SEED)));
	const n = Number(argOf(argv, "n", String(DEFAULT_N)));
	const controls = Number(argOf(argv, "controls", String(DEFAULT_CONTROLS)));
	const since = argOf(argv, "published-since", DEFAULT_PUBLISHED_SINCE) as string;
	const concurrency = Number(argOf(argv, "concurrency", "6"));
	if (existsSync(out) && !argv.includes("--variant")) {
		throw new Error(`${out} exists. Nothing is re-drawn after a draw; pass --variant to log a re-draw beside it.`);
	}
	const poolRaw = await readFile(poolPath, "utf8");
	const pool = JSON.parse(poolRaw) as PoolFile;
	if (poolHash(pool.advisories) !== pool.sha256) throw new Error("pool.json does not match its own sha256");
	const exclRaw = await readFile(exclPath, "utf8");
	const excl = JSON.parse(exclRaw) as ExclusionsFile;
	const excluded = new Set(excl.repos.map((r) => repoKey(r.repo)));
	const opts: DrawOptions = { n, controls, maxPerLanguage: Math.max(1, Math.floor(n / 2)), triesPerRepo: TRIES_PER_REPO, concurrency, seed };

	process.stdout.write(`draw · seed ${seed} · n ${n} + ${controls} controls · cutoff ${since || "none"}\n`);
	let walked = await runWalk(pool, excluded, since || undefined, seed, opts, work);
	const candidateRepos = walked.candidates.size;
	const rule = since
		? dateRuleHolds(walked.result.eligible, walked.result.examined, candidateRepos, n + controls)
		: { holds: false, lower: 0, estimate: 0, required: 3 * (n + controls) };
	const dateRule: Record<string, unknown> = {
		cutoff: since || null,
		rule: "keep the cutoff only if the eligible repositories it leaves, estimated as the walk's Wilson 95% lower-bound yield times the candidate repositories, are at least 3x the draw (targets + controls)",
		candidate_repos: candidateRepos,
		examined: walked.result.examined,
		eligible: walked.result.eligible,
		wilson_lower: Number(rule.lower.toFixed(4)),
		estimate: rule.estimate,
		required: rule.required,
		exhausted: walked.result.exhausted,
		holds: since ? rule.holds && !walked.result.exhausted : false,
	};
	if (since && !dateRule.holds) {
		process.stdout.write(`cutoff ${since} does not hold (estimate ${rule.estimate} < ${rule.required}); walking without it\n`);
		walked = await runWalk(pool, excluded, undefined, seed, opts, work);
	}
	const { counts, result, candidates } = walked;
	const allCandidates = [...candidates.values()].flat();
	const describe = (repo: string, c: Candidate, v: Eligible) => ({
		repo: c.repo, id: c.advisory.id, aliases: c.advisory.aliases, published: c.advisory.published, cwe: c.advisory.cwe,
		severity: c.advisory.severity, fix_commit: v.fix, parent_commit: v.parent, language: v.language,
		scope_files: v.scopeFiles, scope_loc: v.scopeLoc, routes: v.routes, labels: v.labels.length, unscoreable_hunks: v.unscoreable,
		name: targetName(c.repo, c.advisory.id), key: repo,
	});
	const selection: Selection = {
		procedure: "eval/corpus/select-fresh.ts draw",
		rules_version: RULES_VERSION,
		seed,
		parameters: {
			n, controls, max_per_language: opts.maxPerLanguage, tries_per_repo: TRIES_PER_REPO, size_range: SIZE_RANGE,
			max_source_files: MAX_SOURCE_FILES, label_max_lines: LABEL_MAX_LINES, merge_gap: MERGE_GAP,
			max_labels_per_advisory: MAX_LABELS_PER_ADVISORY, scorer_ext: SCORER_EXT.source, published_since_tried: since || null,
		},
		pool: { path: relative(REPO_ROOT, resolve(poolPath)), sha256: pool.sha256, file_sha256: sha256(poolRaw), source: pool.source, advisories: pool.advisories.length },
		exclusions: { path: relative(REPO_ROOT, resolve(exclPath)), sha256: excl.sha256, file_sha256: sha256(exclRaw), repos: excluded.size },
		date_rule: dateRule,
		counts: {
			metadata: counts,
			walk: {
				examined_repos: result.examined,
				eligible_repos: result.eligible,
				advisory_failures: Object.fromEntries([...WALK_FILTERS, ...CONTROL_FILTERS].map((f) => [f, result.failures[f] ?? 0])),
				outcomes: result.steps.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.outcome]: (acc[s.outcome] ?? 0) + 1 }), {}),
				exhausted: result.exhausted,
			},
		},
		published: {
			candidates_by_year: yearHistogram(allCandidates.map((c) => c.advisory.published)),
			drawn: result.targets.map((t) => t.candidate.advisory.published),
			controls: result.controls.map((t) => t.candidate.advisory.published),
		},
		targets: result.targets.map((t) => describe(t.repo, t.candidate, t.verdict)),
		controls: result.controls.map((t) => ({ ...describe(t.repo, t.candidate, t.verdict), control_commit: t.control.commit, control_scope_loc: t.control.scopeLoc, control_language: t.control.language, fixed_regions: t.control.fixedRegions.length })),
		walk: result.steps,
		variants: [],
	};
	if (existsSync(out)) {
		// A re-draw never replaces the pre-registered one: it is appended as a variant.
		const prior = await readJson<Selection>(out);
		prior.variants.push({ logged: new Date().toISOString(), reason: argOf(argv, "variant-reason", "unstated"), selection: { ...selection, variants: undefined } });
		await writeFile(out, `${JSON.stringify(prior, null, 1)}\n`);
		process.stdout.write(`variant appended to ${out}\n`);
		return;
	}
	await writeFile(out, `${JSON.stringify(selection, null, 1)}\n`);
	process.stdout.write(`\nselection: ${result.targets.length} targets + ${result.controls.length} controls from ${result.examined} examined repositories → ${out}\n`);
}

// --- truth ---

interface LabelProvenance { advisory: string; file: string; range: [number, number]; raw: [number, number]; capped: boolean; hunks: number }

/**
 * The selection a command reads: 1 is the pre-registered draw, n > 1 the
 * variant appended (n - 1)th. The default is the latest, which is the one in
 * force; the manifests record which it was.
 */
function selectionVariant(sel: Selection, index?: number): { index: number; selection: Selection } {
	const variants = (sel.variants ?? []) as Array<{ selection: Selection }>;
	const n = index ?? variants.length + 1;
	if (n === 1) return { index: 1, selection: sel };
	const v = variants[n - 2];
	if (!v) throw new Error(`selection.json has no variant ${n}; it has ${variants.length + 1}`);
	return { index: n, selection: v.selection };
}

/**
 * OSV's by-commit query: every record whose affected git ranges include
 * `commit`. Read for ids, aliases and FIX references only.
 */
async function osvByCommit(commit: string): Promise<OsvRecord[]> {
	const out: OsvRecord[] = [];
	let token: string | undefined;
	for (let page = 0; page < 50; page++) {
		const res = await fetch("https://api.osv.dev/v1/query", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ commit, ...(token ? { page_token: token } : {}) }),
		});
		if (!res.ok) throw new Error(`OSV by-commit ${res.status} for ${commit.slice(0, 12)}`);
		const body = (await res.json()) as { vulns?: OsvRecord[]; next_page_token?: string };
		out.push(...(body.vulns ?? []));
		token = body.next_page_token;
		if (!token) break;
	}
	return out;
}

interface OpenWithoutLabels { why: string; regions: Label[]; aliases: string[] }

const relabel = (regions: readonly Label[], advisory: string): Label[] => regions.map((r) => ({ ...r, advisory }));

async function cmdTruth(argv: string[]): Promise<void> {
	const selPath = argOf(argv, "selection", join(FRESH, "selection.json")) as string;
	const poolPath = argOf(argv, "pool", join(FRESH, "pool.json")) as string;
	const outDir = argOf(argv, "out", FRESH) as string;
	const work = resolve(argOf(argv, "work", "/tmp/pired-fresh-work") as string);
	const whole = await readJson<Selection>(selPath);
	const { index, selection: sel } = selectionVariant(whole, argOf(argv, "variant-index") ? Number(argOf(argv, "variant-index")) : undefined);
	const useOsv = !argv.includes("--no-osv");
	const pool = await readJson<PoolFile>(poolPath);
	const byId = new Map(pool.advisories.map((a) => [a.id, a]));
	await mkdir(join(outDir, "truth"), { recursive: true });

	const manifest: Array<Record<string, unknown>> = [];
	const twins: Array<Record<string, unknown>> = [];
	const provenance: Array<Record<string, unknown>> = [];
	for (const t of sel.targets) {
		const repo = String(t.repo);
		const id = String(t.id);
		const fix = String(t.fix_commit);
		const parent = String(t.parent_commit);
		const name = String(t.name);
		const dir = workPaths(work, String(t.key)).git;
		process.stdout.write(`${id} ${repo}\n`);
		await ensureHistory(dir, repo, [fix, parent]);
		const diffOf = (a: string, b: string, file?: string): Promise<string> =>
			git(dir, ["diff", "--unified=0", "--no-color", a, b, ...(file ? ["--", file] : [])]);

		const primary = (await fixLabels(dir, id, parent, fix)).labels;
		const primaryRegions = (await regionsOnReviewed(dir, id, parent, fix, parent)).kept;
		const collected: Label[] = [...primary];
		const credited = [id];
		const dropped: Array<Record<string, unknown>> = [];
		const open = new Map<string, OpenWithoutLabels>();
		const others = pool.advisories
			.filter((a) => a.id !== id && a.fixes.some((f) => repoKey(repoOf(f)) === repoKey(repo)))
			.sort((a, b) => (a.published ?? "").localeCompare(b.published ?? "") || a.id.localeCompare(b.id));
		for (const a of others) {
			const own: Label[] = [];
			const regions: Label[] = [];
			// The bound is on what the fix yields, as for a drawn advisory, not on
			// what survives mapping: a diffuse fix is diffuse wherever it lands.
			let yielded = 0;
			let shares = false;
			let isOpen = false;
			for (const f of a.fixes.filter((x) => repoKey(repoOf(x)) === repoKey(repo))) {
				const full = await resolveInHistory(dir, repo, shaOf(f));
				if (!full) {
					dropped.push({ advisory: a.id, why: `fix ${shaOf(f).slice(0, 12)} not in the history` });
					continue;
				}
				if (full === fix) { shares = true; continue; }
				// Rule 1: fixed after the reviewed tree, so still open in it.
				if (!(await isAncestor(dir, parent, `${full}^1`))) continue;
				isOpen = true;
				const fixParent = (await git(dir, ["rev-parse", `${full}^1`])).trim();
				const { labels } = await fixLabels(dir, a.id, fixParent, full);
				yielded += labels.length;
				// Rules 2 and 3: the same code in the reviewed tree, at lines that translate.
				const diffs = new Map<string, string>();
				for (const file of new Set(labels.map((l) => l.file))) diffs.set(file, await diffOf(parent, fixParent, file));
				const { kept, dropped: gone } = mapLabelsBack(labels, diffs);
				for (const g of gone) dropped.push({ advisory: a.id, file: g.file, range: g.range, why: "region changed between the reviewed tree and this fix" });
				own.push(...kept);
				regions.push(...(await regionsOnReviewed(dir, a.id, fixParent, full, parent)).kept);
			}
			if (shares) {
				// Its fix is the drawn advisory's: the same regions, which carry the
				// drawn advisory's id. Recorded as neutral under its own id too.
				credited.push(a.id);
				open.set(a.id, { why: "shares the drawn advisory's fix commit", regions: relabel(primaryRegions, a.id), aliases: a.aliases });
				continue;
			}
			if (!isOpen) continue;
			if (yielded > MAX_LABELS_PER_ADVISORY) {
				dropped.push({ advisory: a.id, why: `diffuse: its fix yields ${yielded} labels` });
				open.set(a.id, { why: `diffuse: its fix yields ${yielded} labels`, regions, aliases: a.aliases });
			} else if (own.length === 0) {
				open.set(a.id, { why: yielded === 0 ? "its fix changes no labellable code" : "every labelled region changed since the reviewed tree", regions, aliases: a.aliases });
			} else {
				collected.push(...own);
				credited.push(a.id);
			}
		}

		// Open by OSV's own account, whatever the pool made of the record.
		const osvNotes: Array<Record<string, unknown>> = [];
		if (useOsv) {
			const labelled = new Set(collected.map((l) => l.advisory));
			for (const rec of await osvByCommit(parent)) {
				const cid = canonicalId(rec);
				if (cid === id || labelled.has(cid) || open.has(cid)) continue;
				const aliases = [...new Set([rec.id, ...(rec.aliases ?? [])].filter((x) => x !== cid))];
				const shas = fixCommitsIn(rec, repo);
				const regions: Label[] = [];
				let placed = false;
				let fixedBefore = false;
				for (const sha of shas) {
					const full = await resolveInHistory(dir, repo, sha);
					if (!full) continue;
					if (full === fix) { regions.push(...relabel(primaryRegions, cid)); placed = true; continue; }
					if (!(await isAncestor(dir, parent, `${full}^1`))) { fixedBefore = true; continue; }
					const fixParent = (await git(dir, ["rev-parse", `${full}^1`])).trim();
					regions.push(...(await regionsOnReviewed(dir, cid, fixParent, full, parent)).kept);
					placed = true;
				}
				if (placed) open.set(cid, { why: "reported open by OSV's by-commit query", regions, aliases });
				else if (fixedBefore) osvNotes.push({ advisory: cid, why: "OSV by-commit reports it, but its FIX commit precedes the reviewed tree; not recorded" });
				else open.set(cid, { why: shas.length === 0 ? "reported open by OSV's by-commit query; no FIX commit to place it" : "reported open by OSV's by-commit query; FIX commit not in the history", regions: [], aliases });
			}
		}

		let labels = dedupeLabels(collected);
		// Every advisory credited or known open here is stripped when the tree is
		// built, so every label is checked against all of their ids.
		const ids = [...new Set([
			...credited.flatMap((c) => [c, ...(byId.get(c)?.aliases ?? [])]),
			...[...open].flatMap(([c, o]) => [c, ...o.aliases]),
		])];
		await fullCheckout(dir, parent);
		const survivors: Label[] = [];
		for (const l of labels) {
			const text = await readFile(join(dir, l.file), "utf8").catch(() => undefined);
			if (text === undefined || wouldStrip(l.file, text, ids)) { dropped.push({ advisory: l.advisory, file: l.file, range: l.range, why: "file removed by leak stripping" }); continue; }
			survivors.push(l);
		}
		labels = survivors;
		const labelledAdvisories = [...new Set(labels.map((l) => l.advisory))];
		const truth = toTruth(labels, byId);
		const neutral = [...open].flatMap(([advisory, o]) => o.regions.map((r) => ({ advisory, file: r.file, line_range: r.range, why: o.why })));
		await writeFile(join(outDir, "truth", `${name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
		await writeFile(join(outDir, "truth", `${name}.neutral.json`), `${JSON.stringify(neutral, null, 2)}\n`);
		const common = { package: repo, repo, scope: ["."], cwe: t.cwe, severity: t.severity ?? "", published: t.published, fix_commit: fix, variant: index };
		manifest.push({
			id, ...common, entries: truth.length, scope_files: t.scope_files, scope_loc: t.scope_loc, name,
			target: `PLACEHOLDER/corpus/${name}`, truth: `PLACEHOLDER/corpus/truth/${name}.truth.json`,
			reviewed_commit: parent, language: t.language, advisories: labelledAdvisories,
			neutral_advisories: open.size, neutral_regions: neutral.length, aliases: ids.filter((x) => x !== id).sort(),
		});

		// The patched twin: the same project at its fix commit.
		const facts = await treeFacts(dir, fix, repo, workPaths(work, String(t.key)).tree);
		const fixed = (await fixLabels(dir, id, parent, fix, "post")).labels;
		const twinName = `${name}-patched`;
		await writeFile(join(outDir, "truth", `${twinName}.truth.json`), "[]\n");
		twins.push({
			id, ...common, entries: 0, name: twinName, twin_of: name,
			scope_files: "tooMany" in facts ? null : facts.scopeFiles, scope_loc: "tooMany" in facts ? null : facts.scopeLoc,
			language: "tooMany" in facts ? null : facts.language,
			target: `PLACEHOLDER/corpus/${twinName}`, truth: `PLACEHOLDER/corpus/truth/${twinName}.truth.json`,
			reviewed_commit: fix, twin: true, aliases: ids.filter((x) => x !== id).sort(),
			fixed_regions: fixed.map((r) => ({ advisory: r.advisory, file: r.file, line_range: r.range })),
		});

		provenance.push({
			name, id, repo,
			labels: labels.map((l): LabelProvenance => ({ advisory: l.advisory, file: l.file, range: l.range, raw: l.raw, capped: l.capped, hunks: l.hunks })),
			credited, dropped,
			neutral: [...open].map(([advisory, o]) => ({ advisory, why: o.why, regions: o.regions.length })),
			osv_notes: osvNotes,
			twin: { name: twinName, fixed_regions: fixed.length },
		});
		process.stdout.write(`  ${truth.length} labels from ${labelledAdvisories.length} advisor${labelledAdvisories.length === 1 ? "y" : "ies"} · ${open.size} open without labels (${neutral.length} neutral regions) · twin ${fixed.length} fixed regions · ${dropped.length} dropped\n`);
	}

	// Separate controls from an earlier variant stay only if they pass the rules now in force.
	const controls: Array<Record<string, unknown>> = [];
	const considered: Array<Record<string, unknown>> = [];
	const carryFrom = argOf(argv, "carry-controls-from");
	if (carryFrom) {
		const drawn = new Set(sel.targets.map((t) => String(t.key)));
		for (const c of selectionVariant(whole, Number(carryFrom)).selection.controls) {
			const key = String(c.key);
			const a = byId.get(String(c.id));
			const f = a?.fixes.find((x) => repoKey(repoOf(x)) === key);
			if (drawn.has(key)) { considered.push({ name: c.name, kept: false, why: "drawn as a target in this variant" }); continue; }
			if (!a || !f) { considered.push({ name: c.name, kept: false, why: "advisory not in the pool" }); continue; }
			const cand: Candidate = { advisory: a, repo: repoOf(f), sha: shaOf(f) };
			const v = await evaluateCandidate(work, key, cand);
			if (!v.ok) { considered.push({ name: c.name, kept: false, why: `rules v${RULES_VERSION}: ${v.filter}: ${v.detail}` }); continue; }
			const cv = await evaluateControl(work, pool.advisories, key, cand, v);
			if (!cv.ok) { considered.push({ name: c.name, kept: false, why: `rules v${RULES_VERSION} control: ${cv.filter}: ${cv.detail}` }); continue; }
			considered.push({ name: c.name, kept: true, why: `passes rules v${RULES_VERSION}` });
			const name = String(c.name);
			await writeFile(join(outDir, "truth", `${name}.truth.json`), "[]\n");
			controls.push({
				id: a.id, package: cand.repo, repo: cand.repo, entries: 0, scope: ["."], cwe: a.cwe, severity: a.severity ?? "",
				published: a.published, fix_commit: v.fix, scope_files: cv.scopeFiles, scope_loc: cv.scopeLoc, name,
				target: `PLACEHOLDER/corpus/${name}`, truth: `PLACEHOLDER/corpus/truth/${name}.truth.json`,
				reviewed_commit: cv.commit, language: cv.language, control: true, carried_from_variant: Number(carryFrom), aliases: a.aliases,
				fixed_regions: cv.fixedRegions.map((r) => ({ advisory: r.advisory, file: r.file, line_range: r.range })),
			});
		}
	}

	const strip = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== "target" && k !== "truth"));
	await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	await writeFile(join(outDir, "targets.json"), `${JSON.stringify(manifest.map(strip), null, 2)}\n`);
	await writeFile(join(outDir, "twins.json"), `${JSON.stringify(twins, null, 2)}\n`);
	await writeFile(join(outDir, "controls.json"), `${JSON.stringify(controls, null, 2)}\n`);
	await writeFile(join(outDir, "labels.json"), `${JSON.stringify({
		rules_version: RULES_VERSION, variant: index, selection_sha256: sha256(await readFile(selPath, "utf8")), osv_by_commit: useOsv,
		targets: provenance, controls_considered: considered,
	}, null, 1)}\n`);
	process.stdout.write(`truth (variant ${index}): ${manifest.length} targets, ${twins.length} twins, ${controls.length} controls kept of ${considered.length} → ${outDir}\n`);
}

// --- materialise ---

/**
 * Build `<out>/<name>.pristine` for every target, twin and control: the
 * reviewed commit as a plain tree, history and release notes stripped with
 * every credited or known-open advisory's ids. The runner copies from
 * `.pristine`.
 */
async function cmdMaterialise(argv: string[]): Promise<void> {
	const dirIn = argOf(argv, "fresh", FRESH) as string;
	const out = resolve(argOf(argv, "out") ?? "");
	const work = resolve(argOf(argv, "work", "/tmp/pired-fresh-work") as string);
	if (!argOf(argv, "out")) throw new Error("usage: materialise --out <corpus dir> [--work DIR] [--fresh DIR]");
	const read = async (f: string): Promise<Array<Record<string, unknown>>> => (existsSync(join(dirIn, f)) ? readJson(join(dirIn, f)) : []);
	const entries = [...await read("manifest.json"), ...await read("twins.json"), ...await read("controls.json")];
	await mkdir(out, { recursive: true });
	for (const m of entries) {
		const name = String(m.name);
		const dir = workPaths(work, String(m.repo)).git;
		await ensureHistory(dir, String(m.repo), [String(m.reviewed_commit)]);
		await fullCheckout(dir, String(m.reviewed_commit));
		const dest = join(out, `${name}.pristine`);
		await rm(dest, { recursive: true, force: true });
		await cp(dir, dest, { recursive: true, filter: (src) => !src.split("/").includes(".git") });
		const removed = await stripLeakage(dest, { id: String(m.id), aliases: (m.aliases as string[] | undefined) ?? [] } as Advisory);
		const truth = await readJson<Array<{ file: string }>>(join(dirIn, "truth", `${name}.truth.json`));
		const regions = (m.fixed_regions as Array<{ file: string }> | undefined) ?? [];
		const missing = [...truth, ...regions].filter((e) => !existsSync(join(dest, e.file))).map((e) => e.file);
		process.stdout.write(`${name}.pristine  ${removed} leak file(s) stripped${missing.length ? `  MISSING: ${missing.join(", ")}` : ""}\n`);
	}
}

/**
 * Re-evaluate a seeded sample of cached verdicts from scratch, in a separate
 * work directory and without the cache, and report any that differ. Every
 * eligible verdict is always in the sample. This is how an implementation
 * change that must not change a rule is shown not to have.
 */
async function cmdRecheck(argv: string[]): Promise<void> {
	const work = resolve(argOf(argv, "work", "/tmp/pired-fresh-work") as string);
	const scratch = resolve(argOf(argv, "scratch", join(work, "recheck")) as string);
	const sample = Number(argOf(argv, "sample", "30"));
	const seed = Number(argOf(argv, "seed", "1"));
	const pool = await readJson<PoolFile>(argOf(argv, "pool", join(FRESH, "pool.json")) as string);
	const byId = new Map(pool.advisories.map((a) => [a.id, a]));
	const files = (await readdir(join(work, "verdicts"))).filter((f) => f.endsWith(`.v${RULES_VERSION}`)).sort();
	const rows = await Promise.all(files.map(async (f) => ({ f, v: await readJson<Verdict>(join(work, "verdicts", f)) })));
	const ok = rows.filter((r) => r.v.ok);
	const rest = seededShuffle(rows.filter((r) => !r.v.ok), mulberry32(seed)).slice(0, Math.max(0, sample - ok.length));
	let mismatches = 0;
	for (const { f, v } of [...ok, ...rest]) {
		const repo = (f.split(".json.")[0] as string).replace("__", "/");
		const a = byId.get(v.advisory);
		const fix = a?.fixes.find((x) => repoKey(repoOf(x)) === repo);
		if (!a || !fix) { process.stdout.write(`?  ${f}: not in the pool\n`); mismatches += 1; continue; }
		const again = await evaluateCandidate(scratch, repo, { advisory: a, repo: repoOf(fix), sha: shaOf(fix) }, false);
		await rm(workPaths(scratch, repo).git, { recursive: true, force: true });
		await rm(workPaths(scratch, repo).tree, { recursive: true, force: true });
		const same = canonical(again) === canonical(v);
		if (!same) mismatches += 1;
		process.stdout.write(`${same ? "=" : "≠"}  ${repo} ${v.advisory} ${v.ok ? "eligible" : v.filter}${same ? "" : `  →  ${again.ok ? "eligible" : `${again.filter}: ${again.detail}`}`}\n`);
	}
	process.stdout.write(`recheck: ${ok.length + rest.length} verdicts, ${mismatches} differ\n`);
	if (mismatches > 0) process.exitCode = 1;
}

/**
 * One advisory's verdict under the current rules, from scratch and uncached,
 * with `--control` also the control rules. Prints the verdict's rule and
 * counts, never labels. How a draw's earlier controls are re-checked against
 * a later rule set.
 */
async function cmdVerdict(argv: string[]): Promise<void> {
	const work = resolve(argOf(argv, "work", "/tmp/pired-fresh-work") as string);
	const pool = await readJson<PoolFile>(argOf(argv, "pool", join(FRESH, "pool.json")) as string);
	const repo = repoKey(argOf(argv, "repo") ?? "");
	const a = pool.advisories.find((x) => x.id === argOf(argv, "advisory"));
	const fix = a?.fixes.find((f) => repoKey(repoOf(f)) === repo);
	if (!a || !fix) throw new Error("usage: verdict --repo owner/name --advisory CVE-… [--control] (the advisory must be in the pool)");
	const c: Candidate = { advisory: a, repo: repoOf(fix), sha: shaOf(fix) };
	const v = await evaluateCandidate(work, repo, c, false);
	const out: Record<string, unknown> = v.ok
		? { rules_version: RULES_VERSION, repo, advisory: a.id, eligible: true, language: v.language, scope_loc: v.scopeLoc, labels: v.labels.length, import_only_hunks: v.importOnly, deploy: v.deploy, vendored: v.vendored }
		: { rules_version: RULES_VERSION, repo, advisory: a.id, eligible: false, filter: v.filter, detail: v.detail };
	if (v.ok && argv.includes("--control")) {
		const cv = await evaluateControl(work, pool.advisories, repo, c, v);
		out.control = cv.ok ? { eligible: true, commit: cv.commit, scope_loc: cv.scopeLoc, fixed_regions: cv.fixedRegions.length } : { eligible: false, filter: cv.filter, detail: cv.detail };
	}
	process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function main(): Promise<void> {
	const [cmd, ...argv] = process.argv.slice(2);
	if (cmd === "pool") return cmdPool(argv);
	if (cmd === "exclusions") return cmdExclusions(argv);
	if (cmd === "draw") return cmdDraw(argv);
	if (cmd === "truth") return cmdTruth(argv);
	if (cmd === "materialise") return cmdMaterialise(argv);
	if (cmd === "recheck") return cmdRecheck(argv);
	if (cmd === "verdict") return cmdVerdict(argv);
	process.stderr.write("usage: select-fresh.ts pool|exclusions|draw|truth|materialise|recheck|verdict [options]\n");
	process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
