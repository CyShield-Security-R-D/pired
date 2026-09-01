/**
 * The engagement panel — pired's ledger, shown to the operator directly.
 *
 * The transcript is the conversation; this is the state. Until this existed the
 * operator could only see coverage, findings or blockers by asking the agent to
 * recall them, which is backwards: the ledger is the operator's artifact.
 *
 * Design notes, because a side rail is mostly a typography problem:
 *
 * - It reuses the coverage matrix's glyph vocabulary (● clear, ▲ vulnerable,
 *   ◐ testing, ⊘ blocked, · untested) so a status means the same thing wherever
 *   it appears in the tool.
 * - Colour carries meaning only — severity and outcome — never decoration.
 *   Everything structural is dim.
 * - Sections are dropped from the bottom when space is short, but a blocker
 *   always survives: it is the one line that needs a human, and losing it to a
 *   short terminal would defeat the purpose of showing it.
 * - Numbers are column-aligned so the eye can scan them without reading.
 *
 * Pure module: colour and measurement are injected, so it renders identically in
 * the TUI overlay, a tmux pane and a test.
 */

import { frameLines, RULE } from "./frame.ts";
import type { Severity } from "./ontology.ts";

export const PANEL_MODES = ["state", "coverage", "findings", "blockers"] as const;

/**
 * How to tell the operator to dismiss the panel, for a given `process.platform`.
 *
 * A panel shown without being asked for must name a way out that actually works
 * on the machine reading it. On macOS it usually is not the shortcut: Terminal
 * and iTerm send Option+P as `π` unless the profile is set to treat Option as
 * Meta, so `alt+p` is advice that silently types a character instead. The slash
 * command works on every platform and every terminal, so that is what a Mac is
 * told. The shortcut still fires wherever the terminal does send Meta.
 */
export function dismissHint(platform: string, width = 0): string {
	const mac = platform === "darwin";
	const expand = mac ? "/maximize" : "alt+m";
	const hide = mac ? "/panel" : "alt+p";
	// Advertise expanding first: hiding is discoverable by trying to get rid of
	// the thing, while a scrollable panel is not discoverable at all — a feature
	// nothing names is a feature nobody has. Both fit a default 56-column rail;
	// on a narrower one the hint falls back to naming the way out, which is the
	// one a panel shown unasked owes the operator.
	const both = `${expand} expand · ${hide} hide`;
	return width > 0 && width < both.length + 4 ? `${hide} to hide` : both;
}
export type PanelMode = (typeof PANEL_MODES)[number];

/**
 * `body` is prose you are meant to read; `muted` is scaffolding you are meant to
 * look past. They were the same colour, so a finding's description rendered in
 * the dimmest ink on the panel — the one thing you opened the detail *for*.
 */
export type PanelTone = "title" | "body" | "label" | "muted" | "accent" | "good" | "warn" | "bad";

export interface PanelData {
	engagement: string;
	engagementType?: string;
	scope?: { mode: string; authorized: boolean; targets: Record<string, string[] | undefined>; exclude?: Record<string, string[] | undefined> };
	coveragePct?: number;
	cells?: number;
	settled?: number;
	gaps?: number;
	/** Cell status counts, when a matrix exists. */
	coverage?: Partial<Record<"clear" | "vulnerable" | "testing" | "blocked" | "not-tested", number>>;
	surface: Record<string, number>;
	hypotheses: Record<string, number>;
	findings: Record<Severity, number>;
	/** Enough of each finding that the panel can show one in full, not just list it. */
	recentFindings: Array<{
		severity: string; title: string;
		id?: string; cwe?: string; class?: string; status?: string;
		target?: string; description?: string; repro?: string; evidence?: string[];
	}>;
	openBlockers: Array<{ question: string; priority?: string }>;
	evidence: number;
}

