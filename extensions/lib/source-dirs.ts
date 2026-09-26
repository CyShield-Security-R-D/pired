/**
 * A directory-only listing of the source tree, for the areas view (3.2).
 *
 * core/areas.ts names the source directories with no recorded surface as
 * unmapped, and core cannot touch the disk, so the listing is taken here. It
 * lists directories and never opens a file: what it costs is a bounded number
 * of `readdir` calls, once per session, and nothing it returns is file content.
 *
 * Bounded twice, by depth and by count, because a target can be a monorepo with
 * tens of thousands of directories, and the listing only has to be good enough
 * to name the top of an unmapped subtree. Dependency and build output
 * directories are skipped by name: they are not the target's source, and a
 * vendored tree would otherwise read as the largest unmapped area in every
 * review of a project that vendors.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directory names that hold dependencies, build output or runtime state, not the target's own source. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	"node_modules", "bower_components", "vendor", "third_party", "dist", "build", "out", "target", "coverage",
	"__pycache__", "venv", "site-packages", "tmp", "log", "logs", "storage",
]);

export interface ListingOptions {
	/** Deepest level listed; 1 is the root's own subdirectories. */
	maxDepth?: number;
	/** Most directories returned. */
	maxDirs?: number;
}

/**
 * Directories under `root`, relative and slash-separated, breadth first and
 * sorted, skipping hidden and dependency directories and symlinks. A directory
 * that cannot be read is left out rather than failing the listing.
 */
export async function listSourceDirs(root: string, opts: ListingOptions = {}): Promise<string[]> {
	const maxDepth = opts.maxDepth ?? 4;
	const maxDirs = opts.maxDirs ?? 400;
	const out: string[] = [];
	let level = [""];
	for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
		const next: string[] = [];
		for (const rel of level) {
			let entries: Dirent[];
			try {
				entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
			} catch {
				continue;
			}
			const names = entries
				.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_DIRS.has(e.name))
				.map((e) => e.name)
				.sort();
			for (const name of names) {
				if (out.length >= maxDirs) return out.sort();
				const path = rel ? `${rel}/${name}` : name;
				out.push(path);
				next.push(path);
			}
		}
		level = next;
	}
	return out.sort();
}
