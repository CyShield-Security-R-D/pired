#!/usr/bin/env -S node --experimental-strip-types
/**
 * Re-score existing runs at several location levels without touching the pinned scorer.
 *
 * eval/dvbank/score.ts keeps only the start of a `file:lo-hi` citation and grades
 * it through DVBank's detection grader at a ±3 window. That is the official
 * number and it stays pinned. But it cannot say whether a candidate that "lost"
 * a true positive was nowhere near the label or cited the right range starting
 * five lines early, and both answers change what the delegation grid means.
 *
 * So this reads the ledgers the runs left and scores the same claims at four
 * levels — same file, line ±3, line ±10, and claim-range overlapping a
 * width-capped label range — reporting unique labelled locations matched. The
 * control is `officialTp`, a line-for-line mirror of the pinned adapter plus the
 * grader, which must reproduce run.json `truePositives` on every valid run
 * before any other level is believed. See docs/delegation-v6-plan.md, task 1.1.
 *
 * Deliberate differences from the pinned path, all of which only matter above
 * the official level:
 *
 * - a `file:N-M` (or en dash) citation keeps its end; score.ts drops it.
 * - "lines N-M" in prose keeps its end as well.
 * - citations dedupe on file + start line, keeping the widest end, so the cap of
 *   three counts the same locations the pinned adapter counts.
 * - the levels match files by path-segment suffix; the official grader matches
 *   basenames, which lets `a/utils.py` hit a label in `b/utils.py`. `officialTp`
 *   keeps the basename rule, because reproducing the number is its only job.
 * - the levels ignore CWE/class: they measure location. The official grader
 *   refuses a location match when the truth file carries classes and the claim
 *   names a different one, and `officialTp` mirrors that. This is most of the gap
 *   between the official count and line±3: 8 of the corpus's 24 labels carry a
 *   CWE, score.ts keeps the finding's CWE whenever any label in that target file
 *   has one, and dropping the class rule changes the count in 45 of 160 runs.
 * - the levels count every truth a finding touches; the grader assigns each claim
 *   to at most one truth, greedily by distance. Two labels three lines apart can
 *   both be "found" by one citation here and only one of them officially.
 * - "line±3" and "line±10" window the label's whole `line_range`, not its
 *   primary line: [lo-3, hi+3] is what detection_grader.py actually does. The
 *   plan wrote the point form [line-3, line+3], which is kept as "point±3" so
 *   the two readings sit side by side. Measured on the seven v4/v5 grids the
 *   point form counts differently from the range form in 72 of 160 runs, while
 *   the range form agrees with the mirror in 159 once the class and basename
 *   rules are set aside (the one left is a citation touching two labels, which
 *   the grader credits once). This departs from the plan's contract, where
 *   line±3 was the control; the control is `officialTp` instead, pending the
 *   plan owner's decision (an amendment to task 1.1 and an ADR).
 * - the cost of the range form: line±3 and line±10 inherit the full width of an
 *   over-wide label (one spans 501 lines), so they can read above
 *   "range-overlap", which trims both the label and the claim to [lo, lo+cap].
 *   A claim deep inside a 500-line label that line±3 credits is exactly the
 *   match the cap exists to refuse; "point±3" is the reading without that
 *   inflation.
 * - a reversed range ("a.go:120-5") keeps 120 and drops the end, and prose
 *   "line 120 - 3 callers" is not a range, so the start of every citation is the
 *   line score.ts grades.
 * - claims are also capped at [lo, lo+cap] for range-overlap: over the ledgers of
 *   all valid runs, 59 of 2242 citations span more than 30 lines, and capping
 *   them changes range-overlap in 3 of 154 paired runs (138 labels to 134).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLAIMED_LOCATION_CAP } from "./dvbank/score.ts";

export interface Citation {
	file: string;
	lo: number;
	hi: number;
}

export interface Truth {
	id: string;
	file: string;
	line: number;
	lo: number;
	hi: number;
	/** Raw class fields; only the official mirror reads them. */
	cwe?: string;
	vulnClass?: string;
	/** The advisory the label belongs to (fresh-corpus keys); older keys derive it from the id. */
	advisory?: string;
	/** Every class of the advisory (fresh-corpus keys), for an any-of class level. */
	cwes?: string[];
}

