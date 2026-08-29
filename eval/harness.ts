/**
 * Assay runner — executes probes, aggregates metrics, enforces the ratchet.
 *
 * The ratchet is the mechanism that turns a suite into a development instrument:
 * every tracked metric carries a floor (or ceiling) in `ratchet.json`, and a
 * change that regresses one fails the suite even though no individual case
 * flipped. Floors move by an explicit `--update-ratchet`, never silently.
 *
 * Kept free of node builtins except for the CLI shell in `run.ts`, so the
 * harness itself stays unit-testable.
 */

import type { CaseResult, Probe, ProbeResult, RatchetBound, SuiteReport } from "./types.ts";

export interface RunOptions {
	/** Substring filter over `family` and `name`. */
	filter?: string;
	commit?: string;
	now?: () => number;
	nowIso?: () => string;
}

export async function runProbes(
	probes: Probe[],
	ratchet: Record<string, RatchetBound>,
	opts: RunOptions = {},
): Promise<SuiteReport> {
	const now = opts.now ?? (() => Date.now());
	const nowIso = opts.nowIso ?? (() => new Date().toISOString());
	const started = now();
	const startedAt = nowIso();

	const selected = opts.filter
		? probes.filter((p) => p.family.includes(opts.filter as string) || p.name.includes(opts.filter as string))
		: probes;

	const results: ProbeResult[] = [];
	for (const probe of selected) {
		try {
			results.push(await probe.run());
		} catch (err) {
			// A probe that throws is a failing probe, not a crashed suite — otherwise
			// one broken fixture hides every other result.
			results.push({
				probe: probe.name,
				family: probe.family,
				cases: [
					{
						id: `${probe.name}:threw`,
						verdict: "fail",
						expected: "probe runs to completion",
						actual: err instanceof Error ? err.message : String(err),
					},
				],
				metrics: {},
			});
		}
	}

	const totals = { pass: 0, fail: 0, knownLimit: 0 };
	const metrics: Record<string, number> = {};
	for (const r of results) {
		for (const c of r.cases) {
			if (c.verdict === "pass") totals.pass += 1;
			else if (c.verdict === "fail") totals.fail += 1;
			else totals.knownLimit += 1;
		}
		for (const [k, v] of Object.entries(r.metrics)) metrics[k] = v;
	}

	const breaches: Array<{ metric: string; value: number; bound: RatchetBound }> = [];
	for (const [metric, bound] of Object.entries(ratchet)) {
		const value = metrics[metric];
		if (value === undefined) continue; // metric not produced by this filtered run
		if (bound.min !== undefined && value < bound.min) breaches.push({ metric, value, bound });
		if (bound.max !== undefined && value > bound.max) breaches.push({ metric, value, bound });
	}

	return {
		startedAt,
		durationMs: now() - started,
		commit: opts.commit,
		probes: results,
		totals,
		metrics,
		ratchet: { ok: breaches.length === 0, breaches },
	};
}

/** New ratchet with every floor advanced to the values this run achieved. */
export function tightenRatchet(
	ratchet: Record<string, RatchetBound>,
	metrics: Record<string, number>,
): Record<string, RatchetBound> {
	const next: Record<string, RatchetBound> = {};
	for (const [metric, bound] of Object.entries(ratchet)) {
		const value = metrics[metric];
		if (value === undefined) {
			next[metric] = bound;
			continue;
		}
		next[metric] = {
			...bound,
			...(bound.min !== undefined ? { min: Math.max(bound.min, value) } : {}),
			...(bound.max !== undefined ? { max: Math.min(bound.max, value) } : {}),
		};
	}
	return next;
}

const GLYPH: Record<CaseResult["verdict"], string> = { pass: "●", fail: "▲", "known-limit": "◐" };

/** Terminal report. Mirrors the coverage panel's glyph vocabulary on purpose. */
export function formatReport(report: SuiteReport, opts: { verbose?: boolean } = {}): string {
	const lines: string[] = [];
	lines.push(`⦿ assay · T0 probes${report.commit ? ` · ${report.commit}` : ""}`);
	lines.push("");

	for (const r of report.probes) {
		const failed = r.cases.filter((c) => c.verdict === "fail");
		const limits = r.cases.filter((c) => c.verdict === "known-limit");
		const mark = failed.length > 0 ? GLYPH.fail : limits.length > 0 ? GLYPH["known-limit"] : GLYPH.pass;
		const tail = [
			`${r.cases.length - failed.length - limits.length}/${r.cases.length}`,
			limits.length > 0 ? `${limits.length} limit${limits.length > 1 ? "s" : ""}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(`${mark} ${r.family.padEnd(14)} ${r.probe.padEnd(30)} ${tail}`);
		for (const c of r.cases) {
			if (c.verdict === "fail" || (opts.verbose && c.verdict !== "pass")) {
				lines.push(`    ${GLYPH[c.verdict]} ${c.id}`);
				lines.push(`        expected ${c.expected}`);
				lines.push(`        actual   ${c.actual}`);
				if (c.note) lines.push(`        note     ${c.note}`);
			}
		}
	}

	lines.push("");
	const keys = Object.keys(report.metrics).sort();
	if (keys.length > 0) {
		lines.push("metrics");
		for (const k of keys) {
			const breach = report.ratchet.breaches.find((b) => b.metric === k);
			const bound = breach ? `  ✗ ratchet ${JSON.stringify(breach.bound)}` : "";
			lines.push(`  ${k.padEnd(38)} ${String(report.metrics[k]).padStart(8)}${bound}`);
		}
		lines.push("");
	}

	const { pass, fail, knownLimit } = report.totals;
	lines.push(
		`${fail === 0 && report.ratchet.ok ? "PASS" : "FAIL"} · ${pass} pass · ${fail} fail · ${knownLimit} known-limit · ${report.durationMs}ms`,
	);
	if (!report.ratchet.ok) {
		for (const b of report.ratchet.breaches) {
			lines.push(`  ratchet breach: ${b.metric} = ${b.value}, bound ${JSON.stringify(b.bound)}`);
		}
	}
	return lines.join("\n");
}
