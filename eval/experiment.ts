/**
 * Experiment runner — arms x rollouts x sessions, with the aggregation the
 * results are worth reporting in.
 *
 * Built after a single-run comparison produced a flat contradiction: two runs of
 * identical code against an identical target recorded 4 inventory items and 0.
 * Agent behaviour here is stochastic enough that n=1 is not evidence, so this
 * module exists to make the cheap correct thing easy — five rollouts, means with
 * percentile bootstrap intervals, and per-session series so a slope is visible.
 *
 * It carries the compounding experiment directly: an arm can persist its
 * workspace across k sessions or wipe it at each boundary, which is the ablation
 * that separates durable memory from the system prompt.
 */

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { computeEngagementStats } from "../core/stats.ts";
import { Workspace } from "../core/workspace.ts";
import { makeHostServices } from "../extensions/lib/host.ts";
import { auditLedger } from "./probes/ledger.ts";

const run = promisify(execFile);

export interface Arm {
	label: string;
	provider: string;
	model: string;
	profile?: "review" | "recon" | "pentest";
	/** Wipe the engagement workspace between sessions (isolates memory from prompt). */
	wipeBetweenSessions?: boolean;
}

export interface ExperimentSpec {
	/** Directory copied fresh for every rollout. */
	target: string;
	prompt: string;
	/** Sessions per rollout (k). >1 measures compounding. */
	sessions: number;
	/** Independent rollouts per arm (n). */
	rollouts: number;
	arms: Arm[];
	timeoutMs?: number;
}

/** Everything measurable from one session's ledger, with no model in the loop. */
export interface SessionMetrics {
	/** Where the session's stdout was captured. The only trajectory record there is. */
	log?: string;
	inventory: number;
	hypotheses: number;
	findings: number;
	coveragePct: number;
	cells: number;
	settledCells: number;
	evidenceBacked: number;
	evidenceDangling: number;
	findingsClassed: number;
	/** Share of findings whose evidence actually resolves. The faithfulness number. */
	evidenceBackingRate: number;
	durationMs: number;
	ok: boolean;
}

export interface RolloutResult {
	arm: string;
	rollout: number;
	sessions: SessionMetrics[];
}

const PIRED = new URL("../bin/pired.mjs", import.meta.url).pathname;

/** Unique per invocation, so engagement directories never collide across runs. */
const RUN_ID = Math.random().toString(36).slice(2, 8);

/**
 * pi prompts to trust an unknown directory and, with stdin open, blocks
 * indefinitely on the answer — documented in research/02 as an 8-minute hang at
 * ~0 CPU with no model connection. Every rollout runs in a fresh temp directory,
 * so every rollout hits it. Two things are needed and both are easy to forget:
 * pre-trust the directory, and close stdin (see `stdio` below). The first run of
 * this module left five processes blocked at 0:00 CPU for exactly this reason.
 */
async function pretrust(dir: string): Promise<void> {
	const path = join(process.env.HOME ?? "", ".pi", "agent", "trust.json");
	let trust: Record<string, boolean> = {};
	try {
		trust = JSON.parse(await readFile(path, "utf8")) as Record<string, boolean>;
	} catch {
		// no trust file yet
	}
	if (trust[dir]) return;
	trust[dir] = true;
	await writeFile(path, `${JSON.stringify(trust, null, 2)}\n`);
}

async function measure(engagementDir: string, durationMs: number, ok: boolean): Promise<SessionMetrics> {
	const ws = new Workspace(engagementDir, makeHostServices());
	const stats = await computeEngagementStats(ws);
	const audit = await auditLedger(ws);
	const findings = await ws.read("findings");
	const view = await import("../core/stats.ts").then((m) => m.computeCoverageView(ws));
	const settled = view ? view.matrix.counts.clear + view.matrix.counts.vulnerable : 0;
	const evidenceTotal = audit.backed.length + audit.dangling.length;
	return {
		inventory: (await ws.read("inventory")).length,
		hypotheses: (await ws.read("hypotheses")).length,
		findings: findings.length,
		coveragePct: stats.coveragePct ?? 0,
		cells: view?.matrix.applicable ?? 0,
		settledCells: settled,
		evidenceBacked: audit.backed.length,
		evidenceDangling: audit.dangling.length,
		findingsClassed: findings.filter((f) => f.class).length,
		evidenceBackingRate: evidenceTotal > 0 ? audit.backed.length / evidenceTotal : 0,
		durationMs,
		ok,
	};
}

