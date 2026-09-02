/**
 * Phase two: turn a finished review into ledger records.
 *
 * The agent is asked to review AND to call `record` as it goes, and it does the
 * first well and skips the second about half the time. Measured across five live
 * takes on the same prompt and model: 868 records, 0, 0, 868, 0. Told directly
 * to "record kind=finding with cwe, severity and file:line", it answered with a
 * well-formed findings list in prose — CWEs, severities, CVSS vectors — and no
 * tool call. The break is not in deciding what to record; it is in emitting the
 * call at all, deep inside a long conversation.
 *
 * So the two jobs are separated. Phase one reviews, in prose, uninterrupted.
 * Phase two — the scribe, to an operator — is a fresh, single-turn call whose
 * only job is to convert that prose into rows: the regime where a small model is
 * reliable, and where the output is plain JSON rather than a tool call, so there
 * is no call left to skip.
 *
 * Phase two is itself two questions with different costs, and `rollCall` splits
 * them. "What did this new prose find?" is a handful of rows and is asked often;
 * "what does the review conclude about each of the nineteen checklist classes?"
 * is a form to fill in, is mostly answered "not-considered" until the review has
 * been somewhere, and is asked when an operator asks for it. Emitting both every
 * time was most of the tokens and most of the wait.
 *
 * Pure module: builds a request and parses a reply. The model call and the
 * ledger writes belong to the adapter.
 */

import type { Severity } from "./ontology.ts";

/** What the extractor is asked to produce. Deliberately small. */
export interface ExtractedFinding {
	title: string;
	severity: Severity;
	/** Checklist class id. Validated against the engagement's checklist by the caller. */
	class?: string;
	cwe?: string;
	/** Where the bug is. `file` plus `line` is what the report and the grader need. */
	file?: string;
	line?: number;
	description?: string;
	/**
	 * Transcribed, never composed.
	 *
	 * A client's report needs what a flaw costs them and what fixes it, and a
	 * review usually says neither — it says what is broken and where. This pass
	 * reads prose, has no evidence files and no client context, so asking it to
	 * supply the missing half would be asking it to invent the two claims that do
	 * the most damage when invented: a fabricated record count is a lie to a
	 * client, and a fabricated fix is advice about a codebase nobody read.
	 *
	 * So these carry across only when the review states them outright, and the
	 * writing pass (skills/ops-technical-writer) authors the rest, working from
	 * the finding and its evidence rather than from a paragraph.
	 */
	impact?: string;
	remediation?: string;
}

export interface ExtractedElement {
	kind: "endpoint" | "host" | "param" | "tech" | "service";
	/** "POST /api/login", "backend/auth.py", "nginx" — a label, not an id. */
	label: string;
}

export interface ExtractedHypothesis {
	statement: string;
	class: string;
	/** The element label this was tested against; resolved to an id by the caller. */
	target: string;
	outcome: "confirmed" | "refuted" | "inconclusive";
}

/**
 * A verdict on one checklist class across the reviewed surface.
 *
 * Asking for "hypotheses, including the ones you ruled out" returned none on the
 * first live run: a free-form list of absences is not a thing a model volunteers.
 * Enumerating the checklist and asking for a verdict per class is a different
 * question — a form to fill in rather than a memory to search — and absence is
 * the answer to a question nobody was asking.
 *
 * `not-considered` is a first-class answer. A class the review never touched must
 * stay an untested cell; inferring "clean" from silence is how a coverage number
 * becomes a lie.
 */
export interface ClassVerdict {
	class: string;
	verdict: "confirmed" | "refuted" | "not-considered";
	/** The reasoning, which becomes the recorded hypothesis statement. */
	why?: string;
	/** Specific elements. Empty on a refutation means "across the reviewed surface". */
	targets: string[];
}

export interface Extraction {
	surface: ExtractedElement[];
	findings: ExtractedFinding[];
	hypotheses: ExtractedHypothesis[];
	classes: ClassVerdict[];
}

