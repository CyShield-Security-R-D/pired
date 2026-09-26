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
		expect(closingFeatures("I could not reach the admin panel, and I couldn't log in.").offer).toBe(false);
		expect(closingFeatures("I can extend this to the admin panel.").offer).toBe(true);
		expect(closingFeatures("Shall we look at the payment flow next?").offer).toBe(true);
		expect(closingFeatures("Let me know which module matters most.").offer).toBe(true);
		expect(closingFeatures("I'll wait for direction.").offer).toBe(true);
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
});

describe("workerStopInput", () => {
	it("labels a worker pi-subagents timed out as budget, ahead of its ending", () => {
		expect(classifyStop(workerStopInput(worker({ status: "timed-out", ending: "aborted-between-requests" }))).outcome).toBe("budget");
	});

	it("labels a worker with no session, session errors, a cut-off or a failed row as an error", () => {
		expect(workerStopInput(worker({ ending: undefined })).error).toBe("no session");
		expect(workerStopInput(worker({ sessionErrors: 2 })).error).toBe("2 session error(s)");
		expect(workerStopInput(worker({ ending: "cut-off" })).error).toBe("session ended cut-off");
		expect(workerStopInput(worker({ status: "failed" })).error).toBe("pi-subagents reports it failed");
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
			{ arm: "baseline", stop: offered },
			{ arm: "baseline" },
			{ arm: "candidate", stop: finishedOpen },
			{ arm: "candidate", stop: { outcome: "not-an-outcome" } },
		]);
		expect(summary.runs.baseline).toMatchObject({ "offered-to-continue": 1, unclassified: 1, finished: 0 });
		expect(summary.runs.candidate).toMatchObject({ finished: 1, unclassified: 1 });
		expect(summary.workers.finished).toBe(1);
		expect(summary.finishedWithOpenHypotheses).toEqual({ baseline: 0, candidate: 1 });
	});
});
