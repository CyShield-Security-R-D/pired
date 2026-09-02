/**
 * Record identity: is this thing already in the ledger?
 *
 * The ledger is append-only and every create mints a fresh id, so nothing stopped
 * the same endpoint, the same cell or the same bug being written twice. Three
 * paths produce repeats, and none of them is a mistake the agent can see:
 *
 *   - The scribe (core/extract.ts) reads a review buffer that only grows. The
 *     same analysis is read again on every pass, so the same findings and the
 *     same class verdicts are re-emitted.
 *   - Context is compacted mid-engagement. What was recorded an hour ago is no
 *     longer in front of the agent, so it records it again.
 *   - Subagents work the same surface concurrently and each records what it maps.
 *
 * Duplicates are not merely untidy. A surface element recorded twice splits its
 * coverage across two rows and doubles the denominator; a cell carrying both a
 * stale `proposed` and a later `refuted` reads as "testing" forever, because
 * coverage ranks in-progress above settled; a finding recorded twice is a
 * deliverable that reports the same bug twice.
 *
 * So identity is defined here, once, and `record` refuses to create a second row
 * for something it can already name. Pure module: fields in, verdict out.
 */

import { SEVERITIES, type Severity } from "./ontology.ts";

/** A stored record, or the fields of one about to be written. */
export type Fields = Record<string, unknown>;

/** Kinds that live in a ledger and can therefore be duplicated. */
export type IdentityKind =
	| "host" | "service" | "endpoint" | "param" | "tech"
	| "hypothesis" | "finding" | "blocker" | "loot";

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Lowercased and whitespace-collapsed: the form two spellings of one name share. */
function norm(v: unknown): string | undefined {
	const raw = str(v);
	return raw === undefined ? undefined : raw.toLowerCase().replace(/\s+/g, " ");
}

