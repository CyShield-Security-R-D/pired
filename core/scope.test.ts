import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import { checkCommandScope, createScopeGate, extractTargets, isHostInScope, isUrlInScope, summarizeScope } from "./scope.ts";

const scope: EngagementScope = {
	v: 1,
	engagement: "acme",
	authorized: true,
	mode: "enforce",
	targets: {
		domains: ["*.acme.test", "acme.test"],
		ips: ["10.0.0.5"],
		cidrs: ["10.10.20.0/24"],
	},
	exclude: { domains: ["admin.acme.test"] },
};

describe("isHostInScope", () => {
	it("matches wildcard subdomains and the bare apex", () => {
		expect(isHostInScope("app.acme.test", scope)).toBe(true);
		expect(isHostInScope("acme.test", scope)).toBe(true);
		expect(isHostInScope("deep.sub.acme.test", scope)).toBe(true);
	});

	it("rejects out-of-scope domains", () => {
		expect(isHostInScope("evil.com", scope)).toBe(false);
		expect(isHostInScope("acme.test.evil.com", scope)).toBe(false);
	});

	it("honors excludes over targets", () => {
		expect(isHostInScope("admin.acme.test", scope)).toBe(false);
	});

	it("matches exact IPs and CIDR ranges", () => {
		expect(isHostInScope("10.0.0.5", scope)).toBe(true);
		expect(isHostInScope("10.0.0.6", scope)).toBe(false);
		expect(isHostInScope("10.0.0.05", scope)).toBe(true); // zero-padded spelling matches numerically
		expect(isHostInScope("10.10.20.7", scope)).toBe(true);
		expect(isHostInScope("10.10.21.7", scope)).toBe(false);
	});
});

describe("extractTargets", () => {
	it("pulls hosts and urls from a curl command", () => {
		const t = extractTargets("curl -s https://app.acme.test/api?id=1");
		expect(t.urls).toContain("https://app.acme.test/api?id=1");
		expect(t.hosts).toContain("app.acme.test");
		expect(t.usesNetworkTool).toBe(true);
	});

	it("pulls raw IPs from an nmap command", () => {
		const t = extractTargets("nmap -sV 10.10.20.7");
		expect(t.hosts).toContain("10.10.20.7");
		expect(t.usesNetworkTool).toBe(true);
	});

	it("does not flag a non-network command", () => {
		expect(extractTargets("echo hello > out.txt").usesNetworkTool).toBe(false);
	});
});

describe("checkCommandScope", () => {
	it("allows an in-scope network command", () => {
		expect(checkCommandScope("curl https://app.acme.test/", scope).allowed).toBe(true);
	});

	it("blocks an out-of-scope target in enforce mode", () => {
		const d = checkCommandScope("curl https://evil.com/", scope);
		expect(d.allowed).toBe(false);
		expect(d.outOfScope).toContain("evil.com");
		expect(d.reason).toMatch(/out-of-scope/i);
	});

	it("blocks all network commands when not authorized", () => {
		const unauth: EngagementScope = { ...scope, authorized: false };
		const d = checkCommandScope("curl https://app.acme.test/", unauth);
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/authorized/i);
	});

	it("allows everything when mode is off", () => {
		const off: EngagementScope = { ...scope, mode: "off" };
		expect(checkCommandScope("curl https://evil.com/", off).allowed).toBe(true);
	});

	it("warns but allows out-of-scope in warn mode", () => {
		const warn: EngagementScope = { ...scope, mode: "warn" };
		const d = checkCommandScope("curl https://evil.com/", warn);
		expect(d.allowed).toBe(true);
		expect(d.outOfScope).toContain("evil.com");
	});

	it("allows but flags a network command with no resolvable target", () => {
		const d = checkCommandScope("curl $TARGET_URL", scope);
		expect(d.allowed).toBe(true);
		expect(d.unresolved).toBe(true);
	});
});

describe("createScopeGate", () => {
	const gate = createScopeGate(scope);

	it("allows pired and local tools unconditionally", async () => {
		expect((await gate({ name: "record", args: {} })).allow).toBe(true);
		expect((await gate({ name: "read", args: { path: "/etc/hosts" } })).allow).toBe(true);
	});

	it("gates bash by target scope", async () => {
		expect((await gate({ name: "bash", args: { command: "curl https://app.acme.test/" } })).allow).toBe(true);
		const bad = await gate({ name: "bash", args: { command: "curl https://evil.com/" } });
		expect(bad.allow).toBe(false);
		expect(bad.reason).toMatch(/out-of-scope/i);
	});

	it("gates a custom tool by its url/target args", async () => {
		expect((await gate({ name: "http", args: { url: "https://app.acme.test/x" } })).allow).toBe(true);
		expect((await gate({ name: "http", args: { url: "https://evil.com/x" } })).allow).toBe(false);
	});
});

