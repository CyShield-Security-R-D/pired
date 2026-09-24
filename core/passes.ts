/**
 * Passes — the unit of work that makes a second look different from a repeat.
 *
 * Two measurements in `research/` point opposite ways, and this module exists in
 * the space between them.
 *
 * The union of three passes beats the mean of three passes for every arm on the
 * application corpus — 9/24 against a mean of 4.3 for pired, and the same shape
 * for codex and bare pi. Roughly half of what any of them can find, it misses on
 * a given pass. So more passes is where the recall is.
 *
 * And a second pass over a **persisted** ledger buys none of it. Re-scored on a
 * common basis the persisted and wiped arms tie at 0.591 cumulative recall, a
 * gap of -0.000, while the persisted arm's final sessions run about half as long
 * — one of them recording zero new findings and zero new hypotheses in 105
 * seconds. The agent opened a full ledger, concluded the work was done, and
 * stopped.
 *
 * The mechanism is not mysterious. `findGaps` and `selectNext` route to
 * `not-tested` by construction, so once every cell carries a hypothesis the
 * router is empty and stopping is the honest reading of an empty router. The
 * union above came from passes that could not see each other's conclusions.
 *
 * So: a pass carries a **lens**, and the lens decides what it is allowed to look
 * at. Facts carry forward — inventory, the target model, loot, blockers,
 * evidence, which is what makes a later pass cheaper than a cold one — and
 * verdicts do not. A `refuted` hypothesis still reads `clear` in the coverage
 * number handed to the client; what changes is that it stops being terminal for
 * the router.
 *
 * Off by default. With no configuration there is one `route` pass and today's
 * behaviour exactly, which is the behaviour every number in `research/` was
 * measured against. See ADR-018.
 *
 * Pure module: records in, a plan out. No ports, no I/O.
 */

import { unchallengedQueue } from "./challenge.ts";
import { selectNext } from "./coverage.ts";
import {
	DEFAULT_PASS_LADDER,
	PASS_LENSES,
	type CoverageMatrix,
	type FindingRecord,
	type HypothesisRecord,
	type InventoryRecord,
	type LootRecord,
	type PassConfig,
	type PassLens,
} from "./ontology.ts";

/** One line per lens, for wherever the operator is asked to choose one. */
export const PASS_LENS_HELP: Record<PassLens, string> = {
	route: "the coverage matrix as it stands — test cases with no verdict yet",
	file: "files the ledger names but never recorded as surface, so no cell can point at them",
	invariant: "rules in the target model that no hypothesis has tested — the scanner-blind classes",
	adversarial: "claims nobody has looked at twice: unchallenged findings, then cleared cells",
	credentialed: "surface settled before the engagement held a credential, re-run as each principal",
};

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * `PIRED_PASSES=route,file` and friends, parsed.
 *
 * The headless switch exists because an opt-in feature without one is a feature
 * that silently compares two configurations: `research/11` reports three
 * measured passes in which the scribe fired zero times because a headless run
 * had no way to enable it, against earlier passes on the same commit lineage
 * where it defaulted on. `PIRED_SCRIBE` was added for exactly that, and this is
 * the same problem one feature later.
 *
 * Unknown names are dropped rather than throwing: a typo in an environment
 * variable should not stop a session from starting, and the resolved ladder is
 * reported so a dropped entry is visible.
 */
export function parseLenses(raw: string | undefined): PassLens[] | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	if (/^(off|0|false|no)$/i.test(trimmed)) return [];
	const wanted = trimmed.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0);
	const lenses = wanted.filter((x): x is PassLens => (PASS_LENSES as readonly string[]).includes(x));
	return lenses.length > 0 ? lenses : [];
}

/**
 * The ladder this engagement runs, or `undefined` when it does not run passes.
 *
 * `undefined` rather than a one-entry ladder, because the whole feature has to
 * be inert when it is off — no prompt block, no router change, no panel row. A
 * default-on ladder of length 1 would be the same behaviour with more code
 * between it and the operator, and it would put a `<pass>` block in front of
 * every model on every turn to say "pass 1 of 1".
 */
