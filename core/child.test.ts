import { describe, expect, it } from "vitest";
import {
	CHILD_DENIED_TOOLS, type ChildLedger, ChildSetupError, createChildGuard, FALLBACK_MAX_TURNS, HANDOFF_GRACE_TURNS,
	identifyAgent, openChildWorkspace, PARENT_SCOPE_KEY, publishParentScope, readParentScope, RECORD_RESERVE_TURNS,
	readParentRoot, SUPERVISOR_SECTION_END, SUPERVISOR_SECTION_START, SUPERVISOR_TOOL, VERIFIER_FINDING_KEYS, VERIFIER_STATUSES, FINDER_STATUSES,
	withoutSupervisorSection,
} from "./child.ts";
import { type EngagementScope, FINDING_STATUSES, type FindingRecord, HYPOTHESIS_OUTCOMES, type HypothesisRecord, type StoreName } from "./ontology.ts";
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

const AT = "2026-09-24T00:00:00.000Z";

function findingRow(over: Partial<FindingRecord> = {}): FindingRecord {
	return {
		v: 1, id: "f-1", kind: "finding", createdAt: AT, title: "Missing owner check on invoice export", severity: "medium",
		target: "src/export.ts:40", description: "The export handler never compares the invoice owner to the caller.", status: "suspected", ...over,
	};
}

function hypothesisRow(over: Partial<HypothesisRecord> = {}): HypothesisRecord {
	return {
		v: 1, id: "h-7", kind: "hypothesis", createdAt: AT, statement: "invoice export is guarded by the owner check in the router",
		target: "e-1", class: "idor", outcome: "refuted", ...over,
	};
}

/** A ledger the guard reads, holding exactly these rows. */
function ledgerOf(findings: FindingRecord[] = [], hypotheses: HypothesisRecord[] = []): ChildLedger {
	return { findings: async () => findings, hypotheses: async () => hypotheses };
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
		expect(identifyAgent(prompt)?.name).toBe("pired-verify");
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

	it("stamps a worker's rows with its agent name, read at the write, and never leaves one unattributed", async () => {
		// The role can be learned after the tools are built, so the name is read
		// when the row is written. A worker whose role never resolved is still a
		// worker: its row must not read as the lead's, nor as nobody's.
		const { svc, registry } = await parentWorkspace();
		let name: string | undefined;
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry, author: () => name });
		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		await record?.execute({ kind: "finding", title: "Verbose stack traces", severity: "low", target: "src/errors.ts:3" }, ctx);
		name = "pired-investigate";
		await record?.execute({ kind: "finding", title: "Missing owner check on invoice export", severity: "high", target: "src/export.ts:40" }, ctx);
		const rows = await new Workspace(DIR, svc).read("findings");
		expect(rows.map((r) => r.by)).toEqual(["worker", "pired-investigate"]);
	});

	/**
	 * The reserve and the settle reminder used to count every `record` call that
	 * resolved, so `record kind=evidence` — a file, not a ledger row — or a repeat
	 * that matched a row already there released both for a worker whose work was
	 * still nowhere on the ledger.
	 */
	it("reports a write only when rows reach a ledger store: not an evidence file, a note, or a repeat that changed nothing", async () => {
		const { svc, registry } = await parentWorkspace();
		const writes: StoreName[] = [];
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry, onWrite: (store) => writes.push(store) });
		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		await record?.execute({ kind: "evidence", name: "export-200.txt", content: "HTTP/1.1 200 OK" }, ctx);
		await record?.execute({ kind: "note", text: "read the export handler" }, ctx);
		expect(writes).toEqual([]);

		const endpoint = { kind: "endpoint", method: "GET", path: "/export", file: "src/export.ts" };
		await record?.execute(endpoint, ctx);
		await record?.execute(endpoint, ctx);
		expect(writes).toEqual(["inventory"]);

		const cells = { kind: "hypothesis", target: ["e-1", "e-2"], class: "idor", statement: "the export skips the owner check", outcome: "proposed" };
		await record?.execute(cells, ctx);
		const afterFirst = writes.length;
		expect(writes.at(-1)).toBe("hypotheses");
		await record?.execute(cells, ctx);
		expect(writes).toHaveLength(afterFirst);
	});

	it("hands the gate the parent's ledger, live rows only", async () => {
		const { svc, registry } = await parentWorkspace();
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		const kept = await record?.execute({ kind: "finding", title: "IDOR on invoices", severity: "high", target: "src/invoices.ts:12" }, ctx);
		const gone = await record?.execute({ kind: "finding", title: "Verbose errors", severity: "low", target: "src/errors.ts:3" }, ctx);
		const goneId = (gone?.details as { id: string }).id;
		await record?.execute({ kind: "finding", id: goneId, delete: true, reason: "duplicate" }, ctx);
		await record?.execute({ kind: "hypothesis", target: "e-1", class: "idor", statement: "invoices skip the owner check", outcome: "confirmed" }, ctx);
		expect((await setup.ledger.findings()).map((f) => f.id)).toEqual([(kept?.details as { id: string }).id]);
		expect(await setup.ledger.hypotheses()).toEqual([expect.objectContaining({ class: "idor", outcome: "confirmed" })]);
	});

	/**
	 * The review probe, end to end: the finding under check sent back as a new one
	 * with a made-up hypothesisId. The gate let any hypothesisId through, and the
	 * record tool's identity check folded the call into the existing finding.
	 */
	it("refuses the linked create the record tool would merge into an existing finding, which it otherwise rewrites", async () => {
		const { svc, registry } = await parentWorkspace();
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		const original = { kind: "finding", title: "Missing owner check on invoice export", severity: "medium", target: "src/export.ts:40", description: "No owner check." };
		const fid = ((await record?.execute(original, ctx))?.details as { id: string }).id;
		const hid = ((await record?.execute({ kind: "hypothesis", target: "e-1", class: "idor", statement: "the router's owner check runs before the export handler", outcome: "refuted" }, ctx))?.details as { id: string }).id;
		const guard = createChildGuard();
		guard.arm(setup.scope, setup.ledger);
		guard.identify(agentMarker("pired-verify"));
		guard.turnStarted();

		const probe = { ...original, hypothesisId: "h-any", severity: "critical", description: "A different mechanism, described at length so that it wins the merge." };
		expect((await guard.check({ name: "record", args: probe })).reason).toContain("no hypothesis 'h-any' on the shared ledger");
		const merge = await guard.check({ name: "record", args: { ...probe, hypothesisId: hid } });
		expect(merge.allow).toBe(false);
		expect(merge.reason).toContain(`this is finding ${fid}`);
		expect(merge.reason).toContain(`record id=${fid} status=confirmed|refuted|suspected`);
		const fresh = { kind: "finding", hypothesisId: hid, title: "Export CSV includes other tenants' totals", severity: "high", target: "src/export.ts:88" };
		// A fresh finding still waits on the hypothesis: it is recorded refuted.
		expect((await guard.check({ name: "record", args: fresh })).reason).toContain(`hypothesis ${hid} is recorded refuted, not confirmed`);
		const confirm = { kind: "hypothesis", id: hid, outcome: "confirmed", basis: ["src/export.ts:88"] };
		expect(await guard.check({ name: "record", args: confirm })).toEqual({ allow: true });
		await record?.execute(confirm, ctx);
		expect(await guard.check({ name: "record", args: fresh })).toEqual({ allow: true });

		// What the refusal prevents: sent anyway, the call rewrites the finding.
		await record?.execute({ ...probe, hypothesisId: hid }, ctx);
		const after = (await setup.ledger.findings()).find((f) => f.id === fid);
		expect(after).toMatchObject({ severity: "critical", description: probe.description, hypothesisId: hid });
	});

	/**
	 * The round-three review probe, end to end: a verifier's status=suspected with
	 * only a 'reason' passed the gate, and the record tool — which reads a look
	 * that settled nothing from a basis or a control case — wrote it as a plain
	 * edit that moved confirmed, refuted and reported findings back to suspected.
	 */
	it("keeps a settled finding's status through the real record tool: a reason-only look is refused, a grounded one is kept as a look", async () => {
		const { svc, registry } = await parentWorkspace();
		const setup = await openChildWorkspace(DIR, svc, { scopeRegistry: registry });
		const record = setup.tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target", services: svc };
		const guard = createChildGuard();
		guard.arm(setup.scope, setup.ledger);
		guard.identify(agentMarker("pired-verify"));
		guard.turnStarted();
		const settled = [
			{ status: "confirmed", title: "IDOR on invoice export", target: "src/export.ts:40", verdict: { control: "another tenant's session got 403 on the same export" } },
			{ status: "refuted", title: "SQL injection in the search filter", target: "src/search.ts:18", verdict: { basis: ["src/search.ts:22"], live: true } },
			{ status: "reported", title: "Verbose stack traces on error pages", target: "src/errors.ts:3", verdict: {} },
		];
		for (const { status, title, target, verdict } of settled) {
			const created = await record?.execute({ kind: "finding", title, severity: "high", target }, ctx);
			const id = (created?.details as { id: string }).id;
			await record?.execute({ kind: "finding", id, status, ...verdict }, ctx);
			const before = (await setup.ledger.findings()).find((f) => f.id === id);
			expect(before?.status).toBe(status);

			const note = { kind: "finding", id, status: "suspected", reason: "read the handler; could not settle it" };
			expect((await guard.check({ name: "record", args: { ...note } })).reason).toContain("A 'reason' alone is a note");
			const look = { kind: "finding", id, status: "suspected", basis: [target], reason: "could not reach the sink offline" };
			expect(await guard.check({ name: "record", args: { ...look } })).toEqual({ allow: true });
			await record?.execute({ ...look }, ctx);
			const after = (await setup.ledger.findings()).find((f) => f.id === id);
			expect(after?.status).toBe(status);
			// An earned verdict stays the finding's verification; the look goes into its notes.
			if (before?.verification) expect(after?.verification?.verdict).toBe(before.verification.verdict);
		}
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

	/**
	 * In a source-only engagement (scope mode off, no targets) a refutation that
	 * honestly said live=false came back 'unresolved', so an honest verifier could
	 * not refute; baseline runs refuted by asserting live=true on scopes with no
	 * target — 17 of 18 verification records in the 2026-09-24 grid. The worker's
	 * tools have to read that off the parent's scope, not default to "live".
	 */
	it("lets a worker's tools see a source-only parent scope, and a scope with targets as live", async () => {
		const verdictUnder = async (s: EngagementScope): Promise<unknown> => {
			const { svc, registry } = await parentWorkspace(s);
			// On a review of source the refutation quotes the guard (3.1), so the file is there to quote.
			await svc.fs.writeFile("/target/src/invoices.ts", "import { db } from './db';\n".repeat(8) + "if (invoice.ownerId !== user.id) throw forbidden();\n");
			const record = (await openChildWorkspace(DIR, svc, { scopeRegistry: registry })).tools.find((t) => t.name === "record");
			const ctx: ToolContext = { cwd: "/target", services: svc };
			const created = await record?.execute({ kind: "finding", title: "IDOR on invoices", severity: "high", target: "src/invoices.ts:12" }, ctx);
			const id = (created?.details as { id?: string } | undefined)?.id;
			await record?.execute({ kind: "finding", id, status: "refuted", basis: ["src/invoices.ts:9: if (invoice.ownerId !== user.id) throw forbidden();"], live: false, reason: "the owner check runs first" }, ctx);
			return (await new Workspace(DIR, svc).read("findings")).find((f) => f.id === id)?.status;
		};
		expect(await verdictUnder(scope({ mode: "off", targets: {} }))).toBe("refuted");
		expect(await verdictUnder(scope())).toBe("suspected");
	});
});

