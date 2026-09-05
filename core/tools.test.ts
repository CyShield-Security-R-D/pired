import { describe, expect, it } from "vitest";
import type { Checklist, EndpointRecord } from "./ontology.ts";
import type { ToolContext, ToolDefinition } from "./ports.ts";
import { makeFakeServices, type FakeServices } from "./testing/fakes.ts";
import { computeEngagementStats } from "./stats.ts";
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
		expect(textOf(await recall.execute({ query: "gaps" }, ctx))).toMatch(/every applicable test case has a verdict/i);
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
		expect(gaps).toMatch(/showing 4 of 12 outstanding test cases/);
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
	it("keeps a finding that names a file but no line, and says what is missing", async () => {
		// This once threw. The extractor is told "never guess a line number; omit the
		// field instead", so it emits precisely this shape — and on one corpus target
		// eighteen findings were destroyed here, two of them naming answer-key files.
		// Warn, write, and let the model add the line; never trade a finding for it.
		const { ws, ctx, record } = await setup();
		const out = textOf(await record.execute(
			{ kind: "finding", title: "IDOR", severity: "high", target: "share.go" }, ctx,
		));
		expect(await ws.read("findings")).toHaveLength(1);
		expect(out).toMatch(/no line is/);
		expect(out).toMatch(/Recorded finding/);
	});

	it("says nothing about lines when the finding already has one", async () => {
		const { ctx, record } = await setup();
		const out = textOf(await record.execute(
			{ kind: "finding", title: "IDOR", severity: "high", target: "http/share.go:88" }, ctx,
		));
		expect(out).not.toMatch(/no line is/);
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

describe("recording something that is already recorded", () => {
	// Three paths produce repeats and none of them is the agent being careless:
	// the extractor re-reads a growing review buffer once a turn, context is
	// compacted mid-engagement, and subagents map the same surface concurrently.
	// A second row for one thing splits its coverage, and for a finding it is a
	// deliverable that reports the same bug twice.

	it("keeps one row for an endpoint recorded twice", async () => {
		const { ws, ctx, record } = await setup();
		const first = await record.execute({ kind: "endpoint", method: "POST", path: "/api/login" }, ctx);
		const again = await record.execute({ kind: "endpoint", method: "POST", path: "/api/login/" }, ctx);
		expect(await ws.read("inventory")).toHaveLength(1);
		expect((again.details as { id: string }).id).toBe((first.details as { id: string }).id);
		expect(textOf(again)).toMatch(/already recorded/i);
	});

	it("says which id the repeat matched, so the agent can update it", async () => {
		const { ctx, record } = await setup();
		await record.execute({ kind: "host", value: "app.acme.test" }, ctx);
		const again = await record.execute({ kind: "host", value: "APP.acme.test" }, ctx);
		expect(textOf(again)).toContain("id=id1");
	});

	it("writes no line at all when the repeat says nothing new", async () => {
		// The extractor offers the same rows every turn. Each one would otherwise
		// append a full copy of the ledger to the ledger, all of it collapsed again
		// on the next read.
		const { svc, ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		const after = await svc.fs.readFileIfExists(ws.storePath("findings"));
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		expect(await svc.fs.readFileIfExists(ws.storePath("findings"))).toBe(after);
	});

	it("folds what the repeat adds into the row it matched", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "endpoint", path: "/api/login", params: ["user"] }, ctx);
		await record.execute({ kind: "endpoint", path: "/api/login", params: ["password"], auth: "session" }, ctx);
		const inv = await ws.read("inventory");
		expect(inv).toHaveLength(1);
		expect(inv[0]).toMatchObject({ auth: "session", params: ["user", "password"] });
	});

	it("never lowers a severity on a repeat", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		await record.execute({ kind: "finding", title: "IDOR", severity: "info", target: "share.go:88", cwe: "CWE-639" }, ctx);
		const findings = await ws.read("findings");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: "high", cwe: "CWE-639" });
	});

	it("still lets an explicit id say exactly what it means", async () => {
		// The escape hatch: an update the agent asked for by id is last-write-wins,
		// including downward. Nothing else can lower a severity.
		const { ws, ctx, record } = await setup();
		const first = await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		const id = (first.details as { id: string }).id;
		await record.execute({ kind: "finding", id, severity: "low" }, ctx);
		expect((await ws.read("findings"))[0]?.severity).toBe("low");
	});

	it("keeps two findings on one line apart when their classes differ", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "Missing authentication on /admin", class: "authn", severity: "high", target: "app.py:42" }, ctx);
		await record.execute({ kind: "finding", title: "Missing authorization on /admin", class: "authz", severity: "high", target: "app.py:42" }, ctx);
		expect(await ws.read("findings")).toHaveLength(2);
	});

	it("reports a probable repeat rather than merging it away", async () => {
		// Same place, similar words, nothing that proves they are one bug. Losing a
		// real finding costs recall, which no later pass recovers, so the row is
		// written and the resemblance is reported.
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "Weak session cookie on login", severity: "medium", target: "app.py:42" }, ctx);
		const second = await record.execute({ kind: "finding", title: "Session cookie on login is weak", severity: "medium", target: "app.py:42" }, ctx);
		expect(await ws.read("findings")).toHaveLength(2);
		expect(textOf(second)).toMatch(/Possible duplicate of id1/);
	});

	it("does not write the same note twice", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "note", text: "login lacks SameSite" }, ctx);
		await record.execute({ kind: "note", text: "login lacks SameSite" }, ctx);
		const notes = await ws.readNotes();
		expect(notes.match(/login lacks SameSite/g)).toHaveLength(1);
	});

	it("keeps one row per coverage cell, so a refutation is not masked by its own proposal", async () => {
		// Coverage ranks in-progress above settled: a stale `proposed` beside the
		// `refuted` that resolved it leaves the cell reading as testing for the rest
		// of the engagement, and the work of clearing it never counts.
		const { ws, ctx, record } = await setup();
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: "/x" });
		await record.execute({ kind: "hypothesis", target: "e1", class: "sqli", statement: "the login query looks built by hand" }, ctx);
		await record.execute({
			kind: "hypothesis", target: "e1", class: "sqli", outcome: "refuted",
			statement: "every query on this route is parameterised through SQLAlchemy's bound parameters",
		}, ctx);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(1);
		expect(hyps[0]?.outcome).toBe("refuted");
	});

	it("does not let a repeat un-settle a cell", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "hypothesis", target: "e1", class: "sqli", outcome: "confirmed", statement: "landed a payload" }, ctx);
		await record.execute({ kind: "hypothesis", target: "e1", class: "sqli", statement: "worth another look" }, ctx);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(1);
		expect(hyps[0]?.outcome).toBe("confirmed");
	});

	it("collapses a bulk cross product that was recorded before", async () => {
		// Where repeats concentrate: the extractor re-offers one class verdict over
		// the whole surface once a turn, so a forty-element engagement would gain
		// forty rows a turn for reasoning it had already recorded.
		const { ws, ctx, record } = await setup();
		const args = {
			kind: "hypothesis", target: ["e1", "e2"], class: ["sqli", "ssti"], outcome: "refuted",
			statement: "no template rendering and no SQL string building anywhere on these routes",
		};
		await record.execute(args, ctx);
		const second = await record.execute(args, ctx);
		expect(await ws.read("hypotheses")).toHaveLength(4);
		expect((second.details as { created: string[] }).created).toEqual([]);
		expect(textOf(second)).toMatch(/already recorded/i);
	});

	it("does not record one cell twice when a target list names it two ways", async () => {
		const { ws, ctx, record } = await setup();
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h", method: "POST", path: "/api/login" });
		await record.execute({
			kind: "hypothesis", target: ["/api/login", "POST /api/login"], class: "sqli", outcome: "refuted",
			statement: "the login query is parameterised and takes no user-controlled identifiers",
		}, ctx);
		const hyps = await ws.read("hypotheses");
		expect(hyps).toHaveLength(1);
		expect(hyps[0]?.target).toBe("e1");
	});

	it("resolves the targets of a bulk hypothesis to element ids, not the labels the model typed", async () => {
		// Before this the bulk branch ran ahead of target resolution, so a list of
		// labels was stored as written: the same cell existed twice, once keyed on
		// an element id and once on prose, and the prose copy settled nothing.
		const { ws, ctx, record } = await setup();
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: "/a" });
		await ws.append("inventory", { v: 1, id: "e2", kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: "/b" });
		await record.execute({
			kind: "hypothesis", target: ["/a", "/b"], class: "ssti", outcome: "refuted",
			statement: "neither route renders a template with anything the caller supplied",
		}, ctx);
		expect((await ws.read("hypotheses")).map((h) => h.target).sort()).toEqual(["e1", "e2"]);
	});

	it("creates one element for a file two targets in the same call both name", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({
			kind: "hypothesis", target: ["auth.py:12", "auth.py:40"], class: "authn", outcome: "refuted",
			statement: "both call sites go through the same session check before doing any work",
		}, ctx);
		const inv = await ws.read("inventory");
		expect(inv).toHaveLength(1);
		expect(inv[0]).toMatchObject({ kind: "endpoint", path: "auth.py" });
	});
});

