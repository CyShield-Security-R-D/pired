import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	auditFinding, challengeBrief, type ChallengeReport, CLASS_ALIASES, CONTRACTS, contractFor,
	evidenceShape, judge, modelAnswersEntitlement, verdictPatch,
} from "./challenge.ts";
import type { FindingRecord } from "./ontology.ts";

const NOW = "2026-09-07T12:00:00Z";

/** A finding as the ledger holds it. */
function finding(over: Partial<FindingRecord> = {}): FindingRecord {
	return {
		v: 1, id: "f1", kind: "finding", createdAt: "t0",
		title: "IDOR on GET /api/notes/{id}", severity: "high", target: "e1",
		class: "idor", status: "suspected",
		...over,
	} as FindingRecord;
}

/** A challenge that met every bar, so individual tests can knock one out. */
function goodReport(over: Partial<ChallengeReport> = {}): ChallengeReport {
	return {
		verdict: "stands",
		control: "same request with no cookie returned 401; a note id belonging to nobody returned 404",
		live: true,
		entitlement: "model.md actors: notes are private to their owner; there is no sharing feature",
		basis: ["evidence/f1-anon.txt"],
		...over,
	};
}

describe("what a challenge is allowed to conclude", () => {
	it("never returns a status that removes the finding, whatever it is handed", () => {
		// The safety property the whole module rests on. A challenge that could
		// delete a finding is a machine for losing real bugs, and no input to
		// judge() may produce one.
		const reports: ChallengeReport[] = [
			{ verdict: "refuted" },
			{ verdict: "refuted", basis: ["x.go:1"], live: false },
			{ verdict: "refuted", basis: ["x.go:1"], live: true },
			{ verdict: "unresolved" },
			{ verdict: "stands" },
			goodReport(),
		];
		for (const r of reports) {
			const out = judge(finding(), r, NOW);
			expect(["suspected", "confirmed", "refuted"]).toContain(out.status);
		}
	});

	it("leaves the finding suspected when a refutation cites nothing", () => {
		// An uncited refutation is an opinion, and an opinion is not allowed to
		// withdraw a claim from a client's report. This is the same rule
		// eval/key.ts applies to ground truth: a clear cell with no `why` is an
		// assertion, not a result.
		const out = judge(finding(), { verdict: "refuted", live: true }, NOW);
		expect(out.verdict).toBe("unresolved");
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/no basis cited/);
	});

	it("refuses to refute anything when the target was not reachable", () => {
		// The trap that would break a whole engagement in one pass: re-verifying on
		// the last day against a rotated credential and reading "it does not work
		// any more" as "it was never real".
		const out = judge(finding(), { verdict: "refuted", basis: ["evidence/retry.txt"], live: false }, NOW);
		expect(out.verdict).toBe("unresolved");
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/not reachable|session was not valid/);
	});

	it("refutes on cited grounds against a live target, and keeps the row", () => {
		const out = judge(finding(), {
			verdict: "refuted", live: true,
			basis: ["app/policies/note_policy.rb:14"],
			control: "second account received 403, not the note",
		}, NOW);
		expect(out.verdict).toBe("refuted");
		expect(out.status).toBe("refuted");
		expect(verdictPatch(out)).toMatchObject({ status: "refuted" });
		expect(out.verification.basis).toEqual(["app/policies/note_policy.rb:14"]);
	});
});

