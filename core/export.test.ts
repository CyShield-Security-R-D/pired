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

describe("the three sections a client reads", () => {
	const base = {
		v: 1 as const, id: "f1", kind: "finding" as const, createdAt: "t",
		title: "IDOR in /api/user", severity: "high" as const, target: "user_routes.py:41", status: "open" as const,
	};

	it("renders what it is, what it costs and what to do, in that order", () => {
		const md = exportFindingsMarkdown({ findings: [{
			...base,
			description: "no ownership check on the id parameter",
			impact: "any customer can read all 40,000 customer records",
			remediation: "scope the query to the session user",
		}] });
		expect(md.indexOf("**Description**")).toBeLessThan(md.indexOf("**Business impact**"));
		expect(md.indexOf("**Business impact**")).toBeLessThan(md.indexOf("**Remediation**"));
		expect(md).toContain("any customer can read all 40,000 customer records");
		expect(md).not.toContain("not yet report-ready");
	});

	it("marks an unwritten section rather than leaving it out", () => {
		// A finding with no impact paragraph reads as a finished section to anyone
		// skimming. The gap has to be visible where the paragraph should have been.
		const md = exportFindingsMarkdown({ findings: [{ ...base, description: "no ownership check" }] });
		expect(md).toMatch(/\*\*Business impact\*\*\n\n_Not recorded/);
		expect(md).toMatch(/\*\*Remediation\*\*\n\n_Not recorded/);
	});

	it("says in the summary which findings are not ready to send", () => {
		const md = exportFindingsMarkdown({ findings: [
			{ ...base, id: "f1", description: "d", impact: "i", remediation: "r" },
			{ ...base, id: "f2" },
		] });
		expect(md).toMatch(/\*\*1 finding is not report-ready\*\*/);
		expect(md).toContain("f2.");
	});

	it("carries the rationale for a settled finding into the report", () => {
		const md = exportFindingsMarkdown({ findings: [{
			...base, status: "accepted-risk" as const, reason: "client accepted; compensating WAF rule",
		}] });
		expect(md).toContain("- Rationale: client accepted; compensating WAF rule");
	});
});
