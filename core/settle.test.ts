import { describe, expect, it } from "vitest";
import type { BudgetReading, Checklist, FindingRecord, SettleRecord } from "./ontology.ts";
import type { ToolContext, ToolDefinition } from "./ports.ts";
import { lastSettle, remainderLines, writesAfter, renderLastSettle, renderSettleReply, renderSpent, settleAreas, settleRemainder, UNKNOWN_AUTHOR } from "./settle.ts";
import { makeFakeServices, type FakeServices } from "./testing/fakes.ts";
import { createRecallTool, createRecordTool, type ToolDeps } from "./tools.ts";
import { Workspace } from "./workspace.ts";

const T = "2026-01-01T00:00:00.000Z";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

function finding(id: string, extra: Partial<FindingRecord> = {}): FindingRecord {
	return { v: 1, id, kind: "finding", createdAt: T, title: id, severity: "high", target: "x", status: "suspected", ...extra } as FindingRecord;
}

function settle(id: string, createdAt: string, extra: Partial<SettleRecord> = {}): SettleRecord {
	return { v: 1, id, kind: "settle", createdAt, by: "lead", outcome: "paused", remainder: {}, ...extra } as SettleRecord;
}

interface Session {
	svc: FakeServices;
	ws: Workspace;
	ctx: ToolContext;
	/** The lead's record tool, and one per worker name, all on one ledger. */
	record: (author?: string) => ToolDefinition;
	recall: ToolDefinition;
}

async function session(extra: Partial<ToolDeps> = {}): Promise<Session> {
	const svc = makeFakeServices();
	const ws = await Workspace.open("/ws/acme", "acme", svc);
	await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "sqli", title: "SQLi" }, { id: "authz", title: "Access control" }] } as Checklist);
	const ctx: ToolContext = { cwd: "/target", services: svc };
	return {
		svc, ws, ctx,
		record: (author = "lead") => createRecordTool({ workspace: ws, author: () => author, ...extra }),
		recall: createRecallTool({ workspace: ws, ...extra }),
	};
}

