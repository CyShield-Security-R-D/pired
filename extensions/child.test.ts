import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHILD_EXTENSION_ID, EXTENSION_ACK_EVENT, HANDOFF_GRACE_TURNS, publishParentScope } from "../core/child.ts";
import type { EngagementScope } from "../core/ontology.ts";
import { createScopeGate } from "../core/scope.ts";
import { agentMarker, PIRED_AGENTS } from "../core/subagents.ts";
import { Workspace } from "../core/workspace.ts";
import piredChild from "./child.ts";
import { makeHostServices } from "./lib/host.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function scope(workspace: string): EngagementScope {
	return {
		v: 1, engagement: "child-test", authorized: true, mode: "enforce", workspace,
		targets: { domains: ["app.child-test.test"] }, maxAgents: 8,
	};
}

// ---------------------------------------------------------------------------
// The wiring, against a stand-in for pi's extension API
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type RegisteredTool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<unknown> };

/** Only the surface extensions/child.ts touches. Anything else it reached for would throw. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools: RegisteredTool[] = [];
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		events: {
			emit(event: string, payload: unknown) {
				emitted.push({ event, payload });
			},
			on() {
				return () => {};
			},
		},
	};
	piredChild(pi as unknown as ExtensionAPI);
	const fire = async (event: string, payload: unknown, ctx: unknown): Promise<unknown[]> => {
		const out: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx));
		return out;
	};
	return { tools, emitted, fire };
}

function ctxFor(cwd: string, systemPrompt: string | (() => string)) {
	return { cwd, getSystemPrompt: typeof systemPrompt === "function" ? systemPrompt : () => systemPrompt };
}

async function toolCall(fire: ReturnType<typeof fakePi>["fire"], ctx: unknown, toolName: string, input: unknown) {
	const [result] = await fire("tool_call", { type: "tool_call", toolCallId: "t1", toolName, input }, ctx);
	return result as { block: true; reason?: string; terminate?: true } | undefined;
}

describe("pired child extension wiring", () => {
	let root: string;
	let savedWorkspace: string | undefined;
	let withdraw: (() => void) | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pired-child-"));
		savedWorkspace = process.env.PIRED_WORKSPACE;
	});
	afterEach(() => {
		withdraw?.();
		withdraw = undefined;
		if (savedWorkspace === undefined) delete process.env.PIRED_WORKSPACE;
		else process.env.PIRED_WORKSPACE = savedWorkspace;
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * What a parent pired session leaves behind: a workspace, its informational
	 * scope.json, PIRED_WORKSPACE, and — unless `publish` is false — its scope
	 * published on globalThis, where the child really reads it.
	 */
	async function parentSession(publish = true): Promise<{ ws: string; scopeBytes: string }> {
		const ws = join(root, "ws");
		const workspace = await Workspace.open(ws, "child-test", makeHostServices());
		await workspace.writeScope(scope(ws));
		if (publish) withdraw = publishParentScope(globalThis, ws, scope(ws));
		process.env.PIRED_WORKSPACE = ws;
		return { ws, scopeBytes: readFileSync(join(ws, "scope.json"), "utf8") };
	}

	it("refuses to start without the parent's workspace, creates none, and blocks every tool", async () => {
		delete process.env.PIRED_WORKSPACE;
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await expect(fire("session_start", { type: "session_start", reason: "startup" }, ctx)).rejects.toThrow(/PIRED_WORKSPACE is not set/);
		expect(tools).toEqual([]);
		expect(emitted).toEqual([]);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toMatchObject({ block: true, reason: expect.stringContaining("not armed") });
	});

	it("refuses a PIRED_WORKSPACE that no parent session made, and leaves the directory empty", async () => {
		// Workspace.open would have written a manifest here and the worker would
		// have recorded into a ledger no panel ever reads.
		const stray = join(root, "stray");
		mkdirSync(stray);
		process.env.PIRED_WORKSPACE = stray;
		const { tools, fire } = fakePi();
		await expect(fire("session_start", {}, ctxFor(root, ""))).rejects.toThrow(/manifest\.json is missing/);
		expect(tools).toEqual([]);
		expect(existsSync(join(stray, "manifest.json"))).toBe(false);
	});

	it("refuses to arm when no parent in this process published a scope, though scope.json is on disk", async () => {
		await parentSession(false);
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await expect(fire("session_start", {}, ctx)).rejects.toThrow(/published a scope/);
		expect(tools).toEqual([]);
		expect(emitted).toEqual([]);
		expect(await toolCall(fire, ctx, "bash", { command: "ls" })).toMatchObject({ block: true, reason: expect.stringContaining("not armed") });
	});

	/**
	 * The shipped gap: each worker built its gate from <workspace>/scope.json,
	 * which the parent's own `write` or an earlier worker's bash could rewrite,
	 * re-arming every later worker while the parent's gate stayed as it was.
	 */
	it("keeps the parent's gate when scope.json has been rewritten to switch it off", async () => {
		const { ws } = await parentSession();
		writeFileSync(join(ws, "scope.json"), JSON.stringify({ ...scope(ws), mode: "off", targets: { domains: ["outside.child-test.example"] } }));
		const { fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await fire("session_start", {}, ctx);
		const blocked = await toolCall(fire, ctx, "bash", { command: "curl -s http://outside.child-test.example/" });
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("outside.child-test.example") });
	});

	it("arms on the parent's workspace with record and recall only, and acknowledges only once armed", async () => {
		const { ws, scopeBytes } = await parentSession();
		const envBefore = { ...process.env };
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, `${agentMarker("pired-scout")}\n\nworker`);
		await fire("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(tools.map((t) => t.name).sort()).toEqual(["recall", "record"]);
		expect(emitted).toEqual([{ event: EXTENSION_ACK_EVENT, payload: { id: CHILD_EXTENSION_ID } }]);

		const record = tools.find((t) => t.name === "record");
		await record?.execute("t0", { kind: "endpoint", method: "GET", path: "/wired", file: "src/app.ts" }, undefined, undefined, { cwd: root });
		const rows = readFileSync(join(ws, "inventory.jsonl"), "utf8");
		expect(rows).toContain('"path":"/wired"');

		// The child shares the parent's process: an env write here would be one
		// in the parent's shell too, and scope.json is the parent's to write.
		expect(process.env).toEqual(envBefore);
		expect(readFileSync(join(ws, "scope.json"), "utf8")).toBe(scopeBytes);
	});

	it("blocks out-of-scope bash with pired's own reason and refuses delegation and the supervisor channel", async () => {
		const { ws } = await parentSession();
		const { fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-investigate"));
		await fire("session_start", {}, ctx);

		const command = "curl --version http://outside.child-test.example/";
		const expected = await createScopeGate(scope(ws))({ name: "bash", args: { command } });
		expect(await toolCall(fire, ctx, "bash", { command })).toEqual({ block: true, reason: expected.reason });
		expect(await toolCall(fire, ctx, "bash", { command: "ls src" })).toBeUndefined();
		for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor"]) {
			expect(await toolCall(fire, ctx, name, { agent: "pired-scout", task: "nested", reason: "need_decision", message: "?" })).toMatchObject({ block: true });
		}
	});

	it("tells a worker to hand back at its role's turn budget, then ends the run", async () => {
		await parentSession();
		const { fire } = fakePi();
		const scout = PIRED_AGENTS.find((a) => a.name === "pired-scout");
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await fire("session_start", {}, ctx);
		for (let i = 0; i < (scout?.maxTurns ?? 0); i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toBeUndefined();

		await fire("turn_start", { type: "turn_start" }, ctx);
		const handBack = await toolCall(fire, ctx, "read", { path: "a.ts" });
		expect(handBack?.reason).toContain("pired-scout has used its 20-turn budget");
		expect(handBack?.terminate).toBeUndefined();

		for (let i = 0; i < HANDOFF_GRACE_TURNS; i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toMatchObject({ block: true, terminate: true });
	});

	it("learns its role from before_agent_start when the session_start prompt has no marker", async () => {
		await parentSession();
		const { fire } = fakePi();
		const noPrompt = ctxFor(root, () => {
			throw new Error("no prompt yet");
		});
		await fire("session_start", {}, noPrompt);
		await fire("before_agent_start", { type: "before_agent_start", systemPrompt: agentMarker("pired-verify") }, noPrompt);
		for (let i = 0; i < 17; i++) await fire("turn_start", { type: "turn_start" }, noPrompt);
		expect((await toolCall(fire, noPrompt, "read", {}))?.reason).toContain("pired-verify has used its 16-turn budget");
	});
});

