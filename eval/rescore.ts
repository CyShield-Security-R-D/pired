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
 *
 * Beside the levels, each run is partitioned by status and by author
 * (`partitionClaims`, delegation-v6 Phase 3, 3.1): labels matched by all rows,
 * by the rows a report presents (not refuted or disposed of), by the suspected
 * and the confirmed rows, by the independently confirmed ones, by the confirmed
 * rows' verification tier, by each `by`, and by every row ever recorded refuted
 * (and by whom); and the verifications that missed their bar, on quotes or
 * otherwise. The official scorer ignores status, so this is where a verifier's
 * refutations — right or wrong — become countable. It is additive: the mirror
 * does not read it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isIndependent } from "../core/challenge.ts";
import type { FindingRecord } from "../core/ontology.ts";
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

// --- Claim tiers and provenance (delegation-v6 Phase 3, 3.1) -----------------

/**
 * The claim tiers the v6 trial pre-registers. The official scorer grades every
 * finding row whatever its status (eval/dvbank/score.ts `fromLedger`), so a
 * verifier's refutation cannot move the official count; these tiers are where
 * it shows:
 *
 * - `all`: every located row — what the official number grades;
 * - `presented`: not refuted and not disposed of by the operator — what a
 *   report presents as a finding or a lead;
 * - `suspected`: presented but not confirmed — the report's Suspected section;
 * - `confirmed`: confirmed, triaged or reported — the export's Confirmed section;
 * - `confirmed-independent`: confirmed by someone other than any of the row's
 *   finders (`isIndependent`).
 *
 * Each is its own slice, matched from its own rows: labels matched by
 * `suspected` are not `presented` minus `confirmed`, since one label can be hit
 * by rows in both.
 */
export const CLAIM_TIERS = ["all", "presented", "suspected", "confirmed", "confirmed-independent"] as const;
export type ClaimTier = (typeof CLAIM_TIERS)[number];

const DISPOSED = new Set(["refuted", "false-positive", "accepted-risk", "ignored"]);
const SETTLED = new Set(["confirmed", "triaged", "reported"]);

/** Which status tiers a row with this status belongs to. A row with no status is a lead: presented, suspected. */
export function tiersOf(status: unknown, independent?: boolean): ClaimTier[] {
	const s = typeof status === "string" ? status : "";
	if (DISPOSED.has(s)) return ["all"];
	if (!SETTLED.has(s)) return ["all", "presented", "suspected"];
	return independent === true ? ["all", "presented", "confirmed", "confirmed-independent"] : ["all", "presented", "confirmed"];
}

/** Labels matched and rows counted, at every level, for one slice of a run's claims. */
export interface ClaimSlice {
	/** Located finding rows in the slice — the precision denominator, one per row. */
	claims: number;
	matched: Record<Level, string[]>;
}

/** A located ledger finding, with what the partition reads. */
export interface LedgerFinding {
	citations: Citation[];
	cwe?: string;
	vulnClass?: string;
	/** The live row's status. */
	status?: string;
	/** Who created the row (`by`), or undefined on a ledger written before it existed. */
	by?: string;
	/** The live row's verification was made by none of its finders (`isIndependent` true). */
	independent?: boolean;
	/** The live row's verification tier, when it carries one. */
	tier?: string;
	/** Any line of the row's history, not only the live one, recorded it `refuted`. */
	everRefuted: boolean;
	/** Who refuted it, on each history line that did (`verification.by`; `unknown` when absent), once each. */
	refutedBy?: string[];
}

/** The author key a row is counted under: its `by`, or `unknown` for a row written before `by` existed. */
export const UNKNOWN_AUTHOR = "unknown";

/** The verification tiers a confirmed row is split by; `none` is a confirmation with no tier recorded. */
export const VERIFICATION_TIER_KEYS = ["static", "executed", "none"] as const;

function slice(findings: LedgerFinding[], truths: Truth[], cap: number): ClaimSlice {
	const cites = findings.map((f) => f.citations);
	return {
		claims: findings.length,
		matched: Object.fromEntries(LEVELS.map((l) => [l, [...matchUnique(cites, truths, l, cap)].sort()])) as Record<Level, string[]>,
	};
}