describe("what it takes to confirm", () => {
	it("will not confirm without the control case, however confident the report", () => {
		const out = judge(finding(), goodReport({ control: undefined }), NOW);
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/control case was not run/);
	});

	it("will not confirm an access-control finding until entitlement is settled", () => {
		// The shipped incident this module exists for: pired flagged IDORs without
		// establishing that the caller was not meant to reach the resource, and one
		// reached the client's report. Re-running the request cannot answer this —
		// a share link, a team membership and a bug all return the same 200.
		const out = judge(finding(), goodReport({ entitlement: undefined }), NOW);
		expect(out.status).toBe("suspected");
		expect(out.blocker?.type).toBe("scope-clarification");
		expect(out.blocker?.question).toMatch(/meant to be able to reach/);
	});

	it("confirms when the control ran and entitlement is settled", () => {
		const out = judge(finding(), goodReport(), NOW);
		expect(out.verdict).toBe("stands");
		expect(out.status).toBe("confirmed");
		expect(out.verification).toMatchObject({ at: NOW, live: true });
	});

	it("asks for entitlement on the access-control classes and not on injection", () => {
		// sqli is settled by a differential on the wire; idor is settled by knowing
		// who the resource is for. Only one of those is a question for the operator.
		expect(judge(finding({ class: "sqli" }), goodReport({ entitlement: undefined }), NOW).status).toBe("confirmed");
		expect(judge(finding({ class: "idor" }), goodReport({ entitlement: undefined }), NOW).status).toBe("suspected");
	});

	it("flags a finding that had already gone to the client", () => {
		// Withdrawing a claim the client has read is a different conversation from
		// correcting one that never left the workspace.
		const out = judge(finding({ status: "reported" }), { verdict: "refuted", basis: ["x.rb:1"], live: true }, NOW);
		expect(out.wasReported).toBe(true);
	});
});

describe("amending rather than killing", () => {
	it("takes a corrected severity only when the correction is grounded", () => {
		const grounded = judge(finding({ severity: "high", class: "xss" }), {
			verdict: "amended", severity: "low", live: true,
			control: "payload lands in an application/json body; content-type is not HTML",
			basis: ["evidence/f1-response.txt"],
		}, NOW);
		expect(grounded.severity).toBe("low");
		expect(grounded.status).toBe("confirmed");

		const ungrounded = judge(finding({ severity: "high", class: "xss" }), {
			verdict: "amended", severity: "low", live: true, control: "looked at it again",
		}, NOW);
		expect(ungrounded.severity).toBeUndefined();
	});
});

