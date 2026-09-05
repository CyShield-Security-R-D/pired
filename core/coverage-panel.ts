/**
 * The coverage panel — pired's signature view, rendered as plain lines.
 *
 * checklist × surface = coverage is the whole rigor thesis, and until now it was
 * only reachable by asking the agent to run `recall gaps`. This lays it out as
 * one row per vulnerability class with a bar of per-element cells, which scales
 * to a large surface far better than a true grid: the bar simply shortens, while
 * a grid would need to drop whole columns.
 *
 * Pure module: colors and width measurement are injected, so it carries no host
 * imports and is tested against a plain ASCII stand-in.
 */

import { coveragePercent } from "./coverage.ts";
import { frameLines } from "./frame.ts";
import type { CoverageStatus } from "./ontology.ts";
import type { CoverageView } from "./stats.ts";

/** A paintable role: a cell status, or one of the panel's chrome tones. */
export type Tone = CoverageStatus | "title" | "label" | "muted" | "body";

/** Cell glyphs, all single-column so the bar length equals the cell count. */
export const CELL_GLYPH: Record<CoverageStatus, string> = {
	clear: "●",
	vulnerable: "▲",
	testing: "◐",
	blocked: "⊘",
	"not-tested": "·",
	// A cell the class does not apply to (per its `appliesTo`). It holds its slot
	// in the bar to keep columns aligned, but is not counted as work.
	"n/a": "–",
};

export const LEGEND: CoverageStatus[] = ["clear", "vulnerable", "testing", "blocked", "not-tested"];
export const LEGEND_WORD: Record<CoverageStatus, string> = {
	clear: "clear",
	vulnerable: "vulnerable",
	testing: "testing",
	blocked: "blocked",
	"not-tested": "untested",
	"n/a": "n/a",
};

/** Widest class label we will reserve; longer titles are truncated into it. */
const MAX_LABEL = 18;
const MIN_BAR = 4;

