/**
 * What the sealed model may see of pired itself and of the target it reviews.
 *
 * Both leaks this closes were read from inside the seal during the 2026-09-23
 * dry run, not inferred:
 *
 * - pired's own core/*.ts comments cite the corpus it is graded on. The staged
 *   core/ is readable because pi puts the skills path in the system prompt, and
 *   `grep` there returned core/tools.ts:919 naming CVE-2025-52903's mechanism and
 *   core/identity.ts:417 naming http/share.go:84, a truth location — in both
 *   arms. stageSnapshot redacts those comment blocks and fails closed on
 *   anything else that names the corpus.
 * - note-mark's pristine tree ships site/static/icon.svg as an absolute link into
 *   /home/mamgad/corpus/clones/enchant97_note-mark/…. The seal denies the read,
 *   but `readlink` needs no access and returned the upstream repo and the fact
 *   that this is an evaluation clone. copyTargetTree rewrites such links to the
 *   in-tree file they mirror, or drops them.
 */

import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

export const SNAPSHOT_DIRS = ["bin", "core", "extensions", "checklists", "skills", "themes"] as const;
export const SNAPSHOT_FILES = ["package.json", "package-lock.json", "tsconfig.json"] as const;
/** What every line of a redacted comment block becomes; one line per line, so stack traces and cites still land. */
export const REDACTION_MARKER = "// [corpus reference redacted for evaluation]";

function sha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

export function shouldIncludeSnapshotPath(path: string): boolean {
	if (/(^|\/)(\.git|node_modules|eval|docs|research|corpus|results|artifacts|coverage|tests?|__tests__)(\/|$)/i.test(path)) return false;
	if (/(^|\/)\.env(?:\.|$)/i.test(path) || /(?:\.test|\.spec)\.[^/]+$/i.test(path)) return false;
	const first = path.split("/")[0] ?? "";
	return (SNAPSHOT_DIRS as readonly string[]).includes(first) || (SNAPSHOT_FILES as readonly string[]).includes(path);
}

export interface TreeRow { path: string; sha256: string; kind: "file" | "symlink" }
export type TreeMode = "source" | "snapshot" | "runtime";

/**
 * `snapshot` (or `true`) hashes only what a staged snapshot carries; `source`
 * (the default, or `false`) a corpus tree without VCS or vendored installs;
 * `runtime` all of node_modules, nested packages included, because the sealed
 * process loads whatever it finds there. Moved from the runner byte for byte:
 * the digests it recorded in earlier manifests must still reproduce.
 */
export async function treeManifest(root: string, selectedOnly: boolean | TreeMode = false): Promise<{ digest: string; files: number; rows: TreeRow[] }> {
	const mode: TreeMode = selectedOnly === true ? "snapshot" : selectedOnly === false ? "source" : selectedOnly;
	const abs = resolve(root);
	const rows: TreeRow[] = [];
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const rel = relative(abs, path).split("\\").join("/");
			if (mode === "snapshot" && !shouldIncludeSnapshotPath(rel)) continue;
			if (mode === "source" && /(^|\/)(\.git|node_modules)(\/|$)/.test(rel)) continue;
			// Tool caches (vitest writes node_modules/.vite on every test run) are not
			// code the sealed process loads, and would make a stable runtime look changed.
			if (mode === "runtime" && /(^|\/)\.(cache|vite|vitest)(\/|$)/.test(rel)) continue;
			const st = await lstat(path);
			if (st.isDirectory()) { await visit(path); continue; }
			if (st.isSymbolicLink()) {
				rows.push({ path: rel, sha256: sha256(await readlink(path)), kind: "symlink" });
			} else if (st.isFile()) {
				rows.push({ path: rel, sha256: sha256(await readFile(path)), kind: "file" });
			}
		}
	};
	await visit(abs);
	rows.sort((a, b) => a.path.localeCompare(b.path));
	return { digest: sha256(rows.map((r) => `${r.kind}\t${r.path}\t${r.sha256}`).join("\n")), files: rows.length, rows };
}

type EntryKind = "file" | "symlink" | "dir" | "other";

/** Every entry under `root`, links reported and never followed. */
async function walk(root: string, visit: (rel: string, abs: string, kind: EntryKind) => Promise<void>): Promise<void> {
	const recurse = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			const rel = relative(root, abs).split("\\").join("/");
			const st = await lstat(abs);
			const kind: EntryKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
			await visit(rel, abs, kind);
			if (kind === "dir") await recurse(abs);
		}
	};
	await recurse(root);
}

