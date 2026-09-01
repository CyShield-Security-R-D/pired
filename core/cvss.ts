/**
 * CVSS vector strings, checked before they reach a client's report.
 *
 * pired scores in **v4.0** and accepts **v3.1**, because a consultant does not
 * always get to choose: a client's programme may mandate 3.1, a CVE may only
 * publish a 3.1 vector, and a report that silently restates one version's vector
 * under the other version's label is wrong in a way nobody catches by reading.
 *
 * The two are not a version bump apart. In v4.0 Scope is gone — split into what
 * the vulnerable system loses (VC/VI/VA) and what the system it reaches next
 * loses (SC/SI/SA); Attack Requirements (AT) is new and takes the "conditions
 * outside the attacker's control" half of what AC:H used to mean; User
 * Interaction has three values instead of two. So a 3.1 vector cannot be turned
 * into a 4.0 one by editing the prefix, which is exactly what a model will try.
 *
 * Both versions are strings of slash-separated pairs and neither pired nor a
 * reader skimming a report can tell a wrong one from a right one at a glance, so
 * the vector is validated against the metric set its own prefix claims. The
 * error names the metric that is wrong, and it always offers dropping the field,
 * because a vector is a nicety and the finding is the deliverable.
 *
 * Scoring is NOT done here. v4.0 replaced the v3.1 formula with a lookup over
 * 270 macrovector equivalence classes plus interpolation; approximating that
 * would produce numbers that look authoritative and are wrong. The vector is
 * what pired stores; the official calculator is what produces the number.
 *
 * Pure module: a string in, a complaint or nothing out.
 */

/** What pired writes unless the engagement calls for something else. */
export const CVSS_DEFAULT_VERSION = "4.0";

export type CvssVersion = "4.0" | "3.1";

type MetricTable = Array<[string, readonly string[]]>;

/**
 * v4.0 Base metrics, in the order the spec requires them to appear.
 * All eleven are mandatory: v4.0 has no "not defined" for a Base metric.
 */
const BASE_40: MetricTable = [
	["AV", ["N", "A", "L", "P"]],
	["AC", ["L", "H"]],
	["AT", ["N", "P"]],
	["PR", ["N", "L", "H"]],
	["UI", ["N", "P", "A"]],
	["VC", ["H", "L", "N"]],
	["VI", ["H", "L", "N"]],
	["VA", ["H", "L", "N"]],
	["SC", ["H", "L", "N"]],
	["SI", ["H", "L", "N"]],
	["SA", ["H", "L", "N"]],
];

/** v4.0 Threat, Environmental and Supplemental metrics: optional, each at most once. */
const OPTIONAL_40: Record<string, readonly string[]> = {
	// Threat. v4.0 dropped Remediation Level and Report Confidence.
	E: ["X", "A", "P", "U"],
	// Environmental — security requirements
	CR: ["X", "H", "M", "L"], IR: ["X", "H", "M", "L"], AR: ["X", "H", "M", "L"],
	// Environmental — modified base
	MAV: ["X", "N", "A", "L", "P"], MAC: ["X", "L", "H"], MAT: ["X", "N", "P"],
	MPR: ["X", "N", "L", "H"], MUI: ["X", "N", "P", "A"],
	MVC: ["X", "H", "L", "N"], MVI: ["X", "H", "L", "N"], MVA: ["X", "H", "L", "N"],
	MSC: ["X", "H", "L", "N"],
	// Safety is a value only the subsequent-system integrity and availability
	// modifiers take: a vulnerability whose downstream effect is on human safety.
	MSI: ["X", "S", "H", "L", "N"], MSA: ["X", "S", "H", "L", "N"],
	// Supplemental — recorded, never scored
	S: ["X", "N", "P"], AU: ["X", "N", "Y"], R: ["X", "A", "U", "I"],
	V: ["X", "D", "C"], RE: ["X", "L", "M", "H"],
	U: ["X", "Clear", "Green", "Amber", "Red"],
};

