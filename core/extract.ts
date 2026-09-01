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
 * Phase two is a fresh, single-turn call whose only job is to convert that prose
 * into rows — the regime where a small model is reliable, and where the output
 * is plain JSON rather than a tool call, so there is no call left to skip.
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
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const KINDS: ExtractedElement["kind"][] = ["endpoint", "host", "param", "tech", "service"];
const OUTCOMES: ExtractedHypothesis["outcome"][] = ["confirmed", "refuted", "inconclusive"];
const VERDICTS: ClassVerdict["verdict"][] = ["confirmed", "refuted", "not-considered"];

/**
 * The extractor's instructions.
 *
 * It is told it is NOT reviewing. Given any latitude to analyse, a model that
 * has just spent twenty minutes analysing will keep going, and the run ends in
 * more prose — which is the failure this exists to end.
 */
export function extractionSystemPrompt(classes: string[]): string {
	const list = classes.length > 0 ? classes.join(", ") : "(no checklist loaded — omit the class field)";
	const roll = classes.length > 0
		? classes.map((c) => `  {"class": "${c}", "verdict": "confirmed|refuted|not-considered", "why": "...", "targets": []}`).join(",\n")
		: '  // no checklist loaded — return an empty array';
	return `You convert a finished security review into structured data. You are NOT reviewing anything: the analysis is complete and correct as written. Do not add findings, do not re-judge severity, do not investigate further. Transcribe what the review already concluded.

Reply with ONE JSON object and nothing else — no prose before or after, no markdown fence:

{
  "surface":  [{"kind": "endpoint|host|param|tech|service", "label": "POST /api/login"}],
  "findings": [{"title": "...", "severity": "critical|high|medium|low|info", "class": "<id>", "cwe": "CWE-89", "file": "backend/routes/auth.py", "line": 42, "description": "one or two sentences"}],
  "classes": [
${roll}
  ]
}

The "classes" array is a checklist and you must return EVERY row above, in order, with no rows added or removed. For each one, say what the review concluded:
- "confirmed" — the review found this class present. List the places in "targets".
- "refuted" — the review examined this class and found it clean. Put the reason in "why" ("no template rendering of user input anywhere in the reviewed code"). Leave "targets" empty if it applies across everything reviewed.
- "not-considered" — the review did not examine this class. This is a normal, correct answer and you must use it rather than guessing. Never mark a class "refuted" because the review did not mention it; silence is not a clean bill of health.

Other rules:
- "class" on a finding must be one of exactly these ids: ${list}
- "target" and "label" are the review's own words for the thing (a route, a file, a host) — not an id.
- "file" and "line" must come from the review. Never guess a line number; omit the field instead.
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
	if (!raw) return { extraction: empty, errors: ["no JSON object found in the reply"] };

	let doc: unknown;
	try {
		doc = JSON.parse(raw);
	} catch (e) {
		return { extraction: empty, errors: [`reply was not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
	}
	if (typeof doc !== "object" || doc === null) return { extraction: empty, errors: ["reply was not a JSON object"] };
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

	return { extraction: { surface, findings, hypotheses, classes: verdicts }, errors };
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

/** A terser second ask, for when the first reply came back as prose. */
export function retryNudge(): string {
	return "Your previous reply was not JSON. Reply with the JSON object only: no explanation, no preamble, no markdown fence. Start your reply with { and end it with }.";
}

/** One `record` call the adapter should make, in order. */
export interface PlannedRecord {
	args: Record<string, unknown>;
	/** Set when this row creates a surface element, so the adapter can map its new id. */
	createsLabel?: string;
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
			},
		});
		// Coverage is settled by a hypothesis outcome, never by a finding. Without
		// this a run produces a full report beside an empty matrix.
		const alreadySettled = extraction.classes.some((v) => v.class === cls && v.verdict === "confirmed")
			|| extraction.hypotheses.some((h) => h.class === cls && h.target === target);
		if (cls && target && !alreadySettled) {
			const h = hypothesisForFinding(f, cls, target);
			records.push({ args: { kind: "hypothesis", statement: h.statement, class: h.class, target: h.target, outcome: h.outcome } });
		}
	}

	return { records, notes };
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
