/**
 * LLM hosts, from inside pi's own `/login`.
 *
 * pired contributes every OpenAI-compatible host in ~/.pired/models.json to
 * pi's `/model` picker. Getting one *into* that file used to mean writing JSON
 * by hand — base URL, token, context window, and the `thinkingFormat` switch
 * whose wrong value makes a reasoning model answer with nothing at all.
 *
 * `/login` is where someone already goes to give a tool access to a model, so
 * that is where this lives rather than behind a command of its own: pi builds
 * that list from every registered provider that offers an auth method, so an
 * extension can put an entry in it by registering one. The entry's "login" is
 * the host wizard, and what it saves is a host rather than a credential.
 *
 * A separate extension from pired.ts, because none of this is the security
 * layer: it needs no engagement, no workspace and no scope, and a plain pi
 * loading only this file gets host management with nothing else attached.
 */

import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addHost, describeHost, type Prompter } from "./lib/provider-wizard.ts";
import {
	type LocalProviderConfig, mirrorProvidersToPi, piredModelsPath, readProviderFile, registerPiredProviders,
	removeProvider, removeProviderFromPi, toPiProvider, upsertProvider, writeProviderFile,
} from "./lib/providers.ts";

/**
 * The provider id that exists only to put a row in `/login`.
 *
 * It serves no models, so it never appears in `/model`; pi requires an auth
 * method on every provider, and the one it offers is this flow.
 */
const ADD_PROVIDER_ID = "add-provider";
const ADD_PROVIDER_LABEL = "Add a custom provider…";

/**
 * pi's login prompts, as the wizard's four dialogs.
 *
 * The difference worth knowing: a dismissed login prompt *rejects* with "Login
 * cancelled" rather than resolving undefined, and the same rejection aborts the
 * whole login dialog. The wizard speaks undefined, so the two are translated
 * here and nowhere else.
 */
export function loginPrompter(cb: OAuthLoginCallbacks): Prompter {
	const dismissed = (err: unknown): boolean => err instanceof Error && /cancel/i.test(err.message);
	return {
		select: async (title, options) => {
			try {
				return await cb.onSelect({ message: title, options: options.map((o) => ({ id: o, label: o })) });
			} catch (err) {
				if (dismissed(err)) return undefined;
				throw err;
			}
		},
		input: async (title) => {
			try {
				// allowEmpty because an empty answer is how the wizard offers a default.
				return await cb.onPrompt({ message: title, allowEmpty: true });
			} catch (err) {
				if (dismissed(err)) return undefined;
				throw err;
			}
		},
		confirm: async (title, message) => {
			try {
				const answer = await cb.onSelect({
					message: `${title}\n${message}`,
					options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
				});
				return answer === "yes";
			} catch (err) {
				if (dismissed(err)) return false;
				throw err;
			}
		},
		notify: (message) => cb.onProgress?.(message),
	};
}

/**
 * Write the host, then register it everywhere it has to be known.
 *
 * Three places, and missing any one of them is a different silent failure: the
 * file is what survives a restart, `registerProvider` is what puts it in this
 * session's picker, and the mirror is what an extension-less subagent child
 * resolves its model from — a child that cannot resolve a model hangs at zero
 * tokens rather than reporting anything.
 */
export function saveHost(pi: ExtensionAPI, config: LocalProviderConfig): void {
	const path = piredModelsPath();
	const { providers, rest } = readProviderFile(path);
	const next = upsertProvider(providers, config);
	writeProviderFile(next, path, rest);
	pi.registerProvider(config.id, toPiProvider(config));
	mirrorProvidersToPi(next);
}

/** Drop it from the file, the mirror, and this session's picker. */
export function forgetHost(pi: ExtensionAPI, id: string): void {
	const path = piredModelsPath();
	const { providers, rest } = readProviderFile(path);
	writeProviderFile(removeProvider(providers, id), path, rest);
	removeProviderFromPi(id);
	// Optional on older hosts, like registerEntryRenderer in pired.ts.
	pi.unregisterProvider?.(id);
}