export interface ParseResult {
	extraction: Extraction;
	/** Rows dropped, and why. Surfaced to the operator rather than swallowed. */
	errors: string[];
	/**
	 * Whether a JSON object was found and read at all.
	 *
	 * Distinct from an empty extraction, and the distinction decides whether a
	 * retry is worth a second call: a reply that came back as prose has not done
	 * the job, while `{"findings": []}` has — it is a model correctly saying the
	 * new review concluded nothing. Counting the second as a failure is how the
	 * cheap pass would pay double for its most common answer.
	 */
	parsed: boolean;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const KINDS: ExtractedElement["kind"][] = ["endpoint", "host", "param", "tech", "service"];
const OUTCOMES: ExtractedHypothesis["outcome"][] = ["confirmed", "refuted", "inconclusive"];
const VERDICTS: ClassVerdict["verdict"][] = ["confirmed", "refuted", "not-considered"];

/**
 * Which classes the roll-call still has a question to ask about.
 *
 * The roll-call is the expensive half of the pass: one JSON row per checklist
 * class, every time, whether or not the answer can still change anything. A
 * class whose every applicable cell is already settled — clear, vulnerable, or
 * not a question at all — has no answer left to give, and asking for one buys
 * a row the planner will discard.
 *
 * A class with no cells at all stays in: nothing has been recorded against it,
 * which is the case the roll-call exists for. Fails open for the same reason
 * `applies()` does — a filter that can only shrink the question set must never
 * shrink it on a guess.
 */
export function rollCallClasses(classes: string[], cells: Array<{ class: string; status: string }>): string[] {
	const open = new Set<string>();
	const seen = new Set<string>();
	for (const c of cells) {
		seen.add(c.class);
		if (c.status === "not-tested" || c.status === "testing" || c.status === "blocked") open.add(c.class);
	}
	return classes.filter((c) => !seen.has(c) || open.has(c));
}

export interface ExtractionPromptOptions {
	/**
	 * The classes to ask for a verdict on.
	 *
	 * Omitted, the roll-call covers every class — what an operator asking for a
	 * sweep means. A subset skips the ones already settled. An EMPTY array drops
	 * the roll-call entirely, which is the cheap pass: findings and surface out
	 * of new prose, and no per-class form to fill in.
	 *
	 * The split exists because the two halves have different costs and different
	 * rhythms. Findings arrive as the review writes them and are a handful of
	 * rows; the roll-call is nineteen rows of mostly "not-considered" that only
	 * becomes answerable once the review has actually been somewhere. Emitting
	 * it every pass is most of the tokens for most of the wait.
	 */
	rollCall?: string[];
}

/**
 * The extractor's instructions.
 *
 * It is told it is NOT reviewing. Given any latitude to analyse, a model that
 * has just spent twenty minutes analysing will keep going, and the run ends in
 * more prose — which is the failure this exists to end.
 */
export function extractionSystemPrompt(classes: string[], options: ExtractionPromptOptions = {}): string {
	const roster = options.rollCall ?? classes;
	const list = classes.length > 0 ? classes.join(", ") : "(no checklist loaded — omit the class field)";
	const roll = roster.map((c) => `  {"class": "${c}", "verdict": "confirmed|refuted|not-considered", "why": "...", "targets": []}`).join(",\n");
	const classesField = roster.length > 0 ? `,\n  "classes": [\n${roll}\n  ]` : "";
	const rollRules = roster.length > 0
		? `

The "classes" array is a checklist and you must return EVERY row above, in order, with no rows added or removed. For each one, say what the review concluded:
- "confirmed" — the review found this class present. List the places in "targets".
- "refuted" — the review examined this class and found it clean. Put the reason in "why" ("no template rendering of user input anywhere in the reviewed code"). Leave "targets" empty if it applies across everything reviewed.
- "not-considered" — the review did not examine this class. This is a normal, correct answer and you must use it rather than guessing. Never mark a class "refuted" because the review did not mention it; silence is not a clean bill of health.`
		: `

Coverage is not being asked for in this pass: return no "classes" array. If the review examined a class and found it clean, say nothing about it here — a later pass asks that question directly. An empty "findings" array is a correct and expected answer when the review has not concluded anything new.`;
	return `You convert a finished security review into structured data. You are NOT reviewing anything: the analysis is complete and correct as written. Do not add findings, do not re-judge severity, do not investigate further. Transcribe what the review already concluded.

Reply with ONE JSON object and nothing else — no prose before or after, no markdown fence:

{
  "surface":  [{"kind": "endpoint|host|param|tech|service", "label": "POST /api/login"}],
  "findings": [{"title": "...", "severity": "critical|high|medium|low|info", "class": "<id>", "cwe": "CWE-89", "file": "backend/routes/auth.py", "line": 42, "description": "one or two sentences", "impact": "only if the review states it", "remediation": "only if the review states it"}]${classesField}
}${rollRules}

Other rules:
- "class" on a finding must be one of exactly these ids: ${list}
- "target" and "label" are the review's own words for the thing (a route, a file, a host) — not an id.
- "file" and "line" must come from the review. Never guess a line number; omit the field instead.
- "impact" and "remediation" are COPIED, never composed. Most reviews state neither, and omitting them is the correct and expected answer — a later pass writes them from the evidence. Include "impact" only if the review itself says what the flaw costs (records exposed, money, downtime, an obligation breached), and "remediation" only if the review itself names the fix. If you are summarising rather than quoting the review's own conclusion, leave the field out.
- Invent nothing. Every row must be traceable to something the review actually says.`;
}

/** The review text, as the extractor's single user message. */
export function extractionUserMessage(review: string): string {
	return `Here is the completed security review. Convert it to the JSON object described.\n\n---\n${review}\n---`;
}

/**
 * Pull the JSON object out of a reply and validate each row.
 *
 * Tolerant about the wrapper — a fence, a preamble, a trailing sentence — and
 * strict about the contents: a row missing a required field is dropped with a
 * reason rather than written half-formed. A silently mangled finding is worse
 * than a missing one, because it reaches a client's report.
 */
export function parseExtraction(reply: string): ParseResult {
	const errors: string[] = [];
	const empty: Extraction = { surface: [], findings: [], hypotheses: [], classes: [] };

	const raw = sliceJsonObject(reply);
	if (!raw) return { extraction: empty, errors: ["no JSON object found in the reply"], parsed: false };

	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return { extraction: empty, errors: [`reply was not valid JSON: ${e instanceof Error ? e.message : String(e)}`], parsed: false };
	}
	if (typeof doc !== "object" || doc === null) return { extraction: empty, errors: ["reply was not a JSON object"], parsed: false };
	const obj = doc as Record<string, unknown>;