export const LEVELS = ["file", "point±3", "line±3", "line±10", "range-overlap"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * The widest slice of a label range, and of a claim range, the overlap level
 * will honour: [lo, lo+cap]. Measured over the 24 labels of the seven v4/v5
 * grids, the widest span 501, 266, 111 and 98 lines; uncapped, one of those
 * would match any citation in its file and turn the overlap level into the file
 * level. A claim like `x.go:5-2026` does the same from the other side.
 */
export const DEFAULT_WIDTH_CAP = 30;

/** The official grader's window, both sides. */
const WINDOW = 3;

// The same extension list and path characters score.ts uses; a wider pattern
// would find citations the official path cannot see and break the control.
const EXT = "(?:py|pyi|js|jsx|ts|tsx|go|rb|php|java|cs|rs|kt|scala)";
const LOC = new RegExp(`([\\w./-]+\\.${EXT}):(\\d+)(?:[-–](\\d+))?`, "g");
const FILE = new RegExp(`[\\w./-]+\\.${EXT}\\b`, "g");
// score.ts reads prose as /\bline[s]?\s+(\d+)/ and nothing after it. The range
// tail here takes no spaces around the dash: "at line 120 - 3 callers reach it"
// is a line and a sentence, not the range 120..3.
const PROSE_LINE = /\bline[s]?\s+(\d+)(?:[-–](\d+))?/i;

/**
 * The start is always the first number written, because it is the only number
 * score.ts grades. A reversed end ("a.go:120-5") is dropped to a point rather
 * than swapped: swapping would grade line 5 where the pinned adapter grades 120.
 */
function cite(file: string, lo: number, hi?: number): Citation {
	const end = hi === undefined || !Number.isFinite(hi) || hi < lo ? lo : hi;
	return { file, lo, hi: end };
}

/** Every `path:N` / `path:N-M` in the text, in order, nothing else. */
function locationsIn(text: string): Citation[] {
	return [...text.matchAll(LOC)].map((m) => cite(m[1] as string, Number(m[2]), m[3] === undefined ? undefined : Number(m[3])));
}

/**
 * The prose fallback score.ts applies when a record has no `file:line`: a line
 * stated as "line N", paired with the nearest file named before it, else the
 * first named after it. Pairing with the first file mentioned would grade a
 * record that walks through several files against the wrong one.
 */
function proseCitation(text: string): Citation | undefined {
	const line = PROSE_LINE.exec(text);
	if (!line) return undefined;
	let before: string | undefined;
	let after: string | undefined;
	for (const hit of text.matchAll(FILE)) {
		if (hit.index < line.index) before = hit[0];
		else after ??= hit[0];
	}
	const file = before ?? after;
	return file ? cite(file, Number(line[1]), line[2] === undefined ? undefined : Number(line[2])) : undefined;
}

/**
 * Dedupe on file + start line and cap. Keyed on the start, not the whole range:
 * score.ts sees only starts, so `a.go:10` and `a.go:10-20` are one location to
 * it, and keying on the range would let a restated citation push a genuine third
 * location past the cap.
 */
function dedupeCap(citations: Citation[], max: number): Citation[] {
	const out: Citation[] = [];
	for (const c of citations) {
		const seen = out.find((o) => o.file === c.file && o.lo === c.lo);
		if (seen) { if (c.hi > seen.hi) seen.hi = c.hi; continue; }
		if (out.length >= max) break;
		out.push({ ...c });
	}
	return out;
}

/**
 * The locations a piece of text cites: every `path:N`, `path:N-M` and
 * `path:N–M`, deduped, in order, capped at `max`; failing any, the prose
 * "line N" fallback. A file named without a line yields nothing — inventing a
 * line would let a file-only claim land in a label window by accident.
 */
export function parseCitations(text: string, max = CLAIMED_LOCATION_CAP): Citation[] {
	const found = locationsIn(text);
	if (found.length) return dedupeCap(found, max);
	const prose = proseCitation(text);
	return prose ? dedupeCap([prose], max) : [];
}

type Row = Record<string, unknown>;

/**
 * The inventory lookup score.ts builds: an element id, "METHOD path" and path
 * each resolve to the source file the element lives in, when that is a source
 * file at all.
 */
export function inventoryIndex(inventory: Row[]): Map<string, string> {
	const index = new Map<string, string>();
	const source = new RegExp(`\\.${EXT}$`);
	for (const rec of inventory) {
		const src = (rec.file ?? rec.path ?? rec.value) as string | undefined;
		if (!src || typeof src !== "string" || !source.test(src)) continue;
		index.set(rec.id as string, src);
		if (rec.path) index.set(`${(rec.method as string | undefined) ?? ""} ${rec.path as string}`.trim(), src);
		if (rec.path) index.set(rec.path as string, src);
	}
	return index;
}

/**
 * One ledger finding's citations, read exactly the way score.ts fromLedger reads
 * it: target, description, repro, title and evidence joined with spaces; the
 * first location from that text, else the prose fallback, else the inventory
 * file plus a prose line; then every `file:line` in the text and in `locations`.
 * A record whose own text yields no first location is dropped even if
 * `locations` carries one — the pinned adapter does the same, and the control
 * depends on it.
 */
export function citationsForRecord(f: Row, inventory: Map<string, string> = new Map(), max = CLAIMED_LOCATION_CAP): Citation[] {
	// Spread as score.ts spreads it: an evidence string becomes its characters.
	const evidence = (f.evidence ?? []) as Iterable<unknown>;
	const hay = [f.target, f.description, f.repro, f.title, ...evidence].filter(Boolean).join(" ");
	let first: Citation | undefined = locationsIn(hay)[0] ?? proseCitation(hay);
	if (!first && typeof f.target === "string") {
		const viaInventory = inventory.get(f.target);
		const line = PROSE_LINE.exec(hay);
		if (viaInventory && line) first = cite(viaInventory, Number(line[1]), line[2] === undefined ? undefined : Number(line[2]));
	}
	if (!first) return [];
	const fromLocations = Array.isArray(f.locations) ? (f.locations as unknown[]).map(String).join(" ") : "";
	return dedupeCap([first, ...locationsIn(`${hay} ${fromLocations}`)], max);
}

/** Path-segment suffix match: `backend/handlers/assets.go` is `handlers/assets.go`, not `xassets.go`. */
export function sameFile(a: string, b: string): boolean {
	const segs = (p: string) => p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
	const x = segs(a);
	const y = segs(b);
	if (!x.length || !y.length) return false;
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	return short.every((s, i) => s === long[long.length - short.length + i]);
}

/** Does one citation hit one label at this level. */
export function citationMatches(c: Citation, t: Truth, level: Level, cap = DEFAULT_WIDTH_CAP): boolean {
	if (!sameFile(c.file, t.file)) return false;
	switch (level) {
		case "file": return true;
		case "point±3": return c.lo >= t.line - WINDOW && c.lo <= t.line + WINDOW;
		case "line±3": return c.lo >= t.lo - 3 && c.lo <= t.hi + 3;
		case "line±10": return c.lo >= t.lo - 10 && c.lo <= t.hi + 10;
		case "range-overlap": {
			const hi = Math.min(t.hi, t.lo + cap) + WINDOW;
			return c.lo <= hi && Math.min(c.hi, c.lo + cap) >= t.lo - WINDOW;
		}
	}
}

/** Unique label ids matched: a finding matches a label when any of its citations does. */
export function matchUnique(findings: Citation[][], truths: Truth[], level: Level, cap = DEFAULT_WIDTH_CAP): Set<string> {
	const hit = new Set<string>();
	for (const t of truths) {
		if (findings.some((cs) => cs.some((c) => citationMatches(c, t, level, cap)))) hit.add(t.id);
	}
	return hit;
}

/**
 * Labels the overlap level trims, which a reader should question. `width` is
 * the number of lines spanned (hi - lo + 1); the overlap level keeps
 * [lo, lo+cap], cap + 1 lines, so a label is listed when it spans more.
 */
export function labelHygiene(truths: Truth[], cap = DEFAULT_WIDTH_CAP): Array<{ id: string; width: number }> {
	return truths.map((t) => ({ id: t.id, width: t.hi - t.lo + 1 })).filter((l) => l.width > cap + 1);
}

// --- Per advisory, neutral regions, patched twins ---------------------------
//
// Additive to the levels above and never read by the official mirror. The
// fresh v6 corpus (eval/corpus/fresh.md) labels several locations per advisory,
// records the regions of open advisories it could not label as neutral, and
// pairs each target with its patched twin.

/** The advisory a label belongs to: its own field, or the id without its `-n` suffix. */
export function advisoryOf(t: Truth): string {
	return t.advisory ?? t.id.replace(/-\d+$/, "");
}

/**
 * Advisories found at a level: an advisory is found when any of its labels is.
 * A fix that touched three places is one vulnerability; counting its labels
 * would score a review that found it once at a third.
 */
export function advisoriesFound(findings: Citation[][], truths: Truth[], level: Level, cap = DEFAULT_WIDTH_CAP): Set<string> {
	const matched = matchUnique(findings, truths, level, cap);
	return new Set(truths.filter((t) => matched.has(t.id)).map(advisoryOf));
}

/** A region where a claim is neither a true nor a false positive: an open advisory without labels. */
export interface Region { file: string; lo: number; hi: number; advisory?: string }

/** `<name>.neutral.json`: [{ advisory, file, line_range: [lo, hi], why }]. Absent means none. */
export function loadRegions(path: string): Region[] {
	if (!existsSync(path)) return [];
	const raw = JSON.parse(readFileSync(path, "utf8")) as Row[];
	return raw.map((r) => {
		const range = (r.line_range as unknown[] | undefined)?.map(Number) ?? [Number(r.line), Number(r.line)];
		const [a, b] = [range[0]!, range[1] ?? range[0]!];
		return { file: String(r.file), lo: Math.min(a, b), hi: Math.max(a, b), ...(r.advisory ? { advisory: String(r.advisory) } : {}) };
	});
}

const nearRegion = (file: string, line: number, r: { file: string; lo: number; hi: number }): boolean =>
	sameFile(file, r.file) && line >= r.lo - WINDOW && line <= r.hi + WINDOW;

/**
 * Each deduped claim (file:line, as score.ts dedupes) is a true positive when
 * it lands within ±3 of a label's range, neutral when it lands only within ±3
 * of a neutral region, and a false positive otherwise. Location only, like the
 * levels. Precision over the claims that are not neutral is `tp / (tp + fp)`:
 * a report of a real, known, open vulnerability the key could not label is
 * not counted against the reviewer.
 */
export function claimOutcomes(claims: Array<{ file: string; line: number }>, truths: Truth[], neutral: Region[]): { tp: number; neutral: number; fp: number } {
	const out = { tp: 0, neutral: 0, fp: 0 };
	const seen = new Set<string>();
	for (const c of claims) {
		const key = `${c.file}:${c.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (truths.some((t) => nearRegion(c.file, c.line, t))) out.tp += 1;
		else if (neutral.some((r) => nearRegion(c.file, c.line, r))) out.neutral += 1;
		else out.fp += 1;
	}
	return out;
}

export function precisionWithoutNeutral(o: { tp: number; fp: number }): number | null {
	return o.tp + o.fp === 0 ? null : o.tp / (o.tp + o.fp);
}

/**
 * A patched twin's control score: deduped claims within ±3 lines of the fixed
 * regions — the reviewer re-reporting a vulnerability that is no longer there —
 * with all claims per thousand lines of the twin's source beside it. Reported
 * per arm and never folded into precision: a twin has no labels to be precise
 * against.
 */
export function controlScore(claims: Array<{ file: string; line: number }>, fixedRegions: Region[], loc: number): { hits: number; claims: number; perKloc: number | null } {
	const unique = [...new Map(claims.map((c) => [`${c.file}:${c.line}`, c])).values()];
	const hits = unique.filter((c) => fixedRegions.some((r) => nearRegion(c.file, c.line, r))).length;
	return { hits, claims: unique.length, perKloc: loc > 0 ? unique.length / (loc / 1000) : null };
}

// --- The official mirror -------------------------------------------------

/** One graded claim, as score.ts hands it to the grader. */
export interface Claim {
	file: string;
	line: number;
	cwe?: string;
	vulnClass?: string;
}

const normCwe = (v: unknown): string | undefined => {
	if (typeof v === "number" && Number.isFinite(v)) return String(Math.trunc(v));
	if (typeof v !== "string") return undefined;
	return /(\d{1,7})/.exec(v)?.[1];
};
const normClass = (v: unknown): string | undefined => {
	if (typeof v !== "string") return undefined;
	const s = v.trim().toLowerCase();
	return s ? s.replace(/[\s_]+/g, "-") : undefined;
};
const base = (p: string) => basename(p.replace(/\\/g, "/").replace(/\/+$/, ""));
const gap = (fs: number, fe: number, lo: number, hi: number) => (fe < lo ? lo - fe : fs > hi ? fs - hi : 0);

/**
 * The official true-positive count, reproduced: claims deduped on file:line as
 * score.ts dedupe() does, class fields dropped when the truth file carries none,
 * basename + [start-3, end+3] window + class rule as detection_grader.py, and
 * each label and each claim assigned at most once, greedily by distance to the
 * label range then to its primary line.
 */
export interface MirrorOptions {
	/**
	 * "basename" is the grader's rule. "segments" swaps in sameFile, to count the
	 * official true positives that are only a basename collision: measured on the
	 * seven v4/v5 grids, handlers/assets.go credited against a 97-line label in
	 * services/assets.go, http/users.go against users/users.go, and
	 * storage/bolt/share.go against http/share.go.
	 */
	fileRule?: "basename" | "segments";
	/** false drops the class rule, to count location-correct claims it refused. */
	classRule?: boolean;
}

export function officialMatches(claims: Claim[], truths: Truth[], options: MirrorOptions = {}): Set<string> {
	const fileRule = options.fileRule ?? "basename";
	const classRule = options.classRule ?? true;
	const seen = new Set<string>();
	const unique = claims.filter((c) => {
		const key = `${c.file}:${c.line}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const classless = !classRule || truths.every((t) => !t.cwe && !t.vulnClass);
	const candidates: Array<[number, number, number, number]> = [];
	truths.forEach((t, ti) => {
		const tc = normCwe(t.cwe);
		const tk = normClass(t.vulnClass);
		unique.forEach((c, fi) => {
			if (fileRule === "basename" ? base(c.file) !== base(t.file) : !sameFile(c.file, t.file)) return;
			if (c.line < t.lo - WINDOW || c.line > t.hi + WINDOW) return;
			const fc = classless ? undefined : normCwe(c.cwe);
			const fk = classless ? undefined : normClass(c.vulnClass);
			const classOk = (fc === undefined && fk === undefined) || (fc !== undefined && fc === tc) || (fk !== undefined && fk === tk);
			if (!classOk) return;
			candidates.push([gap(c.line, c.line, t.lo, t.hi), gap(c.line, c.line, t.line, t.line), ti, fi]);
		});
	});
	candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
	const truthTaken = new Set<number>();
	const claimTaken = new Set<number>();
	for (const [, , ti, fi] of candidates) {
		if (truthTaken.has(ti) || claimTaken.has(fi)) continue;
		truthTaken.add(ti);
		claimTaken.add(fi);
	}
	return new Set([...truthTaken].map((ti) => truths[ti]!.id));
}

// --- Reading runs ----------------------------------------------------------

function readJsonl(path: string): Row[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const rec = JSON.parse(line) as unknown;
			return rec && typeof rec === "object" ? [rec as Row] : [];
		} catch { return []; }
	});
}

