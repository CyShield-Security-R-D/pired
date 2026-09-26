import { describe, expect, it } from "vitest";
import { deriveAreas, dirOf, MAX_AREAS, normalizePath, renderAreas, renderAreasLine, UNPLACED } from "./areas.ts";
import type { CoverageCell, CoverageStatus, FindingRecord, InventoryRecord } from "./ontology.ts";

// Synthetic trees only. The grouping rule is fixed here, on layouts written for
// it, and never on a corpus repository's.

const T = "2026-01-01T00:00:00.000Z";

function endpoint(id: string, path: string, extra: Record<string, unknown> = {}): InventoryRecord {
	return { v: 1, id, kind: "endpoint", createdAt: T, host: "", method: "GET", path, ...extra } as InventoryRecord;
}

function host(id: string, value: string): InventoryRecord {
	return { v: 1, id, kind: "host", createdAt: T, value } as InventoryRecord;
}

function param(id: string, name: string, extra: Record<string, unknown> = {}): InventoryRecord {
	return { v: 1, id, kind: "param", createdAt: T, name, ...extra } as InventoryRecord;
}

function cells(element: string, ...statuses: CoverageStatus[]): CoverageCell[] {
	return statuses.map((status, i) => ({ element, class: `c${i}`, status }));
}

function finding(id: string, target: string, locations?: string[]): FindingRecord {
	return { v: 1, id, kind: "finding", createdAt: T, title: id, severity: "high", target, status: "suspected", ...(locations ? { locations } : {}) } as FindingRecord;
}

const SURFACE = ["endpoint", "host"] as const;

describe("normalizePath", () => {
	it("spells a file the way a directory listing does, whatever form the model wrote it in", () => {
		expect(normalizePath("./src/routes/users.ts:42")).toBe("src/routes/users.ts");
		expect(normalizePath("src\\admin\\panel.py:10-30")).toBe("src/admin/panel.py");
		expect(normalizePath("/work/app/src//lib/x.go", "/work/app/")).toBe("src/lib/x.go");
		expect(normalizePath("/elsewhere/x.go", "/work/app")).toBe("elsewhere/x.go");
		expect(dirOf("main.go")).toBe(".");
		expect(dirOf("src/a/b.ts")).toBe("src/a");
	});
});

