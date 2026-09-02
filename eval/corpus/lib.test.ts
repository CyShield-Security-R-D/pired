import { describe, expect, it } from "vitest";
import { deriveScope, scopeClause, mapRangeBack } from "./lib.ts";

/** A truth entry needs only `file` for scope selection; the rest is noise here. */
const at = (file: string) => ({ id: "x", title: "x", severity: "high", file, line: 1 });

const tree = (dirs: Record<string, number>): string[] =>
	Object.entries(dirs).flatMap(([d, n]) => Array.from({ length: n }, (_, i) => `${d}/f${i}.py`));

describe("deriveScope", () => {
	it("uses the whole repo when it already fits under the cap", () => {
		const source = tree({ src: 40 });
		expect(deriveScope(source, [at("src/a.py")], 1200)).toEqual({ dirs: ["."], files: 40, overCap: false });
	});

	it("narrows a repo over the cap to the subtree holding the bug", () => {
		const source = tree({ routers: 500, models: 900, web: 900 });
		const s = deriveScope(source, [at("routers/api/v1/repo.go")], 1200);
		expect(s.dirs).toEqual(["routers"]);
		expect(s.files).toBe(500);
		expect(s.overCap).toBe(false);
	});

	it("keeps every subtree when the fix spans more than one", () => {
		const source = tree({ routers: 400, services: 400, models: 900 });
		const s = deriveScope(source, [at("routers/a.go"), at("services/b.go")], 1200);
		expect(new Set(s.dirs)).toEqual(new Set(["routers", "services"]));
		expect(s.files).toBe(800);
	});

	it("goes deeper only when the shallower subtree is still over the cap", () => {
		const source = tree({ "app/controllers": 300, "app/models": 2000, other: 50 });
		const s = deriveScope(source, [at("app/controllers/users.rb")], 1200);
		expect(s.dirs).toEqual(["app/controllers"]);
		expect(s.files).toBe(300);
	});

	it("never returns the vulnerable file's own path as the scope", () => {
		// Handing over the file is handing over the answer. The scope stops at the
		// containing directory however deep the search goes.
		const source = tree({ "a/b/c/d/e/f/g": 5000 });
		const s = deriveScope(source, [at("a/b/c/d/e/f/g/bug.py")], 10);
		expect(s.dirs).not.toContain("a/b/c/d/e/f/g/bug.py");
		expect(s.dirs.every((d) => !d.endsWith(".py"))).toBe(true);
	});

	it("falls back to the whole repo when the bug sits at the root", () => {
		const source = [...tree({ lib: 3000 }), "main.go"];
		const s = deriveScope(source, [at("main.go")], 1200);
		expect(s.dirs).toEqual(["."]);
		expect(s.overCap).toBe(true);
	});

	it("reports overCap rather than narrowing past the point of usefulness", () => {
		const source = tree({ core: 5000 });
		const s = deriveScope(source, [at("core/x.py")], 100);
		expect(s.overCap).toBe(true);
		expect(s.files).toBeGreaterThan(100);
	});
});

describe("scopeClause", () => {
	it("is empty for an unscoped target, so library prompts are unchanged", () => {
		expect(scopeClause(undefined)).toBe("");
		expect(scopeClause([])).toBe("");
		expect(scopeClause(["."])).toBe("");
	});

	it("names every scoped path", () => {
		const c = scopeClause(["routers", "services"]);
		expect(c).toContain("routers, services");
		expect(c).toContain("Confine");
	});
});

describe("deriveScope widening", () => {
	it("spends the remaining cap on sibling directories", () => {
		// Without widening the scope would be `routers` alone — 300 files against a
		// 1200 cap, which narrows the haystack far below what the budget intends.
		const source = tree({ routers: 300, services: 300, models: 300, web: 2000 });
		const s = deriveScope(source, [at("routers/a.go")], 1200);
		expect(s.dirs).toEqual(["models", "routers", "services"]);
		expect(s.files).toBe(900);
	});

	it("skips a sibling too large to fit rather than stopping", () => {
		const source = tree({ a: 100, big: 5000, c: 100, d: 100 });
		const s = deriveScope(source, [at("a/x.go")], 400);
		expect(s.dirs).toEqual(["a", "c", "d"]);
		expect(s.files).toBe(300);
	});

	it("is deterministic — name order, not discovery order", () => {
		const source = tree({ zeta: 100, alpha: 100, mid: 100, huge: 4000 });
		const a = deriveScope(source, [at("mid/x.go")], 400);
		const b = deriveScope([...source].reverse(), [at("mid/x.go")], 400);
		expect(a.dirs).toEqual(b.dirs);
		expect(a.dirs).toEqual(["alpha", "mid", "zeta"]);
	});
});

