import { describe, expect, it } from "vitest";
import { layoutStatusLine, scribeStatus, type Segment } from "./statusline.ts";

/** Stand-ins for pi-tui's visibleWidth/truncateToWidth: ANSI-blind, ASCII-only. */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const measure = (s: string): number => strip(s).length;
const truncate = (s: string, w: number): string => (measure(s) <= w ? s : strip(s).slice(0, w));

const layout = (left: Segment[], right: Segment[], width: number, separator = " · "): string =>
	layoutStatusLine({ left, right, width, measure, truncate, separator });

describe("layoutStatusLine", () => {
	it("right-aligns the trailing group and pads to exactly the width", () => {
		const line = layout([{ text: "pired" }], [{ text: "main" }], 20);
		expect(measure(line)).toBe(20);
		expect(line).toBe(`pired${" ".repeat(11)}main`);
	});

	it("never exceeds the given width, however long the content", () => {
		const left = [{ text: "pired" }, { text: "a-very-long-engagement-name" }];
		const right = [{ text: "some/enormous-model-id" }, { text: "feature/branch" }];
		for (const width of [1, 5, 13, 27, 40, 79, 80, 120]) {
			expect(measure(layout(left, right, width))).toBeLessThanOrEqual(width);
		}
	});

	it("sheds the lowest-priority segment first", () => {
		const left = [{ text: "pired" }];
		const right = [
			{ text: "model", priority: 3 },
			{ text: "branch", priority: 2 },
			{ text: "/help", priority: 1 },
		];
		expect(layout(left, right, 80)).toContain("/help");
		// 24 cols fits "pired" + gap + "model · branch" but not "/help" as well.
		const tight = layout(left, right, 24);
		expect(tight).not.toContain("/help");
		expect(tight).toContain("branch");
		expect(tight).toContain("model");
		// Narrower still: only the highest-priority survivor remains.
		const tighter = layout(left, right, 14);
		expect(tighter).toContain("model");
		expect(tighter).not.toContain("branch");
	});

	it("re-admits a cheaper segment when a costlier one had to go anyway", () => {
		const left = [{ text: "pired" }];
		const right = [
			{ text: "a-very-long-model-identifier", priority: 3 },
			{ text: "main", priority: 2 },
		];
		// 20 cols cannot hold the model, but there is ample room for "main" — the
		// greedy shed drops it first, so it has to come back.
		const line = layout(left, right, 20);
		expect(line).toContain("main");
		expect(line).not.toContain("a-very-long-model-identifier");
		expect(measure(line)).toBe(20);
	});

	it("keeps mandatory segments even when everything else is gone", () => {
		const line = layout([{ text: "pired" }], [{ text: "dropme", priority: 1 }], 8);
		expect(line).toContain("pired");
		expect(line).not.toContain("dropme");
	});

	it("measures display width, not byte or code-unit length", () => {
		const coloured = "\x1b[31mpired\x1b[39m"; // 5 columns, 15 code units
		const line = layout([{ text: coloured }], [{ text: "main" }], 20);
		expect(measure(line)).toBe(20);
		expect(line.endsWith("main")).toBe(true);
	});

	it("honours the minimum gap between the two groups", () => {
		const line = layoutStatusLine({
			left: [{ text: "left" }],
			right: [{ text: "right" }],
			width: 11, // 4 + 5 = 9, leaving only 2 columns of gap
			measure,
			truncate,
			separator: " · ",
			minGap: 4,
		});
		// Cannot honour a 4-column gap, so it falls back to truncation, not overlap.
		expect(measure(line)).toBeLessThanOrEqual(11);
	});

	it("downshifts a segment to its compact form before dropping it", () => {
		const findings = { text: "C1 H2 M3 L1", compact: "4", priority: 6 };
		const left = [{ text: "pired" }, findings];
		const right = [{ text: "branch", priority: 2 }];

		expect(layout(left, right, 40)).toContain("C1 H2 M3 L1"); // roomy: full form
		const mid = layout(left, right, 14); // too tight for the breakdown, not for "4"
		expect(mid).not.toContain("C1 H2");
		expect(mid).toContain("4");
		expect(layout(left, right, 6)).not.toContain("4"); // no room at all: dropped
	});

	it("shrinks a mandatory segment rather than truncating the line", () => {
		const armed = { text: "pentest·enforce", compact: "ENF" }; // no priority: mandatory
		const line = layout([{ text: "pired" }, armed], [], 12);
		expect(line).toContain("ENF");
		expect(line).toContain("pired");
		expect(measure(line)).toBeLessThanOrEqual(12);
	});

	it("upgrades back to the full form when the space is there", () => {
		const seg = { text: "C1 H2 M3 L1", compact: "4", priority: 6 };
		// Wide enough for everything once the cheap segments are gone.
		const line = layout([{ text: "pired" }, seg], [{ text: "x", priority: 1 }], 30);
		expect(line).toContain("C1 H2 M3 L1");
	});

	it("returns an empty line for a zero or negative width", () => {
		expect(layout([{ text: "pired" }], [], 0)).toBe("");
		expect(layout([{ text: "pired" }], [], -5)).toBe("");
	});

	it("ignores empty segments rather than emitting stray separators", () => {
		const line = layout([{ text: "pired" }, { text: "" }, { text: "cov 40%" }], [], 40);
		expect(line).toBe("pired · cov 40%");
	});
});

describe("saying what the scribe is doing", () => {
	// The scribe costs a model call and is off until asked for, so the line has
	// to carry its state. An operator who assumes their findings are being
	// written to the ledger and is wrong finds out when they run the report.
	it("spells the off state out rather than falling silent", () => {
		expect(scribeStatus("off").text).toContain("off");
		expect(scribeStatus("off").compact).toContain("off");
	});

	it("distinguishes armed from working", () => {
		expect(scribeStatus("on").text).not.toContain("off");
		expect(scribeStatus("running").text).not.toBe(scribeStatus("on").text);
		// The ellipsis is the whole difference at a glance: something is in flight.
		expect(scribeStatus("running").text).toContain("…");
	});

	it("has a compact gear for every state, and it is never longer", () => {
		for (const state of ["off", "on", "running"] as const) {
			const { text, compact } = scribeStatus(state);
			expect(compact.length).toBeLessThanOrEqual(text.length);
			expect(compact.length).toBeGreaterThan(0);
		}
	});

	it("survives a narrow line as the compact form rather than vanishing", () => {
		// Priority puts it below the engagement's own numbers, so what matters is
		// that it downshifts before it drops.
		const scribe = scribeStatus("off");
		const line = layout(
			[{ text: "⦿ engagement" }, { text: scribe.text, compact: scribe.compact, priority: 5 }],
			[],
			22,
		);
		expect(line).toContain("off");
	});
});
