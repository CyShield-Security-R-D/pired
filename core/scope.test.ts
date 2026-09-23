import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import type { GateDecision } from "./ports.ts";
import { checkCommandScope, createScopeGate, DEFAULT_MAX_AGENTS, extractTargets, isHostInScope, isUrlInScope, isWithinDir, pickTargetType, scopeGuidance, summarizeScope } from "./scope.ts";

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

describe("pickTargetType", () => {
	const eng = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "e", authorized: true, mode: "off", targets: {}, ...over,
	});

	/**
	 * The bug this exists to stop repeating: `api.json` shipped with 13 classes
	 * and nothing could ever select it, because the shape of a scope cannot tell
	 * an API engagement from a web one — both are a list of URLs.
	 */
	it("takes the operator's word over any inference", () => {
		expect(pickTargetType("pentest", eng({ targetType: "api", targets: { urls: ["https://x/v1"] } }))).toBe("api");
		expect(pickTargetType("review", eng({ targetType: "firmware" }))).toBe("firmware");
		// Even against the profile default, which is the whole point for firmware:
		// a firmware engagement is read-only local work and would otherwise be
		// handed the code-review checklist.
		expect(pickTargetType("review", eng({ targetType: "network" }))).toBe("network");
	});

	it("still infers the two cases the target shape actually settles", () => {
		expect(pickTargetType("pentest", eng({ targets: { ips: ["10.0.0.5"], cidrs: ["10.0.0.0/24"] } }))).toBe("network");
		expect(pickTargetType("pentest", eng({ targets: { domains: ["acme.test"] } }))).toBe("web");
		expect(pickTargetType("recon", eng({ targets: { urls: ["https://acme.test/a"] } }))).toBe("web");
	});

	/** A host named by address as well as by name is still a web engagement. */
	it("does not read a mixed scope as network just because an address is in it", () => {
		expect(pickTargetType("pentest", eng({ targets: { ips: ["10.0.0.5"], domains: ["acme.test"] } }))).toBe("web");
	});

	it("defaults review to code review, and everything unrecognised to web", () => {
		expect(pickTargetType("review", eng())).toBe("code-review");
		expect(pickTargetType("pentest", eng())).toBe("web");
	});
});

describe("the subagent budget", () => {
	const eng = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "e", authorized: true, mode: "off", targets: {}, ...over,
	});
	const spawn = { name: "spawn", args: { task: "enumerate" } };
	/** createScopeGate is synchronous; narrow once rather than at every call site. */
	const decide = (gate: ReturnType<typeof createScopeGate>, call: { name: string; args: object }): GateDecision =>
		gate(call) as GateDecision;

	/**
	 * PLAN.md §11 has always listed hard caps as harness-owned and nothing
	 * implemented one: `spawn` sat in the local-tools set and was waved through,
	 * so a model that decided to fan out could spawn until something else ran
	 * out of patience or money.
	 */
	it("lets the budget through and then stops, saying why", () => {
		const gate = createScopeGate(eng({ maxAgents: 2 }));
		expect(decide(gate, spawn)).toEqual({ allow: true });
		expect(decide(gate, spawn)).toEqual({ allow: true });
		const denied = decide(gate, spawn);
		expect(denied.allow).toBe(false);
		expect(denied.reason).toMatch(/budget spent: 2/);
		expect(denied.reason).toMatch(/maxAgents/);
	});

	it("defaults to eight when the engagement does not say", () => {
		const gate = createScopeGate(eng());
		for (let i = 0; i < DEFAULT_MAX_AGENTS; i++) expect(decide(gate, spawn).allow, `spawn ${i + 1}`).toBe(true);
		expect(decide(gate, spawn).allow).toBe(false);
	});

	it("forbids delegation outright at zero, and says that rather than a budget", () => {
		const denied = decide(createScopeGate(eng({ maxAgents: 0 })), spawn);
		expect(denied.allow).toBe(false);
		expect(denied.reason).toMatch(/Delegation is disabled/);
	});

	/** The cap is on fan-out, not on working: nothing else it does is rationed. */
	it("counts only spawns, and never rations the local tools", () => {
		const gate = createScopeGate(eng({ maxAgents: 1 }));
		for (let i = 0; i < 20; i++) {
			expect(decide(gate, { name: "record", args: {} })).toEqual({ allow: true });
			expect(decide(gate, { name: "recall", args: {} })).toEqual({ allow: true });
		}
		expect(decide(gate, spawn).allow).toBe(true);
		expect(decide(gate, spawn).allow).toBe(false);
	});

	it("custom tool names share the budget with the standard spawn tools", () => {
		const gate = createScopeGate(eng({ maxAgents: 2, agentTools: ["fan_out"] }));
		expect(decide(gate, { name: "spawn", args: {} }).allow).toBe(true);
		expect(decide(gate, { name: "fan_out", args: {} }).allow).toBe(true);
		expect(decide(gate, { name: "fan_out", args: {} }).allow).toBe(false);
		// A third, in whichever name, is over the shared budget.
		expect(decide(gate, { name: "spawn", args: {} }).allow).toBe(false);
	});

	it("gives a fresh session a fresh budget", () => {
		const scope = eng({ maxAgents: 1 });
		expect(decide(createScopeGate(scope), spawn).allow).toBe(true);
		expect(decide(createScopeGate(scope), spawn).allow).toBe(true);
	});

	it("ignores a nonsense budget rather than locking delegation out", () => {
		expect(decide(createScopeGate(eng({ maxAgents: -3 })), spawn).allow).toBe(true);
	});
});