describe("publishing the parent's scope", () => {
	it("publishes the engagement root beside it, and withdraws both together", () => {
		const registry = {};
		const withdraw = publishParentScope(registry, DIR, scope(), "/target");
		expect(readParentRoot(registry, DIR)).toBe("/target");
		withdraw();
		expect(readParentRoot(registry, DIR)).toBeUndefined();
		expect(readParentRoot({}, DIR)).toBeUndefined();
		// Republished without a root, the old one does not linger.
		publishParentScope(registry, DIR, scope(), "/target");
		publishParentScope(registry, DIR, scope());
		expect(readParentRoot(registry, DIR)).toBeUndefined();
	});

	it("lets a worker launched in a subdirectory resolve a quote against the parent's root", async () => {
		const { svc, registry } = await parentWorkspace(scope({ mode: "off", targets: {} }));
		publishParentScope(registry, DIR, scope({ mode: "off", targets: {} }), "/target");
		await svc.fs.writeFile("/target/src/invoices.ts", "import { db } from './db';\n".repeat(8) + "if (invoice.ownerId !== user.id) throw forbidden();\n");
		const record = (await openChildWorkspace(DIR, svc, { scopeRegistry: registry, author: () => "pired-verify" })).tools.find((t) => t.name === "record");
		const ctx: ToolContext = { cwd: "/target/src", services: svc };
		const created = await record?.execute({ kind: "finding", title: "IDOR on invoices", severity: "high", target: "src/invoices.ts:12" }, ctx);
		const id = (created?.details as { id?: string } | undefined)?.id;
		await record?.execute({ kind: "finding", id, status: "suspected", guards: ["invoices.ts:9: if (invoice.ownerId !== user.id) throw forbidden();"] }, ctx);
		const f = (await new Workspace(DIR, svc).read("findings")).find((x) => x.id === id);
		expect(f?.verification?.guards?.[0]?.at).toBe("src/invoices.ts:9");
	});

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
		for (const reason of ["need_decision", "interview_request"]) {
			const refused = await guard.check({ name: SUPERVISOR_TOOL, args: { reason, message: "which host?" } });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toMatch(/as a blocker/);
		}
	});

	it("tells a worker sending a progress update to carry on, not to park a blocker nobody asked for", async () => {
		// 31 contact_supervisor calls were refused in the 2026-09-24 grid, most of
		// them updates pi-subagents' prompt section invited. A blocker for each
		// would fill the operator's panel with questions no one posed.
		const guard = createChildGuard();
		guard.arm(scope());
		for (const args of [{ reason: "progress_update", message: "UPDATE: mapped the routes" }, {}, undefined]) {
			const refused = await guard.check({ name: SUPERVISOR_TOOL, args });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("no supervisor channel");
			expect(refused.reason).toContain("your handoff is the report");
			expect(refused.reason).not.toMatch(/blocker/);
		}
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
		guard.recorded("findings");
		for (let i = 0; i < verify.maxTurns; i++) guard.turnStarted();
		expect(await guard.check({ name: "bash", args: { command: "ls" } })).toEqual({ allow: true });

		guard.turnStarted();
		const refused = await guard.check({ name: "bash", args: { command: "ls" } });
		expect(refused).toMatchObject({ allow: false });
		expect(refused.terminate).toBeUndefined();
		expect(refused.reason).toContain(`pired-verify has used its ${verify.maxTurns}-turn budget`);
		expect(refused.reason).toContain("200 words");
	});

	/**
	 * The shipped regression: the budget refusal refused `record` with everything
	 * else. In the 2026-09-24 grid 17–18 worker record calls died on that line, 11
	 * of them for work that reached neither the ledger nor the handoff, and 10 of
	 * 13 gpt-6-luna scouts lost one there.
	 */
	it("keeps the ledger open through the grace turns while refusing every other tool, and says so", async () => {
		const scout = agent("pired-scout");
		const guard = worker("pired-scout", scout.maxTurns + 1);
		const hypothesis = { kind: "hypothesis", target: "e-1", class: "c-1", outcome: "proposed" };
		expect(await guard.check({ name: "record", args: hypothesis })).toEqual({ allow: true });
		expect(await guard.check({ name: "recall", args: { what: "surface" } })).toEqual({ allow: true });
		const bash = await guard.check({ name: "bash", args: { command: "ls" } });
		expect(bash).toMatchObject({ allow: false });
		expect(bash.terminate).toBeUndefined();
		expect(bash.reason).toContain("The ledger is still open: record and recall run for 1 more turn after this one");
		// Role rules and the scope gate still apply to the ledger calls it lets through.
		expect((await guard.check({ name: "record", args: { kind: "finding", title: "t", severity: "low" } })).reason).toContain("does not record findings");

		guard.turnStarted();
		expect(await guard.check({ name: "record", args: hypothesis })).toEqual({ allow: true });
		const last = await guard.check({ name: "read", args: {} });
		expect(last.reason).toContain("This is the ledger's last turn");
		expect(last.terminate).toBeUndefined();
	});

	it("ends the run once a worker keeps calling tools through the grace turns, record included", async () => {
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
		expect(await guard.check({ name: "record", args: { kind: "note", text: "x" } })).toMatchObject({ allow: false, terminate: true });
		expect(await guard.check({ name: "recall", args: {} })).toMatchObject({ allow: false, terminate: true });
	});

	it("falls back to the tightest role budget when the prompt names no pired worker", async () => {
		const guard = createChildGuard();
		guard.arm(scope());
		expect(guard.identify("no marker here")).toBeUndefined();
		expect(guard.status.maxTurns).toBe(FALLBACK_MAX_TURNS);
		expect(FALLBACK_MAX_TURNS).toBe(Math.min(...PIRED_AGENTS.map((a) => a.maxTurns)));
		for (let i = 0; i < FALLBACK_MAX_TURNS; i++) guard.turnStarted();
		expect((await guard.check({ name: "read", args: {} })).reason).toContain("this worker has 0 turns left after this one");
		guard.turnStarted();
		expect((await guard.check({ name: "read", args: {} })).reason).toContain("this worker has used its");
	});

	it("keeps the first role it identified, so a changed prompt cannot extend the budget", () => {
		const guard = createChildGuard();
		guard.identify(undefined);
		guard.identify(agentMarker("pired-verify"));
		guard.identify(agentMarker("pired-investigate"));
		expect(guard.status).toMatchObject({ agent: "pired-verify", maxTurns: agent("pired-verify").maxTurns, turns: 0 });
	});
});

