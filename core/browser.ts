/**
 * The engagement browser — walk the surface, walk the hypotheses, read the ones
 * that were refuted.
 *
 * The panel already showed *counts*: 41 surface elements, 168 refuted, 6
 * confirmed. Counts are the wrong unit for the thing pired claims to sell. In an
 * engagement the confirmed hypotheses become the findings and the refuted ones
 * are the evidence that everything else was actually checked — the difference
 * between "we found three bugs" and "we tested 174 hypotheses across 10
 * endpoints and three held". That artifact was write-only: reachable by asking
 * the agent, or by parsing .jsonl by hand, and by nothing a person could look at
 * while the work happened.
 *
 * It also hides the failure that cost this project three benchmark passes. A
 * `hypotheses` line reading `0` is easy to skip; a list that is conspicuously
 * empty is not.
 *
 * Pure module in three separately testable pieces:
 *   buildBrowserModel — records and matrix, as rows
 *   reduceBrowser     — one keystroke, as a state transition
 *   renderBrowser     — model and state, as lines
 *
 * Keys arrive as **semantic** names, not escape sequences: recognising `\x1b[A`
 * needs pi-tui's matchesKey, and pi-tui is a host import this module is not
 * allowed. The adapter translates; this decides.
 */

import { CELL_GLYPH } from "./coverage-panel.ts";
import type { Tone } from "./coverage-panel.ts";
import { frameLines, RULE } from "./frame.ts";
import type {
	CoverageCell,
	Severity,
	CoverageStatus,
	FindingRecord,
	HypothesisOutcome,
	HypothesisRecord,
	InventoryKind,
	InventoryRecord,
	LedgerRecord,
} from "./ontology.ts";

/** The coverage tones plus the one this view adds for the cursor row. */
export type BrowserTone = Tone | "selected" | "accent";

export type BrowserView =
	| "coverage" | "class"
	| "surface" | "element"
	| "hypotheses" | "hypothesis"
	| "findings" | "finding";

/** Outcome filter for the hypotheses list. `open` is anything not yet settled. */
export type HypothesisFilter = "all" | "confirmed" | "refuted" | "open";

export type BrowserKey =
	| "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom"
	| "in" | "out" | "close" | "switch" | "refresh"
	| "filter:all" | "filter:confirmed" | "filter:refuted" | "filter:open";

export interface SurfaceRow {
	id: string;
	kind: InventoryKind;
	label: string;
	/** Per-class status, in the model's class order. */
	statuses: CoverageStatus[];
	settled: number;
	askable: number;
	findings: number;
}

export interface HypothesisRow {
	id: string;
	class: string;
	outcome: HypothesisOutcome;
	/** Resolved to the element's label when the target is an inventory id. */
	targetLabel: string;
	targetId?: string;
	statement: string;
	method?: string;
	evidence?: string;
	findingId?: string;
}

export interface FindingRow {
	id: string;
	title: string;
	severity: Severity;
	class?: string;
	cwe?: string;
	status?: string;
	targetLabel: string;
	description?: string;
	repro?: string;
	evidence?: string[];
}

export interface BrowserModel {
	engagement: string;
	classes: Array<{ id: string; title: string }>;
	surface: SurfaceRow[];
	hypotheses: HypothesisRow[];
	findings: FindingRow[];
	counts: Record<HypothesisFilter, number>;
}

export interface BrowserState {
	view: BrowserView;
	cursor: number;
	scroll: number;
	filter: HypothesisFilter;
	/** Held while drilled into one element, and kept so `out` can return to it. */
	elementId?: string;
	/** Held while drilled into one coverage class. */
	classId?: string;
	hypothesisId?: string;
	findingId?: string;
}

