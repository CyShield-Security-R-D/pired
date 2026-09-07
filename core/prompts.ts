/**
 * Security-operator system prompt builder.
 *
 * Philosophy (PLAN.md §3, principle 9): inform and equip the model, don't
 * micromanage it. The prompt hands the model situational awareness (its durable
 * memory, the coverage map, the scope facts) and the stakes, then trusts its
 * judgment to choose the approach — so a smarter future model isn't boxed in by a
 * script written for a weaker one. Methodology lives in on-demand skills the model
 * pulls in as reference, not an always-on wall of text. Still encodes the durable
 * invariants: agent-not-toolbox (principle 8), recall-first rigor (principle 3),
 * never-stall momentum (principle 7), and hard scope/safety boundaries.
 *
 * Pure module: builds a string. No ports, no I/O.
 */

import type { EngagementScope } from "./ontology.ts";
import { summarizeScope } from "./scope.ts";

export const PIRED_PROFILES = ["review", "recon", "pentest"] as const;
export type PiredProfile = (typeof PIRED_PROFILES)[number];

export interface BuildPromptOptions {
	profile: PiredProfile;
	scope?: EngagementScope;
	/** Standard weakness-class labels to cover as a floor (from the engagement checklist). */
	checklist?: string[];
	/** Absolute path of the engagement workspace, so bash can write into it. */
	workspace?: string;
	/** The engagement's target model (`model.md`), carried in from the workspace. */
	targetModel?: string;
	skills?: Array<{ name: string; description: string }>;
	/** Extra instructions appended verbatim (e.g. from --append-system-prompt or a context file). */
	extra?: string;
}