describe("notes are compared block by block", () => {
	it("still writes a short note that appears inside a longer one", async () => {
		// Substring matching would drop it: "no rate limiting" is a phrase from the
		// paragraph above it, and losing it is silent data loss.
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "note", text: "three problems on the login flow: no rate limiting, no lockout, no logging" }, ctx);
		await record.execute({ kind: "note", text: "no rate limiting" }, ctx);
		expect((await ws.readNotes()).match(/no rate limiting/g)).toHaveLength(2);
	});
});

describe("settling a finding without losing it", () => {
	// Three things an operator says about a finding — it is not real, the client
	// accepts the risk, set it aside — and before this the only one the ledger
	// could hear was "false-positive", which still counted as open work.
	it("takes a finding out of the open count while keeping the row", async () => {
		const { ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "finding", title: "Weak TLS ciphers", severity: "medium", target: "nginx.conf:12" }, ctx);
		const id = (made.details as { id: string }).id;
		await record.execute({ kind: "finding", id, status: "accepted-risk", reason: "client accepted, compensating WAF rule in place" }, ctx);
		const findings = await ws.read("findings");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ status: "accepted-risk", reason: "client accepted, compensating WAF rule in place" });
		const stats = await computeEngagementStats(ws);
		expect(stats.findingsTotal).toBe(0);
		expect(stats.disposed).toBe(1);
	});

	it("says how many are disposed of in the status rollup", async () => {
		const { ctx, record, recall } = await setup();
		const made = await record.execute({ kind: "finding", title: "Weak TLS ciphers", severity: "medium", target: "nginx.conf:12" }, ctx);
		await record.execute({ kind: "finding", id: (made.details as { id: string }).id, status: "ignored" }, ctx);
		expect(textOf(await recall.execute({ query: "status" }, ctx))).toMatch(/findings\s+0.*1 disposed/);
	});

	it("lists open findings before settled ones, with the reason attached", async () => {
		const { ctx, record, recall } = await setup();
		const made = await record.execute({ kind: "finding", title: "Weak TLS ciphers", severity: "medium", target: "nginx.conf:12" }, ctx);
		await record.execute({ kind: "finding", id: (made.details as { id: string }).id, status: "false-positive", reason: "cipher list is overridden downstream" }, ctx);
		await record.execute({ kind: "finding", title: "IDOR on share", severity: "high", target: "share.go:88" }, ctx);
		const lines = textOf(await recall.execute({ query: "findings" }, ctx)).split("\n");
		expect(lines[0]).toContain("IDOR on share");
		expect(lines[1]).toContain("cipher list is overridden downstream");
	});
});

