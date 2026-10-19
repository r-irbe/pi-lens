import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withPlatform } from "../support/platform-stub.js";
import { isFullyQualified } from "../../clients/path-utils.js";
import { getWin32LaneFiles } from "../../scripts/lib/win32-gate-population.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const THIS_FILE = "tests/clients/path-utils-win32-absolute.test.ts";

// The literals #1491 / #1498 found: a bare POSIX path is fully qualified on a
// POSIX host and only ambient-drive-relative on Windows, so a fixture built from
// it passes on Linux CI by construction.
const POSIX_LITERAL = "/fake/managed/jscpd";
const DRIVE_ABSOLUTE = String.raw`C:\fake\managed\jscpd.exe`;
const UNC = String.raw`\\server\share\jscpd.exe`;

describe("isFullyQualified host dispatch (#1506)", () => {
	// Recurrence: #1506 / #1491 / #1498. Every other `isFullyQualified` test
	// runs on the host's own arm, so on Linux CI dropping the win32 arm of the
	// dispatch (always answering with the POSIX rule) reds nothing.
	it.each([
		["POSIX literal", POSIX_LITERAL, false],
		["drive-absolute", DRIVE_ABSOLUTE, true],
		["UNC", UNC, true],
		["rooted-relative", String.raw`\fake\managed`, false],
		["drive-relative", "C:fake", false],
		["relative", "fake/managed", false],
	] as const)(
		"answers %s with Windows semantics on win32",
		(_label, value, expected) => {
			expect(withPlatform("win32", () => isFullyQualified(value))).toBe(
				expected,
			);
		},
	);

	it.each([
		["POSIX literal", POSIX_LITERAL, true],
		["drive-absolute", DRIVE_ABSOLUTE, false],
		["relative", "fake/managed", false],
	] as const)(
		"answers %s with POSIX semantics off win32",
		(_label, value, expected) => {
			for (const platform of ["linux", "darwin"] as const)
				expect(withPlatform(platform, () => isFullyQualified(value))).toBe(
					expected,
				);
		},
	);
});

describe("isFullyQualified on the native host (#1506)", () => {
	// Real win32 host: the only place the ambient arm meets the filesystem's own
	// absolute-path rules. Skipped elsewhere by declaration, selected by the
	// native Windows lane through the gate (scripts/lib/win32-gate-population.mjs).
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"rejects the bare POSIX literal and accepts the host-resolved form",
		() => {
			expect(isFullyQualified(POSIX_LITERAL)).toBe(false);
			expect(isFullyQualified(path.resolve(POSIX_LITERAL))).toBe(true);
			expect(isFullyQualified(DRIVE_ABSOLUTE)).toBe(true);
			expect(
				isFullyQualified(path.join(path.parse(process.cwd()).root, "x")),
			).toBe(true);
		},
	);
});

describe("native Windows lane selection (#1506)", () => {
	// Recurrence: #2536 shape, a Windows-only test present but with no CI
	// consumer. Removing the gate above would leave the native cell unselected.
	it("selects this file for the Windows Vitest subset", () => {
		expect(getWin32LaneFiles(ROOT)).toContain(THIS_FILE);
	});
});
