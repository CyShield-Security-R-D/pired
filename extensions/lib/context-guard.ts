/** Reserve output headroom before a gateway can hide an overflow behind a generic 400. */
import type { Context, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
// pi aliases the package root to a file when loading extensions. Deep imports
// beneath that root fail in installed packages without our dev dependencies.
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";

type Stream = ReturnType<typeof openAICompletionsApi>["streamSimple"];
const textTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Anchor to server usage, then estimate the new messages. A newly inserted
 * summary invalidates older usage; another model's tokenizer cannot anchor it.
 * This is an estimate, not SGLang's tokenizer; the budget leaves room for error.
 */
export function estimateInputTokens(model: Model<Api>, context: Context): number {
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
	for (const message of trailing) tokens += estimateTokens(message);
	const addedTools = new Set(trailing.flatMap((message) => message.role === "toolResult" ? message.addedToolNames ?? [] : []));
	const tools = usageIndex < 0 ? context.tools : context.tools?.filter((tool) => addedTools.has(tool.name));
	if (tools?.length) tokens += textTokens(JSON.stringify(tools));
	if (usageIndex < 0 && context.systemPrompt) tokens += textTokens(context.systemPrompt);
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
	return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => stream(model, context, {
		...options,
		onPayload: async (payload, requestModel) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			const request = replacement === undefined ? payload : replacement;
			if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) return request;
			const fields = request as { max_tokens?: number; max_completion_tokens?: number } | null;
			// Budget the desired output even if pi already clamped the wire value.
			// Also honor a higher limit supplied by another payload extension.
			const output = Math.max(options?.maxTokens ?? model.maxTokens,
				fields?.max_tokens ?? 0, fields?.max_completion_tokens ?? 0);
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
