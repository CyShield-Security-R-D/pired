/**
 * The engagement panel — pired's ledger, shown to the operator directly.
 *
 * The transcript is the conversation; this is the state. Until now the operator
 * could only see coverage, findings or blockers by asking the agent to recall
 * them, which is backwards: the ledger is the operator's artifact, not the
 * agent's. A whole afternoon of this session was spent scraping .jsonl from
 * outside the tool for want of this view.
 *
 * It renders into the footer rather than a side rail because that is what the
 * host offers — `setFooter` takes a component returning lines, full width,
 * always visible. A right-hand panel would mean forking pi for a worse result.
 *
 * Modes exist because the phases of an engagement ask different questions:
 * what is established, what is left, what did we find, what needs me. One panel
 * trying to answer all four at once answers none of them well.
 *
 * Pure module: colours and measurement are injected, so it is testable without
 * a terminal — the same contract as the coverage panel.
 */

import type { Severity } from "./ontology.ts";

export const PANEL_MODES = ["state", "coverage", "findings", "blockers"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

export type PanelTone = "title" | "label" | "muted" | "accent" | "good" | "warn" | "bad";

export interface PanelData {
	engagement: string;
	/** From the seeded checklist's targetType — the profile is not persisted. */
	engagementType?: string;
	scope?: { mode: string; authorized: boolean; targets: Record<string, string[] | undefined> };
	coveragePct?: number;
	cells?: number;
	settled?: number;
	gaps?: number;
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
	/** Lines available. The panel must never crowd out the transcript. */
	maxLines: number;
	ink: (tone: PanelTone, text: string) => string;
	measure: (s: string) => number;
	truncate: (s: string, width: number) => string;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const SEVERITY_TONE: Record<Severity, PanelTone> = {
	critical: "bad", high: "bad", medium: "warn", low: "accent", info: "muted",
};
const OUTCOME_TONE: Record<string, PanelTone> = {
	confirmed: "bad", refuted: "good", testing: "warn", proposed: "accent", inconclusive: "muted",
};

function bar(pct: number, width: number, ink: PanelOptions["ink"]): string {
	const filled = Math.round((pct / 100) * width);
	return ink("accent", "█".repeat(filled)) + ink("muted", "░".repeat(Math.max(0, width - filled)));
}

function counts(rec: Record<string, number>, tone: (k: string) => PanelTone, ink: PanelOptions["ink"]): string {
	return Object.entries(rec)
		.filter(([, n]) => n > 0)
		.map(([k, n]) => `${ink(tone(k), k)} ${ink("title", String(n))}`)
		.join(ink("muted", " · "));
}

/**
 * Lay the panel out, never exceeding `maxLines` or `width`. Returning fewer
 * lines than asked is fine; returning more corrupts the host's layout.
 */
export function renderPanel(opts: PanelOptions): string[] {
	const { mode, data: d, width, maxLines, ink, truncate } = opts;
	if (maxLines <= 0 || width <= 0) return [];
	const out: string[] = [];
	const push = (s: string): void => {
		if (out.length < maxLines) out.push(truncate(s, width));
	};

	const head = `${ink("accent", "⦿")} ${ink("title", d.engagement)}${d.engagementType ? ink("muted", ` · ${d.engagementType}`) : ""}`;
	push(head);

	if (mode === "state") {
		if (d.scope) {
			const t = d.scope.targets ?? {};
			const listed = (["domains", "ips", "cidrs", "urls"] as const)
				.map((k) => (t[k]?.length ? `${k} ${t[k]!.length}` : ""))
				.filter(Boolean)
				.join(" · ");
			push(`  ${ink("label", "scope")}  ${ink(d.scope.authorized ? "good" : "warn", d.scope.authorized ? "authorized" : "NOT authorized")} ${ink("muted", d.scope.mode)}${listed ? ink("muted", " · " + listed) : ""}`);
		}
		if (d.coveragePct !== undefined) {
			push(`  ${ink("label", "cover")}  ${bar(d.coveragePct, 16, ink)} ${ink("title", `${d.coveragePct}%`)} ${ink("muted", `${d.settled ?? 0}/${d.cells ?? 0} cells · ${d.gaps ?? 0} gaps`)}`);
		}
		const surf = counts(d.surface, () => "label", ink);
		if (surf) push(`  ${ink("label", "surf ")}  ${surf}`);
		const hyp = counts(d.hypotheses, (k) => OUTCOME_TONE[k] ?? "muted", ink);
		if (hyp) push(`  ${ink("label", "hyps ")}  ${hyp}`);
		const fnd = counts(
			Object.fromEntries(SEVERITY_ORDER.map((s) => [s, d.findings[s] ?? 0])),
			(k) => SEVERITY_TONE[k as Severity] ?? "muted",
			ink,
		);
		if (fnd) push(`  ${ink("label", "finds")}  ${fnd}`);
		if (d.openBlockers.length > 0) {
			push(`  ${ink("warn", "needs you")}  ${ink("title", truncate(d.openBlockers[0]!.question, Math.max(10, width - 16)))}`);
		}
	}

	if (mode === "findings") {
		if (d.recentFindings.length === 0) push(ink("muted", "  nothing recorded yet"));
		for (const f of d.recentFindings) {
			push(`  ${ink(SEVERITY_TONE[f.severity as Severity] ?? "muted", `[${f.severity}]`)} ${f.title}`);
		}
	}

	if (mode === "blockers") {
		if (d.openBlockers.length === 0) push(ink("good", "  nothing blocked"));
		for (const b of d.openBlockers) {
			push(`  ${ink("warn", b.priority ?? "?")} ${b.question}`);
		}
	}

	if (mode === "coverage") {
		push(`  ${bar(d.coveragePct ?? 0, 24, ink)} ${ink("title", `${d.coveragePct ?? 0}%`)}`);
		push(ink("muted", `  ${d.settled ?? 0} settled · ${d.gaps ?? 0} gaps of ${d.cells ?? 0} askable cells`));
		push(ink("muted", "  /coverage for the full matrix"));
	}

	return out;
}