export function initialState(view: BrowserView = "surface"): BrowserState {
	return { view, cursor: 0, scroll: 0, filter: "all" };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_TONE: Record<Severity, BrowserTone> = {
	// low is neither "clear" nor "accent". Green means "ruled out" everywhere else
	// in the tool, so a green low-severity bug says the opposite of what it is —
	// but in themes/pired.json `accent` and `error` are the SAME red, which paints
	// low identically to critical and redder than medium. "blocked" is the muted
	// grey tone: present, ranked below medium, and not shouting.
	critical: "vulnerable", high: "vulnerable", medium: "testing", low: "blocked", info: "muted",
};

const OUTCOME_TONE: Record<HypothesisOutcome, Tone> = {
	confirmed: "vulnerable",
	refuted: "clear",
	testing: "testing",
	proposed: "not-tested",
	inconclusive: "blocked",
};

/** How a cell status reads when no hypothesis carries the text. */
const STATUS_WORD: Record<CoverageStatus, string> = {
	clear: "clear", vulnerable: "vulnerable", testing: "testing",
	blocked: "blocked", "not-tested": "not tested", "n/a": "does not apply",
};

const OUTCOME_GLYPH: Record<HypothesisOutcome, string> = {
	confirmed: "▲", refuted: "●", testing: "◐", proposed: "·", inconclusive: "⊘",
};

/** How an inventory record names itself, by kind. */
export function elementLabel(rec: InventoryRecord): string {
	switch (rec.kind) {
		case "host": return rec.value;
		case "service": return `${rec.proto}/${rec.port}${rec.name ? ` ${rec.name}` : ""}`;
		case "endpoint": return `${rec.method ? `${rec.method} ` : ""}${rec.path}`;
		case "param": return rec.name + (rec.location ? ` (${rec.location})` : "");
		case "tech": return rec.name + (rec.version ? ` ${rec.version}` : "");
		default: return (rec as { id: string }).id;
	}
}

/**
 * How any ledger record names itself to a person.
 *
 * Every view that has to say "this one" — a tool result reporting what a repeat
 * matched, the duplicate sweep listing what it would fold — needs the same
 * answer, and an id is not it. Kept beside elementLabel so there is one place
 * where a record's human name is decided.
 */
export function recordLabel(rec: LedgerRecord): string {
	if (rec.kind === "finding") return rec.title;
	if (rec.kind === "hypothesis") return `${rec.class} on ${rec.target}`;
	if (rec.kind === "blocker") return rec.question;
	if (rec.kind === "loot") return rec.handle;
	return elementLabel(rec);
}

// --- model -----------------------------------------------------------------

export interface BuildModelInput {
	engagement: string;
	classes: Array<{ id: string; title: string }>;
	cells: CoverageCell[];
	inventory: InventoryRecord[];
	hypotheses: HypothesisRecord[];
	findings: FindingRecord[];
}

export function buildBrowserModel(input: BuildModelInput): BrowserModel {
	const { engagement, classes, cells, inventory, hypotheses, findings } = input;
	const labels = new Map(inventory.map((r) => [r.id, elementLabel(r)]));

	// Cells arrive class-major; index them so each element's row can be read in
	// class order regardless of how the matrix was laid out.
	const byElement = new Map<string, Map<string, CoverageStatus>>();
	for (const c of cells) {
		let row = byElement.get(c.element);
		if (!row) byElement.set(c.element, (row = new Map()));
		row.set(c.class, c.status);
	}

	const findingsPer = new Map<string, number>();
	for (const f of findings) {
		const t = typeof f.target === "string" ? f.target : undefined;
		if (t) findingsPer.set(t, (findingsPer.get(t) ?? 0) + 1);
	}

	// Driven by the inventory, not by the matrix. `computeCoverage` only sees the
	// kinds the checklist declares as surface, so building rows from the cells
	// silently drops anything the agent recorded outside that set — and a surface
	// browser that hides recorded surface is worse than no browser. An element
	// with no cells is shown with an all-`n/a` bar: nothing about it is askable,
	// which is a fact worth seeing rather than an absence worth hiding.
	const surface: SurfaceRow[] = inventory.map((rec) => {
		const row = byElement.get(rec.id);
		const statuses: CoverageStatus[] = classes.map((c) => (row ? (row.get(c.id) ?? "not-tested") : "n/a"));
		return {
			id: rec.id,
			kind: rec.kind,
			label: labels.get(rec.id) ?? rec.id,
			statuses,
			settled: statuses.filter((s) => s === "clear" || s === "vulnerable").length,
			askable: statuses.filter((s) => s !== "n/a").length,
			findings: findingsPer.get(rec.id) ?? 0,
		};
	});
	// Least-settled first: the reason to open this view is to find the rows
	// nothing has touched, and burying them under finished ones defeats it.
	//
	// An element with nothing askable sorts last rather than first. Zero of zero
	// is not the most neglected row in the engagement, it is a row with no work in
	// it, and putting a host with no applicable class above an untested endpoint
	// inverts the one ordering this view exists to provide.
	const progress = (r: SurfaceRow): number => (r.askable === 0 ? 2 : r.settled / r.askable);
	surface.sort((a, b) => progress(a) - progress(b) || a.label.localeCompare(b.label));

	const rows: HypothesisRow[] = hypotheses.map((h) => {
		const target = typeof h.target === "string" ? h.target : undefined;
		return {
			id: h.id,
			class: h.class,
			outcome: h.outcome,
			targetId: target && labels.has(target) ? target : undefined,
			targetLabel: (target && labels.get(target)) || target || "—",
			statement: h.statement,
			method: h.method,
			evidence: h.evidence,
			findingId: h.findingId,
		};
	});

	// Worst first. A findings view in recording order buries a critical under six
	// info rows, which is the opposite of what the list is for.
	const findingRows: FindingRow[] = findings
		.map((f) => {
			const t = typeof f.target === "string" ? f.target : undefined;
			return {
				id: f.id,
				title: f.title,
				severity: f.severity,
				class: f.class,
				cwe: f.cwe,
				status: f.status,
				targetLabel: (t && labels.get(t)) || t || "—",
				description: f.description,
				repro: f.repro,
				evidence: f.evidence,
			};
		})
		.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title));

	const settled = (o: HypothesisOutcome): boolean => o === "confirmed" || o === "refuted";
	return {
		engagement,
		classes,
		surface,
		hypotheses: rows,
		findings: findingRows,
		counts: {
			all: rows.length,
			confirmed: rows.filter((h) => h.outcome === "confirmed").length,
			refuted: rows.filter((h) => h.outcome === "refuted").length,
			open: rows.filter((h) => !settled(h.outcome)).length,
		},
	};
}