/**
 * The section pi-subagents 0.71 appends for its supervisor channel, verbatim
 * from DEFAULT_INTERCOM_BRIDGE_TEMPLATE (src/intercom/intercom-bridge.js) behind
 * the marker `buildIntercomBridgeInstruction` puts in front of it. Copied, not
 * imported: pired never imports pi-subagents (ADR-027).
 */
const BRIDGE_SECTION = `${SUPERVISOR_SECTION_START}
The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.

Use contact_supervisor first. It resolves the supervisor session and run metadata automatically.
- Need a decision, blocked, approval, or product/API/scope ambiguity: contact_supervisor({ reason: "need_decision", message: "<question>" })
- Need structured supervisor input rather than a freeform reply: contact_supervisor({ reason: "interview_request", message: "<what input is needed>", interview: { title: "...", questions: [] } })
- After contact_supervisor with reason "need_decision" or "interview_request", stay alive and continue only after the reply arrives. Do not finish your final response with a choose-one question.
- Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions. If an output path is configured but no write-capable tool is available, return the complete artifact in your final response; the runtime will persist it. Do not contact the supervisor merely because you cannot write that output path directly.
- Meaningful progress or unexpected discoveries that change the plan: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })

Do not use contact_supervisor for routine completion handoffs. If no coordination is needed, return a focused task result.`;

describe("withoutSupervisorSection", () => {
	/**
	 * The shipped cost: the section opens "Use contact_supervisor first", the gate
	 * refuses that tool, and 31 such calls were refused in the 2026-09-24 grid.
	 */
	it("cuts pi-subagents' supervisor section out of a worker prompt and keeps what surrounds it", () => {
		// How the prompt reaches pi: pi-subagents' tag, the agent prompt with the
		// section appended, then pi's own sections after the preamble.
		const workerPrompt = `${agentMarker("pired-verify")}\n\nYou are pired-verify.`;
		const prompt = `<active_agent name="pired-verify"/>\n\n${workerPrompt}\n\n${BRIDGE_SECTION}\n\n<cwd>\n/target\n</cwd>`;
		const cut = withoutSupervisorSection(prompt);
		expect(cut).toBe(`<active_agent name="pired-verify"/>\n\n${workerPrompt}\n\n<cwd>\n/target\n</cwd>`);
		expect(cut).not.toContain(SUPERVISOR_TOOL);
		expect(identifyAgent(cut)?.name).toBe("pired-verify");
		// At the very end of the prompt, and as the whole of it.
		expect(withoutSupervisorSection(`${workerPrompt}\n\n${BRIDGE_SECTION}`)).toBe(workerPrompt);
		expect(withoutSupervisorSection(BRIDGE_SECTION)).toBe("");
	});

	it("leaves a prompt alone when the section is absent or not the one pired knows", () => {
		const plain = `${agentMarker("pired-scout")}\n\nMap the surface.`;
		expect(withoutSupervisorSection(plain)).toBe(plain);
		// A custom instructionFile template: the marker, but not the default's ending.
		const custom = `${plain}\n\n${SUPERVISOR_SECTION_START}\nPing contact_supervisor when you are done.`;
		expect(withoutSupervisorSection(custom)).toBe(custom);
		// The marker quoted mid-line, not starting the section.
		const quoted = `${plain} The words "${SUPERVISOR_SECTION_START}" mean nothing here. ${SUPERVISOR_SECTION_END}`;
		expect(withoutSupervisorSection(quoted)).toBe(quoted);
		// Both sentences, but nothing between them about the tool.
		const unrelated = `${plain}\n${SUPERVISOR_SECTION_START}\nsomething else. ${SUPERVISOR_SECTION_END}`;
		expect(withoutSupervisorSection(unrelated)).toBe(unrelated);
		// The ending with no marker before it.
		expect(withoutSupervisorSection(`${plain}\n${SUPERVISOR_SECTION_END}`)).toBe(`${plain}\n${SUPERVISOR_SECTION_END}`);
	});
});

/** An armed guard that knows it is `name`, `turns` turns into its run, reading `ledger`. */
function worker(name: string, turns = 1, ledger?: ChildLedger) {
	const guard = createChildGuard();
	guard.arm(scope(), ledger);
	guard.identify(agentMarker(name));
	for (let i = 0; i < turns; i++) guard.turnStarted();
	return guard;
}

