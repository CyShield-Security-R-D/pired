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
 * and a deep single-module dive is long (24). A refutation of one record is
 * still a tight check — one that sprawls has stopped being a check — but a
 * verifier now takes a batch, one record at a time, and 24 turns fits two or
 * three: in the 2026-09-24 v4 grid a five-finding verify batch settled 2 within
 * 16–18 turns. When each launch covered one record — 23 of 25 gpt-6-luna verify
 * launches did — verification spent the session's worker launches one record at
 * a time: all 5 launches the cap refused were verifiers.
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

/**
 * The tools every worker gets: the parent's own default toolset for reading and
 * searching — pi's `read` and `bash` — plus pired's ledger (`record`, `recall`).
 * A worker searches the way its parent does.
 *
 * Workers used to get pi's `grep`, `find` and `ls` as well, which the parent
 * does not have by default. `grep` and `find` run the `rg` and `fd` binaries,
 * and pi's tools manager downloads a missing one on first use. The v4 grid
 * (2026-09-24) ran on a host with neither binary and no network, so there every
 * worker call to them failed (grep 45 of 45, find 57 of 57); with the refused
 * supervisor calls, that lost 12–19% of worker turns. Where the binaries are
 * installed or can be fetched the tools work, so they are left out for parity
 * with the parent, which never called either, not because they are broken.
 * `ls` goes with them: `bash` already lists a directory.
 */
export const WORKER_TOOLS = ["read", "bash", "record", "recall"] as const;

/**
 * The four workers.
 *
 * Each maps to one part of an assessment a parent would otherwise do inline and
 * lose context to. The missions restate pired's standing rules in the worker's
 * own terms — record as you go, a suspected finding stays suspected until proven,
 * never inflate severity — because a fresh child does not carry the parent's
 * prompt and its only durable channel back is the shared ledger.
 *
 * The scout and verify missions also state where the role stops, because the
 * child gate now refuses the step past it and a refusal the worker was never
 * told about reads as a fault. In the 2026-09-24 v4 grid a pired-scout recorded
 * three findings, outside its role; and two pired-verify workers re-recorded
 * the findings they were checking by id with new descriptions. An update by id
 * is last-write-wins, so the verifier's text replaced the investigator's and
 * reordered the cited locations: that ledger, replayed, scored 4 true positives
 * before the verifiers ran and 2 after. A verifier's verdict belongs in the
 * status and its grounds; the claim itself stays the operator's to amend.
 *
 * The verify mission names the one place a verdict goes — the record's own
 * status, by id, unsettled verdicts included — because the verdicts that were
 * written anywhere else were lost. In the same grid 6 gpt-6-luna verifiers
 * recorded nothing, 4 of them handing back early (turns 7, 7, 11 and 12 of 16)
 * with a verdict stated only in the handoff; 10 of 15 verify tasks that said
 * "do not change status" left no verdict on any row; 4 of 6 amended or refuted
 * verdicts never reached the finding; and 35 of 37 candidate findings ended
 * `suspected`. The handoff is a message the parent may summarise away; the
 * ledger is what the report reads. The mission no longer says "do not promote
 * anything to a finding": a cleared hypothesis the verifier overturns is a
 * finding. It says the order the child gate holds it to — the hypothesis
 * recorded `confirmed` first, and no second finding for one already covered —
 * and that the finding lands `suspected` unless it carries `status=confirmed`
 * with the control case, the same bar an investigator's finding meets.
 *
 * An unsettled verdict names what was checked in `basis` or `control`, because
 * that is what the record tool reads as a challenge; a `reason` alone is kept
 * as a note. And `live=true` is a claim that a running target was tested, so
 * the mission says to leave it out when the basis is the source, rather than
 * inviting the flag on every refutation.
 */
