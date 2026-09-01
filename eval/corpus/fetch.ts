#!/usr/bin/env -S node --experimental-strip-types
/**
 * Real-app corpus: build targets from real projects at their vulnerable commit.
 *
 * Forge is contamination-proof but synthetic. DVBank is real but singular and
 * public. This is the third source: actual codebases, actual vulnerabilities,
 * and a key nobody hand-wrote.
 *
 * The construction rests on one observation — **a security patch is an answer
 * key**. The lines a fix touches are where the bug was, which makes ground truth
 * machine-derivable at scale instead of hand-labelled. It is the security
 * analogue of SWE-bench admitting an instance only on a fail-to-pass transition,
 * one bar lower: patch-localized rather than exploit-verified. A PoC would be
 * stronger and is the next step; this is honest about being the weaker version.
 *
 * Contamination is handled by **time**, not obscurity. Every useful public
 * vulnerable app is in training data, so instead of hunting for obscure targets
 * this filters advisories by publication date: pass --since to keep only
 * vulnerabilities disclosed after a model's cutoff. That decays as models
 * retrain, which is why it is a pipeline rather than a fixed corpus — rerun it.
 *
 * Leakage is stripped aggressively. The clone's own history contains the fix,
 * so .git goes; changelogs, security policies and any file naming the advisory
 * would hand over the answer, so they go too.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { COMMIT_RE, osvQuery, keyFromPatch, PULL_RE, refineKey, resolveSha, shaFromPull, stripLeakage } from "./lib.ts";
import type { Advisory } from "./lib.ts";

const run = promisify(execFile);


function arg(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}
// --- main -------------------------------------------------------------------

const packages = (arg("packages") ?? arg("package") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const ecosystem = arg("ecosystem", "PyPI") as string;
const since = arg("since", "2025-01-01") as string;
const outRoot = arg("out", "/tmp/corpus") as string;
const limit = Number(arg("limit", "3"));

if (packages.length === 0) {
	process.stderr.write(
		"usage: fetch.ts --packages <a,b,c> [--ecosystem PyPI|npm|Go] [--since YYYY-MM-DD] [--limit N per package] [--out DIR]\n",
	);
	process.exit(2);
}

await mkdir(outRoot, { recursive: true });
let built = 0;
type ManifestEntry = { id: string; package: string; ecosystem: string; published?: string; repo: string; sha: string; target: string; truth: string; entries: number };

// Merge with what is already there. Writing a fresh manifest per invocation
// meant fetching one package silently discarded every other target's entry —
// the corpus was still on disk, but nothing downstream could find it.
const manifest: ManifestEntry[] = await (async () => {
	try {
		return JSON.parse(await readFile(join(outRoot, "manifest.json"), "utf8")) as ManifestEntry[];
	} catch {
		return [];
	}
})();
const upsert = (e: ManifestEntry): void => {
	const i = manifest.findIndex((m) => m.id === e.id && m.package === e.package);
	if (i >= 0) manifest[i] = e;
	else manifest.push(e);
};

process.stdout.write(`⦿ corpus · ${ecosystem} · ${packages.length} package(s) · advisories since ${since}\n\n`);

for (const pkg of packages) {
let advisories: Advisory[] = [];
try {
	advisories = (await osvQuery(pkg, ecosystem))
		.filter((a) => (a.published ?? "") >= since)
		// A commit OR a merged pull request. Advisories cite whichever the
		// maintainer linked, and dropping the PR ones costs real targets for a
		// reason unrelated to the vulnerability.
		.filter((a) => (a.references ?? []).some((r) => COMMIT_RE.test(r.url) || PULL_RE.test(r.url)))
		.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
} catch (err) {
	process.stdout.write(`${pkg}: OSV query failed — ${String((err as Error).message).slice(0, 80)}\n`);
	continue;
}
process.stdout.write(`${pkg} — ${advisories.length} candidate(s)\n`);

for (const adv of advisories.slice(0, limit)) {
	// Prefer a direct commit; fall back to resolving a merged PR to the commit it
	// landed as. The rest of the pipeline only ever wanted a sha.
	let owner = "";
	let repo = "";
	let shortSha = "";
	const commitRef = (adv.references ?? []).map((r) => COMMIT_RE.exec(r.url)).find(Boolean);
	if (commitRef) {
		[, owner, repo, shortSha] = commitRef as unknown as [string, string, string, string];
	} else {
		const pullRef = (adv.references ?? []).map((r) => PULL_RE.exec(r.url)).find(Boolean);
		if (!pullRef) continue;
		const [, o, rp, num] = pullRef as unknown as [string, string, string, string];
		const merged = await shaFromPull(o, rp, num);
		if (!merged) {
			process.stdout.write(`  ${adv.id}: PR #${num} is not merged — skipped\n`);
			continue;
		}
		[owner, repo, shortSha] = [o, rp, merged];
	}
	// The directory name is visible to the agent — pired derives the engagement
	// name from it and renders it in the status line on every frame. Leaving the
	// advisory id there told the agent a known vulnerability exists, gave it the
	// identifier, and announced that this was an evaluation; one run reasoned
	// exactly that out loud and switched from reviewing the code to recalling
	// CVEs. Contents were stripped of the id from the start; the path was not.
	//
	// The package name stays. It cannot be hidden without mangling pyproject.toml
	// and the source tree, and it should not be: a reviewer handed sqlparse knows
	// it is sqlparse. That is domain knowledge, not leakage. What must not leak is
	// that a specific bug is known to be present.
	const tag = [...adv.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36).slice(0, 6);
	const slug = `${pkg}-${tag}`.replace(/[^\w.-]/g, "_");
	const workRepo = join(outRoot, `${slug}.repo`);
	const target = join(outRoot, slug);

	try {
		const sha = await resolveSha(owner, repo, shortSha);
		await rm(workRepo, { recursive: true, force: true });
		await mkdir(workRepo, { recursive: true });
		// Fetch the fix commit and its parents only. A full clone of a large project
		// is minutes and gigabytes for two commits' worth of information — mlflow
		// timed out at 300s twice — and depth 2 is everything the key and the
		// checkout need.
		await run("git", ["-C", workRepo, "init", "--quiet"], { timeout: 60_000 });
		await run("git", ["-C", workRepo, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], { timeout: 60_000 });
		await run("git", ["-C", workRepo, "fetch", "--quiet", "--depth", "2", "origin", sha], { timeout: 300_000 });
		// First parent: the pre-fix mainline state, correct for merges and ordinary
		// commits alike.
		await run("git", ["-C", workRepo, "checkout", "--quiet", `${sha}^1`], { timeout: 120_000 });

		const key = refineKey(await keyFromPatch(workRepo, sha, adv));
		if (key.length === 0) {
			process.stdout.write(`  ${adv.id}: fix touches no source files — skipped\n`);
			await rm(workRepo, { recursive: true, force: true });
			continue;
		}

		await rm(target, { recursive: true, force: true });
		await run("cp", ["-r", workRepo, target]);
		const removed = await stripLeakage(target, adv);
		await rm(workRepo, { recursive: true, force: true });

		// A target whose key points at a file the target does not contain is
		// unscoreable: the entry is a guaranteed false negative and the number it
		// produces says nothing about the harness. This caught the leak filter
		// deleting src/werkzeug/security.py — the very file holding the bug — and
		// it exists so that class of mistake can never enter the corpus silently.
		const unresolved: string[] = [];
		for (const e of key) {
			const abs = join(target, e.file);
			const st = await stat(abs).catch(() => undefined);
			if (!st) unresolved.push(e.file);
		}
		if (unresolved.length > 0) {
			process.stdout.write(`  ${adv.id}: REJECTED — key points at missing file(s): ${unresolved.join(", ")}\n`);
			await rm(target, { recursive: true, force: true });
			continue;
		}

		await writeFile(join(outRoot, `${slug}.truth.json`), `${JSON.stringify(key, null, 2)}\n`);
		upsert({
			id: adv.id, package: pkg, ecosystem, published: adv.published?.slice(0, 10),
			repo: `${owner}/${repo}`, sha, target, truth: join(outRoot, `${slug}.truth.json`), entries: key.length,
		});
		built += 1;
		// Written after every target, not once at the end: a slow clone on one
		// large project should not strand the targets already built. The first run
		// hung on mlflow and left five finished targets unusable for want of a
		// manifest.
		await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		process.stdout.write(
			`  ${adv.id}  ${adv.published?.slice(0, 10)}  ${owner}/${repo}@${sha.slice(0, 8)}  →  ${key.length} truth entr${key.length === 1 ? "y" : "ies"} in ${new Set(key.map((k) => k.file)).size} file(s), ${removed} leak file(s) stripped\n`,
		);
	} catch (err) {
		process.stdout.write(`  ${adv.id}: FAILED — ${String((err as Error).message).slice(0, 120)}\n`);
		await rm(workRepo, { recursive: true, force: true });
	}
}

}

await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`\n${built} target(s) under ${outRoot} · manifest.json lists them\n`);
