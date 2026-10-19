/**
 * #4320 round 2 (F3): birth time is not creation identity. Round 1 announced
 * Created to the language server for any file whose inode was born after the
 * client started, so pi-lens's own atomic partial edit (temp file + rename)
 * and every edit on Linux without statx (Node reports ctime as the birth
 * time) read as a creation. `pathBirthtimeMs` answers with the PATH's birth:
 * an inode pi-lens installed over an existing path inherits that path's
 * birth, and a birth the platform cannot report is unknown.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	noteAtomicReplace,
	notePathAppeared,
	pathBirthtimeMs,
	resetPathBirthForTests,
} from "../../clients/path-birth.js";

const stat = (dev: number, ino: number, birthtimeMs: number) => ({
	dev,
	ino,
	birthtimeMs,
	ctimeMs: birthtimeMs + 1,
});

const birthRecords = () =>
	getDegradationSummary().find(
		(group) => group.kind === "lsp-file-birth-unknown",
	);

describe("pathBirthtimeMs (#4320)", () => {
	beforeEach(() => {
		resetPathBirthForTests(false);
		resetDegradationLedger();
	});
	afterEach(() => {
		resetPathBirthForTests();
		resetDegradationLedger();
	});

	it("answers an inode's own birth when pi-lens did not install it", () => {
		expect(pathBirthtimeMs(stat(1, 7, 5_000))).toBe(5_000);
	});

	it("answers the replaced path's birth for an inode pi-lens installed over it, across chained replacements", () => {
		noteAtomicReplace(stat(1, 7, 1_000), stat(1, 8, 9_000));
		expect(pathBirthtimeMs(stat(1, 8, 9_000))).toBe(1_000);
		noteAtomicReplace(stat(1, 8, 9_000), stat(1, 9, 12_000));
		expect(pathBirthtimeMs(stat(1, 9, 12_000))).toBe(1_000);
	});

	// An inode number the filesystem reuses for an unrelated new file must not
	// inherit an old path's birth: that file would be announced as Changed and
	// the server would keep its failed lookup.
	it("does not lend a recorded birth to a reused inode number", () => {
		noteAtomicReplace(stat(1, 7, 1_000), stat(1, 8, 9_000));
		expect(pathBirthtimeMs(stat(1, 8, 20_000))).toBe(20_000);
		expect(pathBirthtimeMs(stat(2, 8, 9_000))).toBe(9_000);
	});

	it("is unknown when the filesystem reports no birth time, with one record per session", () => {
		expect(pathBirthtimeMs(stat(1, 7, 0))).toBeUndefined();
		expect(pathBirthtimeMs(stat(1, 8, 0))).toBeUndefined();
		expect(birthRecords()).toMatchObject({
			count: 1,
			latestReasons: [{ subject: "no-birth-time" }],
		});
	});

	it("is unknown when Node reports ctime as the birth time, with one record per session", () => {
		resetPathBirthForTests(true);
		expect(pathBirthtimeMs(stat(1, 7, 5_000))).toBeUndefined();
		expect(pathBirthtimeMs(stat(1, 8, 6_000))).toBeUndefined();
		expect(birthRecords()).toMatchObject({
			count: 1,
			latestReasons: [{ subject: "ctime-alias" }],
		});
	});

	// lane: Linux CI. The probe must not mistake a statx-backed host for the
	// fallback; on this lane `/proc` reports birth time 0.
	it.skipIf(process.platform !== "linux")(
		"trusts the birth time on a Linux host with statx",
		(ctx) => {
			resetPathBirthForTests();
			const real = fs.statSync(path.resolve("package.json"));
			if (!(real.birthtimeMs > 0)) ctx.skip("filesystem reports no birth time");
			expect(pathBirthtimeMs(real)).toBe(real.birthtimeMs);
			expect(birthRecords()).toBeUndefined();
		},
	);
});

// #4368 r1 row 13: a module moved into place keeps an inode born before the
// server, so the inode's birth reads as old and the server never hears
// Created. A recorded appearance of the PATH (the resolver saw an import
// resolve to nothing, then to it) answers instead.
describe("pathBirthtimeMs with a recorded appearance (#4368 r1 row 13)", () => {
	const moved = path.resolve("moved_module.py");
	beforeEach(() => {
		resetPathBirthForTests(false);
		resetDegradationLedger();
	});
	afterEach(() => {
		resetPathBirthForTests();
		resetDegradationLedger();
	});

	it("answers the appearance when it is later than the inode's birth", () => {
		notePathAppeared(moved, 20_000);
		expect(pathBirthtimeMs(stat(1, 7, 5_000), moved)).toBe(20_000);
		expect(pathBirthtimeMs(stat(1, 7, 5_000))).toBe(5_000);
		expect(pathBirthtimeMs(stat(1, 7, 5_000), `${moved}.other`)).toBe(5_000);
	});

	it("keeps the inode's birth when the appearance is older", () => {
		notePathAppeared(moved, 1_000);
		expect(pathBirthtimeMs(stat(1, 7, 5_000), moved)).toBe(5_000);
	});

	it("answers the appearance when the inode's birth is unknown", () => {
		notePathAppeared(moved, 20_000);
		expect(pathBirthtimeMs(stat(1, 7, 0), moved)).toBe(20_000);
	});
});
