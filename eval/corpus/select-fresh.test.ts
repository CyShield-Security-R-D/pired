import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	LABEL_MAX_LINES, SCORER_EXT, advisoryOrder, canonical, cvss3Rating, cvss3Score, dateRuleHolds, dedupeLabels,
	appWhy, dominantLanguage, drawSequential, isCodeLine, isLabelFile, isServedApp, labelsFromHunks, languageOf, mapLabelsBack, mentionIndex,
	mentions, metadataFilter, mulberry32, namePhrases, parseZeroContextDiff, poolAdvisory, poolHash, repoOrder,
	seededShuffle, targetName, toTruth, wilsonLower, wouldStrip, yearHistogram,
} from "./select-fresh.ts";
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
		["CVE-1", adv("CVE-1", "acme/shop", { cwe: ["CWE-22", "CWE-23"], severity: "high" })],
		["CVE-2", adv("CVE-2", "acme/shop", { cwe: ["CWE-79"] })],
		["CVE-3", adv("CVE-3", "acme/shop", { cwe: [], severity: null })],
	]);

	it("gives every label its advisory's first class when every contributing advisory has one", () => {
		const { truth, classed } = toTruth([label("a.py", 1, 2, "CVE-1"), label("b.py", 4, 4, "CVE-2"), label("c.py", 9, 9, "CVE-1")], byId);
		expect(classed).toBe(true);
		expect(truth.map((t) => [t.id, t.cwe, t.vuln_class])).toEqual([["CVE-1-1", "CWE-22", "CWE-22"], ["CVE-2-1", "CWE-79", "CWE-79"], ["CVE-1-2", "CWE-22", "CWE-22"]]);
	});

	it("gives no label a class when any contributing advisory lacks one, since the grader would refuse every class-naming claim against it", () => {
		// research/12: a classless label beside a classed one could not be matched by any claim that names a CWE.
		const { truth, classed } = toTruth([label("a.py", 1, 2, "CVE-1"), label("b.py", 4, 4, "CVE-3")], byId);
		expect(classed).toBe(false);
		for (const t of truth) expect(t).not.toHaveProperty("cwe");
		for (const t of truth) expect(t).not.toHaveProperty("vuln_class");
		expect(truth[1]?.severity).toBe("unknown");
	});

	it("writes the fields in the official truth files' order, with the id as the title", () => {
		const { truth } = toTruth([label("a.py", 7, 9, "CVE-1")], byId);
		expect(Object.keys(truth[0] ?? {})).toEqual(["id", "title", "cwe", "severity", "file", "line", "line_range", "vuln_class"]);
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

describe("isServedApp", () => {
	it("admits a single routing file with templates and a server entry, as filebrowser, whoogle-search and note-mark have", () => {
		// fetch-apps.ts wants route registrations in three files and would reject three of the five official targets.
		expect(isServedApp({ routeSources: 1, templates: true, migrations: false, server: true })).toBe(true);
	});

	it("rejects a project whose only route registration is outside its source, or that has nothing to serve it with", () => {
		// A README's usage example registers a route; it does not make a library an application.
		expect(isServedApp({ routeSources: 0, templates: true, migrations: true, server: true })).toBe(false);
		expect(isServedApp({ routeSources: 4, templates: true, migrations: false, server: false })).toBe(false);
	});

	it("says why, in the words the walk log records", () => {
		expect(appWhy({ routeSources: 0, templates: false, migrations: false, server: false })).toBe("0 route source file(s); no templates, migrations or server entry");
		expect(appWhy({ routeSources: 2, templates: true, migrations: true, server: false })).toBe("2 route source file(s); templates, migrations");
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
