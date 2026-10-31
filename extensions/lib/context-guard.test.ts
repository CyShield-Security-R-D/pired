import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isContextOverflow, normalizeContext, type AssistantMessage, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	boundMessageTokens, contextSafetyMargin, estimateInputTokens, guardedOpenAICompletions, guardedOpenAIResponses,
} from "./context-guard.ts";

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
const toolResult = (text: string) => ({
	role: "toolResult" as const, toolCallId: "1", toolName: "bash",
	content: [{ type: "text" as const, text }], isError: false, timestamp: 2,
});
/**
 * Scanner-like output in the shape of the measured sample: hex dumps, hashed
 * tokens in URLs, minified JS. Through Bifrost to SGLang, each 48,002 bytes of
 * it added 34,072–34,764 tokens; chars/4 puts it at 12,000.
 */
const denseOutput = (bytes: number): string => {
	const lines = ["654dea51: c7f2 481f acdf ee60 12c1 29c6 7b37 26f6",
		"GET /api/v3/items/37457?token=06387c1f58715c2316a72a9c5c01e3107c02cfc7 200 9431",
		"var f_lziz=function(e,t){return e[470]^t<<16};"];
	let text = "";
	for (let index = 0; text.length < bytes; index++) text += lines[index % lines.length] + "\n";
	return text.slice(0, bytes);
};
const contextAt = (tokens: number): Context => ({ messages: [assistant(tokens), user()] });
/** The most a `contextAt` anchor can be and still leave the full 32k output plus the 16k margin. */
const lastFit = model.contextWindow - model.maxTokens - contextSafetyMargin(model.contextWindow) - boundMessageTokens(user()) - 1;
/** What pi >= 0.86 hands a provider stream: the prompt and tools live in system messages. */
const transcriptAt = (tokens: number) => normalizeContext(contextAt(tokens));
const completion = (text = "ok") => new Response([
	{ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
	{ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
].map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n",
{ headers: { "Content-Type": "text/event-stream" } });
const fakeFetch = () => vi.fn<typeof fetch>(async () => completion());

describe("input budget", () => {
	it("uses server usage (including cached tokens) plus a bound on new tool output", () => {
		const last = assistant(210000);
		last.usage = { ...last.usage, input: 10000, cacheRead: 200000, totalTokens: 0 };
		const output = toolResult("x".repeat(20000));
		expect(estimateInputTokens(model, { messages: [last, output] })).toBe(210000 + boundMessageTokens(output));
	});

	it("never counts new output below its UTF-8 size, which dense scanner output approaches", () => {
		// The shipped estimate charged chars/4. On the measured sample that is
		// 12,000 tokens for output SGLang counted at up to 34,764, so pi sent a request
		// past the window while reporting 84% full.
		const dense = toolResult(denseOutput(48002));
		expect(boundMessageTokens(dense)).toBeGreaterThan(48002);
		// JSON writes each newline as two bytes; the bound stays an upper bound.
		expect(boundMessageTokens(dense)).toBeLessThan(48002 * 1.03);
		// Multi-byte text is bounded by bytes, not characters.
		expect(boundMessageTokens(toolResult("ü".repeat(1000)))).toBeGreaterThanOrEqual(2000);
	});

	it("charges an image as pi does, not by its base64 length", () => {
		const image = { ...user(), content: [{ type: "image" as const, mimeType: "image/png", data: "A".repeat(1_000_000) }] };
		expect(boundMessageTokens(image)).toBeLessThan(2000);
	});

	it("estimates an unanchored context instead of bounding it, so a summary request fits", () => {
		// A real compaction summary request: 363,803 characters, which SGLang
		// counted at 92,438 tokens. Charged by bytes it would exceed the window
		// and the guard would refuse the very request meant to make room.
		expect(estimateInputTokens(model, { messages: [user("x".repeat(363803))] })).toBe(Math.ceil(363803 / 4));
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
		const loaded = {
			role: "toolResult" as const, toolCallId: "1", toolName: "load", content: [], isError: false, timestamp: 2,
			// pi <= 0.85 named a mid-conversation tool on the tool result that loaded it.
			...({ addedToolNames: ["new"] } as object),
		};
		expect(estimateInputTokens(model, { systemPrompt: "already counted", tools, messages: [assistant(100), loaded] }))
			.toBe(100 + boundMessageTokens(loaded) + Math.ceil(JSON.stringify(tools).length / 4));
	});

	it("counts a transcript's system prompt and tools once, from its system messages", () => {
		// pi 0.86 moved both into the transcript; counting them again from the
		// legacy fields would double the unanchored estimate.
		const tools = [{ name: "read", description: "read", parameters: { type: "object" } }] as Tool[];
		const transcript = normalizeContext({ systemPrompt: "x".repeat(400), tools, messages: [user("x".repeat(400))] });
		expect(transcript.messages[0]!.role).toBe("system");
		expect(estimateInputTokens(model, transcript)).toBe(200 + Math.ceil(JSON.stringify(tools).length / 4));
	});

	it("scales the margin for small windows", () => {
		expect(contextSafetyMargin(262144)).toBe(16384);
		expect(contextSafetyMargin(32768)).toBe(2048);
		expect(contextSafetyMargin(8192)).toBe(512);
	});
});

describe("OpenAI-compatible context guard", () => {
	it.each([lastFit + 1, 230000, 245000])("blocks %i input tokens before HTTP and emits an overflow pi recognizes", async (tokens) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, transcriptAt(tokens), { apiKey: "test", fetch }).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("pired's safe context budget");
		expect(isContextOverflow(result, model.contextWindow)).toBe(true);
	});

	it("blocks a request whose dense new output chars/4 would have let through", async () => {
		// 200,000 anchored + 12,001 estimated + 32,768 + 16,384 fits under 262,144,
		// so the shipped guard sent it; SGLang would count the output near 34,500
		// tokens and Bifrost would answer with an opaque 400 pi cannot act on.
		const fetch = fakeFetch();
		const context = normalizeContext({ messages: [assistant(200000), toolResult(denseOutput(48002))] });
		const result = await guardedOpenAICompletions(model, context, { apiKey: "test", fetch }).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(isContextOverflow(result, model.contextWindow)).toBe(true);
	});

	it("allows requests below the threshold with the full output budget and preserves callbacks", async () => {
		const fetch = fakeFetch();
		const onResponse = vi.fn();
		const onPayload = vi.fn((payload: unknown) => ({ ...(payload as object), user: "unchanged" }));
		const result = await guardedOpenAICompletions(model, transcriptAt(lastFit), {
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
		const result = await guardedOpenAICompletions(model, transcriptAt(230000), { apiKey: "test", fetch, maxTokens: 8192 }).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).max_tokens).toBe(8192);
	});

	it.each(["max_tokens", "max_completion_tokens"])("checks a higher %s set by another extension", async (field) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, transcriptAt(200000), {
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
		const result = await guardedOpenAICompletions(model, transcriptAt(100), { apiKey: "test", fetch }).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.errorMessage).toContain("provider api error");
		expect(isContextOverflow(result)).toBe(false);
	});

	it("respects a smaller output budget for summary requests", async () => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, transcriptAt(220000), {
			apiKey: "test", fetch, maxTokens: 8192,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).max_tokens).toBe(8192);
	});

	it.each([0, -1, Infinity])("leaves unknown context window %s to pi", async (contextWindow) => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions({ ...model, contextWindow }, transcriptAt(100), {
			apiKey: "test", fetch,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("preserves cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await guardedOpenAICompletions(model, transcriptAt(100), {
			apiKey: "test", signal: controller.signal, fetch: fakeFetch(),
		}).result();
		expect(result.stopReason).toBe("aborted");
	});

	it("lets a request through when only a summary precedes it, however long the summary", async () => {
		const fetch = fakeFetch();
		const result = await guardedOpenAICompletions(model, normalizeContext({ messages: [user("x".repeat(363803))] }), {
			apiKey: "test", fetch,
		}).result();
		expect(fetch).toHaveBeenCalledOnce();
		expect(result.stopReason).toBe("stop");
	});
});

