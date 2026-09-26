#!/usr/bin/env -S node --experimental-strip-types
/**
 * Where does the delegating arm's extra spend go?
 *
 * On the v5c luna grid the candidate used 62% more tokens than the baseline
 * while its workers accounted for only 7% of them. The rest is the parent's,
 * and a matched comparison reports it as one number, which cannot say whether
 * the parent paid for a longer system prompt carried on every request, for more
 * requests, for handoffs that stay in its context, or for re-reading files a
 * worker had already read. This reads one run's parent transcript and the child
 * sessions pinned under `<cell>/child-sessions` and splits the parent's spend
 * along exactly those lines.
 *
 * It keeps sizes and names only: usage per response, tool names, the `read`
 * tool's path argument, and each tool result's length in characters. Result
 * text, task text and every other argument are dropped at parse time so the
 * output can be printed next to benchmark data without leaking it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contentText, SUBAGENT_TOOL } from "./delegation-compare-lib.ts";

type Row = Record<string, unknown>;

/**
 * A rough characters-per-token rate, used only to put the handoff payload (a
 * character count) on the same axis as token usage in the attribution. It is
 * labelled as an estimate wherever it appears.
 */
export const CHARS_PER_TOKEN = 4;

export interface ResponseUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface SessionResponse {
	usage: ResponseUsage;
	/** The message's own timestamp in ms, or null when the event carries none. */
	at: number | null;
}

export interface SessionToolCall {
	id: string;
	name: string;
	/** The `read` tool's path argument, resolved against the session cwd; absent for every other tool. */
	path?: string;
	/** Index of the response that issued the call. */
	response: number;
	at: number | null;
}

export interface SessionToolResult {
	id: string;
	name: string;
	chars: number;
	/** How many responses preceded this result: the requests after it all carry it. */
	afterResponses: number;
	at: number | null;
}

export interface SessionCompaction {
	/** The summary calls' combined totalTokens (pi sums a split-turn compaction's two calls into one usage). */
	totalTokens: number;
	/** How many responses preceded it: a handoff returned before it stops being carried here. */
	afterResponses: number;
	/** How many tool results preceded it, so a handoff logged at the same response boundary is ordered against it. */
	afterResults: number;
}

export interface ParsedSession {
	responses: SessionResponse[];
	/** Completed compactions; a failed one has no usage and already makes the run invalid upstream. */
	compactions: SessionCompaction[];
	toolCalls: SessionToolCall[];
	toolResults: SessionToolResult[];
}

const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const stamp = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

function parseLines(text: string): Row[] {
	return text.split(/\r?\n/).flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const row = JSON.parse(line) as unknown;
			return isRow(row) ? [row] : [];
		} catch { return []; }
	});
}

/**
 * One session's responses, tool calls and tool results.
 *
 * The parent transcript is pi's event stream, where a finished message is a
 * `message_end`; a child's `session.jsonl` is pi's session file, where it is a
 * `message` entry. A file is read by whichever it holds, never both, so a
 * stream that also logged its entries is not counted twice.
 */
