#!/usr/bin/env -S node --experimental-strip-types
/**
 * Application corpus: real CVEs in real web applications, at their vulnerable commit.
 *
 * `fetch.ts` builds the same thing from libraries. That turned out to be the
 * wrong target class for this harness and the mismatch, not the harness, is what
 * the first corpus numbers largely measured: pired's coverage model is
 * `checklist classes x recorded surface`, and its surface vocabulary is
 * host/service/endpoint/param/tech. A parsing library has none of those. Across
 * every sealed library run pired recorded **zero hypotheses** — the mechanism
 * never engaged, because there was nothing for it to enumerate. On DVBank, a web
 * application, the same harness beat codex.
 *
 * So this file changes the *target class* and nothing else. Every property that
 * made the library corpus trustworthy is inherited verbatim from lib.ts:
 *
 *   real advisory id -> real fix commit -> checkout at sha^1 -> the maintainer's
 *   own diff is the answer key -> history and changelogs stripped
 *
 * None of those five steps care whether the repo is a library or an application.
 * The only thing that made the first corpus library-shaped was its selector: a
 * hand-typed list of package names from PyPI, which is a registry of libraries.
 *
 * Three things this adds on top:
 *
 *  1. A **classifier**, so the seed list below decides only where to *look* and
 *     the code decides what is admitted. A seed entry that turns out to be a
 *     library is rejected by the same rule that would reject `requests`.
 *  2. A **surface tier**. A bug in a route handler and a bug in a crypto helper
 *     are both real, but only the first is the kind of thing an application
 *     review is scoped to find. Both are kept; the tier is recorded so a run can
 *     select on it instead of guessing.
 *  3. A **scope**. Gitea is ~1.5M lines. "Find one bug in the whole repo in 30
 *     minutes" measures nothing, and neither does "find one bug in the file we
 *     already know it is in". Scope is the largest directory subtree that stays
 *     under a file cap, which is how an engagement is actually written: review
 *     these components, not this company.
 *
 *   node eval/corpus/fetch-apps.ts --dry
 *   node eval/corpus/fetch-apps.ts --ecosystems Go,PyPI --limit 2 --out /tmp/corpus-apps
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMIT_RE, classify, countLines, fixReference, deriveScope, walk, keyFromPatch, osvQuery, refineKey, resolveSha, run, stripLeakage } from "./lib.ts";
import type { Advisory } from "./lib.ts";

function arg(name: string, def?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const next = process.argv[i + 1];
	return i >= 0 && next && !next.startsWith("--") ? next : def;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Where to look — deliberately not what to admit.
 *
 * Every entry is an open-source project that ships a running web application.
 * The classifier below re-derives that from the checkout itself, so a wrong
 * guess here costs a clone and is then rejected on the evidence; it cannot
 * smuggle a library into the corpus. Expanding this list is the cheap way to
 * grow the corpus, and a name that yields nothing is free.
 */
const SEEDS: Record<string, string[]> = {
	PyPI: [
		"apache-airflow", "apache-superset", "mlflow", "jupyter-server", "jupyterlab", "notebook",
		"label-studio", "gradio", "streamlit", "langflow", "nautobot", "wagtail", "django-cms",
		"indico", "pretix", "open-webui", "dagster-webserver", "chainlit", "netbox-community",
	],
	npm: [
		"n8n", "directus", "@strapi/strapi", "ghost", "nocodb", "parse-server", "verdaccio",
		"@budibase/server", "@keystone-6/core", "@medusajs/medusa", "payload", "@rocket.chat/meteor",
		"grafana-plugin-sdk", "adminjs", "outline",
	],
	Go: [
		"code.gitea.io/gitea", "github.com/grafana/grafana", "github.com/gogs/gogs",
		"github.com/argoproj/argo-cd/v2", "github.com/argoproj/argo-cd/v3", "github.com/minio/minio",
		"github.com/rancher/rancher", "github.com/navidrome/navidrome", "github.com/goharbor/harbor",
		"github.com/traefik/traefik/v3", "github.com/usememos/memos", "github.com/juanfont/headscale",
		"github.com/kubernetes/dashboard", "github.com/answerdev/answer", "github.com/zitadel/zitadel",
	],
	Packagist: [
		"typo3/cms-core", "drupal/core", "pimcore/pimcore", "moodle/moodle", "october/system",
		"shopware/core", "statamic/cms", "flarum/core", "bagisto/bagisto", "concrete5/core",
		"contao/core-bundle", "sulu/sulu", "librenms/librenms", "snipe/snipe-it", "getgrav/grav",
	],
	Maven: [
		"org.jenkins-ci.main:jenkins-core", "org.keycloak:keycloak-services",
		"org.apache.dolphinscheduler:dolphinscheduler", "org.opencms:opencms-core",
		"com.alibaba.nacos:nacos-server", "org.apache.druid:druid",
	],
};

