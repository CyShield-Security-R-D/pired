/**
 * The worker half of delegation: what a pired child session decides.
 *
 * A pired worker is a pi-subagents child that loaded `extensions/child.ts`
 * (ADR-027). It runs in the parent's process, against the parent's workspace,
 * and the only things that make it pired's rather than a generic agent with a
 * shell are decided here: which ledger it writes to, which scope gates it, which
 * tools it may never touch, and when it has to stop and hand back.
 *
 * Everything fails toward doing nothing. A worker that cannot find the parent's
 * workspace or the scope the parent published refuses to start rather than
 * inventing either — `Workspace.open` would create a fresh, empty engagement and
 * the worker would record into a ledger nobody reads, under a gate built from
 * defaults. Until the child is armed every tool call is refused, so even a host
 * that ran the session after a failed start would get no bash and no network.
 *
 * Pure module: core imports only, the filesystem arrives on the `Fs` port.
 */

import type { EngagementScope } from "./ontology.ts";
import { parseLenses, passState, resolveLadder } from "./passes.ts";
import type { Gate, GateDecision, ToolCall, ToolDefinition } from "./ports.ts";
import { createScopeGate } from "./scope.ts";
import { PIRED_AGENTS, type PiredAgent } from "./subagents.ts";
import { createCoreTools } from "./tools.ts";
import { Workspace, type WorkspaceServices } from "./workspace.ts";

/**
 * The id the child acknowledges itself under. pi-subagents (0.66 and 0.71) lists
 * acknowledged ids on the run result as `runtimeAcknowledgedExtensions`, which is
 * how a parent — or a test — sees that pired's gate actually armed in the child
 * rather than only that the extension path was configured.
 */
export const CHILD_EXTENSION_ID = "pired-child";

/** pi-subagents' acknowledgement event, identical in 0.66 and 0.71 (`runtime-acknowledged-extensions`). */
export const EXTENSION_ACK_EVENT = "subagent:acknowledge-extension";

/**
 * Tools a worker is refused whatever the scope says.
 *
 * pi-subagents puts its own orchestration tools in front of any session that
 * loads it, and a worker that reached one could launch workers of its own —
 * outside the parent's `maxAgents` count, which only sees the parent's calls.
 * `subagents_enable` is the lazy loader's handle on `subagent`; `bg_wait` and
 * `subagent_supervisor` manage background runs pired never starts. The last
 * three are the names the parent gate already treats as spawning.
 */
export const CHILD_DENIED_TOOLS: ReadonlySet<string> = new Set([
	"subagent", "subagents_enable", "bg_wait", "subagent_supervisor",
	"spawn", "delegate", "pired_delegate",
]);

/**
 * pi-subagents' channel from a worker back to its parent. It is not on the
 * agent's tool allowlist — pi-subagents 0.71 registers it in every foreground
 * child and appends a prompt section saying to use it first when blocked. A
 * `need_decision` or `interview_request` then holds the worker until a reply
 * arrives, up to 10 minutes (0.71 `DEFAULT_ASK_TIMEOUT_MS`), and the session that
 * would answer is the parent blocked on this very worker, whose
 * `subagent_supervisor` pired hides. pired's place for a parked question is a
 * blocker on the ledger, which the operator's panel shows.
 */
export const SUPERVISOR_TOOL = "contact_supervisor";

/**
 * Turns a worker may keep calling tools after its budget, while it is told to
 * hand back. A model answers the first refusal with its handoff almost always;
 * one that keeps calling blocked tools is looping, and every blocked turn is a
 * full request on the operator's account. After this many the refusal also asks
 * pi to end the run.
 */
export const HANDOFF_GRACE_TURNS = 2;

/**
 * The budget a worker gets when it cannot tell which worker it is: the tightest
 * role's. The scope gate does not depend on the role, so an unknown role costs
 * turns, never containment.
 */
export const FALLBACK_MAX_TURNS = Math.min(...PIRED_AGENTS.map((a) => a.maxTurns));

// ---------------------------------------------------------------------------
// Which worker am I
// ---------------------------------------------------------------------------

/** `<!-- pired-agent: <name> -->`, the marker core/subagents.ts `agentMarker` writes. */
const PIRED_MARKER = /<!--\s*pired-agent:\s*([A-Za-z0-9._:-]+)\s*-->/;

/**
 * `<active_agent name="<name>"/>`, the tag pi-subagents 0.66 and 0.71 put in
 * front of a runtime agent's system prompt (child-launch). A second source, so a
 * prompt that lost pired's marker to some future rewrite still names its role.
 */
const ACTIVE_AGENT_TAG = /<active_agent\s+name="([^"]+)"\s*\/>/;

/**
 * The pired worker a system prompt belongs to, or undefined.
 *
 * pired's own marker wins over pi-subagents' tag: the parent writes it for
 * exactly this purpose, while the tag is another package's formatting. A name
 * that is not one of PIRED_AGENTS resolves to nothing — the budget table is
 * pired's, and an unknown agent has no row in it.
 */
