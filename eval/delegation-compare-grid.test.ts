import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	corpusReasons, DEFAULT_BUDGET_ARMS, delegationOff, kindlessArmReasons, kindlessCorpus, parseArmList, parseCorpora, parseMaxVerifiers, scopeFor, scopeSettingsFor, shapeOf,
	gridKindReasons, kindSnapshotReasons, parseGridKinds, summarizeTwins, twinTargets, type CorpusInput, type GridKind, type GridOptions, type PinnedCorpus,
} from "./delegation-compare-grid.ts";
import { armsOfPair, DEFAULT_BREAKER, isOfficialGrid, OFFICIAL_PASSES, OFFICIAL_TARGET_IDS, planSchedule, type ExpectedCell } from "./delegation-compare-lib.ts";

// Per-file builders, by house rule: a pinned corpus, the runner's measurement
// of a grid's inputs, and the gate cells a grid expects.
const sha = (c: string): string => c.repeat(64);
const corpus = (over: Partial<PinnedCorpus> = {}): PinnedCorpus => ({
	targets: ["A", "B"], passes: 3, manifestSha256: sha("a"), truthSha256: { "a-app": sha("1"), "b-app": sha("2") },
	label: "the two test targets", kindless: false, ...over,
});
const input = (over: Partial<CorpusInput> = {}): CorpusInput => ({
	gateIds: ["A", "B"], passes: 3, selected: false, manifestSha256: sha("a"),
	targets: [{ id: "A", name: "a-app", truthSha256: sha("1") }, { id: "B", name: "b-app", truthSha256: sha("2") }],
	...over,
});
const cells = (ids: string[], passes: number): ExpectedCell[] => planSchedule(ids, passes).map(({ key, target, pass }) => ({ key, target, pass }));
const shipped = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(new URL("./delegation-compare.pins.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("pinned corpora", () => {
	// The v5 definition moved from constants in the runner into the pins file;
	// a v5 grid must be recognised exactly as it was, so the pin must be the
	// same five ids, three passes and hashes the runner hard-coded.
	it("pins the v5 official corpus as the five research targets, three passes, with the hashes the runner hard-coded", async () => {
		const corpora = parseCorpora((await shipped()).corpora);
		const v5 = corpora["v5-official"]!;
		expect(v5.targets).toEqual([...OFFICIAL_TARGET_IDS]);
		expect(v5.passes).toBe(OFFICIAL_PASSES);
		expect(v5.kindless).toBe(true);
		expect(v5.label).toBe("the five research targets");
		expect(v5.manifestSha256).toBe("b0d72812a4481d69a5a141429d2b5d0800c81d7c120da1ea4c071f1d40dba954");
		expect(Object.keys(v5.truthSha256 ?? {})).toEqual([
			"filebrowser_filebrowser-fetgso", "Kovah_LinkAce-z2dd6z", "fatfreecrm_fat_free_crm-1wl9c6", "benbusby_whoogle-search-03n6cv", "enchant97_note-mark-i71l34",
		]);
		expect(v5.truthSha256?.["enchant97_note-mark-i71l34"]).toBe("ad9049a1e4d2d56943a0c5967b2cecf9c16911df1fed479c7b9ed5376e7e272e");
	});

	// Until the v6 freeze nothing on the fresh corpus may read as official, and
	// it must never be official without a grid kind fixing its arms.
	it("ships the fresh v6 corpus unfrozen and reachable only through a grid kind", async () => {
		const v6 = parseCorpora((await shipped()).corpora)["v6-fresh"]!;
		expect(v6).toMatchObject({ targets: null, passes: null, manifestSha256: null, truthSha256: null, twinsSha256: null, kindless: false });
		expect(shapeOf(v6)).toBeUndefined();
	});

	it("reads a pins file without corpora as none, and skips comment keys", () => {
		expect(parseCorpora(undefined)).toEqual({});
		expect(parseCorpora({ _comment: "notes", x: { label: "x", targets: null } })).toEqual({
			x: { targets: null, passes: null, manifestSha256: null, truthSha256: null, label: "x", kindless: false },
		});
	});

	// A typo in a frozen hash read as "unfrozen" would turn an official corpus
	// into one that can never approve without saying why.
	it("refuses a malformed corpus rather than reading it as unfrozen", () => {
		expect(() => parseCorpora([])).toThrow(/corpora must be an object/);
		expect(() => parseCorpora({ x: { label: "x", manifestSha256: "abc" } })).toThrow(/manifestSha256/);
		expect(() => parseCorpora({ x: { label: "x", targets: ["A", "A"] } })).toThrow(/distinct target ids/);
		expect(() => parseCorpora({ x: { label: "x", targets: [] } })).toThrow(/targets/);
		expect(() => parseCorpora({ x: { label: "x", passes: 0 } })).toThrow(/passes/);
		expect(() => parseCorpora({ x: { label: "x", truthSha256: { a: "zz" } } })).toThrow(/truthSha256/);
		expect(() => parseCorpora({ x: { targets: null } })).toThrow(/label/);
		expect(() => parseCorpora({ x: { label: "x", kindless: "yes" } })).toThrow(/kindless/);
	});
});

