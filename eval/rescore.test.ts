import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	citationMatches, citationsForRecord, currentRuns, findingsFromLedger, formatReport, inventoryIndex, labelHygiene, LEVELS,
	liveRecords, loadTruth, matchUnique, officialMatches, pairedRows, parseCitations, rescoreGrid, sameFile, type Citation, type Truth,
	CLAIM_TIERS, ledgerFindingRows, type LedgerFinding, partitionClaims, tiersOf, verdictCounts,
} from "./rescore.ts";

type Row = Record<string, unknown>;

const truth = (id: string, file: string, line: number, lo = line, hi = line, extra: Partial<Truth> = {}): Truth => ({ id, file, line, lo, hi, ...extra });
const at = (file: string, lo: number, hi = lo): Citation => ({ file, lo, hi });
const finding = (fields: Row): Row => ({ id: `f${Math.random().toString(16).slice(2, 8)}`, kind: "finding", status: "suspected", ...fields });

const dirs: string[] = [];
const tmp = (): string => {
	const d = mkdtempSync(join(tmpdir(), "rescore-"));
	dirs.push(d);
	return d;
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const jsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("parseCitations", () => {
	it("reads a point citation as a one-line range", () => {
		expect(parseCitations("the sink is http/share.go:80 in the handler")).toEqual([at("http/share.go", 80)]);
	});

	it("keeps the end of a hyphen range, which the pinned adapter drops and a range label needs", () => {
		expect(parseCitations("see http/share.go:73-91")).toEqual([at("http/share.go", 73, 91)]);
	});

	it("keeps the end of an en-dash range, the form models write when they typeset", () => {
		expect(parseCitations("see http/share.go:73–91")).toEqual([at("http/share.go", 73, 91)]);
	});

	it("reads a reversed range as a point at its first number, the line score.ts grades, rather than swapping to the end", () => {
		expect(parseCitations("a.go:20-10")).toEqual([at("a.go", 20)]);
		expect(parseCitations("a.go:120-5")).toEqual([at("a.go", 120)]);
	});

	it("does not read a spaced dash after a prose line as a range, so 'line 120 - 3 callers' stays at 120", () => {
		expect(parseCitations("handler.go at line 120 - 3 callers reach it")).toEqual([at("handler.go", 120)]);
	});

	it("keeps the end of a prose range written with a hyphen or an en dash", () => {
		expect(parseCitations("in src/app.ts, lines 40-52")).toEqual([at("src/app.ts", 40, 52)]);
		expect(parseCitations("in src/app.ts, lines 40–52")).toEqual([at("src/app.ts", 40, 52)]);
	});

	it("keeps citations in the order written, so the first one is the one score.ts grades first", () => {
		expect(parseCitations("b.py:5 then a.py:9")).toEqual([at("b.py", 5), at("a.py", 9)]);
	});

	it("counts a restated location once, so repetition cannot push a real third location past the cap", () => {
		expect(parseCitations("a.go:10 a.go:10 a.go:10-14 b.go:3 c.go:4")).toEqual([at("a.go", 10, 14), at("b.go", 3), at("c.go", 4)]);
	});

	it("caps at three by default, the same cap the pinned adapter applies to a record that walks a module", () => {
		expect(parseCitations("a.go:1 b.go:2 c.go:3 d.go:4")).toHaveLength(3);
		expect(parseCitations("a.go:1 b.go:2 c.go:3 d.go:4", 1)).toEqual([at("a.go", 1)]);
	});

	it("pairs a prose line with the nearest file named before it, not the first file mentioned", () => {
		expect(parseCitations("config.py is fine; the sink is in handlers/upload.go at line 55")).toEqual([at("handlers/upload.go", 55)]);
	});

	it("falls back to the first file after a prose line when none precedes it", () => {
		expect(parseCitations("at line 12 of src/app.ts")).toEqual([at("src/app.ts", 12)]);
	});

	it("invents no line for a file named without one, since a guessed line could land in a label window by accident", () => {
		expect(parseCitations("the bug is somewhere in http/share.go")).toEqual([]);
	});

	it("ignores extensions the pinned adapter cannot see, or the control would diverge", () => {
		expect(parseCitations("README.md:4 and main.c:9")).toEqual([]);
	});
});

describe("citationsForRecord", () => {
	it("reads target, description, repro, title and evidence in the pinned adapter's order", () => {
		const cs = citationsForRecord(finding({ target: "x", description: "d.go:4", repro: "r.go:5", title: "t.go:6", evidence: ["e.go:7"] }));
		expect(cs).toEqual([at("d.go", 4), at("r.go", 5), at("t.go", 6)]);
	});

	it("ignores citations in an evidence string, because score.ts spreads a string into characters", () => {
		expect(citationsForRecord(finding({ description: "a.go:5", evidence: "b.go:7" }))).toEqual([at("a.go", 5)]);
	});

	it("adds locations after the text's own citations, still under the cap", () => {
		const cs = citationsForRecord(finding({ description: "a.go:1", locations: ["b.go:2", "c.go:3", "d.go:4"] }));
		expect(cs).toEqual([at("a.go", 1), at("b.go", 2), at("c.go", 3)]);
	});

	it("drops a record whose text has no location even when locations carries one, as score.ts does", () => {
		expect(citationsForRecord(finding({ description: "no location here", locations: ["b.go:2"] }))).toEqual([]);
	});

	it("takes the file from the inventory only when the finding states the line itself", () => {
		const inv = inventoryIndex([{ id: "e1587b", kind: "endpoint", method: "POST", path: "/api/x", file: "src/api/x.py" }]);
		expect(citationsForRecord(finding({ target: "e1587b", description: "missing check at line 40" }), inv)).toEqual([at("src/api/x.py", 40)]);
		expect(citationsForRecord(finding({ target: "POST /api/x", description: "missing check" }), inv)).toEqual([]);
	});

	it("indexes an inventory element by id, route and path, and skips one that names no source file", () => {
		const inv = inventoryIndex([{ id: "a", method: "GET", path: "/r", file: "h.go" }, { id: "b", value: "https://host/" }]);
		expect([...inv.entries()]).toEqual([["a", "h.go"], ["GET /r", "h.go"], ["/r", "h.go"]]);
	});
});

describe("sameFile", () => {
	it("matches a path-segment suffix in either direction", () => {
		expect(sameFile("backend/handlers/assets.go", "handlers/assets.go")).toBe(true);
		expect(sameFile("assets.go", "backend/handlers/assets.go")).toBe(true);
	});

	it("refuses a same-basename file in another directory, the collision the official grader credits", () => {
		expect(sameFile("handlers/assets.go", "services/assets.go")).toBe(false);
	});

	it("refuses a partial segment, so xassets.go is not assets.go", () => {
		expect(sameFile("handlers/xassets.go", "assets.go")).toBe(false);
	});

	it("normalises ./ and backslashes before comparing", () => {
		expect(sameFile("./src\\app.ts", "repo/src/app.ts")).toBe(true);
	});

	it("never matches an empty path", () => {
		expect(sameFile("", "a.go")).toBe(false);
	});
});

describe("levels", () => {
	const label = truth("L", "http/share.go", 80, 78, 84);

	it("lists the four levels in order", () => {
		expect(LEVELS).toEqual(["file", "point±3", "line±3", "line±10", "range-overlap"]);
	});

	it("point±3 windows the label's primary line only, the plan's form, so a wide label does not inflate it", () => {
		expect(citationMatches(at("share.go", 77), label, "point±3")).toBe(true);
		expect(citationMatches(at("share.go", 83), label, "point±3")).toBe(true);
		expect(citationMatches(at("share.go", 76), label, "point±3")).toBe(false);
		expect(citationMatches(at("share.go", 84), label, "point±3")).toBe(false);
		// inside the label range but beyond the primary line: line±3 credits it, point±3 does not
		expect(citationMatches(at("share.go", 86), label, "line±3")).toBe(true);
		expect(citationMatches(at("share.go", 86), label, "point±3")).toBe(false);
	});

	it("file matches any line in the right file and nothing in another", () => {
		expect(citationMatches(at("share.go", 900), label, "file")).toBe(true);
		expect(citationMatches(at("users.go", 80), label, "file")).toBe(false);
	});

	it("line±3 windows the whole label range, as the grader does, and grades the claim's start", () => {
		expect(citationMatches(at("share.go", 75), label, "line±3")).toBe(true);
		expect(citationMatches(at("share.go", 87), label, "line±3")).toBe(true);
		expect(citationMatches(at("share.go", 74), label, "line±3")).toBe(false);
		expect(citationMatches(at("share.go", 88), label, "line±3")).toBe(false);
		// a range starting early is graded on its start, which is what score.ts hands the grader
		expect(citationMatches(at("share.go", 70, 80), label, "line±3")).toBe(false);
	});

	it("line±10 widens the same window", () => {
		expect(citationMatches(at("share.go", 68), label, "line±10")).toBe(true);
		expect(citationMatches(at("share.go", 94), label, "line±10")).toBe(true);
		expect(citationMatches(at("share.go", 67), label, "line±10")).toBe(false);
	});

	it("range-overlap credits a claim range that reaches into the label, which a start-only reading misses", () => {
		expect(citationMatches(at("share.go", 60, 76), label, "range-overlap")).toBe(true);
		expect(citationMatches(at("share.go", 60, 74), label, "range-overlap")).toBe(false);
		expect(citationMatches(at("share.go", 87, 99), label, "range-overlap")).toBe(true);
		expect(citationMatches(at("share.go", 88, 99), label, "range-overlap")).toBe(false);
	});

	it("range-overlap trims an over-wide label to its first cap lines, so a module-sized label cannot match everything", () => {
		const wide = truth("W", "users.go", 10, 10, 510);
		expect(citationMatches(at("users.go", 43), wide, "range-overlap")).toBe(true);
		expect(citationMatches(at("users.go", 44), wide, "range-overlap")).toBe(false);
		expect(citationMatches(at("users.go", 300), wide, "range-overlap")).toBe(false);
		expect(citationMatches(at("users.go", 53), wide, "range-overlap", 40)).toBe(true);
		// the start-graded levels are not trimmed; that is the difference the cap exists to make
		expect(citationMatches(at("users.go", 300), wide, "line±3")).toBe(true);
	});

	it("range-overlap trims an over-wide claim the same way, so x.go:5-2026 cannot reach every label in the file", () => {
		const deep = truth("D", "x.go", 400, 400, 410);
		expect(citationMatches(at("x.go", 5, 2026), deep, "range-overlap")).toBe(false);
		expect(citationMatches(at("x.go", 370, 2026), deep, "range-overlap")).toBe(true);
		expect(citationMatches(at("x.go", 366, 2026), deep, "range-overlap")).toBe(false);
	});
});

describe("matchUnique", () => {
	const truths = [truth("A", "a.go", 10), truth("B", "a.go", 50), truth("C", "b.go", 5)];

	it("credits a label when any citation of any finding hits it, once however many do", () => {
		const hit = matchUnique([[at("x.go", 1), at("a.go", 11)], [at("a.go", 9)]], truths, "line±3");
		expect([...hit]).toEqual(["A"]);
	});

	it("lets one finding credit several labels, unlike the grader's one-claim-per-label assignment", () => {
		expect([...matchUnique([[at("a.go", 10), at("b.go", 5)]], truths, "line±3")].sort()).toEqual(["A", "C"]);
	});

	it("returns nothing for a run with no located findings", () => {
		expect(matchUnique([], truths, "file").size).toBe(0);
	});
});

describe("labelHygiene", () => {
	it("lists labels spanning more lines than range-overlap keeps, counting lines spanned rather than hi - lo", () => {
		// 5..35 is 31 lines, exactly what [lo, lo+30] keeps; 5..36 is 32 and loses one
		const truths = [truth("ok", "a.go", 5, 5, 35), truth("wide", "a.go", 5, 5, 36), truth("pt", "a.go", 9)];
		expect(labelHygiene(truths, 30)).toEqual([{ id: "wide", width: 32 }]);
		expect(labelHygiene(truths, 29)).toEqual([{ id: "ok", width: 31 }, { id: "wide", width: 32 }]);
	});
});

describe("officialMatches", () => {
	it("assigns each claim to at most one label, nearest first, as detection_grader.py does", () => {
		const truths = [truth("A", "a.go", 10), truth("B", "a.go", 13)];
		expect([...officialMatches([{ file: "a.go", line: 12 }], truths)]).toEqual(["B"]);
	});

	it("credits a basename collision, which the segments rule exists to count", () => {
		const truths = [truth("A", "services/assets.go", 10)];
		const claims = [{ file: "handlers/assets.go", line: 10 }];
		expect(officialMatches(claims, truths).size).toBe(1);
		expect(officialMatches(claims, truths, { fileRule: "segments" }).size).toBe(0);
	});

	it("refuses a location match whose CWE differs when the truth carries classes, and not when told to ignore them", () => {
		const truths = [truth("A", "a.go", 10, 10, 10, { cwe: "CWE-639" })];
		const claims = [{ file: "a.go", line: 10, cwe: "CWE-22" }];
		expect(officialMatches(claims, truths).size).toBe(0);
		expect(officialMatches([{ ...claims[0]!, cwe: "639" }], truths).size).toBe(1);
		expect(officialMatches(claims, truths, { classRule: false }).size).toBe(1);
	});

	it("accepts a matching vuln_class after normalising case, spaces and underscores", () => {
		const truths = [truth("A", "a.go", 10, 10, 10, { vulnClass: "sql_injection" })];
		expect(officialMatches([{ file: "a.go", line: 10, vulnClass: "SQL Injection" }], truths).size).toBe(1);
		expect(officialMatches([{ file: "a.go", line: 10, vulnClass: "XSS" }], truths).size).toBe(0);
	});

	it("accepts a claim with no class against classed truth, the grader's location-only branch", () => {
		expect(officialMatches([{ file: "a.go", line: 10 }], [truth("A", "a.go", 10, 10, 10, { cwe: "CWE-639" })]).size).toBe(1);
	});

	it("breaks a tie on range gap by distance to the primary line, so the label the claim sits on wins", () => {
		// both ranges contain line 20 (gap 0); B's primary line is nearer
		const truths = [truth("A", "a.go", 12, 10, 30), truth("B", "a.go", 21, 15, 25)];
		expect([...officialMatches([{ file: "a.go", line: 20 }], truths)]).toEqual(["B"]);
	});

	it("ignores a claim's CWE entirely when no label in the file carries a class, as score.ts strips it", () => {
		expect(officialMatches([{ file: "a.go", line: 10, cwe: "CWE-22" }], [truth("A", "a.go", 10)]).size).toBe(1);
	});
});

describe("ledger reading", () => {
	it("folds the store the way Workspace.read does: last write wins per id, tombstones gone", () => {
		const rows = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "a", v: 2 }, { id: "b", deleted: true }];
		expect(liveRecords(rows)).toEqual([{ id: "a", v: 2 }]);
	});

	it("grades a rewritten finding at its new location only", () => {
		const run = tmp();
		mkdirSync(join(run, "workspace"));
		writeFileSync(join(run, "workspace", "findings.jsonl"), jsonl([
			{ id: "f1", description: "old at a.go:10" },
			{ id: "f2", description: "prose only" },
			{ id: "f1", description: "new at a.go:40-44" },
		]) + "not json\n");
		expect(findingsFromLedger(run)).toEqual([[at("a.go", 40, 44)]]);
	});

	it("reads a run with no ledger as no findings rather than failing the grid", () => {
		expect(findingsFromLedger(tmp())).toEqual([]);
	});

	it("loads line_range as lo/hi, defaulting both to line, from either truth-file shape", () => {
		const d = tmp();
		writeFileSync(join(d, "a.json"), JSON.stringify([{ id: "x", file: "a.go", line: 12, line_range: [14, 10] }, { id: "y", file: "b.go", line: 3, cwe: "CWE-1" }]));
		writeFileSync(join(d, "b.json"), JSON.stringify({ vulnerabilities: [{ id: "z", file: "c.go", line: 7, line_range: [7] }] }));
		expect(loadTruth(join(d, "a.json"))).toEqual([truth("x", "a.go", 12, 10, 14), truth("y", "b.go", 3, 3, 3, { cwe: "CWE-1" })]);
		expect(loadTruth(join(d, "b.json"))).toEqual([truth("z", "c.go", 7)]);
	});
});

