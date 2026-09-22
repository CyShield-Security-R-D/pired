import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["core/**/*.test.ts", "extensions/**/*.test.ts", "bin/**/*.test.ts", "eval/**/*.test.ts", "install.test.ts"],
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			reportsDirectory: "eval/coverage",
			// Measure what ships. Everything named here is code a user runs.
			include: ["core/**/*.ts", "extensions/**/*.ts", "bin/**/*.mjs", "eval/grade.ts", "eval/key.ts"],
			exclude: [
				"**/*.test.ts",
				// Fakes for other modules' tests.
				"core/testing/**",
				// The two entry scripts are shells: read argv, touch the disk, spawn or
				// print. Every decision they used to make now lives in launch.mjs and
				// state.mjs, which are measured. What is left is the IO itself, and a
				// test that mocks all of it would assert only that the mocks were called.
				"bin/pired.mjs",
				"bin/pired-state.mjs",
				"bin/pired-ledger.mjs",
			],
			/**
			 * A ratchet, in the same spirit as eval/ratchet.json: these are floors set
			 * just under what is measured today, so the suite fails when coverage goes
			 * backwards rather than when it fails to reach an aspiration.
			 *
			 * The global floor is dragged down by extensions/pired.ts, which is ~2000
			 * lines of TUI rendering and pi wiring around a small amount of logic. That
			 * logic has been moved out to core as it was found — planExtraction and
			 * applyPlan are the most recent — and the honest way to raise this number
			 * is to keep doing that, not to exclude the file.
			 */
			thresholds: {
				statements: 72,
				branches: 64,
				functions: 71,
				lines: 74,
				"core/**/*.ts": { statements: 90, branches: 78, functions: 92, lines: 94 },
				"bin/**/*.mjs": { statements: 95, branches: 90, functions: 95, lines: 95 },
				"extensions/lib/**/*.ts": { statements: 78, branches: 72, functions: 82, lines: 80 },
				"eval/**/*.ts": { statements: 78, branches: 90, functions: 92, lines: 74 },
			},
		},
	},
});
