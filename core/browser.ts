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
import type {
	CoverageCell,
	CoverageStatus,
	FindingRecord,
	HypothesisOutcome,
	HypothesisRecord,
	InventoryKind,
	InventoryRecord,
} from "./ontology.ts";

/** The coverage tones plus the one this view adds for the cursor row. */
export type BrowserTone = Tone | "selected";

export type BrowserView = "surface" | "element" | "hypotheses" | "hypothesis";

/** Outcome filter for the hypotheses list. `open` is anything not yet settled. */
export type HypothesisFilter = "all" | "confirmed" | "refuted" | "open";

export type BrowserKey =
	| "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom"
	| "in" | "out" | "close" | "switch"
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

export interface BrowserModel {
	engagement: string;
	classes: Array<{ id: string; title: string }>;
	surface: SurfaceRow[];
	hypotheses: HypothesisRow[];
	counts: Record<HypothesisFilter, number>;
}

export interface BrowserState {
	view: BrowserView;
	cursor: number;
	scroll: number;
	filter: HypothesisFilter;
	/** Held while drilled into one element, and kept so `out` can return to it. */
	elementId?: string;
	hypothesisId?: string;
}

export function initialState(view: BrowserView = "surface"): BrowserState {
	return { view, cursor: 0, scroll: 0, filter: "all" };
}

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

	const settled = (o: HypothesisOutcome): boolean => o === "confirmed" || o === "refuted";
	return {
		engagement,
		classes,
		surface,
		hypotheses: rows,
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

function rowCount(model: BrowserModel, state: BrowserState): number {
	switch (state.view) {
		case "surface": return model.surface.length;
		case "hypotheses": return visibleHypotheses(model, state).length;
		case "element": return model.classes.length;
		default: return 0;
	}
}

// --- input -----------------------------------------------------------------

export function reduceBrowser(state: BrowserState, key: BrowserKey, model: BrowserModel, viewport: number): BrowserState | "close" {
	const total = rowCount(model, state);
	const page = Math.max(1, viewport);
	const move = (n: number): BrowserState => {
		const cursor = Math.max(0, Math.min(n, Math.max(0, total - 1)));
		// Scroll by the least that keeps the cursor inside the window.
		let scroll = state.scroll;
		if (cursor < scroll) scroll = cursor;
		if (cursor >= scroll + page) scroll = cursor - page + 1;
		return { ...state, cursor, scroll: Math.max(0, scroll) };
	};

	switch (key) {
		case "up": return move(state.cursor - 1);
		case "down": return move(state.cursor + 1);
		case "pageUp": return move(state.cursor - page);
		case "pageDown": return move(state.cursor + page);
		case "top": return move(0);
		case "bottom": return move(total - 1);
		case "close": return "close";
		case "switch":
			return { ...initialState(state.view === "surface" ? "hypotheses" : "surface"), filter: state.filter };
		case "filter:all": return { ...state, filter: "all", cursor: 0, scroll: 0 };
		case "filter:confirmed": return { ...state, filter: "confirmed", cursor: 0, scroll: 0 };
		case "filter:refuted": return { ...state, filter: "refuted", cursor: 0, scroll: 0 };
		case "filter:open": return { ...state, filter: "open", cursor: 0, scroll: 0 };
		case "out": {
			if (state.view === "hypothesis") {
				return { ...state, view: state.elementId ? "element" : "hypotheses", hypothesisId: undefined };
			}
			if (state.view === "element") return { ...state, view: "surface", elementId: undefined, cursor: 0, scroll: 0 };
			return "close";
		}
		case "in": {
			if (state.view === "surface") {
				const row = model.surface[state.cursor];
				return row ? { ...state, view: "element", elementId: row.id, cursor: 0, scroll: 0 } : state;
			}
			if (state.view === "hypotheses") {
				const row = visibleHypotheses(model, state)[state.cursor];
				return row ? { ...state, view: "hypothesis", hypothesisId: row.id } : state;
			}
			if (state.view === "element") {
				// From a class row into the hypothesis that settled it. A class with no
				// hypothesis is exactly what this view exists to show, so it stays put
				// rather than opening something unrelated.
				const cls = model.classes[state.cursor];
				const hyp = cls && model.hypotheses.find((h) => h.targetId === state.elementId && h.class === cls.id);
				return hyp ? { ...state, view: "hypothesis", hypothesisId: hyp.id } : state;
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

function rule(width: number, ink: RenderOptions["ink"]): string {
	return ink("muted", "─".repeat(Math.max(0, width)));
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
	return selected ? o.ink("selected", pad(clipped, width, o.measure)) : clipped;
}

function header(title: string, right: string, o: RenderOptions): string[] {
	const { width, ink, measure, truncate } = o;
	const left = ink("title", truncate(title, Math.max(0, width - measure(right) - 1)));
	return [pad(left, Math.max(0, width - measure(right)), measure) + ink("muted", right), rule(width, ink)];
}

/** The key legend, which differs per view and is the only affordance a user gets. */
function footer(o: RenderOptions): string[] {
	const { state, ink, width } = o;
	const keys = state.view === "hypothesis"
		? "↑↓ scroll · esc back · q close"
		: state.view === "element"
			? "↑↓ move · ⏎ open · esc back · tab hypotheses · q close"
			: state.view === "surface"
				? "↑↓ move · ⏎ open · tab hypotheses · q close"
				: "↑↓ move · ⏎ open · a/c/r/o filter · tab surface · q close";
	return [rule(width, ink), ink("muted", o.truncate(keys, width))];
}

function surfaceBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
	if (model.surface.length === 0) {
		return [ink("muted", "  no surface recorded yet — the agent has not called record"), ""];
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

function hypothesisBody(o: RenderOptions): string[] {
	const { model, state, width, ink, measure, truncate } = o;
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
	// Scrolling a detail pane is uncommon but a long statement must stay readable
	// on a short terminal rather than being silently cut.
	return out.slice(state.scroll, state.scroll + o.height).map((l) => truncate(l, width));
}

export function renderBrowser(o: RenderOptions): string[] {
	if (o.width < MIN_WIDTH) return [o.truncate(o.ink("muted", "too narrow"), o.width)];
	const { model, state } = o;

	switch (state.view) {
		case "surface": {
			const settled = model.surface.reduce((a, r) => a + r.settled, 0);
			const askable = model.surface.reduce((a, r) => a + r.askable, 0);
			return [
				...header(`surface · ${model.engagement}`, `${model.surface.length} elements · ${settled}/${askable} settled`, o),
				...surfaceBody(o),
				...footer(o),
			];
		}
		case "element": {
			const el = model.surface.find((s) => s.id === state.elementId);
			return [
				...header(el ? el.label : "element", el ? `${el.kind} · ${el.settled}/${el.askable} settled` : "", o),
				...elementBody(o),
				...footer(o),
			];
		}
		case "hypotheses": {
			const c = model.counts;
			const tally = `${c.confirmed} confirmed · ${c.refuted} refuted · ${c.open} open`;
			const filt = state.filter === "all" ? "" : ` [${state.filter}]`;
			return [
				...header(`hypotheses${filt} · ${model.engagement}`, tally, o),
				...hypothesesBody(o),
				...footer(o),
			];
		}
		default:
			return [...header("hypothesis", model.engagement, o), ...hypothesisBody(o), ...footer(o)];
	}
}
