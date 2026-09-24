import { describe, expect, it } from "vitest";
import { computeCoverage } from "./coverage.ts";
import type {
	CoverageMatrix, FindingRecord, HypothesisRecord, InventoryRecord, LootRecord, PassLens,
} from "./ontology.ts";
import {
	lensForPass, nextInPass, parseInvariants, parseLenses, passCommand, passDelta, passState,
	planPass, promoteLens, renderPassBrief, resolveLadder,
} from "./passes.ts";

// --- builders ---------------------------------------------------------------

function hypothesis(over: Partial<HypothesisRecord> = {}): HypothesisRecord {
	return {
		v: 1, id: "h1", kind: "hypothesis", createdAt: "2026-09-01T10:00:00Z",
		statement: "the handler concatenates the id into the query",
		target: "e1", class: "sqli", outcome: "proposed",
		...over,
	} as HypothesisRecord;
}

function finding(over: Partial<FindingRecord> = {}): FindingRecord {
	return {
		v: 1, id: "f1", kind: "finding", createdAt: "2026-09-01T10:00:00Z",
		title: "IDOR on GET /api/notes/{id}", severity: "high", target: "e1",
		class: "idor", status: "suspected",
		...over,
	} as FindingRecord;
}

function endpoint(over: Partial<InventoryRecord> = {}): InventoryRecord {
	return {
		v: 1, id: "e1", kind: "endpoint", createdAt: "2026-09-01T09:00:00Z",
		host: "h1", method: "GET", path: "/api/notes/{id}",
		...over,
	} as InventoryRecord;
}

function loot(over: Partial<LootRecord> = {}): LootRecord {
	return {
		v: 1, id: "l1", kind: "loot", createdAt: "2026-09-01T12:00:00Z",
		handle: "cred:web-admin", type: "password", secret: "hunter2",
		...over,
	} as LootRecord;
}

/** A matrix over one endpoint and two classes, with whatever hypotheses are given. */
function matrix(hypotheses: HypothesisRecord[] = []): CoverageMatrix {
	return computeCoverage({
		classes: [{ id: "sqli" }, { id: "idor" }],
		elements: [{ id: "e1", kind: "endpoint" }],
		hypotheses,
		openBlockers: [],
	});
}

// ---------------------------------------------------------------------------

describe("the ladder, and the fact that it is off by default", () => {
	it("gives no ladder at all when nothing configured it", () => {
		// The inertness property the whole feature rests on. Every number in
		// research/ was measured against a single-pass harness, so an engagement
		// that has not opted in must behave byte-identically: no ladder means no
		// prompt block, no router change and no panel row.
		expect(resolveLadder(undefined)).toBeUndefined();
		expect(resolveLadder({})).toBeUndefined();
		expect(resolveLadder({ enabled: false, lenses: ["file"] })).toBeUndefined();
		expect(passState(undefined, 4)).toBeUndefined();
	});

	it("falls back to the default ladder when enabled with no lenses named", () => {
		expect(resolveLadder({ enabled: true })).toEqual(["route", "file", "invariant", "adversarial"]);
	});

	it("keeps the configured lenses in the order they were written", () => {
		// The ladder is an order, not a set: pass 2 under `adversarial` and pass 2
		// under `file` are different engagements.
		expect(resolveLadder({ enabled: true, lenses: ["adversarial", "file"] })).toEqual(["adversarial", "file"]);
	});

	it("drops a lens the ontology does not know rather than failing to start", () => {
		const bogus = ["route", "telepathy"] as unknown as PassLens[];
		expect(resolveLadder({ enabled: true, lenses: bogus })).toEqual(["route"]);
	});

	it("lets the environment turn passes on for a scope that predates them, and off for one that has them", () => {
		// The affordance PIRED_SCRIBE exists for: research/11 reports three measured
		// passes in which the scribe fired zero times because a headless run had no
		// way to enable it, so the arm was scored with the mechanism switched off.
		expect(resolveLadder(undefined, parseLenses("file,invariant"))).toEqual(["file", "invariant"]);
		expect(resolveLadder({ enabled: true }, parseLenses("off"))).toBeUndefined();
	});

	it("reads a lens list however it was spaced, and ignores an empty variable", () => {
		expect(parseLenses("route, file  invariant")).toEqual(["route", "file", "invariant"]);
		expect(parseLenses("")).toBeUndefined();
		expect(parseLenses(undefined)).toBeUndefined();
		expect(parseLenses("nonsense")).toEqual([]);
	});

	it("clamps a pass past the end of the ladder onto its last rung", () => {
		// An operator opening a fifth pass on a four-rung ladder wants more of the
		// last lens, not the route sweep again — and a pass with no lens would have
		// no worklist at all.
		const ladder: PassLens[] = ["route", "file"];
		expect(lensForPass(ladder, 1)).toBe("route");
		expect(lensForPass(ladder, 2)).toBe("file");
		expect(lensForPass(ladder, 9)).toBe("file");
		expect(lensForPass(ladder, 0)).toBe("route");
	});
});