describe("run selection", () => {
	it("keeps valid runs at the highest attempt only, so a superseded valid attempt is not scored", () => {
		const runs = [
			{ target: "t", pass: 1, arm: "baseline", attempt: 1, valid: true },
			{ target: "t", pass: 1, arm: "baseline", attempt: 2, valid: true },
			{ target: "t", pass: 1, arm: "candidate", attempt: 1, valid: true },
			{ target: "t", pass: 1, arm: "candidate", attempt: 2, valid: false },
		];
		expect(currentRuns(runs)).toEqual([runs[1]]);
	});
});

describe("rescoreGrid and the report", () => {
	const grid = (): string => {
		const g = tmp();
		const keys = join(g, "keys");
		mkdirSync(keys);
		writeFileSync(join(keys, "app.truth.json"), JSON.stringify([
			{ id: "T-1", file: "http/share.go", line: 80, line_range: [78, 84] },
			{ id: "T-2", file: "users/users.go", line: 10, line_range: [10, 200] },
		]));
		writeFileSync(join(g, "manifest.json"), JSON.stringify({ targets: [{ id: "t1", name: "app" }], inputs: { truth: keys } }));
		const cell = (name: string, run: Row, findings: Row[]) => {
			const dir = join(g, "runs", name);
			mkdirSync(join(dir, "workspace"), { recursive: true });
			writeFileSync(join(dir, "run.json"), JSON.stringify({ target: "t1", pass: 1, attempt: 1, valid: true, totalTokens: 1000, ...run }));
			writeFileSync(join(dir, "workspace", "findings.jsonl"), jsonl(findings));
			return dir;
		};
		cell("c-base", { arm: "baseline", truePositives: 1, findings: 2 }, [
			{ id: "a", description: "share delete lacks ownership check, http/share.go:73-81" },
			{ id: "b", description: "users/users.go:150 walks the whole module" },
		]);
		const cand = cell("c-cand", { arm: "candidate", truePositives: 1, findings: 1 }, [{ id: "c", description: "nothing near: http/share.go:120" }]);
		writeFileSync(join(g, "runs", "c-base", "score.json.findings.json"), JSON.stringify([{ file: "http/share.go", line: 73 }, { file: "users/users.go", line: 150 }]));
		writeFileSync(join(cand, "score.json.findings.json"), JSON.stringify([{ file: "http/share.go", line: 121 }]));
		mkdirSync(join(g, "runs", "c-norun"));
		return g;
	};

	it("reproduces the official count per run and scores each level from the ledger", () => {
		const { rows } = rescoreGrid(grid());
		const base = rows.find((r) => r.arm === "baseline")!;
		// 73 is five lines before the label: a miss officially, which the overlap level recovers from the range end;
		// 150 sits inside a 190-line label, credited officially and refused by the width cap
		expect(base.mirroredTp).toBe(1);
		expect(base.matched).toEqual({ "file": ["T-1", "T-2"], "point±3": [], "line±3": ["T-2"], "line±10": ["T-1", "T-2"], "range-overlap": ["T-1"] });
		expect(rows.find((r) => r.arm === "candidate")!.matched["file"]).toEqual(["T-1"]);
	});

	it("pairs rows only when both arms of a target-pass are present", () => {
		const { rows } = rescoreGrid(grid());
		expect(pairedRows(rows)).toHaveLength(2);
		expect(pairedRows(rows.filter((r) => r.arm === "baseline"))).toHaveLength(0);
	});

	it("refuses to pair a retried baseline with a first-attempt candidate, as eval/paired.ts does", () => {
		const { rows } = rescoreGrid(grid());
		const mixed = rows.map((r) => (r.arm === "baseline" ? { ...r, attempt: 2 } : r));
		expect(pairedRows(mixed)).toHaveLength(0);
	});

	it("checks the parsed claims against what the pinned adapter wrote, so a divergence on non-matching claims is seen", () => {
		const { rows } = rescoreGrid(grid());
		expect(rows.find((r) => r.arm === "baseline")!.claimsIdentical).toBe(true);
		expect(rows.find((r) => r.arm === "candidate")!.claimsIdentical).toBe(false);
		const report = formatReport(rows, []);
		expect(report).toContain("claims: 1 of 2 runs parse identically");
		expect(report).toContain("CLAIMS DIFFER");
		expect(formatReport(rows.map((r) => ({ ...r, claimsIdentical: null })), [])).toContain("claims: 0 of 0 runs");
	});

	it("prints counts, cell ids and label widths, and flags a run the mirror cannot reproduce", () => {
		const { rows, truths } = rescoreGrid(grid());
		const report = formatReport(rows, [...truths.values()].flat());
		expect(report).toContain("official mirror 1 of 2 runs agree");
		expect(report).toContain("DISAGREE");
		expect(report).toContain("c-cand official 1 mirrored 0");
		expect(report).toContain("T-2 (191 lines)");
		expect(report).not.toContain("ownership");
	});

	it("says none when every label is within the cap", () => {
		expect(formatReport([], [truth("A", "a.go", 1)])).toContain("labels spanning more than 31 lines (range-overlap keeps lo..lo+30): none");
	});

	it("writes the per-run JSON through the CLI", async () => {
		const g = grid();
		const out = join(tmp(), "out.json");
		const { execFileSync } = await import("node:child_process");
		const printed = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "rescore.ts"), g, "--json", out, "--cap", "30"], { encoding: "utf8" });
		expect(printed).toContain("control:");
		const rows = JSON.parse(readFileSync(out, "utf8")) as Row[];
		expect(rows.map((r) => r.arm).sort()).toEqual(["baseline", "candidate"]);
		expect(Object.keys(rows[0]!.matched as Row)).toEqual([...LEVELS]);
	});

	it("exits 2 with usage on a non-numeric cap or a --json with no path, rather than scoring with NaN", async () => {
		const { spawnSync } = await import("node:child_process");
		const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "rescore.ts"), ...args], { encoding: "utf8" });
		const g = grid();
		for (const args of [[g, "--cap", "abc"], [g, "--json"], []]) {
			const out = run(...args);
			expect(out.status).toBe(2);
			expect(out.stderr).toContain("Usage:");
		}
	});
});

