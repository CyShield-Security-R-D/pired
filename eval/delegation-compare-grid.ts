/**
 * The grid's shape and identity (delegation v6, plan item 2.8): which corpora
 * are official, how many targets a grid takes, and what an official grid on
 * each corpus must match.
 *
 * Why it exists: the harness accepted exactly five targets, and "official" was
 * the five v5 research ids hard-coded beside their manifest and truth hashes.
 * The v6 trial runs on a fresh corpus of twelve targets, so the official
 * definition moves into eval/delegation-compare.pins.json, where a freeze
 * edits a pin rather than the code, and the pins file is itself a harness pin
 * (a grid cannot straddle an edit to it).
 *
 * Everything here is pure: the runner reads the files, hashes them and passes
 * the results in.
 */
import { parseBreakerPolicy, type Arm, type BreakerPolicy, type OfficialShape, type PairArm } from "./delegation-compare-lib.ts";
import { parseMatchedPolicy, type MatchedPolicy } from "./delegation-compare-matched.ts";
import { isValidityPolicy, VALIDITY_POLICIES, type ValidityPolicy } from "./delegation-compare-validity.ts";

/** An official corpus as eval/delegation-compare.pins.json pins it under `corpora`. */
export interface PinnedCorpus {
	/** The gate targets' ids (twins excluded), or null until the corpus is frozen. */
	targets: string[] | null;
	/** The fixed pass count, or null until it is frozen. */
	passes: number | null;
	/** sha256 of the corpus manifest file, or null until frozen. */
	manifestSha256: string | null;
	/** sha256 of every target's truth file, twins included, by target name; null until frozen. */
	truthSha256: Record<string, string> | null;
	/**
	 * sha256 of the patched twins file (plan item 2.8): absent for a corpus with
	 * no twins, null until frozen.
	 */
	twinsSha256?: string | null;
	/** How an exploratory reason names this corpus's targets, e.g. "the five research targets". */
	label: string;
	/**
	 * Whether a grid without --grid-kind can be official on this corpus. True
	 * only for the v5 corpus, whose grids ran before grid kinds existed and must
	 * still be recognised exactly as they were. A kind-only corpus is official
	 * only through a grid kind, which also fixes the arms' configuration.
	 */
	kindless: boolean;
}

const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `corpora` from the pins file. Absent reads as none, so every grid is
 * exploratory. A value that is present but malformed is refused rather than
 * read as unfrozen: a typo in a frozen hash must not quietly turn an official
 * corpus into one that can never approve, or into one that approves anything.
 * Keys starting with "_" are comments.
 */
export function parseCorpora(value: unknown): Record<string, PinnedCorpus> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("pins: corpora must be an object");
	const out: Record<string, PinnedCorpus> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (name.startsWith("_")) continue;
		if (!isRecord(raw)) throw new Error(`pins: corpora.${name} must be an object`);
		const where = `pins: corpora.${name}`;
		const targets = raw.targets ?? null;
		if (targets !== null && (!Array.isArray(targets) || !targets.length || targets.some((t) => typeof t !== "string" || !t) || new Set(targets).size !== targets.length)) {
			throw new Error(`${where}.targets must be null or a non-empty list of distinct target ids`);
		}
		const passes = raw.passes ?? null;
		if (passes !== null && (typeof passes !== "number" || !Number.isSafeInteger(passes) || passes < 1)) throw new Error(`${where}.passes must be null or a positive integer`);
		const manifestSha256 = raw.manifestSha256 ?? null;
		if (manifestSha256 !== null && !hex64(manifestSha256)) throw new Error(`${where}.manifestSha256 must be null or a sha256 hex digest`);
		const truth = raw.truthSha256 ?? null;
		if (truth !== null && (!isRecord(truth) || Object.values(truth).some((v) => !hex64(v)))) throw new Error(`${where}.truthSha256 must be null or an object of sha256 hex digests by target name`);
		const twins = raw.twinsSha256;
		if (twins !== undefined && twins !== null && !hex64(twins)) throw new Error(`${where}.twinsSha256 must be absent, null or a sha256 hex digest`);
		if (typeof raw.label !== "string" || !raw.label) throw new Error(`${where}.label must name the corpus's targets`);
		if (raw.kindless !== undefined && typeof raw.kindless !== "boolean") throw new Error(`${where}.kindless must be a boolean`);
		out[name] = {
			targets: targets as string[] | null, passes: passes as number | null, manifestSha256: manifestSha256 as string | null,
			truthSha256: truth as Record<string, string> | null, label: raw.label, kindless: raw.kindless === true,
			...(twins === undefined ? {} : { twinsSha256: twins as string | null }),
		};
	}
	return out;
}

/**
 * A corpus's official shape, or undefined while its targets or passes are not
 * frozen. `gridPasses` is the grid's own pass count, for a kind whose passes
 * are extendable: the corpus then fixes the targets only.
 */
export function shapeOf(corpus: PinnedCorpus | undefined, gridPasses?: number): OfficialShape | undefined {
	const passes = gridPasses ?? corpus?.passes ?? null;
	return corpus && corpus.targets && passes !== null ? { targets: corpus.targets, passes } : undefined;
}

/**
 * The corpus a grid without --grid-kind is judged against: the kindless corpus
 * whose targets are the grid's, else the first kindless corpus, so that its
 * reasons say what the grid differs from. Undefined when none is pinned.
 */
export function kindlessCorpus(corpora: Record<string, PinnedCorpus>, gateIds: readonly string[]): [string, PinnedCorpus] | undefined {
	const kindless = Object.entries(corpora).filter(([, c]) => c.kindless);
	const same = (c: PinnedCorpus): boolean => c.targets !== null && c.targets.length === gateIds.length && gateIds.every((id) => c.targets!.includes(id));
	return kindless.find(([, c]) => same(c)) ?? kindless[0];
}

/** What the runner measured about the grid's inputs, for the corpus check. */
export interface CorpusInput {
	/** The gate targets' ids after --only, in manifest order (twins excluded). */
	gateIds: readonly string[];
	/** Every loaded target, gate and twin, with the sha256 of its truth file. */
	targets: ReadonlyArray<{ id: string; name: string; truthSha256: string }>;
	passes: number;
	/** --only was given. */
	selected: boolean;
	manifestSha256: string;
	/** sha256 of the twins file, when the grid runs twins. */
	twinsSha256?: string;
	/** The grid's kind sets its own pass count (extendablePasses), so the corpus's is neither read nor required. */
	passesByGrid?: boolean;
}

/**
 * Why a grid is not the official grid of `corpus`, or [] when its shape and
 * every pinned input match. The reasons, and their order, are the ones the
 * runner gave for the v5 corpus before the definition moved into the pins
 * file, so a v5 grid reads exactly as it did.
 */
