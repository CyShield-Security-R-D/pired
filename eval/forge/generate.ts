/**
 * The generator: seed in, target tree + answer key out.
 *
 * A route exercises one or two weakness classes, the way real handlers do. The
 * remaining classes on that route are genuinely `clear` — there is no such sink
 * on the path — and the key says so with a reason, which is what lets a correct
 * refutation be scored rather than merely unpunished. Classes that cannot apply
 * at all (XSS on a JSON-only route) are `n/a`, giving the checklist's own
 * `appliesTo` annotations an external check.
 *
 * Sink line numbers are recovered by searching the finished file for a marker
 * substring. Nothing is written into the tree to mark them: a generated
 * "# vulnerable here" comment would be the exact artifact leak the audit exists
 * to catch.
 */

import type { AnswerKey, KeyCell } from "../key.ts";
import { PYTHON_FLASK } from "./templates/python-flask.ts";
import type { ForgeSpec, Route, SiteRecord, VulnClass, VulnTemplate } from "./types.ts";
import { VULN_CLASSES } from "./types.ts";

/** Deterministic PRNG — a seed reproduces a target exactly. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Ordinary application handlers with no security-relevant sink. Real apps are
 * mostly boring CRUD, and without them a Forge target is 100% juicy routes —
 * unrealistic, and it leaves the artifact audit nothing to compare against. The
 * audit's real question is whether a template-rendered site stands out from
 * ordinary code at the same granularity, and this is that ordinary code.
 */
const FILLER_BODIES = [
	(p: string) => `    page = int(request.args.get("page", 1))\n    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id FROM ${p} LIMIT 20 OFFSET ?", ((page - 1) * 20,)).fetchall()\n    return jsonify({"page": page, "items": rows})`,
	(p: string) => `    con = sqlite3.connect(DB_PATH)\n    total = con.execute("SELECT COUNT(*) FROM ${p}").fetchone()[0]\n    return jsonify({"count": total})`,
	(p: string) => `    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id, created_at FROM ${p} ORDER BY created_at DESC LIMIT 10").fetchall()\n    return jsonify([{"id": r[0], "created_at": r[1]} for r in rows])`,
	(_p: string) => `    return jsonify({"status": "ok", "version": os.environ.get("APP_VERSION", "1.0")})`,
];

const NOUNS = ["orders", "invoices", "reports", "profiles", "tickets", "exports", "records", "batches", "accounts", "sessions"];
const PARAMS = ["name", "q", "ref", "target", "label", "filename", "account", "amount", "oid", "token"];

function pick<T>(rng: () => number, xs: readonly T[]): T {
	return xs[Math.floor(rng() * xs.length)] as T;
}

function makeRoutes(rng: () => number, count: number): Route[] {
	const used = new Set<string>();
	const routes: Route[] = [];
	while (routes.length < count) {
		const noun = pick(rng, NOUNS);
		const style = rng();
		const path = style < 0.4 ? `/api/${noun}` : style < 0.7 ? `/api/${noun}/<ref>` : `/api/${noun}/search`;
		if (used.has(path)) continue;
		used.add(path);
		const method: Route["method"] = path.endsWith("<ref>") ? "GET" : rng() < 0.5 ? "GET" : "POST";
		routes.push({
			method,
			path,
			handler: `${noun}_${routes.length}`,
			param: path.includes("<ref>") ? "ref" : pick(rng, PARAMS),
			jsonOnly: rng() < 0.6,
		});
	}
	return routes;
}

const PACKS: Record<string, VulnTemplate[]> = { "python-flask": PYTHON_FLASK };

export interface ForgeTarget {
	/** Handler bodies rendered from templates — the audit's positive class. */
	siteBodies: string[];
	/** Ordinary handler bodies — the audit's negative class. */
	fillerBodies: string[];
	spec: ForgeSpec;
	/** Relative path -> file content. */
	files: Record<string, string>;
	key: AnswerKey;
	sites: SiteRecord[];
}

