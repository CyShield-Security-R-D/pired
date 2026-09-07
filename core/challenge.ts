/**
 * Challenging a finding — the pass that tries to break a claim before a client
 * reads it.
 *
 * The operator prompt tells the agent to record a plausible lead rather than
 * drop one, because the costliest outcome is a missed vulnerability. That is the
 * right bet, and it has a cost the ledger never carried: an unverified lead and
 * a proven bug were both `open`, rendered identically, and reached the report in
 * the same list. The case this module exists for is an IDOR recorded because
 * one principal could read another's object, with nobody having established
 * that the principal was not *meant* to — a sharing feature, a shared tenant, a
 * collaborator role. It reads exactly like a proven bug until someone checks intent.
 *
 * That case is also why re-running requests is not enough on its own. An
 * access-control finding is a claim about **intent**, and intent is not in the
 * response, not in the code, and not in any number of repeat requests. It is in
 * the target model (`model.md` — actors, invariants) or it is a question for the
 * operator. A challenge that cannot answer it does not get to call the finding
 * confirmed, and does not get to call it refuted either.
 *
 * Two rules hold this module together:
 *
 *   1. **Proof is symmetric; the failure mode is not.** Promotion needs the
 *      control case run; refutation needs a cited basis. When either is missing
 *      the finding stays `suspected` — the challenge never resolves a claim it
 *      did not actually settle, in either direction.
 *   2. **Nothing is ever deleted or hidden.** The worst a challenge can do is
 *      mark a finding `refuted`, which keeps the row, keeps it in the export
 *      under its own heading, and keeps the grounds beside it. A wrong
 *      refutation is therefore visible to the consultant instead of silently
 *      dropping a real bug, which is the only basis on which it is safe to let a
 *      machine challenge findings at all.
 *
 * Pure module: records in, a verdict and a patch out. No ports, no I/O — the
 * host reads evidence files and runs the requests, and hands the text in here.
 */

import type {
	BlockerType, ChallengeVerdict, FindingRecord, FindingStatus, Severity, Verification,
} from "./ontology.ts";

// ---------------------------------------------------------------------------
// Verification contracts — what each weakness class has to show
// ---------------------------------------------------------------------------

export interface VerificationContract {
	/** Checklist class id this governs. */
	class: string;
	/** Restated as the thing that must be true for the finding to be real. */
	claim: string;
	/**
	 * The case that must FAIL for the finding to mean anything.
	 *
	 * Almost every false positive in this corpus of failures is a missing
	 * negative control: a 200 on `/admin` that is a catch-all route serving the
	 * SPA for every path, a payload that appears in the body but arrives
	 * HTML-encoded, an "unauthenticated" request that carried a session cookie
	 * from the tool's own config.
	 */
	control: string;
	/**
	 * The question no response can answer, for the classes that turn on intent.
	 *
	 * Reading another tenant's object is a vulnerability when the reader was not
	 * entitled to it and a feature when they were. The evidence looks identical
	 * either way, which is exactly how the shipped IDOR happened.
	 */
	entitlement?: string;
	/** Severity this class cannot exceed without something more than the base case. */
	ceiling?: Severity;
	/** Why the ceiling is there, quoted back to whoever hits it. */
	ceilingWhy?: string;
}

/**
 * The access-control family, where the entitlement question lives.
 *
 * Kept together because they share one failure: the request succeeded, and
 * nobody asked whether it was supposed to.
 */
const ENTITLEMENT_QUESTION =
	"who is this resource FOR? Establish from the target model's actors and invariants (or ask the " +
	"operator) that the principal making the request is not entitled to it — not a collaborator, not " +
	"a member of the owning team or tenant, not an admin, and not a holder of a share link. If that " +
	"cannot be established, the finding stays suspected: reading another user's object is a bug when " +
	"the reader was not entitled and a feature when they were, and the response looks the same.";

