import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * The scribe, wired through the real extension against a real workspace.
 *
 * What is under test here is not the extraction — `core/extract.test.ts` owns
 * that — but WHERE it runs, which is the whole of the change and the one thing
 * a pure test cannot see. pi awaits every event handler: a pass started from
 * `turn_end` stops the agent's own loop between tool calls, and a pass started
 * from `agent_settled` and awaited there stops the operator's next prompt. Both
 * were true of this code, so both are asserted against, by counting model calls
 * per event rather than by reading the source.
 */

const llm = vi.hoisted(() => ({
	/** Every call the scribe made: what it asked, and how it could be called off. */
	calls: [] as Array<{ system: string; signal?: AbortSignal }>,
	/** The reply the model gives. */
	reply: '{"surface": [], "findings": []}',
	/** Never answer, so an abort is observable. */
	hang: false,
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => ({
	...await importOriginal<typeof import("@earendil-works/pi-ai/compat")>(),
	complete: vi.fn(async (_model: unknown, context: { systemPrompt: string }, options: { signal?: AbortSignal }) => {
		llm.calls.push({ system: context.systemPrompt, signal: options?.signal });
		if (llm.hang) {
			await new Promise((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			});
		}
		return { role: "assistant", content: [{ type: "text", text: llm.reply }], stopReason: "stop", timestamp: Date.now() };
	}),
}));

const { default: piredExtension } = await import("./pired.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi stand-in that keeps the handlers so a test can fire them in order. */
function host() {
	const cwd = mkdtempSync(join(tmpdir(), "pired-scribe-"));
	// An explicit workspace keeps the engagement inside the temp directory
	// instead of the operator's home, and `off` keeps the scope gate out of it.
	writeFileSync(
		join(cwd, "pired.scope.json"),
		JSON.stringify({ engagement: "scribe-test", workspace: join(cwd, "ws"), authorized: true, mode: "off", targets: {} }),
	);
	const events = new Map<string, Handler>();
	const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
	const notes: string[] = [];
	/** The last line pi was handed for its own status area. */
	let status = "";
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown> }>();
	const api = {
		registerCommand: (n: string, o: { handler: (a: string, c: unknown) => unknown }) => commands.set(n, o.handler),
		registerShortcut: () => {},
		registerTool: (t: { name: string; execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown> }) => tools.set(t.name, t),
		registerFlag: () => {},
		registerProvider: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		setActiveTools: () => {},
		getActiveTools: () => [] as string[],
		getFlag: () => undefined,
		on: (e: string, h: Handler) => events.set(e, h),
	};
	const ctx = {
		cwd,
		// Not "tui": the footer, the rail and the banner all need a live host, and
		// none of them is what this file is about.
		mode: "print",
		isProjectTrusted: () => true,
		model: { id: "test-model", provider: "test" },
		ui: {
			notify: (m: string) => notes.push(m),
			setStatus: (_key: string, text: string) => {
				status = text;
			},
		},
		getContextUsage: () => undefined,
	};
	piredExtension(api as never);
	return {
		notes,
		/** The ledger on disk, one entry per live row: the stores are append-only. */
		rows: (store: string): Array<Record<string, unknown>> => {
			const path = join(cwd, "ws", `${store}.jsonl`);
			if (!existsSync(path)) return [];
			const byId = new Map<string, Record<string, unknown>>();
			for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
				const row = JSON.parse(line) as Record<string, unknown>;
				byId.set(String(row.id), row);
			}
			return [...byId.values()];
		},
		status: () => status,
		said: () => notes.join(" | "),
		fire: async (event: string, payload: unknown = {}) => await events.get(event)?.(payload, ctx),
		run: async (name: string, args = "") => await commands.get(name)?.(args, ctx),
		/** A tool call as the session's own model would make it. */
		call: async (name: string, params: unknown) => await tools.get(name)?.execute("t1", params, undefined, undefined, ctx),
		has: (event: string) => events.has(event),
	};
}

/** A turn of review long enough to clear EXTRACT_MIN_REVIEW (1,200 characters). */
const turn = (n: number, chars = 1400): unknown => ({
	message: {
		content: [{
			type: "text",
			text: `Reviewed pass ${n}. ${"The login route builds SQL by string interpolation and the session cookie is not flagged. ".repeat(Math.ceil(chars / 96))}`,
		}],
	},
});

function reset() {
	llm.calls.length = 0;
	llm.reply = '{"surface": [], "findings": []}';
	llm.hang = false;
}

describe("where the scribe runs", () => {
	it("is registered on agent_settled and input, not only on turn_end", async () => {
		const h = host();
		expect(h.has("turn_end")).toBe(true);
		expect(h.has("agent_settled")).toBe(true);
		expect(h.has("input")).toBe(true);
	});

	it("costs nothing at turn_end, however much review the turn produced", async () => {
		// The bug this replaces: `turn_end` fires once per assistant message plus
		// its tool batch, INSIDE pi's agent loop, and the loop awaits it. A review
		// that reads thirty files ended thirty turns, and a 2,000-character gate is
		// one turn of thinking — so the agent stopped for a second model call over
		// and over, on a server that answers one at a time.
		reset();
		const h = host();
		await h.fire("session_start");
		for (let i = 0; i < 4; i++) await h.fire("turn_end", turn(i));
		expect(llm.calls).toHaveLength(0);
	});

	it("offers itself once when it is off and there is review to write", async () => {
		reset();
		const h = host();
		await h.fire("session_start");
		await h.fire("turn_end", turn(1));
		await h.fire("agent_settled");
		// Off by default: the buffer is worth a pass, so say so — and still make
		// no call. An operator who never opts in should hear about it once.
		expect(h.said()).toContain("/scribe");
		expect(llm.calls).toHaveLength(0);
		const before = h.notes.length;
		await h.fire("agent_settled");
		await h.fire("agent_settled");
		expect(h.notes.length).toBe(before);
	});

	it("runs once the agent has settled, when it is switched on", async () => {
		reset();
		const h = host();
		await h.fire("session_start");
		await h.run("scribe", "on");
		await h.fire("turn_end", turn(1));
		await h.fire("agent_settled");
		// Started, not awaited: the handler returns before the pass finishes, which
		// is the difference between a background pass and a stall.
		await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
	});

	it("does not ask the checklist roll-call on its own", async () => {
		// The expensive half. Nineteen JSON rows, mostly "not-considered" until the
		// review has been somewhere, re-emitted every pass.
		reset();
		const h = host();
		await h.fire("session_start");
		await h.run("scribe", "on");
		await h.fire("turn_end", turn(1));
		await h.fire("agent_settled");
		await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
		expect(llm.calls[0]?.system).not.toContain('"classes": [');
		expect(llm.calls[0]?.system).toMatch(/Coverage is not being asked for/);
	});

	it("sweeps the checklist when the operator asks by hand", async () => {
		reset();
		// A verdict in the reply, or the sweep is retried — an empty roll-call is
		// a form that came back unfilled, and `needsRetry` treats it as one.
		llm.reply = JSON.stringify({
			surface: [], findings: [],
			classes: [{ class: "sqli", verdict: "not-considered", targets: [] }],
		});
		const h = host();
		await h.fire("session_start");
		await h.fire("turn_end", turn(1));
		await h.run("scribe");
		expect(llm.calls).toHaveLength(1);
		expect(llm.calls[0]?.system).toContain('"classes": [');
		expect(llm.calls[0]?.system).toMatch(/EVERY row/);
	});

	it("abandons a pass the moment the operator types", async () => {
		// On a local server that answers one request at a time, letting go of this
		// call is also what hands the slot back to the agent they are waiting on.
		reset();
		llm.hang = true;
		const h = host();
		await h.fire("session_start");
		await h.run("scribe", "on");
		await h.fire("turn_end", turn(1));
		await h.fire("agent_settled");
		await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
		expect(llm.calls[0]?.signal?.aborted).toBe(false);
		await h.fire("input", { text: "carry on" });
		expect(llm.calls[0]?.signal?.aborted).toBe(true);
		// And it says nothing about it: the operator caused this, and a warning
		// about work they interrupted is noise in the transcript they just claimed.
		expect(h.said()).not.toContain("failed");
	});

	it("picks the same review up again after an abort", async () => {
		// The pass left no fingerprint, so the next settle is free to try again —
		// otherwise one keystroke costs the engagement that turn's records.
		reset();
		llm.hang = true;
		const h = host();
		await h.fire("session_start");
		await h.run("scribe", "on");
		await h.fire("turn_end", turn(1));
		await h.fire("agent_settled");
		await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
		await h.fire("input", { text: "carry on" });
		llm.hang = false;
		await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
		await h.fire("agent_settled");
		await vi.waitFor(() => expect(llm.calls).toHaveLength(2));
	});

	it("writes what the reply names, through the record tool", async () => {
		reset();
		llm.reply = JSON.stringify({
			surface: [{ kind: "endpoint", label: "POST /api/login" }],
			findings: [{
				title: "SQL injection in login", severity: "critical", cwe: "CWE-89",
				file: "backend/auth.py", description: "f-string SQL",
			}],
		});
		const h = host();
		await h.fire("session_start");
		await h.fire("turn_end", turn(1));
		await h.run("scribe");
		expect(h.said()).toContain("1 findings");
	});

	it("stamps its rows scribe, and the session model's own rows lead, though both go through one record tool", async () => {
		reset();
		llm.reply = JSON.stringify({
			surface: [{ kind: "endpoint", label: "POST /api/login" }],
			findings: [{ title: "SQL injection in login", severity: "critical", cwe: "CWE-89", file: "backend/auth.py", description: "f-string SQL" }],
		});
		const h = host();
		await h.fire("session_start");
		await h.call("record", { kind: "finding", title: "Session cookie lacks SameSite", severity: "low", target: "backend/session.py:12" });
		await h.fire("turn_end", turn(1));
		await h.run("scribe");
		const by = Object.fromEntries(h.rows("findings").map((r) => [r.title, r.by]));
		expect(by).toEqual({ "Session cookie lacks SameSite": "lead", "SQL injection in login": "scribe" });
		const surface = h.rows("inventory");
		expect(surface.length).toBeGreaterThan(0);
		expect(surface.every((r) => r.by === "scribe")).toBe(true);
	});
});

describe("/scribe as a switch", () => {
	it("is off by default, and says so", async () => {
		// The reversal. It used to be on, and on meant a model call inside the
		// agent's loop after most turns.
		reset();
		const h = host();
		await h.run("scribe", "status");
		expect(h.said()).toContain("scribe is off");
	});

	it("turns on and back off", async () => {
		reset();
		const h = host();
		await h.run("scribe", "on");
		await h.run("scribe", "status");
		expect(h.said()).toContain("scribe is on");
		h.notes.length = 0;
		await h.run("scribe", "off");
		await h.run("scribe", "status");
		expect(h.said()).toContain("scribe is off");
	});

	it("still answers to /extract, which is what the docs and the muscle memory say", async () => {
		reset();
		const h = host();
		await h.run("extract", "on");
		h.notes.length = 0;
		await h.run("scribe", "status");
		expect(h.said()).toContain("scribe is on");
	});

	it("writes one row when the same review is written up twice", async () => {
		// The pass reads a buffer that only grows, so everything it wrote on the
		// first pass is offered again on the second. Two rows for one bug is a
		// deliverable that reports it twice and a coverage denominator that counts
		// one route as two.
		reset();
		llm.reply = JSON.stringify({
			surface: [{ kind: "endpoint", label: "POST /api/login" }],
			findings: [{
				title: "SQL injection in login", severity: "critical", cwe: "CWE-89",
				file: "backend/auth.py", line: 30, description: "f-string SQL",
			}],
		});
		const h = host();
		await h.fire("session_start");
		await h.fire("turn_end", turn(1));
		await h.run("scribe");
		await h.fire("turn_end", turn(2));
		await h.run("scribe");
		expect(h.rows("findings")).toHaveLength(1);
		// Two elements, and both are real: the route the review mapped, and the file
		// the finding names — `record` creates the second so the cell it settles
		// exists. What matters is that the second pass added neither again.
		expect(h.rows("inventory").filter((r) => r.kind === "endpoint")).toHaveLength(2);
		// One bug, one cell: the finding's class settles sqli on that file once.
		expect(h.rows("hypotheses")).toHaveLength(1);
		expect(h.said()).toContain("already recorded");
	});

	it("writes one row when the second pass rewords the same finding", async () => {
		// A model re-reading its own prose paraphrases. `record` writes a
		// near-duplicate and reports it, because when the AGENT records something
		// that resembles an existing finding it may have found a second bug; this
		// pass is transcribing text it has already transcribed, and folds it.
		reset();
		llm.reply = JSON.stringify({
			findings: [{ title: "SQL injection in login", severity: "critical", cwe: "CWE-89", file: "backend/auth.py", line: 30 }],
		});
		const h = host();
		await h.fire("session_start");
		await h.fire("turn_end", turn(1));
		await h.run("scribe");
		llm.reply = JSON.stringify({
			findings: [{ title: "SQLi in the login handler", severity: "high", file: "backend/auth.py", line: 30 }],
		});
		await h.fire("turn_end", turn(2));
		await h.run("scribe");
		expect(h.rows("findings")).toHaveLength(1);
	});

	it("says which state it is in on the status line", async () => {
		// The operator has to be able to see that nothing is being written without
		// typing a command to ask. Off is the default, so off is the state that
		// most needs saying.
		reset();
		const h = host();
		await h.fire("session_start");
		expect(h.status()).toContain("scribe off");
		await h.run("scribe", "on");
		expect(h.status()).toContain("scribe");
		expect(h.status()).not.toContain("scribe off");
	});

	it("asked with nothing to write, says so rather than calling a model", async () => {
		reset();
		const h = host();
		await h.run("scribe");
		expect(h.said()).toContain("nothing to write");
		expect(llm.calls).toHaveLength(0);
	});
});
