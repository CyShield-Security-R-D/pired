/**
 * pired's child extension: what a pi-subagents worker loads to become a pired worker.
 *
 * The parent names this file in each pired runtime agent's `extensions` (ADR-027),
 * so pi-subagents loads it into the child session in place of the ambient
 * extensions. The child it produces has pired's `record` and `recall` on the
 * parent's ledger, pired's scope gate with delegation off, a turn budget and
 * record rules for its role, a prompt without pi-subagents' supervisor-channel
 * section, one reminder to record before it hands back with nothing on the
 * ledger, and nothing else of pired's: no panel, no banner, no scribe, no
 * provider setup, no notifications. It never writes scope.json and never writes
 * process.env — the child runs in the parent's process, and an env write here
 * would change the parent's shell too.
 *
 * The scope comes from the parent in-process, on `globalThis` under
 * `Symbol.for("pired.parent-scope.v1")` (core/child.ts `publishParentScope`), not
 * from the workspace's scope.json: that file is informational, and the gated
 * agent can write it. The child is a foreground run in the parent's process, so
 * the parent's published scope is always there when a pired parent launched it.
 *
 * Failure is closed twice over. If the parent's workspace or published scope
 * cannot be found, session_start throws: pi reports it, `record` is never
 * registered, and pi-subagents fails the child at agent_start because `record` is
 * on the agent's tool allowlist. And the tool_call hook is installed before any of
 * that, refusing every call until the gate is armed, so a host that ran the
 * session anyway would still get no bash and no network from it.
 *
 * The decisions live in core/child.ts; this file is only the pi wiring.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHILD_EXTENSION_ID, createChildGuard, EXTENSION_ACK_EVENT, openChildWorkspace, withoutSupervisorSection,
} from "../core/child.ts";
import { makeHostServices } from "./lib/host.ts";
import { toPiTool } from "./lib/tools.ts";

/** The `customType` of the one reminder a worker gets before it hands back with nothing recorded. */
export const SETTLE_REMINDER_TYPE = "pired-record-before-handback";

/** The effective system prompt, or undefined on a host whose context cannot report it. */
function systemPromptOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.getSystemPrompt();
	} catch {
		return undefined;
	}
}

export default function piredChild(pi: ExtensionAPI): void {
	const services = makeHostServices();
	const guard = createChildGuard();

	// Registered first and unconditionally: until session_start arms the gate,
	// this refuses everything.
	pi.on("tool_call", async (event, ctx) => {
		guard.identify(systemPromptOf(ctx));
		const decision = await guard.check({ name: event.toolName, args: event.input });
		if (decision.allow) return undefined;
		return { block: true, reason: decision.reason, ...(decision.terminate ? { terminate: true } : {}) };
	});

	pi.on("turn_start", () => {
		guard.turnStarted();
	});

	// The role marker is in the system prompt pi-subagents assembled for this
	// agent. Read at every point the prompt is available, because which of them
	// a given pi version fills first is not something to depend on.
	//
	// Identified from the prompt as it arrived, before anything is cut from it.
	// The cut is pi-subagents' supervisor-channel section, which tells the worker
	// to use a tool pired refuses (core/child.ts `withoutSupervisorSection`). A
	// returned `systemPrompt` replaces the prompt for the whole run in pi 0.87,
	// the settle continuation included; the session file still records the
	// structured sections, so the section shows there though the model never
	// sees it. Returned only when something was cut, so an unchanged prompt
	// keeps pi's structured form.
	pi.on("before_agent_start", (event) => {
		guard.identify(event.systemPrompt);
		const systemPrompt = withoutSupervisorSection(event.systemPrompt);
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	// The last point before the worker hands back. A worker with nothing on the
	// ledger is told once, and given one more request, to record what it
	// established (core/child.ts `settleCheck` decides; it never fires twice).
	// Handlers chain `entries`, so the reminder goes after whatever an earlier
	// handler proposed. A custom message reaches the model as a user turn, which
	// is what lets pi honour `continue`. pi-subagents 0.71 aborts a child one
	// second after a terminal answer unless it sees the run go on; pi 0.87 emits
	// agent_end, which clears that timer, before this event, and the extra
	// request opens with turn_start, which keeps it clear.
	pi.on("agent_before_settle", (event) => {
		const reminder = guard.settleCheck(event.outcome);
		if (!reminder) return undefined;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: SETTLE_REMINDER_TYPE, content: reminder, display: true }],
			continue: true,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		guard.identify(systemPromptOf(ctx));
		let setup: Awaited<ReturnType<typeof openChildWorkspace>>;
		try {
			setup = await openChildWorkspace(process.env.PIRED_WORKSPACE, services, {
				scopeRegistry: globalThis,
				passes: process.env.PIRED_PASSES,
				// Counted where rows reach the ledger, not per resolved call: an
				// evidence file, a note or a repeat that matched a row already there
				// writes no row, and must not release the recording reserve.
				onWrite: (store) => guard.recorded(store),
				// The rows it creates carry its agent name, as the guard learned it
				// from the prompt — read per write, since the role may arrive later.
				author: () => guard.status.agent,
			});
		} catch (error) {
			guard.fail(error instanceof Error ? error.message : String(error));
			throw error;
		}
		for (const tool of setup.tools) pi.registerTool(toPiTool(tool, () => services));
		// The ledger too: a verifier's finding writes are checked against what is on it.
		guard.arm(setup.scope, setup.ledger);
		// After arming, so an acknowledged child is one whose gate is live.
		pi.events.emit(EXTENSION_ACK_EVENT, { id: CHILD_EXTENSION_ID });
	});
}
