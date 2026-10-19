// Fixture for tests/support/vitest-setup-registry-teardown.test.ts (#3703
// round 2). Leaves fake timers on with a registry write queued behind a held
// lock: the write's lock wait sleeps on a frozen timer and never settles.
// The shared setup's afterAll must give up on it and still run its checks.
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { registerInstance } from "../../../clients/instance-registry.js";

const root = process.env.REGISTRY_TEARDOWN_ROOT;
if (!root) throw new Error("REGISTRY_TEARDOWN_ROOT is not set");
const home = path.join(root, "fake-timers");
fs.mkdirSync(home, { recursive: true });
process.env.PI_LENS_HOME = home;

it("leaves fake timers on with a registry write pending, then the file ends", () => {
	const lock = path.join(home, "instances.json.lock");
	fs.writeFileSync(lock, `${process.ppid} ${Date.now()}\n`);
	vi.useFakeTimers();
	void registerInstance(path.join(root, "fake-timers-root"));
	expect(fs.existsSync(lock)).toBe(true);
});
