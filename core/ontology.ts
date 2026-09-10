/**
 * pired engagement ontology.
 *
 * TypeScript types and schema-version constants for the durable workspace
 * formats. This module mirrors FORMAT.md exactly and is the single source of
 * truth for record shapes in code.
 *
 * Constraints (see PLAN.md §3.1):
 * - Pure types + constants. No runtime behavior beyond the frozen enum arrays.
 * - Zero imports. `core/` must never depend on pi or any adapter.
 * - Erasable TypeScript only (no enums/namespaces), so it runs under Node
 *   type-stripping and any bundler.
 */

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Workspace-level format version, recorded in `manifest.json`. */
export const FORMAT_VERSION = 1;

/** Per-record schema version, written as `v` on every JSONL record. */
export const RECORD_VERSION = 1;

// ---------------------------------------------------------------------------
// Enumerations (const arrays so they can drive tool schemas and validators)
// ---------------------------------------------------------------------------

export const SCOPE_MODES = ["enforce", "warn", "off"] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

export const TARGET_TYPES = ["web", "api", "network", "code-review", "firmware"] as const;
/** Known target types; custom types are allowed. */
export type TargetType = (typeof TARGET_TYPES)[number] | (string & {});

export const INVENTORY_KINDS = ["host", "service", "endpoint", "param", "tech"] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

/**
 * Sections of the target model (`model.md`) — the macro picture every micro
 * record hangs off.
 *
 * Every other record in this ontology is an atom: one host, one cell, one
 * defect. Nothing described the system as a whole, so the understanding that
 * produces a good hypothesis — what this application is for, who its actors
 * are, which rules must hold — lived only in the context window and died at the
 * first compaction. These are the sections of the one artifact that survives it.
 *
 * `invariants` is the load-bearing one: an invariant is a hypothesis generator
 * ("balances never go negative" -> what makes one go negative?), and those are
 * the bugs no checklist and no scanner can reach.
 */
export const MODEL_SECTIONS = ["what", "actors", "invariants", "boundaries", "flows"] as const;
export type ModelSection = (typeof MODEL_SECTIONS)[number];

/** One-line prompt for each section, shown wherever the model asks what to write. */
export const MODEL_SECTION_HELP: Record<ModelSection, string> = {
	what: "what the system is for, in a paragraph — the business it is in, what it holds, who pays for it",
	actors: "the roles and tenants, and what each is allowed to do",
	invariants: "the rules that must always hold (resources conserved, ownership, idempotency, ordering) — each one is a hypothesis waiting to be written",
	boundaries: "where untrusted data crosses into trusted code, and what is trusted on the other side",
	flows: "the handful of sequences that matter — auth, payment, upload, reset — as steps",
};

