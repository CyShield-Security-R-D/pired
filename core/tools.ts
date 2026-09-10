/**
 * pired cognitive tools: `record` and `recall`.
 *
 * These are the agent's memory and situational awareness — NOT security tools
 * (principle 8). `record` writes engagement state to the workspace; `recall`
 * projects it back (including derived coverage, gaps, and the non-blocking
 * `next` router). `spawn` (subagents) lands with the subagent work.
 *
 * Built as core `ToolDefinition`s over the `Workspace` + coverage; the adapter
 * maps them onto its harness. Runtime services (clock/ids) come from `ToolContext`.
 */

import { buildBrowserModel, recordLabel } from "./browser.ts";
import { auditFinding, challengeBrief, hypothesisBrief, judge, SEVERITY_RANK, unchallengedQueue, verdictPatch } from "./challenge.ts";
import { computeCoverage, coveragePercent, findGaps, selectNext } from "./coverage.ts";
import { CVSS_DEFAULT_VERSION, CVSS_EXAMPLE, cvssVersion, validateCvss } from "./cvss.ts";
import { type Fields, findDuplicate, findNearDuplicate, type IdentityKind, isNoOp, mergeRecord } from "./identity.ts";
import { locateAcrossFiles, locateSink, sinkHints } from "./locate.ts";
import { buildTargetIndex, elementLabel, resolveElementTarget, type TargetIndex } from "./target.ts";
import { computeCoverageView, computeEngagementStats, isDisposed } from "./stats.ts";
import { CELL_GLYPH, renderCoveragePanel } from "./coverage-panel.ts";
import {
	type BlockerRecord,
	BLOCKER_STATUSES,
	BLOCKER_TYPES,
	FINDING_SOURCES,
	FINDING_STATUSES,
	HYPOTHESIS_OUTCOMES,
	type FindingRecord,
	MODEL_SECTION_HELP,
	MODEL_SECTIONS,
	UNVERIFIED_STATUS,
	type HypothesisRecord,
	type InventoryKind,
	type InventoryRecord,
	type LedgerRecord,
	LOOT_TYPES,
	PRIORITIES,
	RECORD_VERSION,
	SEVERITIES,
	type StoreName,
} from "./ontology.ts";
import type { JsonSchema, ToolContext, ToolDefinition, ToolResult } from "./ports.ts";
import type { Workspace } from "./workspace.ts";

export interface ToolDeps {
	workspace: Workspace;
	/** Inventory kinds treated as coverage surface elements. */
	surfaceKinds?: InventoryKind[];
}

const RECORD_KINDS = [
	"note", "evidence", "model", "host", "service", "endpoint", "param", "tech", "hypothesis", "finding", "blocker", "loot",
] as const;
type RecordKind = (typeof RECORD_KINDS)[number];
type LedgerKind = Exclude<RecordKind, "note" | "evidence" | "model">;

const RECALL_QUERIES = [
	"status", "next", "coverage", "surface", "gaps", "cleared", "inventory", "hypotheses", "findings", "finding", "challenge", "loot", "blockers", "notes", "model",
] as const;

/**
 * Plain-text rendering of the views the operator sees.
 *
 * The panel, the matrix and the surface list are pure renderers with colour and
 * width injected, so the agent can be handed the SAME view rather than a second
 * summary written beside it. Two derivations of "how far along are we" is how
 * the number on screen and the number the agent reasons from drift apart.
 */
const PLAIN = {
	ink: (_tone: string, text: string): string => text,
	measure: (x: string): number => x.length,
	truncate: (x: string, w: number): string => (x.length > w ? x.slice(0, w) : x),
	width: 100,
};

const STORE_FOR_KIND: Record<LedgerKind, StoreName> = {
	host: "inventory", service: "inventory", endpoint: "inventory", param: "inventory", tech: "inventory",
	hypothesis: "hypotheses", finding: "findings", blocker: "blockers", loot: "loot",
};

const DEFAULTS: Partial<Record<LedgerKind, Record<string, unknown>>> = {
	service: { proto: "tcp" },
	endpoint: { method: "GET" },
	hypothesis: { outcome: "proposed" },
	finding: { status: UNVERIFIED_STATUS },
	blocker: { type: "decision", priority: "medium", status: "open" },
	loot: { type: "password" },
};

const REQUIRED: Record<LedgerKind, string[]> = {
	host: ["value"], service: ["host", "port"], endpoint: ["path"], param: ["name"], tech: ["name"],
	hypothesis: ["statement", "target", "class"],
	// `target` is deliberately NOT required for a finding.
	//
	// A finding is not only a confirmed vulnerability against a recorded surface
	// element. "No dependency pins, so SCA is impossible", "secrets printed to
	// stdout on every run", "this library is three majors behind" are all worth
	// carrying to the report, and none of them has an endpoint or a host to hang
	// off. Requiring one leaves the agent two options — invent an element id, or
	// drop the observation into notes — and notes are where findings went to die.
	//
	// It stays required for a hypothesis, where the target is not a label but the
	// coordinate of the coverage cell the hypothesis settles.
	finding: ["title", "severity"],
	blocker: ["question"], loot: ["handle", "secret"],
};

const DEFAULT_SURFACE_KINDS: InventoryKind[] = ["endpoint", "host"];

// --- small typed accessors --------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/**
 * Coerce a "one or many" field to a list, however the model serialized it.
 *
 * Tool schemas cannot express string-or-array in the JsonSchema subset core
 * carries, so models pick a representation — and smaller ones frequently emit a
 * JSON array *as a string*: target='["id1","id2"]'. Strict Array.isArray missed
 * that and stored the whole literal as one target id, producing a hypothesis
 * attached to an element that does not exist. Measured on live runs, 5-66% of
 * recorded hypotheses were orphaned this way: recorded, counted, settling
 * nothing. Be liberal here — the cost of guessing wrong is a rejected call, the
 * cost of not guessing is a silently unmeasurable engagement.
 */
function asList(v: unknown): string[] {
	if (Array.isArray(v)) return strArr(v) ?? [];
	const raw = str(v);
	if (raw === undefined) return [];
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return strArr(parsed) ?? [];
		} catch {
			// fall through: a bracketed string that is not JSON is taken literally
		}
	}
	if (trimmed.includes(",")) {
		const parts = trimmed.split(",").map((x) => x.trim()).filter(Boolean);
		if (parts.length > 1) return parts;
	}
	return [trimmed];
}

function strArr(v: unknown): string[] | undefined {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) {
		const out = v.filter((x): x is string => typeof x === "string");
		return out.length ? out : undefined;
	}
	return undefined;
}
function oneOf<T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined {
	return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}
function required<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}
function defined(obj: Record<string, unknown>): Record<string, unknown> {
	for (const key of Object.keys(obj)) if (obj[key] === undefined) delete obj[key];
	return obj;
}
function text(body: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text: body }], details };
}

/** Pull only the fields the caller provided, mapped to ontology field names. No defaults, no required checks. */
function extractFields(kind: LedgerKind, a: Record<string, unknown>): Record<string, unknown> {
	switch (kind) {
		case "host":
			return defined({ value: str(a.value), ip: str(a.ip), tech: strArr(a.tech) });
		case "service":
			return defined({ host: str(a.host), port: num(a.port), proto: str(a.proto), name: str(a.name) });
		case "endpoint":
			// `file` is where the route is implemented. Without it in this list the
			// schema accepted the argument and the write dropped it: measured across
			// five targets, the agent passed `file` on 97 of 290 surface calls and
			// the ledger recorded it 0 times.
			return defined({ host: str(a.host), method: str(a.method), path: str(a.path), params: strArr(a.params), auth: str(a.auth), file: str(a.file) });
		case "param":
			return defined({ name: str(a.name), endpoint: str(a.endpoint), location: str(a.location), file: str(a.file) });
		case "tech":
			return defined({ name: str(a.name), host: str(a.host), version: str(a.version) });
		case "hypothesis":
			// `verification` is written by the challenge path below, never taken
			// from the caller — same rule as a finding's, and for the same reason.
			return defined({ statement: str(a.statement), target: asList(a.target)[0], class: asList(a.class)[0], method: str(a.approach) ?? str(a.method), outcome: oneOf(a.outcome, HYPOTHESIS_OUTCOMES), evidence: str(a.evidence), findingId: str(a.findingId), verification: a.verification as HypothesisRecord["verification"] });
		case "finding":
			return defined({ title: str(a.title), severity: oneOf(a.severity, SEVERITIES), target: str(a.target), class: str(a.class), cwe: str(a.cwe), cvss: str(a.cvss), description: str(a.description), impact: str(a.impact), remediation: str(a.remediation), repro: str(a.repro), evidence: strArr(a.evidence), status: oneOf(a.status, FINDING_STATUSES), reason: str(a.reason), hypothesisId: str(a.hypothesisId), source: oneOf(a.source, FINDING_SOURCES), verification: a.verification as FindingRecord["verification"] });
		case "blocker":
			return defined({ type: oneOf(a.blockerType, BLOCKER_TYPES), question: str(a.question), context: str(a.context), options: strArr(a.options), blocks: strArr(a.blocks), priority: oneOf(a.priority, PRIORITIES), status: oneOf(a.status, BLOCKER_STATUSES), answer: str(a.answer) });
		case "loot":
			return defined({ handle: str(a.handle), type: oneOf(a.lootType, LOOT_TYPES), username: str(a.username), secret: str(a.secret), target: str(a.target), source: str(a.source), notes: str(a.notes) });
	}
}

/**
 * Structured detail handed to the host for rendering. Deliberately narrow: a
 * loot record carries a plaintext secret and `details` is persisted into the
 * session transcript, so this must never widen to the whole record.
 */
/**
 * What a write actually did. `created` is a new row; `updated` is the explicit
 * `id=` path; `merged` and `unchanged` are what deduplication turned a repeat
 * into. Callers count creations, never calls: the extractor re-offers the same
 * rows every turn, and counting those as work reports an engagement that is
 * moving when it is standing still.
 */
type WriteOutcome = "created" | "updated" | "merged" | "unchanged";

function recordDetails(record: LedgerRecord, outcome: WriteOutcome): Record<string, unknown> {
	const base: Record<string, unknown> = {
		id: record.id,
		kind: record.kind,
		ids: [record.id],
		created: outcome === "created" ? [record.id] : [],
	};
	if (record.kind === "finding") return { ...base, severity: record.severity, title: record.title };
	return base;
}

/**
 * What a confirmation still owes the client.
 *
 * Confirming settles the coverage cell; only a finding reaches the report, and
 * the two are separate acts — one engagement sat at 120 confirmed cells with an
 * empty findings ledger while every view said "none recorded". Said at the
 * moment the next action is obvious and cheap, and never enforced. ADR-004.
 */
const CONFIRMED_OWES =
	" Confirmed settles the coverage cell; only a finding reaches the report — " +
	"record kind=finding for this, with hypothesisId to link them.";

