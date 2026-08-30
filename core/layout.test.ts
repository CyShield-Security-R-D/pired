import { describe, expect, it } from "vitest";
import { BANNER_KEEP, BANNER_MIN, bannerColumns, RAIL_FLOOR, RAIL_MAX, RAIL_MIN, railColumns } from "./layout.ts";

const both = (cols: number): { rail: number; banner: number } => {
	const rail = railColumns(cols);
	return { rail, banner: bannerColumns(cols, rail) };
};

describe("how the banner and the rail share a terminal", () => {
	it("keeps the layout it was designed at — 56 columns of rail on an 85-column terminal", () => {
		expect(both(85)).toEqual({ rail: 56, banner: 27 });
	});

	it("grows the rail with the screen, so a 2k terminal stops truncating every title", () => {
		expect(railColumns(175)).toBeGreaterThan(RAIL_MIN);
		expect(railColumns(120)).toBeLessThan(railColumns(175));
	});

	it("stops growing: a side panel that keeps growing is not a side panel", () => {
		expect(railColumns(400)).toBe(RAIL_MAX);
	});

	it("yields on a small screen rather than painting over the banner", () => {
		// At a fixed 56 a 70-column terminal left the banner twelve columns, under
		// BANNER_MIN — so the banner took the full width and the two blocks were
		// drawn on top of one another.
		const { rail, banner } = both(70);
		expect(rail).toBeLessThan(RAIL_MIN);
		expect(banner).toBeGreaterThanOrEqual(BANNER_MIN);
		expect(rail + banner + 2).toBeLessThanOrEqual(70);
	});

	it("never squeezes the rail past the point of being readable", () => {
		expect(railColumns(30)).toBe(RAIL_FLOOR);
	});

	it("leaves room for the wordmark at every width that can hold both", () => {
		for (let cols = 44; cols <= 400; cols++) {
			const { rail, banner } = both(cols);
			if (banner === cols) continue; // the overlap fallback, below BANNER_MIN
			expect(rail + banner + 2, `at ${cols} columns`).toBeLessThanOrEqual(cols);
			expect(banner, `at ${cols} columns`).toBeGreaterThanOrEqual(Math.min(BANNER_KEEP - 2, BANNER_MIN));
		}
	});

	it("hands the width to anyone who names one — a setting that is second-guessed is not a setting", () => {
		expect(railColumns(175, 40)).toBe(40);
		expect(railColumns(60, 96)).toBe(96);
	});

	it("ignores an override that is not a width", () => {
		expect(railColumns(175, Number.NaN)).toBe(railColumns(175));
		expect(railColumns(175, 0)).toBe(railColumns(175));
	});
});
