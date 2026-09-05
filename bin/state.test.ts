import { describe, expect, it } from "vitest";
import { buildPanelData, engagementType, pickEngagement, pickNewest, STATE_USAGE, stripAnsi, tally, truncateToWidth } from "./state.mjs";

/**
 * `pired-state --json` is a published interface: the docs invite people to hang
 * a status bar off it. A field quietly renamed or dropped breaks somebody's
 * tmux pane, and nothing else in the project would notice.
 */

describe("choosing an engagement when none was named", () => {
	it("takes the one most recently touched", () => {
		expect(pickNewest([{ name: "old", mtimeMs: 10 }, { name: "new", mtimeMs: 99 }])).toBe("new");
	});

	it("does not let an unstattable directory win by being first", () => {
		// A failed stat arrives as -1; first-past-the-post would have picked it.
		expect(pickNewest([{ name: "broken", mtimeMs: -1 }, { name: "real", mtimeMs: 5 }])).toBe("real");
	});

	it("has nothing to offer when there are no engagements", () => {
		expect(pickNewest([])).toBeUndefined();
	});
});

describe("counting", () => {
	it("tallies by value", () => {
		expect(tally(["endpoint", "endpoint", "host"])).toEqual({ endpoint: 2, host: 1 });
	});

	it("gives an empty object for nothing, not undefined", () => {
		expect(tally([])).toEqual({});
	});
});

describe("naming the engagement type", () => {
	it("reads a known target type out in words", () => {
		expect(engagementType({ targetType: "code-review" })).toBe("review · source audit");
		expect(engagementType({ targetType: "api" })).toBe("pentest · API");
	});

	it("falls back to the raw type rather than showing nothing", () => {
		expect(engagementType({ targetType: "mainframe" })).toBe("mainframe");
	});

	it("says nothing when no checklist is loaded", () => {
		expect(engagementType(undefined)).toBeUndefined();
	});
});

describe("the panel's state", () => {
	const view = {
		matrix: { applicable: 20, counts: { clear: 6, vulnerable: 2, "not-tested": 10, blocked: 2, testing: 0, "n/a": 0 } },
	};
	const stats = { coveragePct: 40, findings: { critical: 1, high: 2 } };

	function data(over = {}) {
		return buildPanelData({ name: "acme", stats, view, ...over });
	}

	it("carries the engagement and its coverage", () => {
		expect(data()).toMatchObject({ engagement: "acme", coveragePct: 40, cells: 20 });
	});

	it("counts settled as cleared plus vulnerable, and gaps as untested plus blocked", () => {
		// Settled is the work done; gaps is the work left. A blocked cell is a gap,
		// not a result — it is waiting on a person.
		expect(data()).toMatchObject({ settled: 8, gaps: 12 });
	});

	it("leaves the coverage fields undefined when there is no matrix yet", () => {
		expect(data({ view: undefined })).toMatchObject({ cells: undefined, settled: undefined, gaps: undefined });
	});

	it("tallies the surface by kind and the hypotheses by outcome", () => {
		const d = data({
			inventory: [{ kind: "endpoint" }, { kind: "endpoint" }, { kind: "host" }],
			hypotheses: [{ outcome: "confirmed" }, { outcome: "refuted" }, { outcome: "refuted" }],
		});
		expect(d.surface).toEqual({ endpoint: 2, host: 1 });
		expect(d.hypotheses).toEqual({ confirmed: 1, refuted: 2 });
	});

	it("shows the newest findings first, because a glance reads from the top", () => {
		const findings = [1, 2, 3].map((n) => ({ severity: "low", title: `f${n}` }));
		expect(data({ findings }).recentFindings.map((f) => f.title)).toEqual(["f3", "f2", "f1"]);
	});

	it("keeps the recent list to a handful — it is a glance, not a report", () => {
		const findings = Array.from({ length: 20 }, (_, i) => ({ severity: "low", title: `f${i}` }));
		expect(data({ findings }).recentFindings).toHaveLength(6);
	});

	it("shows only the blockers that are still open", () => {
		const blockers = [
			{ status: "open", question: "creds for staging?", priority: "high" },
			{ status: "answered", question: "already handled", priority: "low" },
		];
		expect(data({ blockers }).openBlockers).toEqual([{ question: "creds for staging?", priority: "high" }]);
	});

	it("reports the scope, and treats anything but a true authorization as unauthorized", () => {
		expect(data({ scope: { mode: "active", authorized: true, targets: { hosts: ["a"] } } }).scope)
			.toEqual({ mode: "active", authorized: true, targets: { hosts: ["a"] } });
		// The gate is armed or it is not; a truthy string must not read as armed.
		expect(data({ scope: { mode: "active", authorized: "yes" } }).scope?.authorized).toBe(false);
	});

	it("omits scope entirely when none is set, rather than inventing an unarmed one", () => {
		expect(data().scope).toBeUndefined();
	});

	it("keeps every documented field present, so a status bar can rely on the shape", () => {
		expect(Object.keys(data()).sort()).toEqual([
			"cells", "coverage", "coveragePct", "engagement", "engagementType", "evidence", "findings",
			"gaps", "hypotheses", "openBlockers", "recentFindings", "scope", "settled", "surface",
			"unwritten",
		]);
	});

	// The panel's renderer has drawn the cell breakdown since it shipped, and no
	// caller ever set it — so the section that owns cells was blank while the
	// hypotheses section counted them under a different word. ADR-001.
	it("passes the cell breakdown through, so the coverage section can name cells as cells", () => {
		const counts = { clear: 98, vulnerable: 7, testing: 3, blocked: 2, "not-tested": 60, "n/a": 4 };
		expect(data({ view: { matrix: { applicable: 170, counts } } }).coverage).toEqual(counts);
	});

	it("has no cell breakdown to report when there is no matrix", () => {
		expect(data({ view: undefined }).coverage).toBeUndefined();
	});

	// state.mjs is plain JS and cannot import core, so the rollups that must agree
	// with the TUI are handed in by pired-state.mjs. The defaults are the old
	// row-counting behaviour, which is wrong on a cross-product ledger but is at
	// least the behaviour every existing caller already had.
	it("counts claims with the rollup it is given, not one of its own", () => {
		const hypotheses = [
			{ id: "h1", class: "sqli", statement: "Raw SQL is interpolated", outcome: "confirmed" },
			{ id: "h2", class: "sqli", statement: "Raw SQL is interpolated", outcome: "confirmed" },
			{ id: "h3", class: "sqli", statement: "Raw SQL is interpolated", outcome: "confirmed" },
		];
		// One claim asked of three cells.
		const claims = () => ({ confirmed: 1 });
		expect(data({ hypotheses, claims }).hypotheses).toEqual({ confirmed: 1 });
		// Without one, it falls back to counting rows.
		expect(data({ hypotheses }).hypotheses).toEqual({ confirmed: 3 });
	});

	// Confirming a hypothesis and writing a finding are separate acts, and only the
	// second reaches the client. ADR-004.
	it("reports confirmed work with nothing written up for it, as claims", () => {
		const hypotheses = [
			{ id: "h1", class: "sqli", statement: "Raw SQL is interpolated", outcome: "confirmed" },
			{ id: "h2", class: "sqli", statement: "Raw SQL is interpolated", outcome: "confirmed" },
		];
		// Two cells, one claim — the same rollup the hypotheses section uses.
		const claims = (hyps: unknown[]) => (hyps.length ? { confirmed: 1 } : {});
		const unwritten = () => new Set(["h1", "h2"]);
		expect(data({ hypotheses, claims, unwritten }).unwritten).toBe(1);
	});

	it("owes nothing when no rollup says otherwise", () => {
		expect(data().unwritten).toBe(0);
	});

	it("drops disposed findings from the list, so it agrees with the severity chips", () => {
		const findings = [
			{ id: "f1", severity: "high", title: "Real one", status: "confirmed" },
			{ id: "f2", severity: "high", title: "Dismissed one", status: "false-positive" },
		];
		const isDisposed = (status: string | undefined) => status === "false-positive";
		expect(data({ findings, isDisposed }).recentFindings).toEqual([
			{ severity: "high", title: "Real one" },
		]);
	});
});

