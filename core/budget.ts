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
	const { tokens, minutes } = raw as Record<string, unknown>;
	const out: ScopeBudget = {};
	const t = count(tokens);
	const m = count(minutes);
	if (t !== undefined) out.tokens = t;
	if (m !== undefined) out.minutes = m;
	return t === undefined && m === undefined ? undefined : out;
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
 * no budget. One line, about forty tokens, rebuilt every request — which is why
 * it never goes in the system prompt, where a number that moves every turn
 * would break the cached prefix.
 *
 * "Budget: 6.1M of 20M tokens · 52 of 240 min — a ceiling, not a target."
 *
 * It informs; it does not script. From 80% it says to record what is
 * established, because a session cut off at the ceiling keeps only what reached
 * the ledger. At the ceiling it says to settle, which writes down what remains
 * for the next session rather than ending anything.
 */
export function renderBudgetLine(reading: BudgetReading | undefined): string {
	const state = budgetState(reading);
	if (!state) return "";
	const parts: string[] = [];
	if (state.tokens) parts.push(`${formatTokens(state.tokens.spent)} of ${formatTokens(state.tokens.ceiling)} tokens`);
	if (state.minutes) parts.push(`${Math.floor(state.minutes.spent)} of ${state.minutes.ceiling} min`);
	const head = `Budget: ${parts.join(" · ")} — a ceiling, not a target.`;
	if (state.level === "spent") {
		return `${head} The ceiling is reached: settle (\`record kind=settle\`), which records what remains for the next session.`;
	}
	if (state.level === "late") {
		return `${head} ${Math.floor(state.fraction * 100)}% is used: record what is established.`;
	}
	return head;
}
