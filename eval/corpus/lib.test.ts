import { describe, expect, it } from "vitest";
import { deriveScope, scopeClause } from "./lib.ts";

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
