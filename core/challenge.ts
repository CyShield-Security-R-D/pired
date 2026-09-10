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
	type Severity, type Verification,
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

/**
 * Whether nobody has looked at this finding twice.
 *
 * `suspected` is the default status precisely because an absent `verification`
 * means unexamined rather than examined-and-cleared, so the queue is everything
 * still live that no challenge has settled. Exported because two places ask the
 * question — the `recall challenge` queue and the standing brief — and a second
 * copy of this predicate is a second answer to it.
 */
export function isUnchallenged(finding: Pick<FindingRecord, "status">): boolean {
	if ((DISPOSED_STATUSES as readonly string[]).includes(finding.status ?? "")) return false;
	return finding.status !== "confirmed";
}

/** Everything unsettled, worst first — a challenge budget is spent top-down. */
export function unchallengedQueue(findings: FindingRecord[]): FindingRecord[] {
	return findings
		.filter(isUnchallenged)
		.slice()
		.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** How many of the queue to name before the rest becomes a count. */
const BRIEF_NAMED = 3;

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

	const named = queue.slice(0, BRIEF_NAMED).map((f) => `${f.id} [${f.severity}] ${f.title}`);
	const rest = queue.length - named.length;
	const list = rest > 0 ? `${named.join("; ")}; +${rest} more` : named.join("; ");
	const subject = queue.length === 1 ? "1 finding has" : `${queue.length} findings have`;
	return `${subject} been through no challenge: ${list}. `
		+ "`recall challenge id=<id>` returns the brief for one — it is built from the record and the "
		+ "class contract, never from the conversation, so it can be handed to a fresh agent that has "
		+ "not seen the reasoning that produced the claim.";
}
