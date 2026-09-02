#!/usr/bin/env -S node --experimental-strip-types
/**
 * Build corpus targets from named GITHUB REPOSITORIES rather than package names.
 *
 * The package-name selector can only find what someone thought to type, and
 * every name a person thinks of is a famous project — which is why a rebuild of
 * the whole seed list under the size gate admitted nothing at all: 29 rejected
 * for size (n8n at 1,666,158 lines), 8 for not being applications, 0 built.
 *
 * Small web applications are usually not npm or PyPI packages. They are found by
 * enumerating advisories that name a GitHub repository, which is what OSV's GIT
 * ecosystem carries: measured over the bulk exports, 4,104 repositories are
 * reachable through the package ecosystems and 9,804 through GIT, with 6,776
 * reachable ONLY through GIT.
 *
 * This takes an explicit repo list and an advisory index, and drives the same
 * chain lib.ts already implements — checkout at sha^1, the maintainer's diff as
 * the answer key, leak stripping — so a target built here is indistinguishable
 * from one built by fetch-apps.ts.
 *
 *   node eval/corpus/fetch-repos.ts \
 *     --repos benbusby/whoogle-search,filegator/filegator \
 *     --index /path/to/byrepo.json --out /tmp/corpus-small --max-loc 25000
 */
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	COMMIT_RE, keyFromPatch, refineKey, resolveSha, run, stripLeakage, walk,
	type Advisory, type TruthEntry,
} from "./lib.ts";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const repos = (arg("repos") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const indexPath = arg("index") ?? "";
const outRoot = arg("out", "/tmp/corpus-repos") as string;
const maxLoc = Number(arg("max-loc", "25000"));
const perRepo = Number(arg("per-repo", "4"));

if (repos.length === 0 || !indexPath) {
	process.stderr.write("usage: --repos owner/repo,... --index byrepo.json [--out DIR] [--max-loc N] [--per-repo N]\n");
	process.exit(2);
}

/** One advisory as the index records it. */
interface IndexRecord {
	ids: string[];
	repo: string;
	summary?: string;
	cwe?: string[];
	sev?: string;
	/** Commit refs the advisory explicitly types FIX — the trustworthy ones. */
	fixes?: string[];
	/** Commits from a git-range `fixed` event. Often a RELEASE commit, not a patch. */
	frange?: string[];
	published?: string;
}

const CLONES = arg("clones", "/tmp/corpus-clones") as string;

/** A full clone per repository, made once and reused by every advisory on it. */
const cloned = new Set<string>();
async function ensureClone(owner: string, repo: string): Promise<string> {
	const dir = join(CLONES, `${owner}_${repo}`);
	if (cloned.has(dir)) return dir;
	if (!existsSync(join(dir, ".git"))) {
		await mkdir(CLONES, { recursive: true });
		process.stdout.write(`  cloning ${owner}/${repo}…\n`);
		await run("git", ["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, dir], { timeout: 1_800_000 });
	}
	cloned.add(dir);
	return dir;
}

const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, IndexRecord[]>;
await mkdir(outRoot, { recursive: true });

const manifest: Array<Record<string, unknown>> = [];
const stats = { advisories: 0, noFix: 0, cloned: 0, tooBig: 0, noKey: 0, failed: 0, built: 0 };

process.stdout.write(`⦿ repo corpus · ${repos.length} repo(s) · cap ${maxLoc.toLocaleString()} loc\n\n`);

for (const slug of repos) {
	const records = index[slug] ?? [];
	process.stdout.write(`${slug} — ${records.length} advisory record(s)\n`);
	let built = 0;

	for (const rec of records) {
		if (built >= perRepo) break;
		stats.advisories += 1;
		const id = rec.ids[0] ?? "unknown";

		// FIX-typed only. A git-range `fixed` commit is frequently the release, and
		// a release diff as an answer key is not noisy but wrong — the reviewer is
		// scored against a diff that contains no vulnerability.
		const ref = (rec.fixes ?? []).map((f) => COMMIT_RE.exec(f.includes("://") ? f : `https://github.com/${f.replace("@", "/commit/")}`)).find(Boolean);
		if (!ref) { stats.noFix += 1; continue; }
		const [, owner, repo, shortSha] = ref as unknown as [string, string, string, string];

		// The directory name is visible to the agent in its status line, so it must
		// not carry the advisory id — that announces both that a known bug exists
		// and that this is an evaluation.
		const nonce = Math.random().toString(36).slice(2, 8);
		const work = join(outRoot, `${slug.replace(/\//g, "_")}-${nonce}`);

		try {
			// One full clone per repository, checked out locally per advisory.
			//
			// This used to `git init` + `fetch --depth 2 origin <sha>` per target.
			// GitHub stopped serving those by-SHA fetches partway through a build —
			// git falls back to asking for credentials and reports "could not read
			// Username", which is not a permissions problem and not a bad ref: the
			// same SHA that fetched an hour earlier failed, while `git clone` kept
			// working. 19 of 26 targets died that way. Cloning once is also far fewer
			// network round-trips than one fetch per advisory.
			const cache = await ensureClone(owner, repo);
			// From the clone rather than the API, so a build is not also spending
			// GitHub's unauthenticated request budget.
			const sha = (await run("git", ["-C", cache, "rev-parse", shortSha], { timeout: 60_000 })).stdout.trim();
			await run("git", ["-C", cache, "checkout", "--quiet", "--detach", `${sha}^1`], { timeout: 300_000 });
			await rm(work, { recursive: true, force: true });
			// Copy the tree WITHOUT .git: the target must be a plain directory, and
			// the key is computed against the clone, which still has its history.
			await cp(cache, work, {
				recursive: true,
				filter: (src) => !src.split("/").includes(".git"),
			});
			stats.cloned += 1;

			const w = await walk(work);

			// Size gate, measured on the tree AT THE VULNERABLE COMMIT and before the
			// key is computed. HEAD is not a proxy: froxlor measures 1,322 lines on
			// its default branch and 72,035 at its advisory.
			let loc = 0;
			for (const f of w.source) {
				const text = await readFile(join(work, f), "utf8").catch(() => "");
				loc += text.length === 0 ? 0 : text.split("\n").length;
			}
			if (maxLoc > 0 && loc > maxLoc) {
				stats.tooBig += 1;
				process.stdout.write(`  ${id.padEnd(24)} REJECTED — ${loc.toLocaleString()} loc, over the cap\n`);
				await rm(work, { recursive: true, force: true });
				continue;
			}

			const adv: Advisory = { id, summary: rec.summary, published: rec.published, references: [] } as unknown as Advisory;
			const key: TruthEntry[] = refineKey(await keyFromPatch(cache, sha, adv));
			if (key.length === 0) {
				stats.noKey += 1;
				process.stdout.write(`  ${id.padEnd(24)} skipped — fix touches no source files\n`);
				await rm(work, { recursive: true, force: true });
				continue;
			}

			const stripped = await stripLeakage(work, adv);
			await writeFile(join(outRoot, `${slug.replace(/\//g, "_")}-${nonce}.truth.json`), JSON.stringify(key, null, 2));

			manifest.push({
				// Field names are run.ts's contract, not this script's preference: it
				// reads id, package, target, truth, entries and scope, and a manifest
				// that renames any of them crashes the runner on its first target.
				id,
				package: slug,
				entries: key.length,
				// The whole tree. These targets are admitted precisely because they are
				// small enough to review entire, so there is no subtree to derive.
				scope: ["."],
				target: work,
				truth: join(outRoot, `${slug.replace(/\//g, "_")}-${nonce}.truth.json`),
				advisory: id,
				aliases: rec.ids,
				repo: slug,
				// Recorded so scoring can be split by disclosure date: the network seal
				// stops retrieval over the wire, not retrieval from the model's weights,
				// and an advisory published before a model's cutoff proves less.
				published: rec.published ?? null,
				cwe: rec.cwe ?? [],
				severity: rec.sev ?? null,
				fix_commit: sha,
				scope_files: w.source.length,
				scope_loc: loc,
			});
			stats.built += 1;
			built += 1;
			process.stdout.write(
				`  ${id.padEnd(24)} ${(rec.published ?? "").slice(0, 10)}  ${loc.toLocaleString()} loc  ` +
				`→ ${key.length} truth entr${key.length === 1 ? "y" : "ies"}, ${stripped} leak file(s) stripped\n`,
			);
		} catch (err) {
			stats.failed += 1;
			process.stdout.write(`  ${id.padEnd(24)} FAILED — ${String((err as Error).message).slice(0, 70)}\n`);
			await rm(work, { recursive: true, force: true }).catch(() => {});
		}
	}
}

await writeFile(join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(
	`\n${stats.built} target(s) built · ${stats.advisories} advisories · ${stats.noFix} without a FIX commit` +
	` · ${stats.tooBig} over the cap · ${stats.noKey} no source in fix · ${stats.failed} failed\n` +
	`manifest: ${join(outRoot, "manifest.json")}\n`,
);
