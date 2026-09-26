/**
 * Coverage as areas: the recorded surface grouped into places (Phase 3, 3.2).
 *
 * The coverage matrix answers "which test cases are open", one element at a
 * time. It does not answer "which parts of the target has anyone looked at",
 * and a source directory nobody recorded any surface in has no cells at all, so
 * the matrix cannot show it as a hole. This view groups the surface by the
 * directory of its `file` (or by host, when there is no file), gives each group
 * a status from its cells, and lists the source directories with no recorded
 * surface as unmapped.
 *
 * Derived, never stored (FORMAT.md §12), and it ranks nothing: areas come back
 * in path order, and choosing what to look at next stays the reviewer's call.
 *
 * The grouping rule was fixed on synthetic trees written for its tests, not on
 * any corpus layout: a benchmark's repositories are temporary, and a rule tuned
 * to them would group the next repository badly and look fine doing it.
 *
 * Pure module: core imports only.
 */

import type { CoverageCell, FindingRecord, InventoryKind, InventoryRecord } from "./ontology.ts";

/** About as many areas as a reader takes in at a glance; past it, directories are grouped coarser. */
export const MAX_AREAS = 20;

/** The key for surface that names neither a file nor a host. */
export const UNPLACED = "(no file or host)";

/** The key for surface whose file resolves outside the source root. */
export const OUTSIDE = "(outside the source root)";

export type AreaStatus = "untested" | "in progress" | "settled" | "blocked";

export interface Area {
	/** A directory ("src/routes", "." for the root), a host, or UNPLACED. */
	key: string;
	by: "directory" | "host" | "outside" | "none";
	/** Surface elements in the area. */
	elements: number;
	/** Askable cells (n/a excluded) and how they stand. */
	cells: { askable: number; settled: number; testing: number; blocked: number; untested: number };
	status: AreaStatus;
	/** Findings whose target or location falls in the area. */
	findings: number;
}

export interface AreasView {
	areas: Area[];
	/** Listed source directories with no recorded surface in or below them, outermost only. */
	unmapped: string[];
	/** The directory depth areas were cut at to stay near MAX_AREAS, when they had to be. */
	depth?: number;
}

export interface AreasInput {
	/** Every inventory row: surface rows are grouped, the rest resolve a param's endpoint or an endpoint's host. */
	inventory: InventoryRecord[];
	/** Which kinds are surface (the coverage matrix's rows). */
	surfaceKinds: InventoryKind[];
	/** The coverage matrix's cells; empty when there is no checklist. */
	cells: CoverageCell[];
	/** The findings to count, already filtered by the caller (disposed ones left out). */
	findings: FindingRecord[];
	/** A directory-only listing of the source tree, relative to `root`; absent means no unmapped list. */
	dirs?: string[];
	/** The source root, stripped from an absolute `file` so it lines up with `dirs`. */
	root?: string;
}

/**
 * A path as the listing spells it: forward slashes, no `.` or `..` segments, no
 * trailing slash, no `:line` or `:lo-hi` suffix, relative to `root` when it was
 * absolute under it. Undefined when it resolves outside the root: an absolute
 * path elsewhere (when the root is known) or one that climbs out with `..`.
 * Such a path is not the listed tree's, and read as if it were it could mark a
 * listed directory as mapped that nobody recorded anything in.
 */
export function normalizePath(raw: string, root?: string): string | undefined {
	let p = raw.trim().replace(/\\/g, "/").replace(/:\d+(?:-\d+)?$/, "");
	const base = root?.replace(/\\/g, "/").replace(/\/+$/, "");
	const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
	if (base && absolute) {
		if (p !== base && !p.startsWith(`${base}/`)) return undefined;
		p = p.slice(base.length);
	}
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (out.length === 0) return undefined;
			out.pop();
		} else out.push(seg);
	}
	return out.join("/");
}

/** The directory a file lives in, "." for the root. */
export function dirOf(file: string): string {
	const i = file.lastIndexOf("/");
	return i <= 0 ? "." : file.slice(0, i);
}

/** A directory cut to its first `depth` segments; "." stays ".". */
function truncate(dir: string, depth: number): string {
	return dir === "." ? dir : dir.split("/").slice(0, depth).join("/");
}