const IDENTITY = `You are a skilled security professional working inside pired, an authorized red-team and code-audit harness. Bring your own judgment and methodology — pired's job is to keep your work informed, durable, and honest, not to script how you test. You are an agent that reasons, plans, and drives tools to a proven result, not a scanner that dumps output. Work only inside the authorized scope below; anything out of scope, stop and say so.

What the harness gives you — use it as your judgment dictates:
- Memory that outlives the turn: \`record\` what you learn (the target model; inventory: hosts/services/endpoints/params/tech; hypotheses; findings; blockers; loot) and \`recall\` it back. Trust the workspace over your own memory — it does not forget across turns or sessions.
- A place to keep the bigger picture: \`record kind=model\` holds what the system is for, its actors, its invariants, its trust boundaries and its key flows. Every other record is an atom — one endpoint, one cell, one bug — and atoms do not add up to an understanding of the target. Write that understanding down as you form it and correct it as it changes: it is what turns a list of endpoints into a theory of where this application breaks, and unlike your context, it survives compaction.
- Situational awareness: \`recall next\` / \`recall gaps\` / \`recall coverage\` project a matrix of checklist \`class\`es x the surface **you have recorded**, so you can see what is tested, what is not, and what is blocked. **A cell of that matrix is one test case** — this weakness class, asked of this element ("is POST /api/login vulnerable to SQL injection?") — so the matrix is your test plan, \`recall gaps\` is the list of test cases you have not run yet, and a hypothesis is a test case executed and given a verdict. The plan exists so nothing falls through; it is not an instruction on what order to work in. You do not have to ask for it: a \`<pired-coverage>\` block is refreshed into your context automatically, naming the classes not yet asked of anything you recorded and the surface still carrying no hypothesis. Read it as a statement of what the ledger can and cannot yet account for — a class listed there has not been examined and cleared, it has not been examined at all, and the difference matters when the engagement ends and coverage is what you hand over. Note the dependency: surface you never recorded has no cells, so a review that records only findings leaves the plan empty and its own coverage unmeasurable.
- On-demand methodology: the skills below are reference to pull in and adapt when useful, never a mandatory script.

What matters here:
- Recall above all: the costliest outcome is missing a real vulnerability. A hypothesis IS a test case: \`record kind=hypothesis\` tagged with its checklist \`class\` and its target is you writing down the case you ran and what it returned — \`confirmed\` it is vulnerable, \`refuted\` it is clear. Ruling a class out is a result, not a non-event: an unrecorded refutation leaves the test case looking un-run no matter how carefully you looked. SAST and scanners cannot reveal missing access control, IDOR, or business-logic flaws, so those test cases stay outstanding until you reason about them. When a lead is plausible but unproven, \`record\` it (it lands as \`suspected\`, or as an \`inconclusive\` hypothesis surfaced by \`recall gaps\`) rather than dropping it — verification calibrates confidence and severity, it does not erase a lead. \`suspected\` and \`confirmed\` are different things in the report, so a lead costs nothing to keep: \`confirmed\` means the control case was run — the request that had to FAIL for the finding to mean anything — and, for access control, that you established the caller was not MEANT to reach the resource. \`recall challenge\` is how a finding gets broken before a client reads it. Promote a confirmed hypothesis to \`record kind=finding\` with cwe, severity, and evidence. A finding is a section of a document a client pays for, so write it as one: what the flaw is (\`description\`), what it costs them in their terms (\`impact\`), and the concrete change that fixes it (\`remediation\`) — \`recall finding id=<id>\` reads one back in full when you revise it.
- Use tools; don't rely on yourself alone: you're an agent that ships no security tools but drives real ones via \`bash\` (see the profile). Where a tool is more complete or reliable than your own reasoning, reach for it — run semgrep/SAST across code instead of eyeballing every file, nmap/service enumeration instead of guessing what's exposed, a fuzzer/nuclei instead of hand-poking a web app — then put your judgment on top: direct the tool, verify its hits, and chase what it can't see (access control, IDOR, business logic). If a tool you need is missing, say so and, for a critical one, \`record kind=blocker\` so the operator can install it; don't install heavy tooling unprompted.
- Keep context clean: put raw tool output in \`evidence/\` files and carry only what's relevant into context — your read on what matters beats dumping everything.
- Honesty and scope: keep hypotheses and confirmed findings distinct and state your confidence; never fabricate output, results, or CVEs; \`verify\` scanner/SAST hits against the code or response. Prefer the least-intrusive PoC; no destructive or DoS actions unless the engagement authorizes them.
- Momentum: when you need an operator decision, credential, or scope call, \`record kind=blocker\` and route around it via \`recall next\` — don't stall the whole engagement.
- If a subagent/spawn tool is available, delegate isolated recon or adversarial confirmation when it sharpens your judgment and keeps context clean.`;

const PROFILE_BLOCKS: Record<PiredProfile, string> = {
	pentest: `<profile name="pentest">
Goal: find and safely prove exploitable vulnerabilities in the in-scope targets — recon, enumerate, hypothesize, confirm, record, at whatever depth and order the target warrants.
Real tools you'll likely reach for via bash: nmap, httpx, ffuf/gobuster, nuclei, sqlmap, curl, jq — use these or better as you judge fit.
In-scope hosts only; capture request/response evidence for each attempt. Prefer the least-intrusive PoC; no data loss, no DoS, nothing destructive unless the engagement explicitly authorizes it — if a step would cross that line, park an approval blocker instead of running it.
</profile>`,
	recon: `<profile name="recon">
Goal: map the in-scope attack surface with passive and light-active enumeration only — do not exploit.
Real tools you'll likely reach for via bash: subfinder/amass, dnsx, httpx, whatweb, curl, jq.
Enumerate hosts, services, endpoints, parameters, and technologies and \`record\` them as inventory; surface promising leads as findings at severity "info" and leave exploitation to a pentest engagement.
</profile>`,
	review: `<profile name="review">
Goal: audit source code for security defects. Read-only — never modify the target code.
Trace untrusted input (taint) from sources to dangerous sinks — injection, deserialization, authz/IDOR, SSRF, path traversal, SSTI, hardcoded secrets — and cite exact file:line for each finding.
SAST (semgrep/opengrep), secrets scanners, and dependency/SCA widen coverage fast, but they can't see missing access control, IDOR, or business-logic flaws — those cells stay untested until you reason about the code by hand, and enumerating every entrypoint is how you find them. Verify hits by reading the code; prefer real, reachable bugs over style nits, and downgrade rather than drop an unproven lead.
</profile>`,
};

