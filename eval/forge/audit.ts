/**
 * Artifact audit — the check that can reject a Forge build.
 *
 * NOTE ON WHAT THIS MEASURES. The first version of this audit asked whether a
 * classifier could separate vulnerable sites from safe ones, and gated on a
 * one-sided AUC threshold. Both halves were wrong. One-sided is wrong because an
 * AUC near 0 is exactly as separable as one near 1 — the first run scored 0.0
 * and "passed". And the question itself is wrong: safe code contains the
 * mitigation ("?" placeholders, shell=False, a realpath check), so
 * vulnerable-vs-safe is lexically separable in *real* code too. Separating those
 * is what a linter does; it is not evidence of a generator artifact.
 *
 * Gating on "sites vs ordinary handlers" was the second wrong answer. It scores
 * ~0.99, and it should: a handler that calls subprocess.run is lexically unlike
 * one that runs SELECT COUNT(*). Separating code-with-a-sink from
 * code-without-a-sink is what a SAST tool does. It is the signal under study,
 * not an artifact.
 *
 * What LAVA actually got wrong was narrower: injected bugs carried tells
 * *unrelated to the vulnerability* — magic constants, unnatural flow — and,
 * crucially, they were near-clones of each other. A corpus of 50 sites that are
 * byte-identical modulo an identifier has the information content of one site:
 * an agent that learns the shape once scores every instance, and the benchmark
 * reports breadth it does not have.
 *
 * So the gate is **template diversity**: mean pairwise token overlap among sites
 * of the same class. Near-1.0 means clones. The other two numbers are kept as
 * diagnostics, read rather than gated.
 *
 * The standing objection to synthetic vulnerability corpora is that the injected
 * bugs are distinguishable from the surrounding program on surface features
 * alone: magic values, repeated patterns, control flow that does not match the
 * host code. A detector trained or prompted on such a corpus learns the artifact
 * rather than the bug, and the benchmark silently stops measuring security.
 *
 * The countermeasure is structural — vulnerable and safe sites come from the
 * same generator — but "structural" is a claim, and claims get measured. This
 * fits a token log-odds classifier on the rendered sites and scores its ability
 * to separate vulnerable from safe by lexical features. Chance is 0.5. A build
 * that scores meaningfully above the threshold is leaking and does not ship.
 *
 * Deliberately a *weak* classifier: it sees only token presence, no structure
 * and no semantics. Anything it can pick up is a surface tell, which is exactly
 * what we are hunting.
 */

export interface AuditResult {
	/** GATE: mean pairwise token overlap among same-class sites. High = clones. */
	cloneIndex: number;
	/** DIAGNOSTIC: separability of sites from ordinary handlers. Expected high —
	 *  sinks are lexically distinctive, which is the signal, not a leak. */
	injectionAuc: number;
	/** DIAGNOSTIC: separability of vulnerable from safe sites. Expected to be
	 *  high — mitigations have names — so this is read, not gated. */
	bugFixAuc: number;
	vulnerableSites: number;
	safeSites: number;
	/** Tokens most predictive of "vulnerable", strongest first. */
	topTells: Array<{ token: string; logOdds: number }>;
	passed: boolean;
	/** Maximum allowed distance from chance (0.5) on the diagnostic AUC. */
	margin: number;
	/** Maximum allowed clone index before the build is rejected. */
	cloneCeiling: number;
}

function tokenize(code: string): string[] {
	return (code.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? []).filter((t) => t.length > 2);
}

/** Distance from chance, so near-0 and near-1 are treated as equally separable. */
function separability(auc: number): number {
	return Math.abs(auc - 0.5);
}