	const surface: ExtractedElement[] = [];
	for (const [i, row] of arr(obj.surface).entries()) {
		const label = str(row.label) ?? str(row.value) ?? str(row.path);
		const kind = KINDS.find((k) => k === str(row.kind));
		if (!label) { errors.push(`surface[${i}]: no label`); continue; }
		surface.push({ kind: kind ?? "endpoint", label });
	}

	const findings: ExtractedFinding[] = [];
	for (const [i, row] of arr(obj.findings).entries()) {
		const title = str(row.title);
		if (!title) { errors.push(`findings[${i}]: no title`); continue; }
		const severity = SEVERITIES.find((s) => s === str(row.severity)?.toLowerCase());
		if (!severity) { errors.push(`findings[${i}] "${title}": severity missing or not one of ${SEVERITIES.join("/")}`); continue; }
		const line = num(row.line);
		findings.push({
			title, severity,
			class: str(row.class),
			cwe: str(row.cwe),
			file: str(row.file),
			// A line without a file locates nothing, and a file without a line is
			// still worth having — the grader matches on both, the report on either.
			line: line !== undefined && str(row.file) ? line : undefined,
			description: str(row.description),
			impact: str(row.impact),
			remediation: str(row.remediation),
		});
	}

	const hypotheses: ExtractedHypothesis[] = [];
	for (const [i, row] of arr(obj.hypotheses).entries()) {
		const statement = str(row.statement);
		const cls = str(row.class);
		const target = str(row.target);
		const outcome = OUTCOMES.find((o) => o === str(row.outcome)?.toLowerCase());
		if (!statement) { errors.push(`hypotheses[${i}]: no statement`); continue; }
		if (!cls) { errors.push(`hypotheses[${i}]: no class`); continue; }
		if (!target) { errors.push(`hypotheses[${i}]: no target`); continue; }
		if (!outcome) { errors.push(`hypotheses[${i}]: outcome missing or not confirmed/refuted/inconclusive`); continue; }
		hypotheses.push({ statement, class: cls, target, outcome });
	}