describe("what each role may record", () => {
	it("lets a verifier settle a finding by id with only the verdict keys", async () => {
		const guard = worker("pired-verify");
		const confirm = { kind: "finding", id: "f-1", status: "confirmed", control: "unauthenticated GET returned 401 (evidence/f-1-control.txt)", entitlement: "object belongs to another tenant" };
		const refute = { kind: "finding", id: "f-1", status: "refuted", basis: ["src/auth.ts:42", "evidence/f-1-refute.txt"], live: true, reason: "the guard runs before the handler" };
		const unsettled = { kind: "finding", id: "f-1", status: "suspected", basis: ["src/export.ts:40"], reason: "read the handler; could not reach the sink offline" };
		for (const args of [confirm, refute, unsettled]) expect(await guard.check({ name: "record", args })).toEqual({ allow: true });
	});

	/**
	 * The id path spreads the patch over the stored row, so a verifier's evidence
	 * list replaced the investigator's rather than adding to it.
	 */
	it("refuses a verifier's evidence list and points it at basis or control for its saved output", async () => {
		const guard = worker("pired-verify");
		const refused = await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "confirmed", control: "401 unauthenticated", evidence: ["evidence/mine.txt"] } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("'evidence'");
		expect(refused.reason).toContain("record kind=evidence returns its path — in 'control' or 'basis'");
		expect(refused.reason).not.toContain("raw output under evidence");
	});

	/**
	 * `false-positive`, `ignored` and the rest skip the record tool's verdict
	 * check, which judges only confirmed and refuted: a verifier writing one would
	 * close a finding with no basis at all.
	 */
	it("limits a verifier's status to a verdict and refuses the operator's dispositions by name", async () => {
		const guard = worker("pired-verify");
		expect([...VERIFIER_STATUSES].sort()).toEqual(["confirmed", "refuted", "suspected"]);
		for (const status of ["false-positive", "ignored", "accepted-risk", "reported", "triaged", "open", "Refuted", "verified"]) {
			const refused = await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status, reason: "not real" } });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain(`not '${status}'`);
			expect(refused.reason).toContain("refute it with a basis");
		}
		// On a finding it creates as well, and whatever type the model sent.
		expect((await guard.check({ name: "record", args: { kind: "finding", hypothesisId: "h-1", title: "t", severity: "high", status: "reported" } })).allow).toBe(false);
		expect((await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: ["refuted"] } })).reason).toContain(`not '["refuted"]'`);
	});

	/**
	 * The shipped regression: in the v4 grid two pired-verify workers re-recorded
	 * the findings they were checking with new descriptions. An update by id is
	 * last-write-wins, so the investigator's text and cited locations were
	 * replaced, and the replayed ledger went from 4 true positives to 2.
	 */
	it("refuses a verifier's id-update that rewrites the description, and names the key", async () => {
		const guard = worker("pired-verify");
		const refused = await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "confirmed", description: "a different mechanism" } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("'description'");
		expect(refused.reason).toContain("a verdict, not a rewrite");
		expect(refused.terminate).toBeUndefined();
	});

	it("names every rewritten key and ignores the empty values a model fills optional parameters with", async () => {
		const guard = worker("pired-verify");
		const refused = await guard.check({
			name: "record",
			args: { kind: "finding", id: "f-1", status: "refuted", title: "x", locations: ["a.ts:1"], severity: "low", repro: "", cwe: null, source: undefined, remediation: [] },
		});
		expect(refused.reason).toContain("'title', 'locations', 'severity'");
		for (const key of ["repro", "cwe", "source", "remediation"]) expect(refused.reason).not.toContain(`'${key}'`);
		// The same empties alongside verdict keys only are not a rewrite.
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "refuted", basis: ["a.ts:1"], live: true, repro: "", cwe: null } })).toEqual({ allow: true });
	});

	it("keeps the verifier's allowed keys to the verdict and its grounds", () => {
		expect([...VERIFIER_FINDING_KEYS].sort()).toEqual(["basis", "control", "entitlement", "guards", "id", "kind", "live", "path", "reason", "status"]);
	});

	it("lets a verifier send its quoted path and guards, and counts a quoted guard alone as a look", async () => {
		const guard = worker("pired-verify");
		const confirm = { kind: "finding", id: "f-1", status: "confirmed", control: "no owner check on the path", path: ["src/export.ts:12: const id = req.params.id", "src/export.ts:40: return db.invoices.find(id)"] };
		const look = { kind: "finding", id: "f-1", status: "suspected", guards: ["src/router.ts:8: router.use(requireOwner)"] };
		for (const args of [confirm, look]) expect(await guard.check({ name: "record", args })).toEqual({ allow: true });
	});

	it("does not let a verifier create an unlinked finding or delete one", async () => {
		// Refuting is a status: a deleted finding drops out of every view, while a
		// refuted one keeps its history and the verdict's grounds.
		const guard = worker("pired-verify");
		const created = await guard.check({ name: "record", args: { kind: "finding", title: "new", severity: "high", description: "d" } });
		expect(created).toMatchObject({ allow: false });
		expect(created.reason).toContain("does not create findings of its own");
		expect(created.reason).toContain("only for a hypothesis it confirmed, by that hypothesis's real id");
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "", status: "refuted" } })).toMatchObject({ allow: false });
		for (const del of [true, "true"]) {
			const deleted = await guard.check({ name: "record", args: { kind: "finding", id: "f-1", delete: del, reason: "not real" } });
			expect(deleted).toMatchObject({ allow: false });
			expect(deleted.reason).toContain("refuting is a status, not a deletion");
		}
	});

	it("does not read a model's delete:false, or any other false it fills in, as a rewrite", async () => {
		const guard = worker("pired-verify");
		const settle = { kind: "finding", id: "f-1", status: "refuted", basis: ["src/a.ts:3"], live: false, delete: false, draft: false };
		expect(await guard.check({ name: "record", args: settle })).toEqual({ allow: true });
	});

	/**
	 * A verifier that finds a cleared hypothesis holds after all has to get the
	 * finding into the report; refusing it left the verdict in a handoff only.
	 */
	it("lets a verifier create a finding linked to the hypothesis it overturned and recorded confirmed, and still not rewrite one by id", async () => {
		const guard = worker("pired-verify", 1, ledgerOf([], [hypothesisRow({ outcome: "confirmed" })]));
		const linked = { kind: "finding", hypothesisId: "h-7", title: "Missing owner check on invoice export", severity: "high", description: "d", locations: ["src/export.ts:40"], evidence: ["evidence/export.txt"] };
		expect(await guard.check({ name: "record", args: linked })).toEqual({ allow: true });
		const rewrite = await guard.check({ name: "record", args: { ...linked, id: "f-1" } });
		expect(rewrite.allow).toBe(false);
		expect(rewrite.reason).toContain("may not change");
		expect(rewrite.reason).toContain("'hypothesisId'");
	});

	it("checks a verifier's hypothesisId against the ledger and refuses a create that matches an existing finding by title, file or class", async () => {
		const existing = findingRow({ class: "idor" });
		const guard = worker("pired-verify", 1, ledgerOf([existing], [hypothesisRow({ outcome: "confirmed" })]));
		const probe = { kind: "finding", hypothesisId: "h-any", title: existing.title, severity: "critical", target: existing.target, description: "longer, so it would win the merge" };
		const unknown = await guard.check({ name: "record", args: probe });
		expect(unknown.allow).toBe(false);
		expect(unknown.reason).toContain("no hypothesis 'h-any' on the shared ledger");
		expect(unknown.reason).toContain("A verifier creates a finding only for a hypothesis it confirmed, by that hypothesis's real id");
		expect((await guard.check({ name: "record", args: { ...probe, hypothesisId: ["h-7"] } })).reason).toContain('no hypothesis ["h-7"]');

		// The record tool's identity check, which the create would go through: the
		// same title with the file named but no line, and another title on the
		// same line and class, are both the finding already there.
		for (const args of [
			{ ...probe, hypothesisId: "h-7" },
			{ ...probe, hypothesisId: "h-7", target: "export.ts" },
			{ kind: "finding", hypothesisId: "h-7", title: "IDOR in the invoice export", severity: "high", class: "idor", target: "src/export.ts:40" },
		]) {
			const refused = await guard.check({ name: "record", args });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("this is finding f-1 ('Missing owner check on invoice export'), already on the ledger");
			expect(refused.reason).toContain("record id=f-1 status=confirmed|refuted|suspected");
		}
		const fresh = { kind: "finding", hypothesisId: "h-7", title: "Export CSV includes other tenants' totals", severity: "high", target: "src/export.ts:88", evidence: "evidence/export.csv" };
		expect(await guard.check({ name: "record", args: fresh })).toEqual({ allow: true });
	});

	it("refuses a verifier's linked create when it has no ledger to check it against, or cannot read it", async () => {
		const linked = { kind: "finding", hypothesisId: "h-7", title: "t", severity: "high" };
		expect((await worker("pired-verify").check({ name: "record", args: linked })).reason).toContain("no hypothesis 'h-7'");

		const failing = async (): Promise<never> => {
			throw new Error("EIO: findings.jsonl");
		};
		const broken = worker("pired-verify", 1, { findings: failing, hypotheses: failing });
		const refused = await broken.check({ name: "record", args: linked });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("could not read the shared ledger to check this record call (EIO: findings.jsonl)");
		// A call that needs no read is decided as before.
		expect(await broken.check({ name: "record", args: { kind: "finding", id: "f-1", status: "refuted", basis: ["src/a.ts:3"], title: "x" } })).toMatchObject({ allow: false, reason: expect.stringContaining("may not change 'title'") });
		expect(await broken.check({ name: "record", args: { kind: "hypothesis", id: "h-7", outcome: "refuted", basis: ["src/a.ts:3"] } })).toEqual({ allow: true });
	});

	/**
	 * `reported` means the finding has gone to the client. The record tool only
	 * says so after the write, and by then a verifier's refutation had already
	 * moved it.
	 */
	it("refuses a verifier's verdict on a reported finding and points it at status=suspected with its grounds and the handoff", async () => {
		const guard = worker("pired-verify", 1, ledgerOf([findingRow({ status: "reported" }), findingRow({ id: "f-2" })]));
		for (const args of [
			{ kind: "finding", id: "f-1", status: "refuted", basis: ["src/export.ts:12"], reason: "the router checks the owner first" },
			{ kind: "finding", id: "f-1", status: "confirmed", control: "the owner's request returned 200; another tenant's returned 200 too" },
		]) {
			const refused = await guard.check({ name: "record", args });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("finding f-1 is already reported");
			expect(refused.reason).toContain("the operator's decision");
			expect(refused.reason).toContain("Record status=suspected on it with your grounds in 'basis' or 'control'");
			expect(refused.reason).toContain("in your handoff for the operator");
		}
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "suspected", basis: ["src/export.ts:12"] } })).toEqual({ allow: true });
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "suspected", control: "401 without a session" } })).toEqual({ allow: true });
		// The same verdict on a finding not yet reported is the verifier's to write.
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-2", status: "refuted", basis: ["src/export.ts:12"] } })).toEqual({ allow: true });
	});

	/**
	 * Only `reported` used to be held for the operator, so a verifier's
	 * refutation with a basis was judged and written over a triaged,
	 * false-positive or accepted-risk finding as over any suspected one.
	 */
	it("leaves every operator disposition's status to the operator, names it, and still takes a grounded look on it", async () => {
		const dispositions = FINDING_STATUSES.filter((s) => s !== "open" && !VERIFIER_STATUSES.has(s));
		expect([...dispositions].sort()).toEqual(["accepted-risk", "false-positive", "ignored", "reported", "triaged"]);
		for (const status of dispositions) {
			const guard = worker("pired-verify", 1, ledgerOf([findingRow({ status })]));
			for (const args of [
				{ kind: "finding", id: "f-1", status: "refuted", basis: ["src/export.ts:12"], live: true },
				{ kind: "finding", id: "f-1", status: "confirmed", control: "another tenant's request returned 200", entitlement: "the invoice is another tenant's" },
			]) {
				const refused = await guard.check({ name: "record", args });
				expect(refused.allow).toBe(false);
				expect(refused.reason).toContain(`finding f-1 is already ${status}`);
				expect(refused.reason).toContain("the operator's decision, not pired-verify's");
				expect(refused.reason).toContain("Record status=suspected on it with your grounds in 'basis' or 'control'");
			}
			expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "suspected", basis: ["src/export.ts:12"] } })).toEqual({ allow: true });
			expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "suspected", control: "401 without a session" } })).toEqual({ allow: true });
		}
		// `open` is where a finding stood before anyone checked it: a verdict on it is the verifier's.
		const open = worker("pired-verify", 1, ledgerOf([findingRow({ status: "open" })]));
		expect(await open.check({ name: "record", args: { kind: "finding", id: "f-1", status: "refuted", basis: ["src/export.ts:12"] } })).toEqual({ allow: true });
	});

	/**
	 * The round-three review probe: status=suspected with only a 'reason' passed
	 * the gate, and the record tool reads a look that settled nothing only from a
	 * basis or a control case, so it wrote the status as a plain edit and moved
	 * reported, confirmed and refuted findings back to suspected.
	 */
	it("refuses a verifier's status=suspected whose grounds are only a reason, or blank, on a reported, confirmed or refuted finding", async () => {
		for (const status of ["reported", "confirmed", "refuted"] as const) {
			const guard = worker("pired-verify", 1, ledgerOf([findingRow({ status })]));
			for (const args of [
				{ kind: "finding", id: "f-1", status: "suspected", reason: "read the handler; could not settle it" },
				{ kind: "finding", id: "f-1", status: "suspected" },
				{ kind: "finding", id: "f-1", status: "suspected", basis: "   ", reason: "looked" },
				{ kind: "finding", id: "f-1", status: "suspected", basis: ["", "  "], control: "  " },
				{ kind: "finding", id: "f-1", status: "suspected", basis: [42] },
			]) {
				const refused = await guard.check({ name: "record", args });
				expect(refused.allow).toBe(false);
				expect(refused.reason).toContain("status=suspected needs what you checked in 'basis' (file:line or an evidence path) or 'control'");
				expect(refused.reason).toContain("A 'reason' alone is a note");
				expect(refused.reason).toContain("it would move the status back to suspected with nothing behind it");
			}
			// A real basis, as a string or among blanks, or a control case, is a look.
			for (const grounds of [{ basis: "src/export.ts:40" }, { basis: ["", "evidence/f-1-look.txt"] }, { control: "401 without a session" }]) {
				expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "suspected", ...grounds, reason: "could not reach the sink" } })).toEqual({ allow: true });
			}
		}
	});

	/**
	 * A by-id write with no status is a last-write-wins edit of whatever it
	 * carries — the stored reason replaced, nothing judged — and leaves no verdict
	 * for the report to read.
	 */
	it("refuses a verifier's by-id finding write that names no status, since its write there is its verdict", async () => {
		const guard = worker("pired-verify", 1, ledgerOf([findingRow({ status: "confirmed" })]));
		for (const args of [
			{ kind: "finding", id: "f-1", reason: "the handler looks fine to me" },
			{ kind: "finding", id: "f-1", status: "", basis: ["src/export.ts:40"] },
			{ kind: "finding", id: "f-1", control: "401 without a session", live: true },
		]) {
			const refused = await guard.check({ name: "record", args });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("pired-verify's write on a finding is its verdict, and this one names no status");
			expect(refused.reason).toContain("A verifier records a verdict, not a rewrite");
		}
	});

	/**
	 * A finding linked to a hypothesis the ledger still holds refuted or proposed
	 * says the reasoning was overturned while the coverage matrix says it stands.
	 */
	it("refuses a verifier's linked create until its hypothesis is recorded confirmed, naming the outcome and the order", async () => {
		const outcomes = HYPOTHESIS_OUTCOMES.filter((o) => o !== "confirmed");
		expect(outcomes).toEqual(expect.arrayContaining(["proposed", "refuted"]));
		for (const outcome of outcomes) {
			const guard = worker("pired-verify", 1, ledgerOf([], [hypothesisRow({ outcome })]));
			const refused = await guard.check({ name: "record", args: { kind: "finding", hypothesisId: "h-7", title: "Export CSV includes other tenants' totals", severity: "high", target: "src/export.ts:88" } });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain(`hypothesis h-7 is recorded ${outcome}, not confirmed`);
			expect(refused.reason).toContain('First record kind=hypothesis id=h-7 outcome=confirmed statement="what holds" basis=[...]');
			expect(refused.reason).toContain("then record this finding with hypothesisId=h-7");
		}
	});

	/**
	 * In a source-only review there is no running target, and on the 2026-09-24
	 * grid 17 of 18 verification records asserted live=true on such scopes; the
	 * refusal said "'basis' and 'live'" as if both were always owed. And it named
	 * no verdict for a finding the verifier could not settle.
	 */
	it("tells a refused verifier that 'live' is for a running target, and that status=suspected with what it checked is a verdict too", async () => {
		const refused = await worker("pired-verify").check({ name: "record", args: { kind: "finding", id: "f-1", status: "refuted", title: "x" } });
		expect(refused.reason).toContain("status=refuted with 'basis' (and 'live' only when you tested a running target)");
		expect(refused.reason).toContain("or status=suspected with what you checked in 'basis' or 'control' when you could not settle it");
	});

	it("leaves a verifier's hypothesis re-record alone, because id plus basis is the verification path", async () => {
		const guard = worker("pired-verify");
		const recheck = { kind: "hypothesis", id: "h-1", outcome: "refuted", basis: ["src/upload.ts:88"], live: false, approach: "read the sink" };
		expect(await guard.check({ name: "record", args: recheck })).toEqual({ allow: true });
	});

	/**
	 * In the v4 grid a pass-2 pired-scout recorded 3 findings: breadth guesses
	 * nobody traced, entered straight into the findings list instead of the
	 * coverage matrix where a hypothesis would have been settled.
	 */
	it("refuses a scout's finding and points it at a proposed hypothesis, while its hypothesis goes through", async () => {
		const guard = worker("pired-scout");
		const refused = await guard.check({ name: "record", args: { kind: "finding", title: "t", severity: "medium", description: "d" } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("kind=hypothesis outcome=proposed");
		expect((await guard.check({ name: "record", args: { kind: "finding", id: "f-1", status: "confirmed" } })).allow).toBe(false);
		expect(await guard.check({ name: "record", args: { kind: "hypothesis", target: "e-1", class: "c-1", outcome: "proposed" } })).toEqual({ allow: true });
		expect(await guard.check({ name: "record", args: { kind: "endpoint", method: "GET", path: "/x", file: "src/r.ts" } })).toEqual({ allow: true });
	});

	it("lets an investigator and an escalator record and rewrite findings", async () => {
		const finding = { kind: "finding", title: "t", severity: "high", description: "d", locations: ["src/a.ts:3"] };
		for (const name of ["pired-investigate", "pired-escalate"]) {
			const guard = worker(name);
			expect(await guard.check({ name: "record", args: finding })).toEqual({ allow: true });
			expect(await guard.check({ name: "record", args: { ...finding, id: "f-1" } })).toEqual({ allow: true });
		}
	});

	it("applies no role rule to a worker it could not identify, or to args that are not an object", async () => {
		// Role rules keep the ledger honest; containment is the scope gate's, and
		// that applies whatever the role. Malformed args are the record tool's to reject.
		const guard = createChildGuard();
		guard.arm(scope());
		guard.turnStarted();
		expect(await guard.check({ name: "record", args: { kind: "finding", title: "t" } })).toEqual({ allow: true });
		const verifier = worker("pired-verify");
		expect(await verifier.check({ name: "record", args: "kind=finding" })).toEqual({ allow: true });
		expect(await verifier.check({ name: "record", args: undefined })).toEqual({ allow: true });
	});
});