export function resolveLadder(config: PassConfig | undefined, override?: PassLens[]): PassLens[] | undefined {
	// The environment wins, so a headless arm can turn passes on for an
	// engagement whose scope.json predates them, and off for one that has them.
	if (override !== undefined) return override.length > 0 ? [...override] : undefined;
	if (!config?.enabled) return undefined;
	const lenses = config.lenses?.filter((l) => (PASS_LENSES as readonly string[]).includes(l)) ?? [];
	return lenses.length > 0 ? [...lenses] : [...DEFAULT_PASS_LADDER];
}

/**
 * The lens pass `n` runs under, clamped to the last rung.
 *
 * Clamped rather than wrapping or ending: an operator who opens a fifth pass on
 * a four-rung ladder is asking for more adversarial work, not for the route
 * sweep again, and refusing to name a lens would leave the pass with no
 * worklist at all.
 */
export function lensForPass(ladder: PassLens[], pass: number): PassLens {
	const i = Math.min(Math.max(pass, 1), ladder.length) - 1;
	return ladder[i] ?? ladder[ladder.length - 1] ?? "route";
}

/**
 * Put `lens` at the pass that is actually open, without losing the rest.
 *
 * `/pass invariant` on a `route, file, invariant, adversarial` ladder used to
 * overwrite rung 2, which silently dropped `file` from the session for good: the
 * operator asked to run one lens now and lost another one entirely, with nothing
 * saying so. Naming a lens MOVES it to this pass and keeps everything after it,
 * so the ladder stays a plan rather than becoming a log of what was typed.
 *
 * The ladder on disk is configuration and is never rewritten — this is the
 * session's view of it.
 */
export function promoteLens(ladder: PassLens[], pass: number, lens: PassLens): PassLens[] {
	const at = Math.max(1, Math.floor(pass)) - 1;
	const head = ladder.slice(0, at);
	// A ladder shorter than the open pass has been running its last rung by
	// clamping (see lensForPass). Say so explicitly rather than landing the named
	// lens wherever the array happened to end.
	while (head.length < at) head.push(ladder[ladder.length - 1] ?? lens);
	return [...head, lens, ...ladder.slice(at).filter((l) => l !== lens)];
}

export interface PassState {
	/** Counting from 1. */
	pass: number;
	lens: PassLens;
	ladder: PassLens[];
}

/** The state of play, or `undefined` when this engagement does not run passes. */
export function passState(ladder: PassLens[] | undefined, pass: number | undefined): PassState | undefined {
	if (!ladder || ladder.length === 0) return undefined;
	const n = Math.max(1, Math.floor(pass ?? 1));
	return { pass: n, lens: lensForPass(ladder, n), ladder: [...ladder] };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PassWorkItem {
	/** What to hand back: a cell key (`element:class`), a file path, or an invariant. */
	ref: string;
	/** How to say it to a human. */
	label: string;
	/** Why this pass is looking at it — the part a repeat could not say. */
	why: string;
}

export interface PassPlan {
	pass: number;
	lens: PassLens;
	/** The worklist, capped. */
	items: PassWorkItem[];
	/** How many there are in total, before the cap. */
	total: number;
	/** Said when the lens has nothing to work on, and why that is. */
	note?: string;
}

export interface PassInput {
	pass: number;
	lens: PassLens;
	matrix?: CoverageMatrix;
	hypotheses?: HypothesisRecord[];
	findings?: FindingRecord[];
	inventory?: InventoryRecord[];
	loot?: LootRecord[];
	/** `model.md`, for the invariant lens. */
	targetModel?: string;
	labelFor?: (id: string) => string | undefined;
	limit?: number;
}

const DEFAULT_LIMIT = 12;

/** Source files look like this in a target string: `http/share.go:84`, `app.py`. */
const SOURCE_FILE =
	/\b([\w./-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rb|php|java|cs|rs|kt|kts|scala|swift|c|h|cpp|hpp|erb|tpl|sql|sh|yml|yaml|json|tf))\b/g;

function filesIn(text: string | undefined): string[] {
	if (!text) return [];
	const out: string[] = [];
	for (const m of text.matchAll(SOURCE_FILE)) {
		const f = m[1];
		if (f) out.push(f);
	}
	return out;
}

/**
 * The invariants section of `model.md`, one line per rule.
 *
 * Parsed rather than stored as records, because the model is one document
 * revised in place (see `Workspace.writeModelSection`) and a second copy of its
 * contents in the ledger would be a second answer to the same question.
 */
export function parseInvariants(targetModel: string | undefined): string[] {
	if (!targetModel) return [];
	const out: string[] = [];
	let inSection = false;
	for (const raw of targetModel.split("\n")) {
		const line = raw.trim();
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading) {
			inSection = /^invariants\b/i.test((heading[1] ?? "").trim());
			continue;
		}
		if (!inSection || line === "") continue;
		const item = line.replace(/^([-*+]|\d+[.)])\s+/, "").trim();
		if (item.length > 0) out.push(item);
	}
	return out;
}

