import { describe, expect, it } from "vitest";
import { locateSink, sinkHints, locateAcrossFiles } from "./locate.ts";

const GO = `package http

import "net/http"

func withUser(fn handleFunc) handleFunc {
	return withMode(fn)
}

func shareDeleteHandler(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path
	deleteShare(id)
}
`;

describe("pulling the sink identifier out of a finding", () => {
	it("takes code-shaped names and leaves prose alone", () => {
		const h = sinkHints("Share deletion lacks ownership check in shareDeleteHandler");
		expect(h).toContain("shareDeleteHandler");
		expect(h).not.toContain("deletion");
		expect(h).not.toContain("check");
	});

	it("keeps a dotted call whole and also offers the method when it is an identifier", () => {
		const h = sinkHints("reaches afero.NewBasePathFs without resolving");
		expect(h).toContain("afero.NewBasePathFs");
		expect(h).toContain("NewBasePathFs");
	});

	it("puts the most specific identifier first", () => {
		expect(sinkHints("withUser and shareDeleteHandler")[0]).toBe("shareDeleteHandler");
	});
});

describe("resolving the line from the source it names", () => {
	it("finds the definition, not the first mention", () => {
		const at = locateSink(GO, ["shareDeleteHandler"]);
		expect(at).toMatchObject({ line: 9, kind: "definition", symbol: "shareDeleteHandler" });
	});

	it("prefers a definition of any hint over a mention of the first", () => {
		// deleteShare is only ever called; withUser is defined.
		expect(locateSink(GO, ["deleteShare", "withUser"])?.kind).toBe("definition");
	});

	it("falls back to a mention when nothing is defined", () => {
		expect(locateSink(GO, ["deleteShare"])).toMatchObject({ line: 11, kind: "mention" });
	});

	it("returns nothing when the symbol is not in the file", () => {
		// The honest answer: better unlocated than located wrongly.
		expect(locateSink(GO, ["tusUploadHandler"])).toBeUndefined();
	});

	it("returns nothing for an empty file or no hints", () => {
		expect(locateSink("", ["withUser"])).toBeUndefined();
		expect(locateSink(GO, [])).toBeUndefined();
	});

	it("does not match a substring of a longer identifier", () => {
		expect(locateSink("func deleteShareForever() {}\n", ["deleteShare"])).toBeUndefined();
	});
});

describe("hints that would locate a finding on a prose word", () => {
	it("rejects a merely capitalised word", () => {
		// These three resolved real findings onto meaningless lines on a live run.
		const h = sinkHints("Authentication Token accepted in URLs by Stat");
		expect(h).not.toContain("Token");
		expect(h).not.toContain("URLs");
		expect(h).not.toContain("Stat");
	});

	it("still takes a capitalised identifier with an internal case change", () => {
		expect(sinkHints("calls NewBasePathFs here")).toContain("NewBasePathFs");
	});
});

describe("a dotted call keeps the qualifier that makes it specific", () => {
	it("keeps time.Hour whole rather than reducing it to Hour", () => {
		const h = sinkHints("expiry uses time.Hour grace period");
		expect(h).toContain("time.Hour");
		expect(h).not.toContain("Hour");
	});

	it("keeps the receiver on a method call", () => {
		expect(sinkHints("calls f.Stat on the target")).toContain("f.Stat");
	});
});

describe("locating a finding that names a sink but no file at all", () => {
	const files = [
		{ path: "runner/runner.go", body: 'case "FILE":\n\treturn path\ncase "DESTINATION":\n\treturn dst\n' },
		{ path: "http/auth.go", body: "func withUser(fn handleFunc) handleFunc {\n\treturn fn\n}\n" },
		{ path: "http/static.go", body: 'var FILE = "x"\n' },
	];

	it("takes SHOUTED identifiers as hints", () => {
		// Without these the real CVE-2025-52903 finding produced no hints at all.
		const h = sinkHints("FILE and DESTINATION values are expanded into the hook command");
		expect(h).toContain("FILE");
		expect(h).toContain("DESTINATION");
	});

	it("finds the one file that carries the named sinks", () => {
		const hit = locateAcrossFiles(files, ["FILE", "DESTINATION"]);
		expect(hit?.path).toBe("runner/runner.go");
	});

	it("declines when two files match equally well", () => {
		const tie = [
			{ path: "a.go", body: "ALPHA\nBETA\n" },
			{ path: "b.go", body: "ALPHA\nBETA\n" },
		];
		expect(locateAcrossFiles(tie, ["ALPHA", "BETA"])).toBeUndefined();
	});

	it("declines when only one hint matches anywhere", () => {
		expect(locateAcrossFiles(files, ["FILE"])).toBeUndefined();
	});

	it("declines when there are no hints", () => {
		expect(locateAcrossFiles(files, [])).toBeUndefined();
	});
});
