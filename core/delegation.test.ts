import { describe, expect, it } from "vitest";
import type { BlockerRecord, EndpointRecord, HypothesisRecord, LootRecord } from "./ontology.ts";
import { makeFakeServices } from "./testing/fakes.ts";
import { boundedText, workerContext } from "./delegation.ts";
import { createRecallTool } from "./tools.ts";
import { Workspace } from "./workspace.ts";

const DIR = "/ws/acme";

async function setup() {
	const services = makeFakeServices();
	const ws = await Workspace.open(DIR, "acme", services);
	return { services, ws };
}

function endpoint(id: string, path: string, file: string, createdAt: string): EndpointRecord {
	return { v: 1, id, kind: "endpoint", createdAt, host: "h1", method: "GET", path, file };
}

describe("worker context", () => {
	it("follows a referenced claim to its surface and matches exact source paths with line numbers", async () => {
		const { services, ws } = await setup();
		const at = services.clock.nowIso();
		await ws.append("inventory", endpoint("e-auth", "/account", "src/account.ts", at));
		await ws.append("inventory", endpoint("e-other", "/health", "src/health.ts", at));
		const claim: HypothesisRecord = { v: 1, id: "h-auth", kind: "hypothesis", createdAt: at, statement: "Account lookup may miss ownership checks", target: "e-auth", class: "authz", outcome: "testing" };
		await ws.append("hypotheses", claim);
		const context = await workerContext(ws, ["h-auth"]);
		expect(context).toContain('"id":"e-auth"');
		expect(context).toContain('"id":"h-auth"');
		expect(context).not.toContain('"id":"e-other"');

		const byPath = await workerContext(ws, ["src/account.ts:27"]);
		expect(byPath).toContain('"id":"e-auth"');
		expect(byPath).not.toContain('"id":"e-other"');
	});

	it("includes claims related to the referenced surface and excludes unrelated claims", async () => {
		const { services, ws } = await setup();
		const at = services.clock.nowIso();
		await ws.append("inventory", endpoint("e-user", "/user", "src/user.ts", at));
		await ws.append("inventory", endpoint("e-health", "/health", "src/health.ts", at));
		const makeHypothesis = (id: string, target: string): HypothesisRecord => ({
			v: 1, id, kind: "hypothesis", createdAt: at, statement: `Claim ${id}`, target, class: "authz", outcome: "proposed",
		});
		await ws.append("hypotheses", makeHypothesis("h-user", "e-user"));
		await ws.append("hypotheses", makeHypothesis("h-health", "e-health"));
		const context = await workerContext(ws, ["e-user"]);
		expect(context).toContain('"id":"h-user"');
		expect(context).not.toContain('"id":"h-health"');
		expect(context).not.toContain('"id":"e-health"');
	});

	it("returns a bounded live ledger snapshot, omitting conversation history and loot secrets", async () => {
		const { services, ws } = await setup();
		await ws.writeModelSection("overview", "x".repeat(100_000));
		const at = services.clock.nowIso();
		await ws.append("inventory", endpoint("e-big", "/" + "p".repeat(100_000), "src/" + "f".repeat(100_000), at));
		const loot: LootRecord = { v: 1, id: "l-secret", kind: "loot", createdAt: at, handle: "cred:admin", type: "password", secret: "TOP-SECRET-DO-NOT-COPY" };
		await ws.append("loot", loot);
		const context = await workerContext(ws);
		expect(context.length).toBeLessThan(20_000);
		expect(context).toContain("bounded snapshot");
		expect(context).not.toContain("TOP-SECRET-DO-NOT-COPY");
		expect(context).not.toContain("conversation history");
	});

	it("surfaces open blocker notices without exposing answered blockers", async () => {
		const { services, ws } = await setup();
		const at = services.clock.nowIso();
		const blocker = (id: string, status: BlockerRecord["status"], question: string): BlockerRecord => ({
			v: 1, id, kind: "blocker", createdAt: at, type: "decision", question, priority: "high", status,
		});
		await ws.append("blockers", blocker("b-open", "open", "Need the staging account"));
		await ws.append("blockers", blocker("b-done", "answered", "Old resolved question"));
		const context = await workerContext(ws);
		expect(context).toContain("Need the staging account");
		expect(context).not.toContain("Old resolved question");
	});

	it("refreshes from disk on every call so workers see new shared records", async () => {
		const { services, ws } = await setup();
		const before = await workerContext(ws, ["e-live"]);
		await ws.append("inventory", endpoint("e-live", "/new", "src/new.ts", services.clock.nowIso()));
		const after = await workerContext(ws, ["e-live"]);
		expect(before).not.toContain('"id":"e-live"');
		expect(after).toContain('"id":"e-live"');
	});

	it("exposes the live bounded snapshot through recall query=context with refs", async () => {
		const { services, ws } = await setup();
		await ws.append("inventory", endpoint("e-recall", "/settings", "src/settings.ts", services.clock.nowIso()));
		const recall = createRecallTool({ workspace: ws });
		const result = await recall.execute({ query: "context", refs: ["src/settings.ts:44"] }, { cwd: "/target", services });
		const rendered = result.content.map((item) => item.type === "text" ? item.text : "").join("");
		expect(rendered).toContain('"id":"e-recall"');
		expect(rendered).not.toContain("src/health.ts");
	});
});

describe("boundedText", () => {
	it("keeps short text and clips huge text without exceeding the limit", () => {
		expect(boundedText("short", 10)).toBe("short");
		expect(boundedText("abcdefghij", 8, "...more")).toBe("a...more");
		expect(boundedText("x".repeat(100_000), 32).length).toBe(32);
		expect(boundedText("x", 0)).toBe("");
	});
});
