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
		expect(seen.commands).toEqual(expect.arrayContaining([
			"panel", "coverage", "findings", "maximize",
			// The browser: the surface and the hypotheses behind the panel's counts.
			"surface", "hypotheses", "report",
		]));
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

describe("older hosts", () => {
	it("loads against a pi with no entry-renderer API", () => {
		// registerEntryRenderer and appendEntry are newer than the rest of the API.
		// A pi without them must start pired without a banner, not fail to load it.
		const { api } = stubApi();
		const bare = { ...api } as Record<string, unknown>;
		bare.registerEntryRenderer = undefined;
		bare.appendEntry = undefined;
		expect(() => piredExtension(bare as never)).not.toThrow();
	});
});

/**
 * The maximised rail, driven through a stand-in for pi's own host.
 *
 * Two host behaviours are what this feature actually rests on, and both are
 * reproduced here literally rather than approximated, because approximating
 * either one is what let the bug through:
 *
 *  1. ui.custom resolves `overlayOptions` ONCE. The function form is called at
 *     show time and never again — so a panel that is already open cannot be
 *     resized by returning a different object later.
 *  2. pi-tui keeps the object that resolution produced and re-reads its fields
 *     on every frame. That is the seam the fix uses.
 *
 * A stub that re-called overlayOptions each frame would pass against the broken
 * code, which is the test equivalent of not having one.
 */
const ESC = String.fromCharCode(27);

type Overlay = {
	options: Record<string, unknown>;
	component: { render: (w: number) => string[]; handleInput?: (data: string) => boolean };
	focused: boolean;
	hidden: boolean;
};

function railHost() {
	const seen = { shortcuts: new Map<string, (ctx: unknown) => unknown>(), commands: new Map<string, (a: string, c: unknown) => unknown>() };
	let overlay: Overlay | undefined;
	const api = {
		registerCommand: (n: string, o: { handler: (a: string, c: unknown) => unknown }) => seen.commands.set(n, o.handler),
		registerShortcut: (k: string, o: { handler: (c: unknown) => unknown }) => seen.shortcuts.set(k, o.handler),
		registerTool: () => {},
		registerFlag: () => {},
		registerProvider: () => {},
		getFlag: () => "on",
		on: () => {},
	};
	const ctx = {
		mode: "tui",
		ui: {
			notify: () => {},
			setStatus: () => {},
			custom: (
				factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Overlay["component"],
				opts: { overlayOptions?: unknown; onHandle?: (h: unknown) => void },
			) => {
				const resolved = (typeof opts.overlayOptions === "function"
					? (opts.overlayOptions as () => Record<string, unknown>)()
					: opts.overlayOptions) as Record<string, unknown>;
				const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 120 } };
				const theme = { fg: (_tone: string, text: string) => text };
				const component = factory(tui, theme, {}, () => {});
				const entry: Overlay = { options: resolved, component, focused: !resolved.nonCapturing, hidden: false };
				overlay = entry;
				opts.onHandle?.({
					hide: () => {
						entry.hidden = true;
					},
					setHidden: () => {},
					focus: () => {
						entry.focused = true;
					},
					unfocus: () => {
						entry.focused = false;
					},
				});
				return Promise.resolve();
			},
		},
	};
	piredExtension(api as never);
	return {
		ctx,
		maximize: async () => await seen.shortcuts.get("alt+m")?.(ctx),
		panel: async (arg = "") => await seen.commands.get("panel")?.(arg, ctx),
		shortcuts: [...seen.shortcuts.keys()],
		overlay: () => overlay as Overlay,
	};
}

describe("alt+m", () => {
	it("is bound", () => {
		expect(railHost().shortcuts).toContain("alt+m");
	});

	it("resizes the overlay pi is already holding, not just its contents", async () => {
		const host = railHost();
		await host.panel();
		const glance = host.overlay();
		expect(glance.options.width).not.toBe("70%");

		await host.maximize();

		// The same object pi resolved at open time must now describe a bigger
		// panel. It did not before: the panel laid out a full screen of content
		// into an overlay still capped at half of one, and pi sliced off the rest.
		expect(glance.options.width).toBe("70%");
		expect(glance.options.maxHeight).toBe("90%");
	});

	it("takes the keyboard while maximised and gives it back on restore", async () => {
		const host = railHost();
		await host.panel();
		// A view must never eat the keys the operator is typing at the agent.
		expect(host.overlay().focused).toBe(false);
		expect(host.overlay().options.nonCapturing).toBe(true);

		await host.maximize();
		// A scroller that cannot receive arrow keys is not a scroller.
		expect(host.overlay().focused).toBe(true);
		expect(host.overlay().options.nonCapturing).toBe(false);

		await host.maximize();
		expect(host.overlay().focused).toBe(false);
		expect(host.overlay().options.width).not.toBe("70%");
	});

	it("opens maximised with the keyboard when the panel was closed", async () => {
		const host = railHost();
		await host.maximize();
		expect(host.overlay().options.width).toBe("70%");
		// onHandle used to unfocus unconditionally, so this path opened a
		// scrollable panel that ignored every key.
		expect(host.overlay().focused).toBe(true);
	});

	it("restores from inside the rail, where pi's shortcut cannot reach", async () => {
		const host = railHost();
		await host.maximize();
		const rail = host.overlay();
		expect(rail.options.width).toBe("70%");

		// pi routes extension shortcuts through the editor, so while the rail holds
		// focus alt+m never reaches the handler. The rail answers for it itself.
		expect(rail.component.handleInput?.(ESC + "m")).toBe(true);
		await Promise.resolve();

		// Restoring rebuilds the overlay rather than editing the one pi is holding:
		// `nonCapturing` is fixed when an overlay is created, and unfocus() only
		// releases to the next *capturing* overlay, so a rail opened as a view can
		// never be given the keyboard by toggling its options. The old entry is
		// hidden; the live one is a fresh, non-capturing, half-width rail.
		expect(rail.hidden).toBe(true);
		expect(host.overlay().options.width).not.toBe("70%");
		expect(host.overlay().options.nonCapturing).toBe(true);
		expect(host.overlay().focused).toBe(false);
	});

});
