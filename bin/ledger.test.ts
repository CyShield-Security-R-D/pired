import { describe, expect, it } from "vitest";
import { coerceValue, LEDGER_USAGE, parseAssignments, parseLedgerArgv, planPassVerb, renderScope, resultText } from "./ledger.mjs";

describe("coerceValue", () => {
	/**
	 * `core/tools.ts` reads a number with `typeof v === "number"`, so a port that
	 * arrives as the string "80" is not rejected — it is dropped, and the service
	 * lands in the ledger with no port at all. A CLI that passed everything
	 * through as a string would lose a field per record and say nothing.
	 */
	it("makes an integer a number, because the tool silently drops a numeric string", () => {
		expect(coerceValue("80")).toBe(80);
		expect(coerceValue("-1")).toBe(-1);
		expect(coerceValue("0")).toBe(0);
	});

	it("makes true and false booleans, which is how delete= is read", () => {
		expect(coerceValue("true")).toBe(true);
		expect(coerceValue("false")).toBe(false);
	});

	/** Guessing past integers would turn a version into something that matches nothing. */
	it("leaves everything else a string, versions and paths included", () => {
		expect(coerceValue("1.0")).toBe("1.0");
		expect(coerceValue("CWE-89")).toBe("CWE-89");
		expect(coerceValue("core/search.js:42")).toBe("core/search.js:42");
		expect(coerceValue("")).toBe("");
		expect(coerceValue("007")).toBe(7);
	});

	it("refuses an integer too large to survive the round trip", () => {
		expect(coerceValue("99999999999999999999")).toBe("99999999999999999999");
	});
});

describe("parseAssignments", () => {
	it("reads key=value pairs", () => {
		expect(parseAssignments(["kind=finding", "severity=high"])).toEqual({ kind: "finding", severity: "high" });
	});

	/** `evidence` and `locations` take several, and nobody should hand-write JSON in a shell. */
	it("builds a list from a repeated key", () => {
		expect(parseAssignments(["evidence=a.js:1", "evidence=b.js:2", "evidence=c.js:3"]))
			.toEqual({ evidence: ["a.js:1", "b.js:2", "c.js:3"] });
	});

	/** Only the first `=` is structural, or an evidence path with one in it would split. */
	it("keeps an = inside the value", () => {
		expect(parseAssignments(["repro=GET /search?q=' OR 1=1--"]))
			.toEqual({ repro: "GET /search?q=' OR 1=1--" });
	});

	it("refuses a token that is not an assignment rather than ignoring it", () => {
		expect(() => parseAssignments(["gaps"])).toThrow(/expected key=value/);
		expect(() => parseAssignments(["=novalue"])).toThrow(/expected key=value/);
	});
});