const STOP = new Set([
	"that", "this", "with", "from", "have", "must", "always", "never", "their", "there", "which",
	"when", "then", "than", "into", "over", "each", "only", "some", "other", "they", "them", "been",
	"user", "users", "data", "cannot", "should", "would", "could", "value", "values",
]);

/**
 * Content words, crudely singularised.
 *
 * The stem is not linguistics, it is the difference between matching and not:
 * an invariant is written in the plural the domain uses ("balances never go
 * negative") and the hypothesis that tests it is written about one of them
 * ("drive the balance negative"). Without the stem those share one word and the
 * invariant reads untested forever. `ss` is left alone so "class" does not
 * become "clas", and the same normalisation runs on both sides, so whatever it
 * mangles it mangles consistently.
 */
function contentTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (w.length < 4 || STOP.has(w)) continue;
		out.add(w.length >= 5 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
	}
	return out;
}

/**
 * Has any hypothesis actually gone after this invariant?
 *
 * Two shared content words, which is a heuristic and is stated as one: it is
 * looking for "balances never go negative" against "withdraw twice concurrently
 * to drive the balance negative", and it will call a near-miss tested. The cost
 * of a false positive here is one invariant left off a worklist the operator can
 * read in full; the cost of demanding an exact match would be an invariant lens
 * that lists every rule forever and is therefore never read.
 */
function invariantTested(invariant: string, hypotheses: HypothesisRecord[]): boolean {
	const want = contentTokens(invariant);
	if (want.size === 0) return true;
	for (const h of hypotheses) {
		const got = contentTokens(`${h.statement} ${h.method ?? ""}`);
		let shared = 0;
		for (const w of want) if (got.has(w)) shared += 1;
		if (shared >= 2) return true;
	}
	return false;
}

/** Cell key separator: the one character that cannot appear in an id or a class. */
const CELL_SEP = " ";

/** The newest refutation per cell — the row that actually carries the clearance. */
function clearedCells(hypotheses: HypothesisRecord[]): HypothesisRecord[] {
	const byCell = new Map<string, HypothesisRecord>();
	for (const h of hypotheses) {
		if (h.outcome !== "refuted") continue;
		byCell.set(`${h.target}${CELL_SEP}${h.class}`, h);
	}
	return [...byCell.values()]
		.filter((h) => h.verification === undefined)
		.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
}

/**
 * What this pass is for, as a worklist.
 *
 * Every lens but `route` draws on state the router cannot reach, which is the
 * whole point: a pass whose worklist is derived the same way as the last one is
 * the repeat that was measured to add nothing.
 */