export const HYPOTHESIS_OUTCOMES = ["proposed", "testing", "confirmed", "refuted", "inconclusive"] as const;
export type HypothesisOutcome = (typeof HYPOTHESIS_OUTCOMES)[number];

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_STATUSES = [
	"suspected", "open", "confirmed", "triaged", "reported", "refuted", "false-positive", "accepted-risk", "ignored",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * What a finding's status says about how hard anybody looked.
 *
 * The operator prompt tells the agent to record a plausible lead rather than
 * drop it — "verification calibrates confidence and severity, it does not erase
 * a lead" — which is the right bet when the costliest outcome is a missed
 * vulnerability. But the ledger had no way to say which findings were in that
 * state: a lead recorded as a hedge and a bug reproduced against a live target
 * were both `open`, rendered identically, and reached the client in the same
 * list. That is how an unverified IDOR reaches a report.
 *
 * `suspected` is that missing state, and it is the default for anything nobody
 * has challenged yet. `confirmed` now has to be earned: the claim was tested,
 * its control case failed, and the entitlement question was answered.
 *
 * `refuted` is the challenge breaking a finding on cited grounds. It is kept
 * distinct from `false-positive`, which is the operator's own judgement — three
 * months later "who decided this was not real, the tool or the consultant?" is
 * a question the row has to be able to answer.
 */
export const UNVERIFIED_STATUS: FindingStatus = "suspected";

/**
 * How a claim came to be made — the provenance a consultant needs before
 * signing a report.
 *
 * `scanner` is a hit nobody re-issued by hand; `inferred` is reasoning over
 * code or configuration with no request behind it; `observed` is a response
 * somebody actually saw; `reproduced` is observed twice with the control case
 * run. The prompt already says to verify scanner hits, and nothing recorded
 * whether that happened, so a nuclei line and a hand-built proof were the same
 * row.
 */
export const FINDING_SOURCES = ["scanner", "inferred", "observed", "reproduced"] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/** What challenging a finding concluded. */
export const CHALLENGE_VERDICTS = ["stands", "amended", "refuted", "unresolved"] as const;
export type ChallengeVerdict = (typeof CHALLENGE_VERDICTS)[number];

/**
 * Statuses that settle a finding without deleting it.
 *
 * An engagement produces three kinds of finding nobody should be counting as
 * open work, and all three are decisions rather than mistakes: the client has
 * accepted the risk, the operator has judged it not real, or it has been set
 * aside deliberately. The row stays — it is still in the report, still in the
 * history, still auditable — but it leaves the count the header and the
 * statusline show, because a number that never falls is a number nobody reads.
 *
 * Deleting is the separate act, and it is for something that should never have
 * been recorded at all.
 */
export const DISPOSED_STATUSES = ["refuted", "false-positive", "accepted-risk", "ignored"] as const;
export type DisposedStatus = (typeof DISPOSED_STATUSES)[number];

export const BLOCKER_TYPES = [
	"decision",
	"input",
	"approval",
	"scope-clarification",
	"credential-request",
] as const;
export type BlockerType = (typeof BLOCKER_TYPES)[number];

export const BLOCKER_STATUSES = ["open", "answered", "dismissed"] as const;
export type BlockerStatus = (typeof BLOCKER_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LOOT_TYPES = ["password", "hash", "token", "apikey", "cookie", "key"] as const;
export type LootType = (typeof LOOT_TYPES)[number];

/** Derived per-cell coverage status (never stored; computed by core/coverage.ts). */
export const COVERAGE_STATUSES = ["not-tested", "testing", "clear", "vulnerable", "blocked", "n/a"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** Append-only JSONL ledgers held in the workspace. */
export const STORE_NAMES = ["inventory", "hypotheses", "findings", "blockers", "loot"] as const;
export type StoreName = (typeof STORE_NAMES)[number];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, e.g. "2026-08-23T14:02:11Z". */
export type IsoTimestamp = string;

/**
 * Reference to a unit of work the agent can be blocked on or route toward:
 * an inventory element id, a hypothesis id, or a raw target string.
 */
export type WorkRef = string;

// ---------------------------------------------------------------------------
// Record base (every JSONL record)
// ---------------------------------------------------------------------------

export interface RecordBase {
	/** Record schema version (see RECORD_VERSION). */
	v: number;
	/** Short id, unique within its store. Stable across updates. */
	id: string;
	createdAt: IsoTimestamp;
	/** Present when this record supersedes an earlier one with the same id. */
	updatedAt?: IsoTimestamp;
	/** Soft-delete tombstone: the latest record for an id with this set hides the id. */
	deleted?: true;
	/**
	 * Why an id was retired, written on the tombstone.
	 *
	 * A deletion is the one write that leaves no visible trace — the row simply
	 * stops existing for every reader — so the line that does it says why. The
	 * superseded lines are all still in the file above it, which is what makes a
	 * wrong deletion recoverable rather than merely regrettable.
	 */
	deletedReason?: string;
	/** Set by the duplicate sweep on the rows it folded away: the id they became. */
	duplicateOf?: string;
}

// ---------------------------------------------------------------------------
// Workspace manifest
// ---------------------------------------------------------------------------

export interface WorkspaceManifest {
	formatVersion: number;
	engagement: string;
	createdAt: IsoTimestamp;
	/** Store name -> schema version currently on disk. */
	stores: Partial<Record<StoreName, number>>;
	/**
	 * The directory this engagement was opened from, first time.
	 *
	 * An engagement is keyed on the target directory's basename, so
	 * ~/clientA/backend and ~/clientB/backend are one ledger — and for a tool
	 * whose first promise is that client code never leaves the box, mixing two
	 * clients inside the box is the wrong failure to leave open. Recording where
	 * it came from is what lets a later session notice. Absent on every
	 * engagement created before this existed, and absent means unknown, not
	 * mismatched. See ADR-005.
	 */
	originPath?: string;
}

// ---------------------------------------------------------------------------
// scope.json
// ---------------------------------------------------------------------------

export interface ScopeTargets {
	domains?: string[];
	ips?: string[];
	cidrs?: string[];
	urls?: string[];
}

export interface EngagementScope {
	v: number;
	engagement: string;
	/** Must be true for offensive/network tools to run in `enforce` mode. */
	authorized: boolean;
	mode: ScopeMode;
	/** Absolute or `~`-relative workspace path; defaults to ~/.pired/engagements/<engagement>/. */
	workspace?: string;
	targets: ScopeTargets;
	exclude?: ScopeTargets;
	/**
	 * Which checklist seeds the coverage matrix, when the targets cannot say.
	 *
	 * The shape of a scope infers `web` from domains and `network` from bare
	 * addresses, which works for those two and for nothing else: an API
	 * engagement and a web engagement are both a list of URLs, so `api.json`
	 * shipped with 13 classes that nothing could ever select. A firmware
	 * engagement has no network target at all.
	 *
	 * Inference cannot distinguish these because the difference is not in the
	 * targets — it is in what the operator came to test. So they say, and the
	 * inference below stays as the default for the two cases it does settle.
	 */
	targetType?: TargetType;
	/**
	 * Most subagents this session may spawn. Defaults to DEFAULT_MAX_AGENTS.
	 *
	 * A runaway fan-out is not a scope violation but it is the same shape of
	 * problem: unbounded work the operator did not ask for, on their budget and
	 * their client's systems. `0` forbids delegation outright.
	 */
	maxAgents?: number;
	/**
	 * Tool names that spawn a subagent, when the loaded package does not use one
	 * of the defaults.
	 *
	 * pired ships no spawn machinery — the tool belongs to whichever subagent
	 * package is loaded — so the cap has to recognise it by name. Getting the
	 * name wrong fails open (the cap never fires) rather than blocking a
	 * legitimate tool, which is the safer of the two mistakes but is worth
	 * knowing about.
	 */
	agentTools?: string[];
	/**
	 * When true, a recognized network command whose target could not be parsed
	 * (e.g. `curl localhost`, a shell variable) is BLOCKED under `enforce` mode
	 * instead of allowed. Fail-closed for the unverifiable case; default is
	 * fail-open so unparseable-but-legitimate commands are not needlessly blocked.
	 */
	strictUnresolved?: boolean;
}

// ---------------------------------------------------------------------------
// checklist.json
// ---------------------------------------------------------------------------

export interface ChecklistClass {
	/** Stable class id referenced by hypotheses and coverage cells. */
	id: string;
	title: string;
	/** Related CWE identifiers, e.g. ["CWE-89"]. */
	cwe?: string[];
	/**
	 * Inventory kinds this class is testable against. Omitted means "every kind"
	 * — the pre-appliesTo behaviour, so an unannotated checklist is unchanged.
	 * Cells pairing this class with any other kind are `n/a` and drop out of the
	 * coverage denominator: TLS is not a question you ask of a query parameter.
	 */
	appliesTo?: InventoryKind[];
}

export interface Checklist {
	v: number;
	targetType: TargetType;
	classes: ChecklistClass[];
}

// ---------------------------------------------------------------------------
// inventory.jsonl (discriminated by `kind`)
// ---------------------------------------------------------------------------

export interface HostRecord extends RecordBase {
	kind: "host";
	/** Hostname or IP as discovered. */
	value: string;
	ip?: string;
	tech?: string[];
}

export interface ServiceRecord extends RecordBase {
	kind: "service";
	/** Inventory id of the owning host. */
	host: string;
	port: number;
	/** "tcp" | "udp" | other. */
	proto: string;
	name?: string;
}

export interface EndpointRecord extends RecordBase {
	kind: "endpoint";
	/** Inventory id of the owning host. */
	host: string;
	method: string;
	path: string;
	params?: string[];
	/** Auth requirement, e.g. "none" | "session" | "bearer". */
	auth?: string;
	/**
	 * The source file that implements this element, when the review is of code.
	 *
	 * Surface is recorded as routes; findings and answer keys are written in
	 * files, and the two never met. Coverage is `classes x surface`, so a matrix
	 * built only from routes can never point at a file — measured across 17 misses
	 * on the application corpus, the vulnerable file was OPENED every single time
	 * and recorded as surface not once.
	 *
	 * `file` is what lets a cell name a place on disk: the gap list can say which
	 * file is untested, and a finding recorded against the route inherits somewhere
	 * the report can cite and the grader can read.
	 */
	file?: string;
}

export interface ParamRecord extends RecordBase {
	kind: "param";
	/** The source file this parameter is read in. See EndpointRecord.file. */
	file?: string;
	/** Inventory id of the owning endpoint, when known. */
	endpoint?: string;
	name: string;
	/** "query" | "body" | "header" | "path" | "cookie" | other. */
	location?: string;
}

export interface TechRecord extends RecordBase {
	kind: "tech";
	/** Inventory id of the host this technology was observed on, when scoped. */
	host?: string;
	name: string;
	version?: string;
}

export type InventoryRecord = HostRecord | ServiceRecord | EndpointRecord | ParamRecord | TechRecord;

// ---------------------------------------------------------------------------
// hypotheses.jsonl
// ---------------------------------------------------------------------------

export interface HypothesisRecord extends RecordBase {
	kind: "hypothesis";
	statement: string;
	/** Inventory element id, or a raw target string. */
	target: WorkRef;
	/** Checklist class id. */
	class: string;
	method?: string;
	outcome: HypothesisOutcome;
	/** Workspace-relative evidence path. */
	evidence?: string;
	/** Set when outcome=confirmed and a finding was created. */
	findingId?: string;
	/**
	 * What happened when this test case was looked at a second time.
	 *
	 * A hypothesis recorded `refuted` turns its coverage cell `clear`, and that
	 * cell counts toward the percentage handed to the client. Until this field
	 * existed a re-check left the row byte-identical to before, so "one agent
	 * said clear" and "two independent agents said clear" were the same ledger —
	 * the second look could not be reported and could not be deduplicated.
	 *
	 * Unlike a finding's `verification` this is not judged against a contract:
	 * there is no control case for "clear". It records that a second pass ran
	 * and what it was grounded in, which is the claim it is entitled to make.
	 */
	verification?: Verification;
}

// ---------------------------------------------------------------------------
// findings.jsonl
// ---------------------------------------------------------------------------

/**
 * The record a challenge leaves behind.
 *
 * Append-only in spirit: a challenge never deletes a finding and never lowers
 * one out of the ledger. The worst it can do is mark it `refuted`, and a
 * refuted finding is still exported — in its own section, with this record
 * beside it — so a wrong refutation is visible to the consultant rather than
 * silently dropping a real bug. That is the whole safety argument for letting a
 * machine challenge findings at all.
 */
export interface Verification {
	verdict: ChallengeVerdict;
	/** When it was challenged. A proof reproduced on day 1 is not a proof on day 5. */
	at: IsoTimestamp;
	/**
	 * The control case and what it returned.
	 *
	 * The load-bearing field. A finding is not proven by the attack working; it
	 * is proven by the attack working AND the control failing. An IDOR whose
	 * unauthenticated control also succeeds is a public resource, not a bug.
	 */
	control?: string;
	/**
	 * Where the refutation is grounded — `file:line`, an evidence path, or the
	 * model section that settles entitlement.
	 *
	 * A refutation with no basis is not a refutation. `judge()` downgrades one to
	 * `unresolved` rather than letting it settle a finding, for the same reason
	 * `eval/key.ts` rejects a `clear` truth cell with no `why`: an unsupported
	 * clear claim is an assertion, not a result.
	 */
	basis?: string[];
	/**
	 * Whether the target was reachable and the session valid when this ran.
	 *
	 * Re-running a whole engagement's findings against an expired token would
	 * refute every one of them. "The attack no longer works" and "I can no longer
	 * reach the target" are different verdicts and only the first belongs to the
	 * finding, so a refutation is not trusted unless this is true.
	 */
	live?: boolean;
	/** The entitlement question, when the class has one, and how it was settled. */
	entitlement?: string;
	notes?: string;
}

export interface FindingRecord extends RecordBase {
	kind: "finding";
	title: string;
	severity: Severity;
	target: WorkRef;
	/**
	 * Every location this finding has been recorded against, when it is more than
	 * one. A bug is often several sinks — a public-share exposure lives in both the
	 * share handler and the public one — and a merge that kept only the newest
	 * target lost the rest: measured on filebrowser, http/share.go:84 was recorded
	 * exactly on a truth entry and overwritten seconds later.
	 *
	 * `target` stays the primary, so nothing that reads one location changes.
	 */
	locations?: string[];
	/** Checklist class id, when derived from one. */
	class?: string;
	/** Primary CWE, e.g. "CWE-639". */
	cwe?: string;
	/** CVSS vector string. */
	cvss?: string;
	/** What the flaw is, in plain language: the mechanism, and where it lives. */
	description?: string;
	/**
	 * What it costs the client, in their terms.
	 *
	 * The description says what is broken; this says why anyone should pay to fix
	 * it — the records exposed, the money moved, the service lost, the obligation
	 * breached. It is the paragraph a manager reads and the one a technical writer
	 * most often leaves out, and a finding without it is a bug report rather than
	 * a consulting deliverable.
	 */
	impact?: string;
	/** The concrete change that fixes it: the control to add, not "sanitize input". */
	remediation?: string;
	repro?: string;
	/** Workspace-relative evidence/artifact paths. */
	evidence?: string[];
	status: FindingStatus;
	/**
	 * How the claim arose, before anybody challenged it. See FINDING_SOURCES.
	 */
	source?: FindingSource;
	/**
	 * What happened when this finding was challenged.
	 *
	 * Written by the challenge pass, never by the reviewer that made the claim.
	 * Absent means nobody has looked twice, which is why `suspected` is the
	 * default status rather than `open`.
	 */
	verification?: Verification;
	/**
	 * Why the finding carries the status it does.
	 *
	 * "Accepted risk" and "false positive" are decisions somebody made, and a
	 * client reading the report three months later asks who decided and on what
	 * grounds. A status with no reason beside it cannot answer that.
	 */
	reason?: string;
	hypothesisId?: string;
}

// ---------------------------------------------------------------------------
// blockers.jsonl
// ---------------------------------------------------------------------------

export interface BlockerRecord extends RecordBase {
	kind: "blocker";
	type: BlockerType;
	question: string;
	context?: string;
	/** Enumerated choices for decision/approval blockers. */
	options?: string[];
	/** Work items this blocker gates. */
	blocks?: WorkRef[];
	priority: Priority;
	status: BlockerStatus;
	/** Present once answered. */
	answer?: string;
	answeredAt?: IsoTimestamp;
	answeredBy?: string;
}

// ---------------------------------------------------------------------------
// loot.jsonl (sensitive; file is chmod 600, masked at export/share)
// ---------------------------------------------------------------------------

export interface LootRecord extends RecordBase {
	kind: "loot";
	/** Stable reference used instead of reprinting the secret, e.g. "cred:web-admin". */
	handle: string;
	type: LootType;
	username?: string;
	/** Plaintext; only ever written to the chmod-600 workspace file. */
	secret: string;
	/** Inventory id or raw target the secret belongs to. */
	target?: string;
	/** How it was obtained (hypothesis/evidence ref). */
	source?: string;
	notes?: string;
}

// ---------------------------------------------------------------------------
// Union of all ledger records
// ---------------------------------------------------------------------------

export type LedgerRecord = InventoryRecord | HypothesisRecord | FindingRecord | BlockerRecord | LootRecord;

/** Maps a store name to the record type it holds. */
export interface StoreRecordMap {
	inventory: InventoryRecord;
	hypotheses: HypothesisRecord;
	findings: FindingRecord;
	blockers: BlockerRecord;
	loot: LootRecord;
}

// ---------------------------------------------------------------------------
// Derived coverage (computed on read; never stored — see FORMAT.md §11)
// ---------------------------------------------------------------------------

export interface CoverageCell {
	/** Inventory id of the surface element. */
	element: string;
	/** Checklist class id. */
	class: string;
	status: CoverageStatus;
	/** Hypotheses that touched this cell. */
	hypothesisIds?: string[];
	/** Open blockers gating this cell (present when status === "blocked"). */
	blockerIds?: string[];
}

export interface CoverageMatrix {
	cells: CoverageCell[];
	counts: Record<CoverageStatus, number>;
	/**
	 * Cells that are actually askable (`cells.length` minus the `n/a` ones). The
	 * denominator for every coverage percentage — `cells.length` is the grid's
	 * shape, not the work.
	 */
	applicable: number;
}

export interface CoverageGap {
	element: string;
	class: string;
	reason: "not-tested" | "blocked";
}
