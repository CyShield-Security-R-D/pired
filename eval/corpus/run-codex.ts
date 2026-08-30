#!/usr/bin/env -S node --experimental-strip-types
/**
 * The codex arm of the real-app corpus scan.
 *
 * Mirrors `corpus/run.ts` — same targets, same per-target truth files, same
 * grader — but drives codex instead of pired, so the two are comparable on the
 * only question that matters for a discovery claim: **how many real, patched
 * vulnerabilities does each harness actually find in real software?**
 *
 * Two disclosed differences from the pired arm, both forced by codex:
 *  - the prompt drops the `record`/`recall` clauses, since codex has neither;
 *  - findings come back as the final message (`-o` + `--output-schema`),
 *    because codex's sandbox cannot write files in this environment.
 *
 *   node eval/corpus/run-codex.ts [--only sqlparse] [--concurrency 3]
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dedupe, scoreFindings } from "../dvbank/score.ts";
import type { Finding } from "../dvbank/score.ts";
import { scopeClause } from "./lib.ts";

const exec = promisify(execFile);
const RUN_ID = Math.random().toString(36).slice(2, 8);

function arg(name: string, def = ""): string {
	const i = process.argv.indexOf(`--${name}`);
	const v = process.argv[i + 1];
	return i >= 0 && v && !v.startsWith("--") ? v : def;
}

interface Entry {
	id: string;
	package: string;
	repo: string;
	sha: string;
	target: string;
	truth: string;
	entries: number;
	scope?: string[];
	surface?: "direct" | "indirect";
}

// Mirrors the pired arm's correction (see run.ts) minus the record/recall
// clauses, which codex has no equivalent for. Without this the two arms differ
// on a prior that demonstrably decides the outcome, and the comparison measures
// the prompts rather than the harnesses.
const PROMPT =
	"Perform a security review of this codebase. This is production source from a real project, not a " +
	"modified or seeded copy: do not compare it against any upstream version you recall, and do not treat " +
	"\"matches upstream\" as evidence that code is safe — judge each sink on its own behaviour. Identify the " +
	"surface, test your hypotheses, and report confirmed issues as findings with cwe, severity and the exact " +
	"file:line. Check for gaps before you finish.";

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["file", "line", "cwe", "vuln_class", "severity", "message"],
				properties: {
					file: { type: "string", description: "Path relative to the review root" },
					line: { type: "integer" },
					cwe: { type: "string", description: "e.g. CWE-89; empty string if unknown" },
					vuln_class: { type: "string" },
					severity: { type: "string" },
					message: { type: "string" },
				},
			},
		},
	},
};

const corpusDir = arg("corpus", "/tmp/corpus");
const manifest = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")) as Entry[];
const only = arg("only");
// Comma-separated, matching corpus/run.ts, so both arms can be pinned to the
// same subset across repeated passes.
const wanted = only.split(",").map((x) => x.trim()).filter(Boolean);
const targets = wanted.length ? manifest.filter((m) => wanted.some((w) => m.id.includes(w) || m.package.includes(w))) : manifest;

const workDir = arg("work", "/tmp/corpus-codex");
await mkdir(workDir, { recursive: true });
const schemaPath = join(workDir, "schema.json");
await writeFile(schemaPath, JSON.stringify(SCHEMA, null, 2));

process.stderr.write(`⦿ corpus scan · codex · ${targets.length} target(s) · ${RUN_ID}\n\n`);

interface Row {
	id: string;
	repo: string;
	entries: number;
	found: number;
	recall: number;
	reported: number;
	seconds: number;
	ok: boolean;
	error?: string;
}

const rows: Row[] = [];

const jobs = targets.map((m) => async (): Promise<void> => {
	const started = Date.now();
	const name = `${m.id}-${RUN_ID}`;
	const outFile = join(workDir, `${name}.last.json`);
	let ok = true;
	let error: string | undefined;

	try {
		const pending = exec(
			"codex",
			[
				"exec", "--skip-git-repo-check",
				// no --ephemeral: it discarded the transcripts, so codex's behaviour
				// could not be audited afterwards while pired's could.
				"-s", "read-only",
				"-C", m.target,
				"-o", outFile,
				"--output-schema", schemaPath,
				...(arg("model") ? ["-m", arg("model")] : []),
				PROMPT + scopeClause(m.scope),
			],
			{
				timeout: Number(arg("timeout", "1800000")), maxBuffer: 1 << 26, cwd: m.target,
				// codex's read-only sandbox restricts filesystem writes, NOT network —
				// verified: it fetches pypi.org happily. Since the corpus is built from
				// pre-patch commits, an agent that can reach pypi or github can download
				// the fixed release and diff out the answer, which is what the pired
				// transcripts showed it doing up to 34 times on a single target.
				//
				// Blackhole outbound HTTP for the agent's shell commands while exempting
				// codex's own model API, so the arm is sealed the same way pired's is.
				...(arg("sealed") === "no" ? {} : {
					env: {
						...process.env,
						HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1",
						https_proxy: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1",
						NO_PROXY: "api.openai.com,chatgpt.com,auth.openai.com,localhost,127.0.0.1",
						no_proxy: "api.openai.com,chatgpt.com,auth.openai.com,localhost,127.0.0.1",
					},
				}),
			},
		);
		// codex exec reads stdin even with a prompt argument and blocks on the
		// open pipe execFile gives it (research/02 §5).
		pending.child.stdin?.end();
		await pending;
	} catch (err) {
		ok = false;
		const e = err as { stderr?: string; message?: string; killed?: boolean };
		error = (e.killed ? "timeout: " : "") + (e.stderr || e.message || "unknown").slice(0, 200).replace(/\s+/g, " ");
	}

	let findings: Finding[] = [];
	try {
		const raw = await readFile(outFile, "utf8");
		const mm = /\{[\s\S]*\}/.exec(raw);
		findings = dedupe((JSON.parse(mm ? mm[0] : raw) as { findings?: Finding[] }).findings ?? []);
	} catch (e) {
		if (ok) {
			ok = false;
			error = `unparseable final message: ${(e as Error).message.slice(0, 120)}`;
		}
	}

	const seconds = Math.round((Date.now() - started) / 1000);
	// An empty result returned in seconds is a failed run, not a zero score.
	// Scoring it as 0.0 recall is how a broken harness gets written down as a
	// measurement — this run exists to avoid exactly that.
	if (ok && findings.length === 0 && seconds < 60) {
		ok = false;
		error = `returned no findings in ${seconds}s — too fast to be a real review`;
	}

	if (!ok) {
		rows.push({ id: m.id, repo: m.repo, entries: m.entries, found: 0, recall: 0, reported: 0, seconds, ok, error });
		process.stdout.write(`  ${m.id.padEnd(20)} FAILED — ${error}\n`);
		return;
	}

	const score = await scoreFindings(findings, join(workDir, `${name}.report.json`), m.truth);
	rows.push({
		id: m.id, repo: m.repo, entries: m.entries,
		found: score.true_positives, recall: score.recall,
		reported: findings.length, seconds, ok,
	});
	process.stdout.write(
		`  ${m.id.padEnd(20)} ${String(m.entries).padEnd(4)} found ${String(score.true_positives).padEnd(3)} recall ${score.recall.toFixed(2)}  (${findings.length} reported, ${seconds}s)\n`,
	);
});

const concurrency = Math.min(Number(arg("concurrency", "3")), jobs.length);
let next = 0;
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		for (;;) {
			const i = next++;
			if (i >= jobs.length) return;
			await jobs[i]!();
		}
	}),
);

const good = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);
process.stdout.write(`\n⦿ real-app corpus · codex · ${good.length}/${rows.length} scanned\n\n`);
if (failed.length > 0) process.stdout.write(`⚠ ${failed.length} FAILED — not measurements, excluded from the totals below.\n\n`);

const totalTruth = good.reduce((a, r) => a + r.entries, 0);
const totalFound = good.reduce((a, r) => a + r.found, 0);
process.stdout.write(`  pooled recall: ${totalFound}/${totalTruth} = ${totalTruth ? (totalFound / totalTruth).toFixed(3) : "n/a"}\n`);
process.stdout.write(`  targets with >=1 real bug found: ${good.filter((r) => r.found > 0).length}/${good.length}\n`);
process.stdout.write(`  findings reported (mean): ${good.length ? (good.reduce((a, r) => a + r.reported, 0) / good.length).toFixed(1) : "n/a"}\n`);

await writeFile(join(workDir, `scan-${RUN_ID}.json`), `${JSON.stringify(rows, null, 2)}\n`);
process.stdout.write(`\nraw → ${join(workDir, `scan-${RUN_ID}.json`)}\n`);
