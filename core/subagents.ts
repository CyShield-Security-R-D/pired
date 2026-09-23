/**
 * The four pired worker agents, and the definitions that register them.
 *
 * pired delegates only through the pi-subagents ecosystem (ADR-027): it ships no
 * spawn machinery of its own. What lives here is the parent half that
 * pi-subagents needs — the agents' identities, their role prompts, and a builder
 * that turns the parent's current model/thinking/workspace/scope into runtime
 * agent definitions. The definitions travel to pi-subagents over an event
 * (extensions/pired.ts); this module never imports pi-subagents and never does
 * I/O, so the whole thing is unit-testable against the recorded schema.
 *
 * The definition fields are the COMMON SUBSET of what pi-subagents 0.66 and 0.71
 * both accept: 0.71 rejects `fallbackModels`/`completionGuard`, 0.66 rejects
 * `machine`, so none of those appear. `allowNestedSubagents: false` is used in
 * preference to `maxSubagentDepth: 0`, which both versions' validator rejects as
 * a non-positive integer.
 *
 * Pure module: builds strings and plain objects. No ports, no I/O, no pi.
 */

import type { EngagementScope } from "./ontology.ts";

/** The role a worker plays; the child learns it from the prompt marker below. */
export type PiredRole = "scout" | "investigate" | "verify" | "escalate";

/**
 * A pired worker agent: its stable identity and how many turns it may take.
 *
 * `maxTurns` is the child's own stop line (the child extension enforces it) and
 * also seeds the definition's `toolBudget.hard`. The numbers come from what each
 * role actually needs: scouting an area and escalating impact are broad (20),
 * a deep single-module dive is the longest (24), and a fresh refutation is the
 * tightest because a check that sprawls has stopped being a check (16).
 */
export interface PiredAgent {
	name: string;
	role: PiredRole;
	maxTurns: number;
	/** One line for pi-subagents' agent list, so a model can pick the right worker. */
	description: string;
	/** Role-specific body of the worker prompt (what this worker is for). */
	mission: string;
}

/**
 * Roughly how many tool calls a turn spends, used to size `toolBudget.hard` off
 * `maxTurns`. Eight is generous — a turn that reads a file, greps, and records is
 * three — so the budget is a runaway backstop, not the real stop line, which is
 * the turn count the child enforces.
 */
const TOOLS_PER_TURN = 8;

/**
 * A safety net behind the turn budget, never the stop line. At the ~40 s a
 * GLM-5.3 Flash reply took in the pilot, a 24-turn worker needs ~16 minutes, so
 * the earlier 15-minute cap fired mid-request — and a request cut off mid-flight
 * never reaches the child's session, so its spend cannot be counted. Forty-five
 * minutes leaves the turn budget to bind first.
 */
const WORKER_TIMEOUT_MS = 45 * 60 * 1000;

/** The tools every worker gets: read-side exploration, bash, and pired's ledger. */
export const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "record", "recall"] as const;

/**
 * The four workers.
 *
 * Each maps to one part of an assessment a parent would otherwise do inline and
 * lose context to. The missions restate pired's standing rules in the worker's
 * own terms — record as you go, a suspected finding stays suspected until proven,
 * never inflate severity — because a fresh child does not carry the parent's
 * prompt and its only durable channel back is the shared ledger.
 */
