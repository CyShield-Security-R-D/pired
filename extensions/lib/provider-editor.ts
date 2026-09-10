/**
 * Edit what is already configured: a host's URL and token, and each model's
 * parameters.
 *
 * The wizard next door adds a host. Everything after that — a base URL that
 * moved, a context window the probe guessed wrong, a model the server no longer
 * serves — meant opening ~/.pired/models.json in an editor and knowing the
 * schema, which is the same wall the wizard was written to take down. This is
 * that file as menus.
 *
 * Every row carries its own current value, so opening a menu answers "what is
 * this set to" without changing anything, and every edit is written the moment
 * it is made rather than collected into a form that can be abandoned half
 * filled. The menu then redraws from disk, so what is on screen is what was
 * saved — not what this module believes it saved.
 *
 * Written against the same four-method Prompter as the wizard, and for the same
 * reason: it can be driven by a fake, so the flow has tests rather than a
 * description of how someone once clicked through it.
 */

import {
	type AddHostResult, API_DIALECTS, describeModel, draftModel, editModelFields, maskToken,
	type ModelProbe, normalizeBaseUrl, pickModels, probeModels, type Prompter,
} from "./provider-wizard.ts";
import type { LocalModelDef, LocalProviderConfig, ProviderCompat } from "./providers.ts";

type Model = LocalModelDef & { compat?: ProviderCompat };

export interface ProviderEditorDeps {
	/** Re-read on every redraw, so a menu shows the file rather than a memory of it. */
	load(): LocalProviderConfig[];
	save(config: LocalProviderConfig): void | Promise<void>;
	remove(id: string): void | Promise<void>;
	/** The add wizard, injected so this module need not own its options. */
	add?: () => Promise<AddHostResult | undefined>;
	probe?: ModelProbe;
	savedTo?: string;
}

export interface ManageResult {
	/** A model the operator asked to switch to, once it is registered. */
	useModelId?: string;
	providerId?: string;
}

const BACK = "← Back";
const DONE = "✓ Done";
const ADD_PROVIDER = "+ Add a provider…";
const ADD_MODELS = "+ Add models…";
const REMOVE_MODEL = "− Remove a model…";
const REMOVE_PROVIDER = "− Remove this provider";

/** One host as a row: what it is called, where it is, and how much it serves. */
export function providerRow(p: LocalProviderConfig): string {
	const n = p.models.length;
	return `${p.id} — ${p.baseUrl} · ${n} model${n === 1 ? "" : "s"}`;
}

/**
 * The top menu: every configured host, and the way to add one.
 *
 * Returns whatever the add wizard asked to switch to, since that request has to
 * survive back out to the command — the model registry lives there.
 */
export async function manageProviders(ui: Prompter, deps: ProviderEditorDeps): Promise<ManageResult> {
	let result: ManageResult = {};
	for (;;) {
		const providers = deps.load();
		const byLabel = new Map<string, string>();
		const rows = providers.map((p) => {
			const label = providerRow(p);
			byLabel.set(label, p.id);
			return label;
		});

		const picked = await ui.select(
			providers.length > 0
				? `pired · providers${deps.savedTo ? ` · ${deps.savedTo}` : ""}`
				: "pired · no providers configured yet",
			[...rows, ADD_PROVIDER, DONE],
		);
		if (picked === undefined || picked === DONE) return result;

		if (picked === ADD_PROVIDER) {
			const added = await deps.add?.();
			if (added) result = { providerId: added.config.id, ...(added.useModelId ? { useModelId: added.useModelId } : {}) };
			continue;
		}

		const id = byLabel.get(picked);
		if (id !== undefined) await editProvider(ui, deps, id);
	}
}

