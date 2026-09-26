/** One isolated benchmark process, using the same supported pi SDK in both arms. */
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Types only at module scope: the runner imports BENCHMARK_SETTINGS from here,
// and loading the whole pi SDK for one constant would slow every test that does.
import type { CreateAgentSessionFromServicesOptions, createAgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/**
 * The out-of-scope half of the delegation probe. The child is asked to record
 * one surface element and then run a command against a host the probe cell's
 * scope does not list; pired's child gate must refuse it before bash runs, which
 * the marker file (the command's second half) makes observable from outside.
 */
export interface DelegationProbePlan {
	/** The pired runtime agent the scripted parent launches. */
	agent: string;
	/** Target-relative file the child cites on the surface element it records. */
	recordFile: string;
	/** A path unique to this probe, so the ledger row it writes is found unambiguously. */
	recordPath: string;
	/** An out-of-scope bash command the child's scope gate must block. */
	blockedCommand: string;
	/** Created only if the blocked command ran. */
	markerPath: string;
	/** The cell's pi-subagents defaultSessionDir, where child sessions land. */
	childSessionDir: string;
}

/**
 * A no-model self-check of the Landlock seal and pired's workspace resolution.
 * With `probe` set, the process builds the byte-for-byte same runtime as a scored
 * run, but its session model is a scripted faux model registered only here, so
 * nothing reaches a provider. It reads the listed paths and reports what the
 * seal actually allowed and denied, and the tools the first request offered.
 * The point is that a sealing mistake — an answer key left readable, a workspace
 * resolved to the wrong directory, a tool set that is not the one measured —
 * must surface here, where nothing is spent, rather than as a suspiciously cheap
 * "successful" model run.
 *
 * The tools are read at the first request, not after session_start, because
 * that is where the candidate's set is final: pi-subagents loads after pired and
 * activates bg_wait and subagent_supervisor during its own session_start, and
 * pired can only hide them in before_agent_start (measured on the working tree
 * 2026-09-23: both active after session_start, neither offered to the model).
 *
 * `mode: "delegation"` goes one step further: the scripted parent launches
 * pired workers through pi-subagents. That is the only way to see, before tokens
 * are spent, that a worker's records reach the parent's ledger, that its gate
 * blocks, that its session lands where the runner's accounting reads it, and
 * that a worker pired's turn budget stops is still accounted.
 */
export interface ProbeConfig {
	/** Absolute paths that MUST be unreadable from inside the seal (answer keys, sibling cells). */
	readDenied: string[];
	/** Absolute paths that MUST stay readable (the target copy, the config, the node binary). */
	readAllowed: string[];
	/** "seal" (the default) answers the first request at once; "delegation" drives two scripted worker launches. */
	mode?: "seal" | "delegation";
	/** Required with mode "delegation". */
	delegation?: DelegationProbePlan;
}

export interface CompareEntryConfig {
	snapshot: string;
	provider: string;
	model: string;
	thinking: NonNullable<CreateAgentSessionFromServicesOptions["thinkingLevel"]>;
	cwd: string;
	agentDir: string;
	/** Original shared store, so OAuth refresh keeps its normal cross-process lock. */
	authPath: string;
	modelsPath: string;
	/** A per-cell copy of the model catalog, never a historical session directory. */
	modelsStorePath: string;
	prompt: string;
	/**
	 * Extensions loaded after the snapshot's pired.ts, as absolute paths. The
	 * candidate arm passes the pinned pi-subagents entry; the baseline passes none,
	 * so the two arms differ only in the change under test.
	 */
	extensionPaths?: string[];
	/**
	 * The grid's retry policy (ADR draft 2.1). Absent, retries stay off and no
	 * request is logged: the v5 behaviour, byte for byte.
	 */
	retryPolicy?: RetryPolicy;
	/** Present only for the sealing self-check; a real scored run leaves it unset. */
	probe?: ProbeConfig;
}

/**
 * The settings both arms run with, and the ones a pi-subagents child reads from
 * <agentDir>/settings.json (the runner writes this same object there). Cache
 * warming is off because pi's default ("streaming") sends its own requests to
 * keep a prompt cache warm, which would be spend the transcript does not show as
 * a turn; retries are off so a provider failure stays visible; compaction is on
 * and counted.
 */
export const BENCHMARK_SETTINGS = Object.freeze({
	packages: [] as string[],
	compaction: Object.freeze({ enabled: true }),
	retry: Object.freeze({ enabled: false }),
	cacheWarming: "off" as const,
});

/**
 * A grid's in-run retry policy, recorded in its manifest. pi 0.87.1 reads
 * `retry.{enabled, maxRetries, baseDelayMs, maxAgentDelayMs}` for its agent-level
 * retry (settings-manager.js getRetrySettings) and `retry.provider.maxRetries`
 * for silent transport retries, which default to 0. The agent level emits
 * auto_retry_* and a context_edit per failed attempt, so the accounting can see
 * it; the transport level emits nothing, which is why it is pinned at 0 rather
 * than left to a default a later pi could change.
 *
 * `maxFailedAttempts` is the harness's own cap: pi's `maxRetries` is per streak
 * (the counter resets on the next good reply), so without a run-wide cap a
 * provider that drops every third request would be retried forever and the run
 * would read as valid.
 */
export interface RetryPolicy {
	enabled: true;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs: number;
	providerMaxRetries: 0;
	/** Failed attempts allowed per run, parent and workers together; more makes the run invalid infrastructure. */
	maxFailedAttempts: number;
}

/** The v6 policy (design 2.1): four agent retries, 2 s base, 30 s ceiling, no transport retries. */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
	enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 30_000, providerMaxRetries: 0, maxFailedAttempts: 12,
});

