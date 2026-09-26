import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import {
	agentMarker,
	buildPiredAgentDefinitions,
	DEFAULT_MAX_AGENTS,
	delegationBlock,
	eagerSubagentSchema,
	hiddenParentTools,
	PIRED_AGENT_NAMES,
	PIRED_AGENTS,
	SUBAGENTS_ABSENT_NOTICE,
	SUBAGENTS_EAGER_NOTICE,
	SUGGESTED_MAX_AGENTS,
	WORKER_TOOLS,
	workerCap,
	workerPrompt,
	type AgentBuildContext,
} from "./subagents.ts";

const ctx = (over: Partial<AgentBuildContext> = {}): AgentBuildContext => ({
	childExtension: "/home/op/pired/extensions/child.ts",
	model: "openai-codex/gpt-6-luna",
	thinking: "medium",
	workspace: "/home/op/.pired/engagements/acme",
	scopeGuidance: "Authorized engagement: acme [enforce, authorized] 2 domain(s)\nTouch only these targets; anything else is out of scope — stop and say so.",
	...over,
});

describe("the four pired workers", () => {
	it("are exactly scout, investigate, verify and escalate", () => {
		expect(PIRED_AGENTS.map((a) => a.name)).toEqual([
			"pired-scout", "pired-investigate", "pired-verify", "pired-escalate",
		]);
		// The gate keys off this set; a name that fell out of step would silently
		// deny a worker the definitions still register.
		expect([...PIRED_AGENT_NAMES].sort()).toEqual(PIRED_AGENTS.map((a) => a.name).sort());
	});
});

describe("buildPiredAgentDefinitions", () => {
	it("gives every worker the ledger tools and the absolute child extension path", () => {
		for (const { definition } of buildPiredAgentDefinitions(ctx())) {
			// record/recall MUST be allowlisted: pi-subagents fails a child closed
			// when an allowlisted tool is missing, so listing them turns a child
			// extension that did not load into a hard failure, not a worker with no
			// ledger. See the design contract (fail-closed tripwire).
			expect(definition.tools).toContain("record");
			expect(definition.tools).toContain("recall");
			expect(definition.tools).toEqual([...WORKER_TOOLS]);
			expect(definition.extensions).toEqual(["/home/op/pired/extensions/child.ts"]);
		}
	});

	it("gives workers read and bash, not grep and find, which need binaries a sealed host lacks, nor ls, which bash covers", () => {
		// v4 grid, 2026-09-24: every worker call to grep (45 of 45) and find (57
		// of 57) failed, because pi's versions shell out to rg and fd. The parent
		// never called either; it reads and searches with read and bash.
		expect([...WORKER_TOOLS]).toEqual(["read", "bash", "record", "recall"]);
		for (const { definition } of buildPiredAgentDefinitions(ctx())) {
			for (const tool of ["grep", "find", "ls"]) expect(definition.tools).not.toContain(tool);
		}
	});

	it("maps the parent model and thinking level onto each child, off becoming false", () => {
		const [scout] = buildPiredAgentDefinitions(ctx());
		expect(scout?.definition.model).toBe("openai-codex/gpt-6-luna");
		expect(scout?.definition.thinking).toBe("medium");
		// "off" is not a pi-subagents thinking level; the registry wants false.
		const [offScout] = buildPiredAgentDefinitions(ctx({ thinking: "off" }));
		expect(offScout?.definition.thinking).toBe(false);
	});

	it("omits the model field entirely when the parent has none, rather than sending an empty string", () => {
		const [scout] = buildPiredAgentDefinitions(ctx({ model: undefined }));
		expect(scout?.definition).not.toHaveProperty("model");
	});

	it("sets only the 0.66/0.71 common-subset fields, and none of the version-rejected ones", () => {
		// 0.71 rejects fallbackModels/completionGuard; 0.66 rejects machine. A
		// definition carrying any of them fails registration on one version.
		const forbidden = ["fallbackModels", "completionGuard", "machine", "runner"];
		for (const { definition } of buildPiredAgentDefinitions(ctx())) {
			for (const key of forbidden) expect(definition).not.toHaveProperty(key);
		}
	});

	it("keeps every worker a foreground, non-nesting, fresh-context child", () => {
		for (const { definition } of buildPiredAgentDefinitions(ctx())) {
			expect(definition.defaultAsync).toBe(false);
			expect(definition.allowNestedSubagents).toBe(false);
			expect(definition.defaultAcceptance).toBe(false);
			expect(definition.defaultContext).toBe("fresh");
			expect(definition.systemPromptMode).toBe("replace");
			expect(definition.inheritProjectContext).toBe(false);
			expect(definition.inheritGlobalContext).toBe(false);
			expect(definition.inheritSkills).toBe(false);
			// A positive, bounded timeout and tool budget — the registry rejects a
			// non-positive integer, so 0 would fail rather than mean "no depth".
			expect(definition.defaultTimeoutMs).toBeGreaterThan(0);
			expect(definition.toolBudget.hard).toBeGreaterThan(0);
		}
	});

	it("sizes each worker's tool budget off its own turn count", () => {
		const defs = buildPiredAgentDefinitions(ctx());
		for (const agent of PIRED_AGENTS) {
			const def = defs.find((d) => d.name === agent.name)?.definition;
			expect(def?.toolBudget.hard).toBe(agent.maxTurns * 8);
		}
	});

	it("gives the verifier 24 turns, room for two or three records rather than exactly one", () => {
		// v4 grid, 2026-09-24: a five-finding verify batch settled 2 in the 16–18
		// turns it had, and 23 of 25 gpt-6-luna verify launches covered a single
		// finding — all 5 launches the cap refused were verifiers.
		const verify = PIRED_AGENTS.find((a) => a.role === "verify")!;
		expect(verify.maxTurns).toBe(24);
		expect(workerPrompt(verify, ctx())).toMatch(/at most 24 turns/);
	});

	it("trims the description and system prompt, which the registry requires untrimmed to reject", () => {
		for (const { definition } of buildPiredAgentDefinitions(ctx())) {
			expect(definition.description).toBe(definition.description.trim());
			expect(definition.description.length).toBeLessThanOrEqual(4096);
			expect(definition.systemPrompt).toBe(definition.systemPrompt.trim());
			expect(definition.systemPrompt.length).toBeGreaterThan(0);
		}
	});
});

