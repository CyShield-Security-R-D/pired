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

/**
 * The lenses a pass can be run under — the axis that makes pass N+1 unable to
 * repeat pass N.
 *
 * Measured on the application corpus (`research/11`): the union of three passes
 * found 9 of 24 truth entries where the mean pass found 4.3, so roughly half of
 * what the harness can find it misses on any given pass. The obvious remedy —
 * run it again over the same ledger — is the one measured not to work
 * (`research/06`): persisted and wiped arms tie at 0.591 cumulative recall, and
 * the persisted arm's final sessions run about half as long, one of them
 * recording zero new findings in 105 seconds. A second pass that re-reads the
 * first pass's conclusions inherits them.
 *
 * So a pass carries a lens, and the lens decides what it is allowed to look at:
 *
 * - `route` — the coverage matrix as it stands. The present behaviour.
 * - `file` — files the ledger names but never recorded as surface. Across 17
 *   misses the file holding the missed entry was opened 17 times and recorded as
 *   surface 0 times, so a matrix built from routes could never point at it.
 * - `invariant` — the rules in the target model that no hypothesis has tested.
 *   These are the scanner-blind classes; nothing else routes to them.
 * - `adversarial` — cleared cells and unchallenged findings (ADR-014, ADR-016),
 *   given a place in the ladder rather than waiting to be pulled.
 * - `credentialed` — surface settled before the engagement held a credential,
 *   which is surface that was only ever tested as an anonymous caller.
 */
export const PASS_LENSES = ["route", "file", "invariant", "adversarial", "credentialed"] as const;
export type PassLens = (typeof PASS_LENSES)[number];

/**
 * How a pass is opened and what the ladder holds.
 *
 * Off by default, and the whole feature is inert when it is: one `route` pass,
 * no prompt block, no change to the router, nothing new in the panel. The ladder
 * is engagement policy rather than an operator preference — a firmware teardown,
 * a credentialed web retest and a one-hour triage do not want the same one —
 * which is why it lives in `scope.json` beside `maxAgents`.
 */
export interface PassConfig {
	enabled?: boolean;
	/** The ladder, in order. Pass 1 takes the first entry. Defaults to DEFAULT_PASS_LADDER. */
	lenses?: PassLens[];
}

/**
 * The ladder used when passes are enabled and none is named.
 *
 * `credentialed` is deliberately not in it: it is empty without loot, and a
 * ladder whose last rung is usually empty teaches the operator that the ladder
 * ends early. A pentest engagement adds it explicitly.
 */
export const DEFAULT_PASS_LADDER: PassLens[] = ["route", "file", "invariant", "adversarial"];

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

/**
 * How far a verification's grounds reach: `static` is quoted source, `executed` a
 * live check or evidence that is not a static excerpt. Derived by pired, never
 * taken from the caller. Declared by the Phase 3 groundwork; judged by 3.1.
 */
export const VERIFICATION_TIERS = ["static", "executed"] as const;
export type VerificationTier = (typeof VERIFICATION_TIERS)[number];

/** How a session was settled (`record kind=settle`, Phase 3, 3.2). */
export const SETTLE_OUTCOMES = ["finished", "paused", "blocked"] as const;
export type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];

/** Derived per-cell coverage status (never stored; computed by core/coverage.ts). */
export const COVERAGE_STATUSES = ["not-tested", "testing", "clear", "vulnerable", "blocked", "n/a"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/**
 * Append-only JSONL ledgers held in the workspace. `sessions` holds settle records
 * (Phase 3, 3.2); an engagement written before it has no such file and reads as
 * having no settles.
 */
export const STORE_NAMES = ["inventory", "hypotheses", "findings", "blockers", "loot", "sessions"] as const;
export type StoreName = (typeof STORE_NAMES)[number];
/** The stores whose rows are `LedgerRecord`s: every store but `sessions`, which holds settle records. */
export type LedgerStoreName = Exclude<StoreName, "sessions">;

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
	/**
	 * Which pass created this row. Absent means pass 1, or a ledger written
	 * before passes existed — the two are indistinguishable and neither matters.
	 *
	 * Written by the record path and deleted from caller input, the same rule
	 * `verification` follows: a model that could assert which pass it was on
	 * could assert the coverage that goes with it. It is set on creation only, so
	 * a row corrected in pass 3 still reports the pass that found it — which is
	 * what makes the per-pass delta a measurement rather than a restatement.
	 */
	pass?: number;
	/**
	 * Who created this row: `lead`, a worker's agent name (`pired-investigate`,
	 * …), `scribe` or `operator` — see the AUTHOR constants below. Absent on every
	 * row written before it existed, and absent means unknown.
	 *
	 * Stamped by the record path from what the host says is writing, and deleted
	 * from caller input, the rule `pass` and `verification` follow: a worker that
	 * could name its author could pass its own lead off as the lead's. Set on
	 * creation only, so a merge, an update by id and the duplicate sweep keep the
	 * creator. ADR-028 left it out because nothing depended on it; the stop
	 * classifier's fairness note (ADR-030) and the verification tier now do.
	 */
	by?: string;
}

/**
 * The `by` values the host stamps, besides a worker's agent name.
 *
 * `worker` is the fallback for a child whose role could not be read from its
 * prompt, so a worker's row never reads as the lead's.
 */
