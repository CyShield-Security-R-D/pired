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
 * for something it can already name. The scribe's planner (core/extract.ts) reads
 * the same rules a step earlier and does not even offer what they would fold, so
 * a roll-call that fans across forty elements stops costing forty calls to
 * conclude forty times that nothing changed. Pure module: fields in, verdict out.
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
	// Same words, and one of them names no file. "Hardcoded Telegram bot token"
	// against "repo:acme-app" and against "config.json" is one secret written
	// down twice, and the recording that names nowhere adds nothing that would
	// make it a second bug.
	if (same(patch.title, existing.title) && !(looksLikeFile(here) && looksLikeFile(there))) return true;
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

/**
 * Does this location name a file at all?
 *
 * A finding's target is usually `path/file.ext:line`, but a review that found a
 * secret in a config wrote "repo:acme-app" for one recording and "config.json"
 * for the next. The first names no file — it names the engagement — and two
 * findings with the same title where one of them is not anywhere in particular
 * are one finding recorded twice.
 */
function looksLikeFile(loc: string | undefined): boolean {
	if (loc === undefined) return false;
	return loc.includes("/") || /\.[a-z0-9]{1,6}(:\d+)?$/i.test(loc);
}

/**
 * One target named twice.
 *
 * A hypothesis's target is a coverage cell's key, so two spellings of one thing
 * are two cells — one of which nobody will ever settle. Ids and paths are
 * normalised by `norm`/`normPath`, but a review names things in prose:
 * measured on LinkAce, "setupHttpRequest" and "setupHttpRequest helper
 * function" were recorded as separate cells, as were "CheckLinksCommand" and
 * "CheckLinksCommand link checking".
 *
 * So a target that CONTAINS another, on word boundaries, is the same target.
 * The containment is required to be a whole phrase rather than a substring, so
 * "user" does not swallow "users", and the shorter side must be four characters
 * or more, so an initial or a stray token cannot merge two cells that have
 * nothing to do with each other.
 */
const TARGET_MIN = 4;

