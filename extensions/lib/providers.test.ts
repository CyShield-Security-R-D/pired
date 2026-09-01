import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	apiKeyForProvider, mirrorProvidersToPi, piredModelsPath, readProviderFile, removeProvider, removeProviderFromPi,
	resolveKeyRef, toPiProvider, upsertProvider, writeProviderFile,
} from "./providers.ts";

const workspace = (): string => mkdtempSync(join(tmpdir(), "pired-providers-"));

const provider = (over: Record<string, unknown> = {}) => ({
	id: "lmstudio",
	baseUrl: "http://localhost:1234/v1",
	apiKey: "lmstudio",
	models: [{ id: "qwen3.8-27b", reasoning: true, contextWindow: 262144 }],
	...over,
});

describe("mirrorProvidersToPi", () => {
	it("writes providers where an extension-less pi process will find them", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([provider()] as never, p);
		const doc = JSON.parse(readFileSync(p, "utf8"));
		expect(doc.providers.lmstudio.baseUrl).toBe("http://localhost:1234/v1");
		expect(doc.providers.lmstudio.models[0].id).toBe("qwen3.8-27b");
		// pi's schema keys providers by id and defaults the API; a subagent child
		// resolves the model from exactly this shape.
		expect(doc.providers.lmstudio.api).toBe("openai-completions");
	});

	it("preserves a user's own providers and unrelated keys", () => {
		const p = join(workspace(), "models.json");
		writeFileSync(p, JSON.stringify({ providers: { mine: { baseUrl: "http://x/v1", models: [] } }, somethingElse: 42 }));
		mirrorProvidersToPi([provider()] as never, p);
		const doc = JSON.parse(readFileSync(p, "utf8"));
		expect(doc.providers.mine.baseUrl).toBe("http://x/v1");
		expect(doc.somethingElse).toBe(42);
		expect(doc.providers.lmstudio).toBeDefined();
	});

	it("updates an existing entry of the same id rather than duplicating it", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([provider()] as never, p);
		mirrorProvidersToPi([provider({ baseUrl: "http://moved:9/v1" })] as never, p);
		const doc = JSON.parse(readFileSync(p, "utf8"));
		expect(Object.keys(doc.providers)).toEqual(["lmstudio"]);
		expect(doc.providers.lmstudio.baseUrl).toBe("http://moved:9/v1");
	});

	it("does not rewrite the file when nothing changed", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([provider()] as never, p);
		const first = readFileSync(p, "utf8");
		writeFileSync(p, first); // same content, fresh mtime baseline
		mirrorProvidersToPi([provider()] as never, p);
		expect(readFileSync(p, "utf8")).toBe(first);
	});

	it("carries compat through — without it a qwen child returns an empty message", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([provider({ compat: { thinkingFormat: "qwen" } })] as never, p);
		expect(JSON.parse(readFileSync(p, "utf8")).providers.lmstudio.compat.thinkingFormat).toBe("qwen");
	});

	it("survives a malformed existing file rather than throwing into session start", () => {
		const p = join(workspace(), "models.json");
		writeFileSync(p, "{ not json");
		expect(() => mirrorProvidersToPi([provider()] as never, p)).not.toThrow();
		expect(JSON.parse(readFileSync(p, "utf8")).providers.lmstudio).toBeDefined();
	});

	it("writes nothing when there are no providers to mirror", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([], p);
		expect(() => readFileSync(p, "utf8")).toThrow();
	});
});