describe("the audit that costs no traffic", () => {
	it("blocks a finding recorded from a scanner hit nobody re-issued", () => {
		const gaps = auditFinding({ finding: finding({ source: "scanner", evidence: ["evidence/nuclei.txt"] }) });
		expect(gaps.some((g) => g.kind === "unre-issued-scanner-hit" && g.blocking)).toBe(true);
	});

	it("notices evidence that holds a request but no response", () => {
		// A request nobody kept the answer to proves nothing, and it is the shape a
		// transcript takes when the tool was killed mid-run.
		const gaps = auditFinding({
			finding: finding({ evidence: ["evidence/f1.txt"] }),
			evidence: { "evidence/f1.txt": "GET /api/notes/7 HTTP/1.1\nCookie: session=abc\n" },
		});
		expect(gaps.some((g) => g.kind === "no-response" && g.blocking)).toBe(true);
	});

	it("notices an access-control proof that only ever used one identity", () => {
		// Both requests went out as the owner, so the "attacker" was the victim.
		const oneIdentity = auditFinding({
			finding: finding({ evidence: ["evidence/f1.txt"] }),
			evidence: {
				"evidence/f1.txt":
					"GET /api/notes/7 HTTP/1.1\nCookie: session=abc\n\nHTTP/1.1 200 OK\n{}\n" +
					"GET /api/notes/8 HTTP/1.1\nCookie: session=abc\n\nHTTP/1.1 200 OK\n{}\n",
			},
		});
		expect(oneIdentity.some((g) => g.kind === "no-control" && g.blocking)).toBe(true);

		const twoIdentities = auditFinding({
			finding: finding({ evidence: ["evidence/f1.txt"], verification: { verdict: "stands", at: NOW, control: "ran" } }),
			evidence: {
				"evidence/f1.txt":
					"GET /api/notes/7 HTTP/1.1\nCookie: session=victim\n\nHTTP/1.1 200 OK\n{}\n" +
					"GET /api/notes/7 HTTP/1.1\nCookie: session=attacker\n\nHTTP/1.1 200 OK\n{}\n",
			},
			targetModel: "## actors\n\nNotes are private to their owner; there is no sharing feature and no team scope.\n",
		});
		expect(twoIdentities.some((g) => g.kind === "no-control")).toBe(false);
	});

	it("asks for entitlement when the target model has no actors or invariants to answer it", () => {
		const gaps = auditFinding({
			finding: finding({ evidence: ["e.txt"], verification: { verdict: "stands", at: NOW, control: "ran" } }),
			evidence: { "e.txt": "GET /a HTTP/1.1\nCookie: a=1\nCookie: b=2\n\nHTTP/1.1 200 OK\n" },
			targetModel: "## what\n\nA note-taking application for teams.\n",
		});
		expect(gaps.some((g) => g.kind === "entitlement" && g.blocking)).toBe(true);
	});

	it("counts only the model sections that can settle entitlement", () => {
		// A rich `what` paragraph and an empty `actors` section cannot say who a
		// resource is for, and reading the document's length as an answer is how
		// the shipped finding got waved through.
		expect(modelAnswersEntitlement("## what\n\n" + "x".repeat(400))).toBe(false);
		expect(modelAnswersEntitlement("## actors\n\n- owner: full access to their own notes only, no sharing\n")).toBe(true);
		expect(modelAnswersEntitlement(undefined)).toBe(false);
	});

	it("does not demand an HTTP response from a code review, which has no wire", () => {
		// The audit was written on a live engagement and asked every finding for a
		// request/response pair. `review` — the read-only profile that needs no
		// configuration, so the one a first-time user runs — has no wire at all: a
		// finding citing the snippet that contains the bug was told, blocking, that
		// its evidence "contains no HTTP response". Every code-review-only class
		// added since (sca, iac, crypto, logging, reflection, codeinj) would have
		// inherited that.
		const gaps = auditFinding({
			finding: finding({ class: "codeinj", target: "src/api/run.js:42", evidence: ["evidence/codeinj.md"], source: "observed" }),
			evidence: {
				"evidence/codeinj.md":
					"src/api/run.js:42\n\n    const out = eval(req.body.expr);\n\nNo validation between the router and this call.\n",
			},
		});
		expect(gaps.some((g) => g.kind === "no-response")).toBe(false);
		expect(gaps.some((g) => g.kind === "unusable-evidence")).toBe(false);
	});

	it("still blocks evidence that is neither a transcript nor a citation", () => {
		// The gap the wire check was actually catching, kept: a challenger has to be
		// able to go back to the thing that proves this, and prose about a file is
		// not somewhere to go back to.
		const gaps = auditFinding({
			finding: finding({ class: "sca", target: "e1", evidence: ["evidence/sca.md"] }),
			evidence: { "evidence/sca.md": "The version of the library in use here is old and has known issues.\n" },
		});
		expect(gaps.some((g) => g.kind === "unusable-evidence" && g.blocking)).toBe(true);
	});

	it("asks a source excerpt for the guard rather than for two Cookie headers", () => {
		// Two authentication contexts is what an access-control control case looks
		// like ON THE WIRE and nowhere else. Demanding it of a code excerpt asks for
		// something the evidence could never contain; the recorded-control check is
		// the right question for that medium, and it is what fires here.
		const gaps = auditFinding({
			finding: finding({ class: "authz", target: "app/api/orders.py:88", evidence: ["evidence/authz.md"] }),
			evidence: { "evidence/authz.md": "app/api/orders.py:88 — the update handler, unlike the sibling delete handler at :104, calls no policy check.\n" },
			targetModel: "## actors\n\nOrders belong to the account that created them; staff see all of them.\n",
		});
		const control = gaps.find((g) => g.kind === "no-control");
		expect(control?.detail).not.toMatch(/one authentication context/);
		expect(control?.detail).toMatch(/control case not recorded/);
	});

	it("reads a transcript as a transcript even when it also quotes a source line", () => {
		expect(evidenceShape("GET /a HTTP/1.1\n\nHTTP/1.1 200 OK\n\nsee app/api.py:12")).toBe("wire");
		expect(evidenceShape("```\nrun(cmd)\n```")).toBe("static");
		expect(evidenceShape("it looked wrong to me")).toBe("neither");
	});

	it("flags severity above what a class carries on its base case, without blocking", () => {
		// Missing headers reported as high is the most common severity inflation in
		// a report, and it is a correction rather than a reason to hold the finding.
		const gaps = auditFinding({ finding: finding({ class: "misconfig", severity: "high" }) });
		const sev = gaps.find((g) => g.kind === "severity");
		expect(sev?.blocking).toBe(false);
		expect(sev?.detail).toMatch(/above the low/);
	});
});

