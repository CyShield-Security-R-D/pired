import { describe, expect, it } from "vitest";
import { renderPanel, type PanelData, type PanelMode, type PanelTone } from "./panel.ts";

const ink = (_t: PanelTone, s: string): string => s; // colourless stand-in
const measure = (s: string): number => s.length;
const truncate = (s: string, w: number): string => (s.length <= w ? s : s.slice(0, w));

const data: PanelData = {
	engagement: "acme",
	engagementType: "review · source audit",
	scope: { mode: "enforce", authorized: true, targets: { domains: ["acme.com"] } },
	coveragePct: 42,
	cells: 100,
	settled: 42,
	gaps: 58,
	surface: { endpoint: 12, host: 1 },
	hypotheses: { refuted: 30, confirmed: 4, proposed: 2 },
	findings: { critical: 1, high: 2, medium: 0, low: 0, info: 3 },
	recentFindings: [{ severity: "critical", title: "JWT none-algorithm bypass" }],
	openBlockers: [{ question: "need staging credentials", priority: "high" }],
	evidence: 7,
};

const render = (mode: PanelMode, width = 100, maxLines = 12): string[] =>
	renderPanel({ mode, data, width, maxLines, ink, measure, truncate });

describe("engagement panel", () => {
	it("never exceeds the line budget", () => {
		// The footer shares the terminal with the transcript; overflowing it
		// corrupts the host's layout rather than merely looking wrong.
		for (const max of [0, 1, 3, 5, 12]) {
			expect(render("state", 100, max).length).toBeLessThanOrEqual(max);
		}
	});

	it("never emits a line wider than the panel", () => {
		for (const w of [200, 100, 60, 30, 12]) {
			for (const mode of ["state", "findings", "blockers", "coverage"] as PanelMode[]) {
				for (const line of render(mode, w)) expect(line.length).toBeLessThanOrEqual(w);
			}
		}
	});

	it("surfaces an open blocker in state mode — it is the thing that needs a human", () => {
		expect(render("state").join("\n")).toContain("needs you");
		expect(render("state").join("\n")).toContain("staging credentials");
	});

	it("shows the engagement type, which the manifest does not persist", () => {
		expect(render("state")[0]).toContain("review · source audit");
	});

	it("reports coverage against askable cells with a proportional bar", () => {
		const line = render("state").find((l) => l.includes("42%")) ?? "";
		expect(line).toContain("42/100 cells");
		expect(line).toContain("58 gaps");
	});

	it("says so plainly when nothing is blocked", () => {
		const clear = { ...data, openBlockers: [] };
		const lines = renderPanel({ mode: "blockers", data: clear, width: 80, maxLines: 8, ink, measure, truncate });
		expect(lines.join("\n")).toContain("nothing blocked");
	});

	it("degrades to the header alone rather than dropping the engagement name", () => {
		expect(render("state", 100, 1)).toHaveLength(1);
		expect(render("state", 100, 1)[0]).toContain("acme");
	});
});
