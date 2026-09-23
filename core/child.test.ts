import { describe, expect, it } from "vitest";
import {
	CHILD_DENIED_TOOLS, ChildSetupError, createChildGuard, FALLBACK_MAX_TURNS, HANDOFF_GRACE_TURNS,
	identifyAgent, openChildWorkspace, PARENT_SCOPE_KEY, publishParentScope, readParentScope, SUPERVISOR_TOOL,
} from "./child.ts";
import type { EngagementScope } from "./ontology.ts";
import type { ToolContext } from "./ports.ts";
import { createScopeGate } from "./scope.ts";
import { agentMarker, PIRED_AGENTS } from "./subagents.ts";
import { makeFakeServices, type FakeServices } from "./testing/fakes.ts";
import { Workspace } from "./workspace.ts";

const DIR = "/ws/acme";

function scope(over: Partial<EngagementScope> = {}): EngagementScope {
	return {
		v: 1, engagement: "acme", authorized: true, mode: "enforce",
		targets: { domains: ["app.acme.test"] }, maxAgents: 8, ...over,
	};
}

/**
 * A workspace the way a parent session leaves it: a manifest from `open`, the
 * informational scope.json from `writeScope`, and the scope itself published
 * in-process on `registry` (a stand-in for `globalThis`). `null` publishes nothing.
 */
async function parentWorkspace(s: EngagementScope | null = scope()): Promise<{ svc: FakeServices; registry: object }> {
	const svc = makeFakeServices();
	const ws = await Workspace.open(DIR, "acme", svc);
	const registry = {};
	if (s) {
		await ws.writeScope(s);
		publishParentScope(registry, DIR, s);
	}
	return { svc, registry };
}

function agent(name: string) {
	const found = PIRED_AGENTS.find((a) => a.name === name);
	if (!found) throw new Error(`no agent ${name}`);
	return found;
}

describe("identifyAgent", () => {
	it("reads back every marker the parent writes with agentMarker", () => {
		for (const a of PIRED_AGENTS) {
			expect(identifyAgent(`${agentMarker(a.name)}\n\nYou are ${a.name}.`)?.name).toBe(a.name);
		}
	});

	it("falls back to the active_agent tag pi-subagents prefixes when pired's marker is gone", () => {
		// The tag is how pi-subagents 0.66 and 0.71 both open a runtime agent's
		// prompt; a rewrite that dropped the HTML comment must not cost the role.
		const prompt = 'You are a child subagent.\n\n<active_agent name="pired-verify"/>\n\nYou are a worker.';
		expect(identifyAgent(prompt)?.maxTurns).toBe(16);
	});

	it("prefers pired's marker when it and the tag disagree", () => {
		const prompt = `<active_agent name="pired-verify"/>\n\n${agentMarker("pired-investigate")}`;
		expect(identifyAgent(prompt)?.name).toBe("pired-investigate");
	});

	it("names nothing for an agent pired does not own, or for no prompt at all", () => {
		expect(identifyAgent('<active_agent name="worker"/>')).toBeUndefined();
		expect(identifyAgent(agentMarker("pired-nobody"))).toBeUndefined();
		expect(identifyAgent("")).toBeUndefined();
		expect(identifyAgent(undefined)).toBeUndefined();
	});
});