describe("retiring a record", () => {
	// The format has carried a tombstone since v1 and nothing could write one, so
	// a row recorded by mistake stayed in the count and in the report forever.
	it("removes it from every view", async () => {
		const { ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		const id = (made.details as { id: string }).id;
		const gone = await record.execute({ kind: "finding", id, delete: true, reason: "recorded against the wrong engagement" }, ctx);
		expect(await ws.read("findings")).toHaveLength(0);
		expect(textOf(gone)).toMatch(/Deleted finding/);
		expect((await computeEngagementStats(ws)).findingsTotal).toBe(0);
	});

	it("keeps the line, so a wrong deletion is recoverable", async () => {
		const { svc, ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		await record.execute({ kind: "finding", id: (made.details as { id: string }).id, delete: true, reason: "duplicate of the one above" }, ctx);
		const raw = (await svc.fs.readFileIfExists(ws.storePath("findings"))) ?? "";
		expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
		expect(raw).toContain("\"deletedReason\":\"duplicate of the one above\"");
		expect(raw).toContain("\"title\":\"IDOR\"");
	});

	it("retires surface, and the coverage that surface carried goes with it", async () => {
		const { ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "endpoint", method: "GET", path: "/a" }, ctx);
		await record.execute({ kind: "endpoint", id: (made.details as { id: string }).id, delete: true }, ctx);
		expect(await ws.read("inventory")).toHaveLength(0);
	});

	it("refuses to delete without naming what to delete", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "finding", delete: true }, ctx)).rejects.toThrow(/'id' is required/);
	});

	it("refuses to delete something that is not there", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "finding", id: "nope", delete: true }, ctx)).rejects.toThrow(/no live finding/);
	});

	it("refuses to delete a note or an evidence file, which have no id", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "note", delete: true, id: "x" }, ctx)).rejects.toThrow(/not a ledger row/);
	});

	it("lets a deleted id be recorded again as something new", async () => {
		// A tombstone hides an id; it does not reserve the thing. Re-recording the
		// same route after deleting it has to work, or a mistaken delete is fatal.
		const { ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "endpoint", method: "GET", path: "/a" }, ctx);
		await record.execute({ kind: "endpoint", id: (made.details as { id: string }).id, delete: true }, ctx);
		await record.execute({ kind: "endpoint", method: "GET", path: "/a" }, ctx);
		expect(await ws.read("inventory")).toHaveLength(1);
	});
});

