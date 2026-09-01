import { describe, expect, it, vi } from "vitest";
import type { HostServices, JsonSchema, ToolContent, ToolDefinition, ToolResult } from "../../core/ports.ts";
import { toPiTool } from "./tools.ts";

/**
 * The bridge from a core tool onto pi's registerTool shape. Thirty lines, and
 * every one of them is a place a tool can silently stop working: a dropped
 * `details` breaks the coverage counter that reads ids out of it, and a dropped
 * `terminate` means the scope gate cannot stop a run.
 */

const services = { fs: {}, clock: {}, ids: {} } as unknown as HostServices;

/** What a core tool hands back: content blocks, never a bare string. */
const say = (text: string): ToolContent[] => [{ type: "text", text }];
const result = (text: string, over: Partial<ToolResult> = {}): ToolResult => ({ content: say(text), ...over });

function coreTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "record",
		description: "write to the ledger",
		parameters: { type: "object", properties: { kind: { type: "string" } } },
		execute: async () => result("ok"),
		...over,
	} as ToolDefinition;
}

/** pi hands execute() a call id, params, a signal, an update callback and a ctx. */
function run(tool: ReturnType<typeof toPiTool>, params: unknown, ctx = { cwd: "/work" }) {
	return tool.execute("call-1", params as never, undefined as never, () => {}, ctx as never);
}

describe("bridging a core tool onto pi", () => {
	it("carries the name, label and description across", () => {
		const t = toPiTool(coreTool({ label: "Record" }), () => services);
		expect(t).toMatchObject({ name: "record", label: "Record", description: "write to the ledger" });
	});

	it("falls back to the name when a tool declares no label", () => {
		expect(toPiTool(coreTool(), () => services).label).toBe("record");
	});

	it("passes the parameter schema through untouched", () => {
		const parameters: JsonSchema = { type: "object", properties: { kind: { type: "string" } } };
		expect(toPiTool(coreTool({ parameters }), () => services).parameters).toBe(parameters);
	});

	it("hands the tool its context: params, cwd, services and the signal", async () => {
		const execute = vi.fn(async () => result("ok"));
		const t = toPiTool(coreTool({ execute }), () => services);
		await t.execute("call-1", { kind: "finding" } as never, "sig" as never, () => {}, { cwd: "/work" } as never);
		expect(execute).toHaveBeenCalledWith({ kind: "finding" }, { cwd: "/work", services, signal: "sig" });
	});

	it("resolves the services at call time, not at registration time", async () => {
		// The extension swaps its host services when an engagement opens; a bridge
		// that captured them at registration would hand every tool the old set.
		let current = { id: 1 } as unknown as HostServices;
		const execute = vi.fn(async () => result("ok"));
		const t = toPiTool(coreTool({ execute }), () => current);
		current = { id: 2 } as unknown as HostServices;
		await run(t, {});
		expect((execute.mock.calls[0] as unknown as [unknown, { services: HostServices }])[1].services).toBe(current);
	});

	it("returns the content the tool produced", async () => {
		const t = toPiTool(coreTool({ execute: async () => result("recorded 3 rows") }), () => services);
		expect(await run(t, {})).toMatchObject({ content: say("recorded 3 rows") });
	});

	it("preserves details, which is where the written ids travel", async () => {
		// The extension counts settled cells out of details.ids; losing this makes
		// coverage read zero beside a full ledger.
		const details = { kind: "hypothesis", ids: ["a", "b"] };
		const t = toPiTool(coreTool({ execute: async () => result("ok", { details }) }), () => services);
		expect((await run(t, {})).details).toEqual(details);
	});

	it("gives pi an empty object rather than undefined when there are no details", async () => {
		expect((await run(toPiTool(coreTool(), () => services), {})).details).toEqual({});
	});

	it("passes terminate through, which is how the scope gate stops a run", async () => {
		const stop = toPiTool(coreTool({ execute: async () => result("out of scope", { terminate: true }) }), () => services);
		expect(await run(stop, {})).toMatchObject({ terminate: true });
	});

	it("omits terminate entirely when the tool did not ask for it", async () => {
		expect(await run(toPiTool(coreTool(), () => services), {})).not.toHaveProperty("terminate");
	});

	it("lets a caller add presentation without touching behaviour", async () => {
		const renderResult = () => "rendered";
		const t = toPiTool(coreTool(), () => services, { renderResult } as never);
		expect(t.renderResult).toBe(renderResult);
		expect(await run(t, {})).toMatchObject({ content: say("ok") });
	});

	it("does not let presentation override the tool's own identity", () => {
		const t = toPiTool(coreTool(), () => services, { name: "impostor" } as never);
		expect(t.name).toBe("record");
	});

	it("lets a thrown tool error reach pi rather than swallowing it", async () => {
		const t = toPiTool(coreTool({ execute: async () => { throw new Error("out of scope"); } }), () => services);
		await expect(run(t, {})).rejects.toThrow("out of scope");
	});
});
