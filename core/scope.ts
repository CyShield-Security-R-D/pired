/**
 * Engagement scope: matching, best-effort target extraction, and the tool-call gate.
 *
 * The gate is focus/accident-prevention, NOT a sandbox (PLAN.md §8). It extracts
 * candidate targets from freeform commands and tool arguments and checks them
 * against the authorized list. A determined bypass (shell variables, encoding,
 * indirection) defeats it; the real boundary is the container/network.
 *
 * Pure module: no ports, no I/O. Scope loading lives in the workspace/config layer.
 */

import type { EngagementScope, ScopeTargets, TargetType } from "./ontology.ts";
import type { GateDecision, ToolCall } from "./ports.ts";
import { PIRED_AGENT_NAMES } from "./subagents.ts";

// --- IPv4 helpers -----------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = (value << 8) | octet;
	}
	return value >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
	const [range, bitsRaw] = cidr.split("/");
	if (range === undefined || bitsRaw === undefined) return false;
	const bits = Number(bitsRaw);
	const ipInt = ipv4ToInt(ip);
	const rangeInt = ipv4ToInt(range);
	if (ipInt === null || rangeInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (ipInt & mask) === (rangeInt & mask);
}

function isIpv4(host: string): boolean {
	return ipv4ToInt(host) !== null;
}

// --- Matching ---------------------------------------------------------------

function domainMatches(host: string, pattern: string): boolean {
	const h = host.toLowerCase();
	const p = pattern.toLowerCase();
	if (p.startsWith("*.")) {
		const base = p.slice(2);
		return h === base || h.endsWith(`.${base}`);
	}
	return h === p;
}

function matchesTargets(host: string, targets: ScopeTargets | undefined): boolean {
	if (!targets) return false;
	if (isIpv4(host)) {
		const hostInt = ipv4ToInt(host);
		if (targets.ips?.some((ip) => ipv4ToInt(ip) === hostInt)) return true;
		if (targets.cidrs?.some((cidr) => ipInCidr(host, cidr))) return true;
		return false;
	}
	return targets.domains?.some((pattern) => domainMatches(host, pattern)) ?? false;
}

/** A host (domain or IPv4) is in scope when it matches targets and is not excluded. */
export function isHostInScope(host: string, scope: EngagementScope): boolean {
	if (matchesTargets(host, scope.exclude)) return false;
	return matchesTargets(host, scope.targets);
}

/** Decode only well-formed %XX escapes, leaving malformed ones ("%zz", a lone "%") literal. */
function decodeTolerant(value: string): string {
	return value.replace(/%[0-9a-fA-F]{2}/g, (esc) => {
		try {
			return decodeURIComponent(esc);
		} catch {
			return esc;
		}
	});
}

/**
 * Percent-decode a path a few times (handles double-encoding). Tolerant: a single
 * malformed escape cannot disable decoding of valid escapes elsewhere in the path.
 */
function decodeRepeated(value: string): string {
	let cur = value;
	for (let i = 0; i < 3; i++) {
		const dec = decodeTolerant(cur);
		if (dec === cur) return cur;
		cur = dec;
	}
	return cur;
}

/** Resolve "." / ".." segments; returns "/seg/seg" with no trailing slash (root => ""). */
function collapsePath(path: string): string {
	const out: string[] = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.length ? `/${out.join("/")}` : "";
}

/**
 * Canonical `scheme://authority/path` for scope matching: lowercased scheme+authority
 * with any userinfo and the scheme's default port stripped (so `user@h:443` and `h`
 * compare equal), the path percent-decoded (so `%2e`/`%2f` cannot hide traversal) and
 * dot-segments resolved, query/fragment dropped. A non-URL string returns its lowercased self.
 */
function canonicalizeUrl(url: string): string {
	const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(url);
	if (!m) return url.toLowerCase();
	const scheme = (m[1] ?? "").toLowerCase();
	let authority = (m[2] ?? "").toLowerCase();
	authority = authority.slice(authority.lastIndexOf("@") + 1);
	const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : "";
	if (defaultPort && authority.endsWith(`:${defaultPort}`)) {
		authority = authority.slice(0, -(defaultPort.length + 1));
	}
	const path = collapsePath(decodeRepeated(m[3] ?? ""));
	return `${scheme}://${authority}${path}`;
}

