import { describe, expect, it } from "vitest";
import { applyPlan, classFromCwe, elementArgs, extractionSystemPrompt, extractionUserMessage, hypothesisForFinding, needsRetry, parseExtraction, planExtraction, REVIEW_SEPARATOR, reviewEviction, reviewWindow, rollCallClasses, type Extraction, type PlannedRecord, type RecordOutcome, shouldExtract, extractionThreshold } from "./extract.ts";

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

	it("asks for a verdict on every class, not a free-form list of refutations", () => {
		// Asking for "hypotheses, including the ones you ruled out" returned none on
		// the first live run: absence is not something a model volunteers. A
		// roll-call is a form to fill in, and every row demands an answer.
		const p = extractionSystemPrompt(["sqli", "ssti", "xxe"]);
		for (const id of ["sqli", "ssti", "xxe"]) expect(p).toContain(`"class": "${id}"`);
		expect(p).toMatch(/EVERY row/);
		expect(p).toMatch(/no rows added or removed/);
	});

	it("makes 'not considered' a legitimate answer", () => {
		// Without it the model invents a refutation or drops the row. A class the
		// review never touched must stay an untested cell — inferring "clean" from
		// silence is how a coverage number becomes a lie.
		const p = extractionSystemPrompt(["sqli"]);
		expect(p).toContain("not-considered");
		expect(p).toMatch(/silence is not a clean bill of health/);
	});

	it("carries the review verbatim", () => {
		expect(extractionUserMessage("the review body")).toContain("the review body");
	});
});

describe("the cheap pass: findings without the roll-call", () => {
	// The roll-call is one JSON row per class, every pass, and until a review has
	// actually been somewhere almost every row is "not-considered" — rows the
	// planner then discards. It is most of the tokens and most of the wait, so
	// the pass that runs by itself does not ask for it.
	it("drops the classes array entirely when no class is on the roll-call", () => {
		const p = extractionSystemPrompt(["sqli", "ssti"], { rollCall: [] });
		// Not in the schema, not in the rules, and said out loud — a model handed a
		// shape it was told not to fill in will fill it in.
		expect(p).not.toContain('"classes": [');
		expect(p).not.toMatch(/EVERY row/);
		expect(p).toMatch(/return no "classes" array/);
	});

	it("still pins the class vocabulary, because findings are still classified", () => {
		// Dropping the roll-call must not drop the ids: a finding still carries a
		// class, and an unpinned vocabulary is how a class the checklist does not
		// have reaches the planner.
		const p = extractionSystemPrompt(["sqli", "ssti"], { rollCall: [] });
		expect(p).toContain("sqli, ssti");
	});

	it("says an empty findings list is a correct answer", () => {
		// Otherwise the model fills the silence. This pass runs after every reply,
		// and most replies conclude nothing new.
		expect(extractionSystemPrompt(["sqli"], { rollCall: [] })).toMatch(/empty "findings" array is a correct/);
	});

	it("asks only about the classes it was given", () => {
		const p = extractionSystemPrompt(["sqli", "ssti", "xxe"], { rollCall: ["ssti"] });
		expect(p).toContain('"class": "ssti"');
		expect(p).not.toContain('"class": "sqli"');
		expect(p).toMatch(/EVERY row/);
	});

	it("keeps the whole roll-call when none is named", () => {
		// The default is the old behaviour: an operator asking for a sweep means
		// the complete form.
		const p = extractionSystemPrompt(["sqli", "ssti"]);
		expect(p).toContain('"class": "sqli"');
		expect(p).toContain('"class": "ssti"');
	});
});

