/**
 * The session budget a scope declares (Phase 3, 3.2).
 *
 * Only the reading of `scope.budget` lives here so far; the budget line and its
 * state arrive with 3.2. A ceiling is stated to the model only when something
 * enforces it, so a value that is not a clean count is dropped rather than
 * guessed at: absent means no budget line at all, which is today's behaviour.
 *
 * Pure module: core imports only.
 */

import type { EngagementScope, ScopeBudget } from "./ontology.ts";

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
