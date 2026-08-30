import { describe, expect, it } from "vitest";
import { renderBanner } from "./banner.ts";
import type { BannerInfo } from "./banner.ts";

const info: BannerInfo = {
	engagement: "airflow-ftxin0", profile: "review", scope: "enforce",
	model: "qwen3.8-27b", surface: 41, coveragePct: 12, findings: 2,
};

const opts = (width: number, over: Partial<BannerInfo> = {}) => ({
	width, info: { ...info, ...over },
	ink: (_t: string, s: string) => s,
	measure: (s: string) => s.length,
	truncate: (s: string, w: number) => (s.length > w ? s.slice(0, w) : s),
});

describe("renderBanner", () => {
	it("never emits a line wider than the terminal", () => {
		for (const w of [28, 40, 52, 64, 80, 120]) {
			for (const l of renderBanner(opts(w))) expect(l.length).toBeLessThanOrEqual(w);
		}
	});

	it("collapses to the mark and the name when there is no room", () => {
		const lines = renderBanner(opts(20));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("p i");
	});

	it("carries engagement, profile, scope and model", () => {
		const text = renderBanner(opts(88)).join("\n");
		expect(text).toContain("airflow-ftxin0");
		expect(text).toContain("review · scope enforce");
		expect(text).toContain("qwen3.8-27b");
	});

	it("omits the recorded row on a fresh engagement", () => {
		// "0 surface · 0% covered" on a new engagement reads as a failed run rather
		// than a starting point.
		const text = renderBanner(opts(88, { surface: 0, coveragePct: 0, findings: 0 })).join("\n");
		expect(text).not.toContain("surface ·");
		expect(text).not.toContain("recorded");
	});

	it("shows recorded work when the engagement already holds some", () => {
		expect(renderBanner(opts(88)).join("\n")).toContain("41 surface · 12% covered · 2 findings");
	});

	it("singularises one finding", () => {
		const text = renderBanner(opts(88, { findings: 1 })).join("\n");
		expect(text).toContain("· 1 finding");
		expect(text).not.toContain("1 findings");
	});

	it("drops the tagline rather than overflowing a narrow terminal", () => {
		const wide = renderBanner(opts(88)).join("\n");
		const narrow = renderBanner(opts(34)).join("\n");
		expect(wide).toContain("security engagement harness");
		expect(narrow).not.toContain("security engagement harness");
	});

	it("lists the commands that open the views", () => {
		const text = renderBanner(opts(88)).join("\n");
		for (const c of ["/surface", "/hypotheses", "/coverage", "/panel"]) expect(text).toContain(c);
	});
});

describe("reserving height for the panel", () => {
	it("pads to minLines so the editor lands below a floating panel", () => {
		const lines = renderBanner({ ...opts(88), minLines: 22 });
		expect(lines).toHaveLength(22);
		expect(lines.at(-1)).toBe("");
	});

	it("never truncates real content to hit minLines", () => {
		const full = renderBanner(opts(88));
		const padded = renderBanner({ ...opts(88), minLines: 2 });
		expect(padded).toEqual(full);
	});

	it("ignores minLines in the tiny layout, which has no room to give", () => {
		expect(renderBanner({ ...opts(20), minLines: 22 })).toHaveLength(1);
	});
});
