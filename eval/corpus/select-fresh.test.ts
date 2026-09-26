import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LABEL_MAX_LINES, SCORER_EXT, advisoryOrder, canonical, cvss3Rating, cvss3Score, dateRuleHolds, dedupeLabels,
	GitError, dominantLanguage, drawSequential, frameworkPhrase, importLines, importOnly, inNonServiceFolder, isCodeLine, isDeployMarker,
	isLabelFile, isTransientGitFailure, isVendoredFile, labelsFromHunks, languageOf, libraryBanner, mapLabelsBack, mentionIndex, readmePath,
	serviceFacts, serviceVerdict, stderrTail,
	mentions, metadataFilter, mulberry32, namePhrases, parseLsTree, parseZeroContextDiff, poolAdvisory, poolHash, repoOrder,
	seededShuffle, sparsePatterns, targetName, toTruth, walkFromListing, wilsonLower, wouldStrip, yearHistogram,
} from "./select-fresh.ts";
import { ROUTE_RE, walk } from "./lib.ts";
import type { Candidate, DrawPorts, Eligible, Hunk, Label, OsvRecord, PoolAdvisory, Verdict } from "./select-fresh.ts";

// --- builders -------------------------------------------------------------------

const osv = (over: Partial<OsvRecord> = {}): OsvRecord => ({
	id: "CVE-2026-1000",
	published: "2026-03-04T10:00:00Z",
	aliases: ["GHSA-aaaa-bbbb-cccc"],
	references: [{ type: "FIX", url: "https://github.com/acme/shop/commit/0123456789abcdef0123456789abcdef01234567" }],
	database_specific: { cwe_ids: ["CWE-79"] },
	severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" }],
	...over,
});

const adv = (id: string, repo: string, over: Partial<PoolAdvisory> = {}): PoolAdvisory => ({
	id, aliases: [], published: "2026-02-01", cwe: ["CWE-79"], severity: "medium",
	fixes: [`${repo}@${"a".repeat(40)}`], ...over,
});

const hunk = (over: Partial<Hunk> = {}): Hunk => ({
	oldFile: "app/views.py", newFile: "app/views.py", oldStart: 10, oldLen: 1, newStart: 10, newLen: 1,
	removed: ["    return render(user_input)"], added: ["    return render(escape(user_input))"], ...over,
});

const label = (file: string, lo: number, hi: number, advisory = "CVE-2026-1"): Label =>
	({ advisory, file, range: [lo, hi], raw: [lo, hi], capped: false, hunks: 1 });

const candidate = (repo: string, id: string): Candidate => ({ advisory: adv(id, repo), repo, sha: "a".repeat(40) });

const eligible = (id: string, language: string): Eligible => ({
	ok: true, advisory: id, fix: "f".repeat(40), parent: "e".repeat(40), language,
	scopeFiles: 100, scopeLoc: 9_000, routes: 12, labels: [label("app.py", 1, 1, id)], unscoreable: 0,
});

// --- pool -----------------------------------------------------------------------

describe("poolAdvisory", () => {
	it("keeps a CVE record whose FIX-typed reference is a GitHub commit, with its date, class and severity", () => {
		expect(poolAdvisory(osv())).toEqual({
			id: "CVE-2026-1000", aliases: ["GHSA-aaaa-bbbb-cccc"], published: "2026-03-04", cwe: ["CWE-79"],
			severity: "medium", fixes: ["acme/shop@0123456789abcdef0123456789abcdef01234567"],
		});
	});

	it("ignores a commit reference not typed FIX, because an untyped commit is often the release", () => {
		// bludit's CVE-2026-25099/25100/25101 point at a "chore: bump version" commit (research/10).
		const rec = osv({ references: [{ type: "WEB", url: "https://github.com/acme/shop/commit/0123456789abcdef0123456789abcdef01234567" }] });
		expect(poolAdvisory(rec)).toBeUndefined();
	});

	it("drops mirrors that are not CVE records, so one bug is not counted once per database", () => {
		expect(poolAdvisory(osv({ id: "GSD-2026-1000" }))).toBeUndefined();
		expect(poolAdvisory(osv({ id: "PYSEC-2026-12" }))).toBeUndefined();
	});

	it("drops NVD's placeholder classes, which name no weakness", () => {
		const a = poolAdvisory(osv({ database_specific: { cwe_ids: ["NVD-CWE-Other", "NVD-CWE-noinfo"] } }));
		expect(a?.cwe).toEqual([]);
	});

	it("records a fix once when the record cites it twice, and strips a .git suffix from the repository", () => {
		const a = poolAdvisory(osv({
			references: [
				{ type: "FIX", url: "https://github.com/acme/shop.git/commit/ABCDEF0123456789abcdef0123456789abcdef01" },
				{ type: "FIX", url: "https://github.com/acme/shop/commit/abcdef0123456789abcdef0123456789abcdef01#diff-1" },
			],
		}));
		expect(a?.fixes).toEqual(["acme/shop@abcdef0123456789abcdef0123456789abcdef01"]);
	});

	it("keeps an advisory without a publication date so the filter that drops it can count it", () => {
		expect(poolAdvisory(osv({ published: undefined }))?.published).toBeNull();
	});
});

