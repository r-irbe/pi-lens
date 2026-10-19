// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the shape of
// `pi-lens-sym-cpp-*` (#3706). A test times out while holding a registered
// root, so its own `finally { env.cleanup() }` never runs.
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "vitest";
import { setupTestEnvironment } from "../../clients/test-utils.js";

it("times out holding a registered root", { timeout: 300 }, async () => {
	const env = setupTestEnvironment("pi-lens-2912-timeout-");
	try {
		fs.writeFileSync(path.join(env.tmpDir, "source.cpp"), "int main() {}\n");
		await new Promise<never>(() => {});
	} finally {
		env.cleanup();
	}
});