export function generate(spec: ForgeSpec): ForgeTarget {
	const rng = mulberry32(spec.seed);
	const pack = PACKS[spec.stack];
	if (!pack) throw new Error(`forge: no template pack for stack ${spec.stack}`);

	const fillerCount = spec.fillerRoutes ?? spec.routes;
	const routes = makeRoutes(rng, spec.routes + fillerCount);
	const fillers = routes.splice(spec.routes);
	const siteBodies: string[] = [];
	const fillerBodies: string[] = [];
	const cells: KeyCell[] = [];
	const sites: SiteRecord[] = [];
	const handlerBlocks: string[] = [];
	const helperBlocks: string[] = [];
	const extraFiles: Record<string, string> = {};

	for (const route of routes) {
		const available = pack.filter((t) => !(t.class === "xss" && route.jsonOnly));
		const activeCount = rng() < 0.5 ? 1 : 2;
		const active: VulnTemplate[] = [];
		while (active.length < Math.min(activeCount, available.length)) {
			const t = pick(rng, available);
			if (!active.includes(t)) active.push(t);
		}

		const bodies: string[] = [];
		for (const template of active) {
			const isVuln = rng() < spec.vulnRate;
			const taintDepth = Math.floor(rng() * (spec.maxTaintDepth + 1));
			const ctx = { route, taintDepth, rng };
			const site = isVuln ? template.vulnerable(ctx) : template.safe(ctx);
			bodies.push(site.body);
			siteBodies.push(site.body);
			if (site.helpers) helperBlocks.push(site.helpers);
			if (site.extraFile) extraFiles[site.extraFile.path] = site.extraFile.content;
			sites.push({
				route, class: template.class, idiom: template.idiom, vulnerable: isVuln,
				taintDepth, file: "app.py", sinkMarker: site.sinkMarker,
				severity: template.severity, safeReason: template.safeReason,
			});
			cells.push({
				element: `${route.method} ${route.path}`,
				class: template.class,
				truth: isVuln ? "vulnerable" : "clear",
				...(isVuln ? { sink: "app.py:0" } : { why: template.safeReason }),
				severity: template.severity,
				aliases: [route.path, route.handler],
				strata: { stack: spec.stack, idiom: template.idiom, taint: `depth-${taintDepth}` },
			});
		}

		// Classes with no site on this route: genuinely clear, or structurally n/a.
		for (const cls of VULN_CLASSES) {
			if (active.some((t) => t.class === cls)) continue;
			const inapplicable = cls === "xss" && route.jsonOnly;
			cells.push({
				element: `${route.method} ${route.path}`,
				class: cls as VulnClass,
				truth: inapplicable ? "n/a" : "clear",
				...(inapplicable ? {} : { why: `no ${cls} sink is reachable from this handler` }),
				aliases: [route.path, route.handler],
				strata: { stack: spec.stack, idiom: "absent-sink", taint: "n/a" },
			});
		}

		const decorator = `@app.route("${route.path}", methods=["${route.method}"])`;
		handlerBlocks.push(`${decorator}\ndef ${route.handler}(${route.path.includes("<ref>") ? "ref" : ""}):\n${bodies.join("\n")}\n`);
	}

	// Filler routes: ordinary work, and genuinely clear for every class.
	for (const route of fillers) {
		const body = (FILLER_BODIES[Math.floor(rng() * FILLER_BODIES.length)] as (p: string) => string)(
			route.path.split("/")[2] ?? "records",
		);
		fillerBodies.push(body);
		handlerBlocks.push(
			`@app.route("${route.path}", methods=["${route.method}"])\ndef ${route.handler}(${route.path.includes("<ref>") ? "ref" : ""}):\n${body}\n`,
		);
		for (const cls of VULN_CLASSES) {
			cells.push({
				element: `${route.method} ${route.path}`,
				class: cls as VulnClass,
				truth: cls === "xss" && route.jsonOnly ? "n/a" : "clear",
				...(cls === "xss" && route.jsonOnly ? {} : { why: "ordinary read-only handler; no untrusted value reaches a sink" }),
				aliases: [route.path, route.handler],
				strata: { stack: spec.stack, idiom: "filler", taint: "n/a" },
			});
		}
	}

	const appPy = [
		"import os",
		"import sqlite3",
		"import subprocess",
		"",
		"from flask import Flask, abort, jsonify, render_template_string, request, session",
		"",
		"app = Flask(__name__)",
		'app.secret_key = os.environ.get("APP_SECRET", "dev")',
		'DB_PATH = os.environ.get("DB_PATH", "app.db")',
		'STORAGE_ROOT = os.path.realpath(os.environ.get("STORAGE_ROOT", "/srv/storage"))',
		"",
		"",
		...dedupe(helperBlocks),
		"",
		...handlerBlocks,
	].join("\n");

	const files: Record<string, string> = { "app.py": appPy, ...extraFiles };

	// Recover sink lines from the finished text — no markers were written into it.
	// The search starts at the site's OWN handler: two routes can render the same
	// sink text, and a naive first-match would give them both the first line,
	// making the key's ground truth wrong for every instance after the first.
	const lines = appPy.split("\n");
	for (const cell of cells) {
		if (cell.truth !== "vulnerable") continue;
		const site = sites.find(
			(s) => `${s.route.method} ${s.route.path}` === cell.element && s.class === cell.class && s.vulnerable,
		);
		if (!site) continue;
		const handlerLine = lines.findIndex((l) => l.startsWith(`def ${site.route.handler}(`));
		const from = handlerLine >= 0 ? handlerLine : 0;
		const offset = lines.slice(from).findIndex((l) => l.includes(site.sinkMarker));
		cell.sink = offset >= 0 ? `app.py:${from + offset + 1}` : "app.py:unresolved";
	}

	return {
		spec,
		files,
		sites,
		siteBodies,
		fillerBodies,
		key: {
			v: 1,
			target: `forge/${spec.stack}/${spec.seed}`,
			surfaceKinds: ["endpoint"],
			cells,
		},
	};
}

function dedupe(blocks: string[]): string[] {
	return [...new Set(blocks)];
}
