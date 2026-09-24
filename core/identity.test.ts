import { describe, expect, it } from "vitest";
import {
	findDuplicate,
	findingLocation,
	findNearDuplicate,
	clearanceRechecked,
	holdsLeadOpen,
	isNoOp,
	leadMeetsClearance,
	mergeRecord,
	reopensLead,
	titleOverlap,
	type Fields,
	updateById,
} from "./identity.ts";

/**
 * Record identity. Every rule here decides whether two rows are one thing, and
 * getting it wrong in either direction is expensive in a way the agent cannot
 * see: too eager and a real second finding is folded into the first and lost
 * from the deliverable; too shy and the ledger grows a copy of itself every
 * turn, coverage denominators double, and one cell holds two disagreeing rows.
 */

const rec = (over: Fields): Fields => ({ ...over });

describe("identifying a host", () => {
	it("is the same host under a different spelling", () => {
		expect(findDuplicate("host", { kind: "host", value: "Example.COM" }, [
			rec({ kind: "host", value: "example.com", id: "h1" }),
		])).toMatchObject({ id: "h1" });
	});

	it("ignores a scheme, a path and a trailing dot, which name the same machine", () => {
		const existing = [rec({ kind: "host", value: "example.com", id: "h1" })];
		for (const value of ["https://example.com", "example.com/", "example.com."]) {
			expect(findDuplicate("host", { kind: "host", value }, existing)).toMatchObject({ id: "h1" });
		}
	});

	it("falls back to the address when neither row has a name", () => {
		expect(findDuplicate("host", { kind: "host", ip: "10.0.0.1" }, [
			rec({ kind: "host", ip: "10.0.0.1", id: "h1" }),
		])).toMatchObject({ id: "h1" });
	});

	it("keeps two genuinely different hosts apart", () => {
		expect(findDuplicate("host", { kind: "host", value: "other.com" }, [
			rec({ kind: "host", value: "example.com", id: "h1" }),
		])).toBeUndefined();
	});
});

describe("identifying an endpoint", () => {
	const existing = [rec({ kind: "endpoint", method: "POST", path: "/api/login", id: "e1" })];

	it("ignores a query string, a fragment and a trailing slash", () => {
		for (const path of ["/api/login?next=/", "/api/login#form", "/api/login/"]) {
			expect(findDuplicate("endpoint", { kind: "endpoint", method: "POST", path }, existing)).toMatchObject({ id: "e1" });
		}
	});

	it("treats a qualifier only one side carries as agreement, not as a second route", () => {
		// The extractor writes {endpoint, path} with no method; the agent writes the
		// same route with one. Splitting those would halve the route's coverage.
		expect(findDuplicate("endpoint", { kind: "endpoint", path: "/api/login" }, existing)).toMatchObject({ id: "e1" });
	});

	it("still separates two methods on one path when both are stated", () => {
		expect(findDuplicate("endpoint", { kind: "endpoint", method: "GET", path: "/api/login" }, existing)).toBeUndefined();
	});

	it("separates the same path on two hosts", () => {
		expect(findDuplicate("endpoint", { kind: "endpoint", path: "/api/login", host: "b.com" }, [
			rec({ kind: "endpoint", path: "/api/login", host: "a.com", id: "e1" }),
		])).toBeUndefined();
	});

	it("never matches an endpoint against a host sharing the inventory store", () => {
		expect(findDuplicate("endpoint", { kind: "endpoint", path: "/api" }, [
			rec({ kind: "host", value: "/api", id: "h1" }),
		])).toBeUndefined();
	});
});

describe("identifying a service, a param and a technology", () => {
	it("matches a service on host and port however the port was serialized", () => {
		const existing = [rec({ kind: "service", host: "a.com", port: 8080, id: "s1" })];
		expect(findDuplicate("service", { kind: "service", host: "a.com", port: "8080" }, existing)).toMatchObject({ id: "s1" });
	});

	it("separates two ports on one host", () => {
		expect(findDuplicate("service", { kind: "service", host: "a.com", port: 443 }, [
			rec({ kind: "service", host: "a.com", port: 80, id: "s1" }),
		])).toBeUndefined();
	});

	it("matches a param by name within its endpoint", () => {
		const existing = [rec({ kind: "param", name: "username", endpoint: "POST /login", id: "p1" })];
		expect(findDuplicate("param", { kind: "param", name: "username", endpoint: "POST /login" }, existing)).toMatchObject({ id: "p1" });
		expect(findDuplicate("param", { kind: "param", name: "username", endpoint: "POST /signup" }, existing)).toBeUndefined();
	});

	it("treats nginx and nginx 1.18 as one technology seen twice", () => {
		expect(findDuplicate("tech", { kind: "tech", name: "nginx", version: "1.18" }, [
			rec({ kind: "tech", name: "nginx", id: "t1" }),
		])).toMatchObject({ id: "t1" });
	});
});

