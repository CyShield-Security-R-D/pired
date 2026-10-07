import { describe, expect, it } from "vitest";
import { correctedCall, keptReport, needsLedger, notKept, readRecordCall, refusalMemory, trackReads } from "./record-args.ts";

/** A ledger lookup over a fixed set of ids. */
function ledger(rows: Record<string, string>): (id: string) => ReadonlySet<string> {
	return (id) => new Set(rows[id] ? [rows[id]] : []);
}

describe("reading a record call", () => {
	it("leaves a call that names its kind and canonical fields exactly as sent", () => {
		const raw = { kind: "endpoint", path: "/api/login", method: "POST", auth: "none" };
		const call = readRecordCall(raw);
		expect(call.args).toEqual(raw);
		expect(call.kind).toBe("endpoint");
		expect(call.readAs).toEqual([]);
	});

	/**
	 * 2,168 of the grids' 4,397 refused record calls left `kind` out. Replayed,
	 * 1,862 of them carried fields that only one kind takes — statement and
	 * outcome, or method and auth — and were refused anyway.
	 */
	it("infers a missing kind from fields that only one kind takes, and says which fields named it", () => {
		const hyp = readRecordCall({ statement: "s", class: "authz", target: "e1", outcome: "refuted", approach: "a" });
		expect(hyp.kind).toBe("hypothesis");
		expect(hyp.readAs).toEqual(["no kind → kind=hypothesis (from statement, approach, outcome)"]);
		const ep = readRecordCall({ path: "/api/tags", method: "GET", auth: "user", file: "x.go" });
		expect(ep.kind).toBe("endpoint");
		expect(readRecordCall({ section: "what", text: "t" }).kind).toBe("model");
		expect(readRecordCall({ title: "t", severity: "high" }).kind).toBe("finding");
		expect(readRecordCall({ name: "out.txt", content: "raw" }).kind).toBe("evidence");
	});

	it("takes the kind from the ledger when the call names an existing id and nothing else", () => {
		const call = readRecordCall({ id: "f1", status: "confirmed" }, ledger({ f1: "finding" }));
		expect(call.kind).toBe("finding");
		expect(call.readAs[0]).toContain("f1 is a finding");
	});

	it("refuses rather than guesses when the fields fit two kinds, or none", () => {
		expect(() => readRecordCall({ title: "t", statement: "s" })).toThrow(/fit more than one kind: finding \(title\); hypothesis \(statement\)/);
		expect(() => readRecordCall({ text: "just a thought" })).toThrow(/'kind' is missing, and no field in it belongs to one kind only/);
		expect(() => readRecordCall({ kind: "record", text: "x" })).toThrow(/'record' is not a kind/);
	});

	it("reads an HTTP verb sent as the kind as an endpoint with that method", () => {
		const call = readRecordCall({ kind: "POST", path: "/api/login" });
		expect(call.kind).toBe("endpoint");
		expect(call.args.method).toBe("POST");
		expect(readRecordCall({ kind: "Finding", title: "t", severity: "low" }).kind).toBe("finding");
	});

	/** About 1,000 of the grids' failures: the route sent as `endpoint`, on kind=endpoint. */
	it("reads an endpoint's route sent as 'endpoint', and a request line as its method and path", () => {
		const call = readRecordCall({ kind: "endpoint", endpoint: "POST /api/auth/{provider}/login", auth: "none" });
		expect(call.args).toMatchObject({ path: "/api/auth/{provider}/login", method: "POST" });
		expect(call.args.endpoint).toBeUndefined();
		expect(call.readAs).toEqual(["'endpoint' → 'path'", "path 'POST /api/auth/{provider}/login' → method=POST path=/api/auth/{provider}/login"]);
	});

	it("never overrides a canonical field the call did send", () => {
		const call = readRecordCall({ kind: "endpoint", path: "/real", endpoint: "/other", method: "GET" });
		expect(call.args).toMatchObject({ path: "/real", endpoint: "/other" });
		// A request line whose verb disagrees with the method sent is left as written.
		expect(readRecordCall({ kind: "endpoint", path: "POST /x", method: "GET" }).args.path).toBe("POST /x");
		expect(readRecordCall({ kind: "model", section: "what", text: "kept", value: "v" }).args.text).toBe("kept");
	});

	/** 304 of the grids' failures: a model section's content sent as `value`. */
	it("reads a model section's content sent as 'value' or 'content'", () => {
		expect(readRecordCall({ kind: "model", section: "what", value: "v" }).args.text).toBe("v");
		expect(readRecordCall({ kind: "model", section: "what", content: "c" }).args.text).toBe("c");
	});

	/**
	 * The shipped trace: told "Link them with record id=05763b
	 * hypothesisId=186e87", the agent sent handle=186e87 — the one name-shaped
	 * field the schema showed — and the reply said "Recorded" while the link was
	 * dropped unread.
	 */
	it("reads an id sent as 'handle' by the kind of record it names", () => {
		const rows = ledger({ "186e87": "hypothesis", "05763b": "finding" });
		const link = readRecordCall({ kind: "finding", id: "05763b", handle: "186e87", title: "t", severity: "high" }, rows);
		expect(link.args).toMatchObject({ id: "05763b", hypothesisId: "186e87" });
		expect(link.args.handle).toBeUndefined();
		const own = readRecordCall({ kind: "finding", handle: "05763b" }, rows);
		expect(own.args).toMatchObject({ id: "05763b" });
		expect(readRecordCall({ kind: "finding", hypothesis_id: "186e87", title: "t", severity: "low" }, rows).args.hypothesisId).toBe("186e87");
		expect(readRecordCall({ kind: "hypothesis", id: "h", finding: "05763b" }, rows).args.findingId).toBe("05763b");
	});

	/** 90 of the grids' finding calls carried their only location in `file` or `location`, and lost it. */
	it("reads a finding's file or location as its target, when it sent no target", () => {
		expect(readRecordCall({ kind: "finding", title: "t", severity: "low", file: "app/api.py:245" }).args.target).toBe("app/api.py:245");
		expect(readRecordCall({ kind: "finding", title: "t", severity: "low", location: "a.go:9" }).args.target).toBe("a.go:9");
		expect(readRecordCall({ kind: "finding", title: "t", severity: "low", target: "e1", file: "a.go" }).args).toMatchObject({ target: "e1", file: "a.go" });
	});

	it("leaves a loot handle alone, and a handle that names nothing for the reply to report", () => {
		expect(readRecordCall({ kind: "loot", handle: "cred:web", secret: "s" }).args.handle).toBe("cred:web");
		expect(readRecordCall({ kind: "finding", handle: "F1" }, ledger({})).args.handle).toBe("F1");
	});

	/**
	 * A finding sent with a hypothesis's id as its own id used to be minted
	 * under that id, in the other store: two rows, one id.
	 */
	it("reads a hypothesis id sent as a finding's id as the link, not as the finding's id", () => {
		const rows = ledger({ h1: "hypothesis", e1: "endpoint" });
		const call = readRecordCall({ kind: "finding", id: "h1", title: "t", severity: "high" }, rows);
		expect(call.args.id).toBeUndefined();
		expect(call.args.hypothesisId).toBe("h1");
		const both = readRecordCall({ kind: "finding", id: "h1", hypothesisId: "h2", title: "t", severity: "high" }, rows);
		expect(both.args).toMatchObject({ hypothesisId: "h2" });
		expect(both.args.id).toBeUndefined();
		// Any other kind's id is dropped the same way, and said.
		const host = readRecordCall({ kind: "host", id: "e1", value: "h" }, rows);
		expect(host.args.id).toBeUndefined();
		expect(host.readAs[0]).toContain("e1 is an endpoint, not a host");
	});

	it("reads the ledger only when an id or a missing kind has to be resolved", () => {
		expect(needsLedger({ kind: "host", value: "a" })).toBe(false);
		expect(needsLedger({ kind: "finding", id: "x" })).toBe(true);
		expect(needsLedger({ value: "a" })).toBe(true);
		expect(needsLedger({ kind: "finding", handle: "x" })).toBe(true);
	});
});

