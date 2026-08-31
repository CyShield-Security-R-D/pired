import { describe, expect, it } from "vitest";
import { classFromCwe, extractionSystemPrompt, extractionUserMessage, hypothesisForFinding, parseExtraction } from "./extract.ts";

const GOOD = `{
  "surface": [{"kind":"endpoint","label":"POST /api/login"},{"kind":"endpoint","label":"GET /api/transactions"}],
  "findings": [
    {"title":"SQL injection in login","severity":"critical","class":"sqli","cwe":"CWE-89","file":"backend/routes/auth_routes.py","line":30,"description":"f-string SQL"},
    {"title":"MD5 password hashing","severity":"medium","class":"crypto","cwe":"CWE-328","file":"backend/auth.py","line":12}
  ],
  "hypotheses": [
    {"statement":"login builds SQL by f-string","class":"sqli","target":"POST /api/login","outcome":"confirmed"},
    {"statement":"transactions are scoped to the caller","class":"authz","target":"GET /api/transactions","outcome":"refuted"}
  ]
}`;

describe("the extractor's instructions", () => {
	it("pins the class vocabulary so ids are not invented", () => {
		const p = extractionSystemPrompt(["sqli", "authz", "crypto"]);
		expect(p).toContain("sqli, authz, crypto");
	});

	it("says plainly that it is not reviewing", () => {
		// A model that just spent twenty minutes analysing will keep analysing given
		// any latitude, and the run ends in more prose — the exact failure this
		// phase exists to end.
		expect(extractionSystemPrompt([])).toMatch(/NOT reviewing/);
	});

	it("asks for refutations, not only findings", () => {
		// A class checked and found clean is the evidence the class was examined at
		// all, and it is the thing a findings list cannot express.
		expect(extractionSystemPrompt(["sqli"])).toMatch(/RULED OUT/);
	});

	it("carries the review verbatim", () => {
		expect(extractionUserMessage("the review body")).toContain("the review body");
	});
});

describe("parsing the reply", () => {
	it("reads a clean object", () => {
		const { extraction, errors } = parseExtraction(GOOD);
		expect(errors).toEqual([]);
		expect(extraction.findings).toHaveLength(2);
		expect(extraction.hypotheses).toHaveLength(2);
		expect(extraction.surface.map((s) => s.label)).toContain("POST /api/login");
		expect(extraction.findings[0]).toMatchObject({ severity: "critical", cwe: "CWE-89", line: 30 });
	});

	it("survives a fence and a chatty preamble", () => {
		const { extraction, errors } = parseExtraction("Sure! Here you go:\n```json\n" + GOOD + "\n```\nLet me know if you need more.");
		expect(errors).toEqual([]);
		expect(extraction.findings).toHaveLength(2);
	});

	it("is not truncated by a brace inside a description", () => {
		const doc = `{"surface":[],"hypotheses":[],"findings":[{"title":"eval","severity":"high","description":"calls eval(${"${expr}"}) on input"}]}`;
		const { extraction } = parseExtraction(doc);
		expect(extraction.findings).toHaveLength(1);
		expect(extraction.findings[0]?.description).toContain("eval(");
	});

	it("drops a malformed row with a reason instead of writing it half-formed", () => {
		const { extraction, errors } = parseExtraction(`{
			"surface": [{"kind":"endpoint"}],
			"findings": [{"title":"no severity here"},{"title":"ok","severity":"low"}],
			"hypotheses": [{"statement":"s","class":"sqli","target":"t","outcome":"maybe"}]
		}`);
		expect(extraction.findings).toHaveLength(1);
		expect(extraction.hypotheses).toHaveLength(0);
		expect(extraction.surface).toHaveLength(0);
		expect(errors.join(" ")).toMatch(/severity missing/);
		expect(errors.join(" ")).toMatch(/outcome missing/);
		expect(errors.join(" ")).toMatch(/no label/);
	});

	it("refuses a line number with no file to anchor it", () => {
		const { extraction } = parseExtraction(`{"surface":[],"hypotheses":[],"findings":[{"title":"t","severity":"low","line":42}]}`);
		expect(extraction.findings[0]?.line).toBeUndefined();
	});

	it("reports prose as prose rather than throwing", () => {
		const { extraction, errors } = parseExtraction("I reviewed the app and found SQL injection in login.");
		expect(extraction.findings).toEqual([]);
		expect(errors[0]).toMatch(/no JSON object/);
	});

	it("reports invalid JSON as invalid", () => {
		expect(parseExtraction("{ findings: [ }").errors[0]).toMatch(/not valid JSON/);
	});

	it("accepts a line number sent as a string", () => {
		const { extraction } = parseExtraction(`{"surface":[],"hypotheses":[],"findings":[{"title":"t","severity":"low","file":"a.py","line":"42"}]}`);
		expect(extraction.findings[0]?.line).toBe(42);
	});
});

describe("recovering the class the extractor left out", () => {
	// On the first live run all fifteen extracted findings carried a CWE and no
	// class — and a finding with no class settles no coverage cell, so the matrix
	// reads zero while the report fills up. The checklist already maps its classes
	// to CWEs, so the harness finishes the job instead of asking again.
	const classes = [
		{ id: "sqli", cwe: ["CWE-89"] },
		{ id: "codeinj", cwe: ["CWE-94", "CWE-95", "CWE-470"] },
		{ id: "authz", cwe: ["CWE-862", "CWE-285", "CWE-639"] },
		{ id: "logic", cwe: [] },
	];

	it("maps a CWE to its class", () => {
		expect(classFromCwe("CWE-89", classes)).toBe("sqli");
		expect(classFromCwe("CWE-639", classes)).toBe("authz");
		expect(classFromCwe("CWE-470", classes)).toBe("codeinj");
	});

	it("reads a CWE however it was written", () => {
		expect(classFromCwe("cwe-89", classes)).toBe("sqli");
		expect(classFromCwe("89", classes)).toBe("sqli");
		expect(classFromCwe("CWE 89: SQL Injection", classes)).toBe("sqli");
	});

	it("returns nothing rather than guessing", () => {
		expect(classFromCwe("CWE-1004", classes)).toBeUndefined();
		expect(classFromCwe(undefined, classes)).toBeUndefined();
		expect(classFromCwe("not a cwe", classes)).toBeUndefined();
	});
});

describe("the hypothesis a finding already implies", () => {
	// Coverage is settled by a hypothesis outcome, never by a finding. A run that
	// produces only findings leaves every cell untested. A confirmed finding IS a
	// confirmed hypothesis, so writing one is bookkeeping, not inference.
	it("confirms the cell the finding proves", () => {
		const h = hypothesisForFinding(
			{ title: "SQL injection in login", severity: "critical", description: "f-string SQL" },
			"sqli", "backend/auth.py:30",
		);
		expect(h).toMatchObject({ class: "sqli", target: "backend/auth.py:30", outcome: "confirmed" });
		expect(h.statement).toContain("SQL injection in login");
		expect(h.statement).toContain("f-string SQL");
	});

	it("still reads as a statement with no description to add", () => {
		const h = hypothesisForFinding({ title: "MD5 hashing", severity: "medium" }, "crypto", "backend/auth.py:12");
		expect(h.statement).toBe("MD5 hashing");
	});
});
