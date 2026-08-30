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
/**
 * The banner is a lockup, not a stretch.
 *
 * Everything in it — the tagline on the wordmark's baseline, the rule, the facts
 * and the commands — is laid out against this width rather than the terminal's.
 * Given a 117-column box the old layout right-aligned the tagline to the far
 * edge and drew a 58-column rule under it, so the two ends of the same block
 * agreed with nothing and the space between them read as a hole rather than as
 * margin. A rule that spans the whole terminal reads as heavy; one that spans
 * the lockup reads as drawn.
 */
const LOCKUP = 72;
/** Columns between the wordmark and the facts standing beside it. */
const FACT_GAP = 5;
const INDENT = "  ";
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

/**
 * Pad to `minLines`, never truncating: the banner is content, not a viewport.
 *
 * The padding goes *above* the block, which sits at the foot of what it
 * reserves. The rows themselves are not negotiable — the panel is a floating
 * overlay, pi owns the layout root, and padding the banner is the only way the
 * editor clears it — but where they sit is. Under the block they were a hole
 * between the banner and the first reply, in the middle of the reading path;
 * above it they are margin before anything has been said, and the wordmark
 * lands next to the editor, which is where the eye is when it goes to type.
 */
function reserve(lines: string[], minLines: number | undefined): string[] {
	if (!minLines || lines.length >= minLines) return lines;
	return [...Array(minLines - lines.length).fill(""), ...lines];
}

export function renderBanner(o: BannerOptions): string[] {
	const { info, width, ink, measure, truncate } = o;
	if (width < TINY_MIN) return [truncate(`${ink("accent", MARK)} ${ink("pi", "pi")}${ink("red", "red")}`, width)];

	// Which layout, and how wide the block is, are one decision: each layout
	// knows what it needs, and the lockup is that — never the terminal's width.
	const labelled = facts(info, false);
	const labelW = Math.max(...labelled.map((r) => r[0].length)) + 3;
	const cmdRow = COMMANDS.join("   ");
	const factW = Math.max(...labelled.map(([, v]) => labelW + measure(v)));
	// Stacked, the block is as wide as its widest row, capped at LOCKUP.
	const stackedNeeds = Math.max(factW, measure(cmdRow));
	// Side by side, the wordmark and the facts share three rows, and the tagline
	// and the commands share the row under the rule.
	const compactNeeds = Math.max(ART_WIDTH + FACT_GAP + factW, measure(TAGLINE) + 3 + measure(cmdRow));
	const avail = width - INDENT.length;
	const compact = avail >= compactNeeds;
	const inner = compact ? compactNeeds : Math.min(avail, LOCKUP - INDENT.length);
	const lockup = inner + INDENT.length;
	// The tagline is set against the art's last row rather than its first: aligned
	// to the baseline it reads as a lockup, aligned to the top it reads as two
	// unrelated things that happen to share a line.
	const art = artLines(ink);
	const room = inner - ART_WIDTH - 2 >= TAGLINE.length;
	const headLines = art.map((l, i) =>
		i === art.length - 1 && room
			? pad(INDENT + l, lockup - TAGLINE.length, measure) + ink("muted", TAGLINE)
			: INDENT + l);

	// Whether the labels survive is decided by what fits rather than by a width. A
	// fixed breakpoint of forty columns meant a 100-column terminal — 42 columns
	// left beside the panel — chose the labelled layout and then truncated its own
	// last two rows, so the recorded facts and half the command list ended in an
	// ellipsis. Measuring the content cannot get that wrong.
	const roomy = inner >= stackedNeeds;
	const rows = roomy ? labelled : facts(info, true);

	// --- compact: the facts stand beside the wordmark ------------------------
	// Stacked, the banner is thirteen rows of mostly air, and the hole beside the
	// wordmark is exactly the width the facts want. On a screen with the columns
	// to spare they go there instead, which is five rows back and a block that
	// reads as one shape rather than as a list under a picture.
	if (compact) {
		const factLine = ([k, v]: [string, string]): string =>
			`${ink("muted", pad(k, labelW, measure))}${ink("label", v)}`;
		const beside = art.map((l, i) => {
			const f = labelled[i];
			return INDENT + (f ? pad(l, ART_WIDTH + FACT_GAP, measure) + factLine(f) : l);
		});
		const under = labelled.slice(art.length)
			.map((f) => INDENT + " ".repeat(ART_WIDTH + FACT_GAP) + factLine(f));
		// Tagline and commands share the row under the rule, each on its own edge:
		// the block is bounded left and right by the same two columns everywhere.
		const cmds = COMMANDS.map((c) => ink("accent", c)).join(ink("muted", "   "));
		const gap = Math.max(3, inner - measure(TAGLINE) - measure(cmdRow));
		return reserve([
			"",
			...beside.map((l) => truncate(l, width)),
			...under.map((l) => truncate(l, width)),
			truncate(INDENT + ink("rule", "─".repeat(Math.max(0, inner))), width),
			truncate(`${INDENT}${ink("muted", TAGLINE)}${" ".repeat(gap)}${cmds}`, width),
			"",
		], o.minLines);
	}

	// Narrow: the banner is sharing the terminal with the panel, so it gets the
	// columns to its left and nothing more. A label column is the first thing to
	// go — "engagement" beside "pired" spends eleven of twenty-seven columns
	// explaining what the value already says — and the commands wrap instead of
	// running off the edge.
	if (!roomy) {
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
			truncate(INDENT + ink("rule", "─".repeat(Math.max(0, inner))), width),
			"",
			...rows.map(([, v]) => truncate(`${INDENT}${ink("label", v)}`, width)),
			"",
			...cmds.map((l) => truncate(INDENT + ink("accent", l), width)),
			"",
		], o.minLines);
	}

	return reserve([
		"",
		...headLines.map((l) => truncate(l, width)),
		"",
		truncate(INDENT + ink("rule", "─".repeat(Math.max(0, inner))), width),
		"",
		...rows.map(([k, v]) => truncate(`${INDENT}${ink("muted", pad(k, labelW, measure))}${ink("label", v)}`, width)),
		"",
		truncate(INDENT + COMMANDS.map((c) => ink("accent", c)).join(ink("muted", "   ")), width),
		"",
	], o.minLines);
}