function sliceBy(findings: LedgerFinding[], truths: Truth[], cap: number, keys: (f: LedgerFinding) => string[]): Record<string, ClaimSlice> {
	const all = [...new Set(findings.flatMap(keys))].sort();
	return Object.fromEntries(all.map((k) => [k, slice(findings.filter((f) => keys(f).includes(k)), truths, cap)]));
}

/**
 * The status and provenance partition of one run: labels matched by each claim
 * tier, by each author, by the verification tier of the confirmed rows, and by
 * the rows that were ever refuted (and by whom) — the last so a verifier
 * rejecting a real bug is counted even when a later write re-confirmed it.
 * Additive: nothing here feeds the official mirror.
 */
export function partitionClaims(findings: LedgerFinding[], truths: Truth[], cap = DEFAULT_WIDTH_CAP): {
	tiers: Record<ClaimTier, ClaimSlice>;
	byAuthor: Record<string, ClaimSlice>;
	confirmedByTier: Record<string, ClaimSlice>;
	everRefuted: ClaimSlice;
	everRefutedBy: Record<string, ClaimSlice>;
} {
	const tiers = Object.fromEntries(CLAIM_TIERS.map((t) => [t, slice(findings.filter((f) => tiersOf(f.status, f.independent).includes(t)), truths, cap)])) as Record<ClaimTier, ClaimSlice>;
	const confirmed = findings.filter((f) => tiersOf(f.status).includes("confirmed"));
	const refuted = findings.filter((f) => f.everRefuted);
	return {
		tiers,
		byAuthor: sliceBy(findings, truths, cap, (f) => [f.by ?? UNKNOWN_AUTHOR]),
		confirmedByTier: Object.fromEntries(VERIFICATION_TIER_KEYS.map((k) => [k, slice(confirmed.filter((f) => (f.tier ?? "none") === k), truths, cap)])),
		everRefuted: slice(refuted, truths, cap),
		everRefutedBy: sliceBy(refuted, truths, cap, (f) => f.refutedBy?.length ? f.refutedBy : [UNKNOWN_AUTHOR]),
	};
}

/**
 * Every located ledger finding with its status, author, independence, tier and
 * refutation history. The citations are read exactly as `ledgerFindings` reads
 * them.
 */
export function ledgerFindingRows(runDir: string): LedgerFinding[] {
	const ws = join(runDir, "workspace");
	const inventory = inventoryIndex(liveRecords(readJsonl(join(ws, "inventory.jsonl"))));
	const raw = readJsonl(join(ws, "findings.jsonl"));
	const refuters = new Map<string, Set<string>>();
	for (const r of raw) {
		if (r.status !== "refuted" || typeof r.id !== "string") continue;
		const by = (r.verification as Row | undefined)?.by;
		const set = refuters.get(r.id) ?? new Set<string>();
		set.add(typeof by === "string" ? by : UNKNOWN_AUTHOR);
		refuters.set(r.id, set);
	}
	return liveRecords(raw).flatMap((f) => {
		const citations = citationsForRecord(f, inventory);
		if (!citations.length) return [];
		const verification = f.verification as Row | undefined;
		const independent = isIndependent(f as unknown as FindingRecord);
		const refutedBy = refuters.get(f.id as string);
		return [{
			citations,
			...(typeof f.cwe === "string" ? { cwe: f.cwe } : {}),
			...(typeof f.class === "string" ? { vulnClass: f.class } : {}),
			...(typeof f.status === "string" ? { status: f.status } : {}),
			...(typeof f.by === "string" ? { by: f.by } : {}),
			...(independent !== undefined ? { independent } : {}),
			...(typeof verification?.tier === "string" ? { tier: verification.tier } : {}),
			everRefuted: refutedBy !== undefined,
			...(refutedBy ? { refutedBy: [...refutedBy].sort() } : {}),
		}];
	});
}

/** What a run's verifications record about verdicts that missed their bar (3.1). */
export interface VerdictCounts {
	/** Distinct verifications written (one per finding id and verification time). */
	verifications: number;
	/** Of them, unresolved ones that asked for a verdict (`attempted`) — downgrades. */
	downgraded: number;
	/** Of them, ones with at least one quote not found where cited (`ungrounded`). */
	onQuotes: number;
}

/**
 * The quote-downgrade rate's parts, from every history line's verification,
 * each counted once. Read from the `attempted` and `ungrounded` fields pired
 * writes, never from the wording of the notes.
 */