export function parseSession(jsonlText: string): ParsedSession {
	const rows = parseLines(jsonlText);
	let cwd: string | undefined;
	for (const row of rows) if (row.type === "session" && typeof row.cwd === "string") { cwd = row.cwd; break; }
	const eventType = rows.some((row) => row.type === "message_end") ? "message_end" : "message";
	const out: ParsedSession = { responses: [], compactions: [], toolCalls: [], toolResults: [] };
	for (const row of rows) {
		// Compaction spend lives only on compaction_end.result.usage, and the
		// canonical accounting (delegation-compare-lib) counts it as parent spend.
		// Leaving it out put v5c luna's parent totals 440,009 tokens under run.json
		// on the 4 of 38 runs that compacted, most of them long candidate runs.
		if (row.type === "compaction_end" && isRow(row.result)) {
			const u = isRow(row.result.usage) ? row.result.usage : {};
			out.compactions.push({ totalTokens: num(u.totalTokens), afterResponses: out.responses.length, afterResults: out.toolResults.length });
			continue;
		}
		if (row.type !== eventType || !isRow(row.message)) continue;
		const m = row.message;
		const at = stamp(m.timestamp);
		if (m.role === "assistant") {
			const u = isRow(m.usage) ? m.usage : {};
			const index = out.responses.length;
			out.responses.push({ usage: { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), totalTokens: num(u.totalTokens) }, at });
			for (const part of Array.isArray(m.content) ? m.content : []) {
				if (!isRow(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
				const call: SessionToolCall = { id: typeof part.id === "string" ? part.id : "", name: part.name, response: index, at };
				const args = isRow(part.arguments) ? part.arguments : {};
				if (part.name === "read" && typeof args.path === "string" && args.path) {
					call.path = isAbsolute(args.path) || cwd === undefined ? args.path : resolve(cwd, args.path);
				}
				out.toolCalls.push(call);
			}
		} else if (m.role === "toolResult") {
			out.toolResults.push({
				id: typeof m.toolCallId === "string" ? m.toolCallId : "",
				name: typeof m.toolName === "string" ? m.toolName : "",
				chars: contentText(m.content).length,
				afterResponses: out.responses.length,
				at,
			});
		}
	}
	return out;
}

const promptOf = (u: ResponseUsage): number => u.input + u.cacheRead + u.cacheWrite;

export interface RunBreakdown {
	/** Parent responses. Compactions are counted apart, in `compactions`. */
	requests: number;
	/** input + cacheRead + cacheWrite of the parent's first response: the prompt every request starts from. */
	firstRequestPromptTokens: number;
	/** Mean prompt (input + cacheRead + cacheWrite) per parent response. */
	meanContextPerRequest: number;
	/** Sum of that prompt over every parent response. */
	promptTokens: number;
	/**
	 * Prompt growth per request: g = 2 × (promptTokens − requests × first) / requests².
	 *
	 * An agent loop appends each turn to the next prompt, so a run's prompt sum is
	 * about R × F + g × R² / 2, and a longer run has a higher mean context per
	 * request even at the same g. Reading mean context as independent of R put
	 * 63% of v5c luna's extra under "other context growth" when about 30.3M of the
	 * 37.6M above-first-prompt extra was more turns at the baseline's rate.
	 */
	growthPerRequest: number;
	/** Parent output tokens. */
	outputTokens: number;
	/** Completed compactions in the parent session. */
	compactions: number;
	/** Their summary calls' totalTokens. */
	compactionTokens: number;
	/** Responses' totalTokens plus compactionTokens: the canonical accounting's parent spend. */
	parentTotal: number;
	workerTotal: number;
	workerRequests: number;
	/** Characters of every `subagent` tool result the parent received. */
	handoffChars: number;
	/**
	 * Handoff characters times the parent requests that followed each, over
	 * CHARS_PER_TOKEN: an estimate of the prompt tokens the handoffs cost while
	 * they stayed in context. A compaction replaces the handoff with a summary,
	 * so the count stops there; running on would overprice exactly the long
	 * candidate runs that compacted.
	 */
	handoffCarriedTokens: number;
	/**
	 * Distinct paths the parent read with the `read` tool after a worker in the
	 * same run had read them with it. A lower bound: on v5c the parent also made
	 * 630 bash calls to its 1,015 reads, and workers mostly read through bash.
	 */
	rereads: number;
	/** Characters of the parent's results for those re-reads. */
	rereadChars: number;
}

/** The breakdown of one parent session and its children's sessions. */
export function breakdownSessions(parent: ParsedSession, children: ParsedSession[]): RunBreakdown {
	const r = parent.responses;
	const first = r[0];
	const prompts = r.map((x) => promptOf(x.usage));
	// Each handoff is carried from the request after it up to the first compaction logged after it.
	const handoffs = parent.toolResults.flatMap((t, index) => {
		if (t.name !== SUBAGENT_TOOL) return [];
		const cut = parent.compactions.find((k) => k.afterResults > index);
		return [{ chars: t.chars, carried: Math.max(0, (cut ? cut.afterResponses : r.length) - t.afterResponses) }];
	});
	const promptTokens = prompts.reduce((a, b) => a + b, 0);
	const firstPrompt = first ? promptOf(first.usage) : 0;
	const compactionTokens = parent.compactions.reduce((n, k) => n + k.totalTokens, 0);
	// Earliest time any worker read each path; a parent read after it is a re-read.
	const workerReadAt = new Map<string, number>();
	for (const child of children) for (const c of child.toolCalls) {
		if (c.path === undefined || c.at === null) continue;
		const seen = workerReadAt.get(c.path);
		if (seen === undefined || c.at < seen) workerReadAt.set(c.path, c.at);
	}
	const resultChars = new Map(parent.toolResults.map((t) => [t.id, t.chars]));
	const reread = new Set<string>();
	let rereadChars = 0;
	for (const c of parent.toolCalls) {
		if (c.path === undefined || c.at === null) continue;
		const workerAt = workerReadAt.get(c.path);
		if (workerAt === undefined || c.at <= workerAt) continue;
		reread.add(c.path);
		rereadChars += resultChars.get(c.id) ?? 0;
	}
	return {
		requests: r.length,
		firstRequestPromptTokens: firstPrompt,
		meanContextPerRequest: r.length ? promptTokens / r.length : 0,
		promptTokens,
		growthPerRequest: r.length ? 2 * (promptTokens - r.length * firstPrompt) / r.length ** 2 : 0,
		outputTokens: r.reduce((n, x) => n + x.usage.output, 0),
		compactions: parent.compactions.length,
		compactionTokens,
		parentTotal: r.reduce((n, x) => n + x.usage.totalTokens, 0) + compactionTokens,
		workerTotal: children.reduce((n, s) => n + s.responses.reduce((m, x) => m + x.usage.totalTokens, 0), 0),
		workerRequests: children.reduce((n, s) => n + s.responses.length, 0),
		handoffChars: handoffs.reduce((n, t) => n + t.chars, 0),
		handoffCarriedTokens: handoffs.reduce((n, t) => n + t.chars * t.carried, 0) / CHARS_PER_TOKEN,
		rereads: reread.size,
		rereadChars,
	};
}

function sessionFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && e.name === "session.jsonl")
		.map((e) => join(e.parentPath, e.name))
		.sort();
}