describe("openChildWorkspace", () => {
	it("refuses to start without PIRED_WORKSPACE rather than guess a ledger", async () => {
		const svc = makeFakeServices();
		await expect(openChildWorkspace(undefined, svc, { scopeRegistry: {} })).rejects.toBeInstanceOf(ChildSetupError);
		await expect(openChildWorkspace("   ", svc, { scopeRegistry: {} })).rejects.toThrow(/PIRED_WORKSPACE is not set/);
	});

	it("refuses a directory with no manifest and leaves it without one", async () => {
		// Workspace.open would have created the directory and a manifest, and the
		// worker would have recorded into an engagement no panel shows.
		const svc = makeFakeServices();
		const registry = {};
		publishParentScope(registry, "/ws/elsewhere", scope());
		await expect(openChildWorkspace("/ws/elsewhere", svc, { scopeRegistry: registry })).rejects.toThrow(/manifest\.json is missing/);
		expect(svc.fs.has("/ws/elsewhere/manifest.json")).toBe(false);
		expect(await svc.fs.stat("/ws/elsewhere")).toBeUndefined();
	});

	it("fails closed when no parent in this process published a scope, even with a scope.json on disk", async () => {
		// Workers are foreground children in the parent's process. No published
		// scope means no parent vouched for one, and the file is not a substitute.
		const { svc } = await parentWorkspace(null);
		await new Workspace(DIR, svc).writeScope(scope({ mode: "off" }));
		await expect(openChildWorkspace(DIR, svc, { scopeRegistry: {} })).rejects.toThrow(/published a scope/);
		const other = {};
		publishParentScope(other, "/ws/another", scope());
		await expect(openChildWorkspace(DIR, svc, { scopeRegistry: other })).rejects.toThrow(/never from scope\.json/);
	});

	it("refuses a published entry that is not a scope object", async () => {
		const { svc } = await parentWorkspace(null);
		const registry = {};
		publishParentScope(registry, DIR, [] as unknown as EngagementScope);
		await expect(openChildWorkspace(DIR, svc, { scopeRegistry: registry })).rejects.toBeInstanceOf(ChildSetupError);
	});

	/**
	 * scope.json was the workers' security config and the gated agent can write
	 * it: `write`, `edit` and a local bash redirect all pass the scope gate. One
	 * edit mid-session re-armed every later worker with whatever it said.
	 */
	it("gates the worker with the parent's scope, whatever scope.json has been edited to", async () => {
		const { svc, registry } = await parentWorkspace();
		await svc.fs.writeFile(`${DIR}/scope.json`, JSON.stringify(scope({ mode: "off", targets: { domains: ["*"] } })));
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		expect(setup.scope).toMatchObject({ mode: "enforce", targets: { domains: ["app.acme.test"] } });
		const guard = createChildGuard();
		guard.arm(setup.scope);
		expect((await guard.check({ name: "bash", args: { command: "curl -s http://outside.example.org/" } })).allow).toBe(false);
	});

	it("turns a corrupt manifest into a setup refusal, not a crash with a bare SyntaxError", async () => {
		const brokenManifest = makeFakeServices();
		await brokenManifest.fs.writeFile(`${DIR}/manifest.json`, "{ not json");
		await expect(openChildWorkspace(DIR, brokenManifest, { scopeRegistry: {} })).rejects.toBeInstanceOf(ChildSetupError);
	});

	it("hands the worker record and recall only, writing into the parent's ledger", async () => {
		const { svc, registry } = await parentWorkspace();
		const setup = await openChildWorkspace(` ${DIR} `, svc, { scopeRegistry: registry });
		expect(setup.tools.map((t) => t.name).sort()).toEqual(["recall", "record"]);
		expect(setup.scope.engagement).toBe("acme");

		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		await record?.execute({ kind: "endpoint", method: "GET", path: "/child-probe", file: "src/routes.ts" }, ctx);
		const rows = await new Workspace(DIR, svc).read("inventory");
		expect(rows).toEqual([expect.objectContaining({ kind: "endpoint", path: "/child-probe", file: "src/routes.ts" })]);
	});

	it("does not rewrite the parent's scope.json", async () => {
		const { svc, registry } = await parentWorkspace();
		const before = await svc.fs.readFile(`${DIR}/scope.json`);
		await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		expect(await svc.fs.readFile(`${DIR}/scope.json`)).toBe(before);
	});

	it("stamps worker records with the pass the parent has open", async () => {
		// Without it a worker launched in pass 2 records pass-1 rows, and the
		// pass delta reads the worker's work as something the first pass found.
		const { svc, registry } = await parentWorkspace(scope({ passes: { enabled: true } }));
		await new Workspace(DIR, svc).openPass();
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		const ctx: ToolContext = { cwd: "/target", services: svc };
		await setup.tools.find((t) => t.name === "record")?.execute({ kind: "host", value: "app.acme.test" }, ctx);
		expect((await new Workspace(DIR, svc).read("inventory"))[0]).toMatchObject({ pass: 2 });
	});

	it("honours PIRED_PASSES the way the parent does, for a scope that predates passes", async () => {
		const { svc, registry } = await parentWorkspace();
		await new Workspace(DIR, svc).openPass();
		const off = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		const on = await openChildWorkspace(DIR, svc, { scopeRegistry: registry, passes: "route,file" });
		const ctx: ToolContext = { cwd: "/target", services: svc };
		await off.tools.find((t) => t.name === "record")?.execute({ kind: "host", value: "a.acme.test" }, ctx);
		await on.tools.find((t) => t.name === "record")?.execute({ kind: "host", value: "b.acme.test" }, ctx);
		const rows = await new Workspace(DIR, svc).read("inventory");
		expect(rows.find((r) => "value" in r && r.value === "a.acme.test")).not.toHaveProperty("pass");
		expect(rows.find((r) => "value" in r && r.value === "b.acme.test")).toMatchObject({ pass: 2 });
	});
});

