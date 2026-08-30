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

const LEGEND: CoverageStatus[] = ["clear", "vulnerable", "testing", "blocked", "not-tested"];
const LEGEND_WORD: Record<CoverageStatus, string> = {
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
	const { view, engagement, width, ink, measure, truncate } = opts;
	if (width <= 0) return [];
	const { matrix, classes, elementIds } = view;

	const pct = coveragePercent(matrix);
	const head = (): string[] => {
		const title = ink("title", `⦿ coverage · ${engagement}`);
		const right = ink("muted", `${pct}%`);
		const gap = width - measure(title) - measure(right);
		return [gap >= 1 ? title + " ".repeat(gap) + right : truncate(title, width)];
	};

	if (classes.length === 0) return [...head(), "", ink("muted", "no checklist seeded for this engagement")];
	if (elementIds.length === 0) {
		return [...head(), "", ink("muted", "no surface recorded yet — run recon, or record inventory")];
	}

	// Statuses per class, in element order, so each row is one class's bar.
	const byClass = new Map<string, CoverageStatus[]>(classes.map((c) => [c.id, []]));
	for (const cell of matrix.cells) byClass.get(cell.class)?.push(cell.status);

	const labelWidth = Math.min(MAX_LABEL, Math.max(...classes.map((c) => measure(c.title))));
	const countWidth = `${elementIds.length}/${elementIds.length}`.length;
	// label + 2 + bar + 2 + counts
	const barWidth = Math.max(0, width - labelWidth - countWidth - 4);

	const lines = head();
	lines.push("");

	if (barWidth < MIN_BAR) {
		// Too narrow for bars: fall back to per-class counts alone.
		for (const cls of classes) {
			const statuses = byClass.get(cls.id) ?? [];
			lines.push(truncate(`${ink("label", cls.title)} ${ink("muted", rowCount(statuses))}`, width));
		}
		return lines;
	}

	for (const cls of classes) {
		const statuses = byClass.get(cls.id) ?? [];
		const shown = statuses.slice(0, barWidth);
		const overflow = statuses.length - shown.length;
		// Reserve room for the "+N" marker inside the bar rather than past it.
		const marker = overflow > 0 ? `+${overflow}` : "";
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

	lines.push("");
	const present = matrix.counts["n/a"] > 0 ? [...LEGEND, "n/a" as CoverageStatus] : LEGEND;
	const legend = present.map((st) => `${ink(st, CELL_GLYPH[st])} ${ink("muted", LEGEND_WORD[st])}`).join("  ");
	lines.push(truncate(legend, width));

	const gaps = matrix.counts["not-tested"] + matrix.counts.blocked;
	const summary = ink("muted", `${matrix.applicable} cells · ${gaps} gaps`);
	const hint = ink("muted", "esc to close");
	const gap = width - measure(summary) - measure(hint);
	lines.push(gap >= 1 ? summary + " ".repeat(gap) + hint : truncate(summary, width));
	return lines;
}
