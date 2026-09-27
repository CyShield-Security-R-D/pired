import { describe, expect, it } from "vitest";
import { decideInfra } from "./delegation-compare.ts";
import { createBreaker, DEFAULT_BREAKER } from "./delegation-compare-lib.ts";
import { FAST_EMPTY_ERROR, judgeRun, limitError, runNumbers, VALIDITY_POLICY_TEXT, WORKER_IN_FLIGHT, type RunFacts } from "./delegation-compare-validity.ts";

// Per-file builders: the facts inspectRun hands the judge, and the grader's
// reading of a ledger. No shared fixtures, by house rule.
const LIMIT_MS = 14_400_000;
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({ timedOut: false, fastEmpty: false, errors: [], ...over });
/** What a 4 h run stopped by the runner leaves: the timeout, pi's SIGTERM exit, and a parent cut off mid-turn. */
const LIMIT_ERRORS = [
	limitError(LIMIT_MS),
	"process failed with exit=143 signal=none",
	"final assistant reply ended with toolUse, not stop",
	"parent did not finish with an assistant stopReason=stop",
];
/** A delegating run stopped while its subagent call was still out. */
const WORKER_ERRORS = ["subagent call call_9 never ended", "session file run-1/0.jsonl is claimed by no subagent call"];
const ledger = (truePositives: number, totalFindings: number) => ({ ok: true as const, truePositives, totalFindings, precision: totalFindings ? truePositives / totalFindings : 0 });

describe("without a validity policy", () => {
	// v5 grids and every grid before the option: byte-identical verdicts.
	it("keeps a limit-reaching run invalid with every error it had, and writes no flag", () => {
		const judged = judgeRun(facts({ timedOut: true, errors: LIMIT_ERRORS }));
		expect(judged).toEqual({ valid: false, errors: LIMIT_ERRORS, tokensCounted: true });
		expect("flags" in judged).toBe(false);
	});

	it("keeps a fast empty run invalid", () => {
		expect(judgeRun(facts({ fastEmpty: true, errors: [FAST_EMPTY_ERROR] }))).toEqual({ valid: false, errors: [FAST_EMPTY_ERROR], tokensCounted: true });
	});

	it("reads a clean run as valid and changes nothing", () => {
		expect(judgeRun(facts())).toEqual({ valid: true, errors: [], tokensCounted: true });
	});

	it("carries no token count for an invalid run, and the grader's numbers whatever the verdict, as inspectRun always wrote them", () => {
		const numbers = runNumbers(judgeRun(facts({ timedOut: true, errors: LIMIT_ERRORS })), ledger(3, 5), { valid: true, totalTokens: 9_000_000 }, 400);
		expect(numbers).toMatchObject({ truePositives: 3, totalClaims: 5, precision: 0.6 });
		expect(numbers.totalTokens).toBeNaN();
		expect(numbers.totalTokensWithRetryEstimate).toBeNaN();
	});
});

