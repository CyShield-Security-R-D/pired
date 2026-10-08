/**
 * Reading a `record` call the way agents actually send it, and saying back what
 * of it was not kept.
 *
 * Measured across 538 transcripts of the v6 stage-2 grids (GLM 5.3 Flash,
 * GPT-6 Luna, DeepSeek V4.1 Flash): 4,397 of 52,803 record calls were refused
 * (8.3%), against 0 of 5,446 recall calls. 2,168 of the refusals left out
 * `kind`, most on fields that name exactly one; 990 sent an endpoint's route as
 * `endpoint`, and 304 a model section's text as `value`. The calls that did not
 * fail could still lose what they carried: a finding's `handle` or `notes` was
 * dropped without a word under a reply that said "Recorded", so an agent that
 * tried to link a finding to its hypothesis that way was told it had succeeded,
 * tried again, and finally wrote the link into the notes it was dropped from.
 *
 * Nothing here changes what a correct call does. A field is read under its
 * canonical name only when that name is absent, a kind is inferred only when
 * the fields fit exactly one, and every such reading is said back so the next
 * call uses the right name.
 *
 * A model may also be unable to send a field at all. GLM 5.3 Flash sent a key
 * the schema did not list in 0 of its 19,518 record calls, where DeepSeek and
 * Luna sent `hypothesisId` 1,339 times before the schema listed it. So until it
 * was listed GLM could not link a finding to its hypothesis: it sent the link
 * as `handle: ""`, or as the text `"hypothesisId=f742b8"` in whatever field the
 * schema did list, and one run spent 27 calls in a row on one link before it
 * gave up. RECORD_FIELDS is the schema's list, and tools.test.ts holds the
 * schema and every field the write path reads to it.
 */

import {
	BLOCKER_STATUSES, BLOCKER_TYPES, FINDING_SOURCES, FINDING_STATUSES, HYPOTHESIS_OUTCOMES, LOOT_TYPES, MODEL_SECTIONS,
	PRIORITIES, SETTLE_OUTCOMES, SEVERITIES,
} from "./ontology.ts";

export const RECORD_KINDS = [
	"note", "evidence", "model", "host", "service", "endpoint", "param", "tech", "hypothesis", "finding", "blocker", "loot", "settle",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/** Every field the record tool's schema lists: the only names some models can send. */
export const RECORD_FIELDS = [
	"kind", "id", "hypothesisId", "findingId", "text", "section", "value", "ip", "tech", "host", "port", "proto", "name", "version",
	"endpoint", "method", "path", "params", "auth", "location", "file", "statement", "target", "class", "approach", "outcome", "note",
	"content", "title", "severity", "cwe", "cvss", "description", "impact", "remediation", "repro", "status", "evidence", "control",
	"basis", "guards", "live", "entitlement", "question", "blockerType", "priority", "options", "blocks", "context", "answer", "handle",
	"lootType", "username", "secret", "source", "notes", "delete", "reason",
] as const;

/** The kinds of record that carry an id, as `workspace.read` reports them. */
export type KindsOf = (id: string) => ReadonlySet<string>;

export interface ReadCall {
	/** The call as the write path should see it. */
	args: Record<string, unknown>;
	kind: RecordKind;
	/** Each reading that departed from the call as sent, as "sent → read as". */
	readAs: string[];
	/** What the reading took out of the call, each as "field (why)", for the reply's "Not stored". */
	dropped: string[];
}

/** Fields that take one of a fixed set of values, by kind. */
export const CLOSED_VALUES: Partial<Record<RecordKind, Record<string, readonly string[]>>> = {
	finding: { severity: SEVERITIES, status: FINDING_STATUSES, source: FINDING_SOURCES },
	hypothesis: { outcome: HYPOTHESIS_OUTCOMES },
	blocker: { status: BLOCKER_STATUSES, priority: PRIORITIES, blockerType: BLOCKER_TYPES },
	loot: { lootType: LOOT_TYPES },
	settle: { outcome: SETTLE_OUTCOMES },
	model: { section: MODEL_SECTIONS },
};

/**
 * A field's value written as a field of its own: "hypothesisId=f742b8",
 * "source: reproduced". The text of the `key=value` hints a reply gives,
 * copied into a value.
 */
const ASSIGNMENT = /^\s*([A-Za-z][\w-]*)\s*[:=]\s*["'<[]?([^\s"'<>[\]]+?)["'>\]]?\s*$/;