describe("what each lens is allowed to look at", () => {
	it("routes pass 1 to the untested cells, exactly as the matrix always did", () => {
		const plan = planPass({ pass: 1, lens: "route", matrix: matrix() });
		expect(plan.total).toBe(2);
		expect(plan.items.map((i) => i.ref).sort()).toEqual(["e1:idor", "e1:sqli"]);
	});

	it("does not run out of work when the matrix is settled — which is the whole feature", () => {
		// research/06: the persisted arm's final session ran 105 seconds, recorded
		// zero new findings and zero new hypotheses, and stopped. The agent opened a
		// full ledger and concluded the work was done, because `selectNext` routes
		// to `not-tested` by construction and there was nothing left that looked
		// untested. A settled matrix is the end of the route sweep, not the end of
		// the engagement, and every other lens has to be able to say so.
		const settled = [
			hypothesis({ id: "h1", class: "sqli", outcome: "refuted" }),
			hypothesis({ id: "h2", class: "idor", outcome: "refuted" }),
		];
		const m = matrix(settled);
		expect(planPass({ pass: 1, lens: "route", matrix: m }).total).toBe(0);
		expect(planPass({ pass: 2, lens: "adversarial", matrix: m, hypotheses: settled }).total).toBe(2);
	});

	it("distinguishes an unseeded checklist from an empty review from finished work", () => {
		// Found by driving `pired-ledger recall pass` against a workspace with no
		// checklist: it reported "No surface recorded yet" at a ledger that held an
		// endpoint. Three different facts, and a reader sent after the wrong one.
		expect(planPass({ pass: 1, lens: "route" }).note).toContain("No checklist is loaded");
		const empty = computeCoverage({ classes: [{ id: "sqli" }], elements: [], hypotheses: [], openBlockers: [] });
		expect(planPass({ pass: 1, lens: "route", matrix: empty }).note).toContain("No surface recorded yet");
		expect(planPass({
			pass: 1, lens: "route", matrix: matrix([hypothesis({ id: "h1", outcome: "refuted" }), hypothesis({ id: "h2", class: "idor", outcome: "refuted" })]),
		}).note).toContain("Every applicable test case has a verdict");
	});

	it("names a file the ledger talks about but never recorded as surface", () => {
		// The measured miss this lens exists for: across 17 misses on the
		// application corpus the file holding the missed entry was OPENED in 17 of
		// 17 and RECORDED AS SURFACE in 0 of 17. Coverage is classes x surface, so a
		// matrix built out of routes has no cell that can point at a file.
		const plan = planPass({
			pass: 2,
			lens: "file",
			findings: [finding({ target: "http/share.go:84", locations: ["http/share.go:84", "http/public.go:58"] })],
			inventory: [endpoint()],
		});
		expect(plan.items.map((i) => i.ref)).toEqual(["http/share.go", "http/public.go"]);
		expect(plan.items[0]?.why).toContain("never recorded as surface");
	});

	it("leaves out a file that IS recorded as surface, so the lens shrinks as the review improves", () => {
		const plan = planPass({
			pass: 2,
			lens: "file",
			findings: [finding({ target: "http/share.go:84" })],
			inventory: [endpoint({ file: "http/share.go" } as Partial<InventoryRecord>)],
		});
		expect(plan.total).toBe(0);
		expect(plan.note).toContain("Every file the ledger names is recorded as surface");
	});

	it("says what is missing rather than nothing when no source file has been named at all", () => {
		const plan = planPass({ pass: 2, lens: "file", findings: [finding({ target: "e1" })] });
		expect(plan.total).toBe(0);
		expect(plan.note).toContain("names no source files yet");
	});

	it("routes to an invariant no hypothesis has gone after", () => {
		// An invariant is a hypothesis generator, and these are the classes no
		// checklist and no scanner reaches. Nothing else in the harness routes here.
		const model = [
			"## invariants",
			"- balances never go negative",
			"- a share link grants read only",
			"## flows",
			"- login, then fetch",
		].join("\n");
		const plan = planPass({
			pass: 3,
			lens: "invariant",
			targetModel: model,
			hypotheses: [hypothesis({ statement: "withdraw twice concurrently to drive the balance negative" })],
		});
		expect(plan.items.map((i) => i.ref)).toEqual(["a share link grants read only"]);
	});

	it("says the model has no invariants rather than reporting the lens complete", () => {
		// An empty section and a fully-tested one are opposite facts. Reporting the
		// first as the second is how coverage certifies a run that never started —
		// the same failure `recall gaps` fixed for an empty matrix.
		const plan = planPass({ pass: 3, lens: "invariant", targetModel: "## what\n- a bank" });
		expect(plan.total).toBe(0);
		expect(plan.note).toContain("records no invariants");
	});

	it("puts unchallenged findings before cleared cells, and oldest clearances first", () => {
		// Findings first because they reach the client as they stand. Cleared cells
		// oldest-first because a cell cleared in the first hour was cleared by an
		// agent that had not yet read the code it was clearing (ADR-016).
		const plan = planPass({
			pass: 4,
			lens: "adversarial",
			findings: [finding({ id: "f1", status: "suspected" })],
			hypotheses: [
				hypothesis({ id: "h-late", class: "sqli", outcome: "refuted", createdAt: "2026-09-02T10:00:00Z" }),
				hypothesis({ id: "h-early", class: "idor", outcome: "refuted", createdAt: "2026-09-01T08:00:00Z" }),
			],
		});
		expect(plan.items.map((i) => i.ref)).toEqual(["f1", "h-early", "h-late"]);
	});

	it("drops a cleared cell that has already had its second look", () => {
		// Without this the same cell is handed out forever and the work that was
		// done on it cannot be reported — flaw 2 of the three ADR-016 records.
		const plan = planPass({
			pass: 4,
			lens: "adversarial",
			hypotheses: [hypothesis({
				id: "h1", outcome: "refuted",
				verification: { verdict: "stands", at: "2026-09-02T10:00:00Z", basis: ["app.py:12"] },
			})],
		});
		expect(plan.total).toBe(0);
	});

	it("re-opens the cells that were settled before the engagement held a credential", () => {
		// A cell settled before there was a credential was settled as an anonymous
		// caller, whatever it concluded. The route sweep can never notice: the cell
		// is settled, and nothing in it records which principal asked.
		const plan = planPass({
			pass: 5,
			lens: "credentialed",
			loot: [loot({ createdAt: "2026-09-01T12:00:00Z" })],
			hypotheses: [
				hypothesis({ id: "before", outcome: "refuted", createdAt: "2026-09-01T09:00:00Z" }),
				hypothesis({ id: "after", class: "idor", outcome: "refuted", createdAt: "2026-09-01T15:00:00Z" }),
			],
		});
		expect(plan.items.map((i) => i.ref)).toEqual(["before"]);
		expect(plan.items[0]?.why).toContain("cred:web-admin");
	});

	it("orders the pre-credential cells oldest first, so the coldest clearance is sampled first", () => {
		const plan = planPass({
			pass: 5,
			lens: "credentialed",
			loot: [loot({ createdAt: "2026-09-01T12:00:00Z" })],
			hypotheses: [
				hypothesis({ id: "mid", class: "idor", outcome: "refuted", createdAt: "2026-09-01T10:00:00Z" }),
				hypothesis({ id: "first", class: "sqli", outcome: "confirmed", createdAt: "2026-09-01T08:00:00Z" }),
			],
		});
		expect(plan.items.map((i) => i.ref)).toEqual(["first", "mid"]);
	});

	it("says the credentialed lens has no principal yet rather than reporting it clean", () => {
		const plan = planPass({ pass: 5, lens: "credentialed", hypotheses: [hypothesis({ outcome: "refuted" })] });
		expect(plan.total).toBe(0);
		expect(plan.note).toContain("No credentials recorded");
	});

	it("caps the worklist but reports the true total, so a truncated list declares itself", () => {
		const many = Array.from({ length: 30 }, (_, i) => finding({ id: `f${i}`, status: "suspected" }));
		const plan = planPass({ pass: 2, lens: "adversarial", findings: many, limit: 5 });
		expect(plan.items).toHaveLength(5);
		expect(plan.total).toBe(30);
	});
});