// --- selection -------------------------------------------------------------

export function visibleHypotheses(model: BrowserModel, state: BrowserState): HypothesisRow[] {
	const base = state.view === "element" && state.elementId
		? model.hypotheses.filter((h) => h.targetId === state.elementId)
		: model.hypotheses;
	switch (state.filter) {
		case "confirmed": return base.filter((h) => h.outcome === "confirmed");
		case "refuted": return base.filter((h) => h.outcome === "refuted");
		case "open": return base.filter((h) => h.outcome !== "confirmed" && h.outcome !== "refuted");
		default: return base;
	}
}

function rowCount(model: BrowserModel, state: BrowserState, detailRows = 0): number {
	switch (state.view) {
		case "surface": return model.surface.length;
		case "hypotheses": return visibleHypotheses(model, state).length;
		case "element": return model.classes.length;
		case "findings": return model.findings.length;
		// The matrix, class-major: one row per class, then that class down the
		// whole surface. Both are views over data the model already carries.
		case "coverage": return model.classes.length;
		case "class": return model.surface.length;
		// A detail view scrolls over its own rendered lines, whose count depends on
		// the width it wrapped at — which only the caller knows. Zero here is what
		// pinned the cursor and made the detail unscrollable.
		case "finding":
		case "hypothesis": return detailRows;
		default: return 0;
	}
}

/**
 * How many lines the current view can scroll through.
 *
 * Detail views wrap to the available width, so their length is a render-time
 * fact. The adapter measures it with the width it last drew at and hands it to
 * reduceBrowser.
 */
/**
 * The width a body is laid out at, once the frame's borders and gutters are
 * taken off. Exported because detailRowCount must measure at exactly the width
 * renderBrowser wraps at — a 4-column disagreement silently made the last lines
 * of a finding (its evidence paths) unreachable.
 */
export function contentWidth(width: number): number {
	return Math.max(8, width - 4);
}

export function detailRowCount(o: RenderOptions): number {
	const co: RenderOptions = { ...o, width: contentWidth(o.width) };
	return detailRowCountAt(co);
}

function detailRowCountAt(o: RenderOptions): number {
	switch (o.state.view) {
		case "finding": return findingLines(o).length;
		case "hypothesis": return hypothesisLines(o).length;
		default: return 0;
	}
}

// --- input -----------------------------------------------------------------