// ---------------------------------------------------------------------------
// Snapshot staging and redaction

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALNUM = /[A-Za-z0-9]/;
const LOWER_OR_DIGIT = /[a-z0-9]/;
const UPPER = /[A-Z]/;

/**
 * Whether `text[at]` starts, or `text[at - 1]` ends, an identifier-shaped word:
 * a non-alphanumeric neighbour, the edge of the text, or a camelCase hump (a
 * lowercase letter or digit followed by an uppercase one).
 */
function wordEdge(text: string, at: number): boolean {
	if (at <= 0 || at >= text.length) return true;
	const before = text[at - 1] as string;
	const after = text[at] as string;
	if (!ALNUM.test(before) || !ALNUM.test(after)) return true;
	return LOWER_OR_DIGIT.test(before) && UPPER.test(after);
}

/** A case-insensitive match of `lower` in `text` that starts and ends on a word edge. */
function containsWord(text: string, lowerText: string, lower: string): boolean {
	for (let at = lowerText.indexOf(lower); at !== -1; at = lowerText.indexOf(lower, at + 1)) {
		if (wordEdge(text, at) && wordEdge(text, at + lower.length)) return true;
	}
	return false;
}

/**
 * Case-insensitive match on identifier boundaries. Advisory IDs are also matched
 * with the separators squashed out, the same rule findLeaks applies:
 * `CVE_2025_52903` in a comment is the same leak as `CVE-2025-52903`.
 *
 * Project names and paths match only as whole words, a camelCase hump counting
 * as an edge. The first v6 dry run refused to stage pired at all: the fresh
 * corpus's `OpenBMB/XAgent` made `xagent` a term, and a plain substring match
 * found it inside pired's own `maxAgents` on dozens of code lines. A hump still
 * counts, so `whoogleSearch` names `whoogle`.
 */
