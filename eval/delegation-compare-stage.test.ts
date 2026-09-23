import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	copyTargetTree, REDACTION_MARKER, redactCommentBlocks, shouldIncludeSnapshotPath, stageSnapshot, treeManifest, verifyRedactedSource,
} from "./delegation-compare-stage.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pired-stage-test-"));
	roots.push(root);
	return root;
}

async function write(root: string, files: Record<string, string>): Promise<void> {
	for (const [path, body] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), body);
	}
}

/** A pired checkout: shipped code plus the docs and tests a stage must leave out. */
async function checkout(files: Record<string, string> = {}): Promise<{ parent: string; source: string; destination: string; nodeModules: string }> {
	const parent = await scratch();
	const source = join(parent, "source");
	await write(source, {
		"package.json": "{\"name\":\"pired\"}\n",
		"core/plain.ts": "export const one = 1;\n",
		"core/plain.test.ts": "// the filebrowser regression\n",
		"docs/notes.md": "measured on filebrowser\n",
		"README.md": "LinkAce\n",
		...files,
	});
	const nodeModules = join(parent, "runtime-modules");
	await mkdir(nodeModules);
	return { parent, source, destination: join(parent, "stage", "a1b2c3"), nodeModules };
}

const TERMS = ["CVE-2025-52903", "filebrowser", "linkace", "http/share.go"];
const lines = (text: string): string[] => text.split("\n");

describe("shouldIncludeSnapshotPath", () => {
	it("stages shipped code and leaves tests, docs, eval material and env files behind", () => {
		expect(shouldIncludeSnapshotPath("core/tools.ts")).toBe(true);
		expect(shouldIncludeSnapshotPath("skills/ops-delegation/SKILL.md")).toBe(true);
		expect(shouldIncludeSnapshotPath("package.json")).toBe(true);
		expect(shouldIncludeSnapshotPath("core/tools.test.ts")).toBe(false);
		expect(shouldIncludeSnapshotPath("extensions/lib/tests/fixture.ts")).toBe(false);
		expect(shouldIncludeSnapshotPath("skills/x/research/notes.md")).toBe(false);
		expect(shouldIncludeSnapshotPath("bin/.env.local")).toBe(false);
		expect(shouldIncludeSnapshotPath("docs/decisions.md")).toBe(false);
		expect(shouldIncludeSnapshotPath("README.md")).toBe(false);
	});
});

describe("treeManifest", () => {
	it("reproduces the kind/path/hash digest earlier manifests recorded, so moving it out of the runner changed no pin", async () => {
		const { source } = await checkout();
		const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
		const expected = hash([
			`file\tcore/plain.ts\t${hash("export const one = 1;\n")}`,
			`file\tpackage.json\t${hash("{\"name\":\"pired\"}\n")}`,
		].join("\n"));
		const tree = await treeManifest(source, true);
		expect(tree.digest).toBe(expected);
		expect(tree.files).toBe(2);
		expect((await treeManifest(source, "snapshot")).digest).toBe(expected);
	});

	it("ignores docs and tests when hashing a snapshot, but not when hashing a source tree", async () => {
		const { source } = await checkout();
		const before = { snapshot: await treeManifest(source, true), source: await treeManifest(source) };
		await writeFile(join(source, "docs/notes.md"), "rewritten\n");
		expect((await treeManifest(source, true)).digest).toBe(before.snapshot.digest);
		expect((await treeManifest(source)).digest).not.toBe(before.source.digest);
	});
});

