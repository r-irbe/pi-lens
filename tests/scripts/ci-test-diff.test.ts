// flake-shape: real-process-spawn — the CLI's real exit status is the contract; an in-process main() call cannot prove the executable entry point (#4072 review F2).
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareFailureSets,
	extractFailingTestIds,
	stripLogDecorations,
	validateLog,
} from "../../scripts/ci-test-diff.mjs";

const fixture = (name: string) =>
	fs.readFileSync(path.join("tests/fixtures/ci-test-diff", name), "utf8");

// The green fixture is hand-composed in Vitest 5.0.3's real summary shape.
describe("ci-test-diff failure extraction", () => {
	// Recurrence: #4072's Windows logs contain ANSI, CRLF, and Actions timestamps;
	// the tool must compare test identities rather than the aggregate failure count.
	it("reproduces the 7 fixed / 7 new / 51 unchanged witness", () => {
		const master = extractFailingTestIds(
			stripLogDecorations(fixture("job-112724408671.log")),
		);
		const round2 = extractFailingTestIds(
			stripLogDecorations(fixture("job-112734370876.log")),
		);
		const diff = compareFailureSets(master, round2);

		expect(master).toHaveLength(58);
		expect(round2).toHaveLength(58);
		expect(diff.fixed).toHaveLength(7);
		expect(diff.newFailures).toHaveLength(7);
		expect(diff.unchanged).toHaveLength(51);
		expect(diff.fixed).toContain(
			"default::tests/clients/path-utils.test.ts › normalizeFilePath: dot segments fold into the canonical key (#3184) > an empty string is returned unchanged, not invented into the cwd",
		);
		expect(diff.newFailures).toContain(
			"default::tests/clients/read-guard-path-normalization.test.ts › ReadGuard path-key normalization (zero_read false-block regression) > getReadHistory matches across separator forms",
		);
	});

	it("normalizes Actions timestamps and terminal decoration", () => {
		const raw =
			"2026-10-07T00:00:00.000Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m default  tests/a.test.ts\r\n";
		expect(stripLogDecorations(raw)).toBe("FAIL  default  tests/a.test.ts\n");
	});

	it("covers collection, unnamed-project, fallback, and non-tests-root FAIL shapes", () => {
		const raw = [
			"job\tstep\t2026-10-07T00:00:00.000Z FAIL tests/imp.test.ts [ tests/imp.test.ts ]",
			"FAIL tests/single.test.ts > s > a > b",
			"FAIL TS clients/other.spec.ts > labelled",
		].join("\n");
		expect(extractFailingTestIds(stripLogDecorations(raw))).toEqual([
			"TS::clients/other.spec.ts › labelled",
			"tests/imp.test.ts",
			"tests/single.test.ts › s > a > b",
		]);
	});

	it("rejects incomplete or mismatched Vitest summaries", () => {
		expect(() =>
			validateLog("FAIL default tests/a.test.ts > t", "job A"),
		).toThrow("job A log incomplete");
		expect(() =>
			validateLog("Tests 1 failed\nFailed Tests 2", "job B"),
		).toThrow("mismatched Vitest failure summaries");
	});

	it("keeps project names in identities", () => {
		const log =
			"Tests 2 failed\n" +
			"Failed Tests 2\n" +
			"FAIL web tests/same.test.ts > same\n" +
			"FAIL node tests/same.test.ts > same\n";
		expect(validateLog(log).ids).toEqual([
			"node::tests/same.test.ts › same",
			"web::tests/same.test.ts › same",
		]);
	});

	it("normalizes Vitest's non-colour pipe project label", () => {
		const log =
			"Tests 1 failed\n" +
			"Failed Tests 1\n" +
			"FAIL |default| tests/same.test.ts > same\n";
		expect(validateLog(log).ids).toEqual([
			"default::tests/same.test.ts › same",
		]);
	});

	it("accepts a green run and reconciles an unhandled error without a suite", () => {
		expect(validateLog(fixture("job-green-vitest.log")).ids).toEqual([]);
		expect(
			validateLog(
				"Tests 1 failed\nFailed Suites 0\nErrors 1 error\n" +
					"FAIL default tests/late.test.ts > rejects late work",
			),
		).toMatchObject({ testsFailed: 1, suitesFailed: 0, unhandledErrors: 1 });
	});

	it("accepts a skipped-only run as a zero-failure side", () => {
		expect(validateLog("Tests 2 skipped\n").ids).toEqual([]);
	});

	it("rejects a failure count with too few extracted IDs", () => {
		expect(() =>
			validateLog(
				"Tests 2 failed\nFailed Tests 2\n" +
					"FAIL default tests/only.test.ts > only failure",
			),
		).toThrow("has 1 failure IDs; Vitest summary reports 2");
	});

	it("returns 0 for unchanged, 1 for NEW, and 2 for invalid job logs", () => {
		const scratch = fs.mkdtempSync(
			path.join(process.env.TMPDIR ?? os.tmpdir(), "ci-test-diff-"),
		);
		const gh = path.join(scratch, "gh");
		const fixtureDir = path.resolve("tests/fixtures/ci-test-diff");
		const fixtureA = path.join(fixtureDir, "job-112724408671.log");
		const fixtureB = path.join(fixtureDir, "job-112734370876.log");
		fs.writeFileSync(
			gh,
			`#!/usr/bin/env node\nconst fs = require("node:fs");\nconst request = process.argv.find((value) => value.includes("/jobs/")) ?? "";\nconst id = request.match(/\\/jobs\\/(\\d+)\\//)?.[1];\nconst file = id === "0" ? null : id === "3" ? ${JSON.stringify(path.join(fixtureDir, "job-green-vitest.log"))} : id === "4" ? ${JSON.stringify(path.join(scratch, "job-unhandled.log"))} : id === "2" ? ${JSON.stringify(fixtureB)} : ${JSON.stringify(fixtureA)};\nif (file) process.stdout.write(fs.readFileSync(file, "utf8"));\n`,
		);
		fs.writeFileSync(
			path.join(scratch, "job-unhandled.log"),
			"Tests 1 passed\nErrors 1 error\n",
		);
		fs.chmodSync(gh, 0o755);
		const env = { ...process.env, PATH: `${scratch}:${process.env.PATH}` };
		const run = (a: string, b: string) =>
			spawnSync(process.execPath, ["scripts/ci-test-diff.mjs", a, b], {
				cwd: path.resolve("."),
				encoding: "utf8",
				env,
			});
		expect(run("1", "1").status).toBe(0);
		expect(run("1", "2").status).toBe(1);
		expect(run("0", "1").status).toBe(2);
		// A→GREEN is clean, while GREEN→B is NEW; direction is the CLI contract.
		expect(run("1", "3").status).toBe(0);
		expect(run("3", "2").status).toBe(1);
		const unhandled = run("3", "4");
		expect(unhandled.status).toBe(1);
		expect(unhandled.stdout).toContain("NEW (1)");
		expect(unhandled.stdout).toContain("unhandled error 1");
		fs.rmSync(scratch, { recursive: true, force: true });
	});
});
