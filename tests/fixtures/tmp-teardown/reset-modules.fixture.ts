// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the root is
// created through a SECOND copy of test-utils (`vi.resetModules()` re-evaluates
// it), never cleaned up. A module-local registry would hide it from the setup.
import { expect, it, vi } from "vitest";

it("creates a registered root through a re-evaluated test-utils", async () => {
	vi.resetModules();
	const { setupTestEnvironment } = await import(
		"../../clients/test-utils.js"
	);
	expect(setupTestEnvironment("pi-lens-2912-reset-").tmpDir).toContain(
		"pi-lens-2912-reset-",
	);
});
