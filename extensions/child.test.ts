import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CHILD_EXTENSION_ID, EXTENSION_ACK_EVENT, HANDOFF_GRACE_TURNS, publishParentScope, RECORD_RESERVE_TURNS,
	SUPERVISOR_SECTION_END, SUPERVISOR_SECTION_START,
} from "../core/child.ts";
import type { EngagementScope, FindingRecord, HypothesisRecord } from "../core/ontology.ts";
import { createScopeGate } from "../core/scope.ts";
import { agentMarker, PIRED_AGENTS } from "../core/subagents.ts";
import { Workspace } from "../core/workspace.ts";
import piredChild, { SETTLE_REMINDER_TYPE } from "./child.ts";
import { makeHostServices } from "./lib/host.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function scope(workspace: string): EngagementScope {
	return {
		v: 1, engagement: "child-test", authorized: true, mode: "enforce", workspace,
		targets: { domains: ["app.child-test.test"] }, maxAgents: 8,
	};
}

// ---------------------------------------------------------------------------
// The wiring, against a stand-in for pi's extension API
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type RegisteredTool = { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<unknown> };

/** Only the surface extensions/child.ts touches. Anything else it reached for would throw. */
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const tools: RegisteredTool[] = [];
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		events: {
			emit(event: string, payload: unknown) {
				emitted.push({ event, payload });
			},
			on() {
				return () => {};
			},
		},
	};
	piredChild(pi as unknown as ExtensionAPI);
	const fire = async (event: string, payload: unknown, ctx: unknown): Promise<unknown[]> => {
		const out: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx));
		return out;
	};
	return { tools, emitted, fire };
}

function ctxFor(cwd: string, systemPrompt: string | (() => string)) {
	return { cwd, getSystemPrompt: typeof systemPrompt === "function" ? systemPrompt : () => systemPrompt };
}

async function toolCall(fire: ReturnType<typeof fakePi>["fire"], ctx: unknown, toolName: string, input: unknown) {
	const [result] = await fire("tool_call", { type: "tool_call", toolCallId: "t1", toolName, input }, ctx);
	return result as { block: true; reason?: string; terminate?: true } | undefined;
}