describe("parseLedgerArgv", () => {
	it("takes recall's query positionally, the way the skills already write it", () => {
		expect(parseLedgerArgv(["recall", "gaps"])).toMatchObject({ verb: "recall", args: { query: "gaps" } });
		expect(parseLedgerArgv(["recall", "challenge", "id=f3"]))
			.toMatchObject({ verb: "recall", args: { query: "challenge", id: "f3" } });
	});

	it("defaults a bare recall to status, as the tool does", () => {
		expect(parseLedgerArgv(["recall"]).args).toEqual({ query: "status" });
		expect(parseLedgerArgv(["recall", "limit=5"]).args).toEqual({ query: "status", limit: 5 });
	});

	it("passes record's assignments straight through", () => {
		expect(parseLedgerArgv(["record", "kind=service", "host=h1", "port=8080"]).args)
			.toEqual({ kind: "service", host: "h1", port: 8080 });
	});

	it("keeps the CLI's own flags out of the tool's arguments", () => {
		const plan = parseLedgerArgv(["--engagement", "acme", "--json", "recall", "gaps"]);
		expect(plan).toMatchObject({ verb: "recall", engagement: "acme", json: true });
		expect(plan.args).toEqual({ query: "gaps" });
	});

	it("asks for help when given nothing, rather than guessing a verb", () => {
		expect(parseLedgerArgv([]).help).toBe(true);
		expect(parseLedgerArgv(["--help"]).help).toBe(true);
		expect(parseLedgerArgv(["-h"]).help).toBe(true);
	});

	it("names the verbs it does have when handed one it does not", () => {
		expect(() => parseLedgerArgv(["reccord", "kind=note"])).toThrow(/unknown verb "reccord"/);
		expect(() => parseLedgerArgv(["reccord", "kind=note"])).toThrow(/record, recall, scope/);
	});

	it("refuses --engagement with nothing after it", () => {
		expect(() => parseLedgerArgv(["--engagement"])).toThrow(/needs a name/);
		expect(() => parseLedgerArgv(["--engagement", "--json", "recall"])).toThrow(/needs a name/);
	});

	it("documents the subagent case it exists for", () => {
		expect(LEDGER_USAGE).toMatch(/without pired's extension/);
		expect(LEDGER_USAGE).toMatch(/pired-ledger recall gaps/);
	});
});

describe("renderScope", () => {
	const scope = {
		engagement: "acme-web",
		authorized: true,
		mode: "enforce",
		targets: { domains: ["*.acme.test"], ips: ["10.0.0.5"] },
	};

	it("prints the boundary a child has to stay inside", () => {
		const out = renderScope(scope);
		expect(out).toMatch(/engagement\s+acme-web/);
		expect(out).toMatch(/authorized\s+yes/);
		expect(out).toMatch(/\*\.acme\.test/);
		expect(out).toMatch(/10\.0\.0\.5/);
	});

	/**
	 * The honest half. A child never loaded the extension, so it is outside
	 * `createScopeGate` entirely — a CLI cannot enforce a boundary on a process
	 * that is free not to call it, and implying otherwise would be worse than
	 * saying nothing.
	 */
	it("says plainly that it reports the boundary and does not enforce it", () => {
		expect(renderScope(scope)).toMatch(/does not enforce/);
		expect(renderScope(scope)).toMatch(/outside/);
	});

	it("shows an unauthorized engagement as NO, not as a quiet omission", () => {
		expect(renderScope({ ...scope, authorized: false })).toMatch(/authorized\s+NO/);
	});

	it("says there is no authorization at all when there is no scope file", () => {
		expect(renderScope(undefined)).toMatch(/No scope file found/);
		expect(renderScope(undefined)).toMatch(/read-only local work is still fine/);
	});

	it("says so rather than printing an empty target list", () => {
		expect(renderScope({ ...scope, targets: {} })).toMatch(/none named/);
	});

	it("marks exclusions so they cannot be read as targets", () => {
		const out = renderScope({ ...scope, exclude: { domains: ["prod.acme.test"] } });
		expect(out).toMatch(/!domains\s+prod\.acme\.test/);
	});

	it("reports strict mode, which changes what an unparseable command does", () => {
		expect(renderScope({ ...scope, strictUnresolved: true })).toMatch(/enforce\/strict/);
	});
});

describe("resultText", () => {
	it("joins the text a tool returned", () => {
		expect(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
	});

	/** An image has no text; skipping it must not blank the whole result. */
	it("skips non-text content instead of emitting undefined", () => {
		expect(resultText({ content: [{ type: "image", data: "..." }, { type: "text", text: "kept" }] })).toBe("kept");
	});

	it("is empty for a result that carried nothing printable", () => {
		expect(resultText({ content: [] })).toBe("");
		expect(resultText({})).toBe("");
		expect(resultText(undefined)).toBe("");
	});
});

describe("the pass verb", () => {
	it("takes its argument positionally, the way a skill would write it", () => {
		expect(parseLedgerArgv(["pass"])).toMatchObject({ verb: "pass", args: { arg: "" } });
		expect(parseLedgerArgv(["pass", "next"])).toMatchObject({ verb: "pass", args: { arg: "next" } });
		expect(parseLedgerArgv(["pass", "next", "--engagement", "acme"])).toMatchObject({ verb: "pass", engagement: "acme" });
	});

	it("reports without opening unless asked to open", () => {
		// Opening a pass spends the operator's budget and touches the client's
		// systems again. A bare `pass` is a question, not an instruction.
		expect(planPassVerb("")).toEqual({ open: false });
		expect(planPassVerb("status")).toEqual({ open: false });
		expect(planPassVerb(undefined)).toEqual({ open: false });
		expect(planPassVerb("next")).toEqual({ open: true });
		expect(planPassVerb("  NEXT  ")).toEqual({ open: true });
	});

	it("refuses a named lens and says how to reach it anyway", () => {
		// A CLI invocation has no session to hold a promoted lens in, and the two
		// places it could persist are the operator's scope.json — which a child has
		// no business rewriting — and a second copy in the manifest, which would
		// make the ladder and the manifest two answers to one question. The ladder
		// is the answer, and PIRED_PASSES sets it for exactly this kind of run.
		expect(() => planPassVerb("adversarial")).toThrow(/PIRED_PASSES=adversarial/);
	});

	it("is listed in the usage, since a verb nobody can discover is a verb nobody uses", () => {
		expect(LEDGER_USAGE).toContain("pired-ledger pass [next]");
	});
});
