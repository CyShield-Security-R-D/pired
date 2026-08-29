/**
 * Express template pack — the second stack, so stratified reporting has more
 * than one stratum to compare.
 *
 * Node earns first place in the stratification weighting: roughly half of
 * surveyed developers report using it server-side. It also exercises idioms
 * Flask cannot — taint crossing an async boundary, and a template literal that
 * looks safe but is not — which is the point of the idiom axis. A harness can
 * be strong on synchronous Python taint and blind to the same bug behind an
 * await.
 */

import type { RenderCtx, SiteRender, VulnTemplate } from "../types.ts";

function hop(ctx: RenderCtx, expr: string, slug: string): { expr: string; helpers?: string; extraFile?: SiteRender["extraFile"] } {
	if (ctx.taintDepth <= 0) return { expr };
	const fn = `prepare${slug}D${ctx.taintDepth}`;
	if (ctx.taintDepth === 1) {
		return {
			expr: `${fn}(${expr})`,
			helpers: `function ${fn}(value) {\n  return typeof value === "string" ? value.trim() : value;\n}\n`,
		};
	}
	// Depth 2 crosses an async boundary as well as a module boundary: taint
	// through a promise is where single-pass reading tends to lose the thread.
	return {
		expr: `await ${fn}(${expr})`,
		helpers: `const { normalize${slug} } = require("./support-${slug.toLowerCase()}");\n\nasync function ${fn}(value) {\n  return normalize${slug}(value);\n}\n`,
		extraFile: {
			path: `support-${slug.toLowerCase()}.js`,
			content: `async function normalize${slug}(value) {\n  if (value == null) return value;\n  return String(value).trim();\n}\n\nmodule.exports = { normalize${slug} };\n`,
		},
	};
}

const source = (ctx: RenderCtx): string =>
	ctx.route.path.includes(":") ? `req.params.${ctx.route.param}` : `req.query.${ctx.route.param}`;

export const NODE_EXPRESS: VulnTemplate[] = [
	{
		class: "sqli",
		stack: "node-express",
		idiom: "template-literal-query",
		severity: "critical",
		safeReason: "the query uses a bound placeholder; the tainted value is passed as a parameter, never interpolated",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Sql");
			return {
				body: `  const name = ${h.expr};\n  const rows = await db.query(\`SELECT id, name FROM records WHERE name = '\${name}'\`);\n  res.json(rows);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "SELECT id, name FROM records WHERE name = '${name}'",
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Sql");
			return {
				body: `  const name = ${h.expr};\n  const rows = await db.query("SELECT id, name FROM records WHERE name = $1", [name]);\n  res.json(rows);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: `db.query("SELECT id, name FROM records WHERE name = $1", [name])`,
			};
		},
	},
	{
		class: "cmdi",
		stack: "node-express",
		idiom: "exec-string",
		severity: "critical",
		safeReason: "execFile takes an argv array, so the tainted value cannot be reinterpreted as shell syntax",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Cmd");
			return {
				body: `  const archive = ${h.expr};\n  exec(\`tar czf /tmp/bundle.tgz \${archive}\`, (err) => res.json({ queued: !err }));`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "exec(`tar czf /tmp/bundle.tgz ${archive}`",
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Cmd");
			return {
				body: `  const archive = ${h.expr};\n  execFile("tar", ["czf", "/tmp/bundle.tgz", archive], (err) => res.json({ queued: !err }));`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: `execFile("tar", ["czf", "/tmp/bundle.tgz", archive]`,
			};
		},
	},
	{
		class: "idor",
		stack: "node-express",
		idiom: "missing-tenant-scope",
		severity: "high",
		safeReason: "the row is scoped to the authenticated session's account, so another tenant's id returns nothing",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Idor");
			return {
				body: `  const ref = ${h.expr};\n  const row = await db.query("SELECT id, owner, total FROM orders WHERE id = $1", [ref]);\n  res.json(row);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: `"SELECT id, owner, total FROM orders WHERE id = $1", [ref]`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Idor");
			return {
				body: `  const ref = ${h.expr};\n  const row = await db.query("SELECT id, owner, total FROM orders WHERE id = $1 AND owner = $2", [ref, req.session.account]);\n  res.json(row);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: `"SELECT id, owner, total FROM orders WHERE id = $1 AND owner = $2"`,
			};
		},
	},
	{
		class: "pathtrav",
		stack: "node-express",
		idiom: "unvalidated-join",
		severity: "high",
		safeReason: "the resolved path is checked to remain under the storage root before it is read",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Path");
			return {
				body: `  const target = path.join(STORAGE_ROOT, ${h.expr});\n  res.send(await fs.readFile(target));`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "const target = path.join(STORAGE_ROOT,",
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Path");
			return {
				body: `  const target = path.resolve(STORAGE_ROOT, ${h.expr});\n  if (!target.startsWith(STORAGE_ROOT + path.sep)) return res.sendStatus(404);\n  res.send(await fs.readFile(target));`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "if (!target.startsWith(STORAGE_ROOT + path.sep))",
			};
		},
	},
	{
		class: "xss",
		stack: "node-express",
		idiom: "raw-html-response",
		severity: "medium",
		safeReason: "the value is escaped before it reaches the HTML response body",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Html");
			return {
				body: `  const label = ${h.expr};\n  res.type("html").send(\`<div class="banner">\${label}</div>\`);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: '`<div class="banner">${label}</div>`',
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Html");
			return {
				body: `  const label = ${h.expr};\n  res.type("html").send(\`<div class="banner">\${escapeHtml(label)}</div>\`);`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "${escapeHtml(label)}",
			};
		},
	},
	{
		class: "logic",
		stack: "node-express",
		idiom: "unbounded-amount",
		severity: "high",
		safeReason: "the amount is validated positive and bounded by the available balance before the ledger is written",
		vulnerable(ctx) {
			const h = hop(ctx, source(ctx), "Amount");
			return {
				body: `  const amount = Number(${h.expr});\n  await db.query("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [amount, req.session.account]);\n  res.json({ debited: amount });`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: `"UPDATE accounts SET balance = balance - $1 WHERE id = $2"`,
			};
		},
		safe(ctx) {
			const h = hop(ctx, source(ctx), "Amount");
			return {
				body: `  const amount = Number(${h.expr});\n  const [{ balance }] = await db.query("SELECT balance FROM accounts WHERE id = $1", [req.session.account]);\n  if (!(amount > 0) || amount > balance) return res.sendStatus(400);\n  await db.query("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [amount, req.session.account]);\n  res.json({ debited: amount });`,
				helpers: h.helpers, extraFile: h.extraFile,
				sinkMarker: "if (!(amount > 0) || amount > balance)",
			};
		},
	},
];
