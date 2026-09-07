/**
 * Field T1 — a model in the loop, challenging findings against the live target.
 *
 * The tier above `reference.ts`. There the control probe came from the key, so
 * the number was the contract's ceiling: what the design concludes when the
 * right probe is run. Here nothing is handed over. The model gets the finding,
 * the brief `core/challenge.ts` builds for its class, credentials for the
 * principals an engagement would have, and one tool that can reach the target.
 * It has to work out which requests settle the claim.
 *
 * What it must NOT see, and does not: the claim's truth, its separator, the
 * trap it embodies, or its control probe. The prompt is assembled from the
 * finding record alone, which is the same artifact `recall challenge` hands a
 * real operator.
 *
 * Two arms, because the interesting variable is information rather than
 * cleverness:
 *
 *   blind — no target model. The access-control pairs are unanswerable from
 *           requests, so the correct behaviour is to settle everything else and
 *           leave those two suspected rather than guess. A model that resolves
 *           them here is guessing, and the instrument will show it as a false
 *           confirmation or a false refutation.
 *
 *   spec  — the actors and invariants a `model.md` would carry. Now entitlement
 *           is answerable, and the pair should separate. This is the arm that
 *           says whether the entitlement mechanism does any work when the
 *           information it asks for actually exists.
 *
 * The verdict is not taken as given: it goes through `judge()` exactly as a real
 * run would, so an uncited refutation is downgraded here too.
 */

import { challengeBrief, judge } from "../../core/challenge.ts";
import type { FindingRecord } from "../../core/ontology.ts";
import { CLAIMS, type Claim } from "./claims.ts";
import type { Disposition } from "./score.ts";

export type Arm = "blind" | "spec";

/**
 * The engagement's target model, for the `spec` arm.
 *
 * Written as an operator would write it, not as an answer key: it describes the
 * product's intent for each resource and never mentions a vulnerability. The
 * two access-control claims are separable from this and from nothing else.
 */
export const TARGET_MODEL = `## actors

- Every user may read only their own notes. Notes are private to their owner and there is no
  sharing feature for notes.
- Documents can be shared: an owner may grant another named user read access. A grant makes that
  reader entitled to the document.
- Reports are an internal dashboard. Any authenticated employee may read any report, by design.
- Pages are public marketing content and are meant to be readable by anyone, including anonymous
  visitors.

## invariants

- /internal/metrics is an operations endpoint and must require an operator session.
`;

const CREDENTIALS = `Sessions you hold for this engagement (send as the cookie \`session=<value>\`):
  s-alice   alice, owner of note 1, document 1 and report 1
  s-bob     bob, owner of note 2
  s-carol   carol, a third user unrelated to alice's objects
  s-admin   an operator account
Omit the cookie entirely to test as an anonymous caller.`;

const HTTP_TOOL = {
	type: "function" as const,
	function: {
		name: "http",
		description: "Issue one HTTP request to the target and see the response.",
		parameters: {
			type: "object",
			properties: {
				method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
				path: { type: "string", description: "Path and query, e.g. /api/notes/1?x=1" },
				session: { type: "string", description: "Session cookie value, e.g. s-bob. Omit for an anonymous request." },
			},
			required: ["method", "path"],
		},
	},
};

const CONCLUDE_TOOL = {
	type: "function" as const,
	function: {
		name: "conclude",
		description: "Record the outcome of the challenge. Call this once, when you are done.",
		parameters: {
			type: "object",
			properties: {
				verdict: { type: "string", enum: ["stands", "amended", "refuted", "unresolved"] },
				control: { type: "string", description: "REQUIRED for stands/amended. The control case you ran and exactly what it returned, e.g. 'the same request with no cookie returned 401'. Without it the verdict is not accepted and the finding stays suspected." },
				basis: { type: "array", items: { type: "string" }, description: "REQUIRED for refuted. The concrete grounds: the request and response, or the part of the target model, that makes this not a finding. A refutation with no basis is not accepted." },
				live: { type: "boolean", description: "REQUIRED for refuted. True if the target was reachable and your sessions were valid while you tested. A refutation against a dead target is not accepted." },
				entitlement: { type: "string", description: "REQUIRED to confirm an access-control finding (idor, authz, authn, massassign, exposed-admin). How you established the caller was or was not MEANT to reach the resource. Omit only if you genuinely could not establish it." },
			},
			required: ["verdict"],
		},
	},
};

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

