#!/usr/bin/env -S node --experimental-strip-types
/**
 * Field T1 runner — a model challenging findings against the live target.
 *
 *   npm run assay:field-t1 -- --passes 3 --arm blind --arm spec
 *
 * Three passes is the corpus's earned rule (`research/11`): a single pass on a
 * small denominator is not a measurement, so the range is reported beside the
 * mean and a gap smaller than the spread is not a gap.
 *
 * Transcripts land under eval/artifacts/field-<stamp>/ so a verdict can be
 * audited against the requests that produced it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { challengeAll, type Arm, type ModelConfig } from "./challenger.ts";
import { CLAIMS } from "./claims.ts";
import { auditClaims } from "./audit.ts";
import { scoreField, type Disposition } from "./score.ts";
import { startTarget } from "./target.ts";

const argv = process.argv.slice(2);
const value = (name: string, def: string): string => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1]?.startsWith("--") ? (argv[i + 1] as string) : def;
};
const many = (name: string): string[] => argv.reduce<string[]>((acc, a, i) => (a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1] as string] : acc), []);

const passes = Number(value("passes", "3"));
const arms = (many("arm").length > 0 ? many("arm") : ["blind", "spec"]) as Arm[];
const model = value("model", "deepseek/deepseek-v4-flash-0731");

/** Key from the environment, else the provider file pired already keeps. */
function apiKey(): { baseUrl: string; apiKey: string } {
	const env = process.env.OPENROUTER_API_KEY;
	if (env) return { baseUrl: "https://openrouter.ai/api/v1", apiKey: env };
	const file = JSON.parse(readFileSync(join(process.env.HOME ?? "", ".pired/models.json"), "utf8")) as {
		providers: Array<{ id: string; baseUrl: string; apiKey: string }>;
	};
	const or = file.providers.find((p) => p.id === "openrouter");
	if (!or?.apiKey) throw new Error("no OpenRouter key: set OPENROUTER_API_KEY or add the provider to ~/.pired/models.json");
	return { baseUrl: or.baseUrl, apiKey: or.apiKey };
}

const cfg: ModelConfig = { ...apiKey(), model };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join("eval/artifacts", `field-${stamp}`);
mkdirSync(outDir, { recursive: true });

const target = await startTarget();
try {
	const audit = await auditClaims(target.url);
	if (!audit.ok) {
		console.error("FAIL · the key does not describe the target; fix the instrument before measuring a model.");
		process.exit(1);
	}
	console.log(`⦿ field T1 · ${model} · ${CLAIMS.length} claims · ${passes} pass(es) · arms: ${arms.join(", ")}\n`);

	const summary: Record<string, Array<ReturnType<typeof scoreField>>> = {};
	const rawSummary: Record<string, Array<ReturnType<typeof scoreField>>> = {};
	for (const arm of arms) {
		summary[arm] = [];
		rawSummary[arm] = [];
		for (let pass = 1; pass <= passes; pass++) {
			const runs = await challengeAll(cfg, target.url, arm);
			const verdicts: Record<string, Disposition> = Object.fromEntries(runs.map((r) => [r.claim, r.disposition]));
			const score = scoreField(CLAIMS, verdicts);
			// The same pass with the contract removed, so its contribution is a
			// measured difference rather than an argument.
			const rawScore = scoreField(CLAIMS, Object.fromEntries(runs.map((r) => [r.claim, r.raw])));
			summary[arm]?.push(score);
			writeFileSync(join(outDir, `${arm}-pass${pass}.json`), `${JSON.stringify({ arm, pass, model, verdicts, score, rawScore, runs }, null, 2)}\n`);
			rawSummary[arm]?.push(rawScore);
			const errs = runs.filter((r) => r.error).length;
			console.log(
				`  ${arm} pass ${pass}: sens ${score.sensitivity.toFixed(2)}  spec ${score.specificity.toFixed(2)}  ` +
				`res ${score.resolution.toFixed(2)}  reqs ${runs.reduce((n, r) => n + r.requests, 0)}` +
				(errs > 0 ? `  (${errs} errored)` : "") +
				(score.falseRefutations.length > 0 ? `  FALSE REFUTATIONS: ${score.falseRefutations.join(",")}` : "") +
				(score.falseConfirmations.length > 0 ? `  false confirms: ${score.falseConfirmations.join(",")}` : "") +
				// Only what the contract actually rescued: a real bug the model's own
				// verdict would have destroyed and the burden of proof did not let it.
				// Reporting the raw list here instead would credit the contract with
				// refutations it also let through.
				((): string => {
					const saved = rawScore.falseRefutations.filter((id) => !score.falseRefutations.includes(id));
					return saved.length > 0 ? `\n      contract rescued: ${saved.join(", ")}` : "";
				})(),
			);
		}
	}

	const range = (xs: number[]): string => `${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}`;
	const mean = (xs: number[]): string => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
	console.log("\n| arm | contract | sensitivity | specificity | resolution |");
	console.log("|---|---|---|---|---|");
	for (const arm of arms) {
		for (const [label, set] of [["judged", summary[arm] ?? []], ["raw (no contract)", rawSummary[arm] ?? []]] as const) {
			if (set.length === 0) continue;
			console.log(
				`| ${arm} | ${label} | ${mean(set.map((x) => x.sensitivity))} (${range(set.map((x) => x.sensitivity))}) ` +
				`| ${mean(set.map((x) => x.specificity))} (${range(set.map((x) => x.specificity))}) ` +
				`| ${mean(set.map((x) => x.resolution))} (${range(set.map((x) => x.resolution))}) |`,
			);
		}
	}
	// The contract's contribution, summed over every pass: real bugs the model's
	// own verdict would have destroyed and the burden of proof kept.
	for (const arm of arms) {
		const judged = summary[arm] ?? [];
		const raw = rawSummary[arm] ?? [];
		const rescued = raw.reduce((n, r, i) => n + r.falseRefutations.filter((id) => !judged[i]?.falseRefutations.includes(id)).length, 0);
		const survived = judged.reduce((n, j) => n + j.falseRefutations.length, 0);
		console.log(`\n${arm}: the contract rescued ${rescued} real finding(s) the model tried to refute; ${survived} got past it.`);
	}
	console.log(`\nartifacts  ${outDir}`);
} finally {
	await target.close();
}
