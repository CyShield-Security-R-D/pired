/**
 * The box a panel is drawn in.
 *
 * Shared, because more than one view wants the same one: the engagement rail and
 * the coverage matrix that fills the welcome screen beside it. Two boxes on one
 * screen drawn from two copies of this is how they end up a column apart.
 *
 * `ink` is asked only for "muted", so any of the tone vocabularies in core can
 * satisfy it without the frame knowing which one it was handed.
 */

export const BORDER = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤" } as const;

/**
 * Marks a line as a section rule so the frame can join it to the border with
 * ├ ┤ instead of boxing it in │ │, which leaves an ugly notch at each end.
 * A sentinel beats a parallel array: the renderer stays a flat list of lines.
 */
export const RULE = "\u0000rule\u0000";

/**
 * Wrap rendered lines in a border, with the title set into the top edge the way
 * tmux labels a pane. Every line is padded to the inner width first — an
 * unpadded line leaves the right border ragged, which reads as a rendering bug
 * rather than a style.
 */
export function frameLines(
	lines: string[],
	title: string,
	width: number,
	ink: (tone: "muted", text: string) => string,
	measure: (s: string) => number,
	truncate: (s: string, width: number) => string,
): string[] {
	const inner = width - 2;
	if (inner < 8) return lines;
	const label = truncate(title, Math.max(0, inner - 4));
	const used = measure(label) + 3;
	// tl + h + space + label + space = used + 1 columns consumed; the remainder
	// fills to the corner. Off by one here leaves the top edge a column short of
	// every other line, which is exactly the ragged look the frame exists to avoid.
	const top = `${ink("muted", BORDER.tl + BORDER.h)} ${label} ${ink("muted", BORDER.h.repeat(Math.max(0, inner - used)) + BORDER.tr)}`;
	const bottom = ink("muted", BORDER.bl + BORDER.h.repeat(inner) + BORDER.br);
	const body = lines.map((raw) => {
		const isRule = raw.startsWith(RULE);
		const l = isRule ? raw.slice(RULE.length) : raw;
		const clipped = truncate(l, inner);
		const gap = Math.max(0, inner - measure(clipped));
		const fill = isRule ? ink("muted", BORDER.h.repeat(gap)) : " ".repeat(gap);
		const [lhs, rhs] = isRule ? [BORDER.ml, BORDER.mr] : [BORDER.v, BORDER.v];
		return `${ink("muted", lhs)}${clipped}${fill}${ink("muted", rhs)}`;
	});
	return [top, ...body, bottom];
}