describe("the official grid, judged against the pinned corpus", () => {
	it("recognises the v5 official grid exactly as before, against the shipped pin", async () => {
		const v5 = shapeOf(parseCorpora((await shipped()).corpora)["v5-official"])!;
		const grid = cells([...OFFICIAL_TARGET_IDS], OFFICIAL_PASSES);
		expect(isOfficialGrid(grid, [v5])).toBe(true);
		expect(isOfficialGrid(grid)).toBe(true);
		expect(isOfficialGrid(grid.slice(0, 14), [v5])).toBe(false);
		expect(isOfficialGrid(cells([...OFFICIAL_TARGET_IDS], 4), [v5])).toBe(false);
	});

	// The fresh corpus has twelve targets: the grid shape is whatever the pin
	// says, not a count of five.
	it("accepts a twelve-target shape when that is what the corpus pins", () => {
		const twelve = Array.from({ length: 12 }, (_, i) => `T${i + 1}`);
		const shape = { targets: twelve, passes: 6 };
		expect(isOfficialGrid(cells(twelve, 6), [shape])).toBe(true);
		expect(isOfficialGrid(cells(twelve, 6), [])).toBe(false);
		expect(isOfficialGrid(cells(twelve.slice(0, 11), 6), [shape])).toBe(false);
	});

	it("gives no reason for a grid that is the corpus with every pin matched", () => {
		expect(corpusReasons("c", corpus(), input())).toEqual([]);
	});

	// The same strings, in the same order, as the runner wrote for the v5
	// corpus before 2.8, so an exploratory v5 grid reads as it always did.
	it("lists the v5 reasons in their old words and order", () => {
		const reasons = corpusReasons("c", corpus({ label: "the five research targets" }), input({
			gateIds: ["A", "C"], passes: 4, selected: true, manifestSha256: sha("b"),
			targets: [{ id: "A", name: "a-app", truthSha256: sha("9") }, { id: "C", name: "c-app", truthSha256: sha("3") }],
		}));
		expect(reasons).toEqual([
			"--only selects a subset",
			"--passes 4 is not 3",
			`research manifest sha256 ${"b".repeat(12)} is not the pinned ${"a".repeat(12)}`,
			`a-app truth key sha256 ${"9".repeat(12)} is not the pinned ${"1".repeat(12)}`,
			"C (c-app) has no pinned truth hash",
		]);
		expect(corpusReasons("c", corpus({ label: "the five research targets" }), input({ gateIds: ["A", "C"] })))
			.toContain("manifest targets differ from the five research targets");
	});

	it("names what a corpus that is not frozen lacks, and checks only what it pins", () => {
		const reasons = corpusReasons("v6-fresh", corpus({ targets: null, passes: null, manifestSha256: null, truthSha256: null }), input({ passes: 9 }));
		expect(reasons).toEqual(["corpus v6-fresh is not frozen: eval/delegation-compare.pins.json has no targets, passes, manifestSha256, truthSha256 for it"]);
	});

	// The v5 official grid ran no twins; a grid that adds them has runs its
	// official grid never had, on trees nobody froze.
	it("makes twins exploratory on a corpus without them, and checks the twins file where one is pinned", () => {
		expect(corpusReasons("v5", corpus(), input({ twinsSha256: sha("c") }))).toEqual(["corpus v5 has no patched twins; --twins adds runs its official grid did not have"]);
		expect(corpusReasons("c", corpus({ twinsSha256: sha("c") }), input({ twinsSha256: sha("c") }))).toEqual([]);
		expect(corpusReasons("c", corpus({ twinsSha256: sha("c") }), input({ twinsSha256: sha("d") }))).toEqual([`twins file sha256 ${"d".repeat(12)} is not the pinned ${"c".repeat(12)}`]);
		// A grid that runs no twins is judged by its kind's twin arms, not here.
		expect(corpusReasons("c", corpus({ twinsSha256: sha("c") }), input())).toEqual([]);
		expect(corpusReasons("c", corpus({ twinsSha256: null }), input())[0]).toMatch(/has no twinsSha256 for it/);
		expect(() => parseCorpora({ x: { label: "x", twinsSha256: "zz" } })).toThrow(/twinsSha256/);
	});

	it("judges a grid without a kind against the kindless corpus with its targets, else the first kindless one", () => {
		const corpora = { k: corpus({ kindless: false }), v5: corpus({ kindless: true, targets: ["X"] }), other: corpus({ kindless: true }) };
		expect(kindlessCorpus(corpora, ["B", "A"])?.[0]).toBe("other");
		expect(kindlessCorpus(corpora, ["Q"])?.[0]).toBe("v5");
		expect(kindlessCorpus({ k: corpus() }, ["A", "B"])).toBeUndefined();
	});
});