/** The breakdown of one run directory: its transcript.jsonl and child-sessions/**\/session.jsonl. */
export function runBreakdown(runDir: string): RunBreakdown {
	const transcript = join(runDir, "transcript.jsonl");
	const parent = parseSession(existsSync(transcript) ? readFileSync(transcript, "utf8") : "");
	const children = sessionFiles(join(runDir, "child-sessions")).map((f) => parseSession(readFileSync(f, "utf8")));
	return breakdownSessions(parent, children);
}

export const FIELDS = [
	"requests", "firstRequestPromptTokens", "meanContextPerRequest", "promptTokens", "growthPerRequest", "outputTokens", "compactions",
	"compactionTokens", "parentTotal", "workerTotal",
	"workerRequests", "handoffChars", "handoffCarriedTokens", "rereads", "rereadChars",
] as const satisfies ReadonlyArray<keyof RunBreakdown>;

export interface RunMeta {
	arm: string;
	target: string;
	pass: number;
	attempt: number;
	valid: boolean;
	/** run.json's usage.parent.totalTokens, when it carries one: what the matched comparison counted. */
	canonicalParentTotal?: number;
}

export interface GridRun<B = RunBreakdown> {
	meta: RunMeta;
	breakdown: B;
}

/**
 * Keep the highest attempt of each (target, pass, arm) and pair the arms.
 *
 * A lower attempt was superseded by a retry; counting it would weigh one cell
 * twice. A pair is usable only when both arms are valid at the same highest
 * attempt, the rule the matched comparison uses, so the ratios here are over
 * the same pairs it approved or rejected.
 */