describe("readProviderFile / writeProviderFile", () => {
	it("round-trips a host and keeps anything else the file holds", () => {
		const p = join(workspace(), "models.json");
		writeFileSync(p, JSON.stringify({ providers: [provider()], note: "hand-written" }));
		const read = readProviderFile(p);
		expect(read.providers[0]?.id).toBe("lmstudio");
		expect(read.rest).toEqual({ note: "hand-written" });

		writeProviderFile(upsertProvider(read.providers, provider({ id: "ollama" }) as never), p, read.rest);
		const back = JSON.parse(readFileSync(p, "utf8"));
		expect(back.providers.map((c: { id: string }) => c.id)).toEqual(["lmstudio", "ollama"]);
		expect(back.note).toBe("hand-written");
	});

	it("keeps the file readable only by its owner, even one written before that mattered", () => {
		const p = join(workspace(), "models.json");
		// 0644, as an editor or an older pired would have left it.
		writeFileSync(p, JSON.stringify({ providers: [] }), { mode: 0o644 });
		writeProviderFile([provider({ apiKey: "sk-live-secret" })] as never, p);
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	it("reads a missing or malformed file as no hosts rather than throwing", () => {
		const dir = workspace();
		expect(readProviderFile(join(dir, "nothing.json")).providers).toEqual([]);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not json");
		expect(readProviderFile(bad).providers).toEqual([]);
	});
});

describe("upsertProvider / removeProvider", () => {
	it("replaces the entry of the same id in place", () => {
		const list = [provider(), provider({ id: "ollama" })] as never[];
		const next = upsertProvider(list, provider({ baseUrl: "http://moved:9/v1" }) as never);
		expect(next.map((c) => c.id)).toEqual(["lmstudio", "ollama"]);
		expect(next[0]?.baseUrl).toBe("http://moved:9/v1");
	});

	it("removes by id and leaves the rest alone", () => {
		const list = [provider(), provider({ id: "ollama" })] as never[];
		expect(removeProvider(list, "lmstudio").map((c) => c.id)).toEqual(["ollama"]);
		expect(removeProvider(list, "nothing-like-this")).toHaveLength(2);
	});
});

describe("removeProviderFromPi", () => {
	it("drops the mirrored copy too, so /model stops offering a deleted host", () => {
		const p = join(workspace(), "models.json");
		mirrorProvidersToPi([provider(), provider({ id: "ollama" })] as never, p);
		removeProviderFromPi("lmstudio", p);
		expect(Object.keys(JSON.parse(readFileSync(p, "utf8")).providers)).toEqual(["ollama"]);
	});

	it("leaves a file that never had the host, and one that cannot be read", () => {
		const dir = workspace();
		const p = join(dir, "models.json");
		mirrorProvidersToPi([provider()] as never, p);
		const before = readFileSync(p, "utf8");
		removeProviderFromPi("never-configured", p);
		expect(readFileSync(p, "utf8")).toBe(before);
		expect(() => removeProviderFromPi("lmstudio", join(dir, "absent.json"))).not.toThrow();
	});
});

describe("toPiProvider", () => {
	it("fills the defaults pi needs and carries compat down to the model", () => {
		const cfg = toPiProvider({
			id: "lmstudio", baseUrl: "http://localhost:1234/v1",
			compat: { thinkingFormat: "qwen" },
			models: [{ id: "qwen3-27b" }],
		}) as never as { name: string; apiKey: string; api: string; models: { name: string; contextWindow: number; maxTokens: number; compat: { thinkingFormat: string } }[] };
		expect(cfg.name).toBe("lmstudio");
		expect(cfg.apiKey).toBe("local");
		expect(cfg.api).toBe("openai-completions");
		expect(cfg.models[0]?.name).toBe("qwen3-27b");
		expect(cfg.models[0]?.contextWindow).toBe(32768);
		expect(cfg.models[0]?.maxTokens).toBe(8192);
		expect(cfg.models[0]?.compat.thinkingFormat).toBe("qwen");
	});
});

describe("resolveKeyRef", () => {
	it("resolves an env reference, so a key kept out of the file still reaches the model", () => {
		expect(resolveKeyRef("$LAB_TOKEN", { LAB_TOKEN: "sk-live" })).toBe("sk-live");
		expect(resolveKeyRef("${LAB_TOKEN}", { LAB_TOKEN: "sk-live" })).toBe("sk-live");
		expect(resolveKeyRef("Bearer-$A-$B", { A: "1", B: "2" })).toBe("Bearer-1-2");
	});

	it("leaves an unset variable as written, so the error names the variable", () => {
		expect(resolveKeyRef("$NOT_SET", {})).toBe("$NOT_SET");
	});

	it("passes a literal key and a command reference through untouched", () => {
		expect(resolveKeyRef("sk-or-v1-abc", {})).toBe("sk-or-v1-abc");
		expect(resolveKeyRef("!op read op://vault/key", { PATH: "/bin" })).toBe("!op read op://vault/key");
	});
});

describe("apiKeyForProvider", () => {
	it("finds the key in pired's file, in pi's mirror, and falls back to local", () => {
		const dir = workspace();
		const pired = join(dir, "pired.json");
		const mirror = join(dir, "pi.json");
		writeFileSync(pired, JSON.stringify({ providers: [provider({ apiKey: "sk-pired" })] }));
		mirrorProvidersToPi([provider({ id: "ollama", apiKey: "sk-mirrored" })] as never, mirror);
		expect(apiKeyForProvider("lmstudio", [pired, mirror])).toBe("sk-pired");
		expect(apiKeyForProvider("ollama", [pired, mirror])).toBe("sk-mirrored");
		expect(apiKeyForProvider("unconfigured", [pired, mirror])).toBe("local");
	});

	it("resolves an env-var key rather than sending the reference as the token", () => {
		const p = join(workspace(), "models.json");
		writeFileSync(p, JSON.stringify({ providers: [provider({ apiKey: "$PIRED_TEST_TOKEN" })] }));
		process.env.PIRED_TEST_TOKEN = "sk-from-env";
		try {
			expect(apiKeyForProvider("lmstudio", [p])).toBe("sk-from-env");
		} finally {
			delete process.env.PIRED_TEST_TOKEN;
		}
	});
});

describe("piredModelsPath", () => {
	it("resolves against the home directory as it is when asked, not at import", () => {
		const home = process.env.HOME;
		process.env.HOME = "/tmp/pired-home-probe";
		try {
			expect(piredModelsPath()).toBe("/tmp/pired-home-probe/.pired/models.json");
		} finally {
			if (home === undefined) delete process.env.HOME;
			else process.env.HOME = home;
		}
	});
});
