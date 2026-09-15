#!/usr/bin/env -S node --experimental-strip-types
/**
 * The bare-pi arm of the real-app corpus scan.
 *
 * Mirrors `corpus/run-codex.ts` — same targets, same per-target truth files, same
 * grader, same seal, same prompt — but drives stock `pi` with no pired extension
 * loaded. Together the three arms answer the only question that separates a
 * harness from the model inside it: **what does pired add over the same model
 * driven bare, and how do both compare to a different agent entirely?**
 *
 * Differences from the pired arm, all forced by pi having no ledger:
 *  - the prompt drops the `record`/`recall` clauses, exactly as the codex arm does;
 *  - findings come back as the final message, because there is nothing to record
 *    them into. pi has no `--output-schema`, so the shape is asked for in the
 *    prompt and the JSON object is pulled out of the reply.
 *
 * pired is NOT in pi's global settings (`pi list` shows only subagents, btw and
 * plan-mode), so nothing security-specific loads here. Those three stock
 * extensions are left in place: they are this user's ordinary pi, and removing
 * them would measure a pi nobody runs.
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
	"file:line. Check for gaps before you finish.\n\n" +
	// pi has no --output-schema, so the contract is stated here instead. Identical
	// fields to the codex arm's schema, so both arms are graded on the same shape.
	"When you are done, end your final message with ONE JSON object and nothing after it:\n" +
	'{"findings": [{"file": "path/relative/to/root.go", "line": 42, "cwe": "CWE-89", ' +
	'"vuln_class": "sqli", "severity": "high", "message": "one sentence"}]}\n' +
	"Every finding must carry a real file and a real line. Report an empty array if you found nothing.";

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

const workDir = arg("work", "/tmp/corpus-pi");

/**
 * The seal must exempt the model endpoint and nothing else — and the model
 * endpoint is wherever the chosen provider actually lives. run.ts derives this;
 * this file hardcoded "openrouter.ai", so every bare-pi arm on any other
 * provider was sealed away from its own model.
 *
 * Measured: a full 5-target x 3-pass bare-pi arm on the `zai` provider wrote 15
 * "Connection error" failures, while the pired arm against the same provider
 * reported an explicit 429. The failures were the seal, not the quota — and a
 * model that cannot be reached is indistinguishable from one that reviewed the
 * code and found nothing.
 */
const MODEL_HOST = await (async (): Promise<string> => {
	try {
		const cfg = JSON.parse(await readFile(join(process.env.HOME ?? "", ".pi", "agent", "models.json"), "utf8")) as {
			providers?: Record<string, { baseUrl?: string }>;
		};
		const url = cfg.providers?.[arg("provider", "openrouter") as string]?.baseUrl;
		return url ? new URL(url).hostname : "";
	} catch {
		return "";
	}
})();
const NO_PROXY_HOSTS = ["localhost", "127.0.0.1", MODEL_HOST].filter(Boolean).join(",");
if (arg("sealed") !== "no") {
	process.stderr.write(`\u29bf sealed \u00b7 outbound HTTP blackholed except: ${NO_PROXY_HOSTS}\n`);
	if (!MODEL_HOST) process.stderr.write(`\u26a0 no baseUrl found for provider "${arg("provider", "openrouter")}" — the model may be unreachable under the seal\n`);
}
await mkdir(workDir, { recursive: true });
const schemaPath = join(workDir, "schema.json");
await writeFile(schemaPath, JSON.stringify(SCHEMA, null, 2));

process.stderr.write(`⦿ corpus scan · bare pi · ${targets.length} target(s) · ${RUN_ID}\n\n`);

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

/**
 * Pull the findings object out of a reply that is mostly prose.
 *
 * Brace-counting rather than a regex, because a regex cannot tell a brace inside
 * a string literal from one that opens an object, and review prose is full of
 * both. Returns undefined when nothing parses — an unreadable reply is a failed
 * run, not a zero score.
 */
function extractFindings(raw: string): Finding[] | undefined {
	const key = raw.lastIndexOf('"findings"');
	if (key < 0) return undefined;
	for (let i = key; i >= 0; i--) {
		if (raw[i] !== "{") continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < raw.length; j++) {
			const c = raw[j];
			if (escaped) { escaped = false; continue; }
			if (c === "\\") { escaped = true; continue; }
			if (c === '"') { inString = !inString; continue; }
			if (inString) continue;
			if (c === "{") depth += 1;
			else if (c === "}") {
				depth -= 1;
				if (depth !== 0) continue;
				try {
					const o = JSON.parse(raw.slice(i, j + 1)) as { findings?: Finding[] };
					if (Array.isArray(o.findings)) return o.findings;
				} catch { /* not this one; try an earlier brace */ }
				break;
			}
		}
	}
	return undefined;
}

const jobs = targets.map((m) => async (): Promise<void> => {
	const started = Date.now();
	const name = `${m.id}-${RUN_ID}`;
	const outFile = join(workDir, `${name}.reply.txt`);
	let ok = true;
	let error: string | undefined;
	let stdout = "";

	try {
		const pending = exec(
			"pi",
			[
				"--print",
				"--provider", arg("provider", "openrouter") as string,
				...(arg("model") ? ["--model", arg("model") as string] : []),
				PROMPT + scopeClause(m.scope),
			],
			{
				timeout: Number(arg("timeout", "1800000")), maxBuffer: 1 << 26, cwd: m.target,
				// Sealed exactly as the other two arms are. The corpus is built from
				// pre-patch commits, so an agent that can reach the network can fetch
				// the fixed release and diff the answer out — that is retrieval, not
				// discovery. Only the model endpoint is exempt.
				...(arg("sealed") === "no" ? {} : {
					env: {
						...process.env,
						HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1",
						https_proxy: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1",
						NO_PROXY: NO_PROXY_HOSTS,
						no_proxy: NO_PROXY_HOSTS,
					},
				}),
			},
		);
		pending.child.stdin?.end();
		stdout = (await pending).stdout;
	} catch (err) {
		ok = false;
		const e = err as { stderr?: string; message?: string; killed?: boolean };
		error = (e.killed ? "timeout: " : "") + (e.stderr || e.message || "unknown").slice(0, 200).replace(/\s+/g, " ");
	}

	let findings: Finding[] = [];
	try {
		// The reply is prose followed by the object the prompt asked for, and prose
		// contains braces — code snippets, sample payloads. Taking the first `{` and
		// running to the last `}` spanned all of it and failed to parse on 3 of 5
		// targets whose replies each ended in a perfectly good findings object.
		//
		// So: anchor on the LAST "findings" key, walk left to each candidate `{`,
		// and scan forward tracking string state until the braces balance. The first
		// candidate that parses AND carries a findings array wins.
		const raw = stdout;
		await writeFile(outFile, raw).catch(() => {});
		findings = dedupe(extractFindings(raw) ?? []);
		if (extractFindings(raw) === undefined) throw new Error("no findings object in the reply");
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
