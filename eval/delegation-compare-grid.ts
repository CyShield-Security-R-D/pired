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
import type { OfficialShape } from "./delegation-compare-lib.ts";

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