/**
 * The settings a cell runs with. Without a policy it is BENCHMARK_SETTINGS
 * itself, so the settings.json a v5 cell wrote, and its hash, do not change.
 */
export function benchmarkSettings(policy?: RetryPolicy): typeof BENCHMARK_SETTINGS | Record<string, unknown> {
	if (!policy) return BENCHMARK_SETTINGS;
	return {
		...BENCHMARK_SETTINGS,
		retry: {
			enabled: true, maxRetries: policy.maxRetries, baseDelayMs: policy.baseDelayMs, maxAgentDelayMs: policy.maxAgentDelayMs,
			provider: { maxRetries: 0 },
		},
	};
}

/**
 * Refuse a policy that is not the shape above. It arrives from a cell config or
 * a manifest, both files on disk; a typo that turned transport retries on would
 * hide failed attempts from every count.
 */
export function validateRetryPolicy(value: unknown): RetryPolicy {
	const row = value as Partial<Record<keyof RetryPolicy, unknown>> | null;
	if (!row || typeof row !== "object") throw new Error("retryPolicy must be an object");
	if (row.enabled !== true) throw new Error("retryPolicy.enabled must be true; leave retryPolicy out to disable retries");
	if (row.providerMaxRetries !== 0) throw new Error("retryPolicy.providerMaxRetries must be 0: transport retries are silent and unmetered");
	for (const key of ["maxRetries", "maxFailedAttempts"] as const) {
		if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 1) throw new Error(`retryPolicy.${key} must be a positive integer`);
	}
	for (const key of ["baseDelayMs", "maxAgentDelayMs"] as const) {
		if (!Number.isFinite(row[key]) || (row[key] as number) < 0) throw new Error(`retryPolicy.${key} must be a non-negative number of milliseconds`);
	}
	return {
		enabled: true, maxRetries: row.maxRetries as number, baseDelayMs: row.baseDelayMs as number,
		maxAgentDelayMs: row.maxAgentDelayMs as number, providerMaxRetries: 0, maxFailedAttempts: row.maxFailedAttempts as number,
	};
}

/**
 * The host of a fetch target, never its path or query: the path of a provider
 * call can carry an account or deployment name.
 */
export function fetchHost(target: unknown): string | undefined {
	try {
		return new URL(typeof target === "string" ? target : target instanceof URL ? target.href : (target as Request).url).host.toLowerCase();
	} catch { return undefined; }
}

