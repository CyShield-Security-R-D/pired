import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["core/**/*.test.ts", "extensions/**/*.test.ts"],
		environment: "node",
	},
});
