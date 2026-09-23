import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isContextOverflow, type AssistantMessage, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { contextSafetyMargin, estimateInputTokens, guardedOpenAICompletions } from "./context-guard.ts";

const model: Model<"openai-completions"> = {
	id: "qwen", name: "Qwen", provider: "pired-test", api: "openai-completions",
	baseUrl: "http://unused.invalid/v1", reasoning: false, input: ["text"],
	contextWindow: 262144, maxTokens: 32768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { maxTokensField: "max_tokens" },
};
const user = (text = "next", timestamp = 2) => ({
	role: "user" as const, content: [{ type: "text" as const, text }], timestamp,
});
const assistant = (tokens: number, overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant", content: [{ type: "text", text: "done" }],
	api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
	usage: {
		input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	...overrides,
});
const contextAt = (tokens: number): Context => ({ messages: [assistant(tokens), user()] });
const completion = (text = "ok") => new Response([
	{ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
	{ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
{ headers: { "Content-Type": "text/event-stream" } });
const fakeFetch = () => vi.fn<typeof fetch>(async () => completion());

describe("input budget", () => {
	it("uses server usage (including cached tokens) plus new tool output", () => {
		const last = assistant(210000);
		last.usage = { ...last.usage, input: 10000, cacheRead: 200000, totalTokens: 0 };
		expect(estimateInputTokens(model, { messages: [last, {
			role: "toolResult", toolCallId: "1", toolName: "read",
			content: [{ type: "text", text: "x".repeat(20000) }], isError: false, timestamp: 2,
		}] })).toBe(215000);
	});

	it.each(["error", "aborted"] as const)("ignores %s usage", (stopReason) => {
		expect(estimateInputTokens(model, { messages: [assistant(245000, { stopReason }), user()] })).toBe(2);
	});

	it("does not reuse pre-compaction usage or usage from a different model", () => {
		expect(estimateInputTokens(model, { messages: [user("summary", 3), assistant(245000), user()] })).toBe(4);
		expect(estimateInputTokens(model, { messages: [assistant(245000, { model: "other" }), user()] })).toBe(2);
	});

	it("includes system text, tool schemas and image estimates without usage", () => {
		const tools = [{ name: "read", description: "read", parameters: { type: "object" } }] as Tool[];
		const context: Context = { systemPrompt: "x".repeat(400), tools, messages: [user("x".repeat(400)), {
			role: "user", content: [{ type: "image", mimeType: "image/png", data: "ignored" }], timestamp: 3,
		}] };
		expect(estimateInputTokens(model, context)).toBe(1400 + Math.ceil(JSON.stringify(tools).length / 4));
	});

	it("counts newly loaded tools without charging the old schema twice", () => {
		const tools = [{ name: "new", description: "read", parameters: { type: "object" } }] as Tool[];
		expect(estimateInputTokens(model, { systemPrompt: "already counted", tools, messages: [assistant(100), {
			role: "toolResult", toolCallId: "1", toolName: "load", content: [], isError: false, timestamp: 2,
			addedToolNames: ["new"],
		}] })).toBe(100 + Math.ceil(JSON.stringify(tools).length / 4));
	});

	it("scales the margin for small windows", () => {
		expect(contextSafetyMargin(262144)).toBe(16384);
		expect(contextSafetyMargin(32768)).toBe(2048);
		expect(contextSafetyMargin(8192)).toBe(512);
	});
});

describe("OpenAI-compatible context guard", () => {
	it.each([212992, 230000, 245000])("blocks %i input tokens before HTTP and emits an overflow pi recognizes", async (tokens) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, contextAt(tokens), { apiKey: "test", fetch }).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("pired's safe context budget");
		expect(isContextOverflow(result, model.contextWindow)).toBe(true);
	});

	it("allows requests below the threshold with the full output budget and preserves callbacks", async () => {
		const fetch = fakeFetch();
		const onResponse = vi.fn();
		const onPayload = vi.fn((payload: unknown) => ({ ...(payload as object), user: "unchanged" }));
		const result = await guardedOpenAICompletions(model, contextAt(212990), {
			apiKey: "test", fetch, onResponse, onPayload, temperature: 0.3,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
		expect(body).toMatchObject({ max_tokens: 32768, temperature: 0.3, user: "unchanged" });
		expect(onPayload).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledOnce();
		expect(model.contextWindow).toBe(262144);
	});

	it("honors a smaller explicit budget, including compaction requests", async () => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, contextAt(230000), { apiKey: "test", fetch, maxTokens: 8192 }).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).max_tokens).toBe(8192);
	});

	it.each(["max_tokens", "max_completion_tokens"])("checks a higher %s set by another extension", async (field) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, contextAt(200000), {
			apiKey: "test", fetch, onPayload: (payload) => ({ ...(payload as object), [field]: 60000 }),
		}).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(isContextOverflow(result)).toBe(true);
	});

	it("does not reinterpret an unrelated generic gateway 400", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
			JSON.stringify({ error: { message: "provider api error (status 400)" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		));
		const result = await guardedOpenAICompletions(model, contextAt(100), { apiKey: "test", fetch }).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.errorMessage).toContain("provider api error");
		expect(isContextOverflow(result)).toBe(false);
	});

	it("respects a smaller output budget for summary requests", async () => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, contextAt(220000), {
			apiKey: "test", fetch, maxTokens: 8192,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).max_tokens).toBe(8192);
	});

	it.each([0, -1, Infinity])("leaves unknown context window %s to pi", async (contextWindow) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions({ ...model, contextWindow }, contextAt(100), {
			apiKey: "test", fetch,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("preserves cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await guardedOpenAICompletions(model, contextAt(100), {
			apiKey: "test", signal: controller.signal, fetch: fakeFetch(),
		}).result();
		expect(result.stopReason).toBe("aborted");
	});
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pi integration", () => {
	it.each([true, false])("uses pi's lifecycle with auto-compaction enabled=%s", async (enabled) => {
		const root = mkdtempSync(join(tmpdir(), "pired-context-"));
		roots.push(root);
		const settings = SettingsManager.inMemory({ compaction: { enabled }, retry: { enabled: false } });
		const manager = SessionManager.inMemory(root);
		// A long conversation below pi's default threshold but above the safe
		// input budget when this model's full 32k output is reserved.
		for (let index = 0; index < 11; index++) {
			manager.appendMessage(user("x".repeat(80000), index * 2));
			manager.appendMessage(assistant((index + 1) * 20000, { timestamp: index * 2 + 1 }));
		}
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"), modelsPath: null,
			modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false,
		});
		const fetch = fakeFetch();
		runtime.registerProvider(model.provider, {
			api: model.api, baseUrl: model.baseUrl, apiKey: "test", models: [model],
			streamSimple: (m, context, options) => guardedOpenAICompletions(m, context, { ...options, fetch }),
		});
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root, agentDir: root, model, modelRuntime: runtime, resourceLoader: loader,
			sessionManager: manager, settingsManager: settings, noTools: "all", thinkingLevel: "off",
		});
		const events: string[] = [];
		session.subscribe((event) => { events.push(event.type); });
		try {
			await session.prompt("continue");
			if (enabled) {
				expect(events).toContain("compaction_start");
				expect(manager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
				expect(fetch).toHaveBeenCalledTimes(2); // summary, then the retried answer
				expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			} else {
				expect(events).not.toContain("compaction_start");
				expect(fetch).not.toHaveBeenCalled();
				expect(session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("/compact") });
			}
			expect(settings.getCompactionReserveTokens()).toBe(16384);
			expect(model.contextWindow).toBe(262144);
		} finally {
			session.dispose();
		}
	}, 15000);
});
