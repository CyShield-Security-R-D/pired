import { describe, expect, it } from "vitest";
import type { FindingRecord, LootRecord } from "./ontology.ts";
import { exportFindingsJson, exportFindingsMarkdown } from "./export.ts";

function finding(partial: Partial<FindingRecord> & Pick<FindingRecord, "id">): FindingRecord {
	return { v: 1, kind: "finding", createdAt: "t", title: "T", severity: "high", target: "e1", status: "confirmed", ...partial };
}

describe("exportFindingsMarkdown", () => {
	it("renders a report with summary counts", () => {
		const md = exportFindingsMarkdown({
			findings: [finding({ id: "f1", severity: "high", title: "IDOR" }), finding({ id: "f2", severity: "low", title: "Verbose error" })],
			engagement: "acme",
		});
		expect(md).toContain("# pired findings");
		expect(md).toContain("acme");
		expect(md).toMatch(/high: 1/);
		expect(md).toMatch(/low: 1/);
		expect(md).toContain("IDOR");
	});

	it("sorts findings by severity, critical first", () => {
		const md = exportFindingsMarkdown({
			findings: [finding({ id: "a", severity: "low", title: "LowOne" }), finding({ id: "b", severity: "critical", title: "CritOne" })],
		});
		expect(md.indexOf("CritOne")).toBeLessThan(md.indexOf("LowOne"));
	});

	it("redacts loot secrets in finding text", () => {
		const loot: LootRecord[] = [{ v: 1, id: "c1", kind: "loot", createdAt: "t", handle: "cred:x", type: "password", secret: "S3cr3tP@ss" }];
		const md = exportFindingsMarkdown({ findings: [finding({ id: "f1", description: "leaked S3cr3tP@ss here" })], loot });
		expect(md).toContain("[REDACTED cred:x]");
		expect(md).not.toContain("S3cr3tP@ss");
	});

	it("handles an empty findings list", () => {
		expect(exportFindingsMarkdown({ findings: [] })).toMatch(/no findings|Total: 0/i);
	});
});

describe("exportFindingsJson", () => {
	it("emits redacted, parseable JSON", () => {
		const loot: LootRecord[] = [{ v: 1, id: "c1", kind: "loot", createdAt: "t", handle: "cred:x", type: "token", secret: "tok_abcdef" }];
		const json = exportFindingsJson({ findings: [finding({ id: "f1", repro: "use tok_abcdef" })], loot, engagement: "acme" });
		const parsed = JSON.parse(json) as { engagement: string; findings: FindingRecord[] };
		expect(parsed.engagement).toBe("acme");
		expect(parsed.findings[0]?.repro).toContain("[REDACTED cred:x]");
		expect(parsed.findings[0]?.repro).not.toContain("tok_abcdef");
	});
});