export function corpusReasons(name: string, corpus: PinnedCorpus, input: CorpusInput): string[] {
	const reasons: string[] = [];
	const unfrozen = [
		...(corpus.targets === null ? ["targets"] : []), ...(corpus.passes === null && !input.passesByGrid ? ["passes"] : []),
		...(corpus.manifestSha256 === null ? ["manifestSha256"] : []), ...(corpus.truthSha256 === null ? ["truthSha256"] : []),
		...(corpus.twinsSha256 === null ? ["twinsSha256"] : []),
	];
	if (unfrozen.length) reasons.push(`corpus ${name} is not frozen: eval/delegation-compare.pins.json has no ${unfrozen.join(", ")} for it`);
	if (input.selected) reasons.push("--only selects a subset");
	if (corpus.passes !== null && !input.passesByGrid && input.passes !== corpus.passes) reasons.push(`--passes ${input.passes} is not ${corpus.passes}`);
	const pinned = corpus.targets;
	if (pinned && !input.selected && (input.gateIds.length !== pinned.length || input.gateIds.some((id) => !pinned.includes(id)))) {
		reasons.push(`manifest targets differ from ${corpus.label}`);
	}
	// Pin the identity of what is graded, not only the grid shape: a manifest
	// whose scope changed (which changes the prompt) or an edited truth key can
	// keep the same ids and would otherwise read as official.
	if (corpus.manifestSha256 !== null && input.manifestSha256 !== corpus.manifestSha256) {
		reasons.push(`research manifest sha256 ${input.manifestSha256.slice(0, 12)} is not the pinned ${corpus.manifestSha256.slice(0, 12)}`);
	}
	// A grid that runs twins on a corpus without them has more runs than its
	// official grid, on trees nobody froze; one whose twins file differs runs
	// other twins. A grid that runs none is judged by its kind's twin arms.
	if (input.twinsSha256 !== undefined) {
		if (corpus.twinsSha256 === undefined) reasons.push(`corpus ${name} has no patched twins; --twins adds runs its official grid did not have`);
		else if (corpus.twinsSha256 !== null && input.twinsSha256 !== corpus.twinsSha256) {
			reasons.push(`twins file sha256 ${input.twinsSha256.slice(0, 12)} is not the pinned ${corpus.twinsSha256.slice(0, 12)}`);
		}
	}
	if (corpus.truthSha256 !== null) {
		for (const target of input.targets) {
			const want = corpus.truthSha256[target.name];
			if (!want) reasons.push(`${target.id} (${target.name}) has no pinned truth hash`);
			else if (target.truthSha256 !== want) reasons.push(`${target.name} truth key sha256 ${String(target.truthSha256).slice(0, 12)} is not the pinned ${want.slice(0, 12)}`);
		}
	}
	return reasons;
}

/** Every arm, in the order a list of arms is written in the manifest and compared on resume. */
export const ARM_ORDER: readonly Arm[] = ["baseline", "candidate", "matched"];

/**
 * The arms whose scope states the budget line (3.2) when --budget-arms is not
 * given: the candidate snapshot's arms, exactly what every grid before plan
 * item 2.8 wrote. The baseline's scope then stays byte-identical to earlier grids'.
 */
export const DEFAULT_BUDGET_ARMS: readonly Arm[] = ["candidate", "matched"];

/**
 * The arms that load the pinned pi-subagents extension when --subagents-arms
 * is not given: the candidate, and the matched arm that runs its snapshot with
 * the cap at 0. The baseline loads nothing else, as in every earlier grid.
 */
export const DEFAULT_SUBAGENTS_ARMS: readonly Arm[] = ["candidate", "matched"];

/**
 * A comma-separated list of arms (or "none"), deduplicated into ARM_ORDER, so
 * that the same set always reads, pins and compares the same.
 */
export function parseArmList(text: string, allowed: readonly Arm[], flag: string): Arm[] {
	const value = text.trim();
	if (value === "none") return [];
	const parts = value.split(",").map((x) => x.trim());
	for (const part of parts) if (!allowed.includes(part as Arm)) throw new Error(`${flag}: "${part}" is not one of ${allowed.join(", ")} (or "none")`);
	if (new Set(parts).size !== parts.length) throw new Error(`${flag} names an arm more than once`);
	return ARM_ORDER.filter((arm) => parts.includes(arm));
}

/** Whether two arm lists name the same set. */
export function sameArms(a: readonly Arm[], b: readonly Arm[]): boolean {
	return a.length === b.length && a.every((arm) => b.includes(arm));
}

const isCap = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * --max-verifiers: `<arm>=<n>` pairs for the baseline and the candidate. The
 * matched arm is the candidate with delegation off, so it states no verifier
 * cap of its own.
 */
export function parseMaxVerifiers(text: string): Partial<Record<PairArm, number>> {
	const out: Partial<Record<PairArm, number>> = {};
	for (const part of text.split(",")) {
		const [arm, value, extra] = part.split("=").map((x) => x.trim());
		if ((arm !== "baseline" && arm !== "candidate") || value === undefined || value === "" || extra !== undefined) {
			throw new Error(`--max-verifiers: expected <arm>=<n> with arm baseline or candidate, got "${part}"`);
		}
		if (out[arm] !== undefined) throw new Error(`--max-verifiers: ${arm} is given twice`);
		const n = Number(value);
		if (!isCap(n)) throw new Error(`--max-verifiers: ${arm}'s cap must be a non-negative integer`);
		out[arm] = n;
	}
	return out;
}

/** The per-arm options that shape a cell's scope. Absent fields are the pre-2.8 behaviour. */
export interface ArmOptions {
	/** The candidate's worker cap (ADR-032); absent only for a grid whose manifest predates the option. */
	candidateMaxAgents?: number;
	/** --baseline-max-agents; absent, the baseline's scope names no cap, as in every earlier grid. */
	baselineMaxAgents?: number;
	/** --max-verifiers; absent for an arm, its scope names no verifier cap. */
	maxVerifiers?: Partial<Record<PairArm, number>>;
	/** --budget-arms; absent, DEFAULT_BUDGET_ARMS. */
	budgetArms?: readonly Arm[];
	/** --subagents-arms; absent, DEFAULT_SUBAGENTS_ARMS. */
	subagentsArms?: readonly Arm[];
}

/**
 * Whether an arm's cell loads the pinned pi-subagents extension. It is part of
 * what the model is shown, beside the scope: stage 2 runs S as its baseline, and
 * S loaded pi-subagents as stage 1's candidate, so the baseline must be able to
 * load it too, or the two stages' S would be two arms.
 */
export function loadsSubagentsFor(arm: Arm, options: Pick<ArmOptions, "subagentsArms">): boolean {
	return (options.subagentsArms ?? DEFAULT_SUBAGENTS_ARMS).includes(arm);
}

/** What one arm's scope states beyond the research setup. */
export interface ScopeSettings {
	maxAgents?: number;
	maxVerifiers?: number;
	/** Whether the scope carries the budget line (3.2). */
	budget: boolean;
}

/**
 * One arm's scope settings. The matched arm is the candidate with delegation
 * switched off the way an operator switches it off, so its cap is 0. When the
 * candidate's scope states a verifier cap, the matched arm's states 0 as well:
 * that switches verifiers off in so many words, and in stage 2 it makes M's
 * scope the same bytes as S's, the arm it is read beside. Otherwise it states
 * none, as before (at 0 verifiers share the worker cap, which is 0).
 */
