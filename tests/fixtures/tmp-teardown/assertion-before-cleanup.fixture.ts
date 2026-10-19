// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): a failing
// assertion between `setupTestEnvironment` and a bare `env.cleanup()`.
import { expect, it } from "vitest";
import { setupTestEnvironment } from "../../clients/test-utils.js";

it("fails an assertion before cleanup", () => {
	const env = setupTestEnvironment("pi-lens-2912-assert-");
	expect(env.tmpDir).toBe("not the temp dir");
	env.cleanup();
});
