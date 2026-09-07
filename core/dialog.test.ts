import { describe, expect, it } from "vitest";
import { blockerDialog, blockerHeading, SKIP_OPTION } from "./dialog.ts";
import type { BlockerRecord } from "./ontology.ts";

const blocker = (over: Partial<BlockerRecord> = {}): BlockerRecord => ({
	kind: "blocker",
	id: "BLK-001",
	askedAt: "2026-09-07T10:00:00Z",
	type: "decision",
	question: "The staging host 10.0.4.11 answers on 8080 but is not in the SOW's CIDR. Test it?",
	priority: "high",
	status: "open",
	...over,
}) as BlockerRecord;

/**
 * Rows the prose occupies once pi has wrapped it, by the same rule the module
 * counts with: newlines are hard breaks and words wrap at the content width.
 */
const rows = (text: string, columns: number): number => {
	const width = columns - 2;
	let n = 0;
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			const next = line ? `${line} ${word}` : word;
			if (next.length > width && line) {
				n++;
				line = word;
			} else line = next;
		}
		n++;
	}
	return n;
};

describe("blockerDialog", () => {
	// The shipped bug: `ui.select` renders its title and its options and nothing
	// else, and the question was being passed in a `detail` argument that only
	// `confirm` accepts. The operator got "pired · decision" and three choices
	// with no statement of what was being decided.
	it("puts the question in the title, which is the only prose a select renders", () => {
		const d = blockerDialog(blocker({ options: ["in scope", "out of scope"] }));
		expect(d.shape).toBe("select");
		expect(d.title).toContain("not in the SOW's CIDR");
		expect(d.options).toEqual(["in scope", "out of scope", SKIP_OPTION]);
	});

	// Same bug, second shape: ExtensionInputComponent names its second parameter
	// `_placeholder` and never reads it, so an input dialog shows the title alone.
	it("puts the question in the title of an input, whose placeholder pi discards", () => {
		const d = blockerDialog(blocker({ type: "input" }));
		expect(d.shape).toBe("input");
		expect(d.title).toContain("not in the SOW's CIDR");
		expect(d.placeholder).toBe("answer");
	});

	it("asks a credential request for a value, and says where it will be kept", () => {
		expect(blockerDialog(blocker({ type: "credential-request" })).placeholder)
			.toBe("value (stored in the workspace)");
	});

	// confirm is pi's one two-string dialog and it joins them with a newline
	// itself, so the question belongs in the message and not repeated in both.
	it("keeps an approval a yes/no gate, with the question in the message", () => {
		const d = blockerDialog(blocker({ type: "approval", options: ["a", "b"] }));
		expect(d.shape).toBe("confirm");
		expect(d.title).toBe("pired · approval");
		expect(d.detail).toContain("not in the SOW's CIDR");
		expect(d.title).not.toContain("SOW");
	});

	it("shows the context under the question when there is room for both", () => {
		const d = blockerDialog(blocker({ options: ["yes", "no"], context: "Found via reverse DNS." }));
		expect(d.title).toContain("Found via reverse DNS.");
		expect(d.title.indexOf("The staging host")).toBeLessThan(d.title.indexOf("Found via"));
	});

	it("names the blocker's type in words, not as the stored slug", () => {
		expect(blockerHeading(blocker({ type: "credential-request" }))).toBe("pired · credential request");
	});

	// The mirror image of the reported bug. The selector is a plain Container: it
	// draws every line it is handed, and pi's main screen shows the last `rows`
	// of what it rendered. A pasted nmap run in `context` would put the question
	// on screen and push the choices off the bottom.
	it("fits the prose to the terminal so a pasted context cannot evict the choices", () => {
		const context = Array.from({ length: 60 }, (_, i) => `open port ${i} — some service banner`).join("\n");
		const d = blockerDialog(blocker({ options: ["yes", "no"], context }), { columns: 80, rows: 24 });
		// Frame, four spacers, the hint line, three options, and the prose.
		expect(6 + 1 + 3 + rows(d.title, 80)).toBeLessThanOrEqual(24);
		expect(d.title).toContain("not in the SOW's CIDR");
		expect(d.title).toContain("/blockers");
	});

	it("scales the prose with the terminal instead of assuming 80x24", () => {
		const context = Array.from({ length: 60 }, (_, i) => `open port ${i}`).join("\n");
		const tall = blockerDialog(blocker({ options: ["yes"], context }), { columns: 80, rows: 60 });
		const short = blockerDialog(blocker({ options: ["yes"], context }), { columns: 80, rows: 24 });
		expect(rows(tall.title, 80)).toBeGreaterThan(rows(short.title, 80));
		expect(6 + 1 + 2 + rows(tall.title, 80)).toBeLessThanOrEqual(60);
	});

	// A truncation notice that itself wraps costs the row it was spending to be
	// honest, which is how the fit overshot by one at 40 columns.
	it("shortens the truncation marker rather than letting it wrap", () => {
		const d = blockerDialog(
			blocker({ options: ["yes", "no"], context: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") }),
			{ columns: 40, rows: 24 },
		);
		for (const line of d.title.split("\n")) expect(line.length).toBeLessThanOrEqual(38);
	});

	// pi breaks a token wider than the line rather than letting it overflow, so
	// the row count has to break it too: a base64 blob pasted into `context` is
	// one "word" and twelve rows.
	it("counts a word too long to wrap as the rows it will actually occupy", () => {
		// Prefixed, so the partial line in hand is flushed before the break — the
		// shape a `curl` line takes when a token is pasted onto the end of it.
		const blob = `token ${"A".repeat(2000)}`;
		const d = blockerDialog(blocker({ options: ["yes"], context: blob }), { columns: 60, rows: 24 });
		expect(rows(d.title, 60)).toBeLessThanOrEqual(24 - 6 - 1 - 2);
	});

	// At 24 columns a four-digit line count does not fit the shortened marker
	// either, and a marker that wraps costs the row it was spending to be honest.
	it("falls back to a bare count when even the short marker will not fit", () => {
		const context = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
		const d = blockerDialog(blocker({ options: ["yes"], context }), { columns: 24, rows: 30 });
		const last = d.title.split("\n").at(-1)!;
		expect(last).toMatch(/^… \+\d+$/);
		expect(last.length).toBeLessThanOrEqual(22);
	});

	// The heading is the blocker's type. When the screen cannot hold both, the
	// question is what the operator has to read and the type is not.
	it("drops the heading before it drops the question", () => {
		const d = blockerDialog(blocker({ options: ["a", "b", "c", "d", "e", "f"] }), { columns: 80, rows: 16 });
		expect(d.title).not.toContain("pired · decision");
		expect(d.title).toContain("The staging host");
	});

	// pi renders the title through theme.fg, so even the empty string arrives as
	// ANSI codes and costs a row. On a terminal too small for the widget that row
	// is spent either way, and the first line of the question is a better thing
	// to spend it on than a blank.
	it("still shows a line of the question on a terminal too small for the widget", () => {
		const d = blockerDialog(blocker({ options: ["a", "b", "c", "d", "e", "f", "g", "h"] }), { columns: 40, rows: 10 });
		expect(d.title).toContain("The staging host");
	});

	it("does the same for an approval, whose heading takes the only row there is", () => {
		const d = blockerDialog(blocker({ type: "approval" }), { columns: 24, rows: 8 });
		expect(d.title).toBe("pired · approval");
		expect(d.detail).toContain("The staging");
		expect(d.detail.split("\n")).toHaveLength(1);
	});

	it("assumes 80x24 when the host cannot say how big the terminal is", () => {
		const context = Array.from({ length: 60 }, (_, i) => `open port ${i}`).join("\n");
		const guessed = blockerDialog(blocker({ options: ["yes"], context }));
		const explicit = blockerDialog(blocker({ options: ["yes"], context }), { columns: 80, rows: 24 });
		expect(guessed.title).toBe(explicit.title);
	});
});
