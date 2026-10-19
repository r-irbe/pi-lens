import * as fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { setupTestEnvironment, useTrackedTempDirs } from "./test-utils.js";

// Recurrence (#4019): tests/clients/lsp/launch.test.ts registers its own
// `afterEach(() => vi.useRealTimers())` BEFORE `useTrackedTempDirs`. Vitest runs
// afterEach hooks in reverse registration order, so the drain ran while
// `vi.useFakeTimers()` still held `setImmediate`, parked forever, and timed the
// hook out at 10 s: ten Windows-lane tests red, the faking test and every test
// after it. The Windows-only gate hid it from the Linux lanes. This file has no
// gate and no `useRealTimers` teardown of its own, so only the helper's own
// guarantee (a real clock for the drain) can keep it green.
describe("useTrackedTempDirs under a fake clock (#4019)", () => {
	const PREFIX = "pi-lens-4019-fake-clock-";
	let faked = "";

	useTrackedTempDirs(PREFIX);

	it("leaves a tracked dir behind a faked clock", () => {
		vi.useFakeTimers();
		faked = setupTestEnvironment(PREFIX).tmpDir;
		expect(vi.isFakeTimers()).toBe(true);
		expect(fs.existsSync(faked)).toBe(true);
	});

	it("drained that dir on a real clock before the next test ran", () => {
		expect(vi.isFakeTimers()).toBe(false);
		expect(faked).not.toBe("");
		expect(fs.existsSync(faked)).toBe(false);
	});
});
