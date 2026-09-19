import { describe, expect, it } from "vitest";
import { renderBanner, shortPath } from "./banner.ts";
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
		expect(wide).toContain("security assessment harness");
		expect(narrow).not.toContain("security assessment harness");
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

	it("sits at the top of what it reserves", () => {
		// The rows are the panel's height, and the welcome entry fills them with the
		// coverage matrix. This padding is only the fallback for when there is no
		// matrix to draw — an engagement with no checklist, or a panel turned off.
		const lines = renderBanner({ ...opts(160), minLines: 24 });
		expect(lines.length).toBe(24);
		const filled = lines.map((l, i) => [l, i] as const).filter(([l]) => l.trim());
		expect(filled[0]?.[1]).toBeLessThanOrEqual(1);
		expect(lines.at(-1)?.trim()).toBe("");
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

	it("picks the layout by what fits, not by a breakpoint", () => {
		// 42 columns is what a 100-column terminal leaves beside the panel. A fixed
		// breakpoint of 40 chose the labelled layout here and then truncated its own
		// last two rows: the recorded facts and half the command list.
		const text = renderBanner(opts(42)).join("\n");
		expect(text).toContain("41 surface · 2 findings");
		expect(text).toContain("/coverage");
		expect(text).toContain("/panel");
		for (const l of renderBanner(opts(42))) expect(l.length).toBeLessThanOrEqual(42);
	});
});

describe("a wide terminal", () => {
	const widest = (w: number): number => Math.max(...renderBanner(opts(w)).map((l) => l.length));

	it("spans the column it was given, so its edge meets the panel's", () => {
		// Sized to its content the block stopped thirty columns short of the panel,
		// and the two read as unrelated things that happened to share a screen. The
		// rule and the commands now run to the edge of the gutter.
		for (const w of [120, 160, 240]) {
			expect(widest(w), `at ${w} columns`).toBe(w);
		}
	});

	it("stands the facts beside the wordmark instead of under it", () => {
		// Stacked it is thirteen rows of mostly air, with a hole beside the wordmark
		// exactly as wide as the facts want to be.
		const lines = renderBanner(opts(160)).filter((l) => l.trim());
		const first = lines.find((l) => l.includes("█▀█")) as string;
		expect(first).toContain("engagement");
		expect(lines.length).toBeLessThan(renderBanner(opts(72)).filter((l) => l.trim()).length);
	});

	it("pairs the tagline with the commands on the rule's baseline", () => {
		const lines = renderBanner(opts(160));
		const tag = lines.find((l) => l.includes("security assessment harness")) as string;
		// Both edges of the block are the rule's edges, which is what makes the
		// whole thing read as one shape.
		expect(tag).toContain("/panel");
		const rule = lines.find((l) => l.trim().startsWith("─")) as string;
		expect(tag.length).toBe(rule.length);
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
		// Stacked — the layout for a terminal without the columns to stand the
		// facts beside the wordmark.
		const lines = renderBanner(opts(72));
		const tagLine = lines.findIndex((l) => l.includes("security assessment harness"));
		expect(lines[tagLine]).toContain("▀   ▀"); // the art's last row
	});
});

describe("where you are", () => {
	// The engagement name defaults to the directory's basename, so on its own it
	// cannot tell two checkouts of the same repository apart.
	const at = (cwd: string, width = 160): string =>
		renderBanner({ ...opts(width), info: { ...info, cwd } }).join("\n");

	it("names the working directory, with a label when there is room", () => {
		expect(at("~/work/acme/api")).toContain("directory");
		expect(at("~/work/acme/api")).toContain("~/work/acme/api");
	});

	it("keeps the tail of a long path, and says it was cut", () => {
		const long = "~/work/clients/acme-security/engagements/2026/api-gateway/services/auth";
		expect(shortPath(long, 44)).toContain("services/auth");
		expect(shortPath(long, 44).startsWith("…/")).toBe(true);
		expect(shortPath(long, 44).length).toBeLessThanOrEqual(44);
		expect(shortPath("~/short/path", 44)).toBe("~/short/path");
	});

	it("does not let a long path widen the block past its column", () => {
		const long = "~/" + "deep/".repeat(30) + "api";
		for (const line of renderBanner({ ...opts(120), info: { ...info, cwd: long } })) {
			expect(line.length).toBeLessThanOrEqual(120);
		}
	});

	it("keeps the wordmark centred against the facts it stands beside", () => {
		// Five facts against three rows of wordmark left the mark riding high, which
		// reads as a mark that was placed and facts that were poured in after it.
		const lines = renderBanner({ ...opts(160), info: { ...info, cwd: "~/work/acme/api" } });
		const first = lines.findIndex((l) => l.trim());
		expect(lines.findIndex((l) => l.includes("█▀█"))).toBe(first + 1);
		const lastArt = lines.findIndex((l) => l.includes("▀   ▀"));
		expect(lines[lastArt + 1]).toContain("recorded");
	});

	it("drops it where the name already says it", () => {
		// Narrow, every row counts and the path mostly repeats the line above it.
		expect(at("~/work/acme/api", 27)).not.toContain("~/work/acme/api");
	});
});

