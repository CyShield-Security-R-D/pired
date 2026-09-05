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

/**
 * Count how many of each value there are.
 *
 * @param {string[]} values
 * @returns {Record<string, number>}
 */
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
 *
 * @param {Array<{ name: string; mtimeMs: number }>} entries
 * @returns {string | undefined}
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

/**
 * The label for a checklist's target type, or the raw type when it is unknown.
 *
 * @param {{ targetType?: string } | undefined} checklist
 * @returns {string | undefined}
 */
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
 *
 * @param {object} input
 * @param {string} input.name
 * @param {{ targetType?: string }} [input.checklist]
 * @param {{ mode?: string; authorized?: unknown; targets?: unknown }} [input.scope]
 * @param {{ coveragePct?: number; findings?: unknown }} [input.stats]
 * @param {{ matrix: { applicable: number; counts: Record<string, number> } }} [input.view]
 * @param {Array<{ kind: string }>} [input.inventory]
 * @param {Array<{ outcome: string }>} [input.hypotheses]
 * @param {Array<{ severity: string; title: string }>} [input.findings]
 * @param {Array<{ status: string; question: string; priority: string }>} [input.blockers]
 * @param {number} [input.evidence]
 */
/**
 * Hypothesis rows counted by outcome — the fallback when nobody hands us core's
 * claim rollup.
 *
 * @param {{outcome?: string}[]} hyps
 * @returns {Record<string, number>}
 */
const rowCounts = (hyps) => tally(hyps.map((h) => h.outcome));

/**
 * The panel's data, and the two pure functions it will not import.
 *
 * This file is plain JS so the `--json` contract can be tested without a build
 * step, which also means it cannot reach `core/*.ts` — node refuses to strip
 * types under node_modules, which is the whole reason `pired-state.mjs` mirrors
 * the sources to a cache first. So the two rollups that must agree with the TUI
 * are injected by the caller that already has the mirrored core loaded, rather
 * than reimplemented here where they would drift. See ADR-001.
 *
 * @param {object} o
 * @param {string} o.name
 * @param {any} [o.checklist]
 * @param {any} [o.scope]
 * @param {any} [o.stats]
 * @param {any} [o.view]
 * @param {any[]} [o.inventory]
 * @param {any[]} [o.hypotheses]
 * @param {any[]} [o.findings]
 * @param {any[]} [o.blockers]
 * @param {number} [o.evidence]
 * @param {(hyps: any[]) => Record<string, number>} [o.claims] Core's claim rollup.
 * @param {(status: string | undefined) => boolean} [o.isDisposed]
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
	claims = rowCounts,
	isDisposed = () => false,
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
		// The cell breakdown the coverage section was designed to carry and no
		// caller ever filled in.
		coverage: view?.matrix.counts,
		surface: tally(inventory.map((r) => r.kind)),
		// Claims; the coverage row above owns cells.
		hypotheses: claims(hypotheses),
		findings: stats?.findings,
		// Newest first, and only a handful: the panel is a glance, not a report.
		// Disposed findings are dropped here for the same reason they are dropped
		// from `stats.findings` — otherwise the chips and the list below them
		// disagree about the same ledger.
		recentFindings: findings.filter((f) => !isDisposed(f.status)).slice(-6).reverse()
			.map((f) => ({ severity: f.severity, title: f.title })),
		openBlockers: open.map((b) => ({ question: b.question, priority: b.priority })),
		evidence,
	};
}

/**
 * Drop SGR escapes, so a coloured string can be measured by what it shows.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Cut a line to a visible width, marking that it was cut.
 *
 * The ellipsis is the difference between "this line was cut" and "the title ends
 * mid-word", which reads as corrupted data rather than as a narrow pane.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncateToWidth(text, width) {
	const bare = stripAnsi(text);
	if (bare.length <= width) return text;
	return `${bare.slice(0, Math.max(0, width - 1))}…`;
}