describe("the router, under a pass", () => {
	it("hands pass 1 straight to selectNext, including its preference for in-progress cells", () => {
		// The compatibility property: an engagement that never opens a second pass
		// gets the behaviour it had before passes existed, `testing` fallback and
		// all — which the plan's worklist does not model.
		const testing = [
			hypothesis({ id: "h1", class: "sqli", outcome: "testing" }),
			hypothesis({ id: "h2", class: "idor", outcome: "refuted" }),
		];
		const m = matrix(testing);
		const plan = planPass({ pass: 1, lens: "route", matrix: m });
		expect(plan.total).toBe(0);
		expect(nextInPass(plan, m)?.ref).toBe("e1:sqli");
	});

	it("hands a later pass the lens's own first item, not the matrix's", () => {
		const settled = [hypothesis({ id: "h1", outcome: "refuted" })];
		const plan = planPass({ pass: 2, lens: "adversarial", hypotheses: settled });
		expect(nextInPass(plan, matrix(settled))?.ref).toBe("h1");
	});

	it("returns nothing when the lens has nothing, rather than falling back to the matrix", () => {
		const plan = planPass({ pass: 2, lens: "file" });
		expect(nextInPass(plan, matrix())).toBeUndefined();
	});
});

describe("what a pass added", () => {
	it("counts rows by the pass that created them, treating an unstamped row as pass 1", () => {
		// The statistic research/06 could only reconstruct after the fact by diffing
		// two scored ledgers — by which time the session was over. An absent stamp
		// is pass 1, so a ledger written before passes existed still counts.
		const delta = passDelta(2, {
			findings: [finding({ id: "f1" }), finding({ id: "f2", pass: 2 })],
			hypotheses: [hypothesis({ id: "h1", pass: 2 }), hypothesis({ id: "h2", pass: 3 })],
			inventory: [endpoint()],
		});
		expect(delta).toEqual({ pass: 2, findings: 1, hypotheses: 1, surface: 0 });
		expect(passDelta(1, { findings: [finding({ id: "f1" })] }).findings).toBe(1);
	});
});

