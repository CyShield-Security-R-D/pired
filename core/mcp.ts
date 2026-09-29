/**
 * The scope gate in front of MCP calls made through pi-mcp-adapter.
 *
 * pi's `tool_call` hook sees the adapter's own tools (`mcp`, `mcp__<server>`,
 * `mcpScript`, direct tools), and the gate already scans their arguments. It
 * still misses two things:
 * - the calls an `mcpScript` makes from inside its JavaScript;
 * - a bare host inside arguments the model passed as a JSON string, which
 *   the adapter accepts and the gate's argument scan reads as plain text.
 * The adapter asks any listening extension for approval of every resolved call
 * (proxy, direct, script, resource and UI iframe, cached grants included from
 * 2.33.0), with the arguments already parsed. Answering that request is the
 * one place every MCP call passes through, so the gate answers it.
 *
 * pired denies what the gate refuses and otherwise claims nothing, so the
 * adapter's own approval settings still apply to in-scope calls.
 */
import type { GateDecision, ToolCall } from "./ports.ts";

/** The event pi-mcp-adapter emits before every resolved MCP call (2.20.0; cached calls from 2.33.0). */
export const MCP_APPROVAL_EVENT = "pi-mcp-adapter:tool-approval-request";

/** The part of the adapter's `McpToolApprovalRequest` the gate reads. */
export interface McpApprovalRequest {
	serverName: string;
	originalToolName: string;
	args?: Record<string, unknown>;
	origin?: string;
	claim(handler: () => "deny"): boolean;
}

/**
 * The name an MCP call reaches the gate under. It can never equal a name the
 * gate treats specially (`bash`, `read`, `subagent`, a spawn tool), whatever
 * `toolPrefix` the operator configured. With `toolPrefix: "none"`, a server's
 * tool can be called `bash` or `read`. Handed over as such, it would have been
 * parsed as a shell command or waved through as a local file read.
 */
export function mcpCallName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`;
}

function isApprovalRequest(value: unknown): value is McpApprovalRequest {
	const r = value as Partial<McpApprovalRequest> | null;
	return typeof r === "object" && r !== null && typeof r.serverName === "string" && typeof r.originalToolName === "string" && typeof r.claim === "function";
}

/**
 * Put one MCP call through the gate. A refusal claims the request with a
 * denial; an allowed call is left unclaimed, which the adapter reads as
 * "abstain". Returns the gate's decision for a request it could read, so the
 * host can tell the operator, or undefined for anything else.
 */
export function gateMcpCall(gate: (call: ToolCall) => GateDecision, request: unknown): GateDecision | undefined {
	if (!isApprovalRequest(request)) return undefined;
	const decision = gate({ name: mcpCallName(request.serverName, request.originalToolName), args: request.args ?? {} });
	if (!decision.allow) request.claim(() => "deny");
	return decision;
}

/** One content block of a tool result: text, or an image this never touches. */
export type ResultContent = { type: string; text?: string };

/** A tool result as pi's `tool_result` event carries it, as far as this reads it. */
export interface McpToolResult {
	toolName: string;
	content: readonly ResultContent[];
	details?: unknown;
}

/**
 * The adapter reports a broker's denial as "The user declined approval to run
 * MCP tool …". For a call the scope refused, that is untrue. A model told the
 * operator said no asks the operator, or tries again another way. A model told
 * the target is out of scope does what it does after a blocked `bash` call.
 * This keeps the gate's reasons until the result comes back, and puts them in
 * its place.
 */
export interface McpDenials {
	/** The gate refused this call. */
	record(serverName: string, toolName: string, reason: string | undefined): void;
	/**
	 * The result's text as it should reach the model, or undefined to leave it
	 * alone. A proxy or direct call's denial is replaced. Any other MCP tool's
	 * result gets the refusals made while it ran appended, because an
	 * `mcpScript` receives them inside its JavaScript and may never print them.
	 */
	explain(result: McpToolResult): ResultContent[] | undefined;
}

const MCP_TOOL = /^(mcp|mcpScript|mcp__.+)$/;

function refusal(serverName: string, toolName: string, reason: string | undefined): string {
	return `pired's engagement scope blocked MCP tool "${toolName}" on server "${serverName}", not the operator: ${reason ?? "out of authorized scope"} It was not run.`;
}

export function createMcpDenials(): McpDenials {
	let pending: Array<{ serverName: string; toolName: string; reason: string | undefined }> = [];
	return {
		record(serverName, toolName, reason) {
			pending.push({ serverName, toolName, reason });
		},
		explain(result) {
			if (pending.length === 0) return undefined;
			const details = (result.details ?? {}) as { error?: unknown; server?: unknown; tool?: unknown };
			if (details.error === "approval_denied") {
				const i = pending.findIndex((p) => p.serverName === details.server && p.toolName === details.tool);
				if (i < 0) return undefined;
				const [hit] = pending.splice(i, 1);
				return [{ type: "text", text: refusal(hit!.serverName, hit!.toolName, hit!.reason) }];
			}
			// A direct MCP tool carries its own name; any other tool never ran MCP calls.
			if (!MCP_TOOL.test(result.toolName) && typeof details.server !== "string") return undefined;
			const notes = pending.map((p) => refusal(p.serverName, p.toolName, p.reason));
			pending = [];
			return [...result.content, { type: "text", text: notes.join("\n") }];
		},
	};
}
