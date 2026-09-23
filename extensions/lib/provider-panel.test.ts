import { describe, expect, it, vi, afterEach } from "vitest";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { modelIds, ProviderPanel } from "./provider-panel.ts";
import type { ManageResult, ProviderEditorDeps } from "./provider-editor.ts";
import type { LocalProviderConfig } from "./providers.ts";

const provider = (): LocalProviderConfig => ({
	id: "lab", name: "Lab", baseUrl: "http://localhost:1234/v1", apiKey: "secret-token-123456",
	compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
	models: [{ id: "qwen3", contextWindow: 128000, maxTokens: 8192, reasoning: true,
		compat: { supportsReasoningEffort: false, thinkingFormat: "qwen" } }, { id: "llama" }],
});

function setup(configs: LocalProviderConfig[] = [], options: Partial<ProviderEditorDeps> = {}, start = {}) {
	let stored = structuredClone(configs);
	const save = vi.fn(async (config: LocalProviderConfig) => {
		stored = [...stored.filter((p) => p.id !== config.id), structuredClone(config)];
	});
	const remove = vi.fn(async (id: string) => { stored = stored.filter((p) => p.id !== id); });
	const theme = { fg: vi.fn((_tone: string, text: string) => text), bg: vi.fn((_tone: string, text: string) => text), bold: (s: string) => s };
	const done = vi.fn<(result: ManageResult) => void>();
	let height = 30;
	let width = 88;
	const panel = new ProviderPanel(theme, { load: () => stored, save, remove, ...options }, vi.fn(), done, () => height, start);
	const render = () => panel.render(width);
	const text = () => render().map(stripTerminalSequences).join("\n");
	const key = async (s: string) => { await panel.handleInput(s); render(); };
	const focus = async (label: string) => {
		for (let i = 0; i < 600; i++) {
			if (render().map(stripTerminalSequences).some((line) => line.includes("› ") && line.includes(label))) return;
			await key("\t");
		}
		throw new Error(`Cannot focus ${label}\n${text()}`);
	};
	const click = async (label: string) => { await focus(label); await key("\r"); };
	const fill = async (label: string, value: string) => {
		await focus(label);
		await key("\x05");
		await key("\x15");
		await key(`\x1b[200~${value}\x1b[201~`);
	};
	return { panel, text, render, key, focus, click, fill, save, remove, done, theme,
		stored: () => stored, resize: (w: number, h: number) => { width = w; height = h; } };
}

afterEach(() => vi.unstubAllEnvs());