export const CONTRACTS: readonly VerificationContract[] = [
	{
		class: "idor",
		claim: "a principal receives an object belonging to a different principal",
		control:
			"repeat the exact request with NO credentials at all. It must fail. If it succeeds the " +
			"resource is public and there is no IDOR. Then repeat as a THIRD principal with no " +
			"relationship to the object — not the owner, not the caller in the report. If that one is " +
			"refused, the caller's access came from a grant and not from an absent check, and this is " +
			"a share working as designed. If it is also served, the check is missing OR the resource is " +
			"read-wide by design, and only entitlement tells you which. Then a valid but unrelated id — " +
			"a 200 for every id is a handler that ignores the parameter, not an ownership bug.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "authz",
		claim: "a principal performs an action their role is not permitted",
		control:
			"confirm the action is actually refused for someone — if every role including anonymous " +
			"can do it, the control is not missing for this user, it is absent by design and that is a " +
			"different finding. Confirm the effect happened (the record changed), not just a 200.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "authn",
		claim: "authentication can be bypassed or forged",
		control: "the same request without the forged material must be rejected, and the session obtained must actually act as the victim.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "massassign",
		claim: "a request sets a field the caller is not permitted to set",
		control: "read the object back and show the privileged field actually changed. An accepted request that silently drops the field is not mass assignment.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "sqli",
		claim: "attacker input alters the query the database executes",
		control:
			"a true-payload and a false-payload must diverge, and the divergence must track the boolean. " +
			"An error or a 500 is not injection — it is an error.",
	},
	{
		class: "nosqli",
		claim: "attacker input alters the query the datastore executes",
		control: "a true/false operator pair must produce different result sets. A 500 on a malformed operator is a parse failure.",
	},
	{
		class: "xss",
		claim: "attacker input reaches an executable context in a page a victim loads",
		control:
			"check the response Content-Type is HTML and the payload arrives UNencoded in an executable " +
			"position. Reflected-but-encoded is not XSS, and a payload inside a JSON body served as " +
			"application/json does not execute. If it only fires against the tester's own account with " +
			"input only they can supply, it is self-XSS.",
		ceiling: "low",
		ceilingWhy: "self-XSS and XSS requiring an unlikely victim action do not carry high severity on their own",
	},
	{
		class: "ssti",
		claim: "attacker input is evaluated by the template engine",
		control: "an arithmetic probe must return the computed value, not the literal. Reflection of the braces alone proves nothing.",
	},
	{
		class: "cmdi",
		claim: "attacker input reaches a shell or exec call",
		control: "a timing or out-of-band probe must fire. Output that merely contains the payload string is reflection.",
	},
	{
		class: "ssrf",
		claim: "the server can be made to issue a request to an attacker-chosen destination",
		control:
			"an out-of-band callback must fire, or a response/timing differential must distinguish a " +
			"reachable host from an unreachable one. A parameter that merely looks like a URL is not SSRF.",
	},
	{
		class: "traversal",
		claim: "a path outside the intended root is read or written",
		control: "the response must contain the contents of a file outside the root. A 500 or an empty 200 is not traversal.",
	},
	{
		class: "upload",
		claim: "an uploaded file is stored somewhere it can be executed or served dangerously",
		control: "fetch the uploaded file back and show it is served with a dangerous type or executed. Acceptance of the upload is not the finding.",
	},
	{
		class: "redirect",
		claim: "the application sends a victim to an attacker-chosen origin",
		control: "the Location header must leave the origin on a 3xx the browser will follow. A link rendered in a body is not an open redirect.",
		ceiling: "low",
		ceilingWhy: "an open redirect with no auth or token in the flow is a low on its own",
	},
	{
		class: "csrf",
		claim: "a state-changing action can be driven from another origin",
		control:
			"the endpoint must actually change state, and the request must succeed with no token and " +
			"cookies attached cross-site — check SameSite, which defaults to Lax in current browsers " +
			"and defeats most of these. CSRF on a read-only endpoint is not a finding.",
	},
	{
		class: "xxe",
		claim: "the XML parser resolves external entities",
		control: "an out-of-band or file-read entity must actually resolve. An accepted document proves only that XML was parsed.",
	},
	{
		class: "deser",
		claim: "attacker-supplied serialized data reaches a deserializer that can construct arbitrary types",
		control: "a benign gadget probe must produce an observable effect. Recognising the format is not a finding.",
	},
	{
		class: "secrets",
		claim: "a live credential is exposed",
		control:
			"use it. A secret that does not authenticate is a stale string, and a test fixture is not a " +
			"breach. Say which system it was checked against.",
	},
	{
		class: "ratelimit",
		claim: "an endpoint that needs a limit does not have one",
		control: "show a sustained burst succeeding, and name the action worth abusing. Absence of a limit on a harmless read is not a finding.",
		ceiling: "medium",
	},
	{
		class: "misconfig",
		claim: "a setting is wrong in a way that has a consequence",
		control: "name the consequence and show it. A header absent from a response is an observation; what it lets an attacker do is the finding.",
		ceiling: "low",
		ceilingWhy: "missing headers and banner disclosure do not reach medium without a demonstrated consequence",
	},
	{
		class: "tls",
		claim: "the transport can be attacked as configured",
		control: "name the protocol or cipher and the attack it enables against this deployment. A B grade is not a finding.",
		ceiling: "medium",
	},
	{
		class: "default-creds",
		claim: "a shipped credential still authenticates",
		control: "the login must yield an authenticated session and reach something. A 200 on the login form is not a successful login.",
	},
	{
		class: "unauth-service",
		claim: "a service is reachable without authentication that should not be",
		control: "connect and perform a real operation unauthenticated. A banner is not access.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "exposed-admin",
		claim: "an administrative interface is reachable by someone who should not reach it",
		control:
			"confirm it is really the admin interface and really reachable from where the finding claims — " +
			"a catch-all route that serves the SPA for every path returns 200 for /admin too.",
		entitlement: ENTITLEMENT_QUESTION,
	},
	{
		class: "exposed-db",
		claim: "a datastore is reachable and will serve data",
		control: "read something. A refused connection or an auth challenge is not exposure.",
	},
	{
		class: "infodisclosure",
		claim: "the disclosed information helps an attacker",
		control: "name what it enables. Version strings and stack traces are findings when they lead somewhere, observations when they do not.",
		ceiling: "low",
		entitlement: "is this information actually non-public? Check it is not already in the client's docs, repo, or marketing site.",
	},
	{
		class: "logic",
		claim: "the application permits a sequence its rules forbid",
		control:
			"name the invariant from the target model that is violated and show the state after — the " +
			"balance, the order, the record. Without a stated invariant this is a description of a " +
			"feature.",
		entitlement: "which invariant does this break? A logic finding with no invariant behind it is an opinion about design.",
	},
];

