import { describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage.ts";
import { describePlan, type Ledgers, planCompaction } from "./dedupe.ts";
import type { LedgerRecord } from "./ontology.ts";
import { makeFakeServices } from "./testing/fakes.ts";
import { Workspace } from "./workspace.ts";

const NOW = "2026-09-01T12:00:00.000Z";

function ledgers(over: Partial<Ledgers> = {}): Ledgers {
	return { inventory: [], hypotheses: [], findings: [], blockers: [], loot: [], ...over };
}

/** A record as the ledger holds it, at a stated age. */
function row(fields: Record<string, unknown>, id: string, createdAt = "t0"): LedgerRecord {
	return { v: 1, id, createdAt, ...fields } as unknown as LedgerRecord;
}

describe("planning a sweep", () => {
	it("finds nothing to do in a clean workspace", () => {
		const plan = planCompaction(ledgers({
			inventory: [row({ kind: "endpoint", method: "GET", path: "/a" }, "e1")],
		}), NOW);
		expect(plan.groups).toEqual([]);
		expect(plan.writes).toEqual([]);
		expect(describePlan(plan)[0]).toMatch(/No duplicates/);
	});

	it("keeps the oldest row, with its id and its createdAt", () => {
		// Anything already pointing at a row keeps pointing at it, and the history
		// of when the surface was first seen survives the repair.
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e1", "t0"),
				row({ kind: "endpoint", method: "GET", path: "/a/" }, "e2", "t9"),
			],
		}), NOW);
		expect(plan.groups).toHaveLength(1);
		expect(plan.groups[0]).toMatchObject({ store: "inventory", kind: "endpoint" });
		const written = plan.writes[0]?.records ?? [];
		expect(written[0]).toMatchObject({ id: "e1", createdAt: "t0", updatedAt: NOW });
		expect(written[1]).toMatchObject({ id: "e2", deleted: true, duplicateOf: "e1" });
	});

	it("collects three copies into one group, not two", () => {
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "host", value: "app.test" }, "h1"),
				row({ kind: "host", value: "APP.test" }, "h2"),
				row({ kind: "host", value: "https://app.test/" }, "h3"),
			],
		}), NOW);
		expect(plan.groups).toHaveLength(1);
		expect(plan.groups[0]?.losers.map((l) => l.id)).toEqual(["h2", "h3"]);
		expect(plan.removed).toBe(2);
	});

	it("folds what the losers carried into the keeper", () => {
		const plan = planCompaction(ledgers({
			findings: [
				row({ kind: "finding", title: "IDOR", severity: "low", target: "share.go:88", status: "open" }, "f1"),
				row({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", cwe: "CWE-639", status: "open" }, "f2"),
			],
		}), NOW);
		expect(plan.writes[0]?.records[0]).toMatchObject({ id: "f1", severity: "high", cwe: "CWE-639" });
	});

	it("moves every reference onto the surviving id", () => {
		// Tombstoning an element that hypotheses target would strand their cells:
		// they would point at a row no read returns, and the matrix would quietly
		// lose the work that was done against it.
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e1"),
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e2"),
			],
			hypotheses: [row({ kind: "hypothesis", target: "e2", class: "sqli", outcome: "refuted", statement: "parameterised" }, "y1")],
			findings: [row({ kind: "finding", title: "x", severity: "low", target: "e2", status: "open" }, "f1")],
			loot: [row({ kind: "loot", handle: "cred:a", secret: "s", target: "e2" }, "l1")],
		}), NOW);
		const written = (store: string) => plan.writes.find((w) => w.store === store)?.records ?? [];
		expect(written("hypotheses")[0]).toMatchObject({ id: "y1", target: "e1" });
		expect(written("findings")[0]).toMatchObject({ id: "f1", target: "e1" });
		expect(written("loot")[0]).toMatchObject({ id: "l1", target: "e1" });
		expect(plan.retargeted).toBe(3);
	});

	it("moves a blocker that gates a cell, coordinate and all", () => {
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "endpoint", path: "/a", method: "GET" }, "e1"),
				row({ kind: "endpoint", path: "/a", method: "GET" }, "e2"),
			],
			blockers: [row({ kind: "blocker", question: "creds?", status: "open", blocks: ["e2:sqli", "e2"] }, "b1")],
		}), NOW);
		expect(plan.writes.find((w) => w.store === "blockers")?.records[0]).toMatchObject({ blocks: ["e1:sqli", "e1"] });
	});

	it("finds the cell that only exists once the surface has been folded", () => {
		// Two hypotheses on what looked like two elements are one cell as soon as
		// the elements turn out to be one. Grouping before retargeting misses it.
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e1"),
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e2"),
			],
			hypotheses: [
				row({ kind: "hypothesis", target: "e1", class: "sqli", outcome: "proposed", statement: "worth a look" }, "y1"),
				row({ kind: "hypothesis", target: "e2", class: "sqli", outcome: "refuted", statement: "parameterised" }, "y2"),
			],
		}), NOW);
		const hyps = plan.writes.find((w) => w.store === "hypotheses")?.records ?? [];
		expect(hyps[0]).toMatchObject({ id: "y1", target: "e1", outcome: "refuted" });
		expect(hyps[1]).toMatchObject({ id: "y2", deleted: true, duplicateOf: "y1" });
	});

	it("leaves rows that reference nothing folded untouched", () => {
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e1"),
				row({ kind: "endpoint", method: "GET", path: "/a" }, "e2"),
			],
			findings: [row({ kind: "finding", title: "x", severity: "low", target: "auth.py:12", status: "open" }, "f1")],
		}), NOW);
		expect(plan.writes.find((w) => w.store === "findings")).toBeUndefined();
	});

	it("reads back as a list of what would be folded into what", () => {
		const plan = planCompaction(ledgers({
			inventory: [
				row({ kind: "host", value: "app.test" }, "h1"),
				row({ kind: "host", value: "app.test" }, "h2"),
			],
		}), NOW);
		const text = describePlan(plan).join("\n");
		expect(text).toContain("host h1  app.test");
		expect(text).toContain("← h2");
		expect(text).toMatch(/1 group\(s\), 1 row\(s\) folded away/);
	});
});