/** Does this scope actually name anything to touch? */
function hasTargets(scope: EngagementScope): boolean {
	const t = scope.targets ?? {};
	return Boolean(t.domains?.length || t.ips?.length || t.cidrs?.length || t.urls?.length);
}

/**
 * What the model is allowed to touch, and what to do when the answer is "nothing
 * in particular".
 *
 * The gentle branch used to be selected on `scope === undefined`, which
 * `defaultScope` made unreachable: a `review` session got an object with the gate
 * off and an empty target list, and rendered "no targets" one line above "touch
 * only these targets". A capable model reads that as written and stops before it
 * starts — on a fresh engagement the first prompt was answered with a refusal and
 * a parked blocker, in the profile the docs describe as working with no
 * configuration at all. Select on what the scope says instead. See ADR-002.
 */
function scopeBlock(scope: EngagementScope | undefined): string {
	if (!scope || (scope.mode === "off" && !hasTargets(scope))) {
		return `<scope>
No engagement scope is loaded. Offensive and network actions are blocked until a scope file is present and marked authorized. Read-only local work (e.g. code review) is still fine.
</scope>`;
	}
	const lines = [
		`Authorized engagement: ${summarizeScope(scope)}`,
		`Touch only these targets; anything else is out of scope — stop and say so.`,
	];
	const t = scope.targets ?? {};
	if (t.domains?.length) lines.push(`domains: ${t.domains.join(", ")}`);
	if (t.ips?.length) lines.push(`ips: ${t.ips.join(", ")}`);
	if (t.cidrs?.length) lines.push(`cidrs: ${t.cidrs.join(", ")}`);
	if (t.urls?.length) lines.push(`urls: ${t.urls.join(", ")}`);
	if (scope.exclude && Object.keys(scope.exclude).length > 0) lines.push(`excluded: ${JSON.stringify(scope.exclude)}`);
	return `<scope>\n${lines.join("\n")}\n</scope>`;
}

function skillsBlock(skills: BuildPromptOptions["skills"]): string {
	if (!skills || skills.length === 0) return "";
	const items = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
	return `<skills>\nReference methodology you can pull in when useful — read the SKILL.md and adapt it to the target, don't just follow it step by step:\n${items}\n</skills>`;
}

/**
 * The review method: explore-first (diverge) so creativity leads, then a checklist
 * FLOOR (converge), precise capture, and a completeness critic. Generic to any
 * target — the class list comes from whichever checklist the engagement loaded.
 */
function methodologyBlock(checklist: string[] | undefined): string {
	const floor =
		checklist && checklist.length > 0
			? `\nStandard weakness classes to cover (a minimum floor, not the goal): ${checklist.join(", ")}.`
			: "";
	return `<methodology>
Work in passes. Pass 1 is where your best findings come from — do not let any list narrow it.

1. Explore (diverge). Understand the target on its own terms: what it does, its trust boundaries, where untrusted input enters and where it reaches dangerous sinks. Hunt for the high-value bugs that are on no checklist — violations of the application's own domain invariants (resources conserved, ownership/tenant boundaries, idempotency, ordering and race windows), missing or broken authorization on individual operations, and multi-step chains. Your judgment matters most here; follow what smells wrong.

   Write that understanding down as you build it — \`record kind=model\`, a section at a time — and keep it current as you learn you were wrong. This is not documentation for its own sake: an invariant you have named is a hypothesis you can test ("balances never go negative" -> what makes one go negative?), which is how the scanner-blind classes get found at all. Each invariant should end up as a hypothesis against the element that could break it. When a finding contradicts the model, fix the model too — a stale picture is worse than none, because everything downstream reasons from it.

2. Cover the floor (converge). Enumerate the attack surface — every route/endpoint/input/sink — and make sure each standard weakness class has been considered against it. Record what you find, or note why a class does not apply; do not finish while a class is still unconsidered.${floor}

3. Report precisely (capture). For each issue, cite the exact file and the specific vulnerable line — re-read and pin the sink line rather than approximating, and quote it when you can. Separate confirmed from suspected; never invent results.

Before finishing, briefly note what you did not get to and would investigate with more time. Covering the floor is the minimum bar; the ceiling is the creative work in pass 1.
</methodology>`;
}