export const PIRED_AGENTS: readonly PiredAgent[] = [
	{
		name: "pired-scout",
		role: "scout",
		maxTurns: 20,
		description: "Map the attack surface of an area: routes, handlers, inputs, trust boundaries, sinks. Records surface (with file) and proposes hypotheses.",
		mission:
			"You are mapping the attack surface of the area named in your task. Enumerate what an attacker reaches: routes, request handlers, inputs and parameters, trust boundaries, and the dangerous sinks input flows into. `record` each element as surface (`kind=endpoint`/`host`/etc.) the moment you find it, ALWAYS with the source `file` so the coverage matrix has something to point at. Where you see a plausible weakness, `record kind=hypothesis` as `proposed` against the element and its checklist class — a lead, not a verdict. Do not try to confirm anything; scouting is breadth. Return a short list of the surface and hypotheses you recorded.",
	},
	{
		name: "pired-investigate",
		role: "investigate",
		maxTurns: 24,
		description: "Deep-dive one module or lead. Records hypotheses with verdicts and findings (suspected until verified), citing exact file:line.",
		mission:
			"You are investigating the one module or lead named in your task, in depth. Trace untrusted input from source to sink, reason about the code by hand where a scanner is blind (access control, IDOR, business logic), and run tools over `bash` where they are more complete than reading. `record kind=hypothesis` with an `outcome` as you settle each test case, and `record kind=finding` as soon as a flaw is supported — `suspected` until you have run the control case that had to fail for it to mean anything. Cite exact `file:line` in every description and save raw output under evidence. Stay on the assigned lead; a general coverage reminder is not a new assignment. Return the record IDs and evidence paths.",
	},
	{
		name: "pired-verify",
		role: "verify",
		maxTurns: 16,
		description: "Fresh adversarial check of a finding or a cleared hypothesis. Tries to refute it from source or a control case; records a grounded verdict.",
		mission:
			"You are a fresh, skeptical pair of eyes. Your job is to REFUTE the finding or cleared hypothesis named in your task, not to agree with it: read `recall challenge id=<id>` for the brief, then find the input it did not consider or the call path it did not follow. Ground the verdict in source (`basis=file:line`) or a control case you actually ran (`live=true`); `record` it against the hypothesis as `confirmed`, `refuted`, or `inconclusive`. Do not promote anything to a finding and do not widen the check — a verification that sprawls has stopped being one. Return the verdict, what it was grounded in, and the evidence path.",
	},
	{
		name: "pired-escalate",
		role: "escalate",
		maxTurns: 20,
		description: "Amplify impact: trace what findings and open hypotheses unlock, try chains, scan for amplifiers. Records a chained finding only with a concrete path.",
		mission:
			"You are amplifying impact. `recall` the existing findings and the open or suspected hypotheses, then trace what each one unlocks: reachable sinks, privileged operations, secrets, trust boundaries it lets an attacker cross. Try combinations — a low-severity primitive plus another can be a chain worth more than the sum. Scan the code for amplifiers (an SSRF that reaches metadata, an upload that lands in a served path). `record kind=finding` for a chain ONLY when you have a concrete path: cite the component record IDs and each hop's `file:line`. If the path is plausible but unproven, record it as a hypothesis instead. Never inflate severity without evidence for the reach you are claiming. Return the chain and the records you wrote.",
	},
] as const;

/** The agent names the parent gate treats as pired's own, in a set for O(1) checks. */
export const PIRED_AGENT_NAMES: ReadonlySet<string> = new Set(PIRED_AGENTS.map((a) => a.name));

/**
 * The definition shape pi-subagents accepts, narrowed to the common subset this
 * module actually sets. Declared here rather than imported so `core/` keeps its
 * rule of importing nothing from the outside world; the fields are checked
 * against the recorded 0.66 and 0.71 registry schemas.
 */
export interface RuntimeAgentDefinition {
	description: string;
	systemPrompt: string;
	systemPromptMode: "replace" | "append";
	tools: string[];
	extensions: string[];
	model?: string;
	thinking?: string | false;
	defaultContext: "fresh" | "fork";
	defaultAsync: boolean;
	inheritProjectContext: boolean;
	inheritGlobalContext: boolean;
	inheritSkills: boolean;
	allowNestedSubagents: boolean;
	/**
	 * `false` switches off pi-subagents' acceptance contract. With it on, 0.71
	 * appends an "Acceptance Contract" to every worker prompt demanding a JSON
	 * `acceptance-report` block — output spent on every worker, and a second
	 * handoff format fighting the ≤200-word one pired's parent reads.
	 */
	defaultAcceptance: false;
	defaultTimeoutMs: number;
	toolBudget: { hard: number };
}

/** What the parent knows at registration time and the definitions need. */
export interface AgentBuildContext {
	/** Absolute path to pired's child extension (`extensions/child.ts`), resolved by the host. */
	childExtension: string;
	/** The parent model as `provider/id`; omitted lets pi-subagents pick the child's default. */
	model?: string;
	/** The parent's thinking level (a pi level string); `off` maps to `false`. */
	thinking: string;
	/** Absolute workspace directory, named in the prompt so the worker writes to the right ledger. */
	workspace: string;
	/** The operator prompt's own scope wording (`scopeGuidance`), so a worker never reads the engagement differently from its parent. */
	scopeGuidance: string;
}