function termMatcher(terms: string[]): (text: string) => string[] {
	const wanted = [...new Set(terms)].map((term) => {
		if (!term.trim()) throw new Error("A redaction term is empty; it would match every line.");
		return { term, lower: term.toLowerCase(), key: /^(?:CVE|GHSA)[-_ ]/i.test(term) ? squash(term) : undefined };
	});
	return (text) => {
		const lower = text.toLowerCase();
		let squashed: string | undefined;
		return wanted.filter((w) => w.key !== undefined
			? lower.includes(w.lower) || (squashed ??= squash(text)).includes(w.key)
			: containsWord(text, lower, w.lower)).map((w) => w.term);
	};
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

function scriptKind(fileName: string): ts.ScriptKind {
	if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
	if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
	if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function transpile(fileName: string, text: string): { output: string; errors: string[] } {
	const result = ts.transpileModule(text, {
		fileName, reportDiagnostics: true,
		compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
	});
	const errors = (result.diagnostics ?? []).map((d) => {
		const at = d.file && d.start !== undefined ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "";
		return `${fileName}${at}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
	});
	return { output: result.outputText, errors };
}

/**
 * Every comment the parser sees, as character ranges. Taken from the parse
 * rather than from line prefixes because a prefix cannot tell a `//` inside a
 * template literal, or a `* b` continuation of a multiplication, from a comment.
 */
function commentRanges(fileName: string, text: string): ts.CommentRange[] {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
	const ranges = new Map<number, ts.CommentRange>();
	const add = (list: ts.CommentRange[] | undefined): void => { for (const r of list ?? []) ranges.set(r.pos, r); };
	const visit = (node: ts.Node): void => {
		add(ts.getLeadingCommentRanges(text, node.getFullStart()));
		add(ts.getTrailingCommentRanges(text, node.getEnd()));
		for (const child of node.getChildren(source)) {
			// JSDoc nodes sit inside a comment; scanning trivia from their offsets
			// would read comment text as code and invent ranges past the `*/`.
			if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) continue;
			visit(child);
		}
	};
	visit(source);
	return [...ranges.values()];
}

/**
 * Replace the whole comment block around each hit line with REDACTION_MARKER
 * lines, keeping indentation and the line count. Throws — never rewrites code —
 * when a hit is on a line that carries anything but comment, or when the block
 * is not self-contained (a `/*` opened on a code line, or closed on one).
 * `hitLines` are 1-based. Exported for the tests.
 */
export function redactCommentBlocks(fileName: string, text: string, hitLines: number[]): { text: string; lines: number[] } {
	if (!SCRIPT.test(fileName)) throw new Error(`${fileName}:${hitLines.join(",")}: names the corpus outside a JS/TS source comment; refusing to rewrite it.`);
	const before = transpile(fileName, text);
	if (before.errors.length) throw new Error(`${fileName} does not parse before redaction, so its comments cannot be located: ${before.errors.join("; ")}`);
	const ranges = commentRanges(fileName, text);
	const mask = new Uint8Array(text.length);
	for (const r of ranges) mask.fill(1, r.pos, r.end);
	const lines = text.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) { starts.push(offset); offset += line.length + 1; }
	const bodyEnd = (i: number): number => starts[i]! + lines[i]!.replace(/\r$/, "").length;
	const isComment = (i: number): boolean => {
		let covered = false;
		for (let k = starts[i]!; k < bodyEnd(i); k++) {
			if (mask[k]) covered = true;
			else if (!/\s/.test(text[k]!)) return false;
		}
		// A blank line belongs to a block only when its line break is inside a
		// `/* */`; otherwise it separates two blocks and is left alone.
		return covered || (bodyEnd(i) < text.length && mask[bodyEnd(i)] === 1);
	};
	const redacted = new Map<number, string>();
	const errors: string[] = [];
	for (const hit of [...new Set(hitLines)].sort((a, b) => a - b)) {
		const h = hit - 1;
		if (h < 0 || h >= lines.length) throw new Error(`${fileName}:${hit}: hit line out of range.`);
		if (redacted.has(h)) continue;
		if (!isComment(h)) { errors.push(`${fileName}:${hit}: names the corpus on a line that is not only comment`); continue; }
		let first = h;
		let last = h;
		while (first > 0 && isComment(first - 1)) first -= 1;
		while (last < lines.length - 1 && isComment(last + 1)) last += 1;
		const from = starts[first]!;
		const to = bodyEnd(last);
		const head = lines[first]!.trim().replace(/^\uFEFF/, "");
		const partial = ranges.some((r) => r.end > from && r.pos < to && (r.pos < from || r.end > to));
		if (partial || !(head.startsWith("//") || head.startsWith("/*"))) {
			errors.push(`${fileName}:${first + 1}-${last + 1}: comment block around line ${hit} opens or closes on a code line`);
			continue;
		}
		// The block's own indentation for every line, so a JSDoc's ` * ` interior
		// does not leave a ragged ` //` column behind.
		const indent = /^[\uFEFF \t]*/.exec(lines[first]!)?.[0] ?? "";
		for (let i = first; i <= last; i++) redacted.set(i, indent);
	}
	if (errors.length) throw new Error(`Refusing to stage: ${errors.join("; ")}.`);
	for (const [i, indent] of redacted) lines[i] = indent + REDACTION_MARKER + (lines[i]!.endsWith("\r") ? "\r" : "");
	return { text: lines.join("\n"), lines: [...redacted.keys()].map((i) => i + 1).sort((a, b) => a - b) };
}

/**
 * The redacted file must parse, and with comments stripped must emit exactly
 * what the original emits — the proof that only comments changed. Exported for
 * the tests.
 */
export function verifyRedactedSource(fileName: string, before: string, after: string): void {
	if (before.split("\n").length !== after.split("\n").length) throw new Error(`${fileName}: redaction changed the line count.`);
	const a = transpile(fileName, before);
	const b = transpile(fileName, after);
	if (b.errors.length) throw new Error(`${fileName} does not parse after redaction: ${b.errors.join("; ")}`);
	if (a.output !== b.output) throw new Error(`${fileName}: redaction changed code, not just comments.`);
}

interface Leak { path: string; line?: number; terms: string[]; where: "path" | "symlink" | "binary" | "text" }

/** Every place under `root` that names a term: path, link text, binary bytes, or a text line. */
async function scanForTerms(root: string, match: (text: string) => string[]): Promise<{ leaks: Leak[]; texts: Map<string, string> }> {
	const leaks: Leak[] = [];
	const texts = new Map<string, string>();
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	await walk(root, async (rel, abs, kind) => {
		const inPath = match(rel);
		if (inPath.length) leaks.push({ path: rel, terms: inPath, where: "path" });
		if (kind === "symlink") {
			const inLink = match(await readlink(abs));
			if (inLink.length) leaks.push({ path: rel, terms: inLink, where: "symlink" });
			return;
		}
		if (kind !== "file") return;
		const buffer = await readFile(abs);
		// Text is whatever decodes as UTF-8, not whatever lacks a NUL: core/passes.ts
		// keeps a literal NUL in its CELL_SEP string and is source all the same.
		let text: string;
		try { text = utf8.decode(buffer); } catch {
			const inBytes = match(buffer.toString("latin1"));
			if (inBytes.length) leaks.push({ path: rel, terms: inBytes, where: "binary" });
			return;
		}
		let hit = false;
		text.split("\n").forEach((line, i) => {
			const terms = match(line);
			if (terms.length) { hit = true; leaks.push({ path: rel, line: i + 1, terms, where: "text" }); }
		});
		if (hit) texts.set(rel, text);
	});
	return { leaks, texts };
}

const describeLeak = (l: Leak): string => `${l.path}${l.line ? `:${l.line}` : ""} (${l.where}: ${l.terms.join(", ")})`;

export interface Redaction { path: string; lines: number[]; terms: string[]; hitLines?: number[] }
export interface StagedSnapshot { sourceDigest: string; stagedDigest: string; files: number; redactions: Redaction[] }

/**
 * Copy what the runner has always staged, then redact every comment block that
 * names a redaction term. `sourceDigest` is the input's snapshot digest before
 * any redaction — the number earlier manifests recorded — and `stagedDigest`
 * what the model actually reads. Throws on any term that is not inside a
 * complete JS/TS comment block: code, strings, markdown and JSON are never
 * rewritten, because a rewritten skill or a changed string would make the two
 * arms differ in something other than the change under test.
 */
export async function stageSnapshot(source: string, destination: string, options: { redactTerms: string[]; nodeModules: string }): Promise<StagedSnapshot> {
	const match = termMatcher(options.redactTerms);
	const sourceTree = await treeManifest(source, true);
	await mkdir(destination, { recursive: true });
	for (const name of SNAPSHOT_DIRS) {
		const from = join(source, name);
		// verbatimSymlinks: without it Node's cp rewrites a relative link to an
		// absolute path into the source tree, which the seal cannot read and which
		// changes the digest. No snapshot carries a link today; this keeps it so.
		if (await exists(from)) await cp(from, join(destination, name), {
			recursive: true, dereference: false, verbatimSymlinks: true,
			filter: (path) => shouldIncludeSnapshotPath(relative(source, path).split("\\").join("/")),
		});
	}
	for (const name of SNAPSHOT_FILES) {
		const from = join(source, name);
		if (await exists(from)) await cp(from, join(destination, name), { verbatimSymlinks: true });
	}
	await symlink(options.nodeModules, join(destination, "node_modules"), "dir");
	const copied = await treeManifest(destination, true);
	if (copied.digest !== sourceTree.digest) throw new Error(`Staged copy of ${source} does not match its input before redaction.`);

	// Plan every rewrite before writing any, so a refusal leaves no half-redacted stage.
	const found = await scanForTerms(destination, match);
	const refusals = found.leaks.filter((l) => l.where !== "text").map(describeLeak);
	const byFile = new Map<string, Leak[]>();
	for (const leak of found.leaks.filter((l) => l.where === "text")) byFile.set(leak.path, [...(byFile.get(leak.path) ?? []), leak]);
	const planned: Array<{ redaction: Redaction; before: string; after: string }> = [];
	for (const [path, leaks] of byFile) {
		const text = found.texts.get(path)!;
		const hitLines = leaks.map((l) => l.line!);
		try {
			const result = redactCommentBlocks(path, text, hitLines);
			const terms = [...new Set(leaks.flatMap((l) => l.terms))].sort();
			planned.push({ redaction: { path, lines: result.lines, terms, hitLines }, before: text, after: result.text });
		} catch (error) {
			refusals.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (refusals.length) throw new Error(`Staged snapshot names the corpus where it cannot be redacted: ${refusals.join("; ")}`);
	for (const p of planned) verifyRedactedSource(p.redaction.path, p.before, p.after);
	for (const p of planned) await writeFile(join(destination, p.redaction.path), p.after);

	const residue = await scanForTerms(destination, match);
	if (residue.leaks.length) throw new Error(`Staged snapshot still names the corpus after redaction: ${residue.leaks.map(describeLeak).join("; ")}`);
	const staged = await treeManifest(destination, true);
	const changed = new Set(planned.map((p) => p.redaction.path));
	const drift = staged.rows.length !== copied.rows.length || staged.rows.some((row, i) => {
		const was = copied.rows[i]!;
		return row.path !== was.path || row.kind !== was.kind || (row.sha256 !== was.sha256) !== changed.has(row.path);
	});
	if (drift) throw new Error("Redaction changed something other than the files it planned to rewrite.");
	return {
		sourceDigest: sourceTree.digest, stagedDigest: staged.digest, files: staged.files,
		redactions: planned.map((p) => p.redaction).sort((a, b) => a.path.localeCompare(b.path)),
	};
}

// ---------------------------------------------------------------------------
// Target copies

export interface TargetCopy {
	symlinks: Array<{ path: string; target: string; action: "relativized" | "removed"; replacement?: string }>;
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `parts` names an entry under `root` reached through real directories only. */
async function reachableWithoutLinks(root: string, parts: string[]): Promise<boolean> {
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = join(current, parts[i]!);
		const st = await lstat(current).catch(() => undefined);
		if (!st) return false;
		if (i < parts.length - 1 && !st.isDirectory()) return false;
	}
	return true;
}

/**
 * The longest trailing piece of an escaping link's target that exists in the
 * copy, as a link relative to the link's own directory. note-mark's
 * `/home/…/clones/enchant97_note-mark/frontend/public/icon.svg` becomes
 * `../../frontend/public/icon.svg`. A candidate that is the link itself or one
 * of its ancestors is skipped: the second would make a directory cycle that
 * `grep -R` or `find -L` walks forever.
 */
async function inTreeReplacement(root: string, link: string, resolved: string): Promise<string | undefined> {
	const segments = resolved.split(sep).filter((s) => s && s !== "." && s !== "..");
	for (let i = 0; i < segments.length; i++) {
		const candidate = join(root, ...segments.slice(i));
		if (candidate === link || link.startsWith(candidate + sep)) continue;
		if (await reachableWithoutLinks(root, segments.slice(i))) return relative(dirname(link), candidate) || ".";
	}
	return undefined;
}

/**
 * Copy a pristine target as the runner always has, then make every symlink
 * point inside the copy. A link whose text is absolute, or that climbs out of
 * the copy, is rewritten to the in-tree file it mirrors or removed; in-tree
 * relative links are kept verbatim. Walking never follows a link.
 */
export async function copyTargetTree(pristine: string, destination: string): Promise<TargetCopy> {
	// verbatimSymlinks: Node's default cp turns an in-tree relative link into an
	// absolute path into the pristine tree, whose directory name carries the
	// target's name — the very leak this function exists to remove.
	await cp(pristine, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
	const root = resolve(destination);
	const links: string[] = [];
	await walk(root, async (rel, _abs, kind) => { if (kind === "symlink") links.push(rel); });
	links.sort();
	const symlinks: TargetCopy["symlinks"] = [];
	for (const rel of links) {
		const abs = join(root, rel);
		const target = await readlink(abs);
		const resolved = resolve(dirname(abs), target);
		if (!isAbsolute(target) && inside(root, resolved)) continue;
		const replacement = await inTreeReplacement(root, abs, resolved);
		await unlink(abs);
		if (replacement === undefined) { symlinks.push({ path: rel, target, action: "removed" }); continue; }
		await symlink(replacement, abs);
		symlinks.push({ path: rel, target, action: "relativized", replacement });
	}
	// A link rewritten onto another link that was then removed dangles; drop it
	// too, until nothing changes, so the record says what the model can open.
	for (let changed = true; changed;) {
		changed = false;
		for (const entry of symlinks) {
			if (entry.action !== "relativized") continue;
			const abs = join(root, entry.path);
			if (await stat(abs).then(() => true, () => false)) continue;
			await unlink(abs);
			entry.action = "removed";
			delete entry.replacement;
			changed = true;
		}
	}
	const escaping: string[] = [];
	await walk(root, async (rel, abs, kind) => {
		if (kind !== "symlink") return;
		const target = await readlink(abs);
		if (isAbsolute(target) || !inside(root, resolve(dirname(abs), target))) escaping.push(`${rel} -> ${target}`);
	});
	if (escaping.length) throw new Error(`Target copy still links outside itself: ${escaping.join("; ")}`);
	return { symlinks };
}