/** The scripted model the delegation probe registers; its name cannot collide with a real provider. */
export const PROBE_FAUX_PROVIDER = "pired-probe-faux";
export const PROBE_FAUX_MODEL = "scripted";

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;
type PiSdk = typeof import("@earendil-works/pi-coding-agent");

/**
 * Read one path the way the seal's caller would: a file through readFileSync, a
 * directory through readdirSync. readFileSync on a directory throws EISDIR even
 * when the directory is perfectly readable, so a bare readFileSync would report a
 * denied-looking failure for an allowed directory. Retrying as a listing makes a
 * denied directory report its own EACCES and an allowed one report success.
 */
function attemptRead(path: string): { ok: boolean; code?: string } {
	try {
		readFileSync(path);
		return { ok: true };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EISDIR") {
			try { readdirSync(path); return { ok: true }; }
			catch (dirError) { return { ok: false, code: (dirError as NodeJS.ErrnoException).code }; }
		}
		return { ok: false, code };
	}
}

function readChecks(probe: ProbeConfig): { denied: Array<{ path: string; blocked: boolean; code?: string }>; allowed: Array<{ path: string; ok: boolean; code?: string }> } {
	return {
		denied: probe.readDenied.map((path) => { const r = attemptRead(path); return { path, blocked: !r.ok, code: r.code }; }),
		allowed: probe.readAllowed.map((path) => { const r = attemptRead(path); return { path, ok: r.ok, code: r.code }; }),
	};
}

type FauxAi = {
	/** pi's own clamp (models.js), the one createAgentSession applies to the requested level. */
	clampThinkingLevel: (model: unknown, level: string) => string;
	getSupportedThinkingLevels: (model: unknown) => string[];
	fauxProvider: (options: { provider: string; models: Array<Record<string, unknown>> }) => {
		provider: unknown;
		getModel(id: string): unknown;
		setResponses(steps: Array<(context: { messages: unknown[] }) => unknown>): void;
		state: { callCount: number };
	};
	fauxAssistantMessage: (content: unknown, options?: { stopReason?: string; responseId?: string }) => unknown;
	fauxToolCall: (name: string, args: Record<string, unknown>) => unknown;
	fauxText: (text: string) => unknown;
	getCurrentTools: (messages: unknown[]) => Array<{ name: string }>;
};

/**
 * The pi-ai copy pi-coding-agent itself resolves. npm nests a second pi-ai under
 * pi-coding-agent here, and a provider built from the top-level copy would hand
 * pi a Provider from a module instance it never loaded.
 */
async function loadHostPiAi(): Promise<FauxAi> {
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const nested = join(resolve(dirname(piEntry), ".."), "node_modules/@earendil-works/pi-ai/dist/index.js");
	const entry = existsSync(nested) ? nested : fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	return await import(pathToFileURL(entry).href) as FauxAi;
}

type ProbeMessage = { role?: string; toolName?: string; isError?: boolean; content?: unknown };
type ProbeCall = { n: number; side: "parent" | "child"; tools: string[]; results: Array<{ tool: string; isError: boolean; text: string }>; budget?: boolean };

/**
 * The task of the delegation probe's second worker, which never hands back: it
 * records one element and then calls a harmless tool every turn until pired's
 * turn budget stops it. A worker the design's own bound stopped must still be
 * accounted; when it was not, one looping worker ended the whole official grid.
 */
export const BUDGET_PROBE_TASK = "BUDGET-PROBE: keep mapping the surface until you are stopped.";

