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

interface LocalProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models: LocalModelDef[];
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
			api: "openai-completions",
			models: cfg.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning ?? false,
				input: m.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow ?? 32768,
				maxTokens: m.maxTokens ?? 8192,
			})),
		});
	}
}
