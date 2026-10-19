// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the worker is
// SIGTERM'd while a test still holds a registered root. Vitest SIGTERMs its
// forks the same way, with no `exit` event (#3617).
import { it } from "vitest";
import { setupTestEnvironment } from "../../clients/test-utils.js";

it("is killed mid-file holding a registered root", async () => {
	setupTestEnvironment("pi-lens-2912-killed-");
	process.kill(process.pid, "SIGTERM");
	await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
});