describe("what a write did not keep", () => {
	it("names fields the write never read, and fields it threw away unread", () => {
		const sent = { kind: "finding", title: "t", notes: "n", handle: "h", pass: 3, empty: "" };
		const { args, reads } = trackReads({ ...sent });
		void args.title;
		delete args.pass;
		expect(notKept(sent, reads, "finding")).toEqual([
			"notes (a finding has no notes; put it in description, or record kind=note)",
			"handle (only kind=loot has a handle; to change a record pass id=<its id>, and to link the hypothesis this writes up pass hypothesisId=<its id>)",
			"pass (pired stamps which pass found a row)",
		]);
	});

	it("names a value the write drops because it is not one a field takes", () => {
		const sent = { kind: "finding", status: "Confirmed", source: "observed" };
		const { args, reads } = trackReads({ ...sent });
		void args.status;
		void args.source;
		expect(notKept(sent, reads, "finding")).toEqual([
			'status="Confirmed" (not one of suspected, open, confirmed, triaged, reported, refuted, false-positive, accepted-risk, ignored)',
		]);
	});

	it("counts `in` as a read, and gives other kinds a plain reason", () => {
		const { args, reads } = trackReads({ approach: "a", x: 1 });
		void ("x" in args);
		expect(notKept({ approach: "a", x: 1 }, reads, "finding")[0]).toContain("approach belongs to a hypothesis");
		expect(notKept({ y: 1 }, reads, "host")).toEqual(["y (not a field a kind=host call keeps)"]);
		expect(notKept({ entitlement: "e" }, reads, "finding")[0]).toContain("read only when this call settles the finding's status");
		expect(notKept({ live: true }, reads, "hypothesis")[0]).toContain("kept only when re-checking a recorded hypothesis by id");
		expect(notKept({ path: ["a.py:1: x"] }, reads, "hypothesis")[0]).toContain("a verdict input for a finding");
		expect(notKept({ note: "n" }, reads, "hypothesis")[0]).toContain("a hypothesis has no note");
		expect(notKept({ endpoint: "/x" }, reads, "endpoint")[0]).toContain("an endpoint's route goes in path");
		expect(notKept({ host: "h" }, reads, "finding")[0]).toContain("a finding's location goes in target");
	});

	it("puts what was not kept first, and the reading of the call last", () => {
		expect(keptReport([], [])).toEqual({ before: "", after: "" });
		const report = keptReport(["'endpoint' → 'path'"], ["notes (x)"]);
		expect(report.before).toBe("Not stored: notes (x). The rest of this call was recorded.\n");
		// Reasons carry semicolons of their own, so several are a list, not a run-on line.
		expect(keptReport([], ["a (x; y)", "b (z)"]).before).toBe("Not stored:\n- a (x; y)\n- b (z)\nThe rest of this call was recorded.\n");
		expect(report.after).toBe("\nRead this call as: 'endpoint' → 'path'. Use the names on the right next time.");
	});
});