export function reduceBrowser(state: BrowserState, key: BrowserKey, model: BrowserModel, viewport: number, detailRows = 0): BrowserState | "close" {
	const total = rowCount(model, state, detailRows);
	const page = Math.max(1, viewport);
	const detail = state.view === "finding" || state.view === "hypothesis";
	const move = (n: number): BrowserState => {
		if (detail) {
			// No cursor in a detail pane: the keys move the window itself, clamped so
			// the last line can reach the top of an empty screen but no further.
			const maxScroll = Math.max(0, total - page);
			const scroll = Math.max(0, Math.min(n, maxScroll));
			return { ...state, cursor: 0, scroll };
		}
		const cursor = Math.max(0, Math.min(n, Math.max(0, total - 1)));
		// Scroll by the least that keeps the cursor inside the window.
		let scroll = state.scroll;
		if (cursor < scroll) scroll = cursor;
		if (cursor >= scroll + page) scroll = cursor - page + 1;
		return { ...state, cursor, scroll: Math.max(0, scroll) };
	};

	switch (key) {
		case "up": return move((detail ? state.scroll : state.cursor) - 1);
		case "down": return move((detail ? state.scroll : state.cursor) + 1);
		case "pageUp": return move((detail ? state.scroll : state.cursor) - page);
		case "pageDown": return move((detail ? state.scroll : state.cursor) + page);
		case "top": return move(0);
		case "bottom": return move(detail ? total : total - 1);
		case "close": return "close";
		// Handled by the adapter, which owns the workspace read. Returning state
		// unchanged keeps the reducer pure and the cursor where it was.
		case "refresh": return state;
		case "switch": {
			const order: BrowserView[] = ["coverage", "surface", "hypotheses", "findings"];
			const here = order.indexOf(
				state.view === "class" ? "coverage"
					: state.view === "element" ? "surface"
						: state.view === "hypothesis" ? "hypotheses"
							: state.view === "finding" ? "findings"
								: state.view);
			const next = order[(Math.max(0, here) + 1) % order.length] as BrowserView;
			return { ...initialState(next), filter: state.filter };
		}
		case "filter:all": return { ...state, filter: "all", cursor: 0, scroll: 0 };
		case "filter:confirmed": return { ...state, filter: "confirmed", cursor: 0, scroll: 0 };
		case "filter:refuted": return { ...state, filter: "refuted", cursor: 0, scroll: 0 };
		case "filter:open": return { ...state, filter: "open", cursor: 0, scroll: 0 };
		case "out": {
			if (state.view === "finding") return { ...state, view: "findings", findingId: undefined, cursor: 0, scroll: 0 };
			if (state.view === "hypothesis") {
				const back: BrowserView = state.classId ? "class" : state.elementId ? "element" : "hypotheses";
				return { ...state, view: back, hypothesisId: undefined, cursor: 0, scroll: 0 };
			}
			if (state.view === "element") return { ...state, view: "surface", elementId: undefined, cursor: 0, scroll: 0 };
			if (state.view === "class") return { ...state, view: "coverage", classId: undefined, cursor: 0, scroll: 0 };
			return "close";
		}
		case "in": {
			if (state.view === "surface") {
				const row = model.surface[state.cursor];
				return row ? { ...state, view: "element", elementId: row.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "findings") {
				const row = model.findings[state.cursor];
				return row ? { ...state, view: "finding", findingId: row.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "hypotheses") {
				const row = visibleHypotheses(model, state)[state.cursor];
				return row ? { ...state, view: "hypothesis", hypothesisId: row.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "coverage") {
				const cls = model.classes[state.cursor];
				return cls ? { ...state, view: "class", classId: cls.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "class") {
				// Into the hypothesis that settled this cell. A cell with none is the
				// gap the matrix exists to show, so it stays put.
				const el = model.surface[state.cursor];
				const hyp = el && model.hypotheses.find((h) => h.targetId === el.id && h.class === state.classId);
				return hyp ? { ...state, view: "hypothesis", hypothesisId: hyp.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "element") {
				// From a class row into the hypothesis that settled it. A class with no
				// hypothesis is exactly what this view exists to show, so it stays put
				// rather than opening something unrelated.
				const cls = model.classes[state.cursor];
				const hyp = cls && model.hypotheses.find((h) => h.targetId === state.elementId && h.class === cls.id);
				return hyp ? { ...state, view: "hypothesis", hypothesisId: hyp.id, cursor: 0, scroll: 0 } : state;
			}
			return state;
		}
		default: return state;
	}
}

// --- render ----------------------------------------------------------------

export interface RenderOptions {
	model: BrowserModel;
	state: BrowserState;
	width: number;
	/** Rows available for the list body, excluding chrome. */
	height: number;
	ink: (tone: BrowserTone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
	/**
	 * Hard ceiling on emitted lines, when the caller knows it.
	 *
	 * pi slices an overlay at maxHeight and the clipping takes the BOTTOM — the
	 * legend and the closing border. Below the chrome's own floor the box cannot
	 * fit at all, so the view degrades to a bare list rather than a sliced frame.
	 */
	maxLines?: number;
	/**
	 * Paint the cursor row's background.
	 *
	 * A foreground highlight cannot work here: the row is already inked, and a
	 * theme's fg() resets with \x1b[39m, so the first inner colour ends the outer
	 * one and the selected row renders *less* coloured than its neighbours. A
	 * background resets with \x1b[49m, which inner foreground codes never emit.
	 * Optional so core stays testable against a plain ASCII stand-in.
	 */
	highlight?: (s: string) => string;
}

const MIN_WIDTH = 32;
/** Longest surface label we reserve; the bar and counts get the rest. */
const MAX_LABEL = 42;
const MAX_BAR = 24;

/** Pad to a visible width, using the injected measure so ANSI never miscounts. */
function pad(s: string, to: number, measure: (x: string) => number): string {
	const gap = to - measure(s);
	return gap > 0 ? s + " ".repeat(gap) : s;
}

/**
 * A row of the list, with the cursor row painted rather than marked.
 *
 * A leading `▸` alone is easy to lose in a dense list; the tone carries it, and
 * the marker stays as a second, redundant cue for terminals where the selected
 * background does not render.
 */
function row(selected: boolean, body: string, width: number, o: RenderOptions): string {
	const line = `${selected ? "▸ " : "  "}${body}`;
	const clipped = o.truncate(line, width);
	if (!selected) return clipped;
	const filled = pad(clipped, width, o.measure);
	return o.highlight ? o.highlight(filled) : o.ink("selected", filled);
}

/**
 * The tally line, right-aligned under the frame's title.
 *
 * The title itself now lives in the box's top edge, the way the rail and the
 * coverage box set theirs, so this carries only the count.
 */
function header(right: string, o: RenderOptions): string[] {
	const { width, ink, measure, truncate } = o;
	const text = truncate(right, width);
	return [pad("", Math.max(0, width - measure(text)), measure) + ink("muted", text), RULE];
}

/** The key legend, which differs per view and is the only affordance a user gets. */
function footer(o: RenderOptions): string[] {
	const { state, ink, width } = o;
	const keys = state.view === "hypothesis" || state.view === "finding"
		? "↑↓ scroll · esc back · q close"
		: state.view === "element"
			? "↑↓ move · ⏎ open · esc back · tab hypotheses · q close"
			: state.view === "coverage"
				? "↑↓ move · ⏎ open class · tab surface · R reload · q close"
				: state.view === "class"
					? "↑↓ move · ⏎ open · esc back · tab surface · q close"
					: state.view === "surface"
						? "↑↓ move · ⏎ open · tab hypotheses · R reload · q close"
				: state.view === "findings"
					? "↑↓ move · ⏎ open · tab coverage · R reload · q close"
					: "↑↓ move · ⏎ open · a/c/r/o filter · tab findings · R reload · q close";
	return [ink("muted", o.truncate(keys, width))];
}

/** `↓ N more` when the list runs past the window, as the rail marks its overflow. */
function overflow(o: RenderOptions, total: number, bodyLines: number): string {
	// An empty state is one line of prose, not a truncated list: counting the
	// rows that "would" have followed promises content that does not exist.
	if (bodyLines === 0 || total === 0) return "";
	const shown = o.state.scroll + Math.min(o.height, bodyLines);
	const left = total - shown;
	return left > 0 ? o.ink("muted", `↓ ${left} more`) : "";
}

function surfaceBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	if (model.surface.length === 0) {
		// Same words as core/coverage-panel.ts and docs/coverage.md. Two texts for
		// one condition reads as two different conditions.
		return [ink("muted", "  no surface recorded yet — run recon, or record inventory"), ""];
	}
	const barLen = Math.min(MAX_BAR, model.classes.length);
	const right = barLen + 1 + 7 + 4;
	const labelW = Math.max(12, Math.min(MAX_LABEL, width - right - 4));

	const out: string[] = [];
	const slice = model.surface.slice(state.scroll, state.scroll + o.height);
	for (const [i, r] of slice.entries()) {
		const idx = state.scroll + i;
		const bar = r.statuses.slice(0, barLen).map((s) => ink(s, CELL_GLYPH[s])).join("");
		const count = `${r.settled}/${r.askable}`;
		const flag = r.findings > 0 ? ink("vulnerable", ` ★${r.findings}`) : "";
		const label = pad(truncate(r.label, labelW), labelW, measure);
		const kind = ink("muted", pad(r.kind.slice(0, 4), 5, measure));
		out.push(row(idx === state.cursor, `${kind}${label} ${bar} ${pad(count, 7, measure)}${flag}`, width, o));
	}
	return out;
}

/**
 * The matrix, class-major: one row per checklist class, its cells across the
 * whole recorded surface.
 *
 * The transpose of elementBody. Both read the same `surface[].statuses`, which
 * is built in class order — so a class row is that column of the matrix and no
 * new data has to be assembled.
 */
function coverageBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	if (model.classes.length === 0) return [ink("muted", "  no checklist seeded for this engagement")];
	if (model.surface.length === 0) {
		return [ink("muted", "  no surface recorded yet — run recon, or record inventory")];
	}
	const n = model.surface.length;
	// Size the count column from the widest number it must hold. A fixed 7 cut
	// "41/41" to "41/4", which reads as a different, wrong denominator.
	const countW = `${n}/${n}`.length;
	const barLen = Math.min(MAX_BAR, n);
	const labelW = Math.max(12, Math.min(MAX_LABEL, width - barLen - countW - 6));
	const out: string[] = [];
	for (const [i, cls] of model.classes.slice(state.scroll, state.scroll + o.height).entries()) {
		const idx = state.scroll + i;
		const statuses = model.surface.map((el) => el.statuses[idx] ?? "not-tested");
		const askable = statuses.filter((st) => st !== "n/a").length;
		const settled = statuses.filter((st) => st === "clear" || st === "vulnerable").length;
		// Reserve room for the "+N" inside the bar rather than past it, exactly as
		// renderCoveragePanel does. Dropping elements with no marker misreports the
		// surface: 41 elements silently drawn as 24.
		const hidden = n - barLen;
		const marker = hidden > 0 ? `+${hidden}` : "";
		const cells = statuses.slice(0, Math.max(0, barLen - marker.length))
			.map((st) => ink(st, CELL_GLYPH[st])).join("");
		const bar = cells + (marker ? ink("muted", marker) : "");
		const barPad = " ".repeat(Math.max(0, barLen - measure(bar)));
		const label = pad(truncate(cls.title || cls.id, labelW), labelW, measure);
		const count = pad(`${settled}/${askable}`, countW, measure);
		out.push(row(idx === state.cursor, `${label} ${bar}${barPad} ${count}`, width, o));
	}
	return out;
}

/** One class down the surface: which elements it is settled on, and which not. */
function classBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	const idxOfClass = model.classes.findIndex((c) => c.id === state.classId);
	if (idxOfClass < 0) return [ink("muted", "  class not found")];
	const nameW = Math.max(16, Math.min(38, Math.floor(width * 0.4)));
	const out: string[] = [];
	for (const [i, el] of model.surface.slice(state.scroll, state.scroll + o.height).entries()) {
		const idx = state.scroll + i;
		const status = el.statuses[idxOfClass] ?? "not-tested";
		const hyp = model.hypotheses.find((h) => h.targetId === el.id && h.class === state.classId);
		const glyph = ink(status, CELL_GLYPH[status]);
		const name = pad(truncate(el.label, nameW), nameW, measure);
		const settledWithoutHypothesis = status === "clear" || status === "vulnerable";
		const rest = hyp
			? hyp.statement
			: ink("muted", STATUS_WORD[status] + (settledWithoutHypothesis ? " · no hypothesis recorded" : ""));
		out.push(row(idx === state.cursor, `${glyph} ${name} ${rest}`, width, o));
	}
	return out;
}

function elementBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	const el = model.surface.find((s) => s.id === state.elementId);
	if (!el) return [ink("muted", "  element not found")];
	const nameW = 18;
	const out: string[] = [];
	const slice = model.classes.slice(state.scroll, state.scroll + o.height);
	for (const [i, cls] of slice.entries()) {
		const idx = state.scroll + i;
		const status = el.statuses[idx] ?? "not-tested";
		const hyp = model.hypotheses.find((h) => h.targetId === el.id && h.class === cls.id);
		const glyph = ink(status, CELL_GLYPH[status]);
		const name = pad(truncate(cls.title || cls.id, nameW), nameW, measure);
		// Never print text that contradicts the glyph. The glyph is the matrix
		// status and the text was the first matching hypothesis, so a cell settled
		// without one rendered as "● … not tested" — clear and untested at once.
		// With no hypothesis the row states the status itself, and says so when a
		// settled cell has nothing recorded behind it, which is worth seeing.
		const settledWithoutHypothesis = status === "clear" || status === "vulnerable";
		const rest = hyp
			? hyp.statement
			: ink("muted", STATUS_WORD[status] + (settledWithoutHypothesis ? " · no hypothesis recorded" : ""));
		out.push(row(idx === state.cursor, `${glyph} ${name} ${rest}`, width, o));
	}
	return out;
}

function hypothesesBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	const rows = visibleHypotheses(model, state);
	if (rows.length === 0) {
		const why = model.hypotheses.length === 0
			? "no hypotheses recorded — the coverage mechanism has not engaged"
			: `no ${state.filter} hypotheses`;
		return [ink("muted", `  ${why}`)];
	}
	const classW = 14;
	const targetW = Math.min(24, Math.max(10, Math.floor((width - classW - 8) * 0.35)));
	const out: string[] = [];
	for (const [i, h] of rows.slice(state.scroll, state.scroll + o.height).entries()) {
		const idx = state.scroll + i;
		const glyph = ink(OUTCOME_TONE[h.outcome], OUTCOME_GLYPH[h.outcome]);
		const cls = ink("label", pad(truncate(h.class, classW), classW, measure));
		const tgt = ink("muted", pad(truncate(h.targetLabel, targetW), targetW, measure));
		out.push(row(idx === state.cursor, `${glyph} ${cls} ${tgt} ${h.statement}`, width, o));
	}
	return out;
}

function findingsBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	if (model.findings.length === 0) {
		return [ink("muted", "  no findings recorded")];
	}
	const sevW = 9;
	const clsW = 12;
	const out: string[] = [];
	for (const [i, f] of model.findings.slice(state.scroll, state.scroll + o.height).entries()) {
		const idx = state.scroll + i;
		const sev = ink(SEVERITY_TONE[f.severity], pad(f.severity, sevW, measure));
		const cls = ink("muted", pad(truncate(f.cwe || f.class || "", clsW), clsW, measure));
		out.push(row(idx === state.cursor, `${sev} ${cls} ${f.title}`, width, o));
	}
	return out;
}