describe("stageSnapshot", () => {
	it("stages a snapshot that names nothing byte for byte, with the staged digest equal to the source digest", async () => {
		const { source, destination, nodeModules } = await checkout();
		const staged = await stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules });
		expect(staged.sourceDigest).toBe((await treeManifest(source, true)).digest);
		expect(staged.stagedDigest).toBe(staged.sourceDigest);
		expect(staged.files).toBe(2);
		expect(staged.redactions).toEqual([]);
		expect(await readlink(join(destination, "node_modules"))).toBe(nodeModules);
		expect(await readdir(destination)).not.toContain("docs");
	});

	it("redacts the whole // block around a corpus reference and keeps every other line where it was", async () => {
		const original = [
			"export function same(a: string, b: string): boolean {",
			"\tif (a === b) return true;",
			"\t// One bug, several sinks: the merge kept only the newest target,",
			"\t// measured on filebrowser, where http/share.go:84 was recorded",
			"\t// and then overwritten seconds later.",
			"\treturn a.endsWith(b);",
			"}",
			"",
		].join("\n");
		const { source, destination, nodeModules } = await checkout({ "core/identity.ts": original });
		const staged = await stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules });
		const after = lines(await readFile(join(destination, "core/identity.ts"), "utf8"));
		expect(after).toHaveLength(lines(original).length);
		expect(after.slice(2, 5)).toEqual(Array(3).fill(`\t${REDACTION_MARKER}`));
		expect([...after.slice(0, 2), ...after.slice(5)]).toEqual([...lines(original).slice(0, 2), ...lines(original).slice(5)]);
		expect(staged.redactions).toEqual([{ path: "core/identity.ts", lines: [3, 4, 5], hitLines: [4], terms: ["filebrowser", "http/share.go"] }]);
		expect(staged.sourceDigest).toBe((await treeManifest(source, true)).digest);
		expect(staged.stagedDigest).not.toBe(staged.sourceDigest);
		expect(staged.stagedDigest).toBe((await treeManifest(destination, true)).digest);
	});

	it("redacts a JSDoc block from its opening to its closing line without moving the declaration under it", async () => {
		const original = [
			"/**",
			" * Two locations that name the same place.",
			" *",
			" * measured on LinkAce, one SSRF was recorded six times.",
			" */",
			"export function sameLocation(a: string, b: string): boolean {",
			"\treturn a === b;",
			"}",
		].join("\n");
		const { source, destination, nodeModules } = await checkout({ "core/identity.ts": original });
		const staged = await stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules });
		const after = lines(await readFile(join(destination, "core/identity.ts"), "utf8"));
		expect(after.slice(0, 5)).toEqual(Array(5).fill(REDACTION_MARKER));
		expect(after[5]).toBe("export function sameLocation(a: string, b: string): boolean {");
		expect(after).toHaveLength(8);
		expect(staged.redactions[0]?.terms).toEqual(["linkace"]);
	});

	it("matches a term in any case and an advisory ID whatever separators it is spelled with", async () => {
		const { source, destination, nodeModules } = await checkout({
			"core/tools.ts": "// Measured on FileBrowser.\nexport const a = 1;\n// the CVE_2025_52903 mechanism\nexport const b = 2;\n",
		});
		const staged = await stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules });
		expect(staged.redactions[0]).toMatchObject({ lines: [1, 3], terms: ["CVE-2025-52903", "filebrowser"] });
	});

	it("refuses a corpus reference in code rather than rewriting it, and leaves every other file unredacted", async () => {
		const { source, destination, nodeModules } = await checkout({
			"core/a.ts": "// measured on filebrowser\nexport const a = 1;\n",
			"core/b.ts": "export const target = \"http/share.go\";\n",
		});
		await expect(stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules })).rejects.toThrow(/core\/b\.ts:1/);
		// Planned before written: a refusal must not leave a half-redacted stage behind.
		expect(await readFile(join(destination, "core/a.ts"), "utf8")).toBe("// measured on filebrowser\nexport const a = 1;\n");
	});

	it("refuses a corpus reference in a trailing comment, because redacting its line would delete code", async () => {
		const { source, destination, nodeModules } = await checkout({ "core/a.ts": "export const a = 1; // filebrowser\n" });
		await expect(stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules })).rejects.toThrow(/not only comment/);
	});

	it("refuses a block comment that opens on a code line, since the block cannot be replaced whole", async () => {
		const { source, destination, nodeModules } = await checkout({
			"core/a.ts": "export const a = 1; /* the first line\n * measured on filebrowser\n */\nexport const b = 2;\n",
		});
		await expect(stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules })).rejects.toThrow(/opens or closes on a code line/);
	});

	it("treats a comment-shaped line inside a template literal as the string it is", async () => {
		const { source, destination, nodeModules } = await checkout({
			"core/a.ts": "export const help = `\n// see the filebrowser notes\n`;\n",
		});
		await expect(stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules })).rejects.toThrow(/core\/a\.ts:2/);
	});

	it("refuses a corpus reference in a skill's markdown or in JSON, which are never rewritten", async () => {
		const skill = await checkout({ "skills/triage/SKILL.md": "# Triage\n\nAs on filebrowser, check hooks.\n" });
		await expect(stageSnapshot(skill.source, skill.destination, { redactTerms: TERMS, nodeModules: skill.nodeModules }))
			.rejects.toThrow(/skills\/triage\/SKILL\.md:3/);
		const json = await checkout({ "themes/red.json": "{\"name\": \"linkace\"}\n" });
		await expect(stageSnapshot(json.source, json.destination, { redactTerms: TERMS, nodeModules: json.nodeModules }))
			.rejects.toThrow(/themes\/red\.json:1/);
	});

	it("refuses a corpus name carried by a file name or a link's text, which no comment redaction can reach", async () => {
		const named = await checkout({ "skills/filebrowser-hooks/SKILL.md": "# Hooks\n" });
		await expect(stageSnapshot(named.source, named.destination, { redactTerms: TERMS, nodeModules: named.nodeModules }))
			.rejects.toThrow(/path: filebrowser/);
		const linked = await checkout();
		await symlink("/srv/clones/filebrowser/icon.svg", join(linked.source, "core/icon.svg"));
		await expect(stageSnapshot(linked.source, linked.destination, { redactTerms: TERMS, nodeModules: linked.nodeModules }))
			.rejects.toThrow(/core\/icon\.svg \(symlink: filebrowser\)/);
	});

	it("writes nothing outside the destination and leaves the source tree untouched", async () => {
		const { parent, source, destination, nodeModules } = await checkout({ "core/a.ts": "// measured on filebrowser\nexport const a = 1;\n" });
		const sourceBefore = await treeManifest(source);
		const parentBefore = await readdir(parent);
		const modulesBefore = await readdir(nodeModules);
		await stageSnapshot(source, destination, { redactTerms: TERMS, nodeModules });
		expect((await treeManifest(source)).digest).toBe(sourceBefore.digest);
		expect((await readdir(parent)).sort()).toEqual([...parentBefore, "stage"].sort());
		expect(await readdir(join(parent, "stage"))).toEqual(["a1b2c3"]);
		expect(await readdir(nodeModules)).toEqual(modulesBefore);
	});

	it("rejects an empty term instead of letting it match every line", async () => {
		const { source, destination, nodeModules } = await checkout();
		await expect(stageSnapshot(source, destination, { redactTerms: ["filebrowser", " "], nodeModules })).rejects.toThrow(/empty/);
	});
});

