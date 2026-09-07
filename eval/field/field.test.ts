import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditClaims } from "./audit.ts";
import { CLAIMS, type Claim } from "./claims.ts";
import { runReference } from "./reference.ts";
import { BASELINES, type Disposition, scoreBaseline, scoreField } from "./score.ts";
import { startTarget, type RunningTarget } from "./target.ts";

let target: RunningTarget;
beforeAll(async () => { target = await startTarget(); });
afterAll(async () => { await target?.close(); });

/** A claim with one property broken, for the positive controls. */
function broken(over: Partial<Claim>): Claim {
	const base = CLAIMS.find((c) => c.id === "xss-search") as Claim;
	return { ...base, ...over };
}

describe("the key describes the target", () => {
	it("holds for every shipped claim", async () => {
		const report = await auditClaims(target.url);
		const bad = report.claims.filter((c) => !c.ok);
		expect(bad.map((c) => `${c.claim}: ${c.problem}`)).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it("fires the naive probe for decoys as well as for real bugs", async () => {
		// The matched-pair property, and the reason this instrument is hard. A decoy
		// whose obvious probe already fails is a hint, not a trap, and scoring
		// against it would flatter every harness.
		const report = await auditClaims(target.url);
		expect(report.claims.every((c) => c.naive)).toBe(true);
		expect(report.claims.some((c) => c.truth === "clear")).toBe(true);
	});

	it("catches a claim whose naive probe does not fire", async () => {
		const report = await auditClaims(target.url, [broken({ id: "dud", naive: async () => false })]);
		expect(report.ok).toBe(false);
		expect(report.claims[0]?.problem).toMatch(/not a matched pair/);
	});

	it("catches a control that disagrees with the truth it is keyed to", async () => {
		// The forge failure, one layer up: a key nobody checks is an assertion. A
		// claim marked vulnerable whose control does not fire is a broken fixture,
		// and nothing downstream could tell.
		const report = await auditClaims(target.url, [broken({ id: "dud", truth: "clear" })]);
		expect(report.ok).toBe(false);
		expect(report.claims[0]?.problem).toMatch(/control returned true for a claim marked clear/);
	});

	it("refuses an inseparability claim that a request can actually separate", async () => {
		// Otherwise "entitlement" is a label excusing a probe nobody wrote. The twin
		// has to return the SAME control answer with the OPPOSITE truth, or the
		// claim is separable and should say so.
		const separable: Claim[] = [
			broken({ id: "a", truth: "vulnerable", separator: "entitlement", inseparableFrom: "b" }),
			broken({ id: "b", truth: "clear", separator: "entitlement", inseparableFrom: "a", control: async () => false }),
		];
		const report = await auditClaims(target.url, separable);
		expect(report.ok).toBe(false);
		expect(report.claims[0]?.problem).toMatch(/not inseparable/);
	});

	it("proves the access-control pair is inseparable rather than asserting it", async () => {
		const notes = CLAIMS.find((c) => c.id === "idor-notes") as Claim;
		const reports = CLAIMS.find((c) => c.id === "orgwide-reports") as Claim;
		expect(notes.truth).not.toBe(reports.truth);
		expect(await notes.control(target.url)).toBe(await reports.control(target.url));
	});
});

describe("the reference challenger — the contract's own ceiling", () => {
	it("destroys no real finding and blesses no decoy", async () => {
		// The two errors this whole mechanism exists to avoid, measured rather than
		// argued. A false refutation is a bug that leaves the client's report.
		const { verdicts } = await runReference(target.url);
		const s = scoreField(CLAIMS, verdicts);
		expect(s.falseRefutations).toEqual([]);
		expect(s.falseConfirmations).toEqual([]);
		expect(s.sensitivity).toBe(1);
		expect(s.specificity).toBe(1);
	});

	it("declines the claims no request can settle, instead of guessing", async () => {
		// The positive control on the design: it must actually leave something
		// unsettled. A challenger that resolves all ten is one that answered the
		// entitlement question from a response, which is the failure that shipped.
		const { rows } = await runReference(target.url);
		const declined = rows.filter((r) => r.disposition === "suspected").map((r) => r.claim);
		expect(declined).toContain("idor-notes");
		expect(declined).toContain("orgwide-reports");
		expect(declined.every((id) => rows.find((r) => r.claim === id)?.declined?.includes("entitlement"))).toBe(true);
	});

	it("settles the pairs a request can settle", async () => {
		const { verdicts } = await runReference(target.url);
		expect(verdicts["xss-search"]).toBe("confirmed");
		expect(verdicts["xss-echo"]).toBe("refuted");
		expect(verdicts["inject-items"]).toBe("confirmed");
		expect(verdicts["error-sort"]).toBe("refuted");
		// The share grant, caught by a third principal the shipped contract does
		// not yet ask for.
		expect(verdicts["share-docs"]).toBe("refuted");
		expect(verdicts["soft404-admin"]).toBe("refuted");
	});
});

describe("no degenerate strategy wins", () => {
	it("costs each shortcut exactly one axis", () => {
		// Two rates alone are not a scoreboard: suspecting everything scores 1.00
		// on both, which is what the instrument reported the first time it ran.
		const confirm = scoreBaseline(CLAIMS, BASELINES["confirm-everything"] as Disposition);
		const refute = scoreBaseline(CLAIMS, BASELINES["refute-everything"] as Disposition);
		const suspect = scoreBaseline(CLAIMS, BASELINES["record-and-move-on"] as Disposition);
		expect(confirm.specificity).toBe(0);
		expect(refute.sensitivity).toBe(0);
		expect(suspect.sensitivity).toBe(1);
		expect(suspect.specificity).toBe(1);
		expect(suspect.resolution).toBe(0);
		// And the reference beats all three where each of them fails.
		expect(Math.min(confirm.resolution, refute.resolution, suspect.resolution)).toBeLessThan(0.7);
	});

	it("counts an unsettled claim as neither error", () => {
		const s = scoreField(CLAIMS, {});
		expect(s.falseRefutations).toEqual([]);
		expect(s.falseConfirmations).toEqual([]);
		expect(s.resolution).toBe(0);
	});
});
