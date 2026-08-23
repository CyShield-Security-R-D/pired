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

import { computeCoverage, findGaps, selectNext } from "./coverage.ts";
import {
	BLOCKER_STATUSES,
	BLOCKER_TYPES,
	FINDING_STATUSES,
	HYPOTHESIS_OUTCOMES,
	type InventoryKind,
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
	"note", "host", "service", "endpoint", "param", "tech", "hypothesis", "finding", "blocker", "loot",
] as const;
type RecordKind = (typeof RECORD_KINDS)[number];
type LedgerKind = Exclude<RecordKind, "note">;

const RECALL_QUERIES = [
	"next", "coverage", "gaps", "inventory", "hypotheses", "findings", "loot", "blockers", "notes",
] as const;

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
	hypothesis: ["statement", "target", "class"], finding: ["title", "severity", "target"], blocker: ["question"], loot: ["handle", "secret"],
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
			return defined({ statement: str(a.statement), target: str(a.target), class: str(a.class), method: str(a.approach) ?? str(a.method), outcome: oneOf(a.outcome, HYPOTHESIS_OUTCOMES), evidence: str(a.evidence), findingId: str(a.findingId) });
		case "finding":
			return defined({ title: str(a.title), severity: oneOf(a.severity, SEVERITIES), target: str(a.target), class: str(a.class), cwe: str(a.cwe), cvss: str(a.cvss), description: str(a.description), repro: str(a.repro), evidence: strArr(a.evidence), status: oneOf(a.status, FINDING_STATUSES), hypothesisId: str(a.hypothesisId) });
		case "blocker":
			return defined({ type: oneOf(a.blockerType, BLOCKER_TYPES), question: str(a.question), context: str(a.context), options: strArr(a.options), blocks: strArr(a.blocks), priority: oneOf(a.priority, PRIORITIES), status: oneOf(a.status, BLOCKER_STATUSES), answer: str(a.answer) });
		case "loot":
			return defined({ handle: str(a.handle), type: oneOf(a.lootType, LOOT_TYPES), username: str(a.username), secret: str(a.secret), target: str(a.target), source: str(a.source), notes: str(a.notes) });
	}
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
- host: value (+ip, tech[]); service: host, port (+proto, name); endpoint: path (+host, method, params[], auth); param: name (+endpoint, location); tech: name (+host, version)
- hypothesis: statement, target (surface id), class (checklist id) (+approach, outcome[proposed|testing|confirmed|refuted|inconclusive], evidence)
- finding: title, severity[info|low|medium|high|critical], target (+class, cwe, cvss, description, repro, evidence[], status)
- blocker: question (+blockerType, priority[low|medium|high], options[], blocks[] (work ids this gates))
- loot: handle (e.g. cred:web-admin), secret (+lootType, username, target, source)
Pass 'id' to update an existing record. Confirmed hypotheses should also be recorded as findings.`;

const RECORD_PARAMETERS: JsonSchema = {
	type: "object",
	additionalProperties: true,
	required: ["kind"],
	properties: {
		kind: { enum: RECORD_KINDS, description: "What is being recorded." },
		id: { type: "string", description: "Existing record id to update; omit to create." },
		text: { type: "string" },
		value: { type: "string" }, ip: { type: "string" }, tech: { type: "array", items: { type: "string" } },
		host: { type: "string" }, port: { type: "integer" }, proto: { type: "string" }, name: { type: "string" }, version: { type: "string" },
		endpoint: { type: "string" }, method: { type: "string" }, path: { type: "string" }, params: { type: "array", items: { type: "string" } }, auth: { type: "string" }, location: { type: "string" },
		statement: { type: "string" }, target: { type: "string" }, class: { type: "string" }, approach: { type: "string" }, outcome: { enum: HYPOTHESIS_OUTCOMES },
		title: { type: "string" }, severity: { enum: SEVERITIES }, cwe: { type: "string" }, cvss: { type: "string" }, description: { type: "string" }, repro: { type: "string" }, status: { type: "string" }, evidence: { type: "array", items: { type: "string" } },
		question: { type: "string" }, blockerType: { enum: BLOCKER_TYPES }, priority: { enum: PRIORITIES }, options: { type: "array", items: { type: "string" } }, blocks: { type: "array", items: { type: "string" } }, context: { type: "string" },
		handle: { type: "string" }, lootType: { enum: LOOT_TYPES }, username: { type: "string" }, secret: { type: "string" }, source: { type: "string" }, notes: { type: "string" },
	},
};

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
					if (merged[field] === undefined) throw new Error(`record ${kind}: '${field}' is required`);
				}
				const id = existingId ?? ctx.services.ids.newId();
				record = defined({ v: RECORD_VERSION, id, kind, createdAt: now, ...merged }) as unknown as LedgerRecord;
			}

			await deps.workspace.append(store, record);
			return text(recordSummary(kind, record), { id: record.id, kind });
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

export function createRecallTool(deps: ToolDeps): ToolDefinition {
	const surfaceKinds = deps.surfaceKinds ?? DEFAULT_SURFACE_KINDS;

	async function coverageMatrix() {
		const checklist = await deps.workspace.readChecklist();
		if (!checklist) return undefined;
		const inventory = await deps.workspace.read("inventory");
		const elements = inventory.filter((r) => surfaceKinds.includes(r.kind as InventoryKind)).map((r) => ({ id: r.id }));
		const hypotheses = await deps.workspace.read("hypotheses");
		const openBlockers = (await deps.workspace.read("blockers")).filter((b) => b.status === "open");
		return computeCoverage({ classes: checklist.classes, elements, hypotheses, openBlockers });
	}

	return {
		name: "recall",
		label: "recall",
		description:
			"Read engagement state back. query: next (next untested/actionable cell), coverage, gaps (untested/blocked cells), inventory, hypotheses, findings, loot (handles only), blockers, notes. Use 'next'/'gaps' to stay systematic and avoid quitting early.",
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
					return text(inv.length ? briefInventory(inv.slice(0, limit)) : "(no inventory)");
				}
				case "hypotheses": {
					const hyps = await deps.workspace.read("hypotheses");
					return text(hyps.length ? hyps.slice(0, limit).map((h) => `${h.id} [${h.outcome}] ${h.class} on ${h.target}: ${h.statement}`).join("\n") : "(no hypotheses)");
				}
				case "findings": {
					const fs = await deps.workspace.read("findings");
					return text(fs.length ? fs.slice(0, limit).map((f) => `${f.id} [${f.severity}/${f.status}] ${f.title} (${f.target})`).join("\n") : "(no findings)");
				}
				case "blockers": {
					const bs = (await deps.workspace.read("blockers")).filter((b) => b.status === "open");
					return text(bs.length ? bs.slice(0, limit).map((b) => `${b.id} [${b.priority}] ${b.question}`).join("\n") : "(no open blockers)");
				}
				case "loot": {
					const loot = await deps.workspace.read("loot");
					return text(loot.length ? loot.slice(0, limit).map((l) => `${l.handle} (${l.type}${l.username ? ` ${l.username}` : ""}${l.target ? ` @ ${l.target}` : ""})`).join("\n") : "(no loot)");
				}
				case "coverage": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot compute coverage. Record a checklist or surface elements first.");
					const counts = Object.entries(m.counts).filter(([, n]) => n > 0).map(([s, n]) => `${s}: ${n}`).join(", ");
					const notable = m.cells.filter((c) => c.status === "vulnerable" || c.status === "blocked").map((c) => `${c.element}/${c.class}: ${c.status}`);
					return text([`Coverage (${counts || "empty"})`, ...notable].join("\n"));
				}
				case "gaps": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot compute gaps.");
					const gaps = findGaps(m).slice(0, limit);
					return text(gaps.length ? gaps.map((g) => `${g.element}/${g.class}: ${g.reason}`).join("\n") : "No gaps: coverage complete.");
				}
				case "next": {
					const m = await coverageMatrix();
					if (!m) return text("No checklist loaded; cannot pick next work.");
					const next = selectNext(m);
					if (!next) {
						const blocked = m.counts.blocked;
						return text(blocked > 0 ? `No unblocked work: ${blocked} cell(s) blocked pending the operator.` : "No actionable work: coverage complete.");
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