/**
 * URL-prefix match on the canonicalized `scheme://authority/path` with a path
 * boundary, so "…/api" matches "…/api/x" but not "…/apidocs" — and no encoding or
 * dot-segment variant ("…/api/../admin", "…/api/..%2fadmin") escapes the prefix.
 */
function urlHasPrefix(url: string, prefix: string): boolean {
	const u = canonicalizeUrl(url);
	const p = canonicalizeUrl(prefix);
	if (!u.startsWith(p)) return false;
	if (u.length === p.length) return true;
	return u[p.length] === "/";
}

/**
 * A full URL is in scope when it matches a `targets.urls` prefix or its host is
 * in scope, and it is not excluded by an `exclude.urls` prefix or an excluded host.
 * This is what makes `ScopeTargets.urls` (targets and exclusions) actually apply.
 */
export function isUrlInScope(url: string, scope: EngagementScope): boolean {
	if (scope.exclude?.urls?.some((prefix) => urlHasPrefix(url, prefix))) return false;
	const host = hostOfUrl(url);
	if (host && matchesTargets(host, scope.exclude)) return false;
	if (scope.targets?.urls?.some((prefix) => urlHasPrefix(url, prefix))) return true;
	return host ? matchesTargets(host, scope.targets) : false;
}

// --- Target extraction ------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s'"`|<>()]+/gi;
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** Command binaries that reach the network. */
export const NETWORK_TOOLS = new Set<string>([
	"curl", "wget", "nc", "ncat", "netcat", "nmap", "masscan", "ffuf", "gobuster", "feroxbuster",
	"nuclei", "httpx", "katana", "sqlmap", "hydra", "medusa", "dig", "host", "nslookup", "ping",
	"whatweb", "wpscan", "nikto", "dirb", "amass", "subfinder", "dnsx", "naabu", "openssl", "ssh",
	"telnet", "smbclient", "crackmapexec", "nxc", "evil-winrm", "rustscan", "wafw00f",
]);

export interface ExtractedTargets {
	hosts: string[];
	urls: string[];
	usesNetworkTool: boolean;
}

/** Extract the host from a URL string without relying on the `URL` global (keeps core lib-agnostic). */
function hostOfUrl(url: string): string | null {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
	const authority = match?.[1];
	if (authority === undefined) return null;
	const afterUserinfo = authority.slice(authority.lastIndexOf("@") + 1);
	const host = afterUserinfo.replace(/:\d+$/, "").toLowerCase();
	return host || null;
}

function binaryName(token: string): string {
	return token.split("/").pop() ?? "";
}

