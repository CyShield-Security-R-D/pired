import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import { buildSystemPrompt, PIRED_PROFILES, TARGET_MODEL_BUDGET } from "./prompts.ts";

const scope: EngagementScope = {
	v: 1,
	engagement: "acme-web",
	authorized: true,
	mode: "enforce",
	targets: { domains: ["*.acme.test"] },
};

describe("buildSystemPrompt", () => {
	it("includes identity, rigor, and the agent-not-toolbox stance", () => {
		const p = buildSystemPrompt({ profile: "pentest", scope });
		expect(p).toMatch(/not a scanner|agent/i);
		expect(p).toMatch(/recall/);
		expect(p).toMatch(/record/);
		expect(p).toMatch(/bash/i);
		expect(p).toMatch(/install/i); // dependency-aware escalation
	});

	it("embeds the authorized scope summary and targets", () => {
		const p = buildSystemPrompt({ profile: "pentest", scope });
		expect(p).toContain("acme-web");
		expect(p).toMatch(/authorized/i);
		expect(p).toContain("*.acme.test");
	});

	it("warns and gates when no scope is loaded", () => {
		const p = buildSystemPrompt({ profile: "pentest" });
		expect(p).toMatch(/no engagement scope/i);
		expect(p).toMatch(/blocked/i);
	});

	it("specializes per profile", () => {
		expect(buildSystemPrompt({ profile: "recon", scope })).toMatch(/enumerat|passive/i);
		const review = buildSystemPrompt({ profile: "review", scope });
		expect(review).toMatch(/read-only/i);
		expect(review).toMatch(/file:line/i);
		expect(review).toMatch(/semgrep|opengrep|sast/i);
	});

	it("lists methodology skills when provided", () => {
		const p = buildSystemPrompt({
			profile: "pentest",
			scope,
			skills: [{ name: "web-recon", description: "enumerate a web app" }],
		});
		expect(p).toContain("web-recon");
		expect(p).toContain("enumerate a web app");
	});

	it("drives the explore-first method: diverge (creativity) before the checklist floor", () => {
		const p = buildSystemPrompt({ profile: "review", scope });
		// creativity must lead and not be capped by any list
		expect(p).toMatch(/explore|diverge/i);
		expect(p).toMatch(/domain invariant|no checklist|not let any list/i);
		// floor + precise capture + critic
		expect(p).toMatch(/floor/i);
		expect(p).toMatch(/pin the sink|exact file|specific vulnerable line/i);
		expect(p).toMatch(/did not get to|investigate with more time/i);
	});

	it("injects checklist classes as a coverage floor (generic to whatever is loaded)", () => {
		const p = buildSystemPrompt({ profile: "review", scope, checklist: ["authz", "business-logic", "dependencies (SCA)"] });
		expect(p).toMatch(/minimum floor, not the goal/i);
		expect(p).toContain("authz");
		expect(p).toContain("business-logic");
		expect(p).toContain("dependencies (SCA)");
	});

	it("omits the class list cleanly when no checklist is provided", () => {
		const p = buildSystemPrompt({ profile: "review", scope });
		expect(p).not.toMatch(/Standard weakness classes to cover/);
		expect(p).toMatch(/<methodology>/); // methodology still present
	});

	it("appends extra instructions", () => {
		const p = buildSystemPrompt({ profile: "pentest", scope, extra: "Client contact: ops@acme.test" });
		expect(p).toContain("ops@acme.test");
	});

	it("names the rigor loop: recall next/gaps and hypothesis->finding promotion", () => {
		const p = buildSystemPrompt({ profile: "pentest", scope });
		expect(p).toMatch(/recall\s+next/i);
		expect(p).toMatch(/recall\s+gaps/i);
		expect(p).toMatch(/kind=hypothesis/);
		expect(p).toMatch(/kind=finding/);
		expect(p).toMatch(/promote/i); // confirmed hypothesis -> finding
		expect(p).toMatch(/checklist/i); // coverage awareness
	});

	it("encodes evidence capture, context hygiene, and blockers in the identity", () => {
		const p = buildSystemPrompt({ profile: "recon", scope }); // any profile shares the identity
		expect(p).toMatch(/evidence/i);
		expect(p).toMatch(/kind=blocker/); // park a blocker, don't stall
		expect(p).toMatch(/momentum|route around/i);
	});

	it("demands confidence honesty and forbids fabrication", () => {
		const p = buildSystemPrompt({ profile: "review", scope });
		expect(p).toMatch(/fabricate/i);
		expect(p).toMatch(/CVE/);
		expect(p).toMatch(/verify/i); // verify scanner/SAST hits before recording
	});

	it("pentest names least-intrusive PoC, concrete tools, and forbids destructive actions unless authorized", () => {
		const p = buildSystemPrompt({ profile: "pentest", scope });
		expect(p).toMatch(/least[- ]intrusive/i);
		expect(p).toMatch(/PoC/);
		expect(p).toMatch(/nmap|ffuf|gobuster|sqlmap|nuclei/i); // drives real tools via bash
		expect(p).toMatch(/DoS|destructive|data loss/i);
		expect(p).toMatch(/authorize/i);
	});

	it("recon stays passive/light, does not exploit, and names enumeration tools", () => {
		const p = buildSystemPrompt({ profile: "recon", scope });
		expect(p).toMatch(/passive/i);
		expect(p).toMatch(/do not exploit/i);
		expect(p).toMatch(/subfinder|amass|dnsx|httpx|whatweb/i);
	});

	it("review traces untrusted input (taint) to sinks and cites file:line", () => {
		const p = buildSystemPrompt({ profile: "review", scope });
		expect(p).toMatch(/taint|untrusted input/i);
		expect(p).toMatch(/sink/i);
		expect(p).toMatch(/file:line/i);
	});

	it("still gates offensive work when no scope is loaded (any profile)", () => {
		for (const profile of PIRED_PROFILES) {
			const p = buildSystemPrompt({ profile });
			expect(p).toMatch(/no engagement scope/i);
			expect(p).toMatch(/blocked/i);
		}
	});

	describe("the coverage matrix, in words a tester already has", () => {
		// "Cell" and "gap" are pired's private jargon. The mechanism was explained
		// in them and never bridged to the vocabulary a consultant and a model both
		// have deep priors for — a test plan, a test case, the cases still to run.
		// Naming the equivalence is a stronger instruction than "untested cell",
		// especially for the behaviour the whole mechanism depends on and which the
		// code comments say never happens on its own: recording a refutation.
		it("says a cell is one test case and gaps are the ones not run yet", () => {
			const p = buildSystemPrompt({ profile: "review" });
			expect(p).toMatch(/A cell of that matrix is one test case/);
			expect(p).toMatch(/test plan/);
			expect(p).toMatch(/is the list of test cases you have not run yet/);
		});

		it("says a hypothesis is that test case executed, refutation included", () => {
			const p = buildSystemPrompt({ profile: "review" });
			expect(p).toMatch(/A hypothesis IS a test case/);
			expect(p).toMatch(/Ruling a class out is a result, not a non-event/);
		});
	});

	describe("where the engagement's files are", () => {
		// The agent's shell starts in the target, and `evidence/` means the
		// workspace — two different directories, and it only ever saw one of them.
		// Redirecting a scan to `evidence/h7.txt` wrote a real file the ledger had
		// never heard of, and citing it back read as "path does not resolve".
		it("names the absolute path and the variable the shell already has", () => {
			const p = buildSystemPrompt({ profile: "pentest", workspace: "/home/x/.pired/engagements/acme" });
			expect(p).toContain("/home/x/.pired/engagements/acme/evidence/");
			expect(p).toContain("$PIRED_WORKSPACE");
			expect(p).toMatch(/NOT in the directory your shell starts in/);
			expect(p).toMatch(/WORKSPACE-relative path/);
		});

		it("says nothing at all when there is no workspace yet", () => {
			expect(buildSystemPrompt({ profile: "pentest" })).not.toContain("PIRED_WORKSPACE");
		});
	});
});

