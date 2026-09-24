/**
 * A default timeout for the benchmark's `bash` calls, loaded into the parent session of BOTH arms.
 *
 * pi's bash tool has no default timeout ("optional, no default timeout"), so a command the model
 * starts and never bounds runs until the run's own wall-clock limit. Measured in the v5 grids
 * (2026-09-24): a model tested its own regular-expression hypothesis with a script whose input
 * made the regex engine backtrack without end; the process sat at 100% CPU for 21 minutes with the
 * transcript silent, and only an operator's kill saved the pair from a timeout — which the harness
 * classes as non-infrastructure, blocking the pair and, in an official grid, the model's verdict.
 *
 * The default applies only when the call names no timeout: a command the model bounded itself keeps
 * its bound. It is the same in both arms, so it changes the environment, never the comparison.
 * Workers need no copy: pired bounds each of them at 45 minutes (WORKER_TIMEOUT_MS).
 */

/** Seconds, pi's unit for bash `timeout`. Long enough for a real scanner or build, short of a hung run. */
export const DEFAULT_BASH_TIMEOUT_S = 900;

/** The timeout a bash call should carry: its own when it set a usable one, the default otherwise. */
export function bashTimeoutFor(input: unknown): number | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const t = (input as { timeout?: unknown }).timeout;
	if (typeof t === "number" && Number.isFinite(t) && t > 0) return undefined;
	return DEFAULT_BASH_TIMEOUT_S;
}

type ToolCallEvent = { toolName: string; input: unknown };
type Pi = { on(event: "tool_call", handler: (event: ToolCallEvent) => undefined): void };

export default function benchmarkBashTimeout(pi: Pi): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const timeout = bashTimeoutFor(event.input);
		// pi's contract: to change a call's arguments, mutate event.input in place.
		if (timeout !== undefined && typeof event.input === "object" && event.input !== null) {
			(event.input as { timeout?: number }).timeout = timeout;
		}
		return undefined;
	});
}