export default function hostsExtension(pi: ExtensionAPI): void {
	// Also done by pired.ts, deliberately: each extension has to be correct on
	// its own, since either can be loaded without the other, and registering the
	// same host twice replaces it with itself.
	registerPiredProviders(pi);

	/**
	 * A context, for the one thing the login callbacks cannot do.
	 *
	 * `login()` is handed callbacks, not a context, so switching to the model
	 * that was just added — which needs the model registry — has nowhere to come
	 * from otherwise. Every extension is handed a context at session start, so
	 * this keeps that one.
	 *
	 * Saying anything through it afterwards is not an option: pi draws its own
	 * "Logged in to…" status the moment the flow returns, and that status
	 * *replaces* an extension's notification in place rather than appearing
	 * under it. Which is why the wizard reports what it saved while its own
	 * dialog is still open.
	 */
	let seen: ExtensionContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		seen = ctx;
		announceIfModelless(ctx);
	});

	pi.registerProvider(ADD_PROVIDER_ID, {
		name: ADD_PROVIDER_LABEL,
		oauth: {
			name: ADD_PROVIDER_LABEL,
			login: async (cb: OAuthLoginCallbacks): Promise<OAuthCredentials> => {
				const { providers } = readProviderFile();
				const added = await addHost(loginPrompter(cb), {
					existing: providers,
					savedTo: piredModelsPath(),
					save: (config) => saveHost(pi, config),
				});
				// pi treats this rejection as a dismissal and says nothing, which is
				// what backing out of a wizard should look like.
				if (!added) throw new Error("Login cancelled");
				// The wizard has already said what it saved, inside the dialog. All
				// that is left is the switch, which needs a context /login never hands
				// out — hence the one captured at session start.
				if (added.useModelId && seen) await useModel(pi, seen, added.config.id, added.useModelId);
				// A login has to return a credential; this flow's secret went to the
				// host's own entry, so what is stored here is a marker with an expiry
				// far enough out that pi never tries to refresh it.
				return { access: "pired-host", refresh: "", expires: Number.MAX_SAFE_INTEGER };
			},
			refreshToken: async (credentials: OAuthCredentials) => credentials,
			getApiKey: () => "local",
		},
	});

	/**
	 * What `/login` cannot do: show what is configured, and take one away.
	 *
	 * Adding is here too, for anyone who would rather type the noun than find it
	 * in a list of providers — it is the same wizard, driven through pi's plain
	 * dialogs instead of the login dialog's prompts.
	 */
	pi.registerCommand("provider", {
		description: "Add an LLM provider — base URL, model, token — the wizard `/login` also opens; `list` | `remove <id>`",
		handler: async (args, ctx) => {
			const [verb = "", rest = ""] = (args ?? "").trim().split(/\s+/, 2);
			const path = piredModelsPath();
			const { providers } = readProviderFile(path);

			if (verb.toLowerCase() === "list") {
				if (providers.length === 0) {
					ctx.ui.notify(`pired: no providers in ${path} — \`/provider\` or \`/login\` adds one`, "info");
					return;
				}
				const lines = providers.flatMap((p) => [`${p.id} — ${p.baseUrl}`, ...p.models.map((m) => `  · ${m.id}`)]);
				ctx.ui.notify(`pired: ${providers.length} provider(s) in ${path}\n${lines.join("\n")}`, "info");
				return;
			}

			if (verb.toLowerCase() === "remove") {
				const id = rest.trim();
				const hit = providers.find((p) => p.id === id);
				if (!hit) {
					ctx.ui.notify(id ? `pired: no provider called "${id}" — /provider list shows them` : "pired: /provider remove <id>", "warning");
					return;
				}
				if (ctx.hasUI && !(await ctx.ui.confirm(`Remove ${hit.name ?? hit.id}?`, describeHost(hit).join("\n")))) {
					ctx.ui.notify("pired: nothing removed", "info");
					return;
				}
				try {
					forgetHost(pi, id);
				} catch (err) {
					ctx.ui.notify(`pired: could not remove ${id} — ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				ctx.ui.notify(`pired: removed ${id} — a model already in use stays until restart`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`pired: adding a host needs the terminal UI — edit ${path}, see docs/models.md`, "warning");
				return;
			}

			const added = await addHost(ctx.ui, {
				existing: providers,
				savedTo: path,
				save: (config) => saveHost(pi, config),
			});
			if (!added) return;
			ctx.ui.notify(
				`pired: ${added.updated ? "updated" : "added"} ${added.config.id} · ${added.config.models.length} model(s) — in /model now`,
				"info",
			);
			if (added.useModelId) await useModel(pi, ctx, added.config.id, added.useModelId);
		},
	});
}

/**
 * On a box with no model at all, say what to do about it in pired's own terms.
 *
 * pi already warns — but it points at two markdown files inside its own
 * node_modules, and says nothing about the case pired exists for: a model
 * already running on this machine, two questions away. This is the first thing
 * a new operator sees, and until it is answered nothing else in the harness can
 * run, so it is worth a line of its own.
 */
function announceIfModelless(ctx: ExtensionContext): void {
	try {
		if (ctx.modelRegistry.getAvailable().length > 0) return;
	} catch {
		// A host without a registry snapshot: say nothing rather than guess.
		return;
	}
	ctx.ui.notify(
		"pired: no model yet — `/provider` adds one you are already running (LM Studio, Ollama, llama.cpp, vLLM), `/login` signs in to a hosted one",
		"warning",
	);
}

/** Switch to what was just added, which is why it was added. */
async function useModel(pi: ExtensionAPI, ctx: ExtensionContext, provider: string, modelId: string): Promise<void> {
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) {
		ctx.ui.notify(`pired: ${modelId} is registered but pi did not resolve it — pick it from /model`, "warning");
		return;
	}
	// setModel reports false when there is no usable key rather than throwing,
	// and is absent altogether on a pi older than the model-switching API.
	const switched = await pi.setModel?.(model);
	ctx.ui.notify(
		switched === true
			? `pired: model is now ${provider}/${modelId}`
			: switched === false
				? `pired: ${modelId} needs a key pi can resolve — check the token and try /model`
				: `pired: ${modelId} is registered — pick it from /model`,
		switched === true ? "info" : "warning",
	);
}