	const verdicts: ClassVerdict[] = [];
	for (const [i, row] of arr(obj.classes).entries()) {
		const cls = str(row.class);
		const verdict = VERDICTS.find((v) => v === str(row.verdict)?.toLowerCase());
		if (!cls) { errors.push(`classes[${i}]: no class id`); continue; }
		if (!verdict) { errors.push(`classes[${i}] "${cls}": verdict missing or not confirmed/refuted/not-considered`); continue; }
		const targets = Array.isArray(row.targets)
			? row.targets.map((t) => (typeof t === "string" ? t.trim() : "")).filter((t) => t.length > 0)
			: [];
		verdicts.push({ class: cls, verdict, why: str(row.why), targets });
	}

	return { extraction: { surface, findings, hypotheses, classes: verdicts }, errors, parsed: true };
}

/**
 * The outermost {...} in a reply.
 *
 * Brace-counted rather than regexed, and string-aware, so a brace inside a
 * finding's description does not truncate the document.
 */
function sliceJsonObject(text: string): string | undefined {
	// Every balanced top-level object, not just the first.
	//
	// A reply is routinely a wall of reasoning followed by the answer, and that
	// reasoning discusses the very schema being asked for — so it is full of
	// braces. Taking the first one parsed a fragment of the model thinking aloud
	// and reported an empty extraction, while a complete, correct roll-call sat
	// at the end of the same reply. Prefer the candidate that actually looks like
	// the document; among equals, the last, because the answer follows the
	// working.
	const candidates: string[] = [];
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		const end = matchBrace(text, start);
		if (end === undefined) continue;
		candidates.push(text.slice(start, end + 1));
		start = end;   // a nested object is not a separate candidate
	}
	if (candidates.length === 0) return undefined;

	let best: string | undefined;
	let bestScore = -1;
	for (const c of candidates) {
		let doc: unknown;
		try {
			doc = JSON.parse(c);
		} catch {
			continue;
		}
		if (typeof doc !== "object" || doc === null) continue;
		const o = doc as Record<string, unknown>;
		// Score by how much of the asked-for shape is present, so a stray object
		// from the reasoning cannot outrank the real one.
		const score = (Array.isArray(o.classes) ? 2 : 0)
			+ (Array.isArray(o.findings) ? 2 : 0)
			+ (Array.isArray(o.surface) ? 1 : 0)
			+ (Array.isArray(o.hypotheses) ? 1 : 0);
		if (score >= bestScore) { bestScore = score; best = c; }
	}
	// Nothing parsed: hand back the longest, so the caller reports a JSON error
	// against the most plausible candidate rather than a random early brace.
	return best ?? candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Index of the `}` closing the `{` at `start`, or undefined if unbalanced. */
function matchBrace(text: string, start: number): number | undefined {
	let depth = 0;
	let inStr = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return undefined;
}

function arr(v: unknown): Array<Record<string, unknown>> {
	return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}
function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
	if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
	return undefined;
}

/**
 * Recover a checklist class from a finding's CWE.
 *
 * The extractor is given the class vocabulary and still omits the field: on the
 * first live run all fifteen findings arrived with a CWE and no class, and a
 * finding with no class settles no coverage cell — the numbers stay at zero
 * while the report fills up. The checklist already maps its classes to CWEs, so
 * the harness can finish the job deterministically instead of asking again.
 */
export function classFromCwe(
	cwe: string | undefined,
	classes: Array<{ id: string; cwe?: string[] }>,
): string | undefined {
	if (!cwe) return undefined;
	const want = normaliseCwe(cwe);
	if (!want) return undefined;
	for (const c of classes) {
		for (const known of c.cwe ?? []) {
			if (normaliseCwe(known) === want) return c.id;
		}
	}
	return undefined;
}

function normaliseCwe(x: string): string | undefined {
	const m = /(\d+)/.exec(x);
	return m ? `CWE-${m[1]}` : undefined;
}

/**
 * The confirmed hypothesis implied by a finding.
 *
 * pired's own contract is that a confirmed hypothesis is also recorded as a
 * finding with the same class — but coverage is settled by the HYPOTHESIS, not
 * the finding, so a run that produces only findings leaves every cell untested.
 * A confirmed finding is a confirmed hypothesis by definition; deriving it is
 * bookkeeping, not inference.
 */
