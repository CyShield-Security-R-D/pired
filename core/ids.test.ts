import { describe, expect, it } from "vitest";
import { freshId, idMinter } from "./ids.ts";
import type { Ids } from "./ports.ts";

/** An id source that returns exactly the draws it is given, then `rest` forever. */
function scripted(draws: string[], rest = "zzzzzz"): Ids & { drawn: number } {
	const queue = [...draws];
	const source = {
		drawn: 0,
		newId(): string {
			source.drawn += 1;
			return queue.shift() ?? rest;
		},
	};
	return source;
}

function rows(...ids: string[]): Array<{ id: string }> {
	return ids.map((id) => ({ id }));
}

describe("minting an id that is not already in the store", () => {
	it("returns the first draw when nothing holds it", () => {
		const ids = scripted(["a1b2c3"]);
		expect(freshId(ids, () => false)).toBe("a1b2c3");
		expect(ids.drawn).toBe(1);
	});

	it("mints a fresh id when the first draw collides with a stored row", () => {
		// The store keeps the latest line per id, so handing back "a1b2c3" here
		// would have replaced the finding that holds it with a different one.
		const stored = new Set(["a1b2c3"]);
		const ids = scripted(["a1b2c3", "d4e5f6"]);
		expect(freshId(ids, (id) => stored.has(id))).toBe("d4e5f6");
	});

	it("throws after the attempts are exhausted, rather than overwriting a record", () => {
		const ids = scripted([], "a1b2c3");
		expect(() => freshId(ids, (id) => id === "a1b2c3", 5)).toThrow(/could not mint an unused id after 5 attempts/);
		expect(ids.drawn).toBe(5);
	});

	it("gives up after 64 draws by default, which no working id source ever reaches", () => {
		const ids = scripted([], "a1b2c3");
		expect(() => freshId(ids, () => true)).toThrow(/nothing was written/);
		expect(ids.drawn).toBe(64);
	});
});

describe("minting ids for one write", () => {
	it("never gives two rows of one bulk write the same id", () => {
		// A class x element write mints hundreds of ids inside one lock; checking
		// each only against the stored rows would let two new rows share an id,
		// and the second would silently replace the first on the next read.
		const mint = idMinter(scripted(["aaaaaa", "aaaaaa", "bbbbbb", "aaaaaa", "bbbbbb", "cccccc"]), []);
		expect([mint(), mint(), mint()]).toEqual(["aaaaaa", "bbbbbb", "cccccc"]);
	});

	it("skips ids the store already holds as well as ids it handed out", () => {
		const mint = idMinter(scripted(["aaaaaa", "bbbbbb", "bbbbbb", "cccccc"]), rows("aaaaaa"));
		expect([mint(), mint()]).toEqual(["bbbbbb", "cccccc"]);
	});
});