/**
 * Live records the way Workspace.read folds a store: last write wins per id, in
 * first-seen order, tombstones removed. Reading raw lines would grade a finding
 * the reviewer later rewrote at both its old and new locations.
 */
export function liveRecords(rows: Row[]): Row[] {
	const byId = new Map<string, Row>();
	for (const r of rows) if (typeof r.id === "string") byId.set(r.id, r);
	return [...byId.values()].filter((r) => r.deleted !== true);
}

/** Every ledger finding and its class fields, citations read as score.ts reads them. */
export function ledgerFindings(runDir: string): Array<{ citations: Citation[]; cwe?: string; vulnClass?: string }> {
	const ws = join(runDir, "workspace");
	const inventory = inventoryIndex(liveRecords(readJsonl(join(ws, "inventory.jsonl"))));
	return liveRecords(readJsonl(join(ws, "findings.jsonl"))).flatMap((f) => {
		const citations = citationsForRecord(f, inventory);
		if (!citations.length) return [];
		return [{ citations, ...(typeof f.cwe === "string" ? { cwe: f.cwe } : {}), ...(typeof f.class === "string" ? { vulnClass: f.class } : {}) }];
	});
}

/** The citations of every located finding in a run's ledger. */
export function findingsFromLedger(runDir: string): Citation[][] {
	return ledgerFindings(runDir).map((f) => f.citations);
}

