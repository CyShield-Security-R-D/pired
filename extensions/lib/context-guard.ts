/** Reserve output headroom before a gateway can hide an overflow behind a generic 400. */
import type { Context, Model, Api, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
// pi aliases the package root to a file when loading extensions. Deep imports
// beneath that root fail in installed packages without our dev dependencies.
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

type Stream = ReturnType<typeof openAICompletionsApi>["streamSimple"];
/**
 * pi 0.86 moved the system prompt and tool declarations into the transcript's
 * system messages (`TranscriptContext`); pi 0.85 and earlier still pass them
 * beside the messages. The guard runs under both, because the operator's pi is
 * whatever their install left them with.
 */
type AnyContext = Context | TranscriptContext;
type AnyMessage = AnyContext["messages"][number];
const textTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * At most what the server can count for a message it has not seen yet.
 *
 * A byte-level BPE token never covers less than one byte, so the serialized
 * size bounds the count where chars/4 only guesses at it. Through Bifrost to
 * SGLang, a 48,002-byte file of scanner-like output (hex dumps, hashed tokens,
 * minified JS) added up to 34,764 tokens against chars/4's 12,000, and pi sent
 * a request past the window while its footer read 84%. An image is charged as
 * pi charges one: its base64 length says nothing about its tokens.
 */
export function boundMessageTokens(message: AnyMessage): number {
	let images = 0;
	const text = JSON.stringify(message, (_key, value: unknown) => {
		if ((value as { type?: unknown } | null)?.type === "image") {
			images += estimateTokens({ role: "user", content: [value], timestamp: 0 } as Parameters<typeof estimateTokens>[0]);
			return undefined;
		}
		return value;
	});
	return Buffer.byteLength(text, "utf8") + images;
}

/**
 * Anchor to server usage, then bound the new messages. A newly inserted
 * summary invalidates older usage; another model's tokenizer cannot anchor it.
 *
 * Only an anchored context is bounded. Without an anchor — a first request,
 * the first after a summary, or the summary request itself — every message
 * would be charged its bytes, and a 363,803-character summary request that
 * SGLang counted at 92,438 tokens would be refused for its own size. Those are
 * estimated, as pi estimates them.
 */
export function estimateInputTokens(model: Model<Api>, context: AnyContext): number {
	let prefixTimestamp = -Infinity;
	let usageIndex = -1;
	let tokens = 0;
	for (const [index, message] of context.messages.entries()) {
		if (message.role === "assistant" && message.provider === model.provider && message.model === model.id
			&& message.timestamp >= prefixTimestamp && message.stopReason !== "error" && message.stopReason !== "aborted") {
			const usage = calculateContextTokens(message.usage);
			if (usage > 0) {
				tokens = usage;
				usageIndex = index;
			}
		}
		prefixTimestamp = Math.max(prefixTimestamp, message.timestamp);
	}
	const trailing = context.messages.slice(usageIndex + 1);
	// A transcript's system messages are messages: both counts cover their
	// prompt text and toolsAdded, so nothing below applies to them.
	const count = usageIndex < 0 ? estimateTokens : boundMessageTokens;
	for (const message of trailing) tokens += count(message);
	const legacy = context as Partial<Context>;
	if (legacy.systemPrompt === undefined && legacy.tools === undefined) return tokens;
	// pi <= 0.85: prompt and tools ride beside the messages, and a tool added
	// mid-conversation is named on the tool result that introduced it.
	const addedTools = new Set(trailing.flatMap((message) => message.role === "toolResult"
		? (message as { addedToolNames?: string[] }).addedToolNames ?? [] : []));
	const tools = usageIndex < 0 ? legacy.tools : legacy.tools?.filter((tool) => addedTools.has(tool.name));
	if (tools?.length) tokens += textTokens(JSON.stringify(tools));
	if (usageIndex < 0 && legacy.systemPrompt) tokens += textTokens(legacy.systemPrompt);
	return tokens;
}

/** Scale down for small models; a 256k window gets 16k beyond its output budget. */
export function contextSafetyMargin(contextWindow: number): number {
	return Math.min(16384, Math.max(1, Math.floor(contextWindow / 16)));
}

/**
 * Keep the normal adapter's auth, compatibility flags and callbacks. Throw from
 * its payload callback so pi receives an error stream and owns compact-and-retry.
 * Calling ctx.compact() during a running turn instead aborts it and can deadlock.
 */
export function withContextGuard(stream: Stream): Stream {
	return (model: Model<Api>, context: Parameters<Stream>[1], options?: SimpleStreamOptions) => stream(model, context, {
		...options,
		onPayload: async (payload, requestModel) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			const request = replacement === undefined ? payload : replacement;
			if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return request;
			const fields = request as { max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number } | null;
			// Budget the desired output even if pi already clamped the wire value.
			// Also honor a higher limit supplied by another payload extension.
			const output = Math.max(options?.maxTokens ?? model.maxTokens,
				fields?.max_tokens ?? 0, fields?.max_completion_tokens ?? 0, fields?.max_output_tokens ?? 0);
			if (!Number.isSafeInteger(output) || output <= 0) return request;
			const input = estimateInputTokens(model, context);
			const margin = contextSafetyMargin(model.contextWindow);
			if (input + output + margin >= model.contextWindow) {
				throw new Error("context_length_exceeded: pired's safe context budget needs compaction ("
					+ input + " estimated input + " + output + " output + " + margin + " safety tokens; "
					+ model.contextWindow + " context window). Enable pi auto-compaction or run /compact; "
					+ "if this persists, reduce the input or output limit. No request was sent to the provider.");
			}
			return request;
		},
	});
}

export const guardedOpenAICompletions = withContextGuard(openAICompletionsApi().streamSimple);
/**
 * The Responses API needs the same guard. Bifrost passes SGLang's overflow
 * text through on a buffered response, but on the stream pi reads it sends
 * `response.failed` with an empty message, which pi cannot tell from any other
 * failure — so it never compacts.
 */
export const guardedOpenAIResponses = withContextGuard(openAIResponsesApi().streamSimple);
