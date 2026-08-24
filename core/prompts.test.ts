import { describe, expect, it } from "vitest";
import type { EngagementScope } from "./ontology.ts";
import { buildSystemPrompt } from "./prompts.ts";

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
		for (const profile of ["pentest", "recon", "review"] as const) {
			const p = buildSystemPrompt({ profile });
			expect(p).toMatch(/no engagement scope/i);
			expect(p).toMatch(/blocked/i);
		}
	});
});
