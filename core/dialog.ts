/**
 * What a blocker looks like as a dialog — pure, host-agnostic, and the reason
 * the question is visible at all.
 *
 * pi's extension dialogs render exactly one string of prose. `select` draws its
 * `title` and the options and nothing else; `input` takes a placeholder and its
 * component discards it — `ExtensionInputComponent` names the parameter
 * `_placeholder` and never reads it. pired passed `pired · decision` as the
 * title and left the question in a `detail` argument that only `confirm`
 * accepts, so a decision blocker reached the operator as a type name, a list of
 * choices, and no question. Choosing between "in scope" and "out of scope" with
 * nothing on screen saying what was being scoped is not a decision anybody can
 * make, and the browser's detail pane has led with the question all along
 * (`blockerLines`, core/browser.ts) — the dialog was the one place that did not.
 *
 * So the question goes in the title. pi does this itself: `showExtensionConfirm`
 * builds `${title}\n${message}` and hands the pair to the same selector, and
 * pi-tui's `Text` wraps on newlines, so a multi-line title renders as prose
 * above the widget.
 *
 * The prose is then fitted to the viewport, because the selector is a plain
 * `Container` — it renders every line it is given, with no scrolling and no
 * viewport of its own. A pasted nmap run in `context` would trade the bug
 * reported here for its mirror image: the question on screen and the choices
 * pushed off the bottom. `/blockers` holds the untruncated record either way.
 */

import type { BlockerRecord } from "./ontology.ts";

/** Which pi dialog a blocker calls for. */
export type DialogShape = "select" | "input";

/** The terminal the dialog will be drawn in. */
export interface DialogViewport {
	columns: number;
	rows: number;
}

export interface BlockerDialog {
	shape: DialogShape;
	/**
	 * The prose pi renders above the widget. Multi-line, and carrying the
	 * question for every shape — `select` and `input` show nothing else.
	 */
	title: string;
	/** Retained for adapters; empty because all visible prose is in title. */
	detail: string;
	/** Choices for `select`; approval puts its non-deciding escape hatch first. */
	options?: string[];
	/** Passed to `input`. pi's TUI component ignores it; other modes do not. */
	placeholder?: string;
}

/** The `select` choice that leaves a blocker open. Answering is never forced. */
export const SKIP_OPTION = "skip for now";
export const APPROVE_OPTION = "Approve";
export const DENY_OPTION = "Deny";

/** What is assumed when nobody knows the terminal size. 80x24 is the floor. */
const DEFAULT_VIEWPORT: DialogViewport = { columns: 80, rows: 24 };

/**
 * Rows the dialog spends on chrome, counted from the components pi builds.
 *
 * Two `DynamicBorder`s and four `Spacer(1)`s frame the selector; the input has
 * the same frame plus the field itself. The key-hint line is counted rather
 * than assumed, because at 40 columns it wraps to two rows and a chrome figure
 * that says one is a row of prose spent twice.
 */
const SELECT_FRAME = 6;
const INPUT_FRAME = 7;
/** pi's hints, at the default bindings. A rebind moves them by a word, not a row. */
const SELECT_HINT = "↑↓ navigate  enter select  escape/ctrl+c cancel";
const INPUT_HINT = "enter submit  escape/ctrl+c cancel";
/**
 * Rows below the dialog that are not the dialog's to spend.
 *
 * pired's footer renders under the editor container and takes a second line
 * whenever another extension has published a status (`makeFooter`), so two
 * rows, plus one kept clear. Overspending here is what pushes the top of the
 * dialog — the question — out of the viewport: pi's main screen renders into
 * scrollback and shows the last `rows` lines of it.
 */
const MARGIN = 3;
/** Below this the heading is dropped: the question is what has to be read. */
const MIN_QUESTION_ROWS = 2;
/** `Text` is built with paddingX 1, so two columns never hold prose. */
const TEXT_PADDING = 2;
/** The `→ ` an option carries when it is the selected one. */
const CURSOR_WIDTH = 2;

/**
 * Break text into rendered rows the way pi-tui does: newlines are hard breaks,
 * words wrap, and a word longer than the line is split rather than allowed to
 * overflow. Only the row *count* has to match pi exactly — this returns the
 * lines because the fitted prose is what gets sent back as the title.
 */
function wrapRows(text: string, width: number): string[] {
	const w = Math.max(1, width);
	const out: string[] = [];
	for (const paragraph of text.replace(/\r\n/g, "\n").split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			let token = word;
			// A token wider than the line: pi breaks it, and so must the count.
			while (token.length > w) {
				if (line) {
					out.push(line);
					line = "";
				}
				out.push(token.slice(0, w));
				token = token.slice(w);
			}
			const next = line ? `${line} ${token}` : token;
			if (next.length > w && line) {
				out.push(line);
				line = token;
			} else line = next;
		}
		out.push(line);
	}
	return out;
}

/** Rows `text` occupies once pi has wrapped it. */
function rowsFor(text: string, width: number): number {
	return wrapRows(text, width).length;
}

/**
 * How the cut is announced, in as many words as the column count affords.
 *
 * The marker is a line of the budget like any other, so it has to fit on one:
 * at 38 columns the long form wraps to two and the fit overshoots by exactly
 * the row it was spending to stay honest.
 */
function marker(dropped: number, width: number): string {
	const long = `… ${dropped} more line(s) — /blockers has the record`;
	const short = `… ${dropped} more — /blockers`;
	// The last form is a handful of characters and the viewport is clamped to 24
	// columns, so one of the three always fits.
	return long.length <= width ? long : short.length <= width ? short : `… +${dropped}`;
}

