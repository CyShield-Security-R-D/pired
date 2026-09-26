import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSourceDirs } from "./source-dirs.ts";

// A synthetic tree, written here; never a corpus layout.
let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function tree(dirs: string[], files: string[] = []): string {
	root = mkdtempSync(join(tmpdir(), "pired-dirs-"));
	for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
	for (const f of files) writeFileSync(join(root, f), "x");
	return root;
}

describe("listSourceDirs", () => {
	it("lists directories only, relative and sorted, skipping hidden, dependency, build and runtime-state directories", async () => {
		const r = tree(["src/api/v1", "src/web", "lib", ".git/objects", "node_modules/x", "vendor/y", "dist", "tmp", "log", "logs", "storage/app"], ["src/api/a.ts", "README.md"]);
		expect(await listSourceDirs(r)).toEqual(["lib", "src", "src/api", "src/api/v1", "src/web"]);
	});

	it("stops at the depth and count bounds, so a monorepo costs a bounded walk", async () => {
		const r = tree(["a/b/c/d/e", "f/g", "h", "i", "j"]);
		expect(await listSourceDirs(r, { maxDepth: 2 })).toEqual(["a", "a/b", "f", "f/g", "h", "i", "j"]);
		expect(await listSourceDirs(r, { maxDirs: 3 })).toEqual(["a", "f", "h"]);
	});

	it("follows no symlink and reads a missing root as no directories", async () => {
		const r = tree(["real"]);
		symlinkSync(join(r, "real"), join(r, "alias"));
		expect(await listSourceDirs(r)).toEqual(["real"]);
		expect(await listSourceDirs(join(r, "absent"))).toEqual([]);
	});
});
