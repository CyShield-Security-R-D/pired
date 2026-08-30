/**
 * The welcome banner.
 *
 * There was a banner widget once and removing it was right: it sat in the layout
 * forever, repeating a brand the status line already carries. A welcome screen
 * is not a widget — it belongs in the transcript, once, and then scrolls away
 * like any other entry.
 *
 * The mark is letter-spaced rather than drawn in block capitals. Figlet blocks
 * read as retro; thin letterforms, one accent rule and a lot of air read as
 * current, and they survive a narrow terminal without a second layout. The two
 * tones are not decoration — the name is literally "pi" + "red", so the accent
 * lands on the second half and the wordmark explains itself.
 *
 * Pure module: colour and width measurement are injected, so it renders the same
 * under a test's ASCII stand-in as under a terminal theme.
 */

export type BannerTone = "pi" | "red" | "label" | "muted" | "accent" | "rule";

/** pired's engagement glyph, reused so the banner and the status line agree. */
const MARK = "⦿";

/**
 * PIRED in a three-row half-block font, split at the word so each run takes its
 * own tone.
 *
 * Full-height block capitals are six rows and thirty-four columns — wider than
 * the space left beside the panel, and heavy enough to read as retro. Half
 * blocks give the same weight in three rows and seventeen columns, which fits
 * the narrow column and still lands as a wordmark rather than as text.
 */
const ART: Array<[pi: string, red: string]> = [
	["█▀█ █", " █▀█ █▀▀ █▀▄"],
	["█▀▀ █", " █▀▄ █▀▀ █ █"],
	["▀   ▀", " ▀ ▀ ▀▀▀ ▀▀ "],
];
const ART_WIDTH = 17;
const TAGLINE = "security engagement harness";
/** A rule that spans the whole terminal reads as heavy; this one reads as drawn. */
const MAX_RULE = 58;
const INDENT = "  ";
/** Below this a label column costs more than it explains. */
const NARROW_MAX = 40;
/** Below this not even the wordmark fits. */
const TINY_MIN = ART_WIDTH + 4;

export interface BannerInfo {
	engagement: string;
	profile: string;
	/** Scope gate state, already worded — "enforce", "not authorized", "off". */
	scope: string;
	model?: string;
	/** Recorded surface elements, when an engagement is already under way. */
	surface?: number;
	coveragePct?: number;
	findings?: number;
}

export interface BannerOptions {
	info: BannerInfo;
	width: number;
	ink: (tone: BannerTone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
	/**
	 * Pad with blank lines to at least this many rows.
	 *
	 * The panel is a floating overlay anchored top-right: it draws over whatever
	 * is beneath it and pi owns the layout root, so the editor cannot be moved
	 * out of its way. In pi's inline mode the editor sits immediately after the
	 * last content, which on a fresh session is around row 13 — inside a panel
	 * spanning rows 1 to 21. The banner reserving that height is what puts the
	 * editor below it, and it costs nothing once a conversation has grown enough
	 * to push the editor down on its own.
	 */
	minLines?: number;
}

const COMMANDS = ["/surface", "/hypotheses", "/coverage", "/panel"];

function pad(s: string, to: number, measure: (x: string) => number): string {
	const gap = to - measure(s);
	return gap > 0 ? s + " ".repeat(gap) : s;
}

function artLines(ink: BannerOptions["ink"]): string[] {
	return ART.map(([pi, red]) => `${ink("pi", pi)}${ink("red", red)}`);
}

function facts(info: BannerInfo, compact = false): Array<[string, string]> {
	const rows: Array<[string, string]> = [
		["engagement", info.engagement],
		["profile", `${info.profile} · scope ${info.scope}`],
	];
	if (info.model) rows.push(["model", info.model]);
	// Only when the engagement already holds work. A fresh one showing
	// "0 surface · 0% coverage" reads as a failure rather than a starting point.
	if (info.surface !== undefined && info.surface > 0) {
		// Coverage is dropped when narrow: the panel is rendering the same number
		// three columns to the right, and repeating it is what pushes this line
		// past the edge.
		const cov = !compact && info.coveragePct !== undefined ? ` · ${info.coveragePct}% covered` : "";
		const fnd = info.findings ? ` · ${info.findings} finding${info.findings === 1 ? "" : "s"}` : "";
		rows.push(["recorded", `${info.surface} surface${cov}${fnd}`]);
	}
	return rows;
}

/** Pad to `minLines`, never truncating: the banner is content, not a viewport. */
function reserve(lines: string[], minLines: number | undefined): string[] {
	if (!minLines || lines.length >= minLines) return lines;
	return [...lines, ...Array(minLines - lines.length).fill("")];
}

export function renderBanner(o: BannerOptions): string[] {
	const { info, width, ink, measure, truncate } = o;
	if (width < TINY_MIN) return [truncate(`${ink("accent", MARK)} ${ink("pi", "pi")}${ink("red", "red")}`, width)];

	const inner = width - INDENT.length;
	// The tagline is set against the art's last row rather than its first: aligned
	// to the baseline it reads as a lockup, aligned to the top it reads as two
	// unrelated things that happen to share a line.
	const art = artLines(ink);
	const room = inner - ART_WIDTH - 2 >= TAGLINE.length;
	const headLines = art.map((l, i) =>
		i === art.length - 1 && room
			? pad(INDENT + l, width - TAGLINE.length, measure) + ink("muted", TAGLINE)
			: INDENT + l);

	const rows = facts(info, width <= NARROW_MAX);

	// Narrow: the banner is sharing the terminal with the panel, so it gets the
	// columns to its left and nothing more. A label column is the first thing to
	// go — "engagement" beside "pired" spends eleven of twenty-seven columns
	// explaining what the value already says — and the commands wrap instead of
	// running off the edge.
	if (width <= NARROW_MAX) {
		const cmds: string[] = [];
		let line = "";
		for (const c of COMMANDS) {
			const next = line ? `${line}  ${c}` : c;
			if (next.length > inner && line) {
				cmds.push(line);
				line = c;
			} else line = next;
		}
		if (line) cmds.push(line);
		return reserve([
			"",
			...artLines(ink).map((l) => truncate(INDENT + l, width)),
			"",
			truncate(INDENT + ink("rule", "─".repeat(Math.max(0, Math.min(inner, MAX_RULE)))), width),
			"",
			...rows.map(([, v]) => truncate(`${INDENT}${ink("label", v)}`, width)),
			"",
			...cmds.map((l) => truncate(INDENT + ink("accent", l), width)),
			"",
		], o.minLines);
	}

	const labelW = Math.max(...rows.map((r) => r[0].length)) + 3;

	return reserve([
		"",
		...headLines.map((l) => truncate(l, width)),
		"",
		truncate(INDENT + ink("rule", "─".repeat(Math.max(0, Math.min(inner, MAX_RULE)))), width),
		"",
		...rows.map(([k, v]) => truncate(`${INDENT}${ink("muted", pad(k, labelW, measure))}${ink("label", v)}`, width)),
		"",
		truncate(INDENT + COMMANDS.map((c) => ink("accent", c)).join(ink("muted", "   ")), width),
		"",
	], o.minLines);
}
