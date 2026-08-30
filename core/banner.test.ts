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
		const lines = renderBanner(opts(16));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("pired");
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
		expect(renderBanner({ ...opts(16), minLines: 22 })).toHaveLength(1);
	});
});

describe("sharing the terminal with the panel", () => {
	it("drops the label column when narrow — the value already says it", () => {
		// "engagement" beside "pired" spends eleven of twenty-seven columns
		// explaining what the value says on its own.
		const text = renderBanner(opts(27)).join("\n");
		expect(text).toContain("airflow-ftxin0");
		expect(text).not.toContain("engagement");
		expect(text).not.toContain("profile");
	});

	it("drops coverage when narrow, since the panel renders it alongside", () => {
		const text = renderBanner(opts(27)).join("\n");
		expect(text).toContain("41 surface · 2 findings");
		expect(text).not.toContain("covered");
	});

	it("wraps the commands rather than running past the edge", () => {
		const lines = renderBanner(opts(27));
		for (const l of lines) expect(l.length).toBeLessThanOrEqual(27);
		const cmds = lines.filter((l) => l.includes("/surface") || l.includes("/coverage"));
		expect(cmds.length).toBeGreaterThan(1);
	});

	it("keeps the label column when there is room for it", () => {
		expect(renderBanner(opts(88)).join("\n")).toContain("engagement");
	});
});

describe("the wordmark", () => {
	it("is block art at every width that can hold it", () => {
		for (const w of [27, 40, 88]) {
			expect(renderBanner(opts(w)).join("\n")).toContain("█▀█ █ █▀█ █▀▀ █▀▄");
		}
	});

	it("fits the columns left of a 56-column panel on an 85-column terminal", () => {
		// Full-height block capitals are 34 columns; the space beside the panel is
		// 27, which is why the font is three rows of half blocks rather than six of
		// full ones.
		for (const l of renderBanner(opts(27))) expect(l.length).toBeLessThanOrEqual(27);
	});

	it("sets the tagline against the art's baseline, not its top", () => {
		const lines = renderBanner(opts(88));
		const tagLine = lines.findIndex((l) => l.includes("security engagement harness"));
		expect(lines[tagLine]).toContain("▀   ▀"); // the art's last row
	});
});
