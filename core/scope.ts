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

import type { EngagementScope, ScopeTargets } from "./ontology.ts";
import type { Gate, GateDecision, ToolCall } from "./ports.ts";

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
	"record", "recall", "spawn", "read", "write", "edit", "grep", "find", "ls", "note",
]);

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

/**
 * Build the scope gate used before every tool call. Bash is checked by extracting
 * targets from its command; other tools by their url/target/host/ip arguments.
 * pired's own tools and local file tools are always allowed.
 */
export function createScopeGate(scope: EngagementScope): Gate {
	return (call: ToolCall): GateDecision => {
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
}

// --- Summary ----------------------------------------------------------------

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
