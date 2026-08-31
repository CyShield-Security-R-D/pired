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
	const start = text.indexOf("{");
	if (start < 0) return undefined;
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
			if (depth === 0) return text.slice(start, i + 1);
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

/**
 * The slice of a review to hand the extractor.
 *
 * A long engagement produces a review far past the point where a 27B model
 * tracks a formatting instruction, and the first live attempt answered a
 * "return JSON" instruction with prose. The conclusions live at the END — the
 * severity calls, the summary list, the ruled-out classes — so when it has to be
 * cut, the tail is what to keep.
 */
export function trimReview(review: string, limit = 40000): string {
	if (review.length <= limit) return review;
	const kept = review.slice(review.length - limit);
	// Start at a line boundary so the extractor is not handed half a sentence.
	const nl = kept.indexOf("\n");
	return `[earlier analysis omitted — ${review.length - limit} characters]\n${nl > 0 ? kept.slice(nl + 1) : kept}`;
}

/** A terser second ask, for when the first reply came back as prose. */
export function retryNudge(): string {
	return "Your previous reply was not JSON. Reply with the JSON object only: no explanation, no preamble, no markdown fence. Start your reply with { and end it with }.";
}