export function selectRuns<B>(runs: Array<GridRun<B>>): { latest: Array<GridRun<B>>; pairs: Array<{ baseline: GridRun<B>; candidate: GridRun<B> }> } {
	const best = new Map<string, GridRun<B>>();
	for (const run of runs) {
		const key = JSON.stringify([run.meta.target, run.meta.pass, run.meta.arm]);
		const seen = best.get(key);
		if (!seen || run.meta.attempt > seen.meta.attempt) best.set(key, run);
	}
	const latest = [...best.values()].filter((run) => run.meta.valid);
	const pairs: Array<{ baseline: GridRun<B>; candidate: GridRun<B> }> = [];
	for (const candidate of latest) {
		if (candidate.meta.arm !== "candidate") continue;
		const baseline = latest.find((b) => b.meta.arm === "baseline" && b.meta.target === candidate.meta.target && b.meta.pass === candidate.meta.pass);
		if (baseline && baseline.meta.attempt === candidate.meta.attempt) pairs.push({ baseline, candidate });
	}
	pairs.sort((a, b) => a.candidate.meta.target.localeCompare(b.candidate.meta.target) || a.candidate.meta.pass - b.candidate.meta.pass);
	return { latest, pairs };
}

type Numbers = Record<(typeof FIELDS)[number], number>;

/**
 * How much of the candidate's extra parent tokens each cause explains, pooled
 * over the matched pairs.
 *
 * A run's prompt sum is exactly R × F + g × R² / 2 (see growthPerRequest), so
 * pooled over runs it is S + g × K with S = Σ R × F and K = Σ R² / 2. The extra
 * then splits with no cross term left over:
 *
 * - turn count: (R_c − R_b) × F_b + g_b × (K_c − K_b), the extra requests at
 *   the baseline's starting prompt plus the longer runs' growth at the
 *   baseline's rate. The quadratic part matters: a mean-context split that
 *   ignored it charged v5c luna's longer runs to "heavier context".
 * - starting prompt: R_c × (F_c − F_b), with F request-weighted.
 * - faster growth: (g_c − g_b) × K_c, of which the handoffs' carried estimate
 *   is carved out and the rest (other tool results, re-reads, the parent's own
 *   turns) left unnamed.
 * - output, compaction summaries, and whatever totalTokens holds beyond those
 *   (residual).
 *
 * g is pooled (Σ growth / K) rather than a mean of per-run rates, so the terms
 * sum to the pooled prompt difference exactly. Pooling rather than summing
 * per-pair splits keeps one short-candidate/long-baseline pair from driving
 * the turn-count term negative through the interaction of the factors; the
 * per-pair view is reported alongside, since a few pairs dominate the pool.
 */
export interface Attribution {
	extraParentTokens: number;
	turnCount: number;
	startingPrompt: number;
	fasterGrowth: number;
	handoffPayloadEstimate: number;
	otherGrowth: number;
	output: number;
	compaction: number;
	/** Whatever usage's totalTokens holds beyond prompt + output (e.g. reasoning a provider counts apart). */
	residual: number;
	/** Pooled prompt growth per request, baseline and candidate. */
	growth: { baseline: number; candidate: number };
}

type Pair = { baseline: Numbers; candidate: Numbers };