async function oneRollout(spec: ExperimentSpec, arm: Arm, index: number): Promise<RolloutResult> {
	// A fresh target directory per rollout gives a fresh engagement workspace,
	// since pired derives the engagement name from the target's basename.
	const root = await mkdtemp(join(tmpdir(), "assay-"));
	// A run id in the name: without it two invocations share engagement
	// directories, and a straggler from an earlier run appends into a later run's
	// workspace. That happened — one rollout's ledger grew by 62 records after it
	// had been measured.
	const name = `${basename(spec.target)}-${arm.label.replace(/[^a-z0-9]+/gi, "")}-${RUN_ID}-r${index}`;
	const dir = join(root, name);
	await cp(spec.target, dir, { recursive: true });
	await pretrust(dir);
	const engagementDir = join(process.env.HOME ?? "", ".pired", "engagements", name);
	await rm(engagementDir, { recursive: true, force: true });

	const sessions: SessionMetrics[] = [];
	for (let s = 0; s < spec.sessions; s++) {
		if (s > 0 && arm.wipeBetweenSessions) await rm(engagementDir, { recursive: true, force: true });
		const started = Date.now();
		let ok = true;
		let transcript = "";
		try {
			const pending = run(
				process.execPath,
				[
					PIRED, "--profile", arm.profile ?? "review",
					"--provider", arm.provider, "--model", arm.model,
					"--no-theme", "--target", dir, "--prompt", spec.prompt,
				],
				{ timeout: spec.timeoutMs ?? 900_000, maxBuffer: 64 * 1024 * 1024, cwd: dir },
			);
			// Close the child's stdin immediately. execFile has no `stdio` option,
			// and with stdin left open pi waits on its trust prompt forever.
			pending.child.stdin?.end();
			const done = await pending;
			transcript = String(done.stdout ?? "");
		} catch (err) {
			ok = false; // a timeout or non-zero exit still leaves a gradeable ledger
			transcript = String((err as { stdout?: string }).stdout ?? "");
		}
		// Capture the session's output. pired persists work products but no
		// trajectory, so without this a bimodal result cannot be diagnosed at all —
		// there is nothing to read to find out what the run actually did.
		const logPath = join(engagementDir, `session-${s}.log`);
		try {
			await writeFile(logPath, transcript);
		} catch {
			// engagement dir may not exist if the run died before creating it
		}
		const m = await measure(engagementDir, Date.now() - started, ok);
		sessions.push({ ...m, log: logPath });
	}
	await rm(root, { recursive: true, force: true });
	return { arm: arm.label, rollout: index, sessions };
}

/** Rollouts are independent, so they run concurrently up to a small cap. */
export async function runExperiment(spec: ExperimentSpec, concurrency = 3): Promise<RolloutResult[]> {
	const jobs: Array<() => Promise<RolloutResult>> = [];
	for (const arm of spec.arms) {
		for (let i = 0; i < spec.rollouts; i++) jobs.push(() => oneRollout(spec, arm, i));
	}
	const out: RolloutResult[] = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			for (;;) {
				const idx = cursor++;
				const job = jobs[idx];
				if (!job) return;
				out.push(await job());
			}
		}),
	);
	return out;
}

// --- aggregation ------------------------------------------------------------

export interface Interval {
	mean: number;
	lo: number;
	hi: number;
	n: number;
}

/**
 * Percentile bootstrap over rollouts. Resampling is within-arm across rollouts —
 * the variance being estimated is run-to-run, which is the one that made the
 * single-run comparison meaningless.
 */
export function bootstrap(values: number[], iterations = 2000, seed = 42): Interval {
	const n = values.length;
	const mean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : 0;
	if (n < 2) return { mean: round(mean), lo: round(mean), hi: round(mean), n };
	let state = seed >>> 0;
	const rand = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const means: number[] = [];
	for (let b = 0; b < iterations; b++) {
		let sum = 0;
		for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)] as number;
		means.push(sum / n);
	}
	means.sort((a, b) => a - b);
	return {
		mean: round(mean),
		lo: round(means[Math.floor(iterations * 0.025)] as number),
		hi: round(means[Math.floor(iterations * 0.975)] as number),
		n,
	};
}

function round(x: number): number {
	return Number(x.toFixed(3));
}

export type MetricKey = keyof Omit<SessionMetrics, "ok">;

/** Aggregate the final session of each rollout — the state the engagement ended in. */
export function summarize(results: RolloutResult[], metrics: MetricKey[]): Record<string, Record<string, Interval>> {
	const byArm = new Map<string, RolloutResult[]>();
	for (const r of results) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
	const out: Record<string, Record<string, Interval>> = {};
	for (const [arm, rs] of byArm) {
		out[arm] = {};
		for (const m of metrics) {
			out[arm][m] = bootstrap(rs.map((r) => (r.sessions.at(-1)?.[m] as number) ?? 0));
		}
	}
	return out;
}

/** Per-session series per arm — the compounding view. */
export function sessionSeries(results: RolloutResult[], metric: MetricKey): Record<string, Interval[]> {
	const byArm = new Map<string, RolloutResult[]>();
	for (const r of results) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
	const out: Record<string, Interval[]> = {};
	for (const [arm, rs] of byArm) {
		const k = Math.max(...rs.map((r) => r.sessions.length));
		out[arm] = Array.from({ length: k }, (_, s) =>
			bootstrap(rs.map((r) => (r.sessions[s]?.[metric] as number) ?? 0)),
		);
	}
	return out;
}
