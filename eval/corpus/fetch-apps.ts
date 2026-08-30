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

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { COMMIT_RE, NON_SOURCE, SOURCE_EXT, deriveScope, keyFromPatch, osvQuery, refineKey, resolveSha, run, stripLeakage } from "./lib.ts";
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
 * A route registration is the one signal a library cannot fake.
 *
 * jinja2 has templates, sqlparse has a parser, requests has sessions — none of
 * them register a URL against a handler, because none of them serve anything.
 * That makes route density the discriminator, and everything else corroboration.
 */
// A quote of any kind. Route paths are string literals and the opening quote is
// half of what separates a route registration from an ordinary method call.
const Q = "[\"'`]";

const ROUTE_RE = [
	// Flask/FastAPI/Sanic/Quart decorators. The variable is whatever the project
	// named it — `@auth_bp.route`, `@v2.post` — so matching literal `app` or
	// `router` finds nothing in real code. DVBank, a web application built for
	// this evaluation, scored 0 route files against the literal version.
	String.raw`@\w+\.route\(`,
	// The verb forms need the path literal as corroboration, or `@mock.patch(`
	// and every other decorator whose name collides with an HTTP method counts as
	// a route.
	String.raw`@\w+\.(get|post|put|delete|patch|websocket)\(\s*` + Q + "/",
	String.raw`urlpatterns\s*=`,
	// Express/Koa/Nest and friends. Same rule: a leading slash in the first
	// argument is what tells `router.get("/users")` apart from `config.get("key")`
	// and `session.get("https://...")`, which otherwise turn every library that
	// makes an HTTP request into an "application".
	String.raw`\b\w+\.(get|post|put|delete|patch|all|use)\(\s*` + Q + "/",
	String.raw`@(Get|Post|Put|Delete|Patch|Controller)\(`,
	// Go: uppercase verbs plus a quoted path.
	String.raw`\b\w+\.(GET|POST|PUT|DELETE|PATCH|Any|Handle|HandleFunc)\(\s*"/`,
	// Rails config/routes.rb
	String.raw`^\s*(get|post|put|delete|patch|resources|namespace)\s+["':]`,
	// Laravel, CodeIgniter, Symfony
	String.raw`Route::(get|post|put|delete|any|resource|group|middleware)`,
	String.raw`\$routes->(get|post|put|delete|add)`,
	String.raw`#\[Route\(`,
	String.raw`@Route\(`,
	// Spring / Servlet / ASP.NET
	String.raw`@(RestController|Controller|RequestMapping|GetMapping|PostMapping|WebServlet)`,
	String.raw`\[(HttpGet|HttpPost|HttpPut|Route)\(`,
].join("|");

const VENDORED = /(^|\/)(node_modules|vendor|third_party|\.git|dist|build|\.venv|site-packages)(\/|$)/;
const TEMPLATE_RE = /(^|\/)(templates?|views?|layouts)(\/|$)|\.(html|htm|j2|jinja2?|tmpl|gohtml|erb|blade\.php|twig|hbs|ejs)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|migrate|alembic|Migrations)(\/|$)/i;
const SERVER_RE = /(^|\/)(manage\.py|wsgi\.py|asgi\.py|routes\.rb|server\.(js|ts|go)|main\.go|Dockerfile|docker-compose\.ya?ml|index\.php|artisan)$/i;

/**
 * Paths that carry the request-handling surface. Used only to tier a target, not
 * to admit or reject one: a bug in `models/user.go` reachable from a route is a
 * perfectly real application bug, it is simply not the case the coverage model
 * is most directly built to catch, and the two should be distinguishable in the
 * results rather than blended.
 */
const SURFACE_RE = /(^|\/)(routes?|routers?|controllers?|views?|handlers?|api|endpoints?|middlewares?|serializers?|forms?|resources?|permissions?|policies|acl|auth\w*|security|session\w*)(\/|_|\.|$)/i;

interface Walk { all: string[]; source: string[] }

