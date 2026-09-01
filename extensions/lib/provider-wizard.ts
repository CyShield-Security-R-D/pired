/**
 * Add an LLM host from the TUI: base URL, token, models, and the compatibility
 * switches that decide whether a reasoning model answers or silently returns
 * nothing.
 *
 * The flow is written against a four-method prompter rather than against pi's
 * `ctx.ui` so it can be driven by a fake in a test — a wizard whose only
 * verification is running it by hand is a wizard nobody changes afterwards. It
 * touches no files either: it returns the config it built and lets the command
 * decide what to write and what to register.
 */

import type { LocalModelDef, LocalProviderConfig, ProviderCompat } from "./providers.ts";

/** The four dialogs pi gives an extension. `ctx.ui` satisfies this structurally. */
export interface Prompter {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** What a `GET {baseUrl}/models` answer tells us about one model. */
export interface ProbedModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
}

export type ModelProbe = (baseUrl: string, apiKey: string) => Promise<ProbedModel[]>;

/** pired's defaults for a model nothing could be learned about. */
export const DEFAULT_CONTEXT = 32768;
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * pi's extension selector draws every option it is given, with no scrolling and
 * no filter. OpenRouter answers with several hundred models, so past this many
 * the wizard asks for a search string instead of drawing a list off the top of
 * the terminal.
 */
export const MAX_LIST = 20;

/** A host is one entry; nobody is adding a dozen models by hand in one sitting. */
const MAX_MODELS = 12;

export interface HostPreset {
	id: string;
	label: string;
	baseUrl: string;
	apiKey?: string;
	/** The "anything else" branch: asks for the id and the API dialect too. */
	custom?: boolean;
}

/**
 * The hosts pired's own documentation names, with the ports they ship on.
 *
 * A preset is only a set of prefilled answers — every one of them is still
 * shown and editable — but it is the difference between "add a host" and
 * "remember which port LM Studio listens on".
 */
