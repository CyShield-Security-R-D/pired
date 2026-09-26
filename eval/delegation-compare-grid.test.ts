import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	corpusReasons, DEFAULT_BUDGET_ARMS, delegationOff, kindlessArmReasons, kindlessCorpus, parseArmList, parseCorpora, parseMaxVerifiers, scopeFor, scopeSettingsFor, shapeOf,
	type CorpusInput, type PinnedCorpus,
} from "./delegation-compare-grid.ts";
import { isOfficialGrid, OFFICIAL_PASSES, OFFICIAL_TARGET_IDS, planSchedule, type ExpectedCell } from "./delegation-compare-lib.ts";

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
		expect(v6).toMatchObject({ targets: null, passes: null, manifestSha256: null, truthSha256: null, kindless: false });
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
		expect(scopeSettingsFor("matched", { candidateMaxAgents: 8, maxVerifiers: { candidate: 2 } })).toEqual({ maxAgents: 0, budget: true });
	});

	it("writes the baseline's cap, each arm's verifier cap and the budget line only where they are configured", () => {
		const options = { candidateMaxAgents: 8, baselineMaxAgents: 0, maxVerifiers: { candidate: 2 }, budgetArms: ["baseline" as const] };
		expect(scopeFor("e", "/w", scopeSettingsFor("baseline", options), fourHours, now)).toEqual({ ...research, maxAgents: 0, budget: { minutes: 240, deadline: "2026-09-26T14:00:00.000Z" } });
		expect(scopeFor("e", "/w", scopeSettingsFor("candidate", options), fourHours, now)).toEqual({ ...research, maxAgents: 8, maxVerifiers: 2 });
		expect(scopeFor("e", "/w", scopeSettingsFor("matched", options), fourHours, now)).toEqual({ ...research, maxAgents: 0 });
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
