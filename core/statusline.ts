/**
 * Status-line layout — pure and host-agnostic.
 *
 * Fits a prioritised set of segments into a fixed column width. Each segment has
 * three gears: its full text, an optional shorter `compact` form, and gone. As
 * the terminal narrows, the cheapest segments downshift and then drop, and
 * whatever survives is hard-truncated. The truncation is the point — pi's TUI
 * contract is that a rendered line must never exceed the width it handed us, and
 * a line that does corrupts the whole frame rather than just overflowing.
 *
 * Display-width measurement and truncation are injected rather than imported, so
 * this stays free of host imports (the adapter passes pi-tui's ANSI- and
 * wide-character-aware versions) and can be tested with a plain ASCII measure.
 */

/** A unit of status text that is kept, shortened, or dropped as a whole. */
export interface Segment {
	text: string;
	/** Shorter rendering, used before the segment is dropped outright. */
	compact?: string;
	/** Lower priority downshifts and drops first. Omit to make a segment mandatory. */
	priority?: number;
}

export interface StatusLineOptions {
	left: Segment[];
	right: Segment[];
	/** Columns available, as handed to the component's render(). */
	width: number;
	/** Display width of a string, ignoring ANSI and counting wide glyphs as 2. */
	measure: (s: string) => number;
	/** Shorten a string to a display width. */
	truncate: (s: string, width: number) => string;
	/** Rendered between segments on the same side. */
	separator: string;
	/** Minimum blank columns kept between the two sides. Default 2. */
	minGap?: number;
}

type Gear = "full" | "compact";

/**
 * Compose one line: left-aligned and right-aligned groups separated by padding,
 * degrading by priority. The result is always at most `width` columns wide.
 */
export function layoutStatusLine(opts: StatusLineOptions): string {
	const { left: leftSegs, right: rightSegs, width, measure, truncate, separator } = opts;
	if (width <= 0) return "";
	const minGap = opts.minGap ?? 2;

	// Absent from the map = dropped. Segments start in top gear.
	const gear = new Map<Segment, Gear>();
	for (const s of [...leftSegs, ...rightSegs]) if (s.text.length > 0) gear.set(s, "full");

	const textOf = (s: Segment): string => (gear.get(s) === "compact" && s.compact !== undefined ? s.compact : s.text);
	const side = (segs: Segment[]): string =>
		segs
			.filter((s) => gear.has(s))
			.map(textOf)
			.join(separator);
	const required = (): number => {
		const l = measure(side(leftSegs));
		const r = measure(side(rightSegs));
		return r > 0 ? l + minGap + r : l;
	};
	const fits = (): boolean => required() <= width;

	// Downshift then drop, cheapest segment first. A segment with a compact form
	// always gets to shrink before it is given up entirely, so the information
	// degrades gracefully instead of disappearing at one particular width.
	const byPriority = [...gear.keys()]
		.filter((s) => s.priority !== undefined)
		.sort((a, b) => (a.priority as number) - (b.priority as number));
	for (const seg of byPriority) {
		if (fits()) break;
		if (seg.compact !== undefined && gear.get(seg) === "full") {
			gear.set(seg, "compact");
			if (fits()) break;
		}
		gear.delete(seg);
	}

	// Mandatory segments cannot be dropped, but they can still shrink rather than
	// push the line into truncation.
	for (const seg of [...gear.keys()]) {
		if (fits()) break;
		if (seg.priority === undefined && seg.compact !== undefined) gear.set(seg, "compact");
	}

	// Restore what still fits, richest first. Shedding is greedy in priority
	// order, so it can drop a small cheap segment and then drop the expensive one
	// it was making room for anyway — leaving a gap the cheap one would have
	// filled. Without this the line looks sparse at mid widths.
	for (const seg of [...byPriority].reverse()) {
		if (!gear.has(seg)) {
			gear.set(seg, seg.compact !== undefined ? "compact" : "full");
			if (!fits()) {
				gear.delete(seg);
				continue;
			}
		}
		if (gear.get(seg) === "compact") {
			gear.set(seg, "full");
			if (!fits()) gear.set(seg, "compact");
		}
	}

	const left = side(leftSegs);
	const right = side(rightSegs);
	const lw = measure(left);
	const rw = measure(right);

	if (rw > 0 && lw + minGap + rw <= width) return left + " ".repeat(width - lw - rw) + right;
	if (rw === 0 && lw <= width) return left;

	// Mandatory content alone still overflows — truncate rather than corrupt the frame.
	return truncate([left, right].filter((s) => s.length > 0).join(" ".repeat(minGap)), width);
}
