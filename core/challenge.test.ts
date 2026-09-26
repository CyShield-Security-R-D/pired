import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	auditFinding, challengeBrief, type ChallengeReport, CLASS_ALIASES, CONTRACTS, contractFor,
	challengeCommand, deriveTier, describeUngrounded, EARNED_LOCKED_FIELDS, isFinder, evidenceShape, GENERIC_CONTROL, type GroundedQuote, groundQuotes, hasGrounds,
	hypothesisBrief, isEarned, isExaminedUnsettled, isIndependent, isUnchallenged, isWorkerAuthor, judge, MIN_QUOTE_CHARS,
	isCommentOnly, MAX_QUOTE_OCCURRENCES, MAX_QUOTE_SPAN, modelAnswersEntitlement, parseQuote, provenanceLabel, QUOTE_WINDOW, type QuoteReader, unchallengedBrief, unchallengedQueue, unsettledLabel, verdictPatch,
} from "./challenge.ts";
import type { FindingRecord, HypothesisRecord } from "./ontology.ts";

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

/** A guard quoted from the source and found where it was cited, as the host hands it to judge(). */
const GUARD_BASIS = "src/policy.go:31: if note.OwnerID != user.ID { return ErrForbidden }";
const GUARD = { at: "src/policy.go:31", quote: "if note.OwnerID != user.ID { return ErrForbidden }", grounded: true };

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

describe("refuting where there is no live target", () => {
	// The live=false rule guards against a dead session refuting a true finding.
	// In a source-only review there is no session and no target, so an honest
	// verifier says live=false and every refutation it made was downgraded:
	// measured on the 2026-09-24 grid, the runs that did settle findings got there
	// by asserting live=true on scopes with no target (17 of 18 verification
	// records), and the honest ones could not refute anything.
	it("accepts a cited refutation that says live=false when the engagement is source-only", () => {
		const out = judge(finding(), { verdict: "refuted", basis: [GUARD_BASIS], basisQuotes: [GUARD], live: false, sourceOnly: true }, NOW);
		expect(out.status).toBe("refuted");
		expect(out.downgraded).toBeUndefined();
		expect(out.verification).toMatchObject({ verdict: "refuted", basis: [GUARD_BASIS] });
	});

	/**
	 * live=false there says nothing was running, not that a target was down.
	 * Stored, the report printed "(target was not reachable)" beside a refutation
	 * the source settled — the dead-session refutation the live rule rejects.
	 */
	it("stores no live flag on a source-only refutation that said live=false", () => {
		const out = judge(finding(), { verdict: "refuted", basis: [GUARD_BASIS], basisQuotes: [GUARD], live: false, sourceOnly: true }, NOW);
		expect(out.status).toBe("refuted");
		expect(out.verification).not.toHaveProperty("live");
		// A look that settled nothing is written the same way.
		const look = judge(finding(), { verdict: "unresolved", basis: ["src/policy.go:31"], live: false, sourceOnly: true }, NOW);
		expect(look.verification).not.toHaveProperty("live");
		// live=true is a claim that a running target was tested, and is kept as said.
		expect(judge(finding(), { verdict: "refuted", basis: [GUARD_BASIS], basisQuotes: [GUARD], live: true, sourceOnly: true }, NOW).verification.live).toBe(true);
	});

	it("still downgrades live=false when the engagement has a live target, and keeps the flag it was downgraded on", () => {
		for (const sourceOnly of [false, undefined]) {
			const out = judge(finding(), { verdict: "refuted", basis: ["src/policy.go:31"], live: false, sourceOnly }, NOW);
			expect(out.status).toBe("suspected");
			expect(out.downgraded).toMatch(/not reachable/);
			expect(out.verification.live).toBe(false);
		}
	});

	it("does not lift the basis requirement for a source-only review", () => {
		// The cited line is the whole bar there, so it cannot be the bar that goes.
		const out = judge(finding(), { verdict: "refuted", live: false, sourceOnly: true }, NOW);
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/no basis cited/);
	});
});

describe("a challenge that could not settle the claim", () => {
	// `status=suspected` carried nothing, so an honest "I could not settle this"
	// had nowhere to be written. On the 2026-09-24 grid 10 of 15 verify tasks
	// whose instructions said "do not change status" left no verdict on any row;
	// those instructions conflicted with the brief (ADR-028), so the figure is
	// verdicts that never reached a row, not this gap's effect alone.
	it("keeps the finding suspected and writes the grounds as an unresolved verification", () => {
		const out = judge(finding(), {
			verdict: "unresolved", basis: ["src/notes.go:88"], control: "no second account was available to replay as",
			notes: "the ownership check may live in middleware not in this tree",
		}, NOW);
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toBeUndefined();
		expect(out.verification).toEqual({
			verdict: "unresolved", at: NOW, basis: ["src/notes.go:88"],
			control: "no second account was available to replay as",
			notes: "the ownership check may live in middleware not in this tree",
		});
	});

	it("takes a control case alone as grounds: it says what was run", () => {
		const out = judge(finding(), { verdict: "unresolved", control: "no second account existed to replay the request as" }, NOW);
		expect(out.verification).toMatchObject({ verdict: "unresolved", control: "no second account existed to replay the request as" });
		expect(out.downgraded).toBeUndefined();
	});

	it("does not take a reason alone as a look, since any edit may carry one", () => {
		// A finder rewording its own claim passes a reason too. Counted as a look,
		// it would mark a finding examined that no challenge had opened.
		const out = judge(finding(), { verdict: "unresolved", notes: "the handler is generated at build time; not in the tree" }, NOW);
		expect(out.downgraded).toMatch(/no conclusion/);
		expect(hasGrounds({ basis: ["  "], control: " " })).toBe(false);
		expect(hasGrounds({ basis: ["src/notes.go:88"] })).toBe(true);
	});

	it("still says no conclusion was returned when nothing at all was said", () => {
		const out = judge(finding(), { verdict: "unresolved", notes: "  " }, NOW);
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/no conclusion/);
	});

	it("warns when the finding had already gone to the client", () => {
		const out = judge(finding({ status: "reported" }), { verdict: "unresolved", control: "could not reach the handler" }, NOW);
		expect(out.wasReported).toBe(true);
		expect(out.status).toBe("reported");
	});
});