describe("what the agent is told", () => {
	it("says nothing at all on pass 1", () => {
		// A block that renders every turn to say "pass 1 of 4" is how a block stops
		// being read, which is the argument ADR-016 already made against nudging
		// about cleared cells.
		const state = passState(["route", "file"], 1);
		expect(state).toBeDefined();
		expect(renderPassBrief(state!, planPass({ pass: 1, lens: "route", matrix: matrix() }))).toBe("");
	});

	it("separates the facts that carry forward from the verdicts that do not", () => {
		// The distinction is the entire feature. Without it a second pass re-reads a
		// full ledger, inherits its conclusions and stops.
		const state = passState(["route", "adversarial"], 2)!;
		const brief = renderPassBrief(state, planPass({
			pass: 2, lens: "adversarial", findings: [finding({ status: "suspected" })],
		}));
		expect(brief).toContain("Pass 2");
		expect(brief).toContain("facts stand");
		expect(brief).toContain("re-open");
		expect(brief).toContain("f1");
	});

	it("still names the lens when it has nothing to reach, so an empty pass is legible", () => {
		const state = passState(["route", "file"], 2)!;
		const brief = renderPassBrief(state, planPass({ pass: 2, lens: "file" }));
		expect(brief).toContain("lens `file`");
		expect(brief).toContain("names no source files yet");
	});
});

describe("naming a lens out of order", () => {
	it("moves it to the open pass and keeps everything after it", () => {
		// It used to overwrite the rung, which silently dropped `file` from the
		// session for good: the operator asked to run one lens now and lost another
		// entirely, with nothing saying so.
		expect(promoteLens(["route", "file", "invariant", "adversarial"], 2, "adversarial"))
			.toEqual(["route", "adversarial", "file", "invariant"]);
	});

	it("changes nothing when the named lens is already that rung", () => {
		expect(promoteLens(["route", "file"], 2, "file")).toEqual(["route", "file"]);
	});

	it("pads a ladder shorter than the open pass with the rung it has been clamping to", () => {
		expect(promoteLens(["route"], 3, "file")).toEqual(["route", "route", "file"]);
	});
});