describe("the brief the challenger is given", () => {
	it("carries the claim, the control and the citation rule", () => {
		const brief = challengeBrief(finding(), auditFinding({ finding: finding() }));
		expect(brief).toMatch(/BREAK this claim/);
		expect(brief).toMatch(/NO credentials at all/);
		expect(brief).toMatch(/uncited refutation is recorded as unresolved/);
		expect(brief).toMatch(/dead session refutes nothing|session is valid/);
	});

	it("names the entitlement question for an access-control class", () => {
		expect(challengeBrief(finding({ class: "idor" }))).toMatch(/who is this resource FOR/);
		expect(challengeBrief(finding({ class: "sqli" }))).not.toMatch(/who is this resource FOR/);
	});

	it("names the entitlement question for a class that turns on intent and not for one that does not", () => {
		expect(contractFor("idor")?.entitlement).toBeDefined();
		expect(contractFor("sqli")?.entitlement).toBeUndefined();
		expect(contractFor("nonesuch")).toBeUndefined();
	});
});

describe("the registry every checklist class has to resolve through", () => {
	// This block reads the shipped checklists off disk, which no other core test
	// does. The point is precisely that the DATA and the table cannot drift
	// apart: a list of class ids written into the test would go stale with the
	// same edit that broke the thing, and this test would keep passing. It is
	// also how the gap was found — the test that used to sit here was named "has
	// a contract for every class the shipped checklists name" and asserted three
	// ids by hand, while seventeen of the forty-two shipped classes resolved to
	// nothing and were challenged against the generic bar.
	const dir = new URL("../checklists/", import.meta.url);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const classesOf = (file: string): { id: string; title?: string }[] =>
		JSON.parse(readFileSync(new URL(file, dir), "utf8")).classes;

	it("ships checklists to check", () => {
		// A glob that matched nothing would make every assertion below vacuous.
		expect(files.length).toBeGreaterThan(0);
		expect(files.flatMap(classesOf).length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`resolves every class in ${file} to exactly one contract`, () => {
			const unresolved = classesOf(file)
				.filter((c) => contractFor(c.id) === undefined)
				.map((c) => `${c.id} (${c.title})`);
			expect(unresolved).toEqual([]);
		});
	}

	it("keeps aliases pointing at contracts that exist and shadowing none", () => {
		for (const [alias, canonical] of Object.entries(CLASS_ALIASES)) {
			// An alias that is also a real class id would silently never fire, and
			// the class it was meant to redirect would keep the wrong contract.
			expect(CONTRACTS.map((c) => c.class)).not.toContain(alias);
			expect(CONTRACTS.map((c) => c.class)).toContain(canonical);
		}
	});

	it("routes the code-review spelling of path traversal to the traversal contract", () => {
		// The pair `record` grew a spelling suggester for: web.json says
		// `traversal`, code-review.json says `pathtrav`, and a live run spent a
		// third of a session working out why the cell would not settle.
		expect(contractFor("pathtrav")).toBe(contractFor("traversal"));
		expect(contractFor("pathtrav")?.control).toMatch(/outside the root/);
	});

	it("declares no contract twice", () => {
		const ids = CONTRACTS.map((c) => c.class);
		expect(ids.length).toBe(new Set(ids).size);
	});
});