/** One host's own settings, plus the way into its models. */
export async function editProvider(ui: Prompter, deps: ProviderEditorDeps, id: string): Promise<void> {
	for (;;) {
		const provider = deps.load().find((p) => p.id === id);
		// It can genuinely be gone: removing it below returns through here.
		if (!provider) return;

		const url = `Base URL   ${provider.baseUrl}`;
		const token = `Token      ${maskToken(provider.apiKey ?? "local")}`;
		const api = `API        ${provider.api ?? "openai-completions"}`;
		const models = `Models (${provider.models.length})…`;

		const picked = await ui.select(`${provider.name ?? provider.id} — pick a field to change`,
			[url, token, api, models, REMOVE_PROVIDER, BACK]);
		if (picked === undefined || picked === BACK) return;

		if (picked === url) {
			const raw = await ui.input(`Base URL for ${provider.id} — Enter to keep ${provider.baseUrl}`);
			if (raw === undefined) continue;
			const next = raw.trim() ? normalizeBaseUrl(raw) : provider.baseUrl;
			if (next) await deps.save({ ...provider, baseUrl: next });
		} else if (picked === token) {
			const raw = await ui.input(`API token for ${provider.id} — Enter to keep it, or $ENV_VAR to keep the key out of the file`);
			if (raw === undefined) continue;
			if (raw.trim()) await deps.save({ ...provider, apiKey: raw.trim() });
		} else if (picked === api) {
			const dialect = await ui.select(`Which API does ${provider.id} speak?`, API_DIALECTS.map((d) => d.label));
			if (dialect === undefined) continue;
			const next = API_DIALECTS.find((d) => d.label === dialect)?.id;
			if (next) await deps.save({ ...provider, api: next });
		} else if (picked === models) {
			await editProviderModels(ui, deps, id);
		} else if (await ui.confirm(`Remove ${provider.name ?? provider.id}?`, `${providerRow(provider)}\nA model already in use stays until restart.`)) {
			await deps.remove(id);
			return;
		}
	}
}

/** A host's models: one row each, and the ways to add and take away. */
export async function editProviderModels(ui: Prompter, deps: ProviderEditorDeps, id: string): Promise<void> {
	for (;;) {
		const provider = deps.load().find((p) => p.id === id);
		if (!provider) return;

		const byLabel = new Map<string, number>();
		const rows = provider.models.map((m, i) => {
			const label = `  ${describeModel(m)}`;
			byLabel.set(label, i);
			return label;
		});
		const extras = provider.models.length > 0 ? [ADD_MODELS, REMOVE_MODEL, BACK] : [ADD_MODELS, BACK];

		const picked = await ui.select(`${provider.id} · models — pick one to change`, [...rows, ...extras]);
		if (picked === undefined || picked === BACK) return;

		if (picked === ADD_MODELS) {
			await addModelsTo(ui, deps, provider);
			continue;
		}
		if (picked === REMOVE_MODEL) {
			await removeModelFrom(ui, deps, provider);
			continue;
		}

		const at = byLabel.get(picked);
		const target = at === undefined ? undefined : provider.models[at];
		if (at === undefined || target === undefined) continue;
		const edited = await editModelFields(ui, target, provider.baseUrl);
		await deps.save({ ...provider, models: provider.models.map((m, i) => (i === at ? edited : m)) });
	}
}

/**
 * Ask the host what else it serves, and add from that.
 *
 * The models already configured are held back from the list: offering one that
 * is already there invites a duplicate, and the file has no way to tell two
 * entries with the same id apart.
 */
async function addModelsTo(ui: Prompter, deps: ProviderEditorDeps, provider: LocalProviderConfig): Promise<void> {
	let probed: Awaited<ReturnType<ModelProbe>> = [];
	try {
		probed = await (deps.probe ?? probeModels)(provider.baseUrl, provider.apiKey ?? "local");
	} catch (err) {
		ui.notify(`pired: ${provider.baseUrl}/models did not answer — ${err instanceof Error ? err.message : String(err)}`, "warning");
	}

	const already = provider.models.map((m) => m.id);
	const picked = await pickModels(ui, probed, { already });
	if (picked === undefined || picked.length === 0) return;

	const drafts: Model[] = picked.map((mid) => draftModel(mid, provider.baseUrl, probed));
	const reviewed: Model[] = [];
	for (const draft of drafts) reviewed.push(await editModelFields(ui, draft, provider.baseUrl));
	await deps.save({ ...provider, models: [...provider.models, ...reviewed] });
	ui.notify(`pired: added ${reviewed.length} model${reviewed.length === 1 ? "" : "s"} to ${provider.id}`, "info");
}

/** Take one model off, and say so when that leaves the host serving nothing. */
async function removeModelFrom(ui: Prompter, deps: ProviderEditorDeps, provider: LocalProviderConfig): Promise<void> {
	const byLabel = new Map<string, string>();
	const rows = provider.models.map((m) => {
		const label = `  ${describeModel(m)}`;
		byLabel.set(label, m.id);
		return label;
	});

	const picked = await ui.select(`${provider.id} · remove which model?`, [...rows, BACK]);
	if (picked === undefined || picked === BACK) return;
	const mid = byLabel.get(picked);
	if (mid === undefined) return;

	const models = provider.models.filter((m) => m.id !== mid);
	await deps.save({ ...provider, models });
	ui.notify(
		models.length === 0
			? `pired: removed ${mid} — ${provider.id} now serves nothing, so it will not appear in /model`
			: `pired: removed ${mid} from ${provider.id}`,
		models.length === 0 ? "warning" : "info",
	);
}