export function scopeSettingsFor(arm: Arm, options: ArmOptions): ScopeSettings {
	const budget = (options.budgetArms ?? DEFAULT_BUDGET_ARMS).includes(arm);
	if (arm === "matched") return { maxAgents: 0, ...(options.maxVerifiers?.candidate === undefined ? {} : { maxVerifiers: 0 }), budget };
	const maxAgents = arm === "candidate" ? options.candidateMaxAgents : options.baselineMaxAgents;
	const maxVerifiers = options.maxVerifiers?.[arm];
	return { ...(maxAgents === undefined ? {} : { maxAgents }), ...(maxVerifiers === undefined ? {} : { maxVerifiers }), budget };
}

/**
 * Whether an arm's scope switches delegation off: no workers and no verifiers.
 * pired then hides the launcher (core/subagents.ts hiddenParentTools). An arm
 * whose scope names no cap runs at its snapshot's default, which the harness
 * does not know, so it is not read as off.
 */
export function delegationOff(settings: ScopeSettings): boolean {
	return settings.maxAgents === 0 && (settings.maxVerifiers ?? 0) === 0;
}

/**
 * The scope a cell runs under: whole-application, unenforced, exactly the
 * research setup, plus what its arm's settings state. The keys are written in
 * one order whatever the arm, so the same settings give the same bytes in
 * either role: stage 2 runs the stage-1 candidate S as its baseline, and S's
 * scope must not change with the role.
 *
 * The budget line states the ceilings the harness enforces (3.2): `minutes` is
 * the run's time limit, whole minutes, rounded down, and `deadline` the
 * absolute time it runs out, computed before launch so it is never later than
 * the kill. A limit under a minute states none.
 */
export function scopeFor(engagement: string, workspace: string, settings: ScopeSettings, timeoutMs?: number, nowMs: number = Date.now()): Record<string, unknown> {
	const scope: Record<string, unknown> = { engagement, workspace, mode: "off", authorized: false, targets: {} };
	if (settings.maxAgents !== undefined) scope.maxAgents = settings.maxAgents;
	if (settings.maxVerifiers !== undefined) scope.maxVerifiers = settings.maxVerifiers;
	const minutes = timeoutMs !== undefined && Number.isFinite(timeoutMs) ? Math.floor(timeoutMs / 60_000) : 0;
	if (settings.budget && minutes >= 1) scope.budget = { minutes, deadline: new Date(nowMs + timeoutMs!).toISOString() };
	return scope;
}

/**
 * Why a grid without --grid-kind that sets a 2.8 arm option is exploratory.
 * The v5 official grid ran every arm at the configuration these options leave
 * alone; a grid that changes one is measuring different arms.
 */
export function kindlessArmReasons(options: ArmOptions): string[] {
	const reasons: string[] = [];
	if (options.baselineMaxAgents !== undefined) reasons.push(`the baseline's scope states maxAgents ${options.baselineMaxAgents}; without --grid-kind the baseline runs at its snapshot's default`);
	for (const arm of ["baseline", "candidate"] as const) {
		const n = options.maxVerifiers?.[arm];
		if (n !== undefined) reasons.push(`the ${arm}'s scope states maxVerifiers ${n}; without --grid-kind no arm states a verifier cap`);
	}
	if (options.budgetArms !== undefined && !sameArms(options.budgetArms, DEFAULT_BUDGET_ARMS)) {
		reasons.push(`the budget line is on ${options.budgetArms.join(",") || "no arm"}, not ${DEFAULT_BUDGET_ARMS.join(",")}; without --grid-kind the arms keep the default`);
	}
	if (options.subagentsArms !== undefined && !sameArms(options.subagentsArms, DEFAULT_SUBAGENTS_ARMS)) {
		reasons.push(`pi-subagents is loaded in ${options.subagentsArms.join(",") || "no arm"}, not ${DEFAULT_SUBAGENTS_ARMS.join(",")}; without --grid-kind the arms keep the default`);
	}
	return reasons;
}

/**
 * Why a grid without --grid-kind that sets a validity policy is exploratory:
 * the v5 official grid judged a run that reached the limit, and a fast empty
 * run, invalid, and a grid that counts them is judged by other rules.
 */
export function kindlessValidityReasons(validity: ValidityPolicy | undefined): string[] {
	return validity === undefined ? [] : [`runs are judged by the ${validity} validity policy; without --grid-kind the v5 rules apply, under which a run that reaches the limit and a fast empty run are invalid`];
}

/** A fixed region as the fresh corpus records it: the lines the fix changed in the patched tree. */
export interface FixedRegion { file: string; line_range: [number, number]; advisory?: string }

/** A patched twin as a grid target: its entry from the twins file, re-keyed. */
export type TwinTarget = Record<string, unknown> & { id: string; name: string; twinOf: string; aliases: string[]; fixed_regions: FixedRegion[] };

/**
 * The fresh corpus's twins file (eval/corpus/fresh/twins.json) as grid targets.
 *
 * Each entry is its target's fix-commit tree. It carries its target's advisory
 * as `id` and its target's name as `twin_of`, but a grid keys every cell, pin,
 * pair and run record by id, so under the same id a twin's runs would merge
 * with its target's. A twin therefore takes its own `name` as its grid id,
 * which is unique (it names the tree on disk), and `twinOf` names its target
 * by id. The advisory id moves into `aliases`, so the leak check and the
 * copy's stripping still look for it: a fix commit is where a changelog is
 * most likely to name the advisory. Every other field (fixed_regions,
 * scope_loc, scope, ...) is kept as it is, for eval/rescore.ts's control score.
 */
export function twinTargets(raw: unknown, targets: ReadonlyArray<{ id: string; name: string }>): TwinTarget[] {
	if (!Array.isArray(raw) || !raw.length) throw new Error("the twins file must be a non-empty list of patched twins");
	const byName = new Map(targets.map((t) => [t.name, t]));
	const taken = new Set(targets.flatMap((t) => [t.id, t.name]));
	return raw.map((entry, i): TwinTarget => {
		if (!isRecord(entry)) throw new Error(`twin ${i + 1} is not an object`);
		const name = entry.name;
		if (typeof name !== "string" || !name) throw new Error(`twin ${i + 1} has no name`);
		if (typeof entry.id !== "string" || !entry.id) throw new Error(`twin ${name} has no advisory id`);
		if (taken.has(name)) throw new Error(`twin ${name} reuses a target's or another twin's id or name`);
		taken.add(name);
		const of = typeof entry.twin_of === "string" ? byName.get(entry.twin_of) : undefined;
		if (!of) throw new Error(`twin ${name} names no target of the manifest as twin_of (${JSON.stringify(entry.twin_of)})`);
		const regions = entry.fixed_regions;
		if (!Array.isArray(regions) || regions.some((r) => !isRecord(r) || typeof r.file !== "string" || !r.file || !Array.isArray(r.line_range) || r.line_range.length !== 2
			|| !r.line_range.every((n) => Number.isSafeInteger(n) && (n as number) >= 1) || (r.line_range[0] as number) > (r.line_range[1] as number))) {
			throw new Error(`twin ${name} needs fixed_regions: a list of {file, line_range: [lo, hi]}`);
		}
		if (entry.scope_loc !== undefined && entry.scope_loc !== null && !(typeof entry.scope_loc === "number" && Number.isFinite(entry.scope_loc) && entry.scope_loc >= 0)) {
			throw new Error(`twin ${name} has an invalid scope_loc`);
		}
		const aliases = Array.isArray(entry.aliases) ? entry.aliases.map(String) : [];
		return { ...entry, id: name, name, twinOf: of.id, aliases: [...new Set([entry.id, ...aliases])], fixed_regions: regions as FixedRegion[] };
	});
}