/** A path as identity: no query, no fragment, no trailing slash. */
function normPath(v: unknown): string | undefined {
	const raw = norm(v);
	if (raw === undefined) return undefined;
	const bare = (raw.split(/[?#]/)[0] ?? raw).replace(/\/+$/, "");
	return bare.length > 0 ? bare : "/";
}

/** A host as identity: no scheme, no path, no trailing dot. */
function normHost(v: unknown): string | undefined {
	const raw = norm(v);
	if (raw === undefined) return undefined;
	return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

/** Ports arrive as 8080 or "8080" depending on how the model serialized them. */
function normPort(v: unknown): string | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return norm(v);
}

/** Both say something, and they say the same thing. */
function same(a: unknown, b: unknown, f: (v: unknown) => string | undefined = norm): boolean {
	const x = f(a);
	return x !== undefined && x === f(b);
}

/**
 * They do not disagree.
 *
 * A qualifier only one of them carries must not split one thing into two rows:
 * the extractor writes `{endpoint, path}` with no host, the agent writes the same
 * route with one, and they are the same route. The merge keeps whichever value is
 * known, so nothing is lost by treating the silent side as agreement.
 */
function compatible(a: unknown, b: unknown, f: (v: unknown) => string | undefined = norm): boolean {
	const x = f(a);
	const y = f(b);
	return x === undefined || y === undefined || x === y;
}

// --- findings ---------------------------------------------------------------

/**
 * `file.ext:line` anywhere in the record — the same coordinate the report cites
 * and the grader matches on. `record kind=finding` already refuses a finding that
 * names a source file without a line, so this is present on anything locatable.
 */
const SOURCE_LOCATION = /([\w./-]+\.[A-Za-z]{1,6}):(\d+)/;

/**
 * Where a finding says the bug is, in a comparable form.
 *
 * Prefers file:line, because that is what two recordings of one bug will agree on
 * even when their prose does not. Falls back to the target as written, which
 * covers findings with no line at all ("no dependency pins", "/admin has no
 * authentication") — two of those with the same title are still the same finding.
 */
export function findingLocation(rec: Fields): string | undefined {
	const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
	const hay = [rec.target, rec.description, rec.repro, rec.title, ...evidence]
		.filter((x): x is string => typeof x === "string")
		.join(" ");
	const m = SOURCE_LOCATION.exec(hay);
	if (m) return `${m[1]?.toLowerCase()}:${m[2]}`;
	return normPath(rec.target);
}

/** Function words carry no identity; dropping them keeps rewordings comparable. */
const STOPWORDS = new Set([
	"a", "an", "the", "in", "on", "at", "of", "to", "for", "via", "and", "or", "is", "are",
	"with", "by", "from", "into", "that", "this", "it", "its", "as", "be", "can", "could",
]);

function tokens(v: unknown): Set<string> {
	const raw = norm(v) ?? "";
	const out = new Set<string>();
	for (const t of raw.split(/[^a-z0-9]+/)) {
		if (t.length > 1 && !STOPWORDS.has(t)) out.add(t);
	}
	return out;
}

/**
 * Two words for the same thing.
 *
 * Security titles are written in abbreviations and inflections — SQLi for SQL,
 * authz for auth, injections for injection — and exact word equality scored the
 * pair this measure exists to catch ("SQLi in login" against "SQL injection in
 * the login handler") at 0.5, under the bar the near-duplicate check applies. A
 * shared prefix of at least three characters covers those without needing a
 * dictionary. Only the near-duplicate WARNING reads this, never the merge, so a
 * loose match costs a line of text and can never fold one finding into another.
 */
function tokenMatches(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 3 && long.startsWith(short);
}

/**
 * How much of the shorter title the longer one already covers, 0..1.
 *
 * Containment rather than Jaccard: "SQLi in login" and "SQL injection in the
 * login handler via the username parameter" are one bug described at two lengths,
 * and a set-symmetric measure scores that pair as unrelated.
 */
export function titleOverlap(a: unknown, b: unknown): number {
	const x = tokens(a);
	const y = tokens(b);
	if (x.size === 0 || y.size === 0) return 0;
	// Counted over the shorter side, so two words of one title matching a single
	// word of the other ("sql" and "sqli" against "sqli") cannot score above 1.
	const [small, large] = x.size <= y.size ? [x, y] : [y, x];
	let shared = 0;
	for (const t of small) {
		for (const u of large) {
			if (tokenMatches(t, u)) { shared += 1; break; }
		}
	}
	return shared / small.size;
}

/**
 * Two locations that name the same place.
 *
 * A review writes "share.go" where the tree has "http/share.go", and both are
 * the same file — so one path being a tail of the other, on a path boundary, is
 * a match. Without this a second sighting under a different prefix became a
 * second finding: measured on LinkAce, one SSRF was recorded six times under
 * `FetchController.php` and `app/Http/Controllers/FetchController.php`.
 *
 * A tail match is required, not merely a shared basename: `auth/user.go` and
 * `api/user.go` are different files and must stay apart.
 */
function sameLocation(a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return true;
	if (a === b) return true;
	const split = (v: string): [string, string | undefined] => {
		const m = /^(.*):(\d+)$/.exec(v);
		return m ? [m[1] as string, m[2]] : [v, undefined];
	};
	const [pa, la] = split(a);
	const [pb, lb] = split(b);
	if (la !== undefined && lb !== undefined && la !== lb) return false;
	const [long, short] = pa.length >= pb.length ? [pa, pb] : [pb, pa];
	return long === short || long.endsWith(`/${short}`);
}

/** Two findings are the same finding when they name the same bug in the same place. */
function sameFinding(patch: Fields, existing: Fields): boolean {
	const here = findingLocation(patch);
	const there = findingLocation(existing);
	// Same words, and nothing says they are in different places.
	if (same(patch.title, existing.title) && sameLocation(here, there)) return true;
	// Same coordinate, same checklist class: that IS one cell, however the two
	// were worded. Requiring both classes to be present keeps two genuinely
	// different bugs on one line (missing authn vs missing authz) apart, since
	// those carry different classes.
	if (here !== undefined && there !== undefined && sameLocation(here, there) && same(patch.class, existing.class)) return true;
	return false;
}

/**
 * A finding that is probably, but not certainly, one already recorded: same
 * place, overlapping words, no class to confirm it with.
 *
 * Reported, never merged. Losing a real finding costs recall, which is the one
 * thing this harness is measured on, so the uncertain case writes the row and
 * tells the agent what it looks like — leaving the judgement to the only party
 * that has read both.
 */
export function findNearDuplicate<T extends Fields>(patch: Fields, existing: T[]): T | undefined {
	const here = findingLocation(patch);
	if (here === undefined) return undefined;
	for (let i = existing.length - 1; i >= 0; i--) {
		const rec = existing[i];
		if (!rec || rec.kind !== "finding") continue;
		if (findingLocation(rec) !== here) continue;
		if (titleOverlap(patch.title, rec.title) >= 0.6) return rec;
	}
	return undefined;
}

// --- hypotheses -------------------------------------------------------------

/**
 * How strong a claim each outcome makes about a cell. A merge keeps the
 * strongest, so re-proposing something already tested cannot un-test it, and a
 * refutation cannot quietly clear a cell that was confirmed vulnerable.
 */
const OUTCOME_RANK: Record<string, number> = {
	proposed: 0, testing: 1, inconclusive: 2, refuted: 3, confirmed: 4,
};

function rank(v: unknown): number {
	return OUTCOME_RANK[norm(v) ?? "proposed"] ?? 0;
}

// --- the matcher ------------------------------------------------------------

function isSame(kind: IdentityKind, patch: Fields, existing: Fields): boolean {
	switch (kind) {
		case "host":
			// A host is its name; an address-only record is identified by address.
			return same(patch.value, existing.value, normHost)
				|| (norm(patch.value) === undefined && norm(existing.value) === undefined && same(patch.ip, existing.ip));
		case "service":
			return same(patch.host, existing.host, normHost)
				&& same(patch.port, existing.port, normPort)
				&& compatible(patch.proto, existing.proto);
		case "endpoint":
			return same(patch.path, existing.path, normPath)
				&& compatible(patch.method, existing.method)
				&& compatible(patch.host, existing.host, normHost);
		case "param":
			return same(patch.name, existing.name) && compatible(patch.endpoint, existing.endpoint);
		case "tech":
			// Version deliberately ignored: nginx 1.18 and nginx are one technology
			// seen twice, and the merge takes the more specific value.
			return same(patch.name, existing.name) && compatible(patch.host, existing.host, normHost);
		case "hypothesis":
			// (target, class) IS the coverage cell. One cell, one row — two rows can
			// only disagree, and the disagreement is resolved by rank, not by order.
			return same(patch.target, existing.target) && same(patch.class, existing.class);
		case "finding":
			return sameFinding(patch, existing);
		case "blocker":
			return same(patch.question, existing.question);
		case "loot":
			return same(patch.handle, existing.handle)
				&& compatible(patch.username, existing.username)
				&& compatible(patch.target, existing.target);
	}
}

/**
 * The record this one would duplicate, if any.
 *
 * Newest first: when a cell has been written before, the most recent row is the
 * one carrying the current state of it.
 */
export function findDuplicate<T extends Fields>(kind: IdentityKind, patch: Fields, existing: T[]): T | undefined {
	for (let i = existing.length - 1; i >= 0; i--) {
		const rec = existing[i];
		// Inventory holds five kinds in one store; an endpoint never duplicates a host.
		if (!rec || rec.kind !== kind) continue;
		if (isSame(kind, patch, rec)) return rec;
	}
	return undefined;
}

// --- merging ----------------------------------------------------------------

/** Fields where a second sighting adds to the first rather than replacing it. */
const UNION_FIELDS = ["tech", "params", "evidence", "options", "blocks"];

/** Prose the report reads. A terser re-recording must not shorten the deliverable. */
const PROSE_FIELDS = ["description", "repro"];

function maxSeverity(a: unknown, b: unknown): Severity | undefined {
	const rankOf = (v: unknown): number => SEVERITIES.indexOf(norm(v) as Severity);
	const x = rankOf(a);
	const y = rankOf(b);
	if (x < 0 && y < 0) return undefined;
	return SEVERITIES[Math.max(x, y)];
}

/**
 * Fold a second recording of the same thing into the first.
 *
 * Newer wins, with three exceptions, all of which exist so that an implicit merge
 * can never be a loss:
 *   - list fields union, so a second sighting adds params and evidence
 *   - severity takes the worse of the two, so a repeat filed as `info` cannot
 *     downgrade a `high`
 *   - description and repro keep whichever is fuller
 *   - a hypothesis keeps the strongest claim made about its cell
 *
 * The explicit `record id=<id>` path does NOT come through here: an update the
 * agent asked for by id is last-write-wins as documented, which is the escape
 * hatch for genuinely correcting a record downward.
 */
export function mergeRecord(kind: IdentityKind, existing: Fields, patch: Fields): Fields {
	const merged: Fields = { ...existing, ...patch };
	for (const field of UNION_FIELDS) {
		const before = existing[field];
		const now = patch[field];
		if (Array.isArray(before) && Array.isArray(now)) merged[field] = [...new Set([...before, ...now])];
	}
	for (const field of PROSE_FIELDS) {
		const before = str(existing[field]);
		const now = str(patch[field]);
		if (before !== undefined && (now === undefined || now.length < before.length)) merged[field] = existing[field];
	}
	if (kind === "finding") {
		const sev = maxSeverity(existing.severity, patch.severity);
		if (sev !== undefined) merged.severity = sev;
	}
	if (kind === "hypothesis" && rank(existing.outcome) > rank(patch.outcome)) {
		merged.outcome = existing.outcome;
		// The statement has to travel with the outcome it explains, or a cell reads
		// as refuted above the sentence that proposed it.
		if (str(existing.statement) !== undefined) merged.statement = existing.statement;
	}
	return merged;
}

/**
 * Nothing new was said.
 *
 * The extractor re-reads the same review every turn, so most repeats carry
 * exactly the fields already stored. Recognising that and writing no line at all
 * keeps the ledger from growing by a full copy of itself once a turn — every one
 * of those lines would be collapsed on read anyway.
 */
export function isNoOp(existing: Fields, merged: Fields): boolean {
	const strip = (r: Fields): string => {
		const { updatedAt: _u, ...rest } = r;
		return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
	};
	return strip(existing) === strip(merged);
}
