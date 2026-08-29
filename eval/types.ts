/**
 * Assay probe contract — the T0 tier (see the evaluation architecture).
 *
 * A probe is a scripted scenario plus a deterministic assertion about pired's
 * own state or decisions. No model, no network, no target repo: probes run in
 * milliseconds against `core/`'s pure functions and the in-memory fakes, which
 * is what lets them sit in CI beside the unit tests.
 *
 * Probes differ from unit tests in three ways, and the difference is the point:
 *   1. They emit **metrics**, not just pass/fail, so the ratchet can hold a floor.
 *   2. They carry **positive controls** — a case that MUST be caught — so a
 *      detector that has silently stopped detecting anything cannot pass.
 *   3. They record **known limits** separately from failures, so a documented
 *      non-goal (the scope gate is not a sandbox) is pinned rather than either
 *      failing the build forever or quietly disappearing.
 */

/**
 * `pass` — behaved as required. `fail` — a real defect, fails the suite.
 * `known-limit` — behaved as *documented*, at a boundary pired explicitly does
 * not claim to hold. A known-limit that changes behaviour becomes a `fail`,
 * which is how the boundary stays honest.
 */
export type Verdict = "pass" | "fail" | "known-limit";

export interface CaseResult {
	id: string;
	verdict: Verdict;
	/** What the contract requires, in one phrase. */
	expected: string;
	/** What actually happened. */
	actual: string;
	/** Why this case exists, or why the limit is acceptable. */
	note?: string;
}

export interface ProbeResult {
	probe: string;
	family: string;
	cases: CaseResult[];
	/** Ratchet-tracked numbers. Keys are namespaced `<family>.<metric>`. */
	metrics: Record<string, number>;
}

export interface Probe {
	name: string;
	family: string;
	description: string;
	run(): Promise<ProbeResult>;
}

export interface RatchetBound {
	/** Metric may not fall below this. */
	min?: number;
	/** Metric may not rise above this. */
	max?: number;
	/** Why this floor exists. */
	why?: string;
}

export interface SuiteReport {
	startedAt: string;
	durationMs: number;
	commit?: string;
	probes: ProbeResult[];
	totals: { pass: number; fail: number; knownLimit: number };
	metrics: Record<string, number>;
	ratchet: { ok: boolean; breaches: Array<{ metric: string; value: number; bound: RatchetBound }> };
}