describe("identifying a hypothesis — one cell, one row", () => {
	const existing = [rec({ kind: "hypothesis", target: "e1", class: "sqli", outcome: "proposed", id: "y1" })];

	it("matches on target and class, whatever the statement says", () => {
		expect(findDuplicate("hypothesis", {
			kind: "hypothesis", target: "e1", class: "sqli", statement: "worded entirely differently", outcome: "refuted",
		}, existing)).toMatchObject({ id: "y1" });
	});

	it("keeps two classes on one target apart — they are two cells", () => {
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "e1", class: "authz" }, existing)).toBeUndefined();
	});

	it("returns the most recent row for a cell written more than once", () => {
		const many = [
			rec({ kind: "hypothesis", target: "e1", class: "sqli", id: "old" }),
			rec({ kind: "hypothesis", target: "e1", class: "sqli", id: "new" }),
		];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "e1", class: "sqli" }, many)).toMatchObject({ id: "new" });
	});
});

describe("locating a finding", () => {
	it("prefers file:line, which two recordings of one bug agree on when their prose does not", () => {
		expect(findingLocation({ target: "backend/auth.py:42" })).toBe("backend/auth.py:42");
	});

	it("digs the coordinate out of the description or the evidence", () => {
		expect(findingLocation({ description: "the sink is backend/auth.py:42 here" })).toBe("backend/auth.py:42");
		expect(findingLocation({ evidence: ["see backend/auth.py:42"] })).toBe("backend/auth.py:42");
	});

	it("falls back to the target for a finding with no line at all", () => {
		// "no dependency pins", "/admin has no authentication" — still findings.
		expect(findingLocation({ target: "/admin/" })).toBe("/admin");
	});

	it("has no location to offer when nothing names one", () => {
		expect(findingLocation({ title: "weak crypto" })).toBeUndefined();
	});

	it("does not read a host and port as a file and a line", () => {
		// The pattern requires letters after the last dot, so 10.0.0.4:8080 is a
		// service, not backend/auth.py:42, and stays whole as the target it is.
		expect(findingLocation({ target: "10.0.0.4:8080" })).toBe("10.0.0.4:8080");
	});
});

describe("comparing finding titles", () => {
	it("scores one bug described at two lengths as overlapping", () => {
		// Containment, not Jaccard: a symmetric measure calls this pair unrelated,
		// because the longer title carries four words the shorter one never had.
		expect(titleOverlap("SQL injection in login", "SQL injection in the login handler via the username parameter"))
			.toBe(1);
	});

	it("recognises the abbreviation security titles are actually written in", () => {
		// This pair is the example in titleOverlap's own comment, and under exact
		// word equality it scored 0.5 — under the 0.6 the near-duplicate check
		// requires, so the motivating case went unreported. A shared prefix of three
		// characters or more settles it without a dictionary: sqli/sql,
		// injections/injection, xxe/xxe. Only the warning reads this, never the
		// merge, so a loose match costs a line of text and can never lose a finding.
		expect(titleOverlap("SQLi in login", "SQL injection in the login handler via the username parameter")).toBe(1);
		// A prefix does not reach every abbreviation — authz and authorization part
		// company at the fifth character — and it does not have to: the rest of the
		// title carries such a pair over the bar on its own.
		expect(titleOverlap("Missing authz on /admin", "Missing authorization on /admin")).toBeGreaterThan(0.6);
	});

	it("still cannot be pushed above a perfect score by an abbreviation and its expansion", () => {
		// "sql" and "sqli" both match "sqli"; counting over the shorter side keeps
		// the ratio a ratio.
		expect(titleOverlap("SQL SQLi", "SQLi")).toBe(1);
	});

	it("ignores function words, so a rewording still matches", () => {
		expect(titleOverlap("SQL injection in login", "SQL injection of the login")).toBe(1);
	});

	it("scores two different bugs low", () => {
		expect(titleOverlap("SQL injection in login", "weak password hashing")).toBeLessThan(0.6);
	});

	it("scores an empty title as no overlap rather than as a perfect one", () => {
		expect(titleOverlap("", "anything")).toBe(0);
	});
});

