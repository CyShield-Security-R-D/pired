/**
 * The claim set — ground truth as something that executes.
 *
 * Every other key in this repository is a list somebody wrote down. This one
 * runs: each claim carries two probes, and the audit refuses to accept the key
 * unless they behave as the claim says. That is the discipline `eval/forge`
 * learned the hard way, where a generated key marked a cell vulnerable in
 * unreachable code and nothing downstream could tell.
 *
 *   naive   — the observation that makes a reviewer write the finding. It
 *             succeeds for EVERY claim, true or decoy. A pair whose naive probe
 *             already separates it is not a trap, it is a hint, and the audit
 *             fails the instrument for it.
 *   control — the probe that actually settles it. Its result must equal `truth`.
 *
 * `separator` records what a claim can be settled *by*, and it is the number
 * this instrument exists to expose.
 *
 * Most claims are `control`: some request settles them, and the audit proves it
 * by requiring the control probe to agree with the truth. The share-grant decoy
 * is one of these, and finding that out was the first thing the instrument did —
 * a third principal with no grant is refused, which is what a working ownership
 * model looks like, so bob's access came from a grant rather than an absent
 * check. The shipped `idor` contract asks for an unauthenticated probe and an
 * unrelated *id*; neither catches it. A third *principal* does.
 *
 * The `entitlement` claims are the ones that survive that fix. `/api/notes/1`
 * read by a stranger is a broken ownership check; `/api/reports/1` read by a
 * stranger is an internal dashboard working as intended. Session required,
 * anonymous refused, any logged-in caller served — identical on every probe a
 * tester can run. The audit does not merely assert that; it **proves** it, by
 * requiring the two controls to return the same answer while the truths differ.
 * That equality is the ceiling on any verification built out of replaying
 * requests, and it is why entitlement is asked for separately.
 */

import type { FindingRecord } from "../../core/ontology.ts";

export type Truth = "vulnerable" | "clear";

/** What is capable of settling a claim. */
export type Separator = "control" | "entitlement";

export interface Claim {
	id: string;
	class: string;
	truth: Truth;
	separator: Separator;
	/** Why this claim is in the set — the failure it represents. */
	trap: string;
	/**
	 * The claim no request can tell this one apart from.
	 *
	 * Set on both members. The audit requires their controls to agree while
	 * their truths differ — an inseparability proof rather than an assertion.
	 */
	inseparableFrom?: string;
	/** The finding a reviewer writes after the naive probe. */
	finding: Omit<FindingRecord, "v" | "kind" | "createdAt">;
	/** The observation that produces the finding. True for every claim. */
	naive(base: string): Promise<boolean>;
	/** The discriminating probe. Its result must equal `truth === "vulnerable"`. */
	control(base: string): Promise<boolean>;
}

const AS = (session: string): RequestInit => ({ headers: { cookie: `session=${session}` } });

async function body(base: string, path: string, init?: RequestInit): Promise<{ status: number; text: string }> {
	const res = await fetch(`${base}${path}`, init);
	return { status: res.status, text: await res.text() };
}

async function contentType(base: string, path: string): Promise<string> {
	const res = await fetch(`${base}${path}`);
	return res.headers.get("content-type") ?? "";
}

function finding(over: Partial<FindingRecord> & Pick<FindingRecord, "id" | "title" | "severity" | "class">): Claim["finding"] {
	return { target: "", status: "suspected", ...over } as Claim["finding"];
}

