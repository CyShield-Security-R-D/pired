import { describe, expect, it } from "vitest";
import { createMcpDenials, gateMcpCall, MCP_APPROVAL_EVENT, mcpCallName, type McpApprovalRequest } from "./mcp.ts";
import type { EngagementScope } from "./ontology.ts";
import { createScopeGate } from "./scope.ts";

const scope: EngagementScope = {
	v: 1,
	engagement: "acme",
	authorized: true,
	mode: "enforce",
	targets: { domains: ["*.acme.test", "acme.test"], ips: ["10.0.0.5"] },
};

/** A request as pi-mcp-adapter emits it, recording what the listener claimed. */
function request(serverName: string, originalToolName: string, args: Record<string, unknown>, origin = "proxy"): McpApprovalRequest & { claimed: string[] } {
	const claimed: string[] = [];
	return {
		serverName,
		originalToolName,
		args,
		origin,
		claimed,
		claim(handler) {
			if (claimed.length > 0) return false;
			claimed.push(handler());
			return true;
		},
	};
}

describe("gateMcpCall", () => {
	it("listens on the event name pi-mcp-adapter emits, which a typo would turn into a gate that never runs", () => {
		expect(MCP_APPROVAL_EVENT).toBe("pi-mcp-adapter:tool-approval-request");
	});

	it("leaves an in-scope call unclaimed, so the adapter's own approval settings still decide it", () => {
		const r = request("fetch", "fetch", { url: "https://app.acme.test/login" });
		expect(gateMcpCall(createScopeGate(scope), r)).toEqual({ allow: true });
		expect(r.claimed).toEqual([]);
	});

	it("denies a call to an out-of-scope URL, and gives the gate's reason back to the host", () => {
		const r = request("fetch", "fetch", { url: "https://evil.example/x" });
		const decision = gateMcpCall(createScopeGate(scope), r);
		expect(decision?.allow).toBe(false);
		expect(decision?.reason).toMatch(/evil\.example/);
		expect(r.claimed).toEqual(["deny"]);
	});

	it("denies a bare out-of-scope host the model passed inside a JSON string, which the tool_call scan reads as plain text", () => {
		// `mcp({tool, args: "{\"host\":\"10.9.9.9\"}"})` reaches pi's tool_call hook with the host inside
		// a string under `args`, not under a target key; the adapter parses it before asking for approval.
		const r = request("nmap", "scan", { host: "10.9.9.9", ports: "1-1024" });
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(false);
		expect(r.claimed).toEqual(["deny"]);
	});

	it("gates a call an mcpScript makes from inside its JavaScript, which pi's tool_call hook never sees", () => {
		const r = request("browser", "navigate_page", { url: "http://10.9.9.9:8080/" }, "script");
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(false);
		expect(r.claimed).toEqual(["deny"]);
	});

	it("does not wave through a server's tool named `read` as pired's own local file read, whatever toolPrefix is set", () => {
		// With toolPrefix "none" a server's tool can carry a built-in's name; the gate allows `read` unconditionally.
		const r = request("files", "read", { url: "https://evil.example/secret" });
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(false);
		expect(mcpCallName("files", "read")).toBe("mcp__files__read");
	});

	it("does not parse a server's tool named `bash` as a shell command", () => {
		const r = request("shell", "bash", { command: "ls", target: "evil.example" });
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(false);
	});

	it("allows a call with no network target, such as a search or a local database query", () => {
		const r = request("db", "query", { sql: "select 1" });
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(true);
		expect(r.claimed).toEqual([]);
	});

	it("only warns under a warn-mode scope, as it does for every other tool", () => {
		const r = request("fetch", "fetch", { url: "https://evil.example/" });
		expect(gateMcpCall(createScopeGate({ ...scope, mode: "warn" }), r)?.allow).toBe(true);
		expect(r.claimed).toEqual([]);
	});

	it("blocks network MCP calls on an engagement not marked authorized", () => {
		const r = request("fetch", "fetch", { url: "https://app.acme.test/" });
		expect(gateMcpCall(createScopeGate({ ...scope, authorized: false }), r)?.allow).toBe(false);
	});

	it("ignores an event payload it cannot read rather than throwing inside the adapter's approval path", () => {
		const gate = createScopeGate(scope);
		expect(gateMcpCall(gate, undefined)).toBeUndefined();
		expect(gateMcpCall(gate, { serverName: "x" })).toBeUndefined();
		expect(gateMcpCall(gate, { serverName: "x", originalToolName: "y", claim: "no" })).toBeUndefined();
	});

	it("gates a request that carries no arguments as a call with none", () => {
		const r = request("db", "list", {});
		delete (r as { args?: unknown }).args;
		expect(gateMcpCall(createScopeGate(scope), r)?.allow).toBe(true);
	});
});