describe("the recording reserve", () => {
	/**
	 * The shipped regression: in the v4 grid a pired-investigate used all 26 of
	 * its turns and wrote no record, and four more runs had a pired-verify child
	 * that made no durable record. Its handoff is all the parent gets back, and
	 * a handoff is not the ledger.
	 */
	it("holds a silent worker's last turns for record and recall, and lets it carry on once it has recorded", async () => {
		const investigate = agent("pired-investigate");
		const guard = worker("pired-investigate", investigate.maxTurns - RECORD_RESERVE_TURNS);
		expect(await guard.check({ name: "bash", args: { command: "ls" } })).toEqual({ allow: true });

		guard.turnStarted();
		const refused = await guard.check({ name: "bash", args: { command: "ls" } });
		expect(refused).toMatchObject({ allow: false });
		expect(refused.terminate).toBeUndefined();
		expect(refused.reason).toContain(`pired-investigate has ${RECORD_RESERVE_TURNS - 1} turns left after this one and has recorded nothing to the shared ledger`);
		expect(refused.reason).toContain("inconclusive is a valid outcome");
		expect(refused.reason).toContain("then carry on");
		// A way out, so the reserve never pushes a worker into recording filler.
		expect(refused.reason).toContain("If you established nothing worth recording, hand back and say so.");
		expect((await guard.check({ name: "read", args: { path: "a.ts" } })).allow).toBe(false);
		expect(await guard.check({ name: "record", args: { kind: "hypothesis", target: "e-1", class: "c-1", outcome: "inconclusive" } })).toEqual({ allow: true });
		expect(await guard.check({ name: "recall", args: { what: "hypotheses" } })).toEqual({ allow: true });

		guard.recorded("hypotheses");
		expect(guard.status.records).toBe(1);
		expect(await guard.check({ name: "bash", args: { command: "ls" } })).toEqual({ allow: true });
	});

	it("is exactly RECORD_RESERVE_TURNS turns long, the budget's last one included", async () => {
		const scout = agent("pired-scout");
		const guard = worker("pired-scout", scout.maxTurns - RECORD_RESERVE_TURNS);
		let held = 0;
		for (let turn = guard.status.turns; turn <= scout.maxTurns; turn++) {
			if (!(await guard.check({ name: "read", args: {} })).allow) held += 1;
			guard.turnStarted();
		}
		expect(held).toBe(RECORD_RESERVE_TURNS);
	});

	/**
	 * A verifier's product is its verdict. Counting any ledger row released the
	 * reserve for a verifier that had noted an endpoint or parked a blocker while
	 * its verdict was still only in its handoff.
	 */
	it("counts only a verifier's findings and hypotheses writes, and any ledger row for the other roles", async () => {
		const verify = agent("pired-verify");
		const guard = worker("pired-verify", verify.maxTurns - 1);
		guard.recorded("inventory");
		guard.recorded("blockers");
		expect(guard.status.records).toBe(0);
		// It has a row on the ledger; what it has not recorded is its verdict.
		expect((await guard.check({ name: "bash", args: { command: "ls" } })).reason).toContain("has recorded no verdict");
		guard.recorded("findings");
		expect(guard.status.records).toBe(1);
		expect(await guard.check({ name: "bash", args: { command: "ls" } })).toEqual({ allow: true });

		const investigate = worker("pired-investigate");
		investigate.recorded("inventory");
		expect(investigate.status.records).toBe(1);
	});

	it("decides what a write counts for by the role it learns, even when the write came first", () => {
		const guard = createChildGuard();
		guard.arm(scope());
		guard.recorded("inventory");
		expect(guard.status.records).toBe(1);
		guard.identify(agentMarker("pired-verify"));
		expect(guard.status.records).toBe(0);
		expect(guard.settleCheck("completed")).toContain("your verdict on the record named in your task");
	});

	it("never fires for a worker that has already recorded something", async () => {
		const verify = agent("pired-verify");
		const guard = worker("pired-verify");
		guard.recorded("findings");
		for (let i = 1; i < verify.maxTurns; i++) guard.turnStarted();
		expect(guard.status.turns).toBe(verify.maxTurns);
		expect(await guard.check({ name: "bash", args: { command: "ls" } })).toEqual({ allow: true });
	});

	it("counts the last turn down to zero left and says to hand back, still refusing rather than ending the run", async () => {
		const scout = agent("pired-scout");
		const guard = worker("pired-scout", scout.maxTurns - 1);
		const next = await guard.check({ name: "read", args: {} });
		expect(next.reason).toContain("has 1 turn left after this one");
		expect(next.reason).toContain("then carry on");
		guard.turnStarted();
		const last = await guard.check({ name: "read", args: {} });
		expect(last.reason).toContain("has 0 turns left after this one");
		expect(last.reason).toContain("then hand back");
		expect(last.reason).not.toContain("carry on");
		expect(last.terminate).toBeUndefined();
	});

	it("tells a scout in its reserve to record surface and proposals, not the findings it may not write", async () => {
		const scout = agent("pired-scout");
		const refused = await worker("pired-scout", scout.maxTurns - RECORD_RESERVE_TURNS + 1).check({ name: "grep", args: { pattern: "x" } });
		expect(refused.reason).toContain("hypotheses as proposed");
		expect(refused.reason).not.toContain("findings");
	});

	/**
	 * In the 2026-09-24 grid 10 of 15 verify tasks that said "do not change
	 * status" left no verdict on any row. A verifier's durable product is the
	 * verdict on the record it was sent to check, and an unsettled one is still
	 * worth writing.
	 */
	it("tells a verifier in its reserve to record its verdict by id, an unsettled one included", async () => {
		const verify = agent("pired-verify");
		const refused = await worker("pired-verify", verify.maxTurns - 1).check({ name: "bash", args: { command: "ls" } });
		expect(refused.reason).toContain("pired-verify has 1 turn left after this one and has recorded no verdict to the shared ledger");
		expect(refused.reason).toContain("your verdict on the record named in your task, by its id");
		expect(refused.reason).toContain("status=suspected (finding) with what you checked in 'basis' (file:line or evidence path) or 'control', or outcome=inconclusive (hypothesis)");
		// The gate refuses a status=suspected whose only grounds are a reason, so
		// the reserve must not ask for one.
		expect(refused.reason).toContain("what is missing in 'statement' and what you checked in 'basis'; 'reason' is commentary");
		expect(refused.reason).not.toContain("what you checked in 'reason'");
	});

	it("leaves the over-budget hand-back in charge once a silent worker is past its budget", async () => {
		const verify = agent("pired-verify");
		const guard = worker("pired-verify", verify.maxTurns + 1);
		const refused = await guard.check({ name: "bash", args: { command: "ls" } });
		expect(refused.reason).toContain(`pired-verify has used its ${verify.maxTurns}-turn budget`);
		expect(refused.reason).not.toContain("recorded nothing");
		expect(await guard.check({ name: "record", args: { kind: "note", text: "x" } })).toEqual({ allow: true });
	});
});

