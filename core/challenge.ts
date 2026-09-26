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

import {
	type BlockerType, type ChallengeVerdict, DISPOSED_STATUSES, type FindingRecord, type FindingStatus,
	type HypothesisRecord, LEAD_AUTHOR, OPERATOR_AUTHOR, type QuotedLocation, SCRIBE_AUTHOR, type Severity,
	UNVERIFIED_STATUS, type Verification, type VerificationTier,
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
		class: "dataexposure",
		claim: "a response carries fields the caller is not entitled to see",
		control:
			"name the field, then read the same object as a principal who should not see it and show the " +
			"field present and populated. A field that is null or absent for everyone is not exposure, and " +
			"a field the client's own interface renders to this user is not a leak. Check the serializer " +
			"rather than the database row: an API that over-fetches internally and filters on the way out " +
			"is doing the right thing.",
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
		class: "injection",
		claim: "attacker input changes the meaning of a query, filter or command the server builds",
		control:
			"a true-payload and a false-payload must diverge, and the divergence must track the boolean — " +
			"the same discipline sqli takes, because LDAP, XPath and expression filters fail the same way. " +
			"A 500 on a malformed payload is a parse error and a payload echoed back is reflection. Name " +
			"which engine you reached: 'injection' with no engine behind it is a guess about a syntax error.",
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
		class: "codeinj",
		claim: "attacker input reaches an evaluator that will execute it",
		control:
			"trace the path from the entry point to the eval/exec/Function call and show that nothing " +
			"between them constrains what arrives — then make it compute. An arithmetic probe must return " +
			"the product, not the literal. eval() over a constant, or over a value the code itself built, " +
			"is not this finding however alarming the call site looks.",
	},
	{
		class: "reflection",
		claim: "attacker input selects the class, method or attribute that gets invoked",
		control:
			"show the input reaching the dispatch with no allowlist between, and name one thing reachable " +
			"through it that an allowlist would have refused. The finding is never that reflection is used; " +
			"it is what else the name resolves to. Dispatch over a fixed table of names is a lookup table. " +
			"Both jinja2 sandbox escapes in research/09 are this shape — `attr` reaching `format` was " +
			"reachable precisely because the set of resolvable names was never bounded.",
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
		control:
			"the response must contain the contents of a file outside the root. A 500 or an empty 200 is " +
			"not traversal. Against source rather than a running target: show the concatenation and the " +
			"absence of containment. A join under a root that is then resolved and checked with startsWith " +
			"is containment; the same check applied BEFORE resolving `..` and symlinks is not, and an " +
			"allowlist of basenames is. Say which of those the code does.",
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
		class: "crypto",
		claim: "a cryptographic choice fails to provide the property the code relies on it for",
		control:
			"name the property — confidentiality, integrity, unpredictability, one-wayness — and show the " +
			"break in terms of that property. MD5 for a password hash is a break; MD5 for a cache key is " +
			"not. A static IV, an ECB mode, a token from Math.random(): say what an attacker recovers, " +
			"forges or predicts with it, and roughly what it costs them.",
		ceiling: "medium",
		ceilingWhy:
			"naming a weak primitive is an observation. What it lets an attacker read, forge or predict is " +
			"the finding, and showing that is what lifts this",
	},
	{
		class: "sca",
		claim: "a dependency with a known vulnerability is present AND reachable from this application",
		control:
			"take the version from the resolved lockfile, never from the manifest range and never from " +
			"memory — a range is not a version — and name the advisory id. Then show the vulnerable " +
			"function is actually called from this codebase, by what, with what input. This is the class " +
			"most often written from recollection; read the file.",
		ceiling: "medium",
		ceilingWhy: "a CVE in a package the application never calls is inventory, not exploitability",
	},
	{
		class: "iac",
		claim: "a deployed configuration grants or exposes more than the design requires",
		control:
			"name the file, the resource, and what it lets someone do who should not — then establish that " +
			"this file is what actually runs. A permissive compose file written for a laptop is not the " +
			"production posture, and a module nothing instantiates configures nothing. Say how you know it " +
			"is deployed.",
	},
	{
		class: "logging",
		claim: "a secret or personal datum reaches a log or an error response, or a security-relevant event is not recorded",
		control:
			"show the value at the sink — the log line, the response body — not the variable name at the " +
			"call site. A field called `password` that is redacted before the write is the control working. " +
			"Then say who reads that log: the client's own operators and a third-party aggregator are " +
			"different findings.",
		ceiling: "low",
		ceilingWhy:
			"a log the client already controls carries less than one shipped off the box. Say where it goes",
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
		class: "inventory",
		claim: "an undocumented, deprecated or non-production version of the API is reachable and serves data",
		control:
			"reach it and get a real response — a v1 still answering after v2 shipped, a staging host " +
			"returning production records. Then show it does something the current version refuses: an old " +
			"endpoint that behaves identically is duplication, not exposure. A path listed in a spec is " +
			"documentation, and a 404 is not a version.",
		ceiling: "medium",
		ceilingWhy: "an old version that behaves like the current one is an inventory observation until it is shown to bypass something",
	},
	{
		class: "unsafe-consumption",
		claim: "data from an upstream API is trusted where it should be validated",
		control:
			"show the upstream value reaching a sink or a decision with nothing between, then say how an " +
			"attacker gets to influence it — a caller-supplied upstream URL, a takeover of the upstream " +
			"name, a redirect the client follows. Without a route to the upstream this is a note about " +
			"coupling.",
		ceiling: "medium",
		ceilingWhy: "trusting an upstream nobody can influence is a robustness concern; name the route to it and this lifts",
	},
	{
		class: "outdated-service",
		claim: "the running version is vulnerable and the vulnerable feature is enabled",
		control:
			"get the version from the service, not from a scanner's guess, and name the advisory. Then " +
			"check the behaviour: distributions backport fixes, so a banner reading 1.2.3 on a patched " +
			"package is a version string and not a vulnerability. A CVE list keyed off a banner is an " +
			"inventory observation with a severity attached to it.",
		ceiling: "medium",
		ceilingWhy: "a banner is a version claim; without a check of the service's actual behaviour this does not reach high",
	},
	{
		class: "smb-rpc",
		claim: "SMB or RPC exposure permits an operation the deployment does not intend",
		control:
			"perform the operation: list the shares, read a file, enumerate the users. A null session that " +
			"binds and returns nothing is a bind, not access. Then say where you reached it from — a file " +
			"share answering the VLAN it exists to serve is the design, and the finding is reach from a " +
			"segment or a principal that should not have had it.",
	},
	{
		class: "snmp",
		claim: "an SNMP community or configuration exposes data or accepts writes",
		control:
			"read something real with the string — the interface table, the ARP cache, the running config — " +
			"and say what came back. `public` answering with nothing is not the finding. For write access, " +
			"do not write: park an approval blocker and say what a write would reach.",
		ceiling: "medium",
		ceilingWhy:
			"a read-only community returning a device's own interface list is exposure; RW, or a config " +
			"carrying credentials, is what carries high",
	},
	{
		class: "dns",
		claim: "the DNS configuration hands an attacker something they can use",
		control:
			"complete it. A zone transfer must be shown with the records it returned; a dangling CNAME must " +
			"be shown pointing at a name that is actually registrable, checked against the provider rather " +
			"than inferred from an NXDOMAIN. A refused transfer and a subdomain pointing at a live service " +
			"are both the system working.",
		ceiling: "low",
		ceilingWhy:
			"a zone transfer is reconnaissance until you name what those hostnames reach. A proven takeover " +
			"is a different result and lifts this",
	},
	{
		class: "segmentation",
		claim: "a host reaches a network or service the segmentation policy forbids",
		control:
			"show the connection succeeding from the source segment, and name the policy it violates. A " +
			"flat network that was always meant to be flat is a design opinion, not a control failure.",
		entitlement:
			"which segmentation policy does this break? Take it from the target model's invariants or the " +
			"engagement's rules of engagement, or ask the operator. Reachability with no stated policy " +
			"behind it describes the network rather than finding anything wrong with it.",
	},
	/**
	 * The firmware family.
	 *
	 * These are the classes with no analogue in a web or code-review engagement,
	 * so they are the only ones firmware.json needed new: everything else it
	 * asks — `cmdi` of a CGI binary, `traversal` of a device handler, `sca` of a
	 * component in the rootfs — is the same weakness on a different surface and
	 * settles against the same bar it always did.
	 *
	 * What is genuinely different here is the *medium*, which ADR-009 says
	 * decides what proof looks like. Two consequences run through all of them.
	 * A static image cannot answer a question about a running device, so a
	 * control that requires one is a control that cannot be met from an
	 * extracted rootfs — and emulation fails often enough (16% of images on
	 * firmadyne, 79% on FirmAE) that "could not be confirmed dynamically" is an
	 * expected outcome rather than a failure to look. And several of these are
	 * only reachable with the hardware in hand, so their ceiling reflects what
	 * an image alone can establish.
	 */
	{
		class: "memory-safety",
		claim: "attacker-controlled input reaches a memory operation that writes past the buffer",
		control:
			"a benign input of the same length and shape must NOT crash it, and the crash must repeat " +
			"from the same input. A crash under emulation is not a finding on its own: QEMU-based " +
			"rehosting produces faults from unimplemented ioctls and missing peripherals that look " +
			"identical to a real overflow, so say whether the faulting address is derived from your " +
			"input or from a syscall the emulator does not have.",
		ceiling: "high",
		ceilingWhy:
			"critical needs control of execution, not a crash. On an unhardened static MIPS/ARM binary " +
			"that step is usually short — but it is a step, and the absence of NX/ASLR/canary is " +
			"severity context for the impact paragraph rather than proof of exploitability.",
	},
	{
		class: "update-signature",
		claim: "the device accepts firmware that the vendor did not sign",
		control:
			"a MODIFIED image must be accepted. An update client that fetches over plaintext is the " +
			"weaker CWE-494 case and is proven by the transport alone; claiming CWE-347 means showing " +
			"the updater parses a signature and ignores the result, which needs the verify call traced " +
			"or a re-signed image accepted. Reading `http://` in a binary is where this starts, not " +
			"where it ends.",
		ceiling: "high",
		ceilingWhy:
			"critical needs the delivery too. Unsigned update is the classic second-order finding: it " +
			"is persistent compromise once you can reach the update path, so name the bug that gets you " +
			"there — an unauthenticated trigger, a MITM-able channel — or record it as critical-if-chained.",
	},
	{
		class: "update-rollback",
		claim: "the device accepts a validly-signed but older, vulnerable image",
		control:
			"the older image must actually boot and run, and the security version must be shown to live " +
			"somewhere writable rather than in an eFuse or OTP register. A version number that merely " +
			"looks mutable in a config file is not this finding until the downgrade completes.",
	},
	{
		class: "no-update-path",
		claim: "there is no mechanism to ship a fix for this component at all",
		control:
			"absence has to be established, not assumed from a filesystem listing: show there is no " +
			"update client, no writable firmware partition and no documented procedure. A component " +
			"that updates only as part of a whole-image flash still updates.",
		ceiling: "medium",
		ceilingWhy:
			"unpatchability is a property of the product, not a way in. It raises the severity of every " +
			"other finding in the report and carries little on its own — cite it in their impact.",
	},
	{
		class: "secure-boot",
		claim: "the chain of trust can be broken, so code the vendor did not sign executes at boot",
		control:
			"a modified boot stage must actually execute. Boot code or keys sitting in rewritable flash " +
			"is the precondition, not the proof — show the device runs it, or record the reachability " +
			"and keep the finding suspected.",
	},
	{
		class: "debug-iface",
		claim: "a debug or test interface gives access it should not, to whoever can reach it",
		control:
			"the interface must yield something: a shell, a bootloader prompt, a halt-and-read over " +
			"JTAG. Populated pads are not a finding — plenty of boards expose test points that are " +
			"fused off or authenticated. Say which access level you reached, and whether opening the " +
			"enclosure was needed, because that is what decides whether it is in the threat model.",
		entitlement:
			"who is meant to be able to reach this? A debug header inside a sealed enclosure in a " +
			"locked cabinet and one on a retail device an attacker can buy are the same finding with " +
			"different severities. Establish the deployment from the target model or ask the operator.",
	},
	{
		class: "debug-code",
		claim: "debug functionality the vendor did not intend to ship is present and reachable in a production build",
		control:
			"it must be reachable in the SHIPPING configuration. A debug branch behind a compile-time " +
			"flag that is off, or an applet the build strips, is dead code — show the path from an " +
			"input an attacker controls, or this is a note about hygiene rather than a finding.",
	},
	{
		class: "side-channel",
		claim: "a secret can be recovered, or a check bypassed, through power, timing, EM or induced faults",
		control:
			"this cannot be settled from an image. It needs the hardware, the instrumentation and a " +
			"recovered key or a bypassed check to show for it — a non-constant-time comparison in a " +
			"decompilation is a lead. Record it suspected and say what rig would settle it; a claim " +
			"that a device is glitchable, with no glitch, is the kind of thing a client's engineer " +
			"disproves in an afternoon.",
		ceiling: "medium",
		ceilingWhy:
			"without the attack actually performed this is a design observation. It goes higher only " +
			"with a demonstrated key extraction or secure-boot bypass on real hardware.",
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

/**
 * Checklist ids that name a contract written under a different id.
 *
 * The four shipped checklists were written per target type and never agreed a
 * vocabulary: `web.json` calls it `traversal`, `code-review.json` calls it
 * `pathtrav`, and they are the same claim about the same containment failure.
 * Before this the code-review id resolved to nothing and every path-traversal
 * finding in a code review was challenged against the generic bar.
 *
 * `record` already knows the pair is confusable — it grew a spelling suggester
 * after a live run spent a third of a session working out why `traversal`
 * settled no cell against a checklist spelling it `pathtrav` (`core/tools.ts`).
 * So this is a fact about the shipped data, not a convenience, and the honest
 * place for it is next to the contracts it redirects into.
 *
 * An alias may not shadow a real contract id and must point at one that exists;
 * `challenge.test.ts` asserts both, and asserts that every class any shipped
 * checklist names resolves through here to exactly one contract.
 */
export const CLASS_ALIASES: Readonly<Record<string, string>> = {
	pathtrav: "traversal",
};

/** The contract for a class, when one is written. Unknown classes get the generic bar. */
export function contractFor(cls: string | undefined): VerificationContract | undefined {
	if (cls === undefined) return undefined;
	return BY_CLASS.get(cls) ?? BY_CLASS.get(CLASS_ALIASES[cls] ?? "");
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
	| "unusable-evidence"
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
 * A `path.ext:line` citation or a fenced excerpt — the static analogue of a
 * response on the wire.
 *
 * The bar is deliberately a citation and not merely code-shaped text. An excerpt
 * nobody can find again does not let a challenger re-read the guard, which is
 * the whole of what a static control case consists of.
 */
function hasCitation(text: string): boolean {
	return /[\w./-]+\.[A-Za-z]{1,6}:\d+/.test(text) || /^\s*```/m.test(text);
}

/** Where this finding's proof lives: on the wire, in the source, or nowhere yet. */
export type EvidenceShape = "wire" | "static" | "neither";

/**
 * Classify the proof rather than assume it.
 *
 * The audit was written on a live engagement, where evidence is a
 * request/response pair, and it asked every finding for one. `review` — the
 * read-only code-review profile, the one that needs no configuration and so the
 * one a first-time user runs — has no wire at all. A finding citing the very
 * snippet that contains the bug was told its evidence "contains no HTTP
 * response. A request nobody kept the answer to proves nothing", blocking, on a
 * demand the engagement cannot satisfy and the reviewer cannot act on. Every
 * code-review-only class added since (`sca`, `iac`, `crypto`, `logging`,
 * `reflection`, `codeinj`) would have inherited it.
 *
 * Wire is checked first, because a transcript that also quotes a source line is
 * still a transcript and still owes a response.
 */
export function evidenceShape(text: string): EvidenceShape {
	if (hasResponse(text) || hasRequest(text)) return "wire";
	if (hasCitation(text)) return "static";
	return "neither";
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

	// The finding's own location counts towards a static citation: a review that
	// records `target=src/auth/session.py:88` and pastes the function beside it
	// has cited the line, and asking it to repeat the path inside the file is
	// paperwork.
	const located = [f.target, ...(f.locations ?? [])].filter((x): x is string => typeof x === "string").join("\n");
	const shape = evidenceShape(`${evidenceText}\n${located}`);

	if (cited.length === 0) {
		gaps.push({
			kind: "no-evidence",
			detail: "no evidence cited. Save the request/response pair, or the file:line and the code at it, and cite the workspace path.",
			blocking: true,
		});
	} else if (Object.keys(input.evidence ?? {}).length > 0) {
		if (shape === "neither") {
			gaps.push({
				kind: "unusable-evidence",
				detail:
					`cited evidence (${cited.join(", ")}) holds neither an HTTP response nor a file:line ` +
					"citation. A challenger has to be able to go back to the thing that proves this — the " +
					"transcript on a live target, the line in the source on a review — and there is nothing " +
					"here to go back to.",
				blocking: true,
			});
		} else if (shape === "wire" && !hasResponse(evidenceText)) {
			gaps.push({
				kind: "no-response",
				detail: `cited evidence (${cited.join(", ")}) contains no HTTP response. A request nobody kept the answer to proves nothing.`,
				blocking: true,
			});
		} else if (shape === "wire" && !hasRequest(evidenceText)) {
			gaps.push({
				kind: "no-response",
				detail: `cited evidence (${cited.join(", ")}) contains a response but no request — the claim cannot be tied to what was sent.`,
				blocking: false,
			});
		}
	}

	const control = contract?.control ?? GENERIC_CONTROL;
	// Two authentication contexts is what an access-control control case looks
	// like ON THE WIRE, and only there. A code review proves the same claim by
	// showing the guard that the sibling operation has and this one does not, so
	// demanding two Cookie headers from a source excerpt asks for something the
	// evidence could never contain — it falls through to the recorded-control
	// check below, which is the right question for that medium.
	const needsTwo = contract?.entitlement !== undefined && shape === "wire";
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
// Grounded quotes — a verification's citations, checked against the source
// ---------------------------------------------------------------------------

/**
 * How far from the cited line a quote may sit and still count as that line's.
 *
 * Line numbers drift by a few in honest use: a model counts from a `read`
 * window's first line, cites the statement's opening line for a call that
 * spans three, or quotes the `if` above the line it names. Seven lines is one
 * guard and the statement it guards. Fixed before any v6 run and never tuned on
 * corpus runs (delegation-v6 Phase 3 design, 3.1): a tolerance fitted to what a
 * benchmark's verifiers happened to cite would be measuring the benchmark.
 */
export const QUOTE_WINDOW = 3;

/**
 * The shortest quote that can identify a line, in non-space characters.
 *
 * A quote proves the line was read only if it could not have been guessed.
 * `}`, `return err`, `if (!ok) {` and `else:` sit within three lines of almost
 * any line of any file, so matching one inside the window proves nothing
 * about the claim beside it. Twelve non-space characters is about the shortest
 * statement that carries an identifier and a call — `db.execute(q)` is
 * thirteen — so a real sink clears it and a brace does not. A guard shorter
 * than that (`if not user:` is ten) is quoted with the line it guards: the
 * window is matched as one joined text, so two lines quoted together count.
 * Chosen from the shape of source lines, never from runs, like the window
 * above.
 */
export const MIN_QUOTE_CHARS = 12;

/** A cited line and quote, as the model sends it: `file:line: verbatim text`. */
export interface ParsedQuote {
	file: string;
	/** First cited line, 1-based. */
	line: number;
	/** Last cited line, for a `file:12-14: text` range; the first otherwise. */
	end: number;
	quote: string;
}

/**
 * `file:line: text`, `file:lo-hi: text`, with the file free of spaces and
 * colons so a URL (`http://host:8080/x`) or prose is not read as a citation.
 */
const QUOTE_SHAPE = /^\s*([^\s:]+):(\d+)(?:-(\d+))?:\s*(\S.*?)\s*$/s;

/**
 * Parse one `file:line: verbatim text` string, or undefined when it is not one.
 *
 * A pair of backticks or quotes wrapped round the whole text is taken off: it
 * is how a model sets code apart, not part of the line.
 */
export function parseQuote(raw: string): ParsedQuote | undefined {
	const m = QUOTE_SHAPE.exec(raw);
	if (!m) return undefined;
	const line = Number(m[2]);
	const end = m[3] === undefined ? line : Number(m[3]);
	if (line < 1 || end < line) return undefined;
	let quote = m[4] ?? "";
	const wrapped = /^(`+|"|')([\s\S]*)\1$/.exec(quote);
	if (wrapped && (wrapped[2] ?? "").trim().length > 0) quote = (wrapped[2] ?? "").trim();
	return { file: (m[1] ?? "").replace(/^\.\//, ""), line, end, quote };
}

/** Runs of whitespace as one space, trimmed: indentation and wrapping are not content. */
function normaliseSpace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** One cited quote after it was checked against the file it names. */
export interface GroundedQuote extends QuotedLocation {
	grounded: boolean;
	/** Why it is not grounded, in words the reply can print. */
	why?: string;
	/** The cited line, when the string parsed. */
	line?: number;
	/** The text actually at the cited line, when the file was read — so the model can correct the quote in one turn. */
	actual?: string;
}

/**
 * How the host reads a cited file: under the engagement's directory, with its
 * basename fallback, or from the workspace's evidence. Returns the path it
 * resolved to, or undefined when there is no such file. A function rather than
 * a port so this module stays pure: the host owns the resolution rules.
 */
export type QuoteReader = (file: string) => Promise<{ path: string; body: string } | undefined>;

/** The longest `actual` line carried into a reply. */
const ACTUAL_BUDGET = 200;

/**
 * Check each `file:line: verbatim text` against the file it names.
 *
 * A quote is grounded when, after whitespace is normalised on both sides, it
 * appears within QUOTE_WINDOW lines of the cited line (or range), and it is at
 * least MIN_QUOTE_CHARS non-space characters long. The window is read as one
 * joined text, so a quote the model joined from two lines matches as well as
 * one taken from a single line.
 *
 * A string that is not in the form at all comes back ungrounded, saying so:
 * `path` and `guards` are quotes by contract. Every file is read once.
 */
export async function groundQuotes(hops: readonly string[] | undefined, readFile: QuoteReader): Promise<GroundedQuote[]> {
	const out: GroundedQuote[] = [];
	const cache = new Map<string, Promise<{ path: string; body: string } | undefined>>();
	const read = (file: string) => {
		let hit = cache.get(file);
		if (!hit) {
			hit = readFile(file).catch(() => undefined);
			cache.set(file, hit);
		}
		return hit;
	};
	for (const raw of hops ?? []) {
		if (raw.trim().length === 0) continue;
		const parsed = parseQuote(raw);
		if (!parsed) {
			out.push({ at: raw.trim(), quote: "", grounded: false, why: "it is not in the form 'file:line: verbatim text'" });
			continue;
		}
		const quote = normaliseSpace(parsed.quote);
		const cited = parsed.end === parsed.line ? `${parsed.file}:${parsed.line}` : `${parsed.file}:${parsed.line}-${parsed.end}`;
		const chars = quote.replace(/\s/g, "").length;
		if (chars < MIN_QUOTE_CHARS) {
			out.push({
				at: cited, quote, grounded: false,
				why: `the quote is ${chars} non-space characters; at least ${MIN_QUOTE_CHARS} are needed to identify a line`,
			});
			continue;
		}
		const found = await read(parsed.file);
		if (!found) {
			out.push({ at: cited, quote, grounded: false, why: `there is no file '${parsed.file}' under the engagement directory or in the workspace evidence` });
			continue;
		}
		const lines = found.body.split(/\r?\n/);
		const at = parsed.end === parsed.line ? `${found.path}:${parsed.line}` : `${found.path}:${parsed.line}-${parsed.end}`;
		if (parsed.line > lines.length) {
			out.push({ at, quote, grounded: false, why: `${found.path} has ${lines.length} lines` });
			continue;
		}
		const lo = Math.max(0, parsed.line - 1 - QUOTE_WINDOW);
		const hi = Math.min(lines.length, parsed.end + QUOTE_WINDOW);
		const window = normaliseSpace(lines.slice(lo, hi).join(" "));
		if (window.includes(quote)) {
			out.push({ at, quote, grounded: true });
			continue;
		}
		const actual = normaliseSpace(lines[parsed.line - 1] ?? "");
		out.push({
			at, quote, grounded: false, line: parsed.line,
			why: `the quote is not within ${QUOTE_WINDOW} lines of line ${parsed.line}`,
			actual: actual.length > ACTUAL_BUDGET ? `${actual.slice(0, ACTUAL_BUDGET)}…` : actual,
		});
	}
	return out;
}

/** A quote as stored: where, and what. The grounding result stays out of the ledger. */
function stored(q: GroundedQuote): QuotedLocation {
	return { at: q.at, quote: q.quote };
}

/**
 * The quotes that failed, one per line, each with the text actually at its
 * cited line — the reply that lets a model fix a quote in one turn.
 */
export function describeUngrounded(quotes: readonly GroundedQuote[]): string {
	return quotes
		.filter((q) => !q.grounded)
		.map((q) => `- ${q.at}${q.quote ? ` "${q.quote}"` : ""}: ${q.why ?? "not found"}` +
			(q.actual !== undefined ? `; line ${q.line ?? "?"} reads: ${q.actual.length > 0 ? `"${q.actual}"` : "(blank)"}` : ""))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Who wrote a row, and who judged it
// ---------------------------------------------------------------------------

/**
 * Whether `by` names a delegated worker rather than the lead, its scribe or the
 * operator. Absent is not a worker: a row written before `by` existed is
 * unknown, and is left out of every count that separates workers from the lead.
 */
export function isWorkerAuthor(by: string | undefined): boolean {
	return by !== undefined && by !== LEAD_AUTHOR && by !== SCRIBE_AUTHOR && by !== OPERATOR_AUTHOR;
}

/**
 * The party behind an author. The scribe writes from the lead's own review
 * buffer, so its findings are the lead's reasoning: a lead confirming a
 * scribe's finding is the finder confirming itself, which is the agreement
 * the scribe measurement showed (precision 0.059 to 0.038).
 */
function partyOf(by: string): string {
	return by === SCRIBE_AUTHOR ? LEAD_AUTHOR : by;
}

/**
 * Whether a finding's verification was made by someone other than its finder:
 * true or false when both authors are recorded, undefined when either is not.
 *
 * Two launches of one worker share its agent name, so a second
 * `pired-investigate` reading the first one's finding counts as its finder.
 * That errs toward "not independent", which is the side a report can afford.
 */
export function isIndependent(finding: Pick<FindingRecord, "by" | "verification">): boolean | undefined {
	const judgedBy = finding.verification?.by;
	if (finding.by === undefined || judgedBy === undefined) return undefined;
	return partyOf(finding.by) !== partyOf(judgedBy);
}
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
	/**
	 * The engagement has no live target — a review of source, with nothing
	 * running to reach. Set by the host from the engagement's scope, never by
	 * the challenger: it decides whether `live=false` can mean anything at all.
	 */
	sourceOnly?: boolean;
	/**
	 * The `path` the challenger quoted, grounded by the host (`groundQuotes`):
	 * the hops from where untrusted input enters to where it is used, the first
	 * the source and the last the sink.
	 */
	path?: GroundedQuote[];
	/** The `guards` the challenger quoted — the checks it examined — grounded by the host. */
	guards?: GroundedQuote[];
	/**
	 * The entries of `basis` written as quotes, grounded by the host. `basis`
	 * itself keeps every entry as sent: an evidence path or a model section is
	 * still a citation, only not one this can check against a file.
	 */
	basisQuotes?: GroundedQuote[];
	/** Who is judging, stamped as `verification.by`. Set by the host from where the call ran, never by the challenger. */
	by?: string;
	/**
	 * The contents of the evidence files the challenge cites, read by the host.
	 * Only the tier reads them: a cited transcript or tool output is a check that
	 * ran, where a quoted excerpt is a reading.
	 */
	evidence?: string[];
}

/**
 * How far a verification's grounds reach, derived and never taken from the
 * caller. `executed` when it was live against a running target, or cites
 * evidence that is not a static excerpt (a transcript, a tool's output);
 * `static` otherwise.
 *
 * `live=true` counts only where there is a target. On the 2026-09-24 grid 17 of
 * 18 settled verification records asserted live=true on scopes with no target
 * (ADR-028); on a review of source the flag describes nothing that ran.
 * `executed` is the top label, not a gate: nothing is refused for being static.
 */
export function deriveTier(report: Pick<ChallengeReport, "live" | "sourceOnly" | "evidence">): VerificationTier {
	if (report.live === true && report.sourceOnly !== true) return "executed";
	const ran = (report.evidence ?? []).some((text) => text.trim().length > 0 && evidenceShape(text) !== "static");
	return ran ? "executed" : "static";
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
	/**
	 * The earned verification this look was not allowed to replace. Set when the
	 * look settled nothing and the finding already carried a verdict that met
	 * its bar; `verification` is then that verdict, with this look's grounds
	 * added to its notes.
	 */
	kept?: Verification;
}

/** Verdicts whose bar was met: they settle a finding, and nothing unproven replaces them. */
const EARNED_VERDICTS: readonly ChallengeVerdict[] = ["stands", "amended", "refuted"];

/** Whether a verification records a challenge that settled the finding. */
export function isEarned(v: Pick<Verification, "verdict"> | undefined): boolean {
	return v !== undefined && EARNED_VERDICTS.includes(v.verdict);
}

/**
 * Whether a challenge said what it looked at: a cited basis, or the control
 * case it ran. The bar for writing down a look that could not settle a claim.
 *
 * A `reason` alone does not meet it. `reason` is a note any edit may carry — a
 * finder rewording its description passes one — and counting it as a look
 * would record a challenge nobody made.
 */
export function hasGrounds(report: Pick<ChallengeReport, "basis" | "control">): boolean {
	return (report.basis ?? []).some((b) => b.trim().length > 0) || said(report.control);
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
 *   - To REFUTE: a cited basis is required, and — when the engagement has a
 *     live target — that target must have been reachable. "I could not
 *     reproduce it" against an expired session refutes nothing, and an
 *     engagement re-verified on its last day with a dead token would otherwise
 *     refute every true finding it holds. A source-only review has no target to
 *     be unreachable, so there the cited basis is the whole bar.
 *   - When either bar is missed the status does not move: an unverified finding
 *     stays `suspected` — not confirmed, not refuted, still in the ledger,
 *     still in the report under its own heading — and one already settled
 *     stays settled. An unproven challenge is not allowed to settle anything,
 *     and so it is not allowed to unsettle anything either.
 *   - A challenge that reports `unresolved` with its grounds is kept as what it
 *     is: a look that could not settle the claim. The status does not move and
 *     the grounds go on the record, so the next reader knows it was examined
 *     and what was missing.
 *   - Neither kind of look replaces an earned verification (`stands`,
 *     `amended`, `refuted`). The earned one stays the finding's verification,
 *     and the new look's grounds are added to its notes.
 *
 * The safety property is that there is no input to this function that removes
 * a finding.
 */
export function judge(finding: FindingRecord, report: ChallengeReport, at: string): ChallengeOutcome {
	const contract = contractFor(finding.class);
	const basis = (report.basis ?? []).filter((b) => b.trim().length > 0);
	const wasReported = finding.status === "reported" ? true : undefined;

	// `live=false` in a review of source says there was nothing running, not that
	// a target was down. Stored, the report renders it as "target was not
	// reachable" beside a refutation the source settled, which reads as the very
	// dead-session refutation the live rule exists to reject. So it is left off
	// there. Against a live target it is kept: there it is a claim about
	// reachability, and the reason a refutation was not accepted.
	const live = report.sourceOnly === true && report.live === false ? undefined : report.live;
	const path = report.path ?? [];
	const guards = report.guards ?? [];
	const quotes = [...path, ...guards, ...(report.basisQuotes ?? [])];
	const ungrounded = quotes.filter((q) => !q.grounded);
	// Quotes are kept only when every one matched its file: a path with a hop
	// that is not in the source is not a path anybody traced.
	const keepQuotes = ungrounded.length === 0;
	const verification = (verdict: ChallengeVerdict): Verification => ({
		verdict, at,
		...(report.by !== undefined ? { by: report.by } : {}),
		...(report.control !== undefined ? { control: report.control } : {}),
		...(basis.length > 0 ? { basis } : {}),
		...(keepQuotes && path.length > 0 ? { path: path.map(stored) } : {}),
		...(keepQuotes && guards.length > 0 ? { guards: guards.map(stored) } : {}),
		...(isEarned({ verdict }) ? { tier: deriveTier(report) } : {}),
		...(live !== undefined ? { live } : {}),
		...(report.entitlement !== undefined ? { entitlement: report.entitlement } : {}),
		...(report.notes !== undefined ? { notes: report.notes } : {}),
	});

	// What a look that settles nothing leaves behind. It may not move the status:
	// written as `suspected` unconditionally, a verifier re-recording a confirmed
	// or reported finding with "could not settle it" demoted it, and the child
	// gate tells a verifier to do exactly that on a reported one. A legacy `open`
	// is the same unverified state and is written as `suspected`. Nor may it
	// replace a verification that met its bar: the earned verdict stays, and the
	// new look's grounds go into its notes, where the report shows them.
	const standing = isEarned(finding.verification) ? finding.verification : undefined;
	const unmoved: FindingStatus = finding.status === undefined || finding.status === "open" ? "suspected" : finding.status;
	const settledNothing = (look: Verification, why?: string): ChallengeOutcome => ({
		verdict: "unresolved",
		status: unmoved,
		verification: standing === undefined ? look : {
			...standing,
			notes: [standing.notes, `later look ${look.at}, unsettled: ${describeLook(look)}`].filter(Boolean).join(" — "),
		},
		...(why !== undefined ? { downgraded: why } : {}),
		...(standing ? { kept: standing } : {}),
		...(wasReported ? { wasReported } : {}),
	});

	const unresolved = (why: string, blocker?: ChallengeOutcome["blocker"]): ChallengeOutcome => ({
		...settledNothing({ ...verification("unresolved"), notes: [report.notes, why].filter(Boolean).join(" — ") }, why),
		...(blocker ? { blocker } : {}),
	});

	// A quote that is not in the file it cites settles nothing, in either
	// direction and whoever wrote it. It is the one check here that costs no
	// judgement: the line either says it or it does not. The reply prints what
	// the line does say, so a model that paraphrased or miscounted can fix it in
	// one turn instead of guessing (delegation-v6 Phase 3 design, 3.1).
	if (ungrounded.length > 0) {
		return unresolved(
			`${ungrounded.length === 1 ? "a quote does" : `${ungrounded.length} quotes do`} not match the file it cites, ` +
			`so nothing was settled on ${ungrounded.length === 1 ? "it" : "them"}:\n${describeUngrounded(ungrounded)}\n` +
			`Quote the line as it reads, copied from the file — 'file:line: verbatim text', within ${QUOTE_WINDOW} lines of ` +
			"the line cited — and record the verdict again.",
		);
	}

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
		//
		// Only when there is a target, though. In a source-only review nothing is
		// running, so an honest verifier says live=false and this downgraded every
		// refutation it made: measured on the 2026-09-24 grid, the runs that did
		// settle findings got there by asserting live=true on scopes with no
		// target at all (17 of 18 verification records), and the ones that told
		// the truth could not refute anything. A rule that only a false statement
		// passes is teaching the statement, not guarding the finding.
		if (report.live === false && report.sourceOnly !== true) {
			return unresolved(
				"the target was not reachable, or the session was not valid, while this was challenged. " +
				"That refutes the connection, not the finding — re-challenge with a working session.",
			);
		}
		// On a review of source the cited line is the whole proof, so it has to be
		// shown, not named. A bare `file:line` cannot be checked against the file;
		// the guard's own text can, and it is what the adjudication rubric's
		// `guarded` label asks for. A live target keeps ADR-009's bar: there the
		// grounds are the control case run on the wire.
		if (report.sourceOnly === true && quotes.length === 0) {
			return unresolved(
				"a refutation of source quotes what makes this not a finding — the guard, or the line that shows the " +
				"claim is wrong — as 'file:line: verbatim text' in basis or guards. A line number alone cannot be " +
				"checked against the file, and a refutation withdraws a finding from the report.",
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
		// On a review of source nothing ran, so the claim that input reaches the
		// sink is only as good as the trace: the line where it enters and the line
		// where it is used, each quoted as it reads. On the 2026-09-24 grid 17 of
		// 18 settled verification records rested on a live=true that described no
		// running target (ADR-028): a control case alone is a sentence.
		if (report.sourceOnly === true && path.length < 2) {
			return unresolved(
				"a confirmation on a review of source quotes the path the input takes: path=[the source hop, …, the " +
				"sink hop], each 'file:line: verbatim text'. The first is where untrusted input enters, the last where " +
				"it is used; one line holding both is quoted twice.",
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

	// A look that could not settle it, with what it did look at. Before this
	// `status=suspected` carried nothing, so such a look had nowhere on the row
	// to go. On the 2026-09-24 grid, 10 of 15 verify tasks whose instructions
	// said "do not change status" left no verdict on any row, while the challenge
	// brief told them to set the finding's status (ADR-028). That shows verdicts
	// never reaching a row under conflicting instructions, not how many this path
	// would have caught. Nothing is asserted here — the status does not move,
	// and an earned verification is not replaced — so the bar is only having
	// said what was looked at: a basis or a control case (`hasGrounds`).
	if (report.verdict === "unresolved" && hasGrounds(report)) {
		return settledNothing(verification("unresolved"));
	}

	return unresolved("challenge returned no conclusion");
}

function said(v: string | undefined): boolean {
	return v !== undefined && v.trim().length > 0;
}

/** A look's grounds as one line, for the notes of the verdict it did not replace. */
function describeLook(v: Verification): string {
	const parts = [
		v.basis?.length ? `basis ${v.basis.join(", ")}` : undefined,
		said(v.control) ? `control ${v.control}` : undefined,
		said(v.notes) ? v.notes : undefined,
	].filter((p): p is string => p !== undefined);
	return parts.length > 0 ? parts.join("; ") : "no grounds given";
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
	out.push(`- ${LIVE_RULE}`);
	out.push("- To refute, cite: the file:line, the evidence path, or the model section that makes this not a finding. An uncited refutation is recorded as unresolved and changes nothing.");
	out.push("- To confirm, run the control case and say what it returned.");
	out.push("- \"I could not reproduce it\" is not a refutation. Say what you ran and what came back.");
	out.push("");
	// The same bar `judge` applies on the way in, stated in the fields `record`
	// reads. The brief used to ask for a verdict in its own vocabulary
	// (stands|amended|…) and the delegation text for grounds in `reason`, which
	// the gate does not read as a basis — so a verifier following the brief
	// wrote a refutation the gate recorded as unresolved, or wrote nothing.
	// Measured on the 2026-09-24 grid: 6 pired-verify children recorded
	// nothing, 4 of them handing back early with a verdict that was never
	// written, and 4 of 6 amended or refuted verdicts never reached the finding.
	out.push(`Record the verdict on this finding by its id — \`record kind=finding id=${finding.id}\` — as its status, with what earns it:`);
	out.push(`- confirmed: control="the control case and what it returned"${contract?.entitlement ? `, entitlement="how you established the caller was not meant to reach it"` : ""}.`);
	// `live` is asked for only where it is true. judge() takes an absent `live`
	// as no claim about reachability and downgrades only live=false against a
	// live target. Told "live=true|false", a verifier whose basis was the source
	// has only the second to give, and on an engagement with a target that is
	// the one answer that refutes nothing.
	out.push("- refuted: basis=[the file:line, evidence path or model section that makes it not a finding]. live=true when you tested the running target; leave live out when your basis is the source.");
	out.push("- suspected: basis=[what you read] or control=\"what you ran and what came back\", when you could not settle it. That is a result too: the finding keeps its status and your grounds are kept on it. A reason alone is a note, not a look.");
	out.push("Save raw output with `record kind=evidence` and cite the path it returns in basis or control.");
	out.push("The claim itself — title, description, location, severity — is the operator's to amend. If it stands but is overstated or misdescribed, record the verdict and say what is wrong in reason.");
	return out.join("\n");
}

/**
 * When reachability matters, said once for both briefs.
 *
 * The rule exists for a live target — a dead session refutes nothing — and a
 * review of source has nothing running to reach. Stated unconditionally it
 * asked a source-only verifier to prove something that cannot exist; `judge`
 * no longer asks it, so the brief does not either.
 */
const LIVE_RULE =
	"When the engagement has a live target, prove it is reachable and your session is valid BEFORE concluding " +
	"anything failed — a dead session refutes nothing. A review of source has no target to reach; there the cited line is the proof.";

/**
 * Whether this finding still waits on a challenge that settles it.
 *
 * `suspected` is the default status precisely because an absent `verification`
 * means unexamined rather than examined-and-cleared, so the queue is everything
 * still live that no challenge has settled. Exported because several places
 * ask the question — the `recall challenge` queue, the standing brief, the
 * pass command's count — and a second copy of this predicate is a second answer
 * to it.
 *
 * Only an earned verdict takes a finding out: a verification that met its bar
 * (`isEarned`), or a confirmed or disposed status. A look that could not settle
 * the claim — an `unresolved` verification, whether a verifier said so or
 * `judge` downgraded a refutation or confirmation that missed its bar — leaves
 * it in. Taking those out, as the rule before this did, let `recall challenge`
 * say "Nothing unchallenged" over a finding whose only look said "could not
 * tell", which hides exactly the work that is left. What the look found is on
 * the row, and the queue lists it (`unsettledLabel`).
 *
 * And an earned verification settles only a finding whose status still says
 * so. `judge` never leaves an earned verdict on an unverified status, so a
 * finding that is `suspected` (or a legacy `open`, or has none) with one is a
 * finding someone moved back down by id — the operator's documented escape
 * hatch for correcting a record. Read from the verification alone, that
 * correction took the finding out of the queue it was put back into.
 */
export function isUnchallenged(finding: Pick<FindingRecord, "status" | "verification">): boolean {
	if ((DISPOSED_STATUSES as readonly string[]).includes(finding.status ?? "")) return false;
	if (finding.status === "confirmed") return false;
	if (isUnverifiedStatus(finding.status)) return true;
	return !isEarned(finding.verification);
}

/** `suspected`, the legacy `open`, or no status at all: nothing has settled it. */
function isUnverifiedStatus(status: FindingStatus | undefined): boolean {
	return status === undefined || status === UNVERIFIED_STATUS || status === "open";
}

/**
 * Still in the queue, but somebody has already looked: the verification it
 * carries is a look that could not settle it.
 */
export function isExaminedUnsettled(finding: Pick<FindingRecord, "status" | "verification">): boolean {
	return finding.verification !== undefined && isUnchallenged(finding);
}

/**
 * Everything unsettled, worst first — a challenge budget is spent top-down —
 * with the examined-but-unsettled after every finding nobody has examined.
 *
 * A second look at a claim is worth less than a first look at one nobody has
 * checked, so a fresh finding is not queued behind one a verifier already
 * spent a launch on. On the 2026-09-24 grid 10 of 15 verify tasks told "do not
 * change status" left no verdict on any row, so the queue could not tell those
 * findings from ones nobody had opened, and would have handed them out again as
 * if new. That they were re-handed is inferred from how the queue worked, not
 * measured.
 */
export function unchallengedQueue(findings: FindingRecord[]): FindingRecord[] {
	const examined = (f: FindingRecord): number => (isExaminedUnsettled(f) ? 1 : 0);
	return findings
		.filter(isUnchallenged)
		.slice()
		.sort((a, b) => examined(a) - examined(b) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Longest look summary carried onto a queue line before it costs more than it informs. */
const UNSETTLED_NOTE_BUDGET = 160;

/**
 * "examined, unsettled: <what the look said>" for a finding in the queue that
 * somebody has already looked at, and undefined for one nobody has.
 *
 * Said wherever the queue is listed, so whoever spends the next look knows it is
 * a second one and what the first could not settle.
 */
export function unsettledLabel(finding: Pick<FindingRecord, "status" | "verification">): string | undefined {
	if (!isExaminedUnsettled(finding)) return undefined;
	const v = finding.verification;
	const gist = [v?.notes, v?.control, v?.basis?.join(", ")].find((x) => x !== undefined && x.trim().length > 0)?.trim();
	const note = gist === undefined ? "no grounds recorded"
		: gist.length > UNSETTLED_NOTE_BUDGET ? `${gist.slice(0, UNSETTLED_NOTE_BUDGET)}…` : gist;
	// A verdict that met its bar, on a finding moved back down by id. "Unsettled"
	// beside the control case of a `stands` would read as a look that could not
	// tell; what happened is that someone set the verdict aside.
	if (isEarned(v)) return `examined, moved back to ${finding.status ?? UNVERIFIED_STATUS} from a ${v?.verdict} verdict: ${note}`;
	return `examined, unsettled: ${note}`;
}

/** How many of the queue to name before the rest becomes a count. */
const BRIEF_NAMED = 3;

/** How many worker-recorded ids the brief names before the rest becomes a count. */
const BRIEF_WORKER_IDS = 6;

/**
 * Who recorded a finding and who judged it, as a suffix for a listing line:
 * " · by pired-investigate · verified by pired-verify, static". Empty for a row
 * written before `by` existed with no verification, so an old ledger lists as
 * it did.
 *
 * The tier is said beside the verdict because a confirmation read from quoted
 * source and one run against a target are different claims, and a list that
 * prints both as "confirmed" hides the difference (3.1).
 */
export function provenanceLabel(finding: Pick<FindingRecord, "by" | "verification">): string {
	const parts: string[] = [];
	if (finding.by !== undefined) parts.push(`by ${finding.by}`);
	const v = finding.verification;
	if (v !== undefined && isEarned(v)) {
		const who = v.by === undefined ? "" : isIndependent(finding) === false ? ` by ${v.by} (its finder)` : ` by ${v.by}`;
		parts.push(`${v.verdict === "refuted" ? "refuted" : "verified"}${who}${v.tier ? `, ${v.tier}` : ""}`);
	}
	return parts.map((p) => ` · ${p}`).join("");
}

/**
 * The unchallenged findings, as a line for the standing brief.
 *
 * ADR-007 built the contract that settles a claim and left nothing to say a
 * claim was waiting: a finding could sit at `suspected` for a whole engagement
 * with the challenge machinery installed and idle, because consulting the
 * ledger is exactly what a reviewer does not do — measured at one `recall` per
 * session. The coverage block fixed that for untested *cells*; this is the same
 * fix for unverified *claims*.
 *
 * States the fact and asks for nothing, for the reason the coverage block does:
 * choosing what to spend a challenge on is the reviewer's judgement, and
 * re-running a proof touches a client's system again — so this can inform the
 * decision but must not make it.
 */
export function unchallengedBrief(findings: FindingRecord[]): string {
	const queue = unchallengedQueue(findings);
	if (queue.length === 0) return "";

	const named = queue.slice(0, BRIEF_NAMED).map((f) => {
		const label = unsettledLabel(f);
		return `${f.id} [${f.severity}] ${f.title}${label ? ` (${label})` : ""}`;
	});
	const rest = queue.length - named.length;
	// The examined sort last, so they are the ones a short list drops; the count
	// still says they are there.
	const restExamined = queue.slice(BRIEF_NAMED).filter(isExaminedUnsettled).length;
	const more = rest > 0 ? `; +${rest} more${restExamined > 0 ? ` (${restExamined} examined, unsettled)` : ""}` : "";
	const subject = queue.length === 1 ? "1 finding has" : `${queue.length} findings have`;
	// Which of them a worker recorded. A worker's finding is a lead nobody but
	// its finder has read, and the finder does not settle it (3.1), so the lead
	// is told how many are waiting on an independent look — counted, and named
	// up to a bound, never listed whole.
	const byWorkers = queue.filter((f) => isWorkerAuthor(f.by));
	const workerIds = byWorkers.slice(0, BRIEF_WORKER_IDS).map((f) => f.id).join(", ");
	const workerMore = byWorkers.length > BRIEF_WORKER_IDS ? ` +${byWorkers.length - BRIEF_WORKER_IDS} more` : "";
	const workers = byWorkers.length === 0 ? ""
		: ` ${byWorkers.length === queue.length ? (queue.length === 1 ? "It was" : "All were") : `${byWorkers.length} of them were`} ` +
			`recorded by ${byWorkers.length === 1 ? "a worker" : "workers"}: ${workerIds}${workerMore} — a worker's finding is settled by a verifier or by you, not by its finder.`;
	return `${subject} not been settled by a challenge: ${named.join("; ")}${more}.${workers} `
		+ "`recall challenge id=<id>` returns the brief for one — it is built from the record and the "
		+ "class contract, never from the conversation, so it can be handed to a fresh agent that has "
		+ "not seen the reasoning that produced the claim.";
}

/** What the ledger already knows around a cell, for a verifier that arrives cold. */
export interface HypothesisContext {
	/** Human label for the element under test — the route, the file, the host. */
	element?: string;
	/** The engagement's working theory of the target (`model.md`). */
	targetModel?: string;
	/** Findings already recorded on this element, or on this class elsewhere. */
	neighbours?: FindingRecord[];
	/** Other hypotheses that touched the same element. */
	siblings?: HypothesisRecord[];
}

/** Neighbouring rows named before the list becomes a count. */
const BRIEF_NEIGHBOURS = 6;

/** Longest target-model excerpt carried into a brief before it costs more than it informs. */
const BRIEF_MODEL_BUDGET = 1200;

/**
 * The brief for challenging one test case.
 *
 * `challengeBrief` challenges a *claim that something is broken*. This
 * challenges the opposite, and the opposite is where the harness was blind: a
 * hypothesis recorded `refuted` turns its coverage cell `clear`, that cell
 * counts toward the percentage handed to the client, and nothing ever looks
 * again. The costliest outcome in this whole system is a missed vulnerability,
 * and a wrong refutation is the one path to it that carried no second look at
 * all — findings get challenged, refutations were taken at their word.
 *
 * So the framing inverts. Against a finding the verifier tries to break the
 * claim; here it tries to break the *clearance*, which means finding the input
 * the refutation did not consider or the path it did not follow.
 *
 * It carries more of the ledger than the finding brief does, deliberately. A
 * finding arrives with its own evidence and reproduction; a cleared cell
 * arrives with almost nothing, so what makes the second look worth paying for
 * is everything the engagement has learned *since* — the same class confirmed
 * on a neighbouring element, the invariant the target model has since named.
 * None of that is the reasoning that produced the refutation, which the
 * verifier still must not see.
 */
export function hypothesisBrief(h: HypothesisRecord, ctx: HypothesisContext = {}): string {
	const contract = contractFor(h.class);
	const cleared = h.outcome === "refuted";
	const out: string[] = [];

	out.push(`Challenge hypothesis ${h.id}: "${h.statement}" [class ${h.class}, outcome ${h.outcome}]`);
	out.push("");
	out.push(cleared
		? "The agent that ran this test case concluded it is CLEAR, and that verdict is why the "
			+ "coverage matrix counts this cell as settled. Your job is to disagree with it. You have not "
			+ "seen the reasoning that produced it and you do not need it."
		: "Nobody has settled this test case. Your job is to settle it — in either direction, and a "
			+ "refutation counts. You have not seen the reasoning behind it and you do not need it.");
	out.push("");
	out.push(`Test case: ${h.class}, asked of ${ctx.element ?? h.target ?? "(no element recorded)"}`);
	if (h.method) out.push(`Method stated: ${h.method}`);
	if (h.evidence) out.push(`Evidence on file: ${h.evidence}`);
	out.push("");
	out.push(`For this to be a bug: ${contract?.claim ?? "the described effect actually occurs"}`);
	out.push(`The control case: ${contract?.control ?? GENERIC_CONTROL}`);
	if (contract?.entitlement) out.push(`The entitlement question: ${contract.entitlement}`);

	// Capped, for the same reason the target model is. This brief is read by a
	// child, which has the least context room in the system — an engagement with
	// forty findings of one class would otherwise send all forty.
	const known: string[] = [];
	for (const f of (ctx.neighbours ?? []).slice(0, BRIEF_NEIGHBOURS)) {
		known.push(`- ${f.id} [${f.severity}/${f.status}] ${f.title}${f.class ? ` (class ${f.class})` : ""}`);
	}
	for (const sib of (ctx.siblings ?? []).filter((sib) => sib.id !== h.id).slice(0, BRIEF_NEIGHBOURS)) {
		known.push(`- ${sib.id} [${sib.class}/${sib.outcome}] ${sib.statement}`);
	}
	const dropped = Math.max(0, (ctx.neighbours?.length ?? 0) - BRIEF_NEIGHBOURS)
		+ Math.max(0, (ctx.siblings ?? []).filter((sib) => sib.id !== h.id).length - BRIEF_NEIGHBOURS);
	if (dropped > 0) known.push(`- (+${dropped} more — \`recall findings\` and \`recall hypotheses\` for the rest)`);
	if (known.length > 0) {
		out.push("");
		out.push("What the ledger already knows here — none of it is the refutation's reasoning:");
		out.push(...known);
	}

	const model = ctx.targetModel?.trim();
	if (model) {
		out.push("");
		out.push("The engagement's working theory of this target:");
		out.push(model.length > BRIEF_MODEL_BUDGET
			? `${model.slice(0, BRIEF_MODEL_BUDGET)}\n… truncated — \`recall model\` for the rest.`
			: model);
	}

	out.push("");
	out.push("Rules:");
	if (cleared) {
		out.push("- A refutation is only as good as its basis. Look for the input it did not consider, the "
			+ "call path it did not follow, or the sanitiser that does not do what its name says.");
		out.push("- Agreeing is a real result, but say what you checked: \"parameterized at core/db.js:41 and "
			+ "no other path reaches it\" is a refutation; \"I could not find anything\" is not.");
	} else {
		out.push("- Run the control case. Output that merely contains the payload is not the effect.");
		out.push("- Ruling the class out is a result. Record it, with the specific reason.");
	}
	out.push(`- ${LIVE_RULE}`);
	out.push("- Re-run the read, never the write. Nothing destructive; park an approval blocker instead.");
	out.push("");
	// Stated in the fields `record` reads. This used to say "your basis in the
	// reason", and `reason` is a note: only `basis` writes the verification that
	// marks a cell as re-checked, so a verifier that followed the brief to the
	// letter left the clearance looking as if nobody had looked twice.
	out.push(`Record the verdict on this hypothesis by its id — \`record kind=hypothesis id=${h.id}\` — with `
		+ "basis=[the file:line or evidence path that grounds it]; the basis is what marks the cell as re-checked:");
	out.push("- clear: outcome=refuted, statement=\"what you checked and why it holds\".");
	// title and severity are the two fields a new finding is refused without,
	// so a brief that leaves them out walks the verifier into a refusal on the
	// one write that reaches the report.
	out.push(`- vulnerable: outcome=confirmed, statement="what holds", then record the finding — \`record kind=finding\` with title="...", severity=..., `
		+ `class=${h.class}, its file:line or element as target and hypothesisId=${h.id} (title and severity are required). `
		+ "It lands suspected unless it carries status=confirmed with the control case you ran — control=\"what it returned\""
		+ `${contract?.entitlement ? ", and entitlement=\"how you established the caller was not meant to reach it\"" : ""}. `
		+ "Only a finding reaches the report; a confirmed cell does not.");
	out.push("- unsettled: outcome=inconclusive, statement=\"what is missing\", basis=[what you checked] — a hypothesis keeps no reason.");
	out.push("Save raw output with `record kind=evidence` and cite the path it returns in basis.");
	return out.join("\n");
}

/** What `/challenge` should put on screen, and in which tone. */
export interface ChallengeCommandView {
	text: string;
	tone: "info" | "warning";
	/** The finding the brief is for, when one was resolved. Lets a caller act on it. */
	finding?: FindingRecord;
}

export interface ChallengeCommandInput {
	findings: FindingRecord[];
	/** What the operator typed after the command, already trimmed. */
	id?: string;
	targetModel?: string;
	/** Evidence bodies by workspace-relative path, for the gap audit. */
	evidence?: Record<string, string>;
}

/**
 * `/challenge`, as a function of the ledger.
 *
 * The command's decisions — is anything waiting, does this id exist, what does a
 * verifier need to be told — lived in `extensions/pired.ts`, which is 38%
 * covered and is the file CLAUDE.md names as the one to keep moving logic *out*
 * of. It shipped with no test at all, and the argument for moving it is the same
 * one `pickTargetType` made: a decision nothing can test is a decision that goes
 * quietly wrong, and both of this session's schema bugs were exactly that.
 *
 * The host is left with what only a host can do: read the workspace and draw the
 * result.
 */
export function challengeCommand(input: ChallengeCommandInput): ChallengeCommandView {
	const id = input.id?.trim() ?? "";

	if (!id) {
		const queue = unchallengedQueue(input.findings);
		if (queue.length === 0) {
			return { tone: "info", text: "pired: nothing unchallenged — every live finding has been through a challenge that settled it" };
		}
		const list = queue.map((f) => {
			const label = unsettledLabel(f);
			return `· ${f.id} [${f.severity}] ${f.title}${provenanceLabel(f)}${label ? ` — ${label}` : ""}`;
		}).join("\n");
		return {
			tone: "info",
			text: `pired: ${queue.length} finding(s) carry no settled verdict\n${list}\n\n/challenge <id> for the brief on one.`,
		};
	}

	const finding = input.findings.find((f) => f.id === id);
	if (!finding) {
		return { tone: "warning", text: `pired: no finding called "${id}" — /challenge lists what is unverified` };
	}

	const brief = challengeBrief(finding, auditFinding({
		finding,
		...(input.evidence ? { evidence: input.evidence } : {}),
		...(input.targetModel ? { targetModel: input.targetModel } : {}),
	}));
	// The delegation line names the CLI rather than pasting the brief into a task
	// string: a child can fetch its own brief, and a task prompt that carries one
	// is a task prompt nobody reads.
	return {
		tone: "info",
		finding,
		text: `${brief}\n\nTo hand this to a subagent, spawn one whose job is to break the claim. It needs nothing `
			+ `from this conversation — it reads the brief itself with \`pired-ledger recall challenge id=${id}\` and `
			+ `records the verdict with \`pired-ledger record kind=finding id=${id}\` — status=confirmed with control, `
			+ "status=refuted with basis, or status=suspected with basis or control when it cannot be settled. "
			+ "The verdict is judged against the class contract on the way in, so it cannot be asserted.",
	};
}
