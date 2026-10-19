// Child Vitest run for tests/support/vitest-setup-registry-teardown.test.ts
// (#3617, #3703). It runs the two fixture files below through the REAL
// shared setup file in the default forks pool, so each file's worker is
// torn down exactly as the suite's are.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		root: fileURLToPath(new URL("../../..", import.meta.url)),
		include: ["tests/fixtures/registry-teardown/*.fixture.ts"],
		setupFiles: ["./tests/support/vitest-setup.ts"],
		maxWorkers: 2,
	},
});
