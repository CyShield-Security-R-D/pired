import { describe, expect, it } from "vitest";
import {
	classifyRunStop, classifyStop, closingFeatures, closingParagraph, ledgerCrossCheck, parentStopInput, summarizeStops, workerStopInput,
	type ParentStopFacts, type WorkerStopFacts,
} from "./delegation-compare-stop.ts";

/*
 * Every closing below is written for this file. None is taken from a benchmark
 * transcript: a rule tuned on the corpus's sign-offs would learn those models'
 * wording and not the grammar of an offer, and would miss the next model.
 */
const cleanExit = (extra: Partial<ParentStopFacts> = {}): ParentStopFacts => ({
	process: { exitCode: 0, signal: null, timedOut: false }, stoppedByRunner: false,
	lastReply: { stopReason: "stop", text: "The review is complete. Four findings are recorded in the ledger." }, ...extra,
});
const worker = (extra: Partial<WorkerStopFacts> = {}): WorkerStopFacts => ({
	childKey: "run-a/run-0", agent: "pired-investigate", status: "completed", ending: "handoff",
	finalText: "Recorded one confirmed finding at the upload handler.", sessionErrors: 0, ...extra,
});

describe("classifyStop precedence", () => {
	it("labels a time-limit stop as budget", () => {
		// The runner kills a timed-out run, so it exits on a signal with an aborted last
		// reply; read as an error, every time-limited run would look like a crash.
		const input = parentStopInput(cleanExit({ process: { exitCode: null, signal: "SIGTERM", timedOut: true }, lastReply: { stopReason: "aborted", text: "" } }));
		expect(classifyStop(input)).toEqual({ outcome: "budget", evidence: ["time limit"] });
	});

	it("labels a worker stopped by pired's turn budget as turn cap", () => {
		const out = classifyStop(workerStopInput(worker({ ending: "budget-stop", status: "failed", finalText: "" })));
		expect(out.outcome).toBe("turn-cap");
		expect(out.evidence).toEqual(["pired's worker turn budget"]);
	});

	it("puts an error ahead of the budget and the budget ahead of the turn cap", () => {
		expect(classifyStop({ error: "boom", timedOut: true, turnCap: "cap", finalText: "Shall I go on?" }).outcome).toBe("error");
		expect(classifyStop({ tokenCeiling: true, turnCap: "cap", finalText: "Shall I go on?" })).toEqual({ outcome: "budget", evidence: ["token ceiling"] });
		expect(classifyStop({ turnCap: "parent cap", finalText: "Shall I go on?" })).toEqual({ outcome: "turn-cap", evidence: ["parent cap"] });
	});
});