const textOf = (message: ProbeMessage): string => Array.isArray(message.content)
	? (message.content as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n")
	: typeof message.content === "string" ? message.content : "";

/** Every regular file under `dir`, relative to it, or [] when it does not exist. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const visit = (at: string): void => {
		let entries: import("node:fs").Dirent[];
		try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) out.push(relative(dir, path));
		}
	};
	visit(dir);
	return out.sort();
}

/**
 * The seal probe's script: one reply, at the first request, after pired's
 * session_start and before_agent_start have both run, so the tools it records
 * are the ones a scored run's first request is offered.
 */
function scriptSealProbe(ai: FauxAi, probe: ProbeConfig, calls: ProbeCall[], seen: SealObservation): Array<(context: { messages: unknown[] }) => unknown> {
	const step = (context: { messages: unknown[] }): unknown => {
		const tools = ai.getCurrentTools(context.messages).map((t) => t.name);
		calls.push({ n: calls.length + 1, side: "parent", tools, results: [] });
		if (!seen.reported) {
			seen.reported = { ...readChecks(probe), workspace: process.env.PIRED_WORKSPACE ?? null, tools, allTools: seen.allTools?.() ?? null };
		}
		return ai.fauxAssistantMessage(ai.fauxText("Probe complete; no provider was called."), { responseId: `probe-seal-${calls.length}` });
	};
	return Array.from({ length: 4 }, () => step);
}

type SealObservation = {
	allTools?: () => string[];
	reported?: ReturnType<typeof readChecks> & { workspace: string | null; tools: string[]; allTools: string[] | null };
};

/**
 * The scripted parent and worker. A request is the parent's when it offers a
 * delegation tool and the worker's when it offers `record` without one — the
 * tool set, not a prompt marker, so the script does not depend on the wording of
 * pired's worker prompt. The parent turns on pi-subagents' lazy tool if it has
 * to, launches one worker with no `async` (so the configured default decides,
 * and a background default would show up as a missing child), then a second
 * worker with BUDGET_PROBE_TASK, and stops once both results are back. The first
 * worker records one element, attempts the blocked command, and hands off. The
 * second records one element and then calls `true` through bash, with the
 * `toolUse` stop a real model's tool call carries, until pired stops it.
 */
function scriptFaux(ai: FauxAi, plan: DelegationProbePlan, calls: ProbeCall[]): Array<(context: { messages: unknown[] }) => unknown> {
	const step = (context: { messages: unknown[] }): unknown => {
		const messages = context.messages as ProbeMessage[];
		const tools = ai.getCurrentTools(context.messages).map((t) => t.name);
		const results = messages.filter((m) => m.role === "toolResult")
			.map((m) => ({ tool: String(m.toolName ?? ""), isError: m.isError === true, text: textOf(m).slice(0, 400) }));
		const parent = tools.includes("subagent") || tools.includes("subagents_enable");
		const budget = !parent && messages.some((m) => m.role === "user" && textOf(m).includes(BUDGET_PROBE_TASK));
		const n = calls.length + 1;
		calls.push({ n, side: parent ? "parent" : "child", tools, results, ...(budget ? { budget } : {}) });
		const reply = (content: unknown): unknown => ai.fauxAssistantMessage(content, { responseId: `probe-${parent ? "parent" : "child"}-${n}` });
		if (parent) {
			const returned = results.filter((r) => r.tool === "subagent").length;
			if (returned >= 2) return reply(ai.fauxText("Probe complete; both workers are back."));
			if (tools.includes("subagent")) {
				return reply(ai.fauxToolCall("subagent", {
					agent: plan.agent, context: "fresh",
					task: returned === 0
						? `Map the attack surface around ${plan.recordFile}. Record what you find, then return a short handoff.`
						: `${BUDGET_PROBE_TASK} Start at ${plan.recordFile}.`,
				}));
			}
			if (!results.some((r) => r.tool === "subagents_enable")) return reply(ai.fauxToolCall("subagents_enable", {}));
			return reply(ai.fauxText(`No delegation tool after enabling (${tools.join(",")}).`));
		}
		if (!tools.includes("record")) return reply(ai.fauxText(`Worker has no record tool (${tools.join(",")}).`));
		if (budget) {
			const call = results.length === 0
				? ai.fauxToolCall("record", { kind: "endpoint", method: "GET", path: `${plan.recordPath}-budget`, file: plan.recordFile })
				: ai.fauxToolCall("bash", { command: "true" });
			return ai.fauxAssistantMessage(call, { responseId: `probe-child-${n}`, stopReason: "toolUse" });
		}
		if (results.length === 0) {
			return reply(ai.fauxToolCall("record", { kind: "endpoint", method: "GET", path: plan.recordPath, file: plan.recordFile }));
		}
		if (results.length === 1) return reply(ai.fauxToolCall("bash", { command: plan.blockedCommand }));
		return reply(ai.fauxText(`Recorded ${plan.recordPath} (${plan.recordFile}); the out-of-scope request was refused. Nothing unresolved.`));
	};
	// Three parent turns, three for the first worker, and the second worker's
	// budget plus pired's grace turns plus the stop, with room to spare.
	return Array.from({ length: 64 }, () => step);
}

/**
 * Run the scripted delegation and report what it left behind. Everything the
 * report claims is also re-read by the runner from outside the seal; the report
 * is how a failure explains itself, not what decides it.
 */
async function runDelegationProbe(runtime: Runtime, runPrintMode: PiSdk["runPrintMode"], probe: ProbeConfig, plan: DelegationProbePlan, calls: ProbeCall[], prompt: string): Promise<number> {
	const { denied, allowed } = readChecks(probe);
	const exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: prompt });
	const workspace = process.env.PIRED_WORKSPACE ?? null;
	const ledgerRows: Array<Record<string, unknown>> = [];
	if (workspace) {
		const inventory = join(workspace, "inventory.jsonl");
		for (const line of (existsSync(inventory) ? readFileSync(inventory, "utf8") : "").split("\n")) {
			if (!line.includes(plan.recordPath)) continue;
			try { ledgerRows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* reported by count */ }
		}
	}
	const childCalls = calls.filter((c) => c.side === "child" && !c.budget);
	const budgetCalls = calls.filter((c) => c.side === "child" && c.budget);
	const childBash = childCalls.flatMap((c) => c.results).find((r) => r.tool === "bash");
	console.log(JSON.stringify({
		type: "benchmark_probe_delegation", exitCode, denied, allowed, workspace,
		parentCalls: calls.filter((c) => c.side === "parent").length,
		childCalls: childCalls.length,
		parentToolsFirst: calls.find((c) => c.side === "parent")?.tools ?? null,
		parentToolsLast: calls.filter((c) => c.side === "parent").at(-1)?.tools ?? null,
		childTools: childCalls[0]?.tools ?? null,
		childResults: childCalls.at(-1)?.results ?? [],
		childBash: childBash ?? null,
		budgetChildCalls: budgetCalls.length,
		budgetChildLastResult: budgetCalls.at(-1)?.results.at(-1) ?? null,
		markerExists: existsSync(plan.markerPath),
		ledgerRows: ledgerRows.map((r) => ({ id: r.id ?? null, kind: r.kind ?? null, path: r.path ?? null, file: r.file ?? null })),
		childSessionFiles: listFiles(plan.childSessionDir).map((rel) => ({ path: rel, bytes: statSync(join(plan.childSessionDir, rel)).size })),
	}));
	return exitCode;
}

