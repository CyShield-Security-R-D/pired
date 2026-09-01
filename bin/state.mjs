/**
 * What `pired-state` reports, separated from how it reads and prints it.
 *
 * The `--json` output is a published interface — the docs invite people to hang
 * their own status bar off it — so its shape is a contract, and a contract with
 * no test is a shape that drifts. The rest of `pired-state.mjs` is filesystem
 * and ANSI; this is the part with an answer that can be wrong.
 *
 * Plain JavaScript, for the reason given in launch.mjs.
 */

/** How a checklist's target type reads to a person. */
export const ENGAGEMENT_TYPES = {
	"code-review": "review · source audit",
	web: "pentest · web application",
	api: "pentest · API",
	network: "pentest · network",
};

/** Count how many of each value there are. */
export function tally(values) {
	const out = {};
	for (const v of values) out[v] = (out[v] ?? 0) + 1;
	return out;
}

/**
 * The engagement to show when none was named: the one most recently touched.
 *
 * Entries are `{ name, mtimeMs }`; anything that could not be stat'd arrives
 * with -1 and loses to everything, rather than winning by being first.
 */
export function pickNewest(entries) {
	let best;
	let bestT = -1;
	for (const e of entries) {
		if (e.mtimeMs > bestT) {
			bestT = e.mtimeMs;
			best = e.name;
		}
	}
	return best;
}

/** The label for a checklist's target type, or the raw type when it is unknown. */
export function engagementType(checklist) {
	if (!checklist) return undefined;
	return ENGAGEMENT_TYPES[checklist.targetType] ?? checklist.targetType;
}

/**
 * The panel's state, as both the renderer and the JSON consumer see it.
 *
 * Derived from pired's own computations rather than from the .jsonl files, so
 * an external panel and the TUI can never disagree — an earlier version scraped
 * the ledgers directly and could.
 */
export function buildPanelData({
	name,
	checklist,
	scope,
	stats,
	view,
	inventory = [],
	hypotheses = [],
	findings = [],
	blockers = [],
	evidence = 0,
}) {
	const open = blockers.filter((b) => b.status === "open");
	return {
		engagement: name,
		engagementType: engagementType(checklist),
		scope: scope
			? { mode: scope.mode, authorized: scope.authorized === true, targets: scope.targets ?? {} }
			: undefined,
		coveragePct: stats?.coveragePct,
		cells: view?.matrix.applicable,
		settled: view ? view.matrix.counts.clear + view.matrix.counts.vulnerable : undefined,
		gaps: view ? view.matrix.counts["not-tested"] + view.matrix.counts.blocked : undefined,
		surface: tally(inventory.map((r) => r.kind)),
		hypotheses: tally(hypotheses.map((h) => h.outcome)),
		findings: stats?.findings,
		// Newest first, and only a handful: the panel is a glance, not a report.
		recentFindings: findings.slice(-6).reverse().map((f) => ({ severity: f.severity, title: f.title })),
		openBlockers: open.map((b) => ({ question: b.question, priority: b.priority })),
		evidence,
	};
}

/** Drop SGR escapes, so a coloured string can be measured by what it shows. */
export function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Cut a line to a visible width, marking that it was cut.
 *
 * The ellipsis is the difference between "this line was cut" and "the title ends
 * mid-word", which reads as corrupted data rather than as a narrow pane.
 */
export function truncateToWidth(text, width) {
	const bare = stripAnsi(text);
	if (bare.length <= width) return text;
	return `${bare.slice(0, Math.max(0, width - 1))}…`;
}