describe("a look that settles nothing does not move what was settled", () => {
	// The unsettled branch wrote `suspected` whatever the finding held, so a
	// verifier recording "could not settle it" on a confirmed or reported finding
	// demoted it, and replaced a verification that had met its bar with one that
	// had not. Nothing unproven may settle a finding; nor may it unsettle one.
	const EARNED = { verdict: "stands" as const, at: "2026-09-01T00:00:00Z", control: "no-cookie request returned 401" };

	it("keeps a confirmed finding confirmed, with its earned verification, and adds the look to its notes", () => {
		const out = judge(finding({ status: "confirmed", verification: EARNED }), {
			verdict: "unresolved", basis: ["src/notes.go:88"], notes: "could not find the route's middleware",
		}, NOW);
		expect(out.status).toBe("confirmed");
		expect(out.kept).toEqual(EARNED);
		expect(out.verification).toMatchObject({ verdict: "stands", at: EARNED.at, control: EARNED.control });
		expect(out.verification.notes).toMatch(/later look 2026-09-07T12:00:00Z, unsettled: basis src\/notes.go:88; could not find the route's middleware/);
		expect(out.downgraded).toBeUndefined();
	});

	it("leaves every settled or operator status where it was", () => {
		for (const status of ["reported", "triaged", "confirmed", "refuted", "false-positive", "accepted-risk", "ignored"] as const) {
			expect(judge(finding({ status }), { verdict: "unresolved", basis: ["x.go:1"] }, NOW).status, status).toBe(status);
		}
		// A legacy `open` is the unverified state under its old name.
		expect(judge(finding({ status: "open" }), { verdict: "unresolved", basis: ["x.go:1"] }, NOW).status).toBe("suspected");
	});

	it("replaces a look that was itself unsettled, since neither earned anything", () => {
		const out = judge(finding({ verification: { verdict: "unresolved", at: "t1", notes: "first look" } }), { verdict: "unresolved", basis: ["x.go:1"] }, NOW);
		expect(out.kept).toBeUndefined();
		expect(out.verification).toEqual({ verdict: "unresolved", at: NOW, basis: ["x.go:1"] });
	});

	it("holds for a refutation or confirmation that missed its bar, too", () => {
		// The same demotion by the other door: a refutation with no basis landed a
		// confirmed finding on suspected and wrote `unresolved` over its proof.
		const confirmed = finding({ status: "confirmed", verification: EARNED });
		const refuted = judge(confirmed, { verdict: "refuted", live: true }, NOW);
		expect(refuted.status).toBe("confirmed");
		expect(refuted.downgraded).toMatch(/no basis cited/);
		expect(refuted.verification).toMatchObject({ verdict: "stands", control: EARNED.control });
		expect(refuted.verification.notes).toMatch(/later look .*no basis cited/);

		const cleared = finding({ status: "refuted", verification: { verdict: "refuted", at: "t1", basis: ["policy.rb:14"] } });
		const reconfirmed = judge(cleared, { verdict: "stands" }, NOW);
		expect(reconfirmed.status).toBe("refuted");
		expect(reconfirmed.verification).toMatchObject({ verdict: "refuted", basis: ["policy.rb:14"] });
	});

	it("names which verdicts were earned", () => {
		expect(isEarned({ verdict: "stands" })).toBe(true);
		expect(isEarned({ verdict: "amended" })).toBe(true);
		expect(isEarned({ verdict: "refuted" })).toBe(true);
		expect(isEarned({ verdict: "unresolved" })).toBe(false);
		expect(isEarned(undefined)).toBe(false);
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

	/**
	 * The brief used to ask for a verdict in its own vocabulary and the grounds
	 * in 'reason', which the gate does not read as a basis; a verifier that
	 * followed it wrote a refutation recorded as unresolved, or nothing. On the
	 * 2026-09-24 grid 4 of 6 amended or refuted verdicts never reached the finding.
	 */
	it("says how to write each verdict in the fields the gate reads", () => {
		const brief = challengeBrief(finding({ id: "f9" }));
		expect(brief).toContain("record kind=finding id=f9");
		expect(brief).toMatch(/confirmed: control=/);
		expect(brief).toMatch(/refuted: basis=/);
		expect(brief).toMatch(/suspected: basis=\[[^\]]*\] or control=/);
		expect(brief).toMatch(/A reason alone is a note, not a look/);
		expect(brief).toMatch(/record kind=evidence/);
		expect(brief).not.toMatch(/stands\|amended/);
	});

	it("asks for entitlement in the confirm line only where the class turns on it", () => {
		expect(challengeBrief(finding({ class: "idor" }))).toMatch(/confirmed: control="[^"]*", entitlement=/);
		expect(challengeBrief(finding({ class: "sqli" }))).not.toMatch(/confirmed: control="[^"]*", entitlement=/);
	});

	it("leaves the claim itself to the operator", () => {
		expect(challengeBrief(finding())).toMatch(/title, description, location, severity — is the operator's to amend/);
	});

	it("asks for live=true only when the running target was tested, and for nothing when the basis is the source", () => {
		// judge() downgrades live=false against a live target and takes an absent
		// live as no claim. Asked for "live=true|false", a verifier whose grounds
		// were the source had only the answer that refutes nothing.
		const brief = challengeBrief(finding());
		expect(brief).toMatch(/live=true when you tested the running target; leave live out when your basis is the source/);
		expect(brief).not.toMatch(/live=true\|false/);
		expect(judge(finding(), { verdict: "refuted", basis: ["src/policy.go:31"] }, NOW).status).toBe("refuted");
	});

	it("asks for reachability only where there is a live target", () => {
		// judge() no longer downgrades live=false in a source-only review, so a
		// brief that demanded proof of a session would be asking for something the
		// gate does not.
		const brief = challengeBrief(finding());
		expect(brief).toMatch(/When the engagement has a live target, prove it is reachable/);
		expect(brief).toMatch(/A review of source has no target to reach/);
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

describe("the unchallenged queue", () => {
	/**
	 * `suspected` is the default precisely because an absent verification means
	 * unexamined, not examined-and-cleared. Everything still live that no
	 * challenge settled is therefore waiting.
	 */
	it("counts anything live that no challenge has settled", () => {
		expect(isUnchallenged(finding({ status: "suspected" }))).toBe(true);
		expect(isUnchallenged(finding({ status: "open" }))).toBe(true);
		expect(isUnchallenged(finding({ status: "triaged" }))).toBe(true);
		expect(isUnchallenged(finding({ status: "confirmed" }))).toBe(false);
	});

	/**
	 * Round two took any finding carrying a verification out of the queue, so a
	 * look that said "could not tell" — or a refutation judge() downgraded — left
	 * a claim still open while `recall challenge` said "Nothing unchallenged".
	 */
	it("keeps a finding whose only look settled nothing, after every finding nobody has examined", () => {
		const looked = finding({ id: "f1", severity: "critical", verification: { verdict: "unresolved", at: NOW, notes: "no second account" } });
		const fresh = finding({ id: "f2", severity: "low" });
		expect(isUnchallenged(looked)).toBe(true);
		expect(isExaminedUnsettled(looked)).toBe(true);
		expect(isExaminedUnsettled(fresh)).toBe(false);
		// Worse, but examined: a first look at the low one comes before a second at the critical.
		expect(unchallengedQueue([looked, fresh]).map((f) => f.id)).toEqual(["f2", "f1"]);
	});

	it("takes a finding out only on an earned verdict or a settled status", () => {
		for (const verdict of ["stands", "amended", "refuted"] as const) {
			for (const status of ["triaged", "reported"] as const) {
				expect(isUnchallenged(finding({ status, verification: { verdict, at: NOW, basis: ["x.go:1"] } })), `${status} ${verdict}`).toBe(false);
			}
		}
		expect(isUnchallenged(finding({ status: "confirmed" }))).toBe(false);
	});

	/**
	 * `judge` never leaves an earned verdict on an unverified status, so one
	 * there means somebody moved the finding back down by id — the documented
	 * way to correct a record. Read from the verification alone, the correction
	 * took the finding out of the queue it had just been put back into.
	 */
	it("puts a finding moved back to an unverified status in the queue, whatever verification it carries", () => {
		const earned = { verdict: "stands" as const, at: NOW, control: "the false payload returned the empty set" };
		for (const status of ["suspected", "open", undefined] as const) {
			const moved = finding({ id: "f1", status, verification: earned });
			expect(isUnchallenged(moved), String(status)).toBe(true);
			expect(unchallengedQueue([moved]).map((f) => f.id), String(status)).toEqual(["f1"]);
		}
	});

	it("puts a confirmed finding moved back to suspected by id back in the queue", () => {
		const confirmed = finding({ id: "f1", status: "confirmed", verification: { verdict: "stands", at: NOW, control: "401 without the cookie" } });
		expect(unchallengedQueue([confirmed])).toEqual([]);
		// What `record id=f1 status=suspected` leaves: the status moves, the stored verification stays.
		const movedBack = { ...confirmed, status: "suspected" as const };
		expect(unchallengedQueue([movedBack]).map((f) => f.id)).toEqual(["f1"]);
	});

	it("labels an examined finding with what its look could not settle", () => {
		expect(unsettledLabel(finding({ verification: { verdict: "unresolved", at: NOW, notes: "no second account" } })))
			.toBe("examined, unsettled: no second account");
		expect(unsettledLabel(finding({ verification: { verdict: "unresolved", at: NOW, basis: ["a.go:1", "b.go:2"] } })))
			.toBe("examined, unsettled: a.go:1, b.go:2");
		expect(unsettledLabel(finding({ verification: { verdict: "unresolved", at: NOW } }))).toBe("examined, unsettled: no grounds recorded");
		expect(unsettledLabel(finding({ verification: { verdict: "unresolved", at: NOW, notes: "x".repeat(400) } }))?.length).toBeLessThan(200);
		expect(unsettledLabel(finding())).toBeUndefined();
	});

	it("labels a finding moved back down by what it was moved back from, not as a look that could not tell", () => {
		const moved = finding({ status: "suspected", verification: { verdict: "stands", at: NOW, control: "401 without the cookie" } });
		expect(unsettledLabel(moved)).toBe("examined, moved back to suspected from a stands verdict: 401 without the cookie");
	});

	it("hands out the brief for one already examined, and never says nothing is waiting while it is", () => {
		const looked = finding({ id: "f8", verification: { verdict: "unresolved", at: NOW, notes: "no second account" } });
		expect(challengeCommand({ findings: [looked], id: "f8" }).text).toContain("Challenge finding f8");
		const list = challengeCommand({ findings: [looked] }).text;
		expect(list).not.toMatch(/nothing unchallenged/);
		expect(list).toContain("· f8 [high] IDOR on GET /api/notes/{id} — examined, unsettled: no second account");
	});

	/** A disposed finding keeps its row; it is not work waiting on anyone. */
	it("leaves the disposed alone, however they were disposed of", () => {
		for (const status of ["refuted", "false-positive", "accepted-risk", "ignored"] as const) {
			expect(isUnchallenged(finding({ status })), status).toBe(false);
		}
	});

	it("puts the worst first, because a challenge budget is spent top-down", () => {
		const queue = unchallengedQueue([
			finding({ id: "a", severity: "low" }),
			finding({ id: "b", severity: "critical" }),
			finding({ id: "c", severity: "confirmed" as never, status: "confirmed" }),
			finding({ id: "d", severity: "medium" }),
		]);
		expect(queue.map((f) => f.id)).toEqual(["b", "d", "a"]);
	});

	it("does not reorder the caller's array", () => {
		const findings = [finding({ id: "a", severity: "low" }), finding({ id: "b", severity: "critical" })];
		unchallengedQueue(findings);
		expect(findings.map((f) => f.id)).toEqual(["a", "b"]);
	});
});

describe("unchallengedBrief", () => {
	/**
	 * ADR-007 built the contract that settles a claim and nothing ever said a
	 * claim was waiting, so a finding could sit at `suspected` for a whole
	 * engagement with the machinery installed and idle. The coverage block says
	 * which cells are untested; this says which claims are unverified.
	 */
	it("names what is waiting and how to get the brief", () => {
		const out = unchallengedBrief([finding({ id: "f7", severity: "critical", title: "RCE in /admin" })]);
		expect(out).toContain("f7");
		expect(out).toContain("critical");
		expect(out).toContain("RCE in /admin");
		expect(out).toContain("recall challenge");
	});

	/** The whole reason it can go to a subagent, so the line has to say it. */
	it("says the brief owes nothing to the conversation that produced the claim", () => {
		expect(unchallengedBrief([finding()])).toMatch(/never from the conversation|fresh agent/);
	});

	it("agrees with itself about one versus many", () => {
		expect(unchallengedBrief([finding({ id: "a" })])).toContain("1 finding has");
		expect(unchallengedBrief([finding({ id: "a" }), finding({ id: "b" })])).toContain("2 findings have");
	});

	/** A brief that grew with the engagement would be charged on every turn. */
	it("names a few and counts the rest", () => {
		const many = ["a", "b", "c", "d", "e"].map((id) => finding({ id }));
		const out = unchallengedBrief(many);
		expect(out).toContain("+2 more");
		expect(out).not.toContain("e [");
	});

	it("labels the examined-but-unsettled, and counts them when the list is cut", () => {
		const unsettled = (id: string) => finding({ id, verification: { verdict: "unresolved", at: NOW, notes: "no second account" } });
		expect(unchallengedBrief([unsettled("u1")])).toContain("u1 [high] IDOR on GET /api/notes/{id} (examined, unsettled: no second account)");
		const out = unchallengedBrief([finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" }), unsettled("u1"), unsettled("u2")]);
		expect(out).toContain("+2 more (2 examined, unsettled)");
		expect(out).toContain("5 findings have not been settled by a challenge");
	});

	it("is empty when nothing is waiting, so it costs no prompt", () => {
		expect(unchallengedBrief([])).toBe("");
		expect(unchallengedBrief([finding({ status: "confirmed" }), finding({ status: "refuted" })])).toBe("");
	});
});

describe("hypothesisBrief", () => {
	const hyp = (over: Partial<HypothesisRecord> = {}): HypothesisRecord => ({
		v: 1, id: "y7", kind: "hypothesis", createdAt: "t0",
		statement: "q reaches db.query but the call is parameterized at core/db.js:41",
		target: "e1", class: "sqli", outcome: "refuted",
		...over,
	} as HypothesisRecord);

	/**
	 * The gap this exists for: `refuted` turns a coverage cell `clear`, that cell
	 * counts toward the percentage handed to the client, and nothing ever looks
	 * again. Findings are challenged; clearances were taken at their word — and a
	 * wrong clearance is the missed vulnerability the whole harness is built
	 * against.
	 */
	it("asks a verifier to break the clearance, not the claim", () => {
		const out = hypothesisBrief(hyp());
		expect(out).toMatch(/concluded it is CLEAR/);
		expect(out).toMatch(/disagree with it/);
		expect(out).toMatch(/not seen the reasoning/);
	});

	it("frames an unsettled case as one to settle, either way", () => {
		const out = hypothesisBrief(hyp({ outcome: "inconclusive" }));
		expect(out).toMatch(/Nobody has settled/);
		expect(out).toMatch(/a refutation counts/);
		expect(out).not.toMatch(/concluded it is CLEAR/);
	});

	it("carries the class contract, so the verifier knows what would count", () => {
		const out = hypothesisBrief(hyp());
		expect(out).toContain(contractFor("sqli")?.claim);
		expect(out).toContain(contractFor("sqli")?.control);
	});

	it("falls back to the generic bar for a class with no contract", () => {
		expect(hypothesisBrief(hyp({ class: "not-a-class" }))).toContain(GENERIC_CONTROL);
	});

	/**
	 * What makes a second look worth paying for. A cleared cell arrives with
	 * almost nothing of its own, so the value is everything the engagement has
	 * learned since — the same class confirmed next door is exactly what
	 * overturns a clearance.
	 */
	it("brings what the ledger learned nearby, and says it is not the refutation's reasoning", () => {
		const out = hypothesisBrief(hyp(), {
			element: "GET /search (core/search.js)",
			neighbours: [finding({ id: "f2", title: "SQLi in /login", severity: "high", class: "sqli" })],
			siblings: [hyp({ id: "y9", class: "authz", statement: "no ownership check", outcome: "confirmed" })],
		});
		expect(out).toContain("GET /search (core/search.js)");
		expect(out).toContain("f2");
		expect(out).toContain("SQLi in /login");
		expect(out).toContain("y9");
		expect(out).toMatch(/none of it is the refutation's reasoning/);
	});

	/** The brief is for a cold agent; handing it its own row back is noise. */
	it("does not list the hypothesis under challenge among its own siblings", () => {
		const out = hypothesisBrief(hyp(), { siblings: [hyp()] });
		// The id is named where the verdict is to be written; it must not also
		// appear as a row of what the ledger knows nearby.
		expect(out).not.toMatch(/^- y7 \[/m);
		expect(out).not.toMatch(/already knows here/);
	});

	it("carries the target model, truncating rather than trailing off", () => {
		const long = "x".repeat(5000);
		const out = hypothesisBrief(hyp(), { targetModel: long });
		expect(out).toMatch(/truncated/);
		expect(out).toContain("recall model");
		expect(out.length).toBeLessThan(4000);
	});

	it("says nothing about a model or neighbours when there are none", () => {
		const out = hypothesisBrief(hyp());
		expect(out).not.toMatch(/working theory/);
		expect(out).not.toMatch(/already knows here/);
	});

	it("demands grounds either way, and forbids the empty refutation", () => {
		const out = hypothesisBrief(hyp());
		expect(out).toMatch(/I could not find anything/);
		expect(out).toMatch(/file:line or evidence path/);
	});

	/**
	 * It used to say "your basis in the reason". `reason` is a note; only `basis`
	 * writes the verification that marks a cell re-checked, so a verifier that
	 * followed the brief left the clearance looking as if nobody had looked twice.
	 */
	it("puts the grounds in basis, on the hypothesis by its id", () => {
		const out = hypothesisBrief(hyp());
		expect(out).toContain("record kind=hypothesis id=y7");
		expect(out).toMatch(/basis=\[/);
		expect(out).not.toMatch(/basis in the reason/);
		expect(out).toMatch(/outcome=refuted/);
		expect(out).toMatch(/outcome=inconclusive/);
	});

	it("turns a confirmed cell into a finding linked back to it", () => {
		// Only a finding reaches the report; a confirmed cell alone does not.
		const out = hypothesisBrief(hyp());
		expect(out).toMatch(/outcome=confirmed, statement="what holds", then record the finding/);
		expect(out).toContain("hypothesisId=y7");
		expect(out).toContain("class=sqli");
	});

	it("names the two fields a finding is refused without, and what it lands as", () => {
		// title and severity are required for a new finding; a brief that leaves them
		// out walks the verifier into a refusal on the one write that reaches the report.
		const out = hypothesisBrief(hyp());
		expect(out).toContain('title="...", severity=...');
		expect(out).toMatch(/title and severity are required/);
		expect(out).toMatch(/lands suspected unless it carries status=confirmed with the control case you ran/);
		expect(out).not.toMatch(/lands suspected[^\n]*entitlement=/);
		// judge() asks entitlement of the access-control classes, so the brief does too.
		expect(hypothesisBrief(hyp({ class: "idor" }))).toMatch(/lands suspected[^\n]*entitlement=/);
	});
});

describe("challengeCommand", () => {
	/**
	 * Moved out of `extensions/pired.ts`, which is 38% covered and is the file
	 * CLAUDE.md names as the one to keep moving logic out of. It had shipped with
	 * no test at all — and both schema bugs found this session were the same
	 * thing: a decision nothing could test.
	 */
	it("says nothing is waiting rather than drawing an empty list", () => {
		const view = challengeCommand({ findings: [finding({ status: "confirmed" })] });
		expect(view.tone).toBe("info");
		expect(view.text).toMatch(/nothing unchallenged/);
		expect(view.finding).toBeUndefined();
	});

	it("lists what carries no verdict, worst first", () => {
		const view = challengeCommand({
			findings: [
				finding({ id: "a", severity: "low", title: "Verbose errors" }),
				finding({ id: "b", severity: "critical", title: "RCE in /admin" }),
				finding({ id: "c", severity: "high", title: "IDOR on notes", status: "confirmed" }),
			],
		});
		expect(view.text).toMatch(/2 finding\(s\) carry no settled verdict/);
		// Assert on the rows themselves: a bare indexOf("b") matches the "b" in
		// any surrounding prose and passes for the wrong reason.
		const rows = view.text.split("\n").filter((l) => l.startsWith("· "));
		expect(rows).toEqual(["· b [critical] RCE in /admin", "· a [low] Verbose errors"]);
		expect(view.text).not.toContain("IDOR on notes");
		expect(view.text).toMatch(/\/challenge <id>/);
	});

	it("treats whitespace as no argument, not as an id", () => {
		expect(challengeCommand({ findings: [finding()], id: "   " }).text).toMatch(/carry no settled verdict/);
	});

	it("warns on an id it does not have, and points at the list", () => {
		const view = challengeCommand({ findings: [finding()], id: "nope" });
		expect(view.tone).toBe("warning");
		expect(view.text).toMatch(/no finding called "nope"/);
		expect(view.text).toMatch(/\/challenge lists/);
	});

	it("returns the brief and the finding it is for", () => {
		const target = finding({ id: "f3", class: "cmdi", title: "Command injection in /admin" });
		const view = challengeCommand({ findings: [target], id: "f3" });
		expect(view.tone).toBe("info");
		expect(view.finding).toBe(target);
		expect(view.text).toContain("Challenge finding f3");
		expect(view.text).toContain(contractFor("cmdi")?.control);
	});

	/** The delegation half: a child fetches its own brief rather than being handed one. */
	it("names the two commands a subagent needs, with the id filled in", () => {
		const view = challengeCommand({ findings: [finding({ id: "f3" })], id: "f3" });
		expect(view.text).toContain("pired-ledger recall challenge id=f3");
		expect(view.text).toContain("pired-ledger record kind=finding id=f3");
		expect(view.text).toMatch(/status=suspected with basis or control/);
		expect(view.text).toMatch(/cannot be asserted/);
	});

	it("audits against the target model, so an entitlement gap is named", () => {
		const view = challengeCommand({
			findings: [finding({ id: "f4", class: "idor" })],
			id: "f4",
			targetModel: "# Actors\nowner, admin\n",
		});
		expect(view.text).toContain("Challenge finding f4");
		expect(view.text).toMatch(/entitlement/i);
	});

	it("passes evidence through, so a cited file's shape is judged", () => {
		const view = challengeCommand({
			findings: [finding({ id: "f5", class: "sqli", evidence: ["evidence/x.txt"] })],
			id: "f5",
			evidence: { "evidence/x.txt": "GET /search?q=1 HTTP/1.1\n\nHTTP/1.1 200 OK\n" },
		});
		expect(view.text).toContain("evidence/x.txt");
	});

	it("is unbothered by an empty ledger", () => {
		expect(challengeCommand({ findings: [] }).text).toMatch(/nothing unchallenged/);
		expect(challengeCommand({ findings: [], id: "f1" }).tone).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// Grounded verification (delegation-v6 Phase 3, 3.1)
// ---------------------------------------------------------------------------

/**
 * A synthetic decoy: each sink sits beside a guarded twin, far enough apart
 * that neither's window reaches the other. Written for these tests, not taken
 * from any corpus application, so nothing here is fitted to a benchmark.
 */
const DECOY = [
	"from flask import request, abort",                                              // 1
	"from .db import db, current_user, render",                                      // 2
	"",                                                                              // 3
	"@app.get(\"/notes/<note_id>\")",                                                // 4
	"def get_note(note_id):",                                                        // 5
	"    note = db.query(\"SELECT * FROM notes WHERE id = ?\", (note_id,)).one()",   // 6
	"    return note.body",                                                          // 7
	"",                                                                              // 8
	"",                                                                              // 9
	"@app.get(\"/notes/<note_id>/checked\")",                                        // 10
	"def get_note_checked(note_id):",                                                // 11
	"    note = db.query(\"SELECT * FROM notes WHERE id = ?\", (note_id,)).one()",   // 12
	"    if note.owner_id != current_user().id:",                                    // 13
	"        abort(403)",                                                            // 14
	"    return note.body",                                                          // 15
	"",                                                                              // 16
	"",                                                                              // 17
	"@app.get(\"/search\")",                                                         // 18
	"def search():",                                                                 // 19
	"    term = request.args.get(\"q\", \"\")",                                      // 20
	"    rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term + \"%'\")", // 21
	"    return render(rows)",                                                       // 22
	"",                                                                              // 23
	"",                                                                              // 24
	"",                                                                              // 25
	"@app.get(\"/search/checked\")",                                                 // 26
	"def search_checked():",                                                         // 27
	"    term = request.args.get(\"q\", \"\")",                                      // 28
	"    rows = db.execute(\"SELECT * FROM notes WHERE body LIKE ?\", (\"%\" + term + \"%\",))", // 29
	"    return render(rows)",                                                       // 30
].join("\n");

/** The decoy as the host would resolve it: the one file, under the engagement directory. */
const readDecoy: QuoteReader = async (file) =>
	file === "app/notes.py" || file === "notes.py" ? { path: "app/notes.py", body: DECOY } : undefined;

const SQLI_SOURCE = "app/notes.py:20: term = request.args.get(\"q\", \"\")";
const SQLI_SINK = "app/notes.py:21: rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term + \"%'\")";
const IDOR_GUARD = "app/notes.py:13: if note.owner_id != current_user().id:";

/** A decoy finding, as the ledger holds it. */
function decoyFinding(over: Partial<FindingRecord> = {}): FindingRecord {
	return finding({ id: "f9", title: "SQL injection in /search", class: "sqli", target: "app/notes.py:21", ...over });
}

describe("grounding a quote against the file it cites", () => {
	it("accepts a quote three lines off after whitespace normalisation", async () => {
		// Line 21's sink, cited at 18 and with its indentation and spacing mangled.
		const [q] = await groundQuotes(["app/notes.py:18:   rows =   db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term"], readDecoy);
		expect(q?.grounded).toBe(true);
		expect(q?.at).toBe("app/notes.py:18");
	});

	it("does not accept the same quote four lines off", async () => {
		const [q] = await groundQuotes(["app/notes.py:17: rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term"], readDecoy);
		expect(q?.grounded).toBe(false);
		expect(q?.why).toMatch(/not within 3 lines of line 17/);
	});

	it("keeps a sink quote cited at its guarded twin's line from counting, and says what that line reads", async () => {
		// The decoy's point: the parameterised twin is eight lines below, so a
		// verifier that read one function and cited the other is caught.
		const [q] = await groundQuotes(["app/notes.py:29: rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term + \"%'\")"], readDecoy);
		expect(q?.grounded).toBe(false);
		expect(q?.actual).toContain("LIKE ?");
		expect(describeUngrounded([q as GroundedQuote])).toMatch(/line 29 reads: "rows = db\.execute\("SELECT \* FROM notes WHERE body LIKE \?"/);
	});

	it("will not take a quote below the floor, even when the line holds it", async () => {
		const [q] = await groundQuotes(["app/notes.py:14: 403)"], readDecoy);
		expect(q?.grounded).toBe(false);
		expect(q?.why).toMatch(new RegExp(`at least ${MIN_QUOTE_CHARS}`));
		expect(MIN_QUOTE_CHARS).toBe(6);
		expect(MAX_QUOTE_OCCURRENCES).toBe(3);
		expect(QUOTE_WINDOW).toBe(3);
	});

	it("grounds a short guard a file has once, which a length rule failed", async () => {
		// `if not user:` is ten non-space characters: under the old twelve-character
		// rule the one guard that mattered could not be quoted on its own.
		const file = "def view(user):\n    if not user:\n        abort(401)\n    return render(user.notes)\n";
		const [q] = await groundQuotes(["views.py:2: if not user:"], async () => ({ path: "views.py", body: file }));
		expect(q?.grounded).toBe(true);
	});

	it("refuses a line the file repeats too often to identify, which a length rule passed", async () => {
		// `return nil, err` is thirteen non-space characters and sits under half the
		// calls in a Go handler: in the window, and proof of nothing.
		const body = Array.from({ length: 5 }, (_, i) => `\tv${i}, err := step${i}(ctx)\n\tif err != nil {\n\t\treturn nil, err\n\t}`).join("\n");
		const [q] = await groundQuotes(["handler.go:3: return nil, err"], async () => ({ path: "handler.go", body }));
		expect(q?.grounded).toBe(false);
		expect(q?.why).toMatch(/occurs 5 times in handler\.go, so it does not identify a line/);
		// Quoted with the call it belongs to, the same line identifies itself.
		const [joined] = await groundQuotes(["handler.go:1-3: v0, err := step0(ctx) if err != nil { return nil, err"], async () => ({ path: "handler.go", body }));
		expect(joined?.grounded).toBe(true);
	});

	it("refuses a brace or a bare `return nil` however near the cited line it is", async () => {
		const body = Array.from({ length: 12 }, (_, i) => `func f${i}() error {\n\treturn nil\n}`).join("\n");
		const read: QuoteReader = async () => ({ path: "f.go", body });
		const [brace, bare] = await groundQuotes(["f.go:3: }", "f.go:2: return nil"], read);
		expect(brace?.grounded).toBe(false);
		expect(brace?.why).toMatch(/at least 6/);
		expect(bare?.grounded).toBe(false);
		expect(bare?.why).toMatch(/occurs 12 times/);
	});

	it("caps a range, so the decoy's guarded twin thirty lines away cannot ground", async () => {
		// The parameterised twin is at line 29; a range from line 1 would otherwise
		// read the whole file as one window.
		const twin = "rows = db.execute(\"SELECT * FROM notes WHERE body LIKE ?\"";
		const [wide] = await groundQuotes([`app/notes.py:1-30: ${twin}`], readDecoy);
		expect(wide?.grounded).toBe(false);
		expect(wide?.why).toMatch(/the range spans 30 lines; cite the line the quote is on, or a range of at most 7/);
		const [narrow] = await groundQuotes([`app/notes.py:26-32: ${twin}`], readDecoy);
		expect(narrow?.grounded).toBe(true);
		expect(MAX_QUOTE_SPAN).toBe(6);
	});

	it("marks a quote that is only a comment, and grounds it all the same", async () => {
		const body = "def export(req):\n    # checks the caller owns the invoice\n    return send(req.invoice)\n";
		const [q] = await groundQuotes(["x.py:2: # checks the caller owns the invoice"], async () => ({ path: "x.py", body }));
		expect(q).toMatchObject({ grounded: true, commentOnly: true });
		for (const c of ["// guard", "/* guard */", "* guard", "-- guard", "<!-- guard -->"]) expect(isCommentOnly(c)).toBe(true);
		expect(isCommentOnly("if (!owner) return")).toBe(false);
	});

	it("reports a file the host could not settle on, in the host's words", async () => {
		const [q] = await groundQuotes(["notes.py:13: if note.owner_id != current_user().id:"], async () => ({ unresolved: "'notes.py' is ambiguous" }));
		expect(q).toMatchObject({ grounded: false, why: "'notes.py' is ambiguous" });
	});

	it("matches a short guard quoted together with the line it guards", async () => {
		// `if note.owner_id != current_user().id:` clears the bar alone; a guard
		// that does not is quoted with the line after it, across the line break.
		const [q] = await groundQuotes(["app/notes.py:13: current_user().id: abort(403)"], readDecoy);
		expect(q?.grounded).toBe(true);
	});

	it("reads a range as its whole span, and takes off backticks wrapped round the text", async () => {
		const [range, ticked] = await groundQuotes([
			"app/notes.py:12-15: return note.body",
			"app/notes.py:13: `if note.owner_id != current_user().id:`",
		], readDecoy);
		expect(range).toMatchObject({ grounded: true, at: "app/notes.py:12-15" });
		expect(ticked).toMatchObject({ grounded: true, quote: "if note.owner_id != current_user().id:" });
	});

	it("says a string that is not a quote is not one, and names a file that is not there", async () => {
		const [prose, missing, beyond] = await groundQuotes([
			"the handler checks ownership",
			"app/other.py:3: something long enough to be a quote",
			"app/notes.py:90: return render(rows) and more",
		], readDecoy);
		expect(prose).toMatchObject({ grounded: false, why: expect.stringMatching(/file:line: verbatim text/) });
		expect(missing).toMatchObject({ grounded: false, why: expect.stringMatching(/no file 'app\/other\.py'/) });
		expect(beyond).toMatchObject({ grounded: false, why: "app/notes.py has 30 lines" });
	});

	it("stores the path the host resolved, so a basename citation names the file", async () => {
		const [q] = await groundQuotes([`notes.py:13: if note.owner_id != current_user().id:`], readDecoy);
		expect(q).toMatchObject({ grounded: true, at: "app/notes.py:13" });
	});

	it("reads each cited file once, and skips blank entries", async () => {
		let reads = 0;
		const counting: QuoteReader = async (file) => { reads += 1; return readDecoy(file); };
		const out = await groundQuotes([SQLI_SOURCE, "", SQLI_SINK, IDOR_GUARD], counting);
		expect(out).toHaveLength(3);
		expect(reads).toBe(1);
	});

	it("treats a reader that throws as a file that is not there", async () => {
		const [q] = await groundQuotes([SQLI_SINK], async () => { throw new Error("EACCES"); });
		expect(q?.grounded).toBe(false);
	});

	it("parses the citation forms a model writes and nothing else", () => {
		expect(parseQuote("./app/notes.py:20: term = x")).toMatchObject({ file: "app/notes.py", line: 20, end: 20, quote: "term = x" });
		expect(parseQuote("app/notes.py:12-15: return note.body")).toMatchObject({ line: 12, end: 15 });
		expect(parseQuote("http://host:8080/x")).toBeUndefined();
		expect(parseQuote("app/notes.py:20")).toBeUndefined();
		expect(parseQuote("app/notes.py:0: nothing on line zero")).toBeUndefined();
		expect(parseQuote("app/notes.py:15-12: backwards range")).toBeUndefined();
		expect(parseQuote("app/notes.py:13: \"\"")?.quote).toBe("\"\"");
	});
});

describe("the grounded judge", () => {
	const source = async (hops: string[]) => groundQuotes(hops, readDecoy);

	it("confirms on a source-only engagement only when path quotes a source and a sink found at their cited lines", async () => {
		const control = "the parameterised twin at app/notes.py:29 is what safe looks like; this one concatenates";
		const confirmed = judge(decoyFinding(), { verdict: "stands", control, sourceOnly: true, path: await source([SQLI_SOURCE, SQLI_SINK]) }, NOW);
		expect(confirmed.status).toBe("confirmed");
		expect(confirmed.verification.path).toEqual([
			{ at: "app/notes.py:20", quote: "term = request.args.get(\"q\", \"\")" },
			{ at: "app/notes.py:21", quote: "rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term + \"%'\")" },
		]);
		expect(confirmed.verification.tier).toBe("static");

		const sinkOnly = judge(decoyFinding(), { verdict: "stands", control, sourceOnly: true, path: await source([SQLI_SINK]) }, NOW);
		expect(sinkOnly.status).toBe("suspected");
		expect(sinkOnly.downgraded).toMatch(/path=\[the source hop, …, the\s+sink hop\]/);

		const noPath = judge(decoyFinding(), { verdict: "stands", control, sourceOnly: true }, NOW);
		expect(noPath.status).toBe("suspected");
	});

	it("keeps a finding suspected and quotes the real line when a verifier's sink quote is not there", async () => {
		// The sink quoted at the guarded twin's line: the file says otherwise.
		const wrong = "app/notes.py:29: rows = db.execute(\"SELECT * FROM notes WHERE body LIKE '%\" + term + \"%'\")";
		const out = judge(decoyFinding(), {
			verdict: "stands", control: "concatenated into the query", sourceOnly: true, path: await source([SQLI_SOURCE, wrong]),
		}, NOW);
		expect(out.verdict).toBe("unresolved");
		expect(out.status).toBe("suspected");
		expect(out.downgraded).toMatch(/a quote does not match the file it cites/);
		expect(out.downgraded).toMatch(/line 29 reads: "rows = db\.execute\("SELECT \* FROM notes WHERE body LIKE \?"/);
		// A path with a hop nobody can find is not kept as a path.
		expect(out.verification).not.toHaveProperty("path");
	});

	it("leaves a confirmed finding confirmed when a later look quotes a line that is not there", async () => {
		const earned = { verdict: "stands" as const, at: "t1", control: "ran", by: "pired-verify" };
		const out = judge(decoyFinding({ status: "confirmed", verification: earned }), {
			verdict: "refuted", basis: ["app/notes.py:21: rows = db.execute(q, params)"], basisQuotes: await source(["app/notes.py:21: rows = db.execute(q, params)"]), sourceOnly: true,
		}, NOW);
		expect(out.status).toBe("confirmed");
		expect(out.kept).toEqual(earned);
	});

	it("refutes on a source review only with a grounded quoted guard", async () => {
		const idor = finding({ id: "f8", title: "IDOR on /notes/<id>/checked", class: "idor", target: "app/notes.py:12" });
		const bare = judge(idor, { verdict: "refuted", basis: ["app/notes.py:13"], sourceOnly: true }, NOW);
		expect(bare.status).toBe("suspected");
		expect(bare.downgraded).toMatch(/quotes what makes this not a finding/);

		const quoted = judge(idor, { verdict: "refuted", basis: [IDOR_GUARD], basisQuotes: await source([IDOR_GUARD]), sourceOnly: true }, NOW);
		expect(quoted.status).toBe("refuted");

		// The guard may travel in `guards` rather than in `basis`, which still names the grounds.
		const inGuards = judge(idor, { verdict: "refuted", basis: ["the ownership check"], guards: await source([IDOR_GUARD]), sourceOnly: true }, NOW);
		expect(inGuards.status).toBe("refuted");
		expect(inGuards.verification.guards).toEqual([{ at: "app/notes.py:13", quote: "if note.owner_id != current_user().id:" }]);

		// The guard quoted at the unguarded twin's line is not there.
		const misplaced = "app/notes.py:6: if note.owner_id != current_user().id:";
		const decoyed = judge(idor, { verdict: "refuted", basis: [misplaced], basisQuotes: await source([misplaced]), sourceOnly: true }, NOW);
		expect(decoyed.status).toBe("suspected");
		expect(decoyed.downgraded).toMatch(/line 6 reads/);
	});

	it("keeps ADR-009's bar for a refutation against a live target: a cited basis, no quote required", () => {
		const out = judge(finding(), { verdict: "refuted", basis: ["evidence/f1-owner-only.txt"], live: true }, NOW);
		expect(out.status).toBe("refuted");
	});

	it("keeps the live-target confirmation unchanged: control and entitlement, no path", () => {
		expect(judge(finding(), goodReport(), NOW).status).toBe("confirmed");
	});

	it("stamps who judged it, on an earned verdict and on a look alike", async () => {
		const confirmed = judge(finding(), goodReport({ by: "pired-verify" }), NOW);
		expect(confirmed.verification.by).toBe("pired-verify");
		const look = judge(finding(), { verdict: "unresolved", basis: ["app/notes.py:13"], by: "lead" }, NOW);
		expect(look.verification.by).toBe("lead");
		expect(look.verification).not.toHaveProperty("tier");
	});

	it("derives the tier: executed only for a live check or a saved exchange on an engagement with a target", () => {
		const exchange = "GET /search?q=' HTTP/1.1\nHost: app\n\nHTTP/1.1 500 Internal Server Error\n";
		expect(deriveTier({ live: true })).toBe("executed");
		expect(deriveTier({ evidence: [exchange] })).toBe("executed");
		// A review of source is static whatever it cites or claims (ADR-028).
		expect(deriveTier({ live: true, sourceOnly: true })).toBe("static");
		expect(deriveTier({ sourceOnly: true, evidence: [exchange] })).toBe("static");
		// A tool's output, notes, or a request with no response: nothing shows the target answered.
		expect(deriveTier({ evidence: ["$ python poc.py\nrows returned: 412\n"] })).toBe("static");
		expect(deriveTier({ evidence: ["curl -s https://app/search?q=x"] })).toBe("static");
		expect(deriveTier({ evidence: ["   "] })).toBe("static");
		expect(judge(finding(), goodReport(), NOW).verification.tier).toBe("executed");
	});

	it("does not read a `cat -n` excerpt with three-digit line numbers as a transcript", () => {
		const excerpt = "   120\tdef search():\n   121\t    term = request.args.get('q')\n   122\t    return db.execute(term)\n";
		expect(evidenceShape(excerpt)).not.toBe("wire");
		expect(deriveTier({ evidence: [excerpt] })).toBe("static");
		// A status code alone on its line, as `curl -w '%{http_code}'` prints it, is still a response.
		expect(evidenceShape("curl -s -o /dev/null -w '%{http_code}' https://app/\n403\n")).toBe("wire");
		expect(evidenceShape("status:\n200 OK\n")).toBe("wire");
	});
});

describe("who wrote a finding, and who judged it", () => {
	it("tells a worker from the lead, its scribe and the operator", () => {
		expect(isWorkerAuthor("pired-investigate")).toBe(true);
		expect(isWorkerAuthor("worker")).toBe(true);
		for (const by of ["lead", "scribe", "operator", undefined]) expect(isWorkerAuthor(by)).toBe(false);
	});

	it("calls a verification independent only when someone other than the finder made it", () => {
		const v = (by: string) => ({ verdict: "stands" as const, at: NOW, by });
		expect(isIndependent({ by: "pired-investigate", verification: v("pired-verify") })).toBe(true);
		expect(isIndependent({ by: "pired-investigate", verification: v("lead") })).toBe(true);
		expect(isIndependent({ by: "lead", verification: v("lead") })).toBe(false);
		// The scribe writes from the lead's own buffer: the lead confirming it is the finder confirming itself.
		expect(isIndependent({ by: "scribe", verification: v("lead") })).toBe(false);
		expect(isIndependent({ verification: v("lead") })).toBeUndefined();
		expect(isIndependent({ by: "lead" })).toBeUndefined();
	});
});

describe("what the lead is shown about who recorded and who judged (3.1)", () => {
	it("counts the unverified findings workers recorded, and names a bounded few", () => {
		const rows = [
			finding({ id: "f1", by: "lead" }),
			...Array.from({ length: 8 }, (_, i) => finding({ id: `w${i + 1}`, by: i % 2 === 0 ? "pired-investigate" : "pired-escalate" })),
		];
		const brief = unchallengedBrief(rows);
		expect(brief).toContain("9 findings have not been settled by a challenge");
		expect(brief).toContain("8 of them were recorded by workers: w1, w2, w3, w4, w5, w6 +2 more");
		expect(brief).toContain("settled by a verifier or by you, not by its finder");
	});

	it("says so plainly when every waiting finding, or the only one, came from a worker", () => {
		expect(unchallengedBrief([finding({ id: "w1", by: "pired-investigate" }), finding({ id: "w2", by: "worker" })])).toContain("All were recorded by workers: w1, w2");
		expect(unchallengedBrief([finding({ id: "w1", by: "pired-investigate" })])).toContain("It was recorded by a worker: w1");
	});

	it("leaves the worker count out when the lead, the scribe or an old unstamped row recorded them", () => {
		const brief = unchallengedBrief([finding({ id: "f1", by: "lead" }), finding({ id: "f2", by: "scribe" }), finding({ id: "f3" })]);
		expect(brief).not.toContain("recorded by");
	});

	it("labels a listing line with its author, its judge and the tier", () => {
		const judged = (by: string, tier: "static" | "executed", verdict: "stands" | "refuted" = "stands") => ({ verdict, at: NOW, by, tier });
		expect(provenanceLabel({ by: "pired-investigate" })).toBe(" · by pired-investigate");
		expect(provenanceLabel({ by: "pired-investigate", verification: judged("pired-verify", "static") })).toBe(" · by pired-investigate · verified by pired-verify, static");
		expect(provenanceLabel({ by: "lead", verification: judged("lead", "executed") })).toBe(" · by lead · verified by lead (its finder), executed");
		expect(provenanceLabel({ by: "lead", verification: judged("pired-verify", "static", "refuted") })).toBe(" · by lead · refuted by pired-verify, static");
		// A look that settled nothing is not a verification to label, and an old row says nothing.
		expect(provenanceLabel({ by: "lead", verification: { verdict: "unresolved", at: NOW, by: "pired-verify" } })).toBe(" · by lead");
		expect(provenanceLabel({})).toBe("");
		expect(provenanceLabel({ verification: { verdict: "stands", at: NOW } })).toBe(" · verified");
	});

	it("carries the author onto the /challenge list", () => {
		const view = challengeCommand({ findings: [finding({ id: "w1", by: "pired-investigate" })] });
		expect(view.text).toContain("· w1 [high] IDOR on GET /api/notes/{id} · by pired-investigate");
	});
});

describe("co-finders (3.1 review)", () => {
	it("counts every contributor as a finder, so their verification is not independent", () => {
		const v = (by: string) => ({ verdict: "stands" as const, at: NOW, by });
		expect(isIndependent({ by: "lead", contributors: ["pired-verify"], verification: v("pired-verify") })).toBe(false);
		expect(isIndependent({ by: "lead", contributors: ["pired-escalate"], verification: v("pired-verify") })).toBe(true);
		expect(isFinder({ by: "scribe", contributors: ["pired-escalate"] }, "lead")).toBe(true);
		expect(isFinder({ by: "lead" }, undefined)).toBe(false);
		expect(EARNED_LOCKED_FIELDS).toEqual(["status", "title", "description", "target", "severity"]);
	});
});