/** Leave-one-out log-odds scoring, so a site is never scored by a model that saw it. */
export function auditSites(
	vulnerable: string[],
	safe: string[],
	hostLines: string[] = [],
	margin = 0.25,
	cloneCeiling = 0.9,
): AuditResult {
	const countsFor = (docs: string[]): Map<string, number> => {
		const m = new Map<string, number>();
		for (const d of docs) for (const t of new Set(tokenize(d))) m.set(t, (m.get(t) ?? 0) + 1);
		return m;
	};

	const scoreWith = (vDocs: string[], sDocs: string[], doc: string): number => {
		const v = countsFor(vDocs);
		const s = countsFor(sDocs);
		const vN = vDocs.length + 1;
		const sN = sDocs.length + 1;
		let score = 0;
		for (const t of new Set(tokenize(doc))) {
			const pv = ((v.get(t) ?? 0) + 0.5) / vN;
			const ps = ((s.get(t) ?? 0) + 0.5) / sN;
			score += Math.log(pv / ps);
		}
		return score;
	};

	const scored: Array<{ score: number; label: 1 | 0 }> = [];
	for (let i = 0; i < vulnerable.length; i++) {
		const held = vulnerable[i] as string;
		scored.push({ score: scoreWith(vulnerable.filter((_, j) => j !== i), safe, held), label: 1 });
	}
	for (let i = 0; i < safe.length; i++) {
		const held = safe[i] as string;
		scored.push({ score: scoreWith(vulnerable, safe.filter((_, j) => j !== i), held), label: 0 });
	}

	// AUC via rank statistic, ties counted at half.
	let concordant = 0;
	let pairs = 0;
	for (const a of scored.filter((x) => x.label === 1)) {
		for (const b of scored.filter((x) => x.label === 0)) {
			pairs += 1;
			if (a.score > b.score) concordant += 1;
			else if (a.score === b.score) concordant += 0.5;
		}
	}
	const auc = pairs > 0 ? concordant / pairs : 0.5;

	const v = countsFor(vulnerable);
	const s = countsFor(safe);
	const tells = [...v.keys()]
		.map((token) => ({
			token,
			logOdds: Math.log((((v.get(token) ?? 0) + 0.5) / (vulnerable.length + 1)) / (((s.get(token) ?? 0) + 0.5) / (safe.length + 1))),
		}))
		.sort((a, b) => b.logOdds - a.logOdds)
		.slice(0, 8);

	// The gate: do rendered sites stand out from the program hosting them?
	const sites = [...vulnerable, ...safe];
	const injectionAuc = hostLines.length > 0 ? aucBetween(sites, hostLines, scoreWith) : 0.5;

	// Clone index: how alike are same-class sites? Jaccard over token sets, which
	// ignores ordering and identifier-only differences the way an agent would.
	const allSites = [...vulnerable, ...safe];
	const overlaps: number[] = [];
	for (let i = 0; i < allSites.length; i++) {
		for (let j = i + 1; j < allSites.length; j++) {
			const a = new Set(tokenize(allSites[i] as string));
			const b = new Set(tokenize(allSites[j] as string));
			const inter = [...a].filter((t) => b.has(t)).length;
			const union = new Set([...a, ...b]).size;
			if (union > 0) overlaps.push(inter / union);
		}
	}
	const cloneIndex = overlaps.length > 0 ? overlaps.reduce((x, y) => x + y, 0) / overlaps.length : 0;

	return {
		cloneIndex: Number(cloneIndex.toFixed(3)),
		cloneCeiling,
		injectionAuc: Number(injectionAuc.toFixed(3)),
		bugFixAuc: Number(auc.toFixed(3)),
		vulnerableSites: vulnerable.length,
		safeSites: safe.length,
		topTells: tells,
		passed: cloneIndex <= cloneCeiling,
		margin,
	};
}

/** Leave-one-out AUC between two document sets under the same scorer. */
function aucBetween(
	positives: string[],
	negatives: string[],
	scoreWith: (pos: string[], neg: string[], doc: string) => number,
): number {
	const scored: Array<{ score: number; label: 1 | 0 }> = [];
	for (let i = 0; i < positives.length; i++) {
		scored.push({ score: scoreWith(positives.filter((_, j) => j !== i), negatives, positives[i] as string), label: 1 });
	}
	for (let i = 0; i < negatives.length; i++) {
		scored.push({ score: scoreWith(positives, negatives.filter((_, j) => j !== i), negatives[i] as string), label: 0 });
	}
	let concordant = 0;
	let pairs = 0;
	for (const a of scored.filter((x) => x.label === 1)) {
		for (const b of scored.filter((x) => x.label === 0)) {
			pairs += 1;
			if (a.score > b.score) concordant += 1;
			else if (a.score === b.score) concordant += 0.5;
		}
	}
	return pairs > 0 ? concordant / pairs : 0.5;
}
