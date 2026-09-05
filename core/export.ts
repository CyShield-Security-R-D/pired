/**
 * Findings export (PLAN.md §9, §13). Markdown for humans, JSON for tools.
 *
 * Redaction is applied here, at the boundary that leaves the machine: loot
 * secrets are masked before anything is written. SARIF is deferred.
 *
 * Pure module: values in, string out. No ports, no I/O.
 */

import type { CoverageBrief } from "./coverage.ts";
import type { FindingRecord, LootRecord, Severity } from "./ontology.ts";
import { buildRedactor } from "./redaction.ts";

/**
 * What an unwritten section says.
 *
 * Loud on purpose. This document goes to a client, and the failure to avoid is
 * one that ships looking finished: a finding with no business impact reads as a
 * complete section to anyone skimming, and the gap is only visible if the
 * document says so where the paragraph should have been.
 */
const MISSING = "_Not recorded — this finding is not yet report-ready._";

const SEVERITY_DESC = ["critical", "high", "medium", "low", "info"] as const;
const SEVERITY_ORDER: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** Untested elements listed by name before the tail is summarised. A report, not a dump. */
const UNTESTED_SHOWN = 20;

/** What the report can say about the testing behind the findings. */
export interface ExportCoverage {
	brief: CoverageBrief;
	/** Class id -> title, so the report names classes the way the checklist does. */
	classTitles?: Record<string, string>;
	/** Hypotheses that ruled a class out. The work a findings list cannot express. */
	refuted?: number;
}

export interface ExportInput {
	findings: FindingRecord[];
	/** Loot ledger, used to mask secrets in finding text. */
	loot?: LootRecord[];
	engagement?: string;
	generatedAt?: string;
	/**
	 * Element id -> the name the reviewer used. Without it a client report says
	 * `Target: 9d2fdd`, which is the one line naming where the bug is rendered in
	 * the one form the reader cannot use. `core/target.ts` builds it from the
	 * inventory; the callback shape matches `renderCoverageBrief`'s.
	 */
	labelFor?: (id: string) => string | undefined;
	/** The testing behind the findings, when a matrix exists. */
	coverage?: ExportCoverage;
}

/**
 * Everything that will be rendered, with loot secrets masked out of all of it.
 *
 * Redaction used to run over `input.findings` alone, which was right when the
 * findings were the only thing rendered. Element labels and coverage text are
 * also ledger strings and an inventory record can carry a secret — a param named
 * for a token, a host value with credentials in the URL. So the redactor is
 * built once and applied to the whole input before anything is rendered, which
 * is the invariant this module exists to hold. See ADR-003.
 */
function redactedInput(input: ExportInput): ExportInput & { findings: FindingRecord[] } {
	const redactor = buildRedactor(input.loot ?? []);
	const findings = input.findings
		.map((f) => redactor.maskDeep(f))
		.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.id.localeCompare(b.id));
	const labelFor = input.labelFor
		? (id: string) => {
			const label = input.labelFor?.(id);
			return label === undefined ? undefined : redactor.mask(label);
		}
		: undefined;
	return {
		...input,
		findings,
		labelFor,
		coverage: input.coverage ? redactor.maskDeep(input.coverage) : undefined,
	};
}

function redactedSorted(input: ExportInput): FindingRecord[] {
	return redactedInput(input).findings;
}