export interface PanelOptions {
	mode: PanelMode;
	data: PanelData;
	width: number;
	maxLines: number;
	ink: (tone: PanelTone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
	/**
	 * Draw a tmux-style border with the engagement name set into the top edge.
	 * Costs two columns and two rows, so it is optional: a narrow rail or a
	 * two-line strip is better off spending that space on content.
	 */
	frame?: boolean;
	/**
	 * A dim, right-aligned line at the foot of the panel telling the operator how
	 * to dismiss it — a panel that appears uninvited should always say how to make
	 * it go away. Its row is reserved before the sections are laid out, because
	 * the moment you most want the hint is when the panel is full enough to be in
	 * the way, which is exactly when a bottom-dropped line would be gone.
	 */
	hint?: string;
	/**
	 * Show every item a section holds instead of a head slice.
	 *
	 * The rail shows three findings because it has room for three. Maximised it
	 * has room for forty, and showing three anyway makes the extra height look
	 * broken: nothing scrolls, and the panel appears to have simply grown its
	 * margins. Height alone is not what makes a view readable — the content has
	 * to arrive too.
	 */
	expanded?: boolean;
	/**
	 * Index of the highlighted finding, when the panel is being read rather than
	 * glanced at. Out-of-range values are ignored rather than clamped: the caller
	 * owns the cursor, and a panel that silently moved it would fight them.
	 */
	selected?: number;
}

/** Shared with the coverage matrix so a glyph means one thing across the tool. */
const GLYPH = { clear: "●", vulnerable: "▲", testing: "◐", blocked: "⊘", "not-tested": "·" } as const;

/**
 * The widest a label-and-count table is allowed to be, and the cell inside it.
 *
 * The rail grows with the terminal, and a table that grows with it stops being a
 * table: at 67 columns "tech" and its "1" sat twenty-six spaces apart, with the
 * eye asked to carry the association across the gap. Same instinct as the
 * coverage bar, which has always been capped at 24 — a measure, not a stretch.
 *
 * The cell is half the table whether or not a second column is filled, so a
 * surface of one kind and a surface of six read at the same measure, and so do
 * the hypotheses beneath them. Sized from the panel so a narrow rail still gets
 * a proportional one.
 */
const TABLE_MAX = 44;
const tableCell = (width: number): number => Math.floor((Math.min(width, TABLE_MAX) - 4) / 2);

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const SEVERITY_TONE: Record<Severity, PanelTone> = {
	critical: "bad", high: "bad", medium: "warn", low: "accent", info: "muted",
};
const SEVERITY_ABBR: Record<Severity, string> = {
	critical: "crit", high: "high", medium: "med", low: "low", info: "info",
};
const OUTCOME_TONE: Record<string, PanelTone> = {
	confirmed: "bad", refuted: "good", testing: "warn", proposed: "accent", inconclusive: "muted",
};
const OUTCOME_GLYPH: Record<string, string> = {
	confirmed: GLYPH.vulnerable, refuted: GLYPH.clear, testing: GLYPH.testing,
	proposed: "·", inconclusive: "?",
};

export function renderPanel(opts: PanelOptions): string[] {
	const { mode, data: d, ink, measure, truncate } = opts;
	// The border costs two columns and two rows; content is laid out inside them.
	const framed = opts.frame === true && opts.width >= 24 && opts.maxLines >= 4;
	const width = framed ? opts.width - 2 : opts.width;
	const outerLines = framed ? opts.maxLines - 2 : opts.maxLines;
	// The hint is only worth a row if content also fits beside it.
	const hint = opts.hint && outerLines >= 3 ? opts.hint : undefined;
	const maxLines = outerLines - (hint ? 1 : 0);
	if (maxLines <= 0 || width < 12) return [];

	const out: string[] = [];
	const room = (): number => maxLines - out.length;
	const line = (s: string): void => {
		if (room() > 0) out.push(truncate(s, width));
	};
	/**
	 * A section rule: the label, then a hairline to the right margin.
	 *
	 * It is the separator, which is why nothing is spaced above it. A blank line
	 * over a rule separates a separator, and it cost five rows out of twenty-two
	 * in a panel whose whole job is to be read at a glance beside the transcript.
	 */
	const section = (label: string): void => {
		if (room() < 2) return;
		const dashes = Math.max(0, width - label.length - 3);
		out.push(`${RULE}${ink("muted", "─ ")}${ink("label", label)} ${ink("muted", "─".repeat(dashes))}`);
	};
	const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - measure(s)));

	// --- header ---------------------------------------------------------------
	// Framed, the engagement name lives in the top border — and so does its type,
	// which is four words that were costing a whole row of a twenty-row view.
	// Unframed there is no border to put them in, so they take their line.
	if (!framed) {
		line(`${ink("accent", "⦿")} ${ink("title", d.engagement)}`);
		if (d.engagementType) line(`  ${ink("muted", d.engagementType)}`);
	}

	// A blocker is the one thing that needs a human. It goes near the top and is
	// never dropped for space.
	if (d.openBlockers.length > 0 && mode !== "findings") {
		section("needs you");
		for (const b of d.openBlockers.slice(0, opts.expanded ? d.openBlockers.length : 3)) {
			line(`  ${ink("warn", "!")} ${ink("title", b.question)}`);
		}
		if (!opts.expanded && d.openBlockers.length > 3) line(ink("muted", `    +${d.openBlockers.length - 3} more`));
	}

	if (mode === "state" || mode === "coverage") {
		if (d.coveragePct !== undefined) {
			section("coverage");
			const pct = `${d.coveragePct}%`;
			// The operator's unit is a test case, not a matrix cell. Kept to exactly
			// the width the old wording had: this string decides whether the bar and
			// its numbers share a row, so a longer synonym costs a panel row on a
			// narrow terminal. The /coverage overlay has room to spell it out.
			const counts = `${d.settled ?? 0} of ${d.cells ?? 0} cases · ${d.gaps ?? 0} gaps`;
			// A bar and the numbers it draws are one fact, and two rows for one fact
			// is how a panel gets tall. So they share a row, and the bar gives up the
			// columns to make that work — down to twelve, under which it stops being
			// a bar and the two go back to a row each.
			const beside = width - measure(counts) - measure(pct) - 5;
			const together = beside >= 12;
			const barWidth = Math.max(8, Math.min(24, together ? beside : width - 10));
			const filled = Math.round((d.coveragePct / 100) * barWidth);
			const bar = `  ${ink("accent", "█".repeat(filled))}${ink("muted", "░".repeat(barWidth - filled))} ${ink("title", pct)}`;
			if (together) line(`${bar}  ${ink("muted", counts)}`);
			else {
				line(bar);
				line(ink("muted", `  ${counts}`));
			}
			const c = d.coverage;
			if (c) {
				const parts = ([
					["vulnerable", "bad"], ["clear", "good"], ["testing", "warn"], ["blocked", "warn"],
				] as Array<[keyof typeof GLYPH, PanelTone]>)
					.filter(([k]) => (c[k] ?? 0) > 0)
					.map(([k, tone]) => `${ink(tone, GLYPH[k])} ${ink("muted", String(c[k]))}`);
				if (parts.length) line(`  ${parts.join(ink("muted", "  "))}`);
			}
		}
	}

	if (mode === "state") {
		if (d.scope) {
			section("scope");
			line(`  ${ink(d.scope.authorized ? "good" : "warn", d.scope.authorized ? "● authorized" : "○ NOT authorized")} ${ink("muted", d.scope.mode)}`);
			const t = d.scope.targets ?? {};
			const listed = (["domains", "ips", "cidrs", "urls"] as const)
				.filter((k) => t[k]?.length)
				.map((k) => `${ink("muted", k)} ${ink("title", String(t[k]!.length))}`)
				.join(ink("muted", " · "));
			if (listed) line(`  ${listed}`);
		}

		const surf = Object.entries(d.surface).filter(([, n]) => n > 0);
		if (surf.length) {
			section("surface");
			// Two columns so a wide surface does not run down the whole rail — but
			// only once there is a surface to spread. The cell keeps its width
			// either way: a second column that is merely absent should not stretch
			// the first one across the panel.
			const cols = surf.length > 3 ? 2 : 1;
			const w = tableCell(width);
			for (let i = 0; i < surf.length; i += cols) {
				const cell = (e?: [string, number]): string => {
					if (!e) return "";
					const num = String(e[1]);
					return pad(`${ink("muted", e[0])}${" ".repeat(Math.max(1, w - e[0].length - num.length - 2))}${ink("title", num)}`, w);
				};
				line(`  ${cell(surf[i])}${cols === 2 ? cell(surf[i + 1]) : ""}`.trimEnd());
			}
		}

		const hyps = Object.entries(d.hypotheses).filter(([, n]) => n > 0);
		if (hyps.length) {
			section("hypotheses");
			const numWidth = Math.max(...hyps.map(([, n]) => String(n).length));
			// The same cell as the surface table above it, so the two lists of
			// counts read as one column rather than as two that nearly line up.
			const w = tableCell(width);
			for (const [outcome, n] of hyps) {
				const count = " ".repeat(numWidth - String(n).length) + String(n);
				line(`  ${ink(OUTCOME_TONE[outcome] ?? "muted", OUTCOME_GLYPH[outcome] ?? "·")} ${pad(ink("muted", outcome), Math.max(4, w - numWidth - 4))}${ink("title", count)}`);
			}
		}
	}

	if (mode === "state" || mode === "findings") {
		const sev = SEVERITY_ORDER.filter((s) => (d.findings[s] ?? 0) > 0);
		section("findings");
		if (sev.length === 0) {
			line(ink("muted", "  none recorded"));
		} else {
			line(`  ${sev.map((s) => `${ink(SEVERITY_TONE[s], "⬤")} ${ink("muted", SEVERITY_ABBR[s])} ${ink("title", String(d.findings[s]))}`).join(ink("muted", "  "))}`);
			const shown = opts.expanded ? d.recentFindings.length : mode === "findings" ? 12 : 3;
			for (const [i, f] of d.recentFindings.slice(0, shown).entries()) {
				const tone = SEVERITY_TONE[f.severity as Severity] ?? "muted";
				// The cursor is a filled marker plus the title in full ink; unselected
				// rows keep the hollow marker. Two cues, because a highlight alone is
				// invisible on a terminal that renders the accent as plain text.
				const on = opts.selected === i;
				line(`  ${ink(tone, on ? "▶" : "▸")} ${on ? ink("title", f.title) : f.title}`);
			}
		}
	}

	if (mode === "blockers" && d.openBlockers.length === 0) {
		line("");
		line(ink("good", "  nothing blocked"));
	}

	// --- footer ---------------------------------------------------------------
	// One row, both ends: the evidence count on the left, the dismiss hint on the
	// right. They were a blank line, a count and a hint — three rows for a number
	// and a keystroke, in the view that has to earn every row it takes.
	const evidence = d.evidence > 0 ? `  ${d.evidence} evidence file${d.evidence === 1 ? "" : "s"}` : "";
	if (hint) {
		const clipped = truncate(hint, width - 2);
		const gap = width - measure(evidence) - measure(clipped) - 1;
		const together = Boolean(evidence) && gap >= 2;
		// Too narrow to share the row, and the count still worth having: it takes
		// its own line rather than being dropped for a layout that saves nothing.
		if (evidence && !together && room() > 0) line(ink("muted", evidence));
		out.push(together
			? ink("muted", evidence) + " ".repeat(gap) + ink("muted", clipped)
			: " ".repeat(Math.max(0, width - measure(clipped) - 1)) + ink("muted", clipped));
	} else if (evidence && room() > 0) {
		line(ink("muted", evidence));
	}

	if (!framed) return out.map((l) => (l.startsWith(RULE) ? l.slice(RULE.length) : l));
	const title = `${ink("accent", "⦿")} ${ink("title", d.engagement)}${d.engagementType ? ink("muted", ` · ${d.engagementType}`) : ""}`;
	return framed ? frameLines(out, title, opts.width, ink, measure, truncate) : out;
}