/** One patched twin's run as the twin summary lists it: enough to find its ledger and pair it with its target. */
export interface TwinCell { key: string; target: string; twinOf: string; pass: number; attempt: number; cellId: string | null; valid: boolean; claims: number | null }

export interface TwinArmSummary { runs: number; valid: number; claims: number; cells: TwinCell[] }

export interface TwinSummary {
	arms: PairArm[];
	targets: Array<{ id: string; twinOf: string }>;
	expectedRuns: number;
	byArm: Partial<Record<PairArm, TwinArmSummary>>;
	interpretation: Record<string, string>;
}

/**
 * The patched twins' part of summary.json (plan item 2.8), per arm: the runs
 * at each twin pair's highest attempt, how many were valid, the claims they
 * made, and each run's cell, which is where eval/rescore.ts reads the ledger
 * it scores against the fixed regions. It approves nothing and the gate never
 * reads it.
 */
export function summarizeTwins(arms: readonly PairArm[], twins: ReadonlyArray<{ id: string; twinOf: string }>, passes: number, rows: ReadonlyArray<Record<string, unknown>>): TwinSummary {
	const twinOf = new Map(twins.map((t) => [t.id, t.twinOf]));
	const byArm: Partial<Record<PairArm, TwinArmSummary>> = {};
	for (const arm of arms) {
		const cells = rows.filter((r) => r.arm === arm && twinOf.has(String(r.target))).map((r): TwinCell => ({
			key: String(r.key), target: String(r.target), twinOf: twinOf.get(String(r.target))!, pass: Number(r.pass),
			attempt: typeof r.attempt === "number" ? r.attempt : 1, cellId: typeof r.cellId === "string" && r.cellId ? r.cellId : null,
			valid: r.valid === true, claims: typeof r.findings === "number" ? r.findings : null,
		})).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		byArm[arm] = {
			runs: cells.length, valid: cells.filter((c) => c.valid).length,
			claims: cells.reduce((n, c) => n + (c.valid && c.claims !== null ? c.claims : 0), 0), cells,
		};
	}
	return {
		arms: [...arms], targets: twins.map((t) => ({ id: t.id, twinOf: t.twinOf })), expectedRuns: twins.length * passes * arms.length, byArm,
		interpretation: {
			twins: "each twin is its target's fix-commit tree; its key has no labels, so every claim on it is either unrelated to the advisory or a re-flag of the fixed code",
			control: "the control score (claims within 3 lines of a fixed region, and claims per KLOC) is computed by eval/rescore.ts from each cell's ledger and the grid manifest's fixed_regions and scope_loc; claims here are the pinned scorer's count over valid runs",
			gate: "twin runs never enter the gate comparison, the matched arm or the approval; they count toward progress and the breaker like any run",
		},
	};
}

/**
 * A snapshot a kind pins: its input digest and, optionally, its staged
 * (redacted) digest, the tree the model reads. `sameAs` names the kind and arm
 * whose pin this one is, resolved at parse time: stage 2's S and D are the
 * snapshot stage 1 ran as S, so they are pinned once, not three times by hand.
 */
export interface SnapshotPin { digest: string | null; stagedDigest?: string | null; sameAs?: string }

/**
 * A named grid kind (plan item 2.8), as the pins file's `gridKinds` fixes it:
 * the corpus, the snapshots, every arm's configuration, and whether the grid
 * runs with retries and the breaker. The fields mirror the command line, so a
 * grid matches its kind exactly when its options are the kind's.
 */
export interface GridKind {
	corpus: string;
	/** The baseline: a git commit (checked file by file, as the v5 baseline was) or a snapshot digest; null until frozen. */
	baseline: { commit: string | null } | SnapshotPin;
	candidate: SnapshotPin;
	/** --baseline-max-agents; null: the baseline's scope states none. */
	baselineMaxAgents: number | null;
	/** --candidate-max-agents (ADR-032). */
	candidateMaxAgents: number;
	/** --max-verifiers; {} states none. */
	maxVerifiers: Partial<Record<PairArm, number>>;
	/** --budget-arms, in ARM_ORDER. */
	budgetArms: Arm[];
	/** --subagents-arms, in ARM_ORDER: the arms whose cells load the pinned pi-subagents. */
	subagentsArms: Arm[];
	/** --twin-arms, in ARM_ORDER; [] runs no twin. */
	twinArms: PairArm[];
	/** --matched, as the manifest stores it; null runs no matched arm. */
	matched: MatchedPolicy | null;
	/** --retry (ADR-033). */
	retry: boolean;
	/** --breaker (ADR-031): false for fail-fast, true for any policy, or the exact policy. */
	breaker: boolean | BreakerPolicy;
	/** --timeout; null leaves the run limit open. */
	timeoutMs: number | null;
	/** --thinking, the effort both arms run at; null leaves it open. */
	thinking: string | null;
	/**
	 * Whether the grid's passes may grow at a resume (--extend-passes). When true
	 * the pass count is the grid's own, set by its pilot and its one amendment,
	 * and the corpus pins none.
	 */
	extendablePasses: boolean;
	/** The pilot's pass count an extendable kind's grid starts at; null otherwise. */
	pilotPasses: number | null;
	/** The most passes its one amendment may fix; null leaves it open. */
	maxPasses: number | null;
	/**
	 * The kind whose fixed pass count this kind's grid adopts (--passes-from):
	 * stage 2 runs at the count stage 1's pilot fixed. Null otherwise.
	 */
	passesFrom: string | null;
	/**
	 * --validity: the run-validity policy the kind's grids are judged by
	 * (eval/delegation-compare-validity.ts). Absent, the v5 rules: a run that
	 * reaches the limit and a fast empty run are invalid.
	 */
	validity?: ValidityPolicy;
}

const hexCommit = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/**
 * `gridKinds` from the pins file, read strictly: a kind that names an unknown
 * corpus or a malformed value would otherwise make every grid launched under
 * it exploratory for a reason nobody reads until the grid has run. Keys
 * starting with "_" are comments.
 */
