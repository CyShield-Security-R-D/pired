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

import { hasGrounds } from "./challenge.ts";
import { type Fields, findDuplicate } from "./identity.ts";
import { type EngagementScope, type FindingRecord, type HypothesisRecord, type StoreName, type StoreRecordMap, UNNAMED_WORKER_AUTHOR } from "./ontology.ts";
import { parseLenses, passState, resolveLadder } from "./passes.ts";
import type { Gate, GateDecision, ToolCall, ToolDefinition } from "./ports.ts";
import { createScopeGate, isSourceOnly } from "./scope.ts";
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
 * The first line of the section pi-subagents 0.71 appends to a worker's prompt
 * for its supervisor channel (`INTERCOM_BRIDGE_MARKER` in
 * src/intercom/intercom-bridge.js), and the sentence its default template ends
 * on. pired strips the section between them; see `withoutSupervisorSection`.
 */
export const SUPERVISOR_SECTION_START = "Intercom orchestration channel:";
export const SUPERVISOR_SECTION_END = "If no coordination is needed, return a focused task result.";

/**
 * Turns a worker may keep going after its budget, while it is told to hand back.
 * They are the ledger's turns: `record` and `recall` still run, every other tool
 * is refused. After this many any tool call — `record` included — also asks pi to
 * end the run: a model answers the first refusal with its handoff almost always,
 * one that keeps calling tools is looping, and every blocked turn is a full
 * request on the operator's account.
 *
 * The ledger stays open because the budget line used to refuse `record` with
 * everything else. In the 2026-09-24 v4 grid 17–18 worker record calls were
 * refused there, 11 of them for work that then reached neither the ledger nor
 * the handoff; 10 of 13 gpt-6-luna scouts lost a record call that way. A worker
 * at its budget is exactly the one with something left to write down.
 */
export const HANDOFF_GRACE_TURNS = 2;

/**
 * The budget a worker gets when it cannot tell which worker it is: the tightest
 * role's. The scope gate does not depend on the role, so an unknown role costs
 * turns, never containment.
 */
export const FALLBACK_MAX_TURNS = Math.min(...PIRED_AGENTS.map((a) => a.maxTurns));

/**
 * The last turns of a worker's budget — exactly this many, the budget's final
 * turn included — held back for recording when it has recorded nothing. A
 * worker's only durable channel is the shared ledger; its handoff is a message
 * the parent may summarise away. In the 2026-09-24 v4 grid a gpt-6-luna
 * pired-investigate spent all 26 of its turns (24 plus the grace turns) and
 * wrote no record — "hypotheses and findings remain unrecorded" — and four more
 * runs were flagged because a pired-verify child made no durable record. Three
 * turns is enough to write what was established; the reserve refuses tools, it
 * never ends the run.
 *
 * It only catches a worker that runs to its budget. One that hands back early
 * with nothing recorded is caught at settle instead (`ChildGuard.settleCheck`).
 * "Recorded" means a row on the ledger that counts for the worker's role
 * (`ChildGuard.recorded`), not a `record` call that returned.
 */
export const RECORD_RESERVE_TURNS = 3;

/**
 * The only keys a pired-verify worker may pass when it re-records a finding by
 * id: the verdict and its grounds.
 *
 * An update by id is last-write-wins, so any other key a verifier passes
 * replaces the investigator's version of it. In the v4 grid (2026-09-24, GLM,
 * pass 1) two pired-verify workers re-recorded both findings they were checking
 * with new descriptions, which replaced the investigator's text and reordered
 * the cited locations: the ledger replayed held 4 true positives before they ran
 * and 2 after. A verification that can rewrite what it verifies is not one.
 *
 * `evidence` is not a verdict key for the same reason. The id path spreads the
 * patch over the stored row, so a verifier's evidence list does not add to the
 * investigator's, it replaces it. A verifier cites the output it saved (record
 * kind=evidence returns the path) in `basis` to refute or `control` to confirm,
 * where the tool's verdict check reads it and the verification keeps it.
 *
 * `reason` is here as commentary on a verdict, never as one. See
 * `verifierRefusal`: a by-id write needs a status, and `suspected` needs a basis
 * or control.
 */
export const VERIFIER_FINDING_KEYS: ReadonlySet<string> = new Set([
	"kind", "id", "status", "basis", "path", "guards", "live", "control", "entitlement", "reason",
]);

/**
 * The finding statuses a pired-investigate or pired-escalate worker may send:
 * where every finding starts. Its findings land `suspected`, and someone who
 * did not write them settles them (delegation-v6 Phase 3, 3.1).
 *
 * A finder that checks its own claim agrees with it. The scribe measured that
 * (precision 0.059 to 0.038 when a pass re-read the finder's own reasoning),
 * and on the 2026-09-24 grid 17 of 18 settled verification records rested on a
 * live=true that described no running target (ADR-028). `confirmed` and
 * `refuted` are therefore the verifier's or the lead's to write; the
 * dispositions (`false-positive`, `accepted-risk`, …) are the operator's, as
 * they are for a verifier (VERIFIER_STATUSES).
 */
