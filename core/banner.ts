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
const TAGLINE = "security assessment harness";
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
	/**
	 * The working directory, already collapsed against home by the caller.
	 *
	 * The engagement name defaults to this directory's basename, so on its own it
	 * cannot tell two checkouts of the same repository apart — and which tree an
	 * engagement is pointed at is the first thing a consultant needs to be sure
	 * of. Nothing else on the screen carries it.
	 */
	cwd?: string;
	profile: string;
	/** Scope gate state, already worded — "enforce", "not authorized", "off". */
	scope: string;
	model?: string;
	/** Recorded surface elements, when an engagement is already under way. */
	surface?: number;
	coveragePct?: number;
	findings?: number;
	/**
	 * Where this engagement was created, when that is not where we are now.
	 *
	 * An engagement is keyed on the directory's basename, so two clients with a
	 * repository called `backend` share one ledger. A notification scrolls away;
	 * this is the line the operator looks up at. ADR-005.
	 */
	foreignOrigin?: string;
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
	/**
	 * Whether the rail is drawing the ledger beside this banner.
	 *
	 * When it is, the coverage percentage is on screen three times — here, in the
	 * coverage box the welcome entry draws under this banner, and in the rail — and
	 * the findings tally twice. The rail is the ledger and it is up from the first
	 * frame, so the banner is the copy to drop.
	 *
	 * It is a row, and the row is the point: the welcome entry only draws the
	 * matrix when `rows - banner.length - 1 >= 7`, so on a 120-column terminal —
	 * banner 62, stacked layout, fifteen rows — that test failed by two and the
	 * signature view was replaced by five blank rows. Nothing about the matrix was
	 * wrong; the banner above it was simply too tall.
	 *
	 * Off by default, and off is the honest default: with `--no-panel` there is no
	 * rail and no coverage box, so the banner is the only thing carrying those
	 * numbers and it keeps them.
	 */
	panelVisible?: boolean;
}

const COMMANDS = ["/surface", "/hypotheses", "/findings", "/coverage", "/panel"];

function pad(s: string, to: number, measure: (x: string) => number): string {
	const gap = to - measure(s);
	return gap > 0 ? s + " ".repeat(gap) : s;
}

function artLines(ink: BannerOptions["ink"]): string[] {
	return ART.map(([pi, red]) => `${ink("pi", pi)}${ink("red", red)}`);
}

/**
 * `pathMax` is the columns a path may take, not a constant.
 *
 * It was 44 whatever the layout, and a path is the longest value here by a wide
 * margin, so those 44 columns decided whether the facts fit beside the wordmark
 * at all. On a 120-column terminal — banner 62 — the side-by-side layout needed
 * 62 and had 60, missed by two, and fell back to the stacked layout that is six
 * rows taller. A path cut to the column it lands in costs a few characters of a
 * value that is already abbreviated; the fixed number cost the coverage matrix.
 */
