#!/usr/bin/env -S node --experimental-strip-types
/**
 * Re-derive scope for targets already on disk, under a lines-of-code ceiling.
 *
 * The corpus was scoped on file count alone, which admits targets no reviewer
 * can hold: mlflow packs 813k lines into 1,114 files and airflow 194k into
 * 1,200 — both inside a 1,200-file cap, both past a 128k-token context. LM
 * Studio reported exactly that, twice, as "Context size has been exceeded",
 * and a target that cannot be read is not a hard target, it is an unmeasurable
 * one.
 *
 * Scope is a property of the engagement, not of the vulnerability, so tightening
 * it does not touch the answer key — every truth entry stays where the
 * maintainer's patch put it. It changes the haystack, which the manifest records
 * per target so the ratio is always visible.
 *
 * Works from the checkouts already fetched: no clone, no network.
 *
 *   node eval/corpus/rescope.ts --out /tmp/corpus-apps --loc-cap 150000
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveScope, walk } from "./lib.ts";
import type { TruthEntry } from "./lib.ts";

function arg(name: string, def: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : def;
}

const outRoot = arg("out", "/tmp/corpus-apps");
const fileCap = Number(arg("cap", "1200"));
const locCap = Number(arg("loc-cap", "150000"));
const manifestPath = join(outRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<Record<string, unknown>>;

process.stdout.write(`⦿ rescope · ${manifest.length} target(s) · caps: ${fileCap} files, ${locCap.toLocaleString()} loc\n\n`);

let changed = 0;
for (const entry of manifest) {
	const target = entry.target as string;
	const truth = JSON.parse(await readFile(entry.truth as string, "utf8")) as TruthEntry[];
	const w = await walk(target);

	// One pass over the tree; the line counts feed both the ceiling and the
	// manifest, so the number reported is the number that was enforced.
	const lines = new Map<string, number>();
	for (const f of w.source) {
		const text = await readFile(join(target, f), "utf8").catch(() => "");
		lines.set(f, text.length === 0 ? 0 : text.split("\n").length);
	}

	const scope = deriveScope(w.source, truth, fileCap, { lines, locCap });
	const files = scope.dirs.includes(".") ? w.source : w.source.filter((f) => scope.dirs.some((d) => f.startsWith(`${d}/`)));
	const loc = files.reduce((a, f) => a + (lines.get(f) ?? 0), 0);

	const before = `${entry.scope_files as number}f/${Math.round((entry.scope_loc as number) / 1000)}k`;
	const after = `${files.length}f/${Math.round(loc / 1000)}k`;
	const moved = entry.scope_loc !== loc || entry.scope_files !== files.length;
	if (moved) changed += 1;

	entry.scope = scope.dirs;
	entry.scope_files = files.length;
	entry.scope_loc = loc;
	entry.repo_files = w.source.length;

	// A scope that still breaches the ceiling has no smaller subtree to fall back
	// to. Said out loud rather than left in a field nobody reads.
	const over = loc > locCap ? "  ⚠ STILL OVER — no smaller subtree exists" : "";
	process.stdout.write(
		`  ${String(entry.id).padEnd(22)} ${before.padEnd(12)} → ${after.padEnd(12)} ${String(scope.dirs.length).padStart(3)}d${over}\n`,
	);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const locs = manifest.map((e) => e.scope_loc as number).sort((a, b) => a - b);
process.stdout.write(
	`\n${changed} target(s) rescoped · median ${Math.round((locs[Math.floor(locs.length / 2)] ?? 0) / 1000)}k loc · ` +
	`max ${Math.round((locs.at(-1) ?? 0) / 1000)}k loc\n`,
);