/**
 * Every line of a finding's detail, unsliced.
 *
 * Split from the body so the reducer can count them. rowCount used to return 0
 * for this view, which clamped the cursor at 0 and made `scroll` unreachable —
 * so a finding's description, repro and evidence were invisible past the first
 * screenful while the footer advertised "↑↓ scroll".
 */
function findingLines(o: RenderOptions): string[] {
	const { model, state, width, ink, measure } = o;
	const f = model.findings.find((x) => x.id === state.findingId);
	if (!f) return [ink("muted", "  finding not found")];
	const labelW = 12;
	const field = (k: string, v: string, tone: BrowserTone = "label"): string[] =>
		wrap(v, Math.max(8, width - labelW - 2), measure).map((line, i) =>
			`${ink("muted", pad(i === 0 ? k : "", labelW, measure))}${ink(tone, line)}`);

	// Title first, metadata after — as core/panel.ts:renderFindingDetail has it.
	// Leading with severity and CWE means you read a finding's classification
	// before its name.
	const out: string[] = [
		...wrap(f.title, width, measure).map((l) => ink("label", l)),
		"",
		...field("severity", f.severity, SEVERITY_TONE[f.severity]),
		...(f.cwe ? field("cwe", f.cwe) : []),
		...(f.class ? field("class", f.class) : []),
		...field("target", f.targetLabel),
		...(f.status ? field("status", f.status, "muted") : []),
	];
	if (f.description) out.push("", ...wrap(f.description, width, measure).map((l) => ink("body", l)));
	if (f.repro) out.push("", ...field("repro", f.repro, "muted"));
	for (const e of f.evidence ?? []) out.push(...field("evidence", e, "muted"));
	return out;
}