function sameTarget(a: unknown, b: unknown): boolean {
	if (same(a, b) || same(a, b, normPath)) return true;
	const x = norm(a);
	const y = norm(b);
	if (x === undefined || y === undefined) return false;
	const [short, long] = x.length <= y.length ? [x, y] : [y, x];
	if (short.length < TARGET_MIN) return false;
	// Word boundaries on both ends: a name at the start, the end, or the middle
	// of the longer phrase, never half of a longer word.
	const at = long.indexOf(short);
	if (at < 0) return false;
	const before = at === 0 ? " " : long[at - 1] ?? " ";
	const after = at + short.length >= long.length ? " " : long[at + short.length] ?? " ";
	return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
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

/**
 * A refutation arriving on a cell that holds an unresolved lead.
 *
 * By rank alone `refuted` outranks `inconclusive`, so any later refutation in
 * the same (target, class) cell closed the lead, whatever mechanism it was
 * about. The cell is the identity, not the claim: two different checks of one
 * class against one element land on one row. Measured on the 2026-09-24 grid:
 * a lead was recorded inconclusive ("cannot verify offline"), a later record in
 * the same cell refuted a different mechanism, and the lead was gone from the
 * ledger with nobody having resolved it. The baseline run confirmed that issue.
 *
 * So an implicit merge leaves the lead open. Closing one is the explicit
 * `record id=<id>` re-record with a basis, which names the lead it settles,
 * never passes through here, and writes a verification saying so.
 */
export function holdsLeadOpen(existing: Fields, patch: Fields): boolean {
	return norm(existing.outcome) === "inconclusive" && norm(patch.outcome) === "refuted";
}

/**
 * The same situation read in the other order: a lead arriving on a cell that a
 * refutation already cleared, saying something the clearance does not.
 *
 * A lead that says what the refutation already said is not new: it is the same
 * claim re-offered. This names only a lead in different words — which is not
 * yet a reason to reopen anything (`reopensLead` decides that), but always one
 * to tell the agent which cell its lead landed on and what that cell says.
 */
export function leadMeetsClearance(existing: Fields, patch: Fields): boolean {
	return norm(existing.outcome) === "refuted"
		&& norm(patch.outcome) === "inconclusive"
		&& norm(patch.statement) !== undefined
		&& !same(existing.statement, patch.statement);
}

/**
 * A clearance somebody re-checked by id and grounded: `record id=<id>
 * basis=[...]` wrote a verification on it that is not itself unsettled.
 */
export function clearanceRechecked(existing: Fields): boolean {
	const v = existing.verification;
	if (typeof v !== "object" || v === null) return false;
	const { verdict, basis } = v as { verdict?: unknown; basis?: unknown };
	return norm(verdict) !== "unresolved" && Array.isArray(basis) && basis.some((b) => str(b) !== undefined);
}

/**
 * Whether a lead reopens the clearance it lands on.
 *
 * `holdsLeadOpen` alone made the outcome depend on which record landed first:
 * inconclusive-then-refuted kept the lead, refuted-then-inconclusive let rank
 * keep a refutation recorded before the lead existed. Reopening on every lead
 * in different words overcorrected, though. Different wording is not a
 * different mechanism, and a clearance is a check of its own cell: a sentence
 * fanned across a whole surface in one call, or re-offered against a clearance
 * that a second look already grounded, is not evidence that any of them missed
 * it.
 *
 * So a lead reopens a clearance only when the clearance was never re-checked
 * by id with a basis, and only on a write that names that one cell by itself —
 * the second is the caller's to say (`mergeRecord`'s `reopen`), since a pure
 * pair of records cannot tell a single write from one cell of a cross product.
 * Everywhere else the clearance stands, and `record` names the cell, quotes the
 * clearance, and gives the by-id call that reopens it on purpose.
 */
export function reopensLead(existing: Fields, patch: Fields): boolean {
	return leadMeetsClearance(existing, patch) && !clearanceRechecked(existing);
}

/** How a merge is being asked for, where the records alone cannot say. */
export interface MergeOptions {
	/**
	 * The write names one hypothesis cell by itself — the only kind of write
	 * allowed to reopen a clearance (`reopensLead`). A cross product, the
	 * extractor's planner re-reading a buffer and a dedupe fold leave it off, so
	 * none of them un-clears a cell.
	 */
	reopen?: boolean;
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
			return sameTarget(patch.target, existing.target) && same(patch.class, existing.class);
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
const UNION_FIELDS = ["tech", "params", "evidence", "options", "blocks", "basis"];

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
 *   - a hypothesis keeps the strongest claim made about its cell, whole — its
 *     outcome, statement, method and evidence together — and an inconclusive
 *     lead is not closed by a refutation that never named it; a lead recorded
 *     after a clearance reopens it only as `reopensLead` allows
 *
 * The explicit `record id=<id>` path does NOT come through here: an update the
 * agent asked for by id is last-write-wins as documented, which is the escape
 * hatch for genuinely correcting a record downward.
 */
/** Every location a finding record carries: its target and any it already kept. */
function asLocations(rec: Fields): string[] {
	// History first, then the current target: a record that has already
	// accumulated locations must keep them in the order they were found, with the
	// newest appended rather than jumping to the front.
	const out: string[] = [];
	if (Array.isArray(rec.locations)) {
		for (const v of rec.locations) { const s = str(v); if (s !== undefined) out.push(s); }
	}
	const t = str(rec.target);
	if (t !== undefined) out.push(t);
	return out;
}

export function mergeRecord(kind: IdentityKind, existing: Fields, patch: Fields, opts: MergeOptions = {}): Fields {
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
		// One bug, several sinks. A public-share exposure lives in share.go AND
		// public.go; a traversal spans the handler and the path builder. The merge
		// used to keep only the newest target, so the reviewer would name three
		// locations across one turn and the ledger would remember the last —
		// measured on filebrowser, where http/share.go:84 was recorded exactly on a
		// truth entry and then overwritten by http/public.go:58 seconds later.
		//
		// Every location the finding has ever carried is kept, so the report can
		// cite them all and the grader can match any.
		const seen = new Set<string>();
		const locations: string[] = [];
		for (const v of [...asLocations(existing), ...asLocations(patch)]) {
			const key = v.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			locations.push(v);
		}
		if (locations.length > 1) merged.locations = locations;
	}
	if (kind === "hypothesis") {
		if (opts.reopen === true && reopensLead(existing, patch)) {
			// The lead wins whole. The clearance's method, evidence and any
			// verification describe a check of something else, and left on the row
			// they would read as the grounds for — or a second look at — a lead
			// they never examined.
			keepClaim(merged, patch, false);
			if (patch.verification === undefined) delete merged.verification;
		} else if (rank(existing.outcome) > rank(patch.outcome) || holdsLeadOpen(existing, patch)) {
			merged.outcome = existing.outcome;
			// The statement has to travel with the outcome it explains, or a cell reads
			// as refuted above the sentence that proposed it.
			if (str(existing.statement) !== undefined) merged.statement = existing.statement;
			// So do the method and the evidence. Without this a held refutation
			// carried its own `method` onto the open lead, and the row read as a
			// lead grounded in the very check that did not settle it — and since the
			// row then differed, the held call wrote a line instead of nothing. A
			// repeat of the SAME claim may still fill what the stored one left out;
			// a different claim may not.
			keepClaim(merged, existing, same(existing.statement, patch.statement) && !holdsLeadOpen(existing, patch));
		}
	}
	return merged;
}

/** What a hypothesis says about its cell beyond the outcome and the sentence. */
const CLAIM_DETAIL = ["method", "evidence", "basis"] as const;

/**
 * Take the method and evidence from the side whose claim the row keeps.
 *
 * `fill` leaves the other side's value where the kept side has none — right
 * only when both sides are the same claim.
 */
function keepClaim(merged: Fields, from: Fields, fill: boolean): void {
	for (const field of CLAIM_DETAIL) {
		if (from[field] !== undefined) merged[field] = from[field];
		else if (!fill) delete merged[field];
	}
}

/**
 * Apply an update the caller asked for by id: last-write-wins, field by field,
 * as `mergeRecord` documents.
 *
 * With the one exception `mergeRecord` makes when a lead reopens a clearance. A
 * hypothesis whose outcome this changes, sent with no verification of its own
 * (the record tool writes one only for a re-check with a basis), is a new
 * claim about the cell. The stored verification, method and evidence describe
 * the check that reached the old outcome. Spread onto the row, a deliberate
 * reopen — `record id=<id> outcome=inconclusive` — kept the clearance's
 * verification, and the open lead read as one that had already had its second
 * look.
 */
export function updateById(kind: string, existing: Fields, patch: Fields): Fields {
	const updated: Fields = { ...existing, ...patch };
	const outcome = norm(patch.outcome);
	if (kind === "hypothesis" && outcome !== undefined && outcome !== norm(existing.outcome)) {
		// The old claim's method and evidence explained the old outcome; a moved
		// cell must not carry a clearance's reasoning under a confirmed verdict.
		keepClaim(updated, patch, false);
		// With no basis there is no new look, so the old check no longer applies.
		if (patch.verification === undefined) delete updated.verification;
	}
	return updated;
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