describe("scoring a finding", () => {
	// pired writes CVSS v4.0 and accepts v3.1. The two are not distinguishable by
	// eye, and nearly all the writing about CVSS is about v3.1 — so v3.1 metrics
	// are what a model reaches for even under a 4.0 label, and that reads as a
	// scored finding right up to the point a client checks it.
	const V4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N";

	it("accepts a v4.0 vector", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", cvss: V4 }, ctx);
		expect((await ws.read("findings"))[0]?.cvss).toBe(V4);
	});

	it("accepts a v3.1 vector, for the engagement that requires one", async () => {
		const { ws, ctx, record } = await setup();
		const v31 = "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N";
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", cvss: v31 }, ctx);
		expect((await ws.read("findings"))[0]?.cvss).toBe(v31);
	});

	it("refuses v3.1 metrics wearing a v4.0 label, and says where they went", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88",
			cvss: "CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/S:U/C:H/I:N/A:N",
		}, ctx)).rejects.toThrow(/Scope, which v4\.0 removed/);
	});

	it("offers dropping the vector, so a bad one never costs the finding", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", cvss: "nonsense",
		}, ctx)).rejects.toThrow(/omit 'cvss'/);
	});

	it("records a finding with no vector at all", async () => {
		const { ws, ctx, record } = await setup();
		await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
	});
});

