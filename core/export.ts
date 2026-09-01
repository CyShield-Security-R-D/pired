/**
 * Findings export (PLAN.md §9, §13). Markdown for humans, JSON for tools.
 *
 * Redaction is applied here, at the boundary that leaves the machine: loot
 * secrets are masked before anything is written. SARIF is deferred.
 *
 * Pure module: values in, string out. No ports, no I/O.
 */

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

export interface ExportInput {
	findings: FindingRecord[];
	/** Loot ledger, used to mask secrets in finding text. */
	loot?: LootRecord[];
	engagement?: string;
	generatedAt?: string;
}

function redactedSorted(input: ExportInput): FindingRecord[] {
	const redactor = buildRedactor(input.loot ?? []);
	const redacted = input.findings.map((f) => redactor.maskDeep(f));
	return redacted.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.id.localeCompare(b.id));
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

export function exportFindingsMarkdown(input: ExportInput): string {
	const findings = redactedSorted(input);
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
		const meta = [`- Target: ${f.target}`, `- Status: ${f.status}`];
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

	return `${out.join("\n")}\n`;
}