export function planPass(input: PassInput): PassPlan {
	const limit = input.limit ?? DEFAULT_LIMIT;
	const label = (id: string): string => input.labelFor?.(id) ?? id;
	const head = { pass: input.pass, lens: input.lens };
	const done = (items: PassWorkItem[], note?: string): PassPlan => ({
		...head,
		items: items.slice(0, limit),
		total: items.length,
		...(items.length === 0 && note ? { note } : {}),
	});

	switch (input.lens) {
		case "route": {
			const cells = (input.matrix?.cells ?? []).filter((c) => c.status === "not-tested");
			// Three different reasons for an empty route list, and they are not
			// interchangeable: no checklist is a workspace that has not been seeded,
			// no surface is a review that recorded nothing, and no gaps is work that
			// is actually done. Collapsing the first two reported "no surface
			// recorded yet" at a ledger holding surface, which is the kind of wrong
			// message that sends a reader looking for a bug that is not there.
			const why = input.matrix === undefined
				? "No checklist is loaded, so there is no matrix to route by. The engagement seeds one from its target type when it opens."
				: input.matrix.applicable === 0
					? "No surface recorded yet, so there are no test cases. Record inventory first — the plan is classes x the surface you recorded."
					: "Every applicable test case has a verdict. That is what the next lens is for.";
			return done(
				cells.map((c) => ({
					ref: `${c.element}:${c.class}`,
					label: `${label(c.element)} / ${c.class}`,
					why: "no hypothesis has been recorded for this test case",
				})),
				why,
			);
		}

		case "file": {
			/**
			 * The miss this lens exists for, measured: across 17 misses on the
			 * application corpus the file holding the missed entry was **opened in 17
			 * of 17 and recorded as surface in 0 of 17**. Coverage is classes x
			 * surface, so a matrix built from routes has no cell that can point at a
			 * file, and `recall gaps` could never name one.
			 */
			const surfaceFiles = new Set<string>();
			for (const rec of input.inventory ?? []) {
				for (const f of filesIn((rec as { file?: string }).file)) surfaceFiles.add(f);
			}
			const named = new Map<string, number>();
			const note = (text: string | undefined): void => {
				for (const f of filesIn(text)) named.set(f, (named.get(f) ?? 0) + 1);
			};
			for (const f of input.findings ?? []) {
				note(f.target);
				for (const loc of f.locations ?? []) note(loc);
				note(f.description);
				note(f.repro);
			}
			for (const h of input.hypotheses ?? []) note(h.target);
			const items = [...named]
				.filter(([f]) => !surfaceFiles.has(f))
				.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
				.map(([f, n]) => ({
					ref: f,
					label: f,
					why: `named by ${n} record(s), never recorded as surface — no coverage cell can point at it`,
				}));
			return done(
				items,
				named.size > 0
					? "Every file the ledger names is recorded as surface. Nothing is hiding behind the route vocabulary."
					: "The ledger names no source files yet, so there is nothing this lens can reach. It is for a review that has already read code.",
			);
		}

		case "invariant": {
			const invariants = parseInvariants(input.targetModel);
			const hyps = input.hypotheses ?? [];
			const items = invariants
				.filter((inv) => !invariantTested(inv, hyps))
				.map((inv) => ({
					ref: inv,
					label: inv,
					why: "an invariant in the target model that no hypothesis has gone after",
				}));
			return done(
				items,
				invariants.length === 0
					? "The target model records no invariants, so this lens has nothing to route to. `record kind=model section=invariants` is what fills it — an invariant is a hypothesis generator, and these are the bugs no checklist reaches."
					: "Every recorded invariant has a hypothesis against it.",
			);
		}

		case "adversarial": {
			const findings = unchallengedQueue(input.findings ?? []);
			const cleared = clearedCells(input.hypotheses ?? []);
			const items: PassWorkItem[] = [
				...findings.map((f) => ({
					ref: f.id,
					label: `${f.id} [${f.severity}] ${f.title}`,
					why: "a claim no challenge has settled — it reaches the client as it stands",
				})),
				// Oldest first: a cell cleared in the first hour was cleared by an agent
				// that had not yet read the code it was clearing (ADR-016).
				...cleared.map((h) => ({
					ref: h.id,
					label: `${h.id} [${h.class}] ${label(String(h.target))}`,
					why: "a cleared cell nothing has re-checked, counting toward the coverage the client is handed",
				})),
			];
			return done(items, "Nothing is waiting: every live finding has a verdict and every cleared cell has had a second look.");
		}

		case "credentialed": {
			const loot = [...(input.loot ?? [])].sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
			const first = loot[0];
			if (!first) {
				return done([], "No credentials recorded, so there is no principal to re-run the surface as. This lens opens once `record kind=loot` has something in it.");
			}
			/**
			 * A cell settled before the engagement held a credential was settled as an
			 * anonymous caller, whatever it concluded. That is the claim this lens
			 * re-opens, and it is the one a route sweep can never notice: the cell is
			 * settled, the router has moved on, and nothing in it records which
			 * principal asked.
			 */
			const byCell = new Map<string, HypothesisRecord>();
			for (const h of input.hypotheses ?? []) {
				if (h.outcome !== "refuted" && h.outcome !== "confirmed") continue;
				byCell.set(`${h.target}${CELL_SEP}${h.class}`, h);
			}
			const items = [...byCell.values()]
				.filter((h) => String(h.createdAt).localeCompare(String(first.createdAt)) < 0)
				.sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)))
				.map((h) => ({
					ref: h.id,
					label: `${h.id} [${h.class}] ${label(String(h.target))}`,
					why: `settled ${h.createdAt}, before ${first.handle} was recorded — nothing here was asked as an authenticated principal`,
				}));
			return done(items, `Every settled cell was settled after ${first.handle} was recorded, so none of them was an anonymous-only test.`);
		}
	}
}