async function walk(root: string): Promise<Walk> {
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

interface Classification { app: boolean; routes: number; templates: boolean; migrations: boolean; server: boolean; why: string }

async function classify(dir: string, w: Walk): Promise<Classification> {
	// grep exits 1 on "no match", which execFile reports as a failure; that is a
	// zero, not an error.
	let routes = 0;
	try {
		const { stdout } = await run(
			"grep",
			["-rlE", "--binary-files=without-match",
				"--exclude-dir=node_modules", "--exclude-dir=vendor", "--exclude-dir=.git",
				"--exclude-dir=third_party", "--exclude-dir=dist", "--exclude-dir=test",
				"--exclude-dir=tests", "--exclude-dir=docs", "--exclude-dir=doc",
				"--exclude-dir=examples", "--exclude-dir=example", ROUTE_RE, "."],
			{ cwd: dir, maxBuffer: 1 << 26, timeout: 300_000 },
		);
		routes = stdout.split("\n").filter(Boolean).length;
	} catch { /* no match, or grep gave up: treated as no evidence */ }

	const templates = w.all.some((f) => TEMPLATE_RE.test(f));
	const migrations = w.all.some((f) => MIGRATION_RE.test(f));
	const server = w.all.some((f) => SERVER_RE.test(f));
	const corroborated = [templates, migrations, server].filter(Boolean).length;

	// Three route files, not one: a library can carry a single incidental match in
	// an example or a dev helper. Three is a routing table.
	const app = routes >= 3 && corroborated >= 1;
	const why = app
		? `${routes} route file(s)` + (templates ? ", templates" : "") + (migrations ? ", migrations" : "") + (server ? ", server entry" : "")
		: routes < 3 ? `only ${routes} route file(s) — not a served application` : "routes but no templates/migrations/server entry";
	return { app, routes, templates, migrations, server, why };
}

async function countLines(root: string, files: string[]): Promise<number> {
	let total = 0;
	for (const f of files) {
		const text = await readFile(join(root, f), "utf8").catch(() => "");
		total += text.length === 0 ? 0 : text.split("\n").length;
	}
	return total;
}

// --- main -------------------------------------------------------------------

const ecosystems = (arg("ecosystems") ?? Object.keys(SEEDS).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
const override = (arg("packages") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const since = arg("since", "2025-06-01") as string;
const limit = Number(arg("limit", "2"));
const cap = Number(arg("cap", "1200"));
const outRoot = arg("out", "/tmp/corpus-apps") as string;
const dry = flag("dry");
const only = arg("only", "");

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
}

const manifest: ManifestEntry[] = await (async () => {
	try {
		return JSON.parse(await readFile(join(outRoot, "manifest.json"), "utf8")) as ManifestEntry[];
	} catch {
		return [];
	}
})();

const stats = { advisories: 0, cloned: 0, notApp: 0, noKey: 0, failed: 0, built: 0 };
const rejected: string[] = [];

process.stdout.write(
	`⦿ application corpus · ${ecosystems.join(", ")} · advisories since ${since}` +
	` · cap ${cap} source files${dry ? " · DRY RUN" : ""}\n\n`,
);

for (const ecosystem of ecosystems) {
	const packages = override.length > 0 ? override : (SEEDS[ecosystem] ?? []);
	for (const pkg of packages) {
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
			const ref = (adv.references ?? []).map((r) => COMMIT_RE.exec(r.url)).find(Boolean);
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
					repo_files: w.source.length, surface, routes: cls.routes,
				};
				const i = manifest.findIndex((m) => m.id === entry.id && m.package === entry.package);
				if (i >= 0) manifest[i] = entry;
				else manifest.push(entry);
				await writeFile(join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
				stats.built += 1;
				process.stdout.write(
					`  ${adv.id.padEnd(22)} ${(adv.published ?? "").slice(0, 10)}  ${owner}/${repo}@${sha.slice(0, 8)}  ` +
					`${key.length} truth entr${key.length === 1 ? "y" : "ies"}  ${surface}  ` +
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
	` · ${stats.notApp} not an application · ${stats.noKey} no source in fix · ${stats.failed} failed\n`,
);
if (!dry) process.stdout.write(`targets under ${outRoot} · manifest.json lists them\n`);