/**
 * Window a framed panel to `height` rows, keeping both frame edges pinned.
 *
 * The rail drops whole sections to fit its half-screen budget, which is right
 * for a glance and wrong for reading: a findings list of twelve is not something
 * you want truncated to three. Maximised, the panel renders everything and this
 * scrolls it — but the border has to stay put, or the box appears to lose its
 * lid every time the body moves.
 *
 * Pure and total: an out-of-range scroll is clamped rather than rejected, since
 * the caller's scroll offset and the content length change independently and a
 * held-down arrow key must not be able to produce an empty frame.
 */
export interface ScrollWindow {
	lines: string[];
	/** The offset actually used, after clamping. */
	scroll: number;
	/** Body rows below the window; 0 when the end is visible. */
	below: number;
	above: number;
}

export function scrollFramed(all: string[], scroll: number, height: number): ScrollWindow {
	if (all.length <= height || all.length < 3 || height < 3) {
		return { lines: all.slice(0, Math.max(0, height)), scroll: 0, below: 0, above: 0 };
	}
	const top = all[0] as string;
	const bottom = all[all.length - 1] as string;
	const body = all.slice(1, -1);
	const bodyHeight = height - 2;
	const max = Math.max(0, body.length - bodyHeight);
	const at = Math.max(0, Math.min(scroll, max));
	return {
		lines: [top, ...body.slice(at, at + bodyHeight), bottom],
		scroll: at,
		above: at,
		below: Math.max(0, body.length - (at + bodyHeight)),
	};
}

