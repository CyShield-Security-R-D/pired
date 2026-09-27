import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHostServices, NodeFs, RandomIds, SystemClock } from "./host.ts";

/**
 * The node side of core's ports. Most of it is a one-line delegation and needs
 * no test — but its ERROR semantics are load-bearing and invisible: the
 * workspace decides "no engagement yet" from `readFileIfExists` returning
 * undefined, and the lock decides "someone else holds it" from
 * `tryCreateExclusive` returning false. Both are a swallowed errno, and a
 * swallowed errno is exactly the kind of thing that turns into a wrong answer
 * rather than a crash.
 */

let dir: string;
const fs = new NodeFs();

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pired-host-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("reading", () => {
	it("returns undefined for a file that is not there, rather than throwing", async () => {
		expect(await fs.readFileIfExists(join(dir, "nope.json"))).toBeUndefined();
	});

	it("still throws for a failure that is NOT absence", async () => {
		// A directory read as a file is EISDIR. Swallowing it too would turn a real
		// problem into "no engagement yet".
		await expect(fs.readFileIfExists(dir)).rejects.toThrow();
	});

	it("round-trips content", async () => {
		await fs.writeFile(join(dir, "a.txt"), "hello");
		expect(await fs.readFile(join(dir, "a.txt"))).toBe("hello");
	});

	it("throws on a missing file when absence was not offered as an answer", async () => {
		await expect(fs.readFile(join(dir, "nope"))).rejects.toThrow();
	});
});

describe("writing", () => {
	it("appends rather than truncates — the ledgers are append-only", async () => {
		const p = join(dir, "ledger.jsonl");
		await fs.appendFile(p, "{}\n");
		await fs.appendFile(p, "{}\n");
		expect(await fs.readFile(p)).toBe("{}\n{}\n");
	});

	it("appends to a file that does not exist yet", async () => {
		const p = join(dir, "new.jsonl");
		await fs.appendFile(p, "first\n");
		expect(await fs.readFile(p)).toBe("first\n");
	});

	it("honours a mode, which is how loot.jsonl stays 600", async () => {
		const p = join(dir, "loot.jsonl");
		await fs.writeFile(p, "secret", { mode: 0o600 });
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	it("chmods an existing file", async () => {
		const p = join(dir, "f");
		await fs.writeFile(p, "x");
		await fs.chmod(p, 0o600);
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	it("renames, which is the atomic half of an atomic write", async () => {
		await fs.writeFile(join(dir, "tmp"), "v2");
		await fs.rename(join(dir, "tmp"), join(dir, "manifest.json"));
		expect(await fs.readFile(join(dir, "manifest.json"))).toBe("v2");
		expect(await fs.readFileIfExists(join(dir, "tmp"))).toBeUndefined();
	});

	it("overwrites the destination on rename, rather than failing", async () => {
		await fs.writeFile(join(dir, "manifest.json"), "old");
		await fs.writeFile(join(dir, "tmp"), "new");
		await fs.rename(join(dir, "tmp"), join(dir, "manifest.json"));
		expect(await fs.readFile(join(dir, "manifest.json"))).toBe("new");
	});
});

describe("directories", () => {
	it("creates a nested path in one call", async () => {
		await fs.mkdirp(join(dir, "a", "b", "c"));
		expect(await fs.stat(join(dir, "a", "b", "c"))).toBeDefined();
	});

	it("is happy to be asked twice", async () => {
		await fs.mkdirp(join(dir, "a"));
		await expect(fs.mkdirp(join(dir, "a"))).resolves.toBeUndefined();
	});

	it("lists what is there", async () => {
		await writeFile(join(dir, "one"), "");
		await writeFile(join(dir, "two"), "");
		expect((await fs.readdir(dir)).sort()).toEqual(["one", "two"]);
	});

	it("removes a whole tree, and says nothing about one that was already gone", async () => {
		await fs.mkdirp(join(dir, "evidence", "deep"));
		await fs.writeFile(join(dir, "evidence", "deep", "f"), "x");
		await fs.remove(join(dir, "evidence"));
		expect(await fs.stat(join(dir, "evidence"))).toBeUndefined();
		await expect(fs.remove(join(dir, "evidence"))).resolves.toBeUndefined();
	});
});

describe("stat", () => {
	it("reports size and mtime", async () => {
		await fs.writeFile(join(dir, "f"), "12345");
		const s = await fs.stat(join(dir, "f"));
		expect(s?.size).toBe(5);
		expect(typeof s?.mtimeMs).toBe("number");
	});

	it("returns undefined for what is not there", async () => {
		expect(await fs.stat(join(dir, "ghost"))).toBeUndefined();
	});
});

describe("the exclusive create a lock is built on", () => {
	it("succeeds once", async () => {
		expect(await fs.tryCreateExclusive(join(dir, "lock"))).toBe(true);
	});

	it("reports false — not an error — when someone already holds it", async () => {
		const p = join(dir, "lock");
		expect(await fs.tryCreateExclusive(p)).toBe(true);
		expect(await fs.tryCreateExclusive(p)).toBe(false);
	});

	it("still throws when the failure is not contention", async () => {
		// No such directory is a real problem; reporting it as "held" would make a
		// broken workspace look like a busy one.
		await expect(fs.tryCreateExclusive(join(dir, "missing", "lock"))).rejects.toThrow();
	});
});

describe("the clock and the ids", () => {
	it("gives a UTC ISO timestamp, which is what the ledger stores", () => {
		expect(new SystemClock().nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
	});

	it("sleeps", async () => {
		const t0 = Date.now();
		await new SystemClock().sleep(5);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(4);
	});

	it("mints six lowercase hex characters, the shape every existing ledger uses", () => {
		// Uniqueness is not asserted here because a random source cannot promise
		// it: 500 draws from 16^6 repeat in 0.74% of runs, and this test used to
		// fail 1 run in 135 for exactly that reason. The record tool draws again
		// on a collision (core/ids.ts), and that is where uniqueness is tested.
		const ids = new RandomIds();
		for (let i = 0; i < 50; i++) expect(ids.newId()).toMatch(/^[0-9a-f]{6}$/);
	});
});

describe("assembling the services", () => {
	it("provides all three ports", () => {
		const s = makeHostServices();
		expect(typeof s.fs.readFile).toBe("function");
		expect(typeof s.clock.now).toBe("function");
		expect(typeof s.ids.newId).toBe("function");
	});

	it("lets a caller substitute one — which is how the tests reach the rest", () => {
		const ids = { newId: () => "fixed" };
		expect(makeHostServices({ ids }).ids.newId()).toBe("fixed");
	});
});
