/**
 * Why a run, or one of its workers, stopped (delegation v6 Phase 2, item 2.6).
 *
 * Validity says whether a run can be scored; it says nothing about why the
 * model stopped. In the v5 grids a run that ended by offering to do more and
 * a run that ended with its work done both read as valid and complete, so a
 * model that hands the turn back early looked like a model that found less.
 * This module names the stop so the two can be told apart. It is diagnostic
 * only: nothing here feeds `valid`, the comparison or the approval.
 *
 * Precedence, first match wins:
 *   1. error — the run failed on its own (provider error, crash, cut-off);
 *   2. budget — a time limit or token ceiling fired;
 *   3. turn-cap — a turn cap fired (pired's worker turn budget; a parent cap
 *      if a later harness adds one);
 *   4. the text test on the closing prose: offered-to-continue or finished.
 *
 * The text test is grammatical, not a phrase list: it asks whether the closing
 * sentence is a question, and whether a closing sentence offers the reader more
 * work by the writer; whether it addresses the reader and says the work is
 * incomplete are recorded as evidence. A list of one model's sign-off phrases
 * would be fitted to that model's transcripts and miss the next model's
 * wording; the grammar of an offer (a question to the reader, or a first-person
 * modal made conditional on the reader's wish) holds across wordings. The rule
 * was written against synthetic text only. English only for the offer: a
 * closing in another language that ends in "?" still reads as offered, through
 * the question alone, and one that does not reads as finished. A rhetorical
 * closing question ("What would an attacker gain here?") reads as offered.
 */

/** How a run or a worker stopped. */
export type StopOutcome = "error" | "budget" | "turn-cap" | "offered-to-continue" | "finished";

export interface StopClassification {
	outcome: StopOutcome;
	/** Why: the bound that fired, or which closing features fired. */
	evidence: string[];
}

/** What the classifier needs; every field is optional except the closing text. */
export interface StopInput {
	/** The run failed on its own terms; the string says how. */
	error?: string;
	/** The run's time limit fired. */
	timedOut?: boolean;
	/** A token ceiling fired. */
	tokenCeiling?: boolean;
	/** A turn cap fired; the string says which. */
	turnCap?: string;
	/** The prose of the last reply. */
	finalText: string;
}

/** The grammatical features of the closing paragraph. */
export interface ClosingFeatures {
	/** The closing sentence ends in a question mark. */
	question: boolean;
	/** A closing sentence uses a second-person pronoun. Evidence only: "your team should rotate the keys" addresses the reader without handing anything back. */
	readerAddress: boolean;
	/**
	 * A closing sentence offers the reader more work by the writer: a first-person
	 * question ("shall I"), the reader's wish about the writer's work ("would you
	 * like me to"), "let me know", or a conditional on the reader's wish joined to
	 * a first-person modal in the same sentence ("if you want, I can").
	 */
	offer: boolean;
	/** The closing paragraph says the work is not done. */
	incomplete: boolean;
}

/**
 * The prose a reader would take as the sign-off: code, quotations, list items,
 * tables and headings removed, then the last paragraph left. A question inside
 * a code block (a shell prompt, a regex) or a quoted request is not the writer
 * asking anything, and a findings list is content, not a closing.
 */