function recordSummary(kind: string, record: LedgerRecord, outcome: WriteOutcome): string {
	// A repeat is told plainly what it matched, and that nothing was lost. The
	// agent that re-recorded something usually did it because the first call
	// scrolled out of context; "already there, as this id" is the answer to the
	// question it was actually asking.
	if (outcome === "merged") {
		return `Already recorded as ${kind} ${record.id} (${recordLabel(record)}) — updated it in place rather than adding a second row. ` +
			`Pass id=${record.id} to change it further.`;
	}
	if (outcome === "unchanged") {
		return `Already recorded as ${kind} ${record.id} (${recordLabel(record)}) — nothing new in this call, so nothing was written. ` +
			`Pass id=${record.id} to change it.`;
	}
	if (record.kind === "finding") return `Recorded finding ${record.id} [${record.severity}] ${record.title}`;
	if (record.kind === "hypothesis") return `Recorded hypothesis ${record.id} (${record.outcome}) on ${record.target}`;
	if (record.kind === "blocker") return `Parked blocker ${record.id} [${record.priority}]: ${record.question}`;
	if (record.kind === "loot") return `Recorded loot ${record.id} ${record.handle}`;
	return `Recorded ${kind} ${record.id}`;
}

const RECORD_DESCRIPTION = `Record engagement state to the durable workspace. One tool for all state; pick 'kind':
- model: section[what|actors|invariants|boundaries|flows], text — the TARGET MODEL: the bigger picture every other record hangs off. what it is for, who its actors are, the invariants that must hold, where untrusted data crosses in, the flows that matter. Recording a section REPLACES it, because understanding gets corrected; this is the one record you are meant to rewrite. It is injected into every future session, so it is how a later you starts already knowing the target instead of re-deriving it. Write it early and correct it as you learn — and treat 'invariants' as your hypothesis generator: every rule that must hold is a question about what breaks it, and those are the bugs no checklist lists and no scanner sees.
- note: text
- evidence: name, content — saves raw output to the workspace and returns the path to cite (this is how you create the file that 'evidence' fields reference)
- host: value (+ip, tech[]); service: host, port (+proto, name); endpoint: path (+host, method, params[], auth, file); param: name (+endpoint, location, file)
  'file' is where the element lives in the source — the handler a route dispatches to. Reviewing code, give it: coverage is classes x the surface you recorded, so a matrix of routes alone can never point at a file, and a finding on that element inherits a location the report can cite.; tech: name (+host, version)
- hypothesis: statement, target (surface id), class (checklist id) (+approach, outcome[proposed|testing|confirmed|refuted|inconclusive], evidence). One test case: the class you tested, the element you tested it against, and what came back. 'target' and 'class' also accept lists, recording the cross product in one call — use it when one piece of reasoning settles several test cases at once.
- finding: title, severity[info|low|medium|high|critical] (+target, class, cwe, cvss, description, repro, evidence[], status)
  A finding is anything worth carrying into the report, not only a proven vulnerability. Use severity=info for an observation that costs nothing now but may matter later — a missing dependency pin, an unpinned base image, a permissive default, a lead you could not finish. 'target' is optional and accepts a recorded element id OR a raw string (a file path, a module, a component) when no element fits; give one when you can, and record the finding either way rather than leaving it in notes.
  A finding is a section of a document a client pays for, so it is written as one: 'description' says what the flaw is and where, 'impact' says what it costs THEM — the records exposed, the money moved, the service lost, the obligation breached — and 'remediation' says the concrete change that fixes it (the control to add, the call to replace; never "sanitize input"). 'repro' is numbered steps a third party can follow. Write impact in the client's terms, not the tool's: "any logged-in customer can read all 40k customer records, including national IDs" beats "confidentiality impact is high".
  status[suspected|open|confirmed|triaged|reported|refuted|false-positive|accepted-risk|ignored] is how a finding is settled without losing it. New findings are 'suspected': recorded, not yet challenged. 'confirmed' is earned, not asserted — pass 'control' (the case that had to FAIL for this to mean anything: the unauthenticated request, the false payload, the absent guard) and, for access-control classes, 'entitlement' (how you established the caller was not MEANT to reach the resource — reading another user's object is a bug when the reader was not entitled and a feature when they were, and the response looks identical). To refute, pass 'basis' (file:line, an evidence path, or the model section that settles it) and 'live'. Short of either bar the finding stays 'suspected' and nothing is lost. 'recall challenge' lists what is unchallenged; 'recall challenge id=<id>' returns the brief. When the operator says a finding is not real, set status=false-positive; when they say the risk is accepted, status=accepted-risk; when they want it set aside, status=ignored. All three keep the row and its history, drop it out of the open-findings count, and take a 'reason' — which is what a client asks for three months later. Prefer them to deleting.
- blocker: question (+blockerType, priority[low|medium|high], options[], blocks[] (work ids this gates), status[open|answered|dismissed], answer)
  A parked question stays open until someone closes it, and an open blocker is one you keep routing around. When the operator answers it — in a dialog, or just by telling you in chat that it is decided or already handled — write that down: \`recall blockers\` gives you the id, then \`record kind=blocker id=<id> status=answered answer=<what they said>\`. Answers given in the UI arrive on their own; you do not need a tool call to read them.
- loot: handle (e.g. cred:web-admin), secret (+lootType, username, target, source)
Pass 'id' to update an existing record. Pass 'id' with delete=true (and a 'reason') to retire one: it disappears from every view, the superseded lines stay in the file, and the tombstone records why. Delete only what should never have been recorded — a mistake, a row the operator asked you to remove. A finding that is real but will not be acted on is a status, not a deletion; deleting it removes it from the report the client reads.

Recording something twice is safe. Every kind has an identity — an endpoint is its method and path, a hypothesis is its (target, class) cell, a finding is its title and location — and a second recording of the same thing updates the first instead of creating a second row: fields you add are kept, a severity is never lowered, evidence and params are merged. So when you are not sure whether something is already recorded, record it. The reply names the id it matched, and 'id=<that>' is how you change it afterwards.

How these connect (this is what makes coverage work, not ceremony):
- Coverage is your checklist's classes x the surface *you have recorded* — a TEST PLAN. Each cell of it is one test case: this weakness class, asked of this element ("is POST /api/login vulnerable to SQL injection?"). A host or endpoint you never recorded has no test cases at all, so it can never show as tested and 'recall gaps' cannot route you to it. Record the surface as you discover it.
- A hypothesis IS that test case, executed and given a verdict — which is why a cell is settled by a hypothesis outcome and never by a finding: 'confirmed' marks it vulnerable, 'refuted' marks it clear. Ruling a class out is a result, not a non-event: an unrecorded refutation leaves the test case looking un-run no matter how carefully you looked. Running one case per call would be hundreds of calls, so record refutations in the shape you reasoned in: one call with a list of classes (and/or targets) and the single reason they share.
- A confirmed hypothesis should also be recorded as a finding, tagged with the same 'class' so the finding maps back to the test case that proved it.
- 'evidence' is a workspace-relative PATH, not inline text. Create it with record kind=evidence (which returns the path), then cite that exact path. Paths are verified on write: a finding or hypothesis citing a path that does not resolve is rejected, so cite only what you actually saved, or omit the field.`;

const RECORD_PARAMETERS: JsonSchema = {
	type: "object",
	additionalProperties: true,
	required: ["kind"],
	properties: {
		kind: { enum: RECORD_KINDS, description: "What is being recorded." },
		id: { type: "string", description: "Existing record id to update; omit to create." },
		text: { type: "string" },
		section: { enum: MODEL_SECTIONS, description: "For kind=model: which section of the target model this replaces." },
		value: { type: "string" }, ip: { type: "string" }, tech: { type: "array", items: { type: "string" } },
		host: { type: "string" }, port: { type: "integer" }, proto: { type: "string" }, name: { type: "string", description: "Name for param/tech; for kind=evidence, the filename to save under (e.g. \"sqli-login.txt\")." }, version: { type: "string" },
		endpoint: { type: "string" }, method: { type: "string" }, path: { type: "string" }, params: { type: "array", items: { type: "string" } }, auth: { type: "string" }, location: { type: "string" },
		file: { type: "string" },
		statement: { type: "string" },
		// `anyOf`, not a bare description. These two were the only properties in the
		// schema with no type at all, and a typeless property is not something a
		// provider can render into a function signature — the field was dropped
		// before the model ever saw it, every `target` the model sent arrived as
		// undefined, and `record kind=finding` and `kind=hypothesis` (which require
		// it) rejected every single call.
		//
		// The agent behaved correctly under that: it tried, was refused, and wrote
		// its findings into notes.md instead, reporting "record kind=finding
		// rejected every value for its required target field". That is the whole
		// explanation for zero hypotheses and zero findings across the corpus — the
		// coverage mechanism was never idle, it was unreachable.
		target: {
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "Surface element id, or a list of ids to settle together.",
		},
		class: {
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "Checklist class id, or a list of class ids to settle together.",
		},
		approach: { type: "string" }, outcome: { enum: HYPOTHESIS_OUTCOMES },
		content: { type: "string", description: "For kind=evidence: the raw output to save to the file." },
		title: { type: "string" }, severity: { enum: SEVERITIES }, cwe: { type: "string" }, cvss: { type: "string", description: `CVSS vector. v4.0 by default, e.g. "${CVSS_EXAMPLE["4.0"]}"; a v3.1 vector is accepted when the engagement requires one.` }, description: { type: "string", description: "What the flaw is and where: the mechanism, in plain language." }, impact: { type: "string", description: "What it costs the client in their terms — records exposed, money moved, service lost, obligation breached." }, remediation: { type: "string", description: "The concrete change that fixes it: the control to add, the call to replace. Not \"sanitize input\"." }, repro: { type: "string" }, status: { type: "string" }, evidence: { type: "array", items: { type: "string" }, description: "Workspace-relative paths to evidence files you wrote (e.g. [\"evidence/sqli-login.txt\"]). Not inline text." },
		control: { type: "string", description: "For kind=finding: the control case you ran and what it returned — the request that had to FAIL for the finding to mean anything." },
		basis: { type: "array", items: { type: "string" }, description: "The grounds for a refutation, a severity change, or a second look at a cleared cell — file:line, an evidence path, or the model section that settles it. On kind=hypothesis with an id, this is what marks the row as independently re-checked." },
		live: { type: "boolean", description: "Was the target reachable and the session valid when you challenged it? A refutation against a dead session refutes nothing. Applies to kind=finding and to a re-checked kind=hypothesis." },
		entitlement: { type: "string", description: "For kind=finding: how you established the caller was (or was not) meant to reach the resource. Required to confirm an access-control finding." },
		question: { type: "string" }, blockerType: { enum: BLOCKER_TYPES }, priority: { enum: PRIORITIES }, options: { type: "array", items: { type: "string" } }, blocks: { type: "array", items: { type: "string" } }, context: { type: "string" },
		handle: { type: "string" }, lootType: { enum: LOOT_TYPES }, username: { type: "string" }, secret: { type: "string" }, source: { type: "string" }, notes: { type: "string" },
		delete: { type: "boolean", description: "With 'id': retire that record. For something that should never have been recorded — ask the operator first." },
		reason: { type: "string", description: "Why a record is being deleted or its status changed. Stored on the record." },
	},
};