export interface ModelConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

async function chat(cfg: ModelConfig, messages: ChatMessage[], force?: "conclude"): Promise<ChatMessage> {
	const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
		body: JSON.stringify({
			model: cfg.model,
			messages,
			// Once the budget is spent the http tool is withdrawn and the conclusion
			// is required. Without this the first run spent its whole allowance on
			// requests and ended with no verdict on six of ten claims — which scores
			// as "declined to settle" and would have been read as caution rather than
			// as the harness running out of turns. Forcing the call does not bias it:
			// `unresolved` is still one of the four answers.
			tools: force ? [CONCLUDE_TOOL] : [HTTP_TOOL, CONCLUDE_TOOL],
			...(force ? { tool_choice: { type: "function", function: { name: force } } } : {}),
			temperature: 0,
			max_tokens: 1200,
		}),
	});
	if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const body = await res.json() as { choices?: Array<{ message?: ChatMessage }> };
	const msg = body.choices?.[0]?.message;
	if (!msg) throw new Error(`openrouter returned no message: ${JSON.stringify(body).slice(0, 300)}`);
	return msg;
}

/** Execute one model-requested request against the target, and nothing else. */
async function callTarget(base: string, args: { method?: string; path?: string; session?: string }): Promise<string> {
	const path = args.path ?? "/";
	if (!path.startsWith("/")) return "error: path must start with /";
	const headers: Record<string, string> = {};
	if (args.session) headers.cookie = `session=${args.session}`;
	try {
		const res = await fetch(`${base}${path}`, { method: args.method ?? "GET", headers });
		const text = await res.text();
		return [
			`HTTP/1.1 ${res.status}`,
			`content-type: ${res.headers.get("content-type") ?? ""}`,
			"",
			text.slice(0, 600),
		].join("\n");
	} catch (e) {
		return `error: ${(e as Error).message}`;
	}
}

export interface ChallengeRun {
	claim: string;
	disposition: Disposition;
	/**
	 * What the model's own verdict would have settled, with no contract in front
	 * of it. Scored beside `disposition` to isolate what `judge()` contributes:
	 * the difference between the two columns is the burden of proof doing work,
	 * and on the first live pass that difference was two real vulnerabilities the
	 * model tried to refute without citing anything.
	 */
	raw: Disposition;
	verdict?: string;
	requests: number;
	downgraded?: string;
	error?: string;
	transcript: ChatMessage[];
}

/** The model's verdict taken at face value — stands means confirmed, refuted means refuted. */
function rawOf(verdict: string | undefined): Disposition {
	if (verdict === "stands" || verdict === "amended") return "confirmed";
	if (verdict === "refuted") return "refuted";
	return "suspected";
}

const MAX_REQUESTS = 14;
const AT = "2026-09-08T00:00:00Z";