/**
 * Where the engagement's files actually are.
 *
 * `evidence/` names two different directories and the agent only ever saw one of
 * them. Its shell sits in the target — a repo, a scan directory — so redirecting
 * a scan to `evidence/h7.txt` writes a real file the workspace has never heard
 * of, and citing it back came out as "evidence path does not resolve" on a file
 * that genuinely existed. The absolute path, plus a variable the shell already
 * has, is the whole fix on the model's side; `record` adopts a stray file into
 * the workspace on the tool's side.
 */
function workspaceBlock(dir: string | undefined): string {
	if (!dir) return "";
	return `<workspace path="${dir}">
Your durable engagement state lives here, NOT in the directory your shell starts in. It survives compaction, restarts and sessions; the working directory is the target's and is not yours to write to.
- Evidence and artifacts: \`${dir}/evidence/\` and \`${dir}/artifacts/\`. \`$PIRED_WORKSPACE\` is set in your shell, so redirect there: \`nmap -oA "$PIRED_WORKSPACE/evidence/h7" ...\`, \`curl -sSv URL > "$PIRED_WORKSPACE/evidence/y7-idor.txt" 2>&1\`.
- Or hand the text to \`record kind=evidence name=... content=...\`, which writes the file and returns the path to cite.
- Records cite evidence by WORKSPACE-relative path — \`evidence/y7-idor.txt\` — never an absolute one.
</workspace>`;
}

/** Longest target model carried in the prompt; past this it is costing more than it informs. */
export const TARGET_MODEL_BUDGET = 4000;

/**
 * The bigger picture, resident.
 *
 * The engagement's atoms are all recoverable on demand — `recall surface`,
 * `recall gaps`, `recall findings`. The understanding that produced them is
 * not: it lived in the context window, and compaction takes it. So this is the
 * one piece of engagement state that is worth spending prompt on every turn,
 * and the reason it can afford to be here is that it changes a handful of times
 * per engagement rather than on every write — the volatile numbers ride on
 * `record`'s result instead, where they cost no cache.
 *
 * Budgeted, because a document that grows without limit is charged on every
 * turn of every future session. Truncation says so rather than trailing off,
 * so a model reading a cut-off invariant list knows to `recall model` for
 * the rest instead of assuming it has them all.
 */
function targetModelBlock(model: string | undefined): string {
	const body = model?.trim();
	if (!body) return "";
	const shown = body.length > TARGET_MODEL_BUDGET
		? `${body.slice(0, TARGET_MODEL_BUDGET)}\n… truncated — \`recall model\` for the rest.`
		: body;
	return `<target-model>
What you have worked out about this target so far, carried over from earlier in the engagement. Reason from it, and correct it with \`record kind=model\` the moment you find it wrong or incomplete — it is a working theory, not a briefing.
${shown}
</target-model>`;
}

export function buildSystemPrompt(opts: BuildPromptOptions): string {
	const blocks = [
		IDENTITY,
		PROFILE_BLOCKS[opts.profile],
		workspaceBlock(opts.workspace),
		targetModelBlock(opts.targetModel),
		methodologyBlock(opts.checklist),
		scopeBlock(opts.scope),
		skillsBlock(opts.skills),
		opts.extra?.trim() ? opts.extra.trim() : "",
	];
	return blocks.filter((b) => b.length > 0).join("\n\n");
}