describe("applying a sweep to a workspace", () => {
	async function dirty() {
		const svc = makeFakeServices();
		const ws = await Workspace.open("/ws/acme", "acme", svc);
		await ws.writeChecklist({ v: 1, targetType: "code-review", classes: [{ id: "sqli", title: "SQL injection" }] } as never);
		for (const rec of [
			row({ kind: "endpoint", method: "GET", path: "/a" }, "e1"),
			row({ kind: "endpoint", method: "GET", path: "/a" }, "e2"),
		]) await ws.append("inventory", rec as never);
		await ws.append("hypotheses", row({ kind: "hypothesis", target: "e2", class: "sqli", outcome: "refuted", statement: "parameterised" }, "y1") as never);
		for (const rec of [
			row({ kind: "finding", title: "IDOR", severity: "low", target: "share.go:88", status: "open" }, "f1"),
			row({ kind: "finding", title: "IDOR", severity: "high", target: "share.go:88", status: "open" }, "f2"),
		]) await ws.append("findings", rec as never);
		return { svc, ws };
	}

	it("leaves one of everything, still readable", async () => {
		const { ws } = await dirty();
		const plan = planCompaction({
			inventory: await ws.read("inventory"), hypotheses: await ws.read("hypotheses"),
			findings: await ws.read("findings"), blockers: await ws.read("blockers"), loot: await ws.read("loot"),
		}, NOW);
		for (const write of plan.writes) await ws.upsert(write.store, () => write.records as never);
		expect(await ws.read("inventory")).toHaveLength(1);
		expect(await ws.read("findings")).toHaveLength(1);
		expect((await ws.read("findings"))[0]?.severity).toBe("high");
	});

	it("does not lose the coverage the folded element had settled", async () => {
		// The failure this exists to avoid: the cleared cell was recorded against
		// the row that got tombstoned, so a naive sweep would drop the engagement's
		// coverage from 100% to 0% and call it tidying.
		const { ws } = await dirty();
		const before = computeCoverage({
			classes: [{ id: "sqli" }], elements: (await ws.read("inventory")).map((r) => ({ id: r.id, kind: "endpoint" as const })),
			hypotheses: await ws.read("hypotheses"), openBlockers: [],
		});
		expect(before.counts.clear).toBe(1);

		const plan = planCompaction({
			inventory: await ws.read("inventory"), hypotheses: await ws.read("hypotheses"),
			findings: await ws.read("findings"), blockers: await ws.read("blockers"), loot: await ws.read("loot"),
		}, NOW);
		for (const write of plan.writes) await ws.upsert(write.store, () => write.records as never);

		const after = computeCoverage({
			classes: [{ id: "sqli" }], elements: (await ws.read("inventory")).map((r) => ({ id: r.id, kind: "endpoint" as const })),
			hypotheses: await ws.read("hypotheses"), openBlockers: [],
		});
		// One element instead of two, and its one cell is still clear.
		expect(after.counts.clear).toBe(1);
		expect(after.counts["not-tested"]).toBe(0);
		expect(after.applicable).toBe(1);
	});

	it("keeps every original line in the file, so a wrong sweep is recoverable", async () => {
		const { svc, ws } = await dirty();
		const plan = planCompaction({
			inventory: await ws.read("inventory"), hypotheses: await ws.read("hypotheses"),
			findings: await ws.read("findings"), blockers: await ws.read("blockers"), loot: await ws.read("loot"),
		}, NOW);
		for (const write of plan.writes) await ws.upsert(write.store, () => write.records as never);
		const raw = (await svc.fs.readFileIfExists(ws.storePath("inventory"))) ?? "";
		expect(raw.split("\n").filter(Boolean)).toHaveLength(4); // two originals, the keeper, the tombstone
		expect(raw).toContain("\"duplicateOf\":\"e1\"");
	});

	it("is a no-op the second time", async () => {
		const { svc, ws } = await dirty();
		const read = async (): Promise<Ledgers> => ({
			inventory: await ws.read("inventory"), hypotheses: await ws.read("hypotheses"),
			findings: await ws.read("findings"), blockers: await ws.read("blockers"), loot: await ws.read("loot"),
		});
		for (const write of planCompaction(await read(), NOW).writes) await ws.upsert(write.store, () => write.records as never);
		const after = await svc.fs.readFileIfExists(ws.storePath("inventory"));
		const second = planCompaction(await read(), NOW);
		expect(second.groups).toEqual([]);
		expect(second.writes).toEqual([]);
		expect(await svc.fs.readFileIfExists(ws.storePath("inventory"))).toBe(after);
	});
});