const BY_CLASS = new Map(CONTRACTS.map((c) => [c.class, c]));

/** The contract for a class, when one is written. Unknown classes get the generic bar. */
export function contractFor(cls: string | undefined): VerificationContract | undefined {
	return cls === undefined ? undefined : BY_CLASS.get(cls);
}

/**
 * What every finding owes regardless of class, used when no contract matches.
 *
 * Deliberately not empty. A class nobody wrote a contract for is not thereby
 * exempt from showing that the thing it claims actually happens.
 */
export const GENERIC_CONTROL =
	"state what would have to be true for this NOT to be a finding, then check that thing. " +
	"If nothing could falsify the claim as written, the claim is not yet a finding.";

// ---------------------------------------------------------------------------
// The audit — everything checkable without touching the target
// ---------------------------------------------------------------------------

export type GapKind =
	| "provenance"
	| "unre-issued-scanner-hit"
	| "no-evidence"
	| "no-response"
	| "no-control"
	| "entitlement"
	| "severity"
	| "stale";

export interface Gap {
	kind: GapKind;
	/** What to go and do, in the imperative. */
	detail: string;
	/**
	 * Whether this alone stops the finding being confirmed.
	 *
	 * A non-blocking gap is worth saying and not worth holding a report for.
	 */
	blocking: boolean;
}

export interface AuditInput {
	finding: FindingRecord;
	/** Contents of the finding's cited evidence files, keyed by the cited path. */
	evidence?: Record<string, string>;
	/** The engagement's `model.md`, which is where entitlement is settled. */
	targetModel?: string;
	/** Now, for staleness. ISO-8601. */
	now?: string;
}

/** An HTTP response is in this text somewhere. */
function hasResponse(text: string): boolean {
	return /HTTP\/[0-9.]+\s+\d{3}/.test(text) || /^\s*<\s+HTTP\//m.test(text) || /^\s*(?:HTTP\/)?\d{3}\s/m.test(text);
}

