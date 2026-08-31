/**
 * Register custom OpenAI-compatible providers (LM Studio, Ollama, …) from
 * ~/.pired/models.json into pi, so they appear in pi's own /model picker.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

	// Make the same providers resolvable to processes that never load this
	// extension — notably pi-subagents' async children. See mirrorProvidersToPi.
	mirrorProvidersToPi(configs);

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

/**
 * Mirror pired's providers into pi's own `~/.pi/agent/models.json`.
 *
 * `registerProvider` only exists inside the process that loaded this extension.
 * pi-subagents spawns async children with extension bindings deliberately
 * stripped (`omitExtensionBindingsEnv`), so a child never loads pired and never
 * sees a provider pired registered. The child then cannot resolve its model,
 * reports `0 turns | 0 tokens | 0 tools`, and a parent that was told to delegate
 * and then block on the fleet waits on it forever — a silent deadlock at ~0% CPU
 * that only an external timeout ends. Two full mlflow scans died this way.
 *
 * pi reads `~/.pi/agent/models.json` natively in *every* process, extension or
 * not, so writing the same providers there makes them resolvable to children.
 *
 * Merges by provider id and preserves everything else in the file: a user's own
 * entries are never touched, and a no-op change never rewrites the file.
 */
export function mirrorProvidersToPi(
	configs: LocalProviderConfig[],
	piModelsPath = join(homedir(), ".pi", "agent", "models.json"),
): void {
	if (configs.length === 0) return;
	try {
		let doc: { providers?: Record<string, unknown> } = {};
		try {
			doc = JSON.parse(readFileSync(piModelsPath, "utf8")) as typeof doc;
		} catch {
			// no file yet, or unreadable — start from empty rather than failing
		}
		const providers = { ...(doc.providers ?? {}) };
		let changed = false;
		for (const cfg of configs) {
			if (!cfg.id || !cfg.baseUrl) continue;
			const entry = {
				baseUrl: cfg.baseUrl,
				api: cfg.api ?? "openai-completions",
				apiKey: cfg.apiKey ?? "local",
				...(cfg.compat ? { compat: cfg.compat } : {}),
				models: cfg.models.map((m) => ({
					id: m.id,
					...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
					...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
					...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
					...(m.compat ? { compat: m.compat } : {}),
				})),
			};
			if (JSON.stringify(providers[cfg.id]) !== JSON.stringify(entry)) {
				providers[cfg.id] = entry;
				changed = true;
			}
		}
		if (!changed) return;
		mkdirSync(dirname(piModelsPath), { recursive: true });
		writeFileSync(piModelsPath, `${JSON.stringify({ ...doc, providers }, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Best effort. A harness that cannot write this file still works in-process;
		// only subagent delegation degrades, and never fatally.
	}
}

/**
 * The API key for a provider, as pired configured it.
 *
 * `pi.registerProvider` hands the key to pi's own request pipeline, but a direct
 * `complete()` call from an extension goes around that pipeline and must supply
 * its own — and pi-ai does NOT throw when it is missing: the call returns a
 * message with stopReason "error", which reads downstream as "the model replied
 * with nothing useful". A whole recording was misdiagnosed that way.
 *
 * Falls back to pi's mirrored copy, then to "local", which is what an
 * unauthenticated LM Studio or Ollama expects.
 */
export function apiKeyForProvider(
	providerId: string,
	paths = [join(homedir(), ".pired", "models.json"), join(homedir(), ".pi", "agent", "models.json")],
): string {
	for (const path of paths) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			const providers = (parsed as { providers?: unknown }).providers;
			// pired's file is an array; pi's mirror is keyed by provider id.
			const list: LocalProviderConfig[] = Array.isArray(providers)
				? (providers as LocalProviderConfig[])
				: Object.entries((providers ?? {}) as Record<string, LocalProviderConfig>)
					.map(([id, cfg]) => ({ ...cfg, id }));
			const hit = list.find((c) => c.id === providerId);
			if (hit?.apiKey) return hit.apiKey;
		} catch { /* try the next location */ }
	}
	return "local";
}
