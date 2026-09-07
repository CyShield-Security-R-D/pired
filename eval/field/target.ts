/**
 * Field — a live target built to measure verification, not discovery.
 *
 * SCOPE — read this before quoting a Field number.
 *
 * This is a **verification instrument, not a capability benchmark**. It says
 * nothing about whether pired can find bugs in real software; `eval/corpus`
 * (real projects at their vulnerable commit, keyed from the security patch)
 * answers that. What Field measures is narrower and currently unmeasurable
 * anywhere else in this repository: given a claim about a running system, does
 * the challenge pass keep it when it is true and break it when it is not.
 *
 * The design principle is the **matched pair**. Every genuine bug here has a
 * decoy beside it that produces the *same observation on the wire* and is
 * correct behaviour. `GET /api/notes/2` returning another user's note is a
 * broken ownership check; `GET /api/docs/1` returning another user's document
 * is a share grant working as designed. A reviewer who runs the obvious request
 * gets a 200 and someone else's data in both cases. That pair is the whole
 * instrument, and it is the shape of the false positive that shipped to a
 * client: an IDOR recorded because one principal could read another's object,
 * with nobody having established that the principal was not entitled to.
 *
 * So a harness cannot score well here by being suspicious, and cannot score
 * well by being permissive. The only way through is to run the control that
 * separates the pair — and for the access-control pairs, no request separates
 * them at all. Entitlement is settled from the share table, which is the
 * instrument's stand-in for the target model's `actors` section.
 *
 * Zero dependencies and no external network: node's own http server on an
 * ephemeral loopback port, seeded deterministically, started and stopped by the
 * caller.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

/** session cookie -> principal. `carol` exists to be the third party in a pair. */
const SESSIONS: Record<string, string> = {
	"s-alice": "alice",
	"s-bob": "bob",
	"s-carol": "carol",
	"s-admin": "admin",
};

const NOTES = [
	{ id: "1", owner: "alice", body: "alice private note" },
	{ id: "2", owner: "bob", body: "bob private note" },
];

const DOCS = [
	{ id: "1", owner: "alice", body: "alice quarterly doc" },
	{ id: "2", owner: "carol", body: "carol quarterly doc" },
];

/**
 * The grant that makes one of the pairs legitimate.
 *
 * bob reads alice's doc 1 because alice shared it. Nothing in the request or
 * the response says so; only this table does. It is deliberately the single
 * fact that separates the two access-control claims.
 */
const SHARES = [{ doc: "1", grantee: "bob" }];

/**
 * Org-wide by design: any authenticated user may read these.
 *
 * The twin of the broken ownership check on notes, and deliberately
 * indistinguishable from it. Both require a session, both hand any logged-in
 * caller somebody else's record, and both refuse an anonymous one. Every probe
 * a tester can run returns the same answer for the two; only the product
 * decision — an internal dashboard everyone in the company can read — says that
 * one of them is correct. This is the pair no amount of re-running settles.
 */
const REPORTS = [{ id: "1", owner: "alice", body: "alice q3 report" }];

/** Public by design — no session required, and that is the intended contract. */
const PAGES = [{ id: "1", body: "public landing page" }];

const ITEMS = [
	{ id: "1", tag: "alpha" },
	{ id: "2", tag: "beta" },
];

const SPA_SHELL = "<!doctype html><title>field</title><div id=root></div>";

function principal(cookie: string | undefined): string | undefined {
	const m = /(?:^|;\s*)session=([^;]+)/.exec(cookie ?? "");
	return m ? SESSIONS[m[1] as string] : undefined;
}

/**
 * The toy predicate the injection pair is built on.
 *
 * Not a database. The mechanism being modelled is the one that matters —
 * untrusted text concatenated into an expression whose *structure* it can
 * change — so a boolean payload flips the result set exactly as it would
 * against a string-built SQL query, and the true/false differential the
 * contract asks for is real rather than staged.
 */
