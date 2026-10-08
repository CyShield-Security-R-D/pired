import { describe, expect, it } from "vitest";
import { oneRow, recordResultLine, type RecordTone } from "./transcript.ts";

/** Tone-tagging stand-in for pi's theme.fg, so a test can see which tone was asked for. */
const ink = (tone: RecordTone, text: string): string => `<${tone}>${text}</${tone}>`;

/** A `record` body as core/tools.ts actually assembles it: summary, then a tail for the model. */
const withDigest = (head: string): string =>
	`${head}\nEngagement: surface 34 · coverage 22% · 180 test cases outstanding · 3 findings.`;

describe("oneRow", () => {
	// The shipped bug: pi pads ONE string to the frame width and paints
	// toolSuccessBg across it, so a newline inside that string opens the green
	// fill on one physical row and lands the padding on the next. Every row
	// below the result — the rail panel included — then draws one line out.
	it("keeps the summary to a single physical row, so the success fill cannot tear the panel", () => {
		expect(oneRow(withDigest("Recorded hypothesis H-7 (refuted) on E-12"))).toBe(
			"Recorded hypothesis H-7 (refuted) on E-12",
		);
	});

	it("drops a carriage return, which would otherwise overprint the row from column 0", () => {
		expect(oneRow("Recorded loot L-1 cred:web-admin\rEngagement: surface 2")).toBe(
			"Recorded loot L-1 cred:web-admin Engagement: surface 2",
		);
	});

	// pi-tui bills a tab at three columns and the terminal spends eight: the same
	// off-by-n as the newline, arriving by a different route.
	it("flattens a tab, which pi-tui and the terminal measure differently", () => {
		expect(oneRow("Recorded note N-1\tsee evidence/raw.txt")).toBe("Recorded note N-1 see evidence/raw.txt");
	});

	it("leaves an ordinary one-line summary exactly as the tool wrote it", () => {
		expect(oneRow("Recorded endpoint E-3 POST /api/login")).toBe("Recorded endpoint E-3 POST /api/login");
	});

	it("survives an empty body rather than rendering undefined", () => {
		expect(oneRow("")).toBe("");
	});
});

describe("recordResultLine", () => {
	it("leads with what was recorded and names the fields the write did not keep after it", () => {
		const ink = (_tone: RecordTone, text: string): string => text;
		const summary = "Not stored:\n- basis (kept only by id)\n- note (no note)\nThe rest of this call was recorded.\nRecorded hypothesis y7 (refuted) on e1\nmore for the model";
		expect(recordResultLine({ kind: "hypothesis", notStored: ["basis (kept only by id)", "note (no note)"] }, summary, ink))
			.toBe("Recorded hypothesis y7 (refuted) on e1 · not stored: basis, note");
		expect(recordResultLine({ kind: "finding", severity: "high", title: "IDOR", notStored: ['status="Confirmed" (not one of …)'] }, "Not stored: x. The rest of this call was recorded.\nRecorded", ink))
			.toBe("⦿ HIGH  IDOR · not stored: status");
	});

	it("takes the model's leading lines off a reply that wrote nothing, without cutting into the summary", () => {
		const ink = (_tone: RecordTone, text: string): string => text;
		const summary = "The last 2 calls on finding f1 changed nothing. Sent the same way, the next will change nothing too: send what this reply names, under the name it gives.\n" +
			"Not stored: handle (only kind=loot has a handle).\nNothing to change on finding f1 (IDOR): everything in this call that a finding keeps already holds that value, so nothing was written.";
		expect(recordResultLine({ kind: "finding", notStored: ["handle (only kind=loot has a handle)"] }, summary, ink))
			.toBe("Nothing to change on finding f1 (IDOR): everything in this call that a finding keeps already holds that value, so nothing was written. · not stored: handle");
		expect(recordResultLine({ kind: "finding" }, "Not stored:\n- a (x)\n- b (y)\nNothing to change on finding f1 (IDOR).", ink)).toBe("Nothing to change on finding f1 (IDOR).");
	});

	it("leads a finding with its severity, which is the engagement's actual product", () => {
		const line = recordResultLine(
			{ kind: "finding", severity: "high", title: "SQL injection in the login handler" },
			"ignored — the details carry the finding",
			ink,
		);
		expect(line).toBe("<high>⦿ HIGH</high>  <body>SQL injection in the login handler</body>");
	});

	it("keeps a finding to one row too: a pasted title can carry a newline of its own", () => {
		const line = recordResultLine({ kind: "finding", severity: "low", title: "Verbose error\npage" }, "", ink);
		expect(line).not.toContain("\n");
		expect(line).toContain("Verbose error");
	});

	it("falls back to the tool's summary for every kind that is not a finding", () => {
		expect(recordResultLine({ kind: "hypothesis" }, withDigest("Recorded hypothesis H-7 (refuted) on E-12"), ink))
			.toBe("<muted>Recorded hypothesis H-7 (refuted) on E-12</muted>");
	});

	// recordDetails only carries severity and title for findings, so a finding
	// whose details were stripped must still render something rather than "⦿ ".
	it("falls back when the details name a finding but carry neither severity nor title", () => {
		expect(recordResultLine({ kind: "finding" }, "Recorded finding F-2 [medium] Open redirect", ink))
			.toBe("<muted>Recorded finding F-2 [medium] Open redirect</muted>");
	});

	it("tolerates absent details, because presentation must never break the transcript", () => {
		expect(recordResultLine(undefined, "Recorded note N-1", ink)).toBe("<muted>Recorded note N-1</muted>");
	});
});
