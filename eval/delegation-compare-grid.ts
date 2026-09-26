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
import type { Arm, OfficialShape, PairArm } from "./delegation-compare-lib.ts";

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
		if (typeof raw.label !== "string" || !raw.label) throw new Error(`${where}.label must name the corpus's targets`);
		if (raw.kindless !== undefined && typeof raw.kindless !== "boolean") throw new Error(`${where}.kindless must be a boolean`);
		out[name] = {
			targets: targets as string[] | null, passes: passes as number | null, manifestSha256: manifestSha256 as string | null,
			truthSha256: truth as Record<string, string> | null, label: raw.label, kindless: raw.kindless === true,
		};
	}
	return out;
}

/** A corpus's official shape, or undefined while its targets or passes are not frozen. */
export function shapeOf(corpus: PinnedCorpus | undefined): OfficialShape | undefined {
	return corpus && corpus.targets && corpus.passes !== null ? { targets: corpus.targets, passes: corpus.passes } : undefined;
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
		...(corpus.targets === null ? ["targets"] : []), ...(corpus.passes === null ? ["passes"] : []),
		...(corpus.manifestSha256 === null ? ["manifestSha256"] : []), ...(corpus.truthSha256 === null ? ["truthSha256"] : []),
	];
	if (unfrozen.length) reasons.push(`corpus ${name} is not frozen: eval/delegation-compare.pins.json has no ${unfrozen.join(", ")} for it`);
	if (input.selected) reasons.push("--only selects a subset");
	if (corpus.passes !== null && input.passes !== corpus.passes) reasons.push(`--passes ${input.passes} is not ${corpus.passes}`);
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
 * switched off the way an operator switches it off, so its cap is 0 and it
 * states no verifier cap: at 0 verifiers share the worker cap, which is 0.
 */
export function scopeSettingsFor(arm: Arm, options: ArmOptions): ScopeSettings {
	const budget = (options.budgetArms ?? DEFAULT_BUDGET_ARMS).includes(arm);
	if (arm === "matched") return { maxAgents: 0, budget };
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
	return reasons;
}
