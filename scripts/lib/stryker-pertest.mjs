// #4365: the per-test Stryker campaign on clients/. Three halves, all pure
// enough to test without Stryker: which tests a module's run is given
// (planPertest), the vitest-5 compatibility patch to Stryker's runner
// (patchVitestRunner), and the report reader that names tests which cover
// mutated code but kill no mutant (findWorthlessTests).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	compiledJsPath,
	importsMutationSource,
	isCompiledMutationSource,
	mapRelatedTests,
} from "./stryker-diff.mjs";

/**
 * Governance tests are excluded by rule. Two spellings of the same idea:
 * tests/config suites read docs, workflows and package manifests as text, and
 * the `tests/clients` suites the repo selects as governance by name
 * (docs/pi-lens-subagent.md "Tests and probes": sweep, ratchet, conformance,
 * coverage, gate, governance, silence, hermeticity, invariant, contract) scan
 * source as text. Neither runs the mutated code, so in every run they would read
 * as "covers the module, kills nothing" and the report could not tell them from
 * a worthless test.
 */
export const GOVERNANCE_TEST_PREFIX = "tests/config/";
const GOVERNANCE_NAME_RE =
	/(?:sweep|ratchet|conformance|coverage|gate|governance|silence|hermeticity|invariant|contract)[^/]*\.test\.ts$/;
const GOVERNANCE_REASON =
	"governance suite: scans docs, workflows, manifests or source as text";

/** @param {string} file */
export const isGovernanceTest = (file) =>
	file.startsWith(GOVERNANCE_TEST_PREFIX) || GOVERNANCE_NAME_RE.test(file);

/**
 * The tests one module's campaign runs: the one-hop importers and conventional
 * siblings `mapRelatedTests` already selects for the diff lane, minus the
 * governance rule above. The `// mutation-lane: exclude` markers (with their
 * checked reasons in tests/config/stryker-diff-exclusions.json) apply as in
 * that lane.
 *
 * @param {string} moduleFile a runtime `.ts` source, e.g. `clients/run-duration.ts`
 * @param {Parameters<typeof mapRelatedTests>[1]} [options]
 * @returns {{module: string, target: string, tests: string[], excluded: Array<{file: string, reason: string}>}}
 */
export function planPertest(moduleFile, options) {
	if (!isCompiledMutationSource(moduleFile)) {
		throw new Error(`stryker-pertest: not a runtime .ts source: ${moduleFile}`);
	}
	const { related, excluded } = mapRelatedTests([moduleFile], options);
	const governance = [];
	const tests = [];
	for (const test of related.get(moduleFile)) {
		if (isGovernanceTest(test)) {
			governance.push({ file: test, reason: GOVERNANCE_REASON });
		} else tests.push(test);
	}
	if (tests.length === 0) {
		throw new Error(`stryker-pertest: no test imports ${moduleFile}`);
	}
	return {
		module: moduleFile,
		target: compiledJsPath(moduleFile),
		tests: tests.sort(),
		excluded: [...excluded, ...governance],
	};
}

/**
 * Rotation size cap, in source lines of the `.ts` module. Runs on GitHub
 * (ubuntu-latest, concurrency 2, bail off, 2026-10-14) measured 0.17 to 1.76
 * mutants per line and 0.7 to 3.2 s per mutant: clients/run-duration.ts 54
 * lines -> 16 mutants, 5 s; clients/read-bridge.ts 252 lines -> 103 mutants,
 * 234 s; clients/bounded-pid-file-lock.ts 321 mutants, 5m33s; the slowest,
 * clients/process-singletons.ts 71 mutants, took 14m50s. Time follows mutants
 * times the tests covering each, not lines alone. 600 lines bounds the worst
 * measured density (about 1000 mutants at 3.2 s, about 53 minutes) under the
 * 90-minute job cap.
 */
export const MAX_ROTATION_MODULE_LINES = 600;

/**
 * Modules the rotation may pick: runtime `.ts` sources with an own test (see
 * `isOwnTest`) that imports them, and at most `maxLines` long. The import is
 * required: a test named for a module but not importing it (PR #4372 pilot,
 * clients/dispatch/rule-ignores.ts) gives `planPertest` no importer, so the
 * rotation would pick a module whose run always throws. The run itself still
 * takes every one-hop importer (`planPertest`). Cheap on purpose: the full
 * import scan costs minutes over the whole tree, and only own tests are read.
 *
 * @param {string[]} moduleFiles candidate `.ts` sources
 * @param {{testFiles: string[], lineCount?: (file: string) => number, maxLines?: number, readFile?: (file: string) => string}} options
 * @returns {string[]} sorted
 */
export function eligibleModules(
	moduleFiles,
	{
		testFiles,
		lineCount = (file) => readFileSync(file, "utf8").split("\n").length,
		maxLines = MAX_ROTATION_MODULE_LINES,
		readFile = (file) => readFileSync(file, "utf8"),
	},
) {
	const tests = testFiles.filter((test) => !isGovernanceTest(test));
	const importsModule = (file) =>
		tests.some(
			(test) =>
				isOwnTest(test, file) &&
				importsMutationSource(test, readFile(test), file),
		);
	return moduleFiles
		.filter(isCompiledMutationSource)
		.filter((file) => importsModule(file) && lineCount(file) <= maxLines)
		.sort();
}