export function extractTargets(command: string): ExtractedTargets {
	const urls = Array.from(command.matchAll(URL_RE), (m) => m[0].replace(/[.,;)]+$/, ""));
	const hostsFromUrls = urls.map(hostOfUrl).filter((h): h is string => h !== null);
	const bareHosts = Array.from(command.matchAll(HOST_RE), (m) => m[0]);
	const ips = Array.from(command.matchAll(IPV4_RE), (m) => m[0]).filter(isIpv4);
	const hosts = Array.from(new Set([...hostsFromUrls, ...bareHosts, ...ips]));

	// Split on whitespace AND shell punctuation so wrappers like `(curl ...)`,
	// `;curl`, `$(curl ...)`, and backticks still expose the binary name.
	const words = command.split(/[\s;|&()<>{}`$]+/).filter(Boolean);
	const usesNetworkTool = urls.length > 0 || words.some((tok) => NETWORK_TOOLS.has(binaryName(tok)));

	return { hosts, urls, usesNetworkTool };
}

// --- Command-level decision -------------------------------------------------

export interface ScopeDecision {
	allowed: boolean;
	reason?: string;
	outOfScope: string[];
	unresolved: boolean;
}

/** Decide whether a freeform command may run under the given scope. */
export function checkCommandScope(command: string, scope: EngagementScope): ScopeDecision {
	if (scope.mode === "off") return { allowed: true, outOfScope: [], unresolved: false };

	const { hosts, urls, usesNetworkTool } = extractTargets(command);

	if (usesNetworkTool && scope.authorized !== true) {
		return {
			allowed: scope.mode !== "enforce",
			reason:
				'Engagement is not marked authorized; network testing is blocked. Set "authorized": true in the scope file once you have written authorization.',
			outOfScope: hosts,
			unresolved: hosts.length === 0,
		};
	}

	const urlHosts = new Set(urls.map(hostOfUrl).filter((h): h is string => h !== null));
	const bareHosts = hosts.filter((h) => (isIpv4(h) || h.includes(".")) && !urlHosts.has(h));
	const outOfScope = [
		...new Set([
			...urls
				.filter((u) => !isUrlInScope(u, scope))
				.map((u) => {
					const h = hostOfUrl(u);
					return h && !isHostInScope(h, scope) ? h : u;
				}),
			...bareHosts.filter((h) => !isHostInScope(h, scope)),
		]),
	];
	const resolvedCount = urls.length + bareHosts.length;

	if (usesNetworkTool && outOfScope.length > 0) {
		return {
			allowed: scope.mode !== "enforce",
			reason: `Out-of-scope target(s): ${outOfScope.join(", ")}. Only authorized targets in the engagement scope may be tested.`,
			outOfScope,
			unresolved: false,
		};
	}

	if (usesNetworkTool && resolvedCount === 0) {
		const blocked = scope.mode === "enforce" && scope.strictUnresolved === true;
		return {
			allowed: !blocked,
			reason: blocked
				? "Network command with no resolvable target; blocked because strictUnresolved is set and scope could not be verified."
				: "Network command with no resolvable target; scope could not be verified.",
			outOfScope: [],
			unresolved: true,
		};
	}

	return { allowed: true, outOfScope: [], unresolved: false };
}

// --- Tool-call gate ---------------------------------------------------------

/** Tools that never touch the network directly; always allowed by the scope gate. */
const LOCAL_TOOLS = new Set<string>([
	"record", "recall", "read", "write", "edit", "grep", "find", "ls", "note",
]);

/**
 * How many subagents one session may spawn before the gate says no.
 *
 * PLAN.md §11 has always listed hard caps as harness-owned, and nothing
 * implemented one: `spawn` sat in the local-tools set and was waved through, so
 * a model that decided to fan out could spawn until something else ran out.
 * Delegation is not a scope violation, but it is the same shape of problem —
 * unbounded work nobody asked for, on the operator's budget and the client's
 * systems — and the gate is already the place that says no to that.
 *
 * Eight is enough for the patterns `ops-delegation` describes (a verifier per
 * cleared cell of a class, a scout per host) and low enough that a loop is
 * caught in one session rather than one invoice.
 */
export const DEFAULT_MAX_AGENTS = 8;

/**
 * The pi-subagents lazy-loader tool. It only makes the `subagent` tool active;
 * it launches nothing, so it is always allowed and never charged to the budget.
 */
const SUBAGENT_ENABLE_TOOL = "subagents_enable";

/**
 * Generic spawn-tool names, kept as a safety net for a package that is not
 * pi-subagents.
 *
 * pired itself delegates only through pi-subagents' `subagent` tool, which has
 * its own richer gate below (`checkSubagentLaunch`). `subagent` is deliberately
 * NOT in this set — a call to it must reach that gate, not this plain per-call
 * counter. Engagements can add other names via `agentTools`; all of them share
 * the one session budget.
 */
const AGENT_TOOLS = new Set<string>(["spawn", "delegate"]);

/**
 * Management/control actions on the `subagent` tool that only read state.
 *
 * These are allowed and never counted — an operator (or the model on their
 * behalf) has to be able to see the fleet and run doctor. Everything else in
 * management mode creates, changes, or destroys agents, runs, schedules, or
 * config, which pired does not let a delegated flow do, so it is denied.
 */
const SUBAGENT_READONLY_ACTIONS = new Set<string>([
	"list", "get", "models", "children.list", "guide", "status", "doctor", "validate",
	"watchdog.status", "watchdog.check", "watchdog.recommend-model",
	"lane.status", "refine.show", "mission.list", "mission.show",
	"inspector.status", "project.status",
	"schedule.list", "schedule.show", "schedule.history", "debug.run",
]);

/**
 * The only top-level keys a pired worker launch may carry.
 *
 * An allowlist, because the denylist it replaced kept missing things. The
 * `subagent` schema has some eighty top-level keys and changed between 0.66 and
 * 0.71, and several of them move work outside the scope gate or around the
 * worker definition pired registered. `gate` and `acceptance.verify` run a host
 * shell command after the worker, through `spawn(..., {shell:true})`, where no
 * tool_call hook sees it: a probe's `gate` wrote a marker file and went on to
 * curl evil.example.com, while the same command through `bash` was refused.
 * `model` with a `:max` suffix sends client code to whichever provider the call
 * names. `context:"fork"` hands the worker the parent's whole transcript.
 * `sessionDir` moves the child's session out of the directory the accounting
 * reads. The registered definition is the contract; a launch says which worker,
 * what to do, and at most where inside the engagement to do it.
 *
 * `async` and `context` are on the list only for the values the definition
 * already sets (`false`, `"fresh"`), which a model restating them should not be
 * refused for. There is no display-only key to add: neither version has a label
 * or description on a launch, and the progress and artifact switches
 * (`includeProgress`, `chatProgress`, `artifacts`) change what lands in this
 * session's context or on disk.
 */
const LAUNCH_KEYS = new Set<string>(["agent", "task", "cwd", "async", "context"]);

/** The value a constrained launch key must hold, when it is present at all. */
const LAUNCH_KEY_VALUES: Readonly<Record<string, unknown>> = { async: false, context: "fresh" };

/**
 * Why the keys a model is likeliest to reach for are refused. A bare "not
 * allowed" gets retried with the next field over; a reason says what pired
 * holds fixed instead.
 */
const LAUNCH_KEY_REASONS: Readonly<Record<string, string>> = {
	gate: "it runs a shell command on this host after the worker, outside pired's scope gate",
	acceptance: "its verify commands run on this host outside pired's scope gate, and the worker's handoff is already fixed",
	model: "a worker runs on your model and thinking level",
	fast: "a worker runs on your model and tier",
	thinking: "a worker runs at your thinking level",
	async: "workers run in the foreground (async:false) so their work stays accountable to this session",
	context: "a worker starts fresh (context:\"fresh\"); put what it needs in the task, not your transcript",
	sessionDir: "a worker's session stays where pired's accounting reads it",
	timeoutMs: "a worker's time limit is set by its definition",
	maxRuntimeMs: "a worker's time limit is set by its definition",
	toolBudget: "a worker's tool budget is set by its definition",
	usageBudget: "a worker's budget is set by its definition",
	output: "a worker hands back at most 200 words and records to the ledger",
	outputMode: "a worker hands back at most 200 words and records to the ledger",
	outputSchema: "a worker hands back at most 200 words and records to the ledger",
	skill: "a worker loads no skills beyond its definition",
	tasks: "launch one worker per call",
	chain: "launch one worker per call",
	parallel: "launch one worker per call",
	workflow: "scripted workflows are not allowed",
	workflowScript: "scripted workflows are not allowed",
	workflowScriptPath: "scripted workflows are not allowed",
	worktree: "workers share the engagement directory",
	isolation: "workers share the engagement directory",
	extensionBindings: "a worker's extensions are pired's own",
};

function launchKeyRefusal(key: string): SubagentLaunchDecision {
	const why = LAUNCH_KEY_REASONS[key];
	return {
		allow: false,
		count: 0,
		reason: `Subagent launch field \`${key}\` is not allowed${why ? ` — ${why}` : ""}. Launch a pired worker with { agent, task } only (a cwd inside the engagement is also accepted); its registered definition fixes everything else.`,
	};
}

