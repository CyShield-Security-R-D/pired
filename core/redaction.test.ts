import { describe, expect, it } from "vitest";
import type { LootRecord } from "./ontology.ts";
import { buildRedactor } from "./redaction.ts";

function loot(id: string, handle: string, secret: string): LootRecord {
	return { v: 1, id, kind: "loot", createdAt: "t", handle, type: "password", secret };
}

describe("buildRedactor", () => {
	it("masks a known secret with its handle", () => {
		const r = buildRedactor([loot("c1", "cred:web-admin", "S3cr3tP@ss")]);
		expect(r.mask("password is S3cr3tP@ss here")).toBe("password is [REDACTED cred:web-admin] here");
	});

	it("masks longer secrets before shorter overlapping ones", () => {
		const r = buildRedactor([loot("c1", "cred:a", "SuperSecret"), loot("c2", "cred:b", "SuperSecretExtra")]);
		expect(r.mask("x SuperSecretExtra y")).toBe("x [REDACTED cred:b] y");
	});

	it("masks nested object and array fields", () => {
		const r = buildRedactor([loot("c1", "cred:t", "tok_abcdef")]);
		const out = r.maskDeep({ note: "use tok_abcdef", meta: { headers: ["Authorization: tok_abcdef"] } });
		expect(out).toEqual({ note: "use [REDACTED cred:t]", meta: { headers: ["Authorization: [REDACTED cred:t]"] } });
	});

	it("ignores deleted loot and too-short secrets", () => {
		const r = buildRedactor([{ ...loot("c1", "cred:x", "longsecret"), deleted: true }, loot("c2", "cred:y", "abc")]);
		expect(r.mask("longsecret abc")).toBe("longsecret abc");
	});

	it("is identity when there is no loot", () => {
		expect(buildRedactor([]).mask("nothing to mask")).toBe("nothing to mask");
	});
});
