/**
 * Register custom OpenAI-compatible providers (LM Studio, Ollama, …) from
 * ~/.pired/models.json into pi, so they appear in pi's own /model picker.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LocalModelDef {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: ("text" | "image")[];
}

/**
 * Provider-level compatibility switches. Dropping these silently breaks
 * reasoning models: a qwen served by LM Studio returns its thinking in
 * `reasoning_content` and leaves `content` empty, so without
 * `thinkingFormat: "qwen"` the agent receives an empty message, prints nothing
 * and exits 0 — a total failure that looks like a successful no-op run.
 */
interface ProviderCompat {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	thinkingFormat?: string;
	[key: string]: unknown;
}

interface LocalProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	api?: string;
	compat?: ProviderCompat;
	models: (LocalModelDef & { compat?: ProviderCompat })[];
}

export function registerPiredProviders(pi: ExtensionAPI, path = join(homedir(), ".pired", "models.json")): void {
	let configs: LocalProviderConfig[] = [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const providers = (parsed as { providers?: unknown }).providers;
		if (Array.isArray(providers)) configs = providers as LocalProviderConfig[];
	} catch {
		return;
	}

	for (const cfg of configs) {
		if (!cfg.id || !cfg.baseUrl) continue;
		pi.registerProvider(cfg.id, {
			name: cfg.name ?? cfg.id,
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey ?? "local",
			api: cfg.api ?? "openai-completions",
			// Pass compat through at both levels. It is optional in the config and
			// absent for most providers, but for a reasoning model it is the
			// difference between working and silently producing nothing.
			...(cfg.compat ? { compat: cfg.compat } : {}),
			models: cfg.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				input: m.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 32768,
				maxTokens: m.maxTokens ?? 8192,
				...(m.compat ?? cfg.compat ? { compat: m.compat ?? cfg.compat } : {}),
			})),
		});
	}
}