export const FINDER_STATUSES: ReadonlySet<string> = new Set(["suspected", "open"]);

/**
 * The finding statuses a pired-verify worker may write: its verdict, or
 * `suspected` for a finding it could not settle.
 *
 * The others are not verdicts. `false-positive`, `accepted-risk`, `ignored`,
 * `triaged` and `reported` are the operator's dispositions, and `open` is where a
 * finding stood before anyone checked it. They also skip the record tool's burden
 * of proof, which judges only `confirmed` and `refuted` (core/tools.ts): a
 * verifier that wrote `false-positive` would close a finding with no basis at
 * all, where `refuted` has to cite one. A verifier withdraws a finding by
 * refuting it.
 *
 * The same line runs the other way: a finding the operator has already given
 * one of those dispositions is not a verifier's to move (`dispositionRefusal`).
 */
export const VERIFIER_STATUSES: ReadonlySet<string> = new Set(["confirmed", "refuted", "suspected"]);

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

/**
 * The system prompt without pi-subagents' supervisor-channel section, or the
 * prompt unchanged when that section is not there as pired knows it.
 *
 * pi-subagents 0.71 appends the section to every foreground worker's prompt, and
 * it opens "Use contact_supervisor first". A pired worker has no supervisor to
 * reach — the gate refuses the tool — so the section only sent workers into a
 * refusal: in the 2026-09-24 v4 grid 31 contact_supervisor calls were refused,
 * and together with the grep/find tools that fail on a host without rg and fd
 * they cost 12–19% of worker turns.
 *
 * The section is removed only when its first line starts a line, the default
 * template's last sentence follows it, and the text between names the tool. A
 * custom `instructionFile` template, or a reworded default, leaves the prompt as
 * it was; the gate's refusal still covers the call.
 */
export function withoutSupervisorSection(systemPrompt: string): string {
	const start = systemPrompt.indexOf(SUPERVISOR_SECTION_START);
	if (start < 0 || (start > 0 && systemPrompt[start - 1] !== "\n")) return systemPrompt;
	const end = systemPrompt.indexOf(SUPERVISOR_SECTION_END, start);
	if (end < 0 || !systemPrompt.slice(start, end).includes(SUPERVISOR_TOOL)) return systemPrompt;
	const before = systemPrompt.slice(0, start).trimEnd();
	const after = systemPrompt.slice(end + SUPERVISOR_SECTION_END.length).trimStart();
	return before && after ? `${before}\n\n${after}` : before || after;
}

// ---------------------------------------------------------------------------
// Opening the parent's workspace
// ---------------------------------------------------------------------------

/** Why a worker refused to start. Thrown, so pi reports it and the child never arms. */
export class ChildSetupError extends Error {
	override name = "ChildSetupError";
}

/**
 * What the gate reads from the shared ledger: live rows, tombstones dropped, as
 * `Workspace.read` returns them. Only a verifier's finding writes are checked
 * against it (see `verifierRefusal`).
 */
export interface ChildLedger {
	findings(): Promise<readonly FindingRecord[]>;
	hypotheses(): Promise<readonly HypothesisRecord[]>;
}

export interface ChildSetup {
	workspace: Workspace;
	/** The scope the parent session holds in memory, as it published it for its workers. */
	scope: EngagementScope;
	/** `record` and `recall`, bound to the parent's workspace. Nothing else. */
	tools: ToolDefinition[];
	/** The parent's ledger, read for the gate (`ChildGuard.arm`). */
	ledger: ChildLedger;
}

export interface ChildSetupOptions {
	/** The object the parent published its scope on (`globalThis` in pi; see `publishParentScope`). */
	scopeRegistry: object;
	/** `PIRED_PASSES` as the parent process sees it, so a pass-driven engagement tags worker records with the same pass. */
	passes?: string;
	/**
	 * Called once for each write that appended rows to a ledger store — what
	 * `ChildGuard.recorded` counts. Not called for evidence files, notes or the
	 * target model, which are not ledger rows, nor for a call whose rows were all
	 * already there.
	 */
	onWrite?: (store: StoreName) => void;
	/**
	 * The worker's agent name, stamped as `by` on the rows it creates — the
	 * guard's identity (`ChildGuard.status.agent`), read at each write because the
	 * role can be learned after the tools are built. Unknown, the row is stamped
	 * UNNAMED_WORKER_AUTHOR: a worker's row never reads as the lead's.
	 */
	author?: () => string | undefined;
}

/**
 * The parent's workspace, reporting each store a write actually landed in.
 *
 * This is what the recording reserve and the settle reminder count, and the
 * record tool's reply cannot tell it: a `record` that resolved may have saved
 * an evidence file or a note, or matched a row already there and written
 * nothing, and its details say `created: []` alike for an update, a merge and a
 * repeat that changed nothing. Counting every resolved call let a worker lift
 * both checks with `record kind=evidence` alone. Every ledger write goes through
 * `upsert`, which appends nothing when the plan returns no rows, so a plan that
 * returned rows is a line on the ledger.
 */
class WatchedWorkspace extends Workspace {
	readonly #onWrite: (store: StoreName) => void;