describe("a finding written for the report", () => {
	it("says what is still missing, by id, without refusing the finding", async () => {
		// Not a rejection: a finding recorded without its business impact is still a
		// finding, and refusing it would trade the deliverable for the paperwork.
		const { ws, ctx, record } = await setup();
		const made = await record.execute({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88" }, ctx);
		expect(await ws.read("findings")).toHaveLength(1);
		expect(textOf(made)).toMatch(/Not yet report-ready: no description, no impact, no remediation/);
		expect(textOf(made)).toContain(`record id=${(made.details as { id: string }).id}`);
	});

	it("stops saying it once the three sections are there", async () => {
		const { ctx, record } = await setup();
		const done = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88",
			description: "no ownership check on the id parameter",
			impact: "any customer can read all 40,000 customer records",
			remediation: "scope the query to the session user",
		}, ctx);
		expect(textOf(done)).not.toMatch(/report-ready/);
	});

	it("hands back one finding in full, which is what a writing pass works from", async () => {
		// `findings` is a list, one line each. Before this the full text of a
		// finding was reachable only from the operator's TUI, so neither a rewrite
		// pass nor a delegated writer could read what it was about to rewrite.
		const { ctx, record, recall } = await setup();
		const made = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88",
			description: "no ownership check", impact: "40,000 records", cwe: "CWE-639",
		}, ctx);
		const detail = textOf(await recall.execute({ query: "finding", id: (made.details as { id: string }).id }, ctx));
		expect(detail).toContain("## Description\nno ownership check");
		expect(detail).toContain("## Business impact\n40,000 records");
		expect(detail).toContain("## Remediation\n(not recorded)");
		expect(detail).toContain("CWE-639");
	});

	it("asks for an id rather than guessing which finding", async () => {
		const { ctx, recall } = await setup();
		await expect(recall.execute({ query: "finding" }, ctx)).rejects.toThrow(/'id' is required/);
	});

	it("says plainly when the id is not there", async () => {
		const { ctx, recall } = await setup();
		expect(textOf(await recall.execute({ query: "finding", id: "nope" }, ctx))).toMatch(/No live finding nope/);
	});
});

describe("the matrix, described as a test plan", () => {
	// "Cell" is pired's private jargon; a test plan and its cases are vocabulary a
	// consultant and a model both already have. The tools say both, so the agent
	// can connect what it is being asked to record to what it already knows a
	// security engagement is made of.
	it("tells record that a cell is a test case a hypothesis executes", async () => {
		const { record } = await setup();
		const d = record.description ?? "";
		expect(d).toMatch(/TEST PLAN/);
		expect(d).toMatch(/Each cell of it is one test case/);
		expect(d).toMatch(/A hypothesis IS that test case, executed/);
		expect(d).toMatch(/Ruling a class out is a result, not a non-event/);
	});

	it("tells recall that gaps are the cases not run yet", async () => {
		const { recall } = await setup();
		const d = recall.description ?? "";
		expect(d).toMatch(/Coverage is a TEST PLAN/);
		expect(d).toMatch(/one cell per test case/);
		expect(d).toMatch(/gaps \(test cases not run yet/);
	});

	it("says it in the views too, not only in the schema", async () => {
		const { ws, ctx, recall } = await setup();
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [{ id: "authz", title: "Access control" }] } as Checklist);
		await ws.append("inventory", { v: 1, id: "e1", kind: "endpoint", createdAt: "t", host: "h", method: "GET", path: "/x" });
		expect(textOf(await recall.execute({ query: "gaps" }, ctx))).toMatch(/Test cases not yet settled/);
		expect(textOf(await recall.execute({ query: "next" }, ctx))).toMatch(/Next test case: e1 for authz/);
		// And the nudge that the whole mechanism depends on.
		expect(textOf(await recall.execute({ query: "next" }, ctx))).toMatch(/a refutation counts/);
	});
});