describe("identifying a finding", () => {
	it("is the same finding when the words and the place agree", () => {
		expect(findDuplicate("finding", { kind: "finding", title: "SQL injection in login", target: "auth.py:4" }, [
			rec({ kind: "finding", title: "SQL injection in login", target: "auth.py:4", id: "f1" }),
		])).toMatchObject({ id: "f1" });
	});

	it("is the same finding at one coordinate under one class, however it was worded", () => {
		expect(findDuplicate("finding", { kind: "finding", title: "unsanitised SQL", class: "sqli", target: "auth.py:4" }, [
			rec({ kind: "finding", title: "f-string query built from input", class: "sqli", target: "auth.py:4", id: "f1" }),
		])).toMatchObject({ id: "f1" });
	});

	it("keeps two different bugs on one line apart, because their classes differ", () => {
		expect(findDuplicate("finding", { kind: "finding", title: "no authn", class: "authn", target: "api.py:9" }, [
			rec({ kind: "finding", title: "no authz", class: "authz", target: "api.py:9", id: "f1" }),
		])).toBeUndefined();
	});

	it("is one finding when neither recording has a place to name", () => {
		// "No dependency pins", "secrets printed to stdout" — worth reporting, with
		// no line to hang off. Two of those are still one finding.
		expect(findDuplicate("finding", { kind: "finding", title: "No dependency pins — SCA impossible" }, [
			rec({ kind: "finding", title: "No dependency pins — SCA impossible", severity: "info", id: "f1" }),
		])).toMatchObject({ id: "f1" });
	});

	it("keeps the same title at two different places apart", () => {
		expect(findDuplicate("finding", { kind: "finding", title: "SQL injection", target: "orders.py:7" }, [
			rec({ kind: "finding", title: "SQL injection", target: "auth.py:4", id: "f1" }),
		])).toBeUndefined();
	});
});

describe("the near-duplicate a human has to judge", () => {
	const existing = [rec({ kind: "finding", title: "SQL injection in the login handler", target: "auth.py:4", id: "f1" })];

	it("reports the uncertain case rather than merging it", () => {
		// Losing a real finding costs recall, which is the one thing the harness is
		// measured on — so the uncertain case writes the row and says what it saw.
		expect(findNearDuplicate({ title: "SQL injection in login", target: "auth.py:4" }, existing)).toMatchObject({ id: "f1" });
	});

	it("says nothing when the words do not overlap enough", () => {
		expect(findNearDuplicate({ title: "hardcoded API key", target: "auth.py:4" }, existing)).toBeUndefined();
	});

	it("says nothing about a finding with no location to compare", () => {
		expect(findNearDuplicate({ title: "SQL injection in the login handler" }, existing)).toBeUndefined();
	});
});

