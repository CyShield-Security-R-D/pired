import { describe, expect, it } from "vitest";
import type { EngagementScope, FindingRecord, HostRecord, LootRecord } from "./ontology.ts";
import { makeFakeServices } from "./testing/fakes.ts";
import { Workspace } from "./workspace.ts";

const DIR = "/ws/acme";

function host(id: string, value: string, createdAt: string): HostRecord {
	return { v: 1, id, kind: "host", createdAt, value };
}

describe("Workspace.ensure", () => {
	it("creates the manifest and evidence/artifacts dirs", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		const manifest = await ws.readManifest();
		expect(manifest?.engagement).toBe("acme");
		expect(manifest?.formatVersion).toBe(1);
		expect(await svc.fs.stat(`${DIR}/evidence`)).toBeDefined();
		expect(await svc.fs.stat(`${DIR}/artifacts`)).toBeDefined();
	});

	it("does not clobber an existing manifest", async () => {
		const svc = makeFakeServices();
		await Workspace.open(DIR, "acme", svc);
		const first = await new Workspace(DIR, svc).readManifest();
		svc.clock.advance(10_000);
		await Workspace.open(DIR, "acme", svc);
		const second = await new Workspace(DIR, svc).readManifest();
		expect(second?.createdAt).toBe(first?.createdAt);
	});
});

describe("Workspace ledgers", () => {
	it("appends and reads back records", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await ws.append("inventory", host("h1", "app.acme.test", svc.clock.nowIso()));
		const got = await ws.read("inventory");
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ id: "h1", value: "app.acme.test" });
	});

	it("last write for an id wins", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		const f1: FindingRecord = {
			v: 1, id: "f1", kind: "finding", createdAt: svc.clock.nowIso(),
			title: "IDOR", severity: "high", target: "e1", status: "open",
		};
		await ws.append("findings", f1);
		svc.clock.advance(1000);
		await ws.append("findings", { ...f1, status: "confirmed", updatedAt: svc.clock.nowIso() });
		const got = await ws.read("findings");
		expect(got).toHaveLength(1);
		expect(got[0]?.status).toBe("confirmed");
	});

	it("hides soft-deleted records", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await ws.append("inventory", host("h1", "a.acme.test", svc.clock.nowIso()));
		await ws.append("inventory", host("h2", "b.acme.test", svc.clock.nowIso()));
		await ws.append("inventory", { ...host("h1", "a.acme.test", svc.clock.nowIso()), deleted: true });
		const got = await ws.read("inventory");
		expect(got.map((r) => r.id)).toEqual(["h2"]);
	});

	it("skips malformed lines instead of throwing", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await svc.fs.appendFile(ws.storePath("inventory"), "not json\n");
		await ws.append("inventory", host("h1", "app.acme.test", svc.clock.nowIso()));
		const got = await ws.read("inventory");
		expect(got).toHaveLength(1);
	});

	it("chmods the loot store to 600", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		const loot: LootRecord = {
			v: 1, id: "c1", kind: "loot", createdAt: svc.clock.nowIso(),
			handle: "cred:web-admin", type: "password", secret: "s3cr3t",
		};
		await ws.append("loot", loot);
		expect(svc.fs.getMode(ws.storePath("loot"))).toBe(0o600);
	});

	it("tightens a pre-existing permissive loot ledger before appending", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		// Simulate a loot ledger left world-readable by an older version / stray umask.
		await svc.fs.writeFile(ws.storePath("loot"), "", { mode: 0o644 });
		const loot: LootRecord = {
			v: 1, id: "c2", kind: "loot", createdAt: svc.clock.nowIso(),
			handle: "cred:db", type: "password", secret: "s3cr3t",
		};
		await ws.append("loot", loot);
		// The append (which preserves mode) must have run AFTER a chmod to 0o600.
		expect(svc.fs.getMode(ws.storePath("loot"))).toBe(0o600);
	});
});