export const CLAIMS: Claim[] = [
	{
		id: "idor-notes",
		class: "idor",
		truth: "vulnerable",
		separator: "entitlement",
		inseparableFrom: "orgwide-reports",
		trap: "a genuine broken ownership check, wire-identical to the intended org-wide read below",
		finding: finding({
			id: "c1", title: "IDOR on GET /api/notes/{id}", severity: "high", class: "idor",
			target: "/api/notes/{id}", source: "observed",
			description: "A session belonging to bob can read note 1, which is owned by alice.",
		}),
		naive: async (b) => (await body(b, "/api/notes/1", AS("s-bob"))).text.includes("alice private note"),
		control: async (b) => {
			const anon = await body(b, "/api/notes/1");
			const third = await body(b, "/api/notes/1", AS("s-carol"));
			return anon.status === 401 && third.status === 200;
		},
	},
	{
		id: "orgwide-reports",
		class: "idor",
		truth: "clear",
		separator: "entitlement",
		inseparableFrom: "idor-notes",
		trap: "an internal dashboard every employee may read, indistinguishable from a missing ownership check",
		finding: finding({
			id: "c2", title: "IDOR on GET /api/reports/{id}", severity: "high", class: "idor",
			target: "/api/reports/{id}", source: "observed",
			description: "A session belonging to bob can read report 1, which is owned by alice.",
		}),
		naive: async (b) => (await body(b, "/api/reports/1", AS("s-bob"))).text.includes("alice q3 report"),
		// Deliberately the same probe as idor-notes, returning the same answer.
		// The equality is the point and the audit checks it.
		control: async (b) => {
			const anon = await body(b, "/api/reports/1");
			const third = await body(b, "/api/reports/1", AS("s-carol"));
			return anon.status === 401 && third.status === 200;
		},
	},
	{
		id: "share-docs",
		class: "idor",
		truth: "clear",
		separator: "control",
		trap: "cross-user access granted by a share — caught by a third principal, which the shipped contract does not ask for",
		finding: finding({
			id: "c3", title: "IDOR on GET /api/docs/{id}", severity: "high", class: "idor",
			target: "/api/docs/{id}", source: "observed",
			description: "A session belonging to bob can read document 1, which is owned by alice.",
		}),
		naive: async (b) => (await body(b, "/api/docs/1", AS("s-bob"))).text.includes("alice quarterly doc"),
		control: async (b) => {
			const anon = await body(b, "/api/docs/1");
			const third = await body(b, "/api/docs/1", AS("s-carol"));
			// carol is refused: there IS an ownership model, so bob's access came
			// from a grant rather than from an absent check.
			return anon.status === 401 && third.status === 200;
		},
	},
	{
		id: "public-pages",
		class: "idor",
		truth: "clear",
		separator: "control",
		trap: "a public resource read as an access-control failure; the no-credentials control succeeds",
		finding: finding({
			id: "c4", title: "Unauthorized read of GET /api/pages/{id}", severity: "medium", class: "idor",
			target: "/api/pages/{id}", source: "observed",
			description: "Page 1 can be read by a session that does not own it.",
		}),
		naive: async (b) => (await body(b, "/api/pages/1", AS("s-bob"))).text.includes("public landing page"),
		// Succeeds unauthenticated -> public by design, so there is nothing to
		// escalate to and no finding.
		control: async (b) => (await body(b, "/api/pages/1")).status !== 200,
	},
	{
		id: "admin-metrics",
		class: "exposed-admin",
		truth: "vulnerable",
		separator: "control",
		trap: "genuinely unauthenticated admin data, matched against the catch-all decoy below",
		finding: finding({
			id: "c5", title: "Unauthenticated admin data at /internal/metrics", severity: "high", class: "exposed-admin",
			target: "/internal/metrics", source: "observed",
			description: "The endpoint returns the user list with no session.",
		}),
		naive: async (b) => (await body(b, "/internal/metrics")).text.includes("alice"),
		// A path that cannot exist does NOT return this content, so the 200 is
		// about this route rather than about every route.
		control: async (b) => !(await body(b, "/internal/does-not-exist-4f2a")).text.includes("alice"),
	},
	{
		id: "soft404-admin",
		class: "exposed-admin",
		truth: "clear",
		separator: "control",
		trap: "a catch-all route that returns 200 for every path, read as an exposed admin panel",
		finding: finding({
			id: "c6", title: "Admin panel reachable at /admin", severity: "high", class: "exposed-admin",
			target: "/admin", source: "scanner",
			description: "GET /admin returns 200 without authentication.",
		}),
		naive: async (b) => (await body(b, "/admin")).status === 200,
		// The same 200, and the same body, for a path nobody could have built.
		control: async (b) => {
			const admin = await body(b, "/admin");
			const nonsense = await body(b, "/definitely-not-a-route-9c31");
			return admin.text !== nonsense.text;
		},
	},
	{
		id: "xss-search",
		class: "xss",
		truth: "vulnerable",
		separator: "control",
		trap: "reflected into HTML unencoded",
		finding: finding({
			id: "c7", title: "Reflected XSS in GET /search", severity: "high", class: "xss",
			target: "/search", source: "observed",
			description: "The q parameter is reflected into the page.",
		}),
		naive: async (b) => (await body(b, "/search?q=%3Cscript%3E1%3C/script%3E")).text.includes("<script>1</script>"),
		control: async (b) => {
			const ct = await contentType(b, "/search?q=x");
			const reflected = (await body(b, "/search?q=%3Cscript%3E1%3C/script%3E")).text;
			return ct.includes("text/html") && reflected.includes("<script>");
		},
	},
	{
		id: "xss-echo",
		class: "xss",
		truth: "clear",
		separator: "control",
		trap: "reflected, but in a JSON body that no browser executes",
		finding: finding({
			id: "c8", title: "Reflected XSS in GET /api/echo", severity: "medium", class: "xss",
			target: "/api/echo", source: "scanner",
			description: "The q parameter is reflected in the response.",
		}),
		naive: async (b) => (await body(b, "/api/echo?q=%3Cscript%3E1%3C/script%3E")).text.includes("<script>1</script>"),
		control: async (b) => (await contentType(b, "/api/echo?q=x")).includes("text/html"),
	},
	{
		id: "inject-items",
		class: "sqli",
		truth: "vulnerable",
		separator: "control",
		trap: "a real boolean differential — the payload changes the predicate's structure",
		finding: finding({
			id: "c9", title: "Injection in GET /api/items filter", severity: "critical", class: "sqli",
			target: "/api/items", source: "observed",
			description: "The filter parameter is concatenated into the query predicate.",
		}),
		naive: async (b) => (await body(b, "/api/items?filter=alpha")).text.includes("alpha"),
		// True payload returns everything, false payload returns nothing, and the
		// difference tracks the boolean rather than merely existing.
		control: async (b) => {
			const t = (await body(b, `/api/items?filter=${encodeURIComponent("x' OR '1'='1")}`)).text;
			const f = (await body(b, `/api/items?filter=${encodeURIComponent("x' OR '1'='2")}`)).text;
			return t.includes("alpha") && t.includes("beta") && !f.includes("alpha");
		},
	},
	{
		id: "error-sort",
		class: "sqli",
		truth: "clear",
		separator: "control",
		trap: "a 500 on a quote, read as injection; every payload errors identically",
		finding: finding({
			id: "c10", title: "SQL injection in GET /api/sort", severity: "high", class: "sqli",
			target: "/api/sort", source: "scanner",
			description: "A single quote in the by parameter produces a 500, indicating injection.",
		}),
		naive: async (b) => (await body(b, "/api/sort?by=id%27")).status === 500,
		control: async (b) => {
			const t = await body(b, `/api/sort?by=${encodeURIComponent("id' OR '1'='1")}`);
			const f = await body(b, `/api/sort?by=${encodeURIComponent("id' OR '1'='2")}`);
			return t.status !== f.status || t.text !== f.text;
		},
	},
];
