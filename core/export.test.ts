import { describe, expect, it } from "vitest";
import type { FindingRecord, LootRecord } from "./ontology.ts";
import { exportFindingsJson, exportFindingsMarkdown, notReportReady } from "./export.ts";

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

describe("notReportReady", () => {
	const complete = { description: "what it is", impact: "what it costs", remediation: "what to do" };

	it("is the check the report already applies, where the harness can reach it too", () => {
		const findings = [
			finding({ id: "whole", ...complete }),
			finding({ id: "no-impact", description: "d", remediation: "r" }),
			finding({ id: "no-fix", description: "d", impact: "i" }),
			finding({ id: "bare" }),
		];
		expect(notReportReady(findings).map((f) => f.id)).toEqual(["no-impact", "no-fix", "bare"]);
		// And what it says about a set that is finished is nothing at all.
		expect(notReportReady([finding({ id: "whole", ...complete })])).toEqual([]);
	});

	it("agrees with the banner the exported report prints", () => {
		const md = exportFindingsMarkdown({ findings: [finding({ id: "bare" }), finding({ id: "whole", ...complete })] });
		expect(md).toContain("1 finding is not report-ready");
		expect(md).toContain("bare");
	});
});

/**
 * A client report said `Target: 9d2fdd`, and shipped none of the 231 refutations
 * the same engagement recorded. Both are what ADR-003 is about.
 */
describe("what the report says beyond the findings themselves", () => {
	const labels: Record<string, string> = { e1: "POST /api/split-bill", e2: "GET /api/me" };
	const labelFor = (id: string) => labels[id];

	it("names the target the way the reviewer did", () => {
		const md = exportFindingsMarkdown({ findings: [finding({ id: "a", target: "e1" })], labelFor });
		expect(md).toContain("- Target: POST /api/split-bill");
		expect(md).not.toContain("- Target: e1");
	});

	it("keeps an unresolved target rather than dropping it", () => {
		// A target is legitimately a raw label when nothing was mapped for it, and
		// a blank line is worse than an id.
		const md = exportFindingsMarkdown({ findings: [finding({ id: "a", target: "backend/auth.py:22" })], labelFor });
		expect(md).toContain("- Target: backend/auth.py:22");
	});

	it("reports the testing behind the findings, refutations included", () => {
		const md = exportFindingsMarkdown({
			findings: [finding({ id: "a" })],
			labelFor,
			coverage: {
				brief: {
					elements: 46, classes: 19, applicable: 797, settled: 340, percent: 43,
					untestedClasses: ["xxe"], untestedElements: ["e2"],
				},
				classTitles: { xxe: "XXE / unsafe XML & data parsing" },
				refuted: 231,
			},
		});
		expect(md).toContain("## Coverage");
		expect(md).toContain("340 of 797 test cases settled (43%)");
		expect(md).toContain("231 hypotheses were tested and refuted");
		// Named, not counted: "17 classes untested" is not something a client can act on.
		expect(md).toContain("- XXE / unsafe XML & data parsing");
		expect(md).toContain("- GET /api/me");
	});

	it("says nothing about coverage when no checklist was ever seeded", () => {
		// Asserting 0% because nobody seeded a checklist is worse than silence.
		const md = exportFindingsMarkdown({ findings: [finding({ id: "a" })] });
		expect(md).not.toContain("## Coverage");
		const empty = exportFindingsMarkdown({
			findings: [finding({ id: "a" })],
			coverage: { brief: { elements: 0, classes: 0, applicable: 0, settled: 0, percent: 0, untestedClasses: [], untestedElements: [] } },
		});
		expect(empty).not.toContain("## Coverage");
	});

	it("summarises the tail rather than dumping every untested element", () => {
		const many = Array.from({ length: 30 }, (_, i) => `x${i}`);
		const md = exportFindingsMarkdown({
			findings: [finding({ id: "a" })],
			coverage: {
				brief: { elements: 30, classes: 1, applicable: 30, settled: 0, percent: 0, untestedClasses: [], untestedElements: many },
			},
		});
		expect(md).toContain("…and 10 more");
	});

	// Redaction used to run over the findings array alone. Labels and coverage text
	// are ledger strings too, and an inventory record can carry a secret — a param
	// named for a token, a host value with credentials in the URL.
	it("masks secrets that arrive through a label or the coverage section", () => {
		const md = exportFindingsMarkdown({
			findings: [finding({ id: "a", target: "e9" })],
			loot: [{ v: 1, kind: "loot", id: "l1", createdAt: "t", handle: "cred:x", secret: "hunter2xyz" }],
			labelFor: () => "GET /login?token=hunter2xyz",
			coverage: {
				brief: { elements: 1, classes: 1, applicable: 1, settled: 0, percent: 0, untestedClasses: ["hunter2xyz"], untestedElements: [] },
				classTitles: { hunter2xyz: "hunter2xyz" },
			},
		});
		expect(md).not.toContain("hunter2xyz");
		expect(md).toContain("[REDACTED cred:x]");
	});
});