describe("refusals", () => {
	it("builds the call to send instead from the one that was refused", () => {
		const fix = correctedCall("record hypothesis: 'statement' is required, but was not received.", {
			kind: "hypothesis", class: "authz", target: ["e1", "e2"], approach: "x".repeat(80),
		});
		expect(fix).toContain('Send instead: record kind=hypothesis class="authz" target=["e1","e2"] approach="' + "x".repeat(60) + '…" statement="<one sentence');
		expect(fix).toContain("cut short above; send them in full");
		expect(correctedCall("record finding: 'cwe' is required", { kind: "finding" })).toContain('cwe="<cwe>"');
		expect(correctedCall("record finding: evidence path(s) do not resolve", {})).toBe("");
	});

	it("tells a resent refusal that it will be refused again, and forgets after a call goes through", () => {
		const memory = refusalMemory();
		const call = { kind: "endpoint", auth: "none" };
		const boom = new Error("record endpoint: 'path' is required, but was not received.");
		expect(memory.refused(call, boom).message).not.toContain("refused 2 times");
		expect(memory.refused({ auth: "none", kind: "endpoint" }, boom, ["x → y"]).message).toContain("This exact call has now been refused 2 times");
		expect(memory.refused(call, boom).message).toContain("refused 3 times");
		memory.accepted();
		expect(memory.refused(call, boom).message).not.toContain("refused");
		expect(memory.refused(call, "a string").message).toBe("a string");
	});

	/**
	 * The grids' common pattern: not the same call again but the same mistake on
	 * the next one — 394 runs of three or more refusals in a row for one reason,
	 * the longest 39 endpoints each sent with `endpoint` for `path`.
	 */
	it("says when consecutive different calls are refused for the same reason", () => {
		const memory = refusalMemory();
		const missing = (got: string) => new Error(`record hypothesis: 'statement' is required, but was not received. Fields received: ${got}.`);
		expect(memory.refused({ kind: "hypothesis", target: "a" }, missing("target")).message).not.toContain("same reason");
		expect(memory.refused({ kind: "hypothesis", target: "b", class: "x" }, missing("target, class")).message)
			.toContain("The last 2 record calls were refused for this same reason.");
		expect(memory.refused({ kind: "finding" }, new Error("record finding: 'title' is required")).message).not.toContain("same reason");
	});

	it("says how it read a refused call", () => {
		const out = refusalMemory().refused({ kind: "endpoint" }, new Error("nope"), ["no kind → kind=endpoint (from auth)"]);
		expect(out.message).toBe("nope\nRead this call as: no kind → kind=endpoint (from auth).");
	});
});
