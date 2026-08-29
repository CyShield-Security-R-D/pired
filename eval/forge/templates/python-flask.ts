/**
 * Flask template pack.
 *
 * Each entry renders a vulnerable site and a matched safe site. They share
 * naming, structure and comment density (none) so the only difference between
 * them is the security property — which is what stops a detector learning
 * "generated-looking code is vulnerable" instead of learning the bug.
 *
 * Taint depth controls how far the source sits from the sink: 0 inline, 1 via a
 * same-module helper, 2 via a helper in another module. That is the difficulty
 * dial, and it is the axis on which a regex and a taint-tracer diverge.
 */

import type { RenderCtx, SiteRender, VulnTemplate } from "../types.ts";

/** Route the tainted value through `depth` helper hops, returning the expression to use. */
function hop(ctx: RenderCtx, expr: string, slug: string): { expr: string; helpers?: string; extraFile?: SiteRender["extraFile"] } {
	if (ctx.taintDepth <= 0) return { expr };
	// Helper names carry the depth. Two routes using the same class at different
	// depths would otherwise define the same symbol twice and Python would keep
	// only the last, silently collapsing a depth-2 path into a depth-1 one.
	const fn = `_prepare_${slug}_d${ctx.taintDepth}`;
	if (ctx.taintDepth === 1) {
		return {
			expr: `${fn}(${expr})`,
			helpers: `def ${fn}(value):\n    trimmed = value.strip() if value else value\n    return trimmed\n`,
		};
	}
	// Absolute import: app.py is a script, not a package module, so a relative
	// import would make the target unloadable — and an unrunnable target cannot
	// support the dynamic track later.
	return {
		expr: `${fn}(${expr})`,
		helpers: `from support_${slug} import normalize_${slug}\n\n\ndef ${fn}(value):\n    return normalize_${slug}(value)\n`,
		extraFile: {
			path: `support_${slug}.py`,
			content: `def normalize_${slug}(value):\n    if value is None:\n        return value\n    return value.strip()\n`,
		},
	};
}

const source = (ctx: RenderCtx): string =>
	ctx.route.path.includes("<") ? ctx.route.param : `request.args.get("${ctx.route.param}")`;

export const PYTHON_FLASK: VulnTemplate[] = [
	{
		class: "sqli",
		stack: "python-flask",
		idiom: "string-built-query",
		severity: "critical",
		safeReason: "the query is parameterized; the tainted value is bound, never concatenated into SQL",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "sql");
			return {
				body: `    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id, name FROM records WHERE name = '" + ${h.expr} + "'").fetchall()\n    return jsonify(rows)`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `"SELECT id, name FROM records WHERE name = '" +`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "sql");
			return {
				body: `    con = sqlite3.connect(DB_PATH)\n    rows = con.execute("SELECT id, name FROM records WHERE name = ?", (${h.expr},)).fetchall()\n    return jsonify(rows)`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `"SELECT id, name FROM records WHERE name = ?"`,
			};
		},
	},
	{
		class: "cmdi",
		stack: "python-flask",
		idiom: "shell-string",
		severity: "critical",
		safeReason: "the command is an argv list with shell=False, so the tainted value cannot become shell syntax",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "cmd");
			return {
				body: `    archive = ${h.expr}\n    subprocess.run("tar czf /tmp/bundle.tgz " + archive, shell=True)\n    return jsonify({"status": "queued"})`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `subprocess.run("tar czf /tmp/bundle.tgz " + archive, shell=True)`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "cmd");
			return {
				body: `    archive = ${h.expr}\n    subprocess.run(["tar", "czf", "/tmp/bundle.tgz", archive], shell=False)\n    return jsonify({"status": "queued"})`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `subprocess.run(["tar", "czf", "/tmp/bundle.tgz", archive], shell=False)`,
			};
		},
	},
	{
		class: "pathtrav",
		stack: "python-flask",
		idiom: "unvalidated-join",
		severity: "high",
		safeReason: "the resolved path is checked to stay under the storage root before it is opened",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "path");
			return {
				body: `    target = os.path.join(STORAGE_ROOT, ${h.expr})\n    with open(target, "rb") as fh:\n        return fh.read()`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `target = os.path.join(STORAGE_ROOT, `,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "path");
			return {
				body: `    target = os.path.realpath(os.path.join(STORAGE_ROOT, ${h.expr}))\n    if not target.startswith(STORAGE_ROOT + os.sep):\n        abort(404)\n    with open(target, "rb") as fh:\n        return fh.read()`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `if not target.startswith(STORAGE_ROOT + os.sep):`,
			};
		},
	},
	{
		class: "xss",
		stack: "python-flask",
		idiom: "unescaped-render",
		severity: "medium",
		safeReason: "the value is rendered through the template engine's autoescaping context, not marked safe",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "html");
			return {
				body: `    label = ${h.expr}\n    return render_template_string("<div class='banner'>" + label + "</div>")`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `render_template_string("<div class='banner'>" + label + "</div>")`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "html");
			return {
				body: `    label = ${h.expr}\n    return render_template_string("<div class='banner'>{{ label }}</div>", label=label)`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `"<div class='banner'>{{ label }}</div>", label=label`,
			};
		},
	},
	{
		class: "idor",
		stack: "python-flask",
		idiom: "missing-ownership-check",
		severity: "high",
		safeReason: "the row is scoped to the session's account, so another tenant's id returns nothing",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "idor");
			return {
				body: `    con = sqlite3.connect(DB_PATH)\n    row = con.execute("SELECT id, owner, total FROM orders WHERE id = ?", (${h.expr},)).fetchone()\n    return jsonify(row)`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `"SELECT id, owner, total FROM orders WHERE id = ?"`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "idor");
			return {
				body: `    con = sqlite3.connect(DB_PATH)\n    row = con.execute("SELECT id, owner, total FROM orders WHERE id = ? AND owner = ?", (${h.expr}, session.get("account"))).fetchone()\n    return jsonify(row)`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `"SELECT id, owner, total FROM orders WHERE id = ? AND owner = ?"`,
			};
		},
	},
	{
		class: "logic",
		stack: "python-flask",
		idiom: "unbounded-amount",
		severity: "high",
		safeReason: "the amount is validated as positive and bounded by the available balance before the ledger is written",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "amount");
			return {
				body: `    amount = float(${h.expr})\n    con = sqlite3.connect(DB_PATH)\n    con.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", (amount, session.get("account")))\n    con.commit()\n    return jsonify({"debited": amount})`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `con.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", (amount, session.get("account")))`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "amount");
			return {
				body: `    amount = float(${h.expr})\n    con = sqlite3.connect(DB_PATH)\n    balance = con.execute("SELECT balance FROM accounts WHERE id = ?", (session.get("account"),)).fetchone()[0]\n    if amount <= 0 or amount > balance:\n        abort(400)\n    con.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", (amount, session.get("account")))\n    con.commit()\n    return jsonify({"debited": amount})`,
				helpers: h.helpers,
				extraFile: h.extraFile,
				sinkMarker: `if amount <= 0 or amount > balance:`,
			};
		},
	},
];