function validateConfig(config: CompareEntryConfig): void {
	for (const key of ["snapshot", "provider", "model", "thinking", "cwd", "agentDir", "authPath", "modelsPath", "modelsStorePath", "prompt"] as const) {
		if (typeof config[key] !== "string" || !config[key]) throw new Error(`Missing entry config: ${key}`);
	}
	if (config.extensionPaths !== undefined && (!Array.isArray(config.extensionPaths) || config.extensionPaths.some((p) => typeof p !== "string" || !isAbsolute(p)))) {
		throw new Error("Invalid extensionPaths: expected an array of absolute path strings");
	}
	if (config.retryPolicy !== undefined) validateRetryPolicy(config.retryPolicy);
	if (config.probe !== undefined) {
		const probe = config.probe as Partial<ProbeConfig>;
		for (const key of ["readDenied", "readAllowed"] as const) {
			const list = probe[key];
			if (!Array.isArray(list) || list.some((path) => typeof path !== "string" || !isAbsolute(path))) {
				throw new Error(`Invalid probe.${key}: expected an array of absolute path strings`);
			}
		}
		if (probe.mode !== undefined && probe.mode !== "seal" && probe.mode !== "delegation") throw new Error(`Invalid probe.mode: ${String(probe.mode)}`);
		if (probe.mode === "delegation") {
			const plan = (probe.delegation ?? {}) as Partial<DelegationProbePlan>;
			for (const key of ["agent", "recordFile", "recordPath", "blockedCommand", "markerPath", "childSessionDir"] as const) {
				if (typeof plan[key] !== "string" || !plan[key]) throw new Error(`Missing probe.delegation.${key}`);
			}
		}
	}
}