describe("cvss3Score", () => {
	it("scores vectors as the CVSS 3.1 specification does", () => {
		expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
		expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
		expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N")).toBe(7.5);
		expect(cvss3Score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
	});

	it("returns nothing for a vector it cannot read, rather than a severity it guessed", () => {
		expect(cvss3Score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeUndefined();
		expect(cvss3Rating("garbage")).toBeNull();
	});

	it("rates scores on the specification's bands", () => {
		expect(cvss3Rating("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe("critical");
		expect(cvss3Rating("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N")).toBe("high");
		expect(cvss3Rating("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe("medium");
	});
});

describe("poolHash", () => {
	it("hashes the same advisories equally whatever order or key order they arrive in", () => {
		const a = adv("CVE-2026-1", "acme/shop");
		const b = adv("CVE-2026-2", "acme/blog");
		const reordered = Object.fromEntries(Object.entries(b).reverse()) as unknown as PoolAdvisory;
		expect(poolHash([a, b])).toBe(poolHash([reordered, a]));
		expect(poolHash([a, b])).not.toBe(poolHash([a]));
		expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
	});
});

// --- seeded order ------------------------------------------------------------------

describe("the seeded order", () => {
	it("is the same from the same seed and different from another", () => {
		const items = Array.from({ length: 50 }, (_, i) => `r${i}`);
		expect(seededShuffle(items, mulberry32(7))).toEqual(seededShuffle(items, mulberry32(7)));
		expect(seededShuffle(items, mulberry32(7))).not.toEqual(seededShuffle(items, mulberry32(8)));
		expect([...seededShuffle(items, mulberry32(7))].sort()).toEqual([...items].sort());
	});

	it("draws uniformly enough that no position favours an item", () => {
		// 20,000 shuffles of four items: each item should land first about a quarter of the time.
		const rand = mulberry32(20260926);
		const first = new Map<string, number>();
		for (let i = 0; i < 20_000; i++) {
			const top = seededShuffle(["a", "b", "c", "d"], rand)[0] as string;
			first.set(top, (first.get(top) ?? 0) + 1);
		}
		for (const n of first.values()) expect(Math.abs(n / 20_000 - 0.25)).toBeLessThan(0.02);
	});

	it("orders repositories independently of the order the pool listed them in", () => {
		expect(repoOrder(["c/c", "a/a", "b/b"], 3)).toEqual(repoOrder(["b/b", "c/c", "a/a"], 3));
	});

	it("orders one repository's advisories the same however many repositories the walk saw first", () => {
		const cands = ["CVE-2026-3", "CVE-2026-1", "CVE-2026-2", "CVE-2026-4"].map((id) => candidate("acme/shop", id));
		const once = advisoryOrder("acme/shop", cands, 11).map((c) => c.advisory.id);
		expect(advisoryOrder("acme/shop", [...cands].reverse(), 11).map((c) => c.advisory.id)).toEqual(once);
	});
});

// --- metadata filters -------------------------------------------------------------

describe("metadataFilter", () => {
	const pool = [
		adv("CVE-2026-1", "acme/shop"),
		adv("CVE-2026-2", "acme/shop", { published: "2025-05-01" }),
		adv("CVE-2026-3", "Acme/Blog", { fixes: ["Acme/Blog@" + "b".repeat(40), "Acme/Blog@" + "c".repeat(40)] }),
		adv("CVE-2026-4", "acme/wiki", { fixes: ["acme/wiki@" + "d".repeat(40), "other/fork@" + "e".repeat(40)] }),
		adv("CVE-2026-5", "acme/forum", { published: null }),
		adv("CVE-2026-6", "known/app"),
	];

	it("counts what survives each filter, in the order the procedure applies them", () => {
		const { counts } = metadataFilter(pool, new Set(["known/app"]));
		expect(counts.map((c) => [c.advisories, c.repos])).toEqual([[6, 6], [5, 4], [4, 3], [3, 2], [2, 1]]);
		expect(counts.map((c) => c.filter)).toEqual([
			"pool: CVE record with a FIX-typed GitHub commit", "fix commits in one repository", "exactly one fix commit",
			"publication date recorded", "repository not excluded",
		]);
	});

	it("excludes a repository whatever case the advisory spells it in", () => {
		const { candidates } = metadataFilter([adv("CVE-2026-9", "Known/App")], new Set(["known/app"]));
		expect(candidates.size).toBe(0);
	});

	it("applies a publication cutoff only when asked, and says so in the counts", () => {
		const { candidates, counts } = metadataFilter(pool, new Set(), "2026-01-01");
		expect(counts.at(-1)).toEqual({ filter: "published on or after 2026-01-01", advisories: 2, repos: 2 });
		expect(candidates.get("acme/shop")?.map((c) => c.advisory.id)).toEqual(["CVE-2026-1"]);
		expect(candidates.get("known/app")?.[0]?.sha).toBe("a".repeat(40));
	});

	it("counts publication years, with undated advisories under their own heading", () => {
		expect(yearHistogram(["2026-01-02", "2025-12-31", null, "2026-06-01"])).toEqual({ 2025: 1, 2026: 2, unknown: 1 });
	});
});

describe("the date rule", () => {
	it("puts the Wilson lower bound below the observed rate, and at zero with no trials", () => {
		expect(wilsonLower(0, 0)).toBe(0);
		expect(wilsonLower(14, 150)).toBeLessThan(14 / 150);
		expect(wilsonLower(14, 150)).toBeGreaterThan(0.05);
	});

	it("keeps a cutoff only when the estimate it leaves is three times the draw", () => {
		expect(dateRuleHolds(14, 150, 3_000, 14).holds).toBe(true);
		// Same yield, a pool a tenth the size: about 17 eligible, fewer than the 42 required.
		const small = dateRuleHolds(14, 150, 300, 14);
		expect(small).toMatchObject({ holds: false, required: 42 });
		expect(small.estimate).toBeLessThan(42);
	});
});

// --- exclusions --------------------------------------------------------------------

describe("mentions", () => {
	const notes = mentionIndex("Scored filebrowser twice. Targets: benbusby_whoogle-search-03n6cv, Kovah/LinkAce. See notes.");

	it("finds a name inside a run directory name, where underscores and hyphens bound it", () => {
		expect(mentions(notes, "whoogle-search")).toBe(true);
		expect(mentions(notes, "benbusby_whoogle-search")).toBe(true);
	});

	it("finds a slug regardless of case", () => {
		expect(mentions(notes, "kovah/linkace")).toBe(true);
	});

	it("does not find a name inside a longer word", () => {
		expect(mentions(notes, "note")).toBe(false);
		expect(mentions(notes, "file")).toBe(false);
		expect(mentions(notes, "filebrowser")).toBe(true);
	});

	it("uses bare names in pired's notes but only slugs in run logs, which quote whole source trees", () => {
		expect(namePhrases("Acme/Shop", true)).toEqual(["acme/shop", "acme_shop", "shop"]);
		expect(namePhrases("Acme/Shop", false)).toEqual(["acme/shop", "acme_shop"]);
	});
});

// --- label hygiene -------------------------------------------------------------------

describe("isCodeLine", () => {
	it("treats comments and blank lines as no change to code, and PHP attributes and shebangs as code", () => {
		for (const t of ["", "   ", "// note", "# note", "/* note", " * more", "<!-- x -->"]) expect(isCodeLine(t)).toBe(false);
		for (const t of ["return x", "#[Route('/a')]", "#!/usr/bin/env node", "$a = 1; // trailing"]) expect(isCodeLine(t)).toBe(true);
	});
});

describe("isLabelFile", () => {
	it("labels only source the scorer reads, outside tests, docs, vendored and generated code", () => {
		expect(isLabelFile("app/Http/Controllers/FeedController.php")).toBe(true);
		expect(isLabelFile("src/api/users.ts")).toBe(true);
		for (const f of ["README.md", "web/app.vue", "tests/test_views.py", "docs/conf.py", "vendor/lib/a.php",
			"node_modules/x/index.js", "static/js/app.min.js", "handlers/assets_test.go", ".github/scripts/x.py"]) {
			expect(isLabelFile(f)).toBe(false);
		}
	});
});

describe("parseZeroContextDiff", () => {
	it("reads content by the hunk's counts, so a removed SQL comment is not taken for a file header", () => {
		const diff = [
			"diff --git a/db/query.py b/db/query.py",
			"--- a/db/query.py",
			"+++ b/db/query.py",
			"@@ -5,2 +5 @@ def q():",
			"--- select * from users",
			"-    run(sql % name)",
			"+    run(sql, (name,))",
		].join("\n");
		const [h] = parseZeroContextDiff(diff);
		expect(h).toMatchObject({ oldFile: "db/query.py", newFile: "db/query.py", oldStart: 5, oldLen: 2, newStart: 5, newLen: 1 });
		expect(h?.removed).toEqual(["-- select * from users", "    run(sql % name)"]);
	});

	it("gives an added file no pre-image and a deleted file no post-image", () => {
		const diff = [
			"diff --git a/new.go b/new.go", "new file mode 100644", "--- /dev/null", "+++ b/new.go", "@@ -0,0 +1 @@", "+package x",
			"diff --git a/old.go b/old.go", "deleted file mode 100644", "--- a/old.go", "+++ /dev/null", "@@ -1 +0,0 @@", "-package y",
		].join("\n");
		const [added, deleted] = parseZeroContextDiff(diff);
		expect(added).toMatchObject({ oldFile: null, newFile: "new.go", oldLen: 0 });
		expect(deleted).toMatchObject({ oldFile: "old.go", newFile: null, newLen: 0 });
	});

	it("drops a quoted path rather than decode it wrongly", () => {
		const diff = ['--- "a/caf\\303\\251.py"', '+++ "b/caf\\303\\251.py"', "@@ -1 +1 @@", "-x = 1", "+x = 2"].join("\n");
		expect(parseZeroContextDiff(diff)[0]?.oldFile).toBeNull();
	});

	it("reads a path git ended with a tab because it contains a space", () => {
		expect(parseZeroContextDiff("--- a/my app/x.py\t\n+++ b/my app/x.py\t\n@@ -3 +3 @@\n-a\n+b")[0]?.oldFile).toBe("my app/x.py");
	});
});

describe("labelsFromHunks", () => {
	it("places a pure insertion at the line it follows, as keyFromPatch does", () => {
		const { labels } = labelsFromHunks("CVE-1", [hunk({ oldStart: 41, oldLen: 0, newStart: 42, newLen: 2, removed: [], added: ["if not allowed(user):", "    abort(403)"] })]);
		expect(labels.map((l) => l.range)).toEqual([[41, 41]]);
	});

	it("merges hunks within six lines of each other, so no claim is graded as two finds", () => {
		const { labels } = labelsFromHunks("CVE-1", [hunk({ oldStart: 10 }), hunk({ oldStart: 17 }), hunk({ oldStart: 30 })]);
		expect(labels.map((l) => [l.range, l.hunks])).toEqual([[[10, 17], 2], [[30, 30], 1]]);
	});

	it("splits a run of hunks at hunk boundaries rather than let a label pass 31 lines", () => {
		// Before the rule, refineKey collapsed a file to one range; the widest official label spanned 501 lines.
		const hunks = [0, 6, 12, 18, 24, 30, 36].map((d) => hunk({ oldStart: 100 + d }));
		const { labels } = labelsFromHunks("CVE-1", hunks);
		expect(labels.map((l) => l.range)).toEqual([[100, 130], [136, 136]]);
		for (const l of labels) expect(l.range[1] - l.range[0] + 1).toBeLessThanOrEqual(LABEL_MAX_LINES);
	});

	it("caps a single hunk wider than 31 lines to its first 31 and remembers its real span", () => {
		const removed = Array.from({ length: 80 }, (_, i) => `line${i}()`);
		const { labels } = labelsFromHunks("CVE-1", [hunk({ oldStart: 200, oldLen: 80, removed, added: [] })]);
		expect(labels).toEqual([{ advisory: "CVE-1", file: "app/views.py", range: [200, 230], raw: [200, 279], capped: true, hunks: 1 }]);
	});

	it("labels only files the scorer reads, and counts a code fix elsewhere as unscoreable", () => {
		const { labels, unscoreable } = labelsFromHunks("CVE-1", [
			hunk({ oldFile: "web/Upload.vue", newFile: "web/Upload.vue" }),
			hunk({ oldFile: "README.md", newFile: "README.md" }),
			hunk({ oldFile: "server/upload.go", newFile: "server/upload.go" }),
		]);
		expect(labels.map((l) => l.file)).toEqual(["server/upload.go"]);
		expect(unscoreable).toBe(1);
	});

	it("does not label a hunk that only rewords a comment", () => {
		const { labels } = labelsFromHunks("CVE-1", [hunk({ removed: ["# check the user"], added: ["# check the user first"] })]);
		expect(labels).toEqual([]);
	});

	it("labels the fixed side for a clean-code control", () => {
		const { labels } = labelsFromHunks("CVE-1", [hunk({ oldStart: 40, oldLen: 1, newStart: 40, newLen: 3, added: ["a()", "b()", "c()"] })], "post");
		expect(labels.map((l) => l.range)).toEqual([[40, 42]]);
	});

	it("labels nothing in a file the fix created, since the vulnerable tree does not have it", () => {
		const { labels } = labelsFromHunks("CVE-1", [hunk({ oldFile: null, newFile: "app/guard.py", oldStart: 0, oldLen: 0 })]);
		expect(labels).toEqual([]);
	});
});

describe("wouldStrip", () => {
	it("reports a file that names an advisory, or sits under release notes, as leak stripping would delete it", () => {
		expect(wouldStrip("app/views.py", "# fixes GHSA-AAAA-bbbb-cccc", ["CVE-2026-1", "GHSA-aaaa-bbbb-cccc"])).toBe(true);
		expect(wouldStrip("changelog.d/fix.py", "x = 1", ["CVE-2026-1"])).toBe(true);
		expect(wouldStrip("app/security.py", "def check(): pass", ["CVE-2026-1"])).toBe(false);
	});
});

describe("dedupeLabels", () => {
	it("keeps the first of two labels at the same file and range, whichever advisory brought it", () => {
		const out = dedupeLabels([label("a.py", 3, 5, "CVE-1"), label("a.py", 3, 5, "CVE-2"), label("a.py", 3, 6, "CVE-2")]);
		expect(out.map((l) => [l.advisory, l.range])).toEqual([["CVE-1", [3, 5]], ["CVE-2", [3, 6]]]);
	});
});

describe("toTruth", () => {
	const byId = new Map<string, PoolAdvisory>([
		["CVE-1", adv("CVE-1", "acme/shop", { cwe: ["CWE-285", "CWE-266"], severity: "high" })],
		["CVE-3", adv("CVE-3", "acme/shop", { cwe: [], severity: null })],
	]);

	it("writes no class field, so the pinned grader scores location only", () => {
		// OSV sorts CWE ids as text: variant 1 labelled CWE-266 where the advisory's weakness is CWE-285.
		const truth = toTruth([label("a.py", 1, 2, "CVE-1"), label("b.py", 4, 4, "CVE-3")], byId);
		for (const t of truth) {
			expect(t).not.toHaveProperty("cwe");
			expect(t).not.toHaveProperty("vuln_class");
		}
	});

	it("carries every class of the advisory, in numeric order, for a re-scorer's any-of class level", () => {
		const truth = toTruth([label("a.py", 1, 2, "CVE-1"), label("b.py", 4, 4, "CVE-3")], byId);
		expect(truth.map((t) => [t.advisory, t.cwes])).toEqual([["CVE-1", ["CWE-266", "CWE-285"]], ["CVE-3", []]]);
		expect(truth[1]?.severity).toBe("unknown");
	});

	it("numbers labels per advisory and keeps the official fields in their order, the advisory id as the title", () => {
		const truth = toTruth([label("a.py", 7, 9, "CVE-1"), label("c.py", 1, 1, "CVE-3"), label("d.py", 2, 2, "CVE-1")], byId);
		expect(truth.map((t) => t.id)).toEqual(["CVE-1-1", "CVE-3-1", "CVE-1-2"]);
		expect(Object.keys(truth[0] ?? {})).toEqual(["id", "title", "severity", "file", "line", "line_range", "advisory", "cwes"]);
		expect(truth[0]).toMatchObject({ title: "CVE-1", severity: "high", line: 7, line_range: [7, 9] });
	});
});

describe("mapLabelsBack", () => {
	it("moves a label onto the reviewed tree's lines and drops one whose code changed in between", () => {
		// The later tree inserted three lines at 5 and rewrote line 50.
		const diff = "@@ -4,0 +5,3 @@\n+a\n+b\n+c\n@@ -47 +50 @@\n-x\n+y";
		const { kept, dropped } = mapLabelsBack(
			[label("a.py", 20, 22), label("a.py", 50, 50), label("gone.py", 1, 1)],
			new Map([["a.py", diff]]),
		);
		expect(kept.map((l) => l.range)).toEqual([[17, 19]]);
		expect(dropped.map((l) => l.file)).toEqual(["a.py", "gone.py"]);
	});
});

describe("the service rules", () => {
	const facts = (over: Partial<Parameters<typeof serviceVerdict>[0]> = {}) =>
		({ routeFiles: 1, templates: true, migrations: false, server: true, deploy: ["Dockerfile"], ...over });

	it("admits one routing file with templates, a server entry and a Dockerfile, as every official target has", () => {
		// fetch-apps.ts wants three route files and would reject filebrowser, whoogle-search and note-mark.
		expect(serviceVerdict(facts())).toBeUndefined();
	});

	it("rejects in the walk's order: served application, then deployable service, then a README that says framework", () => {
		expect(serviceVerdict(facts({ routeFiles: 0 }))?.filter).toBe("served application");
		expect(serviceVerdict(facts({ templates: false }))?.filter).toBe("served application");
		expect(serviceVerdict(facts({ deploy: [] }))?.filter).toBe("deployable service");
		expect(serviceVerdict(facts({ readmeKind: "a lightweight web framework" }))).toEqual({ filter: "not a framework or library", detail: 'README: "a lightweight web framework"' });
	});

	it("counts no corroboration or route file from tests, docs, examples, fixtures, mocks or archives", () => {
		// Variant 1: a server entry at Archive/Web Version/BACKEND/server.js; templates from examples/ and __fixtures__/.
		const all = ["Archive/Web Version/BACKEND/server.js", "examples/site/templates/a.html", "src/__fixtures__/db/migrations/1.sql", "src/app.ts", "Dockerfile"];
		const f = serviceFacts(all, ["Archive/Web Version/BACKEND/server.js", "src/app.ts"], ["Archive/Web Version/BACKEND/server.js"], new Set());
		expect(f).toMatchObject({ routeFiles: 0, templates: false, migrations: false, server: true, deploy: ["Dockerfile"] });
		expect(inNonServiceFolder("docs/index.py")).toBe(true);
		expect(inNonServiceFolder("app/test_views.py")).toBe(false);
	});

	it("counts no route file that is vendored or not source", () => {
		const f = serviceFacts(["app/routes.py", "app/static/vue.js", "README.md"], ["app/routes.py", "app/static/vue.js"], ["app/routes.py", "app/static/vue.js", "README.md"], new Set(["app/static/vue.js"]));
		expect(f.routeFiles).toBe(1);
	});

	it("finds a deployable-service marker at depth three or less, outside tests, docs and examples", () => {
		for (const p of ["Dockerfile", "deploy/Dockerfile.prod", "docker/compose.yaml", "docker-compose.yml", "charts/app/Chart.yaml", "Procfile", "build/api.Dockerfile"]) expect(isDeployMarker(p)).toBe(true);
		for (const p of ["a/b/c/Dockerfile", "examples/Dockerfile", "docs/docker-compose.yml", "Dockerfile.md.txt/x", "Procfile.dev", "chart.yml", "frontend/Dockerfile.dockerignore"]) expect(isDeployMarker(p)).toBe(false);
	});

	it("takes the root README, preferring Markdown", () => {
		expect(readmePath(["README.rst", "README.md", "docs/README.md"])).toBe("README.md");
		expect(readmePath(["readme.txt", "src/a.py"])).toBe("readme.txt");
		expect(readmePath(["docs/README.md"])).toBeUndefined();
	});
});

describe("frameworkPhrase", () => {
	it("finds a README that says the project is a framework, library, SDK or toolkit", () => {
		expect(frameworkPhrase("# Foo\n\nFoo is a lightweight web-framework for real-time apps.")).toBe("a lightweight web-framework");
		expect(frameworkPhrase("# Foo\nThe official Python SDK for the Foo API")).toBe("The official Python SDK");
		expect(frameworkPhrase('<p><img alt="Foo - The API and real-time application framework" src="x.png"></p>')).toBe("The API and real-time application framework");
		expect(frameworkPhrase("# Bar: a Flask extension library")).toBe("a Flask extension library");
		expect(frameworkPhrase("Baz is a UI toolkit.")).toBe("a UI toolkit");
	});

	it("leaves an application that names the framework it is built on, or keeps a library of media", () => {
		expect(frameworkPhrase("# Shop\nShop is a web app built on the Gin framework.")).toBeUndefined();
		expect(frameworkPhrase("# Shelf\nA self-hosted photo library for your family.")).toBeUndefined();
		expect(frameworkPhrase("# Notes\nA note-taking app.\n\n## Stack\n- The Gin web framework\n")).toBeUndefined();
	});

	it("reads only the first 40 lines", () => {
		expect(frameworkPhrase(`# App\n${"text\n".repeat(45)}App is a framework.`)).toBeUndefined();
	});
});

describe("vendored files", () => {
	it("treats a file over 5,000 lines, or one opening with a library's banner, as vendored", () => {
		// Variant 1: shiori's internal/view/assets/js/vue.js, 11,912 lines, made a Go application JavaScript.
		expect(isVendoredFile("x\n".repeat(5_001))).toBe(true);
		expect(isVendoredFile("x\n".repeat(4_998))).toBe(false);
		expect(libraryBanner("/*!\n * Vue.js v2.6.14\n * (c) 2014-2021 Evan You\n */")).toBe(true);
		expect(libraryBanner("/*! jQuery v3.6.0 | (c) OpenJS Foundation */")).toBe(true);
		expect(libraryBanner("/** @license React v17.0.2 */")).toBe(true);
	});

	it("does not treat a project's own licence header as a banner", () => {
		expect(libraryBanner("/*\nCopyright IBM Corp. All Rights Reserved.\nSPDX-License-Identifier: Apache-2.0\n*/\npackage lib")).toBe(false);
		expect(libraryBanner("// @license MIT\nexport const x = 1;")).toBe(false);
	});
});

describe("server route shapes", () => {
	const route = new RegExp(ROUTE_RE, "m");

	it("counts registrations on an app, a router or a server", () => {
		for (const t of ['app.get("/users", list)', "router.post('/login', h)", "apiRouter.use('/v1', r)", "fastify.get('/', h)", "adminApp.put(`/x`, h)",
			'@app.route("/")', '@bp.post("/items")', 'r.GET("/ping", h)', "Route::get('/a', X::class)", "get '/users', to: 'users#index'"]) {
			expect(route.test(t)).toBe(true);
		}
	});

	it("does not count an HTTP client call, which has the same shape", () => {
		// lib.ts once counted client.post("/login") as a route and every frontend as an application.
		for (const t of ['client.post("/login", body)', "axios.get('/api/items')", 'requests.get("/x")', "this.http.get('/api/a')", "api.post('/users', user)", 'await ky.get("/a")']) {
			expect(route.test(t)).toBe(false);
		}
	});
});

describe("import-only hunks", () => {
	it("marks Go import blocks, Python parenthesised imports and JavaScript requires as import lines", () => {
		expect([...importLines("a.go", 'package a\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc f() {}')]).toEqual([3, 4, 5, 6]);
		expect([...importLines("a.py", "import os\nfrom x import (\n    a,\n    b,\n)\ndef f():\n    pass")]).toEqual([1, 2, 3, 4, 5]);
		expect([...importLines("a.js", "const x = require('x');\nimport {\n  a,\n} from './a';\nimport './side';\nfoo();")]).toEqual([1, 2, 3, 4, 5]);
		expect([...importLines("a.php", "<?php\nuse App\\Models\\User;\n$x = 1;")]).toEqual([2]);
		expect([...importLines("a.rb", "require 'json'\nputs 1")]).toEqual([1]);
		expect(importLines("a.py", "x = 1\nprint(x)").size).toBe(0);
	});

	it("drops a hunk that only changes imports, and keeps one that also changes code", () => {
		const pre = new Set([3, 4, 5]);
		const post = new Set([3, 4, 5, 6]);
		const onlyImport: Hunk = { oldFile: "a.go", newFile: "a.go", oldStart: 4, oldLen: 0, newStart: 5, newLen: 1, removed: [], added: ['\t"strings"'] };
		expect(importOnly(onlyImport, pre, post)).toBe(true);
		const mixed: Hunk = { ...onlyImport, newStart: 6, newLen: 2, added: ['\t"strings"', "x := 1"] };
		expect(importOnly(mixed, pre, post)).toBe(false);
		expect(importOnly(onlyImport, pre, undefined)).toBe(false);
	});

	it("leaves out import-only hunks when labelling and counts them", () => {
		const imp: Hunk = { oldFile: "a.py", newFile: "a.py", oldStart: 1, oldLen: 1, newStart: 1, newLen: 1, removed: ["import os"], added: ["import os, re"] };
		const code = hunk({ oldFile: "a.py", newFile: "a.py", oldStart: 20 });
		const sides = { pre: new Map([["a.py", new Set([1])]]), post: new Map([["a.py", new Set([1])]]) };
		const r = labelsFromHunks("CVE-1", [imp, code], "pre", sides);
		expect(r.labels.map((l) => l.range)).toEqual([[20, 20]]);
		expect(r.imports).toBe(1);
	});
});

describe("git failures", () => {
	it("calls a failure transient from git's stderr or a timeout, never from digits in a path", () => {
		// Variant 1 matched 5\d\d against a message quoting the scratch path, whose digits read as an HTTP 5xx.
		expect(isTransientGitFailure(new GitError("fatal: unable to access 'x': The requested URL returned error: 502", false))).toBe(true);
		expect(isTransientGitFailure(new GitError("fatal: early EOF", false))).toBe(true);
		expect(isTransientGitFailure(new GitError("", true))).toBe(true);
		expect(isTransientGitFailure(new GitError("fatal: remote error: upload-pack: not our ref 53290abc", false))).toBe(false);
		expect(isTransientGitFailure(new Error("Command failed: git -C /tmp/x-8d72fb41-b86b-4ced-8041-212fa3b53290 fetch"))).toBe(false);
		expect(isTransientGitFailure(new Error("cannot expand short sha abc: GitHub 403"))).toBe(true);
	});

	it("keeps the last three lines of stderr, at most 300 characters", () => {
		expect(stderrTail("a\n\nb\nc\nd\n")).toBe("b | c | d");
		expect(stderrTail("x".repeat(400))).toHaveLength(300);
	});
});

describe("language", () => {
	it("treats JavaScript and TypeScript as one stratum, and knows a C project when it sees one", () => {
		expect(languageOf("src/a.ts")).toBe(languageOf("lib/b.js"));
		expect(languageOf("src/main.c")).toBe("C/C++");
		expect(languageOf("README.md")).toBeUndefined();
	});

	it("names the language with the most lines, and breaks a tie by name so file order cannot decide", () => {
		expect(dominantLanguage(new Map([["Python", 900], ["C/C++", 12_000]]))).toBe("C/C++");
		expect(dominantLanguage(new Map([["PHP", 10], ["Go", 10]]))).toBe("Go");
		expect(dominantLanguage(new Map())).toBeUndefined();
	});

	it("lists exactly the extensions the pinned scorer can read a claimed location from", async () => {
		const scorer = await readFile(new URL("../dvbank/score.ts", import.meta.url), "utf8");
		const pinned = /\\\.\(\?:([a-z|]+)\)/.exec(scorer)?.[1];
		expect(pinned).toBeDefined();
		expect(SCORER_EXT.source).toBe(`\\.(?:${pinned})$`);
	});
});

describe("the code-only checkout", () => {
	/** A sparse-checkout pattern as the test reads it: `*` then a literal tail with [xX] classes. */
	const matches = (pattern: string, path: string): boolean => {
		const tail = pattern.slice(1).replace(/\./g, "\\.");
		return new RegExp(`${tail}$`).test(path.split("/").pop() ?? "");
	};

	it("checks out every file the language count reads, whatever the case of its extension", () => {
		const patterns = sparsePatterns();
		expect(patterns).toContain("*.[pP][yY]");
		// The root README, for the framework rule; the leading slash anchors it to the root.
		expect(patterns).toContain("/[rR][eE][aA][dD][mM][eE]*");
		for (const path of ["a/b.py", "C.PHP", "x/y.Tsx", "lib/z.cpp", "App.vue", "run.sh", "m.MM"]) {
			expect(languageOf(path)).toBeDefined();
			expect(patterns.some((p) => matches(p, path))).toBe(true);
		}
		for (const path of ["logo.png", "index.html", "package.json"]) {
			expect(languageOf(path)).toBeUndefined();
			expect(patterns.some((p) => matches(p, path))).toBe(false);
		}
	});

	it("reads a NUL-separated tree listing, paths with spaces and tabs intact", () => {
		const out = "100644 blob aaaa\tapp/main.py\0" + "160000 commit bbbb\tthird/sub\0" + "100644 blob cccc\tdocs/my file.md\0";
		expect(parseLsTree(out)).toEqual([
			{ mode: "100644", path: "app/main.py" }, { mode: "160000", path: "third/sub" }, { mode: "100644", path: "docs/my file.md" },
		]);
	});

	it("sees the same files from a tree listing as walk() sees in a full checkout of it", async () => {
		const files = [
			"app/routes.py", "app/templates/index.html", "app/static/logo.png", "manage.py", "Dockerfile",
			"tests/test_app.py", "node_modules/x/index.js", "vendor/lib.php", ".github/workflows/ci.py", "web/src/App.tsx",
			"db/migrations/0001.py", "README.md", "app/.env", "dist/bundle.js",
		];
		const root = await mkdtemp(join(tmpdir(), "fresh-walk-"));
		try {
			for (const f of files) {
				await mkdir(dirname(join(root, f)), { recursive: true });
				await writeFile(join(root, f), "x\n");
			}
			const fromDisk = await walk(root);
			const fromListing = walkFromListing([...files.map((path) => ({ mode: "100644", path })), { mode: "160000", path: "ext/submodule.py" }]);
			expect([...fromListing.all].sort()).toEqual([...fromDisk.all].sort());
			expect([...fromListing.source].sort()).toEqual([...fromDisk.source].sort());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("targetName", () => {
	it("names a target by project and a tag, never by the advisory id the agent would read", () => {
		const name = targetName("Acme/Shop", "CVE-2026-1000");
		expect(name).toMatch(/^Acme_Shop-[0-9a-z]{1,6}$/);
		expect(name).not.toContain("2026");
		expect(targetName("Acme/Shop", "CVE-2026-1000")).toBe(name);
	});
});

// --- the walk ------------------------------------------------------------------------

/** A fake evaluator: verdicts by advisory id, anything unlisted ineligible. */
function fakePorts(verdicts: Record<string, Verdict>, controlsOk: Set<string> = new Set(), delay = false): DrawPorts & { calls: string[]; released: Array<[string, boolean]> } {
	const calls: string[] = [];
	const released: Array<[string, boolean]> = [];
	return {
		calls,
		released,
		async evaluate(_repo, c) {
			calls.push(c.advisory.id);
			if (delay) await new Promise((r) => setTimeout(r, (c.advisory.id.length * 7) % 5));
			return verdicts[c.advisory.id] ?? { ok: false, advisory: c.advisory.id, filter: "served application", detail: "library" };
		},
		async evaluateControl(_repo, c, e) {
			return controlsOk.has(c.advisory.id)
				? { ok: true, advisory: c.advisory.id, commit: e.fix, language: e.language, scopeFiles: 1, scopeLoc: 5_000, routes: 4, fixedRegions: [] }
				: { ok: false, advisory: c.advisory.id, filter: "no other known advisory open in the fixed tree", detail: "CVE-x open" };
		},
		async release(repo, kept) { released.push([repo, kept]); },
	};
}

const opts = { n: 2, controls: 1, maxPerLanguage: 1, triesPerRepo: 3, concurrency: 1, seed: 5 };

describe("drawSequential", () => {
	it("admits each repository's first eligible advisory, in walk order", async () => {
		const byRepo: Record<string, Candidate[]> = { "a/a": [candidate("a/a", "A1")], "b/b": [candidate("b/b", "B1")], "c/c": [candidate("c/c", "C1")] };
		const ports = fakePorts({ A1: eligible("A1", "Go"), B1: eligible("B1", "Python"), C1: eligible("C1", "PHP") }, new Set(["C1"]));
		const r = await drawSequential(["b/b", "a/a", "c/c"], (repo) => byRepo[repo] ?? [], ports, opts);
		expect(r.targets.map((t) => t.repo)).toEqual(["b/b", "a/a"]);
		expect(r.controls.map((t) => t.repo)).toEqual(["c/c"]);
		expect(r.exhausted).toBe(false);
	});

	it("tries at most three advisories of a repository before counting it ineligible", async () => {
		const cands = ["X1", "X2", "X3", "X4"].map((id) => candidate("x/x", id));
		const ports = fakePorts({ X4: eligible("X4", "Go") });
		const r = await drawSequential(["x/x"], () => cands, ports, opts);
		expect(ports.calls).toHaveLength(3);
		expect(r.targets).toEqual([]);
		expect(r.failures["served application"]).toBe(3);
		expect(r.steps[0]?.outcome).toBe("ineligible");
	});

	it("skips an eligible repository whose language already holds its share of the draw", async () => {
		const byRepo: Record<string, Candidate[]> = { "a/a": [candidate("a/a", "A1")], "b/b": [candidate("b/b", "B1")], "c/c": [candidate("c/c", "C1")] };
		const ports = fakePorts({ A1: eligible("A1", "Go"), B1: eligible("B1", "Go"), C1: eligible("C1", "Ruby") });
		const r = await drawSequential(["a/a", "b/b", "c/c"], (repo) => byRepo[repo] ?? [], ports, { ...opts, controls: 0 });
		expect(r.targets.map((t) => t.verdict.language)).toEqual(["Go", "Ruby"]);
		expect(r.steps.map((s) => s.outcome)).toEqual(["admitted", "language stratum full", "admitted"]);
		expect(r.eligible).toBe(3);
	});

	it("looks for controls only once the draw is full, and records why a candidate control failed", async () => {
		const byRepo: Record<string, Candidate[]> = {
			"a/a": [candidate("a/a", "A1")], "b/b": [candidate("b/b", "B1")], "c/c": [candidate("c/c", "C1")], "d/d": [candidate("d/d", "D1")],
		};
		const ports = fakePorts({ A1: eligible("A1", "Go"), B1: eligible("B1", "PHP"), C1: eligible("C1", "Go"), D1: eligible("D1", "Go") }, new Set(["A1", "D1"]));
		const r = await drawSequential(["a/a", "b/b", "c/c", "d/d"], (repo) => byRepo[repo] ?? [], ports, opts);
		expect(r.targets.map((t) => t.repo)).toEqual(["a/a", "b/b"]);
		expect(r.controls.map((t) => t.repo)).toEqual(["d/d"]);
		expect(r.steps[2]).toMatchObject({ repo: "c/c", outcome: "control ineligible" });
		expect(r.steps[2]?.verdicts.at(-1)).toMatchObject({ filter: "no other known advisory open in the fixed tree" });
	});

	it("draws the same targets at any concurrency, because no verdict depends on the draw", async () => {
		const repos = Array.from({ length: 40 }, (_, i) => `o/r${i}`);
		const byRepo = new Map(repos.map((r, i) => [r, [candidate(r, `R${i}a`), candidate(r, `R${i}b`)]]));
		const verdicts: Record<string, Verdict> = {};
		repos.forEach((_, i) => { if (i % 3 === 0) verdicts[`R${i}b`] = eligible(`R${i}b`, ["Go", "PHP", "Python"][i % 4 % 3] as string); });
		const order = repoOrder(repos, 99);
		const draw = async (concurrency: number) => {
			const r = await drawSequential(order, (repo) => byRepo.get(repo) ?? [], fakePorts(verdicts, new Set(Object.keys(verdicts)), true), { ...opts, n: 4, maxPerLanguage: 2, concurrency });
			return [r.targets.map((t) => t.repo), r.controls.map((t) => t.repo), r.steps.map((s) => s.outcome)];
		};
		expect(await draw(8)).toEqual(await draw(1));
	});

	it("says the walk was exhausted when the pool runs out before the draw is full", async () => {
		const ports = fakePorts({ A1: eligible("A1", "Go") });
		const r = await drawSequential(["a/a"], () => [candidate("a/a", "A1")], ports, opts);
		expect(r).toMatchObject({ exhausted: true, examined: 1, eligible: 1 });
	});

	it("releases every examined checkout, keeping only the drawn ones", async () => {
		const byRepo: Record<string, Candidate[]> = { "a/a": [candidate("a/a", "A1")], "b/b": [candidate("b/b", "B1")], "c/c": [candidate("c/c", "C1")] };
		const ports = fakePorts({ A1: eligible("A1", "Go") });
		await drawSequential(["a/a", "b/b", "c/c"], (repo) => byRepo[repo] ?? [], ports, { ...opts, n: 1, controls: 0, concurrency: 3 });
		expect(ports.released.find(([r]) => r === "a/a")).toEqual(["a/a", true]);
		expect(ports.released.filter(([, kept]) => !kept).map(([r]) => r).sort()).toEqual(["b/b", "c/c"]);
	});
});
