import { describe, expect, it } from "vitest";
import piredExtension from "./pired.ts";

/**
 * The extension is mostly host glue, so it is not unit-testable in the usual
 * sense — but registration is. A typo in a shortcut id or a command name is only
 * discovered by launching the TUI otherwise, and this session lost hours to
 * exactly that class of "looked fine, never ran" failure.
 */
function stubApi() {
	const seen = { commands: [] as string[], shortcuts: [] as string[], flags: [] as string[], events: [] as string[] };
	const api = {
		registerCommand: (n: string) => seen.commands.push(n),
		registerShortcut: (k: string) => seen.shortcuts.push(k),
		registerTool: () => {},
		registerFlag: (n: string) => seen.flags.push(n),
		registerProvider: () => {},
		on: (e: string) => seen.events.push(e),
	};
	return { api, seen };
}

describe("pired extension registration", () => {
	it("registers without throwing against a bare host", () => {
		const { api } = stubApi();
		expect(() => piredExtension(api as never)).not.toThrow();
	});

	it("exposes the operator-facing commands", () => {
		const { api, seen } = stubApi();
		piredExtension(api as never);
		expect(seen.commands).toEqual(expect.arrayContaining(["panel", "coverage", "findings"]));
	});

	it("binds a key for the panel — a view behind a typed command gets checked less", () => {
		const { api, seen } = stubApi();
		piredExtension(api as never);
		expect(seen.shortcuts).toContain("alt+p");
	});

	it("hooks tool_execution_end, which is where blockers are noticed", () => {
		const { api, seen } = stubApi();
		piredExtension(api as never);
		expect(seen.events).toContain("tool_execution_end");
	});
});