describe("redactCommentBlocks", () => {
	it("stops a block at a blank line, so a neighbouring comment that names nothing survives", () => {
		const text = "// kept: names nothing\n\n// measured on filebrowser\nexport const a = 1;\n";
		const result = redactCommentBlocks("core/a.ts", text, [3]);
		expect(lines(result.text)).toEqual(["// kept: names nothing", "", REDACTION_MARKER, "export const a = 1;", ""]);
		expect(result.lines).toEqual([3]);
	});

	it("keeps a CRLF file's line endings", () => {
		const result = redactCommentBlocks("core/a.ts", "// filebrowser\r\nexport const a = 1;\r\n", [1]);
		expect(result.text).toBe(`${REDACTION_MARKER}\r\nexport const a = 1;\r\n`);
	});

	it("refuses to touch a file that is not JS or TS source", () => {
		expect(() => redactCommentBlocks("bin/setup.sh", "# filebrowser\n", [1])).toThrow(/outside a JS\/TS source comment/);
	});
});

describe("verifyRedactedSource", () => {
	it("rejects a rewrite that no longer parses", () => {
		expect(() => verifyRedactedSource("core/a.ts", "const a = 1;\n", "const a = ;\n")).toThrow(/does not parse after redaction/);
	});

	it("rejects a rewrite that still parses but changed code, not just comments", () => {
		expect(() => verifyRedactedSource("core/a.ts", "const a = 1; // x\n", "const a = 2; // y\n")).toThrow(/changed code/);
	});

	it("accepts a rewrite that replaced only comments", () => {
		expect(() => verifyRedactedSource("core/a.ts", "/** filebrowser */\nconst a = 1;\n", `${REDACTION_MARKER}\nconst a = 1;\n`)).not.toThrow();
	});
});