describe("the provider form", () => {
	it("adds several pasted models with one save and no field-by-field prompts", async () => {
		const ui = setup();
		await ui.click("LM Studio");
		expect(ui.text()).toContain("localhost:1234/v1");
		await ui.fill("Model IDs", "qwen3\nllama\r\nqwen3, mistral");
		expect(ui.save).not.toHaveBeenCalled();
		await ui.key("\x13");
		expect(ui.save).toHaveBeenCalledTimes(1);
		expect(ui.stored()[0]?.models.map((m) => m.id)).toEqual(["qwen3", "llama", "mistral"]);
		expect(ui.stored()[0]).toMatchObject({ id: "lmstudio", apiKey: "local" });
		expect(ui.done).toHaveBeenCalledWith({ providerId: "lmstudio", useModelId: "qwen3" });
	});

	it("keeps chunked multiline paste inside the model field until the paste ends", async () => {
		const ui = setup();
		await ui.click("LM Studio");
		await ui.focus("Model IDs");
		await ui.key("\x1b[200~first");
		await ui.key("\r");
		await ui.key("second");
		await ui.key("\n");
		await ui.key("third\x1b[201~");
		expect(ui.save).not.toHaveBeenCalled();
		await ui.key("\x13");
		expect(ui.stored()[0]?.models.map((m) => m.id)).toEqual(["first", "second", "third"]);
	});

	it("keeps normal forms neutral even when the theme's accent is red", async () => {
		const ui = setup();
		ui.render();
		await ui.click("Ollama");
		expect(ui.theme.fg.mock.calls.map(([tone]) => tone)).not.toContain("accent");
		expect(ui.theme.fg.mock.calls.map(([tone]) => tone)).not.toContain("error");
		expect(ui.theme.fg.mock.calls.map(([tone]) => tone)).toContain("borderMuted");
	});

	it("edits all connection settings as a draft and preserves model and provider compatibility", async () => {
		const original = provider();
		const ui = setup([original], {}, { edit: "lab" });
		await ui.fill("Name", "GPU server");
		await ui.fill("Base URL", "192.168.1.20:1234/v1/");
		await ui.fill("API token", "$LAB_KEY");
		await ui.fill("Model IDs", "qwen3 llama mistral");
		expect(ui.stored()).toEqual([original]);
		await ui.click("Save provider");
		expect(ui.stored()[0]).toMatchObject({ id: "lab", name: "GPU server", baseUrl: "http://192.168.1.20:1234/v1", apiKey: "$LAB_KEY", compat: original.compat });
		expect(ui.stored()[0]?.models[0]).toEqual(original.models[0]);
		expect(ui.text()).toContain("Saved GPU server");
		expect(ui.done).not.toHaveBeenCalled();
	});

	it("keeps and discards unsaved edits explicitly without mutating the saved provider", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.fill("Base URL", "localhost:9999/v1");
		await ui.key("\x1b");
		expect(ui.text()).toContain("Discard unsaved changes?");
		await ui.key("\r"); // Keep editing is the safe default.
		expect(ui.text()).toContain("localhost:9999/v1");
		await ui.click("Cancel");
		await ui.click("Discard changes");
		expect(ui.save).not.toHaveBeenCalled();
		expect(ui.stored()).toEqual([provider()]);
		await ui.click("Lab");
		await ui.key("\x1b"); // An untouched form needs no discard dialog.
		expect(ui.text()).toContain("Choose a provider");
	});

	it("hides both existing and newly typed tokens, including while the field has focus", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.focus("API token");
		expect(ui.render().join("\n")).not.toContain("secret-token");
		expect(ui.render().join("\n")).toContain(CURSOR_MARKER);
		await ui.fill("API token", "new-very-private-token");
		expect(ui.render().join("\n")).not.toContain("new-very-private-token");
		await ui.key("\x13");
		expect(ui.stored()[0]?.apiKey).toBe("new-very-private-token");
	});

	it("can clear a token for a server that no longer needs authentication", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.fill("API token", "");
		await ui.key("\x13");
		expect(ui.stored()[0]?.apiKey).toBe("local");
	});

	it("uses distinct IDs for repeated presets and derives a custom ID from the URL", async () => {
		const ui = setup([{ ...provider(), id: "lmstudio" }], {}, { add: true });
		await ui.click("LM Studio");
		await ui.fill("Model IDs", "new-model");
		await ui.key("\x13");
		expect(ui.stored().map((p) => p.id)).toEqual(["lmstudio", "lmstudio-2"]);
		const custom = setup();
		await custom.click("Other OpenAI-compatible");
		await custom.fill("Base URL", "api.example.com/v1");
		await custom.fill("Model IDs", "my-model");
		await custom.key("\x13");
		expect(custom.stored()[0]).toMatchObject({ id: "example", baseUrl: "https://api.example.com/v1" });
	});

	it("validates URL, required models, reserved IDs and collisions without throwing away the draft", async () => {
		const ui = setup([provider()], {}, { add: true });
		await ui.click("Other OpenAI-compatible");
		await ui.fill("Base URL", "ftp://example.com");
		await ui.key("\x13");
		expect(ui.text()).toContain("valid HTTP or HTTPS");
		await ui.fill("Base URL", "https://example.com/v1");
		await ui.key("\x13");
		expect(ui.text()).toContain("Add at least one model");
		await ui.fill("Model IDs", "mistral");
		await ui.click("Advanced");
		await ui.fill("Provider ID", "add-provider");
		await ui.key("\x13");
		expect(ui.text()).toContain("Choose a provider ID");
		await ui.fill("Provider ID", "lab");
		await ui.key("\x13");
		expect(ui.text()).toContain("already in use");
		expect(ui.save).not.toHaveBeenCalled();
		await ui.fill("Provider ID", "new-lab");
		await ui.click("API format");
		await ui.key("\x13");
		expect(ui.stored()[1]).toMatchObject({ id: "new-lab", api: "anthropic-messages" });
	});

	it("retains the draft after a save failure and prevents double submission", async () => {
		let fail = true;
		let release!: () => void;
		const save = vi.fn(async () => {
			if (fail) throw new Error("secret-token-123456");
			await new Promise<void>((resolve) => { release = resolve; });
		});
		const ui = setup([provider()], { save }, { edit: "lab" });
		await ui.key("\x13");
		expect(ui.text()).toContain("Could not save");
		expect(ui.text()).not.toContain("secret-token");
		fail = false;
		const pending = ui.key("\x13");
		await ui.key("\x13");
		await ui.key("\x1b");
		expect(save).toHaveBeenCalledTimes(2);
		release();
		await pending;
		expect(ui.text()).toContain("Saved Lab");
	});

	it("requires an explicit delete and recovers from delete failures", async () => {
		const remove = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce(undefined);
		const ui = setup([provider()], { remove }, { edit: "lab" });
		await ui.click("Delete provider…");
		expect(ui.text()).toContain("Removes 2 model(s)");
		await ui.key("\r"); // Keep provider.
		expect(remove).not.toHaveBeenCalled();
		await ui.click("Delete provider…");
		await ui.click("Delete provider");
		expect(ui.text()).toContain("Could not delete");
		await ui.key("\r");
		expect(remove).toHaveBeenCalledTimes(2);
		expect(ui.text()).toContain("Deleted Lab");
	});

	it("deletes from the list and closes cleanly from either entry point", async () => {
		const ui = setup([provider()]);
		await ui.click("Lab");
		await ui.click("Delete provider…");
		await ui.click("Delete provider");
		expect(ui.stored()).toEqual([]);
		await ui.click("Done");
		expect(ui.done).toHaveBeenCalledWith({});
		const empty = setup();
		await empty.key("\x1b");
		expect(empty.done).toHaveBeenCalledWith({});
		await empty.key("\r");
		expect(empty.save).not.toHaveBeenCalled();
	});
});