export function verdictCounts(runDir: string): VerdictCounts {
	const seen = new Set<string>();
	const counts: VerdictCounts = { verifications: 0, downgraded: 0, onQuotes: 0 };
	for (const r of readJsonl(join(runDir, "workspace", "findings.jsonl"))) {
		const v = r.verification as Row | undefined;
		if (!v || typeof r.id !== "string") continue;
		const key = `${r.id}#${String(v.at)}#${String(v.verdict)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		counts.verifications += 1;
		if (typeof v.attempted === "string") counts.downgraded += 1;
		if (typeof v.ungrounded === "number" && v.ungrounded > 0) counts.onQuotes += 1;
	}
	return counts;
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
	/** The claim tiers (CLAIM_TIERS): labels matched and rows, per level. Additive (3.1). */
	tiers: Record<ClaimTier, ClaimSlice>;
	/** The same, per author (`by`; `unknown` for rows written before it existed). */
	byAuthor: Record<string, ClaimSlice>;
	/** The confirmed rows, split by their verification tier (static / executed / none). */
	confirmedByTier: Record<string, ClaimSlice>;
	/** The rows any line of whose history says `refuted`, re-confirmed or not. */
	everRefuted: ClaimSlice;
	/** The same, per refuter (`verification.by` on the refuting line). */
	everRefutedBy: Record<string, ClaimSlice>;
	/** Verifications written, and how many missed their bar, on quotes or otherwise. */
	verdicts: VerdictCounts;
	/** A matched-arm union row only: its k session cells, in session order. */
	sessions?: string[];
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
	return scoredClaimKeysAt(join(dir, "score.json.findings.json"));
}

function scoredClaimKeysAt(path: string): string[] | null {
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(raw) ? (raw as Array<{ file: string; line?: number }>).map((c) => `${c.file}:${c.line ?? 0}`) : null;
}

/** A matched session's index and own attempt, from run.json's matchedSession. */
const sessionOf = (r: Row): { index: number; sessionAttempt: number } | undefined => {
	const s = r.matchedSession as Row | undefined;
	return s && typeof s.index === "number" && typeof s.sessionAttempt === "number" ? { index: s.index, sessionAttempt: s.sessionAttempt } : undefined;
};

/**
 * The matched arm's runs folded into one row per pair (plan item 2.5): the
 * sessions each union in summary.json names, by cell, their ledgers unioned as
 * the harness unions them. The union's session list is the one the harness
 * scored, so a pair that ran extra sessions on rolled-over budget is read with
 * all of them. A union that is not valid, or one naming a session whose run is
 * missing or not valid, has no row, as an invalid run has none.
 *
 * `officialTp` is the pinned scorer's union number from summary.json's matched
 * block, and the mirror is run on the concatenated claims (officialMatches
 * dedupes them on file:line, as the union did), so the control still checks
 * this file against the official path. A grid still running has no summary.json
 * and so no matched rows: there is no official number yet.
 */
export function matchedUnionRows(gridDir: string, runs: Row[], truths: Map<string, Truth[]>, unions: Row[], cap = DEFAULT_WIDTH_CAP): RescoreRow[] {
	const byCell = new Map(runs.map((r) => [String(r.__cell), r]));
	const rows: RescoreRow[] = [];
	for (const union of unions) {
		if (union.valid !== true || !Array.isArray(union.sessions) || union.sessions.length === 0) continue;
		const sessions = (union.sessions as Row[]).map((s) => byCell.get(String(s.cellId)));
		if (sessions.some((r) => !r || r.valid !== true || r.arm !== "matched")) continue;
		const cells = (sessions as Row[]).map((r) => r.__cell as string);
		const dirs = cells.map((cell) => join(gridDir, "runs", cell));
		const truth = truths.get(String(union.target)) ?? [];
		const findings = dirs.flatMap(findingsFromLedger);
		const claims = dirs.flatMap(claimsFromLedger);
		const scored = typeof union.scorePath === "string" ? scoredClaimKeysAt(`${union.scorePath}.findings.json`) : null;
		rows.push({
			grid: gridDir, cell: cells.join("+"), target: String(union.target), pass: Number(union.pass), arm: "matched", attempt: Number(union.attempt ?? 0),
			officialTp: Number(union.truePositives), claims: Number(union.totalClaims), tokens: Number(union.totalTokens),
			mirroredTp: officialMatches(claims, truth).size,
			segmentsTp: officialMatches(claims, truth, { fileRule: "segments" }).size,
			locationTp: officialMatches(claims, truth, { classRule: false }).size,
			strictLocationTp: officialMatches(claims, truth, { classRule: false, fileRule: "segments" }).size,
			claimsIdentical: scored === null ? null : scored.join("\n") === claimKeys(claims).join("\n"),
			matched: Object.fromEntries(LEVELS.map((l) => [l, [...matchUnique(findings, truth, l, cap)].sort()])) as Record<Level, string[]>,
			// The claim tiers over the unioned ledgers, as a single run's are over its one.
			...partitionClaims(dirs.flatMap(ledgerFindingRows), truth, cap),
			verdicts: dirs.map(verdictCounts).reduce((a, b) => ({ verifications: a.verifications + b.verifications, downgraded: a.downgraded + b.downgraded, onQuotes: a.onQuotes + b.onQuotes }), { verifications: 0, downgraded: 0, onQuotes: 0 }),
			sessions: cells,
		});
	}
	return rows;
}

export function rescoreGrid(gridDir: string, cap = DEFAULT_WIDTH_CAP): { rows: RescoreRow[]; truths: Map<string, Truth[]> } {
	const manifest = JSON.parse(readFileSync(join(gridDir, "manifest.json"), "utf8")) as { targets: Array<{ id: string; name: string }>; inputs: { truth: string }; matched?: unknown };
	const truths = new Map<string, Truth[]>();
	for (const t of manifest.targets) truths.set(t.id, loadTruth(join(manifest.inputs.truth, `${t.name}.truth.json`)));
	const runsDir = join(gridDir, "runs");
	const runs: Row[] = readdirSync(runsDir).flatMap((cell) => {
		const path = join(runsDir, cell, "run.json");
		if (!existsSync(path)) return [];
		return [{ ...(JSON.parse(readFileSync(path, "utf8")) as Row), __cell: cell }];
	});
	// A matched session is one of k draws, not a run of its own: its arm is read
	// as the union below, and never enters the per-run rows.
	const rows = currentRuns(runs.filter((r) => r.arm !== "matched")).map((r): RescoreRow => {
		const dir = join(runsDir, r.__cell as string);
		const truth = truths.get(String(r.target)) ?? [];
		const findings = findingsFromLedger(dir);
		const claims = claimsFromLedger(dir);
		const matched = Object.fromEntries(LEVELS.map((l) => [l, [...matchUnique(findings, truth, l, cap)].sort()])) as Record<Level, string[]>;
		const partition = partitionClaims(ledgerFindingRows(dir), truth, cap);
		return {
			grid: gridDir, cell: r.__cell as string, target: String(r.target), pass: Number(r.pass), arm: String(r.arm), attempt: Number(r.attempt ?? 0),
			officialTp: Number(r.truePositives), claims: Number(r.findings), tokens: Number(r.totalTokens),
			mirroredTp: officialMatches(claims, truth).size,
			segmentsTp: officialMatches(claims, truth, { fileRule: "segments" }).size,
			locationTp: officialMatches(claims, truth, { classRule: false }).size,
			strictLocationTp: officialMatches(claims, truth, { classRule: false, fileRule: "segments" }).size,
			claimsIdentical: ((scored) => scored === null ? null : scored.join("\n") === claimKeys(claims).join("\n"))(scoredClaimKeys(dir)),
			matched,
			...partition,
			verdicts: verdictCounts(dir),
		};
	});
	if (manifest.matched !== undefined) {
		const summaryPath = join(gridDir, "summary.json");
		const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) as { matched?: { unions?: Row[] } } : {};
		rows.push(...matchedUnionRows(gridDir, runs.filter((r) => r.arm === "matched"), truths, summary.matched?.unions ?? [], cap));
	}
	return { rows, truths };
}

/**
 * Rows whose (target, pass) has both arms valid at the same attempt: only those
 * enter the paired sums, the rule eval/paired.ts applies. Without the attempt
 * check a baseline that needed a retry would be paired with a candidate's first
 * attempt, and the two would not have run under the same conditions. A matched
 * union row enters with its pair, and a pair missing a gate arm stays out even
 * when a matched row stands in the second slot.
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
		return !!g && g.arms.has("baseline") && g.arms.has("candidate") && g.attempts.size === 1;
	});
}

/** The aggregate table the CLI prints: counts and ids only, never finding text. */
export function formatReport(all: RescoreRow[], truths: Truth[], cap = DEFAULT_WIDTH_CAP): string {
	const lines: string[] = [];
	// A matched union is k or more sessions, not a run: the run totals below count
	// runs only, and the unions get their own control line (review).
	const rows = all.filter((r) => !r.sessions);
	const unions = all.filter((r) => r.sessions);
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
	if (unions.length) {
		const unionScored = unions.filter((r) => r.claimsIdentical !== null);
		lines.push(`matched unions: official mirror ${unions.filter((r) => r.mirroredTp === r.officialTp).length} of ${unions.length} agree; claims parse identically ${unionScored.filter((r) => r.claimsIdentical).length} of ${unionScored.length}`);
		for (const r of unions) if (r.mirroredTp !== r.officialTp) lines.push(`  DISAGREE ${r.grid} ${r.cell} official ${r.officialTp} mirrored ${r.mirroredTp}`);
	}
	const paired = pairedRows(all);
	const grids = [...new Set(paired.map((r) => r.grid))];
	lines.push(`grid\tarm\tpairs\tofficialTp\t${LEVELS.join("\t")}\tclaims\ttokens`);
	for (const g of grids) {
		for (const arm of [...new Set(paired.filter((r) => r.grid === g).map((r) => r.arm))].sort()) {
			const rs = paired.filter((r) => r.grid === g && r.arm === arm);
			const sum = (f: (r: RescoreRow) => number) => rs.reduce((n, r) => n + f(r), 0);
			lines.push([g, arm, rs.length, sum((r) => r.officialTp), ...LEVELS.map((l) => sum((r) => r.matched[l].length)), sum((r) => r.claims), sum((r) => r.tokens)].join("\t"));
		}
	}
	// The status and provenance partition (3.1): the same paired runs, cut by
	// claim tier and by author. Rows are the precision denominator per slice.
	lines.push(`claim tiers\tgrid\tarm\ttier\trows\t${LEVELS.join("\t")}`);
	for (const g of grids) {
		for (const arm of [...new Set(paired.filter((r) => r.grid === g).map((r) => r.arm))].sort()) {
			const rs = paired.filter((r) => r.grid === g && r.arm === arm);
			const sum = (f: (r: RescoreRow) => ClaimSlice | undefined) => ({
				claims: rs.reduce((n, r) => n + (f(r)?.claims ?? 0), 0),
				levels: LEVELS.map((l) => rs.reduce((n, r) => n + (f(r)?.matched[l].length ?? 0), 0)),
			});
			const tierLine = (label: string, f: (r: RescoreRow) => ClaimSlice | undefined) => {
				const t = sum(f);
				lines.push(["claim tiers", g, arm, label, t.claims, ...t.levels].join("\t"));
			};
			for (const tier of CLAIM_TIERS) tierLine(tier, (r) => r.tiers?.[tier]);
			for (const t of VERIFICATION_TIER_KEYS) tierLine(`confirmed ${t}`, (r) => r.confirmedByTier?.[t]);
			tierLine("ever-refuted", (r) => r.everRefuted);
			const refuters = [...new Set(rs.flatMap((r) => Object.keys(r.everRefutedBy ?? {})))].sort();
			for (const a of refuters) tierLine(`refuted by ${a}`, (r) => r.everRefutedBy?.[a]);
			const authors = [...new Set(rs.flatMap((r) => Object.keys(r.byAuthor ?? {})))].sort();
			for (const a of authors) tierLine(`by ${a}`, (r) => r.byAuthor?.[a]);
			const v = rs.reduce((n, r) => ({
				verifications: n.verifications + (r.verdicts?.verifications ?? 0),
				downgraded: n.downgraded + (r.verdicts?.downgraded ?? 0),
				onQuotes: n.onQuotes + (r.verdicts?.onQuotes ?? 0),
			}), { verifications: 0, downgraded: 0, onQuotes: 0 });
			lines.push(`verdicts\t${g}\t${arm}\tverifications ${v.verifications}\tdowngraded ${v.downgraded}\ton quotes ${v.onQuotes}`);
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
