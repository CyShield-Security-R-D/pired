import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { readParentScope } from "../core/child.ts";
import { blockerDialog } from "../core/dialog.ts";
import { SUBAGENTS_ABSENT_NOTICE, SUBAGENTS_EAGER_NOTICE } from "../core/subagents.ts";
import { createRecallTool, createRecordTool } from "../core/tools.ts";
import { Workspace } from "../core/workspace.ts";
import { makeHostServices } from "./lib/host.ts";
import piredExtension, { applyOwnTheme, describeUnready } from "./pired.ts";

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

	it("hooks session_shutdown, so pi-subagents worker registrations are disposed", () => {
		// Runtime agents registered with pi-subagents are process-local and would
		// otherwise outlive the session and collide on the next one's names.
		const { api, seen } = stubApi();
		piredExtension(api as never);
		expect(seen.events).toContain("session_shutdown");
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

/**
 * The installer used to run `pi install <pired>`, which put themes/ on pi's
 * global resource path and turned `setTheme("pired")` from the no-op its comment
 * claimed into a write of `theme` in ~/.pi/agent/settings.json — repainting the
 * operator's own `pi` for good, from an install that never mentioned it. ADR-017.
 */
describe("applying pired's theme", () => {
	function themeSpy(available: Record<string, unknown>) {
		const asked: string[] = [];
		const applied: unknown[] = [];
		const ui = {
			getTheme: (name: string) => {
				asked.push(name);
				return available[name];
			},
			setTheme: (theme: unknown) => {
				applied.push(theme);
				return { success: true };
			},
		};
		return { ui, asked, applied };
	}

	it("hands pi the theme object, never its name, because a name is what pi writes to disk", () => {
		const instance = { name: "pired" };
		const { ui, applied } = themeSpy({ pired: instance });
		applyOwnTheme(ui);
		expect(applied).toEqual([instance]);
		// The regression in one line: a string here is a permanent settings write.
		expect(applied.some((t) => typeof t === "string")).toBe(false);
	});

	it("leaves a pi that never heard of pired entirely alone", () => {
		const { ui, asked, applied } = themeSpy({});
		applyOwnTheme(ui);
		expect(asked).toEqual(["pired"]);
		expect(applied).toEqual([]);
	});

	it("does nothing on a pi too old to have the theme API rather than throwing into session start", () => {
		expect(() => applyOwnTheme({})).not.toThrow();
		expect(() => applyOwnTheme({ getTheme: () => ({ name: "pired" }) })).not.toThrow();
	});
});

/**
 * Delegation, driven through session_start the way pi drives it, against a
 * stand-in host whose `pi.events` plays pi-subagents' registration listener.
 * The engagement is a temp directory with its own workspace, so nothing here
 * touches ~/.pired.
 */
describe("delegation in a live session", () => {
	type Handler = (event: unknown, ctx: unknown) => unknown;
	const REGISTER = "pi-subagents:runtime-agent-register:v1";

	/**
	 * `subagents` is what the host has: nothing (`absent`), 0.71's lazy loader on
	 * a pi >= 0.86.1 (`lazy`), or an eager `subagent` with no loader (`eager`).
	 */
	function sessionHost(subagents: "absent" | "lazy" | "eager", optIn: { maxAgents?: number; maxVerifiers?: number } = { maxAgents: 8 }) {
		const root = mkdtempSync(join(tmpdir(), "pired-session-"));
		const target = join(root, "target");
		const ws = join(root, "ws");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "pired.scope.json"), JSON.stringify({
			v: 1, engagement: "live", authorized: true, mode: "enforce", workspace: ws,
			targets: { domains: ["app.live.test"] }, ...optIn,
		}));
		const handlers = new Map<string, Handler[]>();
		const notices: string[] = [];
		const all = new Set<string>(["read", "bash"]);
		if (subagents !== "absent") all.add("subagent");
		if (subagents === "lazy") all.add("subagents_enable");
		let active = subagents === "eager" ? ["read", "bash", "subagent"] : ["read", "bash"];
		const api = {
			registerCommand: () => {},
			registerShortcut: () => {},
			registerTool: (t: { name: string }) => all.add(t.name),
			registerFlag: () => {},
			registerProvider: () => {},
			getFlag: (name: string) => (name === "pired-profile" ? "review" : "off"),
			on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
			getAllTools: () => [...all].map((name) => ({ name })),
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
			getThinkingLevel: () => "off",
			events: {
				emit: (event: string, request: { result?: unknown }) => {
					if (event === REGISTER && subagents !== "absent") request.result = { ok: true, registration: { dispose: () => {} } };
				},
				on: () => () => {},
			},
		};
		piredExtension(api as never);
		const ctx = (mode = "print") => ({
			cwd: target, mode, isProjectTrusted: () => true, model: { provider: "p", id: "m" }, thinkingLevel: "off",
			ui: new Proxy({ notify: (m: string) => notices.push(m) } as Record<string, unknown>, {
				get: (t, k) => (k in t ? t[k as string] : () => undefined),
			}),
		});
		const fire = async (event: string, payload: unknown, on: unknown = ctx()): Promise<unknown[]> => {
			const out: unknown[] = [];
			for (const h of handlers.get(event) ?? []) out.push(await h(payload, on));
			return out;
		};
		const launch = async (id: string, agent = "pired-scout") =>
			(await fire("tool_call", { type: "tool_call", toolCallId: id, toolName: "subagent", input: { agent, task: "map src/" } }))[0] as { block?: boolean; reason?: string } | undefined;
		const end = (id: string, isError = false, results: unknown[] = [{ agent: "pired-scout", exitCode: 0 }], on: unknown = ctx()) =>
			fire("tool_execution_end", { type: "tool_execution_end", toolCallId: id, toolName: "subagent", isError, result: { content: [], details: { results } } }, on);
		return { root, target, ws, notices, fire, ctx, launch, end, active: () => active };
	}

	let host: ReturnType<typeof sessionHost> | undefined;
	let savedWorkspace: string | undefined;
	beforeEach(() => {
		savedWorkspace = process.env.PIRED_WORKSPACE;
	});
	afterEach(async () => {
		if (host) {
			await host.fire("session_shutdown", {});
			rmSync(host.root, { recursive: true, force: true });
			host = undefined;
		}
		if (savedWorkspace === undefined) delete process.env.PIRED_WORKSPACE;
		else process.env.PIRED_WORKSPACE = savedWorkspace;
	});

	it("tells an operator without pi-subagents to install it, since `pi update` only upgrades what is there", async () => {
		host = sessionHost("absent");
		await host.fire("session_start", { type: "session_start" });
		expect(host.notices).toContain(SUBAGENTS_ABSENT_NOTICE);
		expect(SUBAGENTS_ABSENT_NOTICE).toContain("pi install npm:pi-subagents");
	});

	it("says once that an eager pi-subagents costs its whole schema every request, and never with the lazy loader", async () => {
		host = sessionHost("eager");
		await host.fire("session_start", { type: "session_start" });
		await host.fire("before_agent_start", { systemPrompt: "base" });
		await host.fire("before_agent_start", { systemPrompt: "base" });
		expect(host.notices.filter((n) => n === SUBAGENTS_EAGER_NOTICE)).toHaveLength(1);

		const lazy = sessionHost("lazy");
		try {
			await lazy.fire("session_start", { type: "session_start" });
			await lazy.fire("before_agent_start", { systemPrompt: "base" });
			expect(lazy.notices).not.toContain(SUBAGENTS_EAGER_NOTICE);
		} finally {
			await lazy.fire("session_shutdown", {});
			rmSync(lazy.root, { recursive: true, force: true });
		}
	});

	it("keeps the launcher and its loader out of an engagement that turns delegation off, and says nothing about their cost", async () => {
		// With both caps at 0 the gate would refuse every launch, so an active stub
		// is ~0.5k characters a request for a call that must fail. This was the
		// default under ADR-029; since ADR-038 it takes maxAgents 0 and
		// maxVerifiers 0, since maxAgents 0 alone leaves two verifier launches.
		host = sessionHost("eager", { maxAgents: 0, maxVerifiers: 0 });
		await host.fire("session_start", { type: "session_start" });
		await host.fire("before_agent_start", { systemPrompt: "base" });
		expect(host.active()).not.toContain("subagent");
		expect(host.active()).not.toContain("subagents_enable");
		expect(host.notices).not.toContain(SUBAGENTS_EAGER_NOTICE);
		expect((await host.launch("t1"))?.block).toBe(true);
	});

	it("keeps the launcher in an engagement that names no cap, since delegation is on by default (ADR-038)", async () => {
		// Under ADR-029 an engagement with nothing in its scope was the one above.
		// It now delegates, so its launcher stays, an eager schema's cost is
		// announced, and a launch goes through.
		host = sessionHost("eager", {});
		await host.fire("session_start", { type: "session_start" });
		await host.fire("before_agent_start", { systemPrompt: "base" });
		expect(host.active()).toContain("subagent");
		expect(host.notices).toContain(SUBAGENTS_EAGER_NOTICE);
		expect(await host.launch("t1")).toBeUndefined();
	});

	it("publishes the session's scope for its workers under the workspace, and withdraws it at shutdown", async () => {
		host = sessionHost("lazy");
		await host.fire("session_start", { type: "session_start" });
		expect(process.env.PIRED_WORKSPACE).toBe(host.ws);
		expect(readParentScope(globalThis, host.ws)).toMatchObject({ engagement: "live", mode: "enforce", targets: { domains: ["app.live.test"] } });
		await host.fire("session_shutdown", {});
		expect(readParentScope(globalThis, host.ws)).toBeUndefined();
	});

	/**
	 * Two `subagent` calls in one assistant message run concurrently in pi, and
	 * a probe had two workers overlapping against one GPU. The gate must refuse
	 * the second, and the first launch's end — not the refused one's — frees it.
	 */
	it("refuses a second launch while the first runs, and frees the slot when that launch's execution ends", async () => {
		host = sessionHost("lazy");
		await host.fire("session_start", { type: "session_start" });
		expect(await host.launch("call-1")).toBeUndefined();
		const second = await host.launch("call-2", "pired-verify");
		expect(second?.block).toBe(true);
		expect(second?.reason).toMatch(/one at a time/);
		await host.end("call-2", true, []);
		expect((await host.launch("call-3", "pired-verify"))?.block).toBe(true);
		await host.end("call-1");
		expect(await host.launch("call-4", "pired-verify")).toBeUndefined();
	});

	it("gives a launch that started no child its budget back", async () => {
		host = sessionHost("lazy");
		writeFileSync(join(host.target, "pired.scope.json"), JSON.stringify({
			v: 1, engagement: "live", authorized: true, mode: "enforce", workspace: host.ws, targets: {}, maxAgents: 1,
		}));
		await host.fire("session_start", { type: "session_start" });
		expect(await host.launch("rejected")).toBeUndefined();
		await host.end("rejected", true, []);
		expect(await host.launch("ran")).toBeUndefined();
		await host.end("ran");
		expect((await host.launch("over"))?.reason).toMatch(/budget spent/);
	});

	/**
	 * A worker parks its questions as blockers (contact_supervisor is refused),
	 * and the only announcement was on the parent's own `record` or on
	 * pi-subagents' foreground-complete event, which 0.71 emits only for a
	 * detached run. So a worker's question sat unannounced.
	 */
	it("announces a blocker a worker parked when the worker's launch ends", async () => {
		host = sessionHost("lazy");
		await host.fire("session_start", { type: "session_start" });
		await new Workspace(host.ws, makeHostServices()).append("blockers", {
			v: 1, id: "BLK-9", kind: "blocker", createdAt: "2026-09-23T10:00:00Z", type: "decision",
			question: "Is staging in scope?", priority: "high", status: "open",
		});
		expect(await host.launch("w1")).toBeUndefined();
		await host.end("w1", false, [{ agent: "pired-scout", exitCode: 0 }], host.ctx("tui"));
		expect(host.notices.some((n) => /1 new question needs your input/.test(n))).toBe(true);
	});
});