/** The claims the official path would grade, flattened in ledger order. */
export function claimsFromLedger(runDir: string): Claim[] {
	return ledgerFindings(runDir).flatMap((f) => f.citations.map((c) => ({ file: c.file, line: c.lo, cwe: f.cwe, vulnClass: f.vulnClass })));
}

export function loadTruth(path: string): Truth[] {
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const items = (Array.isArray(raw) ? raw : ((raw as Row).vulnerabilities as Row[])) as Row[];
	return items.map((v) => {
		const line = Number(v.line);
		const range = Array.isArray(v.line_range) && v.line_range.length ? (v.line_range as unknown[]).map(Number) : [line];
		let lo = range[0]!;
		let hi = range.length > 1 ? range[1]! : lo;
		if (hi < lo) [lo, hi] = [hi, lo];
		return {
			id: String(v.id), file: String(v.file), line: Number.isFinite(line) ? line : lo, lo, hi,
			...(v.cwe ? { cwe: String(v.cwe) } : {}), ...(v.vuln_class ? { vulnClass: String(v.vuln_class) } : {}),
			...(typeof v.advisory === "string" ? { advisory: v.advisory } : {}),
			...(Array.isArray(v.cwes) ? { cwes: (v.cwes as unknown[]).map(String) } : {}),
		};
	});
}