describe("Workspace single-object files", () => {
	it("round-trips scope.json", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		const scope: EngagementScope = {
			v: 1, engagement: "acme", authorized: true, mode: "enforce",
			targets: { domains: ["*.acme.test"] },
		};
		await ws.writeScope(scope);
		expect(await ws.readScope()).toEqual(scope);
	});

	it("appends timestamped notes", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await ws.appendNote("first observation");
		await ws.appendNote("second observation");
		const notes = await svc.fs.readFile(`${DIR}/notes.md`);
		expect(notes).toContain("first observation");
		expect(notes).toContain("second observation");
		expect(notes).toMatch(/## \d{4}-/);
	});

	it("stores evidence and returns a workspace-relative path", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		const rel = await ws.writeEvidence("y7-idor.txt", "raw output");
		expect(rel).toBe("evidence/y7-idor.txt");
		expect(await svc.fs.readFile(`${DIR}/evidence/y7-idor.txt`)).toBe("raw output");
	});
});

describe("Workspace locking", () => {
	it("steals a stale lock", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc, { lockStaleMs: 1000, lockTimeoutMs: 5000 });
		const lockPath = `${ws.storePath("inventory")}.lock`;
		await svc.fs.tryCreateExclusive(lockPath); // simulate a leftover lock
		svc.clock.advance(2000); // make it stale
		await ws.append("inventory", host("h1", "app.acme.test", svc.clock.nowIso()));
		expect(await ws.read("inventory")).toHaveLength(1);
		expect(svc.fs.has(lockPath)).toBe(false);
	});

	it("times out on a fresh foreign lock", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc, { lockStaleMs: 60_000, lockTimeoutMs: 1000, lockRetryMs: 200 });
		await svc.fs.tryCreateExclusive(`${ws.storePath("inventory")}.lock`);
		await expect(ws.append("inventory", host("h1", "app.acme.test", svc.clock.nowIso()))).rejects.toThrow(/lock/i);
	});
});

describe("Workspace.upsert", () => {
	// Deduplication is a read-then-write, and `record` runs beside subagents and
	// the `pired answer` subcommand. Reading outside the lock lets two writers
	// both decide an element is new and both create it — the duplicate the check
	// exists to prevent.
	it("decides what to write from the store as it stands inside the lock", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await ws.append("inventory", host("h1", "app.acme.test", svc.clock.nowIso()));
		let seen = 0;
		await ws.upsert("inventory", (current) => {
			seen = current.length;
			return [host("h2", "api.acme.test", svc.clock.nowIso())];
		});
		expect(seen).toBe(1);
		expect(await ws.read("inventory")).toHaveLength(2);
	});

	it("writes nothing when the plan asks for nothing", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await ws.upsert("inventory", () => undefined);
		await ws.upsert("inventory", () => []);
		expect(svc.fs.has(ws.storePath("inventory"))).toBe(false);
	});

	it("holds the lock for the whole read-decide-write", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc, { lockStaleMs: 60_000, lockTimeoutMs: 1000, lockRetryMs: 200 });
		await svc.fs.tryCreateExclusive(`${ws.storePath("inventory")}.lock`);
		await expect(ws.upsert("inventory", () => [host("h1", "a.test", svc.clock.nowIso())])).rejects.toThrow(/lock/i);
	});

	it("tightens a permissive loot ledger before the plan's secrets reach it", async () => {
		const svc = makeFakeServices();
		const ws = await Workspace.open(DIR, "acme", svc);
		await svc.fs.writeFile(ws.storePath("loot"), "", { mode: 0o644 });
		await ws.upsert("loot", () => [{
			v: 1, id: "l1", kind: "loot", createdAt: svc.clock.nowIso(),
			handle: "cred:web-admin", type: "password", secret: "hunter2",
		}]);
		expect(svc.fs.getMode(ws.storePath("loot"))).toBe(0o600);
	});
});