export const HOST_PRESETS: HostPreset[] = [
	{ id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", apiKey: "local" },
	{ id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "local" },
	{ id: "llamacpp", label: "llama.cpp", baseUrl: "http://localhost:8080/v1", apiKey: "local" },
	{ id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", apiKey: "local" },
	{ id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
	{ id: "", label: "Other OpenAI-compatible host", baseUrl: "", custom: true },
];

/** pi's API adapters, as a question an operator can answer. */
const API_DIALECTS: { id: string; label: string }[] = [
	{ id: "openai-completions", label: "openai-completions — LM Studio, Ollama, vLLM, OpenRouter, most gateways" },
	{ id: "anthropic-messages", label: "anthropic-messages — an Anthropic-shaped API or proxy" },
	{ id: "openai-responses", label: "openai-responses — OpenAI's Responses API" },
	{ id: "google-generative-ai", label: "google-generative-ai — Gemini" },
];

/**
 * How a host returns a model's thinking, in pi's own vocabulary.
 *
 * This is the switch documented in docs/models.md as the failure that looks
 * like success: a Qwen served by LM Studio puts its reasoning in
 * `reasoning_content` and leaves `content` empty, so the wrong value here makes
 * the agent print nothing and exit 0.
 */
export const THINKING_FORMATS: { id: string; label: string }[] = [
	{ id: "qwen", label: "qwen — Qwen/QwQ on LM Studio, vLLM, llama.cpp (reasoning_content)" },
	{ id: "openai", label: "openai — reasoning_effort (most hosted APIs)" },
	{ id: "openrouter", label: "openrouter — reasoning: { effort }" },
	{ id: "deepseek", label: "deepseek — thinking: { type }" },
	{ id: "zai", label: "zai — GLM / z.ai" },
	{ id: "together", label: "together — reasoning: { enabled }" },
	{ id: "qwen-chat-template", label: "qwen-chat-template — chat_template_kwargs.enable_thinking" },
	{ id: "chat-template", label: "chat-template — a server with custom template kwargs" },
	{ id: "string-thinking", label: "string-thinking — top-level thinking: string" },
	{ id: "baseten", label: "baseten — chat_template_args" },
	{ id: "ant-ling", label: "ant-ling — Ling/Ring" },
];

/**
 * An address that is on this machine or this network, and therefore almost
 * certainly serving plain HTTP.
 *
 * The reason this is a list of ranges rather than "does it contain a dot": a
 * model server on the engagement box is pired's *primary* case, and it is
 * routinely reached at `192.168.1.20:1234` or `10.0.0.5:8000`. Reading those as
 * public names and assuming `https` produces a probe that cannot connect and a
 * saved provider that never works — and the operator is given no reason why,
 * because from the outside it looks like the server is down.
 */
function isLocalAddress(host: string): boolean {
	// No dot at all: `localhost`, `gpu-box`, `[::1]`, a container name.
	if (!host.includes(".")) return true;
	if (/\.local$/i.test(host)) return true;
	const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!quad) return false;
	const a = Number(quad[1]);
	const b = Number(quad[2]);
	// loopback · this-host · RFC1918 · link-local · carrier-grade NAT
	return a === 127 || a === 0 || a === 10 || (a === 192 && b === 168)
		|| (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Scheme and trailing slash, so `localhost:1234/v1` is a base URL.
 *
 * An address on this box or this network gets `http`, everything else `https`.
 * A scheme that was typed is never second-guessed.
 */
export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	const host = trimmed.split(/[/:]/, 1)[0] ?? "";
	return `${isLocalAddress(host) ? "http" : "https"}://${trimmed}`;
}

/** Whether the scheme was pired's guess rather than the operator's instruction. */
export function schemeWasAssumed(raw: string): boolean {
	return !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim());
}

/**
 * Whether the URL has no path, which is the single most common reason a probe
 * 404s: nearly every OpenAI-compatible server mounts its API under `/v1`.
 */
export function looksMissingVersionPath(baseUrl: string): boolean {
	try {
		const path = new URL(baseUrl).pathname;
		return path === "" || path === "/";
	} catch {
		return false;
	}
}

/** A provider id from the host name: `https://api.openrouter.ai/v1` -> `openrouter`. */
export function suggestProviderId(baseUrl: string): string {
	let host = baseUrl;
	try {
		host = new URL(baseUrl).hostname;
	} catch {
		host = baseUrl.replace(/^[a-z]+:\/\//i, "").split(/[/:]/, 1)[0] ?? baseUrl;
	}
	// An address is not a name, so keep all of it rather than pick a label out.
	const label = /^[0-9.]+$/.test(host)
		? host.replace(/\./g, "-")
		: (host.replace(/^(api|www)\./i, "").split(".")[0] ?? host);
	const slug = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "custom";
}

/** `name`, `name-2`, `name-3` — the first that nothing else has claimed. */
export function uniqueId(base: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; n < 100; n++) {
		if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
	}
	return `${base}-${Date.now()}`;
}

/**
 * A token as it is safe to put on screen.
 *
 * `$VAR` and `!cmd` are references rather than secrets, so they are shown whole
 * — seeing which variable was named is the point of writing one. A real key
 * keeps its last four characters, which is enough to tell two keys apart and
 * not enough to use.
 */
export function maskToken(value: string): string {
	if (!value) return "(none)";
	if (value.startsWith("$") || value.startsWith("!") || value === "local") return value;
	if (value.length <= 8) return "•".repeat(value.length);
	return `${"•".repeat(6)}${value.slice(-4)}`;
}

/** Case-insensitive substring match, capped at what a selector can draw. */
export function filterModelIds(ids: string[], query: string, limit = MAX_LIST): string[] {
	const q = query.trim().toLowerCase();
	const hits = q ? ids.filter((id) => id.toLowerCase().includes(q)) : ids;
	return hits.slice(0, limit);
}

/** The wire format this model most likely speaks, used to order the question. */
export function guessThinkingFormat(modelId: string, baseUrl: string): string {
	const id = modelId.toLowerCase();
	if (/qwen|qwq/.test(id)) return "qwen";
	if (/deepseek/.test(id)) return "deepseek";
	if (/glm|zai/.test(id)) return "zai";
	if (/openrouter\./i.test(baseUrl)) return "openrouter";
	return "openai";
}

/** A positive integer, or undefined for anything else — including "8k". */
export function toPositiveInt(raw: string): number | undefined {
	const n = Number(raw.trim().replace(/[_,]/g, ""));
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Read a `/models` answer.
 *
 * Split out from the request so the shapes can be tested: LM Studio, Ollama,
 * vLLM and OpenRouter all answer `{ data: [...] }` but disagree about where the
 * context length lives, and OpenRouter is the only one that reports an output
 * cap or vision at all. Embedding models are dropped — they appear in the same
 * list and cannot answer a prompt.
 */
export function parseModelList(body: unknown): ProbedModel[] {
	const doc = (body ?? {}) as { data?: unknown; models?: unknown };
	const rows = Array.isArray(doc.data) ? doc.data : Array.isArray(doc.models) ? doc.models : [];
	const out: ProbedModel[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		const r = (row ?? {}) as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : typeof r.name === "string" ? r.name : undefined;
		if (!id || seen.has(id)) continue;
		if (typeof r.type === "string" && /embed/i.test(r.type)) continue;
		seen.add(id);
		const top = (r.top_provider ?? {}) as Record<string, unknown>;
		const arch = (r.architecture ?? {}) as Record<string, unknown>;
		const num = (...vals: unknown[]): number | undefined => {
			for (const v of vals) {
				if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
			}
			return undefined;
		};
		const modalities = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
		// `loaded_context_length` before `max_context_length`: LM Studio reports
		// both, and the model was loaded at the smaller one. Claiming the maximum
		// would build a request the server rejects.
		const context = num(r.context_length, r.loaded_context_length, r.max_context_length, r.context_window, top.context_length);
		out.push({
			id,
			...(context !== undefined ? { contextWindow: context } : {}),
			...(num(top.max_completion_tokens, r.max_output_tokens, r.max_tokens) !== undefined
				? { maxTokens: num(top.max_completion_tokens, r.max_output_tokens, r.max_tokens) }
				: {}),
			...(modalities.includes("image") || r.type === "vlm" ? { vision: true } : {}),
		});
	}
	return out;
}

/**
 * Merge a second listing into the first, by id.
 *
 * An id the richer listing dropped is dropped here too — that is how an
 * embedding model disappears from the OpenAI-shaped list, which does not say
 * which of its entries can hold a conversation.
 */
export function mergeProbes(base: ProbedModel[], richer: ProbedModel[]): ProbedModel[] {
	const byId = new Map(richer.map((m) => [m.id, m]));
	// Only trust it to *remove* entries when it plainly describes the same server.
	if (!base.some((m) => byId.has(m.id))) return base;
	return base.filter((m) => byId.has(m.id)).map((m) => ({ ...m, ...byId.get(m.id) }));
}

/**
 * Ask the host what it serves.
 *
 * Every failure is the caller's to report, not to swallow: "the host did not
 * answer" is the single most useful thing the wizard can say, since it is the
 * same thing that will happen later to the agent.
 *
 * `/v1/models` is the only endpoint every OpenAI-compatible server has, and on
 * LM Studio — the server pired's own documentation opens with — it answers with
 * nothing but ids: no context length, and no way to tell a chat model from an
 * embedding one. Both matter. Defaulting a 262k model to 32k compacts an
 * engagement eight times sooner than it needs to, and an embedding model in the
 * picker is a provider that cannot answer at all. LM Studio's own
 * `/api/v0/models` carries both, so it is asked as well when the first answer
 * is that thin. A server that does not have it simply fails and is ignored.
 */
export async function probeModels(
	baseUrl: string,
	apiKey: string,
	timeoutMs = 5000,
	doFetch: typeof fetch = fetch,
): Promise<ProbedModel[]> {
	const ask = async (url: string): Promise<unknown> => {
		const res = await doFetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
		return res.json();
	};

	const models = parseModelList(await ask(`${baseUrl}/models`));
	if (models.length === 0 || models.some((m) => m.contextWindow !== undefined)) return models;
	try {
		const native = parseModelList(await ask(`${new URL(baseUrl).origin}/api/v0/models`));
		return mergeProbes(models, native);
	} catch {
		// Not LM Studio, or it declined. The ids are still worth having.
		return models;
	}
}

/** One model, as a line: what it is and how it will be driven. */
export function describeModel(m: LocalModelDef & { compat?: { thinkingFormat?: string } }): string {
	const bits = [
		`${(m.contextWindow ?? DEFAULT_CONTEXT).toLocaleString("en-US")} ctx`,
		`${(m.maxTokens ?? DEFAULT_MAX_TOKENS).toLocaleString("en-US")} out`,
	];
	if (m.reasoning) bits.push(`reasoning · ${m.compat?.thinkingFormat ?? "openai"}`);
	if (m.input?.includes("image")) bits.push("vision");
	return `${m.id} — ${bits.join(" · ")}`;
}

/** The whole host, as the lines shown before anything is written. */
export function describeHost(cfg: LocalProviderConfig): string[] {
	return [
		`id         ${cfg.id}`,
		`base URL   ${cfg.baseUrl}`,
		`API        ${cfg.api ?? "openai-completions"}`,
		`token      ${maskToken(cfg.apiKey ?? "local")}`,
		"models",
		...cfg.models.map((m) => `  · ${describeModel(m)}`),
	];
}

export interface AddHostOptions {
	/** Hosts already in pired's file — for id collisions, and for merging. */
	existing: LocalProviderConfig[];
	probe?: ModelProbe;
	/** Shown in the confirmation so the operator knows what is being written where. */
	savedTo?: string;
	/**
	 * Write and register the host. Called once, after the operator confirms and
	 * before they are asked which model to use.
	 *
	 * The order is deliberate. Asking "switch to this?" about something that has
	 * not been saved yet is a lie in the ordinary case, and in the `/login` case
	 * it is the only chance to say what happened at all: pi draws its own
	 * "Logged in to…" status the moment the login flow returns, and that status
	 * replaces an extension's notification in place rather than appearing under
	 * it. Anything the operator must see has to be said while the dialog is
	 * still open.
	 */
	save?: (config: LocalProviderConfig) => void | Promise<void>;
}

export interface AddHostResult {
	config: LocalProviderConfig;
	/** The model the operator asked to switch to, once it is registered. */
	useModelId?: string;
	/** True when this replaced or extended a host that was already configured. */
	updated: boolean;
}

/**
 * Walk the operator through adding a host. Returns undefined if they backed out
 * — at every step, since a wizard you cannot leave is worse than a JSON file.
 */
export async function addHost(ui: Prompter, opts: AddHostOptions): Promise<AddHostResult | undefined> {
	const labels = HOST_PRESETS.map((p) => (p.baseUrl ? `${p.label} — ${p.baseUrl}` : `${p.label}…`));
	const pickedLabel = await ui.select("pired · add a provider", labels);
	if (pickedLabel === undefined) return undefined;
	const preset = HOST_PRESETS[labels.indexOf(pickedLabel)] ?? HOST_PRESETS[HOST_PRESETS.length - 1];
	if (!preset) return undefined;

	const rawUrl = await ui.input(
		preset.baseUrl ? `Base URL — Enter for ${preset.baseUrl}` : "Base URL — e.g. http://localhost:1234/v1",
	);
	if (rawUrl === undefined) return undefined;
	const baseUrl = normalizeBaseUrl(rawUrl || preset.baseUrl);
	if (!baseUrl) {
		ui.notify("pired: no base URL — nothing added", "warning");
		return undefined;
	}

	let api = "openai-completions";
	if (preset.custom) {
		const dialect = await ui.select("Which API does it speak?", API_DIALECTS.map((d) => d.label));
		if (dialect === undefined) return undefined;
		api = API_DIALECTS.find((d) => d.label === dialect)?.id ?? api;
	}

	const rawKey = await ui.input(
		`API token — Enter for "${preset.apiKey ?? "local"}", or $ENV_VAR to keep the key out of the file`,
	);
	if (rawKey === undefined) return undefined;
	const apiKey = rawKey.trim() || preset.apiKey || "local";

	// Ask the host what it serves before asking the operator to type it. This is
	// also the first moment the URL and the token are tested against reality,
	// which is worth more than the list itself.
	let probed: ProbedModel[] = [];
	try {
		probed = await (opts.probe ?? probeModels)(baseUrl, apiKey);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		const hint = looksMissingVersionPath(baseUrl) ? " · most OpenAI-compatible hosts serve under /v1" : "";
		ui.notify(`pired: ${baseUrl}/models did not answer — ${why}${hint}`, "warning");
	}

	const models: (LocalModelDef & { compat?: ProviderCompat })[] = [];
	while (models.length < MAX_MODELS) {
		if (models.length > 0 && !(await ui.confirm("Another model from this host?", models.map((m) => `· ${describeModel(m)}`).join("\n")))) break;
		const chosen = await chooseModelId(ui, probed, new Set(models.map((m) => m.id)));
		if (chosen === undefined) {
			if (models.length === 0) return undefined;
			break;
		}
		models.push(await describeChosenModel(ui, chosen, baseUrl, probed));
	}
	if (models.length === 0) return undefined;

	const taken = new Set(opts.existing.map((p) => p.id));
	let id = preset.id || suggestProviderId(baseUrl);
	if (preset.custom) {
		const suggestion = uniqueId(id, taken);
		const typed = await ui.input(`Provider id — what --provider calls it — Enter for "${suggestion}"`);
		if (typed === undefined) return undefined;
		id = (typed.trim() || suggestion).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
	}

	// An id that is already configured is usually the operator coming back to
	// add a second model to a host they set up last week. Replacing silently
	// would drop the first one, since pi's registerProvider replaces a
	// provider's model list wholesale.
	let merged = models;
	const clash = opts.existing.find((p) => p.id === id);
	if (clash) {
		const ADD = `Add to "${id}" — keep its ${clash.models.length} existing model(s)`;
		const REPLACE = `Replace "${id}" — its existing model(s) are dropped`;
		const RENAME = `Save separately as "${uniqueId(id, taken)}"`;
		const answer = await ui.select(`"${id}" is already configured`, [ADD, REPLACE, RENAME]);
		if (answer === undefined) return undefined;
		if (answer === ADD) {
			const fresh = new Set(models.map((m) => m.id));
			merged = [...clash.models.filter((m) => !fresh.has(m.id)), ...models];
		} else if (answer === RENAME) {
			id = uniqueId(id, taken);
		}
	}

	const config: LocalProviderConfig = {
		id,
		name: preset.custom ? id : preset.label,
		baseUrl,
		apiKey,
		api,
		models: merged,
	};
	const summary = [...describeHost(config), ...(opts.savedTo ? ["", `Saved to ${opts.savedTo}, readable only by you.`] : [])];
	if (!(await ui.confirm(`${clash ? "Update" : "Add"} ${config.name}?`, summary.join("\n")))) {
		ui.notify("pired: nothing written", "info");
		return undefined;
	}

	try {
		await opts.save?.(config);
	} catch (err) {
		ui.notify(`pired: could not save the host — ${err instanceof Error ? err.message : String(err)}`, "error");
		return undefined;
	}

	const saved = `${clash ? "Updated" : "Added"} ${config.id} · ${config.models.length} model(s)`
		+ `${opts.savedTo ? ` in ${opts.savedTo}` : ""}. It is in /model now.`;
	return { config, updated: Boolean(clash), ...(await chooseModelToUse(ui, models, saved)) };
}

/** Pick from what the host reports, search it when it reports hundreds, or type one. */
async function chooseModelId(ui: Prompter, probed: ProbedModel[], already: Set<string>): Promise<string | undefined> {
	const ids = probed.map((p) => p.id).filter((id) => !already.has(id));
	const TYPE_IT = "type an id…";
	if (ids.length > 0 && ids.length <= MAX_LIST) {
		const picked = await ui.select(`Model — ${ids.length} served here`, [...ids, TYPE_IT]);
		if (picked === undefined) return undefined;
		if (picked !== TYPE_IT) return picked;
	} else if (ids.length > MAX_LIST) {
		// Drawing 300 options would scroll the terminal past the question, so the
		// list becomes a search: type part of a name, pick from what matches.
		const query = await ui.input(`Model — ${ids.length} served here; type part of a name to search`);
		if (query === undefined) return undefined;
		const hits = filterModelIds(ids, query);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) {
			const AS_TYPED = `use "${query.trim()}" as typed`;
			const picked = await ui.select(`${hits.length} match "${query.trim()}"`, [...hits, AS_TYPED]);
			if (picked === undefined) return undefined;
			return picked === AS_TYPED ? query.trim() : picked;
		}
		ui.notify(`pired: nothing here matches "${query.trim()}"`, "warning");
	}
	const typed = await ui.input("Model id — exactly as the host names it");
	if (typed === undefined) return undefined;
	const id = typed.trim();
	if (!id) {
		ui.notify("pired: no model id — nothing added", "warning");
		return undefined;
	}
	return id;
}

/** Fill in what the probe could not: size, and how thinking comes back. */
async function describeChosenModel(
	ui: Prompter,
	id: string,
	baseUrl: string,
	probed: ProbedModel[],
): Promise<LocalModelDef & { compat?: { thinkingFormat: string } }> {
	const hit = probed.find((p) => p.id === id);
	// Esc on these two is "take the default", not "abandon the host": they are
	// the questions an operator is least likely to have an answer to, and the
	// file is editable afterwards.
	let contextWindow = hit?.contextWindow;
	if (contextWindow === undefined) {
		const raw = await ui.input(`Context window for ${id}, in tokens — Enter for ${DEFAULT_CONTEXT}`);
		contextWindow = toPositiveInt(raw ?? "") ?? DEFAULT_CONTEXT;
	}
	let maxTokens = hit?.maxTokens;
	if (maxTokens === undefined) {
		const raw = await ui.input(`Most output tokens per reply for ${id} — Enter for ${DEFAULT_MAX_TOKENS}`);
		maxTokens = toPositiveInt(raw ?? "") ?? DEFAULT_MAX_TOKENS;
	}

	const reasoning = await ui.confirm(
		`Does ${id} think before it answers?`,
		"A reasoning model returns its thinking in a format that has to be declared.\nGet it wrong and the model replies with nothing at all, successfully.",
	);
	let compat: { thinkingFormat: string } | undefined;
	if (reasoning) {
		const guess = guessThinkingFormat(id, baseUrl);
		const ordered = [...THINKING_FORMATS].sort((a, b) => Number(b.id === guess) - Number(a.id === guess));
		const picked = await ui.select(`How ${id} returns its thinking`, ordered.map((f) => f.label));
		compat = { thinkingFormat: THINKING_FORMATS.find((f) => f.label === picked)?.id ?? guess };
	}

	return {
		id,
		contextWindow,
		maxTokens,
		reasoning,
		...(hit?.vision ? { input: ["text", "image"] as ("text" | "image")[] } : {}),
		...(compat ? { compat } : {}),
	};
}

/**
 * Offer to switch to what was just added, since that is why it was added.
 *
 * `saved` rides along as this question's body: it is the last thing drawn
 * before the flow ends, and in `/login` it is the only account of the outcome
 * that survives.
 */
async function chooseModelToUse(ui: Prompter, models: LocalModelDef[], saved: string): Promise<{ useModelId?: string }> {
	const first = models[0];
	if (!first) return {};
	if (models.length === 1) {
		return (await ui.confirm(`Switch to ${first.id} now?`, saved)) ? { useModelId: first.id } : {};
	}
	const NOT_NOW = "not now";
	const picked = await ui.select(`Switch to which one?\n${saved}`, [...models.map((m) => m.id), NOT_NOW]);
	return picked && picked !== NOT_NOW ? { useModelId: picked } : {};
}