export interface RescoreRow {
	grid: string;
	cell: string;
	target: string;
	pass: number;
	arm: string;
	attempt: number;
	officialTp: number;
	claims: number;
	tokens: number;
	/** The official count as reproduced here; must equal officialTp. */
	mirroredTp: number;
	/** The mirror with sameFile in place of basename: official TPs that survive a real path match. */
	segmentsTp: number;
	/** The mirror without the class rule: location-correct labels, one claim per label. */
	locationTp: number;
	/** Neither class nor basename rule: the official assignment over the line±3 level's matching. */
	strictLocationTp: number;
	/**
	 * Whether the deduped claims read here equal, in order, the file:line list the
	 * pinned adapter wrote to score.json.findings.json. True positives are sparse,
	 * so a parser divergence on claims that match nothing would pass the TP
	 * control unnoticed; this catches it. null when the run has no such file.
	 */
	claimsIdentical: boolean | null;
	matched: Record<Level, string[]>;
	/** Advisories with at least one label matched, per level (advisoriesFound). */
	advisoriesMatched: Record<Level, string[]>;
	/** Deduped claims as true, neutral and false positives (claimOutcomes). */
	claimOutcomes: { tp: number; neutral: number; fp: number };
	/** For a patched twin (a target carrying `fixed_regions`): its control score. */
	control?: { hits: number; claims: number; perKloc: number | null };
}