// --- classifier -------------------------------------------------------------

/**
 * Paths that carry the request-handling surface. Used only to tier a target, not
 * to admit or reject one: a bug in `models/user.go` reachable from a route is a
 * perfectly real application bug, it is simply not the case the coverage model
 * is most directly built to catch, and the two should be distinguishable in the
 * results rather than blended.
 */
const SURFACE_RE = /(^|\/)(routes?|routers?|controllers?|views?|handlers?|api|endpoints?|middlewares?|serializers?|forms?|resources?|permissions?|policies|acl|auth\w*|security|session\w*)(\/|_|\.|$)/i;

// --- main -------------------------------------------------------------------

const ecosystems = (arg("ecosystems") ?? Object.keys(SEEDS).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
const override = (arg("packages") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const since = arg("since", "2025-06-01") as string;
const limit = Number(arg("limit", "2"));
const cap = Number(arg("cap", "1200"));
/**
 * The most application source a target may contain and still be admitted.
 *
 * A benchmark target should be reviewable WHOLE. The alternative — admit
 * anything and cut it down afterwards with rescope.ts — derives the surviving
 * subtree from the answer key, which quietly tells the reviewer "the bug is
 * somewhere in these files". That is a different, easier question wearing the
 * same name.
 *
 * The reference application is 2,670 lines. The 20 targets admitted before this
 * gate existed measured 45,786 to 194,065, and 13 of them had to be rescoped;
 * research/08 recorded what oversized targets do to the agent — a repository
 * logged as a host, modules logged as endpoints, and zero hypotheses recorded.
 *
 * 25,000 is deliberately generous: gotify/server is 12,435 and passes with room,
 * while every previously-admitted target fails. `--max-loc 0` disables the gate
 * for anyone who wants the old behaviour.
 */
const maxLoc = Number(arg("max-loc", "25000"));
const outRoot = arg("out", "/tmp/corpus-apps") as string;
const dry = flag("dry");
const only = arg("only", "");
// A global ceiling on built targets. Without it a two-advisory sweep across the
// whole seed list is ~140 working trees on disk, and run.ts keeps a pristine
// copy of each — the corpus would outgrow the machine before it was ever
// scanned. Stopping early is also how the seed list stays long: unproductive
// names cost nothing when the build has a budget.
const maxTargets = Number(arg("max", "0"));

/**
 * `--classify DIR` runs the admission rule against a checkout that is already on
 * disk and exits. It exists so the classifier can be tested against known
 * answers — the library targets it must reject, a web application it must admit
 * — without spending a clone, and so a rejection in a real run can be
 * reproduced afterwards instead of argued about.
 */
const classifyOnly = arg("classify");
if (classifyOnly) {
	const w = await walk(classifyOnly);
	const cls = await classify(classifyOnly, w);
	process.stdout.write(
		`${cls.app ? "APPLICATION" : "not an application"}  ${classifyOnly}\n` +
		`  routes: ${cls.routes} file(s)   templates: ${cls.templates}   migrations: ${cls.migrations}   server entry: ${cls.server}\n` +
		`  compose: ${cls.compose.length > 0 ? cls.compose.join(", ") : "none"}\n` +
		`  source files: ${w.source.length}   verdict: ${cls.why}\n`,
	);
	process.exit(cls.app ? 0 : 1);
}

await mkdir(outRoot, { recursive: true });
const workRoot = join(outRoot, ".work");
await mkdir(workRoot, { recursive: true });

interface ManifestEntry {
	id: string; package: string; ecosystem: string; published?: string;
	repo: string; sha: string; target: string; truth: string; entries: number;
	scope: string[]; scope_files: number; scope_loc: number; repo_files: number;
	surface: "direct" | "indirect"; routes: number;
	/** Compose files at or near the root — the dynamic corpus selects on these. */
	runnable: string[];
}

const manifest: ManifestEntry[] = await (async () => {
	try {
		return JSON.parse(await readFile(join(outRoot, "manifest.json"), "utf8")) as ManifestEntry[];
	} catch {
		return [];
	}
})();

const stats = { advisories: 0, cloned: 0, notApp: 0, tooBig: 0, noKey: 0, failed: 0, built: 0 };
const rejected: string[] = [];

process.stdout.write(
	`⦿ application corpus · ${ecosystems.join(", ")} · advisories since ${since}` +
	` · cap ${cap} source files${dry ? " · DRY RUN" : ""}\n\n`,
);

for (const ecosystem of ecosystems) {
	if (maxTargets > 0 && stats.built >= maxTargets) break;
	const packages = override.length > 0 ? override : (SEEDS[ecosystem] ?? []);
	for (const pkg of packages) {
		if (maxTargets > 0 && stats.built >= maxTargets) break;
		if (only && !pkg.includes(only)) continue;
		let advisories: Advisory[] = [];
		try {
			advisories = (await osvQuery(pkg, ecosystem))
				.filter((a) => (a.published ?? "") >= since)
				.filter((a) => (a.references ?? []).some((r) => COMMIT_RE.test(r.url)))
				.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
		} catch (err) {
			process.stdout.write(`${ecosystem}/${pkg}: OSV query failed — ${String((err as Error).message).slice(0, 70)}\n`);
			continue;
		}
		if (advisories.length === 0) continue;
		process.stdout.write(`${ecosystem}/${pkg} — ${advisories.length} candidate(s)\n`);
		stats.advisories += Math.min(advisories.length, limit);

		for (const adv of advisories.slice(0, limit)) {
			if (maxTargets > 0 && stats.built >= maxTargets) break;
			// Prefer the reference the advisory explicitly types FIX. An untyped
			// commit reference is often a release commit, and a release diff makes an
			// answer key with no vulnerability in it.
			const picked = fixReference(adv.references, COMMIT_RE);
			const ref = picked?.match;
			if (!ref) continue;
			const [, owner, repo, shortSha] = ref as unknown as [string, string, string, string];
			// Same reasoning as fetch.ts: the directory name is rendered in pired's
			// status line every frame, so the advisory id must not appear in it.
			const tag = [...adv.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36).slice(0, 6);
			const slug = `${repo}-${tag}`.replace(/[^\w.-]/g, "_");
			const work = join(workRoot, slug);
			const target = join(outRoot, slug);

			try {
				const sha = await resolveSha(owner, repo, shortSha);
				await rm(work, { recursive: true, force: true });
				await mkdir(work, { recursive: true });
				await run("git", ["-C", work, "init", "--quiet"], { timeout: 60_000 });
				await run("git", ["-C", work, "remote", "add", "origin", `https://github.com/${owner}/${repo}.git`], { timeout: 60_000 });
				await run("git", ["-C", work, "fetch", "--quiet", "--depth", "2", "origin", sha], { timeout: 900_000 });
				await run("git", ["-C", work, "checkout", "--quiet", `${sha}^1`], { timeout: 300_000 });
				stats.cloned += 1;

				const w = await walk(work);
				const cls = await classify(work, w);
				if (!cls.app) {
					stats.notApp += 1;
					rejected.push(`${adv.id} ${owner}/${repo}: ${cls.why}`);
					process.stdout.write(`  ${adv.id.padEnd(22)} REJECTED — ${cls.why}\n`);
					await rm(work, { recursive: true, force: true });
					continue;
				}

				// Size gate, before the answer key is computed.
				//
				// Deliberately measured over the WHOLE application and deliberately
				// placed ahead of keyFromPatch: if admission consulted the key, or the
				// key-derived scope, then whether a project is a valid target would
				// depend on where its bug happens to be. It must not.
				if (maxLoc > 0) {
					const wholeLoc = await countLines(work, w.source);
					if (wholeLoc > maxLoc) {
						stats.tooBig += 1;
						const why = `${wholeLoc.toLocaleString()} loc of source — over the ${maxLoc.toLocaleString()} cap, not reviewable whole`;
						rejected.push(`${adv.id} ${owner}/${repo}: ${why}`);
						process.stdout.write(`  ${adv.id.padEnd(22)} REJECTED — ${why}\n`);
						await rm(work, { recursive: true, force: true });
						continue;
					}
				}

				const key = refineKey(await keyFromPatch(work, sha, adv));
				if (key.length === 0) {
					stats.noKey += 1;
					process.stdout.write(`  ${adv.id.padEnd(22)} skipped — fix touches no source files\n`);
					await rm(work, { recursive: true, force: true });
					continue;
				}

				const scope = deriveScope(w.source, key, cap);
				const scopeFiles = scope.dirs.includes(".")
					? w.source
					: w.source.filter((f) => scope.dirs.some((d) => f.startsWith(`${d}/`)));
				const loc = await countLines(work, scopeFiles);
				const surface: "direct" | "indirect" = key.some((k) => SURFACE_RE.test(k.file)) ? "direct" : "indirect";

				if (dry) {
					process.stdout.write(
						`  ${adv.id.padEnd(22)} ${(adv.published ?? "").slice(0, 10)}  ${cls.routes} routes  ` +
						`key ${key.length} file(s)  ${surface}  scope ${scope.dirs.length}d [${scope.dirs.join(",").slice(0, 60)}] ` +
						`(${scopeFiles.length}/${w.source.length} files, ${loc.toLocaleString()} loc)${scope.overCap ? " OVER-CAP" : ""}\n`,
					);
					stats.built += 1;
					await rm(work, { recursive: true, force: true });
					continue;
				}

				await rm(target, { recursive: true, force: true });
				await run("cp", ["-r", work, target]);
				const removed = await stripLeakage(target, adv);
				await rm(work, { recursive: true, force: true });

				// Inherited from fetch.ts, and non-negotiable: a key pointing at a file
				// the target no longer contains is a guaranteed false negative that says
				// nothing about the harness. The leak filter once deleted the very source
				// file holding the bug.
				const missing: string[] = [];
				for (const e of key) {
					if (!(await stat(join(target, e.file)).catch(() => undefined))) missing.push(e.file);
				}
				if (missing.length > 0) {
					process.stdout.write(`  ${adv.id.padEnd(22)} REJECTED — key points at missing file(s): ${missing.join(", ")}\n`);
					await rm(target, { recursive: true, force: true });
					continue;
				}

				const truthPath = join(outRoot, `${slug}.truth.json`);
				await writeFile(truthPath, `${JSON.stringify(key, null, 2)}\n`);
				const entry: ManifestEntry = {
					id: adv.id, package: pkg, ecosystem, published: adv.published?.slice(0, 10),
					repo: `${owner}/${repo}`, sha, target, truth: truthPath, entries: key.length,
					scope: scope.dirs, scope_files: scopeFiles.length, scope_loc: loc,
					repo_files: w.source.length, surface, routes: cls.routes, runnable: cls.compose,
				};
				// Keyed on the target directory, not (id, package). A Go module that has
				// bumped its major version appears in the seed list as both
				// .../argo-cd/v2 and .../argo-cd/v3, and OSV returns the same advisory
				// for both — two manifest rows pointing at one directory, which
				// double-counts that bug in every pooled recall computed afterwards.
				const i = manifest.findIndex((m) => m.target === entry.target);
				if (i >= 0) manifest[i] = entry;
				else manifest.push(entry);
				await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
				stats.built += 1;
				process.stdout.write(
					`  ${adv.id.padEnd(22)} ${(adv.published ?? "").slice(0, 10)}  ${owner}/${repo}@${sha.slice(0, 8)}  ` +
					`${key.length} truth entr${key.length === 1 ? "y" : "ies"}  ${surface}${cls.compose.length > 0 ? " runnable" : ""}  ` +
					`scope ${scope.dirs.length}d (${scopeFiles.length} files, ${loc.toLocaleString()} loc)  ${removed} leak(s) stripped\n`,
				);
			} catch (err) {
				stats.failed += 1;
				process.stdout.write(`  ${adv.id.padEnd(22)} FAILED — ${String((err as Error).message).slice(0, 100)}\n`);
				await rm(work, { recursive: true, force: true });
			}
		}
	}
}

await rm(workRoot, { recursive: true, force: true });
process.stdout.write(
	`\n⦿ yield: ${stats.built} target(s) from ${stats.cloned} clone(s)` +
	` · ${stats.notApp} not an application · ${stats.tooBig} over the size cap · ${stats.noKey} no source in fix · ${stats.failed} failed\n`,
);
if (!dry) process.stdout.write(`targets under ${outRoot} · manifest.json lists them\n`);