describe("publishing the parent's scope", () => {
	it("hands workers a frozen copy, so neither side's later edits reach the other", () => {
		const registry = {};
		const mine = scope();
		publishParentScope(registry, DIR, mine);
		mine.mode = "off";
		const published = readParentScope(registry, DIR);
		expect(published?.mode).toBe("enforce");
		expect(Object.isFrozen(published)).toBe(true);
		expect(Object.isFrozen(published?.targets?.domains)).toBe(true);
		expect(() => {
			(published as EngagementScope).mode = "off";
		}).toThrow();
	});

	it("keys by workspace, and republishing replaces the entry", () => {
		const registry = {};
		publishParentScope(registry, DIR, scope());
		publishParentScope(registry, "/ws/other", scope({ engagement: "other" }));
		publishParentScope(registry, DIR, scope({ mode: "warn" }));
		expect(readParentScope(registry, DIR)?.mode).toBe("warn");
		expect(readParentScope(registry, "/ws/other")?.engagement).toBe("other");
		expect(readParentScope({}, DIR)).toBeUndefined();
	});

	it("withdraws only its own entry, so a later session on the same workspace keeps its scope", () => {
		const registry = {};
		const first = publishParentScope(registry, DIR, scope());
		const second = publishParentScope(registry, DIR, scope({ mode: "warn" }));
		first();
		expect(readParentScope(registry, DIR)?.mode).toBe("warn");
		second();
		expect(readParentScope(registry, DIR)).toBeUndefined();
	});

	it("lives under the versioned process-global symbol a worker in another module copy can find", () => {
		const registry = {};
		publishParentScope(registry, DIR, scope());
		const slot = (registry as Record<symbol, unknown>)[Symbol.for(PARENT_SCOPE_KEY)];
		expect(slot).toBeInstanceOf(Map);
		// Not enumerable: the slot is not something a JSON dump of globalThis carries.
		expect(Object.keys(registry)).toEqual([]);
	});
});