describe("folding a second recording into the first", () => {
	it("takes the newer value by default", () => {
		expect(mergeRecord("endpoint", { path: "/a", auth: "none" }, { auth: "session" }).auth).toBe("session");
	});

	it("unions the list fields, so a second sighting adds rather than replaces", () => {
		const merged = mergeRecord("endpoint", { params: ["a", "b"] }, { params: ["b", "c"] });
		expect(merged.params).toEqual(["a", "b", "c"]);
	});

	it("never lets a repeat filed as info downgrade a high", () => {
		expect(mergeRecord("finding", { severity: "high" }, { severity: "info" }).severity).toBe("high");
	});

	it("does take the worse severity when the repeat is worse", () => {
		expect(mergeRecord("finding", { severity: "low" }, { severity: "critical" }).severity).toBe("critical");
	});

	it("keeps the fuller prose, so a terser re-recording cannot shorten the report", () => {
		const merged = mergeRecord("finding", { description: "a long and careful explanation" }, { description: "sqli" });
		expect(merged.description).toBe("a long and careful explanation");
	});

	it("still accepts prose that says more", () => {
		const merged = mergeRecord("finding", { description: "sqli" }, { description: "a long and careful explanation" });
		expect(merged.description).toBe("a long and careful explanation");
	});

	it("will not let re-proposing a cell un-test it", () => {
		const merged = mergeRecord("hypothesis", { outcome: "confirmed", statement: "it is vulnerable" }, { outcome: "proposed", statement: "worth checking" });
		expect(merged.outcome).toBe("confirmed");
		// The statement travels with the outcome, or the cell reads as confirmed
		// above the sentence that merely proposed it.
		expect(merged.statement).toBe("it is vulnerable");
	});

	it("will not let a refutation quietly clear a cell already confirmed vulnerable", () => {
		expect(mergeRecord("hypothesis", { outcome: "confirmed" }, { outcome: "refuted" }).outcome).toBe("confirmed");
	});

	it("does let a proposed cell advance to confirmed", () => {
		expect(mergeRecord("hypothesis", { outcome: "proposed" }, { outcome: "confirmed" }).outcome).toBe("confirmed");
	});

	/**
	 * By rank alone refuted(3) beat inconclusive(2), so any later refutation in the
	 * cell closed the lead whatever it was about. Measured on the 2026-09-24 grid:
	 * a lead recorded inconclusive ("cannot verify offline") was overwritten by a
	 * refutation of a different mechanism in the same cell, and the baseline run
	 * confirmed the issue the lead was about.
	 */
	it("leaves an inconclusive lead open when a refutation that never named it lands on its cell", () => {
		const merged = mergeRecord(
			"hypothesis",
			{ outcome: "inconclusive", statement: "stored script via the upload path; cannot verify offline" },
			{ outcome: "refuted", statement: "the comment renderer escapes every field before output" },
		);
		expect(merged.outcome).toBe("inconclusive");
		// The statement stays with the outcome it explains, or the open lead reads
		// as the refutation's sentence.
		expect(merged.statement).toBe("stored script via the upload path; cannot verify offline");
	});

	it("still lets a refutation settle a cell that was only proposed or being tested", () => {
		for (const outcome of ["proposed", "testing"]) {
			const merged = mergeRecord("hypothesis", { outcome, statement: "worth checking" }, { outcome: "refuted", statement: "every query is parameterised" });
			expect(merged.outcome).toBe("refuted");
			expect(merged.statement).toBe("every query is parameterised");
		}
	});

	it("names exactly the case it holds back: a refutation arriving on an inconclusive cell", () => {
		expect(holdsLeadOpen({ outcome: "inconclusive" }, { outcome: "refuted" })).toBe(true);
		expect(holdsLeadOpen({ outcome: "Inconclusive" }, { outcome: " refuted " })).toBe(true);
		// Everything else is the rank rule's business, and saying "held" for it
		// would tell the agent a lead is open when none is.
		expect(holdsLeadOpen({ outcome: "confirmed" }, { outcome: "refuted" })).toBe(false);
		expect(holdsLeadOpen({ outcome: "testing" }, { outcome: "refuted" })).toBe(false);
		expect(holdsLeadOpen({ outcome: "inconclusive" }, { outcome: "confirmed" })).toBe(false);
		expect(holdsLeadOpen({ outcome: "inconclusive" }, { outcome: "inconclusive" })).toBe(false);
	});
});