/**
 * The next thing to work on, as the pass sees it.
 *
 * Pass 1 under the `route` lens goes through `selectNext` unchanged, so an
 * engagement that never opens a second pass gets byte-identical behaviour —
 * including its preference for `testing` cells once the untested ones are gone,
 * which the plan's worklist does not model.
 */
export function nextInPass(plan: PassPlan, matrix?: CoverageMatrix): PassWorkItem | undefined {
	if (plan.lens === "route") {
		const cell = matrix ? selectNext(matrix) : undefined;
		if (!cell) return undefined;
		const key = `${cell.element}:${cell.class}`;
		return plan.items.find((i) => i.ref === key) ?? {
			ref: key,
			label: `${cell.element} / ${cell.class}`,
			why: cell.status === "testing"
				? "recorded as in progress and never settled"
				: "no hypothesis has been recorded for this test case",
		};
	}
	return plan.items[0];
}

// ---------------------------------------------------------------------------
// What a pass added
// ---------------------------------------------------------------------------

export interface PassDelta {
	pass: number;
	findings: number;
	hypotheses: number;
	surface: number;
}

/**
 * What this pass put in the ledger that was not there before.
 *
 * Computed from the `pass` stamp rather than argued, which is the point of the
 * stamp existing: `research/06` could only tell that its third session added
 * nothing by diffing two scored ledgers after the fact, and by then the session
 * was over. This is the same statistic, available while the pass is still open.
 */
