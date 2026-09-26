import { describe, expect, it } from "vitest";
import {
	analyze, cli, clusterBootstrap, diffsByTarget, exactBinomialTwoSided, formatReport, mcnemar, minDetectableEffect, mulberry32,
	dropTwins, pairDiffs, pairRuns, pairsNeeded, parseArgs, parseArms, perIssueFindRate, sampleSd, selectGrids, truthIdsFromManifests, twinIdsFromManifests, type Pair, type RunRecord,
} from "./paired.ts";

const run = (arm: string, target: string, pass: number, ids: string[], extra: Partial<RunRecord> = {}): RunRecord => ({
	grid: "g1", target, pass, arm, attempt: 1, officialTp: ids.length, claims: 5, tokens: 1000,
	matched: { "line±3": ids, file: ids.slice(0, 1) }, ...extra,
});
const pair = (target: string, pass: number, baseline: string[], candidate: string[]): Pair => ({
	grid: "g1", target, pass, attempt: 1, baseline: new Set(baseline), candidate: new Set(candidate),
});

describe("pairRuns", () => {
	it("pairs the two arms of one (grid, target, pass) and reads each arm's matched set at the requested level", () => {
		const pairs = pairRuns([run("baseline", "A", 1, ["A1", "A2"]), run("candidate", "A", 1, ["A2"])], "file");
		expect(pairs).toHaveLength(1);
		expect([...pairs[0]!.baseline]).toEqual(["A1"]);
		expect([...pairs[0]!.candidate]).toEqual(["A2"]);
	});

	it("drops a group with only one arm, so a crashed candidate never counts as a zero-TP pair", () => {
		expect(pairRuns([run("baseline", "A", 1, ["A1"]), run("baseline", "B", 1, [])])).toEqual([]);
	});

	it("keeps each arm's highest attempt and pairs only when the attempts agree", () => {
		const pairs = pairRuns([
			run("baseline", "A", 1, ["A1"], { attempt: 1 }), run("baseline", "A", 1, ["A1", "A2"], { attempt: 2 }),
			run("candidate", "A", 1, [], { attempt: 2 }),
			run("baseline", "B", 1, [], { attempt: 2 }), run("candidate", "B", 1, [], { attempt: 1 }),
		]);
		expect(pairs.map((p) => [p.target, p.attempt, p.baseline.size])).toEqual([["A", 2, 2]]);
	});

	it("keeps grids apart, so the same target and pass in two grids makes two pairs, not one mixed pair", () => {
		const pairs = pairRuns([
			run("baseline", "A", 1, []), run("candidate", "A", 1, []),
			run("baseline", "A", 1, [], { grid: "g2" }), run("candidate", "A", 1, [], { grid: "g2" }),
		]);
		expect(pairs.map((p) => p.grid)).toEqual(["g1", "g2"]);
	});

	it("skips runs marked invalid and arms it does not know", () => {
		const pairs = pairRuns([
			run("baseline", "A", 1, ["A1"], { valid: false }), run("candidate", "A", 1, []),
			run("baseline", "B", 1, []), run("candidate", "B", 1, []), run("other", "B", 1, ["B1"]),
		]);
		expect(pairs.map((p) => [p.target, p.baseline.size, p.candidate.size])).toEqual([["B", 0, 0]]);
	});

	it("drops a pair whose highest attempt is invalid instead of falling back to the attempt it superseded", () => {
		const pairs = pairRuns([
			run("baseline", "A", 1, ["A1"], { attempt: 1 }), run("baseline", "A", 1, [], { attempt: 2, valid: false }),
			run("candidate", "A", 1, [], { attempt: 1 }),
		]);
		expect(pairs).toEqual([]);
	});

	it("throws on a level a paired run does not carry, so a mistyped --level cannot read as an empty set", () => {
		expect(() => pairRuns([run("baseline", "A", 1, ["A1"]), run("candidate", "A", 1, [])], "line+-3")).toThrow(/line\+-3/);
	});
});

describe("perIssueFindRate", () => {
	it("counts the pairs in which each arm found each issue, over the pairs that ran its target", () => {
		const rates = perIssueFindRate([pair("A", 1, ["A1"], ["A1", "A2"]), pair("A", 2, [], ["A2"]), pair("B", 1, ["B1"], [])]);
		expect(rates.get("A1")).toEqual({ baseline: 1, candidate: 1, n: 2 });
		expect(rates.get("A2")).toEqual({ baseline: 0, candidate: 2, n: 2 });
		expect(rates.get("B1")).toEqual({ baseline: 1, candidate: 0, n: 1 });
	});

	it("lists an issue neither arm ever found when the answer key is given, instead of hiding the hard ones", () => {
		const rates = perIssueFindRate([pair("A", 1, ["A1"], [])], new Map([["A", ["A1", "A9"]]]));
		expect(rates.get("A9")).toEqual({ baseline: 0, candidate: 0, n: 1 });
	});
});