function findingBody(o: RenderOptions): string[] {
	return findingLines(o).slice(o.state.scroll, o.state.scroll + o.height).map((l) => o.truncate(l, o.width));
}

/** Wrap on spaces; a hypothesis statement is a sentence, not a path. */
function wrap(text: string, width: number, measure: (s: string) => number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		const next = line ? `${line} ${w}` : w;
		if (measure(next) > width && line) {
			lines.push(line);
			line = w;
		} else line = next;
	}
	if (line) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

/** Every line of a hypothesis's detail, unsliced. See findingLines. */
function hypothesisLines(o: RenderOptions): string[] {
	const { model, state, width, ink, measure } = o;
	const h = model.hypotheses.find((x) => x.id === state.hypothesisId);
	if (!h) return [ink("muted", "  hypothesis not found")];
	const labelW = 10;
	const field = (k: string, v: string, tone: BrowserTone = "label"): string[] =>
		wrap(v, Math.max(8, width - labelW - 2), measure).map((line, i) =>
			`${ink("muted", pad(i === 0 ? k : "", labelW, measure))}${ink(tone, line)}`);

	const out: string[] = [
		...field("outcome", `${OUTCOME_GLYPH[h.outcome]} ${h.outcome}`, OUTCOME_TONE[h.outcome]),
		...field("class", h.class),
		...field("target", h.targetLabel),
		"",
		...wrap(h.statement, width, measure).map((l) => ink("label", l)),
	];
	if (h.method) out.push("", ...field("method", h.method, "muted"));
	if (h.evidence) out.push(...field("evidence", h.evidence, "muted"));
	if (h.findingId) out.push(...field("finding", h.findingId, "vulnerable"));
	return out;
}