describe("the closing text test", () => {
	it("labels a closing question to the reader as offered to continue", () => {
		const out = classifyStop({ finalText: "I mapped the login flow and recorded two findings.\n\nDo you want me to keep testing the admin routes?" });
		expect(out.outcome).toBe("offered-to-continue");
		expect(out.evidence).toEqual(["closing-question", "reader-address", "first-person-offer"]);
	});

	it("ignores a question inside a code block", () => {
		const text = "Recorded the injection at the search handler.\n\n```sh\nread -p 'Continue?' answer\n```";
		expect(classifyStop({ finalText: text })).toEqual({ outcome: "finished", evidence: [] });
	});

	it("labels a declarative closing summary as finished", () => {
		const text = "## Summary\n\n- SQL injection in the search endpoint\n- Stored XSS in comments\n\nAll surface cells are settled and every finding is recorded with its evidence.";
		expect(classifyStop({ finalText: text })).toEqual({ outcome: "finished", evidence: [] });
	});

	it("labels an offer addressed to the reader without a question mark as offered to continue", () => {
		// A statement can hand the turn back as well as a question: "you" plus a first-person offer.
		const out = classifyStop({ finalText: "Two hypotheses are still open. If you want, I can continue with the payment module." });
		expect(out.outcome).toBe("offered-to-continue");
		expect(out.evidence).toEqual(["reader-address", "first-person-offer", "states-incomplete"]);
	});

	it("keeps an admission of unfinished work without an offer as finished, with the admission as evidence", () => {
		// Incompleteness alone does not hand the turn back; the cross-check carries it instead.
		expect(classifyStop({ finalText: "The export endpoint remains untested." })).toEqual({ outcome: "finished", evidence: ["states-incomplete"] });
	});

	it("does not read a first-person report of a failure as an offer", () => {
		// "can't" slipped past a guard written for "couldn't": after "can" the text is "'t", not "n't".
		expect(closingFeatures("I could not reach the admin panel, and I couldn't log in.").offer).toBe(false);
		expect(closingFeatures("If you want the admin panel covered, I can't reach it from the sandbox.").offer).toBe(false);
		const cant = classifyStop({ finalText: "I can't reach the admin panel from the sandbox, so you will need to verify it manually." });
		expect(cant).toEqual({ outcome: "finished", evidence: ["reader-address"] });
	});

	it("reads an offer of more work aimed at the reader as an offer, in any of its grammatical shapes", () => {
		expect(closingFeatures("Shall we look at the payment flow next?").offer).toBe(true);
		expect(closingFeatures("Let me know which module matters most.").offer).toBe(true);
		expect(closingFeatures("Happy to go further; would you like me to test the refund path.").offer).toBe(true);
		expect(closingFeatures("Should you prefer, I could also write a proof of concept.").offer).toBe(true);
		expect(classifyStop({ finalText: "Let me know which module matters most." }).outcome).toBe("offered-to-continue");
	});

	it("does not read a recommendation to the reader as an offer to continue", () => {
		// A bare "I would" beside a "you" anywhere in the paragraph read the usual
		// closing of a security report as an offer.
		for (const text of [
			"I would recommend you patch the upload handler first.",
			"I'd prioritise the SQL injection; your team should rotate the database credentials.",
			"I may have missed issues in the payment module, which your developers should review.",
			"I will now stop. You have the full ledger.",
			"I'll wait for direction.",
		]) expect(classifyStop({ finalText: text }).outcome, text).toBe("finished");
	});

	it("does not read a conditional that points the reader at evidence as an offer", () => {
		for (const text of [
			"If you need the raw requests, they are in evidence/requests.txt.",
			"Should you need to reproduce it, run the curl command above. All findings are recorded.",
		]) expect(classifyStop({ finalText: text }).outcome, text).toBe("finished");
	});

	it("reads an offer only in the closing sentences, not a conditional earlier in the paragraph", () => {
		const text = "If you want, I can walk through the chain. The export endpoint was tested. The upload handler was tested. Every finding is recorded.";
		expect(classifyStop({ finalText: text }).outcome).toBe("finished");
	});

	it("labels a rhetorical closing question and a closing question in another language as offered: known false positives of the question feature", () => {
		expect(classifyStop({ finalText: "Done. What would an attacker gain here?" }).outcome).toBe("offered-to-continue");
		expect(classifyStop({ finalText: "Il reste deux hypothèses. Voulez-vous que je continue ?" }).outcome).toBe("offered-to-continue");
	});

	it("misses an offer written as a list item, because list items are stripped as findings: a known blind spot", () => {
		const text = "All done.\n\n**Next steps (optional):**\n\n- Want me to test the refund path?";
		expect(classifyStop({ finalText: text })).toEqual({ outcome: "finished", evidence: ["states-incomplete"] });
	});

	it("ignores a question inside a quotation, a list item or a table", () => {
		const text = "The login form says \"Forgot password?\" and leaks timing.\n\n> Is this exploitable?\n\n| q | a |\n|---|---|\n| why? | n/a |\n\n1. Could an attacker enumerate users?";
		expect(closingParagraph(text)).toBe("The login form says and leaks timing.");
		expect(classifyStop({ finalText: text }).outcome).toBe("finished");
	});

	it("reads a closing question wrapped in emphasis as a question", () => {
		expect(closingFeatures("Everything is recorded. **Should I continue?**").question).toBe(true);
	});

	it("treats a reply cut off inside an unclosed code block as having no prose closing after it", () => {
		expect(closingParagraph("Done.\n\n```\nwhat now?")).toBe("Done.");
		expect(classifyStop({ finalText: "```\nstill going?" })).toEqual({ outcome: "finished", evidence: ["no prose closing"] });
		expect(closingParagraph("~~~\na?\n~~~\nAfter the fence.")).toBe("After the fence.");
	});
});

