import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settleTelemetry } from "./settle-telemetry.ts";

/** An engagement directory holding these rows, one JSONL file per store. */
async function engagement(stores: Record<string, Array<Record<string, unknown>>>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "telemetry-"));
	for (const [store, rows] of Object.entries(stores)) {
		await writeFile(join(dir, `${store}.jsonl`), rows.map((r) => JSON.stringify({ v: 1, ...r })).join("\n"));
	}
	return dir;
}

const settle = (id: string, createdAt: string, outcome: string) => ({ id, kind: "settle", createdAt, outcome, by: "lead", remainder: { openCells: 2 } });

describe("settleTelemetry and the last settle (3.2)", () => {
	it("carries the lead's last settle and counts the work written after it, leaving out the scribe's and the operator's", async () => {
		const dir = await engagement({
			// The worker's later settle is not the session's: only the lead's is read.
			sessions: [settle("s1", "2026-01-01T01:00:00.000Z", "paused"), settle("s2", "2026-01-01T02:00:00.000Z", "finished"), { ...settle("s3", "2026-01-01T02:50:00.000Z", "blocked"), by: "pired-investigate" }],
			findings: [
				{ id: "f1", kind: "finding", createdAt: "2026-01-01T00:30:00.000Z", title: "a", severity: "low", status: "suspected", by: "lead" },
				{ id: "f2", kind: "finding", createdAt: "2026-01-01T02:30:00.000Z", title: "b", severity: "low", status: "suspected", by: "lead" },
				{ id: "f3", kind: "finding", createdAt: "2026-01-01T02:31:00.000Z", title: "c", severity: "low", status: "suspected", by: "scribe" },
			],
			hypotheses: [{ id: "y1", kind: "hypothesis", createdAt: "2026-01-01T00:10:00.000Z", updatedAt: "2026-01-01T03:00:00.000Z", statement: "s", target: "e1", class: "sqli", outcome: "refuted" }],
			blockers: [{ id: "b1", kind: "blocker", createdAt: "2026-01-01T02:40:00.000Z", question: "q", status: "answered", by: "operator" }],
		});
		const t = await settleTelemetry(dir);
		expect(t.lastSettle).toEqual({ outcome: "finished", at: "2026-01-01T02:00:00.000Z", by: "lead", laterWrites: 2, remainder: { openCells: 2 } });
	});

	it("counts the coverage cells left open when the engagement has a checklist, and none without one", async () => {
		const dir = await engagement({
			inventory: [{ id: "e1", kind: "endpoint", createdAt: "t", host: "", method: "GET", path: "/a" }],
			hypotheses: [{ id: "y1", kind: "hypothesis", createdAt: "t", statement: "s", target: "e1", class: "sqli", outcome: "refuted" }],
		});
		expect(await settleTelemetry(dir)).not.toHaveProperty("openCells");
		await writeFile(join(dir, "checklist.json"), JSON.stringify({ v: 1, targetType: "web", classes: [{ id: "sqli" }, { id: "authz" }, { id: "xss" }] }));
		expect((await settleTelemetry(dir)).openCells).toBe(2);
	});

	it("carries no settle for a run that wrote none, which is every baseline run", async () => {
		const t = await settleTelemetry(await engagement({ findings: [] }));
		expect(t).not.toHaveProperty("lastSettle");
	});
});