describe("createMcpDenials", () => {
	const denied = (server: string, tool: string) => ({
		toolName: "mcp",
		content: [{ type: "text", text: `The user declined approval to run MCP tool "${tool}" on server "${server}".` }],
		details: { mode: "call", error: "approval_denied", server, tool },
	});

	it("replaces the adapter's 'the user declined' with the scope's reason, because a model told the operator said no asks the operator", () => {
		const d = createMcpDenials();
		d.record("fetch", "fetch", "Out-of-scope target(s): evil.example.");
		const text = d.explain(denied("fetch", "fetch"))?.[0]?.text ?? "";
		expect(text).toMatch(/engagement scope blocked MCP tool "fetch" on server "fetch", not the operator/);
		expect(text).toMatch(/evil\.example/);
		expect(text).not.toMatch(/user declined/);
	});

	it("leaves a denial the operator made in the adapter's own prompt as the adapter worded it", () => {
		const d = createMcpDenials();
		d.record("fetch", "fetch", "Out-of-scope target(s): evil.example.");
		expect(d.explain(denied("github", "delete_repo"))).toBeUndefined();
	});

	it("explains each refusal once, so a later denial by the operator is not credited to the scope", () => {
		const d = createMcpDenials();
		d.record("fetch", "fetch", "Out-of-scope target(s): evil.example.");
		expect(d.explain(denied("fetch", "fetch"))).toBeDefined();
		expect(d.explain(denied("fetch", "fetch"))).toBeUndefined();
	});

	it("appends the refusals an mcpScript's calls met to its result, keeping everything the script returned", () => {
		const d = createMcpDenials();
		d.record("browser", "navigate_page", "Out-of-scope target(s): 10.9.9.9.");
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const out = d.explain({ toolName: "mcpScript", content: [{ type: "text", text: "done" }, image] }) ?? [];
		expect(out.slice(0, 2)).toEqual([{ type: "text", text: "done" }, image]);
		expect(out[2]?.text).toMatch(/blocked MCP tool "navigate_page" on server "browser".*10\.9\.9\.9/);
		expect(d.explain({ toolName: "mcpScript", content: [] })).toBeUndefined();
	});

	it("appends them to a direct MCP tool's result, which it knows by the server the adapter names in its details", () => {
		const d = createMcpDenials();
		d.record("browser", "navigate_page", "Out-of-scope target(s): 10.9.9.9.");
		const out = d.explain({ toolName: "browser_click", content: [], details: { server: "browser" } });
		expect(out?.[0]?.text).toMatch(/navigate_page/);
	});

	it("never touches a result of a tool that runs no MCP calls", () => {
		const d = createMcpDenials();
		d.record("browser", "navigate_page", undefined);
		expect(d.explain({ toolName: "bash", content: [{ type: "text", text: "ok" }] })).toBeUndefined();
		expect(d.explain({ toolName: "mcp__browser", content: [] })?.[0]?.text).toMatch(/out of authorized scope/);
	});

	it("has nothing to say when nothing was refused", () => {
		expect(createMcpDenials().explain(denied("fetch", "fetch"))).toBeUndefined();
	});
});