describe("the status and provenance partition (3.1)", () => {
	const row = (over: Partial<LedgerFinding> & Pick<LedgerFinding, "citations">): LedgerFinding => ({ everRefuted: false, ...over });
	const truths = [truth("T-1", "a.go", 10), truth("T-2", "b.go", 20), truth("T-3", "c.go", 30)];

	it("places a status in the tiers a report would: refuted and disposed rows in all only, a lead presented, a settled row confirmed", () => {
		expect(CLAIM_TIERS).toEqual(["all", "presented", "suspected", "confirmed", "confirmed-independent"]);
		for (const s of ["refuted", "false-positive", "accepted-risk", "ignored"]) expect(tiersOf(s, true)).toEqual(["all"]);
		for (const s of ["suspected", "open", undefined]) expect(tiersOf(s)).toEqual(["all", "presented", "suspected"]);
		for (const s of ["confirmed", "triaged", "reported"]) expect(tiersOf(s)).toEqual(["all", "presented", "confirmed"]);
		expect(tiersOf("confirmed", true)).toEqual(["all", "presented", "confirmed", "confirmed-independent"]);
		expect(tiersOf("confirmed", false)).toEqual(["all", "presented", "confirmed"]);
	});

	it("counts labels matched and rows per tier, per author and among rows ever refuted", () => {
		const p = partitionClaims([
			row({ citations: [at("a.go", 10)], status: "confirmed", by: "pired-investigate" }),
			row({ citations: [at("b.go", 20)], status: "refuted", by: "pired-investigate", everRefuted: true }),
			row({ citations: [at("c.go", 30)], status: "suspected", by: "lead" }),
			row({ citations: [at("c.go", 90)], status: "suspected" }),
		], truths);
		expect(p.tiers.all).toMatchObject({ claims: 4, matched: { "line±3": ["T-1", "T-2", "T-3"] } });
		expect(p.tiers.presented).toMatchObject({ claims: 3, matched: { "line±3": ["T-1", "T-3"] } });
		expect(p.tiers.confirmed).toMatchObject({ claims: 1, matched: { "line±3": ["T-1"] } });
		// A refutation of a labelled bug is what this partition exists to count.
		expect(p.everRefuted).toMatchObject({ claims: 1, matched: { "line±3": ["T-2"] } });
		expect(p.tiers.suspected).toMatchObject({ claims: 2, matched: { "line±3": ["T-3"] } });
		expect(Object.keys(p.byAuthor)).toEqual(["lead", "pired-investigate", "unknown"]);
		expect(p.byAuthor["pired-investigate"]).toMatchObject({ claims: 2, matched: { "line±3": ["T-1", "T-2"] } });
		expect(p.byAuthor.unknown).toMatchObject({ claims: 1, matched: { "line±3": [] } });
	});

	it("reads a row ever refuted from any line of its history, even one later re-confirmed", () => {
		const run = tmp();
		mkdirSync(join(run, "workspace"));
		const refuted = { verdict: "refuted", at: "t1", by: "pired-verify", tier: "static" };
		const confirmed = { verdict: "stands", at: "t2", by: "lead", tier: "executed" };
		writeFileSync(join(run, "workspace", "findings.jsonl"), jsonl([
			{ id: "a", kind: "finding", by: "pired-investigate", status: "suspected", target: "a.go:10" },
			{ id: "a", kind: "finding", by: "pired-investigate", status: "refuted", target: "a.go:10", verification: refuted },
			{ id: "a", kind: "finding", by: "pired-investigate", status: "confirmed", target: "a.go:10", verification: confirmed },
			{ id: "b", kind: "finding", status: "suspected", target: "b.go:20" },
			{ id: "b", kind: "finding", status: "refuted", target: "b.go:20" },
			{ id: "b", kind: "finding", status: "suspected", target: "b.go:20", verification: { verdict: "unresolved", at: "t3", attempted: "stands", ungrounded: 2 } },
			{ id: "c", kind: "finding", status: "suspected", description: "no location" },
		]));
		const rows = ledgerFindingRows(run);
		expect(rows).toEqual([
			{ citations: [at("a.go", 10)], status: "confirmed", by: "pired-investigate", independent: true, tier: "executed", everRefuted: true, refutedBy: ["pired-verify"] },
			{ citations: [at("b.go", 20)], status: "suspected", everRefuted: true, refutedBy: ["unknown"] },
		]);
		// The downgrade rate's parts, counted from the fields, each verification once.
		expect(verdictCounts(run)).toEqual({ verifications: 3, downgraded: 1, onQuotes: 1 });
		// The citations are the ones the official path reads, row for row.
		expect(rows.map((r) => r.citations)).toEqual(findingsFromLedger(run));
	});

	it("adds the partition to every rescored run and prints it for the paired runs, leaving the mirror as it was", () => {
		const g = tmp();
		const keys = join(g, "keys");
		mkdirSync(keys);
		writeFileSync(join(keys, "app.truth.json"), JSON.stringify([{ id: "T-1", file: "a.go", line: 10 }]));
		writeFileSync(join(g, "manifest.json"), JSON.stringify({ targets: [{ id: "t1", name: "app" }], inputs: { truth: keys } }));
		for (const [arm, status, by] of [["baseline", "confirmed", "lead"], ["candidate", "refuted", "pired-verify"]] as const) {
			const dir = join(g, "runs", arm);
			mkdirSync(join(dir, "workspace"), { recursive: true });
			writeFileSync(join(dir, "run.json"), JSON.stringify({ target: "t1", pass: 1, attempt: 1, valid: true, totalTokens: 1, arm, truePositives: 1, findings: 1 }));
			writeFileSync(join(dir, "workspace", "findings.jsonl"), jsonl([{ id: "x", kind: "finding", status, by, target: "a.go:10" }]));
		}
		const { rows } = rescoreGrid(g);
		const cand = rows.find((r) => r.arm === "candidate")!;
		expect(cand.mirroredTp).toBe(1);
		expect(cand.tiers.presented.matched["line±3"]).toEqual([]);
		expect(cand.everRefuted.matched["line±3"]).toEqual(["T-1"]);
		const report = formatReport(rows, []);
		expect(report).toContain("claim tiers\tgrid\tarm\ttier\trows");
		expect(report).toMatch(/claim tiers\t\S+\tcandidate\tpresented\t0\t0\t0\t0\t0\t0/);
		expect(report).toMatch(/claim tiers\t\S+\tcandidate\tever-refuted\t1\t1\t1\t1\t1\t1/);
		expect(report).toMatch(/claim tiers\t\S+\tbaseline\tby lead\t1\t1/);
		// A row written before the partition existed still prints, as zeros.
		expect(() => formatReport(rows.map(({ tiers: _t, byAuthor: _b, everRefuted: _e, ...rest }) => rest as typeof rows[number]), [])).not.toThrow();
	});
});