describe("mcnemar", () => {
	it("counts discordant (pair × issue) units in each direction and ignores concordant ones", () => {
		const r = mcnemar([pair("A", 1, ["A1", "A2"], ["A2", "A3"]), pair("A", 2, ["A1"], ["A1"])]);
		expect([r.b, r.c]).toEqual([1, 1]);
		expect(r.p).toBe(1);
	});

	it("returns p = 1 when no unit is discordant rather than dividing by zero", () => {
		expect(mcnemar([pair("A", 1, ["A1"], ["A1"])])).toEqual({ b: 0, c: 0, p: 1 });
		expect(mcnemar([])).toEqual({ b: 0, c: 0, p: 1 });
	});

	it("gives the exact two-sided binomial p: 0 vs 6 is 2/64, 1 vs 9 is 22/1024", () => {
		expect(exactBinomialTwoSided(0, 6)).toBeCloseTo(2 / 64, 12);
		expect(exactBinomialTwoSided(9, 1)).toBeCloseTo(22 / 1024, 12);
		expect(exactBinomialTwoSided(5, 5)).toBe(1);
	});

	it("gives p = 1 for a single discordant unit, which no test can call significant", () => {
		expect(exactBinomialTwoSided(0, 1)).toBe(1);
		expect(exactBinomialTwoSided(1, 0)).toBe(1);
	});

	it("doubles the tail rather than reporting one side: 1 vs 9 is not 11/1024", () => {
		expect(exactBinomialTwoSided(1, 9)).toBeCloseTo(exactBinomialTwoSided(9, 1), 15);
		expect(exactBinomialTwoSided(1, 9)).not.toBeCloseTo(11 / 1024, 6);
		expect(exactBinomialTwoSided(2, 18)).toBeCloseTo((2 * (1 + 20 + 190)) / 2 ** 20, 12);
	});

	it("stays finite on counts whose binomial coefficients overflow a double", () => {
		const p = exactBinomialTwoSided(600, 700);
		expect(Number.isFinite(p)).toBe(true);
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThan(0.01);
		expect(exactBinomialTwoSided(650, 650)).toBe(1);
	});

	it("counts an answer-key issue neither arm found as concordant, leaving b and c unchanged", () => {
		expect(mcnemar([pair("A", 1, ["A1"], [])], new Map([["A", ["A1", "A9"]]]))).toMatchObject({ b: 1, c: 0 });
	});
});

describe("pairDiffs and diffsByTarget", () => {
	it("takes candidate minus baseline matched-set size per pair and groups it by target", () => {
		const pairs = [pair("A", 1, ["A1"], ["A1", "A2"]), pair("A", 2, ["A1", "A2"], []), pair("B", 1, [], ["B1"])];
		expect(pairDiffs(pairs)).toEqual([1, -2, 1]);
		expect(diffsByTarget(pairs)).toEqual(new Map([["A", [1, -2]], ["B", [1]]]));
	});
});

