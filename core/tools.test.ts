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

	describe("a class the checklist does not know", () => {
		// The valid ids live in the engagement's checklist, which the tool schema
		// cannot show, so the model guesses. On a live run it guessed
		// "code-injection" for `codeinj` and "traversal" for `pathtrav`; nothing
		// rejected either, they settled no cell, and a third of the session went on
		// inferring that from a coverage percentage that would not move.
		async function withChecklist(): Promise<{ ctx: ToolContext; record: ToolDefinition }> {
			const { ws, ctx, record } = await setup();
			await ws.writeChecklist({
				v: 1, targetType: "code-review",
				classes: [{ id: "codeinj", title: "Code injection" }, { id: "pathtrav", title: "Path traversal" }],
			} as Checklist);
			return { ctx, record };
		}

		it("is rejected rather than written to a cell nothing matches", async () => {
			const { ctx, record } = await withChecklist();
			await expect(record.execute(
				{ kind: "hypothesis", statement: "eval on user input", target: "e1", class: "code-injection" }, ctx,
			)).rejects.toThrow(/unknown checklist class/i);
		});

		it("names the valid ids and the closest match", async () => {
			const { ctx, record } = await withChecklist();
			await expect(record.execute(
				{ kind: "hypothesis", statement: "s", target: "e1", class: "traversal" }, ctx,
			)).rejects.toThrow(/did you mean 'pathtrav'/);
			await expect(record.execute(
				{ kind: "hypothesis", statement: "s", target: "e1", class: "code-injection" }, ctx,
			)).rejects.toThrow(/codeinj, pathtrav/);
		});

		it("accepts the real id", async () => {
			const { ctx, record } = await withChecklist();
			const out = await record.execute(
				{ kind: "hypothesis", statement: "s", target: "e1", class: "codeinj" }, ctx,
			);
			expect(JSON.stringify(out)).toMatch(/Recorded/i);
		});

		it("stays out of the way when no checklist is seeded", async () => {
			const { ctx, record } = await setup();
			const out = await record.execute(
				{ kind: "hypothesis", statement: "s", target: "e1", class: "whatever" }, ctx,
			);
			expect(JSON.stringify(out)).toMatch(/Recorded/i);
		});
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

	it("hands the agent the matrix the operator sees, not a count line", async () => {
		const { ws, ctx, recall } = await seed();
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "authz", outcome: "confirmed" });
		const out = textOf(await recall.execute({ query: "coverage" }, ctx));
		// One row per class, named — the old output said how many cells were
		// untested but never which, so "where are the holes" was operator-only.
		expect(out).toContain("Access control");
		expect(out).toContain("SQL injection");
		// The settled cell renders as its glyph, and the legend explains it.
		expect(out).toContain("▲");
		expect(out).toMatch(/vulnerable/i);
		expect(out).toMatch(/untested/i);
	});

	it("reports the engagement rollup the panel shows", async () => {
		const { ws, ctx, recall } = await seed();
		await ws.append("findings", { v: 1, id: "f1", kind: "finding", createdAt: "t", title: "IDOR", severity: "high", target: "e1", status: "open" });
		const out = textOf(await recall.execute({ query: "status" }, ctx));
		expect(out).toMatch(/surface\s+1 element/);
		expect(out).toMatch(/coverage\s+\d+%/);
		expect(out).toMatch(/findings\s+1 \(high 1\)/);
		expect(out).toMatch(/blockers\s+0 open/);
	});

	it("shows per-element coverage, with the class order the bar is in", async () => {
		const { ws, ctx, recall } = await seed();
		await ws.append("hypotheses", { v: 1, id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "authz", outcome: "refuted" });
		const out = textOf(await recall.execute({ query: "surface" }, ctx));
		expect(out).toContain("/api/user");
		expect(out).toContain("●");                      // the refuted cell
		expect(out).toMatch(/bar columns, in order: authz, sqli/);
		expect(out).toMatch(/legend:/);
	});

	it("says plainly when there is no surface to cover", async () => {
		const { ctx, recall } = await setup();
		expect(textOf(await recall.execute({ query: "surface" }, ctx))).toMatch(/no surface recorded yet/);
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
			{ kind: "hypothesis", target: "e1", class: ["xss", "ssti"], outcome: "refuted", statement: "no HTML sink: every response is JSON encoded by the framework" },
			ctx,
		);
		// One call, a whole row of the matrix settled — the ergonomics fix exists
		// because doing this per-cell is hundreds of calls on a real engagement.
		// Both cells now read as settled in the rendered matrix (● is "clear").
		const matrix = textOf(await recall.execute({ query: "coverage" }, ctx));
		expect(matrix).toMatch(/XSS\s+●/);
		expect(matrix).toMatch(/SSTI\s+●/);
		expect(textOf(await recall.execute({ query: "status" }, ctx))).toMatch(/coverage\s+100%/);
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
			{ kind: "hypothesis", target: '["e1","e2"]', class: "sqli", outcome: "refuted", statement: "parameterized on both: each query binds its arguments via the driver" },
			ctx,
		);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(2);
		expect(hyps.map((h) => h.target).sort()).toEqual(["e1", "e2"]);
	});

	it("accepts a comma-separated list", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "hypothesis", target: "e1", class: "xss, ssti, xxe", outcome: "refuted", statement: "no HTML sink: every response is JSON encoded by the framework" },
			ctx,
		);
		expect((await ws.read("hypotheses")).map((h) => h.class).sort()).toEqual(["ssti", "xss", "xxe"]);
	});

	it("leaves a single plain value alone", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute(
			{ kind: "hypothesis", target: "e1", class: "sqli", outcome: "refuted", statement: "bound parameter: the query uses $1 placeholders throughout" },
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

describe("an empty ledger is not a finished engagement", () => {
	// Coverage is measured over the surface that was RECORDED, so a run that
	// recorded none has a denominator of zero. `gaps` and `next` used to read that
	// as "coverage complete" and "no actionable work" — certifying as done the one
	// run that never started. The operator's panel has always said "no surface
	// recorded yet"; the agent, the only party that can act on it, was told the
	// opposite.
	async function withChecklistOnly(): Promise<{ ctx: ToolContext; recall: ToolDefinition }> {
		const { ws, ctx, recall } = await setup();
		await ws.writeChecklist({
			v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }],
		} as Checklist);
		return { ctx, recall };
	}

	it("does not call an unrecorded surface 'complete'", async () => {
		const { ctx, recall } = await withChecklistOnly();
		const gaps = textOf(await recall.execute({ query: "gaps" }, ctx));
		expect(gaps).not.toMatch(/complete/i);
		expect(gaps).toMatch(/no surface recorded yet/i);
	});

	it("does not offer 'no actionable work' when nothing was ever recorded", async () => {
		const { ctx, recall } = await withChecklistOnly();
		const next = textOf(await recall.execute({ query: "next" }, ctx));
		expect(next).not.toMatch(/complete|no actionable work/i);
		expect(next).toMatch(/record inventory/i);
	});

	it("still reports genuine completion once a surface exists and is settled", async () => {
		const { ws, ctx, recall, record } = await setup();
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }] } as Checklist);
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h1", method: "GET", path: "/x" });
		await record.execute({ kind: "hypothesis", statement: "no HTML sink: every response is JSON encoded by the framework", target: "e1", class: "authz", outcome: "refuted" }, ctx);
		expect(textOf(await recall.execute({ query: "gaps" }, ctx))).toMatch(/every askable cell is settled/i);
	});
});

