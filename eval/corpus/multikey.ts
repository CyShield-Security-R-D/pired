#!/usr/bin/env -S node --experimental-strip-types
/**
 * Build a target's answer key from EVERY advisory the tree still carries, not
 * the one advisory it was selected for.
 *
 * Each target is a pre-fix commit of a real project, and a commit that predates
 * one CVE predates many. filebrowser alone has 87 advisories; a mid-2025 commit
 * is unfixed for a good number of them. Keying such a target to a single CVE
 * does not measure whether the review found real bugs, it measures whether it
 * guessed which bug we picked — and it scores every other correct finding as a
 * false positive.
 *
 * That is not hypothetical. On CVE-2025-52903 the reviewer reported a missing
 * ownership check in shareDeleteHandler; that is CVE-2025-64523, published five
 * months after the reviewed commit, and it scored 0.00 because share.go is not
 * in that target's key.
 *
 * Selection is by rule and never by what a reviewer found:
 *
 *   1. the advisory's FIX commit is a descendant of the target commit — so the
 *      bug was still open in this tree;
 *   2. the vulnerable region is byte-identical between the target and the fix's
 *      parent — so it is the same code, and therefore the same bug, rather than
 *      one introduced after the target;
 *   3. the range translates cleanly back to the target's own line numbers.
 *
 * Anything that fails a step is dropped rather than guessed. The bias is
 * deliberately toward under-inclusion: a key entry that is not really there
 * scores a correct review as wrong, which is the more damaging error.
 *
 *   node eval/corpus/multikey.ts --manifest /tmp/corpus-fb5/manifest.json \
 *     --clone /tmp/corpus-clones --out /tmp/corpus-fb5 [--apply]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMIT_RE, keyFromPatch, mapRangeBack, refineKey, run, type Advisory, type TruthEntry } from "./lib.ts";

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const manifestPath = arg("manifest") ?? "";
const cloneRoot = arg("clone", "/tmp/corpus-clones") as string;
const outDir = arg("out") ?? "";
const apply = argv.includes("--apply");
if (!manifestPath || !outDir) {
	process.stderr.write("usage: --manifest manifest.json --out DIR [--clone DIR] [--apply]\n");
	process.exit(2);
}

const GIT_NOPROXY = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.proxy", GIT_CONFIG_VALUE_0: "" };

/** A full clone with history, so ancestry and old blobs are answerable. */
async function ensureClone(slug: string): Promise<string> {
	const dir = join(cloneRoot, slug.replace(/\//g, "_"));
	if (existsSync(join(dir, ".git"))) return dir;
	await mkdir(cloneRoot, { recursive: true });
	process.stdout.write(`  cloning ${slug} (full history)…\n`);
	await run("git", ["clone", "--quiet", `https://github.com/${slug}.git`, dir], { timeout: 1_800_000, env: GIT_NOPROXY });
	return dir;
}

async function advisoriesFor(slug: string): Promise<Advisory[]> {
	const body = JSON.stringify({ package: { name: `github.com/${slug}`, ecosystem: "Go" } });
	const res = await fetch("https://api.osv.dev/v1/query", { method: "POST", body }).catch(() => undefined);
	const first = res?.ok ? ((await res.json()) as { vulns?: Advisory[] }).vulns ?? [] : [];
	if (first.length > 0) return first;
	// Not every project is a Go module; GIT covers the rest.
	const alt = await fetch("https://api.osv.dev/v1/query", {
		method: "POST",
		body: JSON.stringify({ package: { name: `https://github.com/${slug}`, ecosystem: "GIT" } }),
	}).catch(() => undefined);
	return alt?.ok ? ((await alt.json()) as { vulns?: Advisory[] }).vulns ?? [] : [];
}

/** The advisory's FIX-typed commit, which is the only one trustworthy as a patch. */
function fixSha(adv: Advisory): string | undefined {
	for (const r of (adv as unknown as { references?: Array<{ type?: string; url?: string }> }).references ?? []) {
		if (r.type !== "FIX" || !r.url) continue;
		const m = COMMIT_RE.exec(r.url);
		if (m) return m[3];
	}
	return undefined;
}

async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
	try {
		await run("git", ["-C", repo, "merge-base", "--is-ancestor", a, b], { timeout: 60_000 });
		return true;
	} catch { return false; }
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<Record<string, string | number>>;
process.stdout.write(`⦿ multi-advisory keys · ${manifest.length} target(s)\n\n`);

for (const t of manifest) {
	const slug = String(t.repo ?? t.package);
	const target = String(t.fix_commit);
	const own = String(t.id);
	process.stdout.write(`${own}  (${slug})\n`);
	const repo = await ensureClone(slug);
	// The reviewed tree is the fix's PARENT, never the fix itself.
	const reviewed = `${target}^1`;
	const advisories = await advisoriesFor(slug);
	const kept: TruthEntry[] = [];
	const credited: string[] = [];

	for (const adv of advisories) {
		const sha = fixSha(adv);
		if (!sha) continue;
		let full: string;
		try { full = (await run("git", ["-C", repo, "rev-parse", sha], { timeout: 60_000 })).stdout.trim(); }
		catch { continue; }
		// Step 1: still open in the reviewed tree. The advisory's own fix is the
		// target's fix for exactly one advisory; that one is included as itself.
		if (full !== target && !(await isAncestor(repo, reviewed, `${full}^1`))) continue;

		const entries = refineKey(await keyFromPatch(repo, full, adv).catch(() => []));
		for (const e of entries) {
			const range: [number, number] = e.line_range ?? [e.line, e.line];
			if (full === target) { kept.push(e); continue; }
			// Steps 2 and 3: the region must be the same code in the reviewed tree,
			// and must translate to its line numbers.
			let diff = "";
			try {
				diff = (await run("git", ["-C", repo, "diff", "--unified=0", "--no-color", reviewed, `${full}^1`, "--", e.file],
					{ maxBuffer: 1 << 28, timeout: 120_000 })).stdout;
			} catch { continue; }
			const mapped = mapRangeBack(diff, range);
			if (!mapped) continue;
			kept.push({ ...e, line: mapped[0], line_range: mapped });
		}
		if (entries.length > 0 && kept.some((k) => k.id.startsWith(adv.id))) credited.push(adv.id);
	}

	// Two advisories can share a fix commit, or fix overlapping regions, and both
	// produce the same file+range. Left in, they inflate the denominator and a
	// review is marked down for not finding the same lines twice.
	const seen = new Set<string>();
	const unique = kept.filter((e) => {
		const key = `${e.file}:${(e.line_range ?? [e.line, e.line]).join("-")}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	kept.length = 0;
	kept.push(...unique);

	const before = JSON.parse(await readFile(String(t.truth), "utf8")) as TruthEntry[];
	process.stdout.write(
		`  ${before.length} entr(y|ies) -> ${kept.length}   from ${credited.length} advisor(y|ies): ` +
		`${credited.slice(0, 6).join(", ")}${credited.length > 6 ? ` (+${credited.length - 6})` : ""}\n`,
	);
	if (apply && kept.length >= before.length) {
		await writeFile(String(t.truth), `${JSON.stringify(kept, null, 2)}\n`);
		process.stdout.write("  written\n");
	}
}
process.stdout.write(`\n${apply ? "keys updated" : "dry run — pass --apply to write"}\n`);