export function parseGridKinds(value: unknown, corpora: Record<string, PinnedCorpus>): Record<string, GridKind> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("pins: gridKinds must be an object");
	const out: Record<string, GridKind> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (name.startsWith("_")) continue;
		const where = `pins: gridKinds.${name}`;
		if (!isRecord(raw)) throw new Error(`${where} must be an object`);
		if (typeof raw.corpus !== "string" || !corpora[raw.corpus]) throw new Error(`${where}.corpus must name a corpus of the pins file`);
		const baseline = raw.baseline;
		if (isRecord(baseline) && Object.keys(baseline).length === 1 && "commit" in baseline) {
			if (baseline.commit !== null && !hexCommit(baseline.commit)) throw new Error(`${where}.baseline.commit must be null or a full git commit id`);
		} else if (!snapshotPinShape(baseline)) throw new Error(`${where}.baseline must be {commit}, {digest, stagedDigest?} or {sameAs}`);
		const candidate = raw.candidate;
		if (!snapshotPinShape(candidate)) throw new Error(`${where}.candidate must be {digest: null or a sha256 hex digest, stagedDigest?} or {sameAs}`);
		if (raw.baselineMaxAgents !== null && !isCap(raw.baselineMaxAgents)) throw new Error(`${where}.baselineMaxAgents must be null or a non-negative integer`);
		if (!isCap(raw.candidateMaxAgents)) throw new Error(`${where}.candidateMaxAgents must be a non-negative integer`);
		const verifiers = raw.maxVerifiers;
		if (!isRecord(verifiers) || Object.entries(verifiers).some(([arm, n]) => (arm !== "baseline" && arm !== "candidate") || !isCap(n))) throw new Error(`${where}.maxVerifiers must map baseline or candidate to a non-negative integer`);
		const arms = (key: "budgetArms" | "subagentsArms" | "twinArms", allowed: readonly Arm[]): Arm[] => {
			const list = raw[key];
			if (!Array.isArray(list) || list.some((arm) => !allowed.includes(arm as Arm)) || new Set(list).size !== list.length) throw new Error(`${where}.${key} must be a list of distinct arms among ${allowed.join(", ")}`);
			return ARM_ORDER.filter((arm) => list.includes(arm));
		};
		let matched: MatchedPolicy | null = null;
		if (raw.matched !== null) {
			try { matched = parseMatchedPolicy(raw.matched); } catch (error) { throw new Error(`${where}.matched: ${error instanceof Error ? error.message : String(error)}`); }
			if (matched.snapshot !== undefined) throw new Error(`${where}.matched runs the candidate snapshot; it names no other`);
		}
		if (typeof raw.retry !== "boolean") throw new Error(`${where}.retry must be a boolean`);
		let breaker: boolean | BreakerPolicy;
		if (typeof raw.breaker === "boolean") breaker = raw.breaker;
		else {
			try { breaker = parseBreakerPolicy(raw.breaker); } catch (error) { throw new Error(`${where}.breaker: ${error instanceof Error ? error.message : String(error)}`); }
		}
		if (raw.timeoutMs !== null && !(typeof raw.timeoutMs === "number" && Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs > 0)) throw new Error(`${where}.timeoutMs must be null or a positive integer`);
		if (raw.extendablePasses !== undefined && typeof raw.extendablePasses !== "boolean") throw new Error(`${where}.extendablePasses must be a boolean`);
		const passCount = (key: "pilotPasses" | "maxPasses"): number | null => {
			const v = raw[key] ?? null;
			if (v !== null && !(Number.isSafeInteger(v) && (v as number) >= 1)) throw new Error(`${where}.${key} must be null or a positive integer`);
			return v as number | null;
		};
		const pilotPasses = passCount("pilotPasses");
		const maxPasses = passCount("maxPasses");
		if (raw.extendablePasses === true && pilotPasses === null) throw new Error(`${where}: an extendable kind needs pilotPasses, the count its grid starts at`);
		if (pilotPasses !== null && maxPasses !== null && pilotPasses > maxPasses) throw new Error(`${where}.pilotPasses is above maxPasses`);
		const passesFrom = raw.passesFrom ?? null;
		if (passesFrom !== null && (typeof passesFrom !== "string" || !passesFrom || name === passesFrom)) throw new Error(`${where}.passesFrom must be null or another kind's name`);
		if (passesFrom !== null && raw.extendablePasses === true) throw new Error(`${where} takes its passes from ${String(passesFrom)}, so it cannot also extend them`);
		if (raw.validity !== undefined && !isValidityPolicy(raw.validity)) throw new Error(`${where}.validity must be one of ${VALIDITY_POLICIES.join(", ")} when present`);
		if (raw.thinking !== null && !(typeof raw.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(raw.thinking))) throw new Error(`${where}.thinking must be null or a thinking level`);
		out[name] = {
			corpus: raw.corpus, baseline: { ...(baseline as Record<string, unknown>) } as GridKind["baseline"], candidate: { ...(candidate as Record<string, unknown>) } as unknown as SnapshotPin,
			baselineMaxAgents: raw.baselineMaxAgents as number | null, candidateMaxAgents: raw.candidateMaxAgents,
			maxVerifiers: { ...verifiers } as Partial<Record<PairArm, number>>, budgetArms: arms("budgetArms", ARM_ORDER), subagentsArms: arms("subagentsArms", ARM_ORDER),
			twinArms: arms("twinArms", ["baseline", "candidate"]) as PairArm[],
			matched, retry: raw.retry, breaker, timeoutMs: raw.timeoutMs as number | null, thinking: raw.thinking as string | null, extendablePasses: raw.extendablePasses === true,
			pilotPasses, maxPasses, passesFrom: passesFrom as string | null,
			...(raw.validity === undefined ? {} : { validity: raw.validity as ValidityPolicy }),
		};
	}
	for (const [name, kind] of Object.entries(out)) {
		if (kind.passesFrom !== null && !out[kind.passesFrom]?.extendablePasses) throw new Error(`pins: gridKinds.${name}.passesFrom must name an extendable kind`);
	}
	// Resolve `sameAs` once every kind is read: a pin names "<kind>.<baseline|candidate>",
	// which must itself be a digest pin, never another reference.
	for (const [name, kind] of Object.entries(out)) {
		for (const arm of ["baseline", "candidate"] as const) {
			const pin = kind[arm] as SnapshotPin & { commit?: unknown };
			if (pin.sameAs === undefined) continue;
			const [other, otherArm] = pin.sameAs.split(".");
			const ref = other && (otherArm === "baseline" || otherArm === "candidate") ? out[other]?.[otherArm] as (SnapshotPin & { commit?: unknown }) | undefined : undefined;
			if (!ref || "commit" in ref || ref.sameAs !== undefined) throw new Error(`pins: gridKinds.${name}.${arm}.sameAs must name another kind's digest pin as <kind>.<baseline|candidate>`);
			kind[arm] = { digest: ref.digest, ...(ref.stagedDigest === undefined ? {} : { stagedDigest: ref.stagedDigest }), sameAs: pin.sameAs };
		}
	}
	return out;
}