// ---------------------------------------------------------------------------
// End to end: pi 0.87.1 + pi-subagents + pired, scripted by a faux model
// ---------------------------------------------------------------------------

/**
 * pi-subagents is not a dependency of pired (ADR-027: pired never imports it),
 * so this only runs when pointed at an installed copy — the pinned one is
 * eval/artifacts/pi-subagents-0.71.0/node_modules/pi-subagents.
 */
function locateSubagents(): { dir?: string; skip?: string } {
	const dir = process.env.PIRED_TEST_PI_SUBAGENTS?.trim();
	if (!dir) return { skip: "set PIRED_TEST_PI_SUBAGENTS to a pi-subagents 0.71 package dir to run it" };
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (pkg.name !== "pi-subagents") return { skip: `${dir} is not the pi-subagents package` };
		return { dir: resolve(dir) };
	} catch {
		return { skip: `no package.json under PIRED_TEST_PI_SUBAGENTS=${dir}` };
	}
}

const SUBAGENTS = locateSubagents();
const PI_ROOT = join(REPO, "node_modules/@earendil-works/pi-coding-agent");
const FAUX_PROVIDER = "pired-child-test-faux";
const FAUX_MODEL = "scripted";

type Msg = { role?: string; toolName?: string; isError?: boolean; content?: unknown };
type Request = { side: "parent" | "child"; tools: string[]; system: string; results: Array<{ tool: string; isError: boolean; text: string }> };
type FauxAi = {
	fauxProvider(options: { provider: string; models: Array<Record<string, unknown>> }): {
		provider: unknown;
		setResponses(steps: Array<(context: { messages: unknown[] }) => unknown>): void;
	};
	fauxAssistantMessage(content: unknown, options?: { responseId?: string }): unknown;
	fauxToolCall(name: string, args: Record<string, unknown>): unknown;
	fauxText(text: string): unknown;
	getCurrentTools(messages: unknown[]): Array<{ name: string }>;
	getCurrentSystemPrompt(messages: unknown[]): string;
};

