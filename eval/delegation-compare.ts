#!/usr/bin/env -S node --experimental-strip-types
/**
 * Isolated, matched baseline/candidate comparison for the pired corpus.
 *
 * Every live grid first runs the whole no-model preflight that `--dry-run`
 * stops after, so a sealing, grading or accounting fault is found before a
 * token is spent rather than read afterwards as a cheap, clean run. The model
 * sees only opaque cell, engagement and snapshot names: the target/pass/arm
 * mapping lives in files outside every sealed tree.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { access, appendFile, cp, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
// pi's own transient-failure rule, the one agent-session.js retries on. Both the
// top-level copy resolved here and the copy nested under pi-coding-agent are
// pi-ai 0.84.2 with a byte-identical utils/retry.js (checked 2026-09-23), so
// "transient" here means exactly what pi would have retried had retries been on.
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { DVBANK, dedupe, engagementTelemetry, fromLedger, scoreFindings, type Finding } from "./dvbank/score.ts";
import { scopeClause, stripLeakage } from "./corpus/lib.ts";
import {
	benchmarkSettings, DEFAULT_RETRY_POLICY, PROBE_FAUX_MODEL, PROBE_FAUX_PROVIDER, validateRetryPolicy,
	type CompareEntryConfig, type ProbeConfig, type RetryPolicy,
} from "./delegation-compare-entry.ts";
import {
	accountUsage, APPROVAL_DECISION, compareMatchedRuns, contentText, createBreaker, DEFAULT_BREAKER, findLeaks, isOfficialGrid, leakTermsFor,
	meteredCallCount, nextPairAction, observationsFromChildSession, observationsFromPiEvents,
	armsOfPair, parseBreakerPolicy, planSchedule, reconcileChildSession, reconcileSubagentCalls, SUBAGENT_TOOL, summarizeRetries,
	type Arm, type BreakerPolicy, type PairArm, type BreakerVerdict, type ChildSessionExtraction, type ChildVerdict, type ExpectedCell, type PiUsageExtraction,
	type OfficialShape, type ScheduledTwins, type RetriedAttempt, type RetrySummary, type RunMetric, type ScheduledPair, type SubagentChild, type SubagentReconciliation,
	type UsageAccounting, type UsageObservation,
} from "./delegation-compare-lib.ts";
// The grid's shape and identity (plan item 2.8): the pinned official corpora.
import {
	ARM_ORDER, corpusReasons, DEFAULT_BUDGET_ARMS, delegationOff, gridKindReasons, kindlessArmReasons, kindlessCorpus, kindSnapshotReasons, parseArmList, parseCorpora,
	parseGridKinds, parseMaxVerifiers, sameArms, scopeFor, scopeSettingsFor, shapeOf, summarizeTwins, twinTargets, type GridKind, type PinnedCorpus, type ScopeSettings,
} from "./delegation-compare-grid.ts";
// The staging, target-copy and tree-hash helpers moved to their own module so
// the same digest rule draws the panel here, in the preflight and in tests.
import { copyTargetTree, shouldIncludeSnapshotPath, stageSnapshot, treeManifest } from "./delegation-compare-stage.ts";
import { auditCell, auditLimits, summarizeAudits, type AuditLimits, type DelegationAudit } from "./delegation-audit.ts";
// Reaping a finished cell's strays by an opaque per-cell env marker, never by
// name: Landlock ABI 4 has no signal scoping, so a name match would reach other
// cells and the operator's own processes.
import { reapMarkedProcesses } from "./delegation-compare-proc.ts";
import { classifyRunStop, summarizeStops, type RunStop } from "./delegation-compare-stop.ts";
// The matched-compute arm (plan item 2.5): its policy, budget, union scorer and comparisons.
import {
	budgetRatios, matchedComparisons, metricOfUnion, nextSessionStep, parseMatchedPolicy, parseMatchedSpec, scoreUnion, sessionBudget, targetsWithoutBudget,
	type MatchedPolicy, type MatchedUnion, type SessionBudget, type SessionRun, type SessionState,
} from "./delegation-compare-matched.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "eval/delegation-compare-entry.ts");
/** Loaded in both arms' parent sessions: a default for bash calls that name no timeout (see the file). */
const BASH_TIMEOUT_EXTENSION = join(ROOT, "eval/delegation-compare-bash-timeout.ts");
const SCORE_PATH = join(ROOT, "eval/dvbank/score.ts");
const WORKSPACE_PATH = join(ROOT, "core/workspace.ts");
/** The script scoreFindings shells out to; pinned by content, since it is read afresh on every call. */
const GRADER_SCRIPT = join(DVBANK, "eval/graders/detection_grader.py");
const PI_NODE_MODULES = join(ROOT, "node_modules");
const PI_PACKAGE = join(PI_NODE_MODULES, "@earendil-works/pi-coding-agent");
const HOME = process.env.HOME || homedir();
const AGENT_BASE = join(HOME, ".pi/agent");
const DEFAULT_MANIFEST = "/tmp/pired-research/corpus/manifest.json";
const DEFAULT_FS_SEAL = "/tmp/pired-fs-seal";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
/** pi-subagents' small loader that exposes its launch tool (the lib's SUBAGENT_TOOL) on first use. */
const ENABLE_TOOL = "subagents_enable";
const RECORD_TOOL = "record";
/** What both arms must expose to the model at session start. */
const BASE_TOOLS = ["read", "bash", "edit", "write", RECORD_TOOL, "recall"] as const;
/**
 * What the candidate must NOT expose. pi-subagents adds bg_wait (~4.4k schema
 * characters) and subagent_supervisor to every parent; pired's design is
 * foreground-only and hides them. pired_delegate is the deleted native worker: a
 * candidate that still shows it is the wrong snapshot.
 */
const CANDIDATE_HIDDEN_TOOLS = ["bg_wait", "subagent_supervisor", "pired_delegate"] as const;
/** The pired agent the delegation probe launches; any of the four would do, scout is the cheapest to script. */
const PROBE_AGENT = "pired-scout";
/**
 * The pinned identities an official decision needs and that the coordinator
 * updates when a candidate is frozen (see --help). Read at preflight, not at
 * import, so a pin update never needs a code edit; the file itself is a
 * harness pin, so a grid cannot straddle an edit to it.
 */
const PINS_PATH = join(ROOT, "eval/delegation-compare.pins.json");
/** The lib owns the acceptance rule and its decision strings; the runner only consumes this verdict. */
const APPROVAL = APPROVAL_DECISION;
/** The opaque per-cell env marker every bash descendant inherits, so strays are reaped by value, never by name. */
const CELL_MARKER = "BENCH_CELL";
/**
 * Every sealed command runs inside its own transient systemd user scope, and the
 * scope, not an env marker, is what a cell's close kills. The marker is a second
 * pass only: `unset BENCH_CELL; setsid python3 -m http.server &` starts a stray
 * whose environ never held it (demonstrated against findMarkedProcesses), while
 * leaving a cgroup needs write access to /sys/fs/cgroup, which the seal never
 * grants. systemd-run needs the user bus to create the scope, so it alone gets
 * these two variables; the `env -u` wrapper strips them (and the INVOCATION_ID
 * systemd-run --scope adds) before fs-seal, so the sealed process's environment
 * is exactly the scrubbed one the leak check read.
 */
const SYSTEMD_RUN = "systemd-run";
const SYSTEMCTL = "systemctl";
const ENV_BIN = "/usr/bin/env";
const SCOPE_HOST_ENV = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;
/** Added by systemd-run --scope to the command it execs (measured); stripped so the sealed env is the recorded one. */
const SCOPE_ADDED_ENV = ["INVOCATION_ID"] as const;
/**
 * The grid's exclusive owner record: pid, the kernel's start time for that pid
 * and the process title. A pid alone is not an identity (pids are reused), and a
 * progress.json timestamp alone cannot tell a live two-hour arm from a dead runner.
 */
const OWNER_FILE = ".pired-compare.owner";
const RUNNER_TITLE = "pired-compare";
/** progress.json is rewritten at least this often while a grid runs, so a stale updatedAt means a dead runner. */
const HEARTBEAT_MS = 60_000;
/**
 * Hashed into the pins, so a harness edited between two grids shows up as a
 * different pin instead of two results silently measured by different rules.
 * The staging, process and comparison modules are pinned too: they decide the
 * staged digest, which strays are reaped, and the acceptance rule, so an edit to
 * any of them must land as a different pin rather than two runs measured apart.
 * The delegation audit writes summary.json's delegation section; it was missing
 * here, so an edit between a grid and its --resume changed that section with no
 * pin mismatch. The product limits it reads (turn budgets, the worker budget)
 * are pinned by value as delegationAuditLimits, not by file, so an unrelated
 * edit to core/ does not block a resume.
 */
const HARNESS_FILES = [
	"eval/delegation-compare.ts", "eval/delegation-compare-lib.ts", "eval/delegation-compare-entry.ts",
	"eval/delegation-compare-stage.ts", "eval/delegation-compare-proc.ts", "eval/delegation-audit.ts", "eval/corpus/fs-seal.c",
	"eval/delegation-compare-bash-timeout.ts", "eval/delegation-compare-stop.ts", "eval/delegation-compare-matched.ts",
	"eval/delegation-compare-grid.ts", "eval/delegation-compare.pins.json",
] as const;

/*
 * The frozen research inputs an official decision is pinned to (the corpus
 * manifest's sha256 and every truth key's) live in the pins file's `corpora`
 * since plan item 2.8. `--help` and the handoff both promise that a different
 * manifest or truth set is exploratory, so they are byte-compared, not merely
 * recorded. The v5 values were measured from
 * eval/artifacts/claude-handoff-2026-09-23/research/corpus (byte-identical to
 * /tmp/pired-research/corpus) on 2026-09-23 and moved unchanged; a manifest or
 * key edited afterwards no longer matches and cannot approve.
 */
/**
 * The intended baseline is git 496b190 and the candidate is a frozen snapshot of
 * the pi-subagents implementation (ADR-027). The baseline is verified against
 * the commit's own blobs at staging time (git can rebuild them); the candidate
 * has no commit, so its snapshot digest is pinned, and so is the pi-subagents
 * tree the candidate arm loads, because that package is half of the change
 * under test. The native-worker candidate's pin (675bd2ef…, ADR-025) no longer
 * applies: that snapshot exposes pired_delegate, which the candidate probe now
 * rejects.
 */
export interface ComparePins {
	baselineCommit: string;
	/** treeManifest(<candidate snapshot>, "snapshot").digest, or null until a candidate is frozen. */
	candidateDigest: string | null;
	candidateFrozenAt: string | null;
	/**
	 * The worker cap an official grid's candidate scope must state, or null when
	 * none is pinned. The cap is half of what the candidate arm is, so a grid run
	 * at another cap measures another candidate and is exploratory.
	 */
	candidateMaxAgents: number | null;
	piSubagents: { dir: string; version: string; digest: string };
	/** The official corpora (plan item 2.8), by name; none when the file has no `corpora`, so every grid is exploratory. */
	corpora: Record<string, PinnedCorpus>;
	/** The named grid kinds (plan item 2.8) a grid can be launched as with --grid-kind. */
	gridKinds: Record<string, GridKind>;
}

export function parseComparePins(text: string): ComparePins {
	const raw = JSON.parse(text) as Record<string, unknown>;
	const hex = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
	if (!hex(raw.baselineCommit)) throw new Error("pins: baselineCommit must be a full git commit id");
	if (raw.candidateDigest !== null && !hex(raw.candidateDigest)) throw new Error("pins: candidateDigest must be a sha256 hex digest or null");
	if (raw.candidateMaxAgents !== undefined && raw.candidateMaxAgents !== null && !isWorkerCap(raw.candidateMaxAgents)) throw new Error("pins: candidateMaxAgents must be a non-negative integer or null");
	const corpora = parseCorpora(raw.corpora);
	const sub = (raw.piSubagents ?? {}) as Record<string, unknown>;
	if (typeof sub.dir !== "string" || !sub.dir || typeof sub.version !== "string" || !sub.version || !hex(sub.digest)) {
		throw new Error("pins: piSubagents needs dir, version and a sha256 digest");
	}
	return {
		baselineCommit: raw.baselineCommit as string,
		candidateDigest: (raw.candidateDigest as string | null) ?? null,
		candidateFrozenAt: typeof raw.candidateFrozenAt === "string" ? raw.candidateFrozenAt : null,
		candidateMaxAgents: isWorkerCap(raw.candidateMaxAgents) ? raw.candidateMaxAgents : null,
		piSubagents: { dir: sub.dir, version: sub.version, digest: sub.digest as string },
		corpora,
		gridKinds: parseGridKinds(raw.gridKinds, corpora),
	};
}

function loadComparePins(): ComparePins { return parseComparePins(readFileSync(PINS_PATH, "utf8")); }

/** The pinned pi-subagents tree and the extension entry its package.json names. */
function piSubagentsPaths(pins: ComparePins): { dir: string; packageDir: string; entry: string } {
	const dir = resolve(ROOT, pins.piSubagents.dir);
	const packageDir = join(dir, "node_modules/pi-subagents");
	return { dir, packageDir, entry: join(packageDir, "index.js") };
}

/** Keep these words byte-identical to eval/corpus/run.ts and research/METHODOLOGY.md. */
export const REVIEW_PROMPT =
	"Perform a security review of this codebase. This is production source from a real project, not a " +
	"modified or seeded copy: do not compare it against any upstream version you recall, and do not treat " +
	"\"matches upstream\" as evidence that code is safe — judge each sink on its own behaviour. Record the " +
	"surface you find, record hypotheses and their outcomes as you settle them, and record confirmed issues " +
	"as findings with cwe, severity and the exact file:line of the vulnerable sink. Notes are not a " +
	"substitute for recording: anything not in the ledger does not count.";

export type Target = {
	id: string;
	name: string;
	package: string;
	target: string;
	truth: string;
	scope?: string[];
	aliases?: string[];
	entries?: number;
	/**
	 * A patched twin's target (plan item 2.8): the id of the target whose fix
	 * commit this tree is. Set only on entries read from the --twins file.
	 */
	twinOf?: string;
	[key: string]: unknown;
};

type Options = {
	baseline: string;
	candidate: string;
	corpus: string;
	truth: string;
	out: string;
	provider: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	passes: number;
	concurrency: number;
	timeoutMs: number;
	selected: string[];
	fsSeal: string;
	manifestPath: string;
	dryRun: boolean;
	/** --auth-horizon-hours: how long the provider's OAuth token must stay valid; computed from the grid when absent. */
	authHorizonHours?: number;
	/**
	 * --candidate-max-agents: the worker cap the candidate arm's scope states
	 * (default 8). Absent only for a grid whose manifest predates the option,
	 * whose resume must write the scope it started with: no `maxAgents`.
	 */
	candidateMaxAgents?: number;
	/**
	 * --baseline-max-agents (plan item 2.8): the worker cap the baseline's scope
	 * states. Absent, it states none, as in every earlier grid.
	 */
	baselineMaxAgents?: number;
	/**
	 * --max-verifiers (plan item 2.8): the verifier cap the baseline's or the
	 * candidate's scope states. Absent for an arm, its scope states none.
	 */
	maxVerifiers?: Partial<Record<PairArm, number>>;
	/**
	 * --budget-arms (plan item 2.8): which arms' scopes carry the budget line.
	 * Absent means DEFAULT_BUDGET_ARMS (candidate, matched), what every earlier
	 * grid wrote; it is set only when it differs, so the manifest keeps its bytes.
	 */
	budgetArms?: Arm[];
	/**
	 * --twins (plan item 2.8): the patched twins file, in the fresh corpus's
	 * shape (eval/corpus/fresh/twins.json). Given only with --twin-arms.
	 */
	twinsPath?: string;
	/**
	 * --twin-arms (plan item 2.8): the arms that run the patched twins. Absent,
	 * no twin runs and every output is what it was before the option.
	 */
	twinArms?: PairArm[];
	/**
	 * --grid-kind (plan item 2.8): the pinned grid kind this grid claims to be.
	 * Official only when every option matches it; absent, the grid is judged
	 * against the kindless (v5) corpus exactly as before.
	 */
	gridKind?: string;
	/**
	 * --breaker: re-queue infrastructure-failed pairs and stop on the circuit
	 * breaker instead of on the first invalid run. Absent: fail-fast, exactly as
	 * every grid before the option ran.
	 */
	breaker?: BreakerPolicy;
	/**
	 * --retry: pi's agent retry on, under DEFAULT_RETRY_POLICY (ADR-033).
	 * Absent, retries stay off and every output is the v5 one.
	 */
	retryPolicy?: RetryPolicy;
	/**
	 * --matched: the matched-compute arm (plan item 2.5), the candidate snapshot
	 * with delegation off run k times at the candidate's token budget. Absent,
	 * no such arm runs and every output is what it was before the option.
	 */
	matched?: MatchedPolicy;
};

type JsonRecord = Record<string, unknown>;
type Provider = { provider: string; model: string; baseHost: string; allowedHosts: string[] };
type EntryConfig = CompareEntryConfig & { probe?: ProbeConfig };
type Parsed = "help" | { kind: "run"; options: Options } | { kind: "resume"; dir: string };

/**
 * The pre-registered re-run rule, printed in --help and written verbatim into
 * every manifest as `resumePolicy`, so it is fixed before any scored run and a
 * resume cannot be argued into re-running a pair it should not.
 */
const RESUME_POLICY =
	"--resume <out-dir> first claims the grid exclusively: it refuses while the " +
	"runner recorded in <out>/" + OWNER_FILE + " (pid, kernel start time, title " +
	RUNNER_TITLE + ") is alive. It then reruns the whole preflight into " +
	"<out>/resume-<n>/, never over the grid's own manifest.json, which is written " +
	"only by the run that created the grid, and compares every recomputed pin " +
	"(runtime, entry, lib, proc, stage, runner, delegation audit and the limits it " +
	"reads, pins file, pinned pi-subagents tree, fs-seal source and binary, grader, " +
	"snapshots, source and truth hashes, prompt, provider endpoint, provider/model/" +
	"thinking, the probe-resolved model runtime, passes, schedule) with that original " +
	"manifest. It refuses unless all are byte-identical; a refused or failed resume " +
	"records why only under resume-<n>/ and leaves manifest.json and progress.json as " +
	"they were. Each pair is judged at its highest attempt only, never by mixing " +
	"attempts: it is kept when both arms are valid at that attempt, and re-run (both " +
	"arms, fresh cells, attempt + 1) when an arm is missing there or invalid for an " +
	"infrastructure reason (infraFailure:true). Infrastructure is read only from " +
	"provider-originated text, never from harness messages or free stderr: the " +
	"failing parent reply's or compaction's errorMessage, an errored worker's provider failure " +
	"from its child session (counted only when the parent's subagent result carries " +
	"the same text), and the entry's " +
	"benchmark_fetch_error lines. It is a failure pi itself would retry " +
	"(isRetryableAssistantError), a provider message that asks the client to try again, " +
	"a zai 1302/1308/1310 code, a provider quota or usage " +
	"limit, an undici/socket error code (UND_ERR_*, ECONNRESET, ECONNREFUSED, " +
	"ETIMEDOUT, EAI_AGAIN), or an arm stopped by this runner's own signal handling " +
	"(runner interruption). A quota or usage-window failure stops the grid, and the " +
	"quota must reset before --resume. A pair with an arm invalid for any other " +
	"reason (a timeout, a fast empty run, a harness check) stays invalid; a resume of " +
	"an official grid holding such a pair refuses to launch, since its decision is " +
	"already incomplete_or_invalid. When a pair's first arm is invalid its second arm " +
	"is not launched and is recorded as not launched, as infrastructure exactly when " +
	"the first arm's failure was. Every attempt is appended to runs.jsonl with its " +
	"attempt number.";

/**
 * How a resume treats the matched arm, written into a manifest only when the
 * grid runs one, so every other manifest keeps its bytes.
 */
const MATCHED_RESUME_POLICY =
	"The matched arm runs only after a pair whose two arms are both valid at the same attempt, and " +
	"belongs to that attempt: a pair re-run by --resume re-runs its matched sessions too, since under " +
	"mode follow their budget is the new candidate run's tokens. For a kept pair, each session is judged " +
	"at its own highest attempt by the pairing rule: a valid session is kept, a missing session or one " +
	"invalid for infrastructure is re-run on its own at attempt + 1 with the budget of the pair's kept " +
	"candidate run, and one invalid for any other reason stays invalid, which leaves the matched arm " +
	"invalid for that pair. The arm is valid only when all k sessions are. It never changes the gate, " +
	"the approval or which pairs are re-run.";

/** Built on demand: the pin lines read eval/delegation-compare.pins.json, and --help must still print if it is broken. */
function helpText(): string {
	let pins: ComparePins | undefined;
	let pinsError = "";
	try { pins = loadComparePins(); } catch (error) { pinsError = message(error); }
	const baseline = pins ? pins.baselineCommit.slice(0, 7) : "(pins unreadable)";
	const candidate = pins ? (pins.candidateDigest ? `${pins.candidateDigest.slice(0, 12)}… (frozen ${pins.candidateFrozenAt ?? "date not recorded"})` : "NOT FROZEN (every grid is exploratory)") : `(pins unreadable: ${pinsError})`;
	const sub = pins ? `${pins.piSubagents.version} at ${pins.piSubagents.dir}, tree ${pins.piSubagents.digest.slice(0, 12)}…` : "(pins unreadable)";
	return `Matched pired baseline/candidate evaluation (no model calls with --dry-run)

Usage:
  node --experimental-strip-types eval/delegation-compare.ts --baseline <snapshot> --candidate <snapshot> --corpus <targets> --truth <truth-dir> --out <dir> --provider <id> --model <id> [options]
  node --experimental-strip-types eval/delegation-compare.ts --resume <out-dir>

Options:
  --provider <id>       Provider ID (required)
  --model <id>          Model ID (required)
  --thinking <level>    Fixed effort for both arms (default: medium)
  --passes <n>          Complete passes per target, minimum 3; 1 allowed with --only (default: 3)
  --only <ids>          Comma-separated exact target IDs (default: every target
                        in the manifest; any number, at least one)
  --concurrency <n>     Matched pairs in flight, 1-8; each pair runs its two
                        arms one after the other (default: 2)
  --timeout <ms>        Per-arm deadline (default: ${DEFAULT_TIMEOUT_MS})
  --manifest <path>     Research manifest (default: ${DEFAULT_MANIFEST})
  --fs-seal <path>      Required Landlock wrapper (default: ${DEFAULT_FS_SEAL})
  --auth-horizon-hours <h>
                        How long the provider's OAuth token must stay valid
                        (default: the grid's worst case, passes x
                        ceil(targets/concurrency) x 2 arms x timeout, and with
                        --breaker x maxAttempts plus the cooldowns, capped at
                        ${AUTH_HORIZON_CAP_MS / 3_600_000} h, plus ${AUTH_MARGIN_MS / 60_000} min)
  --candidate-max-agents <n>
                        Worker cap the candidate's scope states; the
                        baseline's scope names none (default: ${DEFAULT_CANDIDATE_MAX_AGENTS})
  --baseline-max-agents <n>
                        Worker cap the baseline's scope states (default: none,
                        the baseline runs at its snapshot's default)
  --max-verifiers <arm>=<n>[,<arm>=<n>]
                        Verifier cap (maxVerifiers) the baseline's or the
                        candidate's scope states (default: none)
  --budget-arms <arm,...>|none
                        Arms whose scope carries the budget line (default:
                        ${DEFAULT_BUDGET_ARMS.join(",")}; the baseline's scope is then unchanged).
                        These three are pinned in the manifest, restored on
                        --resume, and without --grid-kind make a grid exploratory.
                        One snapshot may run in both arms only when their
                        scopes differ
  --twins <file>        Patched twins, in the fresh corpus's twins.json shape
                        (name, twin_of = the target's name, fixed_regions, ...);
                        each twin runs under its name as its id, and its answer
                        key must be an empty list. Needs --twin-arms
  --twin-arms <arm,...> Arms that run the twins (baseline, candidate). Twin runs
                        never enter the gate or the matched arm; they count
                        toward progress and the breaker, and summary.json lists
                        them per arm with their cells. Pinned in the manifest
  --grid-kind <name>    Claim a grid kind of the pins file (gridKinds): its
                        corpus, snapshots, arm options, twin arms, matched
                        policy, retry, breaker and timeout. Official only when
                        every one matches; each difference is listed as an
                        exploratory reason. Pinned in the manifest
  --breaker <spec>      Stop on a circuit breaker instead of the first invalid
                        run, and re-queue pairs that fail for infrastructure.
                        <spec> is "default", or comma-separated k=v pairs
                        over the defaults: consecutive=${DEFAULT_BREAKER.consecutive} rate=${DEFAULT_BREAKER.rate}
                        window=${DEFAULT_BREAKER.window} cooldownMs=${DEFAULT_BREAKER.cooldownMs} maxAttempts=${DEFAULT_BREAKER.maxAttempts}
                        attemptCeiling=${DEFAULT_BREAKER.attemptCeiling}. Pinned in the manifest; off
                        unless given. It lengthens the worst case the
                        OAuth check sizes (see --auth-horizon-hours)
  --out <dir>           New or empty directory; must not contain an advisory ID
  --resume <out-dir>    Continue a stopped grid in place; takes no other option
  --retry               Retry transient provider errors inside a run: pi's agent
                        retry, ${DEFAULT_RETRY_POLICY.maxRetries} per streak; a run may fail at most
                        max(${DEFAULT_RETRY_POLICY.maxFailedAttempts}, ${DEFAULT_RETRY_POLICY.maxFailedAttemptRate * 100}% of its metered requests) attempts,
                        parent and workers; recorded in the manifest
                        (default: off, as in every v5 grid)
  --matched <spec>      Also run the matched-compute arm: the candidate snapshot
                        with delegation off (its scope states maxAgents 0), k
                        sessions in fresh cells after each pair whose two arms
                        are valid, each stopped between requests at B/k tokens,
                        their findings unioned and scored with the pinned
                        scorer. <spec> is "follow" (B = the pair's candidate
                        tokens, the gate's metric), "fixed", or k=v pairs:
                        mode=follow|fixed k=3 budget.<target id>=<tokens> (fixed
                        only). Pinned in the manifest; reported beside the gate
                        as matched vs candidate and matched vs baseline, never
                        inside it (default: off)
  --matched-snapshot <dir>
                        Run the matched arm from this snapshot instead of the
                        candidate's; makes the grid exploratory
  --dry-run             Run the preflight only, with no model calls
  --help, -h            Show this help without starting a model

Arms: both run pired's pired.ts from their own staged snapshot through pi's SDK
with the same settings (packages [], retries off unless --retry, compaction on,
cache warming off). The candidate also loads the pinned pi-subagents extension,
so the arms differ only in the change under test; the baseline loads nothing
else.
  pi-subagents: ${sub}
Workers run as pi-subagents foreground children inside the arm's process, and
their sessions are written to <cell>/child-sessions, where the accounting reads
every file.

Preflight (always runs; --dry-run stops after it, a live grid starts only if it
passes), recorded in <out>/manifest.json (a resume's in <out>/resume-<n>/manifest.json)
in this order: input existence, the provider OAuth token's expiry against the
grid's worst-case duration (a token that could expire mid-grid would be
refreshed inside a cell, under that cell's own lock), staged snapshot hashes
and redactions, the pinned pi-subagents tree, runtime/harness/grader pins, the
systemd scope check, the Landlock answer-key denial plus the escape-vector and
provider-network checks, the pinned grader end to end for every target (an
empty ledger scores 0 findings, an oracle finding scores a true positive), a
sealed probe of the real per-cell entry command for every target and arm,
answered once by a scripted faux model so the tools are read where the model
sees them, after pired's before_agent_start (they must be exactly
  baseline:  ${BASE_TOOLS.join(",")}
  candidate: the same plus ${ENABLE_TOOL}, and none of ${CANDIDATE_HIDDEN_TOOLS.join(", ")}),
whose resolved model runtime (provider, model, api, endpoint, context window,
max tokens, and the effective thinking level after pi clamps the request to
what the model supports, which must equal --thinking) is pinned and must match
every scored run, and one sealed delegation probe per grid (candidate arm,
first target): the scripted parent
launches ${PROBE_AGENT} through pi-subagents under an enforced loopback-only
scope; the worker must record a surface element into the parent's ledger, have
an out-of-scope bash call blocked by pired's gate, and leave a child session
the accounting reconciles with the parent's subagent result. A second worker
keeps calling tools until pired's turn budget stops it, and must be accounted
as incomplete, not as a failed run. No provider is contacted by any probe.

Isolation: each cell stages its own fresh redacted snapshot copy and its own
target copy (external symlinks rewritten in-tree or removed), drops broker
sockets (every DBUS_* variable, XDG_RUNTIME_DIR, *_SOCK) from the child
environment, and runs in its own transient systemd user scope. When the cell
closes (normal, timeout or abort) the runner SIGKILLs and stops that scope,
verifies its cgroup is empty, then reaps any process still carrying the opaque
${CELL_MARKER} marker as a second pass. The preflight refuses to run if systemd
user scopes are unavailable or a setsid stray with the marker unset survives its
scope's close; the escape-vector check refuses if a sealed process can reach the
docker socket, the user D-Bus, or systemd --user, or sees a D-Bus address; the
network check refuses if DNS or TLS to the provider fails.

Official vs exploratory: only a pinned corpus's targets x its passes is an
acceptance decision (the pins file's corpora; without --grid-kind, the v5 five
research targets x 3 passes; with it, the kind's corpus, snapshots and arm
options), and only when the manifest, every truth key, the baseline, the
candidate snapshot, its worker cap and the pi-subagents tree match their pins.
Without --grid-kind:
  baseline:  git ${baseline}
  candidate: ${candidate}
  cap:       ${pins ? (pins.candidateMaxAgents === null ? "NOT PINNED (every grid is exploratory)" : `--candidate-max-agents ${pins.candidateMaxAgents}`) : "(pins unreadable)"}
--only, a different manifest, other --passes, or any pin mismatch produce an
EXPLORATORY comparison that cannot approve the candidate.
Acceptance also needs both priority models (each grid is one model), so approved
here is approved-for-this-model.

Pins (eval/delegation-compare.pins.json; the file is itself a harness pin, so a
resume refuses across an edit to it). To freeze a candidate:
  1. Copy the working tree into a new snapshot directory with the stage module's
     rules (shouldIncludeSnapshotPath: bin, core, extensions, checklists,
     skills, themes, package.json, package-lock.json, tsconfig.json; no tests,
     docs or eval) and never edit it afterwards.
  2. Record its digest: treeManifest(<snapshot>, "snapshot").digest from
     eval/delegation-compare-stage.ts, as candidateDigest, with the date as
     candidateFrozenAt.
  3. Keep piSubagents pointing at the pinned install. It lives under
     eval/artifacts (not in git); rebuild it with
       npm install --prefix eval/artifacts/pi-subagents-0.71.0 --ignore-scripts --save-exact pi-subagents@0.71.0
     and check treeManifest(<dir>, "runtime").digest against piSubagents.digest.
  4. Run a full-grid --dry-run for each priority model: it must pass and print
     no EXPLORATORY line.

Pairs run pass-major with the arm order counterbalanced. Without --breaker,
after any invalid run the runner stops launching new pairs; in-flight pairs
finish, except that a pair whose first arm was invalid does not launch its second
arm (recorded as not launched). A provider quota or usage-window failure also
stops the grid, and the quota must reset before --resume.
With --breaker, a pair with an arm invalid for infrastructure is re-queued, both
arms at attempt + 1, after cooldownMs x the attempts this runner made at it, up
to maxAttempts; one invalid for any other reason is never re-queued. The breaker
stops new launches at once on a spent quota or on a non-infrastructure invalid
run of an official grid, and otherwise after <consecutive> launched runs fail in
a row, or when at least a <rate> share of the last <window> launched runs failed
(read once that many are in), counting every failure, infrastructure or not; a
valid run ends the streak.
A pair still counts only when both arms are valid at the same attempt. A pair
still failing at attempt <attemptCeiling>, counted across resumes, is abandoned:
no resume re-runs it, the grid cannot approve, and an official grid stops, and
its resume is refused, as for a blocked pair.
SIGINT/SIGTERM/SIGHUP stops new launches, terminates only process groups and
scopes this runner started (a second signal kills them), reaps their strays,
records each arm it stopped as a runner interruption (infrastructure, re-run by
--resume) with the signal time, and still writes summary.json marked
interrupted. The runner claims <out> exclusively in
${OWNER_FILE} and refreshes progress.json updatedAt every ${HEARTBEAT_MS / 1000} s while it
runs, so a stale timestamp means a dead runner.

Resume: ${RESUME_POLICY}

Exit status: 0 for a passing --dry-run or an official approval decision;
1 for anything else, including every exploratory grid.
`;
}