export function hypothesisForFinding(f: ExtractedFinding, cls: string, target: string): ExtractedHypothesis {
	return {
		statement: f.description ? `${f.title} — ${f.description}` : f.title,
		class: cls,
		target,
		outcome: "confirmed",
	};
}

/** How the review buffer joins one turn to the next. */
export const REVIEW_SEPARATOR = "\n\n---\n\n";

/**
 * The most review the extractor is handed, and the size the window is cut back
 * to when it overflows.
 *
 * Two numbers rather than one, and the gap between them is the point — see
 * reviewEviction().
 */
export const REVIEW_BUDGET = 40000;
export const REVIEW_TARGET = 24000;

/** The tail of a text, started at a line boundary so no sentence is halved. */
function tailFrom(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const kept = text.slice(text.length - limit);
	const nl = kept.indexOf("\n");
	return nl > 0 ? kept.slice(nl + 1) : kept;
}

/**
 * The slice of a review to hand the extractor.
 *
 * A long engagement produces a review far past the point where a 27B model
 * tracks a formatting instruction, and the first live attempt answered a
 * "return JSON" instruction with prose. The conclusions live at the END — the
 * severity calls, the summary list, the ruled-out classes — so when it has to be
 * cut, the tail is what to keep.
 */
export function trimReview(review: string, limit = REVIEW_BUDGET): string {
	if (review.length <= limit) return review;
	return `[earlier analysis omitted — ${review.length - limit} characters]\n${tailFrom(review, limit)}`;
}

/** The length the turns will have once joined, without building the string. */
function joinedLength(turns: string[]): number {
	if (turns.length === 0) return 0;
	let n = REVIEW_SEPARATOR.length * (turns.length - 1);
	for (const t of turns) n += t.length;
	return n;
}

/**
 * How many turns to drop from the front of the buffer, or 0 to keep it whole.
 *
 * The extractor's prompt is prefix-cached, and that decides the shape of this.
 * Appending a turn leaves every byte before it identical, so the provider
 * re-reads the whole prefix for free; moving the START of the window by a single
 * character invalidates all of it. Cutting the joined string to a fixed size
 * every turn — which is what handing trimReview() the whole buffer did — moved
 * the start every turn, so from the first overflow onward every pass reprefilled
 * ~10k tokens and hit nothing.
 *
 * So: cut only at a turn boundary, only when the budget is actually exceeded,
 * and when cutting, cut all the way back to `target`. The gap between the two is
 * the headroom that lets the next several turns append without moving the anchor
 * again — one invalidation per ~16k characters of new review instead of one per
 * turn.
 *
 * The newest turn is never dropped: it carries the conclusions, and a turn that
 * exceeds the budget on its own has no boundary to anchor to (reviewWindow falls
 * back to its tail).
 */
export function reviewEviction(turns: string[], budget = REVIEW_BUDGET, target = REVIEW_TARGET): number {
	let total = joinedLength(turns);
	if (total <= budget) return 0;
	let drop = 0;
	while (drop < turns.length - 1 && total > target) {
		total -= (turns[drop] ?? "").length + REVIEW_SEPARATOR.length;
		drop += 1;
	}
	return drop;
}

/**
 * The review buffer as the extractor sees it: the kept turns, and a note saying
 * what was dropped so it knows the analysis it is reading is partial.
 *
 * The note counts everything evicted across the engagement, not just this cut,
 * and it only changes when a cut happens — which is already the moment the
 * prefix is invalidated, so it costs nothing extra.
 */
export function reviewWindow(
	turns: string[],
	dropped: { turns: number; chars: number } = { turns: 0, chars: 0 },
	budget = REVIEW_BUDGET,
): string {
	const joined = turns.join(REVIEW_SEPARATOR);
	// One turn longer than the whole budget: nothing to anchor to, so keep its
	// tail and count the rest as dropped.
	const body = tailFrom(joined, budget);
	const chars = dropped.chars + (joined.length - body.length);
	if (chars === 0) return body;
	return `[earlier analysis omitted — ${dropped.turns} turn(s), ${chars} characters]\n${body}`;
}

