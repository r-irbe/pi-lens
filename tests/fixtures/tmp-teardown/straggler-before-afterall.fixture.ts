// Fixture for tests/support/tmp-root-teardown.test.ts (#2912): the shape of
// `pi-lens-install-attempt-*` (#3705). A raw root the file REMOVES in its own
// afterEach is recreated by a deferred write while the file is still running.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, it } from "vitest";

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2912-straggler-early-"));
});

afterEach(() => {
	const root = dir;
	fs.rmSync(root, { recursive: true, force: true });
	setTimeout(() => {
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, "probe-cache.json"), "{}");
	}, 50);
});

// Keeps the file alive past the write, so it lands before the shared afterAll.
afterAll(async () => {
	await new Promise<void>((resolve) => setTimeout(resolve, 250));
});

it("removes its raw root and a deferred write recreates it", () => {
	fs.writeFileSync(path.join(dir, "input.txt"), "x");
});
