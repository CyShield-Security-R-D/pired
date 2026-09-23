/**
 * Register custom OpenAI-compatible providers (LM Studio, Ollama, …) from
 * ~/.pired/models.json into pi, so they appear in pi's own /model picker.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardedOpenAICompletions } from "./context-guard.ts";

/** pi's own provider-config shape, taken from the API rather than restated. */
export type PiProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

export interface LocalModelDef {
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
export interface ProviderCompat {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	thinkingFormat?: string;
	[key: string]: unknown;
}

export interface LocalProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	apiKey?: string;
	api?: string;
	compat?: ProviderCompat;
	/** Guard OpenAI-compatible requests before sending; enabled unless explicitly false. */
	contextGuard?: boolean;
	models: (LocalModelDef & { compat?: ProviderCompat })[];
}

export function registerPiredProviders(pi: ExtensionAPI, path = piredModelsPath()): void {
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
		pi.registerProvider(cfg.id, toPiProvider(cfg));
	}
}

/**
 * pired's config shape as pi's `registerProvider` wants it.
 *
 * Shared with the `/provider` command, which registers a host the operator has
 * just added without waiting for a restart. Two mappings would mean a host
 * added mid-session could behave differently from the same host after a
 * restart, and the difference would show up as a model that answers today and
 * silently returns nothing tomorrow.
 */
export function toPiProvider(cfg: LocalProviderConfig): PiProviderConfig {
	return {
		name: cfg.name ?? cfg.id,
		baseUrl: cfg.baseUrl,
		apiKey: cfg.apiKey ?? "local",
		api: cfg.api ?? "openai-completions",
		...((cfg.api ?? "openai-completions") === "openai-completions" && cfg.contextGuard !== false
			? { streamSimple: guardedOpenAICompletions } : {}),
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
	};
}

/**
 * Mirror pired's providers into pi's own `~/.pi/agent/models.json`.
 *
 * `registerProvider` only exists inside the process that loaded this extension.
 * pired's own delegation children need nothing from this file: they are
 * in-process foreground pi sessions (ADR-027) and see the providers pired
 * registered. The mirror is for a *separate* pi process — a bare `pi` the
 * operator starts, or pi-subagents' out-of-process external/background runners —
 * which never loaded pired and would otherwise fail to resolve a pired-only
 * provider. (An earlier note here blamed `omitExtensionBindingsEnv` for
 * "stripping" a child's access; that reads one metadata env var's removal as
 * whole-extension isolation. See ADR-027 for the correction. The measured
 * `0 turns | 0 tokens | 0 tools` deadlock was an out-of-process child that could
 * not resolve its model, and the mirror is what fixes exactly that case.)
 *
 * pi reads `~/.pi/agent/models.json` natively in *every* process, extension or
 * not, so writing the same providers there makes them resolvable out of process.
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
			if (hit?.apiKey) return resolveKeyRef(hit.apiKey);
		} catch { /* try the next location */ }
	}
	return "local";
}

/**
 * Resolve a `$VAR` / `${VAR}` reference in a configured key.
 *
 * pi resolves these itself in its request pipeline, so a host whose key is
 * `$OPENROUTER_KEY` works in the picker. A direct `complete()` from an
 * extension goes around that pipeline, and would otherwise send the seven
 * characters `$OPENR…` as the bearer token — a 401 the operator reads as "the
 * extraction pass is broken" rather than "the variable is not exported".
 *
 * An unset variable is left as written rather than blanked: the reference then
 * appears in the provider's own error, which is the one thing that names the
 * cause. `!command` keys are pi's and are passed through untouched — pired does
 * not run commands out of a config file.
 */
export function resolveKeyRef(value: string, env: NodeJS.ProcessEnv = process.env): string {
	if (value.startsWith("!")) return value;
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, bare?: string) => {
		const name = braced ?? bare ?? "";
		return env[name] ?? whole;
	});
}

/**
 * Where pired keeps the hosts it contributes to pi's picker.
 *
 * A function rather than a constant, for the same reason every other path here
 * is resolved per call: the home directory is read when the file is touched,
 * not when the module happens to be imported.
 */
export function piredModelsPath(): string {
	return join(homedir(), ".pired", "models.json");
}

/**
 * The hosts in pired's own file, and whatever else that file holds.
 *
 * Read and write are a pair: `/provider` edits one entry of a file the operator
 * may also have hand-written, so everything outside `providers` is carried
 * through untouched rather than rewritten from pired's model of it.
 */
export function readProviderFile(path = piredModelsPath()): { providers: LocalProviderConfig[]; rest: Record<string, unknown> } {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const { providers, ...rest } = parsed ?? {};
		return { providers: Array.isArray(providers) ? (providers as LocalProviderConfig[]) : [], rest };
	} catch {
		// Missing or malformed: the same silence registerPiredProviders keeps. A
		// caller that then writes replaces a file nobody could read anyway, and
		// `/provider` shows what it will write before it writes it.
		return { providers: [], rest: {} };
	}
}

/**
 * Write pired's file back, with the permissions a file holding tokens deserves.
 *
 * The mode argument to writeFileSync only applies when the file is created, so
 * an existing 0644 file — one written by hand, or by an older pired — stays
 * world-readable unless it is chmod'd explicitly. On a consultant's box that
 * file can hold a client's API token.
 */
export function writeProviderFile(
	providers: LocalProviderConfig[],
	path = piredModelsPath(),
	rest: Record<string, unknown> = {},
): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...rest, providers }, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Windows, or a file we do not own. The content is written either way.
	}
}

/** Replace the entry with this id, or append it. Order is otherwise preserved. */
export function upsertProvider(providers: LocalProviderConfig[], cfg: LocalProviderConfig): LocalProviderConfig[] {
	const at = providers.findIndex((p) => p.id === cfg.id);
	if (at < 0) return [...providers, cfg];
	return providers.map((p, i) => (i === at ? cfg : p));
}

/** Drop the entry with this id. */
export function removeProvider(providers: LocalProviderConfig[], id: string): LocalProviderConfig[] {
	return providers.filter((p) => p.id !== id);
}

/**
 * Drop a mirrored host from pi's own file too.
 *
 * Without this, removing a host in pired leaves it resolvable to every
 * extension-less pi process — including the subagent children mirrorProvidersToPi
 * exists for — so `/model` would keep offering a host the operator deleted.
 * Only ids pired mirrored are touched; anything else in the file is left alone.
 */
export function removeProviderFromPi(id: string, piModelsPath = join(homedir(), ".pi", "agent", "models.json")): void {
	try {
		const doc = JSON.parse(readFileSync(piModelsPath, "utf8")) as { providers?: Record<string, unknown> };
		if (!doc?.providers || !(id in doc.providers)) return;
		const { [id]: _dropped, ...kept } = doc.providers;
		writeFileSync(piModelsPath, `${JSON.stringify({ ...doc, providers: kept }, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Same best-effort contract as the mirror itself.
	}
}