describe("parentStopInput", () => {
	it("reads a clean stop as the text test's to decide", () => {
		expect(parentStopInput(cleanExit())).toEqual({ finalText: "The review is complete. Four findings are recorded in the ledger." });
	});

	it("reads every way the parent can fail on its own as an error, with how", () => {
		expect(parentStopInput(cleanExit({ launchError: "not launched: interrupted" })).error).toBe("not launched: interrupted");
		expect(parentStopInput(cleanExit({ process: null })).error).toBe("not launched");
		expect(parentStopInput(cleanExit({ stoppedByRunner: true })).error).toBe("interrupted by the runner");
		expect(parentStopInput(cleanExit({ process: { exitCode: 1, signal: null, timedOut: false } })).error).toBe("process exited 1");
		expect(parentStopInput(cleanExit({ process: { exitCode: null, signal: "SIGKILL", timedOut: false } })).error).toBe("process exited without a code (SIGKILL)");
		expect(parentStopInput(cleanExit({ lastReply: undefined })).error).toBe("no assistant reply");
		expect(parentStopInput(cleanExit({ lastReply: { stopReason: "error", text: "" } })).error).toBe("last reply ended error");
		expect(parentStopInput(cleanExit({ lastReply: { text: "" } })).error).toBe("last reply ended without a stopReason");
	});

	it("passes a token ceiling and a parent turn cap through when a later harness reports them", () => {
		expect(classifyStop(parentStopInput(cleanExit({ tokenCeiling: true }))).outcome).toBe("budget");
		expect(classifyStop(parentStopInput(cleanExit({ turnCap: "parent turn cap" }))).outcome).toBe("turn-cap");
	});

	it("labels a session the token ceiling cut as budget, though its last reply is the empty aborted one", () => {
		// Plan 2.5: the matched arm's ceiling aborts between requests, and pi writes
		// an `error` reply for the request it never sent. Read as the last reply, that
		// made every ceiling stop an error.
		const cutReply = { stopReason: "error", text: "" };
		expect(classifyStop(parentStopInput(cleanExit({ tokenCeiling: true, lastReply: cutReply })))).toEqual({ outcome: "budget", evidence: ["token ceiling"] });
		expect(classifyStop(parentStopInput(cleanExit({ lastReply: cutReply }))).outcome).toBe("error");
		// A crash is still a crash under a ceiling.
		expect(classifyStop(parentStopInput(cleanExit({ tokenCeiling: true, process: { exitCode: 1, signal: null, timedOut: false } }))).outcome).toBe("error");
	});
});

describe("workerStopInput", () => {
	it("labels a worker pi-subagents timed out as budget, ahead of its ending", () => {
		expect(classifyStop(workerStopInput(worker({ status: "timed-out", ending: "aborted-between-requests" }))).outcome).toBe("budget");
	});

	it("labels a worker whose session ends on pired's turn budget as turn cap even when pi-subagents then reports it timed out", () => {
		// The pi-subagents timeout can fire between pired's stop and the settle (childOutcome).
		expect(classifyStop(workerStopInput(worker({ status: "timed-out", ending: "budget-stop" }))).outcome).toBe("turn-cap");
	});

	it("labels a worker with no session, a cut-off, a length-limited reply or a failed row as an error", () => {
		expect(workerStopInput(worker({ ending: undefined })).error).toBe("no session");
		expect(workerStopInput(worker({ ending: "cut-off" })).error).toBe("session ended cut-off");
		expect(workerStopInput(worker({ finalStop: "length" })).error).toBe("last reply ended length");
		expect(workerStopInput(worker({ status: "failed" })).error).toBe("pi-subagents reports it failed");
	});

	it("judges a worker on how its session ended, not on an error pi retried before a clean handoff", () => {
		const stop = classifyRunStop(cleanExit(), undefined, [worker({ sessionErrors: 2 })]);
		expect(stop.workers[0]).toMatchObject({ outcome: "finished", sessionErrors: 2 });
	});

	it("runs the text test on a clean worker handoff", () => {
		expect(classifyStop(workerStopInput(worker({ finalText: undefined }))).outcome).toBe("finished");
		expect(classifyStop(workerStopInput(worker({ finalText: "Recorded one lead. Should I also test the refund path?" }))).outcome).toBe("offered-to-continue");
	});
});

