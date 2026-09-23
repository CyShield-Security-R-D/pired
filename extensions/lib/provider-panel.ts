/** The terminal provider manager: edit a draft, then save the whole provider. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ManageResult, ProviderEditorDeps } from "./provider-editor.ts";
import {
	API_DIALECTS, DEFAULT_CONTEXT, DEFAULT_MAX_TOKENS, describeModel, draftModel, HOST_PRESETS,
	looksMissingVersionPath, maskToken, normalizeBaseUrl, probeModels, suggestProviderId,
	THINKING_FORMATS, toPositiveInt, uniqueId, type HostPreset, type ProbedModel,
} from "./provider-wizard.ts";
import { resolveKeyRef, type LocalProviderConfig } from "./providers.ts";

type Model = LocalProviderConfig["models"][number];
type Screen = "providers" | "presets" | "form" | "models" | "model" | "delete" | "discard";
type Tone = "text" | "muted" | "success" | "error" | "warning";
interface Row {
	label: string;
	input?: Input;
	placeholder?: string;
	secret?: boolean;
	tone?: Tone;
	run?: () => void | Promise<void>;
}

/** Paste a whole list, with either commas or whitespace between model ids. */
export function modelIds(raw: string): string[] {
	return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

/** pi's single-line Input drops newlines; lists need them to remain separators. */
class ModelInput extends Input {
	private pasting = false;
	override handleInput(data: string): void {
		if (data.includes("\x1b[200~")) this.pasting = true;
		const ended = data.includes("\x1b[201~");
		super.handleInput(this.pasting ? data.replace(/[\r\n\t]/g, " ") : data);
		if (ended) this.pasting = false;
	}
}

function input(value = "", list = false): Input {
	const field = list ? new ModelInput() : new Input();
	field.setValue(value);
	field.handleInput("\x05"); // End of the prefilled value, ready to edit.
	return field;
}

/** External names are text, never terminal control sequences or extra rows. */
function plain(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export class ProviderPanel {
	focused = true;
	private screen: Screen = "providers";
	private selected = 0;
	private scroll = 0;
	private pageSize = 10;
	private message = "";
	private tone: Tone = "muted";
	private busy = false;
	private closed = false;
	private revision = 0;
	private original?: LocalProviderConfig;
	private draft!: LocalProviderConfig;
	private fields: Record<string, Input> = {};
	private baseline = "";
	private advanced = false;
	private useAfterSave = false;
	private probed: ProbedModel[] = [];
	private search = input();
	private model?: Model;
	private modelFields: Record<string, Input> = {};
	private modelCache = new Map<string, Model>();
	private pasteField?: Input;
	private readonly theme: Pick<Theme, "fg" | "bold" | "bg">;
	private readonly deps: ProviderEditorDeps;
	private readonly redraw: () => void;
	private readonly done: (result: ManageResult) => void;
	private readonly height: () => number;

	constructor(
		theme: Pick<Theme, "fg" | "bold" | "bg">,
		deps: ProviderEditorDeps,
		redraw: () => void,
		done: (result: ManageResult) => void,
		height: () => number,
		start: { add?: boolean; edit?: string } = {},
	) {
		this.theme = theme;
		this.deps = deps;
		this.redraw = redraw;
		this.done = done;
		this.height = height;
		const providers = deps.load();
		const target = providers.find((p) => p.id === start.edit);
		if (target) this.openForm(target);
		else if (start.add || providers.length === 0) this.screen = "presets";
	}

	invalidate(): void {}
	dispose(): void { this.closed = true; this.revision++; }

	private go(screen: Screen): void {
		this.screen = screen;
		this.selected = 0;
		this.scroll = 0;
		this.message = "";
		this.tone = "muted";
	}

	private say(message: string, tone: Tone = "muted"): void {
		this.message = message;
		this.tone = tone;
	}

	private finish(result: ManageResult = {}): void {
		this.dispose();
		this.done(result);
	}

	private openForm(provider: LocalProviderConfig, existing = true): void {
		this.revision++;
		this.original = existing ? provider : undefined;
		this.draft = structuredClone(provider);
		this.fields = {
			name: input(provider.name ?? provider.id), url: input(provider.baseUrl),
			key: input(provider.apiKey === "local" ? "" : provider.apiKey),
			models: input(provider.models.map((m) => m.id).join(", "), true), id: input(provider.id),
		};
		this.probed = [];
		this.modelCache = new Map(this.draft.models.map((m) => [m.id, m]));
		this.advanced = false;
		this.useAfterSave = !existing;
		this.baseline = this.snapshot();
		this.go("form");
	}

	private addPreset(preset: HostPreset): void {
		const id = uniqueId(preset.id || "custom", this.deps.load().map((p) => p.id));
		this.openForm({ id, name: preset.custom ? "" : preset.label, baseUrl: preset.baseUrl,
			apiKey: preset.apiKey, api: "openai-completions", models: [] }, false);
		// Local presets are already usable; start at models. Hosted presets need a key.
		this.selected = preset.custom ? 1 : preset.apiKey ? 3 : 2;
	}

	private value(key: string): string { return this.fields[key]!.getValue().trim(); }

	private snapshot(): string {
		return JSON.stringify([Object.values(this.fields).map((f) => f.getValue()), this.draft]);
	}

	private syncModels(): void {
		for (const model of this.draft.models) this.modelCache.set(model.id, model);
		this.draft.models = modelIds(this.value("models")).map((id) => this.modelCache.get(id)
			?? draftModel(id, normalizeBaseUrl(this.value("url")), this.probed));
	}

	private updateModelText(): void {
		this.fields.models = input(this.draft.models.map((m) => m.id).join(", "), true);
	}

	private validUrl(): string | undefined {
		const url = normalizeBaseUrl(this.value("url"));
		try {
			const parsed = new URL(url);
			if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw new Error();
			return url;
		} catch {
			this.selected = 1;
			this.say("Enter a valid HTTP or HTTPS base URL, e.g. localhost:1234/v1.", "error");
			return undefined;
		}
	}

	private async discover(): Promise<void> {
		const url = this.validUrl();
		if (!url) return;
		this.syncModels();
		this.busy = true;
		this.say("Finding models… Esc cancels.");
		const revision = ++this.revision;
		this.redraw();
		try {
			const models = await (this.deps.probe ?? probeModels)(url, resolveKeyRef(this.value("key") || "local"));
			if (this.closed || revision !== this.revision) return;
			this.probed = models;
			this.openModels();
			if (models.length === 0) this.say("No models returned. Go back and paste model IDs, or check the URL.", "warning");
		} catch {
			if (this.closed || revision !== this.revision) return;
			const hint = looksMissingVersionPath(url) ? " Check whether the URL needs /v1." : " Check the URL and token.";
			this.say(`Could not list models.${hint} You can still paste model IDs and save.`, "warning");
		} finally {
			if (revision === this.revision) this.busy = false;
			if (!this.closed) this.redraw();
		}
	}

	private openModels(): void {
		this.syncModels();
		this.search = input();
		this.go("models");
	}

	private pool(): string[] {
		const query = this.search.getValue().trim().toLowerCase();
		return [...new Set([...this.modelCache.keys(), ...this.draft.models.map((m) => m.id), ...this.probed.map((m) => m.id)])]
			.filter((id) => id.toLowerCase().includes(query));
	}

	private toggleModel(id: string): void {
		for (const model of this.draft.models) this.modelCache.set(model.id, model);
		if (this.draft.models.some((m) => m.id === id)) this.draft.models = this.draft.models.filter((m) => m.id !== id);
		else this.draft.models.push(this.modelCache.get(id) ?? draftModel(id, normalizeBaseUrl(this.value("url")), this.probed));
		this.updateModelText();
	}

	private editModel(id: string): void {
		this.model = structuredClone(this.draft.models.find((m) => m.id === id)
			?? this.modelCache.get(id) ?? draftModel(id, normalizeBaseUrl(this.value("url")), this.probed));
		this.modelFields = {
			context: input(String(this.model.contextWindow ?? DEFAULT_CONTEXT)),
			output: input(String(this.model.maxTokens ?? DEFAULT_MAX_TOKENS)),
		};
		this.go("model");
	}

	private applyModel(): void {
		const contextWindow = toPositiveInt(this.modelFields.context!.getValue());
		const maxTokens = toPositiveInt(this.modelFields.output!.getValue());
		if (!contextWindow || !maxTokens || maxTokens > contextWindow) {
			this.say("Use positive token counts; output tokens must not exceed the context window.", "error");
			return;
		}
		const model = { ...this.model!, contextWindow, maxTokens };
		this.modelCache.set(model.id, model);
		const at = this.draft.models.findIndex((m) => m.id === model.id);
		if (at < 0) this.draft.models.push(model);
		else this.draft.models[at] = model;
		this.updateModelText();
		this.go("models");
	}

	private async save(): Promise<void> {
		const baseUrl = this.validUrl();
		if (!baseUrl) return;
		this.syncModels();
		let id = this.value("id");
		if (!this.original && id === "custom") id = uniqueId(suggestProviderId(baseUrl), this.deps.load().map((p) => p.id));
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id === "add-provider") {
			this.advanced = true;
			this.say("Choose a provider ID using letters, numbers, dots, dashes or underscores (add-provider is reserved).", "error");
			return;
		}
		if (!this.original && this.deps.load().some((p) => p.id === id)) {
			this.advanced = true;
			this.say(`Provider ID already in use: ${id}. Choose another in Advanced.`, "error");
			return;
		}
		if (this.draft.models.length === 0 && (!this.original || this.useAfterSave)) {
			this.selected = 3;
			this.say("Add at least one model ID, or choose Find models.", "error");
			return;
		}
		const config: LocalProviderConfig = { ...this.draft, id, name: this.value("name") || id, baseUrl,
			apiKey: this.value("key") || "local" };
		this.busy = true;
		this.say("Saving provider…");
		this.redraw();
		try {
			await this.deps.save(config);
			if (this.useAfterSave && config.models.length > 0) this.finish({ providerId: config.id, useModelId: config.models[0]!.id });
			else {
				this.go("providers");
				this.say(`Saved ${config.name} · ${config.models.length} model(s) available in /model.`, "success");
			}
		} catch {
			// File-system and adapter errors can contain the full config, including keys.
			this.say("Could not save the provider. Check file permissions and try Save again; your draft is kept.", "error");
		} finally { this.busy = false; this.redraw(); }
	}

	private async remove(): Promise<void> {
		this.busy = true;
		this.redraw();
		try {
			await this.deps.remove(this.original!.id);
			this.go("providers");
			this.say(`Deleted ${this.original!.name ?? this.original!.id}. An active model stays until restart.`, "success");
		} catch {
			this.say("Could not delete the provider. Check file permissions and try again.", "error");
		} finally { this.busy = false; this.redraw(); }
	}

	private cancelForm(): void {
		if (this.snapshot() !== this.baseline) this.go("discard");
		else this.go("providers");
	}

	private back(): void {
		if (this.screen === "form") this.cancelForm();
		else if (this.screen === "models" || this.screen === "delete" || this.screen === "discard") this.go("form");
		else if (this.screen === "model") this.go("models");
		else if (this.screen === "presets" && this.deps.load().length > 0) this.go("providers");
		else this.finish();
	}

	private rows(): Row[] {
		switch (this.screen) {
			case "providers": return [
				{ label: "+ Add provider", run: () => this.go("presets") },
				...this.deps.load().map((p) => ({ label: `${p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id} · ${p.models.length} model(s) · ${p.baseUrl}`, run: () => this.openForm(p) })),
				{ label: "Done", run: () => this.finish() },
			];
			case "presets": return [
				...HOST_PRESETS.map((p) => ({ label: `${p.label}${p.baseUrl ? ` · ${p.baseUrl}` : ""}`, run: () => this.addPreset(p) })),
				{ label: "Cancel", run: () => this.back() },
			];
			case "form": return [
				{ label: "Name", input: this.fields.name, placeholder: "A name for this provider" },
				{ label: "Base URL", input: this.fields.url, placeholder: "http://localhost:1234/v1" },
				{ label: "API token", input: this.fields.key, secret: true, placeholder: "Optional · paste a key or $ENV_VAR" },
				{ label: "Model IDs", input: this.fields.models, placeholder: "Paste IDs separated by commas or spaces" },
				{ label: "Find models", run: () => this.discover() },
				{ label: `Manage models (${modelIds(this.value("models")).length}) · select, edit or remove`, run: () => this.openModels() },
				{ label: `${this.advanced ? "▾" : "▸"} Advanced · provider ID and API format`, run: () => { this.advanced = !this.advanced; } },
				...(this.advanced ? [
					this.original ? { label: `Provider ID   ${this.original.id}` } : { label: "Provider ID", input: this.fields.id },
					{ label: `API format    ${this.draft.api ?? "openai-completions"}  ↔`, run: () => {
						const at = API_DIALECTS.findIndex((a) => a.id === this.draft.api);
						this.draft.api = API_DIALECTS[(at + 1) % API_DIALECTS.length]!.id;
					} },
				] : []),
				{ label: `[${this.useAfterSave ? "x" : " "}] Use first model after saving`, run: () => { this.useAfterSave = !this.useAfterSave; } },
				{ label: "Save provider", tone: "success", run: () => this.save() },
				{ label: "Cancel", run: () => this.cancelForm() },
				...(this.original ? [{ label: "Delete provider…", tone: "error" as const, run: () => this.go("delete") }] : []),
			];
			case "models": {
				const chosen = new Set(this.draft.models.map((m) => m.id));
				const pool = this.pool();
				return [
					{ label: "Search", input: this.search, placeholder: "Filter models…" },
					{ label: "Done · back to provider", run: () => this.go("form") },
					{ label: `Select all matching (${pool.length})`, run: () => {
						for (const id of pool) if (!chosen.has(id)) this.toggleModel(id);
					} },
					{ label: "Deselect all matching", run: () => {
						for (const model of this.draft.models) this.modelCache.set(model.id, model);
						this.draft.models = this.draft.models.filter((m) => !pool.includes(m.id));
						this.updateModelText();
					} },
					...pool.map((id) => ({ label: `[${chosen.has(id) ? "x" : " "}] ${describeModel(this.draft.models.find((m) => m.id === id)
						?? this.modelCache.get(id) ?? draftModel(id, this.value("url"), this.probed))}`, run: () => this.toggleModel(id) })),
				];
			}
			case "model": return [
				{ label: "Context tokens", input: this.modelFields.context },
				{ label: "Output tokens", input: this.modelFields.output },
				{ label: `[${this.model!.reasoning ? "x" : " "}] Reasoning`, run: () => { this.model!.reasoning = !this.model!.reasoning; } },
				{ label: `Thinking format   ${this.model!.compat?.thinkingFormat ?? this.draft.compat?.thinkingFormat ?? "openai"}  ↔`, run: () => {
					const current = this.model!.compat?.thinkingFormat ?? this.draft.compat?.thinkingFormat ?? "openai";
					const at = THINKING_FORMATS.findIndex((f) => f.id === current);
					this.model!.compat = { ...this.draft.compat, ...this.model!.compat, thinkingFormat: THINKING_FORMATS[(at + 1) % THINKING_FORMATS.length]!.id };
				} },
				{ label: `[${this.model!.input?.includes("image") ? "x" : " "}] Image input`, run: () => {
					this.model!.input = this.model!.input?.includes("image") ? ["text"] : ["text", "image"];
				} },
				{ label: "Apply to draft", tone: "success", run: () => this.applyModel() },
				{ label: "Cancel", run: () => this.go("models") },
			];
			case "delete": return [
				{ label: "Keep provider", run: () => this.go("form") },
				{ label: "Delete provider", tone: "error", run: () => this.remove() },
			];
			case "discard": return [
				{ label: "Keep editing", run: () => this.go("form") },
				{ label: "Discard changes", run: () => this.go("providers") },
			];
		}
	}

	async handleInput(data: string): Promise<void> {
		if (this.closed) return;
		if (this.busy) {
			if (matchesKey(data, Key.escape) && this.message.startsWith("Finding")) {
				this.revision++;
				this.busy = false;
				this.say("Model search cancelled. You can paste model IDs or try again.");
				this.redraw();
			}
			return;
		}
		const rows = this.rows();
		const row = rows[this.selected];
		// A paste can arrive in chunks; newlines and shortcut-looking bytes inside
		// it belong to the field, not the panel's navigation or Save handler.
		if (data.includes("\x1b[200~") && row?.input) this.pasteField = row.input;
		if (this.pasteField) {
			this.pasteField.handleInput(data);
			if (data.includes("\x1b[201~")) this.pasteField = undefined;
			this.redraw();
			return;
		}
		if (matchesKey(data, Key.escape)) this.back();
		else if (matchesKey(data, Key.ctrl("s"))) {
			if (this.screen === "form") await this.save();
			else if (this.screen === "model") this.applyModel();
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) this.selected = (this.selected + 1) % rows.length;
		else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) this.selected = (this.selected + rows.length - 1) % rows.length;
		else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(rows.length - 1, this.selected + this.pageSize);
		else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.pageSize);
		else if (this.screen === "models" && this.selected >= 4 && data === "e") this.editModel(this.pool()[this.selected - 4]!);
		else if (matchesKey(data, Key.enter) || (!row?.input && matchesKey(data, Key.space))) {
			if (row?.input) this.selected = (this.selected + 1) % rows.length;
			else await row?.run?.();
		} else if (row?.input) row.input.handleInput(data);
		else if (matchesKey(data, Key.right) && row?.label.includes("↔")) await row.run?.();
		this.selected = Math.min(this.selected, this.rows().length - 1);
		this.redraw();
	}

	render(width: number): string[] {
		const rows = this.rows();
		const inner = Math.max(1, width - 4);
		const message = plain(this.message);
		// Red is also the brand color; a failure must remain clear without color.
		const marker = message && (this.tone === "error" || this.tone === "warning") ? "! " : "";
		const feedback = message ? marker + message : (this.screen === "form" ? "Token is hidden · leave blank for a local server" : "");
		const feedbackRows = wrapTextWithAnsi(feedback, inner).slice(0, Math.max(1, this.height() - 9));
		this.pageSize = Math.max(1, this.height() - 5 - feedbackRows.length);
		this.scroll = Math.max(0, Math.min(this.scroll, rows.length - this.pageSize));
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + this.pageSize) this.scroll = this.selected - this.pageSize + 1;
		const fg = (tone: Tone, text: string) => this.theme.fg(tone, text);
		const title = {
			providers: "Providers", presets: "Add provider · choose a preset",
			form: this.original ? `Edit provider · ${this.original.name ?? this.original.id}` : "Add provider",
			models: `Models · ${this.draft?.models.length ?? 0} selected`, model: `Model · ${this.model?.id ?? ""}`,
			delete: `Delete ${this.original?.name ?? this.original?.id}?`, discard: "Discard unsaved changes?",
		}[this.screen];
		const subtitle = {
			providers: "Choose a provider to edit its settings or delete it.",
			presets: "Defaults are filled in for you. Everything stays editable.",
			form: "Edit the fields together. Changes apply only when you save.",
			models: "Space select · e edit settings · deselect to remove · Esc back",
			model: "Apply updates the draft. Save the provider to keep changes.",
			delete: `Removes ${this.original?.models.length ?? 0} model(s) from the picker and saved configuration.`,
			discard: "Your saved provider will stay as it was.",
		}[this.screen];
		const border = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 2)));
		const frame = (text: string) => {
			const clipped = truncateToWidth(text, inner);
			return this.theme.fg("borderMuted", "│") + " " + clipped
				+ " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + " " + this.theme.fg("borderMuted", "│");
		};
		const lines = [this.theme.fg("borderMuted", "╭") + border + this.theme.fg("borderMuted", "╮"),
			frame(this.theme.bold(fg("text", plain(title)))), frame(fg("muted", subtitle))];
		const labelWidth = Math.min(14, Math.max(8, Math.floor(inner / 3)));
		for (const [offset, row] of rows.slice(this.scroll, this.scroll + this.pageSize).entries()) {
			const active = this.scroll + offset === this.selected;
			let content: string;
			if (row.input) {
				const label = truncateToWidth(row.label, labelWidth, "");
				const available = Math.max(3, inner - labelWidth - 4);
				row.input.focused = active && this.focused;
				let value = row.input.getValue();
				if (active && value) {
					value = row.input.render(available)[0]!;
					if (row.secret && !row.input.getValue().startsWith("$")) {
						// Keep only Input's cursor markers; a secret never enters the rendered rows.
						value = value.split(/(\x1b\[7m|\x1b\[27m|\x1b_pi:c\x07)/).map((part) =>
							["\x1b[7m", "\x1b[27m", CURSOR_MARKER].includes(part) ? part : part.replace(/[^ ]/gu, "•")).join("");
					}
				} else value = value ? (row.secret ? maskToken(value) : plain(value))
					: `${active ? CURSOR_MARKER : ""}${fg("muted", row.placeholder ?? "")}`;
				content = fg("muted", label.padEnd(labelWidth)) + "  " + truncateToWidth(value, available);
			} else content = fg(row.tone ?? "text", plain(row.label));
			content = `${active ? "› " : "  "}${content}`;
			lines.push(frame(active ? this.theme.bg("selectedBg", content) : content));
		}
		const position = rows.length > this.pageSize ? ` · ${this.selected + 1}/${rows.length}` : "";
		for (const line of feedbackRows) lines.push(frame(fg(this.tone, line)));
		lines.push(frame(fg("muted", `${inner < 42 ? (this.screen === "form" || this.screen === "model" ? "Tab · ^S save · Esc" : "↑↓ · Enter · Esc") : (this.screen === "form" || this.screen === "model" ? "Tab next · Ctrl+S save · Esc back" : "↑↓ move · Enter select · Esc back")}${position}`)));
		lines.push(this.theme.fg("borderMuted", "╰") + border + this.theme.fg("borderMuted", "╯"));
		return lines.map((line) => truncateToWidth(line, width));
	}
}