describe("the reminder before a worker hands back", () => {
	/**
	 * The shipped regression: 4 of 6 gpt-6-luna pired-verify children that
	 * recorded nothing handed back early — turns 7, 7, 11 and 12 of 16 — stating
	 * a verdict that was never written. The reserve never fires that early.
	 */
	it("reminds a worker handing back with nothing recorded, once, and says why its handoff is not enough", () => {
		const guard = worker("pired-verify", 7);
		const reminder = guard.settleCheck("completed");
		expect(reminder).toContain("have recorded no verdict from this run on the shared ledger");
		expect(reminder).toContain("summarise away");
		expect(reminder).toContain("your verdict on the record named in your task, by its id");
		expect(reminder).toContain("what you checked in 'basis'; 'reason' is commentary. Then hand back again");
		expect(reminder).toContain("hand back again with your full handoff");
		expect(guard.status.reminded).toBe(true);
		// A worker that answers with another hand-back is let go: no loop.
		expect(guard.settleCheck("completed")).toBeUndefined();
		guard.turnStarted();
		expect(guard.settleCheck("completed")).toBeUndefined();
	});

	it("does not remind a worker that recorded something, an unarmed one, or a run that was stopped or failed", () => {
		const recorded = worker("pired-scout", 4);
		recorded.recorded("inventory");
		expect(recorded.settleCheck("completed")).toBeUndefined();

		const unarmed = createChildGuard();
		unarmed.identify(agentMarker("pired-scout"));
		expect(unarmed.settleCheck("completed")).toBeUndefined();

		const stopped = worker("pired-scout", 4);
		expect(stopped.settleCheck("aborted")).toBeUndefined();
		expect(stopped.settleCheck("error")).toBeUndefined();
		// Neither spent the one reminder.
		expect(stopped.status.reminded).toBe(false);
		const reminder = stopped.settleCheck(undefined);
		expect(reminder).toContain("the surface you mapped");
		expect(reminder).toContain("handing back with nothing from this run on the shared ledger");
	});

	it("reminds a worker at its budget, whose next turn the ledger stays open for, but not one past the grace turns", () => {
		const investigate = agent("pired-investigate");
		const atBudget = worker("pired-investigate", investigate.maxTurns);
		expect(atBudget.settleCheck("completed")).toContain("inconclusive is a valid outcome");

		const lastGrace = worker("pired-investigate", investigate.maxTurns + HANDOFF_GRACE_TURNS - 1);
		expect(lastGrace.settleCheck("completed")).toBeDefined();

		// The request the reminder buys would be past the grace, where a record call ends the run.
		const spent = worker("pired-investigate", investigate.maxTurns + HANDOFF_GRACE_TURNS);
		expect(spent.settleCheck("completed")).toBeUndefined();
	});
});