describe("copyTargetTree", () => {
	async function pristine(): Promise<{ parent: string; tree: string; destination: string }> {
		const parent = await scratch();
		const tree = join(parent, "app-x1y2z3.pristine");
		await write(tree, { "frontend/public/icon.svg": "<svg/>\n", "site/static/.keep": "" });
		return { parent, tree, destination: join(parent, "cell", "target") };
	}

	it("rewrites note-mark's absolute clone link onto the in-tree file its path ends in", async () => {
		const { tree, destination } = await pristine();
		const target = "/home/user/corpus/clones/enchant97_note-mark/frontend/public/icon.svg";
		await symlink(target, join(tree, "site/static/icon.svg"));
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([{ path: "site/static/icon.svg", target, action: "relativized", replacement: "../../frontend/public/icon.svg" }]);
		expect(await readlink(join(destination, "site/static/icon.svg"))).toBe("../../frontend/public/icon.svg");
		expect(await readFile(join(destination, "site/static/icon.svg"), "utf8")).toBe("<svg/>\n");
	});

	it("removes an absolute link whose target has no counterpart in the copy", async () => {
		const { tree, destination } = await pristine();
		await symlink("/home/user/corpus/clones/app/assets/logo.png", join(tree, "site/static/logo.png"));
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([{ path: "site/static/logo.png", target: "/home/user/corpus/clones/app/assets/logo.png", action: "removed" }]);
		await expect(lstat(join(destination, "site/static/logo.png"))).rejects.toThrow(/ENOENT/);
	});

	it("keeps an in-tree relative link verbatim instead of pointing it back at the pristine tree", async () => {
		const { tree, destination } = await pristine();
		// Node's cp without verbatimSymlinks rewrites this to /…/app-x1y2z3.pristine/frontend/…,
		// a path the seal cannot read and whose name carries the target.
		await symlink("../../frontend/public/icon.svg", join(tree, "site/static/icon.svg"));
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([]);
		expect(await readlink(join(destination, "site/static/icon.svg"))).toBe("../../frontend/public/icon.svg");
	});

	it("rewrites or removes a relative link that climbs out of the copy", async () => {
		const { tree, destination } = await pristine();
		await symlink("../../../clones/app/frontend/public/icon.svg", join(tree, "site/static/icon.svg"));
		await symlink("../../../../../etc/passwd", join(tree, "site/static/passwd"));
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([
			{ path: "site/static/icon.svg", target: "../../../clones/app/frontend/public/icon.svg", action: "relativized", replacement: "../../frontend/public/icon.svg" },
			{ path: "site/static/passwd", target: "../../../../../etc/passwd", action: "removed" },
		]);
	});

	it("never points a link at one of its own ancestors, which would make a directory cycle", async () => {
		const { tree, destination } = await pristine();
		await symlink("/home/user/corpus/clones/app/site", join(tree, "site/static/up"));
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([{ path: "site/static/up", target: "/home/user/corpus/clones/app/site", action: "removed" }]);
	});

	it("follows a chain of mirrored links to the file at its end, and drops a link whose in-tree target was dropped", async () => {
		const { tree, destination } = await pristine();
		await write(tree, { "debian/setup.sh": "#!/bin/sh\n" });
		await mkdir(join(tree, "ubuntu"));
		await symlink("/home/user/corpus/clones/app/debian/setup.sh", join(tree, "ubuntu/setup.sh"));
		await symlink("/home/user/corpus/clones/app/ubuntu/setup.sh", join(tree, "jammy.sh"));
		await symlink("/home/user/corpus/clones/app/gone/file", join(tree, "ubuntu/stale"));
		await symlink("/home/user/corpus/clones/app/ubuntu/stale", join(tree, "points-at-stale"));
		const copy = await copyTargetTree(tree, destination);
		expect(await readFile(join(destination, "jammy.sh"), "utf8")).toBe("#!/bin/sh\n");
		expect(copy.symlinks.find((l) => l.path === "points-at-stale")?.action).toBe("removed");
		expect(copy.symlinks.find((l) => l.path === "ubuntu/stale")?.action).toBe("removed");
		await expect(lstat(join(destination, "points-at-stale"))).rejects.toThrow(/ENOENT/);
	});

	it("does not follow a link into an outside directory while walking, and writes nothing there or in the pristine tree", async () => {
		const { parent, tree, destination } = await pristine();
		const outside = join(parent, "outside");
		await write(outside, { "secret.txt": "answer\n" });
		await symlink("/nowhere/at/all", join(outside, "dangling"));
		await symlink(outside, join(tree, "vendor"));
		const pristineBefore = await treeManifest(tree);
		const outsideBefore = await treeManifest(outside);
		const copy = await copyTargetTree(tree, destination);
		expect(copy.symlinks).toEqual([{ path: "vendor", target: outside, action: "removed" }]);
		expect((await treeManifest(tree)).digest).toBe(pristineBefore.digest);
		expect((await treeManifest(outside)).digest).toBe(outsideBefore.digest);
		expect((await readdir(parent)).sort()).toEqual(["app-x1y2z3.pristine", "cell", "outside"]);
	});
});
