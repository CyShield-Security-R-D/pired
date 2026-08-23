import { describe, expect, it } from "vitest";
import type { Checklist, EndpointRecord } from "./ontology.ts";
import type { ToolContext, ToolDefinition } from "./ports.ts";
import { makeFakeServices, type FakeServices } from "./testing/fakes.ts";
import { createRecallTool, createRecordTool } from "./tools.ts";
import { Workspace } from "./workspace.ts";

async function setup(): Promise<{ svc: FakeServices; ws: Workspace; ctx: ToolContext; record: ToolDefinition; recall: ToolDefinition }> {
	const svc = makeFakeServices();
	const ws = await Workspace.open("/ws/acme", "acme", svc);
	const ctx: ToolContext = { cwd: "/target", services: svc };
	return { svc, ws, ctx, record: createRecordTool({ workspace: ws }), recall: createRecallTool({ workspace: ws }) };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("record tool", () => {
	it("appends a timestamped note", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "note", text: "login lacks SameSite" }, ctx);
		expect(await ws.readNotes()).toContain("login lacks SameSite");
	});

	it("records a host into inventory with a generated id", async () => {
		const { ws, ctx, record } = await setup();
		const res = await record.execute({ kind: "host", value: "app.acme.test" }, ctx);
		const inv = await ws.read("inventory");
		expect(inv).toHaveLength(1);
		expect(inv[0]).toMatchObject({ kind: "host", value: "app.acme.test" });
		expect((res.details as { id: string }).id).toBe(inv[0]?.id);
	});

	it("defaults hypothesis outcome to proposed and finding status to open", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "hypothesis", statement: "IDOR on /user", target: "e1", class: "authz" }, ctx);
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "e1" }, ctx);
		expect((await ws.read("hypotheses"))[0]?.outcome).toBe("proposed");
		expect((await ws.read("findings"))[0]?.status).toBe("open");
	});

	it("updates an existing record by id, preserving createdAt", async () => {
		const { svc, ws, ctx, record } = await setup();
		const created = await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "e1" }, ctx);
		const id = (created.details as { id: string }).id;
		const createdAt = (await ws.read("findings"))[0]?.createdAt;
		svc.clock.advance(5000);
		await record.execute({ kind: "finding", id, status: "confirmed" }, ctx);
		const findings = await ws.read("findings");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.status).toBe("confirmed");
		expect(findings[0]?.createdAt).toBe(createdAt);
		expect(findings[0]?.updatedAt).toBeDefined();
	});

	it("rejects a finding without a severity", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "finding", title: "x", target: "e1" }, ctx)).rejects.toThrow(/severity/i);
	});

	it("rejects an unknown kind", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "nope" }, ctx)).rejects.toThrow(/kind/i);
	});
});

describe("recall tool", () => {
	async function seed(): Promise<{ ws: Workspace; ctx: ToolContext; recall: ToolDefinition; record: ToolDefinition }> {
		const { ws, ctx, recall, record } = await setup();
		const endpoint: EndpointRecord = { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path: "/api/user" };
		await ws.append("inventory", endpoint);
		const checklist: Checklist = { v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }, { id: "sqli", title: "SQL injection" }] };
		await ws.writeChecklist(checklist);
		void record;
		return { ws, ctx, recall, record };
	}

	it("lists inventory", async () => {
		const { ctx, recall } = await seed();
		const out = textOf(await recall.execute({ query: "inventory" }, ctx));
		expect(out).toContain("/api/user");
	});

	it("computes coverage from checklist × surface × hypotheses", async () => {
		const { ws, ctx, recall } = await seed();
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "authz", outcome: "confirmed" });
		const out = textOf(await recall.execute({ query: "coverage" }, ctx));
		expect(out).toMatch(/vulnerable/i);
		expect(out).toMatch(/not-tested/i);
	});

	it("lists gaps", async () => {
		const { ctx, recall } = await seed();
		const out = textOf(await recall.execute({ query: "gaps" }, ctx));
		expect(out).toContain("e1");
		expect(out).toMatch(/authz|sqli/);
	});

	it("returns the next actionable cell", async () => {
		const { ctx, recall } = await seed();
		const out = textOf(await recall.execute({ query: "next" }, ctx));
		expect(out).toMatch(/e1/);
	});

	it("lists loot by handle without exposing the secret", async () => {
		const { ws, ctx, recall } = await seed();
		await ws.append("loot", { v: 1, id: "c1", kind: "loot", createdAt: "t", handle: "cred:web-admin", type: "password", username: "admin", secret: "S3cr3tP@ss" });
		const out = textOf(await recall.execute({ query: "loot" }, ctx));
		expect(out).toContain("cred:web-admin");
		expect(out).not.toContain("S3cr3tP@ss");
	});

	it("reports when no checklist is loaded", async () => {
		const { ctx, recall } = await setup();
		const out = textOf(await recall.execute({ query: "coverage" }, ctx));
		expect(out).toMatch(/no checklist/i);
	});
});
