import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import hostsExtension, { loginPrompter } from "./hosts.ts";

/**
 * Both doors into the wizard, driven through the shapes pi actually uses.
 *
 * `/login` is the one that matters: pi builds that list from registered
 * providers, calls the chosen one's `login()` with callbacks that *reject* on
 * dismissal, and expects a credential back. None of that is obvious from the
 * types, and all of it is what the entry rests on.
 */
type Step = [match: string, answer: string | boolean | undefined];

function stubHost(available: unknown[] = [{ id: "already-configured" }]) {
	const home = mkdtempSync(join(tmpdir(), "pired-hosts-"));
	const seen = {
		commands: new Map<string, (a: string, c: unknown) => unknown>(),
		providers: new Map<string, Record<string, unknown>>(),
		unregistered: [] as string[],
		models: [] as unknown[],
	};
	const events = new Map<string, (e: unknown, c: unknown) => unknown>();
	const pi = {
		on: (e: string, h: (ev: unknown, c: unknown) => unknown) => events.set(e, h),
		registerCommand: (n: string, o: { handler: (a: string, c: unknown) => unknown }) => seen.commands.set(n, o.handler),
		registerProvider: (n: string, c: Record<string, unknown>) => seen.providers.set(n, c),
		unregisterProvider: (n: string) => seen.unregistered.push(n),
		setModel: async (m: unknown) => {
			seen.models.push(m);
			return true;
		},
	};
	const said: string[] = [];
	const asked: string[] = [];
	let script: Step[] = [];
	let at = 0;
	const answer = (title: string): string | boolean | undefined => {
		asked.push(title);
		const step = script[at++];
		if (!step) throw new Error(`unscripted dialog: ${title}`);
		expect(title, `dialog ${at}`).toContain(step[0]);
		return step[1];
	};
	const inHome = async <T>(steps: Step[], run: () => Promise<T>): Promise<T> => {
		script = steps;
		at = 0;
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			return await run();
		} finally {
			if (previous === undefined) delete process.env.HOME;
			else process.env.HOME = previous;
		}
	};

	// The extension registers against the temp home too: it reads the host file
	// at load to contribute what is already configured.
	const previous = process.env.HOME;
	process.env.HOME = home;
	try {
		hostsExtension(pi as never);
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}

	const ctx = {
		hasUI: true,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAvailable: () => available,
		},
		ui: {
			notify: (m: string) => void said.push(m),
			select: async (t: string) => answer(t) as string | undefined,
			input: async (t: string) => answer(t) as string | undefined,
			confirm: async (t: string) => answer(t) as boolean,
		},
	};

	/** pi's login callbacks: a dismissal rejects, and onSelect answers with an id. */
	const callbacks = {
		onAuth: () => {},
		onDeviceCode: () => {},
		onProgress: (m: string) => void said.push(m),
		onPrompt: async (p: { message: string }) => {
			const value = answer(p.message);
			if (value === undefined) throw new Error("Login cancelled");
			return String(value);
		},
		onSelect: async (p: { message: string; options: { id: string; label: string }[] }) => {
			const value = answer(p.message);
			if (value === undefined) throw new Error("Login cancelled");
			const label = typeof value === "boolean" ? (value ? "Yes" : "No") : value;
			const hit = p.options.find((o) => o.label === label);
			expect(hit, `no option "${label}" in [${p.options.map((o) => o.label).join(" | ")}]`).toBeDefined();
			return hit?.id;
		},
	};

	// pi hands every extension a context on session_start; this one is how the
	// login flow reports an outcome after its dialog has closed.
	events.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

	return {
		seen,
		said,
		asked,
		modelsPath: join(home, ".pired", "models.json"),
		mirrorPath: join(home, ".pi", "agent", "models.json"),
		command: (args: string, steps: Step[] = []) => inHome(steps, async () => {
			await seen.commands.get("provider")?.(args, ctx);
		}),
		/** Wait past the deferred last word, without knowing its timer. */
		settle: async () => {
			await new Promise((r) => setTimeout(r, 800));
		},
		/** What pi does when the operator picks our row in /login. */
		login: (steps: Step[]) => inHome(steps, async () => {
			const entry = seen.providers.get("add-provider") as { oauth?: { login: (cb: unknown) => Promise<unknown> } };
			expect(entry?.oauth, "no /login entry registered").toBeDefined();
			return await entry.oauth?.login(callbacks);
		}),
	};
}