describe("the /pass command", () => {
	it("tells an operator how to turn passes on rather than pretending the command does not exist", () => {
		const view = passCommand({ arg: "" });
		expect(view.tone).toBe("warning");
		expect(view.text).toContain('"passes"');
		expect(view.text).toContain("PIRED_PASSES");
		expect(view.open).toBeUndefined();
	});

	it("reports where the ladder has got to, and what this pass has added", () => {
		const view = passCommand({
			state: passState(["route", "file"], 2),
			delta: { pass: 2, findings: 3, hypotheses: 40, surface: 1 },
		});
		expect(view.text).toContain("pass 2");
		expect(view.text).toContain("<- open");
		expect(view.text).toContain("3 finding(s)");
	});

	it("shows the lens's worklist in the status view, and its note when there is none", () => {
		const state = passState(["route", "adversarial"], 2);
		const withWork = passCommand({
			state,
			plan: planPass({ pass: 2, lens: "adversarial", findings: [finding({ id: "f9", status: "suspected" })] }),
		});
		expect(withWork.text).toContain("1 item(s) this lens can reach");
		expect(withWork.text).toContain("f9");

		const empty = passCommand({ state, plan: planPass({ pass: 2, lens: "adversarial" }) });
		expect(empty.text).toContain("Nothing is waiting");
	});

	it("never opens a pass on its own — only when the operator asked", () => {
		// Opening spends the operator's budget and touches the client's systems
		// again, which is why challenging was never made automatic either (ADR-014).
		expect(passCommand({ state: passState(["route", "file"], 1) }).open).toBeUndefined();
		expect(passCommand({ state: passState(["route", "file"], 1), arg: "status" }).open).toBeUndefined();
		expect(passCommand({ state: passState(["route", "file"], 1), arg: "next" }).open).toBe("file");
		expect(passCommand({ state: passState(["route", "file"], 1), arg: "invariant" }).open).toBe("invariant");
	});

	it("says what is still unverified when it opens a discovery pass, and does not refuse", () => {
		// A union of passes multiplies false positives as readily as findings, and
		// precision is the axis this harness is weakest on — 0.059 on the
		// application corpus against bare pi's 0.192. ADR-004 settled that this kind
		// of thing is surfaced rather than blocked, so the pass still opens.
		const view = passCommand({ state: passState(["route", "file"], 1), arg: "next", unchallenged: 4 });
		expect(view.open).toBe("file");
		expect(view.tone).toBe("info");
		expect(view.text).toContain("4 finding(s) have no settled verdict (examined-but-unsettled included)");
	});

	it("does not say it when the pass being opened is the one that settles them", () => {
		// Opening `adversarial` IS draining the queue. Saying "mind the queue" while
		// the operator opens the queue-draining lens is noise, and noise in a line
		// that only fires sometimes is how it stops being read.
		const view = passCommand({ state: passState(["route", "adversarial"], 1), arg: "next", unchallenged: 4 });
		expect(view.open).toBe("adversarial");
		expect(view.text).not.toContain("no settled verdict");
	});

	it("says the ladder is exhausted instead of silently repeating its last rung", () => {
		const view = passCommand({ state: passState(["route", "file"], 2), arg: "next" });
		expect(view.open).toBe("file");
		expect(view.text).toContain("ends at 2 rungs");
	});

	it("names the valid lenses when asked for one that does not exist", () => {
		const view = passCommand({ state: passState(["route"], 1), arg: "telepathy" });
		expect(view.tone).toBe("warning");
		expect(view.open).toBeUndefined();
		expect(view.text).toContain("credentialed");
	});
});

describe("reading invariants out of the target model", () => {
	it("takes the invariants section and stops at the next heading", () => {
		const model = "# model\n## invariants\n- one\n* two\n1. three\n## boundaries\n- not this";
		expect(parseInvariants(model)).toEqual(["one", "two", "three"]);
	});

	it("returns nothing for a model that has no such section, or no model at all", () => {
		expect(parseInvariants("## actors\n- admin")).toEqual([]);
		expect(parseInvariants(undefined)).toEqual([]);
	});
});
