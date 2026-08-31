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

import { buildBrowserModel } from "./browser.ts";
import { computeCoverage, findGaps, selectNext } from "./coverage.ts";
import { computeCoverageView, computeEngagementStats } from "./stats.ts";
import { CELL_GLYPH, renderCoveragePanel } from "./coverage-panel.ts";
import {
	BLOCKER_STATUSES,
	BLOCKER_TYPES,
	FINDING_STATUSES,
	HYPOTHESIS_OUTCOMES,
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
	"note", "evidence", "host", "service", "endpoint", "param", "tech", "hypothesis", "finding", "blocker", "loot",
] as const;
type RecordKind = (typeof RECORD_KINDS)[number];
type LedgerKind = Exclude<RecordKind, "note" | "evidence">;

const RECALL_QUERIES = [
	"status", "next", "coverage", "surface", "gaps", "inventory", "hypotheses", "findings", "loot", "blockers", "notes",
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
	finding: { status: "open" },
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
			return defined({ host: str(a.host), method: str(a.method), path: str(a.path), params: strArr(a.params), auth: str(a.auth) });
		case "param":
			return defined({ name: str(a.name), endpoint: str(a.endpoint), location: str(a.location) });
		case "tech":
			return defined({ name: str(a.name), host: str(a.host), version: str(a.version) });
		case "hypothesis":
			return defined({ statement: str(a.statement), target: asList(a.target)[0], class: asList(a.class)[0], method: str(a.approach) ?? str(a.method), outcome: oneOf(a.outcome, HYPOTHESIS_OUTCOMES), evidence: str(a.evidence), findingId: str(a.findingId) });
		case "finding":
			return defined({ title: str(a.title), severity: oneOf(a.severity, SEVERITIES), target: str(a.target), class: str(a.class), cwe: str(a.cwe), cvss: str(a.cvss), description: str(a.description), repro: str(a.repro), evidence: strArr(a.evidence), status: oneOf(a.status, FINDING_STATUSES), hypothesisId: str(a.hypothesisId) });
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
function recordDetails(record: LedgerRecord): Record<string, unknown> {
	const base: Record<string, unknown> = { id: record.id, kind: record.kind };
	if (record.kind === "finding") return { ...base, severity: record.severity, title: record.title };
	return base;
}

function recordSummary(kind: string, record: LedgerRecord): string {
	if (record.kind === "finding") return `Recorded finding ${record.id} [${record.severity}] ${record.title}`;
	if (record.kind === "hypothesis") return `Recorded hypothesis ${record.id} (${record.outcome}) on ${record.target}`;
	if (record.kind === "blocker") return `Parked blocker ${record.id} [${record.priority}]: ${record.question}`;
	if (record.kind === "loot") return `Recorded loot ${record.id} ${record.handle}`;
	return `Recorded ${kind} ${record.id}`;
}

const RECORD_DESCRIPTION = `Record engagement state to the durable workspace. One tool for all state; pick 'kind':
- note: text
- evidence: name, content — saves raw output to the workspace and returns the path to cite (this is how you create the file that 'evidence' fields reference)
- host: value (+ip, tech[]); service: host, port (+proto, name); endpoint: path (+host, method, params[], auth); param: name (+endpoint, location); tech: name (+host, version)
- hypothesis: statement, target (surface id), class (checklist id) (+approach, outcome[proposed|testing|confirmed|refuted|inconclusive], evidence). 'target' and 'class' also accept lists, recording the cross product in one call — use it when one piece of reasoning settles several cells at once.
- finding: title, severity[info|low|medium|high|critical] (+target, class, cwe, cvss, description, repro, evidence[], status)
  A finding is anything worth carrying into the report, not only a proven vulnerability. Use severity=info for an observation that costs nothing now but may matter later — a missing dependency pin, an unpinned base image, a permissive default, a lead you could not finish. 'target' is optional and accepts a recorded element id OR a raw string (a file path, a module, a component) when no element fits; give one when you can, and record the finding either way rather than leaving it in notes.
- blocker: question (+blockerType, priority[low|medium|high], options[], blocks[] (work ids this gates))
- loot: handle (e.g. cred:web-admin), secret (+lootType, username, target, source)
Pass 'id' to update an existing record.

How these connect (this is what makes coverage work, not ceremony):
- Coverage is your checklist's classes x the surface *you have recorded*. A host or endpoint you never recorded has no cells at all, so it can never show as tested and 'recall gaps' cannot route you to it. Record the surface as you discover it.
- A cell is settled by a hypothesis outcome, not by a finding: outcome 'confirmed' marks it vulnerable, 'refuted' marks it clear. Ruling a class out is real work and only counts if you record the refutation — otherwise the cell stays untested no matter how carefully you looked. Settling one cell per call would be hundreds of calls, so record refutations in the shape you reasoned in: one call with a list of classes (and/or targets) and the single reason they share.
- A confirmed hypothesis should also be recorded as a finding, tagged with the same 'class' so the finding maps back to its cell.
- 'evidence' is a workspace-relative PATH, not inline text. Create it with record kind=evidence (which returns the path), then cite that exact path. Paths are verified on write: a finding or hypothesis citing a path that does not resolve is rejected, so cite only what you actually saved, or omit the field.`;

const RECORD_PARAMETERS: JsonSchema = {
	type: "object",
	additionalProperties: true,
	required: ["kind"],
	properties: {
		kind: { enum: RECORD_KINDS, description: "What is being recorded." },
		id: { type: "string", description: "Existing record id to update; omit to create." },
		text: { type: "string" },
		value: { type: "string" }, ip: { type: "string" }, tech: { type: "array", items: { type: "string" } },
		host: { type: "string" }, port: { type: "integer" }, proto: { type: "string" }, name: { type: "string", description: "Name for param/tech; for kind=evidence, the filename to save under (e.g. \"sqli-login.txt\")." }, version: { type: "string" },
		endpoint: { type: "string" }, method: { type: "string" }, path: { type: "string" }, params: { type: "array", items: { type: "string" } }, auth: { type: "string" }, location: { type: "string" },
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
		title: { type: "string" }, severity: { enum: SEVERITIES }, cwe: { type: "string" }, cvss: { type: "string" }, description: { type: "string" }, repro: { type: "string" }, status: { type: "string" }, evidence: { type: "array", items: { type: "string" }, description: "Workspace-relative paths to evidence files you wrote (e.g. [\"evidence/sqli-login.txt\"]). Not inline text." },
		question: { type: "string" }, blockerType: { enum: BLOCKER_TYPES }, priority: { enum: PRIORITIES }, options: { type: "array", items: { type: "string" } }, blocks: { type: "array", items: { type: "string" } }, context: { type: "string" },
		handle: { type: "string" }, lootType: { enum: LOOT_TYPES }, username: { type: "string" }, secret: { type: "string" }, source: { type: "string" }, notes: { type: "string" },
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
 */
function targetIndex(inventory: Awaited<ReturnType<Workspace["read"]>>): Map<string, string> {
	const index = new Map<string, string>();
	const add = (key: string | undefined, id: string): void => {
		if (!key) return;
		const k = key.trim().toLowerCase().replace(/\/+$/, "");
		if (k.length > 0 && !index.has(k)) index.set(k, id);
	};
	for (const r of inventory) {
		const rec = r as unknown as Record<string, unknown>;
		const id = r.id;
		add(id, id);
		const path = typeof rec.path === "string" ? rec.path : undefined;
		const method = typeof rec.method === "string" ? rec.method : undefined;
		add(path, id);
		if (method && path) add(`${method} ${path}`, id);
		add(typeof rec.value === "string" ? rec.value : undefined, id);
		add(typeof rec.name === "string" ? rec.name : undefined, id);
	}
	return index;
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
		const id = ctx.services.ids.newId();
		// Same defaults `record kind=endpoint` applies, so an element created here is
		// indistinguishable from one the agent declared itself.
		await deps.workspace.append("inventory", {
			v: RECORD_VERSION, id, kind, createdAt: ctx.services.clock.nowIso(),
			...(DEFAULTS[kind] ?? {}), ...fields,
		} as unknown as InventoryRecord);
		return id;
	} catch {
		return undefined;
	}
}

/** Resolve one target to an element id, or leave it as written. */
function resolveTarget(raw: string, index: Map<string, string>): string {
	const k = raw.trim().toLowerCase().replace(/\/+$/, "");
	const hit = index.get(k);
	if (hit) return hit;
	// "POST /api/login (line 30)" and "/api/login?id=" both name /api/login.
	const path = /(\/[^\s?#)]*)/.exec(k)?.[1];
	if (path && index.get(path)) return index.get(path) as string;
	// "backend/auth_routes.py:36" names a file. It settles a cell only if that
	// file was recorded as surface — which is right: a target naming something
	// nobody mapped cannot be a cell, and silently attaching it to an unrelated
	// element would be worse than leaving it as written.
	const noLine = k.replace(/:\d+(?:-\d+)?$/, "");
	return index.get(noLine) ?? index.get(noLine.split("/").pop() ?? "") ?? raw;
}

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

			if (kind === "note") {
				const body = required(str(a.text), "record note: 'text' is required");
				await deps.workspace.appendNote(body);
				return text("Noted.", { kind });
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
				for (const t of targets) {
					for (const c of classes) {
						const id = ctx.services.ids.newId();
						await deps.workspace.append("hypotheses", defined({
							v: RECORD_VERSION, id, kind: "hypothesis", createdAt: stamp,
							statement, target: t, class: c, outcome,
							method: str(a.approach) ?? str(a.method), evidence: str(a.evidence),
						}) as unknown as HypothesisRecord);
						ids.push(id);
					}
				}
				return text(`Recorded ${ids.length} hypotheses (${targets.length} target(s) x ${classes.length} class(es)), outcome=${outcome}.`, { kind, ids });
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
			if (kind === "hypothesis" || kind === "finding") {
				const wanted = asList(a.target).filter((t): t is string => typeof t === "string" && t.trim().length > 0);
				if (wanted.length > 0) {
					let index = targetIndex(await deps.workspace.read("inventory"));
					const resolved: string[] = [];
					for (const t of wanted) {
						const hit = resolveTarget(t, index);
						if (hit !== t) { resolved.push(hit); continue; }
						// The whole target did not match, but the thing it NAMES might
						// already be recorded — "app.py the login flow" and "app.py line
						// 17" are both about app.py. Resolve the extracted name before
						// creating anything, or the second hypothesis about a file makes
						// a second copy of it and splits its coverage across two rows.
						const name = kind === "hypothesis" ? elementNameIn(t) : undefined;
						if (!name) { resolved.push(t); continue; }
						const byName = resolveTarget(name, index);
						if (byName !== name) { resolved.push(byName); continue; }
						const created = await writeRecord(deps, ctx, "endpoint", { path: name });
						index = targetIndex(await deps.workspace.read("inventory"));
						resolved.push(created ?? t);
					}
					a.target = Array.isArray(a.target) ? resolved : resolved[0];
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
			const claimed = kind === "finding" ? strArr(a.evidence) ?? [] : kind === "hypothesis" ? [str(a.evidence)].filter((x): x is string => !!x) : [];
			if (claimed.length > 0) {
				const missing: string[] = [];
				for (const rel of claimed) {
					if ((await deps.workspace.readRelative(rel)) === undefined) missing.push(rel);
				}
				if (missing.length > 0) {
					throw new Error(
						`record ${kind}: evidence path(s) do not resolve: ${missing.join(", ")}. ` +
							"Create each with record kind=evidence (it returns the path to cite), or omit the evidence field. " +
							"Citing a file that does not exist is an unsupported claim.",
					);
				}
			}

			const store = STORE_FOR_KIND[kind];
			const now = ctx.services.clock.nowIso();
			const patch = extractFields(kind, a);
			const existingId = str(a.id);
			const existing = existingId ? (await deps.workspace.read(store)).find((r) => r.id === existingId) : undefined;

			let record: LedgerRecord;
			if (existing) {
				record = defined({ ...existing, ...patch, v: RECORD_VERSION, id: existing.id, kind, createdAt: existing.createdAt, updatedAt: now }) as unknown as LedgerRecord;
			} else {
				const merged = { ...(DEFAULTS[kind] ?? {}), ...patch };
				for (const field of REQUIRED[kind]) {
					if (merged[field] === undefined) {
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
				const id = existingId ?? ctx.services.ids.newId();
				record = defined({ v: RECORD_VERSION, id, kind, createdAt: now, ...merged }) as unknown as LedgerRecord;
			}

			await deps.workspace.append(store, record);
			return text(recordSummary(kind, record), recordDetails(record));
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
			"Read engagement state back — the same views the operator sees. query: " +
			"status (the rollup: surface, coverage %, findings by severity, blockers), " +
			"coverage (the full checklist x surface matrix, one row per class), " +
			"surface (one row per recorded element with its coverage bar), " +
			"next (next untested/actionable cell), gaps (untested/blocked cells), " +
			"inventory, hypotheses, findings, loot (handles only), blockers, notes. " +
			"Use 'status' to see where the engagement stands, 'coverage'/'surface' to see WHERE the holes are, " +
			"and 'next'/'gaps' to stay systematic and avoid quitting early.",
		parameters: {
			type: "object",
			required: ["query"],
			properties: {
				query: { enum: RECALL_QUERIES },
				limit: { type: "integer", description: "Max items (default 50)." },
			},
		},
		async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
			const a = asRecord(args);
			const query = oneOf(a.query, RECALL_QUERIES);
			if (!query) throw new Error(`recall: 'query' must be one of ${RECALL_QUERIES.join(", ")}`);
			const limit = num(a.limit) ?? 50;

			switch (query) {
				case "notes": {
					const notes = (await deps.workspace.readNotes()).trim();
					return text(notes || "(no notes)");
				}
				case "inventory": {
					const inv = await deps.workspace.read("inventory");
					return text(inv.length ? briefInventory(inv.slice(0, limit)) + truncated(Math.min(limit, inv.length), inv.length, "records") : "(no inventory)");
				}
				case "hypotheses": {
					const hyps = await deps.workspace.read("hypotheses");
					return text(hyps.length ? hyps.slice(0, limit).map((h) => `${h.id} [${h.outcome}] ${h.class} on ${h.target}: ${h.statement}`).join("\n") + truncated(Math.min(limit, hyps.length), hyps.length, "hypotheses") : "(no hypotheses)");
				}
				case "findings": {
					const fs = await deps.workspace.read("findings");
					return text(fs.length ? fs.slice(0, limit).map((f) => `${f.id} [${f.severity}/${f.status}] ${f.title} (${f.target})`).join("\n") + truncated(Math.min(limit, fs.length), fs.length, "findings", "worst first") : "(no findings)");
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
					if (!view) return text("No checklist loaded; cannot compute coverage. Record a checklist or surface elements first.");
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
						`findings   ${stats.findingsTotal}${sev ? ` (${sev})` : ""}`,
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
						return text("No surface recorded yet, so there is nothing to cover and nothing to report as covered. Record inventory (hosts/endpoints/params) first — coverage is measured over what you have recorded.");
					}
					const all = findGaps(m);
					const gaps = all.slice(0, limit);
					return text(gaps.length
						? gaps.map((g) => `${g.element}/${g.class}: ${g.reason}`).join("\n") + truncated(gaps.length, all.length, "gaps")
						: "No gaps: every askable cell is settled.");
				}
				case "next": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot pick next work.");
					if (m.applicable === 0) {
						return text("No surface recorded yet, so there is no next cell to pick. Record inventory (hosts/endpoints/params) first — the matrix is checklist classes x the surface you recorded.");
					}
					const next = selectNext(m);
					if (!next) {
						const blocked = m.counts.blocked;
						return text(blocked > 0 ? `No unblocked work: ${blocked} cell(s) blocked pending the operator.` : "No actionable work: every askable cell is settled.");
					}
					return text(`Next: test ${next.element} for ${next.class}.`);
				}
			}
		},
	};
}

export function createCoreTools(deps: ToolDeps): ToolDefinition[] {
	return [createRecordTool(deps), createRecallTool(deps)];
}