const A_HOST: Step[] = [
	["add a provider", "Other OpenAI-compatible host…"],
	["Base URL", "http://127.0.0.1:1/v1"],
	["Which API", "openai-completions — LM Studio, Ollama, vLLM, OpenRouter, most gateways"],
	["API token", "$LAB_TOKEN"],
	["Model id", "my-model"],
	["Context window", "128000"],
	["output tokens", ""],
	["think before it answers", true],
	["returns its thinking", "qwen — Qwen/QwQ on LM Studio, vLLM, llama.cpp (reasoning_content)"],
	["Another model", false],
	["Provider id", "lab"],
	["Add lab?", true],
	["Switch to my-model now?", false],
];

describe("a first run with no model", () => {
	it("says what to do about it, since nothing else in the harness can run first", () => {
		const host = stubHost([]);
		expect(host.said.join("\n")).toContain("no model yet");
		expect(host.said.join("\n")).toContain("/provider");
	});

	it("stays quiet when a model is already configured", () => {
		expect(stubHost().said.join("\n")).not.toContain("no model yet");
	});
});

describe("the /login entry", () => {
	it("registers a provider pi will list, with a login that is the wizard", () => {
		const host = stubHost();
		const entry = host.seen.providers.get("add-provider") as { name: string; oauth: { name: string; getApiKey: () => string } };
		expect(entry.name).toContain("Add a custom provider");
		expect(entry.oauth.name).toContain("Add a custom provider");
		// No models, so the row that adds a host never shows up as one to talk to.
		expect((entry as { models?: unknown[] }).models).toBeUndefined();
	});

	it("writes the host, registers it, mirrors it, and hands pi a credential", async () => {
		const host = stubHost();
		const credential = await host.login(A_HOST) as { access: string; expires: number };

		expect(JSON.parse(readFileSync(host.modelsPath, "utf8")).providers).toEqual([{
			id: "lab", name: "lab", baseUrl: "http://127.0.0.1:1/v1", apiKey: "$LAB_TOKEN", api: "openai-completions",
			models: [{ id: "my-model", contextWindow: 128000, maxTokens: 8192, reasoning: true, compat: { thinkingFormat: "qwen" } }],
		}]);
		// A file holding a client's token has no business being world-readable.
		expect(statSync(host.modelsPath).mode & 0o777).toBe(0o600);
		expect(host.seen.providers.get("lab")?.baseUrl).toBe("http://127.0.0.1:1/v1");
		expect(JSON.parse(readFileSync(host.mirrorPath, "utf8")).providers.lab.models[0].id).toBe("my-model");
		// The acknowledgement rides on the last question, because pi's own
		// "Logged in to…" status replaces anything notified after this returns.
		expect(host.asked.join("\n")).toContain("Added lab · 1 model(s)");
		// pi stores whatever login returns; ours is a marker it must never refresh.
		expect(credential.access).toBe("pired-host");
		expect(credential.expires).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("switches to the model it just added, which /login itself cannot do", async () => {
		const host = stubHost();
		await host.login([...A_HOST.slice(0, -1), ["Switch to my-model now?", true]]);
		expect(host.seen.models).toEqual([{ provider: "lab", id: "my-model" }]);
		expect(host.said.join("\n")).toContain("model is now lab/my-model");
	});

	/**
	 * The first-run ending. pi closes a login it began with no model by printing,
	 * in red, that the row that was logged into has no default model — after the
	 * model that was actually added is already selected. It cannot be suppressed
	 * from here, so pired waits for it and answers it.
	 */
	it("has the last word when the session began with no model at all", async () => {
		const host = stubHost([]);
		await host.login([...A_HOST.slice(0, -1), ["Switch to my-model now?", true]]);
		expect(host.seen.models).toEqual([{ provider: "lab", id: "my-model" }]);
		// Nothing yet: saying it now would be buried under pi's own two lines.
		expect(host.said.join("\n")).not.toContain("model is now");
		await host.settle();
		expect(host.said.join("\n")).toContain("model is now lab/my-model");
		expect(host.said.join("\n")).toContain("about the /login row");
	});

	it("reads a dismissal as a cancelled login rather than half a host", async () => {
		const host = stubHost();
		await expect(host.login([["add a provider", undefined]])).rejects.toThrow("Login cancelled");
		expect(() => readFileSync(host.modelsPath, "utf8")).toThrow();
	});
});

describe("loginPrompter", () => {
	it("turns pi's rejection into the undefined the wizard reads as backing out", async () => {
		const cancelling = {
			onAuth: () => {}, onDeviceCode: () => {},
			onPrompt: async () => {
				throw new Error("Login cancelled");
			},
			onSelect: async () => {
				throw new Error("Login cancelled");
			},
		};
		const ui = loginPrompter(cancelling as never);
		expect(await ui.input("anything")).toBeUndefined();
		expect(await ui.select("anything", ["a"])).toBeUndefined();
		expect(await ui.confirm("anything", "")).toBe(false);
	});

	it("lets a real failure through rather than reading it as a dismissal", async () => {
		const broken = {
			onAuth: () => {}, onDeviceCode: () => {},
			onPrompt: async () => {
				throw new Error("terminal is gone");
			},
			onSelect: async () => {
				throw new Error("terminal is gone");
			},
		};
		const ui = loginPrompter(broken as never);
		await expect(ui.input("anything")).rejects.toThrow("terminal is gone");
		await expect(ui.select("anything", ["a"])).rejects.toThrow("terminal is gone");
	});
});

describe("/provider", () => {
	it("adds through the command too, and switches to the model", async () => {
		const host = stubHost();
		await host.command("", [...A_HOST.slice(0, -1), ["Switch to my-model now?", true]]);
		expect(JSON.parse(readFileSync(host.modelsPath, "utf8")).providers).toHaveLength(1);
		expect(host.seen.models).toEqual([{ provider: "lab", id: "my-model" }]);
		expect(host.said.join("\n")).toContain("model is now lab/my-model");
	});

	it("lists what is configured, and says where when there is nothing", async () => {
		const host = stubHost();
		await host.command("list");
		expect(host.said.join("\n")).toContain("no providers in");
		host.said.length = 0;

		await host.login(A_HOST);
		host.said.length = 0;
		await host.command("list");
		expect(host.said.join("\n")).toContain("lab — http://127.0.0.1:1/v1");
		expect(host.said.join("\n")).toContain("my-model");
	});

	it("removes a host from both files and from the picker, once confirmed", async () => {
		const host = stubHost();
		await host.login(A_HOST);
		await host.command("remove lab", [["Remove lab?", true]]);
		expect(JSON.parse(readFileSync(host.modelsPath, "utf8")).providers).toEqual([]);
		expect(JSON.parse(readFileSync(host.mirrorPath, "utf8")).providers.lab).toBeUndefined();
		expect(host.seen.unregistered).toEqual(["lab"]);
	});

	it("keeps the host when the removal is declined", async () => {
		const host = stubHost();
		await host.login(A_HOST);
		await host.command("remove lab", [["Remove lab?", false]]);
		expect(JSON.parse(readFileSync(host.modelsPath, "utf8")).providers).toHaveLength(1);
		expect(host.said.join("\n")).toContain("nothing removed");
	});

	it("names the id it does not have rather than removing something else", async () => {
		const host = stubHost();
		await host.command("remove nope");
		expect(host.said.join("\n")).toContain('no provider called "nope"');
		await host.command("remove");
		expect(host.said.join("\n")).toContain("/provider remove <id>");
	});
});
