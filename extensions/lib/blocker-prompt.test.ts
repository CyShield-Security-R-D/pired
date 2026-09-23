import { describe, expect, it, vi } from "vitest";
import type { BlockerRecord } from "../../core/ontology.ts";
import { APPROVE_OPTION, DENY_OPTION, SKIP_OPTION } from "../../core/dialog.ts";
import { promptBlocker } from "./blocker-prompt.ts";

const blocker = (over: Partial<BlockerRecord> = {}): BlockerRecord => ({
	id: "b1", kind: "blocker", type: "approval", question: "Run the test?", status: "open", priority: "high", ...over,
}) as BlockerRecord;

describe("operator decisions", () => {
	it.each([undefined, SKIP_OPTION, "unknown"])("leaves an approval open when dismissed or unanswered (%s)", async (answer) => {
		const ui = { select: vi.fn(async () => answer), input: vi.fn(async () => undefined) };
		expect(await promptBlocker(ui, blocker())).toBeUndefined();
		expect(ui.select.mock.calls[0]).toEqual([expect.stringContaining("Run the test?"), [SKIP_OPTION, APPROVE_OPTION, DENY_OPTION]]);
	});

	it.each([[APPROVE_OPTION, "approved"], [DENY_OPTION, "denied"]])("records only the explicit %s choice", async (choice, answer) => {
		const ui = { select: async () => choice, input: async () => undefined };
		expect(await promptBlocker(ui, blocker())).toBe(answer);
	});

	it("preserves free text and ordinary choices while treating empty answers as cancellation", async () => {
		const ui = { select: async () => "staging", input: vi.fn().mockResolvedValueOnce("use port 8080").mockResolvedValueOnce("") };
		expect(await promptBlocker(ui, blocker({ type: "input" }))).toBe("use port 8080");
		expect(await promptBlocker(ui, blocker({ type: "input" }))).toBeUndefined();
		expect(await promptBlocker(ui, blocker({ type: "decision", options: ["staging", "prod"] }))).toBe("staging");
	});
});