describe("an open lead, whichever order it and a clearance arrive in, on a write of that one cell", () => {
	// Round one held the lead only when it was recorded first. Recorded second,
	// rank kept the refutation — which was written before the lead existed and so
	// cannot have examined it. Two workers on one cell finish in whichever order
	// they finish, so for a write that names the cell by itself the answer does
	// not depend on it. `reopen` is how the caller says it is that write.
	const ONE = { reopen: true };
	const LEAD = { outcome: "inconclusive", statement: "the export path writes a caller-named file; cannot verify offline" };
	const CLEARANCE = {
		outcome: "refuted", statement: "the upload handler resolves the path and checks it stays under the root",
		method: "read the upload handler", evidence: "evidence/upload-root-check.txt",
	};

	it("ends inconclusive, on the lead's own sentence, in both orders", () => {
		const leadFirst = mergeRecord("hypothesis", LEAD, CLEARANCE, ONE);
		const clearanceFirst = mergeRecord("hypothesis", CLEARANCE, LEAD, ONE);
		for (const merged of [leadFirst, clearanceFirst]) {
			expect(merged.outcome).toBe("inconclusive");
			expect(merged.statement).toBe(LEAD.statement);
		}
	});

	it("does not carry the clearance's method or evidence onto the lead, in either order", () => {
		// Left on the row they read as the grounds for a lead they never examined.
		for (const merged of [mergeRecord("hypothesis", LEAD, CLEARANCE, ONE), mergeRecord("hypothesis", CLEARANCE, LEAD, ONE)]) {
			expect(merged.method).toBeUndefined();
			expect(merged.evidence).toBeUndefined();
		}
	});

	it("keeps the lead's own method and evidence when it has them", () => {
		const lead = { ...LEAD, method: "traced the export route", evidence: "evidence/export-trace.txt" };
		for (const merged of [mergeRecord("hypothesis", lead, CLEARANCE, ONE), mergeRecord("hypothesis", CLEARANCE, lead, ONE)]) {
			expect(merged).toMatchObject({ method: "traced the export route", evidence: "evidence/export-trace.txt" });
		}
	});

	it("does not reopen a clearance for the same claim offered again", () => {
		// A lead that says what the refutation already said is a re-offer, not new
		// information; reopening on it would un-clear cells every time the
		// extractor re-read its buffer.
		const merged = mergeRecord("hypothesis", CLEARANCE, { outcome: "inconclusive", statement: `  ${CLEARANCE.statement.toUpperCase()} ` }, ONE);
		expect(merged).toMatchObject({ outcome: "refuted", statement: CLEARANCE.statement, method: CLEARANCE.method });
	});

	/**
	 * Reopening on every lead in other words was too eager: different wording is
	 * not a different mechanism, and a clearance is a check of its own cell. A
	 * merge that does not say it is a one-cell write — a cross product, the
	 * extractor's planner, a dedupe fold — keeps the clearance, whole.
	 */
	it("keeps the clearance whole when the merge does not say it is a write of that one cell", () => {
		const merged = mergeRecord("hypothesis", CLEARANCE, LEAD);
		expect(merged).toMatchObject({ outcome: "refuted", statement: CLEARANCE.statement, method: CLEARANCE.method, evidence: CLEARANCE.evidence });
		expect(isNoOp(CLEARANCE, merged)).toBe(true);
	});

	it("keeps a clearance that was re-checked by id with a basis, even on a one-cell write", () => {
		const rechecked = { ...CLEARANCE, verification: { verdict: "stands", at: "t1", basis: ["upload.go:31"] } };
		const merged = mergeRecord("hypothesis", rechecked, LEAD, ONE);
		expect(merged).toMatchObject({ outcome: "refuted", statement: CLEARANCE.statement, method: CLEARANCE.method });
		expect(merged.verification).toEqual(rechecked.verification);
	});

	it("drops the stale verification with the method and evidence when it does reopen", () => {
		// A look that settled nothing does not protect the clearance, and left on
		// the reopened row it would read as a second look at the lead.
		const unsettled = { ...CLEARANCE, verification: { verdict: "unresolved", at: "t1", notes: "could not reach the export route" } };
		const merged = mergeRecord("hypothesis", unsettled, LEAD, ONE);
		expect(merged).toMatchObject({ outcome: "inconclusive", statement: LEAD.statement });
		expect(merged.verification).toBeUndefined();
		expect(merged.method).toBeUndefined();
		expect(merged.evidence).toBeUndefined();
	});

	it("names exactly the case it reopens: a different lead arriving on a refuted cell nobody re-checked", () => {
		expect(reopensLead(CLEARANCE, LEAD)).toBe(true);
		expect(leadMeetsClearance(CLEARANCE, LEAD)).toBe(true);
		// Re-checked by id with a basis: the lead still met it, and is still named,
		// but it does not reopen it.
		const rechecked = { ...CLEARANCE, verification: { verdict: "amended", at: "t1", basis: ["upload.go:31"] } };
		expect(leadMeetsClearance(rechecked, LEAD)).toBe(true);
		expect(reopensLead(rechecked, LEAD)).toBe(false);
		expect(reopensLead(CLEARANCE, { ...LEAD, statement: CLEARANCE.statement })).toBe(false);
		// A lead with nothing to say cannot be told apart from a re-offer.
		expect(reopensLead(CLEARANCE, { outcome: "inconclusive" })).toBe(false);
		// Proposals and confirmations are the rank rule's business.
		expect(reopensLead(CLEARANCE, { ...LEAD, outcome: "proposed" })).toBe(false);
		expect(reopensLead({ ...CLEARANCE, outcome: "confirmed" }, LEAD)).toBe(false);
		expect(reopensLead(LEAD, CLEARANCE)).toBe(false);
	});

	it("counts a clearance as re-checked only when a grounded look that settled something is on it", () => {
		expect(clearanceRechecked({ verification: { verdict: "stands", at: "t", basis: ["a.go:1"] } })).toBe(true);
		expect(clearanceRechecked({ verification: { verdict: "unresolved", at: "t", basis: ["a.go:1"] } })).toBe(false);
		expect(clearanceRechecked({ verification: { verdict: "stands", at: "t", basis: ["  "] } })).toBe(false);
		expect(clearanceRechecked({ verification: { verdict: "stands", at: "t" } })).toBe(false);
		expect(clearanceRechecked({})).toBe(false);
	});
});