describe("which classes the roll-call still has a question for", () => {
	it("keeps a class with an untested cell", () => {
		expect(rollCallClasses(["sqli", "ssti"], [
			{ class: "sqli", status: "not-tested" },
			{ class: "ssti", status: "clear" },
		])).toEqual(["sqli"]);
	});

	it("drops a class that is settled everywhere it applies", () => {
		// Clear, vulnerable and n/a are all answers. Asking again buys a row per
		// pass for the rest of the engagement and changes nothing.
		expect(rollCallClasses(["sqli"], [
			{ class: "sqli", status: "clear" },
			{ class: "sqli", status: "vulnerable" },
			{ class: "sqli", status: "n/a" },
		])).toEqual([]);
	});

	it("keeps a class with no cells at all", () => {
		// Nothing has been recorded against it, which is the case the roll-call
		// exists for. A filter that can only shrink the question set must never
		// shrink it on a guess.
		expect(rollCallClasses(["sqli", "ssti"], [])).toEqual(["sqli", "ssti"]);
	});

	it("keeps a class that is only blocked or in progress", () => {
		expect(rollCallClasses(["sqli", "ssti"], [
			{ class: "sqli", status: "blocked" },
			{ class: "ssti", status: "testing" },
		])).toEqual(["sqli", "ssti"]);
	});
});

