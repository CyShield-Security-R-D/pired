import { describe, expect, it } from "vitest";
import { dismissHint, renderFindingDetail, renderPanel, scrollFramed, type PanelData, type PanelMode, type PanelTone } from "./panel.ts";

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
		// Its own line under the name, so a long type cannot crowd the engagement.
		expect(render("state").join("\n")).toContain("review · source audit");
	});

	it("reports coverage against askable cells with a proportional bar", () => {
		expect(render("state").find((l) => l.includes("42%"))).toBeDefined();
		expect(render("state").join("\n")).toContain("42 of 100 cases");
		expect(render("state").join("\n")).toContain("58 gaps");
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

describe("framed panel", () => {
	const framed = (w = 54, max = 40): string[] =>
		renderPanel({ mode: "state", data, width: w, maxLines: max, ink, measure, truncate, frame: true });

	it("draws a closed box", () => {
		const l = framed();
		expect(l[0]?.startsWith("╭")).toBe(true);
		expect(l[0]?.endsWith("╮")).toBe(true);
		expect(l.at(-1)?.startsWith("╰")).toBe(true);
		expect(l.at(-1)?.endsWith("╯")).toBe(true);
	});

	it("makes every line exactly the panel width — a ragged edge reads as a bug", () => {
		for (const w of [30, 40, 54, 80]) {
			for (const line of framed(w)) expect(line.length).toBe(w);
		}
	});

	it("joins section rules to the border instead of notching them", () => {
		const rule = framed().find((l) => l.includes("coverage"));
		expect(rule?.startsWith("├")).toBe(true);
		expect(rule?.endsWith("┤")).toBe(true);
	});

	it("puts the engagement name in the top edge and does not repeat it inside", () => {
		const l = framed();
		expect(l[0]).toContain("acme");
		expect(l.slice(1, -1).filter((x) => x.includes("acme"))).toHaveLength(0);
	});

	it("respects the line budget including the border", () => {
		for (const max of [4, 8, 16, 40]) expect(framed(54, max).length).toBeLessThanOrEqual(max);
	});

	it("drops the frame rather than mangling it when too narrow", () => {
		const l = renderPanel({ mode: "state", data, width: 20, maxLines: 20, ink, measure, truncate, frame: true });
		expect(l.every((x) => !x.startsWith("╭"))).toBe(true);
	});
});

describe("dismiss hint", () => {
	const hinted = (w = 54, max = 40, frame = true): string[] =>
		renderPanel({ mode: "state", data, width: w, maxLines: max, ink, measure, truncate, frame, hint: "alt+p to hide" });

	it("shows how to dismiss a panel the operator did not ask for", () => {
		expect(hinted().some((l) => l.includes("alt+p to hide"))).toBe(true);
	});

	it("sits on the last content row, right-aligned", () => {
		const l = hinted();
		expect(l.at(-2)).toContain("alt+p to hide");
		expect(l.at(-2)?.trimEnd().endsWith("│")).toBe(true);
	});

	it("survives a full panel — the hint matters most when the panel is in the way", () => {
		for (const max of [6, 8, 12]) {
			expect(hinted(54, max).some((l) => l.includes("alt+p to hide"))).toBe(true);
		}
	});

	it("still fits the width and the line budget", () => {
		for (const w of [30, 40, 54, 80]) {
			for (const line of hinted(w)) expect(line.length).toBe(w);
		}
		for (const max of [6, 8, 16, 40]) expect(hinted(54, max).length).toBeLessThanOrEqual(max);
	});

	it("is dropped, not squeezed, when there is no room for content beside it", () => {
		expect(hinted(54, 4).some((l) => l.includes("alt+p"))).toBe(false);
	});
});

describe("dismissHint", () => {
	it("names the shortcut where the terminal sends Meta", () => {
		expect(dismissHint("linux")).toBe("alt+m expand · alt+p hide");
	});

	it("names the commands on macOS, where Option+P types π instead", () => {
		expect(dismissHint("darwin")).toBe("/maximize expand · /panel hide");
	});

	it("never suggests a key the reader cannot press", () => {
		expect(dismissHint("darwin")).not.toContain("alt+");
		expect(dismissHint("darwin", 56)).not.toContain("alt+");
	});

	it("advertises expanding, not only the way out", () => {
		// Hiding is discoverable by trying to get rid of the thing. A scrollable
		// panel is not discoverable at all — a feature nothing names is a feature
		// nobody has.
		expect(dismissHint("linux")).toContain("expand");
	});

	it("falls back to the way out when the rail is too narrow for both", () => {
		expect(dismissHint("linux", 20)).toBe("alt+p to hide");
		expect(dismissHint("darwin", 20)).toBe("/panel to hide");
	});
});


describe("the frame survives a tight budget", () => {
	it("never returns more lines than maxLines, at any budget", () => {
		// The rail asked renderPanel for 60 lines while its overlay could show ~20.
		// The panel laid out everything, pi clipped the overflow, and what got
		// clipped was the end: the closing frame and the dismiss hint.
		for (const max of [6, 8, 12, 20, 30]) {
			const lines = renderPanel({
				mode: "state", data, width: 56, maxLines: max, hint: "alt+p to hide",
				ink, measure, truncate, frame: true,
			});
			expect(lines.length).toBeLessThanOrEqual(max);
		}
	});

	it("keeps both frame edges and the hint rather than dropping them last", () => {
		const lines = renderPanel({
			mode: "state", data, width: 56, maxLines: 10, hint: "alt+p to hide",
			ink, measure, truncate, frame: true,
		});
		expect(lines[0]).toContain("╭");
		expect(lines.at(-1)).toContain("╰");
		expect(lines.join("\n")).toContain("alt+p to hide");
	});
});

describe("scrollFramed", () => {
	const framed = (n: number): string[] => ["╭top╮", ...Array.from({ length: n }, (_, i) => `row${i}`), "╰bot╯"];

	it("returns content untouched when it already fits", () => {
		const r = scrollFramed(framed(3), 0, 10);
		expect(r.lines).toHaveLength(5);
		expect(r.below).toBe(0);
	});

	it("keeps both frame edges pinned while the body moves", () => {
		const r = scrollFramed(framed(20), 5, 10);
		expect(r.lines[0]).toBe("╭top╮");
		expect(r.lines.at(-1)).toBe("╰bot╯");
		expect(r.lines).toHaveLength(10);
		expect(r.lines[1]).toBe("row5");
	});

	it("clamps an overscrolled offset instead of emptying the frame", () => {
		// The caller's offset and the content length change independently, so a
		// held-down arrow must not be able to scroll past the end.
		const r = scrollFramed(framed(20), 9999, 10);
		expect(r.lines).toHaveLength(10);
		expect(r.below).toBe(0);
		expect(r.scroll).toBe(12); // 20 body rows, 8 visible
		expect(r.lines.at(-2)).toBe("row19");
	});

	it("clamps a negative offset to the top", () => {
		expect(scrollFramed(framed(20), -5, 10).scroll).toBe(0);
	});

	it("reports how much is out of view on each side", () => {
		const r = scrollFramed(framed(20), 4, 10);
		expect(r.above).toBe(4);
		expect(r.below).toBe(20 - (4 + 8));
	});

	it("degrades rather than throwing at absurd heights", () => {
		expect(scrollFramed(framed(20), 0, 0).lines).toEqual([]);
		expect(scrollFramed(framed(20), 0, 2).lines).toHaveLength(2);
	});
});

describe("expanded", () => {
	const many: PanelData = {
		...data,
		recentFindings: Array.from({ length: 30 }, (_, i) => ({ severity: "high", title: `finding ${i}` })),
		openBlockers: Array.from({ length: 8 }, (_, i) => ({ question: `blocker ${i}` })),
	};
	const run = (expanded: boolean): string =>
		renderPanel({ mode: "state", data: many, width: 70, maxLines: 400, expanded, ink, measure, truncate }).join("\n");

	it("shows three findings restored, and all of them expanded", () => {
		// Maximizing gave the panel room for forty and it kept showing three, so
		// nothing scrolled and the extra height looked like a rendering bug.
		expect(run(false)).toContain("finding 2");
		expect(run(false)).not.toContain("finding 9");
		expect(run(true)).toContain("finding 29");
	});

	it("drops the '+N more' elision when everything is shown", () => {
		expect(run(false)).toContain("more");
		expect(run(true)).not.toContain("+5 more");
	});

	it("produces enough lines to actually scroll", () => {
		const lines = renderPanel({ mode: "state", data: many, width: 70, maxLines: 400, expanded: true, ink, measure, truncate });
		expect(lines.length).toBeGreaterThan(30);
	});
});

describe("a finding, read in the panel", () => {
	// Tags each run with the tone it was asked for, so a test can assert contrast
	// without knowing what colour a theme resolves that tone to.
	const toned = (t: PanelTone, x: string): string => `<${t}>${x}</${t}>`;
	const detail = (extra: Partial<PanelData["recentFindings"][number]> = {}): string[] =>
		renderFindingDetail({
			finding: {
				severity: "high",
				title: "JWT none-algorithm bypass",
				cwe: "CWE-347",
				status: "open",
				description: "The verifier accepts alg=none, so any unsigned token is trusted.",
				...extra,
			},
			engagement: "acme",
			width: 60,
			maxLines: 40,
			ink: toned,
			measure,
			truncate,
		});

	it("renders the description as prose, not as scaffolding", () => {
		const out = detail().join("\n");
		// It read at `dim` — the darkest ink on the panel — for the one thing the
		// detail view exists to show.
		expect(out).toContain("<body>The verifier accepts alg=none,");
		expect(out).not.toContain("<muted>The verifier accepts alg=none,");
	});

	it("keeps the key column quiet so the values carry", () => {
		const out = detail({ target: "POST /api/session" }).join("\n");
		// Key dim, value readable: both at `dim` is a field that looks empty.
		expect(out).toMatch(/<muted>cwe\s*<\/muted><body>CWE-347/);
		expect(out).toMatch(/<muted>target\s*<\/muted><body>POST \/api\/session/);
	});

	it("still spends the severity colour on severity", () => {
		expect(detail().join("\n")).toContain("<bad>high");
		expect(detail({ severity: "info" }).join("\n")).toContain("<muted>info");
	});
});

describe("a rail that grew with the terminal", () => {
	// The rail is no longer a fixed 56 columns, so anything inside it that was
	// laid out against the full width now stretches with the screen.
	const wide = (width: number): string[] =>
		renderPanel({ mode: "state", data, width, maxLines: 60, ink, measure, truncate });

	it("keeps a label and its count in the same measure", () => {
		// At 120 columns the surface table put "endpoint" at one edge and its count
		// at the other, and asked the eye to carry the association across.
		const row = wide(120).find((l) => l.includes("endpoint")) as string;
		expect(row.trimEnd().length).toBeLessThanOrEqual(46);
	});

	it("does the same for the hypotheses table", () => {
		const row = wide(120).find((l) => l.includes("refuted")) as string;
		expect(row.trimEnd().length).toBeLessThanOrEqual(46);
	});

	it("still spends the whole width on the things that are prose", () => {
		// A finding title is not a table: it takes every column it can get, which is
		// the entire point of a rail that grows with the screen.
		const long = { ...data, recentFindings: [{ severity: "high", title: "Q".repeat(200) }] };
		const title = (width: number): number => (renderPanel({
			mode: "state", data: long, width, maxLines: 60, ink, measure, truncate,
		}).find((l) => l.includes("▸")) as string).length;
		expect(title(120)).toBeGreaterThan(title(56));
	});
});

describe("density", () => {
	const framed = (extra: Partial<PanelData> = {}): string[] => renderPanel({
		mode: "state", data: { ...data, ...extra }, width: 56, maxLines: 60,
		frame: true, hint: "alt+m expand · alt+p hide", ink, measure, truncate,
	});

	it("puts nothing above a section rule — the rule is the separator", () => {
		// A blank line over a rule separates a separator, and there were five of
		// them in a panel whose whole job is to be read at a glance.
		const lines = framed();
		for (const [i, l] of lines.entries()) {
			if (!/^├/.test(l)) continue;
			expect(lines[i - 1]?.trim().replace(/[│]/g, ""), `above ${l.slice(0, 20)}`).not.toBe("");
		}
	});

	it("spends its rows on content, not on air", () => {
		// Every blank row inside the frame is a finding that did not fit.
		const blank = framed().filter((l) => l.replace(/[│ ]/g, "") === "").length;
		expect(blank).toBeLessThanOrEqual(1);
	});

	it("still spreads a surface across two columns once there is one to spread", () => {
		const wide = framed({ surface: { endpoint: 12, host: 3, param: 40, header: 2, cookie: 1 } });
		const row = wide.find((l) => l.includes("endpoint")) as string;
		expect(row).toContain("host");
	});
});

describe("rows a compact panel does not spend", () => {
	const framed = (width: number, hint?: string): string[] => renderPanel({
		mode: "state", data, width, maxLines: 60, frame: true,
		...(hint === undefined ? {} : { hint }), ink, measure, truncate,
	});

	it("carries the engagement type in the border, not in a row of its own", () => {
		const lines = framed(56);
		expect(lines[0]).toContain("review · source audit");
		expect(lines.slice(1).join("\n")).not.toContain("review · source audit");
	});

	it("still spells both out when there is no border to put them in", () => {
		const bare = renderPanel({ mode: "state", data, width: 56, maxLines: 60, ink, measure, truncate });
		expect(bare.join("\n")).toContain("acme");
		expect(bare.join("\n")).toContain("review · source audit");
	});

	it("puts the coverage bar and its counts on one row when they fit", () => {
		const row = framed(56).find((l) => l.includes("%")) as string;
		expect(row).toContain("cases");
	});

	it("splits them again when the panel is too narrow to share", () => {
		const lines = framed(34);
		const bar = lines.find((l) => l.includes("%")) as string;
		expect(bar).not.toContain("cases");
		expect(lines.join("\n")).toContain("cases");
	});

	it("shares the last row between the evidence count and the dismiss hint", () => {
		const last = framed(56, "alt+m expand · alt+p hide").at(-2) as string;
		expect(last).toContain("evidence");
		expect(last).toContain("alt+p hide");
	});

	it("gives the count its own row rather than dropping it when narrow", () => {
		const lines = framed(30, "alt+m expand · alt+p hide");
		expect(lines.join("\n")).toContain("evidence");
		expect(lines.at(-2)).toContain("alt+p hide");
	});
});

/**
 * The ledger held 120 confirmed cells and 0 findings, and this panel said
 * "none recorded" — which is true of a review that found nothing and of one
 * whose whole result is still sitting in the hypotheses ledger. ADR-004.
 */
describe("confirmed work that has not been written up", () => {
	const owed = (over: Partial<PanelData> = {}): string =>
		renderPanel({
			mode: "state", width: 100, maxLines: 20, ink, measure, truncate,
			data: { ...data, ...over },
		}).join("\n");

	it("says so, even while the findings tally is empty", () => {
		const out = owed({
			unwritten: 3,
			findings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
			recentFindings: [],
		});
		expect(out).toContain("3 confirmed, not written up");
		// The old reading is still there, and is exactly why the line above is.
		expect(out).toContain("none recorded");
	});

	it("keeps saying so when findings exist, since the two are different questions", () => {
		expect(owed({ unwritten: 2 })).toContain("2 confirmed, not written up");
	});

	it("stays quiet when nothing is owed", () => {
		expect(owed()).not.toContain("not written up");
		expect(owed({ unwritten: 0 })).not.toContain("not written up");
	});
});

