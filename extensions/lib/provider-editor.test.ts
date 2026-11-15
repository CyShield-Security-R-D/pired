import { describe, expect, it } from "vitest";
import { editProvider, editProviderModels, manageProviders, providerRow } from "./provider-editor.ts";
import type { ProbedModel, Prompter } from "./provider-wizard.ts";
import type { LocalProviderConfig } from "./providers.ts";

/**
 * A prompter that answers a scripted transcript, matching the wizard's.
 *
 * A menu row carries its current value, so an answer that is not a row verbatim
 * names a distinctive part of one — otherwise every test would be rewritten
 * each time a default moved.
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
		select: async (title, options) => {
			const want = next("select", title);
			if (typeof want !== "string") return undefined;
			return options.find((o) => o === want) ?? options.find((o) => o.includes(want)) ?? want;
		},
		input: async (title) => next("input", title) as string | undefined,
		confirm: async (title) => next("confirm", title) as boolean,
		notify: (message) => void notes.push(message),
		notes,
		remaining: () => steps.length - at,
	};
}

/**
 * A file that answers `load` with what `save` last wrote.
 *
 * The menus re-read on every redraw on purpose, so a fake that returned a fixed
 * array would let a bug through: it would never show that an edit failed to
 * land, which is the one thing these menus promise.
 */
function fakeFile(initial: LocalProviderConfig[]) {
	let providers = initial.map((p) => ({ ...p, models: [...p.models] }));
	return {
		load: () => providers,
		save: (config: LocalProviderConfig) => {
			providers = providers.some((p) => p.id === config.id)
				? providers.map((p) => (p.id === config.id ? config : p))
				: [...providers, config];
		},
		remove: (id: string) => void (providers = providers.filter((p) => p.id !== id)),
		current: () => providers,
	};
}

const lmstudio = (): LocalProviderConfig => ({
	id: "lmstudio",
	name: "LM Studio",
	baseUrl: "http://localhost:1234/v1",
	apiKey: "local",
	api: "openai-completions",
	models: [{ id: "qwen3-27b", contextWindow: 32768, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } }],
});

describe("providerRow", () => {
	it("says what it is, where it is, and how much it serves", () => {
		expect(providerRow(lmstudio())).toBe("lmstudio — http://localhost:1234/v1 · 1 model");
		expect(providerRow({ id: "x", baseUrl: "http://x/v1", models: [] })).toBe("x — http://x/v1 · 0 models");
	});
});

describe("manageProviders", () => {
	it("lists what is configured and leaves without touching it", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([["pired · providers", "✓ Done"]]);
		expect(await manageProviders(ui, { ...file })).toEqual({});
		expect(file.current()).toEqual([lmstudio()]);
	});

	it("says so rather than showing an empty list", async () => {
		const ui = scripted([["no providers configured yet", "✓ Done"]]);
		await manageProviders(ui, { ...fakeFile([]) });
	});

	/** The switch request has to survive back out: the model registry is up there. */
	it("carries back the model the add wizard asked to switch to", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([["pired · providers", "+ Add a provider…"], ["pired · providers", "✓ Done"]]);
		const result = await manageProviders(ui, {
			...file,
			add: async () => ({ config: { id: "ollama", baseUrl: "http://x/v1", models: [] }, useModelId: "llama3", updated: false }),
		});
		expect(result).toEqual({ providerId: "ollama", useModelId: "llama3" });
	});

	it("redraws from the file, so a host removed inside is gone from the list", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["pired · providers", "lmstudio"],
			["LM Studio — pick a field", "− Remove this provider"],
			["Remove LM Studio?", true],
			["no providers configured yet", "✓ Done"],
		]);
		await manageProviders(ui, { ...file });
		expect(file.current()).toEqual([]);
	});
});

describe("editProvider", () => {
	it("shows every value on its row, so opening it writes nothing", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([["LM Studio — pick a field", "← Back"]]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()).toEqual([lmstudio()]);
	});

	it("moves a base URL and normalizes what was typed", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "Base URL"],
			["Base URL for lmstudio", "192.168.1.14:1234/v1"],
			["LM Studio — pick a field", "← Back"],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		// http, not https: the address is on this network, and guessing TLS is how
		// a saved host silently never connects.
		expect(file.current()[0]?.baseUrl).toBe("http://192.168.1.14:1234/v1");
	});

	it("keeps the current value when the answer is empty, rather than blanking it", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "Base URL"],
			["Base URL for lmstudio", ""],
			["LM Studio — pick a field", "Token"],
			["API token for lmstudio", ""],
			["LM Studio — pick a field", "← Back"],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.baseUrl).toBe("http://localhost:1234/v1");
		expect(file.current()[0]?.apiKey).toBe("local");
	});

	it("takes a token as a reference, which is what keeps it out of the file", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "Token"],
			["API token for lmstudio", "$LAB_TOKEN"],
			["LM Studio — pick a field", "← Back"],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.apiKey).toBe("$LAB_TOKEN");
	});

	it("masks a real token on the row while showing a reference whole", async () => {
		const file = fakeFile([{ ...lmstudio(), apiKey: "sk-or-v1-0123456789abcdef" }]);
		let seen: string[] = [];
		const ui: Prompter = {
			select: async (_t, options) => {
				seen = options;
				return "← Back";
			},
			input: async () => undefined,
			confirm: async () => false,
			notify: () => {},
		};
		await editProvider(ui, { ...file }, "lmstudio");
		expect(seen.join("\n")).toContain("••••••cdef");
		expect(seen.join("\n")).not.toContain("0123456789");
	});

	it("changes the API dialect", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "API "],
			["Which API does lmstudio speak?", "anthropic-messages"],
			["LM Studio — pick a field", "← Back"],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.api).toBe("anthropic-messages");
	});

	it("keeps the host when the removal is declined", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "− Remove this provider"],
			["Remove LM Studio?", false],
			["LM Studio — pick a field", "← Back"],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()).toHaveLength(1);
	});

	/** Removing returns through this menu, and the host it was drawing is gone. */
	it("returns rather than redrawing a host that was just removed", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["LM Studio — pick a field", "− Remove this provider"],
			["Remove LM Studio?", true],
		]);
		await editProvider(ui, { ...file }, "lmstudio");
		expect(file.current()).toEqual([]);
		expect(ui.remaining()).toBe(0);
	});

	it("does nothing at all for an id that is not there", async () => {
		await editProvider(scripted([]), { ...fakeFile([]) }, "ghost");
	});
});