describe("model selection and settings", () => {
	it("discovers with the resolved key and selects more than twelve models in one action", async () => {
		vi.stubEnv("PIRED_TEST_PROVIDER_KEY", "actual-key");
		const probe = vi.fn(async () => Array.from({ length: 65 }, (_, i) => ({ id: `chat-${i}`, contextWindow: 131072, vision: true })));
		const ui = setup([], { probe });
		await ui.click("OpenRouter");
		await ui.fill("API token", "$PIRED_TEST_PROVIDER_KEY");
		await ui.click("Find models");
		expect(probe).toHaveBeenCalledWith("https://openrouter.ai/api/v1", "actual-key");
		await ui.fill("Search", "chat-");
		await ui.click("Select all matching");
		expect(ui.text()).toContain("65 selected");
		await ui.click("Done");
		await ui.key("\x13");
		expect(ui.stored()[0]?.models).toHaveLength(65);
		expect(ui.stored()[0]?.models[0]).toMatchObject({ contextWindow: 131072, input: ["text", "image"] });
		expect(ui.stored()[0]?.apiKey).toBe("$PIRED_TEST_PROVIDER_KEY");
	});

	it("filters without losing selections and preserves custom settings when toggling off and on", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.click("Manage models");
		await ui.fill("Search", "QWEN");
		expect(ui.text()).not.toContain("llama —");
		await ui.focus("[x] qwen3");
		await ui.key(" ");
		expect(ui.text()).toContain("[ ] qwen3");
		await ui.key(" ");
		await ui.click("Done");
		await ui.key("\x13");
		expect(ui.stored()[0]?.models).toEqual([provider().models[1], provider().models[0]]);
	});

	it("bulk deselection removes only the matching models when saved", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.click("Manage models");
		await ui.fill("Search", "llama");
		await ui.click("Deselect all matching");
		await ui.key("\x1b");
		expect(ui.stored()[0]?.models).toHaveLength(2);
		await ui.key("\x13");
		expect(ui.stored()[0]?.models.map((m) => m.id)).toEqual(["qwen3"]);
	});

	it("can remove the last model from an existing provider without deleting its connection", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.click("Manage models");
		await ui.click("Deselect all matching");
		await ui.key("\x1b");
		await ui.key("\x13");
		expect(ui.stored()[0]).toMatchObject({ id: "lab", baseUrl: provider().baseUrl, models: [] });
	});

	it("edits model settings together and validates token counts before applying them", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.click("Manage models");
		await ui.focus("qwen3 —");
		await ui.key("e");
		await ui.fill("Context tokens", "1000");
		await ui.key("\x13");
		expect(ui.text()).toContain("positive token counts");
		await ui.fill("Context tokens", "262144");
		await ui.fill("Output tokens", "16384");
		await ui.click("Reasoning");
		await ui.click("Thinking format");
		await ui.click("Image input");
		await ui.click("Apply to draft");
		expect(ui.save).not.toHaveBeenCalled();
		await ui.click("Done");
		await ui.key("\x13");
		expect(ui.stored()[0]?.models[0]).toMatchObject({ contextWindow: 262144, maxTokens: 16384, reasoning: false,
			input: ["text", "image"], compat: { supportsReasoningEffort: false, supportsDeveloperRole: false } });
	});

	it("cancelling model edits leaves the provider draft untouched", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		await ui.click("Manage models");
		await ui.focus("qwen3 —");
		await ui.key("e");
		await ui.fill("Context tokens", "4096");
		await ui.key("\x1b");
		await ui.key("\x1b");
		await ui.key("\x13");
		expect(ui.stored()[0]?.models).toEqual(provider().models);
	});

	it("allows manual entry after a failed or empty discovery without exposing error credentials", async () => {
		const probe = vi.fn().mockRejectedValueOnce(new Error("secret-token-123456")).mockResolvedValueOnce([]);
		const ui = setup([], { probe });
		await ui.click("LM Studio");
		await ui.fill("Base URL", "localhost:1234");
		await ui.click("Find models");
		expect(ui.text()).toContain("needs /v1");
		expect(ui.text()).not.toContain("secret-token");
		await ui.click("Find models");
		expect(ui.text()).toContain("No models returned");
		await ui.key("\x1b");
		await ui.fill("Model IDs", "manual-model");
		await ui.key("\x13");
		expect(ui.stored()[0]?.models[0]?.id).toBe("manual-model");
	});

	it("ignores a late discovery response after cancellation and after disposal", async () => {
		let resolve!: (models: { id: string }[]) => void;
		const probe = () => new Promise<{ id: string }[]>((r) => { resolve = r; });
		const ui = setup([], { probe });
		await ui.click("LM Studio");
		await ui.focus("Find models");
		const pending = ui.key("\r");
		expect(ui.text()).toContain("Finding models");
		await ui.key("\x1b");
		await ui.fill("Model IDs", "manual");
		resolve([{ id: "late-result" }]);
		await pending;
		expect(ui.text()).not.toContain("late-result");
		await ui.focus("Find models");
		const disposed = ui.key("\r");
		ui.panel.dispose();
		resolve([{ id: "also-late" }]);
		await disposed;
		expect(ui.save).not.toHaveBeenCalled();
	});
});

