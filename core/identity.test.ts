import { describe, expect, it } from "vitest";
import {
	findDuplicate,
	findingLocation,
	findNearDuplicate,
	isNoOp,
	mergeRecord,
	titleOverlap,
	type Fields,
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
