#!/usr/bin/env -S node --experimental-strip-types
/**
 * Does delegation happen the way ADR-027 and docs/delegation.md say it should?
 *
 * The matched comparison measures tokens and findings. It cannot tell a
 * candidate that delegated well from one that never delegated (then the grid
 * measures only a prompt change) or from one whose workers spun without
 * recording. This reads one run's parent transcript, the child sessions
 * pi-subagents pinned under `<cell>/child-sessions`, and the ledger, and
 * reports, per `subagent` call:
 *
 * - which agents it launched, whether it ran in the foreground, and the task it
 *   sent: its length, the ledger IDs and source paths it names;
 * - each child's turns, its `record` calls and the IDs they wrote, the turn of
 *   its first record, its tokens and the length of its handoff;
 * - whether the parent later named any of those record IDs, and how far the
 *   parent's prompt grew across the call, which is the whole efficiency
 *   argument: it should grow by the handoff, not by the child's work.
 *
 * Violations break the contract docs/delegation.md states: a child on an agent
 * other than pired's four, an async launch, two workers running at once, more
 * workers than the session budget, a tool call that ran after the worker's
 * per-role turn budget or a worker that kept going past the point pired stops
 * it, a child that recorded nothing, and a child that neither completed nor was
 * stopped by one of those bounds with its spend accounted. A child the bounds
 * stopped is `incomplete`, which is the design working, so it is a note. Notes
 * are worth reading and break nothing. "Used the records" and the path
 * extraction are heuristics over the transcript and are labelled as such.
 * Nothing here decides validity or acceptance; that is the accounting's.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HANDOFF_GRACE_TURNS } from "../core/child.ts";
import { PIRED_AGENTS } from "../core/subagents.ts";
import {
	childOutcome, childRecordIds, observationsFromChildSession, reconcileSubagentCalls,
	type ChildEnding, type ChildOutcome, type ChildSessionExtraction, type ChildStatus, type SubagentCall, type SubagentChild,
} from "./delegation-compare-lib.ts";

type Row = Record<string, unknown>;

/** The agents pired registers with pi-subagents. */
export const PIRED_AGENT_NAMES: readonly string[] = PIRED_AGENTS.map((agent) => agent.name);
/** The worker prompt asks for a handoff of at most this many words. */
export const HANDOFF_WORDS = 200;
/** A child whose first record comes after this many turns spent most of its budget before sharing anything. */
export const LATE_FIRST_RECORD_TURN = 8;
/**
 * A 200-word handoff is about 300 tokens, plus the calling turn's own output
 * and pi-subagents' two status lines. Growth far past that means the child's
 * work reached the parent's context anyway.
 */
export const PROMPT_GROWTH_NOTE = 6000;

/**
 * The bounds a worker is held to, read from the product modules that set them:
 * each role's `maxTurns` (core/subagents.ts), the grace turns after it before
 * pired's gate ends the run (core/child.ts), and the per-session worker budget
 * when the scope sets none (UNSTATED_MAX_AGENTS below). The runner pins these
 * values in the manifest, so a resume refuses across a change to them rather
 * than auditing two halves of a grid by different limits.
 */
/**
 * The worker budget a cell's scope implies when it sets none. It is the default
 * of the snapshots this audit has measured (v3, v4), which was 8, and not
 * `main`'s: since ADR-029 `main` defaults to 0, and reading that here flagged
 * every launch in every v4 cell as over budget. A candidate cut from `main`
 * states its cap in its scope (docs/delegation-v6-plan.md 2.7), so this fallback
 * applies only to snapshots that relied on their own default.
 */
const UNSTATED_MAX_AGENTS = 8;

export interface AuditLimits {
	maxTurns: Record<string, number>;
	handoffGraceTurns: number;
	maxAgents: number;
}

export function auditLimits(): AuditLimits {
	return {
		maxTurns: Object.fromEntries(PIRED_AGENTS.map((agent) => [agent.name, agent.maxTurns])),
		handoffGraceTurns: HANDOFF_GRACE_TURNS,
		maxAgents: UNSTATED_MAX_AGENTS,
	};
}

