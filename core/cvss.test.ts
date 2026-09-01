import { describe, expect, it } from "vitest";
import { cvssBand, CVSS_DEFAULT_VERSION, CVSS_EXAMPLE, cvssVersion, parseCvss, validateCvss } from "./cvss.ts";

const V4 = CVSS_EXAMPLE["4.0"];
const V31 = CVSS_EXAMPLE["3.1"];

describe("v4.0, the version pired writes by default", () => {
	it("defaults to 4.0", () => {
		expect(CVSS_DEFAULT_VERSION).toBe("4.0");
	});

	it("accepts a complete Base vector", () => {
		expect(validateCvss(V4)).toBeUndefined();
		expect(cvssVersion(V4)).toBe("4.0");
	});

	it("accepts the threat, environmental and supplemental metrics on top of it", () => {
		expect(validateCvss(`${V4}/E:A`)).toBeUndefined();
		expect(validateCvss(`${V4}/CR:H/IR:M/AR:L/MAV:A/MPR:L/MAT:P`)).toBeUndefined();
		expect(validateCvss(`${V4}/S:P/AU:Y/R:I/V:C/RE:H/U:Red`)).toBeUndefined();
	});

	it("accepts Safety on the subsequent-system modifiers, and nowhere else", () => {
		expect(validateCvss(`${V4}/MSI:S`)).toBeUndefined();
		expect(validateCvss(`${V4}/MSA:S`)).toBeUndefined();
		expect(validateCvss(`${V4}/MSC:S`)).toMatch(/MSC:S is not valid/);
	});

	it("insists on every Base metric, and shows what one looks like", () => {
		const why = validateCvss("CVSS:4.0/AV:N/AC:L/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
		expect(why).toMatch(/missing AT/);
		expect(why).toContain(V4);
	});
});

describe("v3.1, for the engagement that requires it", () => {
	// A consultant does not always choose: a client programme may mandate 3.1, and
	// a CVE may only publish a 3.1 vector. Restating one under the other's label
	// is wrong in a way nobody catches by reading.
	it("accepts a complete v3.1 Base vector", () => {
		expect(validateCvss(V31)).toBeUndefined();
		expect(validateCvss("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N")).toBeUndefined();
		expect(cvssVersion(V31)).toBe("3.1");
	});

	it("accepts its temporal and environmental metrics", () => {
		expect(validateCvss(`${V31}/E:F/RL:O/RC:C`)).toBeUndefined();
		expect(validateCvss(`${V31}/CR:H/MAV:A/MUI:R/MS:C/MC:L`)).toBeUndefined();
	});

	it("rejects a v4.0 metric inside a v3.1 vector", () => {
		expect(validateCvss("CVSS:3.1/AV:N/AC:L/AT:N/PR:N/UI:N/S:U/C:H/I:H/A:H"))
			.toMatch(/"AT" is not a v3\.1 metric — that is a v4\.0 metric/);
	});

	it("rejects a v4.0 User Interaction value inside a v3.1 vector", () => {
		expect(validateCvss("CVSS:3.1/AV:N/AC:L/PR:N/UI:A/S:U/C:H/I:H/A:H"))
			.toMatch(/UI:A is not valid — in v3\.1, UI takes N, R/);
	});
});

describe("catching a vector that claims the wrong version", () => {
	it("explains where the v3.1 impact metrics went when they turn up in a v4.0 vector", () => {
		expect(validateCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/C:H/I:N/A:N"))
			.toMatch(/"C" is not a v4\.0 metric — v3\.1's Confidentiality became VC/);
	});

	it("names Scope as the metric v4.0 removed, rather than quibbling about its values", () => {
		// S is a real v4.0 metric (Safety), so a v3.1 Scope arrives as a bad value
		// rather than an unknown metric — and "S takes X, N, P" does not tell anyone
		// that Scope is gone or what replaced it.
		const why = validateCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/S:U/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
		expect(why).toMatch(/v3\.1's Scope, which v4\.0 removed/);
		expect(why).toMatch(/a scope change \(S:C\) is a non-zero SC\/SI\/SA/);
	});

	it("rejects a v3.1 User Interaction value inside a v4.0 vector", () => {
		expect(validateCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:R/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"))
			.toMatch(/UI:R is not valid — in v4\.0, UI takes N, P, A/);
	});

	it("tells a v3.0 vector the one thing that really is a relabel", () => {
		// v3.0 and v3.1 share a metric set exactly, so this is the only version
		// mismatch that a prefix edit genuinely fixes.
		const why = validateCvss("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
		expect(why).toMatch(/relabel the prefix as CVSS:3\.1/);
		expect(why).toMatch(/v4\.0 vector, which is the default/);
	});

	it("refuses a version pired does not write", () => {
		expect(validateCvss("CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P")).toMatch(/says v2\.0/);
	});

	it("rejects a bare vector with no version at all", () => {
		expect(validateCvss("AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toMatch(/starts with "CVSS:4\.0\/" or "CVSS:3\.1\/"/);
	});
});

describe("catching a malformed vector", () => {
	it("rejects an unknown metric", () => {
		expect(validateCvss(`${V4}/ZZ:N`)).toMatch(/"ZZ" is not a v4\.0 metric/);
	});

	it("rejects a value the metric does not take", () => {
		expect(validateCvss("CVSS:4.0/AV:X/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"))
			.toMatch(/AV:X is not valid — in v4\.0, AV takes N, A, L, P/);
	});

	it("rejects a metric given twice", () => {
		expect(validateCvss(`${V4}/E:A/E:P`)).toMatch(/E appears more than once/);
	});

	it("rejects something that is not a pair at all", () => {
		expect(validateCvss("CVSS:4.0/AVN/AC:L")).toMatch(/not a metric:value pair/);
	});

	it("insists the Base block reads in spec order", () => {
		// Order is what every calculator parses against, and a reordered base is a
		// sign the vector was assembled by hand from the wrong table.
		expect(validateCvss("CVSS:4.0/AC:L/AV:N/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"))
			.toMatch(/Base metrics must appear in spec order/);
	});

	it("does not mind where the optional metrics sit", () => {
		// Rejecting a vector every calculator reads correctly would cost a finding
		// to enforce a preference.
		expect(validateCvss("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/E:A/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeUndefined();
	});

	it("takes an empty string as nothing to check", () => {
		expect(validateCvss("")).toBeUndefined();
		expect(validateCvss("   ")).toBeUndefined();
	});
});

describe("reading a vector back", () => {
	it("reports the version, the metrics, and whether it carries more than a base score", () => {
		expect(parseCvss(V4)).toMatchObject({ version: "4.0", extended: false });
		expect(parseCvss(V4)?.metrics).toMatchObject({ AV: "N", AT: "N", VC: "H", SA: "N" });
		expect(parseCvss(`${V4}/E:A`)?.extended).toBe(true);
		expect(parseCvss(V31)).toMatchObject({ version: "3.1", extended: false });
		expect(parseCvss(`${V31}/E:F`)?.extended).toBe(true);
	});

	it("returns nothing for anything the validator rejects", () => {
		expect(parseCvss("nonsense")).toBeUndefined();
		expect(cvssVersion("nonsense")).toBeUndefined();
	});
});

describe("the qualitative bands", () => {
	it("are shared by both versions — the ratings moved, the bands did not", () => {
		expect(cvssBand(0)).toBe("none");
		expect(cvssBand(0.1)).toBe("low");
		expect(cvssBand(3.9)).toBe("low");
		expect(cvssBand(4)).toBe("medium");
		expect(cvssBand(6.9)).toBe("medium");
		expect(cvssBand(7)).toBe("high");
		expect(cvssBand(8.9)).toBe("high");
		expect(cvssBand(9)).toBe("critical");
		expect(cvssBand(10)).toBe("critical");
	});
});