/**
 * Whether a reply is worth a second call.
 *
 * The first live attempt answered a "return JSON" instruction with prose, and
 * the nudge exists for that. What it must not do is fire on an honest empty
 * answer: the cheap pass asks "anything new in this prose?" and the correct
 * reply is often `{"surface": [], "findings": []}`. Retrying that doubles the
 * cost of the quietest turns, which are the ones the whole redesign is for.
 *
 * So: retry when nothing was parsed. Retry an empty roll-call too — a sweep
 * that returns no verdicts at all has skipped the form it was handed, which is
 * the prose failure wearing a JSON hat.
 */
export function needsRetry(result: ParseResult, rollCall: boolean): boolean {
	if (!result.parsed) return true;
	if (!rollCall) return false;
	return result.extraction.findings.length === 0 && result.extraction.classes.length === 0;
}

/** A terser second ask, for when the first reply came back as prose. */
export function retryNudge(): string {
	return "Your previous reply was not JSON. Reply with the JSON object only: no explanation, no preamble, no markdown fence. Start your reply with { and end it with }.";
}

/** One `record` call the adapter should make, in order. */
export interface PlannedRecord {
	args: Record<string, unknown>;
	/** Set when this row creates a surface element, so the adapter can map its new id. */
	createsLabel?: string;
	/**
	 * Set when this row is only worth writing if the one before it landed.
	 *
	 * The derived hypothesis is the case: it settles a cell as confirmed on the
	 * strength of a finding, so writing it after that finding was rejected would
	 * put a coverage claim in the matrix with nothing in the report behind it.
	 */
	dependsOnPrevious?: boolean;
}

export interface PlanInput {
	extraction: Extraction;
	/** Labels already in the ledger, so nothing is recorded twice. */
	known: Set<string>;
	/** Every recorded surface id, for a refutation that names no target. */
	allSurface: string[];
	/** Checklist classes and their CWEs, for recovering an omitted class. */
	classes: Array<{ id: string; cwe?: string[] }>;
}

/**
 * Turn an extraction into the exact sequence of `record` calls it implies.
 *
 * Pure, and separated from the adapter deliberately: this is where the decisions
 * live — which cells a verdict settles, when a class is recovered from a CWE,
 * whether a finding also implies a hypothesis, what is a duplicate — and every
 * one of those was a bug that hid in the extension where nothing could test it.
 *
 * `target` values are LABELS. The adapter resolves them to ids, because ids for
 * rows this plan creates do not exist until it has run.
 */
export function planExtraction(input: PlanInput): { records: PlannedRecord[]; notes: string[] } {
	const { extraction, known, allSurface, classes } = input;
	const records: PlannedRecord[] = [];
	const notes: string[] = [];
	const ids = classes.map((c) => c.id);

	for (const el of extraction.surface) {
		if (known.has(el.label)) continue;
		records.push({ args: elementArgs(el), createsLabel: el.label });
	}

	for (const v of extraction.classes) {
		if (v.verdict === "not-considered") continue;
		if (!ids.includes(v.class)) { notes.push(`class "${v.class}" is not in the checklist`); continue; }
		const outcome = v.verdict === "confirmed" ? "confirmed" : "refuted";
		// A refutation that names no target applies across everything reviewed —
		// what a consultant means by "we checked for SSTI and it is clean". A
		// CONFIRMATION with no target settles nothing: "it is present somewhere" is
		// not a cell, and spreading it over the whole surface would be a lie.
		const targets = v.targets.length > 0 ? v.targets : outcome === "refuted" ? allSurface : [];
		if (targets.length === 0) {
			if (outcome === "confirmed") notes.push(`class "${v.class}" confirmed but named no target`);
			continue;
		}
		records.push({
			args: {
				kind: "hypothesis", class: v.class, target: targets, outcome,
				statement: v.why ?? `${v.class}: ${outcome === "refuted" ? "examined and found clean" : "confirmed"} during review`,
			},
		});
	}

	for (const h of extraction.hypotheses) {
		if (!ids.includes(h.class)) { notes.push(`hypothesis class "${h.class}" is not in the checklist`); continue; }
		records.push({ args: { kind: "hypothesis", statement: h.statement, class: h.class, target: h.target, outcome: h.outcome } });
	}

	for (const f of extraction.findings) {
		const cls = (f.class && ids.includes(f.class) ? f.class : undefined) ?? classFromCwe(f.cwe, classes);
		if (f.class && !ids.includes(f.class)) notes.push(`finding "${f.title.slice(0, 30)}…" had class "${f.class}", not in the checklist`);
		const target = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined;
		records.push({
			args: {
				kind: "finding", title: f.title, severity: f.severity,
				...(cls ? { class: cls } : {}), ...(f.cwe ? { cwe: f.cwe } : {}),
				...(target ? { target } : {}), ...(f.description ? { description: f.description } : {}),
				...(f.impact ? { impact: f.impact } : {}), ...(f.remediation ? { remediation: f.remediation } : {}),
			},
		});
		// Coverage is settled by a hypothesis outcome, never by a finding. Without
		// this a run produces a full report beside an empty matrix.
		// Settled only if something already claims THIS cell. Testing the class
		// alone was too broad: one confirmed sqli verdict naming auth.py would
		// suppress the hypothesis for an sqli finding in orders.py, and that second
		// cell would stay untested next to a reported bug.
		const alreadySettled = extraction.classes.some(
			(v) => v.class === cls && v.verdict === "confirmed" && target !== undefined && v.targets.includes(target),
		) || extraction.hypotheses.some((h) => h.class === cls && h.target === target);
		if (cls && target && !alreadySettled) {
			const h = hypothesisForFinding(f, cls, target);
			records.push({
				args: { kind: "hypothesis", statement: h.statement, class: h.class, target: h.target, outcome: h.outcome },
				dependsOnPrevious: true,
			});
		}
	}

	return { records, notes };
}

