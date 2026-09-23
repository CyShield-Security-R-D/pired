import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner, Theme, type ThemeColor, type Extension, type ExtensionContext, type ExtensionShortcut } from "@earendil-works/pi-coding-agent";
import { matchesKey, setKittyProtocolActive, TuiMainScreen, type Component, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import piredExtension from "./pired.ts";

vi.mock("./lib/providers.ts", () => ({ registerPiredProviders: () => {}, apiKeyForProvider: () => "local" }));

function host() {
	const cwd = mkdtempSync(join(tmpdir(), "pired-ui-"));
	const dir = join(cwd, "workspace");
	writeFileSync(join(cwd, "pired.scope.json"), JSON.stringify({ engagement: "ui-test", workspace: dir, mode: "off", authorized: true }));
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const shortcuts = new Map<string, ExtensionShortcut>();
	const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const notes: string[] = [];
	const terminal = { rows: 24, columns: 100, hideCursor: () => {}, write: () => {}, showCursor: () => {} };
	const tui = new TuiMainScreen(terminal as never);
	tui.requestRender = vi.fn();
	const editor: Component = { render: () => ["editor"], invalidate: () => {} };
	tui.addChild(editor);
	tui.setFocus(editor);
	const overlays: Array<{ component: Component; handle: OverlayHandle; done: () => void }> = [];
	const theme = { fg: (_tone: string, s: string) => s, bg: (_tone: string, s: string) => s, bold: (s: string) => s };
	const api = {
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts.handler),
		registerShortcut: (key: string, shortcut: ExtensionShortcut) => shortcuts.set(key, { ...shortcut, extensionPath: "pired" }),
		registerTool: () => {}, registerFlag: () => {}, registerProvider: () => {}, registerEntryRenderer: () => {}, appendEntry: () => {},
		setActiveTools: () => {}, getActiveTools: () => [], getFlag: () => undefined,
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => events.set(event, handler),
	};
	const ctx = {
		cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true, getContextUsage: () => undefined,
		ui: {
			theme, notify: (message: string) => { notes.push(message); }, setStatus: () => {},
			select: vi.fn<(...args: unknown[]) => Promise<string | undefined>>().mockResolvedValue(undefined),
			input: vi.fn<(...args: unknown[]) => Promise<string | undefined>>().mockResolvedValue(undefined),
			custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => Component,
				opts: { overlayOptions: OverlayOptions; onHandle?: (handle: OverlayHandle) => void }) => new Promise<void>((resolve, reject) => {
				let component: Component & { dispose?: () => void };
				let closed = false;
				const done = () => {
					if (closed) return;
					closed = true;
					tui.hideOverlay(); // pi's real callback pops the top overlay, not its own handle.
					component?.dispose?.();
					resolve();
				};
				Promise.resolve().then(() => factory(tui, theme, {}, done)).then((c) => {
					if (closed) return;
					component = c;
					const handle = tui.showOverlay(component, opts.overlayOptions);
					overlays.push({ component, handle, done });
					opts.onHandle?.(handle);
				}).catch(reject);
			}),
		},
	};
	piredExtension(api as never);
	const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
	return { ctx, tui, editor, terminal, notes, overlays, shortcuts, dir, flush,
		start: async () => { await events.get("session_start")?.({}, ctx); await flush(); },
		command: async (name: string, args = "", context: unknown = ctx) => { await commands.get(name)?.(args, context); await flush(); },
		key: async (key: string) => { await shortcuts.get(key)?.handler(ctx as never); await flush(); },
		event: async (event: string, payload: unknown = {}) => { await events.get(event)?.(payload, ctx); await flush(); },
		append: (store: string, records: unknown[]) => writeFileSync(join(dir, `${store}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n"),
	};
}

afterEach(() => { setKittyProtocolActive(false); vi.unstubAllEnvs(); });

describe("Windows panel shortcuts", () => {
	it("keeps F6/F7 available when the host reserves Alt+P for model cycling", async () => {
		const h = host();
		const ext = { path: "pired", shortcuts: h.shortcuts } as Extension;
		const runner = new ExtensionRunner([ext], {} as never, ".", {} as never, {} as never);
		runner.setUIContext(h.ctx.ui as never, "tui");
		const bindings = runner.getShortcuts({ "app.model.cycleForward": "alt+p", "app.model.cycleBackward": "ctrl+p" });
		expect(bindings.has("alt+p")).toBe(false);
		expect(bindings.has("f6")).toBe(true);
		expect(bindings.has("f7")).toBe(true);
		let modelSwitches = 0;
		const dispatch = async (data: string) => {
			for (const [key, shortcut] of bindings) if (matchesKey(data, key)) {
				await shortcut.handler(h.ctx as unknown as ExtensionContext); await h.flush(); return;
			}
			if (matchesKey(data, "alt+p") || matchesKey(data, "ctrl+p")) modelSwitches++;
		};
		await dispatch("\x1b[17~"); // Windows Terminal / xterm F6.
		expect(h.tui.hasOverlay()).toBe(true);
		await dispatch("\x1b[18~"); // F7 expands and takes focus.
		expect(h.tui.getFocusedComponent()).toBe(h.overlays.at(-1)?.component);
		expect(modelSwitches).toBe(0);
		await dispatch("\x10");
		expect(modelSwitches).toBe(1); // Model controls remain model controls.
	});

	it("can hide a focused, maximized panel with F6 and restore the editor", async () => {
		const h = host();
		await h.key("f7");
		h.overlays.at(-1)?.component.handleInput?.("\x1b[17~");
		await h.flush();
		expect(h.tui.hasOverlay()).toBe(false);
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
	});

	it("restores with F7 from inside the captured panel, including Kitty sequences", async () => {
		const h = host();
		await h.key("f7");
		setKittyProtocolActive(true);
		h.overlays.at(-1)?.component.handleInput?.("\x1b[18~");
		await h.flush();
		expect(h.tui.hasOverlay()).toBe(true);
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
	});
});

describe("panel lifecycle", () => {
	it("removes only the panel when a newer modal is open", async () => {
		const h = host();
		await h.command("panel");
		const modal = { render: () => ["unsaved provider"], invalidate: () => {} };
		const handle = h.tui.showOverlay(modal);
		await h.command("panel", "off");
		expect(h.tui.hasOverlay()).toBe(true);
		expect(h.tui.getFocusedComponent()).toBe(modal);
		handle.hide();
		expect(h.tui.hasOverlay()).toBe(false);
	});

	it("rapid toggles and mode changes leave exactly one usable panel", async () => {
		const h = host();
		await Promise.all([h.key("f6"), h.key("f6")]);
		expect(h.tui.hasOverlay()).toBe(false);
		await h.key("f6");
		for (let i = 0; i < 12; i++) await h.key("f7");
		await h.command("panel", "next");
		await h.command("panel", "off");
		expect(h.tui.hasOverlay()).toBe(false);
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
	});

	it("does not open a UI on headless commands or unknown panel arguments", async () => {
		const h = host();
		await h.command("panel", "", { ...h.ctx, mode: "print" });
		await h.command("panel", "typo");
		expect(h.overlays).toHaveLength(0);
		expect(h.notes.join("\n")).toContain("terminal UI");
		expect(h.notes.join("\n")).toContain("/panel [on");
	});

	it("catches asynchronous UI failure and leaves a working fallback", async () => {
		const h = host();
		h.ctx.ui.custom = async () => { throw new Error("renderer failed"); };
		await h.command("panel");
		expect(h.notes.join("\n")).toContain("footer panel");
		await h.command("panel", "off");
		expect(h.notes.at(-1)).toContain("panel hidden");
	});

	it("reopening a session retires the previous panel and its keyboard capture", async () => {
		const h = host();
		await h.start();
		await h.key("f7");
		await h.start();
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
		await h.command("panel", "off");
		expect(h.tui.hasOverlay()).toBe(false);
	});

	it("scrolls a long finding to its evidence and back without changing the selected finding", async () => {
		const h = host();
		await h.start();
		h.append("findings", [{ v: 1, id: "f1", kind: "finding", title: "Long finding", severity: "high", status: "open",
			description: "Description text. ".repeat(180), evidence: ["evidence/final-proof.txt"] }]);
		await h.command("panel", "findings");
		await h.key("f7");
		const component = h.overlays.at(-1)!.component;
		component.handleInput?.("\r");
		expect(component.render(70).join("\n")).not.toContain("final-proof");
		component.handleInput?.("\x1b[F");
		expect(component.render(70).join("\n")).toContain("final-proof");
		component.handleInput?.("\x1b[H");
		expect(component.render(70).join("\n")).toContain("Long finding");
	});
});

describe("theme semantics", () => {
	const palette = JSON.parse(readFileSync(new URL("../themes/pired.json", import.meta.url), "utf8"));
	const resolve = (role: string): string => palette.vars[palette.colors[role]] ?? palette.colors[role];
	const rgb = (hex: string): number[] => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

	it("keeps pired visibly red without using the error shade for ordinary activity", () => {
		for (const role of ["accent", "borderAccent", "mdLink", "mdCode", "syntaxKeyword", "thinkingHigh"]) {
			const [r, g, b] = rgb(resolve(role)) as [number, number, number];
			expect(r, role).toBeGreaterThan(Math.max(g, b) + 45);
			expect(resolve(role), role).not.toBe(resolve("error"));
		}
		expect(resolve("customMessageLabel")).not.toBe(resolve("error"));
		expect(resolve("error")).toBe(resolve("toolDiffRemoved"));
	});

	it.each(["truecolor", "256color"] as const)("keeps normal and error ink distinct after %s terminal conversion", (mode) => {
		const colors = Object.fromEntries(Object.keys(palette.colors).map((role) => [role, resolve(role)]));
		const theme = new Theme(colors as ConstructorParameters<typeof Theme>[0], colors as ConstructorParameters<typeof Theme>[1], mode);
		for (const role of ["accent", "borderAccent", "muted", "thinkingHigh"] as ThemeColor[]) {
			expect(theme.fg(role, "sample"), role).not.toBe(theme.fg("error", "sample"));
		}
		expect(theme.bg("selectedBg", "sample")).not.toBe(theme.bg("toolErrorBg", "sample"));
	});

	it("keeps field text and muted labels readable on dark and selected backgrounds", () => {
		const luminance = (hex: string): number => rgb(hex).map((n) => n / 255)
			.map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
			.reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
		for (const background of [palette.export.pageBg, resolve("toolPendingBg"), resolve("selectedBg")]) {
			for (const role of ["text", "muted", "accent", "error"]) {
				const contrast = (luminance(resolve(role)) + 0.05) / (luminance(background) + 0.05);
				expect(contrast, `${role} on ${background}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});


describe("blockers without interruptions", () => {
	const question = { v: 1, id: "b1", kind: "blocker", type: "approval", priority: "high", status: "open", question: "Proceed with this test?", askedAt: "2026-09-23T00:00:00Z" };

	it("announces background questions once without stealing focus or blocking the tool event", async () => {
		const h = host();
		await h.start();
		h.append("blockers", [question]);
		const form = { render: () => ["unsaved form"], invalidate: () => {} };
		h.tui.showOverlay(form);
		await h.event("tool_execution_end", { toolName: "record", isError: false });
		await h.event("tool_execution_end", { toolName: "record", isError: false });
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		expect(h.ctx.ui.input).not.toHaveBeenCalled();
		expect(h.tui.getFocusedComponent()).toBe(form);
		expect(h.notes.filter((n) => n.includes("new question"))).toHaveLength(1);
		expect(h.notes.join("\n")).toContain("/blockers to review");
	});

	it.each([[undefined, "open"], ["skip for now", "open"], ["Approve", "answered"], ["Deny", "answered"]])(
		"writes a blocker decision only for an explicit answer (%s)", async (choice, expected) => {
			const h = host();
			await h.start();
			h.append("blockers", [question]);
			h.ctx.ui.select.mockResolvedValue(choice);
			const browsing = h.command("blockers");
			await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
			h.overlays.at(-1)!.component.handleInput?.("a");
			await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
			const rows = readFileSync(join(h.dir, "blockers.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(rows.at(-1).status).toBe(expected);
			if (expected === "open") expect(rows).toHaveLength(1);
			else expect(rows.at(-1).answer).toBe(choice === "Approve" ? "approved" : "denied");
			h.overlays.at(-1)!.component.handleInput?.("q");
			await browsing;
		});
});


describe("browser resizing", () => {
	it("keeps the selected record visible when the terminal becomes shorter", async () => {
		const h = host();
		await h.start();
		h.append("findings", Array.from({ length: 30 }, (_, i) => ({ v: 1, kind: "finding", id: `f${i}`, title: `Finding ${i}`, severity: "high", status: "open" })));
		const browsing = h.command("findings");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const component = h.overlays.at(-1)!.component;
		component.render(80);
		for (let i = 0; i < 10; i++) component.handleInput?.("\x1b[B");
		const before = component.render(80).find((line) => line.includes("▸"));
		expect(before).toBeDefined();
		h.terminal.rows = 14;
		const smaller = component.render(80);
		expect(smaller.find((line) => line.includes("▸"))).toBe(before);
		expect(smaller.length).toBeLessThanOrEqual(Math.floor(14 * 0.8));
		component.handleInput?.("q");
		await browsing;
	});
});


describe("panel refresh from disk", () => {
	it("refreshes severity counts along with rows added outside the session", async () => {
		const h = host();
		await h.start();
		h.append("findings", [{ v: 1, id: "fresh", kind: "finding", title: "External finding", severity: "high", status: "open" }]);
		await h.command("panel", "findings");
		const text = h.overlays.at(-1)!.component.render(70).join("\n");
		expect(text).toContain("External finding");
		expect(text).not.toContain("none recorded");
	});

	it("does not reopen when hidden while the ledger is being refreshed", async () => {
		const h = host();
		await h.start();
		const opening = h.command("panel", "on");
		await h.command("panel", "off");
		await opening;
		expect(h.tui.hasOverlay()).toBe(false);
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
	});
});


describe("returning from an answer dialog", () => {
	it("keeps a deep selection visible and lets Escape close the returned list", async () => {
		const h = host();
		await h.start();
		h.append("blockers", Array.from({ length: 20 }, (_, i) => ({ v: 1, id: `b${i}`, kind: "blocker", type: "approval", priority: "high", status: "open", question: `Question ${String(i).padStart(2, "0")}`, askedAt: "2026-09-23T00:00:00Z" })));
		const browsing = h.command("blockers");
		await vi.waitFor(() => expect(h.overlays).toHaveLength(2));
		const first = h.overlays.at(-1)!.component;
		first.render(80);
		for (let i = 0; i < 15; i++) first.handleInput?.("\x1b[B");
		const selected = first.render(80).find((line) => line.includes("▸"));
		expect(selected).toBeDefined();
		first.handleInput?.("\r");
		first.handleInput?.("a"); // Dismiss the approval prompt without a decision.
		await vi.waitFor(() => expect(h.overlays).toHaveLength(3));
		const returned = h.overlays.at(-1)!.component;
		expect(returned.render(80).find((line) => line.includes("▸"))).toBe(selected);
		returned.handleInput?.("\x1b");
		expect(h.tui.getFocusedComponent()).toBe(h.editor);
		await browsing;
	});
});