function facts(info: BannerInfo, compact = false, panelVisible = false, pathMax = 44): Array<[string, string]> {
	const rows: Array<[string, string]> = [
		["engagement", info.engagement],
	];
	// Dropped when compact: the engagement name is this directory's basename, so
	// on a terminal counting rows the path mostly repeats the line above it.
	if (info.cwd && !compact) rows.push(["directory", shortPath(info.cwd, pathMax)]);
	// Never dropped, not even when compact, and not cut to the column either. Every
	// other row is convenience; this one says the ledger you are about to write to
	// belongs to somewhere else, and the part that says *whose* is the client name
	// at the front. Cut to a narrow column, `~/clientA/backend` becomes
	// `…/backend` — still a path, no longer a warning. It keeps the wider budget
	// and pays for it by making the block taller, which is the right way round for
	// the one row here that exists to stop you writing into the wrong engagement.
	if (info.foreignOrigin) rows.push(["shared with", shortPath(info.foreignOrigin, 44)]);
	rows.push(["profile", `${info.profile} · scope ${info.scope}`]);
	if (info.model) rows.push(["model", info.model]);
	// Only when the engagement already holds work, and only when nothing else on
	// the screen is already saying it. A fresh one showing "0 surface · 0%
	// coverage" reads as a failure rather than a starting point; a worked one
	// beside the rail is saying it for the third time. See `panelVisible`.
	if (!panelVisible && info.surface !== undefined && info.surface > 0) {
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
 * Keep a path's tail, which is the part that identifies it.
 *
 * Cut from the front rather than the back: `~/clients/acme/…` tells you less
 * than `…/acme/services/api`, and a truncated path that looks whole is worse
 * than one that says it was cut.
 */
export function shortPath(path: string, max: number): string {
	if (path.length <= max) return path;
	const parts = path.split("/");
	let out = parts.pop() ?? path;
	for (let i = parts.length - 1; i >= 0; i--) {
		const next = `${parts[i]}/${out}`;
		if (next.length + 2 > max) break;
		out = next;
	}
	return `…/${out}`.slice(-max);
}

/**
 * Pad to `minLines`, never truncating: the banner is content, not a viewport.
 *
 * The padding goes underneath, so the block sits at the top of what it reserves.
 * The rows themselves are not negotiable — the panel is a floating overlay, pi
 * owns the layout root, and padding the banner is the only way the editor clears
 * it. What goes in them is: the welcome entry fills them with the coverage matrix
 * when there is one, and only falls back to this when there is not.
 */
function reserve(lines: string[], minLines: number | undefined): string[] {
	if (!minLines || lines.length >= minLines) return lines;
	return [...lines, ...Array(minLines - lines.length).fill("")];
}

/** The commands, wrapped to `inner` rather than run past it. */
function commandLines(inner: number, ink: BannerOptions["ink"], measure: BannerOptions["measure"]): string[] {
	const out: string[][] = [];
	let line: string[] = [];
	let len = 0;
	for (const c of COMMANDS) {
		if (line.length && len + 3 + c.length > inner) {
			out.push(line);
			line = [];
			len = 0;
		}
		if (line.length) len += 3;
		line.push(c);
		len += c.length;
	}
	if (line.length) out.push(line);
	return out.map((row) => row.map((c) => ink("accent", c)).join(ink("muted", "   ")));
}

/**
 * The row under the rule: the tagline on the left, the commands on the right.
 *
 * Together they are eighty-five columns, which is wider than the banner gets on
 * any terminal under about 145. That used to decide the layout for the whole
 * block — see `compactNeeds` — and it has no business doing so, because when the
 * pair does not fit the answer is to stack them, not to re-lay out the wordmark
 * and the facts. The tagline goes first: it is the one line here that says
 * nothing the operator cannot already see.
 */
function footerLines(
	inner: number,
	ink: BannerOptions["ink"],
	measure: BannerOptions["measure"],
): string[] {
	const cmds = commandLines(inner, ink, measure);
	const tag = ink("muted", TAGLINE);
	if (cmds.length === 1 && measure(TAGLINE) + 3 + measure(COMMANDS.join("   ")) <= inner) {
		const gap = inner - measure(TAGLINE) - measure(COMMANDS.join("   "));
		return [`${INDENT}${tag}${" ".repeat(Math.max(3, gap))}${cmds[0]}`];
	}
	// Under the pair's own width the tagline is dropped rather than wrapped: two
	// rows of prose above the commands reads as a paragraph, not as a footer.
	return measure(TAGLINE) <= inner
		? [`${INDENT}${tag}`, "", ...cmds.map((l) => INDENT + l)]
		: cmds.map((l) => INDENT + l);
}

export function renderBanner(o: BannerOptions): string[] {
	const { info, width, ink, measure, truncate } = o;
	if (width < TINY_MIN) return [truncate(`${ink("accent", MARK)} ${ink("pi", "pi")}${ink("red", "red")}`, width)];

	// Which layout, and how wide the block is, are one decision: each layout
	// knows what it needs, and the lockup is that — never the terminal's width.
	const avail = width - INDENT.length;
	// The label column comes from the keys, which do not depend on the width, so
	// it can be settled before the values are cut to fit under it.
	const labelW = Math.max(...facts(info, false, o.panelVisible).map((r) => r[0].length)) + 3;
	// What the facts column gets in the side-by-side layout, and therefore what a
	// path in it may take. Floored so a very narrow banner still cuts to something
	// a reader can recognise rather than to nothing.
	const pathMax = Math.max(16, avail - ART_WIDTH - FACT_GAP - labelW);
	const labelled = facts(info, false, o.panelVisible, pathMax);
	const cmdRow = COMMANDS.join("   ");
	const factW = Math.max(...labelled.map(([, v]) => labelW + measure(v)));
	// Stacked, the block is as wide as its widest row, capped at LOCKUP.
	const stackedNeeds = Math.max(factW, measure(cmdRow));
	// Side by side, the wordmark and the facts share three rows.
	//
	// The footer used to be part of this test — `TAGLINE + 3 + cmdRow`, which is
	// eighty-five columns whatever the facts do. So a 120-column terminal, whose
	// banner gets sixty-two, was thrown into the stacked layout by a row that can
	// simply wrap, and the stacked layout is fifteen rows against compact's nine.
	// Six rows is the difference between the welcome entry drawing the coverage
	// matrix under this and drawing five blank lines. What the footer needs is the
	// footer's problem; see footerLines.
	const compactNeeds = ART_WIDTH + FACT_GAP + factW;
	const compact = avail >= compactNeeds;
	// compactNeeds decides whether the layout fits; it does not decide the width.
	// Sized to its content the block stopped thirty columns short of the panel and
	// the two read as unrelated things that happened to share a screen. Sized to
	// the column it lives in, the rule and the commands run to the panel's edge
	// and the pair closes: same top, same bottom, one gutter between them.
	const inner = compact ? avail : Math.min(avail, LOCKUP - INDENT.length);
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
	// `panelVisible` travels here too. Without it the narrow layout — the one a
	// 100-column terminal gets, where rows are scarcest — went on drawing the
	// recorded row the rail was already carrying.
	const rows = roomy ? labelled : facts(info, true, o.panelVisible, pathMax);

	// --- compact: the facts stand beside the wordmark ------------------------
	// Stacked, the banner is thirteen rows of mostly air, and the hole beside the
	// wordmark is exactly the width the facts want. On a screen with the columns
	// to spare they go there instead, which is five rows back and a block that
	// reads as one shape rather than as a list under a picture.
	if (compact) {
		const factLine = ([k, v]: [string, string]): string =>
			`${ink("muted", pad(k, labelW, measure))}${ink("label", v)}`;
		// The two columns are centred against each other rather than both starting
		// at the top: three rows of wordmark beside five of facts left the mark
		// riding high on the block, which reads as a mark that was placed and facts
		// that were poured in after it.
		const rows = Math.max(art.length, labelled.length);
		const artLead = Math.floor((rows - art.length) / 2);
		const factLead = Math.floor((rows - labelled.length) / 2);
		const beside = Array.from({ length: rows }, (_, i) => {
			const l = art[i - artLead];
			const f = labelled[i - factLead];
			if (!f) return INDENT + (l ?? "");
			return INDENT + pad(l ?? "", ART_WIDTH + FACT_GAP, measure) + factLine(f);
		});
		// Tagline and commands share the row under the rule, each on its own edge —
		// so the row is as wide as the rule above it, and its right end lands
		// against the panel just as the rule does. When the pair is wider than the
		// column they stack instead, which costs two rows rather than the six that
		// falling back to the stacked layout used to cost.
		return reserve([
			"",
			...beside.map((l) => truncate(l, width)),
			truncate(INDENT + ink("rule", "─".repeat(Math.max(0, inner))), width),
			...footerLines(inner, ink, measure).map((l) => truncate(l, width)),
			"",
		], o.minLines);
	}

	// Narrow: the banner is sharing the terminal with the panel, so it gets the
	// columns to its left and nothing more. A label column is the first thing to
	// go — "engagement" beside "pired" spends eleven of twenty-seven columns
	// explaining what the value already says — and the commands wrap instead of
	// running off the edge.
	if (!roomy) {
		return reserve([
			"",
			...artLines(ink).map((l) => truncate(INDENT + l, width)),
			"",
			truncate(INDENT + ink("rule", "─".repeat(Math.max(0, inner))), width),
			"",
			...rows.map(([, v]) => truncate(`${INDENT}${ink("label", v)}`, width)),
			"",
			...commandLines(inner, ink, measure).map((l) => truncate(INDENT + l, width)),
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
		...commandLines(inner, ink, measure).map((l) => truncate(INDENT + l, width)),
		"",
	], o.minLines);
}