describe("the v6 validity policy", () => {
	// GPT-6 Luna reached the 2 h limit still working (the v5 held-out CasaOS run);
	// dropping such a run drops the arm that works longest.
	it("counts a run that reaches the run limit as valid, flags it, and keeps the stop's own errors as limit effects", () => {
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: LIMIT_ERRORS }));
		expect(judged.valid).toBe(true);
		expect(judged.errors).toEqual([]);
		expect(judged.flags).toEqual({ reachedLimit: true, fastEmpty: false, limitEffects: LIMIT_ERRORS });
		expect(judged.tokensCounted).toBe(true);
	});

	it("scores a limit-reaching run from its ledger at the deadline and counts the tokens metered up to it", () => {
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: LIMIT_ERRORS }));
		expect(runNumbers(judged, ledger(2, 4), { valid: true, totalTokens: 12_000_000 }, 500)).toEqual({
			truePositives: 2, totalClaims: 4, precision: 0.5, totalTokens: 12_000_000, totalTokensWithRetryEstimate: 12_000_500,
		});
	});

	// A worker cut off in flight has spend no tool result reports: counting the
	// rest would flatter the delegating arm on cost.
	it("withholds the tokens of a limit-reaching run whose worker was still running, but keeps it valid", () => {
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: [...LIMIT_ERRORS, ...WORKER_ERRORS] }));
		expect(judged.valid).toBe(true);
		expect(judged.flags!.limitEffects).toEqual([...LIMIT_ERRORS, ...WORKER_ERRORS, WORKER_IN_FLIGHT]);
		expect(judged.tokensCounted).toBe(false);
		expect(runNumbers(judged, ledger(1, 1), { valid: true, totalTokens: 5 }).totalTokens).toBeNaN();
	});

	// Luna ended about 40% of its v5 runs within five minutes: quitting early is behaviour under test.
	it("counts a fast empty run as valid with zero findings, flagged fastEmpty", () => {
		const judged = judgeRun(facts({ policy: "v6", fastEmpty: true, errors: [FAST_EMPTY_ERROR] }));
		expect(judged).toEqual({ valid: true, errors: [], tokensCounted: true, flags: { reachedLimit: false, fastEmpty: true, limitEffects: [] } });
		expect(runNumbers(judged, ledger(0, 0), { valid: true, totalTokens: 40_000 })).toMatchObject({ truePositives: 0, totalClaims: 0, totalTokens: 40_000 });
	});

	it("flags every run it judges, so a clean run reads reachedLimit false and fastEmpty false", () => {
		expect(judgeRun(facts({ policy: "v6" }))).toEqual({ valid: true, errors: [], tokensCounted: true, flags: { reachedLimit: false, fastEmpty: false, limitEffects: [] } });
	});

	// Harness integrity is not model behaviour: on an official grid these still
	// trip the breaker at once (ADR-031), because the run stays invalid.
	it("keeps a leak invalid even when the run also reached the limit", () => {
		const leak = "answer-key leak: CVE-2025-1234 in the target copy";
		const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors: [...LIMIT_ERRORS, leak] }));
		expect(judged.valid).toBe(false);
		expect(judged.errors).toEqual([leak]);
		expect(judged.flags!.reachedLimit).toBe(true);
	});

	// ADR-031: one non-infrastructure invalid run in an official grid trips the
	// breaker at once. Under v6 a leak still does; a limit-reaching run no longer does.
	it("still trips an official grid's breaker at once on a leak, and not on a run that reached the limit", () => {
		const breakerAfter = (errors: string[]) => {
			const judged = judgeRun(facts({ policy: "v6", timedOut: true, errors }));
			const infra = decideInfra({ valid: judged.valid, timedOut: true, stoppedByRunner: false, notLaunchedInterrupted: false, failures: { parent: [], workers: [], fetchErrors: [] } }).infra;
			const breaker = createBreaker({ ...DEFAULT_BREAKER });
			return breaker.record({ atMs: Number.NaN, valid: judged.valid, infra, exhausted: false, blocked: !judged.valid && !infra });
		};
		expect(breakerAfter([...LIMIT_ERRORS, "answer-key leak: CVE-2025-1234 in the target copy"])).toEqual({ tripped: true, reason: expect.stringMatching(/invalid for a non-infrastructure reason/) });
		expect(breakerAfter(LIMIT_ERRORS)).toEqual({ tripped: false });
	});

	it("keeps every harness-integrity error invalid: tool surface, runtime and pins, bookkeeping, the scorer, the launch", () => {
		const integrity = [
			"SDK runtime did not match the request: model gpt-6 is not gpt-6-luna",
			"external grader changed after preflight",
			"baseline arm made 2 subagent call(s)",
			"child run-1/0 (worker): replies came from openai/gpt-5, not openai-codex/gpt-6-luna",
			"provider usage attribution is incomplete",
			"3 malformed JSON event lines",
			"ledger/scorer inspection failed: ENOENT",
			"the cell's agent settings.json changed during the run",
			"a scored run emitted a probe report",
			"spawn pi ENOENT",
		];
		for (const error of integrity) {
			for (const timedOut of [false, true]) {
				const judged = judgeRun(facts({ policy: "v6", timedOut, errors: timedOut ? [...LIMIT_ERRORS, error] : [error] }));
				expect(judged.valid, error).toBe(false);
				expect(judged.errors, error).toEqual([error]);
			}
		}
	});

	// A run that did not reach the limit has no stop to blame its exit status on.
	it("keeps a failed exit or an unfinished parent invalid when the run did not reach the limit", () => {
		const judged = judgeRun(facts({ policy: "v6", errors: LIMIT_ERRORS.slice(1) }));
		expect(judged.valid).toBe(false);
		expect(judged.errors).toEqual(LIMIT_ERRORS.slice(1));
		expect(judged.flags!.limitEffects).toEqual([]);
	});

	it("does not waive the fast-empty text on a run that was not fast and empty", () => {
		expect(judgeRun(facts({ policy: "v6", errors: [FAST_EMPTY_ERROR] })).valid).toBe(false);
	});

	it("states the policy verbatim for the manifest, naming both flags and what stays invalid", () => {
		expect(VALIDITY_POLICY_TEXT.v6).toMatch(/reachedLimit:true/);
		expect(VALIDITY_POLICY_TEXT.v6).toMatch(/fastEmpty:true/);
		expect(VALIDITY_POLICY_TEXT.v6).toMatch(/trips the breaker at once/);
	});
});