/** The agent-name marker the parent writes into the prompt for the child to read back. */
export function agentMarker(name: string): string {
	return `<!-- pired-agent: ${name} -->`;
}

/**
 * The worker prompt: a self-contained system prompt (replace mode), so it must
 * stand on its own — the child does not inherit the parent's operator prompt.
 *
 * The marker comes first so `ctx.getSystemPrompt()` in the child always contains
 * it regardless of how pi assembles the rest. The handoff bound is stated
 * explicitly because a worker's only accountable output is the ledger plus a
 * short return; a transcript-length answer defeats the point of delegating.
 */
export function workerPrompt(agent: PiredAgent, ctx: AgentBuildContext): string {
	return [
		agentMarker(agent.name),
		`You are ${agent.name}, a pired ${agent.role} worker: a focused security specialist a lead operator delegated one task to. You are not the operator and you do not run the engagement — you do the one thing your task names and hand it back.`,
		`Scope — the same boundary the operator works under:\n${ctx.scopeGuidance}\nStay inside it. pired's scope gate refuses anything outside it with a reason; if it refuses a step, record what you could not do and carry on with the rest of your task.`,
		`Shared workspace: ${ctx.workspace} (evidence under ${ctx.workspace}/evidence/, reachable as $PIRED_WORKSPACE in your shell). Your \`record\` and \`recall\` write to and read from this same ledger the operator sees — your records appear to them immediately.`,
		"Read the shared state before you start: `recall context` (narrow it with the exact IDs and paths from your task) gives the model, checklist, surface, hypotheses, findings and open blockers as they stand now. Trust the ledger over your own assumptions; it does not forget.",
		"Record as you go, not at the end: surface the moment you find it (with its source file), a hypothesis before you test it, a finding as soon as it is supported. A finding is `suspected` until the control case that had to fail has been run. Never fabricate output or a CVE, and never claim a severity you cannot show the reach for.",
		agent.mission,
		`You have at most ${agent.maxTurns} turns; when they run out the harness stops you, so finish and hand back before then. Your handoff is your final message and must be at most 200 words: list the record IDs you wrote, the evidence paths, your verdicts, and anything you left unresolved. Do not paste transcripts or re-list what is already in the ledger — the operator reads the records, not your steps.`,
	].join("\n\n").trim();
}

/**
 * Build the runtime agent definitions to register with pi-subagents.
 *
 * Every field is the common 0.66/0.71 subset. `defaultAsync: false` and the
 * absence of any worktree/async option are what keep a pired worker a
 * foreground, accountable child; `allowNestedSubagents: false` stops a worker
 * from spawning its own. `tools` MUST include `record`/`recall`: pi-subagents
 * fails a child closed at start when an allowlisted tool is missing, so listing
 * them makes a child extension that failed to load a hard failure rather than a
 * silent worker with no ledger.
 */
export function buildPiredAgentDefinitions(ctx: AgentBuildContext): Array<{ name: string; definition: RuntimeAgentDefinition }> {
	const thinking: string | false = ctx.thinking === "off" ? false : ctx.thinking;
	return PIRED_AGENTS.map((agent) => ({
		name: agent.name,
		definition: {
			description: agent.description.trim(),
			systemPrompt: workerPrompt(agent, ctx),
			systemPromptMode: "replace",
			tools: [...WORKER_TOOLS],
			extensions: [ctx.childExtension],
			...(ctx.model ? { model: ctx.model } : {}),
			thinking,
			defaultContext: "fresh",
			defaultAsync: false,
			inheritProjectContext: false,
			inheritGlobalContext: false,
			inheritSkills: false,
			allowNestedSubagents: false,
			defaultAcceptance: false,
			defaultTimeoutMs: WORKER_TIMEOUT_MS,
			toolBudget: { hard: agent.maxTurns * TOOLS_PER_TURN },
		},
	}));
}