export function attribute(pairs: Pair[]): Attribution {
	const pool = (side: "baseline" | "candidate") => {
		const rows = pairs.map((p) => p[side]);
		const sum = (f: (r: Numbers) => number) => rows.reduce((n, r) => n + f(r), 0);
		const R = sum((r) => r.requests);
		const K = sum((r) => r.requests ** 2 / 2);
		const S = sum((r) => r.requests * r.firstRequestPromptTokens);
		return {
			R, K,
			F: R ? S / R : 0,
			g: K ? (sum((r) => r.promptTokens) - S) / K : 0,
			total: sum((r) => r.parentTotal),
			output: sum((r) => r.outputTokens),
			compaction: sum((r) => r.compactionTokens),
			handoff: sum((r) => r.handoffCarriedTokens),
		};
	};
	const b = pool("baseline");
	const c = pool("candidate");
	const extra = c.total - b.total;
	const turnCount = (c.R - b.R) * b.F + b.g * (c.K - b.K);
	const startingPrompt = c.R * (c.F - b.F);
	const fasterGrowth = (c.g - b.g) * c.K;
	const handoffPayloadEstimate = c.handoff - b.handoff;
	const output = c.output - b.output;
	const compaction = c.compaction - b.compaction;
	return {
		extraParentTokens: extra,
		turnCount,
		startingPrompt,
		fasterGrowth,
		handoffPayloadEstimate,
		otherGrowth: fasterGrowth - handoffPayloadEstimate,
		output,
		compaction,
		residual: extra - turnCount - startingPrompt - fasterGrowth - output - compaction,
		growth: { baseline: b.g, candidate: c.g },
	};
}

export const TERMS = ["turnCount", "startingPrompt", "fasterGrowth", "handoffPayloadEstimate", "otherGrowth", "output", "compaction", "residual"] as const;