describe("a capped list says what it left out", () => {
	// Every recall list is capped. Rendered without a notice a capped list reads
	// as the whole answer: on a 500-endpoint engagement `gaps` returned fifty
	// lines of 2,250 and looked like a complete, short list of remaining work.
	it("names the total and the ordering when it truncates", async () => {
		const { ws, ctx, recall } = await setup();
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }] } as Checklist);
		for (let i = 0; i < 12; i++) {
			await ws.append("inventory", { v: 1, id: `e${i}`, kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: `/r/${i}` });
		}
		const surface = textOf(await recall.execute({ query: "surface", limit: 5 }, ctx));
		expect(surface).toMatch(/showing 5 of 12 elements \(least-settled first\)/);

		const gaps = textOf(await recall.execute({ query: "gaps", limit: 4 }, ctx));
		expect(gaps).toMatch(/showing 4 of 12 gaps/);
	});

	it("stays quiet when nothing was left out", async () => {
		const { ws, ctx, recall } = await setup();
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: "/x" });
		expect(textOf(await recall.execute({ query: "inventory" }, ctx))).not.toMatch(/showing/);
	});
});

describe("a hypothesis creates the surface it names", () => {
	// Coverage is classes x RECORDED surface, so a hypothesis targeting something
	// nobody declared settles nothing. Take eight recorded three tech tags and
	// then wrote seventeen hypotheses against files — the matrix had no cells at
	// all and the panel read 0% beside a full ledger. Requiring the agent to
	// pre-declare a thing before it may test it is the tool imposing its
	// bookkeeping on the work.
	async function seeded(): Promise<{ ws: Workspace; ctx: ToolContext; record: ToolDefinition; recall: ToolDefinition }> {
		const { ws, ctx, record, recall } = await setup();
		await ws.writeChecklist({
			v: 1, targetType: "code-review",
			classes: [{ id: "secrets", title: "Hardcoded secrets" }, { id: "authn", title: "Broken authentication" }],
		} as Checklist);
		return { ws, ctx, record, recall };
	}

	it("records the file a prose target names, and points the hypothesis at it", async () => {
		const { ws, ctx, record } = await seeded();
		await record.execute(
			{ kind: "hypothesis", statement: "hardcoded key", class: "secrets", outcome: "confirmed",
				target: "app.py line 17 SECRET_KEY = 'supersecret'" }, ctx,
		);
		const inv = await ws.read("inventory");
		expect(inv.map((r) => (r as unknown as { path?: string }).path)).toContain("app.py");
		const hyp = await ws.read("hypotheses");
		// The target is now an id, which is what settles a cell.
		expect(inv.some((r) => r.id === hyp[0]?.target)).toBe(true);
	});

	it("reuses the element on the next hypothesis rather than duplicating it", async () => {
		const { ws, ctx, record } = await seeded();
		for (const cls of ["secrets", "authn"]) {
			await record.execute(
				{ kind: "hypothesis", statement: `${cls}: no reachable sink in this file, checked every call site`, class: cls, outcome: "refuted", target: "app.py the login flow" }, ctx,
			);
		}
		const paths = (await ws.read("inventory")).map((r) => (r as unknown as { path?: string }).path);
		expect(paths.filter((p) => p === "app.py")).toHaveLength(1);
	});

	it("resolves a route written with a method and trailing noise", async () => {
		const { ws, ctx, record } = await seeded();
		await record.execute({ kind: "endpoint", method: "POST", path: "/api/login" }, ctx);
		await record.execute(
			{ kind: "hypothesis", statement: "f-string SQL", class: "authn", outcome: "confirmed", target: "POST /api/login (line 30)" }, ctx,
		);
		const inv = await ws.read("inventory");
		// One endpoint, not two: the existing element was matched, not recreated.
		expect(inv).toHaveLength(1);
		expect((await ws.read("hypotheses"))[0]?.target).toBe(inv[0]?.id);
	});

	it("leaves a target that names nothing as written, rather than inventing an element", async () => {
		const { ws, ctx, record } = await seeded();
		await record.execute(
			{ kind: "hypothesis", statement: "no HTML sink: every response is JSON encoded", class: "authn", outcome: "inconclusive", target: "the login flow generally" }, ctx,
		);
		expect(await ws.read("inventory")).toHaveLength(0);
		expect((await ws.read("hypotheses"))[0]?.target).toBe("the login flow generally");
	});

	it("does not create surface for a finding, which may point at anything", async () => {
		const { ws, ctx, record } = await seeded();
		await record.execute(
			{ kind: "finding", title: "hardcoded key", severity: "high", target: "config/settings.py:4" }, ctx,
		);
		expect(await ws.read("inventory")).toHaveLength(0);
	});
});

