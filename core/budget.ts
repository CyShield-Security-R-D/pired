/**
 * The session budget a scope declares, and the one line that states it (Phase 3, 3.2).
 *
 * A ceiling is stated to the model only when something enforces it, so a value
 * that is not a clean count is dropped rather than guessed at: absent means no
 * budget line at all, which is the behaviour every measurement before 3.2 was
 * taken against.
 *
 * Why a line at all: agents under-use a budget they cannot see, and showing
 * used and remaining each turn held accuracy at lower cost in the literature
 * research/12 cites (BATS). Why "a ceiling, not a target": the failure on the
 * other side is a model that spends to the line because the line is there, and
 * research/12 found true positives roughly flat across token buckets
 * (observational, so no dose-response claim, but no sign that spending to the
 * line buys findings either).
 *
 * Pure module: core imports only.
 */

import type { BudgetReading, EngagementScope, ScopeBudget } from "./ontology.ts";

/** A non-negative integer, or undefined — the rule `workerCap` applies to `maxAgents`. */
function count(v: unknown): number | undefined {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * The scope's budget with its invalid parts dropped, or undefined when nothing
 * valid is left. `tokens` and `minutes` are read independently: a scope that
 * gets one right keeps it.
 */
export function parseBudget(scope: EngagementScope | undefined): ScopeBudget | undefined {
	const raw: unknown = scope?.budget;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { tokens, minutes, deadline } = raw as Record<string, unknown>;
	const out: ScopeBudget = {};
	const t = count(tokens);
	const m = count(minutes);
	const d = typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) ? deadline : undefined;
	if (t !== undefined) out.tokens = t;
	if (m !== undefined) out.minutes = m;
	if (d !== undefined) out.deadline = d;
	return t === undefined && m === undefined && d === undefined ? undefined : out;
}

/** The share of a ceiling past which the line says to record what is established. */
export const BUDGET_LATE = 0.8;

/** One stated unit: its ceiling, what is spent, what is left and the share used. */
export interface BudgetUnitState {
	ceiling: number;
	spent: number;
	remaining: number;
	/** spent / ceiling; a zero ceiling reads as wholly used. */
	fraction: number;
}

/**
 * `open` under 80% of every stated ceiling, `late` from 80%, `spent` at or past
 * one. The most-used unit decides: a session with its minutes gone and its
 * tokens untouched is out of time, whatever the tokens say.
 */
export type BudgetLevel = "open" | "late" | "spent";

export interface BudgetState {
	tokens?: BudgetUnitState;
	minutes?: BudgetUnitState;
	/** The largest fraction among the stated units. */
	fraction: number;
	level: BudgetLevel;
}

function unit(ceiling: number, spent: number | undefined): BudgetUnitState {
	const used = typeof spent === "number" && Number.isFinite(spent) && spent > 0 ? spent : 0;
	return { ceiling, spent: used, remaining: Math.max(0, ceiling - used), fraction: ceiling > 0 ? used / ceiling : 1 };
}

/**
 * Where the session stands against its ceilings, or undefined when the reading
 * states none. A unit with no ceiling is not reported, whatever was spent in
 * it: spend with nothing to measure it against is not a budget.
 */
export function budgetState(reading: BudgetReading | undefined): BudgetState | undefined {
	if (!reading) return undefined;
	const out: Omit<BudgetState, "fraction" | "level"> = {};
	if (reading.ceiling.tokens !== undefined) out.tokens = unit(reading.ceiling.tokens, reading.spent.tokens);
	if (reading.ceiling.minutes !== undefined) out.minutes = unit(reading.ceiling.minutes, reading.spent.minutes);
	const fractions = [out.tokens?.fraction, out.minutes?.fraction].filter((f): f is number => f !== undefined);
	if (fractions.length === 0) return undefined;
	const fraction = Math.max(...fractions);
	return { ...out, fraction, level: fraction >= 1 ? "spent" : fraction >= BUDGET_LATE ? "late" : "open" };
}

/**
 * A token count the way a reader skims one: 6.1M, 20M, 850k, 3.4k, 512.
 * Floored, never rounded up, so a session just under its ceiling never reads as
 * being at it.
 */
export function formatTokens(n: number): string {
	const scaled = (v: number, suffix: string): string =>
		`${v < 100 ? Math.floor(v * 10) / 10 : Math.floor(v)}${suffix}`;
	if (n >= 1_000_000) return scaled(n / 1_000_000, "M");
	if (n >= 1_000) return scaled(n / 1_000, "k");
	return String(Math.floor(Math.max(0, n)));
}

/**
 * The budget line for the per-request tail block, or "" when the scope states
 * no budget. One line, rebuilt every request — which is why it never goes in
 * the system prompt, where a number that moves every turn would break the
 * cached prefix.
 *
 * "Budget: 12 of 45 min used, 33 left · 6.1M of 20M tokens used, 13.9M left."
 *
 * Used and left are both stated, because what a reader acts on is what is
 * left. Minutes used are rounded up and left is the rest, so the two always sum
 * to the ceiling and neither overstates the time there is.
 *
 * It informs; it does not script. Under 80% it is the numbers alone. From 80%
 * it says the budget is a ceiling, not a target, and to record what is
 * established, because a session cut off at the ceiling keeps only what reached
 * the ledger. At the ceiling it says to settle, which writes down what remains
 * for the next session rather than ending anything — or, when the session has
 * settled and done no work since (`settled`), says so instead of asking again.
 */