describe("evidence written where the shell was standing", () => {
	// `evidence/` names two directories. The workspace's is what a citation is
	// resolved against; the agent's shell sits in the target, so `curl >
	// evidence/y7.txt` writes a real file the check never looked at — and the
	// agent was told its own artifact was a fabrication.

	it("adopts a file from the working directory and cites where it now lives", async () => {
		const { svc, ws, ctx, record } = await setup();
		await svc.fs.writeFile("/target/evidence/y7-idor.txt", "HTTP/1.1 200 OK — user 1001 leaked");
		const made = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88",
			evidence: ["evidence/y7-idor.txt"],
		}, ctx);
		// Copied into the workspace, which is what outlives the session.
		expect(await ws.readRelative("evidence/y7-idor.txt")).toContain("user 1001 leaked");
		expect((await ws.read("findings"))[0]?.evidence).toEqual(["evidence/y7-idor.txt"]);
		expect(textOf(made)).toMatch(/Evidence copied into the engagement workspace/);
	});

	it("rewrites the citation when the path it was written under differs", async () => {
		const { svc, ws, ctx, record } = await setup();
		await svc.fs.writeFile("/target/out/scan.txt", "open 6379/tcp redis");
		await record.execute({
			kind: "finding", title: "Unauth Redis", severity: "high", target: "10.0.0.4:6379",
			evidence: ["out/scan.txt"],
		}, ctx);
		const cited = (await ws.read("findings"))[0]?.evidence ?? [];
		expect(cited).toEqual(["evidence/out_scan.txt"]);
		expect(await ws.readRelative(cited[0] as string)).toBe("open 6379/tcp redis");
	});

	it("leaves a path that already resolves in the workspace alone", async () => {
		const { ctx, record } = await setup();
		const saved = await record.execute({ kind: "evidence", name: "y7.txt", content: "proof" }, ctx);
		const rel = (saved.details as { path: string }).path;
		const made = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", evidence: [rel],
		}, ctx);
		expect(textOf(made)).not.toMatch(/copied into the engagement workspace/);
	});

	it("adopts the single path a hypothesis cites", async () => {
		const { svc, ws, ctx, record } = await setup();
		await svc.fs.writeFile("/target/evidence/probe.txt", "no template rendering observed");
		await record.execute({
			kind: "hypothesis", target: "e1", class: "ssti", outcome: "refuted",
			statement: "no template rendering of user input anywhere on this route",
			evidence: "evidence/probe.txt",
		}, ctx);
		expect((await ws.read("hypotheses"))[0]?.evidence).toBe("evidence/probe.txt");
		expect(await ws.readRelative("evidence/probe.txt")).toContain("no template rendering");
	});

	it("still refuses a path that exists in neither place, and says where it looked", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "share.go:88",
			evidence: ["evidence/never-written.txt"],
		}, ctx)).rejects.toThrow(/Looked in the engagement workspace \(\/ws\/acme\)/);
	});

	it("will not adopt its way out of the working directory", async () => {
		// "evidence" is not a licence to copy an arbitrary file into a document a
		// client reads.
		const { svc, ctx, record } = await setup();
		await svc.fs.writeFile("/etc/shadow", "root:x");
		await expect(record.execute({
			kind: "finding", title: "x", severity: "low", target: "a.py:1", evidence: ["../../etc/shadow"],
		}, ctx)).rejects.toThrow(/do not resolve/);
		await expect(record.execute({
			kind: "finding", title: "x", severity: "low", target: "a.py:1", evidence: ["/etc/shadow"],
		}, ctx)).rejects.toThrow(/do not resolve/);
	});

	it("does not copy a binary through a text port", async () => {
		// The Fs port moves text; a screenshot round-tripped through it is a
		// corrupted screenshot cited as proof. Better refused and named.
		const { svc, ctx, record } = await setup();
		await svc.fs.writeFile("/target/shot.png", `PNG${String.fromCharCode(0)}IHDR`);
		await expect(record.execute({
			kind: "finding", title: "x", severity: "low", target: "a.py:1", evidence: ["shot.png"],
		}, ctx)).rejects.toThrow(/do not resolve/);
	});
});