describe("target model in the prompt", () => {
	it("is absent when the engagement has none, costing nothing", () => {
		const p = buildSystemPrompt({ profile: "review", scope });
		expect(p).not.toContain("<target-model>");
	});

	it("carries the model into the prompt so a cold session starts knowing it", () => {
		const p = buildSystemPrompt({
			profile: "review", scope,
			targetModel: "## what\nA payments API.\n\n## invariants\nA balance never goes negative.",
		});
		expect(p).toContain("<target-model>");
		expect(p).toContain("A balance never goes negative.");
		expect(p).toMatch(/working theory, not a briefing/);
	});

	it("truncates a runaway model and says so rather than trailing off", () => {
		// A document that grows without limit is charged on every turn of every
		// future session, so the budget is what stops one engagement's notes-sprawl
		// becoming a permanent tax.
		const long = `## what\n${"x".repeat(TARGET_MODEL_BUDGET)}\nTAIL-MARKER`;
		const p = buildSystemPrompt({ profile: "review", scope, targetModel: long });
		expect(p).toContain("truncated");
		expect(p).toContain("recall model");
		expect(p).not.toContain("TAIL-MARKER");
		expect(p.match(/x+/)?.[0].length).toBeLessThanOrEqual(TARGET_MODEL_BUDGET);
	});

	it("treats a blank model as no model", () => {
		const p = buildSystemPrompt({ profile: "review", scope, targetModel: "   \n  " });
		expect(p).not.toContain("<target-model>");
	});

	it("tells the agent to write the model down and to mine invariants for hypotheses", () => {
		const p = buildSystemPrompt({ profile: "review", scope, checklist: ["authz", "sqli"] });
		expect(p).toMatch(/record kind=model/);
		expect(p).toMatch(/invariant/i);
		expect(p).toMatch(/stale picture is worse than none/i);
	});
});