/**
 * Deterministic rotation: the module at `index` modulo the list. The workflow
 * passes its run number, so consecutive runs walk the list.
 *
 * @param {string[]} eligible
 * @param {number} index
 */
export function pickModule(eligible, index) {
	if (!Number.isInteger(index) || index < 0) {
		throw new Error(
			`stryker-pertest: rotation index is not a non-negative integer: ${index}`,
		);
	}
	if (eligible.length === 0) {
		throw new Error("stryker-pertest: no eligible module to rotate through");
	}
	return eligible[index % eligible.length];
}

/**
 * Split a module's planned tests by a pre-flight run under the runner's own
 * pool. The runner pins `pool: "threads"` over any config, `process.chdir()`
 * throws in a worker thread, and Stryker aborts the whole dry run on one failing
 * test (pilot, clients/spawn-timeout-cooldown.js: 4 chdir failures, no report).
 * A file that fails there, or that the report never mentions, is dropped and
 * named; the rest run.
 *
 * @param {string[]} tests planned test files, repo-relative
 * @param {{testResults: Array<{name: string, status: string, message?: string, assertionResults: Array<{title: string, status: string}>}>}} vitestJson
 *   vitest `--reporter=json` output of the pre-flight run
 * @param {string} root the absolute repo root the report's names are under
 */
export function splitRunnableTests(tests, vitestJson, root) {
	const byFile = new Map(
		vitestJson.testResults.map((result) => [
			path.relative(root, result.name).replaceAll("\\", "/"),
			result,
		]),
	);
	const kept = [];
	const dropped = [];
	for (const file of tests) {
		const result = byFile.get(file);
		if (!result) {
			dropped.push({
				file,
				failures: ["not reported by the pre-flight run"],
			});
			continue;
		}
		const failures = result.assertionResults
			.filter((assertion) => assertion.status === "failed")
			.map((assertion) => assertion.title);
		if (failures.length === 0 && result.status === "failed") {
			failures.push(result.message || "suite failed to run");
		}
		if (failures.length > 0) dropped.push({ file, failures });
		else kept.push(file);
	}
	return { kept, dropped };
}

// @stryker-mutator/vitest-runner 10.0.0 builds a test's name by joining its
// describe titles with a space (stryker-setup.js, copied into the run, and
// test-helpers.js). Vitest 5 matches `testNamePattern` against `fullTestName`,
// which joins with " > ". Unpatched, every mutant run skipped every test: 16 of
// 16 mutants of clients/run-duration.js read "Survived" with 0 tests run
// (spike 2026-10-14). Both files must change together, or the dry run's
// coverage ids stop matching the ids the mutant runs filter on.
const RUNNER_FILES = ["dist/src/stryker-setup.js", "dist/src/test-helpers.js"];
const UNPATCHED_JOIN = "nameParts.join(' ')";
const PATCHED_JOIN = "nameParts.join(' > ')";

/**
 * Patch the installed runner for vitest 5. Idempotent; throws when a file holds
 * neither spelling, so a runner release that renames the join reds the run
 * instead of silently reporting every mutant as surviving.
 *
 * @param {string} runnerDir the `@stryker-mutator/vitest-runner` package directory
 * @returns {{patched: number}} files rewritten by this call
 */
export function patchVitestRunner(runnerDir) {
	let patched = 0;
	for (const rel of RUNNER_FILES) {
		const file = path.join(runnerDir, rel);
		const source = readFileSync(file, "utf8");
		if (source.includes(PATCHED_JOIN)) continue;
		if (!source.includes(UNPATCHED_JOIN)) {
			throw new Error(
				`stryker-pertest: ${rel} holds neither ${UNPATCHED_JOIN} nor ${PATCHED_JOIN}; the runner changed, re-verify the vitest 5 name join`,
			);
		}
		writeFileSync(file, source.replace(UNPATCHED_JOIN, PATCHED_JOIN));
		patched += 1;
	}
	return { patched };
}

/**
 * True when `testFile` is the module's own test: `tests/<path>.test.ts` or
 * `tests/<path>-*.test.ts` for `<path>.ts` (the pairing `mapRelatedTests` calls
 * a sibling). Anything else that imports the module guards some other seam.
 *
 * @param {string} testFile @param {string} moduleFile
 */
export function isOwnTest(testFile, moduleFile) {
	const stem = `tests/${moduleFile.replace(/\.ts$/, "")}`;
	return (
		testFile === `${stem}.test.ts` ||
		(testFile.startsWith(`${stem}-`) && testFile.endsWith(".test.ts"))
	);
}

const COUNTED = new Set(["Killed", "Survived", "Timeout"]);