describe("who may settle a finding (3.1)", () => {
	it("refuses an investigator's status=confirmed and says an independent verifier promotes it", async () => {
		for (const name of ["pired-investigate", "pired-escalate"]) {
			const guard = worker(name);
			for (const status of ["confirmed", "refuted"]) {
				const refused = await guard.check({ name: "record", args: { kind: "finding", title: "SQLi in search", severity: "high", target: "app/search.py:21", status, control: "ran it" } });
				expect(refused.allow).toBe(false);
				expect(refused.reason).toContain(`status=${status} is for an independent verifier (pired-verify`);
				expect(refused.reason).toContain("it lands suspected");
			}
		}
	});

	it("refuses an investigator the operator's dispositions too, so its findings land suspected", async () => {
		const guard = worker("pired-investigate");
		const refused = await guard.check({ name: "record", args: { kind: "finding", title: "t", severity: "low", target: "a.py:1", status: "false-positive" } });
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain("operator's disposition");
		expect([...FINDER_STATUSES].sort()).toEqual(["open", "suspected"]);
		// Suspected, or no status at all, is how a finding starts.
		for (const args of [
			{ kind: "finding", title: "t", severity: "low", target: "a.py:1", status: "suspected" },
			{ kind: "finding", title: "t", severity: "low", target: "a.py:1" },
		]) expect(await guard.check({ name: "record", args })).toEqual({ allow: true });
	});

	it("keeps an investigator off another author's finding by id, and lets it edit its own", async () => {
		const ledger = ledgerOf([
			findingRow({ id: "f-mine", by: "pired-investigate" }),
			findingRow({ id: "f-lead", by: "lead" }),
			findingRow({ id: "f-old" }),
		]);
		const guard = worker("pired-investigate", 1, ledger);
		const theirs = await guard.check({ name: "record", args: { kind: "finding", id: "f-lead", description: "the handler also leaks the total" } });
		expect(theirs.allow).toBe(false);
		expect(theirs.reason).toContain("finding f-lead was recorded by lead, not pired-investigate");
		expect(theirs.reason).toContain("record it again without an id");
		const unknown = await guard.check({ name: "record", args: { kind: "finding", id: "f-old", description: "more" } });
		expect(unknown.reason).toContain("no author on the row");
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-mine", description: "a second sink at line 52" } })).toEqual({ allow: true });
		// A create that would merge into the lead's finding is still allowed: that is how a second location arrives.
		expect(await guard.check({ name: "record", args: { kind: "finding", title: "Missing owner check on invoice export", severity: "medium", target: "src/export.ts:52" } })).toEqual({ allow: true });
		// An id nobody recorded is not someone else's finding.
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-none", description: "x" } })).toEqual({ allow: true });
	});

	it("refuses kind=settle from every worker, a verifier and an unnamed one included", async () => {
		for (const name of ["pired-scout", "pired-investigate", "pired-verify", "pired-escalate"]) {
			const refused = await worker(name).check({ name: "record", args: { kind: "settle", outcome: "finished" } });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("does not settle the session");
		}
		const unnamed = createChildGuard();
		unnamed.arm(scope());
		unnamed.turnStarted();
		expect((await unnamed.check({ name: "record", args: { kind: "settle", outcome: "paused" } })).reason).toContain("a worker does not settle the session");
	});
});