/**
 * pired's two refusals of a call past a worker's budget (core/child.ts
 * `budgetRefusal`): the warning to hand back, and the stop. A call past the
 * budget whose result is neither ran, which means the gate did not hold.
 */
/** The tools pired's child gate keeps open through a worker's grace turns (ADR-028). */
const LEDGER_TOOLS: ReadonlySet<string> = new Set(["record", "recall"]);

const BUDGET_REFUSAL = /pired: .{1,80}? (?:has used its \d+-turn budget|is \d+ turns past its \d+-turn budget)/;

export interface AuditInput {
	parentEvents: Row[];
	/** Every file under the pinned child-session directory, keyed by its path relative to it. */
	childSessions: Record<string, string>;
	/** Every ledger ID that exists (inventory, hypotheses, findings, blockers, loot). */
	ledgerIds: Set<string>;
	/** Whether a source path (without :line) exists in the reviewed tree. */
	pathExists: (path: string) => boolean;
	/** Agents a launch may use. Defaults to pired's four. */
	agents?: readonly string[];
	/** The session's worker budget; defaults to the scope default (auditLimits). */
	maxAgents?: number;
}

export interface ChildAudit {
	childKey: string;
	toolCallId: string;
	agent: string;
	status: ChildStatus;
	/** How the session ended, when there is one. */
	ending: ChildEnding | null;
	/** What the run amounts to (see childOutcome); null without a session, which the reconciliation errors report. */
	outcome: ChildOutcome | null;
	error?: string;
	sessionFound: boolean;
	turns: number;
	/** The role's turn budget; null for an agent that is not pired's. */
	maxTurns: number | null;
	/** Calls refused because the worker was past its budget. */
	callsRefusedPastBudget: number;
	/** Calls that ran after the budget: the child gate did not hold. */
	callsRunPastBudget: number;
	/**
	 * `record`/`recall` calls that ran in the grace turns after the budget. The
	 * child gate keeps the ledger open there (ADR-028): 17–18 worker records were
	 * refused at the budget line in the v4 grids, 11 of them lost entirely.
	 */
	ledgerCallsInGrace: number;
	toolCalls: number;
	toolErrors: number;
	recordCalls: number;
	/** Distinct ledger IDs the child's successful `record` calls wrote or matched. */
	recordIds: string[];
	recordKinds: Record<string, number>;
	findingIds: string[];
	/** The child turn of its first successful `record` call. */
	firstRecordTurn: number | null;
	/** Every provider token in the child's session: replies, compactions, warms. */
	tokens: number;
	handoffWords: number;
}

export interface SubagentCallAudit {
	toolCallId: string;
	requestedAgent: string | null;
	/** Agents of the children it launched. */
	agents: string[];
	async: boolean;
	/** Ended in error without launching a child. */
	rejected: boolean;
	taskChars: number;
	/** Heuristic: six-hex tokens in the task that are ledger IDs. */
	ledgerRefs: string[];
	/** Heuristic: path-like tokens in the task that exist in the target. */
	paths: string[];
	/** Heuristic: tokens with a directory and an extension that do not exist in the target. */
	unresolvedPaths: string[];
	children: ChildAudit[];
	/** Characters of the tool result the parent's context received. */
	handoffChars: number;
	/** Heuristic: a later parent tool call or reply names one of the children's record IDs. */
	parentUsedRecords: boolean;
	/** Parent prompt tokens on the turn that made the call, and on the first turn after it returned. */
	parentPromptAtCall: number | null;
	parentPromptAfterCall: number | null;
}

export interface DelegationAudit {
	/** At least one child was launched. */
	delegated: boolean;
	/** `subagent` launch attempts; management actions are not counted. */
	calls: number;
	subagentCalls: SubagentCallAudit[];
	/** Every launched child, flattened. */
	workers: ChildAudit[];
	parentTurns: number;
	parentTurnsBeforeFirstDelegate: number | null;
	parentRecordsBeforeFirstDelegate: number | null;
	parentTokens: number;
	workerTokens: number;
	/** Parent prompt size (input + cache read + cache write) per turn, for inspecting context growth. */
	parentPromptSeries: number[];
	/** What `reconcileSubagentCalls` found; the accounting decides what they mean. */
	reconciliationErrors: string[];
	/** Contract breaches. An empty list means every checked promise held. */
	violations: string[];
	/** Observations worth reading that break no promise. */
	notes: string[];
}

