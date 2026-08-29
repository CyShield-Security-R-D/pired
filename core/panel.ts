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
export function dismissHint(platform: string): string {
	return platform === "darwin" ? "/panel to hide" : "alt+p to hide";
}
export type PanelMode = (typeof PANEL_MODES)[number];

export type PanelTone = "title" | "label" | "muted" | "accent" | "good" | "warn" | "bad";

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
	recentFindings: Array<{ severity: string; title: string }>;
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
}

const BORDER = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤" } as const;

/**
 * Marks a line as a section rule so the frame can join it to the border with
 * ├ ┤ instead of boxing it in │ │, which leaves an ugly notch at each end.
 * A sentinel beats a parallel array: the renderer stays a flat list of lines.
 */
const RULE = "\u0000rule\u0000";

/**
 * Wrap rendered lines in a border, with the title set into the top edge the way
 * tmux labels a pane. Every line is padded to the inner width first — an
 * unpadded line leaves the right border ragged, which reads as a rendering bug
 * rather than a style.
 */
function frameLines(
	lines: string[],
	title: string,
	width: number,
	ink: PanelOptions["ink"],
	measure: PanelOptions["measure"],
	truncate: PanelOptions["truncate"],
): string[] {
	const inner = width - 2;
	if (inner < 8) return lines;
	const label = truncate(title, Math.max(0, inner - 4));
	const used = measure(label) + 3;
	// tl + h + space + label + space = used + 1 columns consumed; the remainder
	// fills to the corner. Off by one here leaves the top edge a column short of
	// every other line, which is exactly the ragged look the frame exists to avoid.
	const top = `${ink("muted", BORDER.tl + BORDER.h)} ${label} ${ink("muted", BORDER.h.repeat(Math.max(0, inner - used)) + BORDER.tr)}`;
	const bottom = ink("muted", BORDER.bl + BORDER.h.repeat(inner) + BORDER.br);
	const body = lines.map((raw) => {
		const isRule = raw.startsWith(RULE);
		const l = isRule ? raw.slice(RULE.length) : raw;
		const clipped = truncate(l, inner);
		const gap = Math.max(0, inner - measure(clipped));
		const fill = isRule ? ink("muted", BORDER.h.repeat(gap)) : " ".repeat(gap);
		const [lhs, rhs] = isRule ? [BORDER.ml, BORDER.mr] : [BORDER.v, BORDER.v];
		return `${ink("muted", lhs)}${clipped}${fill}${ink("muted", rhs)}`;
	});
	return [top, ...body, bottom];
}

/** Shared with the coverage matrix so a glyph means one thing across the tool. */
const GLYPH = { clear: "●", vulnerable: "▲", testing: "◐", blocked: "⊘", "not-tested": "·" } as const;

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
	/** A section rule: the label, then a hairline to the right margin. */
	const section = (label: string): void => {
		if (room() < 2) return;
		const dashes = Math.max(0, width - label.length - 3);
		out.push(`${RULE}${ink("muted", "─ ")}${ink("label", label)} ${ink("muted", "─".repeat(dashes))}`);
	};
	const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - measure(s)));

	// --- header ---------------------------------------------------------------
	// Framed, the engagement name lives in the top border, so repeating it here
	// would waste the most valuable line in the panel.
	if (!framed) line(`${ink("accent", "⦿")} ${ink("title", d.engagement)}`);
	if (d.engagementType) line(`  ${ink("muted", d.engagementType)}`);

	// A blocker is the one thing that needs a human. It goes near the top and is
	// never dropped for space.
	if (d.openBlockers.length > 0 && mode !== "findings") {
		line("");
		section("needs you");
		for (const b of d.openBlockers.slice(0, 3)) {
			line(`  ${ink("warn", "!")} ${ink("title", b.question)}`);
		}
		if (d.openBlockers.length > 3) line(ink("muted", `    +${d.openBlockers.length - 3} more`));
	}

	if (mode === "state" || mode === "coverage") {
		if (d.coveragePct !== undefined) {
			line("");
			section("coverage");
			const barWidth = Math.max(8, Math.min(24, width - 10));
			const filled = Math.round((d.coveragePct / 100) * barWidth);
			line(`  ${ink("accent", "█".repeat(filled))}${ink("muted", "░".repeat(barWidth - filled))} ${ink("title", `${d.coveragePct}%`)}`);
			line(ink("muted", `  ${d.settled ?? 0} of ${d.cells ?? 0} cells · ${d.gaps ?? 0} gaps`));
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
			line("");
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
			line("");
			section("surface");
			// Two columns so a wide surface does not run down the whole rail.
			const w = Math.floor((width - 4) / 2);
			for (let i = 0; i < surf.length; i += 2) {
				const cell = (e?: [string, number]): string => {
					if (!e) return "";
					const num = String(e[1]);
					return pad(`${ink("muted", e[0])}${" ".repeat(Math.max(1, w - e[0].length - num.length - 2))}${ink("title", num)}`, w);
				};
				line(`  ${cell(surf[i])}${cell(surf[i + 1])}`.trimEnd());
			}
		}

		const hyps = Object.entries(d.hypotheses).filter(([, n]) => n > 0);
		if (hyps.length) {
			line("");
			section("hypotheses");
			const numWidth = Math.max(...hyps.map(([, n]) => String(n).length));
			for (const [outcome, n] of hyps) {
				const count = " ".repeat(numWidth - String(n).length) + String(n);
				line(`  ${ink(OUTCOME_TONE[outcome] ?? "muted", OUTCOME_GLYPH[outcome] ?? "·")} ${pad(ink("muted", outcome), width - numWidth - 6)}${ink("title", count)}`);
			}
		}
	}

	if (mode === "state" || mode === "findings") {
		const sev = SEVERITY_ORDER.filter((s) => (d.findings[s] ?? 0) > 0);
		line("");
		section("findings");
		if (sev.length === 0) {
			line(ink("muted", "  none recorded"));
		} else {
			line(`  ${sev.map((s) => `${ink(SEVERITY_TONE[s], "⬤")} ${ink("muted", SEVERITY_ABBR[s])} ${ink("title", String(d.findings[s]))}`).join(ink("muted", "  "))}`);
			for (const f of d.recentFindings.slice(0, mode === "findings" ? 12 : 3)) {
				line(`  ${ink(SEVERITY_TONE[f.severity as Severity] ?? "muted", "▸")} ${f.title}`);
			}
		}
	}

	if (mode === "blockers" && d.openBlockers.length === 0) {
		line("");
		line(ink("good", "  nothing blocked"));
	}

	// --- footer ---------------------------------------------------------------
	if (room() > 1 && d.evidence > 0) {
		line("");
		line(ink("muted", `  ${d.evidence} evidence file${d.evidence === 1 ? "" : "s"}`));
	}

	if (hint) {
		const clipped = truncate(hint, width - 2);
		out.push(" ".repeat(Math.max(0, width - measure(clipped) - 1)) + ink("muted", clipped));
	}

	if (!framed) return out.map((l) => (l.startsWith(RULE) ? l.slice(RULE.length) : l));
	return framed
		? frameLines(out, `${ink("accent", "⦿")} ${ink("title", d.engagement)}`, opts.width, ink, measure, truncate)
		: out;
}