/** The link field a name in such an assignment means, if it means one. */
function linkField(name: string): "hypothesisId" | "findingId" | undefined {
	const n = name.toLowerCase().replace(/[-_]/g, "");
	if (n === "hypothesisid" || n === "hypothesis") return "hypothesisId";
	if (n === "findingid" || n === "finding") return "findingId";
	return undefined;
}

/** A list however it arrived: an array, or a JSON array sent as a string. */
function listOf(v: unknown): string[] | undefined {
	let raw = v;
	if (typeof v === "string" && /^\s*\[.*\]\s*$/s.test(v)) {
		try {
			raw = JSON.parse(v);
		} catch {
			return undefined;
		}
	}
	return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : undefined;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** "a finding", "an endpoint". */
function some(noun: string): string {
	return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function isKind(v: string): v is RecordKind {
	return (RECORD_KINDS as readonly string[]).includes(v);
}

/** The caller sent a value: not absent, not blank, not an empty list. */
export function given(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "string") return v.trim().length > 0;
	if (Array.isArray(v)) return v.length > 0;
	return true;
}

function text(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function isVerb(v: unknown): boolean {
	return typeof v === "string" && HTTP_METHODS.includes(v.trim().toUpperCase());
}

function present(a: Record<string, unknown>, fields: readonly string[]): string[] {
	return fields.filter((f) => given(a[f]));
}

/**
 * Fields that only one kind takes, so a call that left `kind` out still names
 * it. Shared fields (target, class, status, text, name, host) are deliberately
 * absent: they would make every call look like two kinds.
 */
const SIGNALS: ReadonlyArray<readonly [RecordKind, (a: Record<string, unknown>) => string[]]> = [
	["finding", (a) => present(a, ["title", "severity", "cwe", "cvss", "impact", "remediation", "repro", "entitlement", "hypothesisId"])],
	["hypothesis", (a) => [...present(a, ["statement", "approach", "findingId"]),
		...((HYPOTHESIS_OUTCOMES as readonly string[]).includes(String(a.outcome)) ? ["outcome"] : [])]],
	["endpoint", (a) => [...present(a, ["auth", "endpoint"]), ...(isVerb(a.method) ? ["method"] : []),
		...(typeof a.path === "string" && /^\s*(?:[A-Za-z]+\s+)?\//.test(a.path) ? ["path"] : [])]],
	["model", (a) => present(a, ["section"])],
	["blocker", (a) => present(a, ["question", "blockerType"])],
	["loot", (a) => present(a, ["secret", "lootType", "username"])],
	["service", (a) => present(a, ["port"])],
	["tech", (a) => present(a, ["version"])],
	["param", (a) => present(a, ["location"])],
	["host", (a) => present(a, ["ip"])],
	["evidence", (a) => (given(a.content) && given(a.name) ? ["content", "name"] : [])],
];

function kindSignals(a: Record<string, unknown>): Array<[RecordKind, string[]]> {
	return SIGNALS.map(([kind, fields]) => [kind, fields(a)] as [RecordKind, string[]]).filter(([, fields]) => fields.length > 0);
}

/** Does a call need the ledger to be read? Only when an id, or a missing kind, has to be resolved against it. */
export function needsLedger(raw: Record<string, unknown>): boolean {
	return !(typeof raw.kind === "string" && isKind(raw.kind))
		|| ["id", "handle", "hypothesis", "finding", "hypothesisId", "findingId"].some((f) => given(raw[f]))
		|| Object.values(raw).some((v) => typeof v === "string" && linkField(ASSIGNMENT.exec(v)?.[1] ?? "") !== undefined);
}

function rename(a: Record<string, unknown>, from: string, to: string, readAs: string[]): void {
	if (given(a[to]) || !given(a[from])) return;
	a[to] = a[from];
	delete a[from];
	readAs.push(`'${from}' → '${to}'`);
}

/**
 * Settle the call's kind and the names of its fields. Throws when the kind
 * cannot be told: guessing between two kinds would write a row nobody asked for.
 */
export function readRecordCall(raw: Record<string, unknown>, kindsOf: KindsOf = () => new Set()): ReadCall {
	const a: Record<string, unknown> = { ...raw };
	const readAs: string[] = [];
	const owns = (id: string, kind: string): boolean => kindsOf(id).has(kind);

	let kind: RecordKind;
	const asked = text(a.kind);
	if (asked !== undefined && isKind(asked)) {
		kind = asked;
	} else if (asked !== undefined && isKind(asked.toLowerCase())) {
		kind = asked.toLowerCase() as RecordKind;
		readAs.push(`kind '${asked}' → kind=${kind}`);
	} else if (asked !== undefined && isVerb(asked)) {
		// `kind=POST`: the model reached for the verb of the route it was recording.
		kind = "endpoint";
		if (!given(a.method)) a.method = asked.toUpperCase();
		readAs.push(`kind '${asked}' → kind=endpoint method=${String(a.method)}`);
	} else {
		const id = text(a.id);
		const owners = id ? [...kindsOf(id)].filter(isKind) : [];
		const signals = kindSignals(a);
		if (owners.length === 1) {
			kind = owners[0] as RecordKind;
			readAs.push(`no kind → kind=${kind} (${id} is ${some(kind)})`);
		} else if (signals.length === 1) {
			const [only, fields] = signals[0] as [RecordKind, string[]];
			kind = only;
			readAs.push(`no kind → kind=${kind} (from ${fields.join(", ")})`);
		} else {
			// A settle is never inferred: it ends the session's account of itself.
			// But an outcome only a settle takes says which kind was meant, and the
			// refusal names it rather than saying no field belongs to one kind.
			const settling = typeof a.outcome === "string" && (SETTLE_OUTCOMES as readonly string[]).includes(a.outcome.trim().toLowerCase());
			const why = settling
				? `outcome=${a.outcome} is a settle's, and a settle is only recorded when the call says kind=settle`
				: signals.length === 0
				? "no field in it belongs to one kind only"
				: `its fields fit more than one kind: ${signals.map(([k, f]) => `${k} (${f.join(", ")})`).join("; ")}`;
			throw new Error(
				`record: ${asked === undefined ? "'kind' is missing" : `'${asked}' is not a kind`}, and ${why}. ` +
					`Send kind= one of ${RECORD_KINDS.join(", ")} with the fields that kind takes. Nothing was recorded.`,
			);
		}
	}
	a.kind = kind;

	if (kind === "endpoint") {
		if (typeof a.endpoint === "string") rename(a, "endpoint", "path", readAs);
		// "POST /api/login" in one field: the method and the route, as a request line reads.
		const line = typeof a.path === "string" ? /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(a.path) : null;
		if (line && isVerb(line[1]) && (!given(a.method) || String(a.method).toUpperCase() === line[1]!.toUpperCase())) {
			readAs.push(`path '${String(a.path).trim()}' → method=${line[1]!.toUpperCase()} path=${line[2]}`);
			a.method = line[1]!.toUpperCase();
			a.path = line[2];
		}
	}
	if (kind === "model") {
		rename(a, "value", "text", readAs);
		rename(a, "content", "text", readAs);
	}

	// A closed value in the wrong case: severity "High" is high. Read any other
	// way it was refused as "'severity' is required, but was not received" — and
	// the call had sent it.
	for (const [field, allowed] of Object.entries(CLOSED_VALUES[kind] ?? {})) {
		const v = a[field];
		if (typeof v !== "string" || allowed.includes(v)) continue;
		const low = v.trim().toLowerCase();
		if (!allowed.includes(low)) continue;
		a[field] = low;
		readAs.push(`${field} '${v}' → ${field}=${low}`);
	}
	if (kind === "service" && typeof a.port === "string" && /^\s*\d{1,5}\s*$/.test(a.port)) {
		readAs.push(`port '${a.port.trim()}' → port=${Number(a.port)}`);
		a.port = Number(a.port);
	}

	const dropped: string[] = [];
	if (kind === "hypothesis") {
		// The schema lists `evidence` as a list, because a finding keeps one; a
		// hypothesis keeps a single path. 2,350 of the grids' hypothesis calls sent
		// the list the schema asked for, and every one was dropped unread under a
		// reply that said "Recorded".
		const paths = listOf(a.evidence);
		if (paths && paths.length > 0) {
			a.evidence = paths[0];
			if (paths.length > 1) {
				dropped.push(`evidence ${JSON.stringify(paths.slice(1))} (a hypothesis keeps one evidence path, so only ${paths[0]} was kept; cite the others in basis, or on the finding)`);
			}
		}
	}

	// The two ends of a finding↔hypothesis link, under whatever name the id came in.
	const link = kind === "finding" ? { self: "finding", other: "hypothesis", field: "hypothesisId" }
		: kind === "hypothesis" ? { self: "hypothesis", other: "finding", field: "findingId" } : undefined;
	if (link) {
		for (const alias of [`${link.other}_id`, `${link.other}ID`, `${link.other}-id`]) rename(a, alias, link.field, readAs);
		for (const field of [link.other, "handle"]) {
			const v = text(a[field]);
			if (v && owns(v, link.other) && !given(a[link.field])) {
				a[link.field] = v;
				delete a[field];
				readAs.push(`${field}=${v} → ${link.field}=${v} (${v} is ${some(link.other)})`);
			}
		}
		// The link written as text into a field: handle="hypothesisId=f742b8",
		// host="hypothesisId: f742b8". Read only when the id is one the ledger
		// holds as the other kind, so no other text is ever taken for a link.
		for (const [field, value] of Object.entries(a)) {
			const m = typeof value === "string" ? ASSIGNMENT.exec(value) : null;
			if (!m || linkField(m[1]!) !== link.field || !owns(m[2]!, link.other)) continue;
			if (field !== link.field && given(a[link.field])) continue;
			a[link.field] = m[2];
			if (field !== link.field) delete a[field];
			readAs.push(`${field} '${String(value).trim()}' → ${link.field}=${m[2]}`);
		}
		const id = text(a.id);
		if (id && !owns(id, link.self) && owns(id, link.other)) {
			delete a.id;
			if (!given(a[link.field])) {
				a[link.field] = id;
				readAs.push(`id=${id} → ${link.field}=${id} (${id} is ${some(link.other)}, not ${some(link.self)}; this records ${some(link.self)} linked to it)`);
			} else {
				readAs.push(`id=${id} dropped (${id} is ${some(link.other)}, not ${some(link.self)}; this records a new ${link.self})`);
			}
		}
	}

	if (kind === "finding") {
		// Where the bug is, under the name the surface kinds use for it. 464 of the
		// grids' finding calls put a location in `file` or `location`, which a
		// finding does not keep; 90 of them sent no target, so the finding was
		// left with no location to cite or score.
		rename(a, "file", "target", readAs);
		rename(a, "location", "target", readAs);
	}

	if (kind !== "loot") {
		// A record's own id, sent as the one field the schema shows that looks like a name.
		const handle = text(a.handle);
		if (handle && owns(handle, kind) && !given(a.id)) {
			a.id = handle;
			delete a.handle;
			readAs.push(`handle=${handle} → id=${handle}`);
		}
	}

	// An id that belongs to another kind cannot be updated as this one. Kept, it
	// minted a second row under the first's id, in another store.
	const id = text(a.id);
	if (id && kindsOf(id).size > 0 && !owns(id, kind) && !["note", "evidence", "model", "settle"].includes(kind)) {
		delete a.id;
		readAs.push(`id=${id} dropped (${id} is ${some([...kindsOf(id)].join("/"))}, not ${some(kind)}; this records a new ${kind})`);
	}

	return { args: a, kind, readAs, dropped };
}

/**
 * Take out a finding↔hypothesis link that names no record of the other kind,
 * and say why. Kept, it was stored as written — a placeholder, a typo, a
 * finding's own id — and the row claimed a link that led nowhere.
 *
 * Applied by the record tool only. The child gate reads the call without it,
 * because its own refusal for a verifier naming no hypothesis says more.
 */
export function unknownLinks(args: Record<string, unknown>, kind: RecordKind, kindsOf: KindsOf): string[] {
	const link = kind === "finding" ? { field: "hypothesisId", other: "hypothesis", list: "recall hypotheses" }
		: kind === "hypothesis" ? { field: "findingId", other: "finding", list: "recall findings" } : undefined;
	const v = link ? text(args[link.field]) : undefined;
	if (!link || v === undefined || kindsOf(v).has(link.other)) return [];
	delete args[link.field];
	const is = [...kindsOf(v)];
	const why = is.length > 0 ? `${v} is ${some(is.join("/"))}, not ${some(link.other)}` : `no ${link.other} has the id ${v}`;
	return [`${link.field}=${JSON.stringify(v)} (${why}; \`${link.list}\` lists their ids)`];
}

/** What the write path did with a call's fields: read them, or threw them away first. */
export interface Reads {
	read: Set<string>;
	/** Deleted before anything read it: the write path's way of refusing a field. */
	discarded: Set<string>;
}

/** Wrap the call so the write path's reads are seen: a field it never reads, it never stored. */
export function trackReads(args: Record<string, unknown>): { args: Record<string, unknown>; reads: Reads } {
	const reads: Reads = { read: new Set(), discarded: new Set() };
	const proxy = new Proxy(args, {
		get(target, key, receiver) {
			if (typeof key === "string") reads.read.add(key);
			return Reflect.get(target, key, receiver);
		},
		has(target, key) {
			if (typeof key === "string") reads.read.add(key);
			return Reflect.has(target, key);
		},
		deleteProperty(target, key) {
			if (typeof key === "string" && !reads.read.has(key)) reads.discarded.add(key);
			return Reflect.deleteProperty(target, key);
		},
	});
	return { args: proxy, reads };
}

/** Fields pired writes itself. One sent with a call is never taken from it. */
const HARNESS_FIELDS: Record<string, string> = {
	pass: "pired stamps which pass found a row",
	by: "pired stamps who wrote a row",
	verification: "a verdict is earned by the challenge checks, not sent",
};

/** What a finding's verdict is judged on (tools.ts). */
const VERDICT_INPUTS = ["control", "entitlement", "live", "basis", "path", "guards"];

function whyNotKept(field: string, kind: RecordKind): string {
	const own = HARNESS_FIELDS[field];
	if (own) return own;
	if (field === "handle") {
		return "only kind=loot has a handle; to change a record pass id=<its id>" +
			(kind === "finding" ? ", and to link the hypothesis this writes up pass hypothesisId=<its id>" : "");
	}
	if (kind === "finding" && field === "notes") return "a finding has no notes; put it in description, or record kind=note";
	if (kind === "finding" && field === "approach") return "approach belongs to a hypothesis; say how it was found in description or repro";
	if (kind === "finding" && ["file", "location", "host"].includes(field)) return "a finding's location goes in target, as file:line";
	if (kind === "endpoint" && field === "endpoint") return "an endpoint's route goes in path, which this call also sent; 'endpoint' is the endpoint a param belongs to";
	// A hypothesis keeps its grounds in basis (ADR-040). These are the fields the
	// grids sent it most that it does not keep: path 1,741 times, note 852,
	// control 242, reason 145, notes 78.
	if (kind === "hypothesis" && (field === "note" || field === "notes")) return "a hypothesis has no notes; what you checked goes in statement, and the lines it rests on in basis";
	if (kind === "hypothesis" && field === "reason") return "a hypothesis keeps no reason; say it in statement, and put the lines it rests on in basis";
	// Verdict inputs, read only on the paths that judge a verdict (tools.ts). A
	// call that takes none of them keeps none of them.
	if (kind === "finding" && VERDICT_INPUTS.includes(field)) return "read only when this call settles the finding's status, or records a challenge on it by id";
	if (kind === "hypothesis" && field === "live") return "kept only when re-checking a recorded hypothesis by id";
	if (kind === "hypothesis" && VERDICT_INPUTS.includes(field)) return "a verdict input for a finding; a hypothesis keeps the lines it rests on in basis, each as 'file:line: verbatim text'";
	if (field === "answer") return "only kind=blocker keeps an answer";
	return `not a field a kind=${kind} call keeps`;
}

/**
 * What the call carried that the write did not keep: fields the write path
 * never read or discarded unread, and values outside the set a field takes.
 * `args` is the call as it was before the write, which deletes and rewrites.
 */
export function notKept(args: Record<string, unknown>, reads: Reads, kind: RecordKind): string[] {
	const out: string[] = [];
	for (const field of Object.keys(args)) {
		if (field === "kind" || !given(args[field])) continue;
		if (!reads.read.has(field) || reads.discarded.has(field)) {
			// A field whose text is another field's assignment — host="source=reproduced"
			// — was meant as that field, and the reply says so by name.
			const m = typeof args[field] === "string" ? ASSIGNMENT.exec(args[field] as string) : null;
			const meant = m && (RECORD_FIELDS as readonly string[]).includes(m[1]!) && m[1] !== field ? m[1]! : undefined;
			out.push(meant
				? `${field} (its text ${JSON.stringify(String(args[field]).trim())} is a field of its own: send ${meant} as its own field, ${meant}=${m![2]})`
				: `${field} (${whyNotKept(field, kind)})`);
			continue;
		}
		const allowed = CLOSED_VALUES[kind]?.[field];
		if (allowed && !allowed.includes(String(args[field]))) {
			out.push(`${field}=${JSON.stringify(args[field])} (not one of ${allowed.join(", ")})`);
		}
	}
	return out;
}

/**
 * The lines a successful write adds: what was not kept goes first, where it
 * cannot be missed. `wrote` is false when the call changed nothing, and then
 * the reply does not say the rest was recorded: 146 replies in the grids said
 * both that and "nothing was written".
 */
export function keptReport(readAs: readonly string[], dropped: readonly string[], wrote = true): { before: string; after: string } {
	const rest = wrote ? "The rest of this call was recorded.\n" : "";
	return {
		before: dropped.length === 0 ? ""
			: dropped.length === 1 ? `Not stored: ${dropped[0]}.${rest ? ` ${rest}` : "\n"}`
			: `Not stored:\n${dropped.map((d) => `- ${d}`).join("\n")}\n${rest}`,
		after: readAs.length > 0 ? `\nRead this call as: ${readAs.join("; ")}. Use the names on the right next time.` : "",
	};
}

const PLACEHOLDER: Record<string, string> = {
	statement: "\"<one sentence: the weakness you suspect or ruled out, and where>\"",
	target: "\"<element id, or the file it concerns>\"",
	class: "<checklist class id>",
	title: "\"<short title of the flaw>\"",
	severity: "<info|low|medium|high|critical>",
	path: "\"</the/route>\"",
	text: "\"<the content>\"",
	value: "\"<hostname or IP>\"",
	question: "\"<what you need decided>\"",
	secret: "\"<the secret>\"",
	handle: "\"<a name for it, e.g. cred:web-admin>\"",
};

const SHORT = 60;

function shown(v: unknown): { text: string; cut: boolean } {
	const raw = typeof v === "string" ? v : JSON.stringify(v);
	const cut = raw.length > SHORT;
	const body = cut ? `${raw.slice(0, SHORT)}…` : raw;
	return { text: typeof v === "string" ? JSON.stringify(body) : body, cut };
}

/** A required field that did not arrive, or arrived in a form its kind cannot use. */
const REQUIRED_REFUSAL = /^record (\w+): '(\w+)' (?:is required|was sent as)/;

/** For "'<field>' is required": the call to send instead, built from the one that was sent. */
export function correctedCall(message: string, args: Record<string, unknown>): string {
	const m = REQUIRED_REFUSAL.exec(message);
	if (!m) return "";
	const [, kind, field] = m as unknown as [string, string, string];
	let cut = false;
	const parts = [`kind=${kind}`];
	for (const [key, value] of Object.entries(args)) {
		if (key === "kind" || key === field || !given(value)) continue;
		const s = shown(value);
		cut ||= s.cut;
		parts.push(`${key}=${s.text}`);
	}
	parts.push(`${field}=${PLACEHOLDER[field] ?? `"<${field}>"`}`);
	return `\nSend instead: record ${parts.join(" ")}` + (cut ? `\n(Values over ${SHORT} characters are cut short above; send them in full.)` : "");
}

function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(v) ?? "undefined";
}

/** A refusal's reason without the parts that change from call to call. */
function reasonOf(message: string): string {
	const first = message.split("\n")[0] ?? "";
	return (REQUIRED_REFUSAL.exec(first)?.[0] ?? first.replace(/Fields received:.*$/, "")).trim();
}

/**
 * Refused calls, remembered long enough to notice the same mistake coming back.
 *
 * Identical resends were rare in the grids (one run resent one call three
 * times). The common pattern was the same mistake on the next call, and the
 * next: 394 runs of three or more consecutive refusals for one reason, 2,976
 * refused calls in all, the longest 39 endpoints in a row each sent with
 * `endpoint` for `path`. Each refusal read as news; none said it was the last
 * one again.
 *
 * A call that goes through can loop too, when it changes nothing: one GLM run
 * sent the same id-only update on one finding 27 times, each reply a success.
 * 56 runs of two or more such calls in a row came back from the grids'
 * replay, and no reply said the last one had changed nothing either.
 */
export function refusalMemory(): {
	refused(args: Record<string, unknown>, error: unknown, readAs?: readonly string[]): Error;
	/** A call went through. Pass the record it left unchanged, if it changed nothing; returns the line to add. */
	accepted(unchangedOn?: string): string;
} {
	let lastCall = "";
	let lastReason = "";
	let same = 0;
	let times = 0;
	let idleOn = "";
	let idle = 0;
	return {
		refused(args, error, readAs = []) {
			const message = error instanceof Error ? error.message : String(error);
			const call = `${canonical(args)}\n${message}`;
			const reason = reasonOf(message);
			times = call === lastCall ? times + 1 : 1;
			same = reason === lastReason ? same + 1 : 1;
			lastCall = call;
			lastReason = reason;
			const read = readAs.length > 0 ? `\nRead this call as: ${readAs.join("; ")}.` : "";
			const again = times > 1
				? `\nThis exact call has now been refused ${times} times. Sending it again unchanged will be refused again: change what the error names.`
				: same > 1
					? `\nThe last ${same} record calls were refused for this same reason. Fix it in the next call, and in any others you are about to send the same way.`
					: "";
			const out = new Error(message + correctedCall(message, args) + read + again);
			if (error instanceof Error && error.stack) out.stack = error.stack;
			return out;
		},
		accepted(unchangedOn) {
			lastCall = "";
			lastReason = "";
			same = 0;
			times = 0;
			if (unchangedOn === undefined) {
				idleOn = "";
				idle = 0;
				return "";
			}
			idle = unchangedOn === idleOn ? idle + 1 : 1;
			idleOn = unchangedOn;
			return idle > 1
				? `The last ${idle} calls on ${unchangedOn} changed nothing. Sent the same way, the next will change nothing too: send what this reply names, under the name it gives.\n`
				: "";
		},
	};
}