describe("record kind=settle", () => {
	it("records settle with the ledger's own remainder, ignoring caller counts", async () => {
		const budget: BudgetReading = { ceiling: { tokens: 20_000_000, minutes: 240 }, spent: { tokens: 6_100_000, minutes: 52 } };
		const s = await session({ budget: () => budget, sourceDirs: () => ["src", "src/routes", "src/admin"] });
		await s.record().execute({ kind: "endpoint", path: "/login", file: "src/routes/login.ts" }, s.ctx);
		await s.record().execute({ kind: "hypothesis", statement: "maybe", target: "/login", class: "sqli", outcome: "inconclusive" }, s.ctx);
		await s.record().execute({ kind: "blocker", question: "which tenant?" }, s.ctx);
		const res = await s.record().execute({
			kind: "settle", outcome: "finished", note: "done for today",
			// The caller's own account: every field of it is wrong, and none is used.
			remainder: { openCells: 0, unverified: {}, openBlockers: [] }, openCells: 0,
		}, s.ctx);

		const [row] = await s.ws.read("sessions");
		expect(row).toMatchObject({ kind: "settle", outcome: "finished", note: "done for today", by: "lead", createdAt: s.svc.clock.nowIso() });
		expect(row?.remainder.openCells).toBe(2);
		expect(row?.remainder.inconclusive).toHaveLength(1);
		expect(row?.remainder.openBlockers).toHaveLength(1);
		expect(row?.remainder.unmappedAreas).toEqual(["src/admin"]);
		expect(row?.remainder.spent).toEqual({ tokens: 6_100_000, minutes: 52 });
		expect(row).not.toHaveProperty("openCells");
		const reply = textOf(res);
		expect(reply).toContain("does not end the session");
		expect(reply).toContain("test cases not settled (untested, in progress or blocked): 2");
		expect(reply).toContain("src/routes — in progress, 0/2 cells settled");
		expect(reply).toContain("unmapped — no recorded surface: src/admin");
		expect(reply).toContain("The remainder sent with this call was not used");
	});

	it("settle refuses nothing and lists unverified worker findings", async () => {
		// A worker's unchallenged claim is the thing a lead most needs named when
		// it stops: nobody but the worker has looked at it.
		const s = await session();
		await s.record("pired-investigate").execute({ kind: "finding", title: "SQLi in search", severity: "high", target: "src/search.ts" }, s.ctx);
		await s.record("pired-investigate").execute({ kind: "finding", title: "IDOR on orders", severity: "high", target: "src/orders.ts" }, s.ctx);
		await s.record().execute({ kind: "finding", title: "Weak session cookie", severity: "low", target: "src/session.ts" }, s.ctx);
		for (const outcome of ["finished", "paused", "blocked"]) {
			const res = await s.record().execute({ kind: "settle", outcome }, s.ctx);
			expect(textOf(res)).toMatch(/^Settled \S+ \((finished|paused|blocked)\)\./);
		}
		const rows = await s.ws.read("sessions");
		expect(rows.map((r) => r.outcome)).toEqual(["finished", "paused", "blocked"]);
		const unverified = rows[0]?.remainder.unverified ?? {};
		expect(Object.keys(unverified).sort()).toEqual(["lead", "pired-investigate"]);
		expect(unverified["pired-investigate"]).toHaveLength(2);
		const reply = textOf(await s.record().execute({ kind: "settle", outcome: "finished" }, s.ctx));
		expect(reply).toMatch(/findings nobody has challenged, by who recorded them — lead: \S+; pired-investigate: \S+, \S+/);
	});

	it("says an outcome it cannot read is not one of the three, and will not delete a settle", async () => {
		const s = await session();
		await expect(s.record().execute({ kind: "settle", outcome: "done" }, s.ctx)).rejects.toThrow(/finished, paused, blocked/);
		await expect(s.record().execute({ kind: "settle", id: "s1", delete: true }, s.ctx)).rejects.toThrow(/A settle is history/);
		expect(await s.ws.read("sessions")).toEqual([]);
	});

	it("refuses a settle from anyone but the lead — a worker, the scribe, an unnamed author — and writes nothing", async () => {
		// A worker's settle would describe a worker's stop as the session's.
		const s = await session();
		await expect(s.record("pired-investigate").execute({ kind: "settle", outcome: "finished" }, s.ctx)).rejects.toThrow(/only the lead session settles, and this call is from pired-investigate/);
		await expect(s.record().execute({ kind: "settle", outcome: "finished" }, { ...s.ctx, author: "scribe" })).rejects.toThrow(/from scribe/);
		const unnamed = createRecordTool({ workspace: s.ws });
		await expect(unnamed.execute({ kind: "settle", outcome: "finished" }, s.ctx)).rejects.toThrow(/from an unnamed author/);
		expect(await s.ws.read("sessions")).toEqual([]);
	});

	it("refuses a settle word as a hypothesis outcome rather than dropping it, now the schema's enum carries both", async () => {
		const s = await session();
		await expect(s.record().execute({ kind: "hypothesis", statement: "x", target: "e1", class: "sqli", outcome: "blocked" }, s.ctx)).rejects.toThrow(/"blocked" is not a hypothesis outcome/);
		await s.record().execute({ kind: "hypothesis", statement: "x", target: "e1", class: "sqli", outcome: "inconclusive" }, s.ctx);
		expect((await s.ws.read("hypotheses"))[0]?.outcome).toBe("inconclusive");
	});

	it("takes the note from `text` when the caller put it there", async () => {
		const s = await session();
		await s.record().execute({ kind: "settle", outcome: "paused", text: "auth left" }, s.ctx);
		expect((await s.ws.read("sessions"))[0]?.note).toBe("auth left");
	});
});