/**
 * Every way a recorded element might be named, mapped to its id.
 *
 * A hypothesis settles a coverage cell only when its target IS an element id.
 * The model does not write ids — it writes what it is looking at: "/api/register",
 * "POST /api/login", "backend/auth.py". Measured on a live run: 0 of 107
 * hypotheses resolved, so a ledger with 107 rows reported 0% coverage and gave no
 * hint why. Ids are an implementation detail of the ledger; making the operator's
 * agent memorise them is the tool's problem to solve, not the model's.
 *
 * The rules live in core/target.ts, because coverage resolves targets a second
 * time when it computes the matrix — the element is often recorded after the
 * claim about it — and the two passes have to agree on what a name means.
 */
function targetIndex(inventory: Awaited<ReturnType<Workspace["read"]>>): TargetIndex {
	return buildTargetIndex(inventory as unknown as Fields[]);
}

/** Add an element created mid-call, so the targets behind it resolve to it too. */
function indexElement(index: TargetIndex, name: string, id: string): void {
	const k = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/\/+$/, "");
	if (k.length > 0 && !index.byKey.has(k)) index.byKey.set(k, id);
	index.byKey.set(id, id);
	index.named.push({ id, name: k });
}

/**
 * The element a free-form target names, if any.
 *
 * Targets arrive as prose: "app.py line 17 SECRET_KEY = 'supersecret'",
 * "auth.py `_decode_token`", "POST /api/login (line 30)". The thing being tested
 * is the file or the route at the front; the rest is where in it. Pull that out
 * so a hypothesis can be attached to something, rather than to a sentence.
 */
function elementNameIn(raw: string): string | undefined {
	const t = raw.trim();
	// A route first — it is unambiguous — then a filename with an extension.
	const route = /^([A-Z]+\s+)?(\/[\w./{}<>:-]*)/.exec(t);
	if (route?.[2] && route[2].length > 1) return route[2];
	// A real source or config extension, not any dotted token: "app.run(debug=True)"
	// and "logger.info" both look like filenames to a naive pattern and would be
	// recorded as surface, putting function calls in the coverage matrix.
	const file = /^([\w./-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rb|php|java|cs|rs|kt|kts|scala|swift|c|h|cpp|hpp|sql|sh|bash|zsh|ya?ml|json|toml|ini|cfg|conf|env|tf|tfvars|xml|html|htm|css|scss|md|txt|lock|gradle|properties))\b/i.exec(t);
	return file?.[1];
}

/**
 * Write one inventory element straight to the store and return its id.
 *
 * A small direct write rather than a recursive tool call: the caller is already
 * inside execute(), and re-entering it would re-run the target resolution that
 * asked for this element in the first place.
 */
async function writeRecord(
	deps: ToolDeps,
	ctx: ToolContext,
	kind: "endpoint",
	fields: Record<string, unknown>,
): Promise<string | undefined> {
	try {
		let id: string | undefined;
		// Same defaults `record kind=endpoint` applies, so an element created here is
		// indistinguishable from one the agent declared itself. And the same identity
		// check: two subagents resolving the same unrecorded file both arrive here,
		// and inside the writer's lock only the first of them creates it.
		const merged = { ...(DEFAULTS[kind] ?? {}), ...fields };
		await deps.workspace.upsert("inventory", (current) => {
			const dup = findDuplicate(kind, merged, current as unknown as Fields[]);
			if (dup) { id = (dup as unknown as InventoryRecord).id; return undefined; }
			id = ctx.services.ids.newId();
			return [{ v: RECORD_VERSION, id, kind, createdAt: ctx.services.clock.nowIso(), ...merged } as unknown as InventoryRecord];
		});
		return id;
	} catch {
		return undefined;
	}
}

/** Resolve one target to an element id, or leave it as written. */
/**
 * The id of the element this target names, or the target unchanged.
 *
 * "A target naming something nobody mapped cannot be a cell, and silently
 * attaching it to an unrelated element would be worse than leaving it as
 * written" — so the rules in core/target.ts stop rather than guess when two
 * elements fit equally well, and this hands back what it was given.
 */
function resolveTarget(raw: string, index: TargetIndex): string {
	return resolveElementTarget(raw, index) ?? raw;
}


/**
 * Pull a cited evidence file into the workspace from the run's working directory.
 *
 * Returns the workspace-relative path it now lives at, or undefined when there is
 * nothing there to adopt. A path that tries to leave the working directory is
 * refused rather than resolved: record content is agent-authored, and "evidence"
 * is not a licence to copy /etc/shadow into a document a client reads.
 *
 * Binaries are left alone. The Fs port moves text, so copying a screenshot
 * through it would corrupt it silently — the caller reports it as unresolved and
 * names the directory to write it to instead, which is recoverable, while a
 * mangled PNG cited as proof is not.
 */
/**
 * Find a file by basename under `root`, or undefined if it is absent or ambiguous.
 *
 * Bounded deliberately: a review names a file, not a haystack, and an unbounded
 * walk on a large tree would cost more than the location is worth.
 */
/**
 * Source files under `root`, for locating a finding that names no file.
 *
 * Bounded on every axis — depth, count and size — because this runs inside a
 * `record` call and a review is not worth stalling to read a whole repository.
 */
async function readSourceTree(ctx: ToolContext, root: string): Promise<Array<{ path: string; body: string }>> {
	const SRC_EXT = /\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rb|php|java|cs|rs|kt|kts|scala|swift|c|h|cpp|hpp|sql|sh)$/;
	const SKIP = /^(node_modules|vendor|third_party|dist|build|site-packages|testdata)$/;
	const out: Array<{ path: string; body: string }> = [];
	let frontier = [""];
	for (let depth = 0; depth < 6 && frontier.length > 0 && out.length < 600; depth += 1) {
		const next: string[] = [];
		for (const dir of frontier) {
			const entries = await ctx.services.fs.readdir(`${root}${dir ? `/${dir}` : ""}`).catch(() => [] as string[]);
			for (const entry of entries) {
				if (SKIP.test(entry) || entry.startsWith(".")) continue;
				const rel = dir ? `${dir}/${entry}` : entry;
				if (SRC_EXT.test(entry)) {
					if (out.length >= 600) break;
					const body = await ctx.services.fs.readFileIfExists(`${root}/${rel}`).catch(() => undefined);
					// A minified bundle matches everything and identifies nothing.
					if (body !== undefined && body.length <= 400_000) out.push({ path: rel, body });
				} else if (!entry.includes(".")) next.push(rel);
			}
		}
		frontier = next;
	}
	return out;
}