function snapshotPinShape(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 1 && typeof value.sameAs === "string" && value.sameAs) return true;
	if (!keys.every((k) => k === "digest" || k === "stagedDigest") || !("digest" in value)) return false;
	return (value.digest === null || hex64(value.digest)) && (value.stagedDigest === undefined || value.stagedDigest === null || hex64(value.stagedDigest));
}

/** What a grid was launched with, as its kind is checked against it. */
export interface GridOptions extends ArmOptions {
	thinking?: string;
	twinArms?: readonly PairArm[];
	matched?: MatchedPolicy;
	retry: boolean;
	breaker?: BreakerPolicy;
	timeoutMs: number;
	validity?: ValidityPolicy;
}

const stated = (n: number | undefined | null): string => n === undefined || n === null ? "unstated" : String(n);
const armList = (arms: readonly Arm[]): string => arms.length ? arms.join(",") : "no arm";
const policyText = (p: MatchedPolicy | BreakerPolicy): string => JSON.stringify(p);

/**
 * Why a grid launched as `name` is not that kind's grid, or [] when every
 * option matches. Each reason says what the grid ran and what the kind fixes,
 * the way a mismatched candidate digest is reported, so an exploratory grid
 * reads as one before its first token.
 */
export function gridKindReasons(name: string, kind: GridKind, grid: GridOptions): string[] {
	const reasons: string[] = [];
	const say = (text: string): void => { reasons.push(`grid kind ${name}: ${text}`); };
	if ((grid.baselineMaxAgents ?? null) !== kind.baselineMaxAgents) say(`the baseline's maxAgents is ${stated(grid.baselineMaxAgents)}, not ${stated(kind.baselineMaxAgents)}`);
	if (grid.candidateMaxAgents !== kind.candidateMaxAgents) say(`the candidate's maxAgents is ${stated(grid.candidateMaxAgents)}, not ${stated(kind.candidateMaxAgents)}`);
	for (const arm of ["baseline", "candidate"] as const) {
		if (grid.maxVerifiers?.[arm] !== kind.maxVerifiers[arm]) say(`the ${arm}'s maxVerifiers is ${stated(grid.maxVerifiers?.[arm])}, not ${stated(kind.maxVerifiers[arm])}`);
	}
	const budget = grid.budgetArms ?? DEFAULT_BUDGET_ARMS;
	if (!sameArms(budget, kind.budgetArms)) say(`the budget line is on ${armList(budget)}, not ${armList(kind.budgetArms)}`);
	const subagents = grid.subagentsArms ?? DEFAULT_SUBAGENTS_ARMS;
	if (!sameArms(subagents, kind.subagentsArms)) say(`pi-subagents is loaded in ${armList(subagents)}, not ${armList(kind.subagentsArms)}`);
	const twins = grid.twinArms ?? [];
	if (!sameArms(twins, kind.twinArms)) say(`patched twins run in ${armList(twins)}, not ${armList(kind.twinArms)}`);
	if (!grid.matched !== !kind.matched) say(`the matched arm is ${grid.matched ? "on" : "off"}, not ${kind.matched ? "on" : "off"}`);
	else if (grid.matched && kind.matched) {
		const { snapshot: _snapshot, ...ran } = grid.matched;
		if (policyText(ran) !== policyText(kind.matched)) say(`the matched policy is ${policyText(ran)}, not ${policyText(kind.matched)}`);
	}
	if (grid.retry !== kind.retry) say(kind.retry ? "it requires --retry" : "it runs without --retry");
	if (typeof kind.breaker === "boolean") {
		if (!!grid.breaker !== kind.breaker) say(kind.breaker ? "it requires --breaker" : "it runs without --breaker");
	} else if (!grid.breaker || policyText(grid.breaker) !== policyText(kind.breaker)) {
		say(`the breaker policy is ${grid.breaker ? policyText(grid.breaker) : "off"}, not ${policyText(kind.breaker)}`);
	}
	if (kind.timeoutMs !== null && grid.timeoutMs !== kind.timeoutMs) say(`--timeout ${grid.timeoutMs} is not ${kind.timeoutMs}`);
	if (kind.thinking !== null && grid.thinking !== kind.thinking) say(`--thinking ${grid.thinking ?? "unstated"} is not ${kind.thinking}`);
	if (grid.validity !== kind.validity) say(kind.validity ? `it requires --validity ${kind.validity}` : `it runs without --validity, not under ${grid.validity}`);
	return reasons;
}

/**
 * Why a kind's snapshots do not match the grid's, or [] when both are its
 * frozen ones. The baseline is either a git commit, checked by the caller's
 * file-by-file rule, or a snapshot digest: stage 2's baseline is the
 * candidate snapshot S, which has no commit.
 */
export function kindSnapshotReasons(name: string, kind: GridKind, measured: {
	baselineDigest: string; candidateDigest: string; baselineStagedDigest?: string; candidateStagedDigest?: string; commitReason: (commit: string) => string | undefined;
}): string[] {
	const reasons: string[] = [];
	const of = (pin: SnapshotPin): string => pin.sameAs ? ` (that of ${pin.sameAs})` : "";
	// The staged digest is the redacted tree the model reads: stage 2's S must be
	// the bytes stage 1's S was, not only the same input (plan item 2.8 review).
	const staged = (arm: "baseline" | "candidate", pin: SnapshotPin, actual: string | undefined): void => {
		if (pin.stagedDigest === undefined) return;
		if (pin.stagedDigest === null) reasons.push(`grid kind ${name}: no ${arm} staged digest is frozen${of(pin)}`);
		else if (actual !== pin.stagedDigest) reasons.push(`grid kind ${name}: ${arm} staged digest ${String(actual).slice(0, 12)} is not the pinned ${pin.stagedDigest.slice(0, 12)}${of(pin)}`);
	};
	if ("commit" in kind.baseline) {
		if (kind.baseline.commit === null) reasons.push(`grid kind ${name}: no baseline is frozen (its baseline.commit is null)`);
		else {
			const why = measured.commitReason(kind.baseline.commit);
			if (why) reasons.push(`grid kind ${name}: ${why}`);
		}
	} else {
		if (kind.baseline.digest === null) reasons.push(`grid kind ${name}: no baseline is frozen (its baseline.digest is null${of(kind.baseline)})`);
		else if (measured.baselineDigest !== kind.baseline.digest) reasons.push(`grid kind ${name}: baseline input digest ${measured.baselineDigest.slice(0, 12)} is not the pinned ${kind.baseline.digest.slice(0, 12)}${of(kind.baseline)}`);
		staged("baseline", kind.baseline, measured.baselineStagedDigest);
	}
	if (kind.candidate.digest === null) reasons.push(`grid kind ${name}: no candidate is frozen (its candidate.digest is null${of(kind.candidate)})`);
	else if (measured.candidateDigest !== kind.candidate.digest) reasons.push(`grid kind ${name}: candidate input digest ${measured.candidateDigest.slice(0, 12)} is not the pinned ${kind.candidate.digest.slice(0, 12)}${of(kind.candidate)}`);
	staged("candidate", kind.candidate, measured.candidateStagedDigest);
	return reasons;
}

