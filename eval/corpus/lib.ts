#!/usr/bin/env -S node --experimental-strip-types
/**
 * Shared corpus machinery: advisory lookup, answer-key derivation, leak stripping.
 *
 * Extracted from fetch.ts when the application corpus was added, so that both
 * corpora derive ground truth from **one** implementation. The key is the
 * scientific core of this whole evaluation — two copies of it would drift, and a
 * drifted key produces numbers nobody can falsify.
 */

import { execFile } from "node:child_process";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

export interface Advisory {
	id: string;
	published?: string;
	summary?: string;
	details?: string;
	aliases?: string[];
	severity?: Array<{ type: string; score: string }>;
	database_specific?: { severity?: string; cwe_ids?: string[] };
	references?: Array<{ type: string; url: string }>;
}

export const COMMIT_RE = /github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;

/**
 * A pull request reference, which many advisories give INSTEAD of a commit.
 *
 * GHSA entries frequently cite the PR that fixed a bug rather than the merge
 * commit — gotify's two XSS advisories reference `/pull/534` and `/pull/535`
 * and no commit at all. Filtering candidates on COMMIT_RE alone silently drops
 * every such advisory, which shrinks the corpus across every ecosystem for a
 * reason that has nothing to do with the vulnerability.
 */
export const PULL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/** The merge commit a pull request landed as, or undefined if it never merged. */
export async function shaFromPull(owner: string, repo: string, pull: string): Promise<string | undefined> {
	const headers: Record<string, string> = { accept: "application/vnd.github+json" };
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pull}`, { headers });
	if (!res.ok) return undefined;
	const pr = (await res.json()) as { merged_at?: string | null; merge_commit_sha?: string };
	// An unmerged PR fixed nothing, and its merge_commit_sha is a test merge
	// GitHub computed speculatively — following it would key the answer to a
	// commit that is not in the repository's history.
	if (!pr.merged_at || !pr.merge_commit_sha) return undefined;
	return pr.merge_commit_sha;
}

/**
 * Expand an abbreviated commit sha to its full form.
 *
 * `git fetch origin <short-sha>` fails outright — "couldn't find remote ref" —
 * because a remote can only serve an object named in full. OSV advisories do
 * reference short commit URLs (apache/airflow's PYSEC-2026-2351 among them), so
 * without this those advisories silently drop out of every corpus and the yield
 * looks like a property of the ecosystem rather than a bug in the fetcher.
 *
 * This runs at corpus-build time, which is not the sealed part of the
 * experiment: the seal governs what the *agent* may reach, not how the target
 * was assembled. GITHUB_TOKEN is used when present purely for the rate limit.
 */
export async function resolveSha(owner: string, repo: string, sha: string): Promise<string> {
	if (sha.length === 40) return sha;
	const headers: Record<string, string> = { accept: "application/vnd.github+json" };
	if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, { headers });
	if (!res.ok) throw new Error(`cannot expand short sha ${sha}: GitHub ${res.status}`);
	const full = ((await res.json()) as { sha?: string }).sha;
	if (!full || full.length !== 40) throw new Error(`GitHub returned no full sha for ${sha}`);
	return full;
}

export async function osvQuery(name: string, ecosystem: string): Promise<Advisory[]> {
	const res = await fetch("https://api.osv.dev/v1/query", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ package: { name, ecosystem } }),
	});
	if (!res.ok) throw new Error(`OSV ${res.status} for ${ecosystem}/${name}`);
	return ((await res.json()) as { vulns?: Advisory[] }).vulns ?? [];
}

/** Truth entry in DVBank's schema, so the existing grader scores these unchanged. */
export interface TruthEntry {
	id: string;
	title: string;
	cwe?: string;
	severity: string;
	file: string;
	line: number;
	line_range?: [number, number];
	vuln_class?: string;
}

/**
 * Read the fix diff and record the pre-image locations it touched. `-U0` keeps
 * hunks tight; without it the key drifts into untouched context lines.
 */
export async function keyFromPatch(repo: string, sha: string, adv: Advisory): Promise<TruthEntry[]> {
	// `git show` renders no diff for a merge commit, and security fixes are very
	// often merges — GitHub's private-fork advisory workflow lands them that way.
	// Diffing against the first parent gives the change the fix introduced, and
	// works identically for ordinary commits.
	const { stdout } = await run("git", ["-C", repo, "diff", "--unified=0", "--no-color", `${sha}^1`, sha], { maxBuffer: 1 << 28 });
	const out: TruthEntry[] = [];
	let file = "";
	let n = 0;
	for (const line of stdout.split("\n")) {
		const f = /^--- a\/(.+)$/.exec(line);
		if (f) {
			file = f[1] as string;
			continue;
		}
		const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
		if (h && file) {
			const removed = Number(h[2] ?? "1");
			// A hunk that removes lines points at the bug directly. A pure addition
			// (count 0) is a guard the code was missing — the insertion point is
			// still the right location, and missing-check bugs are exactly the class
			// worth measuring, so they are kept rather than filtered out.
			const start = Number(h[1]);
			const len = Math.max(removed, 1);
			n += 1;
			out.push({
				id: `${adv.id}-${n}`,
				title: adv.summary ?? adv.id,
				cwe: adv.database_specific?.cwe_ids?.[0],
				severity: (adv.database_specific?.severity ?? "medium").toLowerCase(),
				file,
				line: start,
				line_range: [start, start + len - 1],
				vuln_class: adv.database_specific?.cwe_ids?.[0],
			});
		}
	}
	return out;
}

export const SOURCE_EXT = /\.(py|js|jsx|ts|tsx|go|java|rb|php|cs|rs)$/i;
export const NON_SOURCE = /(^|\/)(tests?|spec|__tests__|docs?|examples?|benchmarks?)(\/|$)|(^|\/)(test_|conftest\.)|(_test|\.test|\.spec)\.[a-z]+$/i;

/**
 * A patch touches more than the vulnerability. The fix for one Flask advisory
 * spanned CHANGES.rst, docs/config.rst and tests/test_basic.py alongside the
 * four source files that actually held the bug — and CHANGES.rst is stripped
 * from the target as a leak, so keeping it in the key guarantees a false
 * negative against a reviewer who did everything right.
 *
 * Filtering to source, then collapsing to one entry per file, also fixes a
 * scoring problem: nineteen entries for a single vulnerability would score a
 * reviewer who found it once at recall 0.05. One claim per file is the honest
 * unit — "the bug is in this file, around here".
 *
 * This is why a patch-derived key is weaker than a hand-labelled one like
 * DVBank's. It is precise about location and coarse about count, and it should
 * be read that way.
 */
export function refineKey(entries: TruthEntry[]): TruthEntry[] {
	const byFile = new Map<string, TruthEntry[]>();
	for (const e of entries) {
		if (!SOURCE_EXT.test(e.file) || NON_SOURCE.test(e.file)) continue;
		byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
	}
	const out: TruthEntry[] = [];
	let n = 0;
	for (const [file, es] of byFile) {
		const lo = Math.min(...es.map((e) => e.line_range?.[0] ?? e.line));
		const hi = Math.max(...es.map((e) => e.line_range?.[1] ?? e.line));
		n += 1;
		out.push({ ...(es[0] as TruthEntry), id: `${(es[0] as TruthEntry).id.replace(/-\d+$/, "")}-${n}`, file, line: lo, line_range: [lo, hi] });
	}
	return out;
}

/**
 * Documentation and history that would hand over the answer. Every pattern is
 * anchored to a documentation extension (or no extension) on purpose: an
 * earlier version matched /^SECURITY/i and deleted `src/werkzeug/security.py`
 * — the source file holding the vulnerability the key pointed at. The target
 * then had an unfindable truth entry and would have scored 0 recall for a
 * reason that had nothing to do with the harness.
 */
export const DOC_EXT = "(\\.(md|rst|txt|adoc|rdoc))?$";
export const LEAK_NAMES = [
	/^\.git$/,
	new RegExp(`^CHANGELOG${DOC_EXT}`, "i"),
	new RegExp(`^CHANGES${DOC_EXT}`, "i"),
	new RegExp(`^SECURITY${DOC_EXT}`, "i"),
	new RegExp(`^NEWS${DOC_EXT}`, "i"),
	new RegExp(`^HISTORY${DOC_EXT}`, "i"),
	new RegExp(`^RELEASES?${DOC_EXT}`, "i"),
	new RegExp(`^UPGRADING?${DOC_EXT}`, "i"),
	// Release-note machinery. Applications carry a whole directory of it where a
	// library carries a single CHANGELOG, and a fragment file is written in the
	// same commit as the fix — often naming the vulnerability outright. None of
	// these names collide with a source file, which is the bar every pattern here
	// has to clear.
	/^changelog\.d$/i,
	/^\.changes$/i,
	/^\.changeset$/i,
	/^newsfragments$/i,
	/^release[-_]notes$/i,
	/^CHANGELOG$/,
];

/** Remove the history, the changelog, and anything that names the advisory. */
export async function stripLeakage(dir: string, adv: Advisory): Promise<number> {
	const ids = [adv.id, ...(adv.aliases ?? [])].map((x) => x.toLowerCase());
	let removed = 0;
	const walk = async (d: string): Promise<void> => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (LEAK_NAMES.some((re) => re.test(e.name))) {
				await rm(p, { recursive: true, force: true });
				removed += 1;
				continue;
			}
			if (e.isDirectory()) {
				await walk(p);
				continue;
			}
			const st = await stat(p).catch(() => undefined);
			// 2 MB, not 512 KB: an application's locale catalogues run large and a
			// fix that adds an error string lands the advisory text in every one of
			// them. The cap exists to skip binaries, not to skip big text.
			if (!st || st.size > 2 * 1024 * 1024) continue;
			const text = (await readFile(p, "utf8").catch(() => "")).toLowerCase();
			if (ids.some((id) => id && text.includes(id))) {
				await rm(p, { force: true });
				removed += 1;
			}
		}
	};
	await walk(dir);
	return removed;
}

/**
 * The scope sentence appended to both arms' prompts.
 *
 * Application targets are scoped to a subtree — a 1.5M-line repo reviewed whole
 * inside a wall-clock budget is a lottery, not a measurement. This lives here,
 * shared, so pired and codex are told about that scope in byte-identical words.
 * Two hand-written variants would quietly turn a harness comparison into a
 * prompt comparison.
 */
export function scopeClause(scope?: string[]): string {
	if (!scope || scope.length === 0 || scope.includes(".")) return "";
	return ` The engagement is scoped to these paths under the review root: ${scope.join(", ")}.` +
		" Confine both the review and the findings to that scope.";
}

// Hidden directories are excluded wholesale, not enumerated: `.github` carried
// enough Python to be picked up as reviewable scope on superset, and no
// application keeps its request-handling code behind a dot.
export const VENDORED = /(^|\/)(node_modules|vendor|third_party|dist|build|site-packages)(\/|$)|(^|\/)\.[^/]+(\/|$)/;

export interface Walk { all: string[]; source: string[] }

export async function walk(root: string): Promise<Walk> {
	const all: string[] = [];
	const source: string[] = [];
	const rec = async (dir: string): Promise<void> => {
		// An unreadable directory is a fact about the checkout, not a failure of
		// the walk: skip it and keep counting.
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const abs = join(dir, e.name);
			const rel = relative(root, abs);
			if (VENDORED.test(`/${rel}`)) continue;
			if (e.isDirectory()) {
				await rec(abs);
				continue;
			}
			all.push(rel);
			if (SOURCE_EXT.test(rel) && !NON_SOURCE.test(rel)) source.push(rel);
		}
	};
	await rec(root);
	return { all, source };
}

// --- scope ------------------------------------------------------------------

export interface Scope { dirs: string[]; files: number; overCap: boolean }

/**
 * The largest directory subtree that still fits under the cap.
 *
 * Both failure modes here are silent and fatal. Too wide and the target measures
 * endurance, not review: one bug in 1.5M lines inside a wall-clock budget is a
 * lottery. Too narrow and it measures nothing at all, because handing over the
 * directory the bug is in has already answered the question. Taking the *largest*
 * subtree under the cap is the widest honest setting, and the file and line
 * counts go into the manifest so the haystack-to-needle ratio of every target is
 * stated rather than assumed.
 */
export interface ScopeLimits {
	/** Lines per source file, for the loc ceiling. Omit to cap on files alone. */
	lines?: Map<string, number>;
	locCap?: number;
}

export function deriveScope(source: string[], truth: TruthEntry[], cap: number, limits: ScopeLimits = {}): Scope {
	const { lines, locCap } = limits;
	const locOf = (dirs: string[]): number => {
		if (!lines) return 0;
		const files = dirs.includes(".") ? source : source.filter((f) => dirs.some((d) => f.startsWith(`${d}/`)));
		return files.reduce((a, f) => a + (lines.get(f) ?? 0), 0);
	};
	// A scope has to clear both ceilings. The file cap bounds how much there is to
	// enumerate; the loc cap bounds how much of it can be read into a context
	// window. A target that passes one and fails the other is unreviewable in
	// exactly the way that produces a timeout rather than a result.
	const fits = (dirs: string[], n: number): boolean =>
		n <= cap && (!locCap || !lines || locOf(dirs) <= locCap);

	if (fits(["."], source.length)) return { dirs: ["."], files: source.length, overCap: false };
	const under = (dirs: string[]): number =>
		dirs.includes(".") ? source.length : source.filter((f) => dirs.some((d) => f.startsWith(`${d}/`))).length;

	/**
	 * Spend the rest of the cap on sibling directories.
	 *
	 * Without this the scope is merely the first subtree that fits, which on
	 * airflow meant 241 files against a cap of 1200 — five times smaller than the
	 * budget allows, and a scope that narrow has already told the agent which
	 * subsystem the bug is in. Widening to siblings in name order keeps the
	 * haystack as large as the cap permits and keeps the result reproducible.
	 *
	 * A sibling too large to fit is skipped rather than ending the loop, so a
	 * single huge directory cannot block several small ones from being included.
	 */
	const widen = (dirs: string[], count: (d: string[]) => number): Scope => {
		const chosen = new Set(dirs);
		const siblings = new Set<string>();
		for (const d of dirs) {
			const want = d.split("/").length;
			const parent = d.split("/").slice(0, -1).join("/");
			for (const f of source) {
				const parts = f.split("/");
				if (parts.length <= want) continue;
				const cand = parts.slice(0, want).join("/");
				if (chosen.has(cand) || parts.slice(0, want - 1).join("/") !== parent) continue;
				siblings.add(cand);
			}
		}
		// Largest first, not alphabetically. Superset's scope came back as
		// `.github, RELEASING, docker, scripts, superset` because name order reaches
		// repo furniture before it reaches the application: the cap should be spent
		// on the most code available, and a name tiebreak keeps it reproducible.
		const sized = [...siblings]
			.map((d) => ({ dir: d, n: source.filter((f) => f.startsWith(`${d}/`)).length }))
			.sort((a, b) => b.n - a.n || a.dir.localeCompare(b.dir));
		let total = count([...chosen]);
		for (const { dir, n } of sized) {
			if (total + n > cap) continue;
			if (!fits([...chosen, dir], total + n)) continue;
			chosen.add(dir);
			total += n;
		}
		return { dirs: [...chosen].sort(), files: total, overCap: false };
	};

	let last: Scope = { dirs: ["."], files: source.length, overCap: true };
	for (let depth = 1; depth <= 6; depth++) {
		const dirs = [...new Set(truth.map((t) => {
			const parts = t.file.split("/");
			// Never past a truth file's own directory: a scope of exactly the file is
			// not a scope, it is the answer.
			return parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
		}))];
		if (dirs.some((d) => d === "")) return { dirs: ["."], files: source.length, overCap: source.length > cap };
		const files = under(dirs);
		last = { dirs, files, overCap: false };
		if (fits(dirs, files)) return widen(dirs, under);
	}
	return { ...last, overCap: true };
}

/**
 * The commit reference that is actually the fix.
 *
 * A commit URL can appear under any reference type — ADVISORY, WEB, REPORT — so
 * taking the first commit-shaped URL can key the answer to something that is not
 * the patch. Measured across the OSV bulk exports: 50,718 advisories carry a
 * git-range `fixed` event but only 26,776 carry a reference explicitly typed
 * FIX, and the difference is largely RELEASE commits.
 *
 * bludit is the worst documented case — CVE-2026-25099/25100/25101 all point at
 * "chore: bump version" commits touching 30 files, one of them +25,392 lines
 * because it re-vendors tinymce. As an answer key that is not merely noisy, it
 * is wrong: the reviewer would be scored against a diff containing no
 * vulnerability at all.
 *
 * Prefer type FIX; fall back to any commit reference, and tell the caller which
 * it got so an untyped fallback can be treated with suspicion.
 */
export function fixReference(
	refs: Array<{ type: string; url: string }> | undefined,
	pattern: RegExp,
): { match: RegExpExecArray; typed: boolean } | undefined {
	const list = refs ?? [];
	for (const r of list) {
		if (r.type !== "FIX") continue;
		const m = pattern.exec(r.url);
		if (m) return { match: m, typed: true };
	}
	for (const r of list) {
		const m = pattern.exec(r.url);
		if (m) return { match: m, typed: false };
	}
	return undefined;
}

/**
 * Translate a line range from a later commit back to an earlier one.
 *
 * A one-advisory key is exact because the target commit IS the fix's parent, so
 * the diff's line numbers are the target's line numbers. The moment a target
 * carries several advisories that stops being true: an advisory fixed months
 * later reports lines in ITS parent tree, and pointing the grader at those
 * numbers in an older tree is pointing it at the wrong code.
 *
 * `diff` is `git diff <earlier> <later> -- <file>` at --unified=0. Hunks are
 * walked in order accumulating the offset between the two files, which is exact
 * outside changed regions.
 *
 * Returns undefined when the range overlaps a hunk — the code there is not the
 * same code, so no honest mapping exists and the entry is dropped rather than
 * guessed. That also happens to be the check for "was this bug present in the
 * older tree at all": if the vulnerable region was rewritten in between, it is
 * not the same vulnerability and does not belong in that target's key.
 */
export function mapRangeBack(diff: string, range: [number, number]): [number, number] | undefined {
	const [lo, hi] = range;
	let offset = 0;
	for (const line of diff.split("\n")) {
		// -old,count +new,count
		const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!h) continue;
		const oldStart = Number(h[1]);
		const oldLen = h[2] === undefined ? 1 : Number(h[2]);
		const newStart = Number(h[3]);
		const newLen = h[4] === undefined ? 1 : Number(h[4]);
		// The hunk covers [newStart, newStart+newLen) in the later file. An
		// insertion (newLen 0) covers nothing and only shifts what follows.
		const hunkLo = newStart;
		const hunkHi = newStart + Math.max(newLen, 1) - 1;
		if (newLen > 0 && hi >= hunkLo && lo <= hunkHi) return undefined;
		if (hunkHi < lo) offset += oldLen - newLen;
		else break;
	}
	const mapped: [number, number] = [lo + offset, hi + offset];
	return mapped[0] >= 1 ? mapped : undefined;
}