/** An HTTP request is in this text somewhere. */
function hasRequest(text: string): boolean {
	return /^\s*(?:>\s*)?(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S/m.test(text) || /\bcurl\b/.test(text);
}

/**
 * Whether the evidence shows more than one authentication context.
 *
 * The single most common way an access-control proof is not a proof: both
 * requests went out as the same principal, so the "attacker" was the owner. Two
 * distinct credential values, or an explicit unauthenticated attempt, is what
 * the control looks like on the wire.
 */
function showsTwoPrincipals(text: string): boolean {
	const creds = new Set<string>();
	for (const m of text.matchAll(/^\s*(?:>\s*)?(?:Cookie|Authorization|X-Api-Key)\s*:\s*(.+)$/gim)) {
		creds.add((m[1] ?? "").trim().toLowerCase());
	}
	if (creds.size >= 2) return true;
	return /\b(?:unauthenticated|no cookie|without (?:a )?(?:session|token|credential)|anonymous)\b/i.test(text);
}

/**
 * Does the target model actually answer who a resource is for?
 *
 * Only the sections that carry entitlement count. A model with a rich `what`
 * paragraph and an empty `actors` section cannot settle an IDOR, and treating
 * its length as an answer is how the shipped finding got waved through.
 */
export function modelAnswersEntitlement(targetModel: string | undefined): boolean {
	if (!targetModel) return false;
	// Walked line by line rather than matched as one regex: the section runs to
	// the next heading OR to the end of the document, and a lookahead for "end of
	// input" is the kind of thing that silently matches nothing.
	let inSection = false;
	let body = "";
	const enough = (): boolean => body.replace(/^\s*[-*]\s*$/gm, "").trim().length >= 40;
	for (const line of targetModel.split("\n")) {
		const heading = /^#+\s*(.*?)\s*$/.exec(line);
		if (heading) {
			if (inSection && enough()) return true;
			inSection = /^(actors|invariants)\b/i.test(heading[1] ?? "");
			body = "";
			continue;
		}
		if (inSection) body += `${line}\n`;
	}
	return inSection && enough();
}

/**
 * Everything wrong with a finding that can be seen without issuing a request.
 *
 * This is the tier that costs no traffic, and on a live engagement traffic is
 * detection risk and load on a client's production system. It also catches the
 * category the operator reported: a claim recorded from a scanner line or from
 * reasoning, with no request behind it and no entitlement established.
 */
export function auditFinding(input: AuditInput): Gap[] {
	const { finding: f } = input;
	const contract = contractFor(f.class);
	const gaps: Gap[] = [];
	const evidenceText = Object.values(input.evidence ?? {}).join("\n");
	const cited = f.evidence ?? [];

	if (f.source === undefined) {
		gaps.push({
			kind: "provenance",
			detail:
				"no source recorded — set source=scanner|inferred|observed|reproduced. A consultant " +
				"signing this report needs to know which findings are scanner output nobody re-issued.",
			blocking: false,
		});
	}
	if (f.source === "scanner") {
		gaps.push({
			kind: "unre-issued-scanner-hit",
			detail: "recorded from a scanner hit. Re-issue the request by hand and keep the response before this is confirmed.",
			blocking: true,
		});
	}

	if (cited.length === 0) {
		gaps.push({
			kind: "no-evidence",
			detail: "no evidence cited. Save the request/response pair and cite the workspace path.",
			blocking: true,
		});
	} else if (Object.keys(input.evidence ?? {}).length > 0) {
		if (!hasResponse(evidenceText)) {
			gaps.push({
				kind: "no-response",
				detail: `cited evidence (${cited.join(", ")}) contains no HTTP response. A request nobody kept the answer to proves nothing.`,
				blocking: true,
			});
		} else if (!hasRequest(evidenceText)) {
			gaps.push({
				kind: "no-response",
				detail: `cited evidence (${cited.join(", ")}) contains a response but no request — the claim cannot be tied to what was sent.`,
				blocking: false,
			});
		}
	}

	const control = contract?.control ?? GENERIC_CONTROL;
	const needsTwo = contract?.entitlement !== undefined;
	if (cited.length > 0 && evidenceText.length > 0 && needsTwo && !showsTwoPrincipals(evidenceText)) {
		gaps.push({
			kind: "no-control",
			detail:
				"the evidence shows one authentication context. An access-control claim needs the " +
				"control case in it: the same request as a different principal, and again with no " +
				"credentials at all. " + control,
			blocking: true,
		});
	} else if (f.verification?.control === undefined) {
		gaps.push({ kind: "no-control", detail: `control case not recorded — ${control}`, blocking: true });
	}

	if (contract?.entitlement && f.verification?.entitlement === undefined && !modelAnswersEntitlement(input.targetModel)) {
		gaps.push({
			kind: "entitlement",
			detail:
				`entitlement not established — ${contract.entitlement} ` +
				"The target model records no actors or invariants that settle it, so this is a question " +
				"for the operator, not something to resolve by re-running the request.",
			blocking: true,
		});
	}

	if (contract?.ceiling && rank(f.severity) > rank(contract.ceiling)) {
		gaps.push({
			kind: "severity",
			detail:
				`severity ${f.severity} is above the ${contract.ceiling} this class carries on its base case` +
				(contract.ceilingWhy ? ` — ${contract.ceilingWhy}` : "") +
				". Show the consequence that lifts it, or amend the severity.",
			blocking: false,
		});
	}

	return gaps;
}

/** Worst first, for ordering a challenge queue. */
export const SEVERITY_RANK: Record<Severity, number> = { info: 1, low: 2, medium: 3, high: 4, critical: 5 };
function rank(s: Severity): number { return SEVERITY_RANK[s]; }

// ---------------------------------------------------------------------------
// The verdict — and the burden of proof on each side of it
// ---------------------------------------------------------------------------

/** What a challenge came back with, before this module decides what it earns. */
export interface ChallengeReport {
	verdict: ChallengeVerdict;
	/** `file:line`, an evidence path, or the model section that settles it. */
	basis?: string[];
	/** The control case and what it actually returned. */
	control?: string;
	/** Was the target reachable and the session valid while this ran? */
	live?: boolean;
	/** How entitlement was settled, for the classes that turn on it. */
	entitlement?: string;
	/** A corrected severity, for `amended`. */
	severity?: Severity;
	notes?: string;
}

export interface ChallengeOutcome {
	verdict: ChallengeVerdict;
	/** The status to write. Never outside the ledger, never a deletion. */
	status: FindingStatus;
	verification: Verification;
	/** Set when the reported verdict was not earned, and why. */
	downgraded?: string;
	/** Parked when only the operator can settle the question. */
	blocker?: { type: BlockerType; question: string; context: string };
	/** The finding had already gone to the client. */
	wasReported?: boolean;
	severity?: Severity;
}

/**
 * Decide what a challenge actually earned.
 *
 * The rules are deliberately symmetric in what they demand and asymmetric in
 * where they fail:
 *
 *   - To CONFIRM: the control case must have been run, and for the
 *     access-control classes entitlement must be settled. Reproducing an attack
 *     ten times does not make it a vulnerability if the caller was allowed.
 *   - To REFUTE: a cited basis is required, and the target must have been live.
 *     "I could not reproduce it" against an expired session refutes nothing, and
 *     an engagement re-verified on its last day with a dead token would
 *     otherwise refute every true finding it holds.
 *   - When either bar is missed the finding lands on `suspected` — not
 *     confirmed, not refuted, still in the ledger, still in the report under its
 *     own heading. An unproven challenge is not allowed to settle anything.
 *
 * That last clause is the whole safety property. There is no input to this
 * function that removes a finding.
 */
export function judge(finding: FindingRecord, report: ChallengeReport, at: string): ChallengeOutcome {
	const contract = contractFor(finding.class);
	const basis = (report.basis ?? []).filter((b) => b.trim().length > 0);
	const wasReported = finding.status === "reported" ? true : undefined;

	const verification = (verdict: ChallengeVerdict): Verification => ({
		verdict, at,
		...(report.control !== undefined ? { control: report.control } : {}),
		...(basis.length > 0 ? { basis } : {}),
		...(report.live !== undefined ? { live: report.live } : {}),
		...(report.entitlement !== undefined ? { entitlement: report.entitlement } : {}),
		...(report.notes !== undefined ? { notes: report.notes } : {}),
	});

	const unresolved = (why: string, blocker?: ChallengeOutcome["blocker"]): ChallengeOutcome => ({
		verdict: "unresolved",
		status: "suspected",
		verification: { ...verification("unresolved"), notes: [report.notes, why].filter(Boolean).join(" — ") },
		downgraded: why,
		...(blocker ? { blocker } : {}),
		...(wasReported ? { wasReported } : {}),
	});

	if (report.verdict === "refuted") {
		// A refutation with nothing behind it is an opinion, and an opinion is not
		// allowed to withdraw a finding from a client's report.
		if (basis.length === 0) {
			return unresolved(
				"refuted with no basis cited. Name the control, the line, or the model section that " +
				"makes this not a finding; a refutation has to cite the way a finding does.",
			);
		}
		// The trap that would break an entire engagement at once: re-running every
		// finding on the last day, against a rotated credential or a target behind
		// a new WAF rule, and reading "it does not work any more" as "it was never
		// real". Reachability is the finding's problem only when the target is
		// reachable.
		if (report.live === false) {
			return unresolved(
				"the target was not reachable, or the session was not valid, while this was challenged. " +
				"That refutes the connection, not the finding — re-challenge with a working session.",
			);
		}
		return {
			verdict: "refuted",
			status: "refuted",
			verification: verification("refuted"),
			...(wasReported ? { wasReported } : {}),
		};
	}

	if (report.verdict === "stands" || report.verdict === "amended") {
		if (report.control === undefined || report.control.trim().length === 0) {
			return unresolved(
				`the control case was not run — ${contract?.control ?? GENERIC_CONTROL} ` +
				"A finding is not proven by the attack working; it is proven by the attack working and " +
				"the control failing.",
			);
		}
		if (contract?.entitlement && (report.entitlement === undefined || report.entitlement.trim().length === 0)) {
			return unresolved(
				"entitlement was not established. The request succeeding does not make it unauthorized.",
				{
					type: "scope-clarification",
					question: `Is the caller in "${finding.title}" meant to be able to reach this resource?`,
					context:
						`${contract.entitlement}\n\nThe finding stays suspected until this is answered. ` +
						"Recording the answer in the target model's actors/invariants settles it for every " +
						"later finding on the same surface, not just this one.",
				},
			);
		}
		const severity = report.verdict === "amended" && report.severity !== undefined && basis.length > 0
			? report.severity
			: undefined;
		return {
			verdict: report.verdict,
			status: "confirmed",
			verification: verification(report.verdict),
			...(severity ? { severity } : {}),
			...(wasReported ? { wasReported } : {}),
		};
	}

	return unresolved("challenge returned no conclusion");
}

/**
 * The patch to write. Separated from `judge` so the caller can show it to the
 * operator and write it only if they agree — the same plan-then-apply contract
 * `core/dedupe.ts` uses, and for the same reason: this changes what a client is
 * told.
 */
export function verdictPatch(outcome: ChallengeOutcome): Partial<FindingRecord> {
	return {
		status: outcome.status,
		verification: outcome.verification,
		...(outcome.severity ? { severity: outcome.severity } : {}),
	};
}

// ---------------------------------------------------------------------------
// The brief handed to the challenger
// ---------------------------------------------------------------------------

/**
 * The task given to the agent that challenges a finding.
 *
 * Deliberately built from the RECORD and the contract, never from the
 * conversation that produced the finding. The scribe — the pass that re-read the
 * agent's own review buffer — cost 2.5x the wall clock and moved precision from
 * 0.059 to 0.038, because a verifier that inherits the finder's reasoning agrees
 * with it. A challenge is worth something only to the extent it is a fresh look
 * at the claim and the target.
 */
export function challengeBrief(finding: FindingRecord, gaps: Gap[] = []): string {
	const contract = contractFor(finding.class);
	const out: string[] = [];
	out.push(`Challenge finding ${finding.id}: "${finding.title}" [${finding.severity}${finding.class ? `, class ${finding.class}` : ""}]`);
	out.push("");
	out.push("Your job is to BREAK this claim, not to confirm it. You have not seen the reasoning that produced it and you do not need it.");
	out.push("");
	out.push(`Target: ${finding.target ?? "(none recorded)"}`);
	if (finding.description) out.push(`Claim: ${finding.description}`);
	if (finding.repro) out.push(`Stated reproduction: ${finding.repro}`);
	if (finding.evidence?.length) out.push(`Evidence on file: ${finding.evidence.join(", ")}`);
	out.push("");
	out.push(`What this class has to show: ${contract?.claim ?? "that the described effect actually occurs"}`);
	out.push(`The control case: ${contract?.control ?? GENERIC_CONTROL}`);
	if (contract?.entitlement) out.push(`The entitlement question: ${contract.entitlement}`);
	if (gaps.length > 0) {
		out.push("");
		out.push("Already visible without touching the target:");
		for (const g of gaps) out.push(`- ${g.blocking ? "[blocking] " : ""}${g.detail}`);
	}
	out.push("");
	out.push("Rules:");
	out.push("- Re-run the read, never the write. Nothing destructive; park an approval blocker instead.");
	out.push("- Prove the target is reachable and your session is valid BEFORE concluding anything failed. A dead session refutes nothing.");
	out.push("- To refute, cite: the file:line, the evidence path, or the model section that makes this not a finding. An uncited refutation is recorded as unresolved and changes nothing.");
	out.push("- To confirm, run the control case and say what it returned.");
	out.push("- \"I could not reproduce it\" is not a refutation. Say what you ran and what came back.");
	out.push("");
	out.push("Return: verdict (stands|amended|refuted|unresolved), the control and its result, basis[] for any refutation or severity change, whether the target was live, and how entitlement was settled if this class needs it.");
	return out.join("\n");
}