const textOf = (m: Msg): string => Array.isArray(m.content)
	? (m.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
	: typeof m.content === "string" ? m.content : "";

/** The pi-ai copy pi-coding-agent itself loads; a provider from the other copy is one pi never registered. */
async function hostPiAi(): Promise<FauxAi> {
	const nested = join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/index.js");
	const entry = existsSync(nested) ? nested : join(REPO, "node_modules/@earendil-works/pi-ai/dist/index.js");
	return await import(pathToFileURL(entry).href) as FauxAi;
}

describe(`pired worker through pi-subagents${SUBAGENTS.skip ? ` (skipped: ${SUBAGENTS.skip})` : ""}`, () => {
	const saved: Record<string, string | undefined> = {};
	const ENV = [
		"HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
		"PI_SUBAGENTS_TEMP_ROOT", "PI_OFFLINE", "PIRED_SCRIBE", "PIRED_WORKSPACE", "PIRED_PASSES",
	];
	let root = "";
	let realFetch: typeof fetch;

	beforeEach(() => {
		for (const key of ENV) saved[key] = process.env[key];
		realFetch = globalThis.fetch;
	});
	afterEach(() => {
		for (const key of ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		globalThis.fetch = realFetch;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	type Script = (request: Request, reply: (content: unknown) => unknown, ai: FauxAi) => unknown;

	/**
	 * A parent pi session with pired and pi-subagents loaded, in a scratch
	 * engagement, answering every model request from `script`. Nothing in it may
	 * reach a network or the operator's real state.
	 */
	async function startParent(script: Script) {
		root = mkdtempSync(join(tmpdir(), "pired-child-e2e-"));
		const agentDir = join(root, "agent");
		const target = join(root, "target");
		const ws = join(root, "ws");
		const childSessions = join(root, "child-sessions");
		for (const d of [agentDir, join(target, "src"), join(root, "home"), join(root, "tmp"), join(agentDir, "extensions/subagent")]) mkdirSync(d, { recursive: true });
		writeFileSync(join(target, "src/routes.ts"), "export const routes = ['/child-e2e'];\n");
		writeFileSync(join(target, "pired.scope.json"), JSON.stringify(scope(ws)));
		// Where pi-subagents puts foreground child sessions, read from <agentDir>.
		writeFileSync(join(agentDir, "extensions/subagent/config.json"), JSON.stringify({ defaultSessionDir: childSessions }));
		// The child reads settings from disk. Cache warming off: its keep-warm
		// requests would reach the scripted model as turns nobody took.
		const settings = { packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		Object.assign(process.env, {
			HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
			PI_PACKAGE_DIR: PI_ROOT, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: PI_ROOT,
			PI_SUBAGENTS_TEMP_ROOT: join(root, "tmp/pi-subagents"), PI_OFFLINE: "1", PIRED_SCRIBE: "off",
		});
		delete process.env.PIRED_WORKSPACE;
		delete process.env.PIRED_PASSES;
		const network: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			network.push(String((input as { url?: string })?.url ?? input));
			throw new Error("network disabled in this test");
		}) as typeof fetch;

		const ai = await hostPiAi();
		const requests: Request[] = [];
		const workerMarker = /<!--\s*pired-agent:/;
		const step = (context: { messages: unknown[] }): unknown => {
			const messages = context.messages as Msg[];
			const system = ai.getCurrentSystemPrompt(context.messages);
			const tools = ai.getCurrentTools(context.messages).map((t) => t.name);
			const results = messages.filter((m) => m.role === "toolResult")
				.map((m) => ({ tool: String(m.toolName ?? ""), isError: m.isError === true, text: textOf(m) }));
			const side = workerMarker.test(system) ? "child" : "parent";
			const request: Request = { side, tools, system, results };
			requests.push(request);
			return script(request, (content) => ai.fauxAssistantMessage(content, { responseId: `${side}-${requests.length}` }), ai);
		};
		const faux = ai.fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL, contextWindow: 200_000, maxTokens: 8192 }] });
		faux.setResponses(Array.from({ length: 24 }, () => step));

		const {
			createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
			ModelRuntime, SessionManager, SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
			const settingsManager = SettingsManager.inMemory(settings as Parameters<typeof SettingsManager.inMemory>[0], { projectTrusted: true });
			const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
			modelRuntime.registerNativeProvider(faux.provider as Parameters<typeof modelRuntime.registerNativeProvider>[0]);
			const services = await createAgentSessionServices({
				cwd, agentDir: dir, settingsManager, modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
					additionalExtensionPaths: [join(REPO, "extensions/pired.ts"), join(SUBAGENTS.dir ?? "", "index.js")],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const model = modelRuntime.getModel(FAUX_PROVIDER, FAUX_MODEL);
			if (!model) throw new Error("the scripted model did not register");
			const session = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
			return { ...session, services, diagnostics: services.diagnostics };
		}, { cwd: target, agentDir, sessionManager: SessionManager.inMemory(target) });

		const session = runtime.session;
		const extensionErrors: string[] = [];
		const subagentResults: Array<{ isError: boolean; result: { content?: unknown; details?: { results?: Array<Record<string, unknown>> } } }> = [];
		session.subscribe((event: { type: string; toolName?: string; isError?: boolean; result?: unknown }) => {
			if (event.type === "tool_execution_end" && event.toolName === "subagent") {
				subagentResults.push({ isError: event.isError === true, result: event.result as never });
			}
		});
		await session.bindExtensions({ mode: "print", onError: (e: { extensionPath: string; event: string; error: unknown }) => extensionErrors.push(`${e.extensionPath} ${e.event}: ${String(e.error)}`) });
		return { session, runtime, requests, subagentResults, extensionErrors, network, ws, childSessions };
	}

	/** The parent's side of every script: enable the tool, then `launch`, then wrap up once a subagent result is back. */
	const parentTurn = (request: Request, reply: (content: unknown) => unknown, ai: FauxAi, launch: () => unknown): unknown => {
		if (request.results.some((r) => r.tool === "subagent")) return reply(ai.fauxText("The workers' handoffs are in."));
		if (request.tools.includes("subagent")) return reply(launch());
		if (request.tools.includes("subagents_enable") && !request.results.some((r) => r.tool === "subagents_enable")) return reply(ai.fauxToolCall("subagents_enable", {}));
		return reply(ai.fauxText(`no delegation tool (${request.tools.join(",")})`));
	};

	it.skipIf(SUBAGENTS.skip !== undefined)("records into the parent's ledger, is blocked out of scope with pired's reason, and hands back", async () => {
		const marker = () => join(root, "BLOCKED-COMMAND-RAN");
		const blockedCommand = () => `curl --version http://outside.child-test.example/ && touch ${marker()}`;
		const parent = await startParent((request, reply, ai) => {
			if (request.side === "child") {
				if (request.results.length === 0) return reply(ai.fauxToolCall("record", { kind: "endpoint", method: "GET", path: "/child-e2e", file: "src/routes.ts" }));
				if (request.results.length === 1) return reply(ai.fauxToolCall("bash", { command: blockedCommand() }));
				return reply(ai.fauxText("Recorded GET /child-e2e (src/routes.ts). The out-of-scope request was refused. Nothing unresolved."));
			}
			return parentTurn(request, reply, ai, () => ai.fauxToolCall("subagent", { agent: "pired-scout", task: "Map the surface in src/routes.ts; record it and hand back." }));
		});
		const { session, runtime, requests, subagentResults, extensionErrors, network, ws, childSessions } = parent;
		try {
			expect(process.env.PIRED_WORKSPACE).toBe(ws);
			const scopeBefore = readFileSync(join(ws, "scope.json"), "utf8");

			await session.prompt("Map the attack surface; delegate the routes file to a scout.");

			expect(extensionErrors).toEqual([]);
			expect(network).toEqual([]);

			// The parent launched pired's registered scout, and it came back clean.
			expect(subagentResults).toHaveLength(1);
			const [launch] = subagentResults;
			expect(launch?.isError).toBe(false);
			const child = launch?.result.details?.results?.[0] ?? {};
			expect(child).toMatchObject({ agent: "pired-scout", exitCode: 0 });
			// pired's gate armed inside the child, not only its path configured —
			// which also shows the child found the parent's in-process scope.
			expect(child.runtimeAcknowledgedExtensions).toMatchObject({ ids: [CHILD_EXTENSION_ID] });

			// The worker saw pired's ledger tools and none of the orchestration ones.
			const childRequests = requests.filter((r) => r.side === "child");
			expect(childRequests).toHaveLength(3);
			expect(childRequests[0]?.tools).toEqual(expect.arrayContaining(["record", "recall", "bash"]));
			for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor"]) expect(childRequests[0]?.tools).not.toContain(name);

			// The record reached the parent's ledger.
			const inventory = readFileSync(join(ws, "inventory.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(inventory).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "endpoint", path: "/child-e2e", file: "src/routes.ts" })]));

			// The out-of-scope command was refused with the reason the parent's gate gives, and never ran.
			const expected = await createScopeGate(JSON.parse(scopeBefore) as EngagementScope)({ name: "bash", args: { command: blockedCommand() } });
			const bash = childRequests[2]?.results.find((r) => r.tool === "bash");
			expect(bash?.isError).toBe(true);
			expect(bash?.text).toContain(expected.reason ?? "<no reason>");
			expect(existsSync(marker())).toBe(false);

			// The parent's scope and environment are as it left them.
			expect(readFileSync(join(ws, "scope.json"), "utf8")).toBe(scopeBefore);
			expect(process.env.PIRED_WORKSPACE).toBe(ws);

			// The child's session landed where the accounting reads it, one usage row per response.
			const sessionFile = String(child.sessionFile ?? "");
			expect(sessionFile.startsWith(childSessions)).toBe(true);
			const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; usage?: unknown; responseId?: string } });
			const responses = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
			expect(responses).toHaveLength(3);
			for (const r of responses) {
				expect(r.message?.responseId).toMatch(/^child-/);
				expect(r.message?.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
			}
		} finally {
			await runtime.dispose();
		}
	}, 120_000);

	/**
	 * Two shipped gaps, end to end. A `gate` on a launch ran as a host shell
	 * command after the worker, where no tool_call hook sees it — a probe wrote a
	 * marker file this way. And two launches in one assistant message ran two
	 * workers at once, because pi executes a message's tool calls in parallel.
	 */
	it.skipIf(SUBAGENTS.skip !== undefined)("never runs a launch's gate command, and runs one worker when a message asks for two", async () => {
		const marker = () => join(root, "GATE-COMMAND-RAN");
		const parent = await startParent((request, reply, ai) => {
			if (request.side === "child") return reply(ai.fauxText("Nothing to record. Nothing unresolved."));
			return parentTurn(request, reply, ai, () => [
				ai.fauxToolCall("subagent", { agent: "pired-verify", task: "Refute nothing.", gate: `touch ${marker()}` }),
				ai.fauxToolCall("subagent", { agent: "pired-scout", task: "Map src/." }),
				ai.fauxToolCall("subagent", { agent: "pired-verify", task: "Refute nothing, again." }),
			]);
		});
		const { session, runtime, requests, subagentResults, extensionErrors, network } = parent;
		try {
			await session.prompt("Delegate.");
			expect(extensionErrors).toEqual([]);
			expect(network).toEqual([]);

			expect(subagentResults).toHaveLength(3);
			const texts = subagentResults.map((r) => textOf(r.result as Msg));
			// The gated launch was refused by name, and its command never ran.
			expect(subagentResults[0]?.isError).toBe(true);
			expect(texts[0]).toContain("`gate`");
			expect(existsSync(marker())).toBe(false);
			// Exactly one worker ran; the launch behind it in the same message was refused.
			const ran = subagentResults.filter((r) => (r.result.details?.results?.length ?? 0) > 0);
			expect(ran).toHaveLength(1);
			expect(texts.some((t) => /one at a time/.test(t))).toBe(true);
			expect(new Set(requests.filter((r) => r.side === "child").map((r) => /pired-agent: (pired-[a-z]+)/.exec(r.system)?.[1]))).toEqual(new Set(["pired-scout"]));
		} finally {
			await runtime.dispose();
		}
	}, 120_000);
});