describe("a finder cannot undo the check it could not make (3.1 review)", () => {
	const settled = findingRow({ id: "f-mine", by: "pired-investigate", status: "confirmed", verification: { verdict: "stands", at: AT, by: "pired-verify", control: "ran it" } });

	it("refuses its status and claim fields by id once a verification settled its finding, a second launch of the same worker included", async () => {
		const guard = worker("pired-investigate", 1, ledgerOf([settled]));
		for (const args of [
			{ kind: "finding", id: "f-mine", status: "suspected" },
			{ kind: "finding", id: "f-mine", target: "src/other.ts:9" },
			{ kind: "finding", id: "f-mine", title: "Not a bug after all", description: "d", severity: "low" },
		]) {
			const refused = await guard.check({ name: "record", args });
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("has been verified by pired-verify, and its finder may not change");
		}
		// The write-up is still the finder's to add.
		expect(await guard.check({ name: "record", args: { kind: "finding", id: "f-mine", impact: "every tenant's invoices", remediation: "check the owner" } })).toEqual({ allow: true });
		// A refutation locks it the same way.
		const refuted = worker("pired-investigate", 1, ledgerOf([{ ...settled, status: "refuted", verification: { verdict: "refuted", at: AT } }]));
		expect((await refuted.check({ name: "record", args: { kind: "finding", id: "f-mine", status: "suspected" } })).reason).toContain("has been refuted, and its finder");
		// An unresolved look settles nothing, so it locks nothing.
		const looked = worker("pired-investigate", 1, ledgerOf([{ ...settled, status: "suspected", verification: { verdict: "unresolved", at: AT } }]));
		expect(await looked.check({ name: "record", args: { kind: "finding", id: "f-mine", description: "a second sink" } })).toEqual({ allow: true });
	});

	it("holds a worker whose role could not be read to the finder's rules", async () => {
		const guard = createChildGuard();
		guard.arm(scope(), ledgerOf([findingRow({ id: "f-lead", by: "lead" }), { ...settled, id: "f-w", by: "worker" }]));
		guard.turnStarted();
		const confirm = await guard.check({ name: "record", args: { kind: "finding", title: "t", severity: "high", target: "a.py:1", status: "confirmed", control: "c" } });
		expect(confirm.allow).toBe(false);
		expect(confirm.reason).toContain("pired: worker records findings and does not settle them");
		expect((await guard.check({ name: "record", args: { kind: "finding", id: "f-lead", description: "x" } })).reason).toContain("not worker");
		expect((await guard.check({ name: "record", args: { kind: "finding", id: "f-w", status: "suspected" } })).reason).toContain("its finder may not change 'status'");
		expect(await guard.check({ name: "record", args: { kind: "finding", title: "t", severity: "high", target: "a.py:1" } })).toEqual({ allow: true });
	});
});

/**
 * The record tool reads a call without `kind` by its fields or its id
 * (ADR-040). Judged raw, the same call was "not a finding" to the gate and a
 * finding to the tool: a finder could confirm its own claim by leaving the
 * kind out.
 */
describe("the gate judges a record call as the tool will read it (ADR-040)", () => {
	const settled = findingRow({ id: "f-mine", by: "pired-investigate", status: "confirmed", verification: { verdict: "stands", at: AT, by: "pired-verify", control: "ran it" } });

	it("refuses a finder's verdict sent without kind, by id or by the fields of a new finding", async () => {
		const guard = worker("pired-investigate", 1, ledgerOf([settled]));
		expect((await guard.check({ name: "record", args: { id: "f-mine", status: "suspected" } })).reason)
			.toContain("has been verified by pired-verify, and its finder may not change");
		const fresh = await guard.check({ name: "record", args: { title: "t", severity: "high", target: "a.py:1", status: "confirmed", control: "c" } });
		expect(fresh.allow).toBe(false);
		expect(fresh.reason).toContain("records findings and does not settle them");
		expect((await guard.check({ name: "record", args: { kind: "Finding", id: "f-mine", status: "suspected" } })).allow).toBe(false);
	});

	it("still lets a call through that the tool will refuse anyway, or that is not a finding", async () => {
		const guard = worker("pired-investigate", 1, ledgerOf([settled]));
		expect(await guard.check({ name: "record", args: { title: "t", statement: "s" } })).toEqual({ allow: true });
		expect(await guard.check({ name: "record", args: { statement: "s", target: "e1", class: "authz", outcome: "proposed" } })).toEqual({ allow: true });
	});

	it("refuses, rather than guesses at, a call it can read only through a ledger it cannot read", async () => {
		const failing = async (): Promise<never> => {
			throw new Error("EIO: findings.jsonl");
		};
		const broken = worker("pired-investigate", 1, { findings: failing, hypotheses: failing });
		expect((await broken.check({ name: "record", args: { kind: "finding", handle: "f-mine", status: "suspected" } })).reason)
			.toContain("could not read the shared ledger to check this record call");
	});
});