const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const promptOf = (usage: unknown): number => {
	const u = isRow(usage) ? usage : {};
	return num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
};
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const LEDGER_ID = /^[0-9a-f]{6}$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** Ledger IDs and source paths a task names. Heuristic: a route or a prose slash can look like a path. */
function taskRefs(task: string, ledgerIds: Set<string>, pathExists: (path: string) => boolean): { ledgerRefs: string[]; paths: string[]; unresolvedPaths: string[] } {
	const ledgerRefs = new Set<string>();
	const paths = new Set<string>();
	const unresolved = new Set<string>();
	for (const raw of task.split(/[\s,;()`'"<>[\]{}]+/)) {
		const token = raw.replace(/[.:!?]+$/, "");
		if (!token || token.includes("://")) continue;
		if (LEDGER_ID.test(token)) {
			if (ledgerIds.has(token)) ledgerRefs.add(token);
			continue;
		}
		const path = token.replace(/:\d+(?::\d+)?$/, "");
		if (!path.includes("/") && !EXTENSION.test(path)) continue;
		if (pathExists(path)) paths.add(token);
		else if (path.includes("/") && EXTENSION.test(path)) unresolved.add(token);
	}
	return { ledgerRefs: [...ledgerRefs], paths: [...paths], unresolvedPaths: [...unresolved] };
}

function auditChild(child: SubagentChild, session: ChildSessionExtraction | undefined, limits: AuditLimits): ChildAudit {
	const calls = session?.toolCalls ?? [];
	const maxTurns = limits.maxTurns[child.agent] ?? null;
	const pastBudget = maxTurns === null ? [] : calls.filter((c) => c.turn > maxTurns && c.resultText !== undefined);
	const refused = pastBudget.filter((c) => c.isError === true && BUDGET_REFUSAL.test(c.resultText ?? ""));
	// The gate's grace window, in the audit's turn count (assistant messages, one
	// ahead of the gate's turn_start count at the stop — the same +1 the ceiling
	// below uses).
	const graceEnd = maxTurns === null ? null : maxTurns + limits.handoffGraceTurns + 1;
	const ranPast = pastBudget.filter((c) => !refused.includes(c));
	const ledgerInGrace = ranPast.filter((c) => LEDGER_TOOLS.has(c.name) && graceEnd !== null && c.turn <= graceEnd);
	const records = calls.filter((c) => c.name === "record");
	const written = records.filter((c) => c.isError === false);
	const recordKinds: Record<string, number> = {};
	const findingIds = new Set<string>();
	for (const call of written) {
		const details = isRow(call.details) ? call.details : {};
		const kind = String(details.kind ?? call.arguments.kind ?? "unknown");
		recordKinds[kind] = (recordKinds[kind] ?? 0) + 1;
		if (kind === "finding") for (const id of childRecordIds(call)) findingIds.add(id);
	}
	return {
		childKey: child.childKey, toolCallId: child.toolCallId, agent: child.agent, status: child.status,
		ending: session?.ending ?? null,
		outcome: session ? childOutcome(child, session).outcome : null,
		...(child.error ? { error: child.error } : {}),
		sessionFound: child.sessionFound,
		turns: session?.turns ?? 0,
		maxTurns,
		callsRefusedPastBudget: refused.length,
		callsRunPastBudget: ranPast.length - ledgerInGrace.length,
		ledgerCallsInGrace: ledgerInGrace.length,
		toolCalls: calls.length,
		toolErrors: calls.filter((c) => c.isError === true).length,
		recordCalls: records.length,
		recordIds: [...new Set(written.flatMap(childRecordIds))],
		recordKinds,
		findingIds: [...findingIds],
		firstRecordTurn: written[0]?.turn ?? null,
		tokens: (session?.observations ?? []).reduce((n, o) => n + num(o.usage?.totalTokens), 0),
		handoffWords: words(session?.finalText ?? ""),
	};
}

export function auditDelegation(input: AuditInput): DelegationAudit {
	const events = input.parentEvents;
	const allowed = new Set(input.agents ?? PIRED_AGENT_NAMES);
	const limits = auditLimits();
	const maxAgents = input.maxAgents ?? limits.maxAgents;
	const violations: string[] = [];
	const notes: string[] = [];

	// Parent turns, their prompt sizes, and which turn issued which tool call.
	const assistantEventIndex: number[] = [];
	const promptSeries: number[] = [];
	const turnOfCall = new Map<string, number>();
	let parentTokens = 0;
	for (const [i, e] of events.entries()) {
		if (e.type !== "message_end" || !isRow(e.message) || e.message.role !== "assistant") continue;
		const m = e.message;
		const turn = assistantEventIndex.length;
		assistantEventIndex.push(i);
		promptSeries.push(promptOf(m.usage));
		parentTokens += num(isRow(m.usage) ? m.usage.totalTokens : undefined);
		for (const c of Array.isArray(m.content) ? m.content : []) {
			if (isRow(c) && c.type === "toolCall" && typeof c.id === "string") turnOfCall.set(c.id, turn);
		}
	}
	const turnAfterEvent = (index: number): number | null => {
		const t = assistantEventIndex.findIndex((i) => i > index);
		return t < 0 ? null : t;
	};
	const startIndex = new Map<string, number>();
	const endIndex = new Map<string, number>();
	const recordEnds: number[] = [];
	for (const [i, e] of events.entries()) {
		if (typeof e.toolCallId !== "string") continue;
		if (e.type === "tool_execution_start" && !startIndex.has(e.toolCallId)) startIndex.set(e.toolCallId, i);
		if (e.type === "tool_execution_end") {
			if (!endIndex.has(e.toolCallId)) endIndex.set(e.toolCallId, i);
			if (e.toolName === "record" && e.isError !== true) recordEnds.push(i);
		}
	}

	const reconciliation = reconcileSubagentCalls(events, Object.keys(input.childSessions));
	const sessions = new Map<string, ChildSessionExtraction>();
	for (const child of reconciliation.children) {
		const text = input.childSessions[child.sessionPath];
		if (text !== undefined) sessions.set(child.childKey, observationsFromChildSession(text, child.childKey));
	}
	const launches = reconciliation.calls.filter((call) => !call.action);

	const audits: SubagentCallAudit[] = launches.map((call: SubagentCall) => {
		const children = call.children.map((child) => auditChild(child, sessions.get(child.childKey), limits));
		const refs = taskRefs(call.task ?? "", input.ledgerIds, input.pathExists);
		const ids = [...new Set(children.flatMap((c) => c.recordIds))];
		const after = endIndex.get(call.toolCallId);
		// Heuristic: the records were used if a later parent tool call or reply names one.
		const laterText = after === undefined ? "" : events.slice(after + 1).flatMap((e) => {
			if (e.type === "tool_execution_start") return [JSON.stringify(e.args ?? {})];
			if (e.type === "message_end" && isRow(e.message) && e.message.role === "assistant") return [JSON.stringify(e.message.content ?? "")];
			return [];
		}).join("\n");
		const callTurn = turnOfCall.get(call.toolCallId);
		const afterTurn = after === undefined ? null : turnAfterEvent(after);
		return {
			toolCallId: call.toolCallId,
			requestedAgent: call.requestedAgent ?? null,
			agents: call.children.map((c) => c.agent),
			async: call.async,
			rejected: call.isError && call.children.length === 0,
			taskChars: call.task?.length ?? 0,
			...refs,
			children,
			handoffChars: call.resultText.length,
			parentUsedRecords: ids.some((id) => new RegExp(`\\b${id}\\b`).test(laterText)),
			parentPromptAtCall: callTurn === undefined ? null : promptSeries[callTurn] ?? null,
			parentPromptAfterCall: afterTurn === null ? null : promptSeries[afterTurn] ?? null,
		};
	});

	const workers = audits.flatMap((a) => a.children);
	const first = launches.find((call) => call.children.length > 0);
	const firstStart = first ? startIndex.get(first.toolCallId) : undefined;
	const recordsBefore = firstStart === undefined ? null : recordEnds.filter((i) => i < firstStart).length;
	// Not a violation: delegation is the model's choice. In a candidate run it
	// means the comparison measured the prompt change, not the workers.
	if (workers.length === 0) notes.push("the parent never delegated");
	if (recordsBefore === 0) notes.push("the parent delegated before recording anything it knew");
	// The gate charges every launch against the budget, so more launched children
	// than the budget means it did not hold.
	if (workers.length > maxAgents) violations.push(`the parent launched ${workers.length} workers, over the session budget of ${maxAgents}`);
	// One at a time: pi runs the tool calls of one reply in parallel, so two
	// launches in one reply would put two workers on the ledger at once.
	const spans = audits.filter((a) => a.children.length > 0).flatMap((a) => {
		const from = startIndex.get(a.toolCallId);
		const to = endIndex.get(a.toolCallId);
		return from === undefined || to === undefined ? [] : [{ id: a.toolCallId, from, to }];
	});
	for (const [i, a] of spans.entries()) {
		for (const b of spans.slice(i + 1)) if (a.from < b.to && b.from < a.to) violations.push(`subagent calls ${a.id} and ${b.id} ran at the same time; pired's workers run one at a time`);
	}
	for (const a of audits) {
		if (a.rejected) {
			const who = a.requestedAgent ?? "(no agent)";
			if (a.requestedAgent && !allowed.has(a.requestedAgent)) notes.push(`subagent call ${a.toolCallId} asked for ${who}, not a pired agent, and was rejected`);
			else notes.push(`subagent call ${a.toolCallId} (${who}) was rejected before a child started`);
			continue;
		}
		if (a.async) violations.push(`subagent call ${a.toolCallId} launched an async run${a.requestedAgent ? ` of ${a.requestedAgent}` : ""}; pired's workers run in the foreground`);
		if (a.unresolvedPaths.length) notes.push(`subagent call ${a.toolCallId}: task names paths not in the target (heuristic): ${a.unresolvedPaths.join(", ")}`);
		for (const c of a.children) {
			const who = `child ${c.childKey} (${c.agent})`;
			if (!allowed.has(c.agent)) violations.push(`${who}: not one of pired's agents`);
			// A bound stopping a worker is the design working; anything else short of
			// completion broke the handoff contract or left its spend unaccounted.
			if (c.outcome === "incomplete") notes.push(`${who}: stopped by ${c.ending === "budget-stop" ? "pired's turn budget" : "pi-subagents' worker timeout"} after ${c.turns} turns; its records stand and its spend is counted`);
			else if (c.outcome === null ? c.status !== "completed" : c.outcome !== "completed") violations.push(`${who}: ended ${c.status}${c.error ? `: ${c.error.split("\n")[0]}` : ""}`);
			if (c.maxTurns !== null) {
				const ceiling = c.maxTurns + limits.handoffGraceTurns + 1;
				if (c.callsRunPastBudget) violations.push(`${who}: ${c.callsRunPastBudget} tool call(s) ran after its ${c.maxTurns}-turn budget; pired's child gate refuses every call past it except record and recall in its grace turns`);
				if (c.ledgerCallsInGrace) notes.push(`${who}: ${c.ledgerCallsInGrace} record/recall call(s) in its grace turns after the ${c.maxTurns}-turn budget`);
				if (c.turns > ceiling) violations.push(`${who}: ${c.turns} turns, past the ${ceiling} at which pired stops a ${c.maxTurns}-turn worker`);
				else if (c.callsRefusedPastBudget && c.outcome !== "incomplete") notes.push(`${who}: ${c.callsRefusedPastBudget} call(s) refused past its ${c.maxTurns}-turn budget before it handed back`);
			}
			if (c.recordIds.length === 0 && !Object.keys(c.recordKinds).length) violations.push(`${who}: made no durable record`);
			else if (c.firstRecordTurn !== null && c.firstRecordTurn > LATE_FIRST_RECORD_TURN) notes.push(`${who}: first record at turn ${c.firstRecordTurn}`);
			if (c.handoffWords > HANDOFF_WORDS) notes.push(`${who}: handoff of ${c.handoffWords} words`);
		}
		if (a.children.some((c) => c.recordIds.length) && !a.parentUsedRecords) notes.push(`subagent call ${a.toolCallId}: no later parent call or reply names its children's records (heuristic)`);
		if (a.parentPromptAtCall !== null && a.parentPromptAfterCall !== null) {
			const growth = a.parentPromptAfterCall - a.parentPromptAtCall;
			if (growth > PROMPT_GROWTH_NOTE) notes.push(`subagent call ${a.toolCallId}: parent prompt grew ${growth} tokens across the call`);
		}
	}

	return {
		delegated: workers.length > 0,
		calls: launches.length,
		subagentCalls: audits,
		workers,
		parentTurns: promptSeries.length,
		parentTurnsBeforeFirstDelegate: first ? (turnOfCall.get(first.toolCallId) ?? null) : null,
		parentRecordsBeforeFirstDelegate: recordsBefore,
		parentTokens,
		workerTokens: workers.reduce((n, w) => n + w.tokens, 0),
		parentPromptSeries: promptSeries,
		reconciliationErrors: reconciliation.errors,
		violations,
		notes,
	};
}

/** One grid's candidate runs, aggregated: how often and how well delegation happened. */
export interface DelegationAuditSummary {
	runs: number;
	runsThatDelegated: number;
	calls: number;
	workers: number;
	workersByAgent: Record<string, number>;
	workersByStatus: Record<string, number>;
	/** completed / incomplete (stopped by a bound, spend counted) / failed / unaccounted. */
	workersByOutcome: Record<string, number>;
	workersWithoutRecords: number;
	workerTokenShare: number | null;
	runsWithViolations: number;
	violations: string[];
}

export function summarizeAudits(audits: Array<{ label: string; audit: DelegationAudit }>): DelegationAuditSummary {
	const workers = audits.flatMap(({ audit }) => audit.workers);
	const count = (key: (w: ChildAudit) => string): Record<string, number> => {
		const out: Record<string, number> = {};
		for (const w of workers) out[key(w)] = (out[key(w)] ?? 0) + 1;
		return out;
	};
	const parent = audits.reduce((n, { audit }) => n + audit.parentTokens, 0);
	const worker = audits.reduce((n, { audit }) => n + audit.workerTokens, 0);
	return {
		runs: audits.length,
		runsThatDelegated: audits.filter(({ audit }) => audit.delegated).length,
		calls: audits.reduce((n, { audit }) => n + audit.calls, 0),
		workers: workers.length,
		workersByAgent: count((w) => w.agent),
		workersByStatus: count((w) => w.status),
		workersByOutcome: count((w) => w.outcome ?? "no session"),
		workersWithoutRecords: workers.filter((w) => w.recordIds.length === 0 && !Object.keys(w.recordKinds).length).length,
		workerTokenShare: parent + worker > 0 ? worker / (parent + worker) : null,
		runsWithViolations: audits.filter(({ audit }) => audit.violations.length > 0).length,
		violations: audits.flatMap(({ label, audit }) => audit.violations.map((v) => `${label}: ${v}`)),
	};
}

function readJsonl(path: string): Row[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		try { return [JSON.parse(line) as Row]; } catch { return []; }
	});
}