describe("createChildGuard", () => {
	it("refuses every tool until it is armed, and says why arming failed", async () => {
		const guard = createChildGuard();
		expect(await guard.check({ name: "read", args: { path: "a.ts" } })).toMatchObject({ allow: false });
		guard.fail("no persisted scope");
		const refused = await guard.check({ name: "bash", args: { command: "ls" } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("no persisted scope");
		expect(guard.status.armed).toBe(false);
	});

	it("keeps an armed gate armed when a late failure is reported", async () => {
		const guard = createChildGuard();
		guard.arm(scope());
		guard.fail("late");
		expect(await guard.check({ name: "read", args: { path: "a.ts" } })).toEqual({ allow: true });
	});

	it("refuses pi-subagents' orchestration tools armed or not, so a worker cannot launch workers", async () => {
		// The parent's maxAgents counts the parent's launches only; a worker that
		// reached `subagent` would spawn outside that count.
		const guard = createChildGuard();
		for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor"]) {
			expect(CHILD_DENIED_TOOLS.has(name)).toBe(true);
			expect((await guard.check({ name, args: {} })).reason).toMatch(/do not delegate/);
		}
		guard.arm(scope());
		for (const name of CHILD_DENIED_TOOLS) {
			expect(await guard.check({ name, args: { agent: "pired-scout", task: "x" } })).toMatchObject({ allow: false });
		}
	});

	it("refuses contact_supervisor, which would hold the worker for a reply its blocked parent cannot give", async () => {
		// pi-subagents 0.71 registers it in every foreground child and tells the
		// worker to use it first; a need_decision then waits up to 10 minutes.
		const guard = createChildGuard();
		guard.arm(scope());
		const refused = await guard.check({ name: SUPERVISOR_TOOL, args: { reason: "need_decision", message: "which host?" } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toMatch(/as a blocker/);
		expect((await guard.check({ name: SUPERVISOR_TOOL, args: { reason: "progress_update", message: "UPDATE" } })).allow).toBe(false);
	});

	it("refuses a scope-declared agent tool, because the worker's gate runs with maxAgents 0", async () => {
		const guard = createChildGuard();
		guard.arm(scope({ agentTools: ["team_spawn"], maxAgents: 8 }));
		const refused = await guard.check({ name: "team_spawn", args: {} });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toMatch(/maxAgents=0/);
	});

	it("blocks out-of-scope bash with exactly the reason the parent's gate gives", async () => {
		const s = scope();
		const call = { name: "bash", args: { command: "curl -s http://outside.example.org/" } };
		const parent = await createScopeGate(s)(call);
		const guard = createChildGuard();
		guard.arm(s);
		const child = await guard.check(call);
		expect(child.allow).toBe(false);
		expect(child.reason).toBe(parent.reason);
		expect(await guard.check({ name: "bash", args: { command: "curl -s https://app.acme.test/" } })).toEqual({ allow: true });
	});

	it("lets a worker call tools for its role's turns, then tells it to hand back", async () => {
		const verify = agent("pired-verify");
		const guard = createChildGuard();
		guard.arm(scope());
		expect(guard.identify(`${agentMarker(verify.name)}\n\nbody`)?.name).toBe(verify.name);
		for (let i = 0; i < verify.maxTurns; i++) guard.turnStarted();
		expect(await guard.check({ name: "record", args: { kind: "note", text: "x" } })).toEqual({ allow: true });

		guard.turnStarted();
		const refused = await guard.check({ name: "record", args: { kind: "note", text: "x" } });
		expect(refused).toMatchObject({ allow: false });
		expect(refused.terminate).toBeUndefined();
		expect(refused.reason).toContain(`pired-verify has used its ${verify.maxTurns}-turn budget`);
		expect(refused.reason).toContain("200 words");
	});

	it("ends the run once a worker keeps calling tools through the grace turns", async () => {
		// Each blocked turn is still a full model request; a worker that ignores
		// the hand-back instruction would otherwise run to the per-call backstop.
		const guard = createChildGuard();
		guard.arm(scope());
		guard.identify(agentMarker("pired-scout"));
		const scout = agent("pired-scout");
		for (let i = 0; i < scout.maxTurns + HANDOFF_GRACE_TURNS; i++) guard.turnStarted();
		expect((await guard.check({ name: "read", args: {} })).terminate).toBeUndefined();
		guard.turnStarted();
		expect(await guard.check({ name: "read", args: {} })).toMatchObject({ allow: false, terminate: true });
	});

	it("falls back to the tightest role budget when the prompt names no pired worker", async () => {
		const guard = createChildGuard();
		guard.arm(scope());
		expect(guard.identify("no marker here")).toBeUndefined();
		expect(guard.status.maxTurns).toBe(FALLBACK_MAX_TURNS);
		expect(FALLBACK_MAX_TURNS).toBe(Math.min(...PIRED_AGENTS.map((a) => a.maxTurns)));
		for (let i = 0; i <= FALLBACK_MAX_TURNS; i++) guard.turnStarted();
		expect((await guard.check({ name: "read", args: {} })).reason).toContain("this worker has used its");
	});

	it("keeps the first role it identified, so a changed prompt cannot extend the budget", () => {
		const guard = createChildGuard();
		guard.identify(undefined);
		guard.identify(agentMarker("pired-verify"));
		guard.identify(agentMarker("pired-investigate"));
		expect(guard.status).toMatchObject({ agent: "pired-verify", maxTurns: 16, turns: 0 });
	});
});