export function passDelta(
	pass: number,
	records: { findings?: FindingRecord[]; hypotheses?: HypothesisRecord[]; inventory?: InventoryRecord[] },
): PassDelta {
	const mine = (rows: Array<{ pass?: number }> | undefined): number =>
		(rows ?? []).filter((r) => (r.pass ?? 1) === pass).length;
	return {
		pass,
		findings: mine(records.findings),
		hypotheses: mine(records.hypotheses),
		surface: mine(records.inventory),
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The block put in front of the agent when a pass above the first is open.
 *
 * Empty on pass 1, always. The standing context block is read because it is
 * short and because it only speaks when it has something to say; a line every
 * turn announcing "pass 1 of 4" is how a block stops being read, which is the
 * argument ADR-016 already made against nudging about cleared cells.
 */
export function renderPassBrief(state: PassState, plan: PassPlan, limit = 6): string {
	if (state.pass <= 1) return "";
	const lines = [
		`Pass ${state.pass} of this engagement, lens \`${state.lens}\`: ${PASS_LENS_HELP[state.lens]}.`,
		"Earlier passes' facts stand — inventory, the target model, loot, evidence. Their verdicts are what this pass is here to re-open, so a cell reading `clear` is a claim like any other.",
	];
	if (plan.items.length === 0) {
		if (plan.note) lines.push(plan.note);
		return lines.join("\n");
	}
	const shown = plan.items.slice(0, limit).map((i) => `- ${i.label} — ${i.why}`);
	const rest = plan.total > shown.length ? ` (+${plan.total - shown.length} more)` : "";
	lines.push(`${plan.total} item(s) this lens can reach${rest}:`, ...shown);
	lines.push("`recall pass` reads the full list.");
	return lines.join("\n");
}

export interface PassCommandView {
	text: string;
	tone: "info" | "warning";
	/** Set when the operator asked to open a pass: the lens to open it under. */
	open?: PassLens;
}

export interface PassCommandInput {
	/** Undefined when this engagement does not run passes. */
	state?: PassState;
	plan?: PassPlan;
	/** What the operator typed after the command, already trimmed. */
	arg?: string;
	delta?: PassDelta;
	/**
	 * How many live findings no challenge has settled.
	 *
	 * Said when a pass is opened, never enforced. A union of passes multiplies
	 * false positives as readily as findings, and precision is the axis where
	 * this harness is weakest — 0.059 on the application corpus against bare pi's
	 * 0.192 — so opening discovery work on top of an unverified pile is worth a
	 * sentence. It stays a sentence: ADR-004 settled that confirmed work which
	 * has not reached the report is surfaced rather than blocked, and a `/pass`
	 * that refused would be the harness deciding how the operator spends their
	 * time.
	 */
	unchallenged?: number;
}

/**
 * `/pass`, as a function of the ledger.
 *
 * The command's decisions live here rather than in `extensions/pired.ts` for the
 * reason `challengeCommand` gives: the extension is the file CLAUDE.md names as
 * the one to keep moving logic out of, and a decision nothing can test is a
 * decision that goes quietly wrong. The host is left with reading the workspace,
 * bumping the manifest and drawing the result.
 */
export function passCommand(input: PassCommandInput): PassCommandView {
	const arg = input.arg?.trim().toLowerCase() ?? "";
	const state = input.state;

	if (!state) {
		return {
			tone: "warning",
			text: "pired: this engagement does not run passes. Turn them on in scope.json —\n"
				+ '  "passes": { "enabled": true, "lenses": ["route", "file", "invariant", "adversarial"] }\n'
				+ "or set PIRED_PASSES=route,file,invariant,adversarial for a headless run.\n"
				+ PASS_LENSES.map((l) => `· ${l} — ${PASS_LENS_HELP[l]}`).join("\n"),
		};
	}

	const ladder = state.ladder.map((l, i) => `${i + 1}. ${l}${i + 1 === state.pass ? "  <- open" : ""}`).join("\n");

	if (arg === "" || arg === "status") {
		const plan = input.plan;
		const d = input.delta;
		const lines = [
			`pired: pass ${state.pass}, lens \`${state.lens}\` — ${PASS_LENS_HELP[state.lens]}`,
			ladder,
		];
		if (d) lines.push(`This pass has added ${d.findings} finding(s), ${d.hypotheses} hypothes(es), ${d.surface} surface element(s).`);
		if (plan) {
			lines.push(plan.items.length === 0
				? (plan.note ?? "Nothing this lens can reach.")
				: `${plan.total} item(s) this lens can reach:\n${plan.items.map((i) => `· ${i.label} — ${i.why}`).join("\n")}`);
		}
		lines.push("`/pass next` opens the next lens; `/pass <lens>` opens a named one.");
		return { tone: "info", text: lines.join("\n") };
	}

	// Only worth saying when the pass being opened is not the one that would
	// settle them: opening `adversarial` IS draining the queue.
	const owed = (lens: PassLens): string =>
		input.unchallenged && input.unchallenged > 0 && lens !== "adversarial"
			? `\n${input.unchallenged} finding(s) have no settled verdict (examined-but-unsettled included). A further pass adds to that pile as readily as it adds findings — /challenge, or a pass under \`adversarial\`, is what empties it.`
			: "";

	if (arg === "next") {
		const next = lensForPass(state.ladder, state.pass + 1);
		const exhausted = state.pass >= state.ladder.length;
		return {
			tone: "info",
			open: next,
			text: (exhausted
				? `pired: the ladder ends at ${state.ladder.length} rungs, so pass ${state.pass + 1} re-opens \`${next}\`. Name a lens with /pass <lens> to run a different one.`
				: `pired: opening pass ${state.pass + 1}, lens \`${next}\` — ${PASS_LENS_HELP[next]}`) + owed(next),
		};
	}

	const lens = PASS_LENSES.find((l) => l === arg);
	if (!lens) {
		return {
			tone: "warning",
			text: `pired: no lens called "${arg}". Valid lenses:\n`
				+ PASS_LENSES.map((l) => `· ${l} — ${PASS_LENS_HELP[l]}`).join("\n"),
		};
	}
	return {
		tone: "info",
		open: lens,
		text: `pired: opening pass ${state.pass + 1}, lens \`${lens}\` — ${PASS_LENS_HELP[lens]}` + owed(lens),
	};
}
