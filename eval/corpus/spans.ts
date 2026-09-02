/**
 * The function a line belongs to.
 *
 * A maintainer's patch for a missing check is a pure insertion at one line, so
 * the key credits that line and nothing else. But the vulnerability is not the
 * line — it is the routine that lacked the check. Measured on filebrowser
 * CVE-2025-52903: the reviewer identified the real mechanism (FILE and
 * DESTINATION expanded into a shell command), the finding resolved to
 * runner/runner.go:78, and the key is [63,63]. Same function, twelve lines
 * apart, scored as a miss.
 *
 * So this derives the enclosing function span, and scoring reports a
 * function-level axis BESIDE the line-window one. Beside, never instead of:
 * widening the primary measure after seeing what it rejected would be fitting
 * the ruler to the result. The line-window number stays exactly as it was and
 * remains the one comparable to earlier research.
 *
 * Pure module: source in, span out. Heuristic by design — a real parser per
 * language is not worth it here, and every rule below fails closed, returning
 * undefined rather than a span it is unsure of.
 */

/** Languages split by how they end a block. */
const BRACE = /\.(?:go|js|jsx|ts|tsx|mjs|cjs|java|cs|rs|kt|kts|scala|swift|c|h|cpp|hpp|php)$/i;
const INDENT = /\.(?:py|pyi)$/i;
const END_KEYWORD = /\.(?:rb|rake)$/i;

/** A line that introduces a routine, per family. */
/**
 * A line that opens a routine, across the families the corpus actually holds.
 *
 * Written as alternatives rather than one expression because Go's method
 * receiver (`func (r *Runner) Run(...)`), an anonymous function bound to a
 * variable (`var h = wrap(func(...) {`), a TS arrow and a Java method share no
 * useful shape. A single pattern that matched all of them matched half the
 * language too.
 */
function opensRoutine(text: string): boolean {
	if (!text.includes("{")) return false;
	return (
		// func / function / def / fn / sub, with any leading modifiers
		/^\s*(?:(?:export|default|public|private|protected|static|final|abstract|async)\s+)*(?:func|function|fn|sub|def)\b/.test(text)
		// an anonymous function or arrow bound to something
		|| /\b(?:func|function)\s*\(/.test(text)
		|| /=>\s*\{/.test(text)
		// a bare method: name(args) { — Java, C#, TS class members
		|| /^\s*(?:(?:public|private|protected|static|final|async)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?:[\w<>\[\], .*]+\s*)?\{/.test(text)
	);
}
const PY_DEF = /^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;
const RB_DEF = /^(\s*)def\s+[A-Za-z_]\w*[!?]?/;

export interface Span { start: number; end: number }

/**
 * The span of the routine containing `line` (1-based), or undefined.
 *
 * Undefined is the honest answer for a line at file scope — a constant, an
 * import, a route table — and for anything the heuristic cannot bracket
 * confidently.
 */
export function enclosingSpan(file: string, source: string, line: number): Span | undefined {
	const lines = source.split("\n");
	if (line < 1 || line > lines.length) return undefined;
	if (INDENT.test(file)) return pythonSpan(lines, line);
	if (END_KEYWORD.test(file)) return keywordSpan(lines, line);
	if (BRACE.test(file)) return braceSpan(lines, line);
	return undefined;
}

/** Brace languages: walk back to a definition, then match braces forward. */
function braceSpan(lines: string[], line: number): Span | undefined {
	for (let i = line - 1; i >= 0; i--) {
		const text = lines[i] ?? "";
		if (!opensRoutine(text)) continue;
		let depth = 0;
		for (let j = i; j < lines.length; j++) {
			for (const ch of lines[j] ?? "") {
				if (ch === "{") depth += 1;
				else if (ch === "}") depth -= 1;
			}
			// A definition whose body closes before the line was a different routine.
			if (depth <= 0 && j >= i) {
				return j + 1 >= line ? { start: i + 1, end: j + 1 } : undefined;
			}
		}
		return undefined;
	}
	return undefined;
}

/** Python: the block ends where indentation returns to the def's level. */
function pythonSpan(lines: string[], line: number): Span | undefined {
	for (let i = line - 1; i >= 0; i--) {
		const m = PY_DEF.exec(lines[i] ?? "");
		if (!m) continue;
		const indent = (m[1] ?? "").length;
		let end = lines.length;
		for (let j = i + 1; j < lines.length; j++) {
			const text = lines[j] ?? "";
			if (text.trim().length === 0) continue;
			const here = text.length - text.replace(/^\s*/, "").length;
			if (here <= indent) { end = j; break; }
		}
		return end >= line ? { start: i + 1, end } : undefined;
	}
	return undefined;
}

/** Ruby: `def` ... matching `end` at the same indentation. */
function keywordSpan(lines: string[], line: number): Span | undefined {
	for (let i = line - 1; i >= 0; i--) {
		const m = RB_DEF.exec(lines[i] ?? "");
		if (!m) continue;
		const indent = (m[1] ?? "").length;
		for (let j = i + 1; j < lines.length; j++) {
			const text = lines[j] ?? "";
			const here = text.length - text.replace(/^\s*/, "").length;
			if (/^\s*end\b/.test(text) && here === indent) {
				return j + 1 >= line ? { start: i + 1, end: j + 1 } : undefined;
			}
		}
		return undefined;
	}
	return undefined;
}

/** Does a reported line fall in the same routine as a truth line? */
export function sameRoutine(file: string, source: string, truthLine: number, foundLine: number): boolean {
	const span = enclosingSpan(file, source, truthLine);
	return span !== undefined && foundLine >= span.start && foundLine <= span.end;
}
