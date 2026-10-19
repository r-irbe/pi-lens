// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the shape of
// `pi-lens-tool-discovery-home-*` (#3699). The file removes its raw root and the
// shared afterAll finds it absent; the deferred write only lands in the window
// between that afterAll and the fork's SIGTERM, so only the SIGTERM sweep can see
// it. The listener is PREPENDED so the write lands before the setup's sweep.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, it } from "vitest";

const dir = fs.mkdtempSync(
	path.join(os.tmpdir(), "pi-lens-2912-straggler-late-"),
);

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.prependOnceListener("SIGTERM", () => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "probe-cache.json"), "{}");
	});
});

it("removes its raw root in afterAll", () => {
	fs.writeFileSync(path.join(dir, "input.txt"), "x");
});
