/**
 * The row pired draws into pi's transcript in place of a `record` result.
 *
 * pi renders a tool result inside a Box that pads ONE string out to the frame
 * width and paints `toolSuccessBg` across it. So a `\n` inside that string is
 * not a line break the TUI knows about: the green fill opens on the first
 * physical row, the padding lands on the second, and pi's line accounting is off
 * by one for everything drawn below — the rail panel included. What the operator
 * sees is a successful record tearing the panel under it.
 *
 * That is not a rare input. `record` answers the model, not the operator, and
 * every successful write carries a situational-awareness tail
 * (`\nEngagement: surface 34 · coverage 22% · …`, core/tools.ts) with a
 * paragraph of guidance often under it. It only *looked* intermittent because
 * `truncateToWidth` counts `\n` as one column: on a narrow frame the cut landed
 * before the newline and the row survived, on a wide one it did not. ADR-020.
 */

import type { Severity } from "./ontology.ts";

/** Severities ink themselves; the rest of the row is body text or an aside. */
export type RecordTone = Severity | "body" | "muted";

/** The `details` an agreed `record` result carries. See recordDetails in tools.ts. */
export interface RecordResultDetails {
	kind?: string;
	severity?: Severity;
	title?: string;
}

/**
 * One physical row, whatever the tool put in the string.
 *
 * The first line only: everything after it is addressed to the model in the
 * second person, and the numbers in the tail are the same derivation the rail
 * renders three rows further down. The model still receives the whole body —
 * this cuts the transcript row, not the tool result.
 *
 * C0 controls and DEL go to spaces rather than being dropped, because a lone
 * `\r` returns the cursor to column 0 and overprints the row, and a `\t` is
 * three columns to pi-tui and eight to the terminal. Both are the same off-by-n
 * as the newline, arriving by a different route.
 */
export function oneRow(text: string): string {
	return (text.split("\n", 1)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

/**
 * Render a `record` result as a security-native line. A recorded finding is the
 * engagement's actual product, so its severity should be the first thing the
 * operator sees in the transcript rather than generic tool output. Anything
 * else falls back to the tool's own summary text.
 */
export function recordResultLine(
	details: RecordResultDetails | undefined,
	summary: string,
	ink: (tone: RecordTone, text: string) => string,
): string {
	const d = details ?? {};
	return d.kind === "finding" && d.severity && d.title
		? `${ink(d.severity, `⦿ ${d.severity.toUpperCase()}`)}  ${ink("body", oneRow(d.title))}`
		: ink("muted", oneRow(summary));
}
