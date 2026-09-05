import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromLedger } from "./score.ts";

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