const median = (values: number[]): number | null => {
	if (!values.length) return null;
	const s = [...values].sort((x, y) => x - y);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface PerPairView {
	/** Median over pairs of the pair's own extra parent tokens. */
	medianExtra: number | null;
	/** Median over pairs of each term's share of that pair's extra (pairs with no extra are skipped). */
	medianShare: Record<(typeof TERMS)[number], number | null>;
	/** The pair with the largest |extra|, and its extra as a share of the pooled extra. */
	largest: { target: string; pass: number; extra: number; shareOfPooled: number | null } | null;
}

/**
 * The typical pair next to the pool. On v5c single runs reach 24M–36M tokens
 * on the candidate side and 72M on the baseline side, so pooled shares
 * describe those pairs; the medians say whether a typical pair agrees.
 */
export function perPair(pairs: Array<Pair & { target: string; pass: number }>, pooledExtra: number): PerPairView {
	const each = pairs.map((p) => ({ p, a: attribute([p]) }));
	const withExtra = each.filter((e) => e.a.extraParentTokens !== 0);
	const medianShare = Object.fromEntries(TERMS.map((t) => [t, median(withExtra.map((e) => e.a[t] / e.a.extraParentTokens))])) as PerPairView["medianShare"];
	let largest: PerPairView["largest"] = null;
	for (const e of each) {
		if (!largest || Math.abs(e.a.extraParentTokens) > Math.abs(largest.extra)) {
			largest = { target: e.p.target, pass: e.p.pass, extra: e.a.extraParentTokens, shareOfPooled: pooledExtra === 0 ? null : e.a.extraParentTokens / pooledExtra };
		}
	}
	return { medianExtra: median(each.map((e) => e.a.extraParentTokens)), medianShare, largest };
}

const mean = (rows: Numbers[], field: keyof Numbers): number | null => rows.length ? rows.reduce((n, r) => n + r[field], 0) / rows.length : null;

export interface Reconciliation {
	/** Valid runs whose run.json carries the canonical usage.parent.totalTokens. */
	checked: number;
	/** Those whose parentTotal here differs from it. */
	mismatched: number;
	/** Σ (canonical − parentTotal) over the mismatched runs. */
	gap: number;
}

export interface GridReport {
	grid: string;
	runs: { baseline: number; candidate: number };
	pairs: number;
	means: { baseline: Partial<Record<keyof Numbers, number | null>>; candidate: Partial<Record<keyof Numbers, number | null>> };
	/** Σ candidate / Σ baseline over matched pairs; null when the baseline sum is zero. */
	ratios: Partial<Record<keyof Numbers, number | null>>;
	/**
	 * Σ prompt / Σ requests, candidate over baseline, over matched pairs: context
	 * per request weighted by request, the figure the attribution works with.
	 * The meanContextPerRequest ratio is a ratio of per-run means and differs.
	 */
	pooledContextRatio: number | null;
	attribution: Attribution;
	perPair: PerPairView;
	/**
	 * parentTotal against run.json's usage.parent.totalTokens. Without this the
	 * attribution's zero residual held by construction and said nothing about
	 * whether these totals were the ones the matched comparison judged.
	 */
	reconciliation: Reconciliation;
}

/** Request-weighted context per request; null over no requests, so a ratio against it is null rather than Infinity. */
export const pooledContext = (rows: Numbers[]): number | null => {
	const requests = rows.reduce((n, r) => n + r.requests, 0);
	return requests ? rows.reduce((n, r) => n + r.promptTokens, 0) / requests : null;
};

export function pooledContextRatio(pairs: Pair[]): number | null {
	const b = pooledContext(pairs.map((p) => p.baseline));
	if (!b) return null;
	return (pooledContext(pairs.map((p) => p.candidate)) ?? 0) / b;
}

export function reportGrid(grid: string, runs: Array<GridRun<Numbers>>): GridReport {
	const { latest, pairs } = selectRuns(runs);
	const arm = (name: string) => latest.filter((r) => r.meta.arm === name).map((r) => r.breakdown);
	const baseline = arm("baseline");
	const candidate = arm("candidate");
	const means: GridReport["means"] = { baseline: {}, candidate: {} };
	const ratios: GridReport["ratios"] = {};
	for (const field of FIELDS) {
		means.baseline[field] = mean(baseline, field);
		means.candidate[field] = mean(candidate, field);
		const sb = pairs.reduce((n, p) => n + p.baseline.breakdown[field], 0);
		const sc = pairs.reduce((n, p) => n + p.candidate.breakdown[field], 0);
		ratios[field] = sb === 0 ? null : sc / sb;
	}
	const numbers = pairs.map((p) => ({ baseline: p.baseline.breakdown, candidate: p.candidate.breakdown, target: p.candidate.meta.target, pass: p.candidate.meta.pass }));
	const attribution = attribute(numbers);
	const reconciliation: Reconciliation = { checked: 0, mismatched: 0, gap: 0 };
	for (const run of latest) {
		const canonical = run.meta.canonicalParentTotal;
		if (canonical === undefined) continue;
		reconciliation.checked++;
		if (canonical !== run.breakdown.parentTotal) {
			reconciliation.mismatched++;
			reconciliation.gap += canonical - run.breakdown.parentTotal;
		}
	}
	return {
		grid,
		runs: { baseline: baseline.length, candidate: candidate.length },
		pairs: pairs.length,
		means,
		ratios,
		pooledContextRatio: pooledContextRatio(numbers),
		attribution,
		perPair: perPair(numbers, attribution.extraParentTokens),
		reconciliation,
	};
}

function readMeta(runDir: string): RunMeta | null {
	try {
		const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as Row;
		if (typeof run.arm !== "string" || typeof run.target !== "string") return null;
		const meta: RunMeta = { arm: run.arm, target: run.target, pass: num(run.pass), attempt: num(run.attempt), valid: run.valid === true };
		const parent = isRow(run.usage) && isRow(run.usage.parent) ? run.usage.parent : undefined;
		if (parent && typeof parent.totalTokens === "number") meta.canonicalParentTotal = parent.totalTokens;
		return meta;
	} catch { return null; }
}

/** Every run under `<grid>/runs`, with a breakdown for each valid one. */
export function gridRuns(gridDir: string): Array<GridRun<Numbers>> {
	const root = join(gridDir, "runs");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
		const dir = join(root, e.name);
		const meta = readMeta(dir);
		if (!meta) return [];
		// Invalid runs never reach a mean or a pair; skip parsing them.
		const breakdown = meta.valid ? runBreakdown(dir) : (Object.fromEntries(FIELDS.map((f) => [f, 0])) as Numbers);
		return [{ meta, breakdown }];
	});
}

const fmt = (v: number | null | undefined): string => v === null || v === undefined ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(2);
const pct = (v: number | null): string => v === null ? "-" : `${(100 * v).toFixed(1)}%`;