describe("URL scoping (targets.urls / exclude.urls)", () => {
	const urlExclude: EngagementScope = {
		v: 1,
		engagement: "u",
		authorized: true,
		mode: "enforce",
		targets: { domains: ["*.acme.test"] },
		exclude: { urls: ["https://app.acme.test/admin/"] },
	};
	const urlOnly: EngagementScope = {
		v: 1,
		engagement: "u2",
		authorized: true,
		mode: "enforce",
		targets: { urls: ["https://app.acme.test/api/"] },
	};

	it("blocks a URL excluded by exclude.urls even when its host is in scope", () => {
		expect(checkCommandScope("curl https://app.acme.test/admin/panel", urlExclude).allowed).toBe(false);
		expect(checkCommandScope("curl https://app.acme.test/public", urlExclude).allowed).toBe(true);
	});

	it("allows only matching url prefixes when the host is not in domains", () => {
		expect(checkCommandScope("curl https://app.acme.test/api/users", urlOnly).allowed).toBe(true);
		expect(checkCommandScope("curl https://app.acme.test/admin", urlOnly).allowed).toBe(false);
	});

	it("does not let a url prefix match across a host boundary", () => {
		const s: EngagementScope = { v: 1, engagement: "b", authorized: true, mode: "enforce", targets: { urls: ["https://app.acme.test"] } };
		expect(isUrlInScope("https://app.acme.test/x", s)).toBe(true);
		expect(isUrlInScope("https://app.acme.test.evil.com/x", s)).toBe(false);
	});

	it("gate honors url exclusions for tool args", async () => {
		const gate = createScopeGate(urlExclude);
		expect((await gate({ name: "http", args: { url: "https://app.acme.test/admin/x" } })).allow).toBe(false);
		expect((await gate({ name: "http", args: { url: "https://app.acme.test/public" } })).allow).toBe(true);
	});

	it("resolves dot-segments so traversal cannot escape a url exclusion", () => {
		// /public/../admin/panel canonicalizes to /admin/panel -> excluded.
		expect(isUrlInScope("https://app.acme.test/public/../admin/panel", urlExclude)).toBe(false);
		expect(checkCommandScope("curl https://app.acme.test/public/../admin/x", urlExclude).allowed).toBe(false);
	});

	it("decodes percent-encoded traversal before matching an exclusion", () => {
		// %2e%2e/%2f decode to ../ and /, resolving to /admin/x -> excluded.
		expect(isUrlInScope("https://app.acme.test/x/%2e%2e/admin/y", urlExclude)).toBe(false);
		expect(checkCommandScope("curl https://app.acme.test/foo/..%2fadmin/y", urlExclude).allowed).toBe(false);
	});

	it("keeps a canonicalized path within its target prefix", () => {
		// /api/./users stays under /api/; /api/../admin escapes it.
		expect(isUrlInScope("https://app.acme.test/api/./users", urlOnly)).toBe(true);
		expect(isUrlInScope("https://app.acme.test/api/../admin", urlOnly)).toBe(false);
	});

	it("normalizes default port and userinfo so they cannot dodge an exclusion", () => {
		expect(isUrlInScope("https://app.acme.test:443/admin/x", urlExclude)).toBe(false);
		expect(isUrlInScope("https://user@app.acme.test/admin/x", urlExclude)).toBe(false);
		expect(isUrlInScope("https://app.acme.test:443/public", urlExclude)).toBe(true);
	});

	it("a malformed escape does not re-enable encoded traversal elsewhere", () => {
		// %zz stays literal, but ..%2f still decodes -> resolves into /admin -> excluded.
		expect(isUrlInScope("https://app.acme.test/foo%zz/..%2fadmin/y", urlExclude)).toBe(false);
	});
});

describe("shell-punctuation network-tool detection (#4)", () => {
	it("detects a network tool wrapped in shell punctuation", () => {
		expect(extractTargets("(curl evil.example)").usesNetworkTool).toBe(true);
		expect(extractTargets("echo hi; curl evil.example").usesNetworkTool).toBe(true);
		expect(extractTargets("$(curl evil.example)").usesNetworkTool).toBe(true);
	});

	it("enforces scope on a host reached through shell punctuation", () => {
		const d = checkCommandScope("(curl evil.example)", scope);
		expect(d.allowed).toBe(false);
		expect(d.outOfScope).toContain("evil.example");
		expect(checkCommandScope("echo hi; curl evil.example", scope).allowed).toBe(false);
	});

	it("still allows an in-scope host wrapped in punctuation", () => {
		expect(checkCommandScope("(curl https://app.acme.test/)", scope).allowed).toBe(true);
	});
});

describe("recursive tool-arg extraction (#6)", () => {
	const gate = createScopeGate(scope);

	it("catches an out-of-scope URL nested under a differently-named key", async () => {
		expect((await gate({ name: "http", args: { options: { callback: "https://evil.com/x" } } })).allow).toBe(false);
	});

	it("catches a bare out-of-scope host under a target-ish nested key", async () => {
		expect((await gate({ name: "scan", args: { spec: { targetHost: "evil.com" } } })).allow).toBe(false);
	});

	it("does not mistake a filename for a host", async () => {
		expect((await gate({ name: "fetch", args: { config: "settings.yaml", path: "a/b.json" } })).allow).toBe(true);
	});

	it("still allows an in-scope nested URL", async () => {
		expect((await gate({ name: "http", args: { req: { uri: "https://app.acme.test/x" } } })).allow).toBe(true);
	});
});

describe("strictUnresolved fail-closed (#7)", () => {
	it("fails open by default when a network target cannot be resolved", () => {
		const d = checkCommandScope("curl localhost", scope);
		expect(d.allowed).toBe(true);
		expect(d.unresolved).toBe(true);
	});

	it("blocks an unresolved network target under enforce when strictUnresolved is set", () => {
		const strict: EngagementScope = { ...scope, strictUnresolved: true };
		const d = checkCommandScope("curl localhost", strict);
		expect(d.allowed).toBe(false);
		expect(d.unresolved).toBe(true);
		expect(d.reason).toMatch(/strictUnresolved/);
	});

	it("only fails closed under enforce mode", () => {
		const strictWarn: EngagementScope = { ...scope, mode: "warn", strictUnresolved: true };
		expect(checkCommandScope("curl localhost", strictWarn).allowed).toBe(true);
	});
});

describe("summarizeScope", () => {
	it("renders a one-line summary", () => {
		const s = summarizeScope(scope);
		expect(s).toContain("acme");
		expect(s).toMatch(/enforce/);
		expect(s).toMatch(/authorized/);
	});
});