describe("target model", () => {
	it("records a section and says what is still blank", async () => {
		const { ws, ctx, record } = await setup();
		const out = textOf(await record.execute(
			{ kind: "model", section: "what", text: "A payments API. Holds balances, moves money between customers." }, ctx,
		));
		expect(out).toMatch(/target model updated/i);
		expect(out).toMatch(/still blank/i);
		expect(await ws.readModel()).toContain("moves money");
	});

	it("names the sections when one is missing or misspelled", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "model", text: "..." }, ctx)).rejects.toThrow(/invariants/);
		await expect(record.execute({ kind: "model", section: "architecture", text: "..." }, ctx))
			.rejects.toThrow(/unknown section/i);
	});

	it("points invariants at the hypotheses they generate", async () => {
		const { ctx, record } = await setup();
		const out = textOf(await record.execute(
			{ kind: "model", section: "invariants", text: "A balance never goes negative. A refund never exceeds the payment." }, ctx,
		));
		expect(out).toMatch(/hypothesis/i);
	});

	it("cannot be deleted like a ledger row", async () => {
		const { ctx, record } = await setup();
		await expect(record.execute({ kind: "model", id: "m1", delete: true }, ctx)).rejects.toThrow(/not a ledger row/i);
	});

	it("recall hands back the model, or tells you how to write one", async () => {
		const { ctx, record, recall } = await setup();
		expect(textOf(await recall.execute({ query: "model" }, ctx))).toMatch(/no target model/i);
		await record.execute({ kind: "model", section: "actors", text: "customer, merchant, admin" }, ctx);
		expect(textOf(await recall.execute({ query: "model" }, ctx))).toContain("merchant");
	});
});

describe("macro digest on record", () => {
	async function seeded(): Promise<{ ws: Workspace; ctx: ToolContext; record: ToolDefinition }> {
		const { ws, ctx, record } = await setup();
		await ws.writeChecklist({
			v: 1, targetType: "web",
			classes: [{ id: "authz", title: "Access control" }, { id: "sqli", title: "SQL injection" }],
		} as Checklist);
		return { ws, ctx, record };
	}

	it("reports where the engagement stands on every ledger write", async () => {
		const { ctx, record } = await seeded();
		const out = textOf(await record.execute({ kind: "endpoint", path: "/api/user", host: "h1" }, ctx));
		expect(out).toMatch(/Engagement: surface 1/);
		expect(out).toMatch(/coverage 0%/);
		expect(out).toMatch(/test cases outstanding/);
	});

	it("moves with the ledger, so it cannot read as boilerplate", async () => {
		const { ctx, record } = await seeded();
		await record.execute({ kind: "endpoint", path: "/api/user", host: "h1" }, ctx);
		const second = textOf(await record.execute({ kind: "endpoint", path: "/api/admin", host: "h1" }, ctx));
		expect(second).toMatch(/surface 2/);
		const withFinding = textOf(await record.execute(
			{ kind: "finding", title: "IDOR on /api/user", severity: "high", target: "/api/user", class: "authz" }, ctx,
		));
		expect(withFinding).toMatch(/1 findings/);
	});

	it("derives from the same view the operator sees", async () => {
		const { ws, ctx, record } = await seeded();
		await record.execute({ kind: "endpoint", path: "/api/user", host: "h1" }, ctx);
		const out = textOf(await record.execute({ kind: "endpoint", path: "/api/admin", host: "h1" }, ctx));
		const stats = await computeEngagementStats(ws);
		expect(out).toContain(`coverage ${stats.coveragePct}%`);
		expect(out).toContain(`surface ${stats.surface}`);
	});

	it("asks for a target model once there is a surface, and stops once there is one", async () => {
		const { ctx, record } = await seeded();
		await record.execute({ kind: "endpoint", path: "/a", host: "h1" }, ctx);
		await record.execute({ kind: "endpoint", path: "/b", host: "h1" }, ctx);
		const third = textOf(await record.execute({ kind: "endpoint", path: "/c", host: "h1" }, ctx));
		expect(third).toMatch(/Nothing recorded yet about what this system does/);
		await record.execute({ kind: "model", section: "what", text: "A payments API." }, ctx);
		const after = textOf(await record.execute({ kind: "endpoint", path: "/d", host: "h1" }, ctx));
		expect(after).toMatch(/Engagement: surface 4/);
		// The nudge that ends: a standing instruction repeated forever is wallpaper.
		expect(after).not.toMatch(/Nothing recorded yet/);
	});

	it("never turns a recorded finding into a tool error", async () => {
		const { ws, ctx, record } = await seeded();
		// A workspace whose coverage cannot be derived must still accept the write.
		await ws.writeChecklist({ v: 1, targetType: "web", classes: [] } as unknown as Checklist);
		const out = textOf(await record.execute({ kind: "finding", title: "hardcoded key", severity: "medium" }, ctx));
		expect(out).toMatch(/Recorded finding/);
	});
});