function hypothesisBody(o: RenderOptions): string[] {
	return hypothesisLines(o).slice(o.state.scroll, o.state.scroll + o.height).map((l) => o.truncate(l, o.width));
}

/** Title for the box's top edge, in the rail's `⦿ name · qualifier` shape. */
function frameTitle(o: RenderOptions): string {
	const { model, state } = o;
	switch (state.view) {
		case "coverage": return `⦿ coverage · ${model.engagement}`;
		case "class": {
			const cls = model.classes.find((c) => c.id === state.classId);
			return `⦿ ${cls?.title ?? state.classId ?? "class"} · ${model.engagement}`;
		}
		case "surface": return `⦿ surface · ${model.engagement}`;
		case "element": {
			const el = model.surface.find((s) => s.id === state.elementId);
			return `⦿ ${el ? el.label : "element"} · ${model.engagement}`;
		}
		case "hypotheses": {
			const filt = state.filter === "all" ? "" : ` [${state.filter}]`;
			return `⦿ hypotheses${filt} · ${model.engagement}`;
		}
		case "findings": return `⦿ findings · ${model.engagement}`;
		case "finding": return `⦿ finding · ${model.engagement}`;
		default: return `⦿ hypothesis · ${model.engagement}`;
	}
}

/** The tally and the body, before any framing. */
function parts(o: RenderOptions): { tally: string; body: string[]; total: number } {
	const { model, state } = o;
	switch (state.view) {
		case "coverage": {
			const m = model.surface.reduce((a, r) => ({ s: a.s + r.settled, k: a.k + r.askable }), { s: 0, k: 0 });
			const pct = m.k > 0 ? Math.round((m.s / m.k) * 100) : 0;
			return {
				tally: `${pct}% · ${model.classes.length} classes · ${m.k - m.s} gaps`,
				body: coverageBody(o), total: model.classes.length,
			};
		}
		case "class": {
			const i = model.classes.findIndex((c) => c.id === state.classId);
			const statuses = model.surface.map((el) => el.statuses[i] ?? "not-tested");
			const askable = statuses.filter((st) => st !== "n/a").length;
			const settled = statuses.filter((st) => st === "clear" || st === "vulnerable").length;
			return {
				tally: `${settled}/${askable} settled across ${model.surface.length} elements`,
				body: classBody(o), total: model.surface.length,
			};
		}
		case "surface": {
			const settled = model.surface.reduce((a, r) => a + r.settled, 0);
			const askable = model.surface.reduce((a, r) => a + r.askable, 0);
			return {
				tally: `${model.surface.length} elements · ${settled}/${askable} settled`,
				body: surfaceBody(o), total: model.surface.length,
			};
		}
		case "element": {
			const el = model.surface.find((s) => s.id === state.elementId);
			return {
				tally: el ? `${el.kind} · ${el.settled}/${el.askable} settled` : "",
				body: elementBody(o), total: model.classes.length,
			};
		}
		case "hypotheses": {
			const c = model.counts;
			return {
				tally: `${c.confirmed} confirmed · ${c.refuted} refuted · ${c.open} open`,
				body: hypothesesBody(o), total: visibleHypotheses(model, state).length,
			};
		}
		case "findings": {
			const worst = model.findings[0];
			return {
				tally: model.findings.length === 0 ? "none" : `${model.findings.length} · worst ${worst?.severity ?? "-"}`,
				body: findingsBody(o), total: model.findings.length,
			};
		}
		case "finding": {
			const lines = findingLines(o);
			return { tally: `${lines.length} lines`, body: findingBody(o), total: lines.length };
		}
		default: {
			const lines = hypothesisLines(o);
			return { tally: `${lines.length} lines`, body: hypothesisBody(o), total: lines.length };
		}
	}
}

