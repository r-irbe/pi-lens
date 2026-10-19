/**
 * Incremental mutation spike for changed script files (#1844 item 1).
 *
 * The command runner receives the related-test list from scripts/stryker-diff.mjs
 * through a generated config override. Command runner has no per-test coverage
 * analysis, so every related test file runs for every mutant.
 */
export default {
	// inPlace: Stryker's sandbox copy runs a tsconfig preprocessor that calls
	// ts.parseConfigFileTextToJson, which the TypeScript 7 native API this
	// repo pins does not export (spike 2026-09-08/09); mutating in place
	// skips that preprocessor. The command runner restores files after each
	// mutant.
	inPlace: true,
	// buildCommand runs once after instrumentation, before the dry run: the
	// in-place sandbox reset drops the compiled .js siblings the
	// tests execute, and vitest then reports "No test files found" (spike
	// 2026-09-09). The mutated .mjs scripts run directly, so no per-mutant
	// rebuild is needed.
	buildCommand: "npm run build",
	testRunner: "command",
	commandRunner: {
		command: "node_modules/.bin/vitest run --configLoader runner",
	},
	mutate: ["scripts/**/*.mjs", "!scripts/**/*.test.mjs"],
	incremental: true,
	incrementalFile: ".stryker/incremental.json",
	coverageAnalysis: "off",
	// Measured on the CI runner (4 vCPU, 16 GB), 10 mutants per arm, same diff
	// and tests: 2 -> 856 s, 3 -> 789 s, 4 -> 787 s of driver wall time, peak
	// memory 3.9 / 4.9 / 6.0 GB. 3 ties 4 on time and keeps each mutant round
	// (127 s) inside Stryker's kill bound (timeoutMS + 1.5 x the dry run, about
	// 165 s; 4 runs at 164 s). tests/fixtures/mutation-concurrency-measurement.json.
	concurrency: 3,
	// A cold Vitest process is allowed one minute. Stryker gives mutants 1.5x
	// the measured baseline before treating the command as hung.
	timeoutMS: 60000,
	timeoutFactor: 1.5,
	// The initial test run's own bound; Stryker's default is 5 minutes (#4092).
	// The nightly's 122-file selection took 358 s on 4 cores and 449 s on 2
	// (tests/fixtures/mutation-dry-run-measurement.json), past that default on
	// both shards of run 37629970371. The driver now caps the selection at
	// MAX_DRY_RUN_SECONDS (scripts/lib/stryker-diff.mjs), so 10 minutes is 2.5x
	// that estimate and 1.3x the slowest uncapped run measured; a run still past
	// it is reported as a named dry-run timeout, not a generic failure.
	dryRunTimeoutMinutes: 10,
	// Stryker's in-place mode writes `// @ts-nocheck` into EVERY tracked .js/.ts
	// file (2306 on a CI checkout) before the initial run, which dirties the tree:
	// tests/scripts/mutate.test.ts then failed 16 of 33 cases ("mutate.mjs:
	// refusing dirty file") and held both shards in the initial run for 460 and
	// 525 s (run 37650871948). Nothing here uses a type checker, so the rewrite
	// buys nothing (R2 of #4108).
	disableTypeChecks: false,
	reporters: ["clear-text", "json", "html"],
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	htmlReporter: { fileName: "reports/mutation/mutation.html" },
	thresholds: { high: 60, low: 20, break: 0 },
};