describe("clusterBootstrap", () => {
	const byTarget = new Map([["A", [1, 0, 2]], ["B", [-1, 0]], ["C", [1, 1, 0, 2]]]);

	it("prints the same interval for the same seed, so a rerun of the report does not move the CI", () => {
		expect(clusterBootstrap(byTarget, 2000, 7)).toEqual(clusterBootstrap(byTarget, 2000, 7));
		expect(clusterBootstrap(byTarget, 2000, 7)).not.toEqual(clusterBootstrap(byTarget, 2000, 8));
	});

	it("reports the observed mean and an interval that contains it", () => {
		const r = clusterBootstrap(byTarget, 2000);
		expect(r.mean).toBeCloseTo(6 / 9, 12);
		expect(r.lo).toBeLessThanOrEqual(r.mean);
		expect(r.hi).toBeGreaterThanOrEqual(r.mean);
	});

	it("collapses to a point when every difference is equal, and to zeros with no data", () => {
		expect(clusterBootstrap(new Map([["A", [1, 1]], ["B", [1]]]), 500)).toEqual({ mean: 1, lo: 1, hi: 1 });
		expect(clusterBootstrap(new Map(), 500)).toEqual({ mean: 0, lo: 0, hi: 0 });
	});

	it("widens when the effect lives in one target, where a pair-level bootstrap would call it settled", () => {
		const concentrated = new Map([["A", [3, 3, 3, 3, 3]], ["B", [0, 0, 0, 0, 0]], ["C", [0, 0, 0, 0, 0]]]);
		const r = clusterBootstrap(concentrated, 4000);
		expect(r.lo).toBe(0);
		expect(r.hi).toBeGreaterThanOrEqual(2);
	});

	it("keeps a real interval on one varied target, and is wider than a pair-level bootstrap on clustered data", () => {
		const one = clusterBootstrap(new Map([["A", [-2, 0, 1, 3, 4]]]), 2000);
		expect(one.hi - one.lo).toBeGreaterThan(1);
		// Three targets with a strong shared effect inside each: resampling the five pairs
		// of each target as fifteen independent pairs (one cluster per pair) is narrower.
		const clustered = new Map([["A", [2, 2, 3, 2, 3]], ["B", [0, 0, -1, 0, 0]], ["C", [1, 1, 1, 0, 1]]]);
		const pairLevel = new Map([...clustered.values()].flat().map((d, i) => [`p${String(i).padStart(2, "0")}`, [d]]));
		const cluster = clusterBootstrap(clustered, 4000);
		const naive = clusterBootstrap(pairLevel, 4000);
		expect(cluster.mean).toBeCloseTo(naive.mean, 12);
		expect(cluster.hi - cluster.lo).toBeGreaterThan(1.5 * (naive.hi - naive.lo));
	});

	it("draws from mulberry32, whose outputs stay in [0, 1)", () => {
		const rand = mulberry32(1);
		for (let i = 0; i < 1000; i++) { const x = rand(); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
	});
});

describe("power", () => {
	it("gives (1.959964 + 0.841621) · sd / √n as the minimum detectable effect at the defaults", () => {
		expect(minDetectableEffect(1.2, 15)).toBeCloseTo((2.801585 * 1.2) / Math.sqrt(15), 12);
		expect(minDetectableEffect(1, 0)).toBe(Infinity);
	});

	it("inverts to the pairs needed, rounded up, so the grid planned from it reaches the stated power", () => {
		const n = pairsNeeded(1.2, 0.3);
		expect(n).toBe(Math.ceil((2.801585 * 1.2 / 0.3) ** 2));
		expect(minDetectableEffect(1.2, n)).toBeLessThanOrEqual(0.3);
		expect(minDetectableEffect(1.2, n - 1)).toBeGreaterThan(0.3);
		expect(pairsNeeded(1, 0)).toBe(Infinity);
	});

	it("uses the normal quantiles for other alpha and power, needing more pairs for a stricter test", () => {
		expect(minDetectableEffect(1, 1, 0.01, 0.9)).toBeCloseTo(2.575829 + 1.281552, 4);
		expect(minDetectableEffect(1, 1, 0.001, 0.8)).toBeCloseTo(3.290527 + 0.841621, 4);
		expect(minDetectableEffect(1, 1, 0.05, 0.999)).toBeCloseTo(1.959964 + 3.090232, 4);
		expect(pairsNeeded(1, 0.3, 0.01)).toBeGreaterThan(pairsNeeded(1, 0.3));
	});

	it("takes the sample SD with n − 1 and gives 0 for a single pair", () => {
		expect(sampleSd([1, 2, 3, 4])).toBeCloseTo(Math.sqrt(5 / 3), 12);
		expect(sampleSd([2])).toBe(0);
	});
});

describe("analyze and the CLI", () => {
	const records = [
		run("baseline", "A", 1, ["A1"]), run("candidate", "A", 1, ["A1", "A2"]),
		run("baseline", "A", 2, []), run("candidate", "A", 2, ["A2"]),
		run("baseline", "B", 1, ["B1"]), run("candidate", "B", 1, ["B1"]),
	];

	it("reports pairs, find rates, McNemar and power from the records alone", () => {
		const r = analyze(records, "line±3", new Map([["B", ["B1", "B2"]]]));
		expect([r.pairs, r.targets]).toEqual([3, 2]);
		expect(r.findRates.map((x) => x.id)).toEqual(["A1", "A2", "B1", "B2"]);
		expect(r.mcnemar).toMatchObject({ b: 0, c: 2 });
		expect(r.meanDiff).toBeCloseTo(2 / 3, 12);
		expect(r.pairsFor03).toBeLessThan(r.pairsFor02);
	});

	it("prints ids and counts only, with every section the plan asks for", () => {
		const text = formatReport(analyze(records));
		expect(text).toContain("A2\t0\t2\t2");
		expect(text).toMatch(/McNemar: b=0 .* c=2 .* p=0\.5000/);
		expect(text).toContain("95% cluster bootstrap CI");
		expect(text).toContain("minimum detectable effect");
		expect(text).toContain("pairs needed for +0.2 TP/pair");
	});

	it("parses the file, --level, --grid and repeated --manifest in any order", () => {
		expect(parseArgs(["--level", "file", "r.json", "--grid", "v5c", "--manifest", "a/manifest.json", "--manifest", "b/manifest.json"]))
			.toEqual({ file: "r.json", level: "file", grid: "v5c", manifests: ["a/manifest.json", "b/manifest.json"] });
		expect(parseArgs([])).toEqual({ file: undefined, level: "line±3", grid: undefined, manifests: [] });
	});

	it("selects a grid by exact name, then path suffix, and only then substring, so v5 does not pull in v5b and v5c", () => {
		const grids = ["art/compare-v5/luna", "art/compare-v5b/luna", "art/compare-v5c/luna", "art/compare-v4/glm"];
		expect(selectGrids(grids, "art/compare-v5b/luna")).toEqual(["art/compare-v5b/luna"]);
		expect(selectGrids(grids, "compare-v5/luna")).toEqual(["art/compare-v5/luna"]);
		expect(selectGrids(grids, "compare-v5/luna/")).toEqual(["art/compare-v5/luna"]);
		expect(selectGrids(grids, "v5")).toHaveLength(3);
		expect(selectGrids(grids, "nope")).toEqual([]);
	});

	it("prints one report per grid with the grid in its header, never pooling two grids into one cluster", () => {
		const other = records.map((r) => ({ ...r, grid: "compare-v4" }));
		const files: Record<string, string> = { "r.json": JSON.stringify([...records, ...other]) };
		const all = cli(["r.json"], (p) => files[p]!);
		expect(all.code).toBe(0);
		expect(all.out.match(/3 pair\(s\) over 2 target\(s\)/g)).toHaveLength(2);
		expect(all.out).toContain("grid: compare-v4");
		expect(all.out).toContain("grid: g1");
		expect(all.out).not.toContain("6 pair(s)");
		const one = cli(["r.json", "--grid", "v4"], (p) => files[p]!);
		expect(one.out).toContain("grid: compare-v4");
		expect(one.out).not.toContain("grid: g1");
		expect(cli(["r.json", "--grid", "v9"], (p) => files[p]!)).toMatchObject({ code: 2, out: expect.stringContaining("compare-v4") });
		expect(cli([], () => "")).toMatchObject({ code: 2, out: expect.stringContaining("Usage") });
	});

	it("exits 2 and lists the levels present on a level no record carries, instead of a clean all-zero report", () => {
		const r = cli(["r.json", "--level", "exact"], () => JSON.stringify(records));
		expect(r.code).toBe(2);
		expect(r.out).toContain("file, line±3");
		expect(r.out).not.toContain("McNemar");
	});

	it("lists never-found issues with zeros when given the grid manifest and its answer keys", () => {
		const files: Record<string, string> = {
			"r.json": JSON.stringify(records),
			"g1/manifest.json": JSON.stringify({ targets: [{ id: "A", name: "app-a" }, { id: "B", name: "app-b" }], inputs: { truth: "keys" } }),
			"keys/app-a.truth.json": JSON.stringify([{ id: "A1" }, { id: "A2" }, { id: "A9" }]),
			"keys/app-b.truth.json": JSON.stringify({ vulnerabilities: [{ id: "B1" }, { id: "B7" }] }),
		};
		expect(truthIdsFromManifests(["g1/manifest.json"], (p) => files[p]!)).toEqual(new Map([["A", ["A1", "A2", "A9"]], ["B", ["B1", "B7"]]]));
		const out = cli(["r.json", "--manifest", "g1/manifest.json"], (p) => files[p]!).out;
		expect(out).toContain("A9\t0\t0\t2");
		expect(out).toContain("B7\t0\t0\t1");
		expect(cli(["r.json"], (p) => files[p]!).out).not.toContain("A9");
	});
});

describe("a third arm (plan 2.5)", () => {
	// The matched arm's row is one union per pair, at the pair's attempt.
	const grid = [
		run("baseline", "A", 1, ["A1"]), run("candidate", "A", 1, ["A1", "A2"]), run("matched", "A", 1, ["A1", "A2", "A3"]),
		run("baseline", "A", 2, []), run("candidate", "A", 2, ["A2"]), run("matched", "A", 2, ["A2"]),
	];

	it("leaves the gate's pairing untouched by a matched row", () => {
		const pairs = pairRuns(grid);
		expect(pairs.map((p) => [[...p.baseline], [...p.candidate]])).toEqual([[["A1"], ["A1", "A2"]], [[], ["A2"]]]);
		expect(analyze(grid)).not.toHaveProperty("arms");
	});

	it("pairs matched vs candidate on request, reporting candidate − matched under the arms' own names", () => {
		const r = analyze(grid, "line±3", undefined, ["matched", "candidate"]);
		expect(r.arms).toEqual(["matched", "candidate"]);
		expect(r.pairs).toBe(2);
		expect(r.mcnemar).toMatchObject({ b: 1, c: 0 });
		const text = formatReport(r);
		expect(text).toContain("truth id\tmatched\tcandidate\tn");
		expect(text).toContain("(matched only)");
		expect(text).toContain("mean diff per pair (candidate − matched)");
	});

	it("reads --arms and refuses an unknown or repeated arm", () => {
		expect(parseArgs(["r.json", "--arms", "matched,candidate"])).toEqual({ file: "r.json", level: "line±3", grid: undefined, manifests: [], arms: ["matched", "candidate"] });
		expect(parseArms("baseline, matched")).toEqual(["baseline", "matched"]);
		expect(() => parseArms("candidate,candidate")).toThrow(/two different arms/);
		expect(() => parseArms("single,candidate")).toThrow(/two different arms/);
		const out = cli(["r.json", "--arms", "matched"], () => "[]");
		expect(out.code).toBe(2);
		expect(out.out).toMatch(/--arms takes two different arms/);
	});

	it("runs the CLI on the matched pairing", () => {
		const out = cli(["r.json", "--arms", "matched,candidate"], () => JSON.stringify(grid));
		expect(out.code).toBe(0);
		expect(out.out).toContain("McNemar: b=1 (matched only) c=0 (candidate only)");
	});
});

describe("patched twins (plan 2.8)", () => {
	// A twin is its target's fix-commit tree with no labels: its two arms would
	// pair as a zero-TP pair every pass and dilute every effect and find rate.
	const grid = [
		run("baseline", "A", 1, ["A1"]), run("candidate", "A", 1, ["A1", "A2"]),
		run("baseline", "A-patched", 1, []), run("candidate", "A-patched", 1, []),
		run("baseline", "B-patched", 1, [], { control: { near: 1 } }), run("candidate", "B-patched", 1, [], { twinOf: "B" }),
	];
	const manifest = JSON.stringify({ targets: [{ id: "A", name: "a" }, { id: "A-patched", name: "a-patched", twinOf: "A", fixed_regions: [] }], inputs: { truth: "/t" } });

	it("names the twins a grid manifest lists by twinOf or fixed_regions", () => {
		expect([...twinIdsFromManifests(["g1/manifest.json"], () => manifest)]).toEqual(["A-patched"]);
		expect([...twinIdsFromManifests(["g1/manifest.json"], () => JSON.stringify({ targets: [{ id: "X", fixed_regions: [] }] }))]).toEqual(["X"]);
	});

	it("drops twin rows named by the manifest or marked by their own control score or target", () => {
		const { kept, twins } = dropTwins(grid, new Set(["A-patched"]));
		expect(kept.map((r) => r.target)).toEqual(["A", "A"]);
		expect(twins).toHaveLength(4);
		// Without a manifest, rows that mark themselves still go.
		expect(dropTwins(grid).kept.map((r) => r.target)).toEqual(["A", "A", "A-patched", "A-patched"]);
	});

	it("leaves twins out of the CLI's pairs and says how many rows it dropped", () => {
		const files: Record<string, string> = {
			"r.json": JSON.stringify(grid), "g1/manifest.json": manifest,
			"/t/a.truth.json": JSON.stringify([{ id: "A1" }, { id: "A2" }]), "/t/a-patched.truth.json": "[]",
		};
		const out = cli(["r.json", "--manifest", "g1/manifest.json"], (p) => files[p]!).out;
		expect(out).toMatch(/^dropped 4 patched-twin row\(s\)/);
		expect(out).not.toContain("A-patched");
		expect(out).toContain(formatReport(analyze(grid.slice(0, 2), "line±3", truthIdsFromManifests(["g1/manifest.json"], (p) => files[p]!))).split("\n")[0]!);
		// A grid without twins prints what it always printed.
		expect(cli(["r.json"], () => JSON.stringify(grid.slice(0, 2))).out).not.toContain("dropped");
	});
});