export function parseOptions(argv: string[]): Parsed {
	if (argv.includes("--help") || argv.includes("-h")) return "help";
	if (argv.includes("--resume")) {
		if (argv.length !== 2 || argv[0] !== "--resume" || !argv[1] || argv[1].startsWith("--")) {
			throw new Error("--resume takes exactly one argument, the output directory, and no other option.");
		}
		return { kind: "resume", dir: resolve(argv[1]!) };
	}
	const valueFlags = new Set([
		"--baseline", "--candidate", "--corpus", "--truth", "--out", "--provider", "--model",
		"--thinking", "--passes", "--only", "--concurrency", "--timeout", "--manifest", "--fs-seal", "--auth-horizon-hours",
		"--candidate-max-agents", "--breaker", "--matched", "--matched-snapshot",
		"--baseline-max-agents", "--max-verifiers", "--budget-arms", "--twins", "--twin-arms", "--grid-kind",
	]);
	const values = new Map<string, string>();
	let dryRun = false;
	let retry = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		if (flag === "--dry-run") { dryRun = true; continue; }
		if (flag === "--retry") { retry = true; continue; }
		if (!valueFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
		const value = argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (values.has(flag)) throw new Error(`Repeated option: ${flag}`);
		values.set(flag, value);
	}
	const required = ["--baseline", "--candidate", "--corpus", "--truth", "--out", "--provider", "--model"];
	for (const key of required) if (!values.get(key)) throw new Error(`Required option missing: ${key}`);
	const thinking = values.get("--thinking") ?? "medium";
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error(`Invalid --thinking value: ${thinking}`);
	const passes = Number(values.get("--passes") ?? "3");
	const concurrency = Number(values.get("--concurrency") ?? "2");
	const timeoutMs = Number(values.get("--timeout") ?? String(DEFAULT_TIMEOUT_MS));
	const selected = (values.get("--only") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
	// Fewer than three passes only for an --only pilot, which is exploratory by
	// construction: it proves the live path end to end without counting toward
	// the decision.
	if (!Number.isSafeInteger(passes) || passes < (selected.length ? 1 : 3)) throw new Error("--passes must be an integer of at least 3 (at least 1 with --only)");
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--concurrency must be an integer from 1 to 8");
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout must be a positive finite millisecond count");
	if (new Set(selected).size !== selected.length) throw new Error("--only lists a target more than once");
	const horizon = values.get("--auth-horizon-hours");
	const authHorizonHours = horizon === undefined ? undefined : Number(horizon);
	if (authHorizonHours !== undefined && (!Number.isFinite(authHorizonHours) || authHorizonHours <= 0)) throw new Error("--auth-horizon-hours must be a positive number of hours");
	const candidateMaxAgents = Number(values.get("--candidate-max-agents") ?? String(DEFAULT_CANDIDATE_MAX_AGENTS));
	if (!isWorkerCap(candidateMaxAgents)) throw new Error("--candidate-max-agents must be a non-negative integer");
	const baselineCapText = values.get("--baseline-max-agents");
	const baselineMaxAgents = baselineCapText === undefined ? undefined : Number(baselineCapText);
	if (baselineMaxAgents !== undefined && !isWorkerCap(baselineMaxAgents)) throw new Error("--baseline-max-agents must be a non-negative integer");
	const verifiersText = values.get("--max-verifiers");
	const maxVerifiers = verifiersText === undefined ? undefined : parseMaxVerifiers(verifiersText);
	const budgetText = values.get("--budget-arms");
	const budgetList = budgetText === undefined ? undefined : parseArmList(budgetText, ARM_ORDER, "--budget-arms");
	// The default set is stored as absent, so a grid that names it writes the manifest every earlier grid wrote.
	const budgetArms = budgetList === undefined || sameArms(budgetList, DEFAULT_BUDGET_ARMS) ? undefined : budgetList;
	const twinsText = values.get("--twins");
	const twinArmsText = values.get("--twin-arms");
	const twinList = twinArmsText === undefined ? [] : parseArmList(twinArmsText, ["baseline", "candidate"], "--twin-arms") as PairArm[];
	// Either alone would be a grid that loads twins it never runs, or runs twins it never loaded.
	if (twinList.length && twinsText === undefined) throw new Error("--twin-arms needs --twins <file>, the patched twins to run");
	if (twinsText !== undefined && !twinList.length) throw new Error("--twins needs --twin-arms <arm,...>: no arm would run the twins");
	const gridKind = values.get("--grid-kind");
	if (gridKind !== undefined && !/^[A-Za-z0-9._-]+$/.test(gridKind)) throw new Error("--grid-kind must be a pinned kind's name");
	const breakerText = values.get("--breaker");
	const breaker = breakerText === undefined ? undefined : parseBreakerSpec(breakerText);
	const matchedText = values.get("--matched");
	const matchedSnapshot = values.get("--matched-snapshot");
	if (matchedSnapshot !== undefined && matchedText === undefined) throw new Error("--matched-snapshot needs --matched");
	const matched = matchedText === undefined ? undefined : parseMatchedSpec(matchedText, matchedSnapshot === undefined ? undefined : resolve(matchedSnapshot));
	// The OAuth check caps its horizon at AUTH_HORIZON_CAP_MS. With the breaker's
	// attempts and kMax sessions per pair the official grid's worst case (576.9 h
	// at the default k = 3, kMax = 6; 360.9 h even at kMax = 3) is past that cap,
	// and the check would silently size a shorter grid than this one; the
	// operator states the bound instead.
	if (matched && breaker && authHorizonHours === undefined) {
		throw new Error(`--matched with --breaker needs --auth-horizon-hours: the grid's worst case is past the ${AUTH_HORIZON_CAP_MS / 3_600_000} h cap the OAuth check would otherwise use without saying so`);
	}
	return {
		kind: "run",
		options: {
			baseline: resolve(values.get("--baseline")!), candidate: resolve(values.get("--candidate")!),
			corpus: resolve(values.get("--corpus")!), truth: resolve(values.get("--truth")!), out: resolve(values.get("--out")!),
			provider: values.get("--provider")!, model: values.get("--model")!,
			thinking: thinking as Options["thinking"], passes, concurrency, timeoutMs, selected,
			fsSeal: resolve(values.get("--fs-seal") ?? DEFAULT_FS_SEAL),
			manifestPath: resolve(values.get("--manifest") ?? DEFAULT_MANIFEST), dryRun,
			...(authHorizonHours === undefined ? {} : { authHorizonHours }),
			candidateMaxAgents,
			...(baselineMaxAgents === undefined ? {} : { baselineMaxAgents }),
			...(maxVerifiers === undefined ? {} : { maxVerifiers }),
			...(budgetArms === undefined ? {} : { budgetArms }),
			...(twinsText === undefined ? {} : { twinsPath: resolve(twinsText), twinArms: twinList }),
			...(gridKind === undefined ? {} : { gridKind }),
			...(breaker === undefined ? {} : { breaker }),
			...(retry ? { retryPolicy: { ...DEFAULT_RETRY_POLICY } } : {}),
			...(matched === undefined ? {} : { matched }),
		},
	};
}

/**
 * --breaker's value: "default", or k=v pairs over the defaults, with the
 * manifest's field names. Validated by the same rule the manifest is read back
 * with, so a grid cannot start under a policy its own resume would refuse.
 */
export function parseBreakerSpec(spec: string): BreakerPolicy {
	const policy: Record<string, unknown> = { ...DEFAULT_BREAKER };
	if (spec.trim() !== "default") {
		const seen = new Set<string>();
		for (const part of spec.split(",")) {
			const [key, value, extra] = part.split("=").map((x) => x.trim());
			if (!key || value === undefined || value === "" || extra !== undefined) throw new Error(`--breaker: expected "default" or k=v pairs, got "${part}"`);
			if (seen.has(key)) throw new Error(`--breaker: ${key} is given twice`);
			seen.add(key);
			policy[key] = Number(value);
		}
	}
	try {
		return parseBreakerPolicy(policy);
	} catch (error) {
		throw new Error(`--breaker: ${message(error)}`);
	}
}

/**
 * The retry policy a grid recorded, or undefined for a manifest without one:
 * every v5 manifest, which ran with retries off and must resume that way. A
 * policy that is present but malformed refuses the resume rather than
 * silently running the rest of the grid without retries.
 */
export function retryPolicyFromManifest(manifest: JsonRecord): RetryPolicy | undefined {
	if (manifest.retryPolicy === undefined || manifest.retryPolicy === null) return undefined;
	try { return validateRetryPolicy(manifest.retryPolicy); }
	catch (error) { throw new Error(`--resume manifest has an invalid retryPolicy: ${message(error)}`); }
}

/**
 * Rebuild the exact Options a stopped grid ran with from its own manifest, so a
 * resume measures with the same inputs and pins without the operator retyping
 * (and mistyping) fourteen flags. Every field is verified against the recomputed
 * pins before any cell launches; a manifest that names a path that has moved is
 * caught there, not silently re-run against a different tree.
 */
export function optionsFromManifest(dir: string, manifest: JsonRecord): Options {
	const requested = (manifest.requested ?? {}) as JsonRecord;
	const inputs = (manifest.inputs ?? {}) as JsonRecord;
	const corpusManifest = (inputs.corpusManifest ?? {}) as JsonRecord;
	const baseline = (inputs.baseline ?? {}) as JsonRecord;
	const candidate = (inputs.candidate ?? {}) as JsonRecord;
	const pins = (manifest.pins ?? {}) as JsonRecord;
	const need = (value: unknown, what: string): string => {
		if (typeof value !== "string" || !value) throw new Error(`--resume manifest is missing ${what}`);
		return value;
	};
	const thinking = need(manifest.thinking ?? requested.thinking, "thinking");
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error(`--resume manifest has an invalid thinking level: ${thinking}`);
	const passes = Number(manifest.passes);
	const pilot = Array.isArray(requested.only) && requested.only.length > 0;
	if (!Number.isSafeInteger(passes) || passes < (pilot ? 1 : 3)) throw new Error("--resume manifest has an invalid pass count");
	const concurrency = Number(manifest.concurrency);
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("--resume manifest has an invalid concurrency");
	const timeoutMs = Number(manifest.timeoutMs);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--resume manifest has an invalid timeout");
	const selected = Array.isArray(requested.only) ? requested.only.map(String) : [];
	const authHorizonHours = typeof requested.authHorizonHours === "number" && requested.authHorizonHours > 0 ? requested.authHorizonHours : undefined;
	// A manifest without the field predates the option; its cells wrote no
	// maxAgents, and a resume must keep writing none. A present but malformed one
	// is refused rather than read as "absent", which would silently change the arm.
	if (manifest.candidateMaxAgents !== undefined && !isWorkerCap(manifest.candidateMaxAgents)) throw new Error("--resume manifest has an invalid candidateMaxAgents");
	const candidateMaxAgents = manifest.candidateMaxAgents as number | undefined;
	const arms = armOptionsFromManifest(manifest);
	const twins = twinOptionsFromManifest(manifest);
	if (manifest.gridKind !== undefined && (typeof manifest.gridKind !== "string" || !manifest.gridKind)) throw new Error("--resume manifest has an invalid gridKind");
	const gridKind = manifest.gridKind as string | undefined;
	// Absent: the grid ran fail-fast, and so does its resume. A present policy is
	// read strictly, for the same reason as the cap above.
	let breaker: BreakerPolicy | undefined;
	if (manifest.breaker !== undefined) {
		try { breaker = parseBreakerPolicy(manifest.breaker); } catch (error) { throw new Error(`--resume manifest has an invalid breaker: ${message(error)}`); }
	}
	const retryPolicy = retryPolicyFromManifest(manifest);
	// Absent: the grid ran no matched arm, and neither does its resume.
	let matched: MatchedPolicy | undefined;
	if (manifest.matched !== undefined) {
		try { matched = parseMatchedPolicy(manifest.matched); } catch (error) { throw new Error(`--resume manifest has an invalid matched policy: ${message(error)}`); }
	}
	return {
		baseline: need(baseline.path, "the baseline snapshot path"), candidate: need(candidate.path, "the candidate snapshot path"),
		corpus: need(inputs.corpus, "the corpus path"), truth: need(inputs.truth, "the truth path"), out: dir,
		provider: need(requested.provider, "the provider"), model: need(requested.model, "the model"),
		thinking: thinking as Options["thinking"], passes, concurrency, timeoutMs, selected,
		fsSeal: need(pins.landlockWrapper, "the Landlock wrapper path"),
		manifestPath: need(corpusManifest.path, "the corpus manifest path"), dryRun: false,
		...(authHorizonHours === undefined ? {} : { authHorizonHours }),
		...(candidateMaxAgents === undefined ? {} : { candidateMaxAgents }),
		...arms,
		...twins,
		...(gridKind === undefined ? {} : { gridKind }),
		...(breaker === undefined ? {} : { breaker }),
		...(retryPolicy === undefined ? {} : { retryPolicy }),
		...(matched === undefined ? {} : { matched }),
	};
}

/**
 * The per-arm options (plan item 2.8) a grid pinned, read strictly: a manifest
 * without a field predates it or left it at its default, and a present but
 * malformed one refuses the resume rather than silently changing an arm.
 */
/**
 * The patched twins a grid ran (plan item 2.8): its twin arms and the twins
 * file its preflight recorded. A manifest without `twinArms` ran none, and its
 * resume runs none; one with them but no recorded file cannot be resumed.
 */
export function twinOptionsFromManifest(manifest: JsonRecord): Pick<Options, "twinsPath" | "twinArms"> {
	if (manifest.twinArms === undefined) return {};
	const raw = manifest.twinArms;
	if (!Array.isArray(raw) || !raw.length || raw.some((arm) => arm !== "baseline" && arm !== "candidate") || new Set(raw).size !== raw.length) {
		throw new Error("--resume manifest has an invalid twinArms");
	}
	const inputs = (manifest.inputs ?? {}) as JsonRecord;
	const file = (inputs.twinsManifest ?? {}) as JsonRecord;
	if (typeof file.path !== "string" || !file.path) throw new Error("--resume manifest is missing the twins file path");
	return { twinsPath: file.path, twinArms: raw as PairArm[] };
}

export function armOptionsFromManifest(manifest: JsonRecord): Pick<Options, "baselineMaxAgents" | "maxVerifiers" | "budgetArms"> {
	const out: Pick<Options, "baselineMaxAgents" | "maxVerifiers" | "budgetArms"> = {};
	if (manifest.baselineMaxAgents !== undefined) {
		if (!isWorkerCap(manifest.baselineMaxAgents)) throw new Error("--resume manifest has an invalid baselineMaxAgents");
		out.baselineMaxAgents = manifest.baselineMaxAgents;
	}
	if (manifest.maxVerifiers !== undefined) {
		const raw = manifest.maxVerifiers;
		if (!isJsonRecord(raw) || !Object.keys(raw).length || Object.entries(raw).some(([arm, n]) => (arm !== "baseline" && arm !== "candidate") || !isWorkerCap(n))) {
			throw new Error("--resume manifest has an invalid maxVerifiers");
		}
		out.maxVerifiers = raw as Partial<Record<PairArm, number>>;
	}
	if (manifest.budgetArms !== undefined) {
		const raw = manifest.budgetArms;
		if (!Array.isArray(raw) || raw.some((arm) => !ARM_ORDER.includes(arm as Arm)) || new Set(raw).size !== raw.length) throw new Error("--resume manifest has an invalid budgetArms");
		out.budgetArms = raw as Arm[];
	}
	return out;
}

function sha256(data: string | Buffer): string { return createHash("sha256").update(data).digest("hex"); }

async function hashFile(path: string): Promise<string> { return sha256(await readFile(path)); }

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * A name for anything the sealed process can see — cell directory, engagement,
 * staged snapshot. Hex cannot spell "CVE" or "GHSA", and it carries no target,
 * pass or arm, so neither the paths in the system prompt nor `ps` output name
 * the advisory or say which arm is running.
 */
function opaqueToken(): string { return randomUUID().replaceAll("-", "").slice(0, 16); }

async function readProviderBaseUrl(provider: string): Promise<string | undefined> {
	const candidates = [join(HOME, ".pired/models.json"), join(AGENT_BASE, "models.json")];
	for (const path of candidates) {
		const doc = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as { providers?: Record<string, { baseUrl?: string; baseURL?: string }> | Array<{ id?: string; baseUrl?: string; baseURL?: string }> };
		const providers = Array.isArray(doc.providers)
			? doc.providers.map((p) => [p.id ?? "", p] as const)
			: Object.entries(doc.providers ?? {});
		const entry = providers.find(([id]) => id === provider)?.[1];
		const url = entry?.baseUrl ?? entry?.baseURL;
		if (url) return url;
	}
	if (provider === "openai-codex") return "https://chatgpt.com/backend-api/codex";
	return undefined;
}

async function providerMetadata(provider: string, model: string): Promise<Provider> {
	const raw = await readProviderBaseUrl(provider);
	if (!raw) throw new Error(`Could not derive the configured endpoint for provider "${provider}"; refusing an unsealed run.`);
	let url: URL;
	try { url = new URL(raw); } catch { throw new Error(`Provider "${provider}" has an invalid endpoint URL.`); }
	if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error(`Provider "${provider}" endpoint must be an HTTP(S) URL.`);
	const allowedHosts = ["localhost", "127.0.0.1", url.hostname.toLowerCase()];
	if (provider === "openai-codex") allowedHosts.push("auth.openai.com");
	return { provider, model, baseHost: url.hostname.toLowerCase(), allowedHosts: [...new Set(allowedHosts)] };
}

/**
 * What the shared auth store says about one provider's credential, with every
 * secret dropped: only an OAuth credential's expiry is ever read out of it.
 */
export type CredentialExpiry =
	| { kind: "oauth"; expiresAt: number }
	| { kind: "static" }
	| { kind: "missing" }
	| { kind: "unreadable"; why: string };

export function credentialExpiry(authText: string | undefined, provider: string): CredentialExpiry {
	if (authText === undefined) return { kind: "missing" };
	let doc: unknown;
	try { doc = JSON.parse(authText); } catch { return { kind: "unreadable", why: "auth.json is not JSON" }; }
	const entry = isJsonRecord(doc) ? doc[provider] : undefined;
	if (!isJsonRecord(entry)) return { kind: "missing" };
	if (entry.type !== "oauth") return { kind: "static" };
	return typeof entry.expires === "number" && Number.isFinite(entry.expires)
		? { kind: "oauth", expiresAt: entry.expires }
		: { kind: "unreadable", why: `the ${provider} OAuth credential has no numeric expiry` };
}

/**
 * pi refreshes an OAuth token once fewer than five minutes of it remain (pi-ai
 * auth/resolve.js DEFAULT_OAUTH_MINIMUM_VALIDITY_MS), plus half an hour for the
 * preflight and the gap before the first launch.
 */
export const AUTH_MARGIN_MS = 35 * 60 * 1000;
/**
 * The longest horizon the computed check asks for. A refreshed codex token lives
 * 240 h (measured from the access token's iat/exp on 2026-09-23), so seven days
 * can always be met by refreshing first; a longer worst case is stated in the
 * manifest as capped rather than made impossible to satisfy.
 */
export const AUTH_HORIZON_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Every pass, every wave of `concurrency` pairs, both arms of each pair, each to
 * its full timeout. With a breaker each pair may run maxAttempts times and wait
 * its cooldowns in between: a horizon sized for one attempt would let a grid
 * that re-queues outlive its OAuth token and refresh it inside a cell.
 *
 * `targets` is any number of gate targets (plan item 2.8). Patched twins are
 * pairs of their own in the same passes, with one or two arms and no matched
 * sessions, so a pass holds targets + twins pairs, each no longer than the
 * longest kind. Waves of `concurrency` pairs bound a pool of workers taking
 * pairs in order: each worker finishes a pair at least every longest-pair
 * time while any is queued. With no twins this is the earlier formula.
 */
export function gridWorstCaseMs(grid: { passes: number; targets: number; concurrency: number; timeoutMs: number; breaker?: Pick<BreakerPolicy, "maxAttempts" | "cooldownMs">; matchedSessions?: number; twins?: number; twinArms?: number }): number {
	// The matched arm's k sessions run in the pair's slot after its two arms, each
	// bounded by the same per-arm timeout (its token ceiling usually ends it first).
	const arms = 2 + (grid.matchedSessions ?? 0);
	const twins = grid.twins ?? 0;
	const pairMs = (n: number): number => {
		if (!grid.breaker) return n * grid.timeoutMs;
		const { maxAttempts, cooldownMs } = grid.breaker;
		return maxAttempts * n * grid.timeoutMs + cooldownMs * (maxAttempts * (maxAttempts - 1)) / 2;
	};
	const longest = twins > 0 ? Math.max(pairMs(arms), pairMs(grid.twinArms ?? 2)) : pairMs(arms);
	return grid.passes * Math.ceil((grid.targets + twins) / grid.concurrency) * longest;
}

/**
 * Whether the provider's OAuth token outlives the grid, so that nothing inside
 * a cell ever refreshes it.
 *
 * A refresh inside a cell is not under the lock every other process uses.
 * pi-subagents builds each worker's model runtime with ModelRuntime.create(),
 * whose auth store is <agentDir>/auth.json, the cell's symlink to the shared
 * file, and pi's AuthStorage locks `${authPath}.lock` with realpath false. So a
 * worker locks <cell>/agent/auth.json.lock while every parent, and the
 * operator's own pi sessions, lock ~/.pi/agent/auth.json.lock. Demonstrated with
 * pi 0.87.1's AuthStorage: a store on the shared file and one on a symlink to it
 * both entered the refresh at the same moment holding the same refresh token.
 * openai-codex rotates the refresh token on every refresh, so the second one
 * fails, the run is invalid, and at worst the token family is revoked and every
 * session is logged out mid-grid. The lock path cannot be pointed back without a
 * change to pi-subagents or pi, so the grid refuses to start unless the token
 * stays valid past its worst-case end, and the operator refreshes it first
 * under the shared lock.
 */
export function checkAuthHorizon(input: { provider: string; credential: CredentialExpiry; worstCaseMs: number; requestedHours?: number; nowMs: number; piCli: string }): { ok: boolean; record: JsonRecord; error?: string } {
	const { provider, credential } = input;
	if (credential.kind === "unreadable") return { ok: false, record: { provider, checked: false, credential: "unreadable" }, error: `cannot read the ${provider} credential's expiry: ${credential.why}` };
	if (credential.kind !== "oauth") {
		// Codex has no API-key login: a grid without its OAuth credential would fail at the first request.
		if (provider === "openai-codex") return { ok: false, record: { provider, checked: false, credential: credential.kind }, error: `no ${provider} OAuth credential in the shared auth store; log in with pi first` };
		return { ok: true, record: { provider, checked: false, credential: credential.kind, reason: "no expiring OAuth credential for this provider" } };
	}
	const capped = input.requestedHours === undefined && input.worstCaseMs > AUTH_HORIZON_CAP_MS;
	const horizonMs = input.requestedHours !== undefined ? input.requestedHours * 3_600_000 : Math.min(input.worstCaseMs, AUTH_HORIZON_CAP_MS);
	const requiredMs = horizonMs + AUTH_MARGIN_MS;
	const remainingMs = credential.expiresAt - input.nowMs;
	const hours = (ms: number): number => Math.round(ms / 36_000) / 100;
	const record: JsonRecord = {
		provider, checked: true, credential: "oauth", expiresAt: new Date(credential.expiresAt).toISOString(),
		remainingHours: hours(remainingMs), worstCaseHours: hours(input.worstCaseMs), requiredHours: hours(requiredMs),
		source: input.requestedHours !== undefined ? "--auth-horizon-hours" : capped ? "worst case, capped" : "worst case",
		ok: remainingMs >= requiredMs,
	};
	if (remainingMs >= requiredMs) return { ok: true, record };
	const minExpiry = Math.ceil(requiredMs / 3_600_000);
	return {
		ok: false, record,
		error: `the ${provider} OAuth token expires ${String(record.expiresAt)} (${hours(remainingMs)} h from now), inside this grid's ${hours(requiredMs)} h horizon. `
			+ "A refresh during the grid would run inside a cell under that cell's own lock and could spend the rotating refresh token twice. "
			+ `Refresh it first, outside any grid (it refreshes under the shared lock; the redirect keeps the token off the terminal): node ${input.piCli} auth print-bearer-token --provider ${provider} --min-expiry ${minExpiry}h > /dev/null`
			+ " — or pass --auth-horizon-hours for a shorter bound. Running pi once is not enough: pi refreshes only within five minutes of expiry.",
	};
}

interface RuntimePins {
	node: string;
	nodeExecutable: string;
	piPackageVersion: string;
	piRuntimeSha256: string;
	piRuntimeFiles: number;
	piNodeModules: string;
	harnessSha256: Record<string, string>;
	landlockWrapper: string;
	landlockWrapperSha256: string;
	graderSourceCommit: string;
	graderSourceGitBlob: string;
	graderSourceSha256: string;
	workspaceDecoderSha256: string;
	externalGraderScript: string;
	externalGraderSha256: string;
	python: string;
	/** The pinned pi-subagents install the candidate loads, measured at preflight (see ComparePins). */
	piSubagentsDir: string;
	piSubagentsVersion: string;
	piSubagentsSha256: string;
	piSubagentsFiles: number;
	/** The bounds the delegation audit holds workers to, by value (see HARNESS_FILES). */
	delegationAuditLimits: AuditLimits;
	/** Set after the probe stage: the model definition every probe resolved, which every scored run must match. */
	benchmarkRuntime?: BenchmarkRuntime;
}

type FrozenPins = RuntimePins & Record<`source:${string}`, string>;

/** What the preflight measured of the pinned pi-subagents install. */
type PiSubagentsInstall = { dir: string; entry: string; version: string; digest: string; files: number };

async function runtimePins(fsSeal: string, piSubagents: PiSubagentsInstall): Promise<RuntimePins> {
	const packageJson = JSON.parse(await readFile(join(PI_PACKAGE, "package.json"), "utf8")) as { version?: string };
	// The whole tree, not a list of package paths: npm nests pi-agent-core under
	// pi-coding-agent here, and a hand-written list pointing at the top level both
	// failed to resolve and would have missed the copy actually loaded.
	const runtime = await treeManifest(PI_NODE_MODULES, "runtime");
	const sealStat = await lstat(fsSeal).catch(() => undefined);
	if (!sealStat?.isFile()) throw new Error(`Landlock wrapper is not a regular file: ${fsSeal}`);
	// The research numbers were graded by the scorer at dde9bfa. A byte-level blob
	// comparison, not a version string, is what makes "same grader" checkable.
	const expectedScoreBlob = execFileSync("git", ["rev-parse", "dde9bfa:eval/dvbank/score.ts"], { cwd: ROOT, encoding: "utf8" }).trim();
	const actualScoreBlob = execFileSync("git", ["hash-object", SCORE_PATH], { cwd: ROOT, encoding: "utf8" }).trim();
	if (expectedScoreBlob !== actualScoreBlob) throw new Error("Current pired ledger scorer is not byte-identical to the research-pinned dde9bfa implementation.");
	const harnessSha256: Record<string, string> = {};
	for (const rel of HARNESS_FILES) harnessSha256[rel] = await hashFile(join(ROOT, rel));
	return {
		node: process.version, nodeExecutable: await realpath(process.execPath), piPackageVersion: packageJson.version ?? "unknown",
		piRuntimeSha256: runtime.digest, piRuntimeFiles: runtime.files, piNodeModules: PI_NODE_MODULES,
		harnessSha256, landlockWrapper: fsSeal, landlockWrapperSha256: await hashFile(fsSeal),
		graderSourceCommit: execFileSync("git", ["rev-parse", "dde9bfa"], { cwd: ROOT, encoding: "utf8" }).trim(),
		graderSourceGitBlob: actualScoreBlob,
		graderSourceSha256: await hashFile(SCORE_PATH), workspaceDecoderSha256: await hashFile(WORKSPACE_PATH),
		externalGraderScript: GRADER_SCRIPT, externalGraderSha256: await hashFile(GRADER_SCRIPT),
		python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
		piSubagentsDir: piSubagents.dir, piSubagentsVersion: piSubagents.version,
		piSubagentsSha256: piSubagents.digest, piSubagentsFiles: piSubagents.files,
		delegationAuditLimits: auditLimits(),
	};
}

/**
 * Measure the pinned pi-subagents install and say why it cannot be official.
 * The version is read from the package the entry will load, and the entry
 * must be the one its package.json declares to pi, so a hand-edited or
 * re-installed tree shows up as a different digest rather than as the same
 * candidate. Missing entirely is fatal: the candidate arm could not run.
 */
async function measurePiSubagents(pins: ComparePins): Promise<{ install: PiSubagentsInstall; reasons: string[] }> {
	const paths = piSubagentsPaths(pins);
	if (!await exists(paths.entry)) throw new Error(`pinned pi-subagents is not installed at ${paths.dir} (rebuild it: see --help, Pins)`);
	const pkg = JSON.parse(await readFile(join(paths.packageDir, "package.json"), "utf8")) as { name?: unknown; version?: unknown; pi?: { extensions?: unknown } };
	if (pkg.name !== "pi-subagents") throw new Error(`${paths.packageDir} is not the pi-subagents package`);
	const declared = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions.map(String) : [];
	if (!declared.includes("./index.js")) throw new Error(`pi-subagents at ${paths.packageDir} no longer declares ./index.js as its extension (declares ${declared.join(", ") || "none"})`);
	const tree = await treeManifest(paths.dir, "runtime");
	const version = String(pkg.version ?? "unknown");
	const reasons: string[] = [];
	if (version !== pins.piSubagents.version) reasons.push(`pi-subagents ${version} is not the pinned ${pins.piSubagents.version}`);
	if (tree.digest !== pins.piSubagents.digest) reasons.push(`pi-subagents tree ${tree.digest.slice(0, 12)} is not the pinned ${pins.piSubagents.digest.slice(0, 12)}`);
	return { install: { dir: paths.dir, entry: paths.entry, version, digest: tree.digest, files: tree.files }, reasons };
}

async function systemReadRoots(nodePath: string): Promise<string[]> {
	const roots = [
		"/usr", "/bin", "/lib", "/lib64", "/etc", "/dev", "/proc", dirname(nodePath),
		PI_NODE_MODULES,
	];
	// /etc/resolv.conf is a symlink into /run/systemd/resolve; Landlock checks the
	// resolved file, so without its realpath every provider lookup fails EAI_AGAIN.
	for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]) {
		try { roots.push(await realpath(path)); } catch { /* missing on a minimal OS */ }
	}
	return [...new Set(roots)];
}

type CellPaths = {
	cellId: string;
	cellDir: string;
	targetDir: string;
	workspaceDir: string;
	agentDir: string;
	tmpDir: string;
	/** pi-subagents' defaultSessionDir for this cell: every worker's session.jsonl, and the accounting's only source for worker spend. */
	childSessionDir: string;
	/** PI_SUBAGENTS_TEMP_ROOT: run status, fan-out budgets and supervisor channels, inside the cell's writable tmp. */
	subagentTempRoot: string;
	/** <agentDir>/settings.json, which a worker reads through SettingsManager.create(cwd, agentDir). */
	agentSettingsPath: string;
	/** <agentDir>/extensions/subagent/config.json, pi-subagents' own config. */
	subagentConfigPath: string;
	transcriptPath: string;
	stderrPath: string;
	configPath: string;
	scorePath: string;
};

function cellPaths(root: string): CellPaths {
	const cellId = opaqueToken();
	const cellDir = join(root, cellId);
	return {
		cellId, cellDir,
		targetDir: join(cellDir, "target"), workspaceDir: join(cellDir, "workspace"),
		agentDir: join(cellDir, "agent"), tmpDir: join(cellDir, "tmp"),
		childSessionDir: join(cellDir, "child-sessions"), subagentTempRoot: join(cellDir, "tmp", "psa"),
		agentSettingsPath: join(cellDir, "agent", "settings.json"),
		subagentConfigPath: join(cellDir, "agent", "extensions", "subagent", "config.json"),
		transcriptPath: join(cellDir, "transcript.jsonl"), stderrPath: join(cellDir, "stderr.txt"),
		configPath: join(cellDir, "entry-config.json"), scorePath: join(cellDir, "score.json"),
	};
}

async function pathRulesForCell(cell: CellPaths, stagedSnapshot: string, nodePath: string, piSubagentsDir?: string): Promise<string[]> {
	const args: string[] = [];
	for (const path of await systemReadRoots(nodePath)) if (await exists(path)) args.push("--read", path);
	// This cell's own staged snapshot, granted whole. It lives under cellDir, so no
	// shared per-arm staged tree is granted any more and another cell's <cellDir>/pired
	// is unreadable — the probe checks exactly that. node_modules inside it is a
	// symlink to the runtime, which systemReadRoots already grants.
	if (await exists(stagedSnapshot)) args.push("--read", stagedSnapshot);
	// The config file alone, not the cell directory: the cell also holds this
	// run's transcript and, once the process has exited, the host-side run.json
	// that maps the opaque cell back to its target, pass and arm.
	args.push("--read", ENTRY, "--read", BASH_TIMEOUT_EXTENSION, "--read", cell.configPath);
	// The candidate's pinned pi-subagents install, read-only and only in that arm:
	// the baseline never loads it. Its dependencies resolve inside it; its peers
	// (pi itself) resolve to the runtime systemReadRoots already grants.
	if (piSubagentsDir) {
		args.push("--read", piSubagentsDir);
		// pi-subagents identifies the host by reading every package.json above
		// process.argv[1] (pi-spawn.js findPiPackageRootFromEntry) before it tries
		// PI_PACKAGE_DIR, and an unreadable one aborts the search. Measured in the
		// first sealed dry run: EACCES on the repo's package.json, and "keeping
		// subagent eagerly available", i.e. the full schema on every request.
		for (const manifest of await manifestsAbove(ENTRY)) args.push("--read", manifest);
	}
	// childSessionDir is written by pi-subagents in-process, so the whole sealed
	// tree can write it, the model's bash included. The accounting therefore
	// never believes a child session the parent's own transcript does not name.
	for (const path of [cell.targetDir, cell.workspaceDir, cell.agentDir, cell.tmpDir, cell.childSessionDir, "/dev/null"]) args.push("--write", path);
	// Pi rewrites the shared auth file in place on an OAuth refresh; a private
	// copy would fork the refresh token and log every other session out.
	const authPath = join(AGENT_BASE, "auth.json");
	if (await exists(authPath)) args.push("--write", authPath);
	// The model catalog store is a per-cell copy in agentDir, so the original is
	// not granted. pired's provider mirror still reads its own models.json.
	for (const path of [join(AGENT_BASE, "models.json"), join(HOME, ".pired/models.json")]) {
		if (await exists(path)) args.push("--read", path);
	}
	// AuthStorage's cross-process lock is a directory created beside auth.json.
	// Grant only mkdir/rmdir there, never directory reads.
	args.push("--lock-dir", AGENT_BASE);
	return args;
}

/** Every package.json that exists in a directory above `file`, nearest first. */
async function manifestsAbove(file: string): Promise<string[]> {
	const found: string[] = [];
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if ((await lstat(manifest).catch(() => undefined))?.isFile()) found.push(manifest);
	}
	return found;
}

/**
 * A variable that hands the sealed process a path to an IPC broker. Landlock
 * ABI 4 does not mediate connect(2), so a sealed bash call that reaches
 * dockerd, the user D-Bus or `systemd --user` runs its work in a broker-spawned
 * process that never inherited the seal and can read the answer keys in full
 * (demonstrated: `systemd-run --user --pipe --wait cat <truth>` printed a key
 * that a direct read was denied). Dropping the addresses is the env half of
 * closing that hole; the seal preflight fails closed if a broker is reachable
 * anyway. A trailing _SOCK/_SOCKET catches the same shape for other daemons.
 */
export function isBrokerEnvVar(key: string): boolean {
	// Every DBUS_* name, not only the session address: the live pilot cell's
	// environ held DBUS_STARTER_ADDRESS=unix:path=/run/user/1000/bus (the same bus)
	// and DBUS_STARTER_BUS_TYPE after DBUS_SESSION_BUS_ADDRESS had been dropped.
	return key.startsWith("DBUS_") || key === "XDG_RUNTIME_DIR" || key === "DOCKER_HOST" ||
		key === "SSH_AUTH_SOCK" || /_SOCK(ET)?$/.test(key);
}

/** Session bookkeeping of the runner's own shell or unit, never needed by the sealed process. */
function isHostSessionVar(key: string): boolean {
	return key === "OLDPWD" || (SCOPE_ADDED_ENV as readonly string[]).includes(key);
}

/**
 * The sealed process's environment. Every ambient PIRED_* variable is dropped
 * rather than inherited: the snapshots read PIRED_SCRIBE, PIRED_PASSES,
 * PIRED_RAIL_WIDTH and PIRED_RAIL_HEIGHT, and a value left exported in the
 * operator's shell would change one grid from the next without appearing in any
 * manifest. PIRED_WORKSPACE is not passed either, so the workspace the probe
 * reports is one pired resolved from pired.scope.json, not one handed to it.
 * Broker socket addresses are dropped (see isBrokerEnvVar). HOME and provider
 * keys stay: auth refresh and the provider need them.
 */
function childEnv(cell: CellPaths, provider: Provider): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("PIRED_") || isHostSessionVar(key) || isBrokerEnvVar(key)) continue;
		env[key] = value;
	}
	const blackhole = "http://127.0.0.1:1";
	const noProxy = provider.allowedHosts.join(",");
	return {
		...env,
		HOME,
		PWD: cell.targetDir,
		PI_CODING_AGENT_DIR: cell.agentDir,
		TMPDIR: cell.tmpDir,
		// The opaque per-cell marker every bash descendant inherits. Carries no
		// target/pass/arm, so it neither labels the run nor helps `ps`; it is only
		// how this cell's strays are found and reaped after it closes.
		[CELL_MARKER]: cell.cellId,
		// Unattended runs have no operator to answer the scribe; both arms get it off.
		PIRED_SCRIBE: "off",
		// No network model-catalog refresh. A pi-subagents child builds its model
		// runtime with pi's defaults, whose later refreshes go to the network unless
		// PI_OFFLINE is set; through the proxy blackhole they failed ECONNREFUSED
		// three times in the v3 smoke cell, and the parent never takes that path.
		// Both arms read the pinned per-cell catalog instead.
		PI_OFFLINE: "1",
		// pi-subagents' lazy tool loader must find the host pi package to verify the
		// running host; in an SDK process argv[1] is this entry, not pi's CLI, so
		// without it the loader has no host and falls back to eager registration.
		PI_PACKAGE_DIR: PI_PACKAGE,
		// Its run status, budgets and channels, inside this cell's writable tmp
		// rather than a shared os.tmpdir() tree another cell could read.
		PI_SUBAGENTS_TEMP_ROOT: cell.subagentTempRoot,
		// jiti would otherwise try to cache transpiled extensions beside the
		// read-only snapshot or runtime; off, nothing is written outside the cell.
		JITI_FS_CACHE: "false",
		// Egress steering, not an OS network sandbox: anything that ignores proxy
		// variables can still reach the network.
		HTTP_PROXY: blackhole, HTTPS_PROXY: blackhole, ALL_PROXY: blackhole,
		http_proxy: blackhole, https_proxy: blackhole, all_proxy: blackhole,
		NO_PROXY: noProxy, no_proxy: noProxy,
	};
}

/**
 * A stripped copy of the operator's environment for the sealed preflight probes:
 * the broker addresses gone (so the escape-vector probe reflects what a scored
 * cell inherits) and every PIRED_* dropped, but no proxy blackhole, because the
 * network probe must reach the provider to prove DNS and TLS work under the seal.
 */
function preflightProbeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("PIRED_") || isHostSessionVar(key) || isBrokerEnvVar(key)) continue;
		env[key] = value;
	}
	env.HOME = HOME;
	return env;
}

/** A sealed command as the host launches it: inside its own transient systemd user scope. */
export type ScopedCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv; unit: string };

/**
 * Wrap `fs-seal <sealArgs>` so it runs in a fresh transient systemd user scope.
 *
 * systemd-run --scope creates the scope over the user bus, moves itself into it
 * and execs the command in place, so the spawned pid is still the command's and
 * runOwned's process-group signalling is unchanged. systemd-run is handed the
 * scrubbed sealed environment plus only the two variables it needs to reach the
 * user manager, and `env -u` removes those (and the INVOCATION_ID systemd-run
 * adds) before fs-seal runs: measured, a --scope command otherwise inherits
 * systemd-run's whole environment. The unit name is opaque because the sealed
 * process can read it from /proc/self/cgroup.
 */
export function scopedSealCommand(fsSeal: string, sealArgs: string[], sealedEnv: NodeJS.ProcessEnv, hostEnv: NodeJS.ProcessEnv = process.env, unit = `pired-cell-${opaqueToken()}`): ScopedCommand {
	const env: NodeJS.ProcessEnv = { ...sealedEnv };
	for (const key of SCOPE_HOST_ENV) {
		const value = hostEnv[key];
		if (value !== undefined) env[key] = value;
	}
	const unset = [...SCOPE_HOST_ENV, ...SCOPE_ADDED_ENV].flatMap((key) => ["-u", key]);
	return {
		command: SYSTEMD_RUN,
		args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--", ENV_BIN, ...unset, fsSeal, ...sealArgs],
		env, unit,
	};
}

