import { describe, expect, it } from "vitest";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { blockerDialog } from "../core/dialog.ts";
import { createRecallTool, createRecordTool } from "../core/tools.ts";
import piredExtension, { describeUnready } from "./pired.ts";

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
			// The scribe, the name it had before, and the way back to a dismissed blocker.
			"scribe", "extract", "blockers",
		]));
	});

	it("hooks agent_settled and input, which is where the scribe now lives", () => {
		// The pass used to run from `turn_end`, inside pi's agent loop and awaited
		// by it. These two are the replacement: start when the agent has finished,
		// stop when the operator wants the machine back. See extensions/scribe.test.ts.
		const { api, seen } = stubApi();
		piredExtension(api as never);
		expect(seen.events).toEqual(expect.arrayContaining(["turn_end", "agent_settled", "input"]));
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
		run: async (name: string, arg = "", on: unknown = ctx) => await seen.commands.get(name)?.(arg, on),
		shortcuts: [...seen.shortcuts.keys()],
		overlay: () => overlay as Overlay,
	};
}

describe("/blockers", () => {
	it("says so plainly when there is no engagement to read", async () => {
		const said: string[] = [];
		const host = railHost();
		const ctx = { ...host.ctx, ui: { ...host.ctx.ui, notify: (m: string) => said.push(m) } };
		await host.run("blockers", "", ctx);
		expect(said.join(" ")).toContain("no engagement workspace");
	});
});

describe("/challenge", () => {
	/**
	 * The command shipped with no test at all, which is how `extensions/pired.ts`
	 * gets to 38% coverage and why CLAUDE.md says to keep moving logic out of it.
	 */
	it("says so plainly when there is no engagement to read", async () => {
		const said: string[] = [];
		const host = railHost();
		const ctx = { ...host.ctx, ui: { ...host.ctx.ui, notify: (m: string) => said.push(m) } };
		await host.run("challenge", "", ctx);
		expect(said.join(" ")).toContain("no engagement workspace");
	});

	it("is registered, so /challenge exists at all", () => {
		const host = railHost();
		expect(host.run("challenge", "")).toBeDefined();
	});
});

describe("the recall schema and the queries that read it", () => {
	/**
	 * The bug this catches: `recall cleared class=authz` read `a.class`, and
	 * `class` was not in the tool's parameter schema — so the filter was
	 * unreachable to a model however well it worked when a test called
	 * `execute()` directly. Same shape as `api.json` shipping with 13 classes
	 * nothing could select.
	 */
	it("declares every argument its queries actually read", () => {
		const recall = createRecallTool({ workspace: {} as never });
		const props = Object.keys((recall.parameters as { properties: Record<string, unknown> }).properties);
		for (const arg of ["query", "id", "class", "limit"]) {
			expect(props, `recall must accept ${arg}`).toContain(arg);
		}
	});

	it("offers cleared as a query, or nothing can ask for it", () => {
		const recall = createRecallTool({ workspace: {} as never });
		const q = (recall.parameters as { properties: { query: { enum: string[] } } }).properties.query.enum;
		expect(q).toContain("cleared");
		expect(q).toContain("challenge");
	});

	/**
	 * `basis` and `live` are read on a re-checked hypothesis, and their
	 * descriptions said "For kind=finding:" — a model reading that would never
	 * supply them on a hypothesis, so the field that records a second look would
	 * almost never have been written.
	 */
	it("does not tell the model basis and live are for findings only", () => {
		const record = createRecordTool({ workspace: {} as never });
		const props = (record.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(props.basis?.description).toMatch(/hypothesis/i);
		expect(props.live?.description).not.toMatch(/^For kind=finding:/);
	});
});

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

/**
 * The clause that tells an operator a finding would ship with a section
 * missing. It rides on a line that is already being printed — the extraction
 * summary, or the export — because pi's status line replaces the previous one
 * in place, so a second notification erases the first instead of following it.
 */
describe("saying a finding is not report-ready", () => {
	it("names the pass that fixes it, and says nothing when there is nothing to fix", () => {
		expect(describeUnready(2)).toContain("2 need impact + remediation");
		expect(describeUnready(2)).toContain("/skill:ops-technical-writer");
		expect(describeUnready(1)).toContain("1 needs impact + remediation");
		expect(describeUnready(0)).toBe("");
	});
});

/**
 * The dialog, drawn by the components pi will actually draw it with.
 *
 * core/dialog.test.ts asserts the strings. This asserts what reaches the
 * screen, because the shipped bug was invisible at the string level: the
 * question was passed in a `detail` argument, the argument was correct, and
 * pi's selector renders no such thing.
 */
describe("a blocker on screen", () => {
	const blocker = {
		kind: "blocker", id: "BLK-001", askedAt: "2026-09-07T10:00:00Z", type: "decision",
		question: "The staging host 10.0.4.11 answers on 8080 but is not in the SOW's CIDR. Test it?",
		options: ["in scope — test it", "out of scope — leave it"],
		context: "Found via reverse DNS on the in-scope range.",
		priority: "high", status: "open",
	} as const;

	/** The dialog as the terminal would show it: real component, ink stripped. */
	function draw(columns: number, rows: number, context: string = blocker.context): string[] {
		initTheme("dark");
		const d = blockerDialog({ ...blocker, context } as never, { columns, rows });
		const drawn = new ExtensionSelectorComponent(d.title, d.options ?? [], () => {}, () => {}, {});
		return drawn.render(columns).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	}

	it("prints the question above the choices, which it did not before", () => {
		const lines = draw(80, 24);
		const question = lines.findIndex((l) => l.includes("The staging host 10.0.4.11"));
		const firstChoice = lines.findIndex((l) => l.includes("in scope — test it"));
		expect(question).toBeGreaterThan(-1);
		expect(question).toBeLessThan(firstChoice);
		expect(lines.some((l) => l.includes("skip for now"))).toBe(true);
	});

	// The failure this trades against: prose long enough to push the choices past
	// the bottom of the terminal. pi's main screen shows the last `rows` lines it
	// rendered, so anything over that count scrolls off the top unread — which
	// would hide the question again, and take a choice with it.
	it("keeps the whole dialog inside the terminal, at every size worth having", () => {
		const paste = Array.from({ length: 80 }, (_, i) => `open port ${i} — a service banner nobody trimmed`).join("\n");
		for (const [columns, rows] of [[80, 24], [100, 30], [120, 60], [60, 20], [200, 24]] as const) {
			const lines = draw(columns, rows, paste);
			expect(lines.length, `${columns}x${rows}`).toBeLessThanOrEqual(rows);
			// And the question survived the trim, which is the point of the trim.
			expect(lines.some((l) => l.includes("The staging host"))).toBe(true);
			expect(lines.some((l) => l.includes("skip for now"))).toBe(true);
		}
	});
});