/** What running a plan produced, for the line the operator is shown. */
export interface ApplyResult {
	/** Surface elements created by this pass. */
	surface: number;
	/** Coverage cells settled — one per id a hypothesis row wrote. */
	settled: number;
	/** Findings written. */
	findings: number;
	/**
	 * Rows that named something already in the ledger.
	 *
	 * This pass runs at the end of every turn over a review buffer that only
	 * grows, so most of what it offers on the fifth turn was already recorded on
	 * the fourth. `record` folds those back into the rows they match; counting
	 * them here keeps them out of the numbers above, which would otherwise report
	 * the same twelve findings as new work once a turn.
	 */
	repeats: number;
	/** One line per row that was dropped, and why. */
	errors: string[];
}

/**
 * What one `record` call did: every id it touched, and the subset it created.
 *
 * The distinction is the whole point of the return value. A call that matched
 * something already recorded still reports the id — the caller needs it to map a
 * label onto the element that exists — but it created nothing, and a pass that
 * counted calls instead of creations reported an engagement that was moving when
 * it was standing still.
 */
export interface RecordOutcome {
	ids: string[];
	created: string[];
}

/**
 * Run a plan against a `record` implementation.
 *
 * The other half of the split, and the half that actually broke things. It owns
 * three rules, none of which are obvious and all of which were once wrong:
 *
 *   - **Labels become ids.** The plan speaks the review's own words ("POST
 *     /api/login"); the ledger speaks ids. A target that resolves to no element
 *     settles no cell, so a pass that mapped only the rows it had just written —
 *     rather than everything already recorded — produced a coverage number of
 *     zero beside a full ledger.
 *   - **One bad row must not stop the rest.** A rejected finding costs that
 *     finding, not the nineteen behind it.
 *   - **Except where a row depends on the one before it.** See
 *     `dependsOnPrevious`.
 *
 * `record` returns the ids it wrote — a bulk hypothesis settles several cells in
 * one call, so the count comes from the ids, never from the number of calls.
 */
