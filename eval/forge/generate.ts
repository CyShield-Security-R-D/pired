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
import { NODE_EXPRESS } from "./templates/node-express.ts";
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

function makeRoutes(rng: () => number, count: number, paramStyle: "flask" | "express"): Route[] {
	const used = new Set<string>();
	const routes: Route[] = [];
	while (routes.length < count) {
		const noun = pick(rng, NOUNS);
		const style = rng();
		const refToken = paramStyle === "express" ? ":ref" : "<ref>";
		const path = style < 0.4 ? `/api/${noun}` : style < 0.7 ? `/api/${noun}/${refToken}` : `/api/${noun}/search`;
		if (used.has(path)) continue;
		used.add(path);
		const method: Route["method"] = path.endsWith(refToken) ? "GET" : rng() < 0.5 ? "GET" : "POST";
		routes.push({
			method,
			path,
			handler: `${noun}_${routes.length}`,
			param: path.includes(refToken) ? "ref" : pick(rng, PARAMS),
			jsonOnly: rng() < 0.6,
		});
	}
	return routes;
}

/**
 * Per-stack assembly. Everything Python-specific used to be inline here, which
 * meant a second stack could not exist — and a single-stack corpus cannot report
 * the cross-stratum spread that says whether competence is stack-specific.
 */
interface StackSpec {
	pack: VulnTemplate[];
	mainFile: string;
	/** Filler handler bodies: ordinary work, no security-relevant sink. */
	filler: Array<(noun: string) => string>;
	handlerBlock(route: Route, body: string): string;
	/** How a handler's definition line starts, for scoping the sink search. */
	defLine(handler: string): string;
	assemble(helpers: string[], handlers: string[]): string;
}

const STACKS: Record<string, StackSpec> = {
	"python-flask": {
		pack: PYTHON_FLASK,
		mainFile: "app.py",
		filler: [
			(n) => `    page = int(request.args.get("page", 1))\n    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id FROM ${n} LIMIT 20 OFFSET ?", ((page - 1) * 20,)).fetchall()\n    return jsonify({"page": page, "items": rows})`,
			(n) => `    con = sqlite3.connect(DB_PATH)\n    total = con.execute("SELECT COUNT(*) FROM ${n}").fetchone()[0]\n    return jsonify({"count": total})`,
			(n) => `    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id, created_at FROM ${n} ORDER BY created_at DESC LIMIT 10").fetchall()\n    return jsonify([{"id": r[0], "created_at": r[1]} for r in rows])`,
			() => `    return jsonify({"status": "ok", "version": os.environ.get("APP_VERSION", "1.0")})`,
		],
		handlerBlock: (route, body) =>
			`@app.route("${route.path}", methods=["${route.method}"])\ndef ${route.handler}(${route.path.includes("<ref>") ? "ref" : ""}):\n${body}\n`,
		defLine: (handler) => `def ${handler}(`,
		assemble: (helpers, handlers) => [
			"import os", "import sqlite3", "import subprocess", "",
			"from flask import Flask, abort, jsonify, render_template_string, request, session", "",
			"app = Flask(__name__)",
			'app.secret_key = os.environ.get("APP_SECRET", "dev")',
			'DB_PATH = os.environ.get("DB_PATH", "app.db")',
			'STORAGE_ROOT = os.path.realpath(os.environ.get("STORAGE_ROOT", "/srv/storage"))',
			"", "", ...helpers, "", ...handlers,
		].join("\n"),
	},
	"node-express": {
		pack: NODE_EXPRESS,
		mainFile: "app.js",
		filler: [
			(n) => `  const page = Number(req.query.page || 1);\n  const rows = await db.query("SELECT id FROM ${n} LIMIT 20 OFFSET $1", [(page - 1) * 20]);\n  res.json({ page, items: rows });`,
			(n) => `  const rows = await db.query("SELECT COUNT(*) AS n FROM ${n}");\n  res.json({ count: rows[0].n });`,
			(n) => `  const rows = await db.query("SELECT id, created_at FROM ${n} ORDER BY created_at DESC LIMIT 10");\n  res.json(rows);`,
			() => `  res.json({ status: "ok", version: process.env.APP_VERSION || "1.0" });`,
		],
		handlerBlock: (route, body) =>
			`app.${route.method.toLowerCase()}("${route.path}", async (req, res) => {\n${body}\n});\n`,
		defLine: (handler) => `// handler ${handler}`,
		assemble: (helpers, handlers) => [
			'const express = require("express");',
			'const path = require("path");',
			'const fs = require("fs/promises");',
			'const { exec, execFile } = require("child_process");',
			'const db = require("./db");', "",
			"const app = express();",
			'const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || "/srv/storage");', "",
			"function escapeHtml(value) {",
			'  return String(value).replace(/[&<>"\']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" })[c]);',
			"}", "", ...helpers, "", ...handlers, "", "module.exports = app;",
		].join("\n"),
	},
};

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
	const stack = STACKS[spec.stack];
	if (!stack) throw new Error(`forge: no template pack for stack ${spec.stack}`);
	const pack = stack.pack;

	const fillerCount = spec.fillerRoutes ?? spec.routes;
	const routes = makeRoutes(rng, spec.routes + fillerCount, spec.stack === "node-express" ? "express" : "flask");
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
				taintDepth, file: stack.mainFile, sinkMarker: site.sinkMarker,
				severity: template.severity, safeReason: template.safeReason,
			});
			cells.push({
				element: `${route.method} ${route.path}`,
				class: template.class,
				truth: isVuln ? "vulnerable" : "clear",
				...(isVuln ? { sink: `${stack.mainFile}:0` } : { why: template.safeReason }),
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

		handlerBlocks.push(stack.handlerBlock(route, bodies.join("\n")));
	}

	// Filler routes: ordinary work, and genuinely clear for every class.
	for (const route of fillers) {
		const body = (stack.filler[Math.floor(rng() * stack.filler.length)] as (n: string) => string)(
			route.path.split("/")[2] ?? "records",
		);
		fillerBodies.push(body);
		handlerBlocks.push(stack.handlerBlock(route, body));
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

	const mainSource = stack.assemble(dedupe(helperBlocks), handlerBlocks);

	const files: Record<string, string> = { [stack.mainFile]: mainSource, ...extraFiles };

	// Recover sink lines from the finished text — no markers were written into it.
	// The search starts at the site's OWN handler: two routes can render the same
	// sink text, and a naive first-match would give them both the first line,
	// making the key's ground truth wrong for every instance after the first.
	const lines = mainSource.split("\n");
	for (const cell of cells) {
		if (cell.truth !== "vulnerable") continue;
		const site = sites.find(
			(s) => `${s.route.method} ${s.route.path}` === cell.element && s.class === cell.class && s.vulnerable,
		);
		if (!site) continue;
		const handlerLine = lines.findIndex((l) => l.includes(stack.defLine(site.route.handler)) || l.includes(`"${site.route.path}"`));
		const from = handlerLine >= 0 ? handlerLine : 0;
		const offset = lines.slice(from).findIndex((l) => l.includes(site.sinkMarker));
		cell.sink = offset >= 0 ? `${stack.mainFile}:${from + offset + 1}` : `${stack.mainFile}:unresolved`;
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
