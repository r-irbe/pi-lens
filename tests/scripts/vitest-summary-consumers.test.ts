import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractFailingTestIds,
	stripLogDecorations,
	validateLog,
} from "../../scripts/ci-test-diff.mjs";
import { formatGatingSplit, parseJobLog } from "../../scripts/ci-verdict.mjs";
import {
	reportedFailureFiles,
	unattributedFailure,
} from "../../scripts/lane-check.mjs";
import { parseWindowsVitestFailureCount } from "../../scripts/lib/windows-vitest-failure-count.mjs";
import { parseVitestCounts } from "../../scripts/pre-push-targeted-tests.mjs";

// Recurrence: #4087. Four scripts parsed Vitest console output and each lost
// the same fight with CI's colour: lane-check read no red (#4074), mutate read
// ERROR as RED (#4075), ci-test-diff needed its own strip (#4079), and
// pre-push-targeted-tests recorded `failed: 0` for a red run because
// `^\s*Tests` never matched `<ESC>[2m      Tests`. Both fixtures are one real
// Vitest 5.0.3 run (1 failed | 2 passed | 1 skipped) of the same file, one
// under FORCE_COLOR=1 and one plain. scripts/mutate.mjs is guarded by the real
// FORCE_COLOR=1 spawn in tests/scripts/mutate.test.ts; its classifier is not
// importable without running the CLI.
const FIXTURES = path.join(__dirname, "fixtures");
const load = (name: string) =>
	fs
		.readFileSync(path.join(FIXTURES, name), "utf8")
		.replaceAll("<ESC>", "\u001b");
const plain = load("vitest-mixed-plain.txt");
const coloured = load("vitest-mixed-color.txt");
const REDFILE = "tests/scripts/zz-probe-4087.test.ts";
const ID = `default::${REDFILE} › probe red`;

describe("every Vitest-output consumer reads coloured output like plain output (#4087)", () => {
	it("the fixtures differ only by colour", () => {
		expect(coloured).toContain("\u001b[");
		expect(plain).not.toContain("\u001b");
	});

	it.each([
		["plain", plain],
		["coloured", coloured],
	])("pre-push counts (%s)", (_name, output) => {
		expect(parseVitestCounts(output)).toEqual({
			passed: 2,
			failed: 1,
			skipped: 1,
		});
	});

	it.each([
		["plain", plain],
		["coloured", coloured],
	])("lane-check names the failing file (%s)", (_name, output) => {
		expect(
			reportedFailureFiles(output, [REDFILE, "tests/other.test.ts"]),
		).toEqual([REDFILE]);
		// One failing file counted, none named: unattributed, never "no red".
		expect(unattributedFailure(1, output, [])).toContain(
			"no failing test file",
		);
		expect(unattributedFailure(1, output, [REDFILE])).toBeNull();
	});

	it.each([
		["plain", plain],
		["coloured", coloured],
	])(
		"ci-test-diff extracts the same failure identity (%s)",
		(_name, output) => {
			expect(extractFailingTestIds(stripLogDecorations(output))).toEqual([ID]);
			// validateLog is also handed raw, undecorated text by library callers.
			expect(validateLog(output)).toMatchObject({
				ids: [ID],
				testsFailed: 1,
				suitesFailed: 0,
			});
		},
	);

	it.each([
		["plain", plain],
		["coloured", coloured],
	])("the Windows failure count reads %s output", (_name, output) => {
		expect(parseWindowsVitestFailureCount(output)).toBe(1);
	});

	// The red-row label reads the `Tests` line parseJobLog kept from an Actions
	// job log (timestamped, coloured).
	it.each([
		["plain", plain],
		["coloured", coloured],
	])(
		"ci-verdict labels a red advisory row with its failed count (%s)",
		(_name, output) => {
			const log = output
				.split("\n")
				.map((line) => `2026-10-07T09:33:20.0019603Z ${line}`)
				.join("\n");
			const row = {
				id: 7,
				name: "Heavy",
				gating: false,
				present: true,
				status: "completed",
				conclusion: "failure",
				url: null,
			};
			const [, advisory] = formatGatingSplit(
				[row],
				[],
				[{ rowId: 7, summary: parseJobLog(log).summary }],
			);
			expect(advisory).toBe(
				"Advisory (never gates): 1 checks, 1 red: Heavy (failure, 1 failed)",
			);
		},
	);

	// Recurrence: PR #4109 review F1 (a nested summary before the real one).
	it("ci-test-diff and the Windows count read the run's own summary, not a nested one", () => {
		const log =
			"Tests  5 passed (5)\nTests are great\nTests  1 failed | 4 passed (5)\nFailed Tests  1\n" +
			" FAIL  default tests/a.test.ts > x\n";
		expect(validateLog(log)).toMatchObject({ testsFailed: 1 });
		expect(parseWindowsVitestFailureCount(log)).toBe(1);
	});
});