async function main() {
	if (process.argv.length !== 3) throw new Error("Usage: delegation-compare-entry.ts <cell-config.json>");
	const config: CompareEntryConfig = JSON.parse(await readFile(process.argv[2]!, "utf8"));
	validateConfig(config);
	const delegationPlan = config.probe?.mode === "delegation" ? config.probe.delegation : undefined;
	const {
		createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
		ModelRuntime, runPrintMode, SessionManager, SettingsManager,
	}: PiSdk = await import("@earendil-works/pi-coding-agent");
	// Match the pinned CLI's HTTP setup, including NO_PROXY and the longer
	// connection attempt timeout. Raw Node fetch otherwise bypasses its dispatcher.
	const http = await import(new URL("./core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	http.configureHttpDispatcher();
	const fetch = globalThis.fetch;
	// With a retry policy, every request is logged (host, status, time to
	// headers; never a body or header). Parent and in-process workers share this
	// fetch, so logged requests minus metered replies is the count of attempts no
	// reply reports usage for, a worker's failed compaction included.
	const logRequests = config.retryPolicy !== undefined;
	let requests = 0;
	globalThis.fetch = async (...args) => {
		const n = logRequests ? ++requests : 0;
		const started = logRequests ? performance.now() : 0;
		try {
			const response = await fetch(...args);
			if (logRequests) console.error(JSON.stringify({ type: "benchmark_request", n, host: fetchHost(args[0]), status: response.status, msToHeaders: Math.round(performance.now() - started) }));
			return response;
		}
		catch (error) {
			if (logRequests) console.error(JSON.stringify({ type: "benchmark_request", n, host: fetchHost(args[0]), status: null, msToHeaders: Math.round(performance.now() - started) }));
			const cause = (error as { cause?: { code?: string; syscall?: string; path?: string; errors?: Array<{ code?: string }> } }).cause;
			// The host (never the path or query) says whose fetch failed: a provider
			// call, or a side-channel such as a model-catalog refresh. Only the
			// former may make an invalid run re-runnable.
			const host = fetchHost(args[0]);
			console.error(JSON.stringify({ type: "benchmark_fetch_error", host, code: cause?.code,
				syscall: cause?.syscall, path: cause?.path, codes: cause?.errors?.map((e) => e.code) }));
			throw error;
		}
	};
	// Only a probe ever registers the scripted model; a scored run loads pi-ai's
	// thinking helpers from the same copy but registers nothing.
	const probeCalls: ProbeCall[] = [];
	const sealSeen: SealObservation = {};
	const probe = config.probe;
	const hostAi = await loadHostPiAi();
	const faux = probe
		? (() => {
			const handle = hostAi.fauxProvider({ provider: PROBE_FAUX_PROVIDER, models: [{ id: PROBE_FAUX_MODEL, reasoning: true, contextWindow: 200_000, maxTokens: 8192 }] });
			handle.setResponses(delegationPlan ? scriptFaux(hostAi, delegationPlan, probeCalls) : scriptSealProbe(hostAi, probe, probeCalls, sealSeen));
			return handle;
		})()
		: undefined;
	// CLI --no-extensions still resolves global npm packages. An explicit SDK
	// SettingsManager keeps unrelated packages and their prompts out of both arms.
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const settingsManager = SettingsManager.inMemory(structuredClone(benchmarkSettings(config.retryPolicy)) as Parameters<typeof SettingsManager.inMemory>[0], { projectTrusted: true });
		const modelRuntime = await ModelRuntime.create({ authPath: config.authPath, modelsPath: config.modelsPath,
			modelsStorePath: config.modelsStorePath, allowModelNetwork: false });
		if (faux) modelRuntime.registerNativeProvider(faux.provider as Parameters<typeof modelRuntime.registerNativeProvider>[0]);
		const services = await createAgentSessionServices({
			cwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
				additionalExtensionPaths: [join(config.snapshot, "extensions/pired.ts"), ...(config.extensionPaths ?? [])],
			},
		});
		const errors = services.diagnostics.filter((d) => d.type === "error");
		if (errors.length) throw new Error(errors.map((d) => d.message).join("\n"));
		const extensionErrors = services.resourceLoader.getExtensions().errors;
		if (extensionErrors.length) throw new Error(`Extension load failed: ${JSON.stringify(extensionErrors)}`);
		const model = modelRuntime.getModel(config.provider, config.model);
		if (!model) throw new Error(`Configured model unavailable: ${config.provider}/${config.model}`);
		const sessionModel = faux ? modelRuntime.getModel(PROBE_FAUX_PROVIDER, PROBE_FAUX_MODEL) : model;
		if (!sessionModel) throw new Error("the delegation probe's scripted model did not register");
		// No `tools` option. It is an allowlist that filters extension tools too:
		// the first SDK preflight passed ["read","bash","edit","write"], pired's
		// record/recall never reached the model, and it wrote notes to files with
		// bash instead. Scored, both arms would have recorded nothing and read as
		// "same quality, fewer tokens". Left unset, pi starts from the same four
		// built-ins the CLI does and pired activates its own tools at session_start,
		// so a tool pired adds later cannot be dropped by a stale list here.
		const session = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
			model: sessionModel, thinkingLevel: config.thinking });
		// The effective level, not the requested one. pi clamps the request to what
		// the model supports (sdk.js clampThinkingLevel): under pi's built-in
		// catalog glm-5.3-flash has no medium, so --thinking medium ran at high
		// while this line still said medium, and pired registered its workers at
		// high. A probe's session runs the scripted model, which supports every
		// level, so the real model's clamp is computed with pi's own function.
		const thinking = faux ? hostAi.clampThinkingLevel(model, config.thinking) : session.session.thinkingLevel;
		console.log(JSON.stringify({ type: "benchmark_runtime", provider: model.provider, model: model.id,
			api: model.api, endpoint: new URL(model.baseUrl).origin, thinking, requestedThinking: config.thinking,
			supportedThinking: hostAi.getSupportedThinkingLevels(model),
			contextWindow: model.contextWindow, maxTokens: model.maxTokens }));
		return { ...session, services, diagnostics: services.diagnostics };
	}, { cwd: config.cwd, agentDir: config.agentDir, sessionManager: SessionManager.inMemory(config.cwd) });
	if (probe && delegationPlan) {
		process.exitCode = await runDelegationProbe(runtime, runPrintMode, probe, delegationPlan, probeCalls, config.prompt);
		return;
	}
	if (probe) {
		sealSeen.allTools = () => runtime.session.getAllTools().map((t) => t.name);
		const exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: config.prompt });
		const seen = sealSeen.reported;
		console.log(JSON.stringify({
			type: "benchmark_probe", exitCode, requests: probeCalls.length,
			denied: seen?.denied ?? [], allowed: seen?.allowed ?? [],
			// pired exports this during session_start; null means it never resolved a workspace.
			workspace: seen?.workspace ?? null,
			extensionTools: seen?.tools ?? null, allTools: seen?.allTools ?? null,
		}));
		process.exitCode = exitCode;
		return;
	}
	// The scored path: the configured model, the review prompt, nothing scripted.
	process.exitCode = await runPrintMode(runtime, { mode: "json", initialMessage: config.prompt });
}

// Only when run as the entry: the runner and the tests import the types and
// BENCHMARK_SETTINGS, which must not start a session.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