	constructor(dir: string, services: WorkspaceServices, onWrite: (store: StoreName) => void) {
		super(dir, services);
		this.#onWrite = onWrite;
	}

	override async upsert<S extends StoreName>(
		store: S,
		plan: (current: StoreRecordMap[S][]) => StoreRecordMap[S][] | undefined,
	): Promise<void> {
		let rows = 0;
		await super.upsert(store, (current) => {
			const out = plan(current);
			rows = out?.length ?? 0;
			return out;
		});
		if (rows > 0) this.#onWrite(store);
	}
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
export function publishParentScope(registry: object, dir: string, scope: EngagementScope, root?: string): () => void {
	const key = Symbol.for(PARENT_SCOPE_KEY);
	let slot = scopeSlot(registry);
	if (!slot) {
		slot = new Map();
		Object.defineProperty(registry, key, { value: slot, configurable: true, enumerable: false, writable: false });
	}
	const published = deepFreeze(JSON.parse(JSON.stringify(scope)) as EngagementScope);
	slot.set(dir, published);
	const owned = slot;
	// The engagement root beside it: the directory the parent runs in, which a
	// worker launched with a cwd inside it resolves quotes against (3.1).
	const roots = rootSlot(registry);
	if (root !== undefined) roots.set(dir, root);
	else roots.delete(dir);
	return () => {
		if (owned.get(dir) === published) {
			owned.delete(dir);
			if (roots.get(dir) === root) roots.delete(dir);
		}
	};
}

/** Where the parent keeps the engagement roots it published, keyed like the scopes. */
export const PARENT_ROOT_KEY = "pired.parent-root.v1";

function rootSlot(registry: object): Map<string, string> {
	const key = Symbol.for(PARENT_ROOT_KEY);
	const found = (registry as Record<symbol, unknown>)[key];
	if (found instanceof Map) return found as Map<string, string>;
	const slot = new Map<string, string>();
	Object.defineProperty(registry, key, { value: slot, configurable: true, enumerable: false, writable: false });
	return slot;
}

/** The engagement root the parent published for this workspace, if it named one. */
export function readParentRoot(registry: object, dir: string): string | undefined {
	const found = (registry as Record<symbol, unknown>)[Symbol.for(PARENT_ROOT_KEY)];
	return found instanceof Map ? (found as Map<string, string>).get(dir) : undefined;
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
	const workspace = options.onWrite ? new WatchedWorkspace(path, services, options.onWrite) : new Workspace(path, services);
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
	const tools = createCoreTools({
		workspace,
		pass: () => passState(ladder, passNumber),
		// The parent's scope, not a default: in an engagement with no live target a
		// verifier's honest `live: false` must not turn its refutation into
		// 'unresolved', or the only way to refute is to claim a target that does
		// not exist.
		sourceOnly: () => isSourceOnly(scope),
		author: () => options.author?.() ?? UNNAMED_WORKER_AUTHOR,
		// The parent's directory, so a quote is resolved and stored against the
		// engagement root whatever cwd this worker was launched in.
		root: () => readParentRoot(options.scopeRegistry, path),
	}).filter((t) => CHILD_TOOLS.has(t.name));
	const ledger: ChildLedger = {
		findings: () => workspace.read("findings"),
		hypotheses: () => workspace.read("hypotheses"),
	};
	return { workspace, scope, tools, ledger };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ChildGuard {
	/**
	 * Arm the gate with the parent's scope and the ledger it checks a verifier's
	 * finding writes against. Until this runs every call is refused. Without a
	 * ledger the gate reads an empty one, so a verifier's `hypothesisId` create is
	 * refused — no hypothesis can be shown to exist — rather than let through
	 * unchecked.
	 */
	arm(scope: EngagementScope, ledger?: ChildLedger): void;
	/** Remember why arming failed, so refused calls can say so. */
	fail(reason: string): void;
	/**
	 * Learn the worker's role from its system prompt. The first answer sticks: the
	 * budget a worker started under does not change halfway through its run.
	 */
	identify(systemPrompt: string | undefined): PiredAgent | undefined;
	/** One assistant turn began. */
	turnStarted(): void;
	/**
	 * Rows were appended to `store` (`ChildSetupOptions.onWrite`). What counts
	 * toward the reserve and the settle reminder is the guard's call, by role: a
	 * verifier's result is its verdict, so for pired-verify only findings and
	 * hypotheses count — an endpoint it noted on the way is not the verdict it was
	 * sent for. Evidence files and notes never arrive here.
	 */
	recorded(store: StoreName): void;
	/** Decide one tool call. */
	check(call: ToolCall): Promise<GateDecision>;
	/**
	 * The worker is about to settle: it answered without a tool call and nothing
	 * would run after it. Returns a message to put in front of it for one more
	 * request, or undefined to let it hand back.
	 *
	 * The reserve only catches a worker that runs to its budget. In the 2026-09-24
	 * v4 grid 6 gpt-6-luna pired-verify children recorded nothing, and 4 of them
	 * handed back early — at turns 7, 7, 11 and 12 of 16 — stating a verdict that
	 * was never written anywhere the report is built from. So a worker that is
	 * about to hand back with nothing recorded is told once, while it still has
	 * turns, that its handoff is not durable.
	 *
	 * Once per worker, whatever it does with it: a worker that answers with
	 * another hand-back is let go, so the reminder costs at most one request and
	 * cannot loop. Not for an unarmed worker, which has no ledger to write; not
	 * for a run that ended `aborted` (someone stopped it) or `error` (the next
	 * request would meet the same provider failure); and not once the request it
	 * buys would fall past the grace turns, where a record call ends the run.
	 */
	settleCheck(outcome?: string): string | undefined;
	/** For the host's status and for tests. */
	readonly status: { armed: boolean; agent?: string; maxTurns: number; turns: number; records: number; reminded: boolean };
}

/** A tool call's arguments as a record, or an empty one when a model sent something else. */
function argsOf(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function delegationRefusal(tool: string): GateDecision {
	return {
		allow: false,
		reason: `pired workers do not delegate: \`${tool}\` belongs to the operator's session. Do this part yourself, or name it as unresolved in your handoff.`,
	};
}

/**
 * Why `contact_supervisor` is refused, by what the worker was trying to send.
 *
 * A question needs an answer nobody can give mid-run, so it belongs on the
 * ledger as a blocker, where the operator's panel shows it. A progress update
 * needs no answer at all, and telling that worker to record a blocker would park
 * a question nobody asked. pi-subagents' own prompt section invites updates on
 * "meaningful progress", so they are the common case.
 */
function supervisorRefusal(rawArgs: unknown): GateDecision {
	const why = argsOf(rawArgs).reason;
	if (why === "need_decision" || why === "interview_request") {
		return {
			allow: false,
			reason: "pired workers have no supervisor channel: nobody answers while you run, and the session that launched you is waiting on your handoff. `record` the open question as a blocker, carry on with what you can settle, and name the blocker in your handoff.",
		};
	}
	return {
		allow: false,
		reason: "pired workers have no supervisor channel, and nothing reads a progress update while you run. Carry on with the task: your handoff is the report, and what you record is what lasts.",
	};
}

const HANDOFF = "Your final message is the handoff: at most 200 words listing the record IDs you wrote, the evidence paths, your verdicts, and what is still unresolved.";

/**
 * The refusal past the budget. Within HANDOFF_GRACE_TURNS it refuses everything
 * but the ledger and says so; after them it refuses everything and ends the run.
 */
function budgetRefusal(agent: string, maxTurns: number, over: number): GateDecision {
	if (over > HANDOFF_GRACE_TURNS) {
		return {
			allow: false,
			reason: `pired: ${agent} is ${over} turns past its ${maxTurns}-turn budget and still calling tools, so this run is being stopped. ${HANDOFF}`,
			terminate: true,
		};
	}
	const left = HANDOFF_GRACE_TURNS - over;
	const ledger = left > 0
		? `The ledger is still open: record and recall run for ${left} more turn${left === 1 ? "" : "s"} after this one, and nothing else does. If something you established is not recorded yet, record it, then hand back.`
		: "This is the ledger's last turn: a tool call in your next message ends the run. Hand back now.";
	return { allow: false, reason: `pired: ${agent} has used its ${maxTurns}-turn budget. ${ledger} ${HANDOFF}` };
}

/**
 * What a worker should get onto the ledger before it runs out, by role. A scout
 * told to record findings would spend its reserve on a refusal, and a verifier's
 * one durable product is the verdict on the record it was sent to check —
 * unsettled is a verdict too, and the one most often left unwritten.
 *
 * An unsettled verdict's grounds go in 'basis' or 'control'. This text used to
 * say "what you checked in 'reason'", but the record tool reads a look that
 * settled nothing only from a basis or a control case (`hasGrounds`) — a reason
 * alone is not one — and the gate refuses a status=suspected carrying only a
 * reason (`verifierRefusal`). The reserve would have told a verifier to write
 * the call the gate refuses.
 */
function whatToRecord(agent: PiredAgent | undefined): string {
	switch (agent?.role) {
		case "scout":
			return "the surface you mapped, each element with its file, and hypotheses as proposed";
		case "verify":
			return "your verdict on the record named in your task, by its id — the status or outcome with its grounds, or, if it is unsettled, status=suspected (finding) with what you checked in 'basis' (file:line or evidence path) or 'control', or outcome=inconclusive (hypothesis) with what is missing in 'statement' and what you checked in 'basis'; 'reason' is commentary";
		default:
			return "hypotheses with their outcome (inconclusive is a valid outcome), findings only where supported, raw output as evidence";
	}
}

/**
 * What is missing, in the reserve refusal's words. A verifier counts only
 * findings and hypotheses (`countsFor`), so one that noted an endpoint has a row
 * on the ledger and was still told it "recorded nothing"; what it has not
 * recorded is its verdict.
 */
function missing(agent: PiredAgent | undefined): string {
	return agent?.role === "verify" ? "has recorded no verdict" : "has recorded nothing";
}

function reserveRefusal(agent: PiredAgent | undefined, left: number): GateDecision {
	return {
		allow: false,
		reason: `pired: ${agent?.name ?? "this worker"} has ${left} turn${left === 1 ? "" : "s"} left after this one and ${missing(agent)} to the shared ledger. Record ${whatToRecord(agent)}. Do that now, then ${left === 0 ? "hand back" : "carry on"}. Until something is recorded only record and recall run. If you established nothing worth recording, hand back and say so.`,
	};
}

function settleReminder(agent: PiredAgent | undefined): string {
	const state = agent?.role === "verify"
		? "you are handing back and have recorded no verdict from this run on the shared ledger"
		: "you are handing back with nothing from this run on the shared ledger";
	return `pired: ${state}. Your handoff is a message the session that launched you may summarise away; the ledger is what lasts, and what the report is built from. Before you hand back, record ${whatToRecord(agent)}. Then hand back again with your full handoff — your last message is the one that is read. If you established nothing worth recording, say so in that handoff instead.`;
}

/**
 * Whether a model actually passed `key`. Models fill optional parameters with
 * empty values; an empty string, null, `false` or empty list changes nothing on
 * the record, so it is not a key the role rules should refuse — a `delete:
 * false` is not a deletion.
 */
function passed(args: Record<string, unknown>, key: string): boolean {
	const v = args[key];
	return v !== undefined && v !== null && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0);
}

/**
 * What a role may not write, for a `record` call. Hypotheses, surface and notes
 * are open to every role; the rules are about findings, which are what the
 * report is made of.
 *
 * A scout's findings are breadth guesses no one traced — its mission says not to
 * confirm anything — yet a finding goes straight into the findings list, where a
 * hypothesis would have gone into the coverage matrix to be settled. In the v4
 * grid (2026-09-24) a GLM pass-2 pired-scout recorded 3 findings.
 *
 * A verifier's rules are `verifierRefusal`'s, and read the ledger.
 */
async function roleRefusal(agent: PiredAgent | undefined, rawArgs: unknown, ledger: ChildLedger): Promise<GateDecision | undefined> {
	const args = argsOf(rawArgs);
	// Settling is the session's own statement that its work is finished, paused
	// or blocked (3.2). A worker's task ends in its handoff; its settle would be
	// read as the lead's.
	if (args.kind === "settle") {
		return {
			allow: false,
			reason: `pired: ${agent?.name ?? "a worker"} does not settle the session — that is the lead's record of how the session ended. Your task ends with your handoff: name what you recorded and what you left open.`,
		};
	}
	if (args.kind !== "finding" || !agent) return undefined;
	if (agent.role === "scout") {
		return {
			allow: false,
			reason: `pired: ${agent.name} does not record findings — scouts map surface and propose hypotheses. Record what you saw as kind=hypothesis outcome=proposed against the element and its class, and an investigator or verifier settles it.`,
		};
	}
	if (agent.role === "investigate" || agent.role === "escalate") return finderRefusal(agent, args, ledger);
	if (agent.role !== "verify") return undefined;
	return verifierRefusal(agent, args, ledger);
}

/**
 * What an investigator or escalator may not do to a finding: settle it, or
 * change one someone else recorded.
 *
 * Refused with a reason rather than stripped (ADR-028): a status quietly
 * dropped reads to the worker as a verdict recorded. Its findings land
 * `suspected` and it names them in its handoff; the lead launches a verifier
 * or settles them itself.
 *
 * By id, a worker changes only its own findings. An update by id is
 * last-write-wins, and ADR-028 measured what that costs when the writer is
 * not the finder: two verifiers re-recording findings with new descriptions
 * took the replayed ledger from 4 true positives to 2. A create that merges
 * into another author's finding is still allowed — that is how a second
 * location reaches a bug already on the ledger — and the record tool keeps the
 * stored status on a worker's merge.
 *
 * Two launches of one worker share its agent name, so the second may edit the
 * first one's finding; `by` records the agent, not the launch.
 */
async function finderRefusal(agent: PiredAgent, args: Record<string, unknown>, ledger: ChildLedger): Promise<GateDecision | undefined> {
	if (passed(args, "status") && !(typeof args.status === "string" && FINDER_STATUSES.has(args.status))) {
		const got = typeof args.status === "string" ? args.status : JSON.stringify(args.status);
		const verdict = got === "confirmed" || got === "refuted";
		return {
			allow: false,
			reason: verdict
				? `pired: ${agent.name} records findings and does not settle them — status=${got} is for an independent verifier (pired-verify, launched by the lead) or the lead, because a finder that checks its own claim agrees with it. Record the finding without a status: it lands suspected. Put the control case you ran and the path you traced in its description or evidence, and name its id in your handoff as ready to verify.`
				: `pired: ${agent.name} does not set a finding's status to '${got}' — that is the operator's disposition. Record the finding without a status (it lands suspected), and say in your handoff why you think it is ${got}.`,
		};
	}
	if (!passed(args, "id")) return undefined;
	const stored = (await ledger.findings()).find((f) => f.id === args.id);
	if (stored === undefined || stored.by === agent.name) return undefined;
	return {
		allow: false,
		reason: `pired: finding ${stored.id} was recorded by ${stored.by ?? "someone else (no author on the row)"}, not ${agent.name}, and a worker changes only the findings it recorded. To add a location or detail, record it again without an id — the same bug merges into ${stored.id} and keeps its status — or name ${stored.id} and what you found in your handoff.`,
	};
}

const VERDICT = "A verifier records a verdict, not a rewrite: status=confirmed with 'control' (and 'entitlement' where access is the question), status=refuted with 'basis' (and 'live' only when you tested a running target), or status=suspected with what you checked in 'basis' or 'control' when you could not settle it; its reasoning goes in 'reason'. On a review of source the proof is quoted as 'file:line: verbatim text': 'path' from the source hop to the sink hop to confirm, the guard in 'basis' or 'guards' to refute. Cite the output you saved — record kind=evidence returns its path — in 'control' or 'basis'. The finding's title, description, locations, severity and evidence stay as recorded; if they are wrong, say so in 'reason' and in your handoff, and the operator amends it.";

/**
 * A verifier settles a finding; it does not delete or rewrite one (see
 * VERIFIER_FINDING_KEYS), and its status is a verdict (VERIFIER_STATUSES).
 *
 * It creates a finding only with the `hypothesisId` of a hypothesis on the
 * ledger: a verifier that finds a cleared hypothesis holds after all has to get
 * that finding into the report, and the link says which reasoning it overturns.
 * Like every new finding it goes through the record tool's verdict check, and
 * lands `suspected` short of it. Its hypothesis re-record with an id and a basis
 * is the verification path, and is left alone.
 *
 * The link is checked, not taken on trust. A create without an id goes through
 * the record tool's identity check, which folds a call naming an existing
 * finding's title and location into that finding — newer title, target and
 * status, the longer description, the higher severity. Letting any
 * `hypothesisId` through made that a way round the rule against rewriting by
 * id: a review probe sent the finding under check back with `hypothesisId:
 * "h-any"` and the gate let it through to the merge. So the id has to name a
 * hypothesis that exists, and the call must not be one the record tool would
 * merge into a finding already there. And the hypothesis has to be recorded
 * `confirmed`: a finding linked to one still `refuted` or `proposed` says the
 * reasoning was overturned while the ledger still says it holds.
 *
 * By id, a verifier's write is its verdict, so it carries a status, and a
 * `suspected` one carries what was checked. The record tool reads a look that
 * settled nothing only from a basis or a control case (`hasGrounds`); without
 * either, `status=suspected` is written as a plain last-write-wins edit. A review
 * probe sent `status=suspected` with only a `reason` at reported, confirmed and
 * refuted findings, and each was moved back to suspected — a confirmation whose
 * control case had been run, undone by a sentence.
 *
 * And a finding the operator has given a disposition is theirs to move, whatever
 * a verifier established (`dispositionRefusal`).
 */
async function verifierRefusal(agent: PiredAgent, args: Record<string, unknown>, ledger: ChildLedger): Promise<GateDecision | undefined> {
	if (args.delete === true || args.delete === "true") {
		return { allow: false, reason: `pired: ${agent.name} does not delete findings — refuting is a status, not a deletion. ${VERDICT}` };
	}
	if (passed(args, "status") && !(typeof args.status === "string" && VERIFIER_STATUSES.has(args.status))) {
		const got = typeof args.status === "string" ? args.status : JSON.stringify(args.status);
		return {
			allow: false,
			reason: `pired: ${agent.name} sets a finding's status to ${[...VERIFIER_STATUSES].join(", ")} only, not '${got}'. The other statuses are the operator's dispositions; to withdraw a finding, refute it with a basis. ${VERDICT}`,
		};
	}
	if (!passed(args, "id")) {
		if (passed(args, "hypothesisId")) return linkedCreateRefusal(agent, args, ledger);
		return {
			allow: false,
			reason: `pired: ${agent.name} settles the finding named in its task, by id; it does not create findings of its own. A verifier creates a finding only for a hypothesis it confirmed, by that hypothesis's real id as hypothesisId. ${VERDICT}`,
		};
	}
	const extra = Object.keys(args).filter((key) => passed(args, key) && !VERIFIER_FINDING_KEYS.has(key));
	if (extra.length) {
		return {
			allow: false,
			reason: `pired: ${agent.name} may not change ${extra.map((k) => `'${k}'`).join(", ")} on a finding. ${VERDICT} Record again with only ${[...VERIFIER_FINDING_KEYS].join(", ")}.`,
		};
	}
	if (!passed(args, "status")) {
		return {
			allow: false,
			reason: `pired: ${agent.name}'s write on a finding is its verdict, and this one names no status. ${VERDICT}`,
		};
	}
	if (args.status === "suspected" && !grounded(args)) {
		return {
			allow: false,
			reason: `pired: status=suspected needs what you checked in 'basis' (file:line or an evidence path) or 'control'. A 'reason' alone is a note, not a look: on a finding already confirmed, refuted or reported, it would move the status back to suspected with nothing behind it. ${VERDICT}`,
		};
	}
	return dispositionRefusal(agent, args, ledger);
}

/**
 * Whether a verifier's call says what it checked, read the way the record tool
 * reads it: 'basis' as a string or a list of strings, 'control' as a string,
 * blank ones counting for nothing (`hasGrounds`). Read any other way, the gate
 * could pass a call the record tool then writes as a plain edit.
 */
function grounded(args: Record<string, unknown>): boolean {
	const list = (v: unknown): string[] => typeof v === "string"
		? [v]
		: Array.isArray(v) ? v.filter((b): b is string => typeof b === "string") : [];
	const control = typeof args.control === "string" ? args.control : undefined;
	// Quoted hops and guards say what was looked at, as a basis does.
	return hasGrounds({ basis: [...list(args.basis), ...list(args.path), ...list(args.guards)], control });
}

/**
 * A finding call's fields as the record tool shapes them for its identity
 * check — `extractFields` in core/tools.ts, cut to what `findDuplicate` reads
 * for a finding: title, class, and where it says the bug is.
 *
 * The record tool can still fill in a line afterwards, from the source, for a
 * target that names a file but no line; a location without a line already
 * matches every line of its file here, so that case is covered. One that names
 * no file at all is matched on its title here. The record tool may locate that
 * one from the source first, and a match it then makes on class and line alone
 * is one this check does not see.
 */
function findingFields(args: Record<string, unknown>): Fields {
	const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
	const evidence = typeof args.evidence === "string"
		? [args.evidence]
		: Array.isArray(args.evidence) ? args.evidence.filter((e): e is string => typeof e === "string") : undefined;
	const fields: Fields = {};
	for (const key of ["title", "target", "class", "description", "repro"] as const) {
		const value = text(args[key]);
		if (value !== undefined) fields[key] = value;
	}
	if (evidence?.length) fields.evidence = evidence;
	return fields;
}

async function linkedCreateRefusal(agent: PiredAgent, args: Record<string, unknown>, ledger: ChildLedger): Promise<GateDecision | undefined> {
	const hypothesisId = args.hypothesisId;
	const named = typeof hypothesisId === "string" ? `'${hypothesisId}'` : JSON.stringify(hypothesisId);
	const linked = typeof hypothesisId === "string" ? (await ledger.hypotheses()).find((h) => h.id === hypothesisId) : undefined;
	if (typeof hypothesisId !== "string" || !linked) {
		return {
			allow: false,
			reason: `pired: there is no hypothesis ${named} on the shared ledger. A verifier creates a finding only for a hypothesis it confirmed, by that hypothesis's real id — \`recall hypotheses\` lists them. To settle the finding named in your task, record the verdict on it by its id. ${VERDICT}`,
		};
	}
	const same = findDuplicate("finding", findingFields(args), [...(await ledger.findings())] as unknown as Fields[]);
	if (same) {
		const id = String(same.id);
		return {
			allow: false,
			reason: `pired: this is finding ${id} ('${String(same.title)}'), already on the ledger. Recorded as new it would be merged into ${id}, and a merge takes your title, target and status, the longer description and the higher severity — a rewrite of the finding, not a verdict on it. Record the verdict on ${id} by id instead: record id=${id} status=confirmed|refuted|suspected with its grounds. ${VERDICT}`,
		};
	}
	// After the duplicate check: a create the record tool would merge is refused
	// whatever the hypothesis says, and confirming it first would be a wasted turn.
	if (linked.outcome !== "confirmed") {
		return {
			allow: false,
			reason: `pired: hypothesis ${hypothesisId} is recorded ${linked.outcome}, not confirmed, and a verifier creates a finding only for a hypothesis it confirmed. First record kind=hypothesis id=${hypothesisId} outcome=confirmed statement="what holds" basis=[...] with what you checked; then record this finding with hypothesisId=${hypothesisId}.`,
		};
	}
	return undefined;
}

/**
 * The statuses that are the operator's: every one a verifier may not write
 * except `open`, which is where a finding stood before anyone checked it.
 */
function isDisposition(status: string | undefined): boolean {
	return status !== undefined && status !== "open" && !VERIFIER_STATUSES.has(status);
}

/**
 * A status on a finding the operator has already given a disposition —
 * reported, triaged, false-positive, accepted-risk, ignored. The verification is
 * still worth having: status=suspected with a basis or a control case is judged
 * as a look that settled nothing, which keeps the stored status and writes the
 * look on the row. Any other status moves it, and that is the operator's call.
 *
 * This used to cover `reported` only, and a verifier's refutation with a basis
 * would be judged and written over a `triaged` or `accepted-risk` finding just
 * the same, taking back a decision the operator had made.
 */
async function dispositionRefusal(agent: PiredAgent, args: Record<string, unknown>, ledger: ChildLedger): Promise<GateDecision | undefined> {
	const stored = (await ledger.findings()).find((f) => f.id === args.id);
	if (!stored || !isDisposition(stored.status)) return undefined;
	if (args.status === "suspected" && grounded(args)) return undefined;
	const why = stored.status === "reported" ? "it has gone to the client" : "that is the operator's disposition";
	return {
		allow: false,
		reason: `pired: finding ${stored.id} is already ${stored.status} — ${why}, and whether its status moves is the operator's decision, not ${agent.name}'s. Record status=suspected on it with your grounds in 'basis' or 'control' — that adds your verification without moving the status — and name ${stored.id} and your verdict in your handoff for the operator.`,
	};
}

/** What `arm` reads when the host hands it no ledger. */
const EMPTY_LEDGER: ChildLedger = { findings: async () => [], hypotheses: async () => [] };

/**
 * Whether a write to `store` puts this worker's result on the ledger.
 *
 * A verifier's one durable product is the verdict on the record it was sent to
 * check (`whatToRecord`), and that lives in findings or hypotheses. Counting an
 * endpoint or a blocker it wrote on the way would lift the reserve and the
 * settle reminder for a verifier whose verdict is still only in its handoff.
 * For every other role any ledger row is work established.
 */
function countsFor(agent: PiredAgent | undefined, store: StoreName): boolean {
	return agent?.role !== "verify" || store === "findings" || store === "hypotheses";
}

/**
 * The child's tool-call decision, in order: delegation and the supervisor
 * channel are refused outright; an unarmed child refuses everything; a worker
 * past its turn budget may only `record` and `recall` for HANDOFF_GRACE_TURNS,
 * then any call ends the run; a worker in the last RECORD_RESERVE_TURNS of its
 * budget with nothing recorded may only `record` and `recall`; a `record` outside
 * the worker's role is refused; everything else — the ledger calls the steps
 * above let through included — goes through pired's own scope gate with
 * `maxAgents: 0` and `maxVerifiers: 0`, so a scope-declared `agentTools` name,
 * or a verifier launch the parent's scope allows, is refused as well.
 *
 * Turns are counted from `turn_start`, not tool calls: a turn that reads three
 * files is one step of the investigation, and pi-subagents' `toolBudget.hard`
 * (maxTurns x 8, set by the parent) is the per-call backstop.
 */
export function createChildGuard(): ChildGuard {
	let gate: Gate | undefined;
	let ledger: ChildLedger = EMPTY_LEDGER;
	let failure: string | undefined;
	let agent: PiredAgent | undefined;
	let turns = 0;
	const writes = new Map<StoreName, number>();
	let reminded = false;

	const maxTurns = (): number => agent?.maxTurns ?? FALLBACK_MAX_TURNS;
	// Summed when asked rather than when written, so a role learned after a
	// write still decides what that write counts for.
	const records = (): number => {
		let n = 0;
		for (const [store, count] of writes) if (countsFor(agent, store)) n += count;
		return n;
	};

	return {
		arm(scope, reads) {
			gate = createScopeGate({ ...scope, maxAgents: 0, maxVerifiers: 0 });
			ledger = reads ?? EMPTY_LEDGER;
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
		recorded(store) {
			writes.set(store, (writes.get(store) ?? 0) + 1);
		},
		async check(call) {
			if (CHILD_DENIED_TOOLS.has(call.name)) return delegationRefusal(call.name);
			if (call.name === SUPERVISOR_TOOL) return supervisorRefusal(call.args);
			if (!gate) {
				return {
					allow: false,
					reason: `pired worker is not armed${failure ? ` (${failure})` : ""}; no tool runs until it is. Hand back and say the worker could not start.`,
				};
			}
			const ledgerCall = CHILD_TOOLS.has(call.name);
			const over = turns - maxTurns();
			if (over > HANDOFF_GRACE_TURNS || (over > 0 && !ledgerCall)) return budgetRefusal(agent?.name ?? "this worker", maxTurns(), over);
			// `-over` is the turns left after this one, so the reserve is the
			// budget's last RECORD_RESERVE_TURNS turns: 2, 1 and 0 left for three.
			if (over <= 0 && records() === 0 && -over < RECORD_RESERVE_TURNS && !ledgerCall) return reserveRefusal(agent, -over);
			if (call.name === "record") {
				let refused: GateDecision | undefined;
				try {
					refused = await roleRefusal(agent, call.args, ledger);
				} catch (error) {
					// Toward doing nothing: a rule that could not be checked is not
					// passed. The record tool reads the same stores and would likely
					// fail the same way.
					return {
						allow: false,
						reason: `pired: could not read the shared ledger to check this record call (${error instanceof Error ? error.message : String(error)}). Try once more; if it fails again, put what you would have recorded in your handoff.`,
					};
				}
				if (refused) return refused;
			}
			return gate(call);
		},
		settleCheck(outcome) {
			if (reminded || !gate || records() > 0) return undefined;
			if (outcome !== undefined && outcome !== "completed") return undefined;
			if (turns + 1 - maxTurns() > HANDOFF_GRACE_TURNS) return undefined;
			reminded = true;
			return settleReminder(agent);
		},
		get status() {
			return { armed: gate !== undefined, ...(agent ? { agent: agent.name } : {}), maxTurns: maxTurns(), turns, records: records(), reminded };
		},
	};
}