describe("fitting a coloured line into a pane", () => {
	it("measures what is shown, not the escape codes around it", () => {
		expect(stripAnsi("\x1b[1mbold\x1b[0m")).toBe("bold");
	});

	it("leaves a line that fits exactly alone, colours and all", () => {
		expect(truncateToWidth("\x1b[1mabcd\x1b[0m", 4)).toBe("\x1b[1mabcd\x1b[0m");
	});

	it("marks a cut line with an ellipsis", () => {
		// Without it a cut title reads as corrupted data rather than a narrow pane.
		expect(truncateToWidth("a very long finding title", 10)).toBe("a very lo…");
	});

	it("does not count colour against the width", () => {
		expect(truncateToWidth("\x1b[31mabcdefgh\x1b[0m", 4)).toBe("abc…");
	});

	it("survives a width of zero without throwing", () => {
		expect(truncateToWidth("abc", 0)).toBe("…");
	});
});

/**
 * "Newest anywhere under ~/.pired/engagements" is fine on a box with one
 * engagement and a coin flip on a consultant's. Run inside a target directory it
 * drew an unrelated client's panel, because a different engagement happened to
 * have a newer mtime.
 */
describe("choosing an engagement for the directory you are standing in", () => {
	const entries = [
		{ name: "acmebank", mtimeMs: 1 },
		{ name: "filebrowser_filebrowser-fetgso", mtimeMs: 99 },
	];

	it("prefers the engagement the current directory names", () => {
		expect(pickEngagement({ cwdName: "acmebank", entries }))
			.toEqual({ name: "acmebank", reason: "cwd" });
	});

	it("falls back to the newest when the directory names no engagement", () => {
		// A status bar run from nowhere in particular still wants an answer.
		expect(pickEngagement({ cwdName: "some-unrelated-dir", entries }))
			.toEqual({ name: "filebrowser_filebrowser-fetgso", reason: "newest" });
		expect(pickEngagement({ entries }).reason).toBe("newest");
	});

	it("has nothing to offer when there are no engagements at all", () => {
		expect(pickEngagement({ cwdName: "acmebank", entries: [] }))
			.toEqual({ name: undefined, reason: "newest" });
	});

	it("documents the flags the script actually accepts", () => {
		// --help used to render a panel, which is a confusing thing for a help flag
		// to do, and left every flag below undiscoverable.
		for (const flag of ["--engagement", "--mode", "--width", "--lines", "--no-frame", "--watch", "--every", "--json"]) {
			expect(STATE_USAGE).toContain(flag);
		}
	});
});