/** Every file under `root`, keyed by its path relative to it. */
function readTree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const abs = join(entry.parentPath, entry.name);
		out[abs.slice(root.length + 1).split("\\").join("/")] = readFileSync(abs, "utf8");
	}
	return out;
}

/** Audit one comparison cell (or any directory with transcript + workspace + target + child-sessions). */
export function auditCell(cellDir: string, options: { transcript?: string; workspace?: string; target?: string; childSessions?: string } = {}): DelegationAudit {
	const transcript = options.transcript ?? join(cellDir, "transcript.jsonl");
	const workspace = options.workspace ?? join(cellDir, "workspace");
	const target = resolve(options.target ?? join(cellDir, "target"));
	const ledgerIds = new Set<string>();
	for (const name of ["inventory", "hypotheses", "findings", "blockers", "loot"]) {
		for (const row of readJsonl(join(workspace, `${name}.jsonl`))) if (typeof row.id === "string") ledgerIds.add(row.id);
	}
	// The engagement's own budget when its scope set one; the cells' review scope
	// sets none, so the scope default applies.
	let maxAgents: number | undefined;
	try {
		const scope = JSON.parse(readFileSync(join(workspace, "scope.json"), "utf8")) as { maxAgents?: unknown };
		if (typeof scope.maxAgents === "number" && Number.isInteger(scope.maxAgents) && scope.maxAgents >= 0) maxAgents = scope.maxAgents;
	} catch { /* no scope file: the default */ }
	return auditDelegation({
		parentEvents: readJsonl(transcript),
		childSessions: readTree(resolve(options.childSessions ?? join(cellDir, "child-sessions"))),
		ledgerIds,
		...(maxAgents === undefined ? {} : { maxAgents }),
		pathExists: (path) => {
			const abs = resolve(target, path);
			return (abs === target || abs.startsWith(target + "/")) && existsSync(abs);
		},
	});
}

