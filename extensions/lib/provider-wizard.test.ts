import { describe, expect, it } from "vitest";
import {
	addHost, describeHost, filterModelIds, guessThinkingFormat, looksMissingVersionPath, maskToken,
	mergeProbes, normalizeBaseUrl, parseModelList, probeModels, type ProbedModel, type Prompter, suggestProviderId,
	THINKING_FORMATS, toPositiveInt, uniqueId,
} from "./provider-wizard.ts";
import type { LocalProviderConfig } from "./providers.ts";

/**
 * A prompter that answers a scripted transcript.
 *
 * Each step asserts what it was asked before answering, so a test reads as the
 * dialogue the operator sees — and a step inserted into the middle of the flow
 * fails the test that documents the flow rather than passing quietly.
 */
type Step = [match: string, answer: string | boolean | undefined];

function scripted(steps: Step[]): Prompter & { notes: string[]; remaining: () => number } {
	let at = 0;
	const notes: string[] = [];
	const next = (kind: string, title: string): string | boolean | undefined => {
		const step = steps[at++];
		if (!step) throw new Error(`unscripted ${kind}: ${title}`);
		expect(title, `step ${at}`).toContain(step[0]);
		return step[1];
	};
	return {
		select: async (title) => next("select", title) as string | undefined,
		input: async (title) => next("input", title) as string | undefined,
		confirm: async (title) => next("confirm", title) as boolean,
		notify: (message) => void notes.push(message),
		notes,
		remaining: () => steps.length - at,
	};
}

const qwenFormat = THINKING_FORMATS.find((f) => f.id === "qwen")?.label ?? "qwen";
const noProbe = async (): Promise<ProbedModel[]> => [];