describe("a kept claim keeps its method and evidence", () => {
	it("writes nothing when a held refutation adds nothing but its own claim", () => {
		// The refutation's method used to ride onto the lead, so the held call
		// differed from the stored row and wrote a line that said the lead was
		// grounded in the check that did not settle it.
		const lead = { kind: "hypothesis", target: "e1", class: "xss", outcome: "inconclusive", statement: "cannot verify offline" };
		const merged = mergeRecord("hypothesis", lead, {
			target: "e1", class: "xss", outcome: "refuted", statement: "every field is escaped before output",
			method: "read the renderer", evidence: "evidence/renderer.txt",
		});
		expect(merged.method).toBeUndefined();
		expect(merged.evidence).toBeUndefined();
		expect(isNoOp(lead, merged)).toBe(true);
	});

	it("keeps a confirmed cell's method over a lower claim's", () => {
		const merged = mergeRecord(
			"hypothesis",
			{ outcome: "confirmed", statement: "landed a payload", method: "boolean differential", evidence: "evidence/diff.txt" },
			{ outcome: "proposed", statement: "worth another look", method: "fuzz it", evidence: "evidence/fuzz.txt" },
		);
		expect(merged).toMatchObject({ outcome: "confirmed", method: "boolean differential", evidence: "evidence/diff.txt" });
	});

	it("lets a repeat of the same claim fill what the stored one left out", () => {
		// Same sentence, so it is the same claim: adding its evidence is the
		// "fields you add are kept" promise, not one claim borrowing another's grounds.
		const merged = mergeRecord(
			"hypothesis",
			{ outcome: "refuted", statement: "every query is parameterised" },
			{ outcome: "proposed", statement: "every query is parameterised", evidence: "evidence/queries.txt" },
		);
		expect(merged).toMatchObject({ outcome: "refuted", evidence: "evidence/queries.txt" });
	});
});