/** Labels where the field name alone would overstate what is measured. */
const LABELS: Partial<Record<keyof Numbers, string>> = { rereads: "rereads (read tool, >=)", rereadChars: "rereadChars (read tool, >=)" };

export function formatReport(report: GridReport): string {
	const lines = [`${report.grid}: valid runs baseline ${report.runs.baseline}, candidate ${report.runs.candidate}; matched pairs ${report.pairs}`];
	lines.push(`  ${"field (mean per run)".padEnd(30)}${"baseline".padStart(14)}${"candidate".padStart(14)}${"ratio".padStart(8)}`);
	for (const field of FIELDS) {
		lines.push(`  ${(LABELS[field] ?? field).padEnd(30)}${fmt(report.means.baseline[field]).padStart(14)}${fmt(report.means.candidate[field]).padStart(14)}${fmt(report.ratios[field]).padStart(8)}`);
	}
	lines.push("  ratio = sum candidate / sum baseline over matched pairs; rereads count the read tool only, a lower bound");
	const rc = report.reconciliation;
	lines.push(`  parentTotal vs run.json usage.parent: checked ${rc.checked}, mismatched ${rc.mismatched}, gap ${rc.gap}`);
	const a = report.attribution;
	const share = (v: number) => a.extraParentTokens === 0 ? "-" : pct(v / a.extraParentTokens);
	lines.push(`  pooled context per request (request-weighted, used below), candidate/baseline: ${fmt(report.pooledContextRatio)}`);
	lines.push(`  pooled prompt growth per request: baseline ${fmt(a.growth.baseline)}, candidate ${fmt(a.growth.candidate)}`);
	lines.push(`  extra parent tokens over matched pairs (pooled): ${a.extraParentTokens}`);
	lines.push(`    ${"term".padEnd(52)}${"pooled".padStart(14)}${"share".padStart(9)}${"pair med".padStart(10)}`);
	const line = (label: string, term: (typeof TERMS)[number]) =>
		lines.push(`    ${label.padEnd(52)}${String(Math.round(a[term])).padStart(14)}${share(a[term]).padStart(9)}${pct(report.perPair.medianShare[term]).padStart(10)}`);
	line("turn count (at baseline start and growth)", "turnCount");
	line("starting prompt", "startingPrompt");
	line("faster per-turn growth", "fasterGrowth");
	line(`  of which handoff payload (est. ${CHARS_PER_TOKEN} chars/token)`, "handoffPayloadEstimate");
	line("  of which other growth", "otherGrowth");
	line("output", "output");
	line("compaction summaries", "compaction");
	line("residual", "residual");
	const big = report.perPair.largest;
	lines.push(`  per pair: median extra ${fmt(report.perPair.medianExtra)}; largest pair ${big ? `${big.target} pass ${big.pass} extra ${big.extra} (${pct(big.shareOfPooled)} of pooled)` : "-"}`);
	return lines.join("\n");
}

export interface CliArgs { grids: string[]; jsonOut?: string }

/** null when the arguments are unusable: no grid, or --json without a path. */
export function parseArgs(args: string[]): CliArgs | null {
	const at = args.indexOf("--json");
	const jsonOut = at >= 0 ? args[at + 1] : undefined;
	const grids = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
	if (!grids.length || (at >= 0 && (!jsonOut || jsonOut.startsWith("--")))) return null;
	return jsonOut ? { grids, jsonOut } : { grids };
}

export function main(args: string[], out: (text: string) => void = (t) => process.stdout.write(t)): number {
	const parsed = parseArgs(args);
	if (!parsed) {
		process.stderr.write("Usage: cost-breakdown.ts <grid-dir>... [--json <out>]\n");
		return 2;
	}
	const reports = parsed.grids.map((grid) => reportGrid(grid, gridRuns(grid)));
	for (const report of reports) out(`${formatReport(report)}\n`);
	if (parsed.jsonOut) writeFileSync(parsed.jsonOut, `${JSON.stringify(reports, null, 2)}\n`);
	return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