/** Run systemctl --user; resolves with its exit code and stderr rather than throwing. */
function systemctlUser(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolvePromise) => {
		execFile(SYSTEMCTL, ["--user", ...args], { timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
			resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

async function readCgroupFile(cgroup: string, name: string): Promise<string | undefined> {
	try { return await readFile(join("/sys/fs/cgroup", cgroup, name), "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Kill everything left in a cell's scope and prove the cgroup is empty.
 *
 * A scope stays loaded while any process is left in it, so strays keep it alive
 * after the cell's own process exits; one with nothing left has already been
 * collected ("not loaded" is then the expected answer, not a failure). The pids
 * listed before the kill are returned for the run record. Any pid still in the
 * cgroup after the stop is an error, because it would survive into the pair's
 * next arm.
 */
export async function closeScope(unit: string, waitMs = 3000): Promise<{ pids: number[]; errors: string[] }> {
	const scope = `${unit}.scope`;
	const errors: string[] = [];
	const shown = await systemctlUser(["show", "--property=ControlGroup", "--value", scope]);
	if (shown.code !== 0) return { pids: [], errors: [`could not query scope ${scope}: ${shown.stderr.trim() || `exit ${shown.code}`}`] };
	const cgroup = shown.stdout.trim();
	let pids: number[] = [];
	if (cgroup) {
		try { pids = ((await readCgroupFile(cgroup, "cgroup.procs")) ?? "").split("\n").filter((l) => /^\d+$/.test(l.trim())).map(Number); }
		catch (error) { errors.push(`could not list scope ${scope}: ${message(error)}`); }
	}
	const notLoaded = (r: { stderr: string }): boolean => /not loaded|not found/i.test(r.stderr);
	const killed = await systemctlUser(["kill", "--signal=SIGKILL", scope]);
	if (killed.code !== 0 && !notLoaded(killed)) errors.push(`systemctl kill ${scope} failed: ${killed.stderr.trim() || `exit ${killed.code}`}`);
	const stopped = await systemctlUser(["stop", scope]);
	if (stopped.code !== 0 && !notLoaded(stopped)) errors.push(`systemctl stop ${scope} failed: ${stopped.stderr.trim() || `exit ${stopped.code}`}`);
	if (cgroup) {
		const deadline = Date.now() + waitMs;
		for (;;) {
			let events: string | undefined;
			try { events = await readCgroupFile(cgroup, "cgroup.events"); }
			catch (error) { errors.push(`could not read scope ${scope} state: ${message(error)}`); break; }
			if (events === undefined || /^populated 0$/m.test(events)) break;
			if (Date.now() > deadline) {
				const left = ((await readCgroupFile(cgroup, "cgroup.procs").catch(() => undefined)) ?? "").trim().split("\n").filter(Boolean);
				errors.push(`scope ${scope} still holds pids after SIGKILL and stop: ${left.join(", ") || "unknown"}`);
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	return { pids, errors };
}

async function firstReadableFile(dir: string, preferred: string[]): Promise<string | undefined> {
	for (const rel of preferred) {
		const path = join(dir, rel);
		if ((await lstat(path).catch(() => undefined))?.isFile()) return path;
	}
	const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	const file = entries.find((e) => e.isFile());
	return file ? join(dir, file.name) : undefined;
}

async function checkSeal(options: Options, target: Target, index: number, nodePath: string, outDir: string): Promise<JsonRecord> {
	const pristine = `${target.target}.pristine`;
	const siblingTruth = join(options.corpus, `${target.name}.truth.json`);
	const researchTruth = target.truth;
	for (const path of [siblingTruth, researchTruth]) if (!await exists(path)) throw new Error(`Required truth file absent for denial test: ${path}`);
	const allowedFile = await firstReadableFile(pristine, ["README.md"]);
	if (!allowedFile) throw new Error(`Cannot run filesystem-seal preflight: ${pristine} has no top-level file to read.`);
	const markerDir = join(outDir, "preflight", `seal-${index + 1}`);
	await mkdir(markerDir, { recursive: true });
	const script = [
		`const fs = require("node:fs");`,
		`const allowed = ${JSON.stringify(allowedFile)}; const denied = ${JSON.stringify([siblingTruth, researchTruth])}; const marker = ${JSON.stringify(join(markerDir, "writable.marker"))};`,
		`fs.readFileSync(allowed);`,
		`for (const p of denied) { let blocked = false; try { fs.readFileSync(p); } catch { blocked = true; } if (!blocked) { console.error("answer-key path was readable"); process.exit(21); } }`,
		`fs.writeFileSync(marker, "ok");`,
	].join(" ");
	const roots = await systemReadRoots(nodePath);
	const args = ["--read", pristine, ...roots.flatMap((p) => ["--read", p]), "--write", markerDir, "--write", "/dev/null", "--", nodePath, "-e", script];
	const res = await runSealedScoped(options.fsSeal, args, { cwd: pristine, env: preflightProbeEnv(), timeoutMs: 15_000, stdoutPath: join(markerDir, "stdout.txt"), stderrPath: join(markerDir, "stderr.txt") });
	const closed = await closeScope(res.unit);
	if (res.exitCode !== 0 || res.timedOut || !await exists(join(markerDir, "writable.marker"))) {
		throw new Error(`Landlock answer-key denial preflight failed for ${target.id} (exit=${res.exitCode}, timeout=${res.timedOut}). Details: ${join(markerDir, "stderr.txt")}`);
	}
	if (closed.errors.length) throw new Error(`answer-key denial probe scope did not close cleanly: ${closed.errors.join("; ")}`);
	return { target: target.id, ok: true, testedAllowedRead: basename(allowedFile), deniedPaths: [siblingTruth, researchTruth] };
}

/** runOwned for a sealed command, inside its own systemd user scope; the caller closes the scope. */
async function runSealedScoped(fsSeal: string, sealArgs: string[], config: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdoutPath: string; stderrPath: string; onLine?: LineSink }): Promise<OwnedResult & { unit: string }> {
	const scoped = scopedSealCommand(fsSeal, sealArgs, config.env);
	const result = await runOwned(scoped.command, scoped.args, { ...config, env: scoped.env, scopeUnit: scoped.unit });
	return { ...result, unit: scoped.unit };
}

/** Run one node -e script under the seal with the preflight probe environment; returns its outcome once its scope is closed. */
async function runSealedProbe(options: Options, nodePath: string, markerDir: string, script: string, env: NodeJS.ProcessEnv): Promise<OwnedResult & { unit: string; scopeErrors: string[] }> {
	await mkdir(markerDir, { recursive: true });
	const roots = await systemReadRoots(nodePath);
	const args = [...roots.flatMap((p) => ["--read", p]), "--write", markerDir, "--write", "/dev/null", "--", nodePath, "-e", script];
	const res = await runSealedScoped(options.fsSeal, args, { cwd: markerDir, env, timeoutMs: 60_000, stdoutPath: join(markerDir, "stdout.txt"), stderrPath: join(markerDir, "stderr.txt") });
	const closed = await closeScope(res.unit);
	return { ...res, scopeErrors: closed.errors };
}

/** /proc/<pid>/stat field 22, the start time in clock ticks since boot; undefined once the pid is gone. */
export function startTimeFromStat(statText: string): string | undefined {
	// Field 2 (comm) is parenthesised and may itself hold spaces or ")", so the
	// fields are counted from the LAST ")": field 3 is the first after it.
	const close = statText.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = statText.slice(close + 1).trim().split(/\s+/);
	const value = fields[22 - 3];
	return value && /^\d+$/.test(value) ? value : undefined;
}

async function processStartTime(pid: number): Promise<string | undefined> {
	try { return startTimeFromStat(await readFile(`/proc/${pid}/stat`, "utf8")); }
	catch { return undefined; }
}

/** Whether pid is gone, a zombie, or no longer in the named scope: any of these means the stray is dead or out. */
async function strayGoneFromScope(pid: number, unit: string): Promise<boolean> {
	try {
		const statText = await readFile(`/proc/${pid}/stat`, "utf8");
		const state = statText.slice(statText.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
		if (state === "Z" || state === "X") return true;
		return !(await readFile(`/proc/${pid}/cgroup`, "utf8")).includes(`/${unit}.scope`);
	} catch { return true; }
}

/**
 * Prove, on this host, the reaping a scored cell relies on: fail closed if
 * systemd user scopes are unavailable, if the sealed process sees a D-Bus or
 * runtime-dir address, or if a model-style stray survives its scope's close.
 * Under the seal and in a scope, a helper starts `sleep` detached into its own
 * session with ${CELL_MARKER} deleted from its environment (what `unset
 * BENCH_CELL; setsid sleep 300 &` does), reports its pid and exits. The stray
 * must still be in the scope after the helper exits, and gone after closeScope.
 */
async function checkScopeReaping(options: Options, nodePath: string, outDir: string): Promise<JsonRecord> {
	const markerDir = join(outDir, "preflight", "scope");
	const script = [
		`const { spawn } = require("node:child_process"); const fs = require("node:fs");`,
		`const leaked = Object.keys(process.env).filter((k) => k.startsWith("DBUS_") || ${JSON.stringify([...SCOPE_HOST_ENV, ...SCOPE_ADDED_ENV])}.includes(k));`,
		`const env = { ...process.env }; delete env[${JSON.stringify(CELL_MARKER)}];`,
		`const stray = spawn("sleep", ["300"], { detached: true, stdio: "ignore", env }); stray.unref();`,
		`console.log(JSON.stringify({ type: "scope_probe", stray: stray.pid, cgroup: fs.readFileSync("/proc/self/cgroup", "utf8").trim(), leaked }));`,
	].join(" ");
	await mkdir(markerDir, { recursive: true });
	const roots = await systemReadRoots(nodePath);
	const args = [...roots.flatMap((p) => ["--read", p]), "--write", markerDir, "--write", "/dev/null", "--", nodePath, "-e", script];
	const env = { ...preflightProbeEnv(), [CELL_MARKER]: `scope-probe-${opaqueToken()}` };
	const res = await runSealedScoped(options.fsSeal, args, { cwd: markerDir, env, timeoutMs: 60_000, stdoutPath: join(markerDir, "stdout.txt"), stderrPath: join(markerDir, "stderr.txt") });
	const report = parseJsonObject((await readFile(join(markerDir, "stdout.txt"), "utf8").catch(() => "")).trim()) ?? {};
	const stray = typeof report.stray === "number" ? report.stray : undefined;
	const problems: string[] = [];
	if (res.exitCode !== 0 || res.timedOut) problems.push(`the scoped probe exited ${res.exitCode} (timeout=${res.timedOut}); systemd user scopes may be unavailable (see ${join(markerDir, "stderr.txt")})`);
	if (!String(report.cgroup ?? "").includes(`/${res.unit}.scope`)) problems.push(`the sealed process ran outside its scope (cgroup ${String(report.cgroup ?? "unreported")})`);
	if (Array.isArray(report.leaked) && report.leaked.length) problems.push(`the sealed process saw ${report.leaked.join(", ")}`);
	if (stray === undefined) problems.push("the probe reported no stray pid");
	else if (await strayGoneFromScope(stray, res.unit)) problems.push("the detached stray was not held in the scope after its parent exited");
	const closed = await closeScope(res.unit);
	problems.push(...closed.errors);
	if (stray !== undefined) {
		const deadline = Date.now() + 3000;
		while (!(await strayGoneFromScope(stray, res.unit)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (!(await strayGoneFromScope(stray, res.unit))) problems.push(`stray pid ${stray} survived its scope's close`);
	}
	if (problems.length) throw new Error(`systemd scope reaping check failed: ${problems.join("; ")}. Refusing to run: a stray could outlive its cell and serve the pair's next arm.`);
	return { ok: true, unit: res.unit, strayKilled: stray ?? null, reapedByScope: closed.pids, note: "a setsid stray with the marker unset was held by the scope and killed at close" };
}

/**
 * Prove the seal cannot be escaped through an IPC broker. Under the seal, with
 * the same broker-address-stripped environment a scored cell inherits, a helper
 * tries to connect to the docker socket and the user D-Bus and to run
 * `systemd --user`. Each must fail: if any succeeds, a sealed bash call could
 * launch its work in a broker-spawned process that never inherited the seal and
 * read the answer keys, so the grid refuses to run (fail closed). Reproduced:
 * on a machine where the socket connects are blocked (Landlock ABI 4 here does
 * mediate the connect) and the bus address is dropped, all three fail.
 */
async function checkEscapeVectors(options: Options, nodePath: string, outDir: string): Promise<JsonRecord> {
	const markerDir = join(outDir, "preflight", "escape");
	const script = [
		`const net = require("node:net"); const { execFileSync } = require("node:child_process");`,
		`const uid = process.getuid ? process.getuid() : 0;`,
		`const sockets = ["/var/run/docker.sock", "/run/docker.sock", "/run/user/" + uid + "/bus"];`,
		// The environment half, checked where it lands: a D-Bus or runtime-dir
		// address handed through the scope launcher would name the bus to a client.
		`const addresses = Object.keys(process.env).filter((k) => k.startsWith("DBUS_") || k === "XDG_RUNTIME_DIR");`,
		`const connect = (p) => new Promise((res) => { const s = net.connect(p); let done = false;`,
		`  const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };`,
		`  s.on("connect", () => finish(true)); s.on("error", () => finish(false)); setTimeout(() => finish(false), 3000); });`,
		`(async () => { const reached = []; for (const p of sockets) if (await connect(p)) reached.push(p);`,
		`  let systemdRun = false; try { execFileSync("systemd-run", ["--user", "--pipe", "--wait", "true"], { stdio: "ignore", timeout: 15000 }); systemdRun = true; } catch {}`,
		// io_uring opens and connects an AF_UNIX socket inside a kernel worker, which
		// the seccomp socket() rule never sees; io_uring_setup (425 on x86_64 and
		// aarch64) must fail. python3 exits 0 only if the ring was created.
		`  let ioUring = false; try { execFileSync("python3", ["-c", "import ctypes,sys; libc=ctypes.CDLL(None, use_errno=True); p=ctypes.create_string_buffer(120); sys.exit(0 if libc.syscall(425, 1, p) >= 0 else 3)"], { stdio: "ignore", timeout: 15000 }); ioUring = true; } catch {}`,
		`  if (reached.length || systemdRun || ioUring || addresses.length) { console.error("escape vectors reachable: sockets=" + reached.join(",") + " systemd-run=" + systemdRun + " io_uring=" + ioUring + " env=" + addresses.join(",")); process.exit(31); }`,
		`  console.log(JSON.stringify({ type: "escape_probe", dockerSocket: false, userBus: false, systemdRun: false, brokerEnv: [] })); })();`,
	].join(" ");
	const res = await runSealedProbe(options, nodePath, markerDir, script, preflightProbeEnv());
	if (res.exitCode !== 0 || res.timedOut) {
		throw new Error(`Seal escape-vector check failed (exit=${res.exitCode}, timeout=${res.timedOut}): a sealed process could reach a broker or saw a broker address, or the check could not run. Details: ${join(markerDir, "stderr.txt")}. Refusing to run; run each cell in a PID/user/mount/IPC namespace or on a host with no reachable broker.`);
	}
	if (res.scopeErrors.length) throw new Error(`Seal escape-vector probe scope did not close cleanly: ${res.scopeErrors.join("; ")}`);
	return { ok: true, checked: ["docker.sock", "user-bus", "systemd-run --user", "io_uring_setup", "DBUS_*/XDG_RUNTIME_DIR in the sealed env"], stderr: join(markerDir, "stderr.txt") };
}

/**
 * Prove DNS and TLS to the provider work under the seal, so a scored run's
 * "zero findings" cannot secretly be a resolver the seal never granted. Under
 * the seal, with proxies not blackholed, a helper resolves the provider host and
 * makes one unauthenticated GET — any HTTP status counts, so no token is spent.
 * A DNS or TLS failure fails the grid closed rather than surfacing later as a
 * cheap empty run.
 */
async function checkNetwork(options: Options, provider: Provider, nodePath: string, outDir: string): Promise<JsonRecord> {
	const markerDir = join(outDir, "preflight", "network");
	const origin = `https://${provider.baseHost}`;
	// The overseas provider host can drop a single GET (measured: one ETIMEDOUT
	// against api.z.ai, then 200 on retry), so the fetch is retried a few times
	// with a per-attempt deadline. Only DNS failing outright or every attempt
	// failing fails the grid, keeping the check fail-closed without flaking.
	const script = [
		`const dns = require("node:dns/promises");`,
		`const origin = ${JSON.stringify(origin)}; const host = new URL(origin).hostname;`,
		`const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
		`(async () => {`,
		`  let address; try { address = (await dns.lookup(host)).address; } catch (e) { console.error("dns " + (e && e.code)); process.exit(41); }`,
		`  let lastError;`,
		`  for (let attempt = 1; attempt <= 3; attempt++) {`,
		`    try { const r = await fetch(origin, { method: "GET", signal: AbortSignal.timeout(15000) }); console.log(JSON.stringify({ type: "net_probe", host, address, status: r.status, attempt })); return; }`,
		`    catch (e) { const c = e && e.cause; lastError = (c && c.code) || (e && e.code) || (e && e.name) || String(e); await sleep(2000); } }`,
		`  console.error("fetch " + lastError); process.exit(42); })();`,
	].join(" ");
	const res = await runSealedProbe(options, nodePath, markerDir, script, { ...preflightProbeEnv() });
	if (res.exitCode !== 0 || res.timedOut) {
		throw new Error(`Provider network check failed (exit=${res.exitCode}, timeout=${res.timedOut}): DNS or TLS to ${origin} did not work under the seal. Details: ${join(markerDir, "stderr.txt")}.`);
	}
	if (res.scopeErrors.length) throw new Error(`Provider network probe scope did not close cleanly: ${res.scopeErrors.join("; ")}`);
	const report = parseJsonObject(await readFile(join(markerDir, "stdout.txt"), "utf8").catch(() => "")) ?? {};
	return { ok: true, origin, status: typeof report.status === "number" ? report.status : null, note: "unauthenticated GET; any status proves reachability and spends no tokens" };
}

export async function loadTargets(options: Pick<Options, "manifestPath" | "truth" | "corpus" | "selected" | "twinsPath">): Promise<{ manifestHash: string; twinsHash?: string; targets: Target[]; truthHashes: Record<string, string>; sourceHashes: Record<string, string> }> {
	const raw = await readFile(options.manifestPath, "utf8");
	const manifest = JSON.parse(raw.replaceAll("PLACEHOLDER", dirname(options.truth))) as Target[];
	// Any number of targets (plan item 2.8): the fresh v6 corpus has twelve. What
	// makes a grid official is its pinned corpus, not a count. Ids key every cell,
	// pin and pair, so two entries under one id would silently merge.
	const seen = new Set<string>();
	for (const target of manifest) {
		if (typeof target.id !== "string" || !target.id) throw new Error("Research manifest has a target without an id.");
		if (seen.has(target.id)) throw new Error(`Research manifest lists target id ${target.id} more than once.`);
		seen.add(target.id);
	}
	// The patched twins follow the gate targets, so the first target (the one the
	// delegation and ceiling probes use) is always a gate target.
	let twinsHash: string | undefined;
	let twins: Target[] = [];
	if (options.twinsPath !== undefined) {
		const twinsText = await readFile(options.twinsPath, "utf8");
		twinsHash = sha256(twinsText);
		try {
			twins = twinTargets(JSON.parse(twinsText.replaceAll("PLACEHOLDER", dirname(options.truth))), manifest) as unknown as Target[];
		} catch (error) {
			throw new Error(`--twins ${options.twinsPath}: ${message(error)}`);
		}
	}
	const all = [...manifest, ...twins];
	const wanted = options.selected;
	const selected = wanted.length ? all.filter((t) => wanted.includes(t.id)) : all;
	if (selected.length !== (wanted.length || all.length)) {
		const found = new Set(selected.map((t) => t.id));
		throw new Error(`Unknown --only target ID(s): ${wanted.filter((id) => !found.has(id)).join(", ")}`);
	}
	if (!selected.some((t) => t.twinOf === undefined)) throw new Error(twins.length && wanted.length ? "--only names only patched twins; a grid needs a target for its gate." : "Research manifest resolves no target.");
	const truthHashes: Record<string, string> = {};
	const sourceHashes: Record<string, string> = {};
	for (const target of selected) {
		target.target = join(options.corpus, target.name);
		target.truth = join(options.truth, `${target.name}.truth.json`);
		const pristine = `${target.target}.pristine`;
		if (!await exists(pristine)) throw new Error(`Missing pristine input for ${target.id}: ${pristine}`);
		if (!await exists(target.truth)) throw new Error(`Missing answer key for ${target.id}: ${target.truth}`);
		truthHashes[target.id] = await hashFile(target.truth);
		sourceHashes[target.id] = (await treeManifest(pristine)).digest;
		// A patched twin has no labels: a claim on it can only be a re-flag of the
		// fixed code, which eval/rescore.ts counts against its fixed regions.
		if (target.twinOf !== undefined) {
			let truth: unknown;
			try { truth = JSON.parse(await readFile(target.truth, "utf8")); } catch { truth = undefined; }
			if (!Array.isArray(truth) || truth.length) throw new Error(`Patched twin ${target.id}'s answer key must be an empty list: ${target.truth}`);
		}
	}
	return { manifestHash: sha256(raw), ...(twinsHash === undefined ? {} : { twinsHash }), targets: selected, truthHashes, sourceHashes };
}

function promptFor(target: Target): string { return REVIEW_PROMPT + scopeClause(target.scope); }

/**
 * A target as the grid's manifest.json lists it. A patched twin's entry also
 * carries what eval/rescore.ts's control score reads from it: its target, its
 * fixed regions and its size (plan item 2.8). A gate target's entry is the one
 * every earlier grid wrote.
 */
export function manifestTargetEntry(t: Target): JsonRecord {
	return {
		id: t.id, name: t.name, package: t.package, scope: t.scope ?? null,
		...(t.twinOf === undefined ? {} : { twinOf: t.twinOf, fixed_regions: t.fixed_regions, scope_loc: t.scope_loc ?? null }),
	};
}

/**
 * The strings redacted from every staged snapshot before the model reads it.
 *
 * pired's own source discusses the corpus it was measured on — advisory IDs,
 * the projects, and exact truth locations such as `http/share.go:84` (all in
 * comments). The staged snapshot is granted --read and its path is in the system
 * prompt, so a model that opens pired's source would learn a target's identity
 * and answer key. Both arms are redacted with the identical term set, so the two
 * differ only in the change under test: advisory IDs and aliases of every target,
 * each project's owner/repo/name parts, and every distinct truth-file path.
 */
async function redactTermsFor(targets: Target[], truthDir: string): Promise<string[]> {
	const terms = new Set<string>();
	for (const target of targets) {
		for (const term of leakTermsFor(target)) terms.add(term);
		for (const part of String(target.package ?? "").split("/")) if (part.trim()) terms.add(part.trim().toLowerCase());
		if (typeof target.name === "string" && target.name.trim()) terms.add(target.name.trim().toLowerCase());
		const truthText = await readFile(join(truthDir, `${target.name}.truth.json`), "utf8");
		const truth = JSON.parse(truthText) as Array<{ file?: unknown }>;
		for (const entry of truth) if (typeof entry.file === "string" && entry.file.trim()) terms.add(entry.file.trim());
	}
	return [...terms].sort();
}

/**
 * The staged-path content of git `commit`, keyed by path, as sha256 of the blob
 * bytes (not the git blob id), so it compares against a treeManifest snapshot
 * row directly. `git show` reconstructs a symlink as its target text, which is
 * exactly what a snapshot symlink row hashes, so both kinds compare uniformly.
 */
function baselineCommitRows(commit: string): Map<string, string> {
	const listing = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", commit], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
	const rows = new Map<string, string>();
	for (const path of listing.split("\0")) {
		if (!path || !shouldIncludeSnapshotPath(path)) continue;
		const content = execFileSync("git", ["show", `${commit}:${path}`], { cwd: ROOT, maxBuffer: 1 << 28 });
		rows.set(path, sha256(content));
	}
	return rows;
}

/**
 * Why the baseline snapshot is not git 496b190's staged content, or "" when it
 * is. The handoff forbids mixing candidates; this catches a --baseline that was
 * edited or points at the working tree. git can rebuild the commit's blobs, so
 * the baseline needs no pinned digest of its own, unlike the candidate.
 */
function baselineMismatchReason(rows: Array<{ path: string; sha256: string; kind: string }>, commit: string): string {
	let git: Map<string, string>;
	try { git = baselineCommitRows(commit); }
	catch (error) { return `baseline could not be checked against git ${commit.slice(0, 7)} (${message(error)})`; }
	const snap = new Map(rows.map((r) => [r.path, r.sha256]));
	const missing = [...git.keys()].filter((p) => !snap.has(p));
	const extra = [...snap.keys()].filter((p) => !git.has(p));
	const changed = [...git].filter(([p, h]) => snap.has(p) && snap.get(p) !== h).map(([p]) => p);
	if (missing.length || extra.length || changed.length) {
		const parts = [
			...(missing.length ? [`missing ${missing.length} (${missing.slice(0, 3).join(", ")})`] : []),
			...(extra.length ? [`extra ${extra.length} (${extra.slice(0, 3).join(", ")})`] : []),
			...(changed.length ? [`changed ${changed.length} (${changed.slice(0, 3).join(", ")})`] : []),
		];
		return `baseline snapshot differs from git ${commit.slice(0, 7)}: ${parts.join("; ")}`;
	}
	return "";
}

/** Written through a rename, so concurrent pair-workers never leave a half-written progress file. */
async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${opaqueToken()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmp, path);
}

let outputQueue: Promise<unknown> = Promise.resolve();
/** Serialize root-level output writes from concurrent pair-workers. */
function serially<T>(fn: () => Promise<T>): Promise<T> {
	const next = outputQueue.then(fn, fn);
	outputQueue = next.catch(() => undefined);
	return next;
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
	await serially(() => appendFile(path, `${JSON.stringify(value)}\n`));
}

type LineSink = (line: string, atMs: number) => void;
type OwnedResult = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	/** The transcript hit MAX_TRANSCRIPT_BYTES and the process was stopped. */
	oversized: boolean;
	stdoutBytes: number;
	stderrBytes: number;
	startedAt: number;
	finishedAt: number;
};

/** Process groups this runner spawned, each with its own stop. A signal reaps only these: never pkill by name. */
const activeGroups = new Map<number, (hard: boolean) => void>();
/**
 * `aborted` is a signal (stop launching, terminate our groups). `stopInvalid`
 * stops new pairs while in-flight pairs finish. Without a breaker it is
 * fail-fast, set by any invalid run, because one invalid arm already prevents
 * approval and launching the rest would spend hours of tokens for a decision
 * already fixed. With one, the breaker sets it (runPairs), since an
 * infrastructure failure is re-queued in the same runner instead.
 */
const runState = {
	aborted: false, signals: 0, stopInvalid: false, stopReason: undefined as string | undefined,
	/** When the first stop signal arrived: an arm running at that moment was stopped by this runner, not by its own failure. */
	abortedAtMs: undefined as number | undefined,
	/** A provider quota or usage window is spent: nothing launched before it resets can succeed. */
	quotaExhausted: undefined as string | undefined,
	/** The stop came from a matched session (plan item 2.5); it does not by itself withhold the gate's approval. */
	stoppedBy: undefined as "matched" | "twin" | undefined,
};

async function runOwned(command: string, args: string[], config: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stdoutPath: string; stderrPath: string; onLine?: LineSink; scopeUnit?: string }): Promise<OwnedResult> {
	await mkdir(dirname(config.stdoutPath), { recursive: true });
	const stdout = createWriteStream(config.stdoutPath, { flags: "w" });
	const stderr = createWriteStream(config.stderrPath, { flags: "w" });
	return await new Promise<OwnedResult>((resolvePromise, rejectPromise) => {
		const startedAt = Date.now();
		const child = spawn(command, args, { cwd: config.cwd, env: config.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timedOut = false;
		let oversized = false;
		let finished = false;
		const decoder = new StringDecoder("utf8");
		let partial = "";
		// Only while the group still holds our pipes: after close its ID may be reused by an unrelated process.
		const kill = (signal: NodeJS.Signals): void => {
			if (!child.pid || finished) return;
			try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
			// A hard stop also empties the cell's scope: a setsid stray is outside the
			// group, and one still holding a pipe would keep "close" from ever firing.
			if (signal === "SIGKILL" && config.scopeUnit) void systemctlUser(["kill", "--signal=SIGKILL", `${config.scopeUnit}.scope`]);
		};
		const stop = (hard: boolean): void => {
			if (hard) { kill("SIGKILL"); return; }
			kill("SIGTERM");
			setTimeout(() => kill("SIGKILL"), 5_000).unref();
		};
		if (child.pid) activeGroups.set(child.pid, stop);
		const feed = (text: string, atMs: number): void => {
			if (!config.onLine) return;
			partial += text;
			let newline: number;
			while ((newline = partial.indexOf("\n")) >= 0) {
				const line = partial.slice(0, newline).replace(/\r$/, "");
				partial = partial.slice(newline + 1);
				try { config.onLine(line, atMs); } catch { /* an observer bug must not stop the transcript */ }
			}
		};
		const timeout = setTimeout(() => { timedOut = true; stop(false); }, config.timeoutMs);
		const settle = async (code: number | null, signal: NodeJS.Signals | null, error?: Error): Promise<void> => {
			if (finished) return;
			finished = true;
			const finishedAt = Date.now();
			clearTimeout(timeout);
			if (child.pid) activeGroups.delete(child.pid);
			if (config.onLine && !oversized) {
				const rest = (partial + decoder.end()).replace(/\r$/, "");
				partial = "";
				if (rest) { try { config.onLine(rest, finishedAt); } catch { /* see feed */ } }
			}
			stdout.end(); stderr.end();
			await Promise.all([
				new Promise<void>((r) => stdout.once("finish", () => r())),
				new Promise<void>((r) => stderr.once("finish", () => r())),
			]);
			if (error) rejectPromise(error);
			else resolvePromise({ exitCode: code, signal, timedOut, oversized, stdoutBytes, stderrBytes, startedAt, finishedAt });
		};
		child.once("error", (error) => { void settle(null, null, error); });
		child.once("close", (code, signal) => { void settle(code, signal); });
		child.stdout.on("data", (chunk: Buffer) => {
			const atMs = Date.now();
			stdoutBytes += chunk.length;
			if (oversized) return;
			if (stdoutBytes > MAX_TRANSCRIPT_BYTES) { oversized = true; stop(false); return; }
			stdout.write(chunk);
			feed(decoder.write(chunk), atMs);
		});
		child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderr.write(chunk); });
		// Headless pi reads stdin before startup; close it so session initialization runs.
		child.stdin.end();
	});
}

/**
 * What the live stream showed, with wall-clock arrival times rather than
 * parse-after-exit times. `subagentCalls` counts every call of the tool,
 * launches and read-only actions alike; which of them launched workers is the
 * reconciliation's job, from the transcript and the child sessions.
 */
export type StreamObservation = {
	lines: number;
	malformedJsonLines: number;
	subagentCalls: number;
	enableCalls: number;
	recordCalls: number;
	recordWrites: number;
	subagentUpdates: number;
	recordWritesBeforeFirstSubagent: number;
	firstRecordAt?: number;
	firstSubagentAt?: number;
};

function parseJsonObject(line: string): JsonRecord | undefined {
	try {
		const value = JSON.parse(line) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
	} catch { return undefined; }
}

export function trackStream(): { stream: StreamObservation; onLine: LineSink } {
	const stream: StreamObservation = {
		lines: 0, malformedJsonLines: 0, subagentCalls: 0, enableCalls: 0, recordCalls: 0, recordWrites: 0, subagentUpdates: 0,
		recordWritesBeforeFirstSubagent: 0,
	};
	const pending = new Map<string, string>();
	const onLine = (line: string, atMs: number): void => {
		if (!line.trim()) return;
		stream.lines++;
		const event = parseJsonObject(line);
		if (!event) { stream.malformedJsonLines++; return; }
		if (event.type === "tool_execution_start") {
			const id = String(event.toolCallId ?? event.id ?? "");
			const name = String(event.toolName ?? "");
			if (id) pending.set(id, name);
			if (name === SUBAGENT_TOOL) {
				stream.subagentCalls++;
				stream.firstSubagentAt ??= atMs;
			} else if (name === ENABLE_TOOL) stream.enableCalls++;
			else if (name === RECORD_TOOL) stream.recordCalls++;
		}
		if (event.type === "tool_execution_update" && pending.get(String(event.toolCallId ?? "")) === SUBAGENT_TOOL) stream.subagentUpdates++;
		if (event.type === "tool_execution_end") {
			const id = String(event.toolCallId ?? event.id ?? "");
			if (pending.get(id) === RECORD_TOOL && event.isError !== true) {
				stream.recordWrites++;
				stream.firstRecordAt ??= atMs;
				if (stream.firstSubagentAt === undefined) stream.recordWritesBeforeFirstSubagent++;
			}
			pending.delete(id);
		}
	};
	return { stream, onLine };
}

/** The full event list for accounting, parsed from the transcript file after exit. */
export async function readTranscriptEvents(path: string): Promise<{ events: JsonRecord[]; malformed: number }> {
	const events: JsonRecord[] = [];
	let malformed = 0;
	let buffer = "";
	const take = (line: string): void => {
		if (!line.trim()) return;
		const event = parseJsonObject(line);
		if (event) events.push(event);
		else malformed++;
	};
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			take(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	}
	take(buffer);
	return { events, malformed };
}

async function parseScoreReport(path: string): Promise<JsonRecord | undefined> {
	try { return parseJsonObject(await readFile(path, "utf8")); } catch { return undefined; }
}

type GraderResult =
	| { ok: true; truePositives: number; totalFindings: number; submitted: number; precision: number; reportedPrecision: number; summary: JsonRecord }
	| { ok: false; error: string; submitted: number };

/**
 * Grade through the pinned scorer and believe only the report file it leaves.
 * scoreFindings answers zeros when python or the grader fails, which is
 * indistinguishable from an honest empty ledger — so a stale report from an
 * earlier attempt is deleted first, and a missing or malformed one is a failure.
 */
export async function gradeWithPinnedScorer(findings: Finding[], scorePath: string, truthPath: string): Promise<GraderResult> {
	const submitted = findings.length;
	await rm(scorePath, { force: true });
	await rm(`${scorePath}.findings.json`, { force: true });
	await scoreFindings(findings, scorePath, truthPath);
	const report = await parseScoreReport(scorePath);
	const summary = report?.summary as JsonRecord | undefined;
	if (!summary || typeof summary !== "object") return { ok: false, submitted, error: "pinned scorer did not produce a readable report" };
	const tp = summary.true_positives;
	const total = summary.total_findings;
	const reported = summary.precision;
	if (typeof tp !== "number" || typeof total !== "number" || typeof reported !== "number" ||
		!Number.isSafeInteger(tp) || !Number.isSafeInteger(total) || tp < 0 || total < 0 || tp > total) {
		return { ok: false, submitted, error: "pinned scorer report lacks numeric true_positives/total_findings/precision" };
	}
	if (!Number.isFinite(reported) || reported < 0 || reported > 1) return { ok: false, submitted, error: "scorer returned invalid precision" };
	// The grader rounds precision to four places; the comparison checks precision
	// against TP/claims to 1e-6, so the metric is recomputed from the counts and
	// the rounded figure is only checked for agreement.
	const precision = total === 0 ? 0 : tp / total;
	if (Math.abs(precision - reported) > 5e-5 + 1e-9) return { ok: false, submitted, error: `scorer precision ${reported} disagrees with ${tp}/${total}` };
	return { ok: true, truePositives: tp, totalFindings: total, submitted, precision, reportedPrecision: reported, summary };
}

/** The exact ledger-to-grade path a scored run takes; the dry run drives it on an empty workspace. */
async function scoreWorkspace(workspaceDir: string, scorePath: string, truthPath: string): Promise<{ findings: Finding[]; graded: GraderResult }> {
	const findings = dedupe(await fromLedger(workspaceDir));
	return { findings, graded: await gradeWithPinnedScorer(findings, scorePath, truthPath) };
}

type Context = {
	options: Options;
	out: string;
	provider: Provider;
	pins: FrozenPins;
	/** The arm's input snapshot (options.baseline/candidate): staged fresh per cell. */
	sourceSnapshots: Record<Arm, string>;
	/** The arm's pinned input digest (treeManifest(source, snapshot) before redaction). */
	sourceDigests: Record<Arm, string>;
	/** The arm's expected staged (redacted) digest, computed once at preflight. */
	stagedDigests: Record<Arm, string>;
	/** Redaction terms applied to every staged snapshot, identical for both arms. */
	redactTerms: string[];
	nodePath: string;
	/** The pinned pi-subagents install the candidate arm loads, as measured at preflight. */
	piSubagents: PiSubagentsInstall;
};

type PreparedCell = CellPaths & {
	key: string;
	target: Target;
	pass: number;
	arm: Arm;
	engagement: string;
	/** This cell's own fresh redacted snapshot copy, under cellDir. */
	stagedSnapshot: string;
	/** External symlinks the target copy rewrote or removed, for the run record. */
	symlinkActions: Array<{ path: string; target: string; action: string; replacement?: string }>;
	argv: string[];
	env: NodeJS.ProcessEnv;
	/** Any entry means the cell must not be launched. */
	errors: string[];
	leakHits: string[];
	probe?: ProbeConfig;
	/** sha256 of the settings and pi-subagents config written for this cell; both must be unchanged after it runs. */
	cellConfigSha256: { settings: string; subagentConfig: string };
	/** A matched session's token ceiling and identity; absent for every other cell. */
	tokenCeiling?: number;
	matchedSession?: MatchedSessionSpec;
};

/** Which matched session a cell is, and the budget it runs under (plan item 2.5). */
export type MatchedSessionSpec = {
	index: number;
	/** The sessions B is first split over, and the most the pair may run. */
	k: number;
	kMax: number;
	/** The session's own attempt; `attempt` on the record stays the pair's. */
	sessionAttempt: number;
	/** B, the arm's total for the pair. */
	budget: number;
	/** This session's ceiling: its share of what was left of B, or all of it for a session past k. */
	ceiling: number;
	/** The valid sessions' tokens before this one, when its ceiling was set. */
	spentBefore: number;
	budgetSource: "candidate" | "fixed";
	/** The candidate run whose tokens set the budget under mode follow. */
	candidateCellId: string | null;
};

/**
 * The pi-subagents config every cell gets. Checked against 0.71.0's
 * src/extension/config.js: asyncByDefault defaults to true (resolveAsyncByDefault
 * is `config.asyncByDefault !== false`), so without it a launch that omits
 * `async` would run in the background, outside the foreground turn the parent's
 * transcript records. defaultSessionDir pins where every worker's session lands,
 * which is what the accounting reads. artifactDir "temp" keeps run artifacts
 * under PI_SUBAGENTS_TEMP_ROOT, inside the cell, instead of beside a session
 * file this in-memory parent does not have. An invalid config is not fatal in
 * pi-subagents (loadConfig logs and falls back to {}), which is why the
 * delegation probe runs against this exact file.
 */
export function subagentConfigFor(childSessionDir: string): Record<string, unknown> {
	return { defaultSessionDir: childSessionDir, asyncByDefault: false, artifactDir: "temp" };
}

/**
 * The candidate's worker cap when --candidate-max-agents is not given: 8, the
 * default the v3/v4 candidate snapshots shipped with, so a re-run of one of
 * them delegates exactly as it did when its grids ran.
 */
export const DEFAULT_CANDIDATE_MAX_AGENTS = 8;

function isWorkerCap(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Why a grid's candidate cap keeps it exploratory, or undefined when it is the
 * pinned one. Without this, --candidate-max-agents 3 on the official five
 * targets would produce an acceptance decision for a candidate nobody froze:
 * the snapshot digest was pinned, the cap it runs under was not.
 */
export function workerCapReason(pinned: number | null, requested: number | undefined): string | undefined {
	if (pinned === null) return "no candidate worker cap is pinned: eval/delegation-compare.pins.json has candidateMaxAgents null";
	if (requested !== pinned) return `candidate worker cap ${requested === undefined ? "unstated" : String(requested)} is not the pinned ${pinned}`;
	return undefined;
}

/**
 * The scope a cell runs under: whole-application, unenforced, exactly the research setup.
 * The candidate's scope states its worker cap. Since ADR-029 pired's default is
 * 0, so a candidate cut from main under a scope naming no cap would run with
 * delegation silently off and the grid would compare the baseline with itself.
 * The baseline's scope is left as it was: it names no cap, and whatever its
 * snapshot defaults to is what it measures. An undefined cap (a manifest that
 * predates the option) writes no field, as those grids' cells did.
 *
 * The candidate's scope states the ceilings the harness enforces (3.2), as
 * `budget`: `minutes` is the run's time limit, whole minutes, rounded down, and
 * `deadline` the absolute time it runs out — computed before launch, so it is
 * never later than the kill. `tokens` is written only when a token ceiling is
 * enforced, and none is yet: a ceiling the harness does not enforce is never
 * stated. The baseline's scope carries no budget and stays byte-identical to
 * earlier grids'.
 */
export function reviewScope(engagement: string, workspace: string, arm: Arm, candidateMaxAgents: number | undefined, timeoutMs?: number, nowMs: number = Date.now()): Record<string, unknown> {
	// The pre-2.8 call, kept so its tests hold the default arm settings to the
	// bytes they always wrote: the matched arm is the candidate with delegation
	// switched off, and the budget line belongs to the candidate snapshot's arms.
	return scopeFor(engagement, workspace, scopeSettingsFor(arm, candidateMaxAgents === undefined ? {} : { candidateMaxAgents }), timeoutMs, nowMs);
}

/** The twins a grid schedules: none unless --twin-arms names an arm. */
function twinSchedule(options: Pick<Options, "twinArms">, twinIds: string[]): ScheduledTwins | undefined {
	return options.twinArms?.length && twinIds.length ? { ids: twinIds, arms: options.twinArms } : undefined;
}

/** The grid's pinned schedule: its gate pairs, then in each pass its twins in their arms. */
function gridSchedule(pre: Pick<Preflight, "targets">, options: Pick<Options, "passes" | "twinArms">): ScheduledPair[] {
	const gate = pre.targets.filter((t) => t.twinOf === undefined).map((t) => t.id);
	const twins = pre.targets.filter((t) => t.twinOf !== undefined).map((t) => t.id);
	return planSchedule(gate, options.passes, twinSchedule(options, twins));
}

/** The scope settings an arm runs under in this grid (plan item 2.8). */
function armSettings(options: Options, arm: Arm): ScopeSettings {
	return scopeSettingsFor(arm, options);
}

/** The arms that load the pinned pi-subagents tree: the candidate, and the matched arm that runs it with its cap at 0. */
const loadsSubagents = (arm: Arm): boolean => arm !== "baseline";

/**
 * The delegation probe's scope. The review scope enforces nothing, so a worker
 * gate that never armed would pass it silently; this one is enforced and lists
 * only loopback, so the probe's out-of-scope command must be refused by pired's
 * own gate inside the worker. Used by that probe cell alone.
 *
 * It states a worker cap (plan item 2.8). It named none, which the v3/v4
 * snapshots read as their default of 8; a v5 candidate cut after ADR-029 reads
 * it as 0, refuses both of the probe's launches and hides the launcher, so a
 * v6 dry run would fail here (read from core/subagents.ts's workerCap and
 * hiddenParentTools; not run, since 2.8 ran no probe). The probe proves the pinned pi-subagents
 * path, not the arm's own cap, so it states the v3/v4 default whatever the
 * grid's candidate cap: stage 1's candidate, at 0, still loads pi-subagents.
 */
export function probeDelegationScope(engagement: string, workspace: string): Record<string, unknown> {
	return { engagement, workspace, mode: "enforce", authorized: true, targets: { ips: ["127.0.0.1"] }, maxAgents: DEFAULT_CANDIDATE_MAX_AGENTS };
}

/** Re-checked before every launch: a grid must not straddle an edit to what it measures. */
async function verifyFrozen(ctx: Context, arm: Arm): Promise<string[]> {
	const errors: string[] = [];
	if (await hashFile(ENTRY) !== ctx.pins.harnessSha256["eval/delegation-compare-entry.ts"]) errors.push("entry script changed after preflight");
	if (await hashFile(ctx.options.fsSeal) !== ctx.pins.landlockWrapperSha256) errors.push("Landlock wrapper changed after preflight");
	// The input snapshot, not a shared staged copy: each cell stages its own, so
	// what must not move mid-grid is the source the staging reads from.
	if ((await treeManifest(ctx.sourceSnapshots[arm], "snapshot")).digest !== ctx.sourceDigests[arm]) errors.push(`${arm} input snapshot changed after preflight`);
	// The candidate also loads the pinned pi-subagents tree; it is half of what the arm measures.
	if (loadsSubagents(arm) && (await treeManifest(ctx.piSubagents.dir, "runtime")).digest !== ctx.piSubagents.digest) errors.push("pinned pi-subagents tree changed after preflight");
	return errors;
}

async function prepareCell(ctx: Context, target: Target, pass: number, arm: Arm, root: string, probeFor?: (cell: CellPaths) => Promise<ProbeConfig>, session?: MatchedSessionSpec): Promise<PreparedCell> {
	const { options } = ctx;
	const paths = cellPaths(root);
	const errors: string[] = [];
	for (const dir of [paths.targetDir, paths.workspaceDir, paths.agentDir, paths.tmpDir, paths.childSessionDir, paths.subagentTempRoot, dirname(paths.subagentConfigPath)]) await mkdir(dir, { recursive: true });
	// A fresh redacted snapshot copy inside this cell, so the path token in the
	// system prompt is random per cell rather than one constant per arm. A
	// per-arm constant appears ~46 times in every parent prompt and, since two
	// hex strings usually tokenize to different lengths, biased one arm's token
	// count on every request; per-cell randomness makes it noise that cancels.
	const stagedSnapshot = join(paths.cellDir, "pired");
	let staged: Awaited<ReturnType<typeof stageSnapshot>> | undefined;
	try {
		staged = await stageSnapshot(ctx.sourceSnapshots[arm], stagedSnapshot, { redactTerms: ctx.redactTerms, nodeModules: PI_NODE_MODULES });
		if (staged.sourceDigest !== ctx.sourceDigests[arm]) errors.push(`${arm} snapshot input digest changed after preflight`);
		if (staged.stagedDigest !== ctx.stagedDigests[arm]) errors.push(`${arm} staged (redacted) snapshot digest changed after preflight`);
	} catch (error) {
		errors.push(`staging the ${arm} snapshot failed: ${message(error)}`);
	}
	const pristine = `${target.target}.pristine`;
	if ((await treeManifest(pristine)).digest !== ctx.pins[`source:${target.id}`]) errors.push("pristine corpus input changed after preflight");
	// copyTargetTree, not cp: a pristine link whose text escapes the copy (note-mark
	// ships site/static/icon.svg -> /home/…/corpus/clones/enchant97_note-mark/…) is
	// unreadable through the seal but readlink still returns the absolute path,
	// naming the upstream repo and the eval clone. It is rewritten in-tree or removed.
	const targetCopy = await copyTargetTree(pristine, paths.targetDir);
	await stripLeakage(paths.targetDir, { id: String(target.id), aliases: Array.isArray(target.aliases) ? target.aliases.map(String) : [] });
	await rm(join(paths.targetDir, "pired.scope.json"), { force: true });
	const engagement = `review-${opaqueToken()}`;
	let probe: ProbeConfig | undefined;
	if (probeFor) probe = await probeFor(paths);
	const scope = probe?.mode === "delegation" ? probeDelegationScope(engagement, paths.workspaceDir) : scopeFor(engagement, paths.workspaceDir, armSettings(options, arm), options.timeoutMs);
	const scopeText = `${JSON.stringify(scope, null, 2)}\n`;
	await writeFile(join(paths.targetDir, "pired.scope.json"), scopeText);
	const prompt = probe?.mode === "delegation" ? "Map the attack surface of this codebase. Delegate the first area to a worker." : promptFor(target);
	const modelsStoreSource = join(AGENT_BASE, "models-store.json");
	const modelsStorePath = join(paths.agentDir, "models-store.json");
	if (await exists(modelsStoreSource)) await cp(modelsStoreSource, modelsStorePath);
	else await writeFile(modelsStorePath, "{}\n");
	// What a worker reads from disk. pi-subagents builds each worker's model
	// runtime with ModelRuntime.create() and SettingsManager.create(cwd, agentDir)
	// from PI_CODING_AGENT_DIR — the cell's agentDir — so the parent's in-memory
	// settings never reach it: the same object is written here, and the shared
	// auth and model catalog are linked (a copy of auth.json would fork the OAuth
	// refresh token). Both arms get the same files; only the candidate loads the
	// extension that reads them. A worker that refreshed the token through this
	// link would lock <agentDir>/auth.json.lock, not the shared lock, so the
	// preflight's auth stage refuses a grid whose token could expire before it
	// ends (checkAuthHorizon) and no refresh is due while cells run.
	const settingsText = `${JSON.stringify(benchmarkSettings(options.retryPolicy), null, 2)}\n`;
	const subagentConfigText = `${JSON.stringify(subagentConfigFor(paths.childSessionDir), null, 2)}\n`;
	await writeFile(paths.agentSettingsPath, settingsText);
	await writeFile(paths.subagentConfigPath, subagentConfigText);
	for (const name of ["auth.json", "models.json"]) {
		const source = join(AGENT_BASE, name);
		if (await exists(source)) await symlink(source, join(paths.agentDir, name));
	}
	const config: EntryConfig = {
		snapshot: stagedSnapshot, provider: options.provider, model: options.model,
		thinking: options.thinking as CompareEntryConfig["thinking"],
		cwd: paths.targetDir, agentDir: paths.agentDir, authPath: join(AGENT_BASE, "auth.json"),
		modelsPath: join(AGENT_BASE, "models.json"), modelsStorePath, prompt,
		extensionPaths: [BASH_TIMEOUT_EXTENSION, ...(loadsSubagents(arm) ? [ctx.piSubagents.entry] : [])],
		...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
		...(session ? { tokenCeiling: session.ceiling } : {}),
		...(probe ? { probe } : {}),
	};
	const configText = `${JSON.stringify(config, null, 2)}\n`;
	await writeFile(paths.configPath, configText);
	const sealArgs = await pathRulesForCell(paths, stagedSnapshot, ctx.nodePath, loadsSubagents(arm) ? ctx.piSubagents.dir : undefined);
	const argv = [...sealArgs, "--", ctx.nodePath, "--experimental-strip-types", ENTRY, paths.configPath];
	const env = childEnv(paths, ctx.provider);
	// Everything the sealed process is handed, checked before launch: a hit here
	// would put the advisory ID in the system prompt, a path, or `env` output.
	const haystacks: Record<string, string> = {
		cellDir: paths.cellDir, cwd: paths.targetDir, workspace: paths.workspaceDir, agentDir: paths.agentDir,
		tmpDir: paths.tmpDir, childSessionDir: paths.childSessionDir, settings: settingsText, "subagent-config": subagentConfigText,
		configPath: paths.configPath, engagement, "entry-config": configText,
		"scope-file": scopeText, prompt, snapshot: stagedSnapshot, command: options.fsSeal,
	};
	argv.forEach((arg, i) => { haystacks[`argv[${i}]`] = arg; });
	for (const [key, value] of Object.entries(env)) haystacks[`env ${key}`] = `${key}=${value ?? ""}`;
	const leakHits = findLeaks(haystacks, leakTermsFor(target));
	if (leakHits.length) errors.push(`advisory label would reach the sealed process: ${leakHits.join("; ")}`);
	errors.push(...await verifyFrozen(ctx, arm));
	return {
		...paths, key: `${target.id}#${pass}`, target, pass, arm, engagement, stagedSnapshot,
		symlinkActions: targetCopy.symlinks, argv, env, errors, leakHits,
		cellConfigSha256: { settings: sha256(settingsText), subagentConfig: sha256(subagentConfigText) },
		...(probe ? { probe } : {}),
		...(session ? { tokenCeiling: session.ceiling, matchedSession: session } : {}),
	};
}

type Launch = { result?: OwnedResult; launchError?: string; stream: StreamObservation; scopeUnit?: string };

async function launch(ctx: Context, cell: PreparedCell, timeoutMs: number, mayLaunch: () => boolean = () => true): Promise<Launch> {
	const tracker = trackStream();
	if (cell.errors.length) return { launchError: "not launched: cell preparation failed", stream: tracker.stream };
	if (!mayLaunch()) return { launchError: "not launched: interrupted", stream: tracker.stream };
	const scoped = scopedSealCommand(ctx.options.fsSeal, cell.argv, cell.env);
	try {
		const result = await runOwned(scoped.command, scoped.args, {
			cwd: cell.targetDir, env: scoped.env, timeoutMs, stdoutPath: cell.transcriptPath, stderrPath: cell.stderrPath, onLine: tracker.onLine,
			scopeUnit: scoped.unit,
		});
		return { result, stream: tracker.stream, scopeUnit: scoped.unit };
	} catch (error) {
		return { launchError: `sealed process launch failed: ${message(error)}`, stream: tracker.stream, scopeUnit: scoped.unit };
	}
}

/**
 * Why the entry's benchmark_runtime line is not the run this grid asked for, or
 * undefined when it is. `thinking` there is the session's effective level after
 * pi clamped the request to the model's supported levels; a catalog without the
 * requested level used to run every arm and worker at the clamped level while
 * the line repeated the request, and the first sign was every candidate run
 * failing its workers' thinking check.
 */
export function runtimeMismatch(event: JsonRecord | undefined, options: Pick<Options, "provider" | "model" | "thinking">): string | undefined {
	if (!event) return "no runtime line";
	if (event.provider !== options.provider || event.model !== options.model) return `ran ${String(event.provider)}/${String(event.model)}, not ${options.provider}/${options.model}`;
	if (event.thinking !== options.thinking) {
		const supported = Array.isArray(event.supportedThinking) ? ` (the model supports ${event.supportedThinking.map(String).join(", ")})` : "";
		return `the session's effective thinking level is ${String(event.thinking)}, not the requested ${options.thinking}${supported}`;
	}
	return undefined;
}

/** The fields of the entry's benchmark_runtime line that fix what a run measured, in one fixed order. */
export type BenchmarkRuntime = { provider: unknown; model: unknown; api: unknown; endpoint: unknown; contextWindow: unknown; maxTokens: unknown; thinking: unknown };

/**
 * The resolved model definition a cell ran with. models.json is read live by
 * every cell, and the operator keeps several variants of it beside the live one
 * (models.json.bak-glm53, .bak-luna); a contextWindow or maxTokens that moved
 * between cells would change the compaction trigger and output cap, and with
 * them the token totals, while provider/model/thinking still matched.
 */
export function benchmarkRuntimeOf(event: JsonRecord): BenchmarkRuntime {
	return {
		provider: event.provider ?? null, model: event.model ?? null, api: event.api ?? null, endpoint: event.endpoint ?? null,
		contextWindow: event.contextWindow ?? null, maxTokens: event.maxTokens ?? null, thinking: event.thinking ?? null,
	};
}

async function readOptional(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

type ChildAccount = { child: SubagentChild; session?: ChildSessionExtraction; verdict?: ChildVerdict };

type CellUsage = {
	errors: string[];
	notes: string[];
	parent?: PiUsageExtraction;
	reconciliation?: SubagentReconciliation;
	children: ChildAccount[];
	/** Provider failure text of children that failed on a provider call, checked against the parent's copy; the only child text classifyInfra reads. */
	childProviderErrors: Array<{ childKey: string; text: string }>;
	/** Every file under the cell's childSessionDir, relative to it. */
	childSessionFiles: string[];
	usage: UsageAccounting;
	/** Under a retry policy only: the run's failed attempts, parent and workers, against the policy's cap. */
	retry?: RetrySummary;
	/** Under a retry policy only: observations that reported spend, for the request-log cross-check. */
	meteredCalls?: number;
};

const isJsonRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every regular file (and any other non-directory entry) under `dir`, relative to it, sorted; [] when it does not exist. */
async function filesUnder(dir: string): Promise<string[]> {
	const out: string[] = [];
	const visit = async (at: string): Promise<void> => {
		let entries;
		try { entries = await readdir(at, { withFileTypes: true }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) await visit(path);
			else out.push(relative(dir, path).split("\\").join("/"));
		}
	};
	await visit(dir);
	return out.sort();
}

/**
 * The provider text of a child that failed on a provider call, or a reason it
 * is not used.
 *
 * A child's failed reply is in its session.jsonl as an `error` reply with pi's
 * errorMessage, which observationsFromChildSession reports as `assistant reply
 * <id> failed: <errorMessage>`. A child that failed for any other reason (an
 * empty final answer, a tripwire at agent_start) has no such reply and is not
 * read: its text is the harness's, not the provider's. The session directory
 * is writable from inside the seal, so the text counts only when the parent's
 * own transcript (which the model cannot write) carries it too — in
 * pi-subagents' row for the child or in the text the parent received.
 */
export function childProviderFailure(child: Pick<SubagentChild, "childKey" | "status" | "error">, providerErrors: string[], parentText: string): { text?: string; note?: string } {
	if (child.status === "completed") return {};
	const marker = " failed: ";
	const texts = providerErrors.map((e) => { const at = e.indexOf(marker); return at < 0 ? "" : e.slice(at + marker.length).trim(); }).filter(Boolean);
	if (!texts.length) return providerErrors.length ? { note: `child ${child.childKey}: ended ${child.status} after an aborted reply, which is not a provider failure text` } : {};
	const text = texts[texts.length - 1]!;
	if (!`${child.error ?? ""}\n${parentText}`.includes(text.slice(0, 200))) return { note: `child ${child.childKey}: its session's provider failure is not in the parent's ${SUBAGENT_TOOL} result, so it is not read as one` };
	return { text };
}

/**
 * Every provider token the arm spent — parent, workers, compaction — or a
 * reason the run cannot be counted. A run whose spend cannot be fully
 * attributed is invalid, never a smaller number.
 *
 * Workers are pi-subagents children. Their spend is read from their own
 * session files under the cell's pinned childSessionDir, one per child, and
 * matched to the parent's `subagent` calls by run ID and index; the parent's
 * tool result carries pi-subagents' own sum of the same replies, which the
 * parent extraction leaves out so nothing is booked twice. In the baseline the
 * extension is not loaded, so any subagent call or child session means the
 * wrong snapshot ran and its tokens would land in the wrong arm.
 */
export async function accountCellUsage(events: JsonRecord[], cell: { arm: Arm; childSessionDir: string }, expect: { provider: string; model: string; thinking: string }, stream: Pick<StreamObservation, "subagentCalls">, retryPolicy?: RetryPolicy, ceiling: { cut?: boolean } = {}): Promise<CellUsage> {
	const errors: string[] = [];
	const notes: string[] = [];
	const observations: UsageObservation[] = [];
	// Without a policy the extractors get no retry option at all, so a v5 cell is
	// read exactly as before: any retry is a failure whose spend is unknown.
	const retry = retryPolicy ? { retry: true } : {};
	const retried: RetriedAttempt[] = [];
	let parent: PiUsageExtraction | undefined;
	try {
		// A session the token ceiling cut (plan item 2.5) ends on the empty reply of
		// the request it never sent; without a ceiling the option is never passed.
		parent = observationsFromPiEvents(events, { delegationTools: [SUBAGENT_TOOL], ...retry, ...(ceiling.cut ? { ceilingStop: true } : {}) });
		retried.push(...parent.retries ?? []);
		observations.push(...parent.observations);
		errors.push(...parent.errors, ...parent.providerErrors);
		notes.push(...parent.notes);
		if (!parent.finalStop && !ceiling.cut) errors.push("parent did not finish with an assistant stopReason=stop");
	} catch (error) {
		errors.push(`parent usage extraction failed: ${message(error)}`);
	}
	let childSessionFiles: string[] = [];
	try { childSessionFiles = await filesUnder(cell.childSessionDir); }
	catch (error) { errors.push(`could not list child sessions: ${message(error)}`); }
	const children: ChildAccount[] = [];
	const childProviderErrors: CellUsage["childProviderErrors"] = [];
	let reconciliation: SubagentReconciliation | undefined;
	if (cell.arm === "baseline") {
		if (childSessionFiles.length) errors.push(`baseline arm produced ${childSessionFiles.length} child session file(s)`);
		if (stream.subagentCalls) errors.push(`baseline arm made ${stream.subagentCalls} ${SUBAGENT_TOOL} call(s)`);
	} else {
		try {
			reconciliation = reconcileSubagentCalls(events, childSessionFiles, { sessionDir: cell.childSessionDir, toolName: SUBAGENT_TOOL });
			errors.push(...reconciliation.errors);
			notes.push(...reconciliation.notes);
		} catch (error) {
			errors.push(`subagent reconciliation failed: ${message(error)}`);
		}
		// The matched arm's scope states maxAgents 0: a worker it launched means
		// delegation was not off, and the run is not the single agent it stands for.
		const workers = reconciliation?.children.length ?? 0;
		if (cell.arm === "matched" && (workers || childSessionFiles.length)) {
			errors.push(`matched arm launched ${workers} worker(s) (${childSessionFiles.length} child session file(s)); its scope states maxAgents 0`);
		}
		const callText = new Map((reconciliation?.calls ?? []).map((c) => [c.toolCallId, c.resultText]));
		for (const child of reconciliation?.children ?? []) {
			if (!child.sessionFound) { children.push({ child }); continue; }
			try {
				const session = observationsFromChildSession(await readOptional(join(cell.childSessionDir, child.sessionPath)), child.childKey, retry);
				retried.push(...session.retries ?? []);
				observations.push(...session.observations);
				errors.push(...session.errors, ...session.providerErrors);
				notes.push(...session.notes);
				// A worker on another model or effort is a different experiment; its tokens do not compare.
				const verdict = reconcileChildSession(child, session, { model: `${expect.provider}/${expect.model}`, thinking: expect.thinking });
				errors.push(...verdict.errors);
				notes.push(...verdict.notes);
				if (!verdict.accepted && !verdict.errors.length && !session.errors.length && !session.providerErrors.length) errors.push(`child ${child.childKey} (${child.agent}): ended ${child.status}`);
				const failure = childProviderFailure(child, session.providerErrors, callText.get(child.toolCallId) ?? "");
				if (failure.text) childProviderErrors.push({ childKey: child.childKey, text: failure.text });
				if (failure.note) notes.push(failure.note);
				children.push({ child, session, verdict });
			} catch (error) {
				errors.push(`child ${child.childKey} usage extraction failed: ${message(error)}`);
				children.push({ child });
			}
		}
	}
	const usage = accountUsage(observations);
	errors.push(...usage.errors);
	if (!usage.valid) errors.push("provider usage attribution is incomplete");
	if (!retryPolicy) return { errors: [...new Set(errors)], notes, parent, reconciliation, children, childProviderErrors, childSessionFiles, usage };
	const meteredCalls = meteredCallCount(observations);
	const summary = summarizeRetries(retried, retryPolicy, meteredCalls);
	if (summary.capExceeded) {
		errors.push(`${summary.attempts} failed provider attempts (parent ${summary.bySource.parent.attempts}, workers ${summary.bySource.worker.attempts}) exceed the retry policy's cap of ${summary.cap.allowed} for a run of ${meteredCalls} metered requests`);
	}
	return {
		errors: [...new Set(errors)], notes, parent, reconciliation, children, childProviderErrors, childSessionFiles, usage,
		retry: summary, meteredCalls,
	};
}

/**
 * The settings and pi-subagents config a cell was given, re-read after it ran.
 * Both sit in the cell's writable agentDir, and a worker reads them afresh at
 * every launch, so a sealed bash call that turned retries or cache warming back
 * on, or switched launches to background, would change what later workers spend
 * without appearing anywhere else in the record.
 */
async function cellConfigErrors(cell: PreparedCell): Promise<string[]> {
	const errors: string[] = [];
	const settings = await readFile(cell.agentSettingsPath).then(sha256).catch(() => "missing");
	const subagentConfig = await readFile(cell.subagentConfigPath).then(sha256).catch(() => "missing");
	if (settings !== cell.cellConfigSha256.settings) errors.push("the cell's agent settings.json changed during the run");
	if (subagentConfig !== cell.cellConfigSha256.subagentConfig) errors.push("the cell's pi-subagents config.json changed during the run");
	// A worker's SettingsManager.create(cwd, agentDir) also merges <cwd>/.pi/settings.json
	// over the global file. No corpus target ships one (checked 2026-09-23); one that
	// appeared in the writable target copy could have turned retries back on.
	if (await exists(join(cell.targetDir, ".pi", "settings.json"))) errors.push("a project .pi/settings.json appeared in the target during the run; workers read it");
	return errors;
}

export type RunOutcome = { metric: RunMetric; arm: Arm; cellId: string; seconds: number; record: JsonRecord; infraFailure: boolean; quotaExhausted?: boolean };

/**
 * Kill everything this cell left running. pi's bash tool detaches every command
 * into its own group and untracks it, so a model's `python3 -m http.server &`
 * outlives the cell; runOwned reaps only its own group. Left alive it keeps the
 * finished cell's workspace-write and Landlock domain and can be reached by the
 * next arm of the same pair. The cell's systemd scope is killed first, since a
 * model can strip the env marker but cannot leave its cgroup; the marker reaper
 * then runs as a second pass. This runs after every arm closes (normal, timeout
 * or abort), so it also reaps before the pair's next arm starts.
 */
async function reapCell(cell: PreparedCell, scopeUnit: string | undefined): Promise<{ pids: number[]; errors: string[] }> {
	const pids = new Set<number>();
	const errors: string[] = [];
	if (scopeUnit) {
		try {
			const scoped = await closeScope(scopeUnit);
			for (const pid of scoped.pids) pids.add(pid);
			errors.push(...scoped.errors);
		} catch (error) {
			errors.push(`scope reaping failed: ${message(error)}`);
		}
	}
	try {
		const marked = await reapMarkedProcesses({ name: CELL_MARKER, value: cell.cellId }, { graceMs: 2000 });
		for (const pid of marked.pids) pids.add(pid);
		errors.push(...marked.errors);
	} catch (error) {
		errors.push(`stray reaping failed: ${message(error)}`);
	}
	return { pids: [...pids].sort((a, b) => a - b), errors };
}

/**
 * The provider-originated failure text of one run: the only input the infra
 * classifier reads. Harness messages are never included (a usage defect reads
 * "reports 1308 output tokens", a malformed-line count can be 500), nor is free
 * stderr (a Node stack frame can end ":503:9").
 */
export interface ProviderFailures {
	/** errorMessage of each failing parent reply (not an overflow pi recovered) and each failed compaction. */
	parent: string[];
	/** Worker provider failure text (see workerProviderFailure). */
	workers: string[];
	/** The entry's benchmark_fetch_error lines to the provider's own hosts, parsed. */
	fetchErrors: Array<{ code?: string; codes?: string[]; host?: string }>;
}

export type InfraClass = {
	infra: boolean;
	reason?: string;
	/** A quota or usage window is spent; a resume before it resets can only fail again. */
	exhausted?: boolean;
	/** The provider text that decided it, truncated, for the run record. */
	evidence?: string;
};

/**
 * The errorMessage of every parent reply that ended the run's provider path in
 * failure, from pi's own event stream: stopReason `error`, except a reply whose
 * context overflow pi recovered (a `compaction_end` with reason overflow and
 * willRetry right after it, the pattern observationsFromPiEvents accepts), plus
 * every failed compaction's errorMessage. Tool results are never read, so a
 * model's bash output that says "rate limit" cannot make a run infrastructure.
 *
 * Under a retry policy (`retry`), a reply pi retried is dropped once a later
 * reply arrives: without that, a run invalid for its own reason (a fast empty
 * run, a grader error) that had one dropped stream pi recovered from would be
 * classed as infrastructure and re-run. A retry still in progress when the
 * stream ends, or one pi cancelled (`auto_retry_end` success: false), keeps its
 * text: that run did not recover. Without the option the reading is the v5 one.
 */
export function providerFailureTexts(events: JsonRecord[], options: { retry?: boolean } = {}): string[] {
	const texts: string[] = [];
	let pending: string | undefined;
	// The text of a failed reply pi is retrying; settled by the next reply.
	let retrying: string | undefined;
	for (const event of events) {
		if (event.type === "message_end") {
			const reply = event.message;
			if (!isJsonRecord(reply) || reply.role !== "assistant") continue;
			if (pending !== undefined) texts.push(pending);
			// The retried request produced this reply: either it recovered, or it
			// failed in turn and its own error is now the one that counts.
			retrying = undefined;
			pending = reply.stopReason === "error" ? (typeof reply.errorMessage === "string" ? reply.errorMessage : "") : undefined;
		} else if (event.type === "compaction_end") {
			if (typeof event.errorMessage === "string") texts.push(event.errorMessage);
			else if (event.reason === "overflow" && event.willRetry === true) pending = undefined;
		} else if (options.retry === true && event.type === "auto_retry_start") {
			if (pending !== undefined) retrying = pending;
			pending = undefined;
		} else if (options.retry === true && event.type === "auto_retry_end" && event.success !== true) {
			if (retrying !== undefined) texts.push(retrying);
			retrying = undefined;
		}
	}
	if (pending !== undefined) texts.push(pending);
	if (retrying !== undefined) texts.push(retrying);
	return texts.filter((text) => text.trim() !== "");
}

/** Only whole-line JSON objects the entry's fetch wrapper printed; any other stderr text is ignored. */
export function fetchErrorsFromStderr(stderrText: string, providerHosts?: string[]): ProviderFailures["fetchErrors"] {
	const out: ProviderFailures["fetchErrors"] = [];
	const hosts = providerHosts?.map((h) => h.toLowerCase());
	for (const line of stderrText.split("\n")) {
		const row = line.trim().startsWith("{") ? parseJsonObject(line.trim()) : undefined;
		if (row?.type !== "benchmark_fetch_error") continue;
		const host = typeof row.host === "string" ? row.host.toLowerCase() : undefined;
		// With the provider's hosts known, a fetch to anything else (or with no
		// recorded host) is a side-channel, not a provider failure: counting it
		// would let a run that failed for its own reasons be re-run as "infra".
		if (hosts && (!host || !hosts.includes(host.replace(/:\d+$/, "")))) continue;
		out.push({
			...(typeof row.code === "string" ? { code: row.code } : {}),
			codes: Array.isArray(row.codes) ? row.codes.filter((c): c is string => typeof c === "string") : [],
			...(host ? { host } : {}),
		});
	}
	return out;
}

/**
 * The entry's request log for the provider's own hosts. The entry prints a
 * `benchmark_request` line per fetch only under a retry policy; parent and
 * in-process workers share that fetch, so the count covers attempts no stream
 * shows, such as a worker's failed compaction call. Any other stderr text is
 * ignored, as in fetchErrorsFromStderr.
 */
export function requestLogFromStderr(stderrText: string, providerHosts: string[]): { logged: number; byStatus: Record<string, number> } {
	const hosts = providerHosts.map((h) => h.toLowerCase());
	const byStatus: Record<string, number> = {};
	let logged = 0;
	for (const line of stderrText.split("\n")) {
		const row = line.trim().startsWith("{") ? parseJsonObject(line.trim()) : undefined;
		if (row?.type !== "benchmark_request" || typeof row.host !== "string" || !hosts.includes(row.host.toLowerCase().replace(/:\d+$/, ""))) continue;
		logged++;
		const status = typeof row.status === "number" ? String(row.status) : "none";
		byStatus[status] = (byStatus[status] ?? 0) + 1;
	}
	return { logged, byStatus };
}

/** zai's structured error codes, anchored to the JSON key so a bare number elsewhere never matches. */
const zaiCode = (code: string): RegExp => new RegExp(`"code"\\s*:\\s*"?${code}"?(?!\\d)`);
/**
 * Spent quota or usage windows. pi's own NON_RETRYABLE list (insufficient_quota,
 * quota exceeded, out of budget, billing, available balance) plus "usage limit",
 * which is how codex reports a spent ChatGPT plan ("Codex error: The usage limit
 * has been reached", 222 times in ~/.pi/agent/sessions; "You have hit your
 * ChatGPT usage limit"). zai 1310 ("Weekly/Monthly Limit Exhausted", 611 times)
 * does not match pi's list and would read as a retryable 429, so it is anchored
 * by code before pi's rule runs.
 */
const QUOTA_TEXT = /insufficient_quota|quota exceeded|out of budget|billing|available balance|usage limit/i;
/**
 * A provider that tells the client to retry. pi's list misses one such message: v5b's
 * luna filebrowser pass 3 baseline (2026-09-24) failed on "Codex error: Unable to verify
 * Daybreak Blue access. Please try again.", an entitlement check on OpenAI's side that
 * the other luna runs in flight passed, and the pair was blocked as the run's own fault.
 * Measured in ~/.pi/agent/sessions, every provider message with this phrase is transient
 * by its own wording: 20 codex overloads (pi already retries those) and that one check.
 * It runs after the quota patterns, so a spent plan that says "try again later" still
 * stops the grid.
 */
const PROVIDER_SAYS_RETRY = /\bplease try again\b/i;
/** undici and socket failure codes the entry's fetch wrapper records. */
const TRANSIENT_FETCH_CODE = /^(UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)$/;

/** pi's classifier reads only stopReason and errorMessage of the reply it is handed. */
function failedReply(errorMessage: string): AssistantMessage {
	return { stopReason: "error", errorMessage } as Pick<AssistantMessage, "stopReason" | "errorMessage"> as AssistantMessage;
}

/**
 * Classify a failed run's provider text as infrastructure a --resume may re-run,
 * or not. Transient means pi's own rule (isRetryableAssistantError, the pattern
 * agent-session.js retries on), so 'terminated', 'Connection error.', 'Request
 * timed out.', 'Stream ended without finish_reason', 'Provider finish_reason:
 * network_error', codex server_error and overload text all count: measured in
 * ~/.pi/agent/sessions, 42 of 167 long GLM corpus sessions (25.1%) hit one, and
 * the old number-and-word patterns classed none of them as infrastructure. zai
 * 1302 (request rate), 1308 (five-hour window) and 1310 (weekly quota) are
 * anchored to the JSON code key. A timed-out run is never infrastructure: the
 * two-hour ceiling is part of the protocol, not a fault.
 */
export function classifyInfra(failures: ProviderFailures, timedOut: boolean): InfraClass {
	if (timedOut) return { infra: false };
	const texts = [...failures.parent, ...failures.workers].map((t) => t.trim()).filter(Boolean);
	const evidence = (text: string): string => text.length > 300 ? `${text.slice(0, 300)}…` : text;
	// Exhaustion first: it decides whether anything launched before the reset can succeed.
	for (const text of texts) {
		if (zaiCode("1310").test(text)) return { infra: true, reason: "provider quota exhausted", exhausted: true, evidence: evidence(text) };
		if (zaiCode("1308").test(text)) return { infra: true, reason: "zai 1308 five-hour usage window", exhausted: true, evidence: evidence(text) };
		if (QUOTA_TEXT.test(text)) return { infra: true, reason: "provider quota exhausted", exhausted: true, evidence: evidence(text) };
	}
	for (const text of texts) {
		if (zaiCode("1302").test(text)) return { infra: true, reason: "zai 1302 request rate limit", evidence: evidence(text) };
		if (isRetryableAssistantError(failedReply(text))) return { infra: true, reason: "transient provider failure", evidence: evidence(text) };
		if (PROVIDER_SAYS_RETRY.test(text)) return { infra: true, reason: "provider asked for a retry", evidence: evidence(text) };
	}
	for (const fetchError of failures.fetchErrors) {
		const code = [fetchError.code, ...(fetchError.codes ?? [])].find((c): c is string => typeof c === "string" && TRANSIENT_FETCH_CODE.test(c));
		if (code) return { infra: true, reason: `transient network failure (${code})`, evidence: code };
	}
	return { infra: false };
}

/**
 * Whether an invalid run may be re-run by --resume. A provider classification
 * wins, since it keeps the quota flag; otherwise an arm this runner's own signal
 * handling stopped (or never launched because of it) is a runner interruption.
 * A timeout never is, even when a signal also arrived.
 *
 * Under a retry policy, a run past the policy's cap on failed attempts is
 * infrastructure too: pi recovered each drop, so no failure text is left for
 * the classifier, yet the provider, not the arm, failed the run.
 */
export function decideInfra(run: {
	valid: boolean; timedOut: boolean; stoppedByRunner: boolean; notLaunchedInterrupted: boolean; failures: ProviderFailures;
	retry?: Pick<RetrySummary, "attempts" | "cap" | "capExceeded">;
}): InfraClass {
	if (run.valid || run.timedOut) return { infra: false };
	const provider = classifyInfra(run.failures, false);
	if (provider.infra) return provider;
	if (run.retry?.capExceeded) {
		const { cap } = run.retry;
		return { infra: true, reason: "retry cap exceeded", evidence: `${run.retry.attempts} failed provider attempts; the policy allows ${cap.allowed} (max of ${cap.floor} and ${cap.rate} x ${cap.meteredRequests} metered requests)` };
	}
	if (run.stoppedByRunner || run.notLaunchedInterrupted) return { infra: true, reason: "runner interruption" };
	return { infra: false };
}

async function inspectRun(ctx: Context, cell: PreparedCell, launched: Launch, attempt: number): Promise<RunOutcome> {
	const { options } = ctx;
	const errors = [...cell.errors];
	const result = launched.result;
	if (launched.launchError) errors.push(launched.launchError);
	if (result?.timedOut) errors.push(`timed out at ${options.timeoutMs} ms`);
	if (result?.oversized) errors.push(`transcript exceeded ${MAX_TRANSCRIPT_BYTES} bytes`);
	if (result && result.exitCode !== 0) errors.push(`process failed with exit=${result.exitCode} signal=${result.signal ?? "none"}`);
	const seconds = result ? (result.finishedAt - result.startedAt) / 1000 : 0;
	// Reap this cell's strays before anything else touches the disk, so a leftover
	// server cannot still be writing the workspace we are about to grade, and so
	// the next arm of the pair cannot reach it. A reaping error invalidates the run.
	const reaped = await reapCell(cell, launched.scopeUnit);
	if (reaped.errors.length) errors.push(...reaped.errors);
	let events: JsonRecord[] = [];
	let accounting: CellUsage | undefined;
	let graded: GraderResult | undefined;
	let findings: Finding[] = [];
	let telemetry: JsonRecord | undefined;
	let ceilingState: ReturnType<typeof ceilingOf>;
	if (result) {
		try {
			const transcript = await readTranscriptEvents(cell.transcriptPath);
			events = transcript.events;
			if (transcript.malformed > 0) errors.push(`${transcript.malformed} malformed JSON event lines`);
		} catch (error) {
			errors.push(`transcript unreadable: ${message(error)}`);
		}
		const runtimes = events.filter((e) => e.type === "benchmark_runtime");
		const mismatch = runtimes.length === 1 ? runtimeMismatch(runtimes[0], options) : undefined;
		if (runtimes.length !== 1) errors.push(`expected one SDK runtime metadata event, found ${runtimes.length}`);
		else if (mismatch) errors.push(`SDK runtime did not match the request: ${mismatch}`);
		else {
			const pinned = ctx.pins.benchmarkRuntime;
			const actual = benchmarkRuntimeOf(runtimes[0]!);
			if (!pinned) errors.push("no probe-resolved model runtime was pinned at preflight");
			else if (JSON.stringify(actual) !== JSON.stringify(pinned)) errors.push(`SDK runtime ${JSON.stringify(actual)} differs from the preflight-pinned ${JSON.stringify(pinned)}`);
		}
		if (events.some((e) => e.type === "benchmark_probe" || e.type === "benchmark_probe_delegation")) errors.push("a scored run emitted a probe report");
		if (assistantReplies(events).some((m) => m.provider === PROBE_FAUX_PROVIDER)) errors.push("a scored run was answered by the probe's scripted model");
		ceilingState = ceilingOf(events, cell, result, errors);
		accounting = await accountCellUsage(events, cell, options, launched.stream, options.retryPolicy, { cut: ceilingState?.cut === true });
		errors.push(...accounting.errors);
		if (ceilingState) errors.push(...verifyCeiling(events, ceilingState, accounting.usage.parent.totalTokens));
		errors.push(...await cellConfigErrors(cell));
		try {
			if (await hashFile(GRADER_SCRIPT) !== ctx.pins.externalGraderSha256) errors.push("external grader changed after preflight");
			const scored = await scoreWorkspace(cell.workspaceDir, cell.scorePath, cell.target.truth);
			findings = scored.findings;
			graded = scored.graded;
			if (!graded.ok) errors.push(graded.error);
			const measured = await engagementTelemetry(cell.workspaceDir);
			telemetry = measured as unknown as JsonRecord;
			if (findings.length === 0 && measured.hypotheses === 0 && seconds < 120) errors.push("fast empty run (no findings or hypotheses under 120 seconds)");
		} catch (error) {
			errors.push(`ledger/scorer inspection failed: ${message(error)}`);
		}
	}
	const uniqueErrors = [...new Set(errors)];
	const valid = uniqueErrors.length === 0;
	// Provider-limit and transient failures may be re-run by --resume; the run's
	// own failures (timeout, fast-empty, quality, harness) may not. Only
	// provider-originated text is classified (see ProviderFailures).
	const stderrText = result ? await readFile(cell.stderrPath, "utf8").catch(() => "") : "";
	const failures: ProviderFailures = {
		parent: providerFailureTexts(events, options.retryPolicy ? { retry: true } : {}),
		workers: (accounting?.childProviderErrors ?? []).map((w) => w.text),
		fetchErrors: fetchErrorsFromStderr(stderrText, ctx.provider.allowedHosts.filter((h) => h !== "localhost" && h !== "127.0.0.1")),
	};
	// Stopped by this runner: the first stop signal arrived while the process ran
	// (pi then exits 143 with a truncated transcript), or after it exited but
	// before its grading finished and the grading failed (the python grader shares
	// the runner's process group, so a terminal Ctrl-C reaches it). Either way the
	// arm did not fail on its own; without this every in-flight arm of an
	// interrupted grid was recorded non-infra and blocked on resume.
	const abortedAt = runState.abortedAtMs;
	const stoppedByRunner = abortedAt !== undefined && result !== undefined && !result.timedOut && abortedAt >= result.startedAt &&
		(abortedAt <= result.finishedAt || graded?.ok !== true);
	const classified = decideInfra({
		valid, timedOut: result?.timedOut === true, stoppedByRunner,
		notLaunchedInterrupted: launched.launchError === "not launched: interrupted", failures,
		...(accounting?.retry ? { retry: accounting.retry } : {}),
	});
	const infraFailure = !valid && classified.infra;
	const infraReason = infraFailure ? classified.reason : undefined;
	const usage = accounting?.usage;
	const truePositives = graded?.ok ? graded.truePositives : 0;
	const totalClaims = graded?.ok ? graded.totalFindings : 0;
	const precision = graded?.ok ? graded.precision : 0;
	// Only a valid run carries a token count. JSON has no NaN, so an invalid row
	// serializes as null — never as a zero that reads like a free run.
	const totalTokens = valid && usage?.valid ? usage.total.totalTokens : Number.NaN;
	// What the comparison gates on: metered tokens plus the lower-bound estimate
	// for failed attempts that reported nothing. The arm that makes more calls
	// meets more drops, so metered tokens alone would flatter it; without a
	// policy there are no retried attempts and this is totalTokens.
	const totalTokensWithRetryEstimate = totalTokens + (accounting?.retry?.estimatedTokens ?? 0);
	const requestLog = options.retryPolicy && result ? requestLogFromStderr(stderrText, [ctx.provider.baseHost]) : undefined;
	const stream = launched.stream;
	const since = (at: number | undefined): number | null => at === undefined || !result ? null : (at - result.startedAt) / 1000;
	const record: JsonRecord = {
		key: cell.key, target: cell.target.id, ...(cell.target.twinOf === undefined ? {} : { twinOf: cell.target.twinOf }), pass: cell.pass, arm: cell.arm, cellId: cell.cellId, engagement: cell.engagement,
		attempt, ...(cell.matchedSession ? { matchedSession: cell.matchedSession } : {}), infraFailure, infraReason: infraReason ?? null, infraEvidence: infraFailure ? classified.evidence ?? null : null,
		quotaExhausted: infraFailure && classified.exhausted === true,
		providerFailures: failures,
		stoppedByRunner, interruptedAt: stoppedByRunner && abortedAt !== undefined ? new Date(abortedAt).toISOString() : null,
		scopeUnit: launched.scopeUnit ?? null, reapedPids: reaped.pids, symlinkActions: cell.symlinkActions,
		valid, seconds, process: result ?? null,
		findings: totalClaims, truePositives, unmatchedClaims: Math.max(0, totalClaims - truePositives),
		precisionLowerBound: precision, submittedFindings: findings.length,
		score: graded?.ok ? graded.summary : null, telemetry: telemetry ?? null,
		totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
		// Only a matched session has a ceiling, so every other record keeps its shape.
		...(cell.tokenCeiling !== undefined ? { tokenCeiling: ceilingState ?? null } : {}),
		// Only a grid under a retry policy writes these, so a v5 record keeps its shape.
		...(options.retryPolicy ? {
			totalTokensWithRetryEstimate: Number.isFinite(totalTokensWithRetryEstimate) ? totalTokensWithRetryEstimate : null,
			retry: accounting?.retry ? {
				...accounting.retry,
				// Logged requests minus metered calls: an upper bound on the calls no
				// usage covers, since a compaction that summarized a split turn made
				// two requests under one observation.
				requests: requestLog ? {
					...requestLog, metered: accounting.meteredCalls ?? 0,
					unmetered: Math.max(0, requestLog.logged - (accounting.meteredCalls ?? 0)),
				} : null,
			} : null,
		} : {}),
		usage: usage ? {
			valid: usage.valid, parent: usage.parent, worker: usage.worker, total: usage.total,
			parentRequests: usage.parentRequests, workerRequests: usage.workerRequests,
			duplicateEvents: usage.duplicateEvents, costUsd: usage.costUsd,
			compactions: accounting?.parent?.compactions ?? null,
			recoveredOverflows: accounting?.parent?.recoveredOverflows ?? null,
			missingResponseIds: accounting?.parent?.missingResponseIds ?? null,
			notes: accounting?.notes ?? [],
		} : null,
		delegation: {
			subagentCalls: stream.subagentCalls, enableCalls: stream.enableCalls,
			launches: (accounting?.reconciliation?.calls ?? []).filter((c) => c.children.length > 0).length,
			childSessionFiles: accounting?.childSessionFiles ?? [],
			children: (accounting?.children ?? []).map(({ child, session, verdict }) => ({
				childKey: child.childKey, agent: child.agent, status: child.status, exitCode: child.exitCode ?? null,
				error: child.error ?? null, model: child.model ?? null, thinking: child.thinking ?? null,
				sessionFound: child.sessionFound, turns: session?.turns ?? null, compactions: session?.compactions ?? null,
				// Each retried attempt used one of the worker's turns (core/child.ts
				// counts turn_start); the baseline has no turn budget. Measured here,
				// not corrected, since the product is frozen.
				...(options.retryPolicy ? { retriedAttempts: session?.retries?.length ?? null } : {}),
				models: session?.models ?? [], thinkingLevels: session?.thinkingLevels ?? [], finalStop: session?.finalStop ?? null,
				ending: session?.ending ?? null, outcome: verdict?.outcome ?? null,
				handoffChars: session ? session.finalText.length : null,
				accepted: verdict?.accepted ?? false, errors: [...(session?.errors ?? []), ...(session?.providerErrors ?? []), ...(verdict?.errors ?? [])],
			})),
			calls: (accounting?.reconciliation?.calls ?? []).map((c) => ({
				toolCallId: c.toolCallId, isError: c.isError, requestedAgent: c.requestedAgent ?? null, action: c.action ?? null,
				async: c.async, mode: c.mode ?? null, runId: c.runId ?? null, children: c.children.map((k) => k.childKey),
			})),
			recordCalls: stream.recordCalls, successfulRecordWrites: stream.recordWrites,
			subagentUpdates: stream.subagentUpdates, recordWritesBeforeFirstSubagent: stream.recordWritesBeforeFirstSubagent,
			firstRecordSeconds: since(stream.firstRecordAt), firstSubagentSeconds: since(stream.firstSubagentAt),
		},
		eventCount: events.length,
		leakCheck: { hits: cell.leakHits },
		artifacts: {
			transcriptPath: cell.transcriptPath, stderrPath: cell.stderrPath, workspaceDir: cell.workspaceDir,
			targetDir: cell.targetDir, scorePath: cell.scorePath, configPath: cell.configPath,
			childSessionDir: cell.childSessionDir,
		},
		errors: uniqueErrors,
	};
	// Whether delegation happened the way ADR-027 describes. Diagnostic only: it
	// never changes validity, and a run that did not delegate is still a valid run
	// (the model chooses). Without it, a candidate grid that never delegated would
	// read as a verdict on workers it never used.
	let delegationAudit: DelegationAudit | { error: string } | null = null;
	if (cell.arm === "candidate") {
		try { delegationAudit = auditCell(cell.cellDir, { transcript: cell.transcriptPath, workspace: cell.workspaceDir, target: cell.targetDir, childSessions: cell.childSessionDir }); }
		catch (error) { delegationAudit = { error: error instanceof Error ? error.message : String(error) }; }
	}
	(record as JsonRecord).delegationAudit = delegationAudit;
	// Guarded like the audit: a diagnostic that throws must not cost the run its record.
	let stop: RunStop | { error: string };
	try {
		// engagementTelemetry reads a missing engagement as zeros; passed on, that
		// would read as "nothing open" rather than "no ledger".
		const ledger = telemetry && await exists(cell.workspaceDir) ? telemetry : undefined;
		stop = runStop({ launchError: launched.launchError, result: launched.result, stoppedByRunner, events, telemetry: ledger, children: accounting?.children ?? [], limitMs: ctx.options.timeoutMs, ...(ceilingState?.cut ? { tokenCeiling: true } : {}) });
	} catch (error) {
		stop = { error: error instanceof Error ? error.message : String(error) };
	}
	(record as JsonRecord).stop = stop as unknown as JsonRecord;
	// Written only now, after the process is gone, and outside every granted path.
	await writeJson(join(cell.cellDir, "run.json"), record);
	return {
		metric: { key: cell.key, target: cell.target.id, pass: cell.pass, valid, truePositives, precision, totalClaims, totalTokens: totalTokensWithRetryEstimate },
		arm: cell.arm, cellId: cell.cellId, seconds, record, infraFailure, quotaExhausted: infraFailure && classified.exhausted === true,
	};
}

/**
 * Why the run and each worker stopped (ADR-030). Attached after the record
 * is built, like the delegation audit, and never read by validity: a run that
 * offers to continue is still a valid run, it is the model's choice. Kept apart
 * from `valid` so an old grid's rows, which lack it, still load and compare.
 */
export function runStop(run: {
	launchError?: string;
	result?: Pick<OwnedResult, "exitCode" | "signal" | "timedOut"> & Partial<Pick<OwnedResult, "startedAt" | "finishedAt">>;
	stoppedByRunner: boolean;
	events: JsonRecord[];
	telemetry: JsonRecord | undefined;
	children: Array<Pick<ChildAccount, "child" | "session">>;
	/** The run's time limit; with the process's start and end, the share of it used (3.2). */
	limitMs?: number;
	/** A matched session's token ceiling cut it (plan item 2.5). */
	tokenCeiling?: boolean;
}): RunStop {
	const last = assistantReplies(run.events).at(-1);
	const r = run.result;
	const timing = r && typeof r.startedAt === "number" && typeof r.finishedAt === "number" && run.limitMs
		? { seconds: (r.finishedAt - r.startedAt) / 1000, limitSeconds: run.limitMs / 1000 } : undefined;
	return classifyRunStop({
		...(run.launchError ? { launchError: run.launchError } : {}),
		...(run.tokenCeiling ? { tokenCeiling: true } : {}),
		process: run.result ? { exitCode: run.result.exitCode, signal: run.result.signal, timedOut: run.result.timedOut } : null,
		stoppedByRunner: run.stoppedByRunner,
		...(last ? { lastReply: { stopReason: last.stopReason, text: contentText(last.content) } } : {}),
	}, run.telemetry, run.children.map(({ child, session }) => ({
		childKey: child.childKey, agent: child.agent, status: child.status,
		...(session ? { ending: session.ending, finalText: session.finalText, ...(session.finalStop ? { finalStop: session.finalStop } : {}) } : {}),
		sessionErrors: session ? session.errors.length + session.providerErrors.length : 0,
	})), timing);
}

/**
 * The entry's `benchmark_token_ceiling` line, checked against the cell: one line
 * exactly when the cell had a ceiling and the entry ran to its end. A problem is
 * pushed onto `errors`; the line is returned when it is the cell's own.
 */
export function ceilingOf(events: JsonRecord[], cell: { tokenCeiling?: number }, result: Pick<OwnedResult, "exitCode" | "timedOut"> | undefined, errors: string[]): { ceiling: number; metered: number; requests: number; reached: boolean; cut: boolean; [key: string]: unknown } | undefined {
	const lines = events.filter((e) => e.type === "benchmark_token_ceiling");
	if (cell.tokenCeiling === undefined) {
		if (lines.length) errors.push("a run without a token ceiling reported one");
		return undefined;
	}
	if (lines.length > 1) { errors.push(`expected one token ceiling line, found ${lines.length}`); return undefined; }
	const line = lines[0];
	if (!line) {
		// A killed or crashed entry never reaches the line; its own failure says why.
		if (result && !result.timedOut && result.exitCode === 0) errors.push("the entry did not report its token ceiling");
		return undefined;
	}
	if (line.ceiling !== cell.tokenCeiling) { errors.push(`the entry ran under a token ceiling of ${String(line.ceiling)}, not the cell's ${cell.tokenCeiling}`); return undefined; }
	const { type: _type, ...state } = line;
	return state as ReturnType<typeof ceilingOf> & object;
}

/**
 * The ceiling checked against the transcript, not taken on the entry's word
 * (review). The transcript's metered requests (assistant replies and completed
 * compactions that report tokens) must sum to the line's `metered` and to the
 * accounting's parent total, must first reach the ceiling at the line's
 * `reachedAtRequest`, and nothing metered may follow that request; only a
 * compaction the ceiling aborted at its start may, and none may come before it.
 * Any mismatch is harness integrity, so the session is invalid.
 */
export function verifyCeiling(events: JsonRecord[], line: { ceiling: number; metered: number; requests: number; reached: boolean; reachedAtRequest?: unknown }, parentTotal: number | undefined): string[] {
	const errors: string[] = [];
	let metered = 0;
	let requests = 0;
	let reachedAt: number | null = null;
	let after = 0;
	let abortedEarly = 0;
	for (const e of events) {
		let tokens: unknown;
		if (e.type === "message_end" && isJsonRecord(e.message) && e.message.role === "assistant") tokens = (e.message.usage as JsonRecord | undefined)?.totalTokens;
		else if (e.type === "compaction_end") {
			if (e.aborted === true && !isJsonRecord(e.result)) { if (reachedAt === null) abortedEarly++; continue; }
			tokens = isJsonRecord(e.result) ? (e.result.usage as JsonRecord | undefined)?.totalTokens : undefined;
		} else continue;
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue;
		requests++;
		metered += tokens;
		if (reachedAt !== null) after++;
		else if (metered >= line.ceiling) reachedAt = requests;
	}
	if (metered !== line.metered || requests !== line.requests) errors.push(`the transcript meters ${metered} tokens over ${requests} request(s); the entry's ceiling line says ${line.metered} over ${line.requests}`);
	if (parentTotal !== undefined && parentTotal !== metered) errors.push(`the accounting's parent total ${parentTotal} is not the ${metered} tokens the ceiling metered`);
	if ((reachedAt !== null) !== line.reached || (reachedAt ?? null) !== (line.reachedAtRequest ?? null)) errors.push(`the transcript reaches the ceiling at request ${reachedAt ?? "none"}; the entry's line says ${String(line.reachedAtRequest ?? "none")}`);
	if (after) errors.push(`${after} metered request(s) followed the one that reached the token ceiling`);
	if (abortedEarly) errors.push(`${abortedEarly} compaction(s) were aborted before the token ceiling was reached`);
	return errors;
}

/**
 * What the preflight's ceiling probe must show (plan item 2.5), from what it
 * observed. The scripted model's one reply records an element and crosses a
 * one-token ceiling: the record must be in the ledger (the abort waited for the
 * turn's tools), the model must have been asked once (the abort came before the
 * next request), the accounting must accept the cut session with its ceiling
 * verified, and the classifier must read it as budget.
 */
export function ceilingProbeErrors(seen: {
	requests: number | undefined; line: ReturnType<typeof ceilingOf>; ceilingErrors: string[]; accountingErrors: string[];
	recorded: number; recordedAfter: number; stopOutcome: string | undefined;
}): string[] {
	const errors = [...seen.ceilingErrors];
	if (seen.requests !== 1) errors.push(`the scripted model was asked ${seen.requests ?? "an unknown number of"} time(s); the ceiling must stop the run before a second request`);
	if (!seen.line?.reached || seen.line.cut !== true || seen.line.reachedAtRequest !== 1) errors.push("the entry's ceiling line does not report a cut at the first request");
	errors.push(...seen.accountingErrors.map((e) => `accounting: ${e}`));
	if (seen.recorded !== 1) errors.push(`the crossing reply's record reached the ledger ${seen.recorded} time(s), not once: the abort did not wait for the turn's tools`);
	if (seen.recordedAfter) errors.push("a request after the ceiling recorded to the ledger");
	if (seen.stopOutcome !== "budget") errors.push(`the stop classifier read the cut session as ${seen.stopOutcome ?? "nothing"}, not budget`);
	return errors;
}

async function inspectCeilingProbe(ctx: Context, cell: PreparedCell, launched: Launch): Promise<{ errors: string[]; record: JsonRecord }> {
	const errors = [...cell.errors];
	const result = launched.result;
	const plan = cell.probe?.ceiling;
	if (launched.launchError) errors.push(launched.launchError);
	const reaped = await reapCell(cell, launched.scopeUnit);
	errors.push(...reaped.errors);
	if (!plan || cell.probe?.mode !== "ceiling") errors.push("ceiling probe cell has no ceiling plan");
	if (result?.timedOut) errors.push(`ceiling probe timed out at ${PROBE_TIMEOUT_MS} ms`);
	if (result && result.exitCode !== 0) errors.push(`ceiling probe exited ${result.exitCode} signal=${result.signal ?? "none"} (see ${cell.stderrPath})`);
	let events: JsonRecord[] = [];
	if (result) {
		try { events = (await readTranscriptEvents(cell.transcriptPath)).events; }
		catch (error) { errors.push(`ceiling probe stdout unreadable: ${message(error)}`); }
		if ((await readFile(cell.stderrPath, "utf8").catch(() => "")).includes("benchmark_fetch_error")) errors.push("ceiling probe attempted a network fetch");
	}
	const ceilingErrors: string[] = [];
	const line = ceilingOf(events, cell, result, ceilingErrors);
	const accounting = await accountCellUsage(events, cell, ctx.options, launched.stream, ctx.options.retryPolicy, { cut: line?.cut === true });
	if (line) ceilingErrors.push(...verifyCeiling(events, line, accounting.usage.parent.totalTokens));
	const report = events.find((e) => e.type === "benchmark_probe_ceiling");
	const stop = runStop({ launchError: launched.launchError, result, stoppedByRunner: false, events, telemetry: undefined, children: [], ...(line?.cut ? { tokenCeiling: true } : {}) });
	errors.push(...ceilingProbeErrors({
		requests: typeof report?.requests === "number" ? report.requests : undefined, line, ceilingErrors, accountingErrors: accounting.errors,
		recorded: plan ? (await inventoryRowsNaming(cell.workspaceDir, plan.recordPath)).length : 0,
		recordedAfter: plan ? (await inventoryRowsNaming(cell.workspaceDir, `${plan.recordPath}-after`)).length : 0,
		stopOutcome: stop.outcome,
	}));
	return { errors, record: { cellId: cell.cellId, ok: errors.length === 0, errors, ceiling: line ?? null, requests: report?.requests ?? null, stop: stop.outcome, metered: accounting.usage.parent.totalTokens } };
}

async function runOne(ctx: Context, target: Target, pass: number, arm: Arm, attempt: number, session?: MatchedSessionSpec): Promise<RunOutcome> {
	const cell = await prepareCell(ctx, target, pass, arm, join(ctx.out, "runs"), undefined, session);
	await appendJsonl(join(ctx.out, "cells.jsonl"), {
		cellId: cell.cellId, key: cell.key, target: target.id, ...(target.twinOf === undefined ? {} : { twinOf: target.twinOf }), pass, arm, attempt, ...(session ? { matchedSession: session } : {}), preparedAt: new Date().toISOString(), errors: cell.errors,
	});
	const launched = await launch(ctx, cell, ctx.options.timeoutMs, () => !runState.aborted);
	return await inspectRun(ctx, cell, launched, attempt);
}

/**
 * Why an arm's active tools at session start are not the ones this comparison
 * measures, or [] when they are. Both arms, and the whole set rather than one
 * difference: the first SDK entry passed a tools allowlist that silently dropped
 * record/recall from BOTH arms, and a check on the delegate tool alone passed
 * it. The candidate must show pi-subagents' lazy loader and not the eager
 * `subagent` schema (~18k characters on every request, measured on 0.71.0),
 * which is what pi-subagents falls back to when it cannot find the host pi
 * package; and none of the tools pired hides.
 */
export function toolSurfaceErrors(arm: Arm, tools: string[], off = false): string[] {
	const errors: string[] = [];
	// A candidate whose scope switches delegation off (plan item 2.8: stage 1's S,
	// maxAgents 0 and maxVerifiers 0) is shown no launcher by pired since ADR-029;
	// like the matched arm, the loader is then allowed, not required.
	const optional = arm === "matched" || (arm === "candidate" && off);
	const expected: string[] = arm === "candidate" && !optional ? [...BASE_TOOLS, ENABLE_TOOL] : [...BASE_TOOLS];
	for (const name of expected) if (!tools.includes(name)) errors.push(`${arm} arm does not expose ${name}`);
	if (loadsSubagents(arm)) {
		for (const name of CANDIDATE_HIDDEN_TOOLS) if (tools.includes(name)) errors.push(`${arm} arm exposes ${name}, which pired hides`);
		if (tools.includes(SUBAGENT_TOOL)) errors.push(`${arm} arm exposes ${SUBAGENT_TOOL} eagerly instead of through ${ENABLE_TOOL}`);
	}
	// The matched arm loads pi-subagents with its cap at 0. Since ADR-029 pired
	// keeps the lazy loader out of such a session, but a snapshot cut before that
	// may still show it; it is allowed, not required, and a worker it launched
	// would fail the run (accountCellUsage).
	const known = new Set<string>([...expected, ...(loadsSubagents(arm) ? [...CANDIDATE_HIDDEN_TOOLS, SUBAGENT_TOOL] : []), ...(optional ? [ENABLE_TOOL] : [])]);
	const extra = tools.filter((name) => !known.has(name));
	if (extra.length) errors.push(`${arm} arm exposes unexpected tool(s) ${[...new Set(extra)].join(", ")}`);
	return errors;
}

/** The probe must have been stopped by the seal itself, not by a path that was never there. */
const DENIAL_CODES = new Set(["EACCES", "EPERM"]);

/** The assistant messages of every message_end in a transcript. */
function assistantReplies(events: JsonRecord[]): JsonRecord[] {
	return events.flatMap((e) => e.type === "message_end" && isJsonRecord(e.message) && e.message.role === "assistant" ? [e.message] : []);
}

/** Every requested denial reported as a seal denial, every requested read reported as readable. */
function readCheckErrors(request: ProbeConfig | undefined, report: JsonRecord): string[] {
	const errors: string[] = [];
	const denied = Array.isArray(report.denied) ? report.denied as Array<{ path?: unknown; blocked?: unknown; code?: unknown }> : [];
	const allowed = Array.isArray(report.allowed) ? report.allowed as Array<{ path?: unknown; ok?: unknown; code?: unknown }> : [];
	for (const path of request?.readDenied ?? []) {
		const row = denied.find((r) => r.path === path);
		if (!row) errors.push(`probe did not report denied path ${path}`);
		else if (row.blocked !== true) errors.push(`sealed process could read ${path}`);
		else if (row.code !== undefined && !DENIAL_CODES.has(String(row.code))) errors.push(`denied path ${path} failed with ${String(row.code)}, not a seal denial`);
	}
	for (const path of request?.readAllowed ?? []) {
		const row = allowed.find((r) => r.path === path);
		if (!row) errors.push(`probe did not report allowed path ${path}`);
		else if (row.ok !== true) errors.push(`sealed process could not read ${path} (${String(row.code ?? "unknown")})`);
	}
	return errors;
}

async function inspectProbe(ctx: Context, cell: PreparedCell, launched: Launch): Promise<{ errors: string[]; record: JsonRecord; runtime?: BenchmarkRuntime }> {
	const errors = [...cell.errors];
	const result = launched.result;
	const request = cell.probe;
	if (launched.launchError) errors.push(launched.launchError);
	if (launched.scopeUnit) {
		const closed = await closeScope(launched.scopeUnit);
		errors.push(...closed.errors);
	}
	if (!request) errors.push("probe cell has no probe request");
	if (result?.timedOut) errors.push(`probe timed out at ${PROBE_TIMEOUT_MS} ms`);
	if (result && result.exitCode !== 0) errors.push(`probe exited ${result.exitCode} signal=${result.signal ?? "none"}`);
	let events: JsonRecord[] = [];
	if (result) {
		try {
			const transcript = await readTranscriptEvents(cell.transcriptPath);
			events = transcript.events;
			if (transcript.malformed) errors.push(`${transcript.malformed} malformed stdout lines`);
		} catch (error) { errors.push(`probe stdout unreadable: ${message(error)}`); }
		const stderrText = await readFile(cell.stderrPath, "utf8").catch(() => "");
		if (stderrText.includes("benchmark_fetch_error")) errors.push("probe attempted a network fetch");
	}
	const runtimes = events.filter((e) => e.type === "benchmark_runtime");
	const mismatch = runtimes.length === 1 ? runtimeMismatch(runtimes[0], ctx.options) : undefined;
	if (runtimes.length !== 1) errors.push(`expected one runtime line, found ${runtimes.length}`);
	else if (mismatch) errors.push(`runtime line did not match the request: ${mismatch}`);
	// The probe runs one turn so that pired's before_agent_start has run when the
	// tools are read, but only against the scripted model the entry registers in
	// probe mode: a reply from any other provider means a real model was called.
	const replies = assistantReplies(events);
	const foreign = replies.filter((m) => m.provider !== PROBE_FAUX_PROVIDER);
	if (foreign.length) errors.push(`probe was answered by ${[...new Set(foreign.map((m) => String(m.provider)))].join(", ")}, not the scripted model`);
	if (replies.length !== 1) errors.push(`expected one scripted reply, found ${replies.length}`);
	const probes = events.filter((e) => e.type === "benchmark_probe");
	if (probes.length !== 1) errors.push(`expected one probe report, found ${probes.length}`);
	const report = probes[0] ?? {};
	errors.push(...readCheckErrors(request, report));
	if (report.workspace !== cell.workspaceDir) errors.push(`pired resolved workspace ${String(report.workspace)}, not the cell workspace`);
	const tools = Array.isArray(report.extensionTools) ? report.extensionTools.map(String) : undefined;
	if (!tools) errors.push("probe did not list active tools");
	else errors.push(...toolSurfaceErrors(cell.arm, tools, delegationOff(armSettings(ctx.options, cell.arm))));
	const unique = [...new Set(errors)];
	const runtime = runtimes.length === 1 ? benchmarkRuntimeOf(runtimes[0]!) : undefined;
	return {
		errors: unique,
		record: {
			target: cell.target.id, arm: cell.arm, cellId: cell.cellId, ok: unique.length === 0,
			exitCode: result?.exitCode ?? null, seconds: result ? (result.finishedAt - result.startedAt) / 1000 : null,
			deniedChecked: request?.readDenied.length ?? 0, allowedChecked: request?.readAllowed.length ?? 0,
			workspaceResolved: report.workspace === cell.workspaceDir, tools: tools ?? null,
			runtime: runtime ?? null, scopeUnit: launched.scopeUnit ?? null,
			leakHits: cell.leakHits, errors: unique,
		},
		...(runtime ? { runtime } : {}),
	};
}

/** The rows of <workspace>/inventory.jsonl that name `path`, read from outside the seal. */
async function inventoryRowsNaming(workspaceDir: string, path: string): Promise<JsonRecord[]> {
	const text = await readFile(join(workspaceDir, "inventory.jsonl"), "utf8").catch(() => "");
	return text.split("\n").map((line) => parseJsonObject(line)).filter((row): row is JsonRecord => row !== undefined && row.path === path);
}

/**
 * Judge the delegation probe from outside the seal. The entry's own report is
 * read for what only the process could see (the tools each request offered),
 * but every claim that decides the verdict — the ledger row, the absent marker,
 * the child session, the reconciled spend — is re-read here from disk and from
 * the parent's transcript, the one file the sealed process cannot rewrite.
 */
async function inspectDelegationProbe(ctx: Context, cell: PreparedCell, launched: Launch): Promise<{ errors: string[]; record: JsonRecord }> {
	const errors = [...cell.errors];
	const result = launched.result;
	const request = cell.probe;
	const plan = request?.delegation;
	if (launched.launchError) errors.push(launched.launchError);
	// A worker is an in-process session, but a bash call it made could still
	// have left a process; the probe cell is reaped like a scored one.
	const reaped = await reapCell(cell, launched.scopeUnit);
	errors.push(...reaped.errors);
	if (!plan || request?.mode !== "delegation") errors.push("delegation probe cell has no delegation plan");
	if (result?.timedOut) errors.push(`delegation probe timed out at ${PROBE_TIMEOUT_MS} ms`);
	if (result && result.exitCode !== 0) errors.push(`delegation probe exited ${result.exitCode} signal=${result.signal ?? "none"} (see ${cell.stderrPath})`);
	let events: JsonRecord[] = [];
	if (result) {
		try {
			const transcript = await readTranscriptEvents(cell.transcriptPath);
			events = transcript.events;
			if (transcript.malformed) errors.push(`${transcript.malformed} malformed stdout lines`);
		} catch (error) { errors.push(`delegation probe stdout unreadable: ${message(error)}`); }
		const stderrText = await readFile(cell.stderrPath, "utf8").catch(() => "");
		if (stderrText.includes("benchmark_fetch_error")) errors.push("delegation probe attempted a network fetch");
	}
	const runtimes = events.filter((e) => e.type === "benchmark_runtime");
	if (runtimes.length !== 1) errors.push(`expected one runtime line, found ${runtimes.length}`);
	else if (JSON.stringify(benchmarkRuntimeOf(runtimes[0]!)) !== JSON.stringify(ctx.pins.benchmarkRuntime ?? null)) errors.push("delegation probe resolved a different model runtime from the tool probes");
	const reports = events.filter((e) => e.type === "benchmark_probe_delegation");
	if (reports.length !== 1) errors.push(`expected one delegation report, found ${reports.length}`);
	const report = reports[0] ?? {};
	errors.push(...readCheckErrors(request, report));
	if (report.workspace !== cell.workspaceDir) errors.push(`pired resolved workspace ${String(report.workspace)}, not the cell workspace`);
	const list = (value: unknown): string[] | undefined => Array.isArray(value) ? value.map(String) : undefined;
	// The first request is what the model actually sees: pired's before_agent_start
	// runs between session_start (what the tool probe reads) and that request.
	const parentFirst = list(report.parentToolsFirst);
	if (!parentFirst) errors.push("the scripted parent never made a request");
	else errors.push(...toolSurfaceErrors("candidate", parentFirst).map((e) => `first parent request: ${e}`));
	const parentLast = list(report.parentToolsLast);
	if (parentLast && !parentLast.includes(SUBAGENT_TOOL)) errors.push(`${ENABLE_TOOL} did not expose ${SUBAGENT_TOOL} (last parent request offered ${parentLast.join(",")})`);
	const childTools = list(report.childTools);
	if (!childTools) errors.push("no worker request was made: pi-subagents did not run the worker");
	else {
		for (const name of [RECORD_TOOL, "recall", "bash"]) if (!childTools.includes(name)) errors.push(`worker was not offered ${name}`);
		for (const name of [SUBAGENT_TOOL, ENABLE_TOOL, ...CANDIDATE_HIDDEN_TOOLS]) if (childTools.includes(name)) errors.push(`worker was offered ${name}`);
	}
	const childBash = isJsonRecord(report.childBash) ? report.childBash : undefined;
	if (!childBash) errors.push("the worker's out-of-scope bash call never came back");
	else if (childBash.isError !== true || !String(childBash.text ?? "").includes("Out-of-scope")) errors.push(`the worker's out-of-scope bash call was not refused by pired's scope gate: ${String(childBash.text ?? "").slice(0, 200)}`);
	if (plan && await exists(plan.markerPath)) errors.push("the worker's out-of-scope command ran: its marker file exists");
	const ledger = plan ? await inventoryRowsNaming(cell.workspaceDir, plan.recordPath) : [];
	if (!ledger.some((row) => row.kind === "endpoint" && row.file === plan?.recordFile)) errors.push("the worker's surface record did not reach the parent's ledger");
	// Two launches: the worker that hands back, then the one that keeps calling
	// tools until pired's turn budget stops it (the entry's BUDGET_PROBE_TASK).
	const launches = events.filter((e) => e.type === "tool_execution_end" && e.toolName === SUBAGENT_TOOL);
	if (launches.length !== 2) errors.push(`expected two ${SUBAGENT_TOOL} results in the parent transcript (a worker that hands back, one pired's turn budget stops), found ${launches.length}`);
	if (launches[0]?.isError === true) errors.push(`the parent's first ${SUBAGENT_TOOL} call failed: ${JSON.stringify(launches[0]!.result ?? null).slice(0, 300)}`);
	// The accounting a scored candidate run gets, on the probe's faux spend: each
	// worker's session must be where the config says, and must reconcile.
	const stream = { ...trackStream().stream, subagentCalls: launches.length };
	const accounting = await accountCellUsage(events, cell, { provider: PROBE_FAUX_PROVIDER, model: PROBE_FAUX_MODEL, thinking: ctx.options.thinking }, stream, ctx.options.retryPolicy);
	errors.push(...accounting.errors.map((e) => `accounting: ${e}`));
	errors.push(...await cellConfigErrors(cell));
	if (accounting.childSessionFiles.length === 0) errors.push(`no worker session was written under ${cell.childSessionDir}`);
	if (!accounting.usage.valid || accounting.usage.workerRequests < 3) errors.push(`worker spend was not attributed (${accounting.usage.workerRequests} worker request(s) counted)`);
	// A worker stopped by pired's own bound is the candidate's outcome, not a
	// fault: when it was read as one, a single looping worker ended the grid.
	const outcomes = accounting.children.map(({ verdict, session }) => `${verdict?.outcome ?? "unaccounted"}/${session?.ending ?? "no session"}`);
	if (outcomes.join(" ") !== "completed/handoff incomplete/budget-stop") errors.push(`the two workers were accounted as ${outcomes.join(", ") || "nothing"}, not completed/handoff then incomplete/budget-stop`);
	// The audit a scored candidate run gets, run once on a real pi-subagents
	// transcript. Diagnostic like everywhere else: it is recorded, not judged.
	let audit: JsonRecord;
	try {
		const a = auditCell(cell.cellDir, { transcript: cell.transcriptPath, workspace: cell.workspaceDir, target: cell.targetDir, childSessions: cell.childSessionDir });
		audit = { delegated: a.delegated, calls: a.calls, workers: a.workers.length, violations: a.violations, notes: a.notes };
	} catch (error) { audit = { error: message(error) }; }
	const unique = [...new Set(errors)];
	return {
		errors: unique,
		record: {
			target: cell.target.id, arm: cell.arm, cellId: cell.cellId, ok: unique.length === 0,
			exitCode: result?.exitCode ?? null, seconds: result ? (result.finishedAt - result.startedAt) / 1000 : null,
			agent: plan?.agent ?? null, parentToolsFirst: parentFirst ?? null, parentToolsLast: parentLast ?? null, childTools: childTools ?? null,
			childBash: childBash ?? null, ledgerRows: ledger.length, childSessionFiles: accounting.childSessionFiles, workerOutcomes: outcomes, audit,
			usage: { valid: accounting.usage.valid, parentRequests: accounting.usage.parentRequests, workerRequests: accounting.usage.workerRequests, total: accounting.usage.total },
			reapedPids: reaped.pids, scopeUnit: launched.scopeUnit ?? null, leakHits: cell.leakHits, errors: unique,
		},
	};
}

class PreflightError extends Error {}

type Preflight = {
	ctx: Context;
	targets: Target[];
	expectedCells: ExpectedCell[];
	official: boolean;
	exploratoryReasons: string[];
	/** The pinned official shapes this grid was judged against; the comparison's decision reads the same ones. */
	officialShapes: OfficialShape[];
};

async function runPreflight(options: Options, manifest: JsonRecord, saveManifest: () => Promise<void>, preflightRoot: string): Promise<Preflight> {
	const stages: JsonRecord[] = [];
	const preflight: JsonRecord = { status: "running", stages };
	manifest.preflight = preflight;
	const stage = async <T>(name: string, fn: () => Promise<{ value: T; record: JsonRecord }>): Promise<T> => {
		const startedAt = Date.now();
		try {
			if (runState.aborted) throw new Error("interrupted");
			const { value, record } = await fn();
			stages.push({ name, ok: true, seconds: (Date.now() - startedAt) / 1000, ...record });
			await saveManifest();
			console.log(`preflight ${name}: ok`);
			return value;
		} catch (error) {
			stages.push({ name, ok: false, seconds: (Date.now() - startedAt) / 1000, error: message(error) });
			preflight.status = "failed";
			preflight.failedStage = name;
			await saveManifest();
			throw new PreflightError(`preflight ${name} failed: ${message(error)}`);
		}
	};
	const nodePath = resolve(process.execPath);
	// Accumulated across the inputs and staging stages: an official decision needs
	// the official grid shape AND every pinned input matched, so the pin checks in
	// staging can still push a reason after the grid shape was found official.
	const exploratoryReasons: string[] = [];

	// 1. Inputs exist, targets resolve, nothing handed to the model can carry an
	// advisory ID, and the manifest and truth keys match their research pins.
	const inputs = await stage("inputs", async () => {
		const required: Record<string, string> = {
			baseline: options.baseline, candidate: options.candidate, corpus: options.corpus, truth: options.truth,
			manifest: options.manifestPath, entry: ENTRY, scorer: SCORE_PATH, grader: GRADER_SCRIPT,
		};
		for (const [label, path] of Object.entries(required)) if (!await exists(path)) throw new Error(`Required input missing (${label}): ${path}`);
		if (!(await lstat(options.fsSeal).catch(() => undefined))?.isFile()) throw new Error(`Required Landlock wrapper missing: ${options.fsSeal}`);
		const info = await loadTargets(options);
		for (const target of info.targets) {
			const sibling = join(options.corpus, `${target.name}.truth.json`);
			if (!await exists(sibling)) throw new Error(`Missing corpus-side answer key for ${target.id}: ${sibling}`);
		}
		const terms = info.targets.flatMap((t) => leakTermsFor(t));
		const hits = findLeaks({ "--out": options.out }, terms);
		if (hits.length) throw new Error(`advisory label in the output path every cell sits under: ${hits.join("; ")}`);
		const provider = await providerMetadata(options.provider, options.model);
		// Only the gate targets' cells are expected by the comparison; a patched
		// twin's runs are summarised apart and never enter it (plan item 2.8).
		const gateTargets = info.targets.filter((t) => t.twinOf === undefined);
		const twinTargetsRun = info.targets.filter((t) => t.twinOf !== undefined);
		const expectedCells: ExpectedCell[] = gateTargets.flatMap((target) =>
			Array.from({ length: options.passes }, (_, i) => ({ target: target.id, pass: i + 1, key: `${target.id}#${i + 1}` })));
		const ids = gateTargets.map((t) => t.id);
		const twinIds = twinTargetsRun.map((t) => t.id);
		// The official definition is pinned (plan item 2.8): the grid is judged
		// against the corpus its identity names, and read as official only when its
		// cells are exactly that corpus's shape and every pinned input matches.
		const comparePins = loadComparePins();
		// A grid launched as a kind is judged against that kind's corpus and
		// options; one without a kind, against the kindless (v5) corpus as before.
		let kind: GridKind | undefined;
		if (options.gridKind !== undefined) {
			kind = comparePins.gridKinds[options.gridKind];
			if (!kind) throw new Error(`--grid-kind ${options.gridKind} is not a grid kind of eval/delegation-compare.pins.json (known: ${Object.keys(comparePins.gridKinds).join(", ") || "none"})`);
		}
		const judged: [string, PinnedCorpus] | undefined = kind ? [kind.corpus, comparePins.corpora[kind.corpus]!] : kindlessCorpus(comparePins.corpora, ids);
		const officialShapes: OfficialShape[] = judged && shapeOf(judged[1]) ? [shapeOf(judged[1])!] : [];
		const gridOfficial = isOfficialGrid(expectedCells, officialShapes);
		if (kind) {
			exploratoryReasons.push(...gridKindReasons(options.gridKind!, kind, {
				...options, retry: options.retryPolicy !== undefined,
			}));
		}
		if (!judged) exploratoryReasons.push("eval/delegation-compare.pins.json pins no corpus a grid without --grid-kind can be official on");
		else {
			exploratoryReasons.push(...corpusReasons(judged[0], judged[1], {
				gateIds: ids, passes: options.passes, selected: options.selected.length > 0, manifestSha256: info.manifestHash,
				targets: info.targets.map((t) => ({ id: t.id, name: t.name, truthSha256: info.truthHashes[t.id]! })),
				...(info.twinsHash === undefined ? {} : { twinsSha256: info.twinsHash }),
			}));
		}
		manifest.provider = provider;
		manifest.targets = info.targets.map(manifestTargetEntry);
		manifest.promptSha256ByTarget = Object.fromEntries(info.targets.map((t) => [t.id, sha256(promptFor(t))]));
		manifest.expectedCells = expectedCells;
		manifest.schedule = planSchedule(ids, options.passes, twinSchedule(options, twinIds)).map((p) => ({ key: p.key, order: p.order, ...(p.twin ? { twin: true } : {}) }));
		manifest.inputs = {
			corpusManifest: { path: options.manifestPath, sha256: info.manifestHash },
			...(info.twinsHash === undefined ? {} : { twinsManifest: { path: options.twinsPath, sha256: info.twinsHash } }),
			corpus: options.corpus, truth: options.truth,
			sourceSha256: info.sourceHashes, truthSha256: info.truthHashes,
		};
		return {
			value: { ...info, provider, expectedCells, gridOfficial, officialShapes, comparePins, twinIds, kind },
			record: { targets: ids.length, ...(twinIds.length ? { twins: twinIds.length } : {}), gridOfficial },
		};
	});

	// 1b. An OAuth token that could expire before the grid ends would be refreshed
	// inside a cell, under a lock no other process takes (checkAuthHorizon). Read
	// here, outside every seal, and only for its expiry.
	await stage("auth", async () => {
		const authText = await readFile(join(AGENT_BASE, "auth.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		const worstCaseMs = gridWorstCaseMs({
			passes: options.passes, targets: inputs.targets.length - inputs.twinIds.length, concurrency: options.concurrency, timeoutMs: options.timeoutMs,
			...(options.breaker === undefined ? {} : { breaker: options.breaker }),
			...(options.matched === undefined ? {} : { matchedSessions: options.matched.kMax }),
			...(inputs.twinIds.length && options.twinArms ? { twins: inputs.twinIds.length, twinArms: options.twinArms.length } : {}),
		});
		const verdict = checkAuthHorizon({
			provider: options.provider, credential: credentialExpiry(authText, options.provider), worstCaseMs,
			...(options.authHorizonHours === undefined ? {} : { requestedHours: options.authHorizonHours }),
			nowMs: Date.now(), piCli: join(PI_PACKAGE, "dist/cli.js"),
		});
		manifest.authHorizon = verdict.record;
		if (!verdict.ok) throw new Error(verdict.error);
		return { value: undefined, record: verdict.record };
	});

	// 2. Stage each arm once, redacting the corpus references pired's own source
	// carries, and prove the baseline is the pinned commit, the candidate its
	// pinned snapshot, and the pi-subagents tree the candidate loads its pin.
	const staging = await stage("staging", async () => {
		const { comparePins } = inputs;
		const source = {
			baseline: await treeManifest(options.baseline, "snapshot"),
			candidate: await treeManifest(options.candidate, "snapshot"),
		};
		// One snapshot in both arms is a mistake unless the arms differ in their
		// scope (plan item 2.8): stage 2 runs the candidate snapshot as S in the
		// baseline arm and as D in the candidate arm, apart only in delegation.
		const sameSnapshot = source.baseline.digest === source.candidate.digest;
		const configsDiffer = JSON.stringify(armSettings(options, "baseline")) !== JSON.stringify(armSettings(options, "candidate"));
		if (sameSnapshot && !configsDiffer) throw new Error("Baseline and candidate snapshots are identical.");
		const redactTerms = await redactTermsFor(inputs.targets, options.truth);
		// One staged copy per arm at preflight, under opaque names, only to compute
		// and record the redacted digest and the redaction list. Each cell later
		// stages its own fresh copy and must reproduce these digests exactly.
		const stagePaths: Record<PairArm, string> = {
			baseline: join(preflightRoot, "stage", opaqueToken()),
			candidate: join(preflightRoot, "stage", opaqueToken()),
		};
		const staged: Record<PairArm, Awaited<ReturnType<typeof stageSnapshot>>> = {
			baseline: await stageSnapshot(options.baseline, stagePaths.baseline, { redactTerms, nodeModules: PI_NODE_MODULES }),
			candidate: await stageSnapshot(options.candidate, stagePaths.candidate, { redactTerms, nodeModules: PI_NODE_MODULES }),
		};
		for (const arm of ["baseline", "candidate"] as const) {
			if (staged[arm].sourceDigest !== source[arm].digest) throw new Error(`Staged ${arm} snapshot's pre-redaction digest does not match its input.`);
		}
		if (!sameSnapshot && staged.baseline.stagedDigest === staged.candidate.stagedDigest) throw new Error("Redacted baseline and candidate snapshots are identical.");
		// Pin identity: the baseline must be git 496b190's staged content and the
		// candidate the frozen handoff snapshot, or the grid is exploratory.
		const { kind } = inputs;
		let baselineReason = "";
		let baselineCommitPin: string | null = comparePins.baselineCommit;
		const candidateDigestPin = kind ? kind.candidate.digest : comparePins.candidateDigest;
		if (kind) {
			// The kind pins its own snapshots and caps (plan item 2.8); its arm
			// options were checked with the inputs.
			baselineCommitPin = "commit" in kind.baseline ? kind.baseline.commit : null;
			exploratoryReasons.push(...kindSnapshotReasons(options.gridKind!, kind, {
				baselineDigest: source.baseline.digest, candidateDigest: source.candidate.digest,
				commitReason: (commit) => (baselineReason = baselineMismatchReason(source.baseline.rows, commit)),
			}));
		} else {
			baselineReason = baselineMismatchReason(source.baseline.rows, comparePins.baselineCommit);
			if (baselineReason) exploratoryReasons.push(baselineReason);
			if (comparePins.candidateDigest === null) exploratoryReasons.push("no candidate is frozen: eval/delegation-compare.pins.json has candidateDigest null");
			else if (source.candidate.digest !== comparePins.candidateDigest) exploratoryReasons.push(`candidate input digest ${source.candidate.digest.slice(0, 12)} is not the pinned ${comparePins.candidateDigest.slice(0, 12)}`);
			const capReason = workerCapReason(comparePins.candidateMaxAgents, options.candidateMaxAgents);
			if (capReason) exploratoryReasons.push(capReason);
			exploratoryReasons.push(...kindlessArmReasons(options));
		}
		const piSubagents = await measurePiSubagents(comparePins);
		exploratoryReasons.push(...piSubagents.reasons);
		const inputsRecord = manifest.inputs as JsonRecord;
		inputsRecord.baseline = { path: options.baseline, sha256: source.baseline.digest, files: source.baseline.files, stagedDigest: staged.baseline.stagedDigest, redactions: staged.baseline.redactions, stagedPath: stagePaths.baseline, matchesCommit: baselineCommitPin, baselineMismatch: baselineReason || null };
		inputsRecord.candidate = { path: options.candidate, sha256: source.candidate.digest, files: source.candidate.files, stagedDigest: staged.candidate.stagedDigest, redactions: staged.candidate.redactions, stagedPath: stagePaths.candidate, pinnedDigest: candidateDigestPin, matchesPin: source.candidate.digest === candidateDigestPin };
		// Written only for a grid that runs one snapshot in both arms, so every other manifest keeps its bytes.
		if (sameSnapshot) inputsRecord.sameSnapshotInBothArms = true;
		inputsRecord.piSubagents = { ...piSubagents.install, pinnedVersion: comparePins.piSubagents.version, pinnedDigest: comparePins.piSubagents.digest, matchesPin: piSubagents.reasons.length === 0 };
		// The matched arm runs the candidate snapshot unless the operator names
		// another, which is exploratory: matched vs candidate would then differ in
		// more than delegation. Without --matched nothing here is recorded.
		let matched = { path: options.candidate, digest: source.candidate.digest, stagedDigest: staged.candidate.stagedDigest };
		if (options.matched) {
			const missing = targetsWithoutBudget(options.matched, inputs.targets.map((t) => t.id));
			if (missing.length) throw new Error(`--matched mode fixed names no budget for ${missing.join(", ")}`);
			const override = options.matched.snapshot;
			let stagedPath = stagePaths.candidate;
			if (override !== undefined && resolve(override) !== resolve(options.candidate)) {
				const overrideSource = await treeManifest(override, "snapshot");
				stagedPath = join(preflightRoot, "stage", opaqueToken());
				const overrideStaged = await stageSnapshot(override, stagedPath, { redactTerms, nodeModules: PI_NODE_MODULES });
				if (overrideStaged.sourceDigest !== overrideSource.digest) throw new Error("Staged matched snapshot's pre-redaction digest does not match its input.");
				matched = { path: override, digest: overrideSource.digest, stagedDigest: overrideStaged.stagedDigest };
				if (overrideSource.digest !== source.candidate.digest) exploratoryReasons.push(`the matched arm runs snapshot ${overrideSource.digest.slice(0, 12)}, not the candidate's ${source.candidate.digest.slice(0, 12)}`);
			}
			inputsRecord.matched = { path: matched.path, sha256: matched.digest, stagedDigest: matched.stagedDigest, stagedPath, sameAsCandidate: matched.digest === source.candidate.digest, policy: options.matched };
		}
		return {
			value: {
				sourceSnapshots: { baseline: options.baseline, candidate: options.candidate, matched: matched.path },
				sourceDigests: { baseline: source.baseline.digest, candidate: source.candidate.digest, matched: matched.digest },
				stagedDigests: { baseline: staged.baseline.stagedDigest, candidate: staged.candidate.stagedDigest, matched: matched.stagedDigest },
				redactTerms, piSubagents: piSubagents.install,
			},
			record: {
				baseline: source.baseline.digest, candidate: source.candidate.digest, redactedBaseline: staged.baseline.stagedDigest, redactedCandidate: staged.candidate.stagedDigest, redactTerms: redactTerms.length, piSubagents: `${piSubagents.install.version} ${piSubagents.install.digest.slice(0, 12)}`,
				...(options.matched ? { matched: matched.digest, redactedMatched: matched.stagedDigest } : {}),
			},
		};
	});

	// The official decision is the official grid shape AND every pinned input.
	const official = inputs.gridOfficial && exploratoryReasons.length === 0;
	manifest.official = official;
	manifest.decisionScope = official ? "official" : "exploratory";
	manifest.exploratoryReasons = exploratoryReasons;
	await saveManifest();

	// 3. Runtime, harness and grader pins, including the dde9bfa scorer blob guard.
	const pins = await stage("pins", async () => {
		const runtime = await runtimePins(options.fsSeal, staging.piSubagents);
		const frozen: FrozenPins = { ...runtime };
		for (const target of inputs.targets) frozen[`source:${target.id}`] = inputs.sourceHashes[target.id]!;
		manifest.pins = frozen;
		return { value: frozen, record: { graderSourceGitBlob: runtime.graderSourceGitBlob, harness: runtime.harnessSha256 } };
	});

	const ctx: Context = {
		options, out: options.out, provider: inputs.provider, pins,
		sourceSnapshots: staging.sourceSnapshots, sourceDigests: staging.sourceDigests,
		stagedDigests: staging.stagedDigests, redactTerms: staging.redactTerms, nodePath,
		piSubagents: staging.piSubagents,
	};

	// 4. systemd user scopes hold and kill a marker-stripped setsid stray, Landlock
	// denies both answer-key locations for every target, and no sealed process can
	// reach an IPC broker, sees a broker address, or fails DNS/TLS to the provider.
	await stage("seal", async () => {
		const records: JsonRecord[] = [];
		// First, because every later sealed probe and every cell runs in a scope.
		const scope = await checkScopeReaping(options, nodePath, preflightRoot);
		manifest.scopeCheck = scope;
		for (const [index, target] of inputs.targets.entries()) records.push(await checkSeal(options, target, index, nodePath, preflightRoot));
		const escape = await checkEscapeVectors(options, nodePath, preflightRoot);
		const network = await checkNetwork(options, inputs.provider, nodePath, preflightRoot);
		manifest.filesystemSeal = records;
		manifest.escapeVectorCheck = escape;
		manifest.networkCheck = network;
		return { value: undefined, record: { targets: records.length, scopes: "reaped", escapeVectors: "denied", network: network.status ?? "reached" } };
	});

	// 5. The grader, end to end through the scoring path a run uses: an empty
	// ledger must read as zero claims, an oracle claim as a true positive. A
	// grader that fails silently would otherwise score every arm 0 and look fair.
	await stage("grader", async () => {
		const records: JsonRecord[] = [];
		for (const [index, target] of inputs.targets.entries()) {
			const dir = join(preflightRoot, "preflight", `grader-${index + 1}`);
			const emptyWorkspace = join(dir, "empty-workspace");
			await mkdir(emptyWorkspace, { recursive: true });
			const empty = await scoreWorkspace(emptyWorkspace, join(dir, "empty.score.json"), target.truth);
			if (!empty.graded.ok) throw new Error(`${target.id}: empty ledger: ${empty.graded.error}`);
			if (empty.graded.totalFindings !== 0 || empty.graded.truePositives !== 0) throw new Error(`${target.id}: empty ledger scored ${empty.graded.truePositives}/${empty.graded.totalFindings}`);
			if (target.twinOf !== undefined) {
				// A patched twin's key has no labels (plan item 2.8), so there is no
				// oracle: a claim must count as a claim and never as a true positive.
				const decoy: Finding = { file: "README.md", line: 1 };
				const graded = await gradeWithPinnedScorer([decoy], join(dir, "decoy.score.json"), target.truth);
				if (!graded.ok) throw new Error(`${target.id}: decoy on a patched twin: ${graded.error}`);
				if (graded.truePositives !== 0 || graded.totalFindings !== 1) throw new Error(`${target.id}: a claim on a patched twin scored ${graded.truePositives}/${graded.totalFindings}, not 0/1`);
				records.push({ target: target.id, twinOf: target.twinOf, empty: { totalFindings: 0, truePositives: 0 }, decoy: { ...decoy, truePositives: 0, totalFindings: 1 } });
				continue;
			}
			const truth = JSON.parse(await readFile(target.truth, "utf8")) as Array<{ file?: unknown; line?: unknown; line_range?: unknown }>;
			const first = truth[0];
			const range = Array.isArray(first?.line_range) ? first.line_range.map(Number) : [Number(first?.line), Number(first?.line)];
			const [lo, hi] = [range[0], range[1] ?? range[0]];
			if (typeof first?.file !== "string" || !Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) throw new Error(`${target.id}: first truth entry has no file and line range`);
			const oracleFinding: Finding = { file: first.file, line: Math.floor((lo! + hi!) / 2) };
			const oracle = await gradeWithPinnedScorer([oracleFinding], join(dir, "oracle.score.json"), target.truth);
			if (!oracle.ok) throw new Error(`${target.id}: oracle: ${oracle.error}`);
			if (oracle.truePositives < 1) throw new Error(`${target.id}: an oracle finding at ${oracleFinding.file}:${oracleFinding.line} scored no true positive`);
			records.push({
				target: target.id, empty: { totalFindings: 0, truePositives: 0 },
				oracle: { file: oracleFinding.file, line: oracleFinding.line, truePositives: oracle.truePositives, totalFindings: oracle.totalFindings },
			});
		}
		manifest.grader = records;
		return { value: undefined, record: { targets: records.length } };
	});

	// 6. The real per-cell entry command, sealed, for every target and both arms,
	// stopped before any model call: the seal, pired's workspace resolution and
	// the tool surface are checked as they will actually run.
	await stage("probe", async () => {
		const probesRoot = join(preflightRoot, "preflight", "probes");
		const decoyDir = join(probesRoot, opaqueToken());
		await mkdir(decoyDir, { recursive: true });
		await writeFile(join(decoyDir, "run.json"), "{\"decoy\":true}\n");
		const records: JsonRecord[] = [];
		const failures: string[] = [];
		const resolved: BenchmarkRuntime[] = [];
		let previous: PreparedCell | undefined;
		// The matched arm is probed too when the grid runs one: its seal and tool
		// surface (pi-subagents loaded, cap 0) are checked before any token.
		const probeArms: Arm[] = ["baseline", "candidate", ...(options.matched ? ["matched" as const] : [])];
		for (const target of inputs.targets) {
			// A patched twin runs only in its twin arms, so only those are probed on it.
			for (const arm of target.twinOf === undefined ? probeArms : options.twinArms ?? []) {
				const absent: string[] = [];
				const cell = await prepareCell(ctx, target, 0, arm, probesRoot, async (paths) => {
					// Each cell now stages its own snapshot under its own cellDir, so there is
					// no shared per-arm staged tree to deny; instead the previous cell's
					// staged snapshot (its <cellDir>/pired) must be unreadable from this one.
					const deniedCandidates = [
						target.truth, join(options.corpus, `${target.name}.truth.json`), options.truth, options.corpus,
						options.manifestPath, join(options.out, "manifest.json"), join(preflightRoot, "manifest.json"),
						join(decoyDir, "run.json"), decoyDir,
						...(previous ? [previous.configPath, previous.transcriptPath, previous.cellDir, previous.workspaceDir, previous.stagedSnapshot, previous.childSessionDir] : []),
						// Granted to the candidate alone; the baseline must not see it.
						...(arm === "baseline" ? [ctx.piSubagents.entry] : []),
						join(HOME, ".pired/engagements"), "/tmp/pired-research",
						join(AGENT_BASE, "sessions"), join(AGENT_BASE, "run-history.jsonl"),
					];
					const readDenied: string[] = [];
					for (const path of [...new Set(deniedCandidates)]) (await exists(path) ? readDenied : absent).push(path);
					const truth = JSON.parse(await readFile(target.truth, "utf8")) as Array<{ file?: unknown }>;
					// A patched twin's key is empty; the files its fix touched are in its tree.
					const fixed = Array.isArray(target.fixed_regions) ? (target.fixed_regions as Array<{ file?: unknown }>).map((r) => r.file) : [];
					const sourceFile = await firstReadableFile(paths.targetDir, [
						...[...truth.map((t) => t.file), ...fixed].filter((f): f is string => typeof f === "string"), "README.md",
					]);
					if (!sourceFile) throw new Error(`${target.id}: target copy has no readable file`);
					return { readDenied, readAllowed: [sourceFile, paths.workspaceDir, paths.configPath, ...(loadsSubagents(arm) ? [ctx.piSubagents.entry] : [])] };
				});
				const launched = await launch(ctx, cell, PROBE_TIMEOUT_MS, () => !runState.aborted);
				const verdict = await inspectProbe(ctx, cell, launched);
				if (verdict.runtime) resolved.push(verdict.runtime);
				records.push({ ...verdict.record, absentDeniedPaths: absent });
				failures.push(...verdict.errors.map((e) => `${target.id} ${arm}: ${e}`));
				console.log(`probe ${target.id} ${arm}: ${verdict.errors.length ? "FAILED" : "ok"}`);
				previous = cell;
			}
		}
		manifest.probes = records;
		if (failures.length) throw new Error(failures.join("\n"));
		// Every probe must have resolved the same model definition; it is pinned,
		// compared by a resume, and required of every scored run.
		const distinct = [...new Set(resolved.map((r) => JSON.stringify(r)))];
		if (resolved.length !== records.length || distinct.length !== 1) throw new Error(`probes resolved ${distinct.length} different model runtimes over ${resolved.length}/${records.length} probes: ${distinct.join(" | ")}`);
		pins.benchmarkRuntime = resolved[0]!;
		return { value: undefined, record: { cells: records.length, benchmarkRuntime: pins.benchmarkRuntime } };
	});

	// 7. One scripted delegation, sealed, in the candidate arm of the first target:
	// pired's agents are registered, a worker runs through pi-subagents, its
	// record lands in the parent's ledger, pired's gate blocks it, and its
	// session reconciles with the parent's result — all before any token.
	await stage("delegation", async () => {
		const target = inputs.targets[0]!;
		const root = join(preflightRoot, "preflight", "delegation");
		const cell = await prepareCell(ctx, target, 0, "candidate", root, async (paths) => {
			const sourceFile = await firstReadableFile(paths.targetDir, ["README.md"]);
			if (!sourceFile) throw new Error(`${target.id}: target copy has no readable file`);
			const readDenied: string[] = [];
			for (const path of [target.truth, join(options.corpus, `${target.name}.truth.json`)]) if (await exists(path)) readDenied.push(path);
			return {
				mode: "delegation", readDenied, readAllowed: [sourceFile, paths.childSessionDir, ctx.piSubagents.entry],
				delegation: {
					agent: PROBE_AGENT, recordFile: relative(paths.targetDir, sourceFile).split("\\").join("/"),
					recordPath: `/pired-probe-${opaqueToken()}`,
					// 10.66.66.66 is outside the probe scope (loopback only); if pired's gate
					// let the command through, the marker would be written.
					blockedCommand: `curl -s --max-time 2 http://10.66.66.66/ ; echo ran > ${join(paths.tmpDir, "gate-marker")}`,
					markerPath: join(paths.tmpDir, "gate-marker"),
					childSessionDir: paths.childSessionDir,
				},
			};
		});
		const launched = await launch(ctx, cell, PROBE_TIMEOUT_MS, () => !runState.aborted);
		const verdict = await inspectDelegationProbe(ctx, cell, launched);
		manifest.delegationProbe = verdict.record;
		console.log(`delegation probe ${target.id} candidate: ${verdict.errors.length ? "FAILED" : "ok"}`);
		if (verdict.errors.length) throw new Error(verdict.errors.join("\n"));
		return { value: undefined, record: { target: target.id, agent: PROBE_AGENT, childSessionFiles: (verdict.record.childSessionFiles as unknown[]).length, usage: verdict.record.usage } };
	});

	// 8. The matched arm's token ceiling, sealed, against a scripted reply that
	// records one element and crosses a one-token ceiling: the record lands, no
	// second request is made, and the accounting accepts the cut. Only for a grid
	// that runs the arm.
	if (options.matched) {
		const matchedPolicy = options.matched;
		await stage("ceiling", async () => {
			const target = inputs.targets[0]!;
			const root = join(preflightRoot, "preflight", "ceiling");
			const session: MatchedSessionSpec = { index: 1, k: matchedPolicy.k, kMax: matchedPolicy.kMax, sessionAttempt: 1, budget: 1, ceiling: 1, spentBefore: 0, budgetSource: "fixed", candidateCellId: null };
			const cell = await prepareCell(ctx, target, 0, "matched", root, async (paths) => {
				const sourceFile = await firstReadableFile(paths.targetDir, ["README.md"]);
				if (!sourceFile) throw new Error(`${target.id}: target copy has no readable file`);
				const readDenied: string[] = [];
				for (const path of [target.truth, join(options.corpus, `${target.name}.truth.json`)]) if (await exists(path)) readDenied.push(path);
				return { mode: "ceiling", readDenied, readAllowed: [sourceFile], ceiling: { recordFile: relative(paths.targetDir, sourceFile).split("\\").join("/"), recordPath: `/pired-ceiling-${opaqueToken()}` } };
			}, session);
			const launched = await launch(ctx, cell, PROBE_TIMEOUT_MS, () => !runState.aborted);
			const verdict = await inspectCeilingProbe(ctx, cell, launched);
			manifest.ceilingProbe = verdict.record;
			console.log(`ceiling probe ${target.id} matched: ${verdict.errors.length ? "FAILED" : "ok"}`);
			if (verdict.errors.length) throw new Error(verdict.errors.join("\n"));
			return { value: undefined, record: { target: target.id, requests: verdict.record.requests, stop: verdict.record.stop } };
		});
	}

	preflight.status = "passed";
	await saveManifest();
	return { ctx, targets: inputs.targets, expectedCells: inputs.expectedCells, official, exploratoryReasons, officialShapes: inputs.officialShapes };
}

/**
 * The RunMetric a comparison reads, reconstructed from a persisted run record
 * (for resumed pairs). Its tokens are what the gate reads: under a retry policy
 * the metered count plus the estimate for unmetered attempts, otherwise the
 * metered count. `metered` reads the metered count alone, for the comparison
 * reported beside the gate.
 */
export function metricFromRecord(record: JsonRecord, tokens: "gate" | "metered" = "gate"): RunMetric {
	const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
	const count = tokens === "gate" && record.totalTokensWithRetryEstimate !== undefined ? record.totalTokensWithRetryEstimate : record.totalTokens;
	return {
		key: String(record.key ?? ""), target: String(record.target ?? ""), pass: Number(record.pass ?? 0),
		valid: record.valid === true,
		truePositives: num(record.truePositives), precision: num(record.precisionLowerBound),
		totalClaims: num(record.findings),
		totalTokens: count === null || count === undefined ? Number.NaN : num(count),
	};
}

export interface ResumePlan {
	/** Pair keys to re-run: an arm missing, or an arm invalid for an infra reason. Both arms, fresh cells. */
	rerunKeys: string[];
	/** Pair keys invalid for a non-infra reason. They stay invalid; the grid cannot approve. */
	blockedKeys: string[];
	/** Pair keys whose two arms are both valid at the pair's highest attempt; those records are carried unchanged. */
	keepKeys: string[];
	/** Pair keys still failing at the breaker's attempt ceiling. Never re-run; the grid cannot approve. Always empty without a ceiling. */
	abandonedKeys: string[];
	/** The attempt number the next run of a rerun pair gets. */
	nextAttempt: Record<string, number>;
	/** `${pairKey}\u0000${arm}` -> that arm's record at its pair's highest attempt (absent when the arm has none there). */
	latest: Record<string, JsonRecord>;
	reasons: Record<string, string>;
}

/**
 * Decide, from a stopped grid's persisted runs, which pairs a --resume re-runs.
 *
 * Each pair is judged only at its highest attempt, never by mixing attempts: a
 * newest-per-arm rule kept a pair whose attempt-2 baseline had finished and
 * whose attempt-2 candidate never ran, and compared it with the attempt-1
 * candidate measured hours earlier in another provider window. At that attempt
 * a pair is kept when both arms are valid; blocked when an arm is invalid for a
 * non-infrastructure reason (it stays invalid, so the grid cannot approve:
 * re-running it would chase a candidate defect with more tokens); and otherwise
 * (an arm missing there, or invalid for infrastructure) re-run, both arms, at
 * the next attempt. Two rows for one arm at one attempt resolve to the last line
 * written. Pure: takes the schedule and the run records, touches no disk.
 */
export function planResume(pairs: ScheduledPair[], runs: JsonRecord[], attemptCeiling?: number): ResumePlan {
	const maxAttempt: Record<string, number> = {};
	const rows: Array<{ key: string; arm: Arm; attempt: number; run: JsonRecord }> = [];
	for (const run of runs) {
		const key = typeof run.key === "string" ? run.key : undefined;
		const arm = run.arm === "baseline" || run.arm === "candidate" ? run.arm : undefined;
		if (!key || !arm) continue;
		const attempt = typeof run.attempt === "number" ? run.attempt : 1;
		rows.push({ key, arm, attempt, run });
		maxAttempt[key] = Math.max(maxAttempt[key] ?? 0, attempt);
	}
	const latest: Record<string, JsonRecord> = {};
	for (const row of rows) if (row.attempt === maxAttempt[row.key]) latest[`${row.key}\u0000${row.arm}`] = row.run;
	const plan: ResumePlan = { rerunKeys: [], blockedKeys: [], keepKeys: [], abandonedKeys: [], nextAttempt: {}, latest, reasons: {} };
	for (const pair of pairs) {
		// A patched twin counts when its twin arms are valid at one attempt (plan item 2.8).
		const arms = armsOfPair(pair).map((arm) => latest[`${pair.key}\u0000${arm}`])
			.map((r) => r && { valid: r.valid === true, infra: r.infraFailure === true });
		const attempt = maxAttempt[pair.key] ?? 0;
		// No requeue context: a resume is the operator's decision to spend more on
		// the pair, so it waits no cooldown and applies no per-runner attempt cap.
		// The ceiling does apply, or an auto-resumer could re-run a pair forever.
		const action = nextPairAction(attempt, arms, attemptCeiling === undefined ? {} : { attemptCeiling });
		if (action.kind === "keep") {
			plan.keepKeys.push(pair.key);
		} else if (action.kind === "blocked") {
			plan.blockedKeys.push(pair.key);
			plan.reasons[pair.key] = action.reason;
		} else if (action.kind === "abandoned") {
			plan.abandonedKeys.push(pair.key);
			plan.reasons[pair.key] = action.reason;
		} else {
			plan.rerunKeys.push(pair.key);
			plan.nextAttempt[pair.key] = attempt + 1;
			plan.reasons[pair.key] = action.reason;
		}
	}
	return plan;
}

/** Identity fields a resume must find byte-identical between the grid's original manifest and its own recomputation. */
export function resumeMismatches(prior: JsonRecord, fresh: JsonRecord): string[] {
	const diffs: string[] = [];
	const eq = (label: string, a: unknown, b: unknown): void => { if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) diffs.push(label); };
	// The probe-resolved model runtime is reported under its own name: a models.json
	// edit (contextWindow, maxTokens, endpoint) is a different fault from a harness edit.
	// So is the pinned pi-subagents install: a re-installed or edited tree is a
	// different candidate, not a harness change, and the refusal should say so.
	const subagentFields = (pins: JsonRecord): JsonRecord => Object.fromEntries(Object.entries(pins).filter(([k]) => k.startsWith("piSubagents")));
	const { benchmarkRuntime: priorRuntime, ...priorPins } = (prior.pins ?? {}) as JsonRecord;
	const { benchmarkRuntime: freshRuntime, ...freshPins } = (fresh.pins ?? {}) as JsonRecord;
	const withoutSubagents = (pins: JsonRecord): JsonRecord => Object.fromEntries(Object.entries(pins).filter(([k]) => !k.startsWith("piSubagents")));
	eq("pins", prior.pins === undefined ? undefined : withoutSubagents(priorPins), fresh.pins === undefined ? undefined : withoutSubagents(freshPins));
	eq("pins.piSubagents", subagentFields(priorPins), subagentFields(freshPins));
	eq("pins.benchmarkRuntime", priorRuntime, freshRuntime);
	eq("provider", prior.provider, fresh.provider);
	eq("prompt", prior.prompt, fresh.prompt);
	eq("promptSha256ByTarget", prior.promptSha256ByTarget, fresh.promptSha256ByTarget);
	eq("schedule", prior.schedule, fresh.schedule);
	eq("passes", prior.passes, fresh.passes);
	// The cap is half of what the candidate arm is; pairs run under two caps
	// would be two candidates pooled into one comparison.
	eq("candidateMaxAgents", prior.candidateMaxAgents, fresh.candidateMaxAgents);
	// The same for every arm's scope (plan item 2.8): pairs run under two
	// configurations of one arm would be two arms pooled into one.
	eq("baselineMaxAgents", prior.baselineMaxAgents, fresh.baselineMaxAgents);
	eq("maxVerifiers", prior.maxVerifiers, fresh.maxVerifiers);
	eq("budgetArms", prior.budgetArms, fresh.budgetArms);
	// Twin runs under two sets of arms, or of two twins files, would not add up to one control.
	eq("twinArms", prior.twinArms, fresh.twinArms);
	// A grid that claimed a kind is judged by it; resumed as another it would be two grids.
	eq("gridKind", prior.gridKind, fresh.gridKind);
	// A grid that re-queued and stopped under one policy, then resumed under
	// another, would be one grid run under two stopping rules.
	eq("breaker", prior.breaker, fresh.breaker);
	// A retried attempt is a failure without a policy and a count with one; half
	// a grid read one way and half the other would not compare.
	eq("retryPolicy", prior.retryPolicy, fresh.retryPolicy);
	// The matched arm's mode, k and budgets: sessions run under two policies
	// would be two arms unioned into one.
	eq("matched", prior.matched, fresh.matched);
	const pr = (prior.requested ?? {}) as JsonRecord;
	const fr = (fresh.requested ?? {}) as JsonRecord;
	for (const k of ["provider", "model", "thinking", "passes", "only"]) eq(`requested.${k}`, pr[k], fr[k]);
	const pi = (prior.inputs ?? {}) as JsonRecord;
	const fi = (fresh.inputs ?? {}) as JsonRecord;
	eq("inputs.sourceSha256", pi.sourceSha256, fi.sourceSha256);
	eq("inputs.truthSha256", pi.truthSha256, fi.truthSha256);
	eq("inputs.corpusManifest.sha256", (pi.corpusManifest as JsonRecord | undefined)?.sha256, (fi.corpusManifest as JsonRecord | undefined)?.sha256);
	eq("inputs.twinsManifest.sha256", (pi.twinsManifest as JsonRecord | undefined)?.sha256, (fi.twinsManifest as JsonRecord | undefined)?.sha256);
	for (const arm of ["baseline", "candidate", ...(prior.matched !== undefined || fresh.matched !== undefined ? ["matched"] : [])]) {
		const pa = (pi[arm] ?? {}) as JsonRecord;
		const fa = (fi[arm] ?? {}) as JsonRecord;
		eq(`inputs.${arm}.sha256`, pa.sha256, fa.sha256);
		eq(`inputs.${arm}.stagedDigest`, pa.stagedDigest, fa.stagedDigest);
	}
	return diffs;
}

async function ensureEmptyOutput(out: string): Promise<void> {
	const entries = await readdir(out).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [] as string[];
		throw error;
	});
	// A reused directory could hand the grader a stale score file or the summary
	// a run from a different harness; every invocation starts from nothing.
	if (entries.length) throw new Error(`--out must be a new or empty directory: ${out}`);
	await mkdir(out, { recursive: true });
	// Claim the directory atomically before writing anything else: a non-recursive
	// mkdir of the lock entry fails with EEXIST for a second runner that raced past
	// the emptiness check with the same --out, so only one runner proceeds.
	try { await mkdir(join(out, ".pired-compare.lock")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`--out is already claimed by another runner: ${out}`);
		throw error;
	}
	await writeFile(join(out, ".pired-compare.lock", "pid"), `${process.pid}\n`).catch(() => undefined);
}

/** Set once the grid finished normally, so the top-level catch never marks a finished grid crashed. */
let gridFinished = false;

/** A preflight or resume refusal that already wrote its own terminal status; the top-level catch must not overwrite it. */
class ResumeRefusedError extends Error {}

type OwnerRecord = { pid: number; startTime: string; title: string; mode: string; claimedAt: string };

/** The owner record this process wrote, so only its own claim is ever released. */
let ownerClaim: { path: string; record: OwnerRecord } | undefined;

export function parseOwnerRecord(text: string): OwnerRecord | undefined {
	const row = parseJsonObject(text.trim());
	if (!row || typeof row.pid !== "number" || typeof row.startTime !== "string" || typeof row.title !== "string") return undefined;
	return { pid: row.pid, startTime: row.startTime, title: row.title, mode: String(row.mode ?? ""), claimedAt: String(row.claimedAt ?? "") };
}

/**
 * Whether the recorded owner is the same process still running: the pid exists,
 * the kernel's start time for it is the one recorded (so a reused pid does not
 * count), and its title is this runner's.
 */
export function ownerIsLive(recorded: Pick<OwnerRecord, "pid" | "startTime">, observed: { startTime?: string; title?: string }): boolean {
	return observed.startTime !== undefined && observed.startTime === recorded.startTime && observed.title === RUNNER_TITLE;
}

async function processTitle(pid: number): Promise<string | undefined> {
	try { return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0]?.trim(); }
	catch { return undefined; }
}

async function observeProcess(pid: number): Promise<{ startTime?: string; title?: string }> {
	const [startTime, title] = await Promise.all([processStartTime(pid), processTitle(pid)]);
	return { ...(startTime === undefined ? {} : { startTime }), ...(title === undefined ? {} : { title }) };
}

/**
 * A grid started before owner records existed names its runner only in
 * progress.json, and wrote that file only at the end of each arm, so a live
 * two-hour arm looked exactly like a dead runner. Refuse while that pid is
 * alive under this runner's title.
 */
async function refuseLegacyOwner(out: string): Promise<void> {
	if (await exists(join(out, OWNER_FILE))) return;
	const progress = parseJsonObject(await readFile(join(out, "progress.json"), "utf8").catch(() => ""));
	if (!progress || progress.status !== "running" || typeof progress.pid !== "number") return;
	const observed = await observeProcess(progress.pid);
	if (observed.startTime !== undefined && observed.title === RUNNER_TITLE) {
		throw new Error(`refusing: progress.json names runner pid ${progress.pid}, which is alive as ${RUNNER_TITLE}. Wait for it to finish or stop it with SIGINT; a resume beside a live grid would launch its in-flight pairs a second time.`);
	}
}

/**
 * Claim <out> exclusively for this process. The owner file is created with
 * O_CREAT|O_EXCL, so of two runners racing for it one gets EEXIST. An existing
 * record whose runner is gone (pid dead, reused, or not this runner) is moved
 * aside atomically and re-read, so a claim a racing resume made in between is
 * put back rather than deleted. Without this a resume beside a live grid re-ran
 * its in-flight pairs, doubling concurrency against the same provider window,
 * and both runners appended rows with the same attempt number.
 */
async function claimOwner(out: string, mode: string): Promise<void> {
	const path = join(out, OWNER_FILE);
	const startTime = await processStartTime(process.pid);
	if (!startTime) throw new Error("could not read this runner's start time from /proc/self/stat; refusing to claim the grid without an owner record a later resume can check");
	const record: OwnerRecord = { pid: process.pid, startTime, title: process.title, mode, claimedAt: new Date().toISOString() };
	await refuseLegacyOwner(out);
	for (let round = 0; round < 3; round++) {
		try {
			const handle = await open(path, "wx");
			try { await handle.writeFile(`${JSON.stringify(record)}\n`); }
			finally { await handle.close(); }
			ownerClaim = { path, record };
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const text = await readFile(path, "utf8").catch(() => undefined);
		if (text === undefined) continue;
		const recorded = parseOwnerRecord(text);
		if (!recorded) {
			// Created but not yet written, by a claimer that is either racing this one
			// right now or died between the two calls; only the latter is stale.
			const age = Date.now() - ((await stat(path).catch(() => undefined))?.mtimeMs ?? 0);
			if (age < 10_000) throw new Error(`refusing: ${out} is being claimed by another runner right now`);
		} else if (ownerIsLive(recorded, await observeProcess(recorded.pid))) {
			throw new Error(`refusing: runner pid ${recorded.pid} (${recorded.mode}, claimed ${recorded.claimedAt}) is alive and owns ${out}. Wait for it to finish or stop it with SIGINT; a resume beside a live grid would launch its in-flight pairs a second time.`);
		}
		const aside = `${path}.stale-${opaqueToken()}`;
		try { await rename(path, aside); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const moved = await readFile(aside, "utf8").catch(() => "");
		if (moved !== text) {
			await link(aside, path).catch(() => undefined);
			await rm(aside, { force: true });
			throw new Error(`refusing: another runner claimed ${out} while this one was checking it`);
		}
		await rm(aside, { force: true });
		console.log(`owner: runner pid ${recorded?.pid ?? "unknown"} that last owned ${out} is gone; claiming it`);
	}
	throw new Error(`could not claim ${out}: its owner record kept changing`);
}

/** Remove the owner record only if it is still this process's own claim. */
async function releaseOwner(): Promise<void> {
	const claim = ownerClaim;
	if (!claim) return;
	ownerClaim = undefined;
	const current = parseOwnerRecord(await readFile(claim.path, "utf8").catch(() => ""));
	if (current && current.pid === claim.record.pid && current.startTime === claim.record.startTime) await rm(claim.path, { force: true }).catch(() => undefined);
}

/**
 * Where this invocation reports its state, and the last state it reported. A
 * resume reports into resume-<n>/status.json until its pins match and its plan
 * is accepted, and only then takes over the grid's progress.json, so a refused
 * or failed resume leaves the grid's own status as the stopped run left it.
 */
const statusFile: { path?: string; record?: JsonRecord } = {};

function reportStatus(record: JsonRecord): Promise<void> {
	statusFile.record = record;
	const path = statusFile.path;
	if (!path) return Promise.resolve();
	return serially(() => writeJson(path, { ...record, pid: process.pid, pidStartTime: ownerClaim?.record.startTime ?? null, updatedAt: new Date().toISOString() }));
}

/**
 * Rewrite the last status every HEARTBEAT_MS. progress.json used to change only
 * when an arm finished, so during a two-hour arm (measured on the pilot: 17
 * minutes in, updatedAt was still the launch time) a live runner and a dead one
 * looked the same. The timer is unref'd so it never keeps the process alive.
 */
function startHeartbeat(): () => void {
	const timer = setInterval(() => {
		if (statusFile.path && statusFile.record) void reportStatus(statusFile.record).catch(() => undefined);
	}, HEARTBEAT_MS);
	timer.unref();
	return () => clearInterval(timer);
}

export function newManifest(options: Options, mode: string): JsonRecord {
	const id = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15) + `-${randomUUID().slice(0, 8)}`;
	return {
		schema: "pired-matched-delegation-compare/v2", id, createdAt: new Date().toISOString(), mode,
		requested: { provider: options.provider, model: options.model, thinking: options.thinking, passes: options.passes, only: options.selected, authHorizonHours: options.authHorizonHours ?? null },
		thinking: options.thinking, passes: options.passes, concurrency: options.concurrency, timeoutMs: options.timeoutMs,
		...(options.candidateMaxAgents === undefined ? {} : { candidateMaxAgents: options.candidateMaxAgents }),
		// Each per-arm option (plan item 2.8) is written only when it is set, so a
		// grid that uses none writes the manifest every earlier grid wrote.
		...(options.baselineMaxAgents === undefined ? {} : { baselineMaxAgents: options.baselineMaxAgents }),
		...(options.maxVerifiers === undefined ? {} : { maxVerifiers: options.maxVerifiers }),
		...(options.budgetArms === undefined ? {} : { budgetArms: options.budgetArms }),
		...(options.twinArms === undefined ? {} : { twinArms: options.twinArms }),
		...(options.gridKind === undefined ? {} : { gridKind: options.gridKind }),
		...(options.breaker === undefined ? {} : { breaker: options.breaker }),
		// Only a grid that asked for retries records a policy, so a grid without
		// one writes the v5 manifest, and a v5 manifest resumes with retries off.
		...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
		// Only a grid that asked for the matched arm records one.
		...(options.matched ? { matched: options.matched, matchedResumePolicy: MATCHED_RESUME_POLICY } : {}),
		prompt: REVIEW_PROMPT, resumePolicy: RESUME_POLICY,
		runtimeConfiguration: {
			globalExtensions: false, globalSkills: false, promptTemplates: false, contextFiles: false, theme: false, forcedDelegation: false, scribe: "off",
			settings: benchmarkSettings(options.retryPolicy), candidateExtensions: ["pi-subagents (pinned; see pins.piSubagents*)"],
			subagentConfig: subagentConfigFor("<cell>/child-sessions"),
		},
	};
}

async function main(): Promise<void> {
	const parsed = parseOptions(process.argv.slice(2));
	if (parsed === "help") { process.stdout.write(helpText()); return; }
	// /proc/<pid>/cmdline is world-readable and /proc is inside the seal's read
	// roots, so `ps` from a sealed bash call would show this runner's arguments —
	// including any `--only CVE-…`. Replace them before any child starts. The
	// owner record also relies on this title to recognise a live runner.
	process.title = RUNNER_TITLE;
	if (parsed.kind === "resume") return await resumeMain(parsed.dir);
	const options = parsed.options;
	const outHits = findLeaks({ "--out": options.out }, []);
	if (outHits.length) throw new Error(`--out must not contain an advisory identifier (${outHits.join(", ")}): every cell path sits under it and reaches the model.`);
	await ensureEmptyOutput(options.out);
	await claimOwner(options.out, options.dryRun ? "dry-run" : "live");
	const manifest = newManifest(options, options.dryRun ? "dry-run" : "live");
	// The run that creates the grid is the only writer of <out>/manifest.json.
	await driveGrid(options, manifest, undefined, {
		manifestPath: join(options.out, "manifest.json"), preflightRoot: options.out, statusPath: join(options.out, "progress.json"),
	});
}

/** A fresh resume-<n> directory, claimed with a non-recursive mkdir so two resumes never share one. */
async function claimResumeDir(dir: string): Promise<{ n: number; root: string }> {
	for (let n = 1; n < 10_000; n++) {
		const root = join(dir, `resume-${n}`);
		try { await mkdir(root); return { n, root }; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error(`--resume: no free resume-<n> directory in ${dir}`);
}

type ResumeInput = { prior: JsonRecord; priorRuns: JsonRecord[]; n: number; root: string };
type GridPaths = { manifestPath: string; preflightRoot: string; statusPath: string };

/**
 * Resume a stopped grid in place. The grid's original manifest.json is only
 * read: a refused resume used to write its fresh pins over it first, so the next
 * --resume compared new pins against new pins and continued under a changed
 * harness, and a resume that failed early left a manifest with no inputs, which
 * made the grid unresumable for good. Now the resume's own preflight and
 * manifest go to resume-<n>/, its recomputed pins are compared with the
 * untouched original, and only an accepted resume touches progress.json.
 */
async function resumeMain(dir: string): Promise<void> {
	const priorPath = join(dir, "manifest.json");
	if (!await exists(priorPath)) throw new Error(`--resume: no manifest.json in ${dir}`);
	// Before anything is written: a resume beside a live runner would re-launch its in-flight pairs.
	await claimOwner(dir, "resume");
	const prior = parseJsonObject(await readFile(priorPath, "utf8")) ?? {};
	const options = optionsFromManifest(dir, prior);
	const priorRuns: JsonRecord[] = [];
	const runsPath = join(dir, "runs.jsonl");
	if (await exists(runsPath)) {
		for (const line of (await readFile(runsPath, "utf8")).split("\n")) {
			const row = parseJsonObject(line);
			if (row) priorRuns.push(row);
		}
	}
	const { n, root } = await claimResumeDir(dir);
	const manifest = newManifest(options, "resume");
	manifest.resumedFrom = { id: prior.id ?? null, n, priorRuns: priorRuns.length, originalManifest: priorPath };
	console.log(`resume ${n}: preflight and pin check in ${root}; the grid's manifest.json and progress.json are not written unless the resume is accepted`);
	await driveGrid(options, manifest, { prior, priorRuns, n, root }, {
		manifestPath: join(root, "manifest.json"), preflightRoot: root, statusPath: join(root, "status.json"),
	});
}

/** Refuse a resume, recording why in the resume's own manifest and status file only. */
async function refuseResume(manifest: JsonRecord, saveManifest: () => Promise<void>, why: string, detail: JsonRecord): Promise<never> {
	manifest.resumeDecision = { status: "refused", reason: why, ...detail };
	await saveManifest();
	await reportStatus({ status: "refused", reason: why, ...detail });
	throw new ResumeRefusedError(why);
}

/** Install the stop handlers, run the preflight, and (unless --dry-run) the grid. */
async function driveGrid(options: Options, manifest: JsonRecord, resume: ResumeInput | undefined, paths: GridPaths): Promise<void> {
	const output = options.out;
	statusFile.path = paths.statusPath;
	const saveManifest = (): Promise<void> => serially(() => writeJson(paths.manifestPath, manifest));
	await saveManifest();
	// SIGHUP (terminal/SSH loss) is handled like SIGINT/SIGTERM: without a handler
	// Node terminates at once and leaves progress.json reading "running" for a dead
	// runner. Registered, it stops launches and still writes an interrupted summary.
	// The first signal's time is kept: an arm running at that moment was stopped by
	// this runner, which is infrastructure, not the arm's own failure.
	const onSignal = (): void => {
		runState.signals++;
		runState.aborted = true;
		runState.abortedAtMs ??= Date.now();
		if (!runState.stopReason) runState.stopReason = `interrupted by signal at ${new Date(runState.abortedAtMs).toISOString()}`;
		for (const stop of activeGroups.values()) stop(runState.signals > 1);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	process.on("SIGHUP", onSignal);
	const stopHeartbeat = startHeartbeat();
	try {
		await reportStatus({ status: resume ? "resume-preflight" : "preflight", completedRuns: 0 });
		const pre = await runPreflight(options, manifest, saveManifest, paths.preflightRoot).catch(async (error: unknown) => {
			await reportStatus({ status: runState.aborted ? "interrupted" : "preflight-failed", completedRuns: 0, error: message(error) });
			throw error;
		});
		if (resume) {
			const diffs = resumeMismatches(resume.prior, manifest);
			if (diffs.length) {
				await refuseResume(manifest, saveManifest, `--resume refused: the recomputed pins differ from the grid's original manifest.json at: ${diffs.join(", ")}. The inputs or harness changed; a resume must measure with the same rules.`, { mismatches: diffs });
			}
		}
		if (!pre.official) console.log(`EXPLORATORY — not an acceptance decision (${pre.exploratoryReasons.join("; ") || "grid is not the official five targets x three passes"})`);
		if (options.dryRun) {
			await reportStatus({ status: "dry-run-complete", official: pre.official, expectedArms: 0, completedRuns: 0 });
			const twinCount = pre.targets.filter((t) => t.twinOf !== undefined).length;
			const probes = (pre.targets.length - twinCount) * (options.matched ? 3 : 2) + twinCount * (options.twinArms?.length ?? 0);
			console.log(`dry-run passed · ${pre.targets.length - twinCount} targets${twinCount ? ` + ${twinCount} patched twins (${options.twinArms?.join(",")})` : ""} · ${options.passes} passes configured · scopes reap strays · answer keys sealed · escape vectors denied · provider network reachable · grader verified · ${probes} sealed tool probes · 1 sealed delegation probe (faux model: a worker that hands back, one pired's turn budget stops)${options.matched ? " · 1 sealed ceiling probe (faux model: the crossing reply's record lands, no second request)" : ""} · no model calls`);
			console.log(`manifest ${paths.manifestPath}`);
			gridFinished = true;
			return;
		}
		const schedule = gridSchedule(pre, options);
		const plan = resume ? planResume(schedule, resume.priorRuns, options.breaker?.attemptCeiling) : undefined;
		// A patched twin never enters the gate, so a blocked or abandoned twin does
		// not fix an official grid's decision and does not refuse its resume.
		const twinKeys = new Set(schedule.filter((p) => p.twin).map((p) => p.key));
		if (plan && resume) {
			console.log(`resume: ${plan.rerunKeys.length} pair(s) to re-run, ${plan.keepKeys.length} kept, ${plan.blockedKeys.length} blocked (invalid, non-infra)${options.breaker ? `, ${plan.abandonedKeys.length} abandoned (attempt ceiling ${options.breaker.attemptCeiling})` : ""}`);
			for (const key of plan.blockedKeys) console.log(`  blocked ${key}: ${plan.reasons[key] ?? ""}`);
			for (const key of plan.abandonedKeys) console.log(`  abandoned ${key}: ${plan.reasons[key] ?? ""}`);
			// A blocked pair already fixes an official grid's decision at
			// incomplete_or_invalid; fail-fast only watched new outcomes, so a resume
			// used to spend every remaining pair (up to ~50 two-hour sessions) anyway.
			const gateBlocked = plan.blockedKeys.filter((k) => !twinKeys.has(k));
			const gateAbandoned = plan.abandonedKeys.filter((k) => !twinKeys.has(k));
			if (gateBlocked.length && pre.official) {
				await refuseResume(manifest, saveManifest,
					`--resume refused: ${gateBlocked.length} pair(s) of this official grid are invalid for a non-infrastructure reason (${gateBlocked.map((k) => `${k}: ${plan.reasons[k] ?? ""}`).join("; ")}), so its decision is already incomplete_or_invalid and launching the remaining pairs would spend tokens on a fixed outcome.`,
					{ blocked: gateBlocked });
			}
			// An abandoned pair fixes the decision the same way, and refusing is what
			// ends an auto-resume loop that would otherwise re-run it forever.
			if (gateAbandoned.length && pre.official) {
				await refuseResume(manifest, saveManifest,
					`--resume refused: ${gateAbandoned.length} pair(s) of this official grid reached the attempt ceiling (${gateAbandoned.map((k) => `${k}: ${plan.reasons[k] ?? ""}`).join("; ")}), so its decision is already incomplete_or_invalid.`,
					{ abandoned: gateAbandoned });
			}
			manifest.resumeDecision = { status: "accepted", rerun: plan.rerunKeys, kept: plan.keepKeys, blocked: plan.blockedKeys, ...(options.breaker ? { abandoned: plan.abandonedKeys } : {}) };
			await saveManifest();
			await reportStatus({ status: "accepted", rerun: plan.rerunKeys.length, kept: plan.keepKeys.length, blocked: plan.blockedKeys.length, ...(options.breaker ? { abandoned: plan.abandonedKeys.length } : {}) });
			await appendJsonl(join(output, "resumes.jsonl"), {
				n: resume.n, id: manifest.id, manifest: relative(output, paths.manifestPath), acceptedAt: new Date().toISOString(),
				rerun: plan.rerunKeys, kept: plan.keepKeys, blocked: plan.blockedKeys, ...(options.breaker ? { abandoned: plan.abandonedKeys } : {}),
			});
			// Accepted: from here the resume is the grid's runner and reports in progress.json.
			statusFile.path = join(output, "progress.json");
		}
		await runGrid(pre, options, manifest, plan, resume?.priorRuns ?? []);
		gridFinished = true;
	} finally {
		stopHeartbeat();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("SIGHUP", onSignal);
	}
}

/**
 * The record of a pair's second arm that was not launched: after an invalid
 * first arm (infrastructure exactly when the first arm's failure was, so a
 * resume re-runs both), or after this runner's own stop signal (a runner
 * interruption). Written to runs.jsonl like any arm, so the grid's record shows
 * why the pair is incomplete.
 */
export function notLaunchedOutcome(pair: ScheduledPair, arm: Arm, attempt: number, first: RunOutcome, interrupted: boolean): RunOutcome {
	const firstInvalid = !first.metric.valid;
	const infraFailure = firstInvalid ? first.infraFailure : interrupted;
	const why = firstInvalid
		? `not launched: the pair's ${first.arm} arm was invalid${first.infraFailure ? " for an infrastructure reason" : ""}, so this arm could not be compared`
		: "not launched: interrupted";
	const record: JsonRecord = {
		key: pair.key, target: pair.target, pass: pair.pass, arm, attempt, cellId: null, valid: false, notLaunched: true,
		infraFailure,
		infraReason: !infraFailure ? null : firstInvalid ? `partner arm ${first.arm} failed: ${String(first.record.infraReason ?? "infrastructure")}` : "runner interruption",
		totalTokens: null, errors: [why],
	};
	return {
		metric: { key: pair.key, target: pair.target, pass: pair.pass, valid: false, truePositives: 0, precision: 0, totalClaims: 0, totalTokens: Number.NaN },
		arm, cellId: "", seconds: 0, record, infraFailure,
	};
}

/**
 * The outcomes at each pair's highest attempt, in their order. A pair counts
 * only when both arms are valid at the same attempt, and a re-queued pair
 * leaves its earlier attempts in the outcomes: passed whole, the comparison
 * would read them as duplicate runs and the grid as incomplete. A fail-fast
 * grid holds one attempt per pair, so for it this is the identity.
 */
export function atHighestAttempt<T extends { metric: { key: string }; record: JsonRecord }>(outcomes: T[]): T[] {
	const attemptOf = (o: T): number => typeof o.record.attempt === "number" ? o.record.attempt : 1;
	const top = new Map<string, number>();
	for (const o of outcomes) top.set(o.metric.key, Math.max(top.get(o.metric.key) ?? 0, attemptOf(o)));
	return outcomes.filter((o) => attemptOf(o) === top.get(o.metric.key));
}

/** One arm's run at one attempt, as the attempt report shows it. */
export type AttemptArm = { launched: boolean; valid: boolean; infra: boolean; reason: string | null; seconds: number | null; tokens: number | null };

export interface AttemptReport {
	/** Each pair's highest attempt over the grid's rows. */
	attemptsByPair: Record<string, number>;
	/** Launched runs invalid for infrastructure, per arm, by infraReason. A partner that was not launched is not counted. */
	launchedInfraFailures: Record<PairArm, Record<string, number>>;
	/** Every attempt of each abandoned pair, per arm; null where the arm has no row at that attempt. */
	abandoned: Array<{ key: string; attempts: Array<{ attempt: number; baseline: AttemptArm | null; candidate: AttemptArm | null }> }>;
}

/**
 * What a grid with a breaker spent on attempts, from every row it has written
 * (a resume passes the rows of the runners before it). The per-arm failure
 * counts are reported, not assumed: which arm drops more has differed by grid
 * (launched infrastructure failures, baseline/candidate: 31/16 on v5c Luna,
 * 22/8 on v5 GLM, 10/14 on cc GLM). An abandoned pair lists each attempt, so
 * the reason a pair never counted can be read without opening runs.jsonl.
 */
export function attemptReport(rows: JsonRecord[], abandonedKeys: string[]): AttemptReport {
	const attemptOf = (r: JsonRecord): number => typeof r.attempt === "number" ? r.attempt : 1;
	const armOf = (r: JsonRecord): PairArm | undefined => r.arm === "baseline" || r.arm === "candidate" ? r.arm : undefined;
	const report: AttemptReport = { attemptsByPair: {}, launchedInfraFailures: { baseline: {}, candidate: {} }, abandoned: [] };
	for (const r of rows) {
		if (typeof r.key !== "string") continue;
		report.attemptsByPair[r.key] = Math.max(report.attemptsByPair[r.key] ?? 0, attemptOf(r));
		const arm = armOf(r);
		if (arm && r.notLaunched !== true && r.valid !== true && r.infraFailure === true) {
			const reason = typeof r.infraReason === "string" && r.infraReason ? r.infraReason : "unstated";
			report.launchedInfraFailures[arm][reason] = (report.launchedInfraFailures[arm][reason] ?? 0) + 1;
		}
	}
	const armRow = (r: JsonRecord): AttemptArm => ({
		launched: r.notLaunched !== true, valid: r.valid === true, infra: r.infraFailure === true,
		reason: r.valid === true ? null : typeof r.infraReason === "string" && r.infraReason ? r.infraReason : Array.isArray(r.errors) && r.errors.length ? String(r.errors[0]) : null,
		seconds: typeof r.seconds === "number" ? r.seconds : null,
		tokens: typeof r.totalTokens === "number" ? r.totalTokens : null,
	});
	for (const key of abandonedKeys) {
		const byAttempt = new Map<number, { baseline: AttemptArm | null; candidate: AttemptArm | null }>();
		for (const r of rows) {
			const arm = armOf(r);
			if (r.key !== key || !arm) continue;
			const slot = byAttempt.get(attemptOf(r)) ?? { baseline: null, candidate: null };
			// Two rows for one arm at one attempt resolve to the last written, as in planResume.
			slot[arm] = armRow(r);
			byAttempt.set(attemptOf(r), slot);
		}
		report.abandoned.push({ key, attempts: [...byAttempt.entries()].sort(([a], [b]) => a - b).map(([attempt, arms]) => ({ attempt, ...arms })) });
	}
	return report;
}

/** The record of an arm whose launch threw inside the runner: a harness fault, never infrastructure. */
function runnerFaultOutcome(pair: ScheduledPair, arm: Arm, attempt: number, error: unknown): RunOutcome {
	const record: JsonRecord = { key: pair.key, target: pair.target, pass: pair.pass, arm, attempt, valid: false, infraFailure: false, errors: [`runner fault: ${message(error)}`] };
	return {
		metric: { key: pair.key, target: pair.target, pass: pair.pass, valid: false, truePositives: 0, precision: 0, totalClaims: 0, totalTokens: Number.NaN },
		arm, cellId: "", seconds: 0, record, infraFailure: false,
	};
}

/** The part of runState the pair loop reads and sets; the signal handlers share the same object. */
export type GridStopState = { aborted: boolean; stopInvalid: boolean; stopReason: string | undefined; quotaExhausted: string | undefined; stoppedBy?: "matched" | "twin" | undefined };

/** What the pair loop needs from the grid around it. runGrid passes the real runner; the tests pass fakes and a fake clock. */
export interface PairLoop {
	/** The pairs to launch, in schedule order. */
	pairs: ScheduledPair[];
	/** The attempt a pair's first launch by this runner gets: 1, or a resume's next attempt. */
	firstAttempt: (pair: ScheduledPair) => number;
	concurrency: number;
	official: boolean;
	/** Absent: fail-fast. The first invalid run stops new launches, and nothing is re-queued. */
	breaker?: BreakerPolicy;
	state: GridStopState;
	/** Launch one arm. A throw is a runner fault, recorded as a non-infrastructure invalid run. */
	launch: (pair: ScheduledPair, arm: Arm, attempt: number) => Promise<RunOutcome>;
	/** Keep an outcome (the outcomes list, runs.jsonl). A throw is a bookkeeping failure, and stops new launches. */
	settle: (outcome: RunOutcome) => Promise<void>;
	/** After the stop decision: progress.json and the console line. */
	report: (outcome: RunOutcome, pair: ScheduledPair, arm: Arm, attempt: number) => Promise<void>;
	nowMs: () => number;
	sleep: (ms: number) => Promise<void>;
	log: (line: string) => void;
	warn: (line: string) => void;
	/** The grid's directory, named in the resume command the messages print. */
	out: string;
	/** The matched arm (plan item 2.5). Absent, the loop is the one every earlier grid ran. */
	matched?: MatchedLoop;
}

/**
 * The matched arm's part of the pair loop. Its k sessions run in the pair's
 * slot after both arms of the pair are valid at the same attempt, so that the
 * pair's own two arms keep the timing they had before this arm existed; a pair
 * that is re-run takes its matched sessions with it.
 */
export interface MatchedLoop {
	/** k, kMax and the floor: how B is split into sessions (nextSessionStep). */
	policy: Pick<MatchedPolicy, "k" | "kMax" | "floorShare">;
	/** B, from the pair's candidate run (follow) or the policy (fixed). */
	budget: (pair: ScheduledPair, candidate: RunOutcome) => SessionBudget;
	/** Launch one session. A throw is a runner fault, recorded as a non-infrastructure invalid run. */
	launch: (pair: ScheduledPair, attempt: number, session: MatchedSessionSpec) => Promise<RunOutcome>;
	/** Kept pairs a resume found with sessions still owed, each with the candidate run that sets B and the sessions already run. */
	resume?: Array<{ pair: ScheduledPair; attempt: number; candidate: RunOutcome; sessions: SessionState[] }>;
}

/** What the matched arm's sessions did in one runner; session is `<pair key>/<index>`. */
export interface MatchedLoopResult {
	/** Pairs whose matched arm had no budget, so no session ran. */
	skipped: Array<{ key: string; attempt: number; reason: string }>;
	requeued: Array<{ session: string; sessionAttempt: number; notBefore: string; reason: string }>;
	gaveUp: Array<{ session: string; sessionAttempt: number; reason: string }>;
	blocked: Array<{ session: string; sessionAttempt: number; reason: string }>;
	abandoned: Array<{ session: string; sessionAttempt: number; reason: string }>;
}

export interface PairLoopResult {
	/** The breaker's last verdict; null for a fail-fast grid. */
	breaker: BreakerVerdict | null;
	requeued: Array<{ key: string; attempt: number; notBefore: string; reason: string }>;
	gaveUp: Array<{ key: string; attempt: number; reason: string }>;
	/** Pairs this runner saw end blocked; in an exploratory grid the breaker lets the grid go on past them. */
	blocked: Array<{ key: string; attempt: number; reason: string }>;
	/** Pairs that failed at the attempt ceiling. */
	abandoned: Array<{ key: string; attempt: number; reason: string }>;
	/** Present only when the loop ran a matched arm. */
	matched?: MatchedLoopResult;
}

/** The longest an idle pair-worker sleeps before it looks again, so a signal or a trip is seen within a second while it waits out a cooldown. */
const IDLE_SLICE_MS = 1000;

/**
 * The pool of pair-workers runGrid drives. Workers take pairs in schedule
 * order, and each pair runs its two arms one after the other, so the arms of
 * one pair never share a provider window.
 *
 * Without a breaker this is the fail-fast loop every earlier grid ran: the
 * first invalid run stops new launches and in-flight pairs finish. In v5 that
 * let one dropped stream stop a grid for the night (research/12). With a
 * breaker, each launched run feeds it instead, and a pair that ends invalid for
 * infrastructure is re-queued by nextPairAction, both arms at attempt + 1 after
 * its cooldown. A ready re-queued pair goes before later pairs of the schedule,
 * so a stopped grid still leaves whole passes where it can. A worker with
 * nothing ready waits for the first cooldown to end; a worker with nothing
 * queued stops, which loses no pair, because only the worker that ran a pair
 * can re-queue it, and it is still running.
 */
export async function runPairs(loop: PairLoop): Promise<PairLoopResult> {
	const { state } = loop;
	const policy = loop.breaker;
	const breaker = policy ? createBreaker(policy) : undefined;
	const result: PairLoopResult = { breaker: null, requeued: [], gaveUp: [], blocked: [], abandoned: [] };
	const matchedResult: MatchedLoopResult | undefined = loop.matched ? { skipped: [], requeued: [], gaveUp: [], blocked: [], abandoned: [] } : undefined;
	if (matchedResult) result.matched = matchedResult;
	type MatchedOnly = { candidate: RunOutcome; sessions: SessionState[] };
	type Queued = { pair: ScheduledPair; attempt: number; firstAttempt: number; notBeforeMs: number; matchedOnly?: MatchedOnly };
	const queue: Queued[] = loop.pairs.map((pair) => {
		const attempt = loop.firstAttempt(pair);
		return { pair, attempt, firstAttempt: attempt, notBeforeMs: 0 };
	});
	for (const item of loop.matched?.resume ?? []) {
		queue.push({ pair: item.pair, attempt: item.attempt, firstAttempt: item.attempt, notBeforeMs: 0, matchedOnly: { candidate: item.candidate, sessions: item.sessions } });
	}
	const takeReady = (): Queued | undefined => {
		const now = loop.nowMs();
		let pick = -1;
		for (const [i, q] of queue.entries()) if (q.notBeforeMs <= now && (pick < 0 || q.pair.index < queue[pick]!.pair.index)) pick = i;
		return pick < 0 ? undefined : queue.splice(pick, 1)[0];
	};
	const quotaStop = (arm: Arm, pair: ScheduledPair): string =>
		`provider quota exhausted on the ${arm} run of ${pair.target} pass ${pair.pass} (${state.quotaExhausted ?? ""}); the quota must reset before --resume`;
	/**
	 * Keep one arm's outcome and apply the stop rules to it: the quota stop, and
	 * the fail-fast rule or the breaker. `gate` is false for a matched session
	 * and for a patched twin's run (plan item 2.8): a non-infrastructure failure
	 * there leaves the gate's decision open, so it does not trip an official
	 * grid's breaker at once the way a pair's arm does; it still counts as a
	 * failed launch. A throw is a bookkeeping failure.
	 */
	const keep = async (outcome: RunOutcome, pair: ScheduledPair, arm: Arm, attempt: number, launched: boolean, gate: boolean): Promise<void> => {
		await loop.settle(outcome);
		if (outcome.quotaExhausted && !state.quotaExhausted) {
			state.quotaExhausted = `${String(outcome.record.infraReason ?? "provider quota exhausted")}: ${String(outcome.record.infraEvidence ?? "")}`;
			loop.log(`QUOTA EXHAUSTED — ${state.quotaExhausted}. No further pair will launch; wait for the provider's quota or usage window to reset, then run --resume ${loop.out}.`);
		}
		if (!breaker) {
			if (!outcome.metric.valid && !state.stopInvalid && !state.aborted) {
				state.stopInvalid = true;
				if (!gate) state.stoppedBy = pair.twin ? "twin" : "matched";
				state.stopReason = outcome.quotaExhausted
					? quotaStop(arm, pair)
					: `stopped after an invalid ${arm} run of ${pair.target} pass ${pair.pass}${outcome.infraFailure ? ` (infra: ${String(outcome.record.infraReason ?? "")})` : ""}`;
			}
		} else if (launched) {
			// A partner that was not launched reached no provider, so it is not
			// evidence of an outage; counting it would trip on half the failures.
			const verdict = breaker.record({
				atMs: loop.nowMs(), valid: outcome.metric.valid, infra: outcome.infraFailure, exhausted: outcome.quotaExhausted === true,
				blocked: gate && loop.official && !outcome.metric.valid && !outcome.infraFailure,
			});
			if (verdict.tripped && !state.stopInvalid && !state.aborted) {
				state.stopInvalid = true;
				if (!gate) state.stoppedBy = pair.twin ? "twin" : "matched";
				state.stopReason = outcome.quotaExhausted
					? quotaStop(arm, pair)
					: `circuit breaker tripped on the ${arm} run of ${pair.target} pass ${pair.pass} attempt ${attempt}: ${verdict.reason ?? ""}`;
				if (!outcome.quotaExhausted) loop.log(`BREAKER TRIPPED — ${state.stopReason}. No further pair will launch; pairs in flight finish, then --resume ${loop.out} re-runs what is left.`);
			}
		}
		await loop.report(outcome, pair, arm, attempt);
	};
	const runPair = async ({ pair, attempt, firstAttempt, matchedOnly }: Queued): Promise<void> => {
		if (matchedOnly) {
			await runMatched(pair, attempt, matchedOnly.candidate, matchedOnly.sessions);
			return;
		}
		let first: RunOutcome | undefined;
		const byArm: Partial<Record<Arm, RunOutcome>> = {};
		for (const arm of pair.order) {
			// Nothing of this pair ran yet: leave it without a row, which a resume
			// reads as a pair with no run at this attempt.
			if (state.aborted && !first) break;
			// Every write for this arm is inside one try: a bookkeeping failure
			// (ENOSPC on runs.jsonl) then stops new launches and drains the pool with
			// the signal handlers still installed, rather than rejecting Promise.all.
			try {
				let outcome: RunOutcome;
				let launched = false;
				if (first && (!first.metric.valid || state.aborted)) {
					// The partner is not launched: a first arm invalid for a non-infra
					// reason blocks the pair and one invalid for infra re-runs both arms,
					// so up to two hours of this arm could never be compared. It is
					// recorded, as infra exactly when the first arm was.
					outcome = notLaunchedOutcome(pair, arm, attempt, first, state.aborted);
				} else {
					launched = true;
					try {
						outcome = await loop.launch(pair, arm, attempt);
					} catch (error) {
						outcome = runnerFaultOutcome(pair, arm, attempt, error);
					}
				}
				first ??= outcome;
				byArm[arm] = outcome;
				await keep(outcome, pair, arm, attempt, launched, !pair.twin);
			} catch (error) {
				// The bookkeeping itself failed; stop launching and keep draining.
				if (!state.stopInvalid) { state.stopInvalid = true; state.stopReason = `bookkeeping write failed: ${message(error)}`; }
				loop.warn(`bookkeeping failure for ${pair.target} pass ${pair.pass} ${arm}: ${message(error)}`);
			}
		}
		// The matched arm follows a pair whose two arms are valid at this attempt,
		// the only pairs the comparison keeps. A grid already stopping launches none,
		// and a patched twin never has one.
		if (loop.matched && !pair.twin && byArm.baseline?.metric.valid && byArm.candidate?.metric.valid) {
			await runMatched(pair, attempt, byArm.candidate, []);
		}
		// A signal leaves the pair as it is; its resume decides from runs.jsonl.
		if (!policy || state.aborted) return;
		const now = loop.nowMs();
		const arms = armsOfPair(pair).map((arm) => byArm[arm]).map((o) => o && { valid: o.metric.valid, infra: o.infraFailure });
		const action = nextPairAction(attempt, arms, { attemptCeiling: policy.attemptCeiling, requeue: { policy, atMs: now, attemptsThisRun: attempt - firstAttempt + 1 } });
		if (action.kind === "blocked") {
			result.blocked.push({ key: pair.key, attempt, reason: action.reason });
		} else if (action.kind === "abandoned") {
			result.abandoned.push({ key: pair.key, attempt, reason: action.reason });
			loop.log(`ABANDONED ${pair.target} pass ${pair.pass} · ${action.reason}`);
			// Like a blocked run, an abandoned pair fixes an official grid's decision,
			// so the pairs after it would spend tokens on a known outcome. A patched
			// twin is outside the decision, so it does not stop the grid.
			if (loop.official && !pair.twin && !state.stopInvalid) {
				state.stopInvalid = true;
				state.stopReason = `${pair.key} failed at the attempt ceiling of ${policy.attemptCeiling}, so this official grid's decision is already incomplete_or_invalid`;
			}
		} else if (action.kind === "give-up") {
			result.gaveUp.push({ key: pair.key, attempt, reason: action.reason });
			loop.log(`ATTEMPT CAP ${pair.target} pass ${pair.pass} · ${action.reason}`);
		} else if (action.kind === "rerun" && !state.stopInvalid) {
			// A stopped grid re-queues nothing: its resume re-runs the pair from runs.jsonl.
			queue.push({ pair, attempt: action.attempt, firstAttempt, notBeforeMs: action.notBeforeMs });
			result.requeued.push({ key: pair.key, attempt: action.attempt, notBefore: new Date(action.notBeforeMs).toISOString(), reason: action.reason });
			loop.log(`RE-QUEUED ${pair.target} pass ${pair.pass} as attempt ${action.attempt} after a ${Math.round((action.notBeforeMs - now) / 1000)} s cooldown · ${action.reason}`);
		}
	};
	/** Wait until `atMs` in slices, so a signal or a trip is seen within a second. */
	const waitUntil = async (atMs: number): Promise<void> => {
		for (let now = loop.nowMs(); now < atMs && !state.aborted && !state.stopInvalid; now = loop.nowMs()) {
			await loop.sleep(Math.min(atMs - now, IDLE_SLICE_MS));
		}
	};
	/**
	 * A pair's matched sessions, one after the other, as nextSessionStep plans
	 * them: the first k split what is left of B, extra sessions spend what the
	 * earlier ones did not, and a failed session is re-run on its own with its
	 * index's ceiling, by the rule a pair is re-run by (nextPairAction with the
	 * one session as its arm), after the same cooldown and up to the same caps.
	 * A session that ends invalid for good stops the pair's arm, since it can no
	 * longer be valid; a resume picks up only what infrastructure left unrun.
	 */
	const runMatched = async (pair: ScheduledPair, attempt: number, candidate: RunOutcome, prior: SessionState[]): Promise<void> => {
		const matched = loop.matched!;
		const record = matchedResult!;
		if (state.aborted || state.stopInvalid) return;
		const budget = matched.budget(pair, candidate);
		if (!budget.ok) {
			record.skipped.push({ key: pair.key, attempt, reason: budget.reason });
			loop.log(`MATCHED SKIPPED ${pair.target} pass ${pair.pass} · ${budget.reason}`);
			return;
		}
		const sessions = [...prior];
		const launches = new Map<number, number>();
		for (;;) {
			if (state.aborted || state.stopInvalid) return;
			const step = nextSessionStep(matched.policy, budget.budget, sessions, policy ? { attemptCeiling: policy.attemptCeiling } : {});
			if (step.kind === "done") return;
			if (step.kind !== "run") {
				const at = sessions.filter((x) => x.index === step.index).reduce((n, x) => Math.max(n, x.attempt), 0);
				(step.kind === "blocked" ? record.blocked : record.abandoned).push({ session: `${pair.key}/${step.index}`, sessionAttempt: at, reason: step.reason });
				loop.log(`MATCHED SESSION ${step.kind.toUpperCase()} ${pair.target} pass ${pair.pass} session ${step.index} · ${step.reason}`);
				return;
			}
			const name = `${pair.key}/${step.index}`;
			const spec: MatchedSessionSpec = {
				index: step.index, k: matched.policy.k, kMax: matched.policy.kMax, sessionAttempt: step.attempt, budget: budget.budget, ceiling: step.ceiling,
				spentBefore: step.spentBefore, budgetSource: budget.source, candidateCellId: candidate.cellId || null,
			};
			let outcome: RunOutcome;
			try {
				outcome = await matched.launch(pair, attempt, spec);
			} catch (error) {
				outcome = runnerFaultOutcome(pair, "matched", attempt, error);
				outcome.record.matchedSession = spec;
			}
			try {
				await keep(outcome, pair, "matched", attempt, true, false);
			} catch (error) {
				// A lost record is a harness-integrity failure: it withholds approval
				// like any other, so it is not marked as the matched arm's own stop.
				if (!state.stopInvalid) { state.stopInvalid = true; state.stopReason = `bookkeeping write failed: ${message(error)}`; }
				loop.warn(`bookkeeping failure for ${pair.target} pass ${pair.pass} matched session ${step.index}: ${message(error)}`);
				return;
			}
			const launched = (launches.get(step.index) ?? 0) + 1;
			launches.set(step.index, launched);
			sessions.push({ index: step.index, attempt: step.attempt, valid: outcome.metric.valid, infra: outcome.infraFailure, tokens: outcome.metric.totalTokens, ceiling: step.ceiling });
			if (outcome.metric.valid) continue;
			// Fail-fast has already stopped the grid; nothing is re-run without a breaker.
			if (!policy || state.aborted) return;
			const action = nextPairAction(step.attempt, [{ valid: false, infra: outcome.infraFailure }], {
				attemptCeiling: policy.attemptCeiling,
				requeue: { policy, atMs: loop.nowMs(), attemptsThisRun: launched },
			});
			const why = action.kind === "keep" ? "" : action.reason.replace("an arm", "the session").replace("the pair is", "the session is");
			if (action.kind === "rerun" && !state.stopInvalid) {
				record.requeued.push({ session: name, sessionAttempt: action.attempt, notBefore: new Date(action.notBeforeMs).toISOString(), reason: why });
				loop.log(`RE-RUN matched session ${step.index} of ${pair.target} pass ${pair.pass} as session attempt ${action.attempt} · ${why}`);
				await waitUntil(action.notBeforeMs);
				continue;
			}
			if (action.kind === "blocked") record.blocked.push({ session: name, sessionAttempt: step.attempt, reason: why });
			else if (action.kind === "abandoned") record.abandoned.push({ session: name, sessionAttempt: step.attempt, reason: why });
			else if (action.kind === "give-up") record.gaveUp.push({ session: name, sessionAttempt: step.attempt, reason: why });
			if (action.kind !== "rerun") loop.log(`MATCHED SESSION ${action.kind.toUpperCase()} ${pair.target} pass ${pair.pass} session ${step.index} · ${why}`);
			return;
		}
	};
	const worker = async (): Promise<void> => {
		for (;;) {
			// Stop taking pairs once the grid is stopped or a signal arrived; a pair
			// already in flight runs its second arm only when its first arm was valid.
			if (state.aborted || state.stopInvalid || !queue.length) return;
			const next = takeReady();
			if (next) {
				await runPair(next);
				continue;
			}
			const waitMs = Math.min(...queue.map((q) => q.notBeforeMs)) - loop.nowMs();
			await loop.sleep(Math.min(Math.max(waitMs, 0), IDLE_SLICE_MS));
		}
	};
	await Promise.all(Array.from({ length: Math.min(loop.concurrency, Math.max(1, loop.pairs.length)) }, worker));
	result.breaker = breaker ? breaker.verdict : null;
	return result;
}

/**
 * A grid's runs split into the gate's and the patched twins' (plan item 2.8).
 * compareMatchedRuns reads a run whose key it does not expect as "unexpected",
 * which makes the grid incomplete, so a twin's run left in would keep every
 * grid with twins from a decision.
 */
export function splitTwinRuns<T extends { metric: { target: string } }>(outcomes: readonly T[], twinIds: ReadonlySet<string>): { gate: T[]; twins: T[] } {
	return { gate: outcomes.filter((o) => !twinIds.has(o.metric.target)), twins: outcomes.filter((o) => twinIds.has(o.metric.target)) };
}

/** A persisted run record as the loop's outcome, the way a resume seeds the pairs it keeps. */
function outcomeFromRecord(record: JsonRecord, arm: Arm): RunOutcome {
	return { metric: metricFromRecord(record), arm, cellId: String(record.cellId ?? ""), seconds: Number(record.seconds ?? 0), record, infraFailure: record.infraFailure === true };
}

const sessionOf = (record: JsonRecord): { index: number; sessionAttempt: number } | undefined => {
	const spec = record.matchedSession as JsonRecord | undefined;
	return spec && typeof spec.index === "number" && typeof spec.sessionAttempt === "number" ? { index: spec.index, sessionAttempt: spec.sessionAttempt } : undefined;
};

/**
 * Each matched session's latest record at one pair attempt, by index: the
 * highest session attempt, and at one attempt the last row written, as
 * planResume resolves two rows for one arm.
 */
export function latestMatchedSessions(rows: readonly JsonRecord[], key: string, attempt: number): JsonRecord[] {
	const latest = new Map<number, { sessionAttempt: number; record: JsonRecord }>();
	for (const record of rows) {
		const session = sessionOf(record);
		if (record.arm !== "matched" || record.key !== key || !session) continue;
		if ((typeof record.attempt === "number" ? record.attempt : 1) !== attempt) continue;
		const held = latest.get(session.index);
		if (!held || session.sessionAttempt >= held.sessionAttempt) latest.set(session.index, { sessionAttempt: session.sessionAttempt, record });
	}
	return [...latest.entries()].sort(([a], [b]) => a - b).map(([, v]) => v.record);
}

/** What a resume does with the matched arm of the pairs it keeps. */
export interface MatchedResumePlan {
	/** Kept pairs with a session still owed, and the sessions they already ran. */
	resume: Array<{ key: string; attempt: number; candidate: JsonRecord; sessions: SessionState[] }>;
	blocked: Array<{ session: string; reason: string }>;
	abandoned: Array<{ session: string; reason: string }>;
	/** Kept pairs whose arm has no budget (a fixed policy without one for the target). */
	skipped: Array<{ key: string; reason: string }>;
}

/** A matched session's record as nextSessionStep reads it: its own attempt, the gate's tokens, and the ceiling its index was given. */
export function sessionStateOf(record: JsonRecord): SessionState | undefined {
	const session = sessionOf(record);
	if (!session) return undefined;
	const ceiling = (record.matchedSession as JsonRecord).ceiling;
	return {
		index: session.index, attempt: session.sessionAttempt, valid: record.valid === true, infra: record.infraFailure === true,
		tokens: metricFromRecord(record).totalTokens, ceiling: typeof ceiling === "number" ? ceiling : 0,
	};
}

/**
 * For each pair the resume keeps (both arms valid at its highest attempt),
 * whether its matched arm still owes a session, by nextSessionStep over the
 * sessions it ran at that attempt. A pair with a blocked or abandoned session
 * owes nothing: its union can never be valid (review). A pair the resume
 * re-runs is not listed: its matched sessions follow its new attempt, whose
 * candidate run sets a new budget.
 */
export function planMatchedResume(plan: Pick<ResumePlan, "keepKeys" | "latest">, runs: readonly JsonRecord[], policy: MatchedPolicy, attemptCeiling?: number): MatchedResumePlan {
	const out: MatchedResumePlan = { resume: [], blocked: [], abandoned: [], skipped: [] };
	for (const key of plan.keepKeys) {
		const candidate = plan.latest[`${key}\u0000candidate`];
		if (!candidate) continue;
		const attempt = typeof candidate.attempt === "number" ? candidate.attempt : 1;
		const budget = sessionBudget(policy, String(candidate.target ?? ""), metricFromRecord(candidate));
		if (!budget.ok) { out.skipped.push({ key, reason: budget.reason }); continue; }
		const sessions = latestMatchedSessions(runs, key, attempt).flatMap((r) => sessionStateOf(r) ?? []);
		const step = nextSessionStep(policy, budget.budget, sessions, attemptCeiling === undefined ? {} : { attemptCeiling });
		if (step.kind === "run") out.resume.push({ key, attempt, candidate, sessions });
		else if (step.kind === "blocked") out.blocked.push({ session: `${key}/${step.index}`, reason: step.reason });
		else if (step.kind === "abandoned") out.abandoned.push({ session: `${key}/${step.index}`, reason: step.reason });
	}
	return out;
}

/** A matched session's record as the union reads it; its findings are read from its ledger only when it is valid. */
export function sessionRunOf(record: JsonRecord, findings?: Finding[]): SessionRun {
	const session = sessionOf(record);
	const metric = metricFromRecord(record);
	const stop = record.stop as JsonRecord | undefined;
	return {
		index: session?.index ?? 0, attempt: session?.sessionAttempt ?? 0, cellId: String(record.cellId ?? ""),
		valid: metric.valid, infra: record.infraFailure === true, ceiling: sessionStateOf(record)?.ceiling ?? 0, totalTokens: metric.totalTokens, truePositives: Number.isFinite(metric.truePositives) ? metric.truePositives : 0,
		claims: Number.isFinite(metric.totalClaims) ? metric.totalClaims : 0,
		stop: stop && typeof stop.outcome === "string" ? stop.outcome : null,
		...(findings ? { findings } : {}),
	};
}

/**
 * The matched arm's section of summary.json: each pair's union at the pair's
 * compared attempt (graded now with the pinned scorer, so a resume's union is
 * of the sessions the grid ended with), the two comparisons beside the gate,
 * and the realised budget ratio.
 */
async function summarizeMatched(policy: MatchedPolicy, pairs: ScheduledPair[], compared: RunOutcome[], outcomes: RunOutcome[], expectedCells: ExpectedCell[], targetById: Map<string, Target>, output: string, loop: MatchedLoopResult | undefined, resume: MatchedResumePlan | undefined): Promise<JsonRecord & { policy: MatchedPolicy; unions: Array<MatchedUnion & { scorePath: string | null }>; comparisons: ReturnType<typeof matchedComparisons>; budgetRatio: ReturnType<typeof budgetRatios> }> {
	const records = outcomes.filter((o) => o.arm === "matched").map((o) => o.record);
	const unions: Array<MatchedUnion & { scorePath: string | null }> = [];
	for (const pair of pairs) {
		const candidate = compared.find((o) => o.arm === "candidate" && o.metric.key === pair.key);
		const attempt = typeof candidate?.record.attempt === "number" ? candidate.record.attempt : 1;
		const sessions = latestMatchedSessions(records, pair.key, attempt);
		// B as the loop computed it, from the same candidate run (or the fixed policy).
		const budget = sessionBudget(policy, pair.target, candidate && { valid: candidate.metric.valid, totalTokens: candidate.metric.totalTokens });
		const runs: SessionRun[] = [];
		for (const record of sessions) {
			const artifacts = (record.artifacts ?? {}) as JsonRecord;
			// Read the way the pinned adapter read the session's own ledger (scoreWorkspace).
			const findings = record.valid === true && typeof artifacts.workspaceDir === "string"
				? await fromLedger(artifacts.workspaceDir).then(dedupe).catch(() => undefined)
				: undefined;
			runs.push(sessionRunOf(record, findings));
		}
		const target = targetById.get(pair.target);
		let scorePath: string | null = null;
		const union = await scoreUnion({
			key: pair.key, target: pair.target, pass: pair.pass, attempt, policy,
			budget: budget.ok ? budget.budget : null,
			sessions: runs,
			grade: async (findings) => {
				if (!target) return { ok: false, error: `no target ${pair.target}` };
				await mkdir(join(output, "matched"), { recursive: true });
				scorePath = join(output, "matched", `${opaqueToken()}.score.json`);
				const graded = await gradeWithPinnedScorer(findings, scorePath, target.truth);
				return graded.ok ? { ok: true, truePositives: graded.truePositives, totalFindings: graded.totalFindings, precision: graded.precision } : { ok: false, error: graded.error };
			},
		});
		unions.push({ ...union, scorePath });
	}
	const matchedMetrics = unions.map(metricOfUnion);
	const baselineMetrics = compared.filter((o) => o.arm === "baseline").map((o) => o.metric);
	const candidateMetrics = compared.filter((o) => o.arm === "candidate").map((o) => o.metric);
	return {
		policy,
		unions,
		comparisons: matchedComparisons(baselineMetrics, candidateMetrics, matchedMetrics, expectedCells),
		budgetRatio: budgetRatios(matchedMetrics, candidateMetrics),
		sessions: {
			...(loop ?? { skipped: [], requeued: [], gaveUp: [], blocked: [], abandoned: [] }),
			...(resume ? { resumeBlocked: resume.blocked, resumeAbandoned: resume.abandoned } : {}),
		},
		interpretation: {
			arm: `the candidate snapshot with delegation off (scope maxAgents 0), run ${policy.k} times in fresh cells; each session stopped between requests at B/${policy.k} tokens; findings unioned, deduplicated by file+line as the pinned scorer does, and scored with the pinned scorer`,
			budget: policy.mode === "follow" ? "B is each pair's candidate run's tokens (the gate's metric); the arm runs after the pair's two arms, so it adds within-pair time drift" : "B is the pre-registered per-target budget; the realised ratio shows how it compared with this grid's candidate",
			precision: "the union raises claims as well as true positives; compare pooled precision after deduplication, not TP alone",
			validity: "the arm is valid for a pair only when all k sessions are valid at the pair's compared attempt",
			gate: "baseline vs candidate decides; matched vs candidate and matched vs baseline are reported beside it and approve nothing",
		},
	};
}

async function runGrid(pre: Preflight, options: Options, manifest: JsonRecord, plan: ResumePlan | undefined, priorRuns: JsonRecord[]): Promise<void> {
	const { ctx, expectedCells, official } = pre;
	const output = ctx.out;
	const targetById = new Map(pre.targets.map((t) => [t.id, t]));
	const pairs = gridSchedule(pre, options);
	// A patched twin's runs (plan item 2.8) count toward progress, in their own arms, and never toward the gate.
	const twinIds = new Set(pre.targets.filter((t) => t.twinOf !== undefined).map((t) => t.id));
	const gatePairs = pairs.filter((p) => !p.twin);
	const expectedArms = gatePairs.length * (2 + (options.matched?.k ?? 0)) + pairs.filter((p) => p.twin).reduce((n, p) => n + p.order.length, 0);
	const onGate = (o: RunOutcome): boolean => !twinIds.has(o.metric.target);
	// On a resume, seed the outcomes with the latest attempt of every pair not
	// being re-run, so the comparison sees the whole grid. Only the re-run pairs
	// are launched; a blocked pair carries its invalid record and keeps the grid
	// from approving.
	const outcomes: RunOutcome[] = [];
	if (plan) {
		for (const pair of pairs) {
			if (plan.rerunKeys.includes(pair.key)) continue;
			for (const arm of ["baseline", "candidate"] as const) {
				const record = plan.latest[`${pair.key}\u0000${arm}`];
				if (record) outcomes.push(outcomeFromRecord(record, arm));
			}
		}
	}
	// The matched sessions of the pairs a resume keeps: their latest runs are
	// carried, and the ones still missing or failed for infrastructure are queued.
	// A kept twin pair has no matched sessions: only the gate pairs a resume keeps are read for them.
	const gateKeep = plan ? plan.keepKeys.filter((key) => gatePairs.some((p) => p.key === key)) : [];
	const matchedResume = plan && options.matched ? planMatchedResume({ ...plan, keepKeys: gateKeep }, priorRuns, options.matched, options.breaker?.attemptCeiling) : undefined;
	if (plan && options.matched) {
		for (const key of gateKeep) {
			const candidate = plan.latest[`${key}\u0000candidate`];
			const attempt = typeof candidate?.attempt === "number" ? candidate.attempt : 1;
			for (const record of latestMatchedSessions(priorRuns, key, attempt)) outcomes.push(outcomeFromRecord(record, "matched"));
		}
		if (matchedResume) {
			console.log(`resume: matched arm · sessions owed on ${matchedResume.resume.length} kept pair(s), ${matchedResume.blocked.length} blocked, ${matchedResume.abandoned.length} abandoned, ${matchedResume.skipped.length} without a budget`);
		}
	}
	const launchPairs = plan ? pairs.filter((p) => plan.rerunKeys.includes(p.key)) : pairs;
	// The rows this runner appends to runs.jsonl, every attempt included.
	const fresh: JsonRecord[] = [];
	// reportStatus keeps the last record, so the heartbeat rewrites this same state.
	// completedRuns counts arms at their pair's highest attempt, so a grid that
	// re-queued never reads as more than complete; attempts counts every row.
	// A matched session re-run on its own leaves two rows at one pair attempt;
	// each (pair, session) counts once.
	const completedRuns = (): number => {
		const top = atHighestAttempt(outcomes);
		if (!options.matched) return top.length;
		// The first k sessions of each pair; an extra session is budget rolled over, not an expected arm.
		const k = options.matched.k;
		return top.filter((o) => o.arm !== "matched").length + new Set(top.filter((o) => o.arm === "matched" && (sessionOf(o.record)?.index ?? 0) <= k).map((o) => `${o.metric.key}/${sessionOf(o.record)?.index ?? 0}`)).size;
	};
	const progress = (status: string, extra: JsonRecord = {}): Promise<void> => reportStatus({
		status, official, expectedArms, completedRuns: completedRuns(),
		...(options.breaker ? { attempts: fresh.length } : {}), ...extra,
	});
	await progress("running");
	const loop = await runPairs({
		pairs: launchPairs,
		firstAttempt: (pair) => plan ? (plan.nextAttempt[pair.key] ?? 1) : 1,
		concurrency: options.concurrency, official,
		...(options.breaker === undefined ? {} : { breaker: options.breaker }),
		state: runState,
		launch: (pair, arm, attempt) => runOne(ctx, targetById.get(pair.target)!, pair.pass, arm, attempt),
		settle: async (outcome) => {
			outcomes.push(outcome);
			fresh.push(outcome.record);
			await appendJsonl(join(output, "runs.jsonl"), outcome.record);
		},
		report: async (outcome, pair, arm, attempt) => {
			await progress(runState.aborted ? "interrupted" : runState.stopInvalid ? "stopped-invalid" : "running", { lastCell: outcome.cellId, stopReason: runState.stopReason ?? null });
			const tokens = Number.isFinite(outcome.metric.totalTokens) ? String(outcome.metric.totalTokens) : "n/a";
			const state = outcome.metric.valid ? "valid" : outcome.record.notLaunched === true ? "NOT LAUNCHED" : "INVALID";
			const session = sessionOf(outcome.record);
			const label = session && options.matched ? `${arm} session ${session.index} (k=${options.matched.k}, up to ${options.matched.kMax}; session attempt ${session.sessionAttempt})` : arm;
			console.log(`${state} ${label} ${pair.target} pass ${pair.pass} attempt ${attempt} · ${outcome.seconds.toFixed(0)}s · tokens ${tokens}${outcome.infraFailure ? ` · infra: ${String(outcome.record.infraReason ?? "")}` : ""}`);
		},
		nowMs: () => Date.now(),
		sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
		log: (line) => console.log(line),
		warn: (line) => console.error(line),
		out: output,
		...(options.matched ? {
			matched: {
				policy: options.matched,
				budget: (pair: ScheduledPair, candidate: RunOutcome) => sessionBudget(options.matched!, pair.target, { valid: candidate.metric.valid, totalTokens: candidate.metric.totalTokens }),
				launch: (pair: ScheduledPair, attempt: number, session: MatchedSessionSpec) => runOne(ctx, targetById.get(pair.target)!, pair.pass, "matched", attempt, session),
				resume: (matchedResume?.resume ?? []).flatMap((r) => {
					const pair = pairs.find((p) => p.key === r.key);
					return pair ? [{ pair, attempt: r.attempt, candidate: outcomeFromRecord(r.candidate, "candidate"), sessions: r.sessions }] : [];
				}),
			},
		} : {}),
	});
	const interrupted = runState.aborted;
	const stoppedInvalid = runState.stopInvalid;
	const abandonedKeys = [...new Set([...(plan?.abandonedKeys ?? []), ...loop.abandoned.map((a) => a.key)])];
	// The gate reads the gate targets' runs only; a twin's are summarised apart.
	const { gate: compared, twins: twinOutcomes } = splitTwinRuns(atHighestAttempt(outcomes), twinIds);
	const comparison = compareMatchedRuns(
		compared.filter((o) => o.arm === "baseline").map((o) => o.metric),
		compared.filter((o) => o.arm === "candidate").map((o) => o.metric),
		expectedCells, pre.officialShapes,
	);
	// Under a retry policy the gate reads metered tokens plus the estimate for
	// unmetered attempts; the same comparison on metered tokens alone is reported
	// beside it, so a verdict that rests on the estimate shows as one.
	const meteredOnlyComparison = options.retryPolicy ? compareMatchedRuns(
		outcomes.filter((o) => o.arm === "baseline" && onGate(o)).map((o) => metricFromRecord(o.record, "metered")),
		outcomes.filter((o) => o.arm === "candidate" && onGate(o)).map((o) => metricFromRecord(o.record, "metered")),
		expectedCells, pre.officialShapes,
	) : undefined;
	const matchedSummary = options.matched ? await summarizeMatched(options.matched, gatePairs, compared, outcomes, expectedCells, targetById, output, loop.matched, matchedResume) : undefined;
	const twinSummary = options.twinArms?.length && twinIds.size ? {
		...summarizeTwins(options.twinArms, pre.targets.filter((t) => t.twinOf !== undefined).map((t) => ({ id: t.id, twinOf: t.twinOf! })), options.passes, twinOutcomes.map((o) => o.record)),
		stops: summarizeStops(twinOutcomes.map((o) => ({ arm: o.arm, key: String((o.record as JsonRecord).key ?? o.cellId), valid: o.metric.valid, stop: (o.record as JsonRecord).stop }))),
	} : undefined;
	// Each cell loads node_modules afresh, and hashing it (~25k files) per launch
	// is too slow, so it is re-hashed once at the end: a runtime that moved during
	// the grid means the arms may not have run the same pi, and nothing is approved.
	const runtimeAfter = await treeManifest(PI_NODE_MODULES, "runtime").then((t) => t.digest).catch((error) => `unreadable: ${message(error)}`);
	const runtimeStable = runtimeAfter === ctx.pins.piRuntimeSha256;
	if (!runtimeStable) console.log("RUNTIME CHANGED during the grid — no decision");
	// !stoppedInvalid too: a bookkeeping failure on a final arm sets it with every
	// comparison row present, and the approval could count a row runs.jsonl never got.
	// A stop a matched session caused leaves every gate row it did not prevent
	// written; the gate's own completeness decides, as the arm never enters it.
	// So does a stop a patched twin's run caused (plan item 2.8).
	const stopWithholdsApproval = stoppedInvalid && runState.stoppedBy === undefined;
	const approved = official && !interrupted && !stopWithholdsApproval && runtimeStable && comparison.complete && comparison.decision === APPROVAL;
	// A patched twin that gave up or was abandoned is no reason the gate did not
	// approve; it is listed in the breaker block and the twins block instead.
	const twinKeys = new Set(pairs.filter((p) => p.twin).map((p) => p.key));
	const gateGaveUp = loop.gaveUp.filter((g) => !twinKeys.has(g.key));
	const gateAbandoned = abandonedKeys.filter((k) => !twinKeys.has(k));
	// Why a non-approval is a non-approval, so the console and summary never show
	// the approval string alone when the candidate was not approved.
	const notApprovedReasons = [
		...(!official ? [`exploratory: ${pre.exploratoryReasons.join("; ") || "not the official grid"}`] : []),
		...(interrupted ? ["interrupted before the grid finished"] : []),
		...(stoppedInvalid && !interrupted ? [`stopped early: ${runState.stopReason ?? "an invalid run"}`] : []),
		...(runState.quotaExhausted ? [`provider quota exhausted (${runState.quotaExhausted}); it must reset before --resume`] : []),
		...(gateGaveUp.length ? [`${gateGaveUp.length} pair(s) reached the attempt cap (${gateGaveUp.map((g) => g.key).join(", ")}); --resume re-runs them`] : []),
		...(gateAbandoned.length ? [`${gateAbandoned.length} pair(s) abandoned at the attempt ceiling (${gateAbandoned.join(", ")}); no resume re-runs them`] : []),
		...(!runtimeStable ? ["the pi runtime changed during the grid"] : []),
		...(!comparison.complete ? [`grid incomplete or invalid: ${comparison.missingOrInvalid.slice(0, 4).join("; ") || "missing pairs"}`] : []),
		...(comparison.complete && comparison.decision !== APPROVAL ? [`comparison decision: ${comparison.decision}`] : []),
	];
	const inputsRecord = (manifest.inputs ?? {}) as JsonRecord;
	const baselineInput = (inputsRecord.baseline ?? {}) as JsonRecord;
	const candidateInput = (inputsRecord.candidate ?? {}) as JsonRecord;
	const summary = {
		id: manifest.id, mode: manifest.mode, provider: options.provider, model: options.model, thinking: options.thinking,
		official, decisionScope: official ? "official" : "exploratory", exploratoryReasons: pre.exploratoryReasons,
		// Only a grid launched as a kind names one.
		...(options.gridKind === undefined ? {} : { gridKind: options.gridKind }),
		interrupted, interruptedAt: runState.abortedAtMs === undefined ? null : new Date(runState.abortedAtMs).toISOString(),
		stoppedInvalid, stopReason: runState.stopReason ?? null, quotaExhausted: runState.quotaExhausted ?? null, runtimeStable,
		// Only a grid run with --breaker has this block, so a fail-fast grid's summary is what it always was.
		...(options.breaker === undefined ? {} : {
			breaker: {
				policy: options.breaker, tripped: loop.breaker?.tripped ?? false, reason: loop.breaker?.reason ?? null,
				requeued: loop.requeued, gaveUp: loop.gaveUp,
				blocked: [...(plan?.blockedKeys ?? []).map((key) => ({ key, reason: plan?.reasons[key] ?? null })), ...loop.blocked],
				...attemptReport([...priorRuns, ...fresh], abandonedKeys),
			},
		}),
		completeRunGrid: comparison.complete,
		// One grid measures one model; acceptance needs both priority models. This
		// name and flag keep a single-model summary from reading as final acceptance.
		approvedForThisModel: approved, approved, acceptanceRequiresBothModels: true, notApprovedReasons: approved ? [] : notApprovedReasons,
		inputDigests: {
			baseline: baselineInput.sha256 ?? null, candidate: candidateInput.sha256 ?? null,
			baselineStaged: baselineInput.stagedDigest ?? null, candidateStaged: candidateInput.stagedDigest ?? null,
		},
		runtimeSha256: ctx.pins.piRuntimeSha256, runtimeAfterSha256: runtimeAfter,
		comparison,
		...(options.retryPolicy ? { retryPolicy: options.retryPolicy, meteredOnlyComparison } : {}),
		// Only a grid run with --matched has this block; the gate above never reads it.
		...(matchedSummary ? { matched: matchedSummary } : {}),
		// Only a grid run with --twin-arms has this block; the gate above never reads it.
		...(twinSummary ? { twins: twinSummary } : {}),
		interpretation: {
			precision: "lower bound against patch-localized keys; unmatched claims are unadjudicated and are not confirmed false positives",
			passes: "ranges are across complete five-target pooled passes; three passes are coarse and are not a significance test",
			approval: "one grid is one model; approvedForThisModel requires the official five-target, three-pass grid with matched pins and every run valid; candidate pass-mean pooled TP and grid-pooled precision each at least 85% of baseline (ADR-026); no target whose candidate TP range lies wholly below its baseline range; and lower mean total parent+worker+compaction tokens. Corpus acceptance additionally requires the same for the second priority model.",
			tokens: "an invalid run carries no token count; it is excluded from the comparison and the grid is then incomplete",
			...(options.gridKind === undefined ? {} : { gridKind: "official here means the grid ran as its pinned kind; approvedForThisModel is still ADR-026's rule, and the v6 pre-registration's decision rule is computed from these runs by eval/rescore.ts and eval/paired.ts" }),
			...(options.retryPolicy ? { retryTokens: "the comparison's tokens are metered tokens plus a lower-bound estimate for failed attempts pi retried that reported no usage (the previous reply's prompt plus output); meteredOnlyComparison reads metered tokens alone" } : {}),
		},
		// The gate targets' runs only: a patched twin's are in the twins block.
		delegationAudit: summarizeAudits(outcomes.filter(onGate).flatMap((o) => {
			const audit = (o.record as JsonRecord).delegationAudit as DelegationAudit | { error: string } | null | undefined;
			return o.arm === "candidate" && audit && !("error" in audit) ? [{ label: `${String((o.record as JsonRecord).key ?? o.cellId)}`, audit }] : [];
		})),
		// Per arm, so an arm that hands the turn back early is visible next to its TP.
		stops: summarizeStops(outcomes.filter(onGate).map((o) => ({ arm: o.arm, key: String((o.record as JsonRecord).key ?? o.cellId), valid: o.metric.valid, stop: (o.record as JsonRecord).stop }))),
		rows: outcomes.map((o) => o.record),
	};
	await serially(() => writeJson(join(output, "summary.json"), summary));
	await progress(interrupted ? "interrupted" : stoppedInvalid ? "stopped-invalid" : comparison.complete ? "complete" : "incomplete");
	if (!official) console.log("EXPLORATORY — not an acceptance decision");
	if (interrupted) console.log("INTERRUPTED — grid incomplete");
	if (stoppedInvalid && !interrupted) console.log(`STOPPED EARLY — ${runState.stopReason ?? "an invalid run"}`);
	if (runState.quotaExhausted) console.log(`QUOTA EXHAUSTED — wait for the reset, then: node --experimental-strip-types eval/delegation-compare.ts --resume ${output}`);
	if (loop.gaveUp.length) console.log(`ATTEMPT CAP — ${loop.gaveUp.length} pair(s) left for --resume: ${loop.gaveUp.map((g) => g.key).join(", ")}`);
	if (abandonedKeys.length) console.log(`ABANDONED — ${abandonedKeys.length} pair(s) failed at the attempt ceiling and will not be re-run: ${abandonedKeys.join(", ")}`);
	console.log(`pass-mean TP ${comparison.baseline.truePositives.mean.toFixed(2)} → ${comparison.candidate.truePositives.mean.toFixed(2)}; precision ${comparison.baseline.precision.mean.toFixed(3)} → ${comparison.candidate.precision.mean.toFixed(3)}`);
	const fmt = (x: number | null) => x === null ? "n/a" : x.toFixed(3);
	// A stopped or partial grid is not evaluated, which is not the same as failed:
	// printing BELOW there read as a quality failure the candidate did not have.
	const verdict = (within: boolean | null | undefined): string => !comparison.complete || within === null || within === undefined ? "n/a (grid incomplete)" : within ? "ok" : "BELOW";
	console.log(`gate: TP ${comparison.candidate.truePositives.mean.toFixed(2)} vs floor ${comparison.gate.truePositiveFloor.toFixed(2)} (${verdict(comparison.gate.truePositivesWithinMargin)}); pooled precision ${fmt(comparison.baseline.pooledPrecision)} → ${fmt(comparison.candidate.pooledPrecision)} vs floor ${fmt(comparison.gate.precisionFloor)} (${verdict(comparison.gate.precisionWithinMargin)}); targets below baseline range: ${comparison.gate.targetsBelowBaselineRange.join(", ") || "none"}`);
	for (const t of comparison.targets) {
		console.log(`  ${t.target}: TP ${t.baseline.truePositives.min}–${t.baseline.truePositives.max} → ${t.candidate.truePositives.min}–${t.candidate.truePositives.max}; precision ${fmt(t.baseline.pooledPrecision)} → ${fmt(t.candidate.pooledPrecision)}; tokens ${t.baseline.totalTokens.mean.toFixed(0)} → ${t.candidate.totalTokens.mean.toFixed(0)}`);
	}
	console.log(`pass-mean tokens ${comparison.baseline.totalTokens.mean.toFixed(0)} → ${comparison.candidate.totalTokens.mean.toFixed(0)}; ranges ${comparison.baseline.totalTokens.min.toFixed(0)}–${comparison.baseline.totalTokens.max.toFixed(0)} / ${comparison.candidate.totalTokens.min.toFixed(0)}–${comparison.candidate.totalTokens.max.toFixed(0)}; separated=${comparison.tokenRangesSeparated}`);
	const d = summary.delegationAudit;
	console.log(`delegation: ${d.runsThatDelegated}/${d.runs} candidate runs delegated · ${d.workers} workers ${JSON.stringify(d.workersByAgent)} ${JSON.stringify(d.workersByStatus)} outcomes ${JSON.stringify(d.workersByOutcome)} · worker share of candidate tokens ${d.workerTokenShare === null ? "n/a" : `${(100 * d.workerTokenShare).toFixed(1)}%`} · ${d.runsWithViolations} run(s) with contract violations`);
	for (const v of d.violations.slice(0, 10)) console.log(`  delegation violation ${v}`);
	for (const [arm, counts] of Object.entries(summary.stops.runs)) console.log(`stops ${arm}: ${JSON.stringify(counts)}`);
	if (matchedSummary) {
		const mc = matchedSummary.comparisons.matchedVsCandidate;
		const ratio = matchedSummary.budgetRatio.median;
		console.log(`matched (${matchedSummary.policy.mode}, k=${matchedSummary.policy.k}): ${matchedSummary.unions.filter((u) => u.valid).length}/${matchedSummary.unions.length} pairs valid · pass-mean TP matched ${(mc.arms.matched?.truePositives.mean ?? 0).toFixed(2)} vs candidate ${(mc.arms.candidate?.truePositives.mean ?? 0).toFixed(2)} (${mc.complete ? "complete" : "incomplete"}) · pooled precision ${fmt(mc.arms.matched?.pooledPrecision ?? null)} vs ${fmt(mc.arms.candidate?.pooledPrecision ?? null)} · median budget ratio ${ratio === null ? "n/a" : ratio.toFixed(3)} over ${matchedSummary.budgetRatio.perPair.length} pair(s) · reported beside the gate, not in it`);
	}
	if (twinSummary) {
		const line = twinSummary.arms.map((arm) => {
			const a = twinSummary.byArm[arm]!;
			return `${arm} ${a.valid}/${a.runs} valid, ${a.claims} claims`;
		}).join(" · ");
		console.log(`patched twins (${twinSummary.targets.length}, beside the gate): ${line} · control score: eval/rescore.ts`);
	}
	// When not approved, print the reason, never the bare approval decision string.
	if (approved) console.log(`APPROVED (this model) · ${comparison.decision}`);
	else console.log(`NOT APPROVED (this model) · ${notApprovedReasons.join(" · ")}`);
	console.log(`summary ${join(output, "summary.json")}`);
	process.exitCode = approved ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main().catch(async (error) => {
		const recorded = error instanceof PreflightError || error instanceof ResumeRefusedError;
		console.error(recorded ? (error as Error).message : error instanceof Error ? error.stack ?? error.message : String(error));
		// A top-level throw means the grid did not finish; leave a terminal marker so
		// a polling operator sees "crashed", not a stale "running". A preflight
		// failure or a refused resume already wrote its own terminal status, so it is
		// not overwritten. statusFile.path is a resume's own status file until the
		// resume is accepted, so a resume that crashes early never marks the grid.
		if (statusFile.path && !gridFinished && !recorded) {
			await reportStatus({ status: "crashed", error: message(error) }).catch(() => undefined);
		}
		process.exitCode = 1;
	}).finally(async () => {
		// After the crash marker, so a resume waiting on the claim cannot start and
		// then have its own progress.json overwritten by this runner's last write.
		await releaseOwner();
	});
}
