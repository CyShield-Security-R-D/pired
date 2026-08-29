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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function arg(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}

interface Advisory {
	id: string;
	published?: string;
	summary?: string;
	details?: string;
	aliases?: string[];
	severity?: Array<{ type: string; score: string }>;
	database_specific?: { severity?: string; cwe_ids?: string[] };
	references?: Array<{ type: string; url: string }>;
}

const COMMIT_RE = /github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/;

async function osvQuery(name: string, ecosystem: string): Promise<Advisory[]> {
	const res = await fetch("https://api.osv.dev/v1/query", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ package: { name, ecosystem } }),
	});
	if (!res.ok) throw new Error(`OSV ${res.status} for ${ecosystem}/${name}`);
	return ((await res.json()) as { vulns?: Advisory[] }).vulns ?? [];
}

/** Truth entry in DVBank's schema, so the existing grader scores these unchanged. */
interface TruthEntry {
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
async function keyFromPatch(repo: string, sha: string, adv: Advisory): Promise<TruthEntry[]> {
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

const SOURCE_EXT = /\.(py|js|jsx|ts|tsx|go|java|rb|php|cs|rs)$/i;
const NON_SOURCE = /(^|\/)(tests?|spec|__tests__|docs?|examples?|benchmarks?)(\/|$)|(^|\/)(test_|conftest\.)|(_test|\.test|\.spec)\.[a-z]+$/i;

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
function refineKey(entries: TruthEntry[]): TruthEntry[] {
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

const LEAK_NAMES = [/^\.git$/, /^CHANGELOG/i, /^CHANGES/i, /^SECURITY/i, /^NEWS/i, /^HISTORY/i];

/** Remove the history, the changelog, and anything that names the advisory. */
async function stripLeakage(dir: string, adv: Advisory): Promise<number> {
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
			if (!st || st.size > 512 * 1024) continue;
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

// --- main -------------------------------------------------------------------

const pkg = arg("package");
const ecosystem = arg("ecosystem", "PyPI") as string;
const since = arg("since", "2025-01-01") as string;
const outRoot = arg("out", "/tmp/corpus") as string;
const limit = Number(arg("limit", "3"));

if (!pkg) {
	process.stderr.write(
		"usage: fetch.ts --package <name> [--ecosystem PyPI|npm|Go] [--since YYYY-MM-DD] [--limit N] [--out DIR]\n",
	);
	process.exit(2);
}

const advisories = (await osvQuery(pkg, ecosystem))
	.filter((a) => (a.published ?? "") >= since)
	.filter((a) => (a.references ?? []).some((r) => COMMIT_RE.test(r.url)))
	.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));

process.stdout.write(`⦿ corpus · ${ecosystem}/${pkg} · ${advisories.length} advisories since ${since} with a fix commit\n\n`);

await mkdir(outRoot, { recursive: true });
let built = 0;

for (const adv of advisories.slice(0, limit)) {
	const ref = (adv.references ?? []).map((r) => COMMIT_RE.exec(r.url)).find(Boolean);
	if (!ref) continue;
	const [, owner, repo, sha] = ref as unknown as [string, string, string, string];
	const slug = `${pkg}-${adv.id}`.replace(/[^\w.-]/g, "_");
	const workRepo = join(outRoot, `${slug}.repo`);
	const target = join(outRoot, slug);

	try {
		await rm(workRepo, { recursive: true, force: true });
		await run("git", ["clone", "--quiet", `https://github.com/${owner}/${repo}.git`, workRepo], { timeout: 300_000 });
		// The parent of the fix is the vulnerable state.
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

		await writeFile(join(outRoot, `${slug}.truth.json`), `${JSON.stringify(key, null, 2)}\n`);
		built += 1;
		process.stdout.write(
			`  ${adv.id}  ${adv.published?.slice(0, 10)}  ${owner}/${repo}@${sha.slice(0, 8)}  →  ${key.length} truth entr${key.length === 1 ? "y" : "ies"} in ${new Set(key.map((k) => k.file)).size} file(s), ${removed} leak file(s) stripped\n`,
		);
	} catch (err) {
		process.stdout.write(`  ${adv.id}: FAILED — ${String((err as Error).message).slice(0, 120)}\n`);
		await rm(workRepo, { recursive: true, force: true });
	}
}

process.stdout.write(`\n${built} target(s) under ${outRoot}\n`);