export function renderBudgetLine(reading: BudgetReading | undefined, settled?: string): string {
	const state = budgetState(reading);
	if (!state) return "";
	const parts: string[] = [];
	if (state.minutes) {
		const used = Math.min(state.minutes.ceiling, Math.ceil(state.minutes.spent));
		parts.push(`${used} of ${state.minutes.ceiling} min used, ${state.minutes.ceiling - used} left`);
	}
	if (state.tokens) {
		parts.push(`${formatTokens(state.tokens.spent)} of ${formatTokens(state.tokens.ceiling)} tokens used, ${formatTokens(state.tokens.remaining)} left`);
	}
	const head = `Budget: ${parts.join(" · ")}`;
	if (state.level === "spent") {
		return settled
			? `${head} — a ceiling, not a target. The ceiling is reached; settled: ${settled}.`
			: `${head} — a ceiling, not a target. The ceiling is reached: settle (\`record kind=settle\`), which records what remains for the next session.`;
	}
	if (state.level === "late") {
		return `${head} — a ceiling, not a target. ${Math.floor(state.fraction * 100)}% is used: record what is established.`;
	}
	return `${head}.`;
}

// ---------------------------------------------------------------------------
// Spend: what the host counts against `tokens` and `minutes`
// ---------------------------------------------------------------------------

function tokenCount(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Tokens one model call cost, from a usage object: pi's `totalTokens` when it
 * is there, else input + output + cache reads + cache writes (pi-subagents
 * reports a child's usage without a total). Anything unreadable is 0 — a
 * missing count must not become a guessed one.
 */
export function usageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	const total = tokenCount(u.totalTokens);
	if (total > 0) return total;
	return tokenCount(u.input) + tokenCount(u.output) + tokenCount(u.cacheRead) + tokenCount(u.cacheWrite);
}

/** Tokens the workers of one `subagent` call spent: the sum over pi-subagents' `details.results[].usage`. */
export function subagentTokens(result: unknown): number {
	const results = (result as { details?: { results?: unknown } } | null | undefined)?.details?.results;
	if (!Array.isArray(results)) return 0;
	return results.reduce<number>((n, r) => n + usageTokens((r as { usage?: unknown } | null)?.usage), 0);
}

/** Who spent it: the lead's own turns, its workers (and verifiers), or the scribe. */
export type SpendSource = "parent" | "worker" | "scribe";

/**
 * A session's spend, counted by source from the moment it started. Tokens
 * count every model call the session pays for, which is the scope's
 * definition; minutes are wall clock from `startMs`.
 *
 * `once` takes a key so an event pi might deliver twice (a tool call's end) is
 * counted once.
 */
export class SpendMeter {
	private readonly bySource: Record<SpendSource, number> = { parent: 0, worker: 0, scribe: 0 };
	private readonly seen = new Set<string>();
	private readonly startMs: number;

	constructor(startMs: number) {
		this.startMs = startMs;
	}

	add(source: SpendSource, tokens: number): void {
		this.bySource[source] += tokenCount(tokens);
	}

	/** Add once per key; a repeat of the key adds nothing. */
	once(key: string, source: SpendSource, tokens: number): void {
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.add(source, tokens);
	}

	tokens(source?: SpendSource): number {
		return source ? this.bySource[source] : this.bySource.parent + this.bySource.worker + this.bySource.scribe;
	}

	minutes(nowMs: number): number {
		return Math.max(0, nowMs - this.startMs) / 60_000;
	}

	/**
	 * The reading for `ToolDeps.budget` and the tail block, or undefined when
	 * there is no ceiling.
	 *
	 * With a `deadline`, time is read from it: minutes spent are the ceiling less
	 * the minutes left before it, so the count agrees with the clock that stops
	 * the session rather than trailing it by however long the host took to start
	 * pired. A deadline with no `minutes` makes its own ceiling, from session
	 * start to the deadline, rounded down.
	 */
	reading(ceiling: ScopeBudget | undefined, nowMs: number): BudgetReading | undefined {
		if (!ceiling) return undefined;
		const deadline = ceiling.deadline === undefined ? Number.NaN : Date.parse(ceiling.deadline);
		if (!Number.isFinite(deadline)) return { ceiling, spent: { tokens: this.tokens(), minutes: this.minutes(nowMs) } };
		const left = Math.max(0, deadline - nowMs) / 60_000;
		const minutes = ceiling.minutes ?? Math.max(0, Math.floor((deadline - this.startMs) / 60_000));
		return { ceiling: { ...ceiling, minutes }, spent: { tokens: this.tokens(), minutes: Math.max(0, minutes - left) } };
	}
}
