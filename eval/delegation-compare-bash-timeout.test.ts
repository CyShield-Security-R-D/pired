import { describe, expect, it } from "vitest";
import benchmarkBashTimeout, { bashTimeoutFor, DEFAULT_BASH_TIMEOUT_S } from "./delegation-compare-bash-timeout.ts";

describe("the benchmark's default bash timeout", () => {
	it("gives an unbounded bash call the default, so a runaway script cannot hold a run to its wall-clock limit", () => {
		expect(bashTimeoutFor({ command: "python3 - <<'EOF' ... EOF" })).toBe(DEFAULT_BASH_TIMEOUT_S);
		expect(bashTimeoutFor({ command: "x", timeout: 0 })).toBe(DEFAULT_BASH_TIMEOUT_S);
		expect(bashTimeoutFor({ command: "x", timeout: "10" })).toBe(DEFAULT_BASH_TIMEOUT_S);
	});

	it("leaves a timeout the model chose alone", () => {
		expect(bashTimeoutFor({ command: "go test ./...", timeout: 3000 })).toBeUndefined();
		expect(bashTimeoutFor(undefined)).toBeUndefined();
	});

	it("sets the timeout on the call itself, for bash only", () => {
		const handlers: Array<(e: { toolName: string; input: unknown }) => undefined> = [];
		benchmarkBashTimeout({ on: (_event, handler) => { handlers.push(handler); } });
		const bash = { toolName: "bash", input: { command: "sleep 1" } as { command: string; timeout?: number } };
		const read = { toolName: "read", input: { path: "a" } as Record<string, unknown> };
		for (const h of handlers) { h(bash); h(read); }
		expect(bash.input.timeout).toBe(DEFAULT_BASH_TIMEOUT_S);
		expect(read.input).not.toHaveProperty("timeout");
	});
});