/**
 * Confirming a hypothesis and writing a finding are separate acts, and only the
 * second reaches the client. Across a whole engagement not one of twenty
 * findings carried a hypothesisId, so nothing linked a finding to the reasoning
 * that produced it. Both nudges inform; neither refuses. ADR-004.
 */
describe("joining a finding to the reasoning behind it", () => {
	it("says what still has to happen when a hypothesis is confirmed", async () => {
		const { ctx, record } = await setup();
		const res = await record.execute({
			kind: "hypothesis", statement: "dag_id is not scoped", target: "e1", class: "authz", outcome: "confirmed",
		}, ctx);
		expect(textOf(res)).toContain("only a finding reaches the report");
	});

	it("stays quiet about it when the hypothesis was refuted", async () => {
		// Refuting is finished work. Nothing is owed to the report for it beyond
		// the coverage section, which the export writes on its own.
		const { ctx, record } = await setup();
		const res = await record.execute({
			kind: "hypothesis", outcome: "refuted", target: "e1", class: "authz",
			statement: "the route decorator resolves the caller and compares owner_id before the query runs",
		}, ctx);
		expect(textOf(res)).not.toContain("only a finding reaches the report");
	});

	it("names the hypothesis a finding looks like the write-up of", async () => {
		const { ctx, record } = await setup();
		const hyp = await record.execute({
			kind: "hypothesis", statement: "dag_id is not scoped", target: "e1", class: "authz", outcome: "confirmed",
		}, ctx);
		const id = (hyp.details as { ids?: string[]; id?: string }).ids?.[0] ?? (hyp.details as { id: string }).id;
		const res = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "e1", class: "authz",
		}, ctx);
		expect(textOf(res)).toContain(`hypothesisId=${id}`);
	});

	it("says nothing when the finding already carries the link", async () => {
		const { ctx, record } = await setup();
		await record.execute({
			kind: "hypothesis", statement: "dag_id is not scoped", target: "e1", class: "authz", outcome: "confirmed",
		}, ctx);
		const res = await record.execute({
			kind: "finding", title: "IDOR", severity: "high", target: "e1", class: "authz", hypothesisId: "whatever",
		}, ctx);
		expect(textOf(res)).not.toContain("Link them with");
	});

	it("does not suggest a hypothesis from a different class", async () => {
		const { ctx, record } = await setup();
		await record.execute({
			kind: "hypothesis", statement: "dag_id is not scoped", target: "e1", class: "authz", outcome: "confirmed",
		}, ctx);
		const res = await record.execute({
			kind: "finding", title: "SQLi", severity: "high", target: "e1", class: "sqli",
		}, ctx);
		expect(textOf(res)).not.toContain("Link them with");
	});
});