describe("an update by id", () => {
	// Last-write-wins, as documented, except where the spread keeps what no
	// longer describes the row. A deliberate reopen by id kept the clearance's
	// verification, so the open lead read as one that had already had its
	// second look.
	const CLEARANCE = {
		kind: "hypothesis", target: "e1", class: "traversal", outcome: "refuted",
		statement: "the upload handler resolves the path and checks it stays under the root",
		method: "read the upload handler", evidence: "evidence/upload-root-check.txt",
		verification: { verdict: "stands", at: "t1", basis: ["upload.go:31"] },
	};

	it("drops the stored verification, method and evidence when it moves a hypothesis's outcome without a basis", () => {
		const reopened = updateById("hypothesis", CLEARANCE, { outcome: "inconclusive" });
		expect(reopened).toMatchObject({ outcome: "inconclusive", statement: CLEARANCE.statement, target: "e1", class: "traversal" });
		expect(reopened.verification).toBeUndefined();
		expect(reopened.method).toBeUndefined();
		expect(reopened.evidence).toBeUndefined();
	});

	it("keeps the method and evidence the reopening call sent", () => {
		const reopened = updateById("hypothesis", CLEARANCE, { outcome: "inconclusive", method: "traced the export route", evidence: "evidence/export.txt" });
		expect(reopened).toMatchObject({ method: "traced the export route", evidence: "evidence/export.txt" });
		expect(reopened.verification).toBeUndefined();
	});

	it("takes the verification a re-check with a basis wrote, rather than dropping it", () => {
		const amended = { verdict: "amended", at: "t2", basis: ["export.go:12"] };
		const out = updateById("hypothesis", CLEARANCE, { outcome: "confirmed", verification: amended });
		expect(out.verification).toEqual(amended);
		// The clearance's method explained "refuted"; it must not ride onto "confirmed".
		expect(out.method).toBeUndefined();
	});

	it("is a plain overwrite when the outcome does not move, or the record is not a hypothesis", () => {
		expect(updateById("hypothesis", CLEARANCE, { outcome: " Refuted ", statement: "reworded" })).toEqual({ ...CLEARANCE, outcome: " Refuted ", statement: "reworded" });
		expect(updateById("hypothesis", CLEARANCE, {})).toEqual(CLEARANCE);
		const finding = { kind: "finding", title: "x", status: "confirmed", verification: { verdict: "stands", at: "t1" } };
		expect(updateById("finding", finding, { status: "suspected" })).toEqual({ ...finding, status: "suspected" });
	});
});

describe("recognising that nothing new was said", () => {
	it("is a no-op when the merge changed nothing", () => {
		// The extractor re-reads the same review every turn; without this the ledger
		// grows by a full copy of itself once a turn.
		const existing = { kind: "finding", title: "x", severity: "low" };
		expect(isNoOp(existing, mergeRecord("finding", existing, { title: "x", severity: "low" }))).toBe(true);
	});

	it("ignores the timestamp, which changes on every write by definition", () => {
		const existing = { kind: "finding", title: "x", updatedAt: "2026-01-01T00:00:00Z" };
		const merged = { kind: "finding", title: "x", updatedAt: "2026-09-01T00:00:00Z" };
		expect(isNoOp(existing, merged)).toBe(true);
	});

	it("does not care what order the fields are in", () => {
		expect(isNoOp({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
	});

	it("is not a no-op when the repeat actually added something", () => {
		const existing = { kind: "finding", title: "x" };
		expect(isNoOp(existing, mergeRecord("finding", existing, { description: "new detail" }))).toBe(false);
	});
});

describe("a file named two ways is one place", () => {
	const f = (title: string, target: string) => ({ kind: "finding", title, target, severity: "high" });

	it("folds a bare filename into the same finding under its full path", () => {
		// Measured on LinkAce: one SSRF recorded six times under path variants.
		expect(findDuplicate("finding", f("SSRF in fetch", "http/data.go"),
			[f("SSRF in fetch", "data.go")] as never)).toBeDefined();
	});

	it("keeps same-named files in different directories apart", () => {
		expect(findDuplicate("finding", f("IDOR", "api/user.go"),
			[f("IDOR", "auth/user.go")] as never)).toBeUndefined();
	});

	it("keeps two different lines in one file apart", () => {
		expect(findDuplicate("finding", f("SSRF", "http/data.go:95"),
			[f("SSRF", "http/data.go:200")] as never)).toBeUndefined();
	});

	it("folds a variant path when the line agrees", () => {
		expect(findDuplicate("finding", f("SSRF", "app/Http/Controllers/Fetch.php:95"),
			[f("SSRF", "Fetch.php:95")] as never)).toBeDefined();
	});
});

describe("a cell named two ways", () => {
	// Measured on LinkAce: "setupHttpRequest" and "setupHttpRequest helper
	// function" were recorded as separate cells, as were "CheckLinksCommand" and
	// "CheckLinksCommand link checking". Neither target resolved to an element, so
	// both were stored as written, and one cell became two — each settling nothing.
	const existing = [rec({ kind: "hypothesis", target: "setupHttpRequest", class: "ssrf", outcome: "confirmed", id: "y1" })];

	it("folds a target that is prose around the same name", () => {
		expect(findDuplicate("hypothesis", {
			kind: "hypothesis", target: "setupHttpRequest helper function", class: "ssrf",
		}, existing)).toMatchObject({ id: "y1" });
	});

	it("folds it in the other direction too", () => {
		const wordy = [rec({ kind: "hypothesis", target: "CheckLinksCommand link checking", class: "ssrf", id: "y2" })];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "CheckLinksCommand", class: "ssrf" }, wordy))
			.toMatchObject({ id: "y2" });
	});

	it("ignores a trailing slash, which is the same route", () => {
		const routes = [rec({ kind: "hypothesis", target: "/api/login", class: "sqli", id: "y3" })];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "/api/login/", class: "sqli" }, routes))
			.toMatchObject({ id: "y3" });
	});

	it("does not let one word swallow a longer one", () => {
		// "user" inside "users" is not a name match, and merging those two cells
		// would clear a route nobody tested.
		const users = [rec({ kind: "hypothesis", target: "users", class: "authz", id: "y4" })];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "user", class: "authz" }, users)).toBeUndefined();
	});

	it("will not match on a fragment too short to identify anything", () => {
		const short = [rec({ kind: "hypothesis", target: "api", class: "authz", id: "y5" })];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "api gateway routes", class: "authz" }, short))
			.toBeUndefined();
	});

	it("keeps two genuinely different targets apart", () => {
		const two = [rec({ kind: "hypothesis", target: "auth/user.go", class: "authz", id: "y6" })];
		expect(findDuplicate("hypothesis", { kind: "hypothesis", target: "api/session.go", class: "authz" }, two))
			.toBeUndefined();
	});
});