/** Is `dir` the directory `area` or somewhere below it? */
function within(dir: string, area: string): boolean {
	return area === "." ? dir === "." : dir === area || dir.startsWith(`${area}/`);
}

/** Looks like a path rather than a label: it has a slash or a file extension. */
function pathLike(s: string): boolean {
	return !/\s/.test(s.trim()) && (/[/\\]/.test(s) || /\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?$/.test(s));
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * The deepest cut at which the directories number MAX_AREAS or fewer, or 1
 * when even the top level does not fit. Undefined when no cut is needed.
 */
function cutDepth(dirs: Set<string>): number | undefined {
	if (dirs.size <= MAX_AREAS) return undefined;
	const deepest = Math.max(...[...dirs].map((d) => (d === "." ? 1 : d.split("/").length)));
	for (let depth = deepest - 1; depth >= 1; depth--) {
		if (new Set([...dirs].map((d) => truncate(d, depth))).size <= MAX_AREAS) return depth;
	}
	return 1;
}

function statusOf(cells: Area["cells"]): AreaStatus {
	if (cells.askable === 0 || cells.settled + cells.testing + cells.blocked === 0) return "untested";
	if (cells.settled === cells.askable) return "settled";
	if (cells.untested === 0 && cells.testing === 0) return "blocked";
	return "in progress";
}

const BY_ORDER: Record<Area["by"], number> = { directory: 0, host: 1, outside: 2, none: 3 };

export function deriveAreas(input: AreasInput): AreasView {
	const byId = new Map(input.inventory.map((r) => [r.id, r]));
	const hostName = (ref: string | undefined): string | undefined => {
		if (!ref) return undefined;
		const rec = byId.get(ref);
		return rec?.kind === "host" ? rec.value : ref;
	};
	// Where one element lives: its file's directory, else its host, else nowhere.
	// A param with no file of its own lives where its endpoint does.
	const place = (rec: InventoryRecord, seen = new Set<string>()): { by: Area["by"]; key: string } => {
		seen.add(rec.id);
		const file = str((rec as { file?: unknown }).file);
		if (file) {
			const norm = normalizePath(file, input.root);
			if (norm === undefined) return { by: "outside", key: OUTSIDE };
			if (norm) return { by: "directory", key: dirOf(norm) };
		}
		if (rec.kind === "param" && rec.endpoint) {
			const parent = byId.get(rec.endpoint);
			if (parent && !seen.has(parent.id)) return place(parent, seen);
		}
		const host = rec.kind === "host" ? str(rec.value) : rec.kind === "param" ? undefined : hostName(str(rec.host));
		return host ? { by: "host", key: host } : { by: "none", key: UNPLACED };
	};

	const surface = input.inventory.filter((r) => input.surfaceKinds.includes(r.kind));
	const placed = new Map(surface.map((r) => [r.id, place(r)]));
	const rawDirs = new Set([...placed.values()].filter((p) => p.by === "directory").map((p) => p.key));
	const depth = cutDepth(rawDirs);
	const areaKey = (p: { by: Area["by"]; key: string }): string =>
		p.by === "directory" && depth !== undefined ? truncate(p.key, depth) : p.key;

	const areas = new Map<string, Area>();
	const areaOf = new Map<string, Area>();
	for (const rec of surface) {
		const p = placed.get(rec.id)!;
		const key = areaKey(p);
		const id = `${p.by}\u0000${key}`;
		let area = areas.get(id);
		if (!area) {
			area = { key, by: p.by, elements: 0, cells: { askable: 0, settled: 0, testing: 0, blocked: 0, untested: 0 }, status: "untested", findings: 0 };
			areas.set(id, area);
		}
		area.elements += 1;
		areaOf.set(rec.id, area);
	}

	for (const cell of input.cells) {
		const area = areaOf.get(cell.element);
		if (!area || cell.status === "n/a") continue;
		area.cells.askable += 1;
		if (cell.status === "clear" || cell.status === "vulnerable") area.cells.settled += 1;
		else if (cell.status === "testing") area.cells.testing += 1;
		else if (cell.status === "blocked") area.cells.blocked += 1;
		else area.cells.untested += 1;
	}

	const dirAreas = [...areas.values()].filter((a) => a.by === "directory");
	for (const f of input.findings) {
		const target = typeof f.target === "string" ? f.target : undefined;
		const direct = target ? areaOf.get(target) : undefined;
		if (direct) { direct.findings += 1; continue; }
		const where = [...(f.locations ?? []), ...(target ? [target] : [])].find(pathLike);
		if (!where) continue;
		const norm = normalizePath(where, input.root);
		if (norm === undefined) continue;
		const dir = dirOf(norm);
		// The narrowest area holding it: after a cut, "src" and "src/api" cannot
		// both exist, but before one they can.
		const home = dirAreas.filter((a) => within(dir, a.key)).sort((a, b) => b.key.length - a.key.length)[0];
		if (home) home.findings += 1;
	}

	const list = [...areas.values()];
	for (const a of list) a.status = statusOf(a.cells);
	list.sort((a, b) => BY_ORDER[a.by] - BY_ORDER[b.by] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

	// Unmapped only once some surface names a file in the tree: before that every
	// directory is unmapped, which says nothing, and a review of a live target
	// that records no files has no source tree to be unmapped against.
	const unmapped = rawDirs.size > 0 ? unmappedDirs(input.dirs, rawDirs, input.root) : [];
	return { areas: list, unmapped, ...(depth !== undefined ? { depth } : {}) };
}

/**
 * Listed directories with no recorded surface in or below them. Only the
 * outermost of a run is named: `src/admin` unmapped says everything
 * `src/admin/views` would.
 */
function unmappedDirs(listing: string[] | undefined, mapped: Set<string>, root?: string): string[] {
	if (!listing) return [];
	const dirs = [...new Set(listing.map((d) => normalizePath(d, root)).filter((d): d is string => !!d))].sort();
	const has = (dir: string): boolean => [...mapped].some((m) => within(m, dir));
	const out: string[] = [];
	for (const dir of dirs) {
		if (has(dir)) continue;
		if (out.some((u) => within(dir, u))) continue;
		out.push(dir);
	}
	return out;
}

function areaLabel(a: Area): string {
	const cells = a.cells.askable > 0 ? `, ${a.cells.settled}/${a.cells.askable} cells settled` : "";
	const found = a.findings > 0 ? `, ${a.findings} finding${a.findings === 1 ? "" : "s"}` : "";
	return `${a.key} — ${a.status}${cells}${found}`;
}

/** "a, b, c (+N more)": a list that says what it left out. */
function bounded(items: string[], limit: number): string {
	const shown = items.slice(0, limit).join(", ");
	return items.length > limit ? `${shown} (+${items.length - limit} more)` : shown;
}

/**
 * The one bounded line for the per-request tail block, or "" when no surface
 * is recorded: at the start of an engagement every source directory is
 * unmapped, and saying so on every request is noise that trains the reader to
 * skip the block. Settled areas are counted rather than named; the rest are
 * named in path order, up to `limit`, and what was left out is stated.
 */
export function renderAreasLine(view: AreasView, limit = 8): string {
	if (view.areas.length === 0) return "";
	const settled = view.areas.filter((a) => a.status === "settled").length;
	const open = view.areas.filter((a) => a.status !== "settled").map((a) => `${a.key} (${a.status}${a.findings > 0 ? `, ${a.findings} finding${a.findings === 1 ? "" : "s"}` : ""})`);
	const parts = [`Areas: ${view.areas.length} from the recorded surface, ${settled} settled.`];
	if (open.length > 0) parts.push(`Not settled: ${bounded(open, limit)}.`);
	if (view.unmapped.length > 0) parts.push(`Source directories with no recorded surface: ${bounded(view.unmapped, limit)}.`);
	return parts.join(" ");
}

/** Every area on its own line, then the unmapped directories: the settle reply and `recall status`. */
export function renderAreas(view: AreasView, limit = Number.POSITIVE_INFINITY): string[] {
	if (view.areas.length === 0 && view.unmapped.length === 0) return [];
	const lines = view.areas.slice(0, limit).map((a) => `  ${areaLabel(a)}`);
	if (view.areas.length > limit) lines.push(`  (+${view.areas.length - limit} more)`);
	if (view.depth !== undefined) lines.push(`  (directories grouped at depth ${view.depth} to stay near ${MAX_AREAS} areas)`);
	if (view.unmapped.length > 0) {
		lines.push(`  unmapped — no recorded surface: ${bounded(view.unmapped, limit)}`);
	}
	return lines;
}