describe("clearing a cell costs as much as reporting a bug", () => {
	// Reporting a bug requires a file, a line, a CWE and a severity. Clearing a
	// class required a sentence, which made "it is safe" structurally cheaper than
	// "it is broken" — the wrong way round for a tool whose coverage number is
	// built out of refutations. On filebrowser, "The reviewer confirmed this is by
	// design with proper access controls" cleared 103 cells over the very code the
	// advisory was about.
	it("refuses a refutation that asserts rather than explains", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute(
			{ kind: "hypothesis", target: "e1", class: "sqli", outcome: "refuted", statement: "safe" }, ctx,
		)).rejects.toThrow(/needs to say what was checked/);
	});

	it("says how many cells the call would have cleared", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute(
			{ kind: "hypothesis", target: ["e1", "e2", "e3"], class: "sqli", outcome: "refuted", statement: "fine" }, ctx,
		)).rejects.toThrow(/clears 3 cells at once/);
	});

	it("accepts one that names the mechanism", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({
			kind: "hypothesis", target: "e1", class: "sqli", outcome: "refuted",
			statement: "every query goes through the ORM with bound parameters; no string concatenation reaches the driver",
		}, ctx);
		expect(await ws.read("hypotheses")).toHaveLength(1);
	});

	it("leaves confirmations and open outcomes alone", async () => {
		// The bar exists because a refutation CLEARS a cell. A confirmation is
		// evidenced by the finding it becomes.
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "hypothesis", target: "e1", class: "sqli", outcome: "confirmed", statement: "f-string" }, ctx);
		await record.execute({ kind: "hypothesis", target: "e2", class: "sqli", outcome: "proposed", statement: "check" }, ctx);
		expect(await ws.read("hypotheses")).toHaveLength(2);
	});
});

describe("a finding must be locatable", () => {
	it("refuses a finding that names a file but no line", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute(
			{ kind: "finding", title: "IDOR", severity: "high", target: "share.go" }, ctx,
		)).rejects.toThrow(/no line is/);
	});

	it("accepts file:line in the target", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "http/share.go:88" }, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
	});

	it("accepts a line stated in the description instead", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "http/share.go",
			description: "the ownership check is missing at line 88",
		}, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
	});

	it("leaves a finding that names no source file alone", async () => {
		// "the login flow", a component, a design gap — not everything has a line.
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "No rate limiting anywhere", severity: "medium" }, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
	});
});