/** v3.1 Base metrics, in spec order. All mandatory. */
const BASE_31: MetricTable = [
	["AV", ["N", "A", "L", "P"]],
	["AC", ["L", "H"]],
	["PR", ["N", "L", "H"]],
	["UI", ["N", "R"]],
	["S", ["U", "C"]],
	["C", ["H", "L", "N"]],
	["I", ["H", "L", "N"]],
	["A", ["H", "L", "N"]],
];

/** v3.1 Temporal and Environmental metrics: optional, each at most once. */
const OPTIONAL_31: Record<string, readonly string[]> = {
	E: ["X", "U", "P", "F", "H"], RL: ["X", "O", "T", "W", "U"], RC: ["X", "U", "R", "C"],
	CR: ["X", "H", "M", "L"], IR: ["X", "H", "M", "L"], AR: ["X", "H", "M", "L"],
	MAV: ["X", "N", "A", "L", "P"], MAC: ["X", "L", "H"], MPR: ["X", "N", "L", "H"],
	MUI: ["X", "N", "R"], MS: ["X", "U", "C"],
	MC: ["X", "H", "L", "N"], MI: ["X", "H", "L", "N"], MA: ["X", "H", "L", "N"],
};

const SPEC: Record<CvssVersion, { base: MetricTable; optional: Record<string, readonly string[]> }> = {
	"4.0": { base: BASE_40, optional: OPTIONAL_40 },
	"3.1": { base: BASE_31, optional: OPTIONAL_31 },
};

/** A complete, valid Base vector per version — what a corrected one should look like. */
export const CVSS_EXAMPLE: Record<CvssVersion, string> = {
	"4.0": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
	"3.1": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
};

/** Every Base metric with the values it takes, for an error that has to teach. */
function metricsHelp(version: CvssVersion): string {
	return `CVSS:${version}/${SPEC[version].base.map(([m, values]) => `${m}:[${values.join("|")}]`).join("/")}`;
}

export interface CvssVector {
	version: CvssVersion;
	/** Every metric present, keyed by abbreviation. */
	metrics: Record<string, string>;
	/** True when anything beyond the Base metrics was supplied. */
	extended: boolean;
}

/** The version a vector claims, whether or not the rest of it is valid. */
export function cvssVersion(vector: string): CvssVersion | undefined {
	const prefix = vector.trim().split("/")[0] ?? "";
	return prefix === "CVSS:4.0" ? "4.0" : prefix === "CVSS:3.1" ? "3.1" : undefined;
}

/**
 * Why this string is not a CVSS vector, or undefined when it is one.
 *
 * One complaint at a time, the most useful one first: a version pired does not
 * write is a different mistake from a missing metric, and being told both at
 * once invites a patch rather than a rebuild.
 */