describe("deriveScope sibling order", () => {
	it("spends the cap on the largest siblings, not the alphabetically first", () => {
		// Name order reaches repo furniture (.github, docker, scripts) before it
		// reaches the application, and leaves the cap underfilled.
		const source = tree({ base: 100, alpha: 400, zed: 500 });
		const s = deriveScope(source, [at("base/x.go")], 600);
		expect(s.dirs).toEqual(["base", "zed"]);
		expect(s.files).toBe(600);
	});
});

describe("deriveScope loc ceiling", () => {
	const lines = (per: Record<string, number>, source: string[]) =>
		new Map(source.map((f) => [f, per[f.split("/")[0] as string] ?? 0]));

	it("narrows a repo that fits on files but not on lines", () => {
		// mlflow: 1,114 files — inside a 1,200 file cap — and 813k lines, far past
		// what a 128k-token window can carry. Capping files alone admits it.
		const source = tree({ big: 300, small: 300 });
		const l = lines({ big: 2000, small: 50 }, source);
		const s = deriveScope(source, [at("small/x.py")], 1200, { lines: l, locCap: 100_000 });
		expect(s.dirs).toEqual(["small"]);
		expect(s.files).toBe(300);
	});

	it("stops widening when the next sibling would breach the loc ceiling", () => {
		const source = tree({ base: 100, tiny: 100, huge: 100 });
		const l = lines({ base: 100, tiny: 100, huge: 5000 }, source);
		const s = deriveScope(source, [at("base/x.py")], 1200, { lines: l, locCap: 50_000 });
		expect(s.dirs).toEqual(["base", "tiny"]);
	});

	it("is unchanged when no loc ceiling is given", () => {
		const source = tree({ a: 100, b: 100 });
		expect(deriveScope(source, [at("a/x.py")], 1200).dirs).toEqual(["."]);
	});
});

describe("translating a truth range from a later commit back to the target", () => {
	// `git diff <earlier> <later>` at --unified=0. "-" is the earlier file.
	it("leaves a range alone when nothing changed before it", () => {
		expect(mapRangeBack("", [40, 50])).toEqual([40, 50]);
	});

	it("shifts a range back by the lines added above it", () => {
		// 10 lines inserted at line 5 of the later file: line 40 there was 30 before.
		const diff = "@@ -4,0 +5,10 @@\n";
		expect(mapRangeBack(diff, [40, 50])).toEqual([30, 40]);
	});

	it("shifts forward when lines were deleted above it", () => {
		const diff = "@@ -5,10 +4,0 @@\n";
		expect(mapRangeBack(diff, [40, 50])).toEqual([50, 60]);
	});

	it("refuses a range that overlaps a changed hunk", () => {
		// The code there is not the same code, so there is no honest mapping — and
		// a rewritten region means this is not the same vulnerability either.
		const diff = "@@ -40,5 +40,5 @@\n";
		expect(mapRangeBack(diff, [42, 44])).toBeUndefined();
	});

	it("ignores hunks that fall after the range", () => {
		const diff = "@@ -100,4 +100,9 @@\n";
		expect(mapRangeBack(diff, [10, 20])).toEqual([10, 20]);
	});

	it("accumulates several hunks above the range", () => {
		const diff = "@@ -4,0 +5,10 @@\n@@ -20,0 +31,5 @@\n";
		expect(mapRangeBack(diff, [60, 61])).toEqual([45, 46]);
	});

	it("refuses a mapping that would fall off the top of the file", () => {
		const diff = "@@ -0,0 +1,100 @@\n";
		expect(mapRangeBack(diff, [5, 6])).toBeUndefined();
	});
});