export function closingParagraph(text: string): string {
	// An unclosed fence runs to the end: a reply cut off inside a code block has no prose after it.
	let fence: string | undefined;
	const lines = text.split("\n").map((line) => {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			return "";
		}
		if (marker) { fence = marker; return ""; }
		if (/^\s*>/.test(line)) return "";
		if (/^\s*(?:[-*+•]|\d+[.)])\s/.test(line)) return "";
		if (/^\s*\|/.test(line)) return "";
		if (/^\s*#{1,6}\s/.test(line)) return "";
		if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) return "";
		return line
			.replace(/`[^`\n]*`/g, " ")
			.replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
	});
	const paragraphs = lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => /[A-Za-z]/.test(p));
	return paragraphs.at(-1) ?? "";
}

/** The sentences of a paragraph, with trailing emphasis and brackets trimmed from each. */
function sentences(paragraph: string): string[] {
	return paragraph.split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s)).map((s) => s.replace(/[\s*_)\]'’]+$/, ""));
}

/**
 * How many sentences at the end count as the sign-off. Two, so an offer
 * followed by a courtesy ("If you want, I can go on. Thanks.") is still read,
 * but not so many that a recommendation earlier in the paragraph is.
 */
const CLOSING_SENTENCES = 2;

const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves)\b/i;
/**
 * A first-person modal: "I can", "I'll", "I could". Not "I could not",
 * "I couldn't" or "I can't", which report, not offer. On its own it is not an
 * offer: "I would recommend you patch it" is advice, "I will now stop" an
 * announcement. It counts only joined to a conditional on the reader's wish.
 */
const FIRST_PERSON_MODAL = /\bI(?:\s+(?:can|could|would|will|shall)\b(?!\s+not\b|n?['’]t\b)|['’](?:ll|d)\b)/;
/** "shall I", "should we", "can I": a first-person question the writer puts to the reader, about what the writer does next. */
const INVERTED_FIRST_PERSON = /\b(?:shall|should|can|could|may)\s+(?:I|we)\b/i;
/** "would you like me to", "do you want us to", "want me to": the reader's wish about the writer's next work. */
const READER_WISH_FOR_WRITER = /\b(?:(?:would|do|should)\s+you\s+(?:\w+\s+)?)?(?:want|like|wish|prefer)\s+(?:me|us)\s+to\b/i;
/** "let me know", "let us know": an imperative that hands the next move to the reader. */
const HAND_BACK = /\blet\s+(?:me|us)\s+know\b/i;
/**
 * "if you want", "should you prefer": a conditional on the reader's wish. An
 * offer only in the same sentence as a first-person modal; "if you need the raw
 * requests, they are in evidence/" is a pointer, not an offer.
 */
const READER_CONDITIONAL = /\b(?:if\s+you|should\s+you)\s+(?:\w+\s+)?(?:want|like|wish|prefer|need)\b/i;
/**
 * Words that say work is unfinished. Generic English, not any model's sign-off;
 * it is evidence only and never decides the outcome on its own, because a
 * finished report can say "no further issues remain".
 */
const INCOMPLETE = /\b(?:not\s+yet|remain(?:s|ing)?|still\s+(?:need|open|to|untested|unverified|pending)|unfinished|incomplete|pending|outstanding|untested|unverified|next\s+steps?|did\s+not\s+(?:finish|complete|get\s+to)|didn['’]t\s+(?:finish|complete|get\s+to)|ran\s+out\s+of)\b/i;

/** Whether one sentence offers the reader more work by the writer. */
function offersMoreWork(sentence: string): boolean {
	if (INVERTED_FIRST_PERSON.test(sentence) && sentence.endsWith("?")) return true;
	if (READER_WISH_FOR_WRITER.test(sentence) || HAND_BACK.test(sentence)) return true;
	return READER_CONDITIONAL.test(sentence) && FIRST_PERSON_MODAL.test(sentence);
}

export function closingFeatures(paragraph: string): ClosingFeatures {
	const closing = sentences(paragraph).slice(-CLOSING_SENTENCES);
	return {
		question: (closing.at(-1) ?? "").endsWith("?"),
		readerAddress: closing.some((s) => SECOND_PERSON.test(s)),
		offer: closing.some(offersMoreWork),
		incomplete: INCOMPLETE.test(paragraph),
	};
}

const FEATURE_NAMES: Array<[keyof ClosingFeatures, string]> = [
	["question", "closing-question"], ["readerAddress", "reader-address"], ["offer", "first-person-offer"], ["incomplete", "states-incomplete"],
];

export function classifyStop(input: StopInput): StopClassification {
	if (input.error) return { outcome: "error", evidence: [input.error] };
	if (input.timedOut || input.tokenCeiling) {
		return { outcome: "budget", evidence: [...(input.timedOut ? ["time limit"] : []), ...(input.tokenCeiling ? ["token ceiling"] : [])] };
	}
	if (input.turnCap) return { outcome: "turn-cap", evidence: [input.turnCap] };
	const paragraph = closingParagraph(input.finalText);
	if (!paragraph) return { outcome: "finished", evidence: ["no prose closing"] };
	const features = closingFeatures(paragraph);
	const fired = FEATURE_NAMES.filter(([key]) => features[key]).map(([, name]) => name);
	// The offer is aimed at the reader by construction, so it needs no separate
	// "you": a bare "you" plus a bare "I would" was advice ("I would recommend you
	// patch it") far more often than a hand-back.
	const offered = features.question || features.offer;
	return { outcome: offered ? "offered-to-continue" : "finished", evidence: fired };
}

/**
 * The ledger's own view of whether work was left, read beside the text test and
 * never merged into it: a run can offer to continue with nothing open, or sign
 * off as finished with hypotheses nobody tested. Disagreement between the two is
 * the thing to look at, so both are kept.
 *
 * `surfaceCells` is the inventory's size, not the unsettled cells: the
 * telemetry carries no per-cell status, and computing one would re-read the
 * ledger here. The harness passes no telemetry when the engagement directory
 * is absent, so that case is null; a ledger that exists but fails to read still
 * comes back from engagementTelemetry as zeros and reads as nothing open.
 */
export interface LedgerCrossCheck {
	surfaceCells: number;
	hypotheses: number;
	settledHypotheses: number;
	openHypotheses: number;
}

export function ledgerCrossCheck(telemetry: unknown): LedgerCrossCheck | null {
	if (!telemetry || typeof telemetry !== "object") return null;
	const t = telemetry as Record<string, unknown>;
	const n = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
	const surface = n(t.surface), hypotheses = n(t.hypotheses), settled = n(t.settled);
	if (surface === null || hypotheses === null || settled === null) return null;
	return { surfaceCells: surface, hypotheses, settledHypotheses: settled, openHypotheses: Math.max(0, hypotheses - settled) };
}

/** What the harness knows about the parent's end, gathered from the run. */
export interface ParentStopFacts {
	launchError?: string;
	process: { exitCode: number | null; signal?: string | null; timedOut: boolean } | null;
	stoppedByRunner: boolean;
	/** The last assistant reply, if any. */
	lastReply?: { stopReason?: unknown; text: string };
	tokenCeiling?: boolean;
	turnCap?: string;
}

/**
 * The parent's stop. A run the time limit killed exits on a signal and its last
 * reply may be `aborted`; that is the budget, not an error, so the kill it
 * causes is not read as a failure. A run the operator interrupted did not end
 * on its own either; it is recorded as an error with that reason, since no
 * outcome here describes it better and none of the others may claim it.
 */
export function parentStopInput(facts: ParentStopFacts): StopInput {
	const text = facts.lastReply?.text ?? "";
	const timedOut = facts.process?.timedOut === true;
	const base = { finalText: text, ...(facts.tokenCeiling ? { tokenCeiling: true } : {}), ...(facts.turnCap ? { turnCap: facts.turnCap } : {}) };
	if (facts.launchError) return { ...base, error: facts.launchError };
	if (!facts.process) return { ...base, error: "not launched" };
	if (timedOut) return { ...base, timedOut: true };
	if (facts.stoppedByRunner) return { ...base, error: "interrupted by the runner" };
	if (facts.process.exitCode !== 0) return { ...base, error: `process exited ${facts.process.exitCode ?? "without a code"}${facts.process.signal ? ` (${facts.process.signal})` : ""}` };
	const stop = facts.lastReply?.stopReason;
	if (!facts.lastReply) return { ...base, error: "no assistant reply" };
	if (stop !== "stop") return { ...base, error: `last reply ended ${typeof stop === "string" ? stop : "without a stopReason"}` };
	return base;
}

/** What the harness knows about one worker's end: pi-subagents' row and its session. */
export interface WorkerStopFacts {
	childKey: string;
	agent: string;
	/** pi-subagents' status (ChildStatus). */
	status: string;
	/** How the session ended (ChildEnding); undefined when no session was found. */
	ending?: string;
	/** The last reply's stopReason; `length` also ends as a `handoff`. */
	finalStop?: string;
	finalText?: string;
	/** Structural or provider errors anywhere in the session. Recorded, not decisive. */
	sessionErrors: number;
}

/**
 * A worker's stop, judged on how its session ended, the way the parent is judged
 * on its last reply.
 *
 * - pired's turn budget shows as a `budget-stop` ending, and is read before
 *   pi-subagents' `timed-out` status: that timeout can fire in the moments
 *   between pired's stop and pi-subagents settling the child (childOutcome), so
 *   the status alone would name the time limit when the turn cap is what fired.
 * - A last reply that ended `length` is an error for a worker as for the parent:
 *   a reply cut off by the output limit has no sign-off to read.
 * - An error earlier in the session that pi retried, after which the worker
 *   handed off cleanly, does not make the worker an error; the parent is not
 *   judged on its earlier replies either. The count is kept beside the outcome.
 * - A clean handoff gets the text test, which is where a worker that asks the
 *   parent for leave to continue shows up.
 */
export function workerStopInput(facts: WorkerStopFacts): StopInput {
	const finalText = facts.finalText ?? "";
	if (facts.ending === undefined) return { finalText, error: "no session" };
	if (facts.ending === "budget-stop") return { finalText, turnCap: "pired's worker turn budget" };
	if (facts.status === "timed-out") return { finalText, timedOut: true };
	if (facts.ending !== "handoff") return { finalText, error: `session ended ${facts.ending}` };
	if (facts.finalStop === "length") return { finalText, error: "last reply ended length" };
	if (facts.status !== "completed") return { finalText, error: `pi-subagents reports it ${facts.status}` };
	return { finalText };
}

export interface WorkerStop extends StopClassification {
	childKey: string;
	agent: string;
	sessionErrors: number;
}

export interface RunStop extends StopClassification {
	crossCheck: LedgerCrossCheck | null;
	workers: WorkerStop[];
}

export function classifyRunStop(parent: ParentStopFacts, telemetry: unknown, workers: WorkerStopFacts[]): RunStop {
	return {
		...classifyStop(parentStopInput(parent)),
		crossCheck: ledgerCrossCheck(telemetry),
		workers: workers.map((w) => ({ childKey: w.childKey, agent: w.agent, ...classifyStop(workerStopInput(w)), sessionErrors: w.sessionErrors })),
	};
}

export type StopCounts = Record<StopOutcome, number>;

export interface StopCountsByArm {
	/** Runs per arm by stop outcome. Rows written before this field existed are counted under `unclassified`. */
	runs: Record<string, StopCounts & { unclassified: number }>;
	/** Candidate workers by stop outcome. */
	workers: StopCounts;
}

/**
 * A run whose text says finished while its ledger still holds open hypotheses:
 * the disagreement to inspect. Listed, not counted per arm, because the count is
 * not comparable between arms: since ADR-028 the candidate keeps a worker's open
 * lead open by design, so it shows more of these when both arms behave alike.
 */
export interface FinishedWithOpen {
	arm: string;
	key: string;
	openHypotheses: number;
}

export interface StopSummary extends StopCountsByArm {
	/**
	 * The same counts over valid runs only: the runs the comparison scores. The
	 * top-level counts include invalid and infrastructure-failed runs, so an arm
	 * with more infrastructure failures shows more `error` rows there.
	 */
	valid: StopCountsByArm;
	finishedWithOpenHypotheses: FinishedWithOpen[];
}

const zero = (): StopCounts => ({ error: 0, budget: 0, "turn-cap": 0, "offered-to-continue": 0, finished: 0 });

export interface StopRow {
	arm: string;
	key: string;
	valid: boolean;
	stop?: unknown;
}

const isStop = (stop: unknown): stop is RunStop => !!stop && typeof stop === "object" && (stop as RunStop).outcome in zero();

function countStops(rows: StopRow[]): StopCountsByArm {
	const runs: StopSummary["runs"] = {};
	const workers = zero();
	for (const row of rows) {
		const arm = (runs[row.arm] ??= { ...zero(), unclassified: 0 });
		if (!isStop(row.stop)) { arm.unclassified++; continue; }
		arm[row.stop.outcome]++;
		for (const w of Array.isArray(row.stop.workers) ? row.stop.workers : []) if (w.outcome in workers) workers[w.outcome]++;
	}
	return { runs, workers };
}

export function summarizeStops(rows: StopRow[]): StopSummary {
	return {
		...countStops(rows),
		valid: countStops(rows.filter((r) => r.valid)),
		finishedWithOpenHypotheses: rows.flatMap((r) => isStop(r.stop) && r.stop.outcome === "finished" && (r.stop.crossCheck?.openHypotheses ?? 0) > 0
			? [{ arm: r.arm, key: r.key, openHypotheses: r.stop.crossCheck!.openHypotheses }] : []),
	};
}