/** The outcome of vetting one `subagent` tool call. */
export interface SubagentLaunchDecision {
	allow: boolean;
	reason?: string;
	/** Children this call would launch, to charge against the session budget (0 for a non-launch). */
	count: number;
}

/** What `checkSubagentLaunch` needs from the session to decide. */
export interface SubagentGateContext {
	/** Agent names treated as pired's own workers. */
	agents: ReadonlySet<string>;
	/** The engagement directory; a launch whose `cwd` resolves outside it is refused. */
	cwd?: string;
	/** Children already launched this session. */
	spawned: number;
	/** The per-session cap (0 disables delegation). */
	maxAgents: number;
	/** A launch this gate allowed has not finished executing yet. */
	running?: boolean;
}

/** Forward slashes, and an upper-case drive letter, so a Windows path compares with itself. */
function slashed(path: string): string {
	return path.replace(/\\/g, "/").replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

/**
 * Whether `candidate` resolves to `base` or somewhere under it.
 *
 * Resolved the way pi-subagents resolves a launch's cwd — `path.resolve` against
 * the session's directory, so a relative path is taken from the engagement and
 * `..` is followed — but without `node:path`, which core may not import. The
 * earlier check compared the strings, so `src` and `/eng/src` were refused with
 * a reason saying the cwd had to stay inside the engagement, which it did.
 */
export function isWithinDir(base: string, candidate: string): boolean {
	const root = collapsePath(slashed(base));
	const c = slashed(candidate);
	const absolute = c.startsWith("/") || /^[A-Z]:\//.test(c);
	const target = collapsePath(absolute ? c : `${slashed(base)}/${c}`);
	return target === root || target.startsWith(`${root}/`);
}

/**
 * Vet one `subagent` tool call against pired's delegation policy.
 *
 * pired delegates only to its own foreground workers. A launch is allowed when
 * it names one pired worker and carries nothing outside `LAUNCH_KEYS`, its `cwd`
 * (if any) is the engagement directory or under it, no other launch is still
 * running, and one more child fits the `maxAgents` budget. Everything else is
 * refused with a reason naming what to drop: a builtin or external-runner agent
 * (claude-code, codex-exec, cursor-agent …), any per-call override, a second
 * launch while one runs, and any management action that mutates agents, runs
 * or config. Read-only management (list/status/doctor …) is allowed and
 * uncounted.
 *
 * One at a time is enforced here rather than trusted: pi runs the tool calls of
 * one assistant message in parallel unless a tool declares itself sequential,
 * and `subagent` does not, so a model that emitted two launches in one message
 * had two workers sending requests to one local GPU at once.
 */
export function checkSubagentLaunch(rawArgs: unknown, ctx: SubagentGateContext): SubagentLaunchDecision {
	const args = (rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;

	const action = typeof args.action === "string" ? args.action.trim() : undefined;
	if (action) {
		if (SUBAGENT_READONLY_ACTIONS.has(action)) return { allow: true, count: 0 };
		return {
			allow: false,
			count: 0,
			reason: `Subagent management action "${action}" is not allowed; pired permits only read-only inspection (list, status, doctor, …) and launching its own workers.`,
		};
	}

	if (ctx.maxAgents === 0) {
		return { allow: false, count: 0, reason: "Delegation is disabled for this engagement (maxAgents=0). Do the work in this session." };
	}

	for (const [key, value] of Object.entries(args)) {
		if (value === undefined) continue;
		if (!LAUNCH_KEYS.has(key)) return launchKeyRefusal(key);
		if (key in LAUNCH_KEY_VALUES && value !== LAUNCH_KEY_VALUES[key]) return launchKeyRefusal(key);
	}

	const agent = args.agent;
	if (agent === undefined) {
		return { allow: false, count: 0, reason: "Subagent launch names no agent; pired allows only its own workers (pired-scout, pired-investigate, pired-verify, pired-escalate)." };
	}
	if (typeof agent !== "string" || !ctx.agents.has(agent)) {
		const shown = typeof agent === "string" ? agent : JSON.stringify(agent);
		return { allow: false, count: 0, reason: `Only pired workers may be launched (pired-scout, pired-investigate, pired-verify, pired-escalate); refused: ${shown}.` };
	}

	const cwd = args.cwd;
	if (cwd !== undefined && (typeof cwd !== "string" || ctx.cwd === undefined || !isWithinDir(ctx.cwd, cwd))) {
		const shown = typeof cwd === "string" ? cwd : JSON.stringify(cwd);
		return {
			allow: false,
			count: 0,
			reason: `A worker's cwd must be the engagement directory${ctx.cwd ? ` (${ctx.cwd})` : ""} or a directory inside it; refused: ${shown}. Omit cwd to use the engagement directory.`,
		};
	}

	if (ctx.running) {
		return {
			allow: false,
			count: 0,
			reason: "A pired worker launched from this session is still running, and workers run one at a time. Wait for its handoff, then launch the next in a later message.",
		};
	}

	if (ctx.spawned + 1 > ctx.maxAgents) {
		const left = Math.max(0, ctx.maxAgents - ctx.spawned);
		return {
			allow: false,
			count: 0,
			reason: `Subagent budget spent: ${ctx.maxAgents} per session, ${ctx.spawned} already launched (${left} left). Record what the existing workers returned and do the rest here — or raise maxAgents in the scope file.`,
		};
	}
	return { allow: true, count: 1 };
}

/** A property name that plausibly holds a network destination (matched case-insensitively). */
function isTargetKey(key: string): boolean {
	const k = key.toLowerCase();
	if (k === "ip" || k === "ips" || k === "addr" || k === "address") return true;
	return ["url", "uri", "host", "target", "endpoint", "server", "domain"].some((hint) => k.includes(hint));
}

/**
 * Collect candidate targets from arbitrary tool arguments, recursively (#6): a full
 * `scheme://` URL anywhere is caught regardless of key name or nesting, while bare
 * hosts/IPs are only harvested from target-ish keys so filenames like `config.yaml`
 * are not mistaken for hosts. Depth-bounded and cycle-safe.
 */
function collectTargetsFromArgs(args: unknown): { urls: string[]; hosts: string[] } {
	const urls: string[] = [];
	const hosts: string[] = [];
	const seen = new Set<object>();
	const visit = (value: unknown, underTargetKey: boolean, depth: number): void => {
		if (value === null || value === undefined || depth > 6) return;
		if (typeof value === "string") {
			const found = extractTargets(value);
			urls.push(...found.urls);
			if (underTargetKey) hosts.push(...found.hosts);
			return;
		}
		if (typeof value !== "object" || seen.has(value as object)) return;
		seen.add(value as object);
		if (Array.isArray(value)) {
			for (const item of value) visit(item, underTargetKey, depth + 1);
		} else {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				visit(v, underTargetKey || isTargetKey(k), depth + 1);
			}
		}
	};
	visit(args, false, 0);
	return { urls, hosts };
}

/** Extra facts the gate needs that are not in the scope file. */
export interface ScopeGateOptions {
	/** The engagement directory, so a `subagent` launch whose `cwd` resolves outside it is refused. */
	cwd?: string;
	/** The agent names to treat as pired's own workers; defaults to the four built-ins. */
	agents?: ReadonlySet<string>;
}

/** A tool call as the host hands it to the gate: the port's call, plus the id the host will report its end under. */
export type GatedToolCall = ToolCall & { id?: string };

/** What the host reports when a tool call's execution ends (pi's `tool_execution_end`). */
export interface ToolCallEnd {
	/** The id the call reached the gate under. */
	id?: string;
	name: string;
	isError: boolean;
	/** The tool's result. For `subagent`, pi-subagents lists the children that ran in `details.results`. */
	result?: unknown;
}

/**
 * The gate, plus the one thing it has to hear back: that a `subagent` call it
 * allowed has finished. Without it the gate cannot know a worker is still
 * running, and cannot give back the budget of a launch that never started one.
 */
export type ScopeGate = ((call: GatedToolCall) => GateDecision) & {
	settle(end: ToolCallEnd): void;
};

/** How many children a `subagent` result says ran; 0 when it lists none. */
function childrenInResult(result: unknown): number {
	const results = (result as { details?: { results?: unknown } } | null | undefined)?.details?.results;
	return Array.isArray(results) ? results.length : 0;
}

/**
 * Build the scope gate used before every tool call. Bash is checked by extracting
 * targets from its command; other tools by their url/target/host/ip arguments.
 * pired's own tools and local file tools are always allowed.
 *
 * Delegation is gated in two places that share one session budget: the
 * pi-subagents `subagent` tool goes through `checkSubagentLaunch` (one pired
 * worker per call, no overrides, in-engagement cwd, one at a time, read-only
 * management), and any other spawn-style tool name is capped per call. The
 * budget is per session on purpose — the gate is built at session start and a
 * counter is all it can honestly hold, and a fresh session getting a fresh
 * budget is what an operator restarting a run expects.
 *
 * A launch is charged when the gate allows it, which is the only moment the
 * gate can stop the next one, and refunded by `settle` when it ends in an error
 * with no child in its result: a launch pi-subagents rejected — an unknown
 * model, a cwd that does not exist, a malformed project settings file — started
 * nothing, and charging it left "8 already launched" on a session that had run
 * none.
 */
export function createScopeGate(scope: EngagementScope, options: ScopeGateOptions = {}): ScopeGate {
	const maxAgents = typeof scope.maxAgents === "number" && scope.maxAgents >= 0
		? scope.maxAgents
		: DEFAULT_MAX_AGENTS;
	// Custom external tools extend the defaults; they never uncap the built-ins.
	const agentTools = new Set([...AGENT_TOOLS, ...(scope.agentTools ?? [])]);
	const piredAgents = options.agents ?? PIRED_AGENT_NAMES;
	let spawned = 0;
	/** The allowed `subagent` launch whose execution has not ended, with what it was charged. */
	let running: { id?: string; count: number } | undefined;

	const gate = (call: GatedToolCall): GateDecision => {
		// The lazy loader only makes `subagent` active; it launches nothing.
		if (call.name === SUBAGENT_ENABLE_TOOL) return { allow: true };
		if (call.name === "subagent") {
			const decision = checkSubagentLaunch(call.args, {
				agents: piredAgents,
				...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
				spawned,
				maxAgents,
				running: running !== undefined,
			});
			if (!decision.allow) return { allow: false, reason: decision.reason };
			if (decision.count > 0) {
				spawned += decision.count;
				running = { ...(call.id !== undefined ? { id: call.id } : {}), count: decision.count };
			}
			return { allow: true };
		}
		if (agentTools.has(call.name)) {
			if (spawned >= maxAgents) {
				return {
					allow: false,
					reason: maxAgents === 0
						? "Delegation is disabled for this engagement (maxAgents=0). Do the work in this session."
						: `Subagent budget spent: ${maxAgents} already spawned this session. Finish or record what `
							+ "the existing ones returned, and do the rest here — or raise maxAgents in the scope file.",
				};
			}
			spawned++;
			return { allow: true };
		}
		if (LOCAL_TOOLS.has(call.name)) return { allow: true };

		if (call.name === "bash") {
			const command = (call.args as { command?: unknown } | null)?.command;
			if (typeof command !== "string") return { allow: true };
			const decision = checkCommandScope(command, scope);
			return decision.allowed ? { allow: true } : { allow: false, reason: decision.reason };
		}

		if (scope.mode === "off") return { allow: true };

		const { urls, hosts } = collectTargetsFromArgs(call.args);
		if (urls.length === 0 && hosts.length === 0) return { allow: true };

		if (scope.authorized !== true) {
			return {
				allow: scope.mode !== "enforce",
				reason: "Engagement is not marked authorized; network testing is blocked.",
			};
		}

		const outOfScope = [
			...new Set([
				...urls
					.filter((u) => !isUrlInScope(u, scope))
					.map((u) => {
						const h = hostOfUrl(u);
						return h && !isHostInScope(h, scope) ? h : u;
					}),
				...hosts.filter((h) => !isHostInScope(h, scope)),
			]),
		];
		if (outOfScope.length > 0) {
			return {
				allow: scope.mode !== "enforce",
				reason: `Out-of-scope target(s): ${outOfScope.join(", ")}.`,
			};
		}
		return { allow: true };
	};

	/**
	 * A tool call ended. Only the running launch's own end releases it: a second
	 * launch the gate refused in the same message ends too, immediately, and
	 * must not free the slot of the worker still running.
	 */
	const settle = (end: ToolCallEnd): void => {
		if (end.name !== "subagent" || running === undefined) return;
		if (running.id !== undefined && end.id !== running.id) return;
		if (end.isError && childrenInResult(end.result) === 0) spawned = Math.max(0, spawned - running.count);
		running = undefined;
	};

	return Object.assign(gate, { settle });
}

// --- Summary ----------------------------------------------------------------

function hasScopeTargets(scope: EngagementScope): boolean {
	const t = scope.targets ?? {};
	return Boolean(t.domains?.length || t.ips?.length || t.cidrs?.length || t.urls?.length);
}

/**
 * What the model may touch, in the one wording both the operator's prompt and
 * every pired worker's prompt use. Two renderings of one scope disagreed once:
 * the parent read a review engagement (mode off, no targets) as "read-only local
 * work is fine" while its worker read the same file as "off / not authorized —
 * stop", parked a blocker, and the parent stopped behind it (measured on the
 * 2026-09-24 smoke run: an empty review after 61 s).
 */
export function scopeGuidance(scope: EngagementScope | undefined): string {
	if (!scope || (scope.mode === "off" && !hasScopeTargets(scope))) {
		return "No engagement scope is loaded. Offensive and network actions are blocked until a scope file is present and marked authorized. Read-only local work (e.g. code review) is still fine.";
	}
	const lines = [
		`Authorized engagement: ${summarizeScope(scope)}`,
		"Touch only these targets; anything else is out of scope — stop and say so.",
	];
	const t = scope.targets ?? {};
	if (t.domains?.length) lines.push(`domains: ${t.domains.join(", ")}`);
	if (t.ips?.length) lines.push(`ips: ${t.ips.join(", ")}`);
	if (t.cidrs?.length) lines.push(`cidrs: ${t.cidrs.join(", ")}`);
	if (t.urls?.length) lines.push(`urls: ${t.urls.join(", ")}`);
	if (scope.exclude && Object.keys(scope.exclude).length > 0) lines.push(`excluded: ${JSON.stringify(scope.exclude)}`);
	return lines.join("\n");
}

export function summarizeScope(scope: EngagementScope): string {
	const t = scope.targets ?? {};
	const counts = [
		t.domains?.length ? `${t.domains.length} domain(s)` : null,
		t.ips?.length ? `${t.ips.length} ip(s)` : null,
		t.cidrs?.length ? `${t.cidrs.length} cidr(s)` : null,
		t.urls?.length ? `${t.urls.length} url(s)` : null,
	].filter(Boolean);
	const auth = scope.authorized === true ? "authorized" : "NOT authorized";
	const mode = scope.strictUnresolved ? `${scope.mode}/strict` : scope.mode;
	return `${scope.engagement} [${mode}, ${auth}] ${counts.join(", ") || "no targets"}`;
}

/**
 * Which bundled checklist seeds this engagement's coverage matrix.
 *
 * Lived in the extension until it had to answer for two more target types, and
 * moved here because it is a pure function of the scope and because a decision
 * nothing can test is a decision that goes quietly wrong — `api.json` shipped
 * with 13 classes that no code path could ever select, and nobody noticed.
 *
 * The order is deliberate. The operator's own `targetType` wins, because the
 * inference below reads the shape of the targets and the shape settles exactly
 * two cases: bare addresses mean `network`, hostnames and URLs mean `web`. An
 * API engagement is a list of URLs and looks identical to a web one; a firmware
 * engagement names no network target at all. Neither is inferable, so neither
 * is inferred.
 */
export function pickTargetType(profile: string, scope: EngagementScope): TargetType {
	if (scope.targetType) return scope.targetType;
	if (profile === "review") return "code-review";
	const t = scope.targets ?? {};
	const webish = (t.domains?.length ?? 0) > 0 || (t.urls?.length ?? 0) > 0;
	const netish = (t.ips?.length ?? 0) > 0 || (t.cidrs?.length ?? 0) > 0;
	if (netish && !webish) return "network";
	return "web";
}
