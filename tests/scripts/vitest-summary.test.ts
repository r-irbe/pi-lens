import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseVitestSummary } from "../../scripts/lib/vitest-summary.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("parseVitestSummary (#4087)", () => {
	const load = (name: string) =>
		readFileSync(join(here, "fixtures", name), "utf8").replaceAll(
			"<ESC>",
			"\u001b",
		);
	const ID = "default::tests/scripts/zz-probe-4087.test.ts › probe red";

	// Recurrence: #4087. CI colours Vitest, and escape codes split `Tests` from
	// its counts; one real FORCE_COLOR=1 run and its plain twin must parse alike.
	it.each(["vitest-mixed-plain.txt", "vitest-mixed-color.txt"])(
		"reads counts, ids and files from the real transcript %s",
		(name) => {
			expect(parseVitestSummary(load(name))).toEqual({
				noTests: false,
				testsFailed: 1,
				testsPassed: 2,
				testsSkipped: 1,
				failedTestsHeader: 1,
				suitesFailed: null,
				filesFailed: 1,
				unhandledErrors: null,
				failureIds: [ID],
				failedFiles: ["tests/scripts/zz-probe-4087.test.ts"],
			});
		},
	);

	it("strips Actions timestamps and CRLF from a coloured transcript", () => {
		const log = load("vitest-mixed-color.txt")
			.split("\n")
			.map((line) => `2026-10-07T09:33:20.0019603Z ${line}`)
			.join("\r\n");
		expect(parseVitestSummary(log)).toMatchObject({
			testsFailed: 1,
			testsPassed: 2,
			filesFailed: 1,
			failureIds: [ID],
		});
	});

	it("reports an absent summary as null, never as zero", () => {
		expect(parseVitestSummary("Vitest crashed\n")).toEqual({
			noTests: false,
			testsFailed: null,
			testsPassed: null,
			testsSkipped: null,
			failedTestsHeader: null,
			suitesFailed: null,
			filesFailed: null,
			unhandledErrors: null,
			failureIds: [],
			failedFiles: [],
		});
	});

	it.each([
		["\u001b[2m      Tests \u001b[22m \u001b[33mno tests\u001b[39m\n", true],
		["      Tests  0 tests\n", true],
		["      Tests  1 passed (1)\n", false],
	])("detects a run with no tests (%j)", (log, expected) => {
		expect(parseVitestSummary(log).noTests).toBe(expected);
	});

	it("takes a failing file from FAIL and inline suite lines, not stack frames", () => {
		const log =
			" FAIL  |default| tests/a.test.ts > t\n" +
			" \u001b[31m❯\u001b[39m |default| tests/b.test.ts (2 tests | 1 failed) 8ms\n" +
			" ❯ tests/c.test.ts:5:35\n";
		expect(parseVitestSummary(log).failedFiles).toEqual([
			"tests/a.test.ts",
			"tests/b.test.ts",
		]);
	});

	// Recurrence: PR #4109 review F1. Master's ci-test-diff skipped any `Tests`
	// line that was not `Tests N failed`, and its Windows count took the last
	// one; a first-`Tests`-line rule read a prose line, or a nested summary a
	// failing assertion quoted, instead of the run's own (printed last).
	it("skips a prose Tests line around the real summary", () => {
		const log =
			"Tests are great\n  Tests  the harness prints this\n      Tests  1 failed | 2 passed (3)\nTests are great again\n";
		expect(parseVitestSummary(log)).toMatchObject({
			testsFailed: 1,
			testsPassed: 2,
			noTests: false,
		});
	});

	it("takes the last summary when a nested one is printed before it", () => {
		const nested =
			"Tests  5 passed (5)\n FAIL  tests/a.test.ts > x\n Test Files  1 failed (1)\n      Tests  1 failed | 4 passed (5)\n";
		expect(parseVitestSummary(nested)).toMatchObject({
			testsFailed: 1,
			testsPassed: 4,
			filesFailed: 1,
		});
		// The other direction: a nested failure must not outlive a green run.
		const green =
			"Tests  1 failed | 4 passed (5)\n\n      Tests  5 passed (5)\n";
		expect(parseVitestSummary(green)).toMatchObject({
			testsFailed: null,
			testsPassed: 5,
		});
	});
});