export interface CoveragePanelOptions {
	view: CoverageView;
	engagement: string;
	width: number;
	ink: (tone: Tone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
	/**
	 * Draw it in the same box the rail uses. The title then carries the heading,
	 * so the two rows it would have taken go back to the matrix.
	 */
	frame?: boolean;
	/**
	 * Where to send a reader for the classes that did not fit. The welcome box
	 * points at `/coverage`; the `/coverage` overlay passes nothing, because a
	 * view telling you to open the view you are in is not an instruction.
	 */
	moreHint?: string;
	/** Rows the whole thing may occupy. Classes past the budget become a "+N". */
	maxLines?: number;
	/**
	 * Right-hand note on the summary row, e.g. a dismiss key. Takes a row of its
	 * own when it will not fit beside the summary: it is the only text telling a
	 * reader how to leave, so it is the last thing that may be dropped.
	 */
	hint?: string;
}

/**
 * A row's settled-over-askable count. `n/a` cells still occupy a slot in the bar
 * so columns stay aligned across rows, but they are not work, so they are out of
 * the denominator here exactly as they are out of `matrix.applicable`.
 */
function rowCount(statuses: CoverageStatus[]): string {
	const done = statuses.filter((st) => st === "clear" || st === "vulnerable").length;
	const askable = statuses.filter((st) => st !== "n/a").length;
	return `${done}/${askable}`;
}

/** Lay the matrix out as lines, none wider than `width`. */
export function renderCoveragePanel(opts: CoveragePanelOptions): string[] {
	const { view, engagement, ink, measure, truncate } = opts;
	const framed = opts.frame === true && opts.width >= 24;
	// Two columns of left margin, as the rail has: content flush against a border
	// reads as content that overflowed into it.
	const width = (framed ? opts.width - 2 : opts.width) - 2;
	const budget = (opts.maxLines ?? Number.MAX_SAFE_INTEGER) - (framed ? 2 : 0);
	if (width <= 0 || budget <= 0) return [];
	const { matrix, classes, elementIds } = view;

	const pct = coveragePercent(matrix);
	// Framed, the heading is the border's own label and the row it would have
	// taken — with the blank under it — goes back to the matrix. `⦿ view ·
	// engagement` is the shape the rail and the browser both use; the percentage
	// moves to the summary row so all three titles read the same way.
	const title = `${ink("title", "⦿ coverage")}${ink("muted", ` · ${engagement}`)}`;
	const head = (): string[] => {
		if (framed) return [];
		const left = ink("title", `⦿ coverage · ${engagement}`);
		const right = ink("muted", `${pct}%`);
		const gap = width - measure(left) - measure(right);
		return [gap >= 1 ? left + " ".repeat(gap) + right : truncate(left, width), ""];
	};
	const done = (lines: string[]): string[] => {
		const padded = lines.slice(0, budget).map((l) => (l ? `  ${l}` : l));
		return framed ? frameLines(padded, title, opts.width, ink, measure, truncate) : padded;
	};

	if (classes.length === 0) return done([...head(), ink("muted", "no checklist seeded for this engagement")]);
	if (elementIds.length === 0) {
		return done([...head(), ink("muted", "no surface recorded yet — run recon, or record inventory")]);
	}

	// Statuses per class, in element order, so each row is one class's bar.
	const byClass = new Map<string, CoverageStatus[]>(classes.map((c) => [c.id, []]));
	for (const cell of matrix.cells) byClass.get(cell.class)?.push(cell.status);

	const labelWidth = Math.min(MAX_LABEL, Math.max(...classes.map((c) => measure(c.title))));
	const countWidth = `${elementIds.length}/${elementIds.length}`.length;
	// label + 2 + bar + 2 + counts. Room decides whether bars are drawn at all;
	// the bar itself is never longer than there are cells to put in it. Padded out
	// to the full width instead, a surface of seven elements pushed its counts
	// eighty columns from the row they belong to.
	const room = width - labelWidth - countWidth - 4;
	const barWidth = Math.max(0, Math.min(elementIds.length, room));

	const lines = head();

	// The legend, the totals and the dismiss hint. Shared, because the narrow
	// fallback below used to return without them — so the one layout where a
	// reader most needs telling how to close the overlay was the one that never
	// said.
	// Does the dismiss hint fit beside the summary, or does it need its own row?
	// It is the only text telling a reader how to close the overlay, so when it
	// will not share a line it takes one — and the class budget must know that
	// before it decides how many rows it can spend.
	// "cells" and "gaps" are the matrix's own words; "test cases" is the operator's.
	// The panel is read by someone who thinks in a test plan, so it says both.
	// Claims that reached no cell, said out loud rather than dropped.
	//
	// A hypothesis whose target names nothing recorded — or names a param when the
	// surface is routes and hosts — is testing that was done, recorded, and that
	// this percentage cannot see. Coverage resolves what it can when the matrix is
	// built (core/target.ts); what is left is a real gap between the ledger and
	// the number, and the operator is the only one who can close it.
	const stray = view.unattached > 0 ? ` · ${view.unattached} claims settle no cell` : "";
	const summaryText = `${pct}% · ${matrix.applicable} test cases · ${matrix.counts["not-tested"] + matrix.counts.blocked} gaps${stray}`;
	const hintText = opts.hint ?? "";
	const hintInline = hintText.length === 0
		|| width - measure(summaryText) - measure(hintText) >= 1;
	const tailRows = (withLegend: boolean): number =>
		(withLegend ? 1 : 0) + 1 + (hintText && !hintInline ? 1 : 0);

	const tail = (withLegend: boolean): string[] => {
		const out: string[] = [];
		if (withLegend) {
			// No blank above the legend: it is the key to the rows over it and belongs
			// with them, and a spare row here is a class that could have been shown.
			const present = matrix.counts["n/a"] > 0 ? [...LEGEND, "n/a" as CoverageStatus] : LEGEND;
			out.push(truncate(present.map((st) => `${ink(st, CELL_GLYPH[st])} ${ink("muted", LEGEND_WORD[st])}`).join("  "), width));
		}
		const summary = ink("muted", summaryText);
		const hint = hintText ? ink("muted", hintText) : "";
		if (hint && hintInline) {
			const gap = width - measure(summaryText) - measure(hintText);
			out.push(summary + " ".repeat(Math.max(0, gap)) + hint);
		} else {
			out.push(truncate(summary, width));
			if (hint) out.push(truncate(hint, width));
		}
		return out;
	};

	if (room < MIN_BAR) {
		// Too narrow for bars: fall back to per-class counts alone. The legend keys
		// glyphs this layout does not draw, so it goes; the hint stays.
		for (const cls of classes) {
			const statuses = byClass.get(cls.id) ?? [];
			lines.push(truncate(`${ink("label", cls.title)} ${ink("muted", rowCount(statuses))}`, width));
		}
		return done([...lines, ...tail(false)]);
	}

	// The legend and the summary are the floor; classes fill what is left. Dropping
	// rows silently would misreport the work, so the ones that do not fit are
	// counted on a line of their own.
	const floor = lines.length + tailRows(true);
	const rowsFor = Math.max(1, budget - floor);
	const shownClasses = classes.length > rowsFor ? classes.slice(0, rowsFor - 1) : classes;

	for (const cls of shownClasses) {
		const statuses = byClass.get(cls.id) ?? [];
		const shown = statuses.slice(0, barWidth);
		const overflow = statuses.length - shown.length;
		// Reserve room for the "+N" marker inside the bar rather than past it, and
		// keep a space before it: "·········+29" reads as one token.
		const marker = overflow > 0 ? ` +${overflow}` : "";
		const cells = (marker ? shown.slice(0, Math.max(0, barWidth - marker.length)) : shown)
			.map((st) => ink(st, CELL_GLYPH[st]))
			.join("");
		const bar = cells + (marker ? ink("muted", marker) : "");

		const label = truncate(cls.title, labelWidth);
		const pad = " ".repeat(Math.max(0, labelWidth - measure(label)));
		const counts = rowCount(statuses);
		const countPad = " ".repeat(Math.max(0, countWidth - counts.length));
		const barPad = " ".repeat(Math.max(0, barWidth - measure(bar)));
		lines.push(truncate(`${ink("label", label)}${pad}  ${bar}${barPad}  ${countPad}${ink("muted", counts)}`, width));
	}

	if (shownClasses.length < classes.length) {
		const where = opts.moreHint ? ` · ${opts.moreHint}` : "";
		lines.push(ink("muted", `+${classes.length - shownClasses.length} more classes${where}`));
	}

	return done([...lines, ...tail(true)]);
}