export const PIRED_AGENTS: readonly PiredAgent[] = [
	{
		name: "pired-scout",
		role: "scout",
		maxTurns: 20,
		description: "Map the attack surface of an area: routes, handlers, inputs, trust boundaries, sinks. Records surface (with file) and proposes hypotheses.",
		mission:
			"You are mapping the attack surface of the area named in your task. Enumerate what an attacker reaches: routes, request handlers, inputs and parameters, trust boundaries, and the dangerous sinks input flows into. `record` each element as surface (`kind=endpoint`/`host`/etc.) the moment you find it, ALWAYS with the source `file` so the coverage matrix has something to point at. Where you see a plausible weakness — even one you can already see plainly — `record kind=hypothesis` as `proposed` against the element and its checklist class: a lead for an investigator to settle, not a verdict. Scouts do not record findings (pired refuses a finding from a scout) and do not try to confirm anything; scouting is breadth. Return a short list of the surface and hypotheses you recorded.",
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
		maxTurns: 24,
		description: "Fresh adversarial check of findings or cleared hypotheses, one at a time. Tries to refute each from source or a control case; records each verdict on the record.",
		mission:
			"You are a fresh, skeptical pair of eyes. Your job is to REFUTE each finding or cleared hypothesis named in your task, not to agree with it: read `recall challenge id=<id>` for its brief, then find the input it did not consider or the call path it did not follow. When the task names several records, take them one at a time and record each verdict before you start the next; if your turns run out, hand back the ones you did not reach as unchallenged. Record the verdict whatever it is — an unsettled one too — by the record's id: a finding's `status` is `confirmed` (with the `control` case you ran, and `entitlement` where the brief asks), `refuted` (with a `basis`: `file:line`; `live=true` only when you tested a running target; leave it out when your basis is the source), or, when it is unsettled, `suspected` with what you checked in `basis` or `control` (a `reason` alone is only a note); a hypothesis's `outcome` likewise, with a `statement` and a `basis` (`inconclusive` when unsettled; a hypothesis keeps no `control` or `reason`). Your handoff is not durable; the ledger is. Save raw output with `record kind=evidence` and cite its path in `basis` or `control`. If a cleared hypothesis turns out vulnerable, record its `outcome=confirmed` by id, then — unless a finding already covers it — the finding with its `hypothesisId`: it lands `suspected` unless it carries `status=confirmed` with the control case. You do not edit a finding's title, description, location or severity (pired refuses that from a verifier): if one is wrong, say so in `reason` and in your handoff, and the operator amends it. Do not widen the check — a verification that sprawls has stopped being one. Return each verdict, what it was grounded in, and the evidence path.",
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
 * How many workers one session may launch before the gate says no.
 *
 * PLAN.md §11 has always listed hard caps as harness-owned, and nothing
 * implemented one: `spawn` sat in the local-tools set and was waved through, so
 * a model that decided to fan out could spawn until something else ran out.
 * Delegation is not a scope violation, but it is the same shape of problem —
 * unbounded work nobody asked for, on the operator's budget and the client's
 * systems — and the gate is already the place that says no to that.
 *
 * The default is **zero**: delegation is opt-in, per engagement, by setting
 * `maxAgents` in the scope file (ADR-029). It shipped on at eight, and the
 * pre-registered trial that was to justify that did not (ADR-026 outcome). On
 * GPT-6 Luna the delegating build found 7 true positives to the baseline's 6
 * while making 115 claims to 58 and spending 62% more tokens; across six
 * official grids it found 58 to the baseline's 69. A default is what every
 * engagement that never thought about it runs, so it is the measured-better
 * configuration until a design beats it.
 *
 * `SUGGESTED_MAX_AGENTS` is the cap to opt in with. Eight is enough for the
 * patterns `ops-delegation` describes (a verifier per cleared cell of a class, a
 * scout per host) and low enough that a loop is caught in one session rather
 * than one invoice.
 *
 * Both live here, beside the workers, rather than in core/scope.ts, which
 * enforces them: the delegation block states the cap too, and core/scope.ts
 * already imports this module, so the reverse import would make a cycle.
 */
export const DEFAULT_MAX_AGENTS = 0;
export const SUGGESTED_MAX_AGENTS = 8;

/**
 * The session's worker cap: the engagement's `maxAgents`, or the default when
 * it names none. A negative number is nonsense rather than a request, so it
 * falls back to the default too; `0` disables delegation.
 * One function, so the number the prompt states is the number the gate holds.
 */
export function workerCap(scope: EngagementScope | undefined): number {
	const n = scope?.maxAgents;
	return typeof n === "number" && n >= 0 ? n : DEFAULT_MAX_AGENTS;
}

/**
 * Verifier launches are off unless the scope asks for them (Phase 3, 3.1), for
 * the reason delegation is: they cost parent turns, and their benefit is not yet
 * measured.
 */
export const DEFAULT_MAX_VERIFIERS = 0;

/**
 * The session's verifier cap: the engagement's `maxVerifiers` when it is a
 * non-negative integer, else the default — the rule `workerCap` applies, and
 * stricter by the integer, since a fraction of a launch is not a request either.
 * Declared by the Phase 3 groundwork; nothing enforces it until 3.1.
 */
export function verifierCap(scope: EngagementScope | undefined): number {
	const n = scope?.maxVerifiers;
	return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_VERIFIERS;
}

/**
 * The pi-subagents tools pired takes out of the parent's active set, re-applied
 * every turn because pi-subagents' lazy loader can put them back.
 *
 * Always the wait and supervisor tools: pired delegates in the foreground only.
 * With delegation off, the launcher and its loader stub as well. The gate
 * refuses every launch at a cap of zero, so leaving them active only spends the
 * stub's ~0.5k characters on every request and invites a call that must fail —
 * and with delegation off by default, that is every engagement that never
 * opted in.
 */
export function hiddenParentTools(scope: EngagementScope | undefined): ReadonlySet<string> {
	return workerCap(scope) === 0 ? HIDDEN_WHEN_OFF : HIDDEN_ALWAYS;
}
const HIDDEN_ALWAYS: ReadonlySet<string> = new Set(["bg_wait", "subagent_supervisor"]);
const HIDDEN_WHEN_OFF: ReadonlySet<string> = new Set([...HIDDEN_ALWAYS, "subagent", "subagents_enable"]);

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
 *
 * "Record as you go" also says what happens to a worker that does not: the
 * child gate refuses every other tool in its last few turns until it records
 * what it has established. That reserve is for a worker that runs out of turns:
 * in the v4 grid a pired-investigate spent all 26 of its turns and wrote no
 * ledger record ("hypotheses and findings remain unrecorded"). It does not reach
 * a worker that hands back early with nothing written — 4 of the 6 gpt-6-luna
 * verifiers that recorded nothing stopped at turn 7, 7, 11 or 12 of 16 — which
 * is the child gate's separate check on a hand-back, and why the verify mission
 * says the handoff is not durable.
 *
 * The sentence ends on the way out the reserve refusal itself gives. Without it
 * the prompt reads as though a record is owed whatever happened, and a worker
 * with nothing established has only filler to write.
 */
export function workerPrompt(agent: PiredAgent, ctx: AgentBuildContext): string {
	return [
		agentMarker(agent.name),
		`You are ${agent.name}, a pired ${agent.role} worker: a focused security specialist a lead operator delegated one task to. You are not the operator and you do not run the engagement — you do the one thing your task names and hand it back.`,
		`Scope — the same boundary the operator works under:\n${ctx.scopeGuidance}\nStay inside it. pired's scope gate refuses anything outside it with a reason; if it refuses a step, record what you could not do and carry on with the rest of your task.`,
		`Shared workspace: ${ctx.workspace} (evidence under ${ctx.workspace}/evidence/, reachable as $PIRED_WORKSPACE in your shell). Your \`record\` and \`recall\` write to and read from this same ledger the operator sees — your records appear to them immediately.`,
		"Read the shared state before you start: `recall context` (narrow it with the exact IDs and paths from your task) gives the model, checklist, surface, hypotheses, findings and open blockers as they stand now. Trust the ledger over your own assumptions; it does not forget.",
		"Record as you go, not at the end: surface the moment you find it (with its source file), a hypothesis before you test it, a finding as soon as it is supported. A finding is `suspected` until the control case that had to fail has been run. Never fabricate output or a CVE, and never claim a severity you cannot show the reach for. A worker that reaches its last few turns with nothing recorded is refused every other tool until it records what it has established — or, if it established nothing, hands back and says so.",
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
 *
 * The facts about context stay; the framing of context as a budget to conserve
 * is gone. The previous text opened "your context is this review's scarcest
 * budget" and closed "doing it yourself is often cheaper". In the v4 grid four
 * of five GLM-5.3 Flash pass-1 candidates stopped with 12–49% of their test
 * cases settled and gave context-budget reasons ("I've spent a lot of context…
 * honest terminal state"); no baseline run did. The counter-evidence is real: a
 * pass-2 candidate with byte-identical text reached 100% and scored best, so
 * the wording is a plausible contributor, not a proven cause. The new text is
 * aimed at the reading that failed: context pressure is a reason to hand an
 * area to a worker, and whether the review is done is the method's call, not
 * the context meter's. It points at the method rather than restating it, so the
 * block cannot swap one stop line for a paraphrase of another. For the same
 * reason it states no flat rule the other way ("never a reason to finish
 * early"): that is a rule about when to stop, set by the block rather than the
 * method. The closing sentence still says where each choice costs less, as
 * information about context, not as a budget to protect.
 *
 * Three more facts are stated because their absence was measured:
 * - The number of worker launches. After the cap the parent is on its own; in
 *   the v4 grid 43.5% of gpt-6-luna candidate parent tokens were spent after the
 *   last worker had run. A parent that knows the number can plan the launches.
 * - A verifier takes several records. 23 of 25 gpt-6-luna verify launches
 *   covered one finding, and all 5 launches the cap refused were verifiers.
 * - A verifier's verdict passes the same evidence checks the operator's does.
 *   10 of 15 verify tasks that said "do not change status" left no verdict on
 *   any row, so the parent is told why that instruction is not needed.
 */
export function delegationBlock(scope?: EngagementScope): string {
	const cap = workerCap(scope);
	if (cap === 0) {
		return `<delegation>
Delegation is turned off for this engagement (maxAgents=0). Do the work in this session.
</delegation>`;
	}
	return `<delegation>
Standing authorization from the operator for this engagement: delegation to the four pired workers below is authorized. These are the applicable instructions pi-subagents asks for, so you do not need a request in the current message. Call \`subagents_enable\` once to load the \`subagent\` tool.
How your context works: every file you read and every tool output stays in it and is sent again with every later request. A worker reads in a fresh context and hands back at most 200 words plus the records it wrote to this same ledger — you keep the conclusions, not the reading. So a filling context is a reason to hand the next area to a worker; whether you are done is decided by the method in your instructions, not by how much context you have used.
- \`pired-scout\` — map an area's attack surface (routes, handlers, inputs, trust boundaries, sinks) and record it. A natural first move on each large area of an unfamiliar codebase, before you choose where to dig.
- \`pired-investigate\` — take one module or lead to a verdict in isolation.
- \`pired-verify\` — try to refute findings or cleared cells with fresh eyes before they reach a report; one launch takes several, settled one at a time.
- \`pired-escalate\` — once findings exist, trace what they unlock and whether they chain.
This engagement allows ${cap} worker launch${cap === 1 ? "" : "es"} per session; the work after the last one is yours. Record what you already know first, then launch with \`{ agent, task }\` and put the exact file paths and record IDs in the task — the worker sees a bounded snapshot, not your transcript; its model, context and limits are fixed, and a call that overrides them is refused. Workers run one at a time, in the foreground (one launch per message; a second while one runs is refused); read their records after the handoff. A verifier's verdict goes onto the record through the same evidence checks yours does, so it needs no instruction to leave a status alone; you keep the plan, the cross-component reasoning and the final severity judgment — a worker's return is a lead to weigh, not tested coverage. A check you can settle in a few reads costs less here than briefing a worker; a large area's reading never enters your context if a worker does it.
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