function tally(findings: FindingRecord[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
	for (const f of findings) counts[f.severity] += 1;
	return counts;
}

export function exportFindingsJson(input: ExportInput): string {
	const findings = redactedSorted(input);
	return `${JSON.stringify({ engagement: input.engagement, generatedAt: input.generatedAt, findings }, null, 2)}\n`;
}

/**
 * The findings that would ship with a section missing.
 *
 * Shared with the harness rather than kept inside the exporter, because the
 * moment to hear about it is when the finding is recorded — while the reviewer
 * still has the context to write the two paragraphs — and not when the report
 * is already being handed over. `skills/ops-technical-writer` is the pass that
 * fills them in.
 */
export function notReportReady(findings: FindingRecord[]): FindingRecord[] {
	return findings.filter((f) => !f.description || !f.impact || !f.remediation);
}

export function exportFindingsMarkdown(rawInput: ExportInput): string {
	const input = redactedInput(rawInput);
	const findings = input.findings;
	const counts = tally(findings);
	const out: string[] = [];

	out.push(`# pired findings${input.engagement ? ` — ${input.engagement}` : ""}`);
	if (input.generatedAt) out.push(`\nGenerated: ${input.generatedAt}`);

	out.push("\n## Summary\n");
	const summary = SEVERITY_DESC.filter((s) => counts[s] > 0).map((s) => `- ${s}: ${counts[s]}`);
	out.push(summary.length ? summary.join("\n") : "No findings recorded.");
	out.push(`\nTotal: ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
	const incomplete = notReportReady(findings);
	if (incomplete.length > 0) {
		out.push(
			`\n> **${incomplete.length} finding${incomplete.length === 1 ? " is" : "s are"} not report-ready** — ` +
			`missing a description, a business impact or a remediation: ${incomplete.map((f) => f.id).join(", ")}.`,
		);
	}

	out.push("\n## Findings\n");
	if (findings.length === 0) {
		out.push("_None._");
	}
	for (const f of findings) {
		out.push(`### [${f.severity.toUpperCase()}] ${f.title}  (${f.id})`);
		// The resolved element name, falling back to whatever was recorded. A target
		// is legitimately a raw label when nothing was mapped for it, so the id is
		// never dropped — it is only translated when there is a translation.
		const target = (typeof f.target === "string" ? input.labelFor?.(f.target) : undefined) ?? f.target;
		const meta = [`- Target: ${target}`, `- Status: ${f.status}`];
		if (f.class) meta.push(`- Class: ${f.class}`);
		if (f.cwe) meta.push(`- CWE: ${f.cwe}`);
		if (f.cvss) meta.push(`- CVSS: ${f.cvss}`);
		if (f.reason) meta.push(`- Rationale: ${f.reason}`);
		out.push(meta.join("\n"));
		// The three sections a client's report is read for, in the order it is read
		// in: what it is, what it costs us, what we do about it. Written out even
		// when empty — a heading marked "not recorded" is caught by whoever reviews
		// the document; a section that silently is not there is not.
		for (const [heading, body] of [
			["Description", f.description],
			["Business impact", f.impact],
			["Remediation", f.remediation],
		] as const) {
			out.push(`\n**${heading}**\n\n${body ?? MISSING}`);
		}
		if (f.repro) out.push(`\n**Reproduction**\n\n${f.repro}`);
		if (f.evidence?.length) out.push(`\n**Evidence**\n${f.evidence.map((e) => `- ${e}`).join("\n")}`);
		out.push("");
	}

	out.push(...coverageSection(input));
	return `${out.join("\n")}\n`;
}

/**
 * What was tested, including what was ruled out.
 *
 * A findings list answers "what did you find" and cannot answer "what did you
 * look at" — and the second question is the one that separates an assessment
 * from a scanner run. One engagement recorded 231 refutations and shipped none
 * of them, because the export stopped at the findings loop.
 *
 * Empty when there is no matrix. A report that asserts 0% coverage because
 * nobody seeded a checklist is worse than a report that does not mention it.
 */
function coverageSection(input: ExportInput): string[] {
	const cov = input.coverage;
	if (!cov || cov.brief.applicable === 0) return [];
	const { brief } = cov;
	const name = (id: string) => cov.classTitles?.[id] ?? id;

	const out = ["\n## Coverage\n"];
	out.push(
		`${brief.settled} of ${brief.applicable} test cases settled (${brief.percent}%) ` +
		`across ${brief.elements} recorded element(s) × ${brief.classes} weakness class(es).`,
	);
	if (cov.refuted) {
		out.push(
			`\n${cov.refuted} hypothes${cov.refuted === 1 ? "is" : "es"} were tested and refuted — ` +
			`weakness classes ruled out against specific surface, not merely unreported.`,
		);
	}

	// Named rather than counted. "17 classes untested" is a number nobody can act
	// on; the list is the scope conversation to have before the report is signed.
	const untestedClasses = brief.untestedClasses ?? [];
	if (untestedClasses.length > 0) {
		out.push("\n**Not tested in this engagement**\n");
		out.push(untestedClasses.map((id) => `- ${name(id)}`).join("\n"));
	}
	const untestedElements = brief.untestedElements ?? [];
	if (untestedElements.length > 0) {
		const shown = untestedElements.slice(0, UNTESTED_SHOWN);
		const rest = untestedElements.length - shown.length;
		out.push("\n**Surface with no settled test case**\n");
		out.push(shown.map((id) => `- ${input.labelFor?.(id) ?? id}`).join("\n"));
		if (rest > 0) out.push(`- …and ${rest} more`);
	}
	out.push("");
	return out;
}
