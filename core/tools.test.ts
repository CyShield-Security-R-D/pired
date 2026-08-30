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

describe("record kind=evidence", () => {
	it("writes the file and returns the path to cite", async () => {
		const { ws, ctx, record } = await setup();
		const res = await record.execute(
			{ kind: "evidence", name: "sqli-login.txt", content: "HTTP/1.1 500\nSQL syntax error" },
			ctx,
		);
		const rel = (res.details as { path: string }).path;
		expect(rel).toBe("evidence/sqli-login.txt");
		// The path a finding will cite must actually resolve — this is the whole
		// point of the affordance: without it the model invents plausible filenames.
		expect(await ws.readRelative(rel)).toContain("SQL syntax error");
		expect(textOf(res)).toContain(rel);
	});

	it("requires both a name and content", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "evidence", name: "a.txt" }, ctx)).rejects.toThrow(/content/);
		await expect(record.execute({ kind: "evidence", content: "x" }, ctx)).rejects.toThrow(/name/);
	});
});

describe("record hypothesis in bulk", () => {
	it("records one hypothesis per class when class is a list", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{
				kind: "hypothesis",
				target: "e1",
				class: ["xss", "ssti", "xxe"],
				outcome: "refuted",
				statement: "JSON-only route: no template rendering and no XML parsing on this path",
			},
			ctx,
		);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(3);
		expect(hyps.map((h) => h.class).sort()).toEqual(["ssti", "xss", "xxe"]);
		expect(hyps.every((h) => h.outcome === "refuted" && h.target === "e1")).toBe(true);
	});

	it("records the cross product when both target and class are lists", async () => {
		const { ws, ctx, record } = await setup();
		const res = await record.execute(
			{
				kind: "hypothesis",
				target: ["e1", "e2"],
				class: ["sqli", "cmdi"],
				outcome: "refuted",
				statement: "no shell or SQL sink reachable from either handler",
			},
			ctx,
		);
		expect(await ws.read("hypotheses")).toHaveLength(4);
		expect((res.details as { ids: string[] }).ids).toHaveLength(4);
	});

	it("settles the matching coverage cells", async () => {
		const { ws, ctx, record, recall } = await setup();
		const ep = (id: string, path: string): EndpointRecord =>
			({ v: 1, id, kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path });
		await ws.append("inventory", ep("e1", "/a"));
		await ws.writeChecklist({
			v: 1,
			targetType: "web",
			classes: [{ id: "xss", title: "XSS" }, { id: "ssti", title: "SSTI" }],
		} satisfies Checklist);
		await record.execute(
			{ kind: "hypothesis", target: "e1", class: ["xss", "ssti"], outcome: "refuted", statement: "JSON only" },
			ctx,
		);
		// One call, a whole row of the matrix settled — the ergonomics fix exists
		// because doing this per-cell is hundreds of calls on a real engagement.
		expect(textOf(await recall.execute({ query: "coverage" }, ctx))).toContain("clear: 2");
	});

	it("still requires a statement when recording in bulk", async () => {
		const { ctx, record } = await setup();
		await expect(
			record.execute({ kind: "hypothesis", target: "e1", class: ["xss", "ssti"], outcome: "refuted" }, ctx),
		).rejects.toThrow(/statement/);
	});
});

describe("list coercion on hypothesis fields", () => {
	it("accepts a JSON array serialized as a string", async () => {
		const { ws, ctx, record } = await setup();
		// Smaller models emit this shape constantly; strict Array.isArray stored the
		// whole literal as one target id, orphaning every hypothesis it produced.
		await record.execute(
			{ kind: "hypothesis", target: '["e1","e2"]', class: "sqli", outcome: "refuted", statement: "parameterized on both" },
			ctx,
		);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(2);
		expect(hyps.map((h) => h.target).sort()).toEqual(["e1", "e2"]);
	});

	it("accepts a comma-separated list", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "hypothesis", target: "e1", class: "xss, ssti, xxe", outcome: "refuted", statement: "JSON only" },
			ctx,
		);
		expect((await ws.read("hypotheses")).map((h) => h.class).sort()).toEqual(["ssti", "xss", "xxe"]);
	});

	it("leaves a single plain value alone", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "hypothesis", target: "e1", class: "sqli", outcome: "refuted", statement: "bound parameter" },
			ctx,
		);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(1);
		expect(hyps[0]).toMatchObject({ target: "e1", class: "sqli" });
	});
});