/**
 * An engagement is keyed on the target directory's basename, so ~/clientA/backend
 * and ~/clientB/backend are one append-only ledger. ADR-005.
 */
describe("an engagement that belongs to another directory", () => {
	const base = {
		engagement: "backend", cwd: "~/clientB/backend", profile: "review", scope: "off",
	};
	const draw = (info: Parameters<typeof renderBanner>[0]["info"], width = 72) =>
		renderBanner({ info, width, ink: (_t, x) => x, measure: (x) => x.length, truncate: (x) => x }).join("\n");

	it("says where the ledger came from when it is not here", () => {
		expect(draw({ ...base, foreignOrigin: "~/clientA/backend" })).toContain("~/clientA/backend");
	});

	it("says nothing at all when the engagement is where it was made", () => {
		// Absence of an origin means unknown — every engagement created before this
		// existed has none — and unknown must not read as mismatched.
		expect(draw(base)).not.toContain("shared with");
	});

	it("keeps the warning even on a terminal too narrow for the directory row", () => {
		// Every other fact is convenience. This one says the ledger being written to
		// belongs to somebody else's engagement.
		const narrow = draw({ ...base, foreignOrigin: "~/clientA/backend" }, 46);
		expect(narrow).toContain("clientA");
	});
});


describe("not saying it three times", () => {
	// The welcome entry draws the coverage matrix under the banner and the rail
	// draws the ledger beside it, so with the panel up the banner's `recorded` row
	// is the third copy of the coverage percentage on one screen and the second of
	// the findings tally.
	const withPanel = (width: number) => ({ ...opts(width), panelVisible: true });

	it("drops the recorded row when the rail is already carrying it", () => {
		const text = renderBanner(withPanel(88)).join("\n");
		expect(text).not.toContain("recorded");
		expect(text).not.toContain("41 surface");
		// Identity is not state: what the banner is for survives.
		expect(text).toContain("airflow-ftxin0");
		expect(text).toContain("review · scope enforce");
	});

	it("keeps it when the panel is off, because nothing else would say it", () => {
		// `pired --no-panel` draws no rail and no coverage box, so the banner is the
		// only thing on screen carrying the numbers.
		expect(renderBanner(opts(88)).join("\n")).toContain("41 surface");
	});

	it("gives the rows it saves to the matrix under it", () => {
		// The welcome entry only draws the matrix when `21 - banner - 1 >= 7`.
		const before = renderBanner(opts(62)).length;
		const after = renderBanner(withPanel(62)).length;
		expect(after).toBeLessThan(before);
		expect(21 - after - 1).toBeGreaterThanOrEqual(7);
	});
});

describe("what decides the layout", () => {
	it("stands the facts beside the wordmark at the width a 120-column terminal leaves", () => {
		// 62 columns. The side-by-side layout needed 62 and had 60 — missed by two,
		// because the directory was cut to a fixed 44 whatever column it landed in —
		// so it fell back to the stacked layout, which is six rows taller, and those
		// six rows were the coverage matrix.
		const lines = renderBanner({ ...opts(62), panelVisible: true });
		const art = lines.findIndex((l) => l.includes("█▀█"));
		expect(lines[art]).toContain("airflow-ftxin0");
	});

	it("cuts a path to the column it lands in, not to a constant", () => {
		const text = renderBanner({
			...opts(62, { cwd: "~/clients/acme/services/api" }), panelVisible: true,
		}).join("\n");
		expect(text).toContain("…/");
		expect(text).toContain("api");
		for (const l of renderBanner({ ...opts(62, { cwd: "~/clients/acme/services/api" }), panelVisible: true })) {
			expect(l.length).toBeLessThanOrEqual(62);
		}
	});

	it("stacks the tagline under the commands rather than re-laying out the block", () => {
		// Together they are 85 columns whatever the facts do. Letting that decide
		// the whole layout is what threw a 62-column banner into the tall one.
		const lines = renderBanner({ ...opts(62), panelVisible: true });
		const tag = lines.findIndex((l) => l.includes("security assessment harness"));
		const cmd = lines.findIndex((l) => l.includes("/surface"));
		expect(tag).toBeGreaterThanOrEqual(0);
		expect(cmd).toBeGreaterThan(tag);
	});

	it("keeps them on one row when the column can hold both", () => {
		const lines = renderBanner({ ...opts(116), panelVisible: true });
		const pair = lines.find((l) => l.includes("security assessment harness"));
		expect(pair).toContain("/panel");
	});
});

describe("the narrow layout defers too", () => {
	it("drops the recorded row at the width a 100-column terminal leaves", () => {
		// The flag reached the labelled layout and stopped there, so the layout with
		// the fewest rows to spare was the one still spending one on a number the
		// rail was already carrying. Found by rendering it rather than by reading it.
		const text = renderBanner({ ...opts(27), panelVisible: true }).join("\n");
		expect(text).not.toContain("41 surface");
		expect(text).toContain("airflow-ftxin0");
	});

	it("still shows it there when the panel is off", () => {
		expect(renderBanner(opts(27)).join("\n")).toContain("41 surface");
	});
});