/**
 * One amendment to a running grid's pass count (plan item 2.8). The grid's
 * manifest.json is written once and never rewritten, so an amendment is
 * appended to <out>/amendments.jsonl, and to its resume's row in
 * resumes.jsonl, when the resume that makes it is accepted; every later
 * resume's manifest lists them all.
 *
 * - `extend-passes` grows the grid from `from` to `to` passes.
 * - `fix-passes` keeps the count (`from` = `to`): the pilot's rule gave no
 *   more passes than it ran, and the grid says so rather than staying open.
 *
 * It records who made it and why, and what the grid held at that moment (how
 * many runs, a hash of runs.jsonl, a hash of summary.json when there is one),
 * so an amendment made after reading results can be told from one made before.
 */
export interface PassesAmendment {
	kind: "extend-passes" | "fix-passes";
	at: string;
	from: number;
	to: number;
	/** user@host of the operator who ran the resume. */
	by: string;
	reason: string | null;
	runsCompleted: number;
	runsSha256: string;
	summarySha256: string | null;
	resume: number;
}

/** The amendments a grid's amendments.jsonl holds, read strictly: a malformed row refuses the resume. */
export function parseAmendments(rows: readonly unknown[]): PassesAmendment[] {
	return rows.map((row, i) => {
		const ok = isRecord(row) && (row.kind === "extend-passes" || row.kind === "fix-passes") && typeof row.at === "string"
			&& Number.isSafeInteger(row.from) && Number.isSafeInteger(row.to)
			&& (row.kind === "extend-passes" ? (row.to as number) > (row.from as number) : row.to === row.from)
			&& typeof row.by === "string" && (row.reason === null || typeof row.reason === "string")
			&& Number.isSafeInteger(row.runsCompleted) && hex64(row.runsSha256) && (row.summarySha256 === null || hex64(row.summarySha256)) && Number.isSafeInteger(row.resume);
		if (!ok) throw new Error(`amendments.jsonl row ${i + 1} is not a pass-count amendment`);
		const r = row as Record<string, unknown>;
		return {
			kind: r.kind as PassesAmendment["kind"], at: r.at as string, from: r.from as number, to: r.to as number, by: r.by as string, reason: r.reason as string | null,
			runsCompleted: r.runsCompleted as number, runsSha256: r.runsSha256 as string, summarySha256: r.summarySha256 as string | null, resume: r.resume as number,
		};
	});
}

/**
 * The pass count a grid runs at now: its manifest's, then each amendment's in
 * order. An amendment that does not start where the last one ended means the
 * record was edited, and refuses the resume.
 */
export function currentPasses(manifestPasses: number, amendments: readonly PassesAmendment[]): number {
	let passes = manifestPasses;
	for (const a of amendments) {
		if (a.from !== passes) throw new Error(`amendments.jsonl amends ${a.from} passes, but the grid had ${passes} at that point`);
		passes = a.to;
	}
	return passes;
}

/**
 * Why amendments.jsonl and resumes.jsonl disagree, or undefined when every
 * amendment is recorded in both, in the same order, field for field. Either
 * file can be edited; one edited without the other is caught here, on every
 * resume and at every summary.
 */
export function amendmentsMismatch(amendments: readonly PassesAmendment[], resumeRows: readonly unknown[]): string | undefined {
	const recorded = resumeRows.flatMap((row) => isRecord(row) && row.amendment !== undefined ? [row.amendment] : []);
	if (recorded.length !== amendments.length) return `amendments.jsonl holds ${amendments.length} amendment(s) and resumes.jsonl records ${recorded.length}`;
	for (const [i, a] of amendments.entries()) {
		if (JSON.stringify(a) !== JSON.stringify(recorded[i])) return `amendment ${i + 1} differs between amendments.jsonl and resumes.jsonl`;
	}
	return undefined;
}

/** What a resume is asked to amend, and the grid it amends. */
export interface AmendmentRequest {
	passes: number;
	official: boolean;
	gridKind?: string;
	amendments: readonly PassesAmendment[];
	to: number;
	reason?: string;
}

/**
 * Why a resume may not amend a grid's passes to `to`, or undefined when it
 * may. The v6 pre-registration's internal pilot runs `pilotPasses` passes whose
 * pairs count toward the final analysis, and its rule then fixes the count, so
 * the pilot's grid grows into the full one: once.
 *
 * - An official grid of a kind amends only when its kind declares
 *   extendablePasses, only once, only from the pilot's count, to at most
 *   `maxPasses`, and only with a stated reason. A second amendment would let
 *   the count follow the results.
 * - An official grid without a kind (v5) is three passes by definition.
 * - An exploratory grid may grow; it may fix its count only if it has a kind
 *   that is extendable, since nothing else reads the fix.
 */
export function extensionRefusal(request: AmendmentRequest, kinds: Record<string, Pick<GridKind, "extendablePasses" | "pilotPasses" | "maxPasses">>): string | undefined {
	const { passes, to } = request;
	if (!Number.isSafeInteger(to) || to < passes) return `--extend-passes ${to} is below the grid's ${passes} passes`;
	const kind = request.gridKind === undefined ? undefined : kinds[request.gridKind];
	if (to === passes && !kind?.extendablePasses) return `--extend-passes ${to} keeps the grid's ${passes} passes, and only a grid of an extendable kind has a pass count to fix`;
	if (!request.official) return undefined;
	if (request.gridKind === undefined) return "an official grid without a grid kind has a fixed pass count and cannot be extended";
	if (!kind?.extendablePasses) return `grid kind ${request.gridKind} does not declare extendablePasses, so its official grid cannot be extended`;
	if (request.amendments.length) return `grid kind ${request.gridKind}'s official grid has already fixed its pass count (${request.amendments.length} amendment(s)); it is amended once`;
	if (passes !== kind.pilotPasses) return `grid kind ${request.gridKind}'s official grid is amended from its pilot's ${kind.pilotPasses} passes, not ${passes}`;
	if (kind.maxPasses !== null && to > kind.maxPasses) return `grid kind ${request.gridKind} runs at most ${kind.maxPasses} passes, not ${to}`;
	if (!request.reason?.trim()) return `grid kind ${request.gridKind}'s official grid needs --extend-reason <text>: why the pass count is ${to}`;
	return undefined;
}

/**
 * Why a kind grid's pass count is not its kind's, or [] when it is: a pilot
 * grid starts at its pilot's count and is amended once to at most maxPasses;
 * a grid whose kind takes its passes from another stage runs exactly the
 * count that stage fixed.
 */