describe("each arm's scope", () => {
	const now = Date.parse("2026-09-26T10:00:00.000Z");
	const fourHours = 4 * 60 * 60 * 1000;
	const research = { engagement: "e", workspace: "/w", mode: "off", authorized: false, targets: {} };

	// Unconfigured, every arm writes what it wrote before 2.8: the baseline the
	// bare research scope, the candidate its cap and the budget line, the
	// matched arm a cap of zero and the budget line.
	it("keeps the baseline's scope byte-identical when no option names it", () => {
		const scope = scopeFor("e", "/w", scopeSettingsFor("baseline", { candidateMaxAgents: 8 }), fourHours, now);
		expect(JSON.stringify(scope)).toBe(JSON.stringify(research));
		expect(scopeSettingsFor("baseline", { candidateMaxAgents: 8, budgetArms: DEFAULT_BUDGET_ARMS })).toEqual({ budget: false });
		expect(scopeSettingsFor("candidate", { candidateMaxAgents: 8 })).toEqual({ maxAgents: 8, budget: true });
		expect(scopeSettingsFor("matched", { candidateMaxAgents: 8 })).toEqual({ maxAgents: 0, budget: true });
	});

	it("writes the baseline's cap, each arm's verifier cap and the budget line only where they are configured", () => {
		const options = { candidateMaxAgents: 8, baselineMaxAgents: 0, maxVerifiers: { candidate: 2 }, budgetArms: ["baseline" as const] };
		expect(scopeFor("e", "/w", scopeSettingsFor("baseline", options), fourHours, now)).toEqual({ ...research, maxAgents: 0, budget: { minutes: 240, deadline: "2026-09-26T14:00:00.000Z" } });
		expect(scopeFor("e", "/w", scopeSettingsFor("candidate", options), fourHours, now)).toEqual({ ...research, maxAgents: 8, maxVerifiers: 2 });
		// The candidate states a verifier cap, so the matched arm, the candidate with delegation off, states 0.
		expect(scopeFor("e", "/w", scopeSettingsFor("matched", options), fourHours, now)).toEqual({ ...research, maxAgents: 0, maxVerifiers: 0 });
	});

	// Stage 2 runs stage 1's candidate S as its baseline. If S's scope changed
	// with its role, the two stages would measure two different S arms.
	it("gives S the same scope bytes as the candidate in stage 1 and as the baseline in stage 2", () => {
		const asCandidate = scopeSettingsFor("candidate", { candidateMaxAgents: 0, maxVerifiers: { candidate: 0 } });
		const asBaseline = scopeSettingsFor("baseline", { candidateMaxAgents: 8, baselineMaxAgents: 0, maxVerifiers: { baseline: 0, candidate: 2 }, budgetArms: ["baseline", "candidate", "matched"] });
		expect(JSON.stringify(scopeFor("e", "/w", asBaseline, fourHours, now))).toBe(JSON.stringify(scopeFor("e", "/w", asCandidate, fourHours, now)));
		expect(scopeFor("e", "/w", asBaseline, fourHours, now)).toMatchObject({ maxAgents: 0, maxVerifiers: 0, budget: { minutes: 240 } });
	});

	it("reads delegation as off only when the scope states no workers and no verifiers", () => {
		expect(delegationOff({ maxAgents: 0, budget: true })).toBe(true);
		expect(delegationOff({ maxAgents: 0, maxVerifiers: 0, budget: true })).toBe(true);
		expect(delegationOff({ maxAgents: 0, maxVerifiers: 2, budget: true })).toBe(false);
		expect(delegationOff({ maxAgents: 8, budget: true })).toBe(false);
		// No cap stated: the snapshot's default decides, which the harness does not know.
		expect(delegationOff({ budget: false })).toBe(false);
	});

	it("parses arm lists into one order and verifier caps per arm", () => {
		expect(parseArmList("matched, baseline", ["baseline", "candidate", "matched"], "--x")).toEqual(["baseline", "matched"]);
		expect(parseArmList("none", ["baseline"], "--x")).toEqual([]);
		expect(() => parseArmList("matched", ["baseline", "candidate"], "--twin-arms")).toThrow(/--twin-arms: "matched"/);
		expect(parseMaxVerifiers("candidate=2")).toEqual({ candidate: 2 });
		expect(() => parseMaxVerifiers("candidate")).toThrow(/<arm>=<n>/);
		expect(() => parseMaxVerifiers("candidate=1=2")).toThrow(/<arm>=<n>/);
	});

	// The v5 official grid ran every arm at the configuration these options
	// leave alone; a grid without a kind that changes one measures other arms.
	it("makes a grid without a kind exploratory when it configures an arm, and names how", () => {
		expect(kindlessArmReasons({ candidateMaxAgents: 8 })).toEqual([]);
		expect(kindlessArmReasons({ candidateMaxAgents: 8, budgetArms: ["matched", "candidate"] })).toEqual([]);
		expect(kindlessArmReasons({ baselineMaxAgents: 0, maxVerifiers: { baseline: 0, candidate: 2 }, budgetArms: [] })).toEqual([
			"the baseline's scope states maxAgents 0; without --grid-kind the baseline runs at its snapshot's default",
			"the baseline's scope states maxVerifiers 0; without --grid-kind no arm states a verifier cap",
			"the candidate's scope states maxVerifiers 2; without --grid-kind no arm states a verifier cap",
			"the budget line is on no arm, not candidate,matched; without --grid-kind the arms keep the default",
		]);
	});
});