async function findByBasename(ctx: ToolContext, root: string, base: string): Promise<string | undefined> {
	const SKIP = /^(node_modules|vendor|third_party|dist|build|site-packages|\.git)$/;
	let frontier = [""];
	const matches: string[] = [];
	for (let depth = 0; depth < 6 && frontier.length > 0 && matches.length < 2; depth += 1) {
		const next: string[] = [];
		for (const dir of frontier) {
			if (next.length > 400) break;
			const entries = await ctx.services.fs.readdir(`${root}${dir ? `/${dir}` : ""}`).catch(() => [] as string[]);
			for (const entry of entries) {
				if (SKIP.test(entry) || entry.startsWith(".")) continue;
				const rel = dir ? `${dir}/${entry}` : entry;
				if (entry === base) matches.push(rel);
				else if (!entry.includes(".")) next.push(rel);
			}
		}
		frontier = next;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

async function adoptFromCwd(deps: ToolDeps, ctx: ToolContext, rel: string): Promise<string | undefined> {
	if (rel.startsWith("/") || rel.includes("\\")) return undefined;
	if (rel.split("/").some((seg) => seg === "..")) return undefined;
	if (!ctx.cwd) return undefined;
	try {
		const body = await ctx.services.fs.readFileIfExists(`${ctx.cwd.replace(/\/+$/, "")}/${rel}`);
		if (body === undefined || body.includes("\u0000")) return undefined;
		// Strip a leading "evidence/" so the common case round-trips to the very
		// path the agent cited, and the record it is stored on is unchanged.
		return await deps.workspace.writeEvidence(rel.replace(/^evidence\//, ""), body);
	} catch {
		return undefined;
	}
}

/**
 * Where the engagement stands, in one line, appended to what `record` returns.
 *
 * The operator has watched this the whole time — `refreshStatus` redraws the
 * panel on every write, so the human has a live dashboard of surface, coverage
 * and findings. The agent, which is the thing choosing what to do next, could
 * only see it by stopping to ask. So the numbers went one way: the further into
 * an engagement, the more the operator knew about it and the less the agent did.
 *
 * It rides on the tool result rather than in the system prompt on purpose.
 * These numbers move on every write, and a block that changes every turn at the
 * FRONT of the context invalidates the prefix cache behind it every turn — the
 * failure `reviewEviction` (core/extract.ts) exists to prevent. At the tail, on
 * a result that is already unique, the same line costs nothing.
 *
 * Derived from `computeCoverageView`, the same derivation the panel renders, so
 * the number the agent reasons from and the number on the operator's screen
 * cannot drift apart.
 */
async function macroDigest(deps: ToolDeps, surfaceKinds: InventoryKind[]): Promise<string> {
	try {
		const view = await computeCoverageView(deps.workspace, surfaceKinds);
		const inventory = await deps.workspace.read("inventory");
		const surface = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind)).length;
		const parts = [`surface ${surface}`];
		if (view) {
			const outstanding = view.matrix.counts["not-tested"] + view.matrix.counts.blocked;
			parts.push(`coverage ${coveragePercent(view.matrix)}%`, `${outstanding} test cases outstanding`);
		}
		const findings = (await deps.workspace.read("findings")).filter((f) => !isDisposed(f.status)).length;
		if (findings > 0) parts.push(`${findings} findings`);
		const blockers = (await deps.workspace.read("blockers")).filter((b) => b.status === "open").length;
		if (blockers > 0) parts.push(`${blockers} open blockers`);

		// The one nudge that ends. A standing instruction repeated on every call
		// becomes wallpaper; this one appears only while the condition holds —
		// there is a surface to reason about and nothing written down about what
		// the system actually does — and is gone for good once it is answered.
		const model = (await deps.workspace.readModelSections()).size > 0;
		const nudge = !model && surface >= MODEL_PROMPT_AFTER
			? `\nNothing recorded yet about what this system does. \`record kind=model section=what text="..."\` ` +
				`— then \`section=invariants\`, which is where the bugs no checklist lists come from.`
			: "";
		return `\nEngagement: ${parts.join(" · ")}.${nudge}`;
	} catch {
		// Situational awareness is a courtesy on top of a write that already
		// succeeded. It must never turn a recorded finding into a tool error.
		return "";
	}
}

/** Surface elements before the absence of a target model is worth mentioning. */
const MODEL_PROMPT_AFTER = 3;

export function createRecordTool(deps: ToolDeps): ToolDefinition {
	return {
		name: "record",
		label: "record",
		description: RECORD_DESCRIPTION,
		parameters: RECORD_PARAMETERS,
		async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
			const a = asRecord(args);
			const kind = oneOf(a.kind, RECORD_KINDS);
			if (!kind) throw new Error(`record: 'kind' must be one of ${RECORD_KINDS.join(", ")}`);

			// Retiring a record.
			//
			// The format has carried a tombstone since the first version — `read`
			// drops any id whose latest line says deleted — and nothing could write
			// one, so a row recorded by mistake stayed in the count and in the report
			// forever. The only workaround was to re-record it with a status nobody
			// believed, which is how a findings list stops being read.
			//
			// It is deliberately append-only: the tombstone is one more line, every
			// superseded version is still above it in the file, and `deletedReason`
			// says why. A wrong deletion is recoverable by anyone who opens the
			// ledger, which is the property that makes it safe to expose at all.
			if (a.delete === true || str(a.delete) === "true") {
				if (kind === "note" || kind === "evidence" || kind === "model") {
					throw new Error(`record delete: '${kind}' is not a ledger row and has no id to retire. Notes, evidence files and the target model are edited on disk — or, for the model, corrected by recording the section again.`);
				}
				const id = required(str(a.id), "record delete: 'id' is required — name the record to retire.");
				const store = STORE_FOR_KIND[kind];
				const why = str(a.reason);
				let gone: LedgerRecord | undefined;
				await deps.workspace.upsert(store, (current) => {
					const existing = current.find((r) => r.id === id);
					if (!existing) return undefined;
					gone = defined({
						...existing, v: RECORD_VERSION, deleted: true,
						updatedAt: ctx.services.clock.nowIso(), deletedReason: why,
					}) as unknown as LedgerRecord;
					return [gone];
				});
				if (!gone) {
					throw new Error(`record delete: no live ${kind} with id ${id}. Check 'recall ${STORE_FOR_KIND[kind]}' — it may already be deleted.`);
				}
				return text(
					`Deleted ${kind} ${id} (${recordLabel(gone)})${why ? `: ${why}` : ""}. ` +
					"It is gone from every view and every count; the ledger keeps the line, so this is reversible by hand.",
					{ kind, id, deleted: true, ids: [id], created: [] },
				);
			}

			// The target model: one document, revised in place.
			//
			// Deliberately NOT a ledger row. Every ledger kind is an atom that
			// accumulates — a second endpoint never invalidates the first — and the
			// dedup machinery in identity.ts exists to keep it that way. An
			// understanding of the target is the opposite: the third version of
			// "what this system does" REPLACES the second, and a store that kept
			// both would make the agent read two answers and pick one.
			if (kind === "model") {
				const section = (str(a.section) ?? "").trim().toLowerCase();
				if (!section) {
					throw new Error(
						`record model: 'section' is required — one of ${MODEL_SECTIONS.join(", ")}. ` +
						MODEL_SECTIONS.map((sec) => `${sec}: ${MODEL_SECTION_HELP[sec]}`).join("; "),
					);
				}
				if (!(MODEL_SECTIONS as readonly string[]).includes(section)) {
					throw new Error(`record model: unknown section '${section}'. Use one of ${MODEL_SECTIONS.join(", ")}.`);
				}
				const body = required(str(a.text), "record model: 'text' is required — the content of the section.");
				await deps.workspace.writeModelSection(section, body);
				const written = await deps.workspace.readModelSections();
				const missing = MODEL_SECTIONS.filter((sec) => !written.has(sec));
				return text(
					`Target model updated: ${section}. It is carried into every future session, so a later you starts already knowing this.` +
					(missing.length > 0 ? `\nStill blank: ${missing.join(", ")}.` : "") +
					(section === "invariants"
						? "\nEach of these is a hypothesis waiting to be written: ask what breaks it, and record that against the element it breaks on."
						: ""),
					{ kind, section, created: ["model"] },
				);
			}

			if (kind === "note") {
				const body = required(str(a.text), "record note: 'text' is required");
				// A note re-written verbatim is the same note. Nothing keys notes.md,
				// so the only defence against the same observation appearing four
				// times is to look before appending. Compared block by block rather
				// than by substring: a one-line note is often a phrase from a longer
				// one already written, and dropping it would be silent data loss.
				const blocks = (await deps.workspace.readNotes()).split(/^## /m).map((b) => b.replace(/^\S+\n/, "").trim());
				if (blocks.includes(body.trim())) {
					return text("Already noted — not written twice.", { kind, created: [] });
				}
				await deps.workspace.appendNote(body);
				return text("Noted.", { kind, created: ["note"] });
			}

			// Evidence is a file, not a ledger row. Without this the evidence contract
			// is unfulfillable: findings are asked to cite a workspace path, and the
			// model has no way to create one — so it invents plausible filenames it
			// never wrote. Returning the path is the point; it is what gets cited.
			if (kind === "evidence") {
				const name = required(str(a.name), "record evidence: 'name' is required (e.g. \"sqli-login.txt\")");
				const body = required(str(a.content) ?? str(a.text), "record evidence: 'content' is required (the raw output to save)");
				const rel = await deps.workspace.writeEvidence(name, body);
				return text(`Evidence saved to ${rel} — cite this exact path in the finding's evidence[].`, { kind, path: rel });
			}
			// A refutation clears cells, so it must say what was checked.
			//
			// Reporting a bug requires a file, a line, a CWE and a severity. Clearing
			// a class required a sentence — which made "it is safe" structurally
			// cheaper than "it is broken", the wrong way round for a tool whose
			// coverage number is built out of refutations.
			//
			// Measured on filebrowser: "The reviewer confirmed this is by design with
			// proper access controls" cleared 103 cells over the command-execution
			// path the advisory was actually about. One unevidenced sentence, 103
			// cells of false assurance.
			//
			// The bar is deliberately low — name the mechanism you checked — because
			// the goal is to make an empty refutation impossible, not to make an
			// honest one laborious.
			// Earned, never asserted — the same rule as a finding's, and it needs the
			// same delete: the shape builder passes `verification` straight through,
			// so without this a caller could hand in the conclusion it is supposed
			// to have reached.
			if (kind === "hypothesis") delete a.verification;

			// A re-record carrying a basis is a second look at a settled cell, not a
			// first one. Writing it down is what makes the challenge reportable —
			// before this the row came back byte-identical and the work vanished.
			if (kind === "hypothesis" && str(a.id) && strArr(a.basis)?.length) {
				const before = (await deps.workspace.read("hypotheses")).find((h) => h.id === str(a.id));
				if (before) {
					const now = oneOf(a.outcome, HYPOTHESIS_OUTCOMES) ?? before.outcome;
					a.verification = {
						// `stands` when the second pass agreed, `amended` when it moved the
						// verdict — the cell's answer changed, which is the whole point of
						// paying for the look.
						verdict: now === before.outcome ? "stands" : "amended",
						at: ctx.services.clock.nowIso(),
						basis: strArr(a.basis),
						...(typeof a.live === "boolean" ? { live: a.live } : {}),
						...(str(a.reason) ? { notes: str(a.reason) } : {}),
					} satisfies HypothesisRecord["verification"];
				}
			}

			if (kind === "hypothesis" && oneOf(a.outcome, HYPOTHESIS_OUTCOMES) === "refuted") {
				const why = str(a.statement);
				const targets = asList(a.target).length;
				// Only when a statement was actually given. A missing one is the
				// required-field check's business, and stealing its error would tell
				// the agent to write more when the field never arrived at all.
				if (why !== undefined && why.length < 40) {
					throw new Error(
						`record hypothesis: a refutation needs to say what was checked, not just that it was. ` +
						`Got ${why?.length ?? 0} characters. State the mechanism that makes this class inapplicable here ` +
						`— the sanitiser, the parameterised query, the capability check, the absence of the sink — ` +
						`so the cleared cell can be audited later. ` +
						(targets > 1 ? `This call clears ${targets} cells at once, which is exactly why. ` : ""),
					);
				}
			}


			// Targets are resolved before anything is written: the model names what it
			// is looking at, and the ledger keys on ids.
			//
			// A hypothesis whose target resolves to nothing settles no cell, and a
			// review that tested a file it never separately declared as surface is
			// the common case — take eight recorded three tech tags and then wrote
			// seventeen hypotheses against files, so the matrix had no cells at all.
			// Requiring the agent to pre-declare a thing before it may test it is the
			// tool imposing its bookkeeping on the work. So the element is created
			// from the target: recording that something was examined is not
			// invention, it is the claim the hypothesis already makes.
			// HYPOTHESES ONLY. A hypothesis's target must be an element id, because that
			// is what a coverage cell is keyed on. A finding's target must NOT be
			// touched: it carries the location the report and the grader need, and
			// resolving it destroys that. Applying this to both cost take nine its
			// deliverable — "auth_routes.py:22" became element id "53d145", the line
			// number was gone, and 164 findings graded as 5 (recall 0.08) against a key
			// the same run had genuinely found dozens of entries for.
			//
			// This runs BEFORE the bulk branch below, not after. A list of targets
			// that skipped resolution was stored as the labels the model typed, so
			// the same cell existed twice — once keyed on "/api/login" from a bulk
			// refutation and once on the element id from a single call — and the
			// label-keyed copy settled nothing.
			if (kind === "hypothesis") {
				const wanted = asList(a.target).filter((t): t is string => typeof t === "string" && t.trim().length > 0);
				if (wanted.length > 0) {
					const index = targetIndex(await deps.workspace.read("inventory"));
					const resolved: string[] = [];
					for (const t of wanted) {
						const hit = resolveTarget(t, index);
						if (hit !== t) { resolved.push(hit); continue; }
						// The whole target did not match, but the thing it NAMES might
						// already be recorded — "app.py the login flow" and "app.py line
						// 17" are both about app.py. Resolve the extracted name before
						// creating anything, or the second hypothesis about a file makes
						// a second copy of it and splits its coverage across two rows.
						const name = elementNameIn(t);
						if (!name) { resolved.push(t); continue; }
						const byName = resolveTarget(name, index);
						if (byName !== name) { resolved.push(byName); continue; }
						const created = await writeRecord(deps, ctx, "endpoint", { path: name });
						// Index the new element rather than re-reading the whole store per
						// target: a bulk refutation naming forty files would otherwise
						// read the inventory forty times, and two targets naming the same
						// unrecorded file would each create their own copy of it.
						if (created) indexElement(index, name, created);
						resolved.push(created ?? t);
					}
					// Always a list: `asList` normalises it downstream, and assigning
					// resolved[0] here dropped every target but the first whenever the
					// model sent its array as a JSON string.
					a.target = resolved;
				}
			}

			// Coverage is settled one cell at a time, which for a real engagement is
			// O(elements x classes) tool calls — 19 classes over 20 endpoints is 380
			// calls, and no model will make them. So a reviewer's actual unit of
			// reasoning ("these five classes don't apply to this route, for one
			// reason") is expressible in one call: class and target accept lists and
			// the cross product is recorded. Without this, coverage stays at 0% on
			// real runs no matter how thorough the review was.
			if (kind === "hypothesis" && (asList(a.class).length > 1 || asList(a.target).length > 1)) {
				const classes = asList(a.class);
				const targets = asList(a.target);
				if (classes.length === 0 || targets.length === 0) throw new Error("record hypothesis: 'class' and 'target' lists must be non-empty");
				const statement = required(str(a.statement), "record hypothesis: 'statement' is required");
				const outcome = oneOf(a.outcome, HYPOTHESIS_OUTCOMES) ?? "proposed";
				const stamp = ctx.services.clock.nowIso();
				const ids: string[] = [];
				const created: string[] = [];
				await deps.workspace.upsert("hypotheses", (current) => {
					// The cross product is where repeats concentrate: the extractor
					// re-offers the same class verdict over the whole surface once a
					// turn, so a 40-element engagement would gain 40 rows a turn for
					// reasoning it had already recorded. Matching against rows written
					// earlier in THIS call too, since a target list may name one element
					// twice under two spellings.
					const working = [...current] as unknown as Fields[];
					const out: HypothesisRecord[] = [];
					for (const t of targets) {
						for (const c of classes) {
							const patch = defined({
								statement, target: t, class: c, outcome,
								method: str(a.approach) ?? str(a.method), evidence: str(a.evidence),
							});
							const dup = findDuplicate("hypothesis", patch, working);
							if (dup) {
								const merged = defined({
									...mergeRecord("hypothesis", dup, patch),
									v: RECORD_VERSION, id: dup.id as string, kind: "hypothesis", createdAt: dup.createdAt, updatedAt: stamp,
								}) as unknown as HypothesisRecord;
								ids.push(merged.id);
								if (isNoOp(dup, merged as unknown as Fields)) continue;
								working.push(merged as unknown as Fields);
								out.push(merged);
								continue;
							}
							const id = ctx.services.ids.newId();
							const record = defined({
								v: RECORD_VERSION, id, kind: "hypothesis", createdAt: stamp, ...patch,
							}) as unknown as HypothesisRecord;
							working.push(record as unknown as Fields);
							out.push(record);
							ids.push(id);
							created.push(id);
						}
					}
					return out;
				});
				const repeats = ids.length - created.length;
				const owed = outcome === "confirmed" ? CONFIRMED_OWES : "";
				return text(
					`Recorded ${created.length} hypotheses (${targets.length} target(s) x ${classes.length} class(es)), outcome=${outcome}.` +
					(repeats > 0 ? ` ${repeats} cell(s) were already recorded and were updated in place, not duplicated.` : "") +
					owed,
					{ kind, ids, created },
				);
			}


			// A finding that names a source file should name the line in it — asked
			// for, never enforced by refusing the write.
			//
			// The report cites a location and the grader locates a finding by
			// file:line, so "share.go" alone is unciteable and unscoreable. This once
			// threw for that reason, and the cure was worse than the disease: the
			// extractor is told in the same breath "never guess a line number; omit
			// the field instead", so it emits exactly the shape this rejected. On one
			// corpus target it produced eighteen findings across its passes — seven in
			// a single one, two of them naming files that were in the answer key — and
			// every one was thrown away at this line. The run before it recorded 27
			// unlocated findings and scored zero; this turned that into 0 findings and
			// scored zero, having also destroyed the evidence.
			//
			// So it warns and writes. The nudge still reaches the model in the tool
			// result, where it can act on it by reading the file and citing a line,
			// and the finding survives either way. Recall above all: a finding the
			// client needs is not improved by deleting it, and no check here may cost
			// one.
			let unlocated = "";
			if (kind === "finding") {
				const hay = [a.target, a.description, a.repro, a.title, ...(strArr(a.evidence) ?? [])]
					.filter((x): x is string => typeof x === "string").join(" ");
				const SRC = /[\w./-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rb|php|java|cs|rs|kt|kts|scala|swift|c|h|cpp|hpp|sql|sh)\b/;
				const named = SRC.exec(hay);
				// A finding that names identifiers but no file is still locatable: the
				// identifiers live in exactly one file often enough to be worth looking.
				// This is how the finding that correctly identified CVE-2025-52903's
				// mechanism — "FILE and DESTINATION expanded into the hook command" —
				// was recorded with no location at all and dropped before scoring.
				if (!named && ctx.cwd) {
					const hits = sinkHints(hay);
					if (hits.length >= 2) {
						const files = await readSourceTree(ctx, ctx.cwd.replace(/\/+$/, ""));
						const found = locateAcrossFiles(files, hits);
						if (found) {
							a.target = `${found.path}:${found.at.line}`;
							unlocated =
								`\nNo file was named, so it was located from the code: '${found.at.symbol}' and the other ` +
								`identifiers in this finding appear together only in ${found.path}, at line ${found.at.line}. ` +
								`Correct it with record id=<id> target="<file>:<line>" if the sink is elsewhere.`;
						}
					}
				}
				const located = /[\w./-]+\.[A-Za-z]{1,6}:\d+/.test(hay) || /\blines?\s+\d+/i.test(hay);
				if (named && !located) {
					// Before asking, try to answer it from the code. The finding names the
					// file and almost always names the function inside it, and the file is
					// on disk — so look up where that symbol is defined. That is reading,
					// not guessing: deterministic, and silent when the symbol is absent.
					const file = named[0];
					const found = await (async () => {
						if (!ctx.cwd || file.startsWith("/") || file.split("/").some((seg) => seg === "..")) return undefined;
						const root = ctx.cwd.replace(/\/+$/, "");
						const direct = await ctx.services.fs.readFileIfExists(`${root}/${file}`).catch(() => undefined);
						if (direct !== undefined) return { path: file, body: direct };
						// A review says "share.go"; the file is `http/share.go`. Resolving the
						// basename against the tree recovers the finding instead of leaving it
						// unlocated over a prefix the reviewer never had reason to type.
						// Ambiguity is left alone: two files of the same name mean the record
						// does not identify one, and picking either would be a guess.
						const hit = await findByBasename(ctx, root, file.split("/").pop() ?? file);
						if (!hit) return undefined;
						const body = await ctx.services.fs.readFileIfExists(`${root}/${hit}`).catch(() => undefined);
						return body === undefined ? undefined : { path: hit, body };
					})();
					const at = found ? locateSink(found.body, sinkHints(hay)) : undefined;
					if (at && found) {
						// Written into the target so the report and the grader both see it;
						// both read file:line and neither reads prose.
						a.target = `${found.path}:${at.line}`;
						unlocated =
							`\nNo line was given, so it was resolved from the source: '${at.symbol}' is ` +
							`${at.kind === "definition" ? "defined" : "referenced"} at ${found.path}:${at.line}, and the finding ` +
							`was recorded there. Correct it with record id=<id> target="${found.path}:<line>" if the sink is elsewhere.`;
					} else {
						unlocated =
							`\n'${file}' is named but no line is, and no symbol from this finding was found in it. ` +
							`The finding is recorded, but as it stands it cannot be cited precisely in the report and ` +
							`will not be scored. Add the line with record id=<id> target="${file}:42" once you have read ` +
							"the sink. If it genuinely has no single line (a missing control, a design flaw), give the " +
							"file plus the function or route it concerns and say so in the description.";
					}
				}
			}

			// Settling a finding is checked, not taken on trust.
			//
			// `status=refuted` is one word, and without this the model could write it
			// over any finding it felt unsure about — which is precisely the machine
			// for losing real bugs this whole mechanism exists to not be. The burden
			// of proof therefore lives in the tool rather than in the prompt: a
			// refutation needs cited grounds and a live target, a confirmation needs
			// the control case and (for the access-control classes) entitlement, and
			// anything short of either lands on `suspected`.
			//
			// Nothing is rejected and nothing is lost. The write always happens; what
			// the tool decides is which of three retained states it lands in, and it
			// says why.
			let downgrade = "";
			if (kind === "finding") {
				// `verification` is an output of the check below, never an input to it.
				// Accepting one would let a caller hand in the conclusion it is
				// supposed to have earned, which is the one field that must not be
				// forgeable.
				delete a.verification;
				const wanted = oneOf(a.status, FINDING_STATUSES);
				if (wanted === "confirmed" || wanted === "refuted") {
					const existing = str(a.id) ? (await deps.workspace.read("findings")).find((f) => f.id === str(a.id)) : undefined;
					const subject = {
						...(existing ?? {}),
						kind: "finding",
						title: str(a.title) ?? existing?.title ?? "(untitled)",
						severity: oneOf(a.severity, SEVERITIES) ?? existing?.severity ?? "info",
						class: str(a.class) ?? existing?.class,
						status: existing?.status ?? UNVERIFIED_STATUS,
					} as FindingRecord;
					const outcome = judge(subject, {
						verdict: wanted === "confirmed" ? "stands" : "refuted",
						control: str(a.control),
						basis: strArr(a.basis) ?? (str(a.reason) && wanted === "refuted" ? undefined : undefined),
						live: typeof a.live === "boolean" ? a.live : undefined,
						entitlement: str(a.entitlement),
						notes: str(a.reason),
					}, ctx.services.clock.nowIso());
					const patch = verdictPatch(outcome);
					a.status = patch.status;
					a.verification = patch.verification;
					if (outcome.downgraded) {
						downgrade =
							`\nRecorded as ${patch.status}, not ${wanted}: ${outcome.downgraded}\n` +
							"The finding is kept exactly as it was — nothing was lost. Re-run it with the missing " +
							"piece and record the outcome again.";
					}
					if (outcome.blocker) {
						// Written straight to the store rather than through the general
						// path, which is mid-flight on a finding right now. The operator
						// is the only one who can answer this, and the blocker machinery
						// already puts the question in front of them as a dialog.
						let parked: string | undefined;
						await deps.workspace.upsert("blockers", (current) => {
							const dup = current.find((b) => b.status === "open" && b.question === outcome.blocker?.question);
							if (dup) { parked = dup.id; return undefined; }
							parked = ctx.services.ids.newId();
							return [{
								v: RECORD_VERSION, id: parked, kind: "blocker", createdAt: ctx.services.clock.nowIso(),
								type: outcome.blocker?.type, question: outcome.blocker?.question,
								context: outcome.blocker?.context, priority: "high", status: "open",
							} as unknown as BlockerRecord];
						});
						if (parked) downgrade += `\nParked blocker ${parked} so the operator can answer it.`;
					}
					if (outcome.wasReported) {
						downgrade += "\nThis finding was already REPORTED to the client. Changing it now is a conversation with the operator, not an edit — say so before you move on.";
					}
				}
			}

			// A CVSS vector is checked against the version it claims, not taken on
			// trust.
			//
			// pired writes v4.0 and accepts v3.1, and the two are not distinguishable
			// by eye — both are slash-separated pairs. Nearly everything written about
			// CVSS is about v3.1, so v3.1 metrics are what a model reaches for even
			// under a 4.0 label, and that reads as a scored finding right up to the
			// point a client checks it. Relabelling the prefix does not fix it either:
			// Scope is gone in v4.0 and AT is new, which is what the error says.
			//
			// Dropping the field is always offered. A vector is a nicety; the finding
			// is the deliverable, and no check here may cost one.
			if (kind === "finding") {
				const vector = str(a.cvss);
				const complaint = vector === undefined ? undefined : validateCvss(vector);
				if (complaint !== undefined) {
					throw new Error(
						`record finding: ${complaint} Build a v${CVSS_DEFAULT_VERSION} vector at ` +
						"https://www.first.org/cvss/calculator/4-0 (or the v3.1 calculator when the engagement requires v3.1), " +
						"or omit 'cvss' and record the finding without one — severity, cwe and the description are what the report needs.",
					);
				}
			}

			// A class the checklist does not know is silent data loss.
			//
			// `class` is a free string, and the valid ids live in the engagement's
			// checklist, which the tool schema cannot show. So the model guesses:
			// measured on a live run it tried `code-injection` against a checklist
			// spelling it `codeinj`, then `traversal` against `pathtrav`, and spent a
			// third of the session working the difference out from coverage numbers
			// that would not move. Nothing rejected those records — they were written
			// to a cell no checklist class matched, so they simply never counted.
			//
			// Reject instead, and name the ids. One round trip beats an hour of
			// inference from a stuck percentage.
			if (kind === "hypothesis" || kind === "finding") {
				const checklist = await deps.workspace.readChecklist();
				const valid = checklist?.classes.map((c) => c.id) ?? [];
				if (valid.length > 0) {
					const wanted = asList(a.class).filter((c): c is string => typeof c === "string" && c.length > 0);
					const unknown = wanted.filter((c) => !valid.includes(c));
					if (unknown.length > 0) {
						// Suggest by normalised comparison. The observed misses differ by
						// punctuation and truncation ("code-injection" vs "codeinj") but
						// also by which end got dropped ("traversal" vs "pathtrav"), so
						// match on the longest shared run of characters rather than on a
						// shared prefix, which catches the first pair and not the second.
						const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
						const shared = (a2: string, b: string): number => {
							let best = 0;
							for (let i = 0; i < a2.length; i++) {
								for (let j = i + best + 1; j <= a2.length; j++) {
									if (b.includes(a2.slice(i, j))) best = j - i;
									else break;
								}
							}
							return best;
						};
						const near = (x: string): string | undefined => {
							const n = norm(x);
							const exact = valid.find((v) => norm(v) === n);
							if (exact) return exact;
							// An id that is an abbreviation of the guess, or vice versa:
							// "sqli" inside "sqlinjection", "codeinj" inside "codeinjection".
							// Checked first because a shared-run score alone prefers the
							// common English suffix — "sql-injection" scores higher against
							// "reflection" ("ection") than against "sqli".
							const prefix = valid
								.filter((v) => n.startsWith(norm(v)) || norm(v).startsWith(n))
								.sort((p, q) => norm(q).length - norm(p).length)[0];
							if (prefix) return prefix;
							let bestId: string | undefined;
							let bestLen = 3;   // below four characters the "match" is noise
							for (const v of valid) {
								const nv = norm(v);
								const len = shared(n, nv);
								// The run has to be most of the id AND a real part of the
								// guess, or a shared suffix suggests an unrelated class.
								if (len > bestLen && len / nv.length >= 0.5 && len / n.length >= 0.4) {
									bestLen = len; bestId = v;
								}
							}
							return bestId;
						};
						const hints = unknown.map((u) => {
							const guess = near(u);
							return guess ? `${u} (did you mean '${guess}'?)` : u;
						});
						throw new Error(
							`record ${kind}: unknown checklist class: ${hints.join(", ")}. ` +
								`Valid ids for this engagement: ${valid.join(", ")}. ` +
								"A class the checklist does not list settles no coverage cell.",
						);
					}
				}
			}

			// Evidence must resolve before a claim citing it is accepted.
			//
			// Adding `record kind=evidence` gave the model a way to create evidence
			// files, and it started emitting well-formed paths — to files it had not
			// written. Measured across six live runs, evidence backing sat at 0.49:
			// roughly half of all cited paths pointed at nothing. That is worse than
			// the original malformed-text failure, because it looks correct.
			//
			// A finding is a claim in a document a client reads. Citing an artifact
			// that does not exist is a fabrication, so the tool refuses rather than
			// hoping the prompt is persuasive. The error names the fix.
			// Evidence files pulled into the workspace by this call, reported back so
			// the agent learns where its own artifacts actually live.
			const adopted: string[] = [];

			// ...but "does not resolve" was, often enough, the tool and the workspace
			// disagreeing about one word.
			//
			// `evidence/` means two different directories. The workspace's is
			// ~/.pired/engagements/<name>/evidence, and that is what a cited path is
			// resolved against. The agent's SHELL sits in the target — a repo, a scan
			// directory — so `nmap -oA evidence/h7` or `curl > evidence/y7.txt`, which
			// is what ops-evidence taught for months, writes a real file somewhere the
			// check never looks. The agent then cited a path it had genuinely just
			// written and was told it was a fabrication.
			//
			// So resolve before refusing: workspace first, then the run's own working
			// directory, and adopt what is found there. Copying it in is the point —
			// the workspace is what survives the session and the report is written
			// from it, while the target directory is someone else's and may be gone
			// tomorrow. The citation is rewritten to where the file now lives, so the
			// record is true when it is stored rather than true when it was typed.
			const claimed = kind === "finding" ? strArr(a.evidence) ?? [] : kind === "hypothesis" ? [str(a.evidence)].filter((x): x is string => !!x) : [];
			if (claimed.length > 0) {
				const missing: string[] = [];
				const resolved: string[] = [];
				for (const rel of claimed) {
					if ((await deps.workspace.readRelative(rel)) !== undefined) { resolved.push(rel); continue; }
					const adoptedAs = await adoptFromCwd(deps, ctx, rel);
					if (adoptedAs) { resolved.push(adoptedAs); adopted.push(`${rel} -> ${adoptedAs}`); continue; }
					missing.push(rel);
					resolved.push(rel);
				}
				if (missing.length > 0) {
					throw new Error(
						`record ${kind}: evidence path(s) do not resolve: ${missing.join(", ")}. ` +
							`Looked in the engagement workspace (${deps.workspace.dir}) and under the working directory (${ctx.cwd}). ` +
							"Create each with record kind=evidence (it returns the path to cite), write it into " +
							`"${deps.workspace.dir}/evidence/" from bash, or omit the evidence field. ` +
							"Citing a file that does not exist is an unsupported claim.",
					);
				}
				if (adopted.length > 0) {
					a.evidence = kind === "hypothesis" ? resolved[0] : resolved;
				}
			}

			const store = STORE_FOR_KIND[kind];
			const now = ctx.services.clock.nowIso();
			const patch = extractFields(kind, a);
			const existingId = str(a.id);
			const existing = existingId ? (await deps.workspace.read(store)).find((r) => r.id === existingId) : undefined;

			if (!existing) {
				const complete = { ...(DEFAULTS[kind] ?? {}), ...patch };
				for (const field of REQUIRED[kind]) {
					if (complete[field] === undefined) {
						// Name what did arrive. The old message said only that a field was
						// required, which reads as the model's mistake even when the field
						// was stripped from the schema before the model could send it.
						const got = Object.keys(a).filter((k) => k !== "kind").join(", ") || "nothing";
						// Tell the agent how to resolve it. A missing target is not an
						// operator decision — the agent records the surface element itself,
						// or names a raw one — and an error that only states a rule invites
						// it to stop and ask, or to give up and write a note.
						const how = field === "target"
							? " A target is a recorded element id, or a raw string when nothing fits — a file path, a module, a component." +
								" Record the surface element first (kind=endpoint/host/service/param/tech) and pass its id, or pass the raw string." +
								" Do not ask the operator for it, and do not drop the record."
							: "";
						throw new Error(
							`record ${kind}: '${field}' is required, but was not received. Fields received: ${got}.` +
							`${how} If you did send '${field}', the tool schema dropped it — report this rather than working around it.`,
						);
					}
				}
			}

			// The write, and the identity check that decides whether it is a write at
			// all, happen together under the store's lock.
			//
			// An `id` the caller passed is an explicit update and is honoured exactly
			// as sent — that is the escape hatch for correcting a record downward,
			// including past anything the merge below would protect. Everything else
			// is checked against what is already recorded, because the agent asking
			// to create a second copy of something is not making a claim that there
			// are two of them; it is a turn that no longer remembers the first.
			let record: LedgerRecord | undefined;
			let outcome: WriteOutcome = "created";
			let near: LedgerRecord | undefined;
			await deps.workspace.upsert(store, (current) => {
				const byId = existingId ? current.find((r) => r.id === existingId) : undefined;
				if (byId) {
					outcome = "updated";
					record = defined({ ...byId, ...patch, v: RECORD_VERSION, id: byId.id, kind, createdAt: byId.createdAt, updatedAt: now }) as unknown as LedgerRecord;
					return [record];
				}
				const dup = existingId ? undefined : findDuplicate(kind as IdentityKind, patch, current as unknown as Fields[]);
				if (dup) {
					const merged = defined({
						...mergeRecord(kind as IdentityKind, dup as unknown as Fields, patch),
						v: RECORD_VERSION, id: dup.id, kind, createdAt: dup.createdAt, updatedAt: now,
					}) as unknown as LedgerRecord;
					if (isNoOp(dup as unknown as Fields, merged as unknown as Fields)) {
						outcome = "unchanged";
						record = dup as unknown as LedgerRecord;
						return undefined;
					}
					outcome = "merged";
					record = merged;
					return [merged];
				}
				// Same place, overlapping words, nothing that proves they are one bug.
				// Written, then reported: a merge here could drop a real finding, and
				// recall is the one thing that cannot be recovered later.
				if (kind === "finding") near = findNearDuplicate(patch, current as unknown as Fields[]) as unknown as LedgerRecord | undefined;
				const id = existingId ?? ctx.services.ids.newId();
				record = defined({ v: RECORD_VERSION, id, kind, createdAt: now, ...(DEFAULTS[kind] ?? {}), ...patch }) as unknown as LedgerRecord;
				return [record];
			});

			const written = record as LedgerRecord;
			const pulled = adopted.length > 0
				? `\nEvidence copied into the engagement workspace so it outlives this session: ${adopted.join(", ")}. ` +
					"Cite the workspace path from now on, or write straight into it."
				: "";
			// What the report will be missing, said at the moment it can still be
			// fixed cheaply.
			//
			// Not a rejection. A finding recorded without its business impact is
			// still a finding, and refusing it would trade the deliverable for the
			// paperwork — but nothing else in the run will ever mention the gap, and
			// a description-only finding is a bug report a client is asked to
			// translate for themselves. So the row lands and the tool says what is
			// left, by id, in the order a reader needs it.
			const gaps = kind === "finding"
				? (["description", "impact", "remediation"] as const).filter((f) => str((written as unknown as Fields)[f]) === undefined)
				: [];
			const incomplete = gaps.length > 0
				? `\nNot yet report-ready: no ${gaps.join(", no ")}. Add with record id=${written.id} ` +
					`${gaps.map((g) => `${g}="..."`).join(" ")} — impact is what it costs the client in their terms, ` +
					"remediation is the concrete change that fixes it."
				: "";
			const warning = near
				? `\nPossible duplicate of ${near.id} (${recordLabel(near)}) — same location, similar wording, nothing that settles it. ` +
					`Recorded separately rather than risk losing one of them. If they are the same issue, fold the detail into ` +
					`${near.id} with record id=${near.id}, then retire this one with record id=${written.id} delete=true reason="duplicate of ${near.id}".`
				: "";
			// The id that would join the two ledgers, offered rather than demanded.
			//
			// Across a whole engagement not one of twenty findings carried a
			// hypothesisId, so nothing linked a finding to the reasoning that
			// produced it. Coverage does not need the link — it joins by cell — but
			// a reader of the ledger does. Naming the candidate is cheaper than
			// asking for it, and nothing is rejected for its absence.
			let linkage = "";
			// A single hypothesis does not take the cross-product return above, so the
			// same thing has to be said on the way out of the general path.
			if (kind === "hypothesis" && written.kind === "hypothesis" && written.outcome === "confirmed") {
				linkage = CONFIRMED_OWES;
			}
			if (kind === "finding" && written.kind === "finding" && !written.hypothesisId) {
				const match = (await deps.workspace.read("hypotheses")).find((h) =>
					h.outcome === "confirmed" && h.class === written.class
					&& typeof h.target === "string" && h.target === written.target
					&& !h.findingId);
				if (match) {
					linkage = `\nThis looks like the write-up of hypothesis ${match.id}. ` +
						`Link them with record id=${written.id} hypothesisId=${match.id}.`;
				}
			}
			// What this finding has not yet shown, said while the reviewer still has
			// the context to go and show it.
			//
			// The failure this closes: an IDOR was recorded because one principal
			// could read another's object, with nobody having established that the
			// principal was not MEANT to — a share link, a shared tenant, a
			// collaborator role — and it reached the client's report. Re-running the
			// request cannot settle that; the target model or the operator can.
			//
			// Informational, never a refusal. A finding recorded as a lead is worth
			// more than a finding the tool argued the reviewer out of writing, and
			// `suspected` is now a status the report renders honestly on its own.
			let unverified = "";
			if (kind === "finding" && written.kind === "finding" && !isDisposed(written.status)) {
				const evidence: Record<string, string> = {};
				for (const rel of written.evidence ?? []) {
					const body = await deps.workspace.readRelative(rel);
					if (body !== undefined) evidence[rel] = body;
				}
				const gaps = auditFinding({
					finding: written, evidence,
					targetModel: await deps.workspace.readModel().catch(() => undefined),
				});
				const blocking = gaps.filter((g) => g.blocking);
				if (blocking.length > 0) {
					unverified =
						`\nRecorded as ${written.status}. Before this can be confirmed:\n` +
						blocking.map((g) => `- ${g.detail}`).join("\n") +
						`\nChallenge it with \`recall challenge id=${written.id}\`, which returns the brief for this class.`;
				}
				const advisory = gaps.filter((g) => !g.blocking).map((g) => `- ${g.detail}`);
				if (advisory.length > 0) unverified += `\nAlso worth fixing:\n${advisory.join("\n")}`;
			}
			const digest = await macroDigest(deps, deps.surfaceKinds ?? DEFAULT_SURFACE_KINDS);
			return text(recordSummary(kind, written, outcome) + warning + unlocated + pulled + incomplete + linkage + downgrade + unverified + digest, recordDetails(written, outcome));
		},
	};
}

// --- recall -----------------------------------------------------------------

function briefInventory(records: Awaited<ReturnType<Workspace["read"]>>): string {
	return records
		.map((r) => {
			if (r.kind === "endpoint") return `${r.id} endpoint ${r.method} ${r.path}`;
			if (r.kind === "host") return `${r.id} host ${r.value}`;
			if (r.kind === "service") return `${r.id} service ${r.host}:${r.port}`;
			if (r.kind === "param") return `${r.id} param ${r.name}`;
			if (r.kind === "tech") return `${r.id} tech ${r.name}`;
			return `${r.id} ${r.kind}`;
		})
		.join("\n");
}

/**
 * Say what was left out.
 *
 * Every list here is capped, and a capped list rendered without a notice reads
 * as the whole answer: `gaps` on a 500-endpoint engagement showed fifty lines of
 * 2,250 and looked complete. That is the same failure as reporting an empty
 * matrix as "coverage complete" — a view that silently understates the work
 * remaining is worse than one that admits it cannot show it all.
 */
function truncated(shown: number, total: number, noun: string, order?: string): string {
	if (shown >= total) return "";
	return `\n… showing ${shown} of ${total} ${noun}${order ? ` (${order})` : ""}. Raise 'limit' for more.`;
}

export function createRecallTool(deps: ToolDeps): ToolDefinition {
	const surfaceKinds = deps.surfaceKinds ?? DEFAULT_SURFACE_KINDS;

	async function coverageMatrix() {
		const checklist = await deps.workspace.readChecklist();
		if (!checklist) return undefined;
		const inventory = await deps.workspace.read("inventory");
		const elements = inventory
			.filter((r) => surfaceKinds.includes(r.kind as InventoryKind))
			.map((r) => ({ id: r.id, kind: r.kind as InventoryKind }));
		const hypotheses = await deps.workspace.read("hypotheses");
		const openBlockers = (await deps.workspace.read("blockers")).filter((b) => b.status === "open");
		return computeCoverage({ classes: checklist.classes, elements, hypotheses, openBlockers });
	}

	return {
		name: "recall",
		label: "recall",
		description:
			"Read engagement state back — the same views the operator sees. " +
			"Coverage is a TEST PLAN: checklist classes x the surface you recorded, one cell per test case " +
			"(this class, asked of this element). query: " +
			"status (the rollup: surface, coverage %, findings by severity, blockers), " +
			"coverage (the full test plan as a matrix, one row per class), " +
			"surface (one row per recorded element with its coverage bar), " +
			"next (the next test case to run), gaps (test cases not run yet, plus the ones blocked), " +
			"model (the target model: what the system does, its actors, its invariants), " +
			"inventory, hypotheses, findings, loot (handles only), blockers, notes, " +
			"finding (ONE finding in full — pass id — every field as recorded: description, impact, remediation, repro, evidence, cwe, cvss). " +
			"Use 'status' to see where the engagement stands, 'coverage'/'surface' to see WHERE the holes are, " +
			"and 'next'/'gaps' to work the outstanding test cases and avoid quitting early.",
		parameters: {
			type: "object",
			required: ["query"],
			properties: {
				query: { enum: RECALL_QUERIES },
				id: { type: "string", description: "For query=finding, or query=challenge: which finding or hypothesis." },
				class: { type: "string", description: "For query=cleared: only cells of this checklist class." },
				limit: { type: "integer", description: "Max items (default 50)." },
			},
		},
		async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
			const a = asRecord(args);
			const query = oneOf(a.query, RECALL_QUERIES);
			if (!query) throw new Error(`recall: 'query' must be one of ${RECALL_QUERIES.join(", ")}`);
			const limit = num(a.limit) ?? 50;

			switch (query) {
				case "model": {
					const model = (await deps.workspace.readModel()).trim();
					if (model.length > 0) return text(model);
					return text(
						"(no target model recorded)\n" +
						`Write it with record kind=model section=<${MODEL_SECTIONS.join("|")}> text="...":\n` +
						MODEL_SECTIONS.map((sec) => `- ${sec}: ${MODEL_SECTION_HELP[sec]}`).join("\n"),
					);
				}
				case "notes": {
					const notes = (await deps.workspace.readNotes()).trim();
					return text(notes || "(no notes)");
				}
				case "inventory": {
					const inv = await deps.workspace.read("inventory");
					return text(inv.length ? briefInventory(inv.slice(0, limit)) + truncated(Math.min(limit, inv.length), inv.length, "records") : "(no inventory)");
				}
				case "cleared": {
					/**
					 * The cells a refutation settled, oldest first, that nothing has
					 * looked at twice.
					 *
					 * `gaps` and `next` route to `not-tested`, so a `clear` cell is
					 * invisible to both — it is settled, and the router is built to move
					 * on. That is right for planning and wrong for assurance: a wrong
					 * clearance is the missed vulnerability this whole harness is built
					 * against, and it was the one verdict with no way to even enumerate
					 * it, let alone challenge it.
					 *
					 * Oldest first because a cell cleared in the first hour was cleared
					 * by an agent that had not yet read the code it was clearing.
					 */
					const wanted = str(a.class);
					const hyps = await deps.workspace.read("hypotheses");
					const settled = hyps.filter((h) => h.outcome === "refuted");
					const byCell = new Map<string, (typeof settled)[number]>();
					for (const h of settled) {
						// The newest row per cell is the one that counts; anything above
						// it in the file has been superseded.
						byCell.set(`${h.target}\u0000${h.class}`, h);
					}
					const open = [...byCell.values()]
						.filter((h) => h.verification === undefined)
						.filter((h) => !wanted || h.class === wanted)
						.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));

					const rechecked = [...byCell.values()].length - open.length;
					if (open.length === 0) {
						return text(settled.length === 0
							? "No cleared cells yet. Nothing has been ruled out, so there is nothing to re-check."
							: `Every cleared cell has been through a second look (${rechecked}).`);
					}

					const labels = new Map((await deps.workspace.read("inventory")).map((r) => [r.id, elementLabel(r)]));
					const lines = open.slice(0, limit).map((h) =>
						`${h.id} [${h.class}] ${labels.get(String(h.target)) ?? h.target}: ${h.statement}`);
					return text(
						`${open.length} cleared cell(s) nothing has re-checked, oldest first` +
						`${rechecked > 0 ? ` (${rechecked} already re-checked)` : ""}:\n${lines.join("\n")}` +
						truncated(Math.min(limit, open.length), open.length, "cleared cells") +
						"\n\n`recall challenge id=<id>` returns the brief for one. Sample rather than sweep — one per " +
						"class, or the oldest — and hand it to a fresh agent: the job is to break the clearance, and a " +
						"verifier that has read the reasoning behind it agrees with it.",
					);
				}
				case "hypotheses": {
					const hyps = await deps.workspace.read("hypotheses");
					return text(hyps.length ? hyps.slice(0, limit).map((h) => `${h.id} [${h.outcome}] ${h.class} on ${h.target}: ${h.statement}`).join("\n") + truncated(Math.min(limit, hyps.length), hyps.length, "hypotheses") : "(no hypotheses)");
				}
				case "findings": {
					// Open work first, then what was disposed of. A finding the client
					// accepted or the operator dismissed still belongs in the list — it
					// is in the report and someone will ask about it — but it is not
					// what to look at first, and its reason travels with it.
					const all = await deps.workspace.read("findings");
					const fs = [...all.filter((f) => !isDisposed(f.status)), ...all.filter((f) => isDisposed(f.status))];
					return text(fs.length
						? fs.slice(0, limit).map((f) =>
							`${f.id} [${f.severity}/${f.status}] ${f.title} (${f.target})${f.reason ? ` — ${f.reason}` : ""}`,
						).join("\n") + truncated(Math.min(limit, fs.length), fs.length, "findings", "open first")
						: "(no findings)");
				}
				case "challenge": {
					// The brief for challenging one finding, or the queue of what is
					// unchallenged.
					//
					// Deliberately a pull, not a push. Re-running a proof touches a
					// client's production system again — that is traffic, detection risk
					// and load — so nothing here fires on its own; the operator asks for
					// it. The brief is built from the RECORD and the class contract, never
					// from the conversation that produced the finding: the scribe pass,
					// which re-read the agent's own review buffer, cost 2.5x the wall
					// clock and moved precision from 0.059 to 0.038, because a verifier
					// that inherits the finder's reasoning agrees with it.
					const id = str(a.id);
					const all = await deps.workspace.read("findings");
					const model = await deps.workspace.readModel().catch(() => undefined);
					if (!id) {
						// The same predicate the standing brief counts with, so what the
						// block says is waiting and what this hands back cannot disagree.
						const queue = unchallengedQueue(all);
						if (queue.length === 0) return text("Nothing unchallenged. Every live finding has been through a challenge.");
						const lines = queue.slice(0, limit).map((f) => {
							const gaps = auditFinding({ finding: f, targetModel: model }).filter((g) => g.blocking);
							return `${f.id} [${f.severity}/${f.status}] ${f.title}` +
								(gaps.length > 0 ? `\n    needs: ${gaps.map((g) => g.kind).join(", ")}` : "\n    needs: nothing visible without re-running it");
						});
						return text(
							`${queue.length} finding(s) not yet confirmed, worst first:\n${lines.join("\n")}\n\n` +
							"`recall challenge id=<id>` returns the brief for one. Challenge it in a fresh context — " +
							"a verifier that has already read the reasoning behind a claim agrees with it.",
						);
					}
					const found = all.find((f) => f.id === id);
					if (!found) {
						// An id that is not a finding may still be a test case. A cleared
						// cell is the one verdict in this system nothing ever revisits —
						// `refuted` turns the cell `clear` and it counts toward the
						// coverage handed to the client — so it is worth being able to
						// challenge one by name.
						const hyp = (await deps.workspace.read("hypotheses")).find((h) => h.id === id);
						if (!hyp) return text(`No live finding or hypothesis ${id}. Use 'recall findings' or 'recall gaps' for what is there.`);

						const inventory = await deps.workspace.read("inventory");
						const element = inventory.find((r) => r.id === hyp.target);
						const hyps = await deps.workspace.read("hypotheses");
						// Everything the engagement has learned around this cell since the
						// verdict was written. It is what makes a second look worth paying
						// for, and none of it is the reasoning that produced the verdict.
						const neighbours = all.filter((f) =>
							!isDisposed(f.status) && (f.target === hyp.target || (f.class !== undefined && f.class === hyp.class)));
						const siblings = hyps.filter((h) => h.target === hyp.target);
						return text(
							`${hypothesisBrief(hyp, {
								...(element ? { element: elementLabel(element) } : {}),
								...(model ? { targetModel: model } : {}),
								neighbours,
								siblings,
							})}\n\n` +
							"Record the outcome with `record kind=hypothesis id=" + hyp.id + " outcome=refuted|confirmed " +
							"reason=\"...\"` — the grounds go in 'reason', and a confirmation means recording the finding too.",
						);
					}
					const evidence: Record<string, string> = {};
					for (const rel of found.evidence ?? []) {
						const body = await deps.workspace.readRelative(rel);
						if (body !== undefined) evidence[rel] = body;
					}
					const gaps = auditFinding({ finding: found, evidence, targetModel: model });
					return text(
						`${challengeBrief(found, gaps)}\n\n` +
						"Record the outcome with `record id=" + found.id + " status=confirmed|refuted reason=\"...\"` — " +
						"a refutation needs the grounds in 'reason', and the finding is kept either way.",
					);
				}
				case "finding": {
					// One finding, whole.
					//
					// `findings` is a list, one line each, and there was no way for the
					// agent to read back what it had actually written — the full text of
					// a finding was reachable only from the operator's TUI. A pass that
					// rewrites a finding for the report, and any child delegated to do
					// it, has to be able to see the finding first.
					const id = str(a.id);
					if (!id) throw new Error("recall finding: 'id' is required — pass the finding id. Use query=findings for the list.");
					const found = (await deps.workspace.read("findings")).find((f) => f.id === id);
					if (!found) return text(`No live finding ${id}. Use 'recall findings' for what is there.`);
					const lines = [
						`${found.id} [${found.severity}/${found.status}] ${found.title}`,
						`target: ${found.target ?? "(none)"}`,
						`class: ${found.class ?? "(none)"}   cwe: ${found.cwe ?? "(none)"}   cvss: ${found.cvss ?? "(none)"}`,
						`recorded: ${found.createdAt}${found.updatedAt ? ` · updated ${found.updatedAt}` : ""}`,
						...(found.reason ? [`reason: ${found.reason}`] : []),
						"",
						`## Description\n${found.description ?? "(not recorded)"}`,
						`## Business impact\n${found.impact ?? "(not recorded)"}`,
						`## Remediation\n${found.remediation ?? "(not recorded)"}`,
						`## Reproduction\n${found.repro ?? "(not recorded)"}`,
						`## Evidence\n${found.evidence?.length ? found.evidence.join("\n") : "(none cited)"}`,
					];
					return text(lines.join("\n"));
				}
				case "blockers": {
					const bs = (await deps.workspace.read("blockers")).filter((b) => b.status === "open");
					return text(bs.length ? bs.slice(0, limit).map((b) => `${b.id} [${b.priority}] ${b.question}`).join("\n") + truncated(Math.min(limit, bs.length), bs.length, "open blockers") : "(no open blockers)");
				}
				case "loot": {
					const loot = await deps.workspace.read("loot");
					return text(loot.length ? loot.slice(0, limit).map((l) => `${l.handle} (${l.type}${l.username ? ` ${l.username}` : ""}${l.target ? ` @ ${l.target}` : ""})`).join("\n") + truncated(Math.min(limit, loot.length), loot.length, "loot handles") : "(no loot)");
				}
				case "coverage": {
					// The same matrix the operator opens with /coverage, rendered as
					// text. It used to be a counts line plus the vulnerable cells, which
					// told the agent how much was left but never WHERE — so the one view
					// that answers "what have I not looked at" was operator-only.
					const view = await computeCoverageView(deps.workspace, surfaceKinds);
					if (!view) return text("No checklist loaded; cannot compute coverage — the test plan is built from one. Record a checklist or surface elements first.");
					const lines = renderCoveragePanel({
						view, engagement: "", width: PLAIN.width,
						ink: PLAIN.ink, measure: PLAIN.measure, truncate: PLAIN.truncate,
					});
					return text(lines.join("\n"));
				}
				case "surface": {
					// One row per recorded element with its coverage bar across the
					// checklist — the /surface view. `inventory` lists what exists;
					// this says how far each one has actually been taken.
					const view = await computeCoverageView(deps.workspace, surfaceKinds);
					const model = buildBrowserModel({
						engagement: "",
						classes: view?.classes ?? [],
						cells: view?.matrix.cells ?? [],
						inventory: await deps.workspace.read("inventory"),
						hypotheses: await deps.workspace.read("hypotheses"),
						findings: await deps.workspace.read("findings"),
					});
					if (model.surface.length === 0) {
						return text("no surface recorded yet — run recon, or record inventory");
					}
					// reduce, not Math.max(...spread): a spread of a very large surface
					// exceeds the argument limit and throws instead of rendering.
					const wide = model.surface.reduce((a, r) => Math.max(a, r.label.length), 0);
					const rows = model.surface.slice(0, limit).map((r) => {
						const bar = r.statuses.map((st) => CELL_GLYPH[st]).join("");
						const flag = r.findings > 0 ? `  ${r.findings} finding(s)` : "";
						return `${r.id.padEnd(8)} ${r.label.padEnd(Math.min(wide, 48))}  ${bar}  ${r.settled}/${r.askable}${flag}`;
					});
					const legend = `legend: ${Object.entries(CELL_GLYPH).map(([k, g]) => `${g} ${k}`).join("  ")}`;
					const order = model.classes.map((c) => c.id).join(", ");
					const note = truncated(rows.length, model.surface.length, "elements", "least-settled first");
					return text([...rows, "", `bar columns, in order: ${order}`, legend].join("\n") + note);
				}
				case "status": {
					// The engagement rollup the panel shows: how much surface, how much
					// of it settled, what has been found, what is parked.
					const stats = await computeEngagementStats(deps.workspace, surfaceKinds);
					const sev = Object.entries(stats.findings)
						.filter(([, n]) => n > 0)
						.map(([k, n]) => `${k} ${n}`)
						.join(" · ");
					const m = await coverageMatrix();
					const gaps = m ? m.counts["not-tested"] + m.counts.blocked : 0;
					return text([
						`surface    ${stats.surface} element(s)`,
						`coverage   ${stats.coveragePct ?? 0}%${m ? ` · ${m.applicable} askable cells · ${gaps} gap(s)` : " (no checklist)"}`,
						`findings   ${stats.findingsTotal}${sev ? ` (${sev})` : ""}${stats.disposed > 0 ? ` · ${stats.disposed} disposed` : ""}`,
						`blockers   ${stats.blockers} open`,
					].join("\n"));
				}
				case "gaps": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot compute gaps.");
					// An empty matrix has no gaps because it has no cells — which is the
					// opposite of complete. Coverage is over the surface you RECORDED, so
					// a review that recorded none has a denominator of zero, and saying
					// "complete" certifies as finished exactly the run that never
					// started. The panel has said this since it was written; the agent,
					// which is the one that can act on it, was told it was done.
					if (m.applicable === 0) {
						return text("No surface recorded yet, so there are no test cases and nothing to report as covered. Record inventory (hosts/endpoints/params) first — the test plan is checklist classes x the surface you have recorded.");
					}
					const all = findGaps(m);
					const gaps = all.slice(0, limit);
					return text(gaps.length
						? `Test cases not yet settled (element/class):\n${gaps.map((g) => `${g.element}/${g.class}: ${g.reason}`).join("\n")}`
							+ truncated(gaps.length, all.length, "outstanding test cases")
						: "No gaps: every applicable test case has a verdict.");
				}
				case "next": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot pick next work.");
					if (m.applicable === 0) {
						return text("No surface recorded yet, so there is no next test case to pick. Record inventory (hosts/endpoints/params) first — the test plan is checklist classes x the surface you recorded.");
					}
					const next = selectNext(m);
					if (!next) {
						const blocked = m.counts.blocked;
						return text(blocked > 0 ? `No unblocked work: ${blocked} test case(s) blocked pending the operator.` : "No actionable work: every applicable test case has a verdict.");
					}
					return text(`Next test case: ${next.element} for ${next.class}. Record the verdict as a hypothesis either way — a refutation counts.`);
				}
			}
		},
	};
}

export function createCoreTools(deps: ToolDeps): ToolDefinition[] {
	return [createRecordTool(deps), createRecallTool(deps)];
}