export function identifyAgent(systemPrompt: string | undefined): PiredAgent | undefined {
	if (!systemPrompt) return undefined;
	for (const pattern of [PIRED_MARKER, ACTIVE_AGENT_TAG]) {
		const name = pattern.exec(systemPrompt)?.[1];
		const agent = name ? PIRED_AGENTS.find((a) => a.name === name) : undefined;
		if (agent) return agent;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Opening the parent's workspace
// ---------------------------------------------------------------------------

/** Why a worker refused to start. Thrown, so pi reports it and the child never arms. */
export class ChildSetupError extends Error {
	override name = "ChildSetupError";
}

export interface ChildSetup {
	workspace: Workspace;
	/** The scope the parent session holds in memory, as it published it for its workers. */
	scope: EngagementScope;
	/** `record` and `recall`, bound to the parent's workspace. Nothing else. */
	tools: ToolDefinition[];
}

export interface ChildSetupOptions {
	/** The object the parent published its scope on (`globalThis` in pi; see `publishParentScope`). */
	scopeRegistry: object;
	/** `PIRED_PASSES` as the parent process sees it, so a pass-driven engagement tags worker records with the same pass. */
	passes?: string;
}

// ---------------------------------------------------------------------------
// The parent's scope, handed over in-process
// ---------------------------------------------------------------------------

/**
 * The name of the process-global slot the parent publishes its scope in, for
 * `Symbol.for`. Versioned, so a later shape gets a new slot rather than a
 * worker misreading an old one.
 */
export const PARENT_SCOPE_KEY = "pired.parent-scope.v1";

type ScopeSlot = Map<string, EngagementScope>;

function scopeSlot(registry: object): ScopeSlot | undefined {
	const slot = (registry as Record<symbol, unknown>)[Symbol.for(PARENT_SCOPE_KEY)];
	return slot instanceof Map ? (slot as ScopeSlot) : undefined;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const inner of Object.values(value as object)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}

/**
 * Publish the parent's scope for the workers it launches, keyed by workspace
 * directory. Returns the withdrawal, which removes the entry only while it is
 * still this one, so a later session on the same workspace keeps its own.
 *
 * Why not the workspace's scope.json, which the worker used to read: that file
 * is the parent's copy for `pired-state` and the panel, and the gated agent can
 * write it — `write`, `edit` and a local `bash` redirect all pass the scope gate,
 * which does not police local paths. One edit mid-session re-armed every later
 * worker with a wider scope (or `mode: "off"`) while the parent's own gate stayed
 * as it was. A pired worker is a foreground child in the parent's process, so the
 * parent can hand it the exact scope object its own gate was built from, where
 * no tool call reaches. The copy is deep-frozen: a worker holds it, never edits it.
 */
export function publishParentScope(registry: object, dir: string, scope: EngagementScope): () => void {
	const key = Symbol.for(PARENT_SCOPE_KEY);
	let slot = scopeSlot(registry);
	if (!slot) {
		slot = new Map();
		Object.defineProperty(registry, key, { value: slot, configurable: true, enumerable: false, writable: false });
	}
	const published = deepFreeze(JSON.parse(JSON.stringify(scope)) as EngagementScope);
	slot.set(dir, published);
	const owned = slot;
	return () => {
		if (owned.get(dir) === published) owned.delete(dir);
	};
}

/** The scope a parent in this process published for `dir`, or undefined. */
export function readParentScope(registry: object, dir: string): EngagementScope | undefined {
	return scopeSlot(registry)?.get(dir);
}

/** The two tools a worker gets. Named, not taken wholesale, so a tool added to core later is not handed to workers by accident. */
const CHILD_TOOLS = new Set(["record", "recall"]);

function isScope(value: unknown): value is EngagementScope {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open the workspace the parent session is using, without ever creating one.
 *
 * `dir` is `PIRED_WORKSPACE`, which the parent exports at session start and the
 * in-process child inherits. The manifest proves a pired session made the
 * directory; the scope comes from the parent in-process (`publishParentScope`),
 * never from the workspace's scope.json. Missing either, the worker would be
 * recording into a directory no panel shows or gating against a scope nobody
 * vouched for, so it throws instead.
 *
 * `new Workspace` rather than `Workspace.open`: open creates the directories and
 * a manifest when they are absent, which is precisely the invented engagement
 * this refuses.
 */
export async function openChildWorkspace(
	dir: string | undefined,
	services: WorkspaceServices,
	options: ChildSetupOptions,
): Promise<ChildSetup> {
	const path = dir?.trim();
	if (!path) {
		throw new ChildSetupError(
			"PIRED_WORKSPACE is not set: a pired worker runs only under a pired parent session and will not guess which ledger to write.",
		);
	}
	const workspace = new Workspace(path, services);
	const manifest = await workspace.readManifest().catch((error: unknown) => {
		throw new ChildSetupError(`pired workspace ${path} has an unreadable manifest.json: ${(error as Error).message}`);
	});
	if (!manifest) {
		throw new ChildSetupError(`no pired workspace at ${path} (manifest.json is missing); a worker never creates one.`);
	}
	const scope: unknown = readParentScope(options.scopeRegistry, path);
	if (!isScope(scope)) {
		throw new ChildSetupError(
			`no pired parent in this process published a scope for ${path}; a worker takes its scope from the session that launched it, never from scope.json, and will not arm without one.`,
		);
	}
	const ladder = resolveLadder(scope.passes, parseLenses(options.passes));
	// A snapshot: a worker lives for one task, and `/pass` is an operator command
	// the parent cannot run while it is blocked on the worker it launched.
	const passNumber = ladder ? await workspace.currentPass() : 1;
	const tools = createCoreTools({ workspace, pass: () => passState(ladder, passNumber) }).filter((t) => CHILD_TOOLS.has(t.name));
	return { workspace, scope, tools };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ChildGuard {
	/** Arm the gate with the parent's scope. Until this runs every call is refused. */
	arm(scope: EngagementScope): void;
	/** Remember why arming failed, so refused calls can say so. */
	fail(reason: string): void;
	/**
	 * Learn the worker's role from its system prompt. The first answer sticks: the
	 * budget a worker started under does not change halfway through its run.
	 */
	identify(systemPrompt: string | undefined): PiredAgent | undefined;
	/** One assistant turn began. */
	turnStarted(): void;
	/** Decide one tool call. */
	check(call: ToolCall): Promise<GateDecision>;
	/** For the host's status and for tests. */
	readonly status: { armed: boolean; agent?: string; maxTurns: number; turns: number };
}

function delegationRefusal(tool: string): GateDecision {
	return {
		allow: false,
		reason: `pired workers do not delegate: \`${tool}\` belongs to the operator's session. Do this part yourself, or name it as unresolved in your handoff.`,
	};
}

const SUPERVISOR_REFUSAL: GateDecision = {
	allow: false,
	reason: "pired workers do not wait on the operator mid-task: nobody answers while you run. `record` the open question as a blocker, carry on with what you can settle, and name the blocker in your handoff.",
};

function budgetRefusal(agent: string, maxTurns: number, over: number): GateDecision {
	const handoff = "Your final message is the handoff: at most 200 words listing the record IDs you wrote, the evidence paths, your verdicts, and what is still unresolved.";
	if (over > HANDOFF_GRACE_TURNS) {
		return {
			allow: false,
			reason: `pired: ${agent} is ${over} turns past its ${maxTurns}-turn budget and still calling tools, so this run is being stopped. ${handoff}`,
			terminate: true,
		};
	}
	return {
		allow: false,
		reason: `pired: ${agent} has used its ${maxTurns}-turn budget. Stop calling tools and hand back now. ${handoff}`,
	};
}

/**
 * The child's tool-call decision, in order: delegation and the supervisor
 * channel are refused outright; an unarmed child refuses everything; a worker
 * past its turn budget is told to hand back; everything else goes through
 * pired's own scope gate with `maxAgents: 0`, so a scope-declared `agentTools`
 * name is refused as well.
 *
 * Turns are counted from `turn_start`, not tool calls: a turn that reads three
 * files is one step of the investigation, and pi-subagents' `toolBudget.hard`
 * (maxTurns x 8, set by the parent) is the per-call backstop.
 */
export function createChildGuard(): ChildGuard {
	let gate: Gate | undefined;
	let failure: string | undefined;
	let agent: PiredAgent | undefined;
	let turns = 0;

	const maxTurns = (): number => agent?.maxTurns ?? FALLBACK_MAX_TURNS;

	return {
		arm(scope) {
			gate = createScopeGate({ ...scope, maxAgents: 0 });
			failure = undefined;
		},
		fail(reason) {
			if (!gate) failure = reason;
		},
		identify(systemPrompt) {
			agent ??= identifyAgent(systemPrompt);
			return agent;
		},
		turnStarted() {
			turns += 1;
		},
		async check(call) {
			if (CHILD_DENIED_TOOLS.has(call.name)) return delegationRefusal(call.name);
			if (call.name === SUPERVISOR_TOOL) return SUPERVISOR_REFUSAL;
			if (!gate) {
				return {
					allow: false,
					reason: `pired worker is not armed${failure ? ` (${failure})` : ""}; no tool runs until it is. Hand back and say the worker could not start.`,
				};
			}
			const over = turns - maxTurns();
			if (over > 0) return budgetRefusal(agent?.name ?? "this worker", maxTurns(), over);
			return gate(call);
		},
		get status() {
			return { armed: gate !== undefined, ...(agent ? { agent: agent.name } : {}), maxTurns: maxTurns(), turns };
		},
	};
}