const responsesModel: Model<"openai-responses"> = { ...model, api: "openai-responses", compat: {} };
const responsesCompleted = () => new Response("event: response.completed\ndata: " + JSON.stringify({
	type: "response.completed",
	response: { id: "test", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } },
}) + "\n\n", { headers: { "Content-Type": "text/event-stream" } });

describe("Responses API context guard", () => {
	// Bifrost forwards SGLang's overflow text on a buffered /v1/responses call,
	// but on the stream pi reads it sends `response.failed` with an empty message.
	it.each([lastFit + 1, 245000])("blocks %i input tokens before HTTP and emits an overflow pi recognizes", async (tokens) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responsesCompleted());
		const result = await guardedOpenAIResponses(responsesModel, normalizeContext(contextAt(tokens)), { apiKey: "test", fetch }).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(isContextOverflow(result, responsesModel.contextWindow)).toBe(true);
	});

	it("sends a request below the threshold with the full output budget", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responsesCompleted());
		const result = await guardedOpenAIResponses(responsesModel, normalizeContext(contextAt(lastFit)), { apiKey: "test", fetch }).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).max_output_tokens).toBe(32768);
	});

	it("checks a higher max_output_tokens set by another extension", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responsesCompleted());
		const result = await guardedOpenAIResponses(responsesModel, normalizeContext(contextAt(200000)), {
			apiKey: "test", fetch, onPayload: (payload) => ({ ...(payload as object), max_output_tokens: 60000 }),
		}).result();
		expect(fetch).not.toHaveBeenCalled();
		expect(isContextOverflow(result)).toBe(true);
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