function evaluateFilter(expr: string, item: { id: string; tag: string }): boolean {
	// `tag = '<input>'` with the input pasted in, quotes and all.
	for (const clause of expr.split(/\s+OR\s+/i)) {
		const parts = clause.split(/\s+AND\s+/i);
		if (parts.every((p) => {
			const eq = /^\s*(?:tag|'([^']*)')\s*=\s*'([^']*)'\s*$/.exec(p);
			if (!eq) return false;
			return eq[1] === undefined ? item.tag === eq[2] : eq[1] === eq[2];
		})) return true;
	}
	return false;
}

export interface RunningTarget {
	url: string;
	close(): Promise<void>;
}

/** Start the target on an ephemeral loopback port. */
export async function startTarget(): Promise<RunningTarget> {
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		const who = principal(req.headers.cookie);
		const json = (code: number, body: unknown): void => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const html = (code: number, body: string): void => {
			res.writeHead(code, { "content-type": "text/html" });
			res.end(body);
		};

		// --- session -----------------------------------------------------------
		if (path === "/api/me") {
			if (!who) return json(401, { error: "unauthenticated" });
			return json(200, { user: who });
		}

		// --- TRUE: broken ownership check --------------------------------------
		// Authenticated, and then it never checks whose note it is.
		const note = /^\/api\/notes\/(\w+)$/.exec(path);
		if (note) {
			if (!who) return json(401, { error: "unauthenticated" });
			const found = NOTES.find((n) => n.id === note[1]);
			return found ? json(200, found) : json(404, { error: "not found" });
		}

		// --- DECOY: the same observation, produced by a share grant -------------
		const doc = /^\/api\/docs\/(\w+)$/.exec(path);
		if (doc) {
			if (!who) return json(401, { error: "unauthenticated" });
			const found = DOCS.find((d) => d.id === doc[1]);
			if (!found) return json(404, { error: "not found" });
			const entitled = found.owner === who || SHARES.some((s) => s.doc === found.id && s.grantee === who);
			return entitled ? json(200, found) : json(403, { error: "forbidden" });
		}

		// --- DECOY: org-wide read, intended ------------------------------------
		const report = /^\/api\/reports\/(\w+)$/.exec(path);
		if (report) {
			if (!who) return json(401, { error: "unauthenticated" });
			const found = REPORTS.find((r) => r.id === report[1]);
			return found ? json(200, found) : json(404, { error: "not found" });
		}

		// --- DECOY: public by design -------------------------------------------
		// The no-credentials control SUCCEEDS here, which is exactly what says
		// "this is not an access-control finding".
		const page = /^\/api\/pages\/(\w+)$/.exec(path);
		if (page) {
			const found = PAGES.find((p) => p.id === page[1]);
			return found ? json(200, found) : json(404, { error: "not found" });
		}

		// --- TRUE: unauthenticated admin data ----------------------------------
		if (path === "/internal/metrics") {
			return json(200, { users: Object.values(SESSIONS), notes: NOTES.length });
		}

		// --- TRUE: reflected into HTML, unencoded ------------------------------
		if (path === "/search") {
			return html(200, `<h1>results for ${url.searchParams.get("q") ?? ""}</h1>`);
		}

		// --- DECOY: reflected, but never executable ----------------------------
		if (path === "/api/echo") {
			return json(200, { echo: url.searchParams.get("q") ?? "" });
		}

		// --- TRUE: input changes the shape of the predicate --------------------
		if (path === "/api/items") {
			const filter = url.searchParams.get("filter") ?? "";
			const expr = `tag = '${filter}'`;
			return json(200, { items: ITEMS.filter((i) => evaluateFilter(expr, i)) });
		}

		// --- DECOY: an error is an error, not an injection ---------------------
		// A quote breaks the parser and returns 500 — identically, for every
		// payload. Nothing diverges, so nothing is proven.
		if (path === "/api/sort") {
			const by = url.searchParams.get("by") ?? "id";
			if (/['"]/.test(by)) return json(500, { error: "sort parse error" });
			return json(200, { items: [...ITEMS].sort((a, b) => (a[by as "id" | "tag"] ?? "").localeCompare(b[by as "id" | "tag"] ?? "")) });
		}

		// --- DECOY: the catch-all that makes every path look reachable ----------
		// `/admin` returns 200 because EVERYTHING returns 200. A reviewer who does
		// not request a path that cannot exist reports an exposed admin panel.
		return html(200, SPA_SHELL);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
	};
}