describe("deriveAreas", () => {
	it("groups surface into areas by file directory, with a status from its cells", () => {
		const inventory = [
			endpoint("e1", "/login", { file: "src/auth/login.ts" }),
			endpoint("e2", "/logout", { file: "src/auth/logout.ts:12" }),
			endpoint("e3", "/items", { file: "src/items/list.ts" }),
			endpoint("e4", "/admin", { file: "src/admin/index.ts" }),
			endpoint("e5", "/health", { file: "src/ops/health.ts" }),
		];
		const view = deriveAreas({
			inventory,
			surfaceKinds: [...SURFACE],
			cells: [
				...cells("e1", "clear", "vulnerable", "n/a"),
				...cells("e2", "clear", "clear"),
				...cells("e3", "clear", "not-tested"),
				...cells("e4", "not-tested", "not-tested"),
				...cells("e5", "blocked", "clear"),
			],
			findings: [finding("f1", "e1"), finding("f2", "src/items/list.ts", ["src/items/list.ts:9"])],
		});
		expect(view.areas.map((a) => [a.key, a.status, a.elements, a.findings])).toEqual([
			["src/admin", "untested", 1, 0],
			["src/auth", "settled", 2, 1],
			["src/items", "in progress", 1, 1],
			["src/ops", "blocked", 1, 0],
		]);
		// n/a is not askable: it neither settles nor holds an area open.
		expect(view.areas[1]?.cells).toEqual({ askable: 4, settled: 4, testing: 0, blocked: 0, untested: 0 });
		expect(view.depth).toBeUndefined();
	});

	it("places surface with no file by its host, and a param with no file where its endpoint lives", () => {
		const view = deriveAreas({
			inventory: [
				host("h1", "api.acme.test"),
				endpoint("e1", "/v1/users", { host: "h1" }),
				endpoint("e2", "/v1/orders", { host: "shop.acme.test" }),
				endpoint("e3", "/orphan"),
				endpoint("e4", "/upload", { file: "web/upload.php" }),
				param("p1", "file", { endpoint: "e4" }),
				param("p2", "q"),
			],
			surfaceKinds: ["endpoint", "host", "param"],
			cells: [...cells("e1", "testing"), ...cells("e4", "not-tested"), ...cells("p1", "clear")],
			findings: [],
		});
		expect(view.areas.map((a) => [a.by, a.key, a.elements, a.status])).toEqual([
			["directory", "web", 2, "in progress"],
			["host", "api.acme.test", 2, "in progress"],
			["host", "shop.acme.test", 1, "untested"],
			["none", UNPLACED, 2, "untested"],
		]);
	});

	it("lists a source directory with no surface as unmapped, naming only the outermost of a run", () => {
		const view = deriveAreas({
			inventory: [endpoint("e1", "/a", { file: "/repo/src/routes/a.ts" })],
			surfaceKinds: [...SURFACE],
			cells: [],
			findings: [],
			root: "/repo",
			dirs: ["src", "src/routes", "src/routes/sub", "src/admin", "src/admin/views", "scripts", "./docs/"],
		});
		// src holds mapped surface below it; src/routes is mapped; its empty
		// subdirectory is not. src/admin/views is said by src/admin.
		expect(view.unmapped).toEqual(["docs", "scripts", "src/admin", "src/routes/sub"]);
		expect(deriveAreas({ inventory: [], surfaceKinds: [...SURFACE], cells: [], findings: [] }).unmapped).toEqual([]);
	});

	it("cuts directories to a shallower depth, deterministically, when there are more than the cap", () => {
		// 3 top-level packages x 10 modules each = 30 leaf directories.
		const inventory: InventoryRecord[] = [];
		for (const pkg of ["pkg/api", "pkg/core", "pkg/store"]) {
			for (let m = 0; m < 10; m++) inventory.push(endpoint(`${pkg}-${m}`, `/${m}`, { file: `${pkg}/m${m}/handler.go` }));
		}
		const view = deriveAreas({ inventory, surfaceKinds: [...SURFACE], cells: [], findings: [finding("f1", "pkg/core/m3/handler.go:5")] });
		expect(view.depth).toBe(2);
		expect(view.areas.map((a) => [a.key, a.elements, a.findings])).toEqual([["pkg/api", 10, 0], ["pkg/core", 10, 1], ["pkg/store", 10, 0]]);
		// The same input in another order groups the same way.
		const again = deriveAreas({ inventory: [...inventory].reverse(), surfaceKinds: [...SURFACE], cells: [], findings: [] });
		expect(again.areas.map((a) => a.key)).toEqual(view.areas.map((a) => a.key));
	});

	it("falls back to the top level when even that exceeds the cap", () => {
		const inventory = Array.from({ length: MAX_AREAS + 5 }, (_, i) => endpoint(`e${i}`, `/${i}`, { file: `d${String(i).padStart(2, "0")}/x/y.ts` }));
		const view = deriveAreas({ inventory, surfaceKinds: [...SURFACE], cells: [], findings: [] });
		expect(view.depth).toBe(1);
		expect(view.areas).toHaveLength(MAX_AREAS + 5);
	});
});

describe("renderAreasLine", () => {
	it("says nothing before any surface is recorded, when every directory would read as unmapped", () => {
		expect(renderAreasLine(deriveAreas({ inventory: [], surfaceKinds: [...SURFACE], cells: [], findings: [], dirs: ["src", "lib"] }))).toBe("");
	});

	it("bounds the areas line and states what was omitted", () => {
		const inventory = Array.from({ length: 12 }, (_, i) => endpoint(`e${i}`, `/${i}`, { file: `mod${String(i).padStart(2, "0")}/h.ts` }));
		const view = deriveAreas({
			inventory, surfaceKinds: [...SURFACE], cells: cells("e0", "clear"), findings: [finding("f1", "e1")],
			dirs: ["zz1", "zz2", "zz3", "zz4"],
		});
		const line = renderAreasLine(view, 3);
		expect(line).toBe(
			"Areas: 12 from the recorded surface, 1 settled. " +
			"Not settled: mod01 (untested, 1 finding), mod02 (untested), mod03 (untested) (+8 more). " +
			"Source directories with no recorded surface: zz1, zz2, zz3 (+1 more).",
		);
	});

	it("lists every area in full for the settle reply, with the cut depth and the unmapped directories", () => {
		const inventory = Array.from({ length: 22 }, (_, i) => endpoint(`e${i}`, `/${i}`, { file: `a${i % 2}/b${i}/h.ts` }));
		const view = deriveAreas({ inventory, surfaceKinds: [...SURFACE], cells: cells("e0", "clear", "not-tested"), findings: [], dirs: ["a0", "a1", "vendor"] });
		const lines = renderAreas(view);
		expect(lines).toEqual([
			"  a0 — in progress, 1/2 cells settled",
			"  a1 — untested",
			`  (directories grouped at depth 1 to stay near ${MAX_AREAS} areas)`,
			"  unmapped — no recorded surface: vendor",
		]);
		expect(renderAreas(view, 1)).toContain("  (+1 more)");
		expect(renderAreas(deriveAreas({ inventory: [], surfaceKinds: [...SURFACE], cells: [], findings: [] }))).toEqual([]);
	});
});