describe("a finding recorded once against a place and once against nowhere", () => {
	// From a client engagement: one hardcoded token, recorded against "config.json" and
	// against "repo:acme-app". The second names no file — it names the engagement —
	// and it is not a second secret.
	const existing = [rec({ kind: "finding", title: "Hardcoded Telegram bot token", target: "config.json", severity: "high", id: "f1" })];

	it("folds the recording that names no file", () => {
		expect(findDuplicate("finding", {
			kind: "finding", title: "Hardcoded Telegram bot token", target: "repo:acme-app", severity: "high",
		}, existing)).toMatchObject({ id: "f1" });
	});

	it("folds one with no target at all", () => {
		expect(findDuplicate("finding", { kind: "finding", title: "Hardcoded Telegram bot token", severity: "high" }, existing))
			.toMatchObject({ id: "f1" });
	});

	it("still keeps the same weakness in two real files apart", () => {
		// The recall guard. "Missing authorization check" in two routes is two
		// findings, and a client's report must carry both.
		const both = [rec({ kind: "finding", title: "Missing authorization check", target: "api/orders.go:31", severity: "high", id: "f2" })];
		expect(findDuplicate("finding", {
			kind: "finding", title: "Missing authorization check", target: "api/users.go:12", severity: "high",
		}, both)).toBeUndefined();
	});
});

describe("a finding with more than one sink keeps them all", () => {
	const f = (target: string, locations?: string[]) =>
		({ kind: "finding", title: "Public share exposes the sharer's tree", severity: "high", target, ...(locations ? { locations } : {}) });

	it("keeps the earlier location when a later one is merged in", () => {
		// Measured on filebrowser: http/share.go:84 landed exactly on a truth entry
		// and was overwritten by http/public.go:58 in the same second.
		const merged = mergeRecord("finding", f("http/share.go:84"), f("http/public.go:58"));
		expect(merged.locations).toEqual(["http/share.go:84", "http/public.go:58"]);
	});

	it("accumulates across successive merges without duplicating", () => {
		const first = mergeRecord("finding", f("http/share.go:84"), f("http/public.go:47"));
		const second = mergeRecord("finding", first, f("http/public.go:58"));
		expect(second.locations).toEqual(["http/share.go:84", "http/public.go:47", "http/public.go:58"]);
	});

	it("does not add the field when the location never changed", () => {
		const merged = mergeRecord("finding", f("http/share.go:84"), f("http/share.go:84"));
		expect(merged.locations).toBeUndefined();
	});

	it("keeps the newest target as the primary", () => {
		expect(mergeRecord("finding", f("a.go:1"), f("b.go:2")).target).toBe("b.go:2");
	});
});
