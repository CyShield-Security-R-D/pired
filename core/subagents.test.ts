import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import {
	agentMarker,
	buildPiredAgentDefinitions,
	delegationBlock,
	eagerSubagentSchema,
	PIRED_AGENT_NAMES,
	PIRED_AGENTS,
	SUBAGENTS_ABSENT_NOTICE,
	SUBAGENTS_EAGER_NOTICE,
	WORKER_TOOLS,
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
	const scope = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "acme", authorized: true, mode: "enforce", targets: {}, ...over,
	});

	it("names all four workers and grants standing authorization", () => {
		const block = delegationBlock(scope());
		for (const agent of PIRED_AGENTS) expect(block).toContain(agent.name);
		expect(block.toLowerCase()).toMatch(/standing authorization/);
		// Keeps pired's voice: it informs the economics and leaves the choice open,
		// without telling the model it must launch anything.
		expect(block).toMatch(/doing it yourself is often cheaper/);
		expect(block.toLowerCase()).not.toMatch(/must (delegate|launch|use)/);
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

	it("says delegation is off, without listing workers, when the engagement disables it", () => {
		const block = delegationBlock(scope({ maxAgents: 0 }));
		expect(block.toLowerCase()).toMatch(/turned off|disabled/);
		expect(block).not.toContain("pired-scout");
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
