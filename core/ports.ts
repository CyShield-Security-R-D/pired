/**
 * pired core boundary contract ("ports").
 *
 * This is the entire, deliberately small surface between the harness-agnostic
 * `core/` and whatever runs it (`adapters/standalone/` on pi-agent-core + pi-ai
 * today; another harness tomorrow). Keeping it small and universal is the
 * longevity mechanism (PLAN.md §3.1).
 *
 * The contract has two directions:
 *
 *   1. Services the HOST provides TO core (dependency-inverted ports core calls):
 *      Fs, Clock, Ids — bundled as `HostServices`.
 *      In tests these are fakes; core never needs a real runtime.
 *
 *   2. Definitions core provides TO the host (core outputs the adapter wires in):
 *      ToolDefinition, GateDecision, and the system-prompt string. The adapter
 *      maps these onto its harness (e.g. pi-agent-core `AgentTool` /
 *      `beforeToolCall` / the agent system prompt).
 *
 * Constraints: zero imports (no pi, no third-party, not even node builtins);
 * erasable TypeScript only. Anything the core needs from the outside world is a
 * method on one of these interfaces.
 */

// ---------------------------------------------------------------------------
// Shared primitives (defined locally to avoid depending on lib.dom / @types/node)
// ---------------------------------------------------------------------------

/**
 * Structural subset of the standard `AbortSignal`. A real `AbortSignal` is
 * assignable to this, so adapters pass one straight through.
 */
export interface AbortSignalLike {
	readonly aborted: boolean;
	throwIfAborted?(): void;
}

// ===========================================================================
// Direction 1 — services the host provides to core
// ===========================================================================

export interface FileStat {
	mtimeMs: number;
	size: number;
}

/**
 * Filesystem the workspace is built on. Adapters back this with `node:fs`.
 * Paths are absolute or posix-style relative strings that core assembles.
 */
export interface Fs {
	readFile(path: string): Promise<string>;
	/** Returns undefined when the file does not exist (no throw). */
	readFileIfExists(path: string): Promise<string | undefined>;
	/** Overwrites. `mode` sets permissions on create (e.g. 0o600 for loot). */
	writeFile(path: string, data: string, opts?: { mode?: number }): Promise<void>;
	appendFile(path: string, data: string): Promise<void>;
	mkdirp(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	/** Returns undefined when the path does not exist. */
	stat(path: string): Promise<FileStat | undefined>;
	/** Atomically create an empty file, returning false if it already exists (lockfile primitive). */
	tryCreateExclusive(path: string): Promise<boolean>;
}

/** Time source. Injected so timestamps and delays are deterministic under test. */
export interface Clock {
	/** Epoch milliseconds. */
	now(): number;
	/** ISO-8601 UTC, e.g. "2026-08-23T14:02:11Z". */
	nowIso(): string;
	/** Resolve after ~ms. Injected (not `setTimeout`) so lock-retry loops are testable. */
	sleep(ms: number): Promise<void>;
}

/** Id source. Injected so ids are deterministic under test. */
export interface Ids {
	/**
	 * A short random id. NOT guaranteed unique: callers mint through
	 * `freshId`/`idMinter` (core/ids.ts), which draw again on a collision.
	 */
	newId(): string;
}

/**
 * Host-provided services core factories accept. Fakes satisfy this in tests.
 * Subagents are deliberately NOT here — pired delegates through the external
 * `pi-subagents` package (ADR-027) rather than shipping its own spawn machinery;
 * a delegated worker reaches this same workspace through pired's own child
 * extension, not through a port.
 */
export interface HostServices {
	fs: Fs;
	clock: Clock;
	ids: Ids;
}

// ===========================================================================
// Direction 2 — definitions core provides to the host
// ===========================================================================

/**
 * Minimal JSON-Schema subset for tool parameters. Kept as plain data (not
 * typebox) so core carries no schema-library dependency; the adapter maps this
 * to its harness's schema type. Extra keys are allowed for forward-compat.
 */
export interface JsonSchema {
	type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
	description?: string;
	enum?: readonly (string | number)[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** base64-encoded image data. */
	data: string;
	mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

export interface ToolResult {
	/** Content returned to the model. */
	content: ToolContent[];
	/** Structured data for rendering/state; not sent verbatim to the model. */
	details?: unknown;
	/** Hint that the agent may stop after this tool batch (see PLAN.md §11 semantics). */
	terminate?: boolean;
}

/** Runtime context passed to a tool's execute(). Long-lived deps (workspace, scope) are captured by the tool factory closure, not passed here. */
export interface ToolContext {
	/** Working directory of the run (target repo for review; cwd otherwise). */
	cwd: string;
	services: HostServices;
	signal?: AbortSignalLike;
}

/**
 * A tool core exposes (record / recall / spawn, and future scanner wrappers).
 * The adapter converts this to its harness's tool type. `execute` receives the
 * raw args; the adapter validates against `parameters` before calling, or core
 * validates internally.
 */
export interface ToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: JsonSchema;
	execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** A pending tool call presented to the scope gate. */
export interface ToolCall {
	name: string;
	args: unknown;
}

/**
 * Decision core's scope gate returns for a tool call. The adapter maps this onto
 * its pre-tool-call hook (e.g. pi-agent-core `beforeToolCall`): `allow: false`
 * becomes a block with `reason`.
 */
export interface GateDecision {
	allow: boolean;
	reason?: string;
	/** When true, hints the agent should stop after this (blocked) tool batch. */
	terminate?: boolean;
}

/**
 * Core's scope gate. Produced by core (e.g. `createScopeGate(scope)`) and called
 * by the adapter before every tool execution. Pure with respect to the host.
 */
export type Gate = (call: ToolCall) => GateDecision | Promise<GateDecision>;

/**
 * The system prompt is a plain string core builds (via a core builder over the
 * active profile, scope, and loaded skills) and the adapter sets on its agent.
 * No port object is required for it.
 */
export type SystemPrompt = string;