export const LEAD_AUTHOR = "lead";
export const SCRIBE_AUTHOR = "scribe";
export const OPERATOR_AUTHOR = "operator";
export const UNNAMED_WORKER_AUTHOR = "worker";

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
	 * The pass currently open, counting from 1.
	 *
	 * On the manifest rather than in the session because a pass outlives a
	 * session — a consultant closes the laptop mid-pass — and because the count
	 * is what the per-pass delta is expressed in. Absent means 1.
	 */
	pass?: number;
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
	 * Whether this engagement works in passes, and which lenses its ladder holds.
	 *
	 * Absent or `enabled: false` is one `route` pass, which is the behaviour every
	 * measurement in `research/` was taken against — so nothing already reported
	 * changes meaning until an engagement opts in.
	 */
	passes?: PassConfig;
	/**
	 * Most subagents this session may spawn. Defaults to DEFAULT_MAX_AGENTS.
	 *
	 * A runaway fan-out is not a scope violation but it is the same shape of
	 * problem: unbounded work the operator did not ask for, on their budget and
	 * their client's systems. `0` forbids delegation outright.
	 */
	maxAgents?: number;
	/**
	 * Extra spawn-style tool names to cap, for a delegation package that is not
	 * pi-subagents.
	 *
	 * pired delegates through pi-subagents' `subagent` tool, which the gate knows
	 * by name and vets in full; these names extend the generic per-call cap
	 * (`spawn`/`delegate`) and share the session's maxAgents budget. An unknown
	 * external tool the gate has never heard of cannot be counted.
	 */
	agentTools?: string[];
	/**
	 * When true, a recognized network command whose target could not be parsed
	 * (e.g. `curl localhost`, a shell variable) is BLOCKED under `enforce` mode
	 * instead of allowed. Fail-closed for the unverifiable case; default is
	 * fail-open so unparseable-but-legitimate commands are not needlessly blocked.
	 */
	strictUnresolved?: boolean;
	/**
	 * The session's ceilings, when the operator or the benchmark harness states
	 * them. Absent means no budget, and no budget line. Read through
	 * core/budget.ts `parseBudget`, which drops a value that is not a
	 * non-negative integer. Declared by the Phase 3 groundwork; shown by 3.2.
	 */
	budget?: ScopeBudget;
	/**
	 * Most verifier launches this session may make, counted apart from
	 * `maxAgents` so verification does not compete with work launches. Read
	 * through core/subagents.ts `verifierCap`: absent or invalid is 0. Declared by
	 * the Phase 3 groundwork; enforced by 3.1.
	 */
	maxVerifiers?: number;
}

/** A session's ceilings. Tokens count every model call the session pays for; minutes are wall clock. */
export interface ScopeBudget {
	tokens?: number;
	minutes?: number;
	/**
	 * An absolute time (ISO 8601) the session is stopped at, when whoever set
	 * the budget enforces one — the benchmark harness writes launch time plus
	 * the run limit. Minutes left are then read from it rather than from when
	 * pired's session happened to start (3.2).
	 */
	deadline?: string;
}

/**
 * What the host reports against the budget (`ToolDeps.budget`): the ceilings the
 * scope states and what has been spent so far, in the same units.
 */
export interface BudgetReading {
	ceiling: ScopeBudget;
	spent: { tokens?: number; minutes?: number };
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
/**
 * One cited line and the text quoted from it: `at` is `file:line`, `quote` the
 * verbatim text. The model sends `"file:line: text"` strings; pired stores this.
 */
export interface QuotedLocation {
	at: string;
	quote: string;
}

export interface Verification {
	verdict: ChallengeVerdict;
	/**
	 * Who judged the finding, in `RecordBase.by`'s vocabulary. Declared by the
	 * Phase 3 groundwork; written and judged by 3.1, like the three below.
	 */
	by?: string;
	/** The hops from source to sink, each a grounded quote. */
	path?: QuotedLocation[];
	/** The checks examined on the way, each a grounded quote. */
	guards?: QuotedLocation[];
	/** `static` or `executed`, derived by pired and never taken from the caller. */
	tier?: VerificationTier;
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
// sessions.jsonl (settle records; Phase 3, 3.2)
// ---------------------------------------------------------------------------

/**
 * What was left when a session settled, computed by the harness from the ledger.
 * A remainder the caller sends is ignored. Declared by the Phase 3 groundwork;
 * written by 3.2.
 */
export interface SettleRemainder {
	/** Coverage cells not yet settled. */
	openCells?: number;
	/** Source directories with no recorded surface. */
	unmappedAreas?: string[];
	/** Unverified finding ids, keyed by the `by` that created them. */
	unverified?: Record<string, string[]>;
	/** Hypothesis ids left `inconclusive`. */
	inconclusive?: string[];
	/** Open blocker ids. */
	openBlockers?: string[];
	/** What the session had spent when it settled. */
	spent?: BudgetReading["spent"];
}

export interface SettleRecord extends RecordBase {
	kind: "settle";
	outcome: SettleOutcome;
	note?: string;
	remainder: SettleRemainder;
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
	sessions: SettleRecord;
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