describe("the pre-registered tiers are their own slices (3.1 review)", () => {
	const row = (over: Partial<LedgerFinding> & Pick<LedgerFinding, "citations">): LedgerFinding => ({ everRefuted: false, ...over });
	const truths = [truth("T-1", "a.go", 10)];

	it("matches suspected from its own rows, so a label hit by both a confirmed and a suspected row counts in both", () => {
		const p = partitionClaims([
			row({ citations: [at("a.go", 10)], status: "confirmed", independent: false, tier: "static" }),
			row({ citations: [at("a.go", 11)], status: "suspected" }),
		], truths);
		expect(p.tiers.confirmed.matched["line±3"]).toEqual(["T-1"]);
		expect(p.tiers.suspected.matched["line±3"]).toEqual(["T-1"]);
		// Presented minus confirmed would have said the suspected tier found nothing.
		expect(p.tiers.presented.matched["line±3"]).toEqual(["T-1"]);
		expect(p.tiers["confirmed-independent"]).toMatchObject({ claims: 0 });
	});

	it("counts a confirmation independent only when none of the row's finders made it, and splits confirmed rows by tier", () => {
		const p = partitionClaims([
			row({ citations: [at("a.go", 10)], status: "confirmed", independent: true, tier: "executed" }),
			row({ citations: [at("b.go", 5)], status: "confirmed", independent: false, tier: "static" }),
			row({ citations: [at("c.go", 5)], status: "reported" }),
			row({ citations: [at("d.go", 5)], status: "refuted", tier: "static", everRefuted: true, refutedBy: ["pired-verify", "lead"] }),
		], truths);
		expect(p.tiers["confirmed-independent"]).toMatchObject({ claims: 1, matched: { "line±3": ["T-1"] } });
		expect(p.confirmedByTier.executed).toMatchObject({ claims: 1, matched: { "line±3": ["T-1"] } });
		expect(p.confirmedByTier.static).toMatchObject({ claims: 1 });
		expect(p.confirmedByTier.none).toMatchObject({ claims: 1 });
		expect(Object.keys(p.everRefutedBy)).toEqual(["lead", "pired-verify"]);
		expect(p.everRefutedBy.lead).toMatchObject({ claims: 1 });
	});

	it("prints the new slices and the downgrade counts for the paired runs", () => {
		const g = tmp();
		const keys = join(g, "keys");
		mkdirSync(keys);
		writeFileSync(join(keys, "app.truth.json"), JSON.stringify([{ id: "T-1", file: "a.go", line: 10 }]));
		writeFileSync(join(g, "manifest.json"), JSON.stringify({ targets: [{ id: "t1", name: "app" }], inputs: { truth: keys } }));
		for (const arm of ["baseline", "candidate"]) {
			const dir = join(g, "runs", arm);
			mkdirSync(join(dir, "workspace"), { recursive: true });
			writeFileSync(join(dir, "run.json"), JSON.stringify({ target: "t1", pass: 1, attempt: 1, valid: true, totalTokens: 1, arm, truePositives: 1, findings: 1 }));
			writeFileSync(join(dir, "workspace", "findings.jsonl"), jsonl([
				{ id: "x", kind: "finding", status: "refuted", by: "lead", target: "a.go:10", verification: { verdict: "refuted", at: "t", by: "pired-verify", tier: "static" } },
			]));
		}
		const report = formatReport(rescoreGrid(g).rows, []);
		expect(report).toMatch(/claim tiers\t\S+\tcandidate\tconfirmed-independent\t0/);
		expect(report).toMatch(/claim tiers\t\S+\tcandidate\tconfirmed none\t0/);
		expect(report).toMatch(/claim tiers\t\S+\tcandidate\trefuted by pired-verify\t1\t1/);
		expect(report).toMatch(/verdicts\t\S+\tcandidate\tverifications 1\tdowngraded 0\ton quotes 0/);
	});
});