/**
 * The browser, drawn in the same box the rail and the coverage matrix use.
 *
 * Before this it was two bare rules around a list flush against the overlay
 * edge — the only view in the tool without a frame, which read as a raw dump
 * beside everything else. The box, the title in the top edge and the key legend
 * welded into the bottom section all come from core/frame.ts, so there is one
 * chrome rather than three.
 */
export function renderBrowser(o: RenderOptions): string[] {
	if (o.width < MIN_WIDTH) return [o.truncate(o.ink("muted", "too narrow"), o.width)];

	// Two columns for the border, one gutter each side, so nothing sits against
	// the frame: content flush to a border reads as content that overflowed it.
	const contentW = contentWidth(o.width);
	const co: RenderOptions = { ...o, width: contentW };
	const { tally, body, total } = parts(co);

	// An empty state returns one prose line; `total` is the row count the view
	// would have had. Pass both so the marker is only drawn over real rows.
	const isEmpty = total === 0 || body.length === 0
		|| (body.length === 1 && total > 1 && o.state.scroll === 0 && !body[0]?.includes("▸"));
	const more = overflow(co, total, isEmpty ? 0 : body.length);
	const keys = footer(co)[0] ?? "";
	const legend = more
		? pad(keys, Math.max(0, contentW - co.measure(more)), co.measure) + more
		: keys;

	// Chrome is two borders, the tally, two rules and the legend.
	const CHROME = 6;
	const budget = o.maxLines ?? Number.MAX_SAFE_INTEGER;
	if (budget < CHROME + 1) {
		// Too short to box. A bare list beats a frame with its bottom sliced off.
		return body.slice(0, Math.max(1, budget)).map((l) => o.truncate(l, o.width));
	}
	const rows = Math.max(1, Math.min(body.length, budget - CHROME));

	const lines = [
		...header(tally, co),
		...body.slice(0, rows),
		RULE,
		legend,
	].map((l) => (l.startsWith(RULE) ? l : ` ${l}`));

	return frameLines(lines, frameTitle(o), o.width, (t, x) => o.ink(t, x), o.measure, o.truncate);
}