describe("editProviderModels", () => {
	it("edits a model's parameters in place", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["lmstudio · models", "qwen3-27b"],
			["qwen3-27b — pick a field", "Context window"],
			["Context window for qwen3-27b", "262144"],
			["qwen3-27b — pick a field", "✓ Done"],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.models[0]?.contextWindow).toBe(262144);
	});

	/**
	 * The wrong thinking format is the failure documented in docs/models.md: the
	 * model answers with nothing, successfully. Being able to correct it without
	 * hand-editing JSON is most of why this menu exists.
	 */
	it("corrects a thinking format that was guessed wrong", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["lmstudio · models", "qwen3-27b"],
			["qwen3-27b — pick a field", "Reasoning"],
			["qwen3-27b — pick a field", "✓ Done"],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.models[0]?.reasoning).toBe(false);
		expect(file.current()[0]?.models[0]?.compat).toBeUndefined();
	});

	it("adds models the host serves and it does not have yet", async () => {
		const file = fakeFile([lmstudio()]);
		const probed: ProbedModel[] = [{ id: "qwen3-27b" }, { id: "llama3", contextWindow: 128000 }];
		const ui = scripted([
			["lmstudio · models", "+ Add models…"],
			["pick any", "llama3"],
			["1 chosen", "Done"],
			["llama3 — pick a field", "✓ Done"],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file, probe: async () => probed }, "lmstudio");
		expect(file.current()[0]?.models.map((m) => m.id)).toEqual(["qwen3-27b", "llama3"]);
		expect(file.current()[0]?.models[1]?.contextWindow).toBe(128000);
	});

	/** Offering one it already has invites a duplicate the file cannot tell apart. */
	it("holds back the models the host already has", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["lmstudio · models", "+ Add models…"],
			// qwen3-27b is configured, so it is held back and the probe's only entry
			// with it: the picker has nothing to list and says so.
			["the host listed none", undefined],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file, probe: async () => [{ id: "qwen3-27b" }] }, "lmstudio");
		expect(file.current()[0]?.models).toHaveLength(1);
	});

	it("reports a host that did not answer rather than looking like it serves nothing", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["lmstudio · models", "+ Add models…"],
			["the host listed none", undefined],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, {
			...file,
			probe: async () => {
				throw new Error("fetch failed");
			},
		}, "lmstudio");
		expect(ui.notes.join("\n")).toContain("did not answer");
	});

	it("takes a model away", async () => {
		const file = fakeFile([{
			...lmstudio(),
			models: [...lmstudio().models, { id: "llama3", contextWindow: 8192, maxTokens: 512, reasoning: false }],
		}]);
		const ui = scripted([
			["lmstudio · models", "− Remove a model…"],
			["remove which model?", "llama3"],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.models.map((m) => m.id)).toEqual(["qwen3-27b"]);
		expect(ui.notes.join("\n")).toContain("removed llama3");
	});

	/** A host serving nothing is not an error, but it will not be in /model. */
	it("warns when the last model is taken away", async () => {
		const file = fakeFile([lmstudio()]);
		const ui = scripted([
			["lmstudio · models", "− Remove a model…"],
			["remove which model?", "qwen3-27b"],
			["lmstudio · models", "← Back"],
		]);
		await editProviderModels(ui, { ...file }, "lmstudio");
		expect(file.current()[0]?.models).toEqual([]);
		expect(ui.notes.join("\n")).toContain("serves nothing");
	});

	it("offers no way to remove one when there are none to remove", async () => {
		const file = fakeFile([{ ...lmstudio(), models: [] }]);
		let seen: string[] = [];
		const ui: Prompter = {
			select: async (_t, options) => {
				seen = options;
				return "← Back";
			},
			input: async () => undefined,
			confirm: async () => false,
			notify: () => {},
		};
		await editProviderModels(ui, { ...file }, "lmstudio");
		expect(seen).toEqual(["+ Add models…", "← Back"]);
	});
});
