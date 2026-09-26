import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piredExtension from "./pired.ts";

/**
 * The budget line and the areas line in a live session (3.2): where they go,
 * and what is counted against the budget. A small host of its own, like the
 * one in pired.test.ts, with only what these events touch.
 */

type Handler = (event: unknown, ctx: unknown) => unknown;

function host(scopeExtra: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "pired-budget-"));
	const target = join(root, "target");
	const ws = join(root, "ws");
	mkdirSync(join(target, "src", "routes"), { recursive: true });
	mkdirSync(join(target, "src", "admin"), { recursive: true });
	writeFileSync(join(target, "pired.scope.json"), JSON.stringify({
		v: 1, engagement: "budget", authorized: true, mode: "enforce", workspace: ws, targets: { domains: ["app.test"] }, ...scopeExtra,
	}));
	const handlers = new Map<string, Handler[]>();
	type PiTool = { name: string; execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ text?: string }> }> };
	const tools = new Map<string, PiTool>();
	let active = ["read", "bash"];
	const api = {
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: (t: PiTool) => tools.set(t.name, t),
		registerFlag: () => {},
		registerProvider: () => {},
		getFlag: (name: string) => (name === "pired-profile" ? "review" : "off"),
		on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
		getAllTools: () => [...active, ...tools.keys()].map((name) => ({ name })),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		getThinkingLevel: () => "off",
		events: { emit: () => {}, on: () => () => {} },
	};
	piredExtension(api as never);
	const ctx = {
		cwd: target, mode: "print", isProjectTrusted: () => true, model: { provider: "p", id: "m" }, thinkingLevel: "off",
		ui: new Proxy({} as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }),
	};
	const fire = async (event: string, payload: unknown): Promise<unknown[]> => {
		const out: unknown[] = [];
		for (const h of handlers.get(event) ?? []) out.push(await h(payload, ctx));
		return out;
	};
	/** The tail block the next request would carry, or "" when none is appended. */
	const tail = async (): Promise<string> => {
		const [res] = await fire("context", { type: "context", messages: [{ role: "user", content: "review this", timestamp: 1 }] }) as Array<{ messages?: Array<{ content: unknown }> } | undefined>;
		const last = res?.messages?.at(-1)?.content;
		return typeof last === "string" && last.startsWith("<pired-coverage>") ? last : "";
	};
	const systemPrompt = async (): Promise<string> =>
		((await fire("before_agent_start", { systemPrompt: "base" }))[0] as { systemPrompt: string }).systemPrompt;
	/** Call one of pired's registered tools the way pi would, returning its text. */
	const call = async (name: string, params: unknown): Promise<string> =>
		(await tools.get(name)!.execute("call", params, undefined, undefined, ctx)).content.map((c) => c.text ?? "").join("");
	return { root, target, fire, tail, systemPrompt, call };
}

let h: ReturnType<typeof host> | undefined;
afterEach(async () => {
	if (h) {
		await h.fire("session_shutdown", {});
		rmSync(h.root, { recursive: true, force: true });
		h = undefined;
	}
});

/** Let the background directory listing land. */
const listingLands = () => new Promise((r) => setTimeout(r, 50));

describe("the budget in a live session", () => {
	it("keeps the budget out of the system prompt and puts it in the per-request tail block", async () => {
		h = host({ budget: { tokens: 20_000_000, minutes: 240 } });
		await h.fire("session_start", { type: "session_start" });
		expect(await h.systemPrompt()).not.toMatch(/Budget:|of 20M tokens|a ceiling, not a target/);
		// Used minutes round up, so a session a second old has used one.
		expect(await h.tail()).toMatch(/Budget: [01] of 240 min used, 2(40|39) left · 0 of 20M tokens used, 20M left\./);
	});

	it("renders no budget line when the scope sets none", async () => {
		h = host({});
		await h.fire("session_start", { type: "session_start" });
		expect(await h.tail()).toBe("");
	});

	it("counts parent, worker and scribe tokens against it — the lead's turns and its workers here, a repeated worker end once", async () => {
		h = host({ budget: { tokens: 10_000_000 } });
		await h.fire("session_start", { type: "session_start" });
		await h.fire("turn_end", { type: "turn_end", message: { role: "assistant", content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2_000_000 } }, toolResults: [] });
		const workers = { content: [], details: { results: [{ agent: "pired-scout", exitCode: 0, usage: { input: 5_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 } }] } };
		for (let i = 0; i < 2; i++) {
			await h.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "subagent", isError: false, result: workers });
		}
		expect(await h.tail()).toContain("Budget: 8M of 10M tokens used, 2M left — a ceiling, not a target. 80% is used: record what is established.");
		expect(await h.call("recall", { query: "status" })).toContain("budget     8M of 10M tokens used, 2M left");
	});

	it("at the ceiling, says the session settled in the tail once it has, instead of asking again", async () => {
		h = host({ budget: { tokens: 1_000 } });
		await h.fire("session_start", { type: "session_start" });
		await h.fire("turn_end", { type: "turn_end", message: { role: "assistant", content: [], usage: { totalTokens: 1_500 } }, toolResults: [] });
		expect(await h.tail()).toContain("The ceiling is reached: settle (`record kind=settle`)");
		await h.call("record", { kind: "settle", outcome: "paused", note: "out of tokens" });
		expect(await h.tail()).toContain("The ceiling is reached; settled: paused.");
	});

	it("adds a bounded areas line once surface is recorded, naming an unlisted source directory as unmapped", async () => {
		h = host({});
		await h.fire("session_start", { type: "session_start" });
		await listingLands();
		expect(await h.tail()).toBe("");
		await h.call("record", { kind: "endpoint", path: "/login", file: "src/routes/login.ts" });
		const tail = await h.tail();
		expect(tail).toContain("Areas: 1 from the recorded surface, 0 settled.");
		expect(tail).toContain("Source directories with no recorded surface: src/admin.");
	});
});