describe("terminal layout and navigation", () => {
	it("scrolls to the focused row and stays within narrow, short terminal bounds", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		ui.resize(38, 12);
		await ui.click("Advanced");
		await ui.key("\x1b[6~");
		await ui.key("\x1b[5~");
		await ui.key("\x1b[Z");
		await ui.key("\x1b[A");
		await ui.key("\x1b[B");
		await ui.focus("Save provider");
		expect(ui.render().length).toBeLessThanOrEqual(12);
		for (const line of ui.render()) expect(visibleWidth(line)).toBeLessThanOrEqual(38);
		expect(ui.text()).toContain("› Save provider");
		await ui.key("\x1b[C"); // Arrow navigation must never activate Save or Delete.
		expect(ui.save).not.toHaveBeenCalled();
	});

	it("wraps validation messages instead of cutting off the corrective action", async () => {
		const ui = setup([provider()], {}, { edit: "lab" });
		ui.resize(38, 16);
		await ui.fill("Base URL", "ftp://host");
		await ui.key("\x13");
		expect(ui.text()).toContain("! Enter a valid HTTP or HTTPS");
		expect(ui.text()).toContain("localhost:1234/v1");
		expect(ui.render().length).toBeLessThanOrEqual(16);
	});

	it("treats external labels as text and Enter advances between fields", async () => {
		const ui = setup([{ ...provider(), name: "Lab\n\x1b[31mred" }]);
		expect(ui.render().every((line) => !line.includes("\n"))).toBe(true);
		await ui.click("Lab");
		await ui.focus("Name");
		await ui.key("\r");
		expect(ui.text()).toMatch(/› Base URL/);
		ui.panel.invalidate();
	});

	it("splits pasted IDs without duplicates", () => {
		expect(modelIds("a,b\n c\t a,, ")).toEqual(["a", "b", "c"]);
	});
});