export async function challengeClaim(cfg: ModelConfig, base: string, claim: Claim, arm: Arm): Promise<ChallengeRun> {
	const finding = { v: 1, kind: "finding", createdAt: AT, ...claim.finding } as FindingRecord;
	const messages: ChatMessage[] = [
		{
			role: "system",
			content:
				"You are verifying a security finding on an authorized engagement. Your job is to BREAK the claim, " +
				"not to agree with it. Use the http tool to run whatever requests settle it, then call conclude exactly once.\n\n" +
				CREDENTIALS +
				(arm === "spec" ? `\n\nThe engagement's target model:\n\n${TARGET_MODEL}` : "") +
				`\n\nYou have at most ${MAX_REQUESTS} requests.`,
		},
		{ role: "user", content: challengeBrief(finding) },
	];

	let requests = 0;
	let error: string | undefined;
	let retried = false;
	let lastVerdict: string | undefined;
	const MAX_TURNS = MAX_REQUESTS + 8;

	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const force = requests >= MAX_REQUESTS || turn === MAX_TURNS - 1 ? "conclude" as const : undefined;
		let reply: ChatMessage;
		try {
			reply = await chat(cfg, messages, force);
		} catch (e) {
			error = (e as Error).message;
			break;
		}
		messages.push(reply);
		const calls = reply.tool_calls ?? [];

		// A prose answer is not a verdict. The first run ended this way on three
		// claims and scored them as "declined to settle", which reads as caution
		// and was really the loop giving up. Ask again, with the tool forced.
		if (calls.length === 0) {
			messages.push({
				role: "user",
				content: "Record your outcome by calling conclude. If you could not settle it, verdict=unresolved is a real answer.",
			});
			continue;
		}

		let settled: { outcome: ReturnType<typeof judge>; verdict: string } | undefined;
		for (const call of calls) {
			let args: Record<string, unknown> = {};
			try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { /* keep {} */ }
			if (call.function.name === "conclude") {
				const outcome = judge(finding, {
					verdict: (args.verdict as "stands" | "amended" | "refuted" | "unresolved") ?? "unresolved",
					control: typeof args.control === "string" ? args.control : undefined,
					basis: Array.isArray(args.basis) ? (args.basis as string[]) : undefined,
					live: typeof args.live === "boolean" ? args.live : undefined,
					entitlement: typeof args.entitlement === "string" ? args.entitlement : undefined,
				}, AT);
				settled = { outcome, verdict: String(args.verdict ?? "") };
				break;
			}
			if (call.function.name === "http") {
				requests += 1;
				const out = requests > MAX_REQUESTS
					? "error: request budget exhausted — call conclude with what you have"
					: await callTarget(base, args as { method?: string; path?: string; session?: string });
				messages.push({ role: "tool", tool_call_id: call.id, content: out });
			}
		}

		if (!settled) continue;
		lastVerdict = settled.verdict;

		// A downgrade is fed back exactly as `record` feeds it back in the product —
		// "Recorded as suspected, not refuted: … Re-run it with the missing piece and
		// record the outcome again." Giving the model that turn here is faithful to
		// how the feature behaves, not a thumb on the scale: the same text, the same
		// one chance to supply what was missing.
		if (settled.outcome.downgraded && !retried) {
			retried = true;
			messages.push({
				role: "user",
				content:
					`Recorded as ${settled.outcome.status}, not ${settled.verdict}: ${settled.outcome.downgraded}\n` +
					"The finding is kept either way. Run whatever is still missing and call conclude again.",
			});
			continue;
		}

		return {
			claim: claim.id,
			disposition: settled.outcome.status === "confirmed" || settled.outcome.status === "refuted" ? settled.outcome.status : "suspected",
			raw: rawOf(settled.verdict),
			verdict: settled.verdict,
			requests,
			...(settled.outcome.downgraded ? { downgraded: settled.outcome.downgraded } : {}),
			transcript: messages,
		};
	}
	// No conclusion is not a refutation and not a confirmation.
	return { claim: claim.id, disposition: "suspected", raw: rawOf(lastVerdict), requests, transcript: messages, ...(lastVerdict ? { verdict: lastVerdict } : {}), ...(error ? { error } : {}) };
}

export async function challengeAll(cfg: ModelConfig, base: string, arm: Arm, claims: Claim[] = CLAIMS): Promise<ChallengeRun[]> {
	const out: ChallengeRun[] = [];
	for (const c of claims) out.push(await challengeClaim(cfg, base, c, arm));
	return out;
}
