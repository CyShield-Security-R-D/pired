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
	/** sha256 of the twins file, when the grid runs twins. */
	twinsSha256?: string;
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
		...(corpus.twinsSha256 === null ? ["twinsSha256"] : []),
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
