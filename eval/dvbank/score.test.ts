import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMED_LOCATION_CAP, fromLedger } from "./score.ts";

/** A ledger holding just these findings. */
async function ledger(findings: Array<Record<string, unknown>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "score-"));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "findings.jsonl"),
		findings.map((f) => JSON.stringify({ v: 1, kind: "finding", createdAt: "", ...f })).join("\n"));
	return dir;
}

describe("locating a finding that states its line in prose", () => {
	it("joins a named file with a line stated after it", async () => {
		// Measured on filebrowser: an exact hit on http/share.go:80, dropped for
		// want of a colon.
		const dir = await ledger([{
			id: "a", title: "IDOR in share deletion", severity: "medium", target: "ANY /api/share/{hash}",
			description: "DELETE /api/share/{hash} (http/share.go shareDeleteHandler) calls store.Share.Delete(hash) directly (line 80) with no ownership check.",
		}]);
		expect(await fromLedger(dir)).toEqual([expect.objectContaining({ file: "http/share.go", line: 80 })]);
	});

	it("prefers an explicit file:line over the prose form", async () => {
		const dir = await ledger([{
			id: "b", title: "x", severity: "high", target: "app/models/user.rb:42",
			description: "see also line 900 of the helper",
		}]);
		expect(await fromLedger(dir)).toEqual([expect.objectContaining({ file: "app/models/user.rb", line: 42 })]);
	});

	it("pairs each line with the file it follows, not the first file named", async () => {
		const dir = await ledger([{
			id: "c", title: "x", severity: "high", target: "route",
			description: "config.py is fine; the sink is in handlers/upload.go at line 55",
		}]);
		expect(await fromLedger(dir)).toEqual([expect.objectContaining({ file: "handlers/upload.go", line: 55 })]);
	});

	it("still drops a finding that names a file but no line anywhere", async () => {
		// Inventing a line would let a file-only finding land in a truth window by
		// accident, which inflates recall — worse than under-counting.
		const dir = await ledger([{ id: "d", title: "x", severity: "high", target: "http/share.go" }]);
		expect(await fromLedger(dir)).toEqual([]);
	});

	it("drops a finding with no file at all", async () => {
		const dir = await ledger([{ id: "e", title: "no rate limiting", severity: "low" }]);
		expect(await fromLedger(dir)).toEqual([]);
	});
});

describe("grading every location a finding claims", () => {
	it("grades every location the record cites, not just the first", async () => {
		// Measured on filebrowser: "Share deletion lacks ownership check" cited
		// share.go:73, :28 and :80 in one record. The truth is share.go[80,80] —
		// third in the list, and invisible to a grader that reads one location.
		const dir = await ledger([{
			id: "a", title: "Share deletion lacks ownership check", severity: "medium",
			target: "http/share.go:73",
			description: "the route at http/share.go:28 dispatches here and the check is missing at http/share.go:80",
		}]);
		const out = await fromLedger(dir);
		expect(out.map((f) => `${f.file}:${f.line}`)).toEqual(
			["http/share.go:73", "http/share.go:28", "http/share.go:80"]);
	});

	it("caps a record that walks a whole module", async () => {
		const many = Array.from({ length: 9 }, (_, i) => `pkg/f${i}.go:${i + 1}`).join(" and ");
		const dir = await ledger([{ id: "b", title: "x", severity: "low", target: "pkg/f0.go:1", description: many }]);
		expect((await fromLedger(dir)).length).toBe(CLAIMED_LOCATION_CAP);
	});

	it("reads the locations a merge preserved", async () => {
		const dir = await ledger([{
			id: "b", title: "x", severity: "high", target: "http/public.go:58",
			locations: ["http/share.go:84", "http/public.go:58"],
		}]);
		expect((await fromLedger(dir)).map((f) => `${f.file}:${f.line}`))
			.toEqual(expect.arrayContaining(["http/share.go:84", "http/public.go:58"]));
	});

	it("caps a record that names a whole module", async () => {
		const many = Array.from({ length: 12 }, (_, i) => `pkg/f${i}.go:${i + 1}`).join(" ");
		const dir = await ledger([{ id: "c", title: "x", severity: "low", target: "route", description: many }]);
		expect((await fromLedger(dir)).length).toBeLessThanOrEqual(6);
	});
});

describe("a finding recorded against a route", () => {
	it("resolves to the handler file the element records", async () => {
		// Measured: findings targeting "POST /api/notes/{id}/assets" resolved to
		// nothing, because only elements whose PATH was a file path could name one.
		const dir = await mkdtemp(join(tmpdir(), "score-route-"));
		await writeFile(join(dir, "inventory.jsonl"), JSON.stringify({
			v: 1, kind: "endpoint", id: "e1", createdAt: "", host: "h", method: "POST",
			path: "/api/notes/{id}/assets", file: "backend/handlers/assets.go",
		}));
		await writeFile(join(dir, "findings.jsonl"), JSON.stringify({
			v: 1, kind: "finding", id: "f1", createdAt: "", title: "traversal", severity: "high",
			target: "POST /api/notes/{id}/assets", description: "the upload handler joins the name at line 147",
		}));
		expect(await fromLedger(dir)).toEqual([
			expect.objectContaining({ file: "backend/handlers/assets.go", line: 147 })]);
	});
});