describe("whether a reply is worth a second call", () => {
	const parsed = (reply: string) => parseExtraction(reply);

	it("retries prose", () => {
		// The failure the nudge exists for: a "reply with JSON" instruction
		// answered with a findings list in English.
		expect(needsRetry(parsed("Here are the findings I identified: 1. SQL injection…"), false)).toBe(true);
		expect(needsRetry(parsed("not json at all"), true)).toBe(true);
	});

	it("does NOT retry an honest empty answer from the cheap pass", () => {
		// `{"findings": []}` is a model correctly saying the new prose concluded
		// nothing. Retrying it doubles the cost of the quietest turns, which are
		// the ones the whole redesign is for.
		expect(needsRetry(parsed('{"surface": [], "findings": []}'), false)).toBe(false);
	});

	it("retries a sweep that came back with no verdicts", () => {
		// A roll-call that returns nothing has skipped the form it was handed —
		// the prose failure wearing a JSON hat.
		expect(needsRetry(parsed('{"surface": [{"kind":"host","label":"api.example.com"}], "findings": [], "classes": []}'), true)).toBe(true);
	});

	it("takes a sweep that answered", () => {
		expect(needsRetry(parsed('{"findings": [], "classes": [{"class":"sqli","verdict":"not-considered","targets":[]}]}'), true)).toBe(false);
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

describe("the class roll-call", () => {
	const doc = `{
	  "surface": [], "findings": [],
	  "classes": [
	    {"class":"sqli","verdict":"confirmed","why":"f-string SQL in login","targets":["POST /api/login"]},
	    {"class":"ssti","verdict":"refuted","why":"no template rendering of user input anywhere","targets":[]},
	    {"class":"xxe","verdict":"not-considered"},
	    {"class":"authz","verdict":"sort of","why":"unclear"}
	  ]
	}`;

	it("reads each verdict, and keeps a refutation that names no target", () => {
		const { extraction, errors } = parseExtraction(doc);
		expect(extraction.classes).toHaveLength(3);
		expect(extraction.classes[0]).toMatchObject({ class: "sqli", verdict: "confirmed", targets: ["POST /api/login"] });
		// An empty targets list on a refutation means "across everything reviewed",
		// which is what a consultant means by "we checked for SSTI and it is clean".
		expect(extraction.classes[1]).toMatchObject({ class: "ssti", verdict: "refuted", targets: [] });
		expect(extraction.classes[2]?.verdict).toBe("not-considered");
		expect(errors.join(" ")).toMatch(/verdict missing/);
	});

	it("keeps the reasoning, because a refutation has to be auditable", () => {
		const { extraction } = parseExtraction(doc);
		expect(extraction.classes[1]?.why).toContain("no template rendering");
	});
});

describe("the review window the extractor is handed", () => {
	const turn = (n: number, size: number): string => `turn${n} ${"x".repeat(size - 7)}`;

	it("keeps the buffer whole while it fits, so appending is all that changes", () => {
		const turns = [turn(1, 5000), turn(2, 5000)];
		expect(reviewEviction(turns, 40000, 24000)).toBe(0);
		const before = reviewWindow(turns);
		turns.push(turn(3, 5000));
		// The point of the whole exercise: the previous prompt is a prefix of the
		// next one, so the provider re-reads it for free.
		expect(reviewWindow(turns).startsWith(before)).toBe(true);
	});

	it("cuts back to the target, not to the budget, so the anchor stays put for a while", () => {
		const turns = Array.from({ length: 9 }, (_, i) => turn(i, 5000));
		const drop = reviewEviction(turns, 40000, 24000);
		expect(drop).toBeGreaterThan(0);
		const kept = turns.slice(drop);
		expect(kept.join(REVIEW_SEPARATOR).length).toBeLessThanOrEqual(24000);
		// Headroom left over: the next few turns append without moving the start.
		expect(reviewEviction([...kept, turn(99, 5000)], 40000, 24000)).toBe(0);
	});

	it("evicts at a turn boundary, never mid-sentence", () => {
		const turns = Array.from({ length: 9 }, (_, i) => turn(i, 5000));
		const kept = turns.slice(reviewEviction(turns, 40000, 24000));
		expect(kept[0]).toBe(turns[turns.length - kept.length]);
	});

	it("never drops the newest turn, which carries the conclusions", () => {
		const huge = [turn(1, 90000)];
		expect(reviewEviction(huge, 40000, 24000)).toBe(0);
		const many = Array.from({ length: 4 }, (_, i) => turn(i, 30000));
		expect(reviewEviction(many, 40000, 24000)).toBe(many.length - 1);
	});

	it("falls back to the tail when one turn alone exceeds the budget", () => {
		const text = reviewWindow([`${"a".repeat(50000)}\nthe conclusion`], { turns: 0, chars: 0 }, 40000);
		expect(text).toContain("the conclusion");
		expect(text).toContain("earlier analysis omitted");
		expect(text.length).toBeLessThan(41000);
	});

	it("says what was dropped, counting the whole engagement and not just this cut", () => {
		const text = reviewWindow([turn(9, 100)], { turns: 4, chars: 20000 });
		expect(text).toContain("4 turn(s), 20000 characters");
	});

	it("adds no header while nothing has been dropped", () => {
		expect(reviewWindow([turn(1, 100)])).not.toContain("omitted");
	});
});

// ---------------------------------------------------------------------------
// The plan: which record calls an extraction implies, and in what order.
// ---------------------------------------------------------------------------

const CLASSES = [
	{ id: "sqli", cwe: ["CWE-89"] },
	{ id: "authz", cwe: ["CWE-639", "CWE-862"] },
	{ id: "ssti", cwe: ["CWE-1336"] },
];

function extraction(over: Partial<Extraction> = {}): Extraction {
	return { surface: [], findings: [], hypotheses: [], classes: [], ...over };
}

function plan(over: Partial<Extraction> = {}, opts: { known?: string[]; allSurface?: string[] } = {}) {
	return planExtraction({
		extraction: extraction(over),
		known: new Set(opts.known ?? []),
		allSurface: opts.allSurface ?? [],
		classes: CLASSES,
	});
}

describe("planning the surface", () => {
	it("records an element the ledger has never seen", () => {
		const { records } = plan({ surface: [{ kind: "endpoint", label: "POST /api/login" }] });
		expect(records).toHaveLength(1);
		expect(records[0]?.args).toEqual({ kind: "endpoint", method: "POST", path: "/api/login" });
		expect(records[0]?.createsLabel).toBe("POST /api/login");
	});

	it("skips one phase one already mapped, so coverage is not split across two rows", () => {
		const { records } = plan(
			{ surface: [{ kind: "endpoint", label: "POST /api/login" }] },
			{ known: ["POST /api/login"] },
		);
		expect(records).toHaveLength(0);
	});

	it("puts every surface row before anything that could point at one", () => {
		const { records } = plan({
			surface: [{ kind: "endpoint", label: "GET /a" }],
			findings: [{ title: "bug", severity: "high", class: "sqli", file: "a.py", line: 1 }],
		});
		expect(records[0]?.createsLabel).toBe("GET /a");
	});
});

describe("planning the class roll-call", () => {
	it("settles the named targets when a class is confirmed", () => {
		const { records } = plan({
			classes: [{ class: "sqli", verdict: "confirmed", targets: ["POST /api/login"], why: "f-string SQL" }],
		});
		expect(records[0]?.args).toMatchObject({
			kind: "hypothesis", class: "sqli", outcome: "confirmed", target: ["POST /api/login"], statement: "f-string SQL",
		});
	});

	it("fans a targetless refutation across everything recorded — the consultant's 'we checked, it is clean'", () => {
		const { records } = plan(
			{ classes: [{ class: "ssti", verdict: "refuted", targets: [], why: "no template rendering" }] },
			{ allSurface: ["id1", "id2", "id3"] },
		);
		expect(records[0]?.args).toMatchObject({ outcome: "refuted", target: ["id1", "id2", "id3"] });
	});

	it("refuses to fan a targetless CONFIRMATION anywhere — 'present somewhere' is not a cell", () => {
		const { records, notes } = plan(
			{ classes: [{ class: "sqli", verdict: "confirmed", targets: [] }] },
			{ allSurface: ["id1", "id2"] },
		);
		expect(records).toHaveLength(0);
		expect(notes.join(" ")).toContain("named no target");
	});

	it("writes nothing at all for not-considered, which is the honesty boundary", () => {
		const { records } = plan(
			{ classes: [{ class: "sqli", verdict: "not-considered", targets: [] }] },
			{ allSurface: ["id1"] },
		);
		expect(records).toHaveLength(0);
	});

	it("carries the reason, because a refutation nobody can audit is a blank cell", () => {
		const { records } = plan(
			{ classes: [{ class: "ssti", verdict: "refuted", targets: [], why: "no template rendering of user input" }] },
			{ allSurface: ["id1"] },
		);
		expect(records[0]?.args.statement).toBe("no template rendering of user input");
	});

	it("falls back to a statement of its own when the extractor gives no reason", () => {
		const { records } = plan(
			{ classes: [{ class: "ssti", verdict: "refuted", targets: [] }] },
			{ allSurface: ["id1"] },
		);
		expect(String(records[0]?.args.statement)).toContain("examined and found clean");
	});

	it("drops a class the checklist does not have, with a note rather than silently", () => {
		const { records, notes } = plan({ classes: [{ class: "telepathy", verdict: "refuted", targets: ["x"] }] });
		expect(records).toHaveLength(0);
		expect(notes.join(" ")).toContain("not in the checklist");
	});
});

describe("planning findings", () => {
	it("recovers the class the extractor omitted, from the CWE the checklist maps", () => {
		const { records } = plan({ findings: [{ title: "SQLi", severity: "critical", cwe: "CWE-89", file: "a.py", line: 4 }] });
		expect(records[0]?.args).toMatchObject({ kind: "finding", class: "sqli", target: "a.py:4" });
	});

	it("omits the class rather than inventing one when nothing maps", () => {
		const { records } = plan({ findings: [{ title: "odd", severity: "low", cwe: "CWE-0000", file: "a.py" }] });
		expect(records[0]?.args).not.toHaveProperty("class");
	});

	it("notes a class the extractor invented instead of passing it through", () => {
		const { notes } = plan({ findings: [{ title: "x", severity: "low", class: "telepathy", cwe: "CWE-89", file: "a.py" }] });
		expect(notes.join(" ")).toContain("not in the checklist");
	});

	it("targets file:line, and file alone when there is no line to trust", () => {
		const withLine = plan({ findings: [{ title: "x", severity: "low", class: "sqli", file: "a.py", line: 9 }] });
		const without = plan({ findings: [{ title: "x", severity: "low", class: "sqli", file: "a.py" }] });
		expect(withLine.records[0]?.args.target).toBe("a.py:9");
		expect(without.records[0]?.args.target).toBe("a.py");
	});

	it("writes the confirmed hypothesis a finding already represents, or the matrix reads zero beside a full report", () => {
		const { records } = plan({ findings: [{ title: "SQLi", severity: "critical", class: "sqli", file: "a.py", line: 4 }] });
		expect(records).toHaveLength(2);
		expect(records[1]?.args).toMatchObject({ kind: "hypothesis", class: "sqli", target: "a.py:4", outcome: "confirmed" });
		expect(records[1]?.dependsOnPrevious).toBe(true);
	});

	it("does not double-settle a cell the extractor already gave a hypothesis for", () => {
		const { records } = plan({
			findings: [{ title: "SQLi", severity: "critical", class: "sqli", file: "a.py", line: 4 }],
			hypotheses: [{ statement: "already", class: "sqli", target: "a.py:4", outcome: "confirmed" }],
		});
		expect(records.filter((r) => r.args.kind === "hypothesis")).toHaveLength(1);
	});

	it("does not double-settle a cell the class roll-call already named", () => {
		const { records } = plan({
			findings: [{ title: "SQLi", severity: "critical", class: "sqli", file: "a.py", line: 4 }],
			classes: [{ class: "sqli", verdict: "confirmed", targets: ["a.py:4"] }],
		});
		expect(records.filter((r) => r.args.kind === "hypothesis")).toHaveLength(1);
	});

	it("still settles a second cell the roll-call did NOT name", () => {
		// The roll-call confirmed sqli in auth.py. A second sqli in orders.py is a
		// different cell, and suppressing it would leave a reported bug untested.
		const { records } = plan({
			findings: [{ title: "SQLi in orders", severity: "high", class: "sqli", file: "orders.py", line: 7 }],
			classes: [{ class: "sqli", verdict: "confirmed", targets: ["auth.py:2"] }],
		});
		expect(records.some((r) => r.args.kind === "hypothesis" && r.args.target === "orders.py:7")).toBe(true);
	});

	it("settles nothing from a finding with no location, since there is no cell to settle", () => {
		const { records } = plan({ findings: [{ title: "vague", severity: "low", class: "sqli" }] });
		expect(records).toHaveLength(1);
	});
});

describe("one extracted element as record arguments", () => {
	it("splits a method off an endpoint label", () => {
		expect(elementArgs({ kind: "endpoint", label: "POST /api/login" }))
			.toEqual({ kind: "endpoint", method: "POST", path: "/api/login" });
	});

	it("keeps a bare path whole when there is no method", () => {
		expect(elementArgs({ kind: "endpoint", label: "/api/login" })).toEqual({ kind: "endpoint", path: "/api/login" });
	});

	it("uses the field each kind is keyed by", () => {
		expect(elementArgs({ kind: "host", label: "10.0.0.1" })).toEqual({ kind: "host", value: "10.0.0.1" });
		expect(elementArgs({ kind: "tech", label: "nginx" })).toEqual({ kind: "tech", name: "nginx" });
	});
});

// ---------------------------------------------------------------------------
// Running the plan.
// ---------------------------------------------------------------------------

/** A `record` that hands back one id per target, and can be told to fail. */
/**
 * A stand-in for the `record` tool. `repeatOn` makes it answer the way the real
 * one does for something already in the ledger: the id it matched, and nothing
 * created.
 */
function fakeRecord(
	failOn: (args: Record<string, unknown>) => boolean = () => false,
	repeatOn: (args: Record<string, unknown>) => boolean = () => false,
) {
	const calls: Array<Record<string, unknown>> = [];
	let n = 0;
	const record = async (args: Record<string, unknown>): Promise<RecordOutcome> => {
		calls.push(args);
		if (failOn(args)) throw new Error("rejected by the ledger");
		const t = args.target;
		const count = Array.isArray(t) ? t.length : 1;
		const ids = Array.from({ length: count }, () => `id${++n}`);
		return { ids, created: repeatOn(args) ? [] : ids };
	};
	return { record, calls };
}

describe("running the plan", () => {
	it("resolves a label to the id the ledger already holds", async () => {
		const { record, calls } = fakeRecord();
		const rows: PlannedRecord[] = [{ args: { kind: "hypothesis", class: "sqli", target: "POST /api/login", outcome: "confirmed" } }];
		await applyPlan(rows, record, new Map([["POST /api/login", "id7"]]));
		expect(calls[0]?.target).toBe("id7");
	});

	it("resolves every label in a bulk target", async () => {
		const { record, calls } = fakeRecord();
		const rows: PlannedRecord[] = [{ args: { kind: "hypothesis", class: "ssti", target: ["a", "b"], outcome: "refuted" } }];
		await applyPlan(rows, record, new Map([["a", "id1"], ["b", "id2"]]));
		expect(calls[0]?.target).toEqual(["id1", "id2"]);
	});

	it("passes an unknown label through rather than dropping the row", async () => {
		const { record, calls } = fakeRecord();
		const rows: PlannedRecord[] = [{ args: { kind: "hypothesis", class: "sqli", target: "a.py:4", outcome: "confirmed" } }];
		await applyPlan(rows, record, new Map());
		expect(calls[0]?.target).toBe("a.py:4");
	});

	it("maps the id of an element it has just created, so later rows can point at it", async () => {
		const { record, calls } = fakeRecord();
		const rows: PlannedRecord[] = [
			{ args: { kind: "endpoint", method: "GET", path: "/a" }, createsLabel: "GET /a" },
			{ args: { kind: "hypothesis", class: "sqli", target: "GET /a", outcome: "confirmed" } },
		];
		await applyPlan(rows, record, new Map());
		expect(calls[1]?.target).toBe("id1");
	});

	it("counts cells by the ids written, never by the calls made", async () => {
		const { record } = fakeRecord();
		const rows: PlannedRecord[] = [{ args: { kind: "hypothesis", class: "ssti", target: ["a", "b", "c"], outcome: "refuted" } }];
		const out = await applyPlan(rows, record, new Map());
		expect(out.settled).toBe(3);
	});

	it("counts what it wrote, by kind", async () => {
		const { record } = fakeRecord();
		const rows: PlannedRecord[] = [
			{ args: { kind: "endpoint", path: "/a" }, createsLabel: "/a" },
			{ args: { kind: "hypothesis", class: "sqli", target: "/a", outcome: "confirmed" } },
			{ args: { kind: "finding", title: "x", severity: "low" } },
		];
		const out = await applyPlan(rows, record, new Map());
		expect(out).toMatchObject({ surface: 1, settled: 1, findings: 1 });
	});

	it("lets one rejected row cost only itself", async () => {
		const { record, calls } = fakeRecord((a) => a.title === "bad");
		const rows: PlannedRecord[] = [
			{ args: { kind: "finding", title: "bad", severity: "low" } },
			{ args: { kind: "finding", title: "good", severity: "low" } },
		];
		const out = await applyPlan(rows, record, new Map());
		expect(calls).toHaveLength(2);
		expect(out.findings).toBe(1);
		expect(out.errors.join(" ")).toContain("bad");
	});

	it("skips the hypothesis a rejected finding would have justified", async () => {
		// Otherwise the matrix gains a confirmed cell with nothing in the report
		// behind it — a coverage claim backed by a row that was never written.
		const { record, calls } = fakeRecord((a) => a.kind === "finding");
		const rows: PlannedRecord[] = [
			{ args: { kind: "finding", title: "x", severity: "low" } },
			{ args: { kind: "hypothesis", class: "sqli", target: "a.py:1", outcome: "confirmed" }, dependsOnPrevious: true },
		];
		const out = await applyPlan(rows, record, new Map());
		expect(calls).toHaveLength(1);
		expect(out.settled).toBe(0);
	});

	it("writes the dependent row when the one before it landed", async () => {
		const { record } = fakeRecord();
		const rows: PlannedRecord[] = [
			{ args: { kind: "finding", title: "x", severity: "low" } },
			{ args: { kind: "hypothesis", class: "sqli", target: "a.py:1", outcome: "confirmed" }, dependsOnPrevious: true },
		];
		expect((await applyPlan(rows, record, new Map())).settled).toBe(1);
	});

	it("keeps quiet about a surface row that fails — the rows pointing at it report themselves", async () => {
		const { record } = fakeRecord((a) => a.kind === "endpoint");
		const rows: PlannedRecord[] = [{ args: { kind: "endpoint", path: "/a" }, createsLabel: "/a" }];
		expect((await applyPlan(rows, record, new Map())).errors).toHaveLength(0);
	});

	it("names the row in the error, so a dropped one can be chased", async () => {
		const { record } = fakeRecord(() => true);
		const rows: PlannedRecord[] = [{ args: { kind: "finding", title: "SQL injection in login", severity: "critical" } }];
		const out = await applyPlan(rows, record, new Map());
		expect(out.errors[0]).toContain("SQL injection in login");
		expect(out.errors[0]).toContain("rejected by the ledger");
	});
});

describe("a pass that offers what is already recorded", () => {
	// This runs at the end of every turn over a review buffer that only grows, so
	// most of what it offers on the fifth turn was already recorded on the fourth.
	// `record` folds those back into the rows they match; counting them as new
	// work would report an engagement that is moving when it is standing still.
	it("counts a repeated finding as a repeat, not as a finding", async () => {
		const { record } = fakeRecord(() => false, (a) => a.kind === "finding");
		const rows: PlannedRecord[] = [{ args: { kind: "finding", title: "IDOR", severity: "high" } }];
		const out = await applyPlan(rows, record, new Map());
		expect(out).toMatchObject({ findings: 0, repeats: 1 });
	});

	it("counts only the cells a bulk row actually settled", async () => {
		const { record } = fakeRecord();
		const half = async (args: Record<string, unknown>) => {
			const { ids } = await record(args);
			return { ids, created: ids.slice(0, 1) };
		};
		const rows: PlannedRecord[] = [{ args: { kind: "hypothesis", class: "ssti", target: ["a", "b", "c"], outcome: "refuted" } }];
		const out = await applyPlan(rows, half, new Map());
		expect(out).toMatchObject({ settled: 1, repeats: 2 });
	});

	it("maps the label of an element that already existed, so later rows point at it", async () => {
		// A pass that mapped only what it created sent every hypothesis about a
		// known element to a label the ledger does not key on.
		const { record, calls } = fakeRecord(() => false, () => true);
		const rows: PlannedRecord[] = [
			{ args: { kind: "endpoint", method: "GET", path: "/a" }, createsLabel: "GET /a" },
			{ args: { kind: "hypothesis", class: "sqli", target: "GET /a", outcome: "confirmed" } },
		];
		const out = await applyPlan(rows, record, new Map());
		expect(calls[1]?.target).toBe("id1");
		expect(out).toMatchObject({ surface: 0, repeats: 2 });
	});
});

describe("impact and remediation, transcribed but never composed", () => {
	// A review says what is broken and where. It rarely says what the flaw costs
	// the client or how to fix it, and this pass reads prose with no evidence
	// files and no client context — so it copies those two when the review states
	// them and omits them otherwise. Composing them here would invent the two
	// claims that do the most damage when invented.
	it("carries them across when the review stated them", () => {
		const { extraction } = parseExtraction(`{
			"surface": [], "hypotheses": [], "classes": [],
			"findings": [{
				"title": "IDOR in /api/user", "severity": "high", "file": "user_routes.py", "line": 41,
				"description": "no ownership check on the id parameter",
				"impact": "any customer can read all 40,000 customer records",
				"remediation": "scope the query to the session user"
			}]
		}`);
		expect(extraction.findings[0]).toMatchObject({
			impact: "any customer can read all 40,000 customer records",
			remediation: "scope the query to the session user",
		});
	});

	it("leaves them undefined when the review said neither", () => {
		const { extraction, errors } = parseExtraction(
			`{"surface":[],"hypotheses":[],"classes":[],"findings":[{"title":"IDOR","severity":"high"}]}`,
		);
		expect(extraction.findings[0]?.impact).toBeUndefined();
		expect(extraction.findings[0]?.remediation).toBeUndefined();
		// Omitting them is a correct answer, not a dropped row.
		expect(errors).toEqual([]);
	});

	it("tells the extractor that omitting them is the expected answer", () => {
		const p = extractionSystemPrompt(["sqli"]);
		expect(p).toMatch(/"impact" and "remediation" are COPIED, never composed/);
		expect(p).toMatch(/omitting them is the correct and expected answer/);
	});

	it("passes them to the record call when they are there, and not when they are not", () => {
		const withBoth = planExtraction({
			extraction: {
				surface: [], hypotheses: [], classes: [],
				findings: [{ title: "IDOR", severity: "high", file: "a.py", line: 4, impact: "40k records", remediation: "scope the query" }],
			},
			known: new Set(), allSurface: [], classes: [],
		});
		expect(withBoth.records[0]?.args).toMatchObject({ impact: "40k records", remediation: "scope the query" });

		const without = planExtraction({
			extraction: { surface: [], hypotheses: [], classes: [], findings: [{ title: "IDOR", severity: "high" }] },
			known: new Set(), allSurface: [], classes: [],
		});
		expect(without.records[0]?.args).not.toHaveProperty("impact");
		expect(without.records[0]?.args).not.toHaveProperty("remediation");
	});
});

describe("deciding whether another extraction pass is worth making", () => {
	const base = { reviewLength: 10_000, lastLength: 0, barren: 0, min: 1200, growth: 2000 };

	it("waits until there is any review at all", () => {
		expect(shouldExtract({ ...base, reviewLength: 800 })).toBe(false);
	});

	it("always makes the first pass — that is the rescue", () => {
		expect(shouldExtract({ ...base, lastLength: 0 })).toBe(true);
	});

	it("does not run again on a turn that added almost nothing", () => {
		// The bug: the buffer grows a little every turn, and a pass fired each time.
		expect(shouldExtract({ ...base, reviewLength: 10_200, lastLength: 10_000 })).toBe(false);
	});

	it("runs once enough new review has accumulated", () => {
		expect(shouldExtract({ ...base, reviewLength: 12_000, lastLength: 10_000 })).toBe(true);
	});

	it("asks for more each time a pass comes back empty", () => {
		const at = (barren: number) => shouldExtract({ ...base, reviewLength: 14_000, lastLength: 10_000, barren });
		expect(at(0)).toBe(true);   // 2k needed
		expect(at(1)).toBe(true);   // 4k needed
		expect(at(2)).toBe(false);  // 8k needed
	});

	it("caps the backoff so a long engagement still gets passes", () => {
		expect(extractionThreshold(2000, 99)).toBe(extractionThreshold(2000, 5));
	});

	it("recovers immediately once a pass writes something", () => {
		expect(shouldExtract({ ...base, reviewLength: 13_000, lastLength: 10_000, barren: 0 })).toBe(true);
	});
});

describe("what a target means depends on what is being recorded", () => {
	it("resolves a hypothesis target to the element id that settles the cell", async () => {
		const seen: Array<Record<string, unknown>> = [];
		await applyPlan(
			[{ args: { kind: "hypothesis", class: "ssrf", target: "POST /fetch", outcome: "refuted", statement: "x" } }],
			async (a) => { seen.push(a); return { ids: ["h1"], created: ["h1"] }; },
			new Map([["POST /fetch", "e1"]]),
		);
		expect(seen[0]?.target).toBe("e1");
	});

	it("leaves a finding's location alone", async () => {
		// "FetchController.php:95" rewritten to "ae6ea1" is unciteable and unscoreable.
		const seen: Array<Record<string, unknown>> = [];
		await applyPlan(
			[{ args: { kind: "finding", title: "SSRF", severity: "high", target: "FetchController.php:95" } }],
			async (a) => { seen.push(a); return { ids: ["f1"], created: ["f1"] }; },
			new Map([["FetchController.php:95", "ae6ea1"]]),
		);
		expect(seen[0]?.target).toBe("FetchController.php:95");
	});
});
