/**
 * How the banner and the rail share a terminal.
 *
 * Both used to be fixed: the rail was 56 columns whatever the screen, and the
 * banner took everything left over. That reads well at 85 columns, which is the
 * width it was designed at, and badly at 175 — the rail becomes a sliver still
 * truncating every finding title, the banner becomes a 117-column box holding 58
 * columns of content, and between them sits a stripe of nothing that makes the
 * two halves look unrelated.
 *
 * The rule here is that both blocks scale, but neither scales without limit. A
 * rail that grows forever eventually covers the transcript it is meant to sit
 * beside; a banner that stretches forever spreads a wordmark and four facts
 * across a metre of glass.
 *
 * Kept out of the extension so the breakpoints can be tested, and so a preview
 * renders the same arithmetic the TUI does rather than a copy of it.
 */

/**
 * The width the rail wants: narrower and a finding title is truncation with a
 * border around it. It is a preference, not a floor — see RAIL_FLOOR.
 */
export const RAIL_MIN = 56;
/** Wider and the panel stops being a side panel. */
export const RAIL_MAX = 88;
/** Of the terminal. Chosen so 85 columns keeps the layout it was designed at. */
export const RAIL_SHARE = 0.38;
/**
 * The narrowest the rail will squeeze to before it stops yielding.
 *
 * On a 70-column terminal an unyielding 56 left the banner twelve columns, which
 * is under BANNER_MIN — so the banner took the full width and the rail painted
 * over the wordmark. A panel that is merely cramped beats two blocks drawn on
 * top of each other.
 */
export const RAIL_FLOOR = 24;
/** Columns to leave beside the rail: the wordmark, its indent, and some air. */
export const BANNER_KEEP = 28;
/** Below this the banner drops its label column; see renderBanner. */
export const BANNER_MIN = 18;

/**
 * Columns for the rail.
 *
 * `override` is PIRED_RAIL_WIDTH and wins outright: someone who names a width
 * has a reason, and second-guessing it is how a setting stops being a setting.
 */
export function railColumns(terminalCols: number, override?: number): number {
	if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
	const want = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(terminalCols * RAIL_SHARE)));
	// Never so much that the banner beside it has nowhere to stand.
	return Math.max(RAIL_FLOOR, Math.min(want, terminalCols - BANNER_KEEP));
}

/**
 * Columns the banner may use: everything left of the rail.
 *
 * Under BANNER_MIN nothing legible fits beside the rail, so the banner takes the
 * full width and accepts the overlap for that frame — the panel can be dismissed
 * with alt+p on a terminal that small.
 */
export function bannerColumns(terminalCols: number, railCols: number): number {
	const free = terminalCols - railCols - 2;
	return free >= BANNER_MIN ? free : terminalCols;
}

/**
 * The overlay geometry, kept here rather than as a literal at the call site —
 * which is the drift this module exists to stop. One entry, because /coverage,
 * /surface, /hypotheses and /findings are now one browser wearing one chrome;
 * a second geometry would make the same view resize as you tab through it.
 */
export const OVERLAY = {
	browser: { width: "90%", minWidth: 48, maxHeight: "80%", anchor: "center" },
} as const;

/** The share of the terminal an overlay gets, as OVERLAY.maxHeight promises. */
export const OVERLAY_HEIGHT_SHARE = 0.8;

/**
 * Chrome an overlay spends before the first body row: the box's two edges, the
 * tally, two section rules and the key legend.
 */
export const BROWSER_CHROME = 6;
