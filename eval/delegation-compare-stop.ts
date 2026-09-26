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
 * is a question, whether it addresses the reader, whether the writer offers or
 * conditions further work in the first person, and whether it says the work is
 * incomplete. A list of one model's sign-off phrases would be fitted to that
 * model's transcripts and miss the next model's wording; the grammar of an
 * offer (a question to the reader, or "you" plus a first-person modal) holds
 * across wordings. The rule was written against synthetic text only. English
 * only: a closing in another language reads as finished.
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
	/** The closing paragraph uses a second-person pronoun. */
	readerAddress: boolean;
	/** A first-person modal, an inverted first-person question, a first-person imperative ("let me"), or a conditional on the reader's wish. */
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

/** The last sentence of a paragraph, with trailing emphasis and brackets trimmed. */
function closingSentence(paragraph: string): string {
	const sentences = paragraph.split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s));
	return (sentences.at(-1) ?? "").replace(/[\s*_)\]'’]+$/, "");
}

const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves)\b/i;
/** "I can", "I'll", "I could" — not "I could not" or "I couldn't", which report, not offer. */
const FIRST_PERSON_MODAL = /\bI(?:\s+(?:can|could|would|will|shall|might|may)\b(?!\s+not\b|n['’]t)|['’](?:ll|d)\b)/;
/** "shall I", "should we", "can I" — a first-person question the writer puts to the reader. */
const INVERTED_FIRST_PERSON = /\b(?:shall|should|can|could|may)\s+(?:I|we)\b/i;
/** "let me", "let us", "let's" — a first-person imperative. */
const FIRST_PERSON_IMPERATIVE = /\blet(?:\s+(?:me|us)\b|['’]s\b)/i;
/** "if you want", "would you like": a conditional on, or a question about, the reader's wish. */
const READER_WISH = /\b(?:if\s+you|would\s+you|do\s+you|should\s+you)\s+(?:\w+\s+)?(?:want|like|wish|prefer|need)\b/i;
/**
 * Words that say work is unfinished. Generic English, not any model's sign-off;
 * it is evidence only and never decides the outcome on its own, because a
 * finished report can say "no further issues remain".
 */
const INCOMPLETE = /\b(?:not\s+yet|remain(?:s|ing)?|still\s+(?:need|open|to|untested|unverified|pending)|unfinished|incomplete|pending|outstanding|untested|unverified|next\s+steps?|did\s+not\s+(?:finish|complete|get\s+to)|didn['’]t\s+(?:finish|complete|get\s+to)|ran\s+out\s+of)\b/i;

export function closingFeatures(paragraph: string): ClosingFeatures {
	return {
		question: closingSentence(paragraph).endsWith("?"),
		readerAddress: SECOND_PERSON.test(paragraph),
		offer: FIRST_PERSON_MODAL.test(paragraph) || INVERTED_FIRST_PERSON.test(paragraph) || FIRST_PERSON_IMPERATIVE.test(paragraph) || READER_WISH.test(paragraph),
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
	const offered = features.question || (features.readerAddress && features.offer);
	return { outcome: offered ? "offered-to-continue" : "finished", evidence: fired };
}

/**
 * The ledger's own view of whether work was left, read beside the text test and
 * never merged into it: a run can offer to continue with nothing open, or sign
 * off as finished with hypotheses nobody tested. Disagreement between the two is
 * the thing to look at, so both are kept.
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
	finalText?: string;
	/** Structural or provider errors in the session. */
	sessionErrors: number;
}

/**
 * A worker's stop. pired's turn budget shows as a `budget-stop` ending; the
 * pi-subagents timeout as a `timed-out` status. A worker whose session ends
 * cleanly on a handoff gets the text test on its handoff, which is where a
 * worker that asks the parent for leave to continue shows up.
 */
export function workerStopInput(facts: WorkerStopFacts): StopInput {
	const finalText = facts.finalText ?? "";
	if (facts.ending === undefined) return { finalText, error: "no session" };
	if (facts.status === "timed-out") return { finalText, timedOut: true };
	if (facts.ending === "budget-stop") return { finalText, turnCap: "pired's worker turn budget" };
	if (facts.sessionErrors > 0) return { finalText, error: `${facts.sessionErrors} session error(s)` };
	if (facts.ending !== "handoff") return { finalText, error: `session ended ${facts.ending}` };
	if (facts.status !== "completed") return { finalText, error: `pi-subagents reports it ${facts.status}` };
	return { finalText };
}

export interface RunStop extends StopClassification {
	crossCheck: LedgerCrossCheck | null;
	workers: Array<StopClassification & { childKey: string; agent: string }>;
}

export function classifyRunStop(parent: ParentStopFacts, telemetry: unknown, workers: WorkerStopFacts[]): RunStop {
	return {
		...classifyStop(parentStopInput(parent)),
		crossCheck: ledgerCrossCheck(telemetry),
		workers: workers.map((w) => ({ childKey: w.childKey, agent: w.agent, ...classifyStop(workerStopInput(w)) })),
	};
}

export type StopCounts = Record<StopOutcome, number>;

export interface StopSummary {
	/** Runs per arm by stop outcome. Rows written before this field existed are counted under `unclassified`. */
	runs: Record<string, StopCounts & { unclassified: number }>;
	/** Candidate workers by stop outcome. */
	workers: StopCounts;
	/** Runs whose text says finished while the ledger still holds open hypotheses, per arm. */
	finishedWithOpenHypotheses: Record<string, number>;
}

const zero = (): StopCounts => ({ error: 0, budget: 0, "turn-cap": 0, "offered-to-continue": 0, finished: 0 });

export function summarizeStops(rows: Array<{ arm: string; stop?: unknown }>): StopSummary {
	const runs: StopSummary["runs"] = {};
	const workers = zero();
	const finishedWithOpenHypotheses: Record<string, number> = {};
	for (const row of rows) {
		const arm = (runs[row.arm] ??= { ...zero(), unclassified: 0 });
		finishedWithOpenHypotheses[row.arm] ??= 0;
		const stop = row.stop as RunStop | undefined;
		if (!stop || typeof stop !== "object" || !(stop.outcome in arm)) { arm.unclassified++; continue; }
		arm[stop.outcome]++;
		if (stop.outcome === "finished" && (stop.crossCheck?.openHypotheses ?? 0) > 0) finishedWithOpenHypotheses[row.arm]!++;
		for (const w of Array.isArray(stop.workers) ? stop.workers : []) if (w.outcome in workers) workers[w.outcome]++;
	}
	return { runs, workers, finishedWithOpenHypotheses };
}