describe("pired child extension wiring", () => {
	let root: string;
	let savedWorkspace: string | undefined;
	let withdraw: (() => void) | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pired-child-"));
		savedWorkspace = process.env.PIRED_WORKSPACE;
	});
	afterEach(() => {
		withdraw?.();
		withdraw = undefined;
		if (savedWorkspace === undefined) delete process.env.PIRED_WORKSPACE;
		else process.env.PIRED_WORKSPACE = savedWorkspace;
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * What a parent pired session leaves behind: a workspace, its informational
	 * scope.json, PIRED_WORKSPACE, and — unless `publish` is false — its scope
	 * published on globalThis, where the child really reads it.
	 */
	async function parentSession(publish = true): Promise<{ ws: string; scopeBytes: string }> {
		const ws = join(root, "ws");
		const workspace = await Workspace.open(ws, "child-test", makeHostServices());
		await workspace.writeScope(scope(ws));
		if (publish) withdraw = publishParentScope(globalThis, ws, scope(ws));
		process.env.PIRED_WORKSPACE = ws;
		return { ws, scopeBytes: readFileSync(join(ws, "scope.json"), "utf8") };
	}

	/** Rows the parent's investigator left on the ledger, written the way the record tool stores them. */
	async function seedLedger(ws: string, findings: FindingRecord[], hypotheses: HypothesisRecord[] = []): Promise<void> {
		const workspace = new Workspace(ws, makeHostServices());
		await workspace.upsert("findings", () => findings);
		if (hypotheses.length) await workspace.upsert("hypotheses", () => hypotheses);
	}

	const AT = "2026-09-24T00:00:00.000Z";
	const finding = (over: Partial<FindingRecord> = {}): FindingRecord => ({
		v: 1, id: "f-1", kind: "finding", createdAt: AT, title: "Missing owner check on invoice export", severity: "medium",
		target: "src/export.ts:40", description: "No owner check.", status: "suspected", ...over,
	});
	const hypothesis: HypothesisRecord = {
		v: 1, id: "h-7", kind: "hypothesis", createdAt: AT, statement: "the router's owner check runs before the export handler",
		target: "e-1", class: "idor", outcome: "refuted",
	};

	it("refuses to start without the parent's workspace, creates none, and blocks every tool", async () => {
		delete process.env.PIRED_WORKSPACE;
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await expect(fire("session_start", { type: "session_start", reason: "startup" }, ctx)).rejects.toThrow(/PIRED_WORKSPACE is not set/);
		expect(tools).toEqual([]);
		expect(emitted).toEqual([]);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toMatchObject({ block: true, reason: expect.stringContaining("not armed") });
	});

	it("refuses a PIRED_WORKSPACE that no parent session made, and leaves the directory empty", async () => {
		// Workspace.open would have written a manifest here and the worker would
		// have recorded into a ledger no panel ever reads.
		const stray = join(root, "stray");
		mkdirSync(stray);
		process.env.PIRED_WORKSPACE = stray;
		const { tools, fire } = fakePi();
		await expect(fire("session_start", {}, ctxFor(root, ""))).rejects.toThrow(/manifest\.json is missing/);
		expect(tools).toEqual([]);
		expect(existsSync(join(stray, "manifest.json"))).toBe(false);
	});

	it("refuses to arm when no parent in this process published a scope, though scope.json is on disk", async () => {
		await parentSession(false);
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await expect(fire("session_start", {}, ctx)).rejects.toThrow(/published a scope/);
		expect(tools).toEqual([]);
		expect(emitted).toEqual([]);
		expect(await toolCall(fire, ctx, "bash", { command: "ls" })).toMatchObject({ block: true, reason: expect.stringContaining("not armed") });
	});

	/**
	 * The shipped gap: each worker built its gate from <workspace>/scope.json,
	 * which the parent's own `write` or an earlier worker's bash could rewrite,
	 * re-arming every later worker while the parent's gate stayed as it was.
	 */
	it("keeps the parent's gate when scope.json has been rewritten to switch it off", async () => {
		const { ws } = await parentSession();
		writeFileSync(join(ws, "scope.json"), JSON.stringify({ ...scope(ws), mode: "off", targets: { domains: ["outside.child-test.example"] } }));
		const { fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await fire("session_start", {}, ctx);
		const blocked = await toolCall(fire, ctx, "bash", { command: "curl -s http://outside.child-test.example/" });
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("outside.child-test.example") });
	});

	it("arms on the parent's workspace with record and recall only, and acknowledges only once armed", async () => {
		const { ws, scopeBytes } = await parentSession();
		const envBefore = { ...process.env };
		const { tools, emitted, fire } = fakePi();
		const ctx = ctxFor(root, `${agentMarker("pired-scout")}\n\nworker`);
		await fire("session_start", { type: "session_start", reason: "startup" }, ctx);

		expect(tools.map((t) => t.name).sort()).toEqual(["recall", "record"]);
		expect(emitted).toEqual([{ event: EXTENSION_ACK_EVENT, payload: { id: CHILD_EXTENSION_ID } }]);

		const record = tools.find((t) => t.name === "record");
		await record?.execute("t0", { kind: "endpoint", method: "GET", path: "/wired", file: "src/app.ts" }, undefined, undefined, { cwd: root });
		const rows = readFileSync(join(ws, "inventory.jsonl"), "utf8");
		expect(rows).toContain('"path":"/wired"');

		// The child shares the parent's process: an env write here would be one
		// in the parent's shell too, and scope.json is the parent's to write.
		expect(process.env).toEqual(envBefore);
		expect(readFileSync(join(ws, "scope.json"), "utf8")).toBe(scopeBytes);
	});

	it("blocks out-of-scope bash with pired's own reason and refuses delegation and the supervisor channel", async () => {
		const { ws } = await parentSession();
		const { fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-investigate"));
		await fire("session_start", {}, ctx);

		const command = "curl --version http://outside.child-test.example/";
		const expected = await createScopeGate(scope(ws))({ name: "bash", args: { command } });
		expect(await toolCall(fire, ctx, "bash", { command })).toEqual({ block: true, reason: expected.reason });
		expect(await toolCall(fire, ctx, "bash", { command: "ls src" })).toBeUndefined();
		for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor"]) {
			expect(await toolCall(fire, ctx, name, { agent: "pired-scout", task: "nested", reason: "need_decision", message: "?" })).toMatchObject({ block: true });
		}
	});

	it("tells a worker to hand back at its role's turn budget, keeps the ledger open for the grace turns, then ends the run", async () => {
		const { ws } = await parentSession();
		const { fire, tools } = fakePi();
		const scout = PIRED_AGENTS.find((a) => a.name === "pired-scout");
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await fire("session_start", {}, ctx);
		// Something on the ledger, so the recording reserve stays out of this.
		await tools.find((t) => t.name === "record")?.execute("r1", { kind: "host", value: "app.child-test.test" }, undefined, undefined, { cwd: root });
		for (let i = 0; i < (scout?.maxTurns ?? 0); i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toBeUndefined();

		await fire("turn_start", { type: "turn_start" }, ctx);
		const handBack = await toolCall(fire, ctx, "read", { path: "a.ts" });
		expect(handBack?.reason).toContain("pired-scout has used its 20-turn budget");
		expect(handBack?.reason).toContain("The ledger is still open");
		expect(handBack?.terminate).toBeUndefined();
		// The grace turns are the ledger's: a record there is written, not refused.
		const late = { kind: "endpoint", method: "GET", path: "/late", file: "src/app.ts" };
		expect(await toolCall(fire, ctx, "record", late)).toBeUndefined();
		await tools.find((t) => t.name === "record")?.execute("r2", late, undefined, undefined, { cwd: root });
		expect(readFileSync(join(ws, "inventory.jsonl"), "utf8")).toContain('"path":"/late"');

		for (let i = 0; i < HANDOFF_GRACE_TURNS; i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect(await toolCall(fire, ctx, "read", { path: "a.ts" })).toMatchObject({ block: true, terminate: true });
		expect(await toolCall(fire, ctx, "record", late)).toMatchObject({ block: true, terminate: true });
	});

	it("keeps the recording reserve in force after a record that throws, and lifts it after one that resolves", async () => {
		// A write that threw put nothing on the ledger; counting it would release
		// the reserve for a worker whose work is still nowhere durable.
		await parentSession();
		const { fire, tools } = fakePi();
		const scout = PIRED_AGENTS.find((a) => a.name === "pired-scout");
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await fire("session_start", {}, ctx);
		for (let i = 0; i < (scout?.maxTurns ?? 0) - RECORD_RESERVE_TURNS + 1; i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect(await toolCall(fire, ctx, "bash", { command: "ls" })).toMatchObject({ block: true, reason: expect.stringContaining("has recorded nothing to the shared ledger") });

		const record = tools.find((t) => t.name === "record");
		await expect(record?.execute("r1", { kind: "evidence" }, undefined, undefined, { cwd: root })).rejects.toThrow(/'name' is required/);
		expect(await toolCall(fire, ctx, "bash", { command: "ls" })).toMatchObject({ block: true, reason: expect.stringContaining("has recorded nothing") });

		await record?.execute("r2", { kind: "host", value: "app.child-test.test" }, undefined, undefined, { cwd: root });
		expect(await toolCall(fire, ctx, "bash", { command: "ls" })).toBeUndefined();
	});

	/**
	 * Every record call that resolved used to count, so a verifier that saved an
	 * evidence file — a file, not a ledger row — was let out of the reserve and
	 * past the settle reminder with its verdict still only in its handoff.
	 */
	it("keeps a verifier's reserve and settle reminder after an evidence file or a note, and lifts both with its verdict", async () => {
		const { ws } = await parentSession();
		await seedLedger(ws, [finding()]);
		const verify = PIRED_AGENTS.find((a) => a.name === "pired-verify");
		const ctx = ctxFor(root, agentMarker("pired-verify"));
		const evidence = { kind: "evidence", name: "f-1-refute.txt", content: "router.ts:12 requireOwner(invoice)" };
		const note = { kind: "note", text: "The router checks the owner before the export handler runs." };
		const verdict = { kind: "finding", id: "f-1", status: "refuted", basis: ["src/router.ts:12", "evidence/f-1-refute.txt"], reason: "the owner check runs first" };
		// Fresh args per call, as pi sends them: the record tool writes its verdict onto the object it is given.
		const run = async (pi: ReturnType<typeof fakePi>, id: string, args: Record<string, unknown>) => {
			expect(await toolCall(pi.fire, ctx, "record", { ...args })).toBeUndefined();
			await pi.tools.find((t) => t.name === "record")?.execute(id, { ...args }, undefined, undefined, { cwd: root });
		};

		const reserve = fakePi();
		await reserve.fire("session_start", {}, ctx);
		for (let i = 0; i < (verify?.maxTurns ?? 0) - RECORD_RESERVE_TURNS + 1; i++) await reserve.fire("turn_start", { type: "turn_start" }, ctx);
		await run(reserve, "e1", evidence);
		await run(reserve, "n1", note);
		expect(await toolCall(reserve.fire, ctx, "bash", { command: "ls" })).toMatchObject({ block: true, reason: expect.stringContaining("has recorded no verdict") });
		await run(reserve, "v1", verdict);
		expect(await toolCall(reserve.fire, ctx, "bash", { command: "ls" })).toBeUndefined();

		const settle = { type: "agent_before_settle", outcome: "completed", entries: [], continue: false };
		const early = fakePi();
		await early.fire("session_start", {}, ctx);
		for (let i = 0; i < 7; i++) await early.fire("turn_start", { type: "turn_start" }, ctx);
		await run(early, "e2", evidence);
		const [reminded] = await early.fire("agent_before_settle", settle, ctx) as Array<{ continue?: boolean } | undefined>;
		expect(reminded?.continue).toBe(true);

		const settled = fakePi();
		await settled.fire("session_start", {}, ctx);
		for (let i = 0; i < 7; i++) await settled.fire("turn_start", { type: "turn_start" }, ctx);
		await run(settled, "e3", evidence);
		await run(settled, "v3", verdict);
		expect(await settled.fire("agent_before_settle", settle, ctx)).toEqual([undefined]);
	});

	/**
	 * The review probe: the finding under check sent back as a new one with
	 * hypothesisId 'h-any' passed the gate, and the record tool merged it into
	 * the existing finding. The gate needs the parent's ledger to see either.
	 */
	it("checks a verifier's finding writes against the parent's ledger", async () => {
		const { ws } = await parentSession();
		await seedLedger(ws, [finding(), finding({ id: "f-2", title: "Verbose stack traces", target: "src/errors.ts:3", status: "reported" })], [hypothesis]);
		const { fire, tools } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-verify"));
		await fire("session_start", {}, ctx);
		await fire("turn_start", { type: "turn_start" }, ctx);

		const probe = { kind: "finding", hypothesisId: "h-any", title: "Missing owner check on invoice export", severity: "critical", target: "src/export.ts:40", description: "A longer description that would win the merge." };
		expect(await toolCall(fire, ctx, "record", probe)).toMatchObject({ block: true, reason: expect.stringContaining("no hypothesis 'h-any'") });
		expect(await toolCall(fire, ctx, "record", { ...probe, hypothesisId: "h-7" })).toMatchObject({ block: true, reason: expect.stringContaining("record id=f-1 status=") });
		// h-7 is on the ledger refuted: the hypothesis is confirmed first, through the real record tool, then the finding.
		const fresh = { kind: "finding", hypothesisId: "h-7", title: "Export CSV includes other tenants' totals", severity: "high", target: "src/export.ts:88" };
		expect(await toolCall(fire, ctx, "record", fresh)).toMatchObject({ block: true, reason: expect.stringContaining("hypothesis h-7 is recorded refuted, not confirmed") });
		const confirm = { kind: "hypothesis", id: "h-7", outcome: "confirmed", basis: ["src/export.ts:88"] };
		expect(await toolCall(fire, ctx, "record", { ...confirm })).toBeUndefined();
		await tools.find((t) => t.name === "record")?.execute("h1", { ...confirm }, undefined, undefined, { cwd: root });
		expect(await toolCall(fire, ctx, "record", fresh)).toBeUndefined();

		expect(await toolCall(fire, ctx, "record", { kind: "finding", id: "f-2", status: "refuted", basis: ["src/errors.ts:1"] })).toMatchObject({ block: true, reason: expect.stringContaining("finding f-2 is already reported") });
		expect(await toolCall(fire, ctx, "record", { kind: "finding", id: "f-2", status: "suspected", basis: ["src/errors.ts:1"] })).toBeUndefined();
	});

	it("learns its role from before_agent_start when the session_start prompt has no marker", async () => {
		await parentSession();
		const { fire } = fakePi();
		const verify = PIRED_AGENTS.find((a) => a.name === "pired-verify");
		const noPrompt = ctxFor(root, () => {
			throw new Error("no prompt yet");
		});
		await fire("session_start", {}, noPrompt);
		await fire("before_agent_start", { type: "before_agent_start", systemPrompt: agentMarker("pired-verify") }, noPrompt);
		for (let i = 0; i <= (verify?.maxTurns ?? 0); i++) await fire("turn_start", { type: "turn_start" }, noPrompt);
		expect((await toolCall(fire, noPrompt, "read", {}))?.reason).toContain(`pired-verify has used its ${verify?.maxTurns}-turn budget`);
	});

	/**
	 * pi-subagents 0.71 appends a section telling every worker to "Use
	 * contact_supervisor first", a tool the gate refuses; 31 such calls were
	 * refused in the 2026-09-24 grid.
	 */
	it("replaces a worker prompt carrying pi-subagents' supervisor section with one without it, and still knows its role", async () => {
		await parentSession();
		const { fire } = fakePi();
		const ctx = ctxFor(root, "");
		await fire("session_start", {}, ctx);
		const body = `<active_agent name="pired-verify"/>\n\n${agentMarker("pired-verify")}\n\nYou are pired-verify.`;
		const section = `${SUPERVISOR_SECTION_START}\nUse contact_supervisor first.\n- Need a decision: contact_supervisor({ reason: "need_decision" })\n\n${SUPERVISOR_SECTION_END}`;
		const [result] = await fire("before_agent_start", { type: "before_agent_start", systemPrompt: `${body}\n\n${section}\n\n<cwd>\n/t\n</cwd>` }, ctx);
		expect(result).toEqual({ systemPrompt: `${body}\n\n<cwd>\n/t\n</cwd>` });
		const verify = PIRED_AGENTS.find((a) => a.name === "pired-verify");
		for (let i = 0; i <= (verify?.maxTurns ?? 0); i++) await fire("turn_start", { type: "turn_start" }, ctx);
		expect((await toolCall(fire, ctx, "read", {}))?.reason).toContain("pired-verify has used its");

		// No section, no replacement: pi keeps its structured prompt.
		const [plain] = await fire("before_agent_start", { type: "before_agent_start", systemPrompt: body }, ctx);
		expect(plain).toBeUndefined();
	});

	/**
	 * 4 of the 6 gpt-6-luna pired-verify children that recorded nothing in the
	 * 2026-09-24 grid handed back early with a verdict stated and never written.
	 */
	it("asks pi for one more request, with a reminder after any earlier handler's entries, when a worker settles with nothing recorded", async () => {
		await parentSession();
		const { fire } = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-verify"));
		await fire("session_start", {}, ctx);
		for (let i = 0; i < 7; i++) await fire("turn_start", { type: "turn_start" }, ctx);
		const earlier = { type: "custom", customType: "someone-else", data: {} };
		const settle = { type: "agent_before_settle", outcome: "completed", entries: [earlier], continue: false };

		const [first] = await fire("agent_before_settle", settle, ctx) as Array<{ entries: Array<Record<string, unknown>>; continue: boolean } | undefined>;
		expect(first?.continue).toBe(true);
		expect(first?.entries).toHaveLength(2);
		expect(first?.entries[0]).toBe(earlier);
		expect(first?.entries[1]).toMatchObject({ type: "custom_message", customType: SETTLE_REMINDER_TYPE, display: true });
		expect(String(first?.entries[1]?.content)).toContain("your verdict on the record named in your task");

		// Never twice: the worker's next hand-back settles.
		expect(await fire("agent_before_settle", settle, ctx)).toEqual([undefined]);
	});

	it("lets a worker that recorded something, or a run that was aborted, settle without a reminder", async () => {
		await parentSession();
		const recorded = fakePi();
		const ctx = ctxFor(root, agentMarker("pired-scout"));
		await recorded.fire("session_start", {}, ctx);
		await recorded.tools.find((t) => t.name === "record")?.execute("r1", { kind: "host", value: "app.child-test.test" }, undefined, undefined, { cwd: root });
		const settle = { type: "agent_before_settle", outcome: "completed", entries: [], continue: false };
		expect(await recorded.fire("agent_before_settle", settle, ctx)).toEqual([undefined]);

		const aborted = fakePi();
		await aborted.fire("session_start", {}, ctx);
		expect(await aborted.fire("agent_before_settle", { ...settle, outcome: "aborted" }, ctx)).toEqual([undefined]);
	});
});

// ---------------------------------------------------------------------------
// End to end: pi 0.87.1 + pi-subagents + pired, scripted by a faux model
// ---------------------------------------------------------------------------

/**
 * pi-subagents is not a dependency of pired (ADR-027: pired never imports it),
 * so this only runs when pointed at an installed copy — the pinned one is
 * eval/artifacts/pi-subagents-0.71.0/node_modules/pi-subagents.
 */
function locateSubagents(): { dir?: string; skip?: string } {
	const dir = process.env.PIRED_TEST_PI_SUBAGENTS?.trim();
	if (!dir) return { skip: "set PIRED_TEST_PI_SUBAGENTS to a pi-subagents 0.71 package dir to run it" };
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
		if (pkg.name !== "pi-subagents") return { skip: `${dir} is not the pi-subagents package` };
		return { dir: resolve(dir) };
	} catch {
		return { skip: `no package.json under PIRED_TEST_PI_SUBAGENTS=${dir}` };
	}
}

const SUBAGENTS = locateSubagents();
const PI_ROOT = join(REPO, "node_modules/@earendil-works/pi-coding-agent");
const FAUX_PROVIDER = "pired-child-test-faux";
const FAUX_MODEL = "scripted";

type Msg = { role?: string; toolName?: string; isError?: boolean; content?: unknown };
type Request = { side: "parent" | "child"; tools: string[]; system: string; results: Array<{ tool: string; isError: boolean; text: string }> };
type FauxAi = {
	fauxProvider(options: { provider: string; models: Array<Record<string, unknown>> }): {
		provider: unknown;
		setResponses(steps: Array<(context: { messages: unknown[] }) => unknown>): void;
	};
	fauxAssistantMessage(content: unknown, options?: { responseId?: string }): unknown;
	fauxToolCall(name: string, args: Record<string, unknown>): unknown;
	fauxText(text: string): unknown;
	getCurrentTools(messages: unknown[]): Array<{ name: string }>;
	getCurrentSystemPrompt(messages: unknown[]): string;
};

const textOf = (m: Msg): string => Array.isArray(m.content)
	? (m.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
	: typeof m.content === "string" ? m.content : "";

/** The pi-ai copy pi-coding-agent itself loads; a provider from the other copy is one pi never registered. */
async function hostPiAi(): Promise<FauxAi> {
	const nested = join(PI_ROOT, "node_modules/@earendil-works/pi-ai/dist/index.js");
	const entry = existsSync(nested) ? nested : join(REPO, "node_modules/@earendil-works/pi-ai/dist/index.js");
	return await import(pathToFileURL(entry).href) as FauxAi;
}

describe(`pired worker through pi-subagents${SUBAGENTS.skip ? ` (skipped: ${SUBAGENTS.skip})` : ""}`, () => {
	const saved: Record<string, string | undefined> = {};
	const ENV = [
		"HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
		"PI_SUBAGENTS_TEMP_ROOT", "PI_OFFLINE", "PIRED_SCRIBE", "PIRED_WORKSPACE", "PIRED_PASSES",
	];
	let root = "";
	let realFetch: typeof fetch;

	beforeEach(() => {
		for (const key of ENV) saved[key] = process.env[key];
		realFetch = globalThis.fetch;
	});
	afterEach(() => {
		for (const key of ENV) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		globalThis.fetch = realFetch;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	type Script = (request: Request, reply: (content: unknown) => unknown, ai: FauxAi) => unknown;

	/**
	 * A parent pi session with pired and pi-subagents loaded, in a scratch
	 * engagement, answering every model request from `script`. Nothing in it may
	 * reach a network or the operator's real state.
	 */
	async function startParent(script: Script) {
		root = mkdtempSync(join(tmpdir(), "pired-child-e2e-"));
		const agentDir = join(root, "agent");
		const target = join(root, "target");
		const ws = join(root, "ws");
		const childSessions = join(root, "child-sessions");
		for (const d of [agentDir, join(target, "src"), join(root, "home"), join(root, "tmp"), join(agentDir, "extensions/subagent")]) mkdirSync(d, { recursive: true });
		writeFileSync(join(target, "src/routes.ts"), "export const routes = ['/child-e2e'];\n");
		writeFileSync(join(target, "pired.scope.json"), JSON.stringify(scope(ws)));
		// Where pi-subagents puts foreground child sessions, read from <agentDir>.
		writeFileSync(join(agentDir, "extensions/subagent/config.json"), JSON.stringify({ defaultSessionDir: childSessions }));
		// The child reads settings from disk. Cache warming off: its keep-warm
		// requests would reach the scripted model as turns nobody took.
		const settings = { packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

		Object.assign(process.env, {
			HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
			PI_PACKAGE_DIR: PI_ROOT, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: PI_ROOT,
			PI_SUBAGENTS_TEMP_ROOT: join(root, "tmp/pi-subagents"), PI_OFFLINE: "1", PIRED_SCRIBE: "off",
		});
		delete process.env.PIRED_WORKSPACE;
		delete process.env.PIRED_PASSES;
		const network: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			network.push(String((input as { url?: string })?.url ?? input));
			throw new Error("network disabled in this test");
		}) as typeof fetch;

		const ai = await hostPiAi();
		const requests: Request[] = [];
		const workerMarker = /<!--\s*pired-agent:/;
		const step = (context: { messages: unknown[] }): unknown => {
			const messages = context.messages as Msg[];
			const system = ai.getCurrentSystemPrompt(context.messages);
			const tools = ai.getCurrentTools(context.messages).map((t) => t.name);
			const results = messages.filter((m) => m.role === "toolResult")
				.map((m) => ({ tool: String(m.toolName ?? ""), isError: m.isError === true, text: textOf(m) }));
			const side = workerMarker.test(system) ? "child" : "parent";
			const request: Request = { side, tools, system, results };
			requests.push(request);
			return script(request, (content) => ai.fauxAssistantMessage(content, { responseId: `${side}-${requests.length}` }), ai);
		};
		const faux = ai.fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL, contextWindow: 200_000, maxTokens: 8192 }] });
		faux.setResponses(Array.from({ length: 24 }, () => step));

		const {
			createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
			ModelRuntime, SessionManager, SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir: dir, sessionManager, sessionStartEvent }) => {
			const settingsManager = SettingsManager.inMemory(settings as Parameters<typeof SettingsManager.inMemory>[0], { projectTrusted: true });
			const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
			modelRuntime.registerNativeProvider(faux.provider as Parameters<typeof modelRuntime.registerNativeProvider>[0]);
			const services = await createAgentSessionServices({
				cwd, agentDir: dir, settingsManager, modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
					additionalExtensionPaths: [join(REPO, "extensions/pired.ts"), join(SUBAGENTS.dir ?? "", "index.js")],
				},
			});
			expect(services.resourceLoader.getExtensions().errors).toEqual([]);
			const model = modelRuntime.getModel(FAUX_PROVIDER, FAUX_MODEL);
			if (!model) throw new Error("the scripted model did not register");
			const session = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off" });
			return { ...session, services, diagnostics: services.diagnostics };
		}, { cwd: target, agentDir, sessionManager: SessionManager.inMemory(target) });

		const session = runtime.session;
		const extensionErrors: string[] = [];
		const subagentResults: Array<{ isError: boolean; result: { content?: unknown; details?: { results?: Array<Record<string, unknown>> } } }> = [];
		session.subscribe((event: { type: string; toolName?: string; isError?: boolean; result?: unknown }) => {
			if (event.type === "tool_execution_end" && event.toolName === "subagent") {
				subagentResults.push({ isError: event.isError === true, result: event.result as never });
			}
		});
		await session.bindExtensions({ mode: "print", onError: (e: { extensionPath: string; event: string; error: unknown }) => extensionErrors.push(`${e.extensionPath} ${e.event}: ${String(e.error)}`) });
		return { session, runtime, requests, subagentResults, extensionErrors, network, ws, childSessions };
	}

	/** The parent's side of every script: enable the tool, then `launch`, then wrap up once a subagent result is back. */
	const parentTurn = (request: Request, reply: (content: unknown) => unknown, ai: FauxAi, launch: () => unknown): unknown => {
		if (request.results.some((r) => r.tool === "subagent")) return reply(ai.fauxText("The workers' handoffs are in."));
		if (request.tools.includes("subagent")) return reply(launch());
		if (request.tools.includes("subagents_enable") && !request.results.some((r) => r.tool === "subagents_enable")) return reply(ai.fauxToolCall("subagents_enable", {}));
		return reply(ai.fauxText(`no delegation tool (${request.tools.join(",")})`));
	};

	it.skipIf(SUBAGENTS.skip !== undefined)("records into the parent's ledger, is blocked out of scope with pired's reason, and hands back", async () => {
		const marker = () => join(root, "BLOCKED-COMMAND-RAN");
		const blockedCommand = () => `curl --version http://outside.child-test.example/ && touch ${marker()}`;
		const parent = await startParent((request, reply, ai) => {
			if (request.side === "child") {
				if (request.results.length === 0) return reply(ai.fauxToolCall("record", { kind: "endpoint", method: "GET", path: "/child-e2e", file: "src/routes.ts" }));
				if (request.results.length === 1) return reply(ai.fauxToolCall("bash", { command: blockedCommand() }));
				return reply(ai.fauxText("Recorded GET /child-e2e (src/routes.ts). The out-of-scope request was refused. Nothing unresolved."));
			}
			return parentTurn(request, reply, ai, () => ai.fauxToolCall("subagent", { agent: "pired-scout", task: "Map the surface in src/routes.ts; record it and hand back." }));
		});
		const { session, runtime, requests, subagentResults, extensionErrors, network, ws, childSessions } = parent;
		try {
			expect(process.env.PIRED_WORKSPACE).toBe(ws);
			const scopeBefore = readFileSync(join(ws, "scope.json"), "utf8");

			await session.prompt("Map the attack surface; delegate the routes file to a scout.");

			expect(extensionErrors).toEqual([]);
			expect(network).toEqual([]);

			// The parent launched pired's registered scout, and it came back clean.
			expect(subagentResults).toHaveLength(1);
			const [launch] = subagentResults;
			expect(launch?.isError).toBe(false);
			const child = launch?.result.details?.results?.[0] ?? {};
			expect(child).toMatchObject({ agent: "pired-scout", exitCode: 0 });
			// pired's gate armed inside the child, not only its path configured —
			// which also shows the child found the parent's in-process scope.
			expect(child.runtimeAcknowledgedExtensions).toMatchObject({ ids: [CHILD_EXTENSION_ID] });

			// The worker saw pired's ledger tools and none of the orchestration ones.
			const childRequests = requests.filter((r) => r.side === "child");
			expect(childRequests).toHaveLength(3);
			expect(childRequests[0]?.tools).toEqual(expect.arrayContaining(["record", "recall", "bash"]));
			for (const name of ["subagent", "subagents_enable", "bg_wait", "subagent_supervisor"]) expect(childRequests[0]?.tools).not.toContain(name);

			// The record reached the parent's ledger.
			const inventory = readFileSync(join(ws, "inventory.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(inventory).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "endpoint", path: "/child-e2e", file: "src/routes.ts" })]));

			// The out-of-scope command was refused with the reason the parent's gate gives, and never ran.
			const expected = await createScopeGate(JSON.parse(scopeBefore) as EngagementScope)({ name: "bash", args: { command: blockedCommand() } });
			const bash = childRequests[2]?.results.find((r) => r.tool === "bash");
			expect(bash?.isError).toBe(true);
			expect(bash?.text).toContain(expected.reason ?? "<no reason>");
			expect(existsSync(marker())).toBe(false);

			// The parent's scope and environment are as it left them.
			expect(readFileSync(join(ws, "scope.json"), "utf8")).toBe(scopeBefore);
			expect(process.env.PIRED_WORKSPACE).toBe(ws);

			// The child's session landed where the accounting reads it, one usage row per response.
			const sessionFile = String(child.sessionFile ?? "");
			expect(sessionFile.startsWith(childSessions)).toBe(true);
			const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; usage?: unknown; responseId?: string } });
			const responses = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
			expect(responses).toHaveLength(3);
			for (const r of responses) {
				expect(r.message?.responseId).toMatch(/^child-/);
				expect(r.message?.usage).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
			}
		} finally {
			await runtime.dispose();
		}
	}, 120_000);

	/**
	 * Two shipped gaps, end to end. A `gate` on a launch ran as a host shell
	 * command after the worker, where no tool_call hook sees it — a probe wrote a
	 * marker file this way. And two launches in one assistant message ran two
	 * workers at once, because pi executes a message's tool calls in parallel.
	 */
	it.skipIf(SUBAGENTS.skip !== undefined)("never runs a launch's gate command, and runs one worker when a message asks for two", async () => {
		const marker = () => join(root, "GATE-COMMAND-RAN");
		const parent = await startParent((request, reply, ai) => {
			if (request.side === "child") return reply(ai.fauxText("Nothing to record. Nothing unresolved."));
			return parentTurn(request, reply, ai, () => [
				ai.fauxToolCall("subagent", { agent: "pired-verify", task: "Refute nothing.", gate: `touch ${marker()}` }),
				ai.fauxToolCall("subagent", { agent: "pired-scout", task: "Map src/." }),
				ai.fauxToolCall("subagent", { agent: "pired-verify", task: "Refute nothing, again." }),
			]);
		});
		const { session, runtime, requests, subagentResults, extensionErrors, network } = parent;
		try {
			await session.prompt("Delegate.");
			expect(extensionErrors).toEqual([]);
			expect(network).toEqual([]);

			expect(subagentResults).toHaveLength(3);
			const texts = subagentResults.map((r) => textOf(r.result as Msg));
			// The gated launch was refused by name, and its command never ran.
			expect(subagentResults[0]?.isError).toBe(true);
			expect(texts[0]).toContain("`gate`");
			expect(existsSync(marker())).toBe(false);
			// Exactly one worker ran; the launch behind it in the same message was refused.
			const ran = subagentResults.filter((r) => (r.result.details?.results?.length ?? 0) > 0);
			expect(ran).toHaveLength(1);
			expect(texts.some((t) => /one at a time/.test(t))).toBe(true);
			expect(new Set(requests.filter((r) => r.side === "child").map((r) => /pired-agent: (pired-[a-z]+)/.exec(r.system)?.[1]))).toEqual(new Set(["pired-scout"]));
		} finally {
			await runtime.dispose();
		}
	}, 120_000);
});