/**
 * Valid runs at the highest attempt of their (target, pass, arm). A lower
 * attempt that happened to be valid was superseded by a resume and is not what
 * the grid scored.
 */
export function currentRuns(runs: Row[]): Row[] {
	const top = new Map<string, number>();
	const key = (r: Row) => `${String(r.target)}#${String(r.pass)}#${String(r.arm)}`;
	for (const r of runs) top.set(key(r), Math.max(top.get(key(r)) ?? -Infinity, Number(r.attempt ?? 0)));
	return runs.filter((r) => r.valid === true && Number(r.attempt ?? 0) === top.get(key(r)));
}

/** score.ts dedupe(): one file+line is one claim. */
export function claimKeys(claims: Array<{ file: string; line?: number }>): string[] {
	return [...new Set(claims.map((c) => `${c.file}:${c.line ?? 0}`))];
}

function scoredClaimKeys(dir: string): string[] | null {
	const path = join(dir, "score.json.findings.json");
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(raw) ? (raw as Array<{ file: string; line?: number }>).map((c) => `${c.file}:${c.line ?? 0}`) : null;
}

export function rescoreGrid(gridDir: string, cap = DEFAULT_WIDTH_CAP): { rows: RescoreRow[]; truths: Map<string, Truth[]> } {
	const manifest = JSON.parse(readFileSync(join(gridDir, "manifest.json"), "utf8")) as {
		targets: Array<{ id: string; name: string; fixed_regions?: Array<{ file: string; line_range: [number, number] }>; scope_loc?: number }>;
		inputs: { truth: string };
	};
	const truths = new Map<string, Truth[]>();
	const neutral = new Map<string, Region[]>();
	const twins = new Map<string, { regions: Region[]; loc: number }>();
	for (const t of manifest.targets) {
		truths.set(t.id, loadTruth(join(manifest.inputs.truth, `${t.name}.truth.json`)));
		neutral.set(t.id, loadRegions(join(manifest.inputs.truth, `${t.name}.neutral.json`)));
		if (Array.isArray(t.fixed_regions)) {
			twins.set(t.id, { regions: t.fixed_regions.map((r) => ({ file: r.file, lo: r.line_range[0], hi: r.line_range[1] })), loc: Number(t.scope_loc ?? 0) });
		}
	}
	const runsDir = join(gridDir, "runs");
	const runs = readdirSync(runsDir).flatMap((cell) => {
		const path = join(runsDir, cell, "run.json");
		if (!existsSync(path)) return [];
		return [{ ...(JSON.parse(readFileSync(path, "utf8")) as Row), __cell: cell }];
	});
	const rows = currentRuns(runs).map((r): RescoreRow => {
		const dir = join(runsDir, r.__cell as string);
		const truth = truths.get(String(r.target)) ?? [];
		const findings = findingsFromLedger(dir);
		const claims = claimsFromLedger(dir);
		const matched = Object.fromEntries(LEVELS.map((l) => [l, [...matchUnique(findings, truth, l, cap)].sort()])) as Record<Level, string[]>;
		const advisoriesMatched = Object.fromEntries(LEVELS.map((l) => [l, [...advisoriesFound(findings, truth, l, cap)].sort()])) as Record<Level, string[]>;
		const twin = twins.get(String(r.target));
		return {
			grid: gridDir, cell: r.__cell as string, target: String(r.target), pass: Number(r.pass), arm: String(r.arm), attempt: Number(r.attempt ?? 0),
			officialTp: Number(r.truePositives), claims: Number(r.findings), tokens: Number(r.totalTokens),
			mirroredTp: officialMatches(claims, truth).size,
			segmentsTp: officialMatches(claims, truth, { fileRule: "segments" }).size,
			locationTp: officialMatches(claims, truth, { classRule: false }).size,
			strictLocationTp: officialMatches(claims, truth, { classRule: false, fileRule: "segments" }).size,
			claimsIdentical: ((scored) => scored === null ? null : scored.join("\n") === claimKeys(claims).join("\n"))(scoredClaimKeys(dir)),
			matched,
			advisoriesMatched,
			claimOutcomes: claimOutcomes(claims, truth, neutral.get(String(r.target)) ?? []),
			...(twin ? { control: controlScore(claims, twin.regions, twin.loc) } : {}),
		};
	});
	return { rows, truths };
}

