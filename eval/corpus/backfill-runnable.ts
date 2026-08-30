#!/usr/bin/env -S node --experimental-strip-types
/**
 * Backfill `runnable` on an application manifest built before that field existed.
 *
 * Reads the targets already on disk rather than re-cloning, so a corpus that
 * cost an hour of fetching does not cost another one to gain a field. The rule
 * matches the fetcher's: a compose file at the root or one level down, which is
 * what can actually stand the application up — a compose file inside an
 * integration-test directory cannot.
 *
 *   node eval/corpus/backfill-runnable.ts --out /tmp/corpus-apps
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const i = process.argv.indexOf("--out");
const outRoot = i >= 0 ? (process.argv[i + 1] as string) : "/tmp/corpus-apps";
const COMPOSE_RE = /^(docker-)?compose([-.][\w.-]+)?\.ya?ml$/i;

const manifestPath = join(outRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<Record<string, unknown>>;

async function composeFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (e.isFile() && COMPOSE_RE.test(e.name)) found.push(e.name);
		if (!e.isDirectory()) continue;
		for (const f of await readdir(join(root, e.name), { withFileTypes: true }).catch(() => [])) {
			if (f.isFile() && COMPOSE_RE.test(f.name)) found.push(`${e.name}/${f.name}`);
		}
	}
	return found.sort();
}

let changed = 0;
for (const entry of manifest) {
	const target = entry.target as string;
	const runnable = await composeFiles(target);
	if (JSON.stringify(entry.runnable ?? null) === JSON.stringify(runnable)) continue;
	entry.runnable = runnable;
	changed += 1;
	process.stdout.write(`  ${String(entry.id).padEnd(24)} ${runnable.length > 0 ? runnable.join(", ") : "not runnable"}\n`);
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`\n${changed} entr${changed === 1 ? "y" : "ies"} updated · ${manifest.filter((m) => (m.runnable as string[])?.length > 0).length}/${manifest.length} runnable\n`);