/**
 * Fit text into a row budget, saying what was left out.
 *
 * The marker costs a row of the budget rather than being added on top of it —
 * a truncation notice that itself overflows would be the bug it is there to
 * prevent. With a single row to spend there is no honest way to say both, and
 * the row goes to the text: an operator can tell that a question stops mid
 * sentence, and cannot answer a question they never saw.
 */
function fit(text: string, width: number, maxRows: number): string {
	const lines = wrapRows(text, width);
	if (lines.length <= maxRows) return lines.join("\n");
	if (maxRows <= 1) return lines[0]!;
	const kept = lines.slice(0, maxRows - 1);
	while (kept.length > 1 && kept[kept.length - 1]!.trim() === "") kept.pop();
	return [...kept, marker(lines.length - kept.length, width)].join("\n");
}

/** `credential-request` → `credential request`. The stored form is a slug. */
export function blockerHeading(b: BlockerRecord): string {
	return `pired · ${b.type.replace(/-/g, " ")}`;
}

/**
 * The question and any context, fitted to a row budget. No heading.
 *
 * The question is served first and the context gets what survives: a question
 * without its context is still answerable, and context without the question is
 * what shipped.
 */
function bodyFor(b: BlockerRecord, width: number, budget: number): string {
	const question = b.question.trim();
	if (budget <= 0) return fit(question, width, 1);
	const context = (b.context ?? "").trim();
	// Hold two rows back for context — a blank and a line — but only if there is
	// context and the question does not want the whole budget itself.
	const reserve = context && rowsFor(question, width) < budget - 2 ? 2 : 0;
	const fittedQuestion = fit(question, width, budget - reserve);
	const left = budget - rowsFor(fittedQuestion, width) - 1; // −1 for the blank line
	const fittedContext = context && left > 0 ? fit(context, width, left) : "";
	return [fittedQuestion, fittedContext].filter((part) => part !== "").join("\n\n");
}

/**
 * Heading and body, as the single string `select` and `input` will render.
 *
 * The heading is only the blocker's type, so it is the first thing dropped when
 * the screen is short — below `MIN_QUESTION_ROWS` of room it costs two rows
 * (itself and the blank under it) that the question needs more. Nothing is
 * emitted at all once the widget alone fills the terminal: pi's main screen
 * renders into scrollback and shows the last `rows` lines of it, so prose added
 * past that point scrolls off the top unread and takes an option with it.
 */
function proseFor(b: BlockerRecord, width: number, budget: number): string {
	const heading = blockerHeading(b);
	const headed = rowsFor(heading, width) + 1; // the heading and the blank under it
	if (budget - headed < MIN_QUESTION_ROWS) return bodyFor(b, width, budget);
	return `${heading}\n\n${bodyFor(b, width, budget - headed)}`;
}

/**
 * Rows of prose the dialog may spend.
 *
 * `MARGIN` is a courtesy to the footer and is the first thing surrendered: a
 * dialog that overlaps the status line is a cosmetic problem, and a dialog with
 * no question in it is not.
 */
function proseBudget(rows: number, chrome: number, widget: number): number {
	const hard = rows - chrome - widget;
	// Never below one row. pi renders the title through `theme.fg`, so even the
	// empty string arrives as ANSI codes and costs a line — on a terminal too
	// small for the widget itself that line is spent regardless, and the first
	// line of the question is a better thing to spend it on than a blank.
	return Math.max(Math.min(hard, MIN_QUESTION_ROWS), hard - MARGIN, 1);
}

/**
 * Build the dialog for one blocker, sized for the terminal it will be shown in.
 *
 * Approvals have explicit Approve/Deny choices and a non-deciding default.
 * Escape and skip must never be recorded as denial. Anything carrying
 * enumerated options is a picker. Everything else is free text.
 */
export function blockerDialog(b: BlockerRecord, viewport?: Partial<DialogViewport>): BlockerDialog {
	const columns = Math.max(24, viewport?.columns ?? DEFAULT_VIEWPORT.columns);
	const rows = Math.max(8, viewport?.rows ?? DEFAULT_VIEWPORT.rows);
	const width = columns - TEXT_PADDING;

	if (b.type === "approval") {
		// confirm() returns false for both Escape and No. Only explicit choices
		// may become a recorded decision; Enter on the default leaves it open.
		const options = [SKIP_OPTION, APPROVE_OPTION, DENY_OPTION];
		const budget = proseBudget(rows, SELECT_FRAME + rowsFor(SELECT_HINT, width), options.length);
		return { shape: "select", title: proseFor(b, width, budget), detail: "", options };
	}

	if (b.options && b.options.length > 0) {
		const options = [...b.options, SKIP_OPTION];
		const listRows = options.reduce((n, o) => n + rowsFor(o, width - CURSOR_WIDTH), 0);
		const chrome = SELECT_FRAME + rowsFor(SELECT_HINT, width);
		return { shape: "select", title: proseFor(b, width, proseBudget(rows, chrome, listRows)), detail: "", options };
	}

	return {
		shape: "input",
		title: proseFor(b, width, proseBudget(rows, INPUT_FRAME + rowsFor(INPUT_HINT, width), 0)),
		detail: "",
		placeholder: b.type === "credential-request" ? "value (stored in the workspace)" : "answer",
	};
}