/**
 * The operator's standing authorization for the four pired workers, injected
 * into the parent prompt when — and only when — the agents registered.
 *
 * pi-subagents tells a model that "direct execution is the default; complexity
 * alone never authorizes delegation" and that authorization must come from the
 * request "or applicable instructions". The first version of this block called
 * delegation "never required" and "for when your context gets noisy": in the
 * first official grid (2026-09-24) four of five candidate sessions ran 18–97
 * turns on whole-application reviews without once enabling the tool. This block
 * states the operator's authorization in pi-subagents' own terms and informs the
 * model of the economics (every read is re-sent on every later request; a worker
 * returns 200 words), without forcing a single launch. It is omitted entirely
 * when pi-subagents is absent, so a model is never told to use a tool it does
 * not have.
 */
export function delegationBlock(scope?: EngagementScope): string {
	const disabled = scope?.maxAgents === 0;
	if (disabled) {
		return `<delegation>
Delegation is turned off for this engagement (maxAgents=0). Do the work in this session.
</delegation>`;
	}
	return `<delegation>
Standing authorization from the operator for this engagement: delegation to the four pired workers below is authorized. These are the applicable instructions pi-subagents asks for, so you do not need a request in the current message. Call \`subagents_enable\` once to load the \`subagent\` tool.
Why it matters: your context is this review's scarcest budget. Every file you read and every tool output stays in your context and is sent again with every later request, so reading a whole module yourself is paid for on each turn that follows. A worker reads in a fresh context and hands back at most 200 words plus the records it wrote to this same ledger — you keep the conclusions, not the reading.
- \`pired-scout\` — map an area's attack surface (routes, handlers, inputs, trust boundaries, sinks) and record it. A natural first move on each large area of an unfamiliar codebase, before you choose where to dig.
- \`pired-investigate\` — take one module or lead to a verdict in isolation.
- \`pired-verify\` — try to refute a finding or a cleared cell with fresh eyes before it reaches a report.
- \`pired-escalate\` — once findings exist, trace what they unlock and whether they chain.
Record what you already know first, then launch with \`{ agent, task }\` and put the exact file paths and record IDs in the task — the worker sees a bounded snapshot, not your transcript; its model, context and limits are fixed, and a call that overrides them is refused. Workers run one at a time, in the foreground (one launch per message; a second while one runs is refused); read their records after the handoff. You keep the plan, the cross-component reasoning and the final severity judgment — a worker's return is a lead to weigh, not tested coverage. For a small, focused check, doing it yourself is often cheaper; for mapping or deep-diving a large area, a worker usually is.
</delegation>`;
}

/**
 * The operator notice for a pi with no pi-subagents at all. `pi install`, not
 * `pi update`: update only upgrades a package pi already has, and on a box that
 * never installed it prints "No matching package found" and exits 1.
 */
export const SUBAGENTS_ABSENT_NOTICE =
	"pired: pi-subagents is not installed, so delegation is off. Install it with `pi install npm:pi-subagents` (>= 0.71, on pi >= 0.86.1) to use the pired workers.";

/**
 * The operator notice for a pi-subagents that registered pired's workers but
 * puts its whole `subagent` schema in front of the parent on every request.
 *
 * pired registers on 0.66 and 0.71 alike (the definition is their common
 * subset), so an operator who never re-ran the installer gets working
 * delegation and no hint that it costs ~5k tokens a request (~21k chars of
 * schema, measured on 0.66 for ADR-027). pi-subagents 0.71 on pi >= 0.86.1 shows
 * a ~0.5k-char `subagents_enable` stub instead until the first launch.
 */
export const SUBAGENTS_EAGER_NOTICE =
	"pired: pi-subagents is sending its full `subagent` tool schema with every request (about 5k tokens each). Update it with `pi update npm:pi-subagents` (>= 0.71, on pi >= 0.86.1) and it loads that schema only once a worker is launched.";

/**
 * Whether the parent carries pi-subagents' full `subagent` schema without the
 * lazy loader: `subagent` active and no `subagents_enable` registered, which is
 * pi-subagents before 0.71 or 0.71 on a pi older than 0.86.1. With the loader,
 * `subagent` is active only after the model asked for it, which is the cost
 * working as intended.
 */
export function eagerSubagentSchema(allTools: readonly string[], activeTools: readonly string[]): boolean {
	return activeTools.includes("subagent") && !allTools.includes("subagents_enable");
}