describe("normalizeBaseUrl", () => {
	it("leaves a complete URL alone but drops the trailing slash", () => {
		expect(normalizeBaseUrl(" https://openrouter.ai/api/v1/ ")).toBe("https://openrouter.ai/api/v1");
	});

	it("assumes http for a host on the engagement box and https for the internet", () => {
		expect(normalizeBaseUrl("localhost:1234/v1")).toBe("http://localhost:1234/v1");
		expect(normalizeBaseUrl("gpu-box:8000/v1")).toBe("http://gpu-box:8000/v1");
		expect(normalizeBaseUrl("127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/v1");
		expect(normalizeBaseUrl("api.corp.example.com/v1")).toBe("https://api.corp.example.com/v1");
	});

	/**
	 * The model server on the LAN is pired's primary case and its address has
	 * dots in it. Reading `192.168.1.15:1234` as a public name and assuming
	 * TLS produces a probe that cannot connect and a saved provider that never
	 * works, with nothing on screen to say why.
	 */
	it("assumes http for every address that is on this network", () => {
		for (const host of ["192.168.1.15:1234/v1", "10.0.0.5:8000/v1", "172.16.4.4:1234/v1",
			"172.31.255.1:1234/v1", "169.254.7.7:1234/v1", "100.64.0.3:1234/v1", "gpu.local:1234/v1"]) {
			expect(normalizeBaseUrl(host), host).toBe(`http://${host}`);
		}
	});

	it("still assumes https for a public address that only looks numeric", () => {
		expect(normalizeBaseUrl("8.8.8.8:1234/v1")).toBe("https://8.8.8.8:1234/v1");
		expect(normalizeBaseUrl("172.32.0.1:1234/v1")).toBe("https://172.32.0.1:1234/v1");
	});

	it("never second-guesses a scheme that was typed", () => {
		expect(normalizeBaseUrl("http://api.openrouter.ai/v1")).toBe("http://api.openrouter.ai/v1");
		expect(normalizeBaseUrl("https://192.168.1.5/v1")).toBe("https://192.168.1.5/v1");
	});

	it("is empty for nothing typed", () => {
		expect(normalizeBaseUrl("   ")).toBe("");
	});
});

describe("looksMissingVersionPath", () => {
	it("spots the base URL that will 404, which is the one with no path", () => {
		expect(looksMissingVersionPath("http://localhost:1234")).toBe(true);
		expect(looksMissingVersionPath("http://localhost:1234/")).toBe(true);
		expect(looksMissingVersionPath("http://localhost:1234/v1")).toBe(false);
		expect(looksMissingVersionPath("not a url")).toBe(false);
	});
});

describe("suggestProviderId", () => {
	it("names a host after itself", () => {
		expect(suggestProviderId("https://api.openrouter.ai/v1")).toBe("openrouter");
		expect(suggestProviderId("http://localhost:1234/v1")).toBe("localhost");
		expect(suggestProviderId("http://192.168.1.5:8000/v1")).toBe("192-168-1-5");
	});

	it("falls back to something usable when the URL is not one", () => {
		expect(suggestProviderId("!!!")).toBe("custom");
	});
});

describe("uniqueId", () => {
	it("suffixes only when it has to", () => {
		expect(uniqueId("lmstudio", [])).toBe("lmstudio");
		expect(uniqueId("lmstudio", ["lmstudio"])).toBe("lmstudio-2");
		expect(uniqueId("lmstudio", ["lmstudio", "lmstudio-2"])).toBe("lmstudio-3");
	});
});

describe("maskToken", () => {
	it("shows a reference whole and a secret barely", () => {
		expect(maskToken("$OPENROUTER_KEY")).toBe("$OPENROUTER_KEY");
		expect(maskToken("local")).toBe("local");
		expect(maskToken("sk-or-v1-0123456789abcdef")).toBe("••••••cdef");
		expect(maskToken("short")).toBe("•••••");
		expect(maskToken("")).toBe("(none)");
	});
});

describe("filterModelIds", () => {
	it("matches anywhere in the id, case-insensitively, and caps the list", () => {
		const ids = ["qwen/qwen3-27b", "meta/llama-4", "QWEN/qwen3-4b"];
		expect(filterModelIds(ids, "qwen3")).toEqual(["qwen/qwen3-27b", "QWEN/qwen3-4b"]);
		expect(filterModelIds(ids, " ", 2)).toEqual(["qwen/qwen3-27b", "meta/llama-4"]);
	});
});

describe("guessThinkingFormat", () => {
	it("puts the right wire format first for the models that need one", () => {
		expect(guessThinkingFormat("qwen3-27b", "http://localhost:1234/v1")).toBe("qwen");
		expect(guessThinkingFormat("QwQ-32B", "http://localhost:1234/v1")).toBe("qwen");
		expect(guessThinkingFormat("deepseek-r1", "http://x/v1")).toBe("deepseek");
		expect(guessThinkingFormat("glm-4.6", "http://x/v1")).toBe("zai");
		expect(guessThinkingFormat("kimi-k2", "https://openrouter.ai/api/v1")).toBe("openrouter");
		expect(guessThinkingFormat("kimi-k2", "https://x/v1")).toBe("openai");
	});
});

describe("toPositiveInt", () => {
	it("takes a number and refuses everything else", () => {
		expect(toPositiveInt(" 262144 ")).toBe(262144);
		expect(toPositiveInt("262,144")).toBe(262144);
		expect(toPositiveInt("8k")).toBeUndefined();
		expect(toPositiveInt("0")).toBeUndefined();
		expect(toPositiveInt("-1")).toBeUndefined();
		expect(toPositiveInt("")).toBeUndefined();
	});
});

describe("parseModelList", () => {
	it("reads LM Studio's context length, which is where the local case gets its size", () => {
		expect(parseModelList({ data: [{ id: "qwen3-27b", type: "llm", max_context_length: 262144 }] }))
			.toEqual([{ id: "qwen3-27b", contextWindow: 262144 }]);
	});

	it("reads OpenRouter's output cap and vision, which nothing else reports", () => {
		expect(parseModelList({
			data: [{
				id: "qwen/qwen3-27b",
				context_length: 1000000,
				top_provider: { max_completion_tokens: 16384 },
				architecture: { input_modalities: ["text", "image"] },
			}],
		})).toEqual([{ id: "qwen/qwen3-27b", contextWindow: 1000000, maxTokens: 16384, vision: true }]);
	});

	it("drops embedding models, which appear in the same list and cannot answer a prompt", () => {
		const models = parseModelList({ data: [{ id: "qwen3-27b", type: "llm" }, { id: "nomic-embed", type: "embeddings" }] });
		expect(models.map((m) => m.id)).toEqual(["qwen3-27b"]);
	});

	it("survives a shape it has never seen rather than throwing into the wizard", () => {
		expect(parseModelList(undefined)).toEqual([]);
		expect(parseModelList({ data: "nope" })).toEqual([]);
		expect(parseModelList({ models: [{ name: "llama3" }, { name: "llama3" }, {}] })).toEqual([{ id: "llama3" }]);
	});
});

describe("probeModels", () => {
	/** A fetch that answers a scripted set of URLs and 404s everything else. */
	const server = (routes: Record<string, unknown>, seen: string[] = []) => (async (url: string) => {
		seen.push(String(url));
		const body = routes[String(url)];
		return body === undefined
			? new Response("no", { status: 404, statusText: "Not Found" })
			: new Response(JSON.stringify(body), { status: 200 });
	}) as unknown as typeof fetch;

	it("asks the host what it serves, with the token", async () => {
		let auth: unknown;
		const seen: string[] = [];
		const models = await probeModels("http://localhost:1234/v1", "sk-test", 100, (async (url: string, init: RequestInit) => {
			seen.push(String(url));
			auth = (init?.headers as Record<string, string>)?.Authorization;
			return new Response(JSON.stringify({ data: [{ id: "qwen3-27b", context_length: 262144 }] }), { status: 200 });
		}) as unknown as typeof fetch);
		expect(seen).toEqual(["http://localhost:1234/v1/models"]);
		expect(auth).toBe("Bearer sk-test");
		expect(models).toEqual([{ id: "qwen3-27b", contextWindow: 262144 }]);
	});

	/**
	 * The LM Studio case, which is the documented one. Its OpenAI-shaped list is
	 * ids and nothing else — no size, and no way to see that one of them is an
	 * embedding model. Both of those are wrong answers a new operator would
	 * accept without knowing: a 262k model configured at 32k, or a provider that
	 * cannot hold a conversation at all.
	 */
	it("asks LM Studio's own endpoint when the first answer carries no sizes", async () => {
		const seen: string[] = [];
		const models = await probeModels("http://192.168.1.20:1234/v1", "local", 100, server({
			"http://192.168.1.20:1234/v1/models": { data: [{ id: "qwen3.8-27b" }, { id: "nomic-embed" }, { id: "phi-4" }] },
			"http://192.168.1.20:1234/api/v0/models": { data: [
				{ id: "qwen3.8-27b", type: "vlm", max_context_length: 262144, loaded_context_length: 128000 },
				{ id: "nomic-embed", type: "embeddings", max_context_length: 2048 },
				{ id: "phi-4", type: "llm", max_context_length: 16384 },
			] },
		}, seen));
		expect(seen).toEqual([
			"http://192.168.1.20:1234/v1/models",
			"http://192.168.1.20:1234/api/v0/models",
		]);
		// The embedding model is gone, and the size is the one actually loaded.
		expect(models).toEqual([
			{ id: "qwen3.8-27b", contextWindow: 128000, vision: true },
			{ id: "phi-4", contextWindow: 16384 },
		]);
	});

	it("keeps the ids it has when the second endpoint is not there", async () => {
		const models = await probeModels("http://localhost:8000/v1", "local", 100, server({
			"http://localhost:8000/v1/models": { data: [{ id: "served-by-vllm" }] },
		}));
		expect(models).toEqual([{ id: "served-by-vllm" }]);
	});

	it("reports the status rather than pretending the host serves nothing", async () => {
		const failing = (async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
		await expect(probeModels("http://x/v1", "local", 100, failing)).rejects.toThrow("HTTP 401");
	});
});

describe("mergeProbes", () => {
	it("refuses to filter against a listing that describes something else", () => {
		const base = [{ id: "a" }, { id: "b" }];
		expect(mergeProbes(base, [{ id: "x", contextWindow: 8 }])).toEqual(base);
	});
});

describe("describeHost", () => {
	it("shows what will be written, with the token masked", () => {
		const lines = describeHost({
			id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-v1-0123456789",
			models: [{ id: "qwen/qwen3-27b", contextWindow: 262144, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } }],
		});
		expect(lines.join("\n")).toContain("••••••6789");
		expect(lines.join("\n")).not.toContain("sk-or-v1-0123456789");
		expect(lines.join("\n")).toContain("262,144 ctx");
		expect(lines.join("\n")).toContain("reasoning · qwen");
	});
});

describe("addHost", () => {
	it("adds a local host from its preset, keeping what the probe already knows", async () => {
		const ui = scripted([
			["add a provider", "LM Studio — http://localhost:1234/v1"],
			["Base URL", ""],
			["API token", ""],
			["Model", "qwen3-27b"],
			["output tokens", ""],
			["think before it answers", true],
			["returns its thinking", qwenFormat],
			["Another model", false],
			["Add LM Studio?", true],
			["Switch to qwen3-27b now?", true],
		]);
		const result = await addHost(ui, {
			existing: [],
			probe: async () => [{ id: "qwen3-27b", contextWindow: 262144 }],
		});
		expect(result?.config).toEqual({
			id: "lmstudio",
			name: "LM Studio",
			baseUrl: "http://localhost:1234/v1",
			apiKey: "local",
			api: "openai-completions",
			models: [{
				id: "qwen3-27b", contextWindow: 262144, maxTokens: 8192, reasoning: true,
				compat: { thinkingFormat: "qwen" },
			}],
		});
		expect(result?.useModelId).toBe("qwen3-27b");
		expect(result?.updated).toBe(false);
		expect(ui.remaining()).toBe(0);
	});

	it("takes a custom host, an env-var token, and a model typed in when the probe fails", async () => {
		const ui = scripted([
			["add a provider", "Other OpenAI-compatible host…"],
			["Base URL", "gpu-box:8000/v1"],
			["Which API", "openai-completions — LM Studio, Ollama, vLLM, OpenRouter, most gateways"],
			["API token", "$LAB_TOKEN"],
			["Model id", "my-tuned-model"],
			["Context window", "128000"],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", false],
			["Provider id", ""],
			["Add gpu-box?", true],
			["Switch to my-tuned-model now?", false],
		]);
		const result = await addHost(ui, {
			existing: [],
			probe: async () => {
				throw new Error("fetch failed");
			},
		});
		expect(result?.config.id).toBe("gpu-box");
		expect(result?.config.baseUrl).toBe("http://gpu-box:8000/v1");
		// A token kept as a reference never reaches the file, which is the point
		// of offering it to someone holding a client's key.
		expect(result?.config.apiKey).toBe("$LAB_TOKEN");
		expect(result?.config.models).toEqual([{ id: "my-tuned-model", contextWindow: 128000, maxTokens: 8192, reasoning: false }]);
		expect(result?.useModelId).toBeUndefined();
		expect(ui.notes.join("\n")).toContain("did not answer");
	});

	it("searches rather than drawing a list pi's selector cannot scroll", async () => {
		const many = Array.from({ length: 60 }, (_, i) => ({ id: `vendor/model-${i}` }));
		const ui = scripted([
			["add a provider", "OpenRouter — https://openrouter.ai/api/v1"],
			["Base URL", ""],
			["API token", "sk-or-test"],
			["type part of a name to search", "model-42"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", false],
			["Add OpenRouter?", true],
			["Switch to vendor/model-42 now?", false],
		]);
		const result = await addHost(ui, { existing: [], probe: async () => many });
		expect(result?.config.models[0]?.id).toBe("vendor/model-42");
		expect(result?.config.models[0]?.contextWindow).toBe(32768);
	});

	it("adds to a host that already exists rather than dropping the models it had", async () => {
		const existing: LocalProviderConfig[] = [{
			id: "lmstudio", baseUrl: "http://localhost:1234/v1", models: [{ id: "already-there" }],
		}];
		const ui = scripted([
			["add a provider", "LM Studio — http://localhost:1234/v1"],
			["Base URL", ""],
			["API token", ""],
			["Model id", "second-model"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", false],
			["already configured", 'Add to "lmstudio" — keep its 1 existing model(s)'],
			["Update LM Studio?", true],
			["Switch to second-model now?", false],
		]);
		const result = await addHost(ui, { existing, probe: noProbe });
		expect(result?.config.models.map((m) => m.id)).toEqual(["already-there", "second-model"]);
		expect(result?.updated).toBe(true);
	});

	it("replaces a host outright when that is what was asked", async () => {
		const existing: LocalProviderConfig[] = [{
			id: "lmstudio", baseUrl: "http://localhost:1234/v1", models: [{ id: "already-there" }],
		}];
		const ui = scripted([
			["add a provider", "LM Studio — http://localhost:1234/v1"],
			["Base URL", ""],
			["API token", ""],
			["Model id", "only-this"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", false],
			["already configured", 'Replace "lmstudio" — its existing model(s) are dropped'],
			["Update LM Studio?", true],
			["Switch to only-this now?", false],
		]);
		const result = await addHost(ui, { existing, probe: noProbe });
		expect(result?.config.models.map((m) => m.id)).toEqual(["only-this"]);
	});

	it("collects a second model when asked for one", async () => {
		const ui = scripted([
			["add a provider", "Ollama — http://localhost:11434/v1"],
			["Base URL", ""],
			["API token", ""],
			["Model", "llama3"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", true],
			["Model", "qwen3"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", true],
			["returns its thinking", qwenFormat],
			["Another model", false],
			["Add Ollama?", true],
			["Switch to which one?", "qwen3"],
		]);
		const result = await addHost(ui, { existing: [], probe: async () => [{ id: "llama3" }, { id: "qwen3" }] });
		expect(result?.config.models.map((m) => m.id)).toEqual(["llama3", "qwen3"]);
		expect(result?.useModelId).toBe("qwen3");
	});

	it("writes nothing when the operator backs out — at the start, or at the end", async () => {
		expect(await addHost(scripted([["add a provider", undefined]]), { existing: [], probe: noProbe })).toBeUndefined();

		const late = scripted([
			["add a provider", "LM Studio — http://localhost:1234/v1"],
			["Base URL", ""],
			["API token", ""],
			["Model id", "qwen3-27b"],
			["Context window", ""],
			["output tokens", ""],
			["think before it answers", false],
			["Another model", false],
			["Add LM Studio?", false],
		]);
		expect(await addHost(late, { existing: [], probe: noProbe })).toBeUndefined();
		expect(late.notes.join("\n")).toContain("nothing written");
	});

	it("stops when the base URL is left empty on a host that has no preset", async () => {
		const ui = scripted([
			["add a provider", "Other OpenAI-compatible host…"],
			["Base URL", ""],
		]);
		expect(await addHost(ui, { existing: [], probe: noProbe })).toBeUndefined();
		expect(ui.notes.join("\n")).toContain("no base URL");
	});
});