/** The human-readable form of one audit, as the CLI prints it. */
export function formatAudit(label: string, audit: DelegationAudit): string {
	const lines = [`${label}: ${audit.delegated ? `${audit.calls} subagent call(s), ${audit.workers.length} child(ren)` : "no delegation"} · parent ${audit.parentTurns} turns, ${audit.parentTokens} tokens · children ${audit.workerTokens} tokens`];
	if (audit.delegated) lines.push(`  first child at parent turn ${audit.parentTurnsBeforeFirstDelegate} after ${audit.parentRecordsBeforeFirstDelegate} record(s)`);
	for (const call of audit.subagentCalls) {
		lines.push(`  call ${call.toolCallId} ${call.requestedAgent ?? "-"}${call.rejected ? " REJECTED" : ""}${call.async ? " ASYNC" : ""} · task ${call.taskChars} chars, ${call.ledgerRefs.length} ledger ref(s), ${call.paths.length} path(s)${call.unresolvedPaths.length ? ` (${call.unresolvedPaths.length} unresolved)` : ""} · handoff ${call.handoffChars} chars · parent prompt ${call.parentPromptAtCall ?? "?"} → ${call.parentPromptAfterCall ?? "?"} · records used ${call.parentUsedRecords ? "yes" : "no"}`);
		for (const c of call.children) {
			lines.push(`    ${c.childKey} ${c.agent} ${c.status}${c.outcome === null || c.outcome === c.status ? "" : ` (${c.outcome})`} · ${c.turns} turns · ${c.recordIds.length} record ID(s) ${JSON.stringify(c.recordKinds)} · first record turn ${c.firstRecordTurn ?? "-"} · ${c.tokens} tokens · handoff ${c.handoffWords} words`);
		}
	}
	for (const e of audit.reconciliationErrors) lines.push(`  reconciliation ${e}`);
	for (const v of audit.violations) lines.push(`  VIOLATION ${v}`);
	for (const n of audit.notes) lines.push(`  note ${n}`);
	return lines.join("\n");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const json = args.includes("--json");
	const dirs = args.filter((a) => a !== "--json");
	if (!dirs.length) {
		process.stderr.write("Usage: delegation-audit.ts [--json] <cell-dir>...\n");
		process.exitCode = 2;
		return;
	}
	const audits = dirs.map((dir) => ({ label: dir, audit: auditCell(dir) }));
	if (json) process.stdout.write(`${JSON.stringify({ audits, summary: summarizeAudits(audits) }, null, 2)}\n`);
	else {
		for (const { label, audit } of audits) process.stdout.write(`${formatAudit(label, audit)}\n`);
		if (audits.length > 1) process.stdout.write(`${JSON.stringify(summarizeAudits(audits), null, 2)}\n`);
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