describe("patched twins", () => {
	// A two-entry synthetic copy of eval/corpus/fresh/twins.json's shape: each
	// twin carries its target's advisory as id and its target's name as twin_of.
	const targets = [{ id: "CVE-2031-0001", name: "acme_shop-aaaaaa" }, { id: "CVE-2031-0002", name: "acme_wiki-bbbbbb" }];
	const twinsFile = (): Array<Record<string, unknown>> => [
		{
			id: "CVE-2031-0001", package: "acme/shop", repo: "acme/shop", scope: ["."], cwe: ["CWE-79"], severity: "high", published: "2031-01-02",
			fix_commit: "a".repeat(40), variant: 2, entries: 0, name: "acme_shop-aaaaaa-patched", twin_of: "acme_shop-aaaaaa", scope_files: 12, scope_loc: 3400,
			language: "Python", target: "PLACEHOLDER/corpus/acme_shop-aaaaaa-patched", truth: "PLACEHOLDER/corpus/truth/acme_shop-aaaaaa-patched.truth.json",
			reviewed_commit: "a".repeat(40), twin: true, aliases: ["GHSA-2222-3333-4444"],
			fixed_regions: [{ advisory: "CVE-2031-0001", file: "shop/views.py", line_range: [40, 44] }, { advisory: "CVE-2031-0001", file: "shop/forms.py", line_range: [9, 9] }],
		},
		{
			id: "CVE-2031-0002", package: "acme/wiki", repo: "acme/wiki", scope: ["."], cwe: ["CWE-22"], severity: "medium", published: "2031-02-03",
			fix_commit: "b".repeat(40), variant: 2, entries: 0, name: "acme_wiki-bbbbbb-patched", twin_of: "acme_wiki-bbbbbb", scope_files: 30, scope_loc: 9100,
			language: "Go", target: "PLACEHOLDER/corpus/acme_wiki-bbbbbb-patched", truth: "PLACEHOLDER/corpus/truth/acme_wiki-bbbbbb-patched.truth.json",
			reviewed_commit: "b".repeat(40), twin: true, aliases: [],
			fixed_regions: [{ advisory: "CVE-2031-0002", file: "wiki/files.go", line_range: [120, 131] }],
		},
	];

	// Under its target's id a twin's runs would merge with its target's, since
	// ids key every cell, pair and record.
	it("keys each twin by its own name, names its target by id, and keeps the advisory as a leak term", () => {
		const twins = twinTargets(twinsFile(), targets);
		expect(twins.map((t) => [t.id, t.twinOf])).toEqual([["acme_shop-aaaaaa-patched", "CVE-2031-0001"], ["acme_wiki-bbbbbb-patched", "CVE-2031-0002"]]);
		expect(twins[0]!.aliases).toEqual(["CVE-2031-0001", "GHSA-2222-3333-4444"]);
		expect(twins[1]!.aliases).toEqual(["CVE-2031-0002"]);
		// What eval/rescore.ts's control score reads is carried through unchanged.
		expect(twins[0]).toMatchObject({ scope_loc: 3400, twin_of: "acme_shop-aaaaaa", fixed_regions: twinsFile()[0]!.fixed_regions, scope: ["."] });
	});

	it("refuses a twins file whose twin names no target, lacks fixed regions or reuses a name", () => {
		expect(() => twinTargets([], targets)).toThrow(/non-empty list/);
		expect(() => twinTargets([{ ...twinsFile()[0], twin_of: "nobody" }], targets)).toThrow(/names no target/);
		expect(() => twinTargets([{ ...twinsFile()[0], fixed_regions: [{ file: "a.py", line_range: [9, 3] }] }], targets)).toThrow(/fixed_regions/);
		expect(() => twinTargets([{ ...twinsFile()[0], fixed_regions: undefined }], targets)).toThrow(/fixed_regions/);
		expect(() => twinTargets([twinsFile()[0], twinsFile()[0]], targets)).toThrow(/reuses/);
		expect(() => twinTargets([{ ...twinsFile()[0], name: "acme_shop-aaaaaa" }], targets)).toThrow(/reuses/);
		expect(() => twinTargets([{ ...twinsFile()[0], id: "" }], targets)).toThrow(/advisory id/);
		expect(() => twinTargets([{ ...twinsFile()[0], scope_loc: -1 }], targets)).toThrow(/scope_loc/);
	});

	// Twins follow the gate pairs within a pass, in the twin arms only; with no
	// twins the schedule is the one every earlier grid pinned.
	it("schedules each twin after the gate pairs of its pass, in its arms only", () => {
		expect(planSchedule(["A", "B"], 2, { ids: ["A-patched"], arms: [] })).toEqual(planSchedule(["A", "B"], 2));
		const one = planSchedule(["A", "B"], 2, { ids: ["A-patched", "B-patched"], arms: ["baseline"] });
		expect(one.map((p) => [p.key, p.order.join(","), p.twin === true])).toEqual([
			["A#1", "baseline,candidate", false], ["B#1", "candidate,baseline", false], ["A-patched#1", "baseline", true], ["B-patched#1", "baseline", true],
			["A#2", "candidate,baseline", false], ["B#2", "baseline,candidate", false], ["A-patched#2", "baseline", true], ["B-patched#2", "baseline", true],
		]);
		const both = planSchedule(["A", "B"], 1, { ids: ["A-patched", "B-patched"], arms: ["baseline", "candidate"] });
		expect(both.filter((p) => p.twin).map((p) => p.order.join(","))).toEqual(["baseline,candidate", "candidate,baseline"]);
		expect(armsOfPair(one[2]!)).toEqual(["baseline"]);
		expect(armsOfPair(one[1]!)).toEqual(["baseline", "candidate"]);
	});

	it("summarises each twin arm's runs, valid runs, claims and cells, apart from the gate", () => {
		const rows = [
			{ key: "acme_shop-aaaaaa-patched#1", target: "acme_shop-aaaaaa-patched", pass: 1, arm: "baseline", attempt: 2, cellId: "c1", valid: true, findings: 3 },
			{ key: "acme_shop-aaaaaa-patched#1", target: "acme_shop-aaaaaa-patched", pass: 1, arm: "candidate", attempt: 2, cellId: "c2", valid: false, findings: 7 },
			{ key: "CVE-2031-0001#1", target: "CVE-2031-0001", pass: 1, arm: "baseline", cellId: "g1", valid: true, findings: 9 },
		];
		const summary = summarizeTwins(["baseline", "candidate"], [{ id: "acme_shop-aaaaaa-patched", twinOf: "CVE-2031-0001" }], 3, rows);
		expect(summary.expectedRuns).toBe(6);
		expect(summary.byArm.baseline).toEqual({
			runs: 1, valid: 1, claims: 3,
			cells: [{ key: "acme_shop-aaaaaa-patched#1", target: "acme_shop-aaaaaa-patched", twinOf: "CVE-2031-0001", pass: 1, attempt: 2, cellId: "c1", valid: true, claims: 3 }],
		});
		// An invalid run's claims are not counted: its ledger is not a finished review.
		expect(summary.byArm.candidate).toMatchObject({ runs: 1, valid: 0, claims: 0 });
		expect(summary.interpretation.gate).toMatch(/never enter the gate/);
	});
});

