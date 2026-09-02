import { describe, expect, it } from "vitest";
import { attachToElements, buildTargetIndex, elementKeys, resolveElementTarget } from "./target.ts";
import type { Fields } from "./identity.ts";

/**
 * Turning what the model wrote into the element it meant.
 *
 * The stakes are asymmetric and the rules are shaped by it. A target that fails
 * to resolve costs a coverage cell: work that was done, recorded, and invisible.
 * A target resolved to the WRONG element costs more — it reads as tested work
 * that was never done, which is the one lie a coverage number must not tell. So
 * every rule here either matches something the review actually named, or stops.
 */

const el = (over: Fields): Fields => ({ kind: "endpoint", ...over });

const index = (inventory: Fields[]) => buildTargetIndex(inventory);

describe("the names an element answers to", () => {
	it("knows a route by its path and by its method and path", () => {
		expect(elementKeys(el({ id: "e1", method: "GET", path: "/api/x" })))
			.toEqual(["e1", "/api/x", "get /api/x"]);
	});

	it("knows a host by its value and a technology by its name", () => {
		expect(elementKeys({ kind: "host", id: "h1", value: "Example.COM" })).toContain("example.com");
		expect(elementKeys({ kind: "tech", id: "t1", name: "nginx" })).toContain("nginx");
	});
});

describe("resolving a target to the element it names", () => {
	const inv = [
		el({ id: "e1", method: "GET", path: "/api/transactions" }),
		el({ id: "e2", path: "/api/register" }),
		el({ id: "e3", path: "http/share.go" }),
		el({ id: "e4", path: "CheckLinksCommand" }),
	];

	it("takes an id unchanged", () => {
		expect(resolveElementTarget("e1", index(inv))).toBe("e1");
	});

	it("matches the path a review writes without the method", () => {
		// The common case, and the one that was silently failing: 192 of dvbank's
		// 207 unattached claims named an element its own inventory already held.
		expect(resolveElementTarget("/api/register", index(inv))).toBe("e2");
	});

	it("matches a method the element does not carry, and a trailing slash", () => {
		expect(resolveElementTarget("GET /api/register/", index(inv))).toBe("e2");
	});

	it("finds the route inside prose", () => {
		expect(resolveElementTarget("POST /api/register (line 30)", index(inv))).toBe("e2");
	});

	it("drops a line number, then falls back to the basename", () => {
		expect(resolveElementTarget("http/share.go:88", index(inv))).toBe("e3");
		expect(resolveElementTarget("share.go", index(inv))).toBe("e3");
	});

	it("finds an element named inside a longer phrase", () => {
		// Measured on LinkAce: "CheckLinksCommand link checking" settled nothing,
		// beside a "CheckLinksCommand" element it plainly meant.
		expect(resolveElementTarget("CheckLinksCommand link checking", index(inv))).toBe("e4");
	});

	it("will not match a fragment of a word", () => {
		const users = [el({ id: "u1", path: "users" })];
		expect(resolveElementTarget("user", index(users))).toBeUndefined();
	});

	it("will not match on a name too short to identify anything", () => {
		const api = [el({ id: "a1", name: "api" })];
		expect(resolveElementTarget("api gateway routing rules", index(api))).toBeUndefined();
	});

	it("refuses to choose between two elements that fit equally well", () => {
		// A cell attached to the wrong element is worse than one attached to
		// nothing: it reads as tested work that nobody did.
		const twins = [el({ id: "x1", name: "handler" }), el({ id: "x2", name: "handlers" })];
		expect(resolveElementTarget("the handler and handlers layer", index(twins))).toBeUndefined();
	});

	it("refuses when two elements are recorded under one name", () => {
		// A ledger that already holds duplicate elements should not have coverage
		// claims built on top of the mistake. (Naming one of them outright still
		// resolves — that is the exact-match step, and it is what `record` has
		// always done; this is only about the guess.)
		const dupes = [el({ id: "d1", name: "TokenService" }), el({ id: "d2", name: "TokenService" })];
		expect(resolveElementTarget("the TokenService refresh path", index(dupes))).toBeUndefined();
		expect(resolveElementTarget("TokenService", index(dupes))).toBe("d1");
	});

	it("prefers the most specific element that fits", () => {
		const nested = [el({ id: "c1", name: "FetchController" }), el({ id: "c2", name: "FetchController::htmlKeywordsFromUrl" })];
		expect(resolveElementTarget("FetchController::htmlKeywordsFromUrl", index(nested))).toBe("c2");
	});

	it("says nothing rather than guessing when nothing was mapped", () => {
		expect(resolveElementTarget("withUser", index(inv))).toBeUndefined();
		expect(resolveElementTarget("repo:acme-app", index(inv))).toBeUndefined();
	});
});

describe("attaching recorded claims to the surface", () => {
	const inv = [el({ id: "e1", path: "/api/register" }), el({ id: "e2", path: "auth.go" })];

	it("rewrites what it can and counts what it cannot", () => {
		const { hypotheses, unattached } = attachToElements(
			[
				{ target: "/api/register", class: "sqli" },
				{ target: "auth.go:12", class: "authz" },
				{ target: "withUser", class: "authz" },
			],
			inv,
		);
		expect(hypotheses.map((h) => h.target)).toEqual(["e1", "e2", "withUser"]);
		expect(unattached).toBe(1);
	});

	it("leaves a row that is already attached exactly as it is", () => {
		const rows = [{ target: "e1", class: "sqli" }];
		const { hypotheses, unattached } = attachToElements(rows, inv);
		expect(hypotheses[0]).toBe(rows[0]);
		expect(unattached).toBe(0);
	});

	it("never invents an element, so the denominator cannot move", () => {
		// The whole reason this runs at read time. Resolving can only attach a claim
		// to something already recorded: coverage rises because work that was done
		// is finally counted, never because the matrix was reshaped underneath it.
		const before = inv.length;
		attachToElements([{ target: "something nobody mapped", class: "sqli" }], inv);
		expect(inv).toHaveLength(before);
	});
});
