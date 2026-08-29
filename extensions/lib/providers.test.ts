import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mirrorProvidersToPi } from "./providers.ts";

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