describe("grid kinds", () => {
	const shippedKinds = async (): Promise<Record<string, GridKind>> => {
		const pins = await shipped();
		return parseGridKinds(pins.gridKinds, parseCorpora(pins.corpora));
	};
	// A kind and the options that match it exactly, as a builder pair.
	const kind = (over: Partial<GridKind> = {}): GridKind => ({
		corpus: "c", baseline: { digest: sha("b") }, candidate: { digest: sha("c") }, baselineMaxAgents: 0, candidateMaxAgents: 8,
		maxVerifiers: { baseline: 0, candidate: 2 }, budgetArms: ["baseline", "candidate", "matched"], twinArms: [],
		matched: { mode: "follow", k: 3, kMax: 6, floorShare: 0.05 }, retry: true, breaker: { ...DEFAULT_BREAKER }, timeoutMs: 14_400_000, ...over,
	});
	const ran = (over: Partial<GridOptions> = {}): GridOptions => ({
		candidateMaxAgents: 8, baselineMaxAgents: 0, maxVerifiers: { baseline: 0, candidate: 2 }, budgetArms: ["baseline", "candidate", "matched"],
		matched: { mode: "follow", k: 3, kMax: 6, floorShare: 0.05 }, retry: true, breaker: { ...DEFAULT_BREAKER }, timeoutMs: 14_400_000, ...over,
	});

	// The pre-registration's draft: stage 1 is A against S, stage 2 is S against
	// D with the matched arm; both on the fresh corpus, retry and breaker on.
	it("ships the two v6 stages as drafts of the pre-registration, unfrozen", async () => {
		const kinds = await shippedKinds();
		expect(kinds["v6-stage1"]).toMatchObject({
			corpus: "v6-fresh", baseline: { commit: null }, candidate: { digest: null }, baselineMaxAgents: null, candidateMaxAgents: 0,
			maxVerifiers: { candidate: 0 }, budgetArms: ["candidate", "matched"], twinArms: ["baseline", "candidate"], matched: null, retry: true, timeoutMs: 14_400_000,
		});
		expect(kinds["v6-stage2"]).toMatchObject({
			corpus: "v6-fresh", baseline: { digest: null }, candidate: { digest: null }, baselineMaxAgents: 0, candidateMaxAgents: 8,
			maxVerifiers: { baseline: 0, candidate: 2 }, budgetArms: ["baseline", "candidate", "matched"], twinArms: [], matched: { mode: "follow", k: 3 }, retry: true,
		});
		expect(kinds["v6-stage1"]!.breaker).toEqual(DEFAULT_BREAKER);
		expect(kinds["v6-stage2"]!.breaker).toEqual(DEFAULT_BREAKER);
	});

	// Stage 2 compares D with the S that stage 1 measured. The kinds must give S
	// the same scope bytes in both roles, or stage 2's baseline is another arm.
	it("gives S the same scope as stage 1's candidate and as stage 2's baseline", async () => {
		const kinds = await shippedKinds();
		const armOptions = (k: GridKind) => ({ candidateMaxAgents: k.candidateMaxAgents, ...(k.baselineMaxAgents === null ? {} : { baselineMaxAgents: k.baselineMaxAgents }), maxVerifiers: k.maxVerifiers, budgetArms: k.budgetArms });
		const now = Date.parse("2026-09-26T10:00:00.000Z");
		const s1 = scopeFor("e", "/w", scopeSettingsFor("candidate", armOptions(kinds["v6-stage1"]!)), kinds["v6-stage1"]!.timeoutMs!, now);
		const s2 = scopeFor("e", "/w", scopeSettingsFor("baseline", armOptions(kinds["v6-stage2"]!)), kinds["v6-stage2"]!.timeoutMs!, now);
		expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
		expect(delegationOff(scopeSettingsFor("baseline", armOptions(kinds["v6-stage2"]!)))).toBe(true);
		// M is S's snapshot with delegation off, read beside S and D: in stage 2 its scope is S's too.
		expect(JSON.stringify(scopeFor("e", "/w", scopeSettingsFor("matched", armOptions(kinds["v6-stage2"]!)), 14_400_000, now))).toBe(JSON.stringify(s2));
		// Stage 1's baseline A runs at its own defaults, as every v5 baseline did.
		expect(JSON.stringify(scopeFor("e", "/w", scopeSettingsFor("baseline", armOptions(kinds["v6-stage1"]!)), 14_400_000, now)))
			.toBe(JSON.stringify({ engagement: "e", workspace: "/w", mode: "off", authorized: false, targets: {} }));
	});

	it("gives no reason for a grid whose every option is its kind's", () => {
		expect(gridKindReasons("k", kind(), ran())).toEqual([]);
		// A matched snapshot override is judged by its digest elsewhere, not as a policy change.
		expect(gridKindReasons("k", kind(), ran({ matched: { mode: "follow", k: 3, kMax: 6, floorShare: 0.05, snapshot: "/s" } }))).toEqual([]);
		expect(gridKindReasons("k", kind({ breaker: true }), ran())).toEqual([]);
	});

	// A mismatched option keeps the grid exploratory and says what differs, the
	// way a candidate digest that is not the pinned one does.
	it("lists every option that differs from the kind", () => {
		const reasons = gridKindReasons("v6-stage2", kind(), {
			candidateMaxAgents: 4, maxVerifiers: { candidate: 1 }, twinArms: ["baseline"], retry: false, timeoutMs: 7_200_000,
		});
		expect(reasons).toEqual([
			"grid kind v6-stage2: the baseline's maxAgents is unstated, not 0",
			"grid kind v6-stage2: the candidate's maxAgents is 4, not 8",
			"grid kind v6-stage2: the baseline's maxVerifiers is unstated, not 0",
			"grid kind v6-stage2: the candidate's maxVerifiers is 1, not 2",
			"grid kind v6-stage2: the budget line is on candidate,matched, not baseline,candidate,matched",
			"grid kind v6-stage2: patched twins run in baseline, not no arm",
			"grid kind v6-stage2: the matched arm is off, not on",
			"grid kind v6-stage2: it requires --retry",
			`grid kind v6-stage2: the breaker policy is off, not ${JSON.stringify(DEFAULT_BREAKER)}`,
			"grid kind v6-stage2: --timeout 7200000 is not 14400000",
		]);
		expect(gridKindReasons("k", kind({ breaker: false, retry: false }), ran())).toEqual(["grid kind k: it runs without --retry", "grid kind k: it runs without --breaker"]);
		expect(gridKindReasons("k", kind(), ran({ matched: { mode: "follow", k: 2, kMax: 4, floorShare: 0.05 } }))[0]).toMatch(/the matched policy is \{"mode":"follow","k":2/);
		expect(gridKindReasons("k", kind({ matched: null }), ran())).toEqual(["grid kind k: the matched arm is on, not off"]);
	});

	it("holds a kind's snapshots to its own pins: a commit, a digest, or not frozen", () => {
		const measured = { baselineDigest: sha("b"), candidateDigest: sha("c"), commitReason: (commit: string) => commit === "1".repeat(40) ? "" : `baseline snapshot differs from git ${commit.slice(0, 7)}` };
		expect(kindSnapshotReasons("k", kind(), measured)).toEqual([]);
		expect(kindSnapshotReasons("k", kind({ baseline: { commit: "1".repeat(40) } }), measured)).toEqual([]);
		expect(kindSnapshotReasons("k", kind({ baseline: { commit: "2".repeat(40) } }), measured)).toEqual(["grid kind k: baseline snapshot differs from git 2222222"]);
		expect(kindSnapshotReasons("k", kind({ baseline: { commit: null }, candidate: { digest: null } }), measured)).toEqual([
			"grid kind k: no baseline is frozen (its baseline.commit is null)", "grid kind k: no candidate is frozen (its candidate.digest is null)",
		]);
		expect(kindSnapshotReasons("k", kind({ baseline: { digest: sha("x") }, candidate: { digest: sha("y") } }), measured)).toEqual([
			`grid kind k: baseline input digest ${"b".repeat(12)} is not the pinned ${"x".repeat(12)}`,
			`grid kind k: candidate input digest ${"c".repeat(12)} is not the pinned ${"y".repeat(12)}`,
		]);
	});

	it("refuses a malformed kind rather than letting every grid under it read as exploratory", () => {
		const corpora = { c: corpus() };
		const raw = (over: Record<string, unknown>) => ({ k: { ...kind(), ...over } });
		expect(parseGridKinds(undefined, corpora)).toEqual({});
		expect(parseGridKinds({ _comment: "x", ...raw({}) }, corpora).k).toEqual(kind());
		expect(() => parseGridKinds(raw({ corpus: "nope" }), corpora)).toThrow(/corpus/);
		expect(() => parseGridKinds(raw({ baseline: { commit: "abc" } }), corpora)).toThrow(/baseline.commit/);
		expect(() => parseGridKinds(raw({ baseline: { tag: "v1" } }), corpora)).toThrow(/baseline must be/);
		expect(() => parseGridKinds(raw({ candidate: {} }), corpora)).toThrow(/candidate must be/);
		expect(() => parseGridKinds(raw({ candidateMaxAgents: null }), corpora)).toThrow(/candidateMaxAgents/);
		expect(() => parseGridKinds(raw({ maxVerifiers: { matched: 1 } }), corpora)).toThrow(/maxVerifiers/);
		expect(() => parseGridKinds(raw({ twinArms: ["matched"] }), corpora)).toThrow(/twinArms/);
		expect(() => parseGridKinds(raw({ matched: { mode: "follow" } }), corpora)).toThrow(/matched/);
		expect(() => parseGridKinds(raw({ breaker: { consecutive: 0 } }), corpora)).toThrow(/breaker/);
		expect(() => parseGridKinds(raw({ retry: "yes" }), corpora)).toThrow(/retry/);
		expect(() => parseGridKinds(raw({ timeoutMs: 0 }), corpora)).toThrow(/timeoutMs/);
	});
});