export function kindPassesReasons(name: string, kind: GridKind, grid: { passes: number; amendments: readonly PassesAmendment[]; passesFrom?: { gridKind: string | null; passes: number; official: boolean } }): string[] {
	const reasons: string[] = [];
	const say = (text: string): void => { reasons.push(`grid kind ${name}: ${text}`); };
	if (kind.extendablePasses) {
		const [first, ...more] = grid.amendments;
		if (!first && grid.passes !== kind.pilotPasses) say(`the pilot runs ${kind.pilotPasses} passes, not ${grid.passes}`);
		if (first && first.from !== kind.pilotPasses) say(`its amendment starts from ${first.from} passes, not the pilot's ${kind.pilotPasses}`);
		if (first && kind.maxPasses !== null && first.to > kind.maxPasses) say(`its amendment runs ${first.to} passes, past ${kind.maxPasses}`);
		if (more.length) say(`its pass count was amended ${grid.amendments.length} times, not once`);
	}
	if (kind.passesFrom !== null) {
		const from = grid.passesFrom;
		if (!from) say(`it takes its pass count from a ${kind.passesFrom} grid (--passes-from <dir>)`);
		else {
			if (from.gridKind !== kind.passesFrom) say(`its passes come from a ${from.gridKind ?? "kindless"} grid, not ${kind.passesFrom}`);
			if (!from.official) say("the grid it takes its passes from is not official");
			if (grid.passes !== from.passes) say(`it runs ${grid.passes} passes, not the ${from.passes} it adopted`);
		}
	} else if (!kind.extendablePasses && grid.amendments.length) {
		say(`its pass count was amended ${grid.amendments.length} time(s), and the kind does not declare extendablePasses`);
	}
	return reasons;
}

/**
 * Whether `fresh` continues `prior`: the same pairs in the same order and arm
 * order for every pass `prior` had, with later passes after them. planSchedule
 * is pass-major with an arm-order rule that depends only on the pass and the
 * target's position, so an extended grid's schedule starts with the one it
 * had, and a pair already run keeps its cells.
 */
export function scheduleExtends(prior: readonly unknown[], fresh: readonly unknown[]): boolean {
	return fresh.length > prior.length && prior.every((pair, i) => JSON.stringify(pair) === JSON.stringify(fresh[i]));
}

/**
 * The command-line options that make a grid its kind: every option the kind
 * fixes, in the runner's own spelling. The operator's command line for a
 * stage, and the tests that hold a stage's arms equal across roles, are built
 * from this, so a kind and the flags that claim it cannot drift apart. The
 * paths (snapshots, corpus, twins file, output) are the caller's.
 */
export function kindFlags(name: string, kind: GridKind, paths: { twins?: string; passesFrom?: string } = {}): string[] {
	const flags: string[] = [];
	if (kind.thinking !== null) flags.push("--thinking", kind.thinking);
	flags.push("--candidate-max-agents", String(kind.candidateMaxAgents));
	if (kind.baselineMaxAgents !== null) flags.push("--baseline-max-agents", String(kind.baselineMaxAgents));
	const verifiers = (["baseline", "candidate"] as const).flatMap((arm) => kind.maxVerifiers[arm] === undefined ? [] : [`${arm}=${kind.maxVerifiers[arm]}`]);
	if (verifiers.length) flags.push("--max-verifiers", verifiers.join(","));
	flags.push("--budget-arms", kind.budgetArms.join(",") || "none");
	flags.push("--subagents-arms", kind.subagentsArms.join(",") || "none");
	if (kind.twinArms.length) flags.push("--twins", paths.twins ?? "<twins.json>", "--twin-arms", kind.twinArms.join(","));
	if (kind.matched) {
		const m = kind.matched;
		flags.push("--matched", [`mode=${m.mode}`, `k=${m.k}`, `kMax=${m.kMax}`, `floor=${m.floorShare}`, ...Object.entries(m.budgets ?? {}).map(([t, n]) => `budget.${t}=${n}`)].join(","));
	}
	if (kind.retry) flags.push("--retry");
	if (kind.breaker === true) flags.push("--breaker", "default");
	else if (kind.breaker) flags.push("--breaker", Object.entries(kind.breaker).map(([k, v]) => `${k}=${v}`).join(","));
	if (kind.timeoutMs !== null) flags.push("--timeout", String(kind.timeoutMs));
	if (kind.validity) flags.push("--validity", kind.validity);
	if (kind.extendablePasses && kind.pilotPasses !== null) flags.push("--passes", String(kind.pilotPasses));
	if (kind.passesFrom !== null) flags.push("--passes-from", paths.passesFrom ?? `<${kind.passesFrom} grid>`);
	flags.push("--grid-kind", name);
	return flags;
}

/** A run's gate metric as the pilot's SD reads it. */
export interface PilotRun { key: string; valid: boolean; truePositives: number }

/**
 * What a pilot grid may show before its pass count is fixed (plan item 2.8
 * review): the pre-registration reads only the pooled paired SD of the primary
 * metric, blind to the direction of the difference, to fix the pass count. So
 * no arm mean, no per-target range and no sign is shown; only how many pairs
 * are valid and the SD of their differences, which is the same whichever arm
 * is ahead. The metric is the official true positives per pair; the
 * pre-registration's advisories-found SD is computed from the sealed runs by
 * eval/v6-decision.ts.
 */
export function pilotPairedSd(baseline: readonly PilotRun[], candidate: readonly PilotRun[]): { metric: string; validPairs: number; sd: number | null } {
	const byKey = new Map(baseline.filter((r) => r.valid).map((r) => [r.key, r.truePositives]));
	const diffs = candidate.filter((r) => r.valid && byKey.has(r.key)).map((r) => r.truePositives - byKey.get(r.key)!);
	const n = diffs.length;
	const mean = n ? diffs.reduce((a, b) => a + b, 0) / n : 0;
	const sd = n >= 2 ? Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1)) : null;
	return { metric: "official true positives per pair, paired difference (sign withheld)", validPairs: n, sd };
}

/**
 * summary.json while a pilot is blind: every field that carries an arm's
 * numbers (the comparison and its metered twin, stops, the delegation audit,
 * the matched and twin blocks, the rows, and each abandoned attempt's tokens)
 * moves to the sealed file, and the pilot block takes their place.
 */
export function blindSummary(summary: Record<string, unknown>, pilot: ReturnType<typeof pilotPairedSd>, sealedPath: string): { summary: Record<string, unknown>; sealed: Record<string, unknown> } {
	const SEALED = ["comparison", "meteredOnlyComparison", "stops", "delegationAudit", "matched", "twins", "rows"];
	const out: Record<string, unknown> = {};
	const sealed: Record<string, unknown> = { id: summary.id ?? null };
	for (const [key, value] of Object.entries(summary)) {
		if (SEALED.includes(key)) { sealed[key] = value; continue; }
		if (key === "breaker" && isRecord(value)) {
			const { abandoned, ...rest } = value;
			sealed.breakerAbandoned = abandoned ?? null;
			out.breaker = { ...rest, abandoned: Array.isArray(abandoned) ? abandoned.map((a) => (isRecord(a) ? { key: a.key } : a)) : abandoned };
			continue;
		}
		out[key] = value;
	}
	out.pilot = {
		blinded: true, ...pilot, sealed: sealedPath,
		note: "until the pass count is fixed, only the paired SD is shown; the arms' numbers are sealed, never printed, and read by eval/v6-decision.ts",
	};
	return { summary: out, sealed };
}