/**
 * One finding, in full, laid out for the maximised panel.
 *
 * Reading a finding is a different job from listing them, and doing it in the
 * same frame is what keeps the panel a single surface: the operator never leaves
 * the rail to find out what a row means. Separate from renderPanel because the
 * two share no layout — the sections that make the dashboard useful are noise
 * once you are reading one row of it.
 */
export interface FindingDetailOptions {
	finding: PanelData["recentFindings"][number];
	engagement: string;
	width: number;
	maxLines: number;
	ink: (tone: PanelTone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
	frame?: boolean;
	hint?: string;
}

/** Wrap on spaces: a description is prose, and breaking it mid-word reads as corruption. */
function wrapWords(text: string, width: number, measure: (s: string) => number): string[] {
	const out: string[] = [];
	let line = "";
	for (const w of text.split(/\s+/).filter(Boolean)) {
		const next = line ? `${line} ${w}` : w;
		if (measure(next) > width && line) {
			out.push(line);
			line = w;
		} else line = next;
	}
	if (line) out.push(line);
	return out;
}

export function renderFindingDetail(o: FindingDetailOptions): string[] {
	const { finding: f, ink, measure, truncate } = o;
	const framed = o.frame === true && o.width >= 24 && o.maxLines >= 4;
	const width = framed ? o.width - 2 : o.width;
	const hint = o.hint && o.maxLines >= 5 ? o.hint : undefined;
	const body: string[] = [];
	const labelW = 11;
	const field = (k: string, v: string, tone: PanelTone = "body"): void => {
		for (const [i, l] of wrapWords(v, Math.max(8, width - labelW - 2), measure).entries()) {
			body.push(`${ink("muted", (i === 0 ? k : "").padEnd(labelW))}${ink(tone, l)}`);
		}
	};

	const tone = SEVERITY_TONE[f.severity as Severity] ?? "muted";
	body.push("");
	for (const l of wrapWords(f.title, width - 2, measure)) body.push(`  ${ink("title", l)}`);
	body.push("");
	field("severity", f.severity, tone);
	if (f.cwe) field("cwe", f.cwe);
	if (f.class) field("class", f.class);
	if (f.target) field("target", f.target);
	if (f.status) field("status", f.status, "muted");
	if (f.description) {
		body.push("");
		for (const l of wrapWords(f.description, width - 2, measure)) body.push(`  ${ink("body", l)}`);
	}
	if (f.repro) {
		body.push("");
		field("repro", f.repro);
	}
	for (const e of f.evidence ?? []) field("evidence", e, "muted");

	const room = o.maxLines - (framed ? 2 : 0) - (hint ? 1 : 0);
	const lines = body.slice(0, Math.max(0, room)).map((l) => truncate(l, width));
	if (hint) {
		const pad = Math.max(0, width - measure(hint));
		lines.push(" ".repeat(pad) + ink("muted", hint));
	}
	return framed ? frameLines(lines, o.engagement, o.width, ink, measure, truncate) : lines;
}