describe("evidence must resolve before a claim citing it is accepted", () => {
	it("rejects a finding citing a path that was never written", async () => {
		const { ctx, record } = await setup();
		await expect(
			record.execute(
				{ kind: "finding", title: "SQLi", severity: "high", target: "e1", evidence: ["evidence/never-written.txt"] },
				ctx,
			),
		).rejects.toThrow(/do not resolve/);
	});

	it("accepts a finding whose evidence was actually saved", async () => {
		const { ws, ctx, record } = await setup();
		const res = await record.execute({ kind: "evidence", name: "sqli.txt", content: "HTTP 500 SQL syntax error" }, ctx);
		const rel = (res.details as { path: string }).path;
		await record.execute(
			{ kind: "finding", title: "SQLi", severity: "high", target: "e1", evidence: [rel] },
			ctx,
		);
		expect((await ws.read("findings"))[0]).toMatchObject({ evidence: [rel] });
	});

	it("names every missing path so the model can fix them all at once", async () => {
		const { ctx, record } = await setup();
		await expect(
			record.execute(
				{ kind: "finding", title: "x", severity: "low", target: "e1", evidence: ["evidence/a.txt", "evidence/b.txt"] },
				ctx,
			),
		).rejects.toThrow(/a\.txt.*b\.txt/);
	});

	it("still accepts a finding with no evidence claim", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "x", severity: "low", target: "e1" }, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
	});

	it("gates hypotheses too", async () => {
		const { ctx, record } = await setup();
		await expect(
			record.execute(
				{ kind: "hypothesis", statement: "s", target: "e1", class: "sqli", evidence: "evidence/ghost.txt" },
				ctx,
			),
		).rejects.toThrow(/do not resolve/);
	});
});

describe("tool schemas are renderable by a provider", () => {
	/**
	 * Every property must declare a shape.
	 *
	 * `target` and `class` once had a description and nothing else. A typeless
	 * property cannot be rendered into a function signature, so the field was
	 * dropped before the model saw it — and since both are required by
	 * `kind=finding` and `kind=hypothesis`, every attempt to record either was
	 * rejected for a field the model had no way to send. Findings went to notes,
	 * coverage stayed at zero, and three benchmark passes measured a mechanism
	 * that was unreachable rather than idle.
	 */
	const shaped = (schema: Record<string, unknown>): boolean =>
		schema.type !== undefined || schema.enum !== undefined ||
		schema.anyOf !== undefined || schema.oneOf !== undefined;

	// Built directly rather than through a fixture: this asserts on the schema
	// shape, which needs no workspace behind it.
	const tools: ToolDefinition[] = [
		createRecordTool({ workspace: {} as never }),
		createRecallTool({ workspace: {} as never }),
	];
	for (const tool of tools) {
		it(`${tool.name}: every property declares a type`, () => {
			const props = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>;
			const typeless = Object.entries(props).filter(([, v]) => !shaped(v)).map(([k]) => k);
			expect(typeless).toEqual([]);
		});

		it(`${tool.name}: every required field exists in properties`, () => {
			const props = Object.keys(tool.parameters.properties ?? {});
			for (const r of tool.parameters.required ?? []) expect(props).toContain(r);
		});
	}
});

describe("a finding is not only a proven vulnerability", () => {
	it("records an observation that has no surface element to hang off", async () => {
		// "No dependency pins, so SCA is impossible" is worth carrying to the
		// report and has no endpoint or host. Requiring a target left the agent
		// two options: invent an element id, or drop it into notes.
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "finding", title: "No dependency pins — SCA impossible", severity: "info" },
			ctx,
		);
		const findings = await ws.read("findings");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("info");
		expect(findings[0]?.target).toBeUndefined();
	});

	it("accepts a raw string target when no element id fits", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "finding", title: "Secrets printed to stdout", severity: "low", target: "modules/telegram.py:55" },
			ctx,
		);
		expect((await ws.read("findings"))[0]?.target).toBe("modules/telegram.py:55");
	});

	it("still requires a target on a hypothesis, which is a coverage coordinate", async () => {
		const { ctx, record } = await setup();
		await expect(
			record.execute({ kind: "hypothesis", statement: "x", class: "injection" }, ctx),
		).rejects.toThrow(/'target' is required/);
	});
});

describe("a missing target tells the agent how to resolve it", () => {
	it("names both routes and says not to ask the operator", async () => {
		// An error that only states a rule invites the agent to stop and ask, or to
		// give up and write a note. Neither is what should happen: it can record
		// the element itself, or name a raw one.
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "hypothesis", statement: "x", class: "injection" }, ctx))
			.rejects.toThrow(/raw string|Record the surface element first/);
		await expect(record.execute({ kind: "hypothesis", statement: "x", class: "injection" }, ctx))
			.rejects.toThrow(/Do not ask the operator/);
	});
});