/**
 * Rows whose (target, pass) has both arms valid at the same attempt: only those
 * enter the paired sums, the rule eval/paired.ts applies. Without the attempt
 * check a baseline that needed a retry would be paired with a candidate's first
 * attempt, and the two would not have run under the same conditions.
 */
export function pairedRows(rows: RescoreRow[]): RescoreRow[] {
	const groups = new Map<string, { arms: Set<string>; attempts: Set<number> }>();
	for (const r of rows) {
		const k = `${r.grid}#${r.target}#${r.pass}`;
		const g = groups.get(k) ?? { arms: new Set(), attempts: new Set() };
		g.arms.add(r.arm);
		g.attempts.add(r.attempt);
		groups.set(k, g);
	}
	return rows.filter((r) => {
		const g = groups.get(`${r.grid}#${r.target}#${r.pass}`);
		return !!g && g.arms.size >= 2 && g.attempts.size === 1;
	});
}

/** The aggregate table the CLI prints: counts and ids only, never finding text. */
export function formatReport(rows: RescoreRow[], truths: Truth[], cap = DEFAULT_WIDTH_CAP): string {
	const lines: string[] = [];
	const control = rows.filter((r) => r.mirroredTp === r.officialTp).length;
	const pointControl = rows.filter((r) => r.matched["line±3"].length === r.officialTp).length;
	lines.push(`control: official mirror ${control} of ${rows.length} runs agree; line±3 level ${pointControl} of ${rows.length}`);
	for (const r of rows) if (r.mirroredTp !== r.officialTp) lines.push(`  DISAGREE ${r.grid} ${r.cell} official ${r.officialTp} mirrored ${r.mirroredTp}`);
	const withScored = rows.filter((r) => r.claimsIdentical !== null);
	lines.push(`claims: ${withScored.filter((r) => r.claimsIdentical).length} of ${withScored.length} runs parse identically to score.json.findings.json`);
	for (const r of withScored) if (!r.claimsIdentical) lines.push(`  CLAIMS DIFFER ${r.grid} ${r.cell}`);
	// Why the location levels differ from the official count, in the grader's own
	// terms: labels the class rule refused, and labels credited only by basename.
	const total = (f: (r: RescoreRow) => number) => rows.reduce((n, r) => n + f(r), 0);
	lines.push(`official TP ${total((r) => r.officialTp)} · without the class rule ${total((r) => r.locationTp)} · with segment file matching ${total((r) => r.segmentsTp)} · runs where line±3 differs: class ${rows.filter((r) => r.locationTp !== r.mirroredTp).length}, basename ${rows.filter((r) => r.segmentsTp !== r.mirroredTp).length}`);
	// The last step of the chain: what is left between the mirror and line±3 is
	// only one-claim-per-label assignment, which the unique-location levels skip.
	const assignment = rows.filter((r) => r.matched["line±3"].length !== r.strictLocationTp);
	lines.push(`line±3 against the mirror without class or basename rules: ${rows.length - assignment.length} of ${rows.length} runs agree`);
	for (const r of assignment) lines.push(`  ASSIGNMENT ${r.grid} ${r.cell} mirror ${r.strictLocationTp} line±3 ${r.matched["line±3"].length}`);
	const paired = pairedRows(rows);
	const grids = [...new Set(paired.map((r) => r.grid))];
	lines.push(`grid\tarm\tpairs\tofficialTp\t${LEVELS.join("\t")}\tclaims\ttokens`);
	for (const g of grids) {
		for (const arm of [...new Set(paired.filter((r) => r.grid === g).map((r) => r.arm))].sort()) {
			const rs = paired.filter((r) => r.grid === g && r.arm === arm);
			const sum = (f: (r: RescoreRow) => number) => rs.reduce((n, r) => n + f(r), 0);
			lines.push([g, arm, rs.length, sum((r) => r.officialTp), ...LEVELS.map((l) => sum((r) => r.matched[l].length)), sum((r) => r.claims), sum((r) => r.tokens)].join("\t"));
		}
	}
	// Additive: advisories found per level, and precision with neutral claims set aside.
	lines.push(`grid\tarm\tpairs\tadvisories ${LEVELS.join("\t")}\tclaims tp/neutral/fp\tprecision without neutral`);
	for (const g of grids) {
		for (const arm of [...new Set(paired.filter((r) => r.grid === g).map((r) => r.arm))].sort()) {
			const rs = paired.filter((r) => r.grid === g && r.arm === arm);
			const sum = (f: (r: RescoreRow) => number) => rs.reduce((n, r) => n + f(r), 0);
			const o = { tp: sum((r) => r.claimOutcomes.tp), neutral: sum((r) => r.claimOutcomes.neutral), fp: sum((r) => r.claimOutcomes.fp) };
			const p = precisionWithoutNeutral(o);
			lines.push([g, arm, rs.length, ...LEVELS.map((l) => sum((r) => r.advisoriesMatched[l].length)), `${o.tp}/${o.neutral}/${o.fp}`, p === null ? "—" : p.toFixed(3)].join("\t"));
		}
	}
	const controls = rows.filter((r) => r.control);
	if (controls.length) {
		lines.push("patched twins (never in precision): grid\tarm\truns\tclaims near fixed regions\tclaims per KLOC (mean)");
		for (const g of [...new Set(controls.map((r) => r.grid))]) {
			for (const arm of [...new Set(controls.filter((r) => r.grid === g).map((r) => r.arm))].sort()) {
				const rs = controls.filter((r) => r.grid === g && r.arm === arm);
				const per = rs.map((r) => r.control!.perKloc).filter((x): x is number => x !== null);
				lines.push([g, arm, rs.length, rs.reduce((n, r) => n + r.control!.hits, 0), per.length ? (per.reduce((a, b) => a + b, 0) / per.length).toFixed(2) : "—"].join("\t"));
			}
		}
	}
	const wide = labelHygiene(truths, cap);
	lines.push(`labels spanning more than ${cap + 1} lines (range-overlap keeps lo..lo+${cap}): ${wide.length ? wide.map((w) => `${w.id} (${w.width} lines)`).join(", ") : "none"}`);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let json: string | undefined;
	let cap = DEFAULT_WIDTH_CAP;
	const grids: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--json") json = args[++i];
		else if (args[i] === "--cap") cap = Number(args[++i]);
		else grids.push(args[i]!);
	}
	if (!grids.length || !Number.isFinite(cap) || cap < 0 || (args.includes("--json") && !json)) {
		process.stderr.write("Usage: rescore.ts <grid-dir>... [--json <out.json>] [--cap 30]\n");
		process.exitCode = 2;
		return;
	}
	const rows: RescoreRow[] = [];
	const truths = new Map<string, Truth>();
	for (const g of grids) {
		const result = rescoreGrid(g, cap);
		rows.push(...result.rows);
		for (const ts of result.truths.values()) for (const t of ts) truths.set(t.id, t);
	}
	if (json) writeFileSync(json, `${JSON.stringify(rows, null, 2)}\n`);
	process.stdout.write(`${formatReport(rows, [...truths.values()], cap)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