export async function applyPlan(
	records: PlannedRecord[],
	record: (args: Record<string, unknown>) => Promise<RecordOutcome>,
	idFor: Map<string, string>,
): Promise<ApplyResult> {
	const out: ApplyResult = { surface: 0, settled: 0, findings: 0, repeats: 0, errors: [] };
	let previousFailed = false;
	for (const row of records) {
		if (row.dependsOnPrevious && previousFailed) continue;
		const kind = row.args.kind;
		// Hypotheses target a surface ELEMENT and must resolve to its id — that is
		// what settles a coverage cell. Findings target a LOCATION and must not:
		// rewriting "FetchController.php:95" to "ae6ea1" destroys the only thing the
		// report can cite and the grader can read. Measured on LinkAce: 19 findings
		// recorded, several carrying inventory ids where a path belonged, 5 gradeable.
		const args = row.createsLabel || kind === "finding"
			? row.args
			: { ...row.args, target: resolveTarget(row.args.target, idFor) };
		try {
			const { ids, created } = await record(args);
			previousFailed = false;
			if (row.createsLabel) {
				if (created.length > 0) out.surface += 1;
				else out.repeats += 1;
				// The id is mapped either way, and on a repeat it is the id of the
				// element already recorded — which is the one later rows should point
				// at. A pass that mapped only what it created sent every hypothesis
				// about a known element to a label the ledger does not key on.
				const id = ids[0];
				if (id) idFor.set(row.createsLabel, id);
			} else if (kind === "hypothesis") {
				out.settled += created.length;
				out.repeats += ids.length - created.length;
			} else if (kind === "finding") {
				if (created.length > 0) out.findings += 1;
				else out.repeats += 1;
			}
		} catch (err) {
			previousFailed = true;
			const why = err instanceof Error ? err.message : String(err);
			// A surface row that fails is not worth a line: the elements it would
			// have created are usually already there, and the rows that point at it
			// report their own failure.
			if (!row.createsLabel) out.errors.push(`${describeRow(row)}: ${why}`);
		}
	}
	return out;
}

/** A target is one label or a list of them; ids and unknown labels pass through. */
function resolveTarget(target: unknown, idFor: Map<string, string>): unknown {
	if (typeof target === "string") return idFor.get(target) ?? target;
	if (Array.isArray(target)) return target.map((t) => (typeof t === "string" ? idFor.get(t) ?? t : t));
	return target;
}

/** Name a row in an error line the way the operator would recognise it. */
function describeRow(row: PlannedRecord): string {
	const a = row.args;
	if (a.kind === "finding") return `finding "${String(a.title ?? "").slice(0, 40)}…"`;
	if (a.kind === "hypothesis") return `${String(a.class ?? "hypothesis")} "${String(a.statement ?? "").slice(0, 40)}…"`;
	return String(a.kind ?? "row");
}

/** One extracted element as `record` arguments. */
export function elementArgs(el: ExtractedElement): Record<string, unknown> {
	if (el.kind === "endpoint") {
		const m = /^([A-Z]+)\s+(.+)$/.exec(el.label);
		return m ? { kind: "endpoint", method: m[1], path: m[2] } : { kind: "endpoint", path: el.label };
	}
	if (el.kind === "host") return { kind: "host", value: el.label };
	return { kind: el.kind, name: el.label };
}

/**
 * Whether an automatic extraction pass is worth making.
 *
 * The old condition was `claims === 0 || unanswered > 0`, and both halves are
 * permanently true in a real engagement: a checklist class that the extractor
 * reports as "not-considered" is never settled, so something is always
 * unanswered, and an agent that records nothing itself leaves claims at zero
 * forever. The fingerprint guard beside it could not help either — it keys on
 * the review buffer, which grows every turn, so every pass looked new.
 *
 * Measured: 18 passes on one target that settled nothing, each carrying the
 * whole review buffer to a model server that answers one call at a time. The
 * pass meant to rescue an engagement was consuming it.
 *
 * Two rules, both about evidence rather than about the agent's behaviour:
 * extract only when there is genuinely new review to read, and ask for more of
 * it each time a pass comes back empty. A model that has said nothing
 * conclusive in 2,000 characters is not usually one turn away from doing so,
 * and the backoff resets the moment a pass writes something.
 */
export interface ExtractGate {
	/** Characters of review accumulated so far. */
	reviewLength: number;
	/** Review length when a pass last ran; 0 when none has. */
	lastLength: number;
	/** Consecutive passes that wrote nothing at all. */
	barren: number;
	/** Review required before the first pass. */
	min: number;
	/** New review required before another pass. */
	growth: number;
}

/** How much new review the next pass needs, given how many came back empty. */
export function extractionThreshold(growth: number, barren: number): number {
	return growth * 2 ** Math.min(Math.max(barren, 0), 5);
}

export function shouldExtract(g: ExtractGate): boolean {
	if (g.reviewLength < g.min) return false;
	// The first pass is the rescue the mechanism exists for: never hold it back.
	if (g.lastLength <= 0) return true;
	return g.reviewLength - g.lastLength >= extractionThreshold(g.growth, g.barren);
}