export function validateCvss(vector: string): string | undefined {
	const raw = vector.trim();
	if (raw.length === 0) return undefined;

	const parts = raw.split("/");
	const prefix = parts[0] ?? "";
	const version = cvssVersion(raw);
	if (!version) {
		const claimed = /^CVSS:(\d+\.\d+)$/.exec(prefix)?.[1];
		if (claimed === "3.0") {
			// Worth its own answer: v3.0 and v3.1 share a metric set exactly, so this
			// one really is fixed by relabelling — the only case where it is.
			return "pired records CVSS v4.0 (preferred) or v3.1, and this says v3.0. " +
				"v3.0 and v3.1 use the same metrics, so relabel the prefix as CVSS:3.1 — or build a v4.0 vector, which is the default.";
		}
		if (claimed) {
			return `pired records CVSS v4.0 (preferred) or v3.1, and this says v${claimed}.`;
		}
		return `a vector starts with "CVSS:4.0/" or "CVSS:3.1/". Got "${prefix || raw.slice(0, 20)}".`;
	}

	const { base, optional } = SPEC[version];
	const metrics: Record<string, string> = {};
	const order: string[] = [];
	for (const part of parts.slice(1)) {
		if (part.length === 0) continue;
		const cut = part.indexOf(":");
		if (cut <= 0) return `"${part}" is not a metric:value pair.`;
		const metric = part.slice(0, cut);
		const value = part.slice(cut + 1);
		const allowed = optional[metric] ?? base.find(([m]) => m === metric)?.[1];
		if (!allowed) {
			// Naming where the metric went is the difference between "fix this
			// character" and "you are working from the wrong table".
			const MOVED: Record<string, string> = {
				C: "v3.1's Confidentiality became VC on the vulnerable system and SC on the system it reaches next",
				I: "v3.1's Integrity became VI and SI",
				A: "v3.1's Availability became VA and SA",
			};
			const moved = version === "4.0" && MOVED[metric] ? ` — ${MOVED[metric]}` : "";
			const gone = version === "3.1" && ["AT", "VC", "VI", "VA", "SC", "SI", "SA"].includes(metric)
				? ` — that is a v4.0 metric; in v3.1 use S plus C/I/A`
				: "";
			return `"${metric}" is not a v${version} metric${moved}${gone}.`;
		}
		if (!allowed.includes(value)) {
			// The one substitution worth naming. S is a real v4.0 metric (Safety), so
			// a v3.1 Scope arrives here rather than as an unknown metric, and being
			// told "S takes X, N, P" does not tell anyone that Scope is gone.
			if (version === "4.0" && metric === "S" && (value === "U" || value === "C")) {
				return "S:" + value + " is v3.1's Scope, which v4.0 removed. Say what the vulnerable system loses " +
					"with VC/VI/VA and what the system it reaches next loses with SC/SI/SA — a scope change (S:C) is a " +
					"non-zero SC/SI/SA. In v4.0, S is Safety and takes X, N, P.";
			}
			return `${metric}:${value} is not valid — in v${version}, ${metric} takes ${allowed.join(", ")}.`;
		}
		if (metric in metrics) return `${metric} appears more than once.`;
		metrics[metric] = value;
		order.push(metric);
	}

	const missing = base.filter(([m]) => !(m in metrics)).map(([m]) => m);
	if (missing.length > 0) {
		return `every Base metric is mandatory; this v${version} vector is missing ${missing.join(", ")}. ` +
			`Metrics: ${metricsHelp(version)}. Example: ${CVSS_EXAMPLE[version]}`;
	}
	// The Base block leads the vector, in spec order — that is what every
	// calculator parses against. Checked over the metrics that are actually base,
	// so an optional metric sitting among them is not what fails here.
	const baseOrder = order.filter((m) => base.some(([b]) => b === m));
	const expected = base.map(([m]) => m);
	for (let i = 0; i < expected.length; i++) {
		if (baseOrder[i] !== expected[i]) {
			return `Base metrics must appear in spec order: ${expected.join("/")}. Got ${baseOrder.join("/")}.`;
		}
	}
	return undefined;
}

/** Parse a validated vector. Returns undefined for anything validateCvss rejects. */
export function parseCvss(vector: string): CvssVector | undefined {
	if (validateCvss(vector) !== undefined) return undefined;
	const version = cvssVersion(vector);
	if (!version) return undefined;
	const metrics: Record<string, string> = {};
	for (const part of vector.trim().split("/").slice(1)) {
		const cut = part.indexOf(":");
		if (cut > 0) metrics[part.slice(0, cut)] = part.slice(cut + 1);
	}
	return { version, metrics, extended: Object.keys(metrics).length > SPEC[version].base.length };
}

/**
 * The qualitative band a numeric score falls in. Shared by both versions — the
 * ratings moved between them, the bands did not.
 */
export function cvssBand(score: number): "none" | "low" | "medium" | "high" | "critical" {
	if (score >= 9) return "critical";
	if (score >= 7) return "high";
	if (score >= 4) return "medium";
	if (score > 0) return "low";
	return "none";
}
