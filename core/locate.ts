/**
 * Resolve a finding's line from the source it names, rather than from the model.
 *
 * The extractor is told "never guess a line number; omit the field instead" —
 * correctly, because a guessed line that lands inside a truth window is a false
 * positive wearing a true positive's clothes. But a finding located only as
 * "share.go" is uncitable in a report and invisible to scoring, so the two rules
 * together produced findings that could never count.
 *
 * The way out is not to relax either rule. A finding that names a sink almost
 * always names it twice — the file, and the function or route inside it — and
 * the file is on disk. Looking up where that symbol is defined is reading, not
 * guessing: the answer comes from the code, is deterministic, and is wrong only
 * if the symbol genuinely is not there, in which case nothing is written.
 *
 * Pure module: text in, line out. No ports, no I/O.
 */

/** Words that look like identifiers but carry no location. */
const STOP = new Set([
	"this", "that", "with", "from", "when", "where", "which", "there", "their", "these", "those",
	"user", "users", "file", "files", "line", "lines", "code", "call", "calls", "data", "value",
	"input", "output", "check", "checks", "error", "errors", "request", "response", "server",
	"client", "handler", "handlers", "function", "method", "class", "return", "returns", "string",
	"true", "false", "null", "none", "type", "name", "path", "http", "https", "json", "html",
	"allow", "allows", "allowed", "without", "before", "after", "into", "then", "than", "does",
	"not", "and", "the", "for", "any", "all", "can", "may", "via", "its", "it", "is", "are",
	"was", "were", "has", "have", "been", "being", "only", "also", "same", "other", "each",
	"attacker", "arbitrary", "vulnerable", "vulnerability", "security", "issue", "flaw",
]);

/**
 * Identifiers worth looking up: camelCase, snake_case, or dotted calls are code;
 * a lone lowercase English word usually is not.
 */
export function sinkHints(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
		const raw = m[0];
		// A dotted call keeps its qualifier: `time.Hour` and `f.Stat` identify
		// something, `Hour` and `Stat` identify a line at random. Taking the method
		// alone put findings on `time.Hour` at line 20 and `.Stat()` at line 134,
		// neither of which was the sink the finding described.
		const bare = raw.includes(".") ? raw : raw;
		const tail = raw.includes(".") ? (raw.split(".").pop() ?? raw) : raw;
		if (tail.length < 4 || bare.length > 60) continue;
		if (STOP.has(tail.toLowerCase())) continue;
		// Shape test: an internal case change, an underscore, or a dotted call.
		//
		// Being merely capitalised is NOT enough — English sentences capitalise, and
		// accepting it resolved findings onto "Token", "URLs" and "Stat", which put
		// three false positives in the ledger and located none of them at a sink.
		// A location guessed off a prose word is worse than no location: it is
		// unfalsifiable in the report and scores as a wrong answer rather than a
		// blank one.
		// A dotted expression qualifies itself; anything else must carry an internal
		// case change or an underscore to count as code.
		const codeShaped = /[a-z][A-Z]/.test(tail) || tail.includes("_") || raw.includes(".");
		if (!codeShaped) continue;
		const push = (v: string): void => {
			const key = v.toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);
			out.push(v);
		};
		push(bare);
		// Also offer the bare method when it stands on its own as an identifier, so
		// a call written `afero.NewBasePathFs` still resolves in a file that imported
		// it unqualified. `Hour` and `Stat` do not qualify and stay out.
		if (raw.includes(".") && (/[a-z][A-Z]/.test(tail) || tail.includes("_"))) push(tail);
	}
	// Longest first: the most specific identifier is the one worth trusting.
	return out.sort((a, b) => b.length - a.length);
}

/** Lines that introduce a symbol, across the languages the corpus actually holds. */
function definitionAt(line: string, ident: string): boolean {
	const i = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`\\b(?:func|def|function|class|type|var|let|const|public|private|protected|static|sub|fn)\\b[^\\n]*\\b${i}\\b`,
		// Assignment or property form (`foo = (x) => …`, `foo: function …`). NOT a
		// bare `foo(` — at an indent that is a call, and calling a sink is exactly
		// what a mention is.
	).test(line) || new RegExp(`^\\s*(?:async\\s+)?${i}\\s*[:=][^=]`).test(line);
}

export interface SinkLocation {
	line: number;
	/** The identifier that resolved it, for saying why in the record. */
	symbol: string;
	/** A definition is a stronger answer than a mention. */
	kind: "definition" | "mention";
}

/**
 * Find the line in `source` that best matches one of `hints`.
 *
 * A definition beats a mention, and a longer identifier beats a shorter one,
 * because "shareDeleteHandler" identifies a sink and "Delete" does not. Returns
 * undefined when nothing matches — the finding then stays unlocated and says so,
 * which is the honest outcome and the one that keeps a wrong line out of the
 * ledger.
 */
export function locateSink(source: string, hints: string[]): SinkLocation | undefined {
	if (source.length === 0 || hints.length === 0) return undefined;
	const lines = source.split("\n");
	let mention: SinkLocation | undefined;
	for (const symbol of hints) {
		const word = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
		for (const [i, line] of lines.entries()) {
			if (!word.test(line)) continue;
			if (definitionAt(line, symbol)) return { line: i + 1, symbol, kind: "definition" };
			// Keep the first mention as a fallback, but keep looking for a definition
			// — of any hint, not just this one.
			mention ??= { line: i + 1, symbol, kind: "mention" };
			break;
		}
	}
	return mention;
}