describe("the matched arm's union rows (plan 2.5)", () => {
	// A synthetic grid: one gate pair and a matched arm of two sessions whose
	// ledgers overlap on one citation.
	const grid = (opts: { k?: number; union?: Row | null; secondValid?: boolean } = {}): string => {
		const g = tmp();
		const keys = join(g, "keys");
		mkdirSync(keys);
		writeFileSync(join(keys, "app.truth.json"), JSON.stringify([
			{ id: "T-1", file: "http/share.go", line: 80, line_range: [78, 84] },
			{ id: "T-2", file: "users/users.go", line: 10, line_range: [10, 20] },
			{ id: "T-3", file: "auth/login.go", line: 30, line_range: [30, 30] },
		]));
		writeFileSync(join(g, "manifest.json"), JSON.stringify({ targets: [{ id: "t1", name: "app" }], inputs: { truth: keys }, ...(opts.k ? { matched: { mode: "follow", k: opts.k } } : {}) }));
		const cell = (name: string, run: Row, findings: Row[]) => {
			const dir = join(g, "runs", name);
			mkdirSync(join(dir, "workspace"), { recursive: true });
			writeFileSync(join(dir, "run.json"), JSON.stringify({ target: "t1", pass: 1, attempt: 1, valid: true, totalTokens: 1000, truePositives: 1, findings: 1, ...run }));
			writeFileSync(join(dir, "workspace", "findings.jsonl"), jsonl(findings));
		};
		cell("c-base", { arm: "baseline" }, [{ id: "a", description: "http/share.go:80" }]);
		cell("c-cand", { arm: "candidate" }, [{ id: "b", description: "http/share.go:81" }]);
		const session = (index: number, sessionAttempt: number, valid = true) => ({ arm: "matched", valid, matchedSession: { index, sessionAttempt } });
		cell("m-1", session(1, 1), [{ id: "c", description: "http/share.go:80" }]);
		cell("m-2-old", session(2, 1, false), [{ id: "d", description: "auth/login.go:30" }]);
		cell("m-2", session(2, 2), []);
		writeFileSync(join(g, "runs", "m-2", "run.json"), JSON.stringify({ target: "t1", pass: 1, attempt: 1, valid: opts.secondValid ?? true, totalTokens: 900, arm: "matched", matchedSession: { index: 2, sessionAttempt: 2 } }));
		// A third session, run on rolled-over budget; only a union that names it reads it.
		cell("m-3", session(3, 1), [{ id: "g", description: "auth/login.go:30" }]);
		writeFileSync(join(g, "runs", "m-2", "workspace", "findings.jsonl"), jsonl([
			{ id: "e", description: "http/share.go:80" }, { id: "f", description: "users/users.go:12" },
		]));
		// The union names the session runs it scored, by cell: m-2-old was superseded by m-2.
		const union = opts.union === undefined
			? { target: "t1", pass: 1, attempt: 1, valid: true, truePositives: 2, totalClaims: 2, totalTokens: 1900, sessions: [{ index: 1, cellId: "m-1" }, { index: 2, cellId: "m-2" }] }
			: opts.union;
		if (union) writeFileSync(join(g, "summary.json"), JSON.stringify({ matched: { unions: [union] } }));
		return g;
	};

	it("unions each session's latest ledger into one row, deduplicated as the pinned scorer dedupes", () => {
		const { rows } = rescoreGrid(grid({ k: 2 }));
		const matched = rows.filter((r) => r.arm === "matched");
		expect(matched).toHaveLength(1);
		expect(matched[0]).toMatchObject({ cell: "m-1+m-2", sessions: ["m-1", "m-2"], officialTp: 2, mirroredTp: 2, claims: 2, tokens: 1900, attempt: 1 });
		expect(matched[0]!.matched["line±3"]).toEqual(["T-1", "T-2"]);
		// The superseded session attempt (the only one citing T-3) never enters the union.
		expect(matched[0]!.matched["point±3"]).not.toContain("T-3");
	});

	it("gives the arm no row when one of its sessions is not valid, when the union names a run that is missing, or when summary.json has no union yet", () => {
		expect(rescoreGrid(grid({ k: 2, secondValid: false })).rows.filter((r) => r.arm === "matched")).toEqual([]);
		expect(rescoreGrid(grid({ k: 2, union: null })).rows.filter((r) => r.arm === "matched")).toEqual([]);
		const missing = { target: "t1", pass: 1, attempt: 1, valid: true, truePositives: 2, totalClaims: 2, totalTokens: 1900, sessions: [{ index: 1, cellId: "m-1" }, { index: 2, cellId: "m-9" }] };
		expect(rescoreGrid(grid({ k: 2, union: missing })).rows.filter((r) => r.arm === "matched")).toEqual([]);
	});

	it("reads a union with an extra session on rolled-over budget by the sessions it names", () => {
		const three = { target: "t1", pass: 1, attempt: 1, valid: true, truePositives: 3, totalClaims: 3, totalTokens: 2900, sessions: [{ index: 1, cellId: "m-1" }, { index: 2, cellId: "m-2" }, { index: 3, cellId: "m-3" }] };
		const [row] = rescoreGrid(grid({ k: 2, union: three })).rows.filter((r) => r.arm === "matched");
		expect(row).toMatchObject({ cell: "m-1+m-2+m-3", sessions: ["m-1", "m-2", "m-3"], officialTp: 3, mirroredTp: 3 });
		expect(row!.matched["point±3"]).toContain("T-3");
		// The two-session union of the same grid does not read the third session.
		const [two] = rescoreGrid(grid({ k: 2 })).rows.filter((r) => r.arm === "matched");
		expect(two!.matched["point±3"]).not.toContain("T-3");
	});

	it("keeps union rows out of the per-run totals and gives them their own control line", () => {
		const report = formatReport(rescoreGrid(grid({ k: 2 })).rows, []);
		expect(report).toContain("control: official mirror 2 of 2 runs agree");
		expect(report).toContain("matched unions: official mirror 1 of 1 agree");
	});

	it("never reads a matched session as a run of its own, even in a grid whose manifest names no matched arm", () => {
		const { rows } = rescoreGrid(grid());
		expect(rows.map((r) => r.arm).sort()).toEqual(["baseline", "candidate"]);
	});

	it("reports the matched row beside its gate pair, and never lets it stand in for a missing gate arm", () => {
		const { rows } = rescoreGrid(grid({ k: 2 }));
		expect(pairedRows(rows).map((r) => r.arm).sort()).toEqual(["baseline", "candidate", "matched"]);
		expect(pairedRows(rows.filter((r) => r.arm !== "candidate"))).toEqual([]);
		expect(formatReport(rows, [])).toMatch(/\tmatched\t1\t2\t/);
	});
});