describe("the worker prompt", () => {
	it("carries the agent-name marker the child reads its role from", () => {
		for (const agent of PIRED_AGENTS) {
			const prompt = workerPrompt(agent, ctx());
			expect(prompt).toContain(agentMarker(agent.name));
			// The marker leads the prompt, so getSystemPrompt() in the child holds
			// it whatever pi prepends around a replace-mode prompt.
			expect(prompt.startsWith(agentMarker(agent.name))).toBe(true);
		}
	});

	it("binds the handoff to at most 200 words and names the shared workspace and scope", () => {
		const prompt = workerPrompt(PIRED_AGENTS[0]!, ctx());
		expect(prompt).toMatch(/200 words/);
		expect(prompt).toContain("/home/op/.pired/engagements/acme");
		expect(prompt).toContain("acme [enforce, authorized] 2 domain(s)");
		// recall-context-first: the worker is told to read shared state before it starts.
		expect(prompt).toMatch(/recall context/);
	});

	it("tells the verifier to refute and the escalator not to inflate severity", () => {
		const verify = PIRED_AGENTS.find((a) => a.role === "verify")!;
		expect(workerPrompt(verify, ctx()).toLowerCase()).toMatch(/refute/);
		const escalate = PIRED_AGENTS.find((a) => a.role === "escalate")!;
		expect(workerPrompt(escalate, ctx()).toLowerCase()).toMatch(/never inflate|without evidence/);
	});

	it("tells the scout it proposes hypotheses and records no findings, so the gate's refusal is not a surprise", () => {
		// v4 grid, 2026-09-24: a pired-scout recorded three findings, outside its
		// role. A weakness it can already see is a lead for an investigator.
		const scout = PIRED_AGENTS.find((a) => a.role === "scout")!;
		const prompt = workerPrompt(scout, ctx());
		expect(prompt).toMatch(/do not record findings/);
		expect(prompt).toMatch(/pired refuses a finding from a scout/);
		expect(prompt).toMatch(/`proposed`/);
		expect(prompt).toMatch(/investigator to settle/);
	});

	it("tells the verifier its verdict is a status with grounds and that the finding's claim is not its to rewrite", () => {
		// v4 grid, 2026-09-24: two verifiers re-recorded findings by id with new
		// descriptions; last-write-wins replaced the investigator's text and the
		// replayed ledger fell from 4 true positives to 2.
		const verify = PIRED_AGENTS.find((a) => a.role === "verify")!;
		const prompt = workerPrompt(verify, ctx());
		for (const field of ["`control`", "`entitlement`", "`basis`", "`live=true`", "`reason`"]) expect(prompt).toContain(field);
		expect(prompt).toMatch(/do not edit a finding's title, description, location or severity/);
		expect(prompt).toMatch(/pired refuses that from a verifier/);
		expect(prompt).toMatch(/the operator amends it/);
	});

	it("tells the verifier to record every verdict on the record by id, an unsettled one too, because the handoff is not durable", () => {
		// v4 grid, 2026-09-24: 6 gpt-6-luna verifiers recorded nothing, 4 of them
		// handing back early with a verdict stated only in the handoff, and 4 of 6
		// amended or refuted verdicts never reached the finding.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/Record the verdict whatever it is — an unsettled one too — by the record's id/);
		expect(prompt).toMatch(/`inconclusive` when unsettled/);
		expect(prompt).toMatch(/Your handoff is not durable; the ledger is/);
		// Raw output goes on the ledger too, where the verdict can cite it.
		expect(prompt).toMatch(/`record kind=evidence` and cite its path in `basis` or `control`/);
	});

	it("puts an unsettled verdict's grounds in basis or control, since a reason alone is only a note", () => {
		// The record tool reads an unsettled challenge from what was checked —
		// `basis` or `control`. A mission that said `reason` sent the grounds where
		// they are kept as a note, and the finding still read as unchallenged.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/when it is unsettled, `suspected` with what you checked in `basis` or `control` \(a `reason` alone is only a note\)/);
		expect(prompt).not.toMatch(/what you checked in `reason`/);
	});

	it("claims live=true only for a running target and leaves it out when the basis is the source", () => {
		// `live=true` is a claim about a running target, not a password for the
		// bar: in the v4 grid 17 of 18 baseline verification records asserted it
		// on scopes with no target.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/`live=true` only when you tested a running target; leave it out when your basis is the source/);
	});

	it("lets the verifier record the finding a cleared hypothesis turned out to be, linked by hypothesisId", () => {
		// "Do not promote anything to a finding" left an overturned clearance with
		// nowhere to go but the handoff; linked, it meets the same bar as any
		// investigator's finding.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/the finding with its `hypothesisId`: it lands `suspected` unless it carries `status=confirmed` with the control case/);
		expect(prompt).not.toMatch(/do not promote/i);
	});

	it("tells the verifier the order the gate holds it to: the hypothesis confirmed first, and no second finding for a covered one", () => {
		// The child gate lets a verifier create a finding only for a hypothesis
		// recorded confirmed that no finding already covers; a refusal the worker
		// was never told about reads as a fault.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/record its `outcome=confirmed` by id, then — unless a finding already covers it — the finding with its `hypothesisId`/);
	});

	it("tells the verifier to take a batch one record at a time and hand back what it did not reach as unchallenged", () => {
		// v4 grid, 2026-09-24: a five-finding verify batch settled 2 within 16–18
		// turns. Recording each verdict before the next keeps a batch that runs
		// out from losing the ones it did settle.
		const prompt = workerPrompt(PIRED_AGENTS.find((a) => a.role === "verify")!, ctx());
		expect(prompt).toMatch(/take them one at a time and record each verdict before you start the next/);
		expect(prompt).toMatch(/hand back the ones you did not reach as unchallenged/);
	});

	it("warns every worker that its other tools are refused if it reaches its last turns with nothing recorded", () => {
		// v4 grid, 2026-09-24: a pired-investigate used all 26 of its turns and
		// wrote no record; four runs flagged a pired-verify child with none.
		for (const agent of PIRED_AGENTS) {
			expect(workerPrompt(agent, ctx())).toMatch(/last few turns with nothing recorded is refused every other tool until it records/);
		}
	});

	it("gives a worker that established nothing a way out of the reserve, so the warning does not read as a record owed", () => {
		// The reserve refusal says "hand back and say so"; a prompt that stopped
		// at "until it records" left a worker with nothing to record only filler.
		for (const agent of PIRED_AGENTS) {
			expect(workerPrompt(agent, ctx())).toContain(
				"until it records what it has established — or, if it established nothing, hands back and says so.",
			);
		}
	});
});

describe("the scope a worker is told", () => {
	it("carries the operator prompt's own scope wording, so a review engagement reads as read-only work that is fine", async () => {
		// The 2026-09-24 smoke run: the worker read mode off / authorized false as
		// "not authorized — stop", parked a blocker, and the parent stopped behind it.
		const { scopeGuidance } = await import("./scope.ts");
		const review: EngagementScope = { v: 1, engagement: "review-x", authorized: false, mode: "off", targets: {} };
		const [first] = buildPiredAgentDefinitions(ctx({ scopeGuidance: scopeGuidance(review) }));
		expect(first!.definition.systemPrompt).toContain("Read-only local work (e.g. code review) is still fine.");
		expect(first!.definition.systemPrompt).not.toMatch(/not authorized/i);
		expect(first!.definition.systemPrompt).toMatch(/record what you could not do and carry on/);
	});
});

describe("the delegation prompt block", () => {
	/** An engagement that opted in with the suggested cap; the default is off (ADR-029). */
	const scope = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "acme", authorized: true, mode: "enforce", targets: {}, maxAgents: SUGGESTED_MAX_AGENTS, ...over,
	});

	it("names all four workers and grants standing authorization", () => {
		const block = delegationBlock(scope());
		for (const agent of PIRED_AGENTS) expect(block).toContain(agent.name);
		expect(block.toLowerCase()).toMatch(/standing authorization/);
		// Keeps pired's voice: it informs where each choice costs less and leaves
		// the choice open, without telling the model it must launch anything.
		expect(block).toMatch(/A check you can settle in a few reads costs less here than briefing a worker/);
		expect(block).toMatch(/a large area's reading never enters your context if a worker does it/);
		expect(block.toLowerCase()).not.toMatch(/must (delegate|launch|use)/);
		expect(block).not.toMatch(/is what the workers are for/);
		// States the authorization in pi-subagents' own terms, whose guidance holds
		// delegation back until "applicable instructions" allow it.
		expect(block).toMatch(/applicable instructions/);
		expect(block).toMatch(/sent again with every later request/);
	});

	it("tells the model to launch with agent and task alone, one at a time, so the gate's refusals are not a surprise", () => {
		const block = delegationBlock(scope());
		expect(block).toContain("`{ agent, task }`");
		expect(block).toMatch(/one at a time/);
		expect(block).toMatch(/a second while one runs is refused/);
	});

	it("never frames context as a budget to conserve, so a filling context is not read as a reason to stop", () => {
		// v4 grid, 2026-09-24: four of five GLM pass-1 candidates stopped with
		// 12–49% of their test cases settled, citing context budget, under a block
		// that called context "this review's scarcest budget" and doing it yourself
		// "often cheaper". A byte-identical block also produced a 100% run, so this
		// guards a plausible contributor, not a proven cause.
		const block = delegationBlock(scope());
		expect(block.toLowerCase()).not.toMatch(/scarcest budget/);
		// The facts the old framing rested on are still stated.
		expect(block).toMatch(/at most 200 words/);
		expect(block).toMatch(/you keep the conclusions, not the reading/);
		expect(block).toMatch(/you keep the plan/);
		// Context pressure points at a worker, and the stop line is the method.
		expect(block).toMatch(/a filling context is a reason to hand the next area to a worker/);
		expect(block).toMatch(/whether you are done is decided by the method in your instructions, not by how much context you have used/);
	});

	it("states no flat rule about finishing, so the block sets no stop line of its own in either direction", () => {
		// Round-two review: "never a reason to finish early" is a rule about when
		// to stop, set by the block rather than the method it points at.
		const block = delegationBlock(scope());
		expect(block).not.toMatch(/finish early/);
		expect(block).not.toMatch(/never a reason/);
	});

	it("points at the method for when to stop without paraphrasing it, so no second stop line competes with the method's", () => {
		// Round-one review: a gloss of the floor ("each standard weakness class
		// considered against the attack surface you recorded") traded a budget
		// stop for a paraphrased floor stop that the method itself does not say.
		expect(delegationBlock(scope())).not.toMatch(/weakness class/);
	});

	it("states how many worker launches the engagement allows, the same number the gate holds", () => {
		// v4 grid, 2026-09-24: 43.5% of gpt-6-luna candidate parent tokens were
		// spent after the last worker, and all 5 launches the cap refused were
		// verifiers — a parent that is not told the number cannot plan for it.
		expect(delegationBlock(scope())).toContain(`allows ${SUGGESTED_MAX_AGENTS} worker launches per session`);
		expect(delegationBlock(scope({ maxAgents: 3 }))).toContain("allows 3 worker launches per session");
		expect(delegationBlock(scope({ maxAgents: 1 }))).toContain("allows 1 worker launch per session");
		// A nonsense cap is the default, in the prompt as at the gate: off.
		expect(delegationBlock(scope({ maxAgents: -3 }))).toMatch(/turned off/);
		expect(workerCap(undefined)).toBe(DEFAULT_MAX_AGENTS);
		expect(workerCap(scope({ maxAgents: -3 }))).toBe(DEFAULT_MAX_AGENTS);
		expect(workerCap(scope({ maxAgents: 0 }))).toBe(0);
	});

	it("tells the parent a verifier's verdict passes the same evidence checks, so it is not told to leave status alone", () => {
		// v4 grid, 2026-09-24: 10 of 15 verify tasks that said "do not change
		// status" left no verdict on any row.
		const block = delegationBlock(scope());
		expect(block).toMatch(/A verifier's verdict goes onto the record through the same evidence checks yours does/);
		expect(block).toMatch(/needs no instruction to leave a status alone/);
		expect(block).toMatch(/final severity judgment/);
		// And that one launch can carry several records, settled one at a time.
		expect(block).toMatch(/one launch takes several, settled one at a time/);
	});

	it("says delegation is off, without listing workers, when the engagement disables it", () => {
		const block = delegationBlock(scope({ maxAgents: 0 }));
		expect(block.toLowerCase()).toMatch(/turned off|disabled/);
		expect(block).not.toContain("pired-scout");
		expect(block).not.toMatch(/worker launch/);
	});
});

describe("what the operator is told about pi-subagents", () => {
	it("says `pi install` when it is absent, which is the command that works on a box without it", () => {
		// `pi update npm:pi-subagents` exits 1 with "No matching package found"
		// when the package was never installed.
		expect(SUBAGENTS_ABSENT_NOTICE).toContain("pi install npm:pi-subagents");
		expect(SUBAGENTS_ABSENT_NOTICE).not.toContain("pi update");
	});

	it("says `pi update` and the per-request cost for an eager install", () => {
		expect(SUBAGENTS_EAGER_NOTICE).toContain("pi update npm:pi-subagents");
		expect(SUBAGENTS_EAGER_NOTICE).toMatch(/5k tokens/);
	});

	it("calls the schema eager only when subagent is active and no lazy loader exists", () => {
		// pi-subagents < 0.71, or 0.71 on a pi older than 0.86.1: no loader, subagent always on.
		expect(eagerSubagentSchema(["read", "subagent"], ["read", "subagent"])).toBe(true);
		// 0.71 with the loader, before and after the model enabled it: the cost is the design.
		expect(eagerSubagentSchema(["read", "subagent", "subagents_enable"], ["read", "subagents_enable"])).toBe(false);
		expect(eagerSubagentSchema(["read", "subagent", "subagents_enable"], ["read", "subagent", "subagents_enable"])).toBe(false);
		// Registered but not active (an operator hid it): nothing is being paid.
		expect(eagerSubagentSchema(["read", "subagent"], ["read"])).toBe(false);
	});
});

describe("the pi-subagents tools the parent does not see", () => {
	const scope = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "acme", authorized: true, mode: "enforce", targets: {}, ...over,
	});

	it("hides the launcher and its loader when delegation is off, so the stub costs nothing and invites no refused call", () => {
		// ADR-029: off is the default, so this is every engagement that never opted in.
		for (const off of [undefined, scope(), scope({ maxAgents: 0 })]) {
			const hidden = hiddenParentTools(off);
			for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor"]) expect(hidden.has(name), name).toBe(true);
		}
	});

	it("keeps the launcher and its loader for an engagement that opted in, and still hides the background tools", () => {
		const hidden = hiddenParentTools(scope({ maxAgents: SUGGESTED_MAX_AGENTS }));
		expect(hidden.has("subagent")).toBe(false);
		expect(hidden.has("subagents_enable")).toBe(false);
		expect(hidden.has("bg_wait")).toBe(true);
		expect(hidden.has("subagent_supervisor")).toBe(true);
	});
});