/**
 * The pi-subagents `subagent` tool has its own gate (ADR-027): pired delegates
 * ONLY to its four foreground workers, one at a time, each launched with
 * `{ agent, task }` and nothing that overrides its definition. Everything else —
 * a builtin or external-runner agent, any per-call override, a second launch
 * while one runs, a cwd outside the engagement, and any management action that
 * mutates state — is refused. It counts launched children, not tool calls.
 */
describe("the subagent gate", () => {
	const eng = (over: Partial<EngagementScope> = {}): EngagementScope => ({
		v: 1, engagement: "e", authorized: true, mode: "enforce", targets: { domains: ["app.e.test"] }, ...over,
	});
	const decide = (gate: ReturnType<typeof createScopeGate>, call: { name: string; args: object; id?: string }): GateDecision =>
		gate(call) as GateDecision;
	const at = (over: Partial<EngagementScope> = {}) => createScopeGate(eng(over), { cwd: "/work/target" });
	const launch = (extra: object = {}, agent = "pired-scout") => ({ name: "subagent", args: { agent, task: "map /api", ...extra } });
	/** The end pi reports for a launch that ran one child to completion. */
	const ran = (id?: string) => ({ ...(id ? { id } : {}), name: "subagent", isError: false, result: { details: { results: [{ agent: "pired-scout", exitCode: 0 }] } } });

	it("lets a pired launch carrying only agent and task through", () => {
		expect(decide(at(), launch())).toEqual({ allow: true });
	});

	it("refuses a builtin or external-runner agent", () => {
		const gate = at();
		// A pi-subagents builtin and an external CLI runner are both denied — they
		// are not pired workers, so nothing pired vouches for their scope.
		const builtin = decide(gate, launch({}, "general-purpose"));
		expect(builtin.allow).toBe(false);
		expect(builtin.reason).toMatch(/only pired workers/i);
		expect(decide(gate, launch({}, "codex-exec")).allow).toBe(false);
		const unnamed = decide(gate, { name: "subagent", args: { task: "x" } });
		expect(unnamed.reason).toMatch(/names no agent/);
		expect(decide(gate, { name: "subagent", args: { agent: ["pired-scout"], task: "x" } }).reason).toContain('["pired-scout"]');
	});

	/**
	 * The shipped blocker: pi-subagents runs `gate` (and `acceptance.verify`) with
	 * `spawn(command, {shell:true})` after the worker returns, where no tool_call
	 * hook sees it. A probe's gate wrote a marker file and went on to curl a host
	 * the same `bash` call was refused for.
	 */
	it("refuses a gate command, as a string or an object, that the bash gate would have refused", () => {
		const gate = at();
		const command = "curl -s http://evil.example.com/";
		expect(decide(gate, { name: "bash", args: { command } }).allow).toBe(false);
		for (const value of [command, { command, output: "json" }]) {
			const refused = decide(gate, launch({ gate: value }, "pired-verify"));
			expect(refused.allow).toBe(false);
			expect(refused.reason).toContain("`gate`");
			expect(refused.reason).toMatch(/outside pired's scope gate/);
		}
	});

	it("refuses acceptance with verify commands, and acceptance in any other form", () => {
		const gate = at();
		const verify = decide(gate, launch({ acceptance: { level: "verified", verify: [{ command: "nmap evil.example.com", cwd: "/" }] } }));
		expect(verify.allow).toBe(false);
		expect(verify.reason).toContain("`acceptance`");
		// false is pi-subagents' "no acceptance", but the definition already says
		// so; accepting it would put a key on the list whose other values run shells.
		expect(decide(gate, launch({ acceptance: false })).allow).toBe(false);
	});

	/**
	 * Each of these overrides the worker definition pired registered, or does
	 * host-side work the scope gate never sees: a different model or provider
	 * for client code, the parent's transcript, a session outside the accounted
	 * directory, a longer leash, a scripted fan-out.
	 */
	it.each([
		["model", "openai-codex/gpt-6-luna"],
		["model", "zai/glm-5.3-flash:max"],
		["fast", true],
		["thinking", "xhigh"],
		["context", "fork"],
		["context", "profile"],
		["sessionDir", "/elsewhere"],
		["skill", "ops-recon"],
		["skills", ["ops-recon"]],
		["tools", ["bash"]],
		["output", "/tmp/out.md"],
		["outputMode", "file-only"],
		["outputSchema", { type: "object" }],
		["maxOutput", { bytes: 1 }],
		["timeoutMs", 2_000_000_000],
		["maxRuntimeMs", 2_000_000_000],
		["toolBudget", { hard: 10_000 }],
		["usageBudget", { tokens: 10_000_000 }],
		["workflow", "review"],
		["workflowScript", "await runs.run('k',{agent:'pired-scout'})"],
		["workflowScriptPath", "/tmp/w.js"],
		["worktree", true],
		["isolation", "worktree"],
		["tasks", [{ agent: "pired-scout", task: "a" }]],
		["chain", [{ agent: "pired-scout", task: "a" }]],
		["parallel", [{ agent: "pired-scout", task: "a" }]],
		["extensionBindings", { "pkg/1": {} }],
		["reads", ["src/"]],
		["progress", true],
		["includeProgress", true],
		["chatProgress", "live-card"],
		["interactive", true],
		["artifacts", false],
		["share", true],
		["machine", "gpu-box"],
		["agentScope", "project"],
		["control", { enabled: false }],
		["label", "scout"],
		["description", "a scout"],
	])("refuses a launch carrying %s, naming the key", (key, value) => {
		const refused = decide(at(), launch({ [key]: value }));
		expect(refused.allow).toBe(false);
		expect(refused.reason).toContain(`\`${key}\``);
		expect(refused.reason).toMatch(/\{ agent, task \}/);
	});

	it("allows async and context only as the values the definition already sets", () => {
		const gate = at({ maxAgents: 8 });
		expect(decide(gate, { ...launch({ async: false, context: "fresh" }), id: "a" })).toEqual({ allow: true });
		gate.settle(ran("a"));
		const background = decide(gate, launch({ async: true }));
		expect(background.allow).toBe(false);
		expect(background.reason).toMatch(/foreground/);
		expect(decide(gate, launch({ context: "fork" })).reason).toMatch(/starts fresh/);
	});

	it("ignores a key whose value is undefined, which never reaches the wire", () => {
		expect(decide(at(), launch({ model: undefined })).allow).toBe(true);
	});

	it("treats arguments that are not an object as naming no agent", () => {
		expect(decide(at(), { name: "subagent", args: ["pired-scout"] }).reason).toMatch(/names no agent/);
	});

	/**
	 * The check used to be string equality with the engagement directory, so a
	 * scout pointed at `src` was refused with a reason saying the cwd had to stay
	 * inside the engagement — which it did.
	 */
	it("allows a cwd that is the engagement directory or anywhere under it, relative or absolute", () => {
		for (const cwd of ["/work/target", "/work/target/", "/work/target/src", ".", "src", "./src/../lib", ""]) {
			const gate = at();
			expect(decide(gate, launch({ cwd })), cwd).toEqual({ allow: true });
		}
	});

	it("refuses a cwd outside the engagement, and says inside is fine", () => {
		for (const cwd of ["/etc", "..", "../other", "/work/target-other", "/work/target/../other", "src/../../x"]) {
			const refused = decide(at(), launch({ cwd }));
			expect(refused.allow, cwd).toBe(false);
			expect(refused.reason).toContain("or a directory inside it");
			expect(refused.reason).toContain(`refused: ${cwd}`);
		}
		expect(decide(at(), launch({ cwd: 7 })).reason).toContain("refused: 7");
		// With no engagement directory to measure against, any cwd is refused.
		expect(decide(createScopeGate(eng()), launch({ cwd: "/work/target" })).allow).toBe(false);
	});

	/**
	 * pi runs one assistant message's tool calls in parallel unless a tool says
	 * otherwise, and `subagent` does not: a probe's parent emitted two launches
	 * in one message and two workers ran at once against one GPU.
	 */
	it("refuses a second launch while the first is still running, and releases on that launch's own end", () => {
		const gate = at();
		expect(decide(gate, { ...launch(), id: "call-1" })).toEqual({ allow: true });
		const second = decide(gate, { ...launch({}, "pired-verify"), id: "call-2" });
		expect(second.allow).toBe(false);
		expect(second.reason).toMatch(/one at a time/);
		// The refused call ends immediately; its end must not free the running slot.
		gate.settle({ id: "call-2", name: "subagent", isError: true, result: { details: {} } });
		expect(decide(gate, { ...launch({}, "pired-verify"), id: "call-3" }).allow).toBe(false);
		// Other tools ending change nothing either.
		gate.settle({ id: "call-1", name: "bash", isError: false });
		expect(decide(gate, { ...launch({}, "pired-verify"), id: "call-4" }).allow).toBe(false);

		gate.settle(ran("call-1"));
		expect(decide(gate, { ...launch({}, "pired-verify"), id: "call-5" })).toEqual({ allow: true });
	});

	it("lets read-only management through while a worker runs", () => {
		const gate = at();
		expect(decide(gate, { ...launch(), id: "c1" }).allow).toBe(true);
		expect(decide(gate, { name: "subagent", args: { action: "status" } })).toEqual({ allow: true });
		expect(decide(gate, { name: "subagents_enable", args: {} })).toEqual({ allow: true });
	});

	it("releases on any subagent end when the host gave the launch no id", () => {
		const gate = at();
		expect(decide(gate, launch()).allow).toBe(true);
		gate.settle(ran());
		expect(decide(gate, launch()).allow).toBe(true);
	});

	it("counts every launched child against the budget", () => {
		const gate = at({ maxAgents: 2 });
		for (const id of ["a", "b"]) {
			expect(decide(gate, { ...launch(), id }).allow).toBe(true);
			gate.settle(ran(id));
		}
		const over = decide(gate, { ...launch(), id: "c" });
		expect(over.allow).toBe(false);
		expect(over.reason).toMatch(/budget spent: 2 per session, 2 already launched \(0 left\)/);
	});

	/**
	 * The budget was charged when the gate allowed a launch and never given back,
	 * so launches pi-subagents rejected before starting a child — an unknown
	 * model, a missing cwd, a malformed project settings file — spent it.
	 */
	it("refunds a launch that failed before any child started, and keeps the charge when one ran", () => {
		const gate = at({ maxAgents: 1 });
		expect(decide(gate, { ...launch(), id: "rejected" }).allow).toBe(true);
		gate.settle({ id: "rejected", name: "subagent", isError: true, result: { details: { mode: "single", results: [] } } });
		// Blocked by another extension after pired allowed it: pi's error result has empty details.
		expect(decide(gate, { ...launch(), id: "blocked" }).allow).toBe(true);
		gate.settle({ id: "blocked", name: "subagent", isError: true, result: { content: [], details: {} } });

		expect(decide(gate, { ...launch(), id: "failed-child" }).allow).toBe(true);
		// A child that started and failed was a launch: the charge stands.
		gate.settle({ id: "failed-child", name: "subagent", isError: true, result: { details: { results: [{ agent: "pired-scout", exitCode: 1 }] } } });
		expect(decide(gate, { ...launch(), id: "next" }).reason).toMatch(/budget spent/);
	});

	it("says delegation is disabled at maxAgents=0, before looking at anything else", () => {
		const gate = at({ maxAgents: 0 });
		const denied = decide(gate, launch({ gate: "true" }));
		expect(denied.allow).toBe(false);
		expect(denied.reason).toMatch(/disabled/i);
	});

	it("allows the lazy-loader tool, uncounted", () => {
		const gate = at({ maxAgents: 1 });
		for (let i = 0; i < 5; i++) expect(decide(gate, { name: "subagents_enable", args: {} }).allow).toBe(true);
		// Enabling never spent the single-worker budget.
		expect(decide(gate, launch()).allow).toBe(true);
	});

	it("allows read-only management uncounted and refuses a mutating management action", () => {
		const gate = at({ maxAgents: 1 });
		for (const action of ["list", "status", "doctor", "models"]) {
			expect(decide(gate, { name: "subagent", args: { action } }).allow, action).toBe(true);
		}
		const mutate = decide(gate, { name: "subagent", args: { action: "create", agent: "evil", config: {} } });
		expect(mutate.allow).toBe(false);
		expect(mutate.reason).toMatch(/management action/i);
		expect(decide(gate, { name: "subagent", args: { action: "delete", agent: "pired-scout" } }).allow).toBe(false);
		// None of the above spent the single-worker budget.
		expect(decide(gate, launch()).allow).toBe(true);
	});

	it("honours a custom pired-agent set passed to the gate", () => {
		const gate = createScopeGate(eng(), { cwd: "/work/target", agents: new Set(["only-me"]) });
		expect(decide(gate, { ...launch({}, "only-me"), id: "1" }).allow).toBe(true);
		gate.settle(ran("1"));
		expect(decide(gate, launch()).allow).toBe(false);
	});
});

describe("isWithinDir", () => {
	it("follows dot segments the way path.resolve does", () => {
		expect(isWithinDir("/eng", "/eng/a/../b")).toBe(true);
		expect(isWithinDir("/eng", "/eng/../eng2")).toBe(false);
		expect(isWithinDir("/eng", "a/./b")).toBe(true);
		expect(isWithinDir("/", "/anything")).toBe(true);
	});

	it("reads Windows paths, whatever the separator or drive-letter case", () => {
		expect(isWithinDir("C:\\eng", "c:\\eng\\src")).toBe(true);
		expect(isWithinDir("C:\\eng", "src\\x")).toBe(true);
		expect(isWithinDir("C:\\eng", "D:\\eng")).toBe(false);
	});
});

describe("scopeGuidance", () => {
	it("tells a review engagement with no targets that read-only local work is fine", () => {
		const text = scopeGuidance({ v: 1, engagement: "r", authorized: false, mode: "off", targets: {} });
		expect(text).toContain("Read-only local work (e.g. code review) is still fine.");
	});

	it("lists an authorized engagement's targets and the stay-inside instruction", () => {
		const text = scopeGuidance({ v: 1, engagement: "acme", authorized: true, mode: "enforce", targets: { domains: ["a.test"], ips: ["10.0.0.1"] } });
		expect(text).toMatch(/^Authorized engagement: /);
		expect(text).toContain("domains: a.test");
		expect(text).toContain("ips: 10.0.0.1");
		expect(text).toContain("Touch only these targets");
	});
});