describe("recall status", () => {
	it("shows the budget line and the last settle, and the areas once there is surface", async () => {
		const budget: BudgetReading = { ceiling: { minutes: 240 }, spent: { minutes: 200 } };
		const s = await session({ budget: () => budget });
		const before = textOf(await s.recall.execute({ query: "status" }, s.ctx));
		expect(before).toContain("budget     200 of 240 min — a ceiling, not a target. 83% is used: record what is established.");
		expect(before).toContain("settled    never");
		expect(before).not.toContain("areas");
		await s.record().execute({ kind: "endpoint", path: "/a", file: "api/a.ts" }, s.ctx);
		s.svc.clock.advance(1000);
		await s.record().execute({ kind: "settle", outcome: "paused", note: "auth left" }, s.ctx);
		const after = textOf(await s.recall.execute({ query: "status" }, s.ctx));
		expect(after).toMatch(/settled {4}paused at \S+ — auth left \(left: 2 open cell\(s\)\)/);
		expect(after).toContain("areas\n  api — untested");
	});

	it("renders no budget line when the scope sets none", async () => {
		const s = await session();
		expect(textOf(await s.recall.execute({ query: "status" }, s.ctx))).not.toContain("budget");
	});
});

describe("the remainder, rendered", () => {
	it("keys a finding written before `by` existed under an unknown author rather than dropping it", () => {
		const r = settleRemainder({ inventory: [], surfaceKinds: ["endpoint"], cells: undefined, hypotheses: [], findings: [finding("f1"), finding("f2", { status: "false-positive" })], blockers: [] });
		expect(r).toEqual({ unverified: { [UNKNOWN_AUTHOR]: ["f1"] } });
		// No checklist is no cells to count, not zero open.
		expect(r).not.toHaveProperty("openCells");
	});

	it("says the ledger shows nothing open when nothing is", () => {
		const record = settle("s1", T, { outcome: "finished" });
		const reply = renderSettleReply(record, settleAreas({ inventory: [], surfaceKinds: [], cells: [], hypotheses: [], findings: [], blockers: [] }), false);
		expect(reply).toBe([
			"Settled s1 (finished).",
			"Settling records where the engagement stands; it does not end the session. The ledger is where the next session starts.",
			"The ledger shows nothing open.",
		].join("\n"));
		expect(remainderLines({})).toEqual([]);
		expect(renderSpent(undefined)).toBe("");
		expect(renderSpent({ tokens: 1_500 })).toBe("1.5k tokens");
	});

	it("reads the newest settle as the last one, and lists every part of what it left", () => {
		const newest = settle("s2", "2026-01-02T00:00:00.000Z", {
			outcome: "blocked",
			remainder: { openCells: 3, unverified: { lead: ["f1"] }, inconclusive: ["y1"], openBlockers: ["b1", "b2"], unmappedAreas: ["lib"] },
		});
		expect(lastSettle([newest, settle("s1", T)])).toBe(newest);
		// Only the lead's settle stands for the session.
		expect(lastSettle([newest, settle("s3", "2026-01-03T00:00:00.000Z", { by: "pired-investigate" })])).toBe(newest);
		expect(lastSettle([settle("s4", T, { by: undefined })])).toBeUndefined();
		expect(lastSettle([])).toBeUndefined();
		expect(renderLastSettle(newest)).toBe(
			"settled    blocked at 2026-01-02T00:00:00.000Z (left: 3 open cell(s), 1 unchallenged finding(s), 1 inconclusive, 2 open blocker(s), 1 unmapped dir(s))",
		);
	});
});

describe("writesAfter", () => {
	it("counts the work written after a settle, by its latest version, and not the scribe's or the operator's", () => {
		const at = "2026-01-01T01:00:00.000Z";
		expect(writesAfter(at, [
			{ createdAt: "2026-01-01T00:00:00.000Z", by: "lead" },
			{ createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T02:00:00.000Z", by: "lead" },
			{ createdAt: "2026-01-01T02:00:00.000Z", by: "pired-investigate" },
			{ createdAt: "2026-01-01T02:00:00.000Z" },
			{ createdAt: "2026-01-01T02:00:00.000Z", by: "scribe" },
			{ createdAt: "2026-01-01T02:00:00.000Z", by: "operator" },
			{ createdAt: at, by: "lead" },
			{},
		])).toBe(3);
	});
});