describe("ledgerCrossCheck", () => {
	it("counts open hypotheses from the ledger telemetry beside the text test", () => {
		expect(ledgerCrossCheck({ surface: 12, hypotheses: 9, settled: 6, findings: 3 })).toEqual({ surfaceCells: 12, hypotheses: 9, settledHypotheses: 6, openHypotheses: 3 });
	});

	it("returns null when the run has no readable telemetry, rather than zeros that read as nothing open", () => {
		expect(ledgerCrossCheck(undefined)).toBeNull();
		expect(ledgerCrossCheck({ surface: 1, hypotheses: "x", settled: 0 })).toBeNull();
	});
});

describe("classifyRunStop and summarizeStops", () => {
	it("classifies the parent and each worker and keeps the cross-check beside them", () => {
		const stop = classifyRunStop(cleanExit(), { surface: 4, hypotheses: 3, settled: 1 }, [worker(), worker({ childKey: "run-a/run-1", ending: "budget-stop" })]);
		expect(stop.outcome).toBe("finished");
		expect(stop.crossCheck?.openHypotheses).toBe(2);
		expect(stop.workers.map((w) => [w.childKey, w.outcome])).toEqual([["run-a/run-0", "finished"], ["run-a/run-1", "turn-cap"]]);
	});

	it("counts outcomes per arm, workers apart, and rows written before the field existed as unclassified", () => {
		const offered = classifyRunStop(cleanExit({ lastReply: { stopReason: "stop", text: "Want me to go on?" } }), undefined, []);
		const finishedOpen = classifyRunStop(cleanExit(), { surface: 2, hypotheses: 2, settled: 0 }, [worker()]);
		const summary = summarizeStops([
			{ arm: "baseline", key: "t/p1", valid: true, stop: offered },
			{ arm: "baseline", key: "t/p2", valid: true },
			{ arm: "candidate", key: "t/p1", valid: true, stop: finishedOpen },
			{ arm: "candidate", key: "t/p2", valid: true, stop: { outcome: "not-an-outcome" } },
		]);
		expect(summary.runs.baseline).toMatchObject({ "offered-to-continue": 1, unclassified: 1, finished: 0 });
		expect(summary.runs.candidate).toMatchObject({ finished: 1, unclassified: 1 });
		expect(summary.workers.finished).toBe(1);
		// Listed, not rated per arm: ADR-028 keeps a worker's open lead open, which biases a per-arm count against the candidate.
		expect(summary.finishedWithOpenHypotheses).toEqual([{ arm: "candidate", key: "t/p1", openHypotheses: 2 }]);
	});

	it("counts valid runs apart, so the stop counts can refer to the runs the comparison scores", () => {
		const errored = classifyRunStop(cleanExit({ process: { exitCode: 1, signal: null, timedOut: false } }), undefined, []);
		const finished = classifyRunStop(cleanExit(), undefined, []);
		const summary = summarizeStops([
			{ arm: "candidate", key: "t/p1", valid: false, stop: errored },
			{ arm: "candidate", key: "t/p2", valid: true, stop: finished },
		]);
		expect(summary.runs.candidate).toMatchObject({ error: 1, finished: 1 });
		expect(summary.valid.runs.candidate).toMatchObject({ error: 0, finished: 1 });
	});
});