const REASONS = {
	"covers-no-mutant": "covers code no mutant reaches",
	redundant:
		"restates the implementation: it covers mutants that other tests kill and kills none itself",
	"observes-nothing":
		"asserts its own setup: every mutant it covers survives every test",
};

/**
 * @typedef {{id: string, status: string, coveredBy?: string[], killedBy?: string[], static?: boolean}} ReportMutant
 * @typedef {{files: Record<string, {mutants: ReportMutant[]}>, testFiles?: Record<string, {tests: Array<{id: string, name: string}>}>}} MutationReport
 */

/** @param {MutationReport} report */
function indexTests(report) {
	const byId = new Map();
	for (const [file, { tests }] of Object.entries(report.testFiles ?? {})) {
		for (const test of tests) byId.set(test.id, { file, name: test.name });
	}
	return byId;
}

/** @param {MutationReport} report @returns {ReportMutant[]} */
const allMutants = (report) =>
	Object.values(report.files).flatMap((file) => file.mutants);

/**
 * Tests that cover mutated code but kill no mutant, each with a reason code.
 * The code is decided by what the OTHER tests do with the mutants this one
 * covers: some are killed by another test (`redundant`), or none is killed by
 * anyone (`observes-nothing`). A test that covers a Timeout mutant is never listed: a timeout carries no
 * `killedBy`, so it cannot be told from a kill by that test. A static mutant
 * runs at import, so Stryker records no `coveredBy` for it; every test is
 * treated as covering it.
 *
 * @param {MutationReport} report
 * @param {string} [moduleFile] the mutated `.ts` module; marks each candidate
 *   `own` when it lives in that module's own test files
 */
export function findWorthlessTests(report, moduleFile = "") {
	const tests = indexTests(report);
	const stats = new Map(
		[...tests.keys()].map((id) => [
			id,
			{ covers: 0, kills: 0, timeouts: 0, survivors: 0, killedByOthers: 0 },
		]),
	);
	for (const mutant of allMutants(report)) {
		if (!COUNTED.has(mutant.status)) continue;
		const covering = mutant.static
			? [...tests.keys()]
			: (mutant.coveredBy ?? []);
		const killers = new Set(mutant.killedBy ?? []);
		for (const id of covering) {
			const stat = stats.get(id);
			if (!stat) continue;
			stat.covers += 1;
			if (mutant.status === "Timeout") stat.timeouts += 1;
			else if (killers.has(id)) stat.kills += 1;
			else if (mutant.status === "Survived") stat.survivors += 1;
			else stat.killedByOthers += 1;
		}
	}
	const found = [];
	for (const [id, stat] of stats) {
		if (stat.kills > 0 || stat.timeouts > 0) continue;
		const code =
			stat.covers === 0
				? "covers-no-mutant"
				: stat.killedByOthers > 0
					? "redundant"
					: "observes-nothing";
		const { file, name } = tests.get(id);
		found.push({
			id,
			file,
			name,
			code,
			reason: REASONS[code],
			covers: stat.covers,
			kills: stat.kills,
			survivedCovered: stat.survivors,
			killedByOthers: stat.killedByOthers,
			own: moduleFile !== "" && isOwnTest(file, moduleFile),
		});
	}
	return found;
}

/** @param {MutationReport} report */
export function summarizeReport(report) {
	const counts = { total: 0 };
	for (const { status } of allMutants(report)) {
		counts.total += 1;
		counts[status] = (counts[status] ?? 0) + 1;
	}
	return counts;
}

/**
 * Markdown for the step summary and the artifact.
 *
 * @param {ReturnType<typeof findWorthlessTests>} candidates
 * @param {ReturnType<typeof summarizeReport>} summary
 * @param {{module?: string}} [meta]
 */
export function renderCandidates(candidates, summary, { module = "" } = {}) {
	const counts = Object.entries(summary)
		.map(([key, value]) => `${key}: ${value}`)
		.join(", ");
	const lines = [
		`## Per-test Stryker candidates${module ? `: \`${module}\`` : ""}`,
		"",
		`Mutants: ${counts}.`,
		"",
	];
	if (candidates.length === 0) {
		lines.push("Every test in the run kills at least one mutant.");
		return `${lines.join("\n")}\n`;
	}
	const row = (c) =>
		`| \`${c.file}\` | ${c.name.replaceAll("|", "\\|")} | ${c.covers} | ${c.kills} | ${c.reason} |`;
	const table = (title, rows) => {
		if (rows.length === 0) return;
		lines.push(
			`### ${title} (${rows.length})`,
			"",
			"| test file | test | covers | kills | reason |",
			"| --- | --- | --- | --- | --- |",
			...rows.map(row),
			"",
		);
	};
	// The module's own tests are the deletion review. The rest cover it as a
	// side effect of guarding another seam and are listed for completeness.
	table(
		"Own tests",
		candidates.filter((c) => c.own),
	);
	table(
		"Other seams",
		candidates.filter((c) => !c.own),
	);
	return `${lines.join("\n")}\n`;
}
