/**
 * Per-test mutation campaign on one clients/ module (#4365).
 *
 * Driven by scripts/stryker-pertest.mjs and
 * .github/workflows/stryker-pertest.yml, which pass `--mutate <module>.js` and
 * PILENS_MUTATION_TESTS (the module's one-hop tests, vitest.mutation.config.ts).
 *
 * Differences from stryker.config.mjs, which stays the diff lane's config:
 *   - testRunner "vitest" with coverageAnalysis "perTest", so the JSON report
 *     records which test covered and which test killed each mutant.
 *   - The target is the compiled `.js` twin. Tests import `../../clients/x.js`;
 *     vitest loads that file, never the `.ts` (spike 2026-10-14: editing the
 *     `.js` reds the test, editing the `.ts` changes nothing).
 *   - `vitest.related` is off: the run is given its test files by name.
 *   - No incremental file: one module per run, nothing to carry over.
 */
const {
	commandRunner: _commandRunner,
	htmlReporter: _htmlReporter,
	...base
} = (await import("./stryker.config.mjs")).default;

export default {
	...base,
	testRunner: "vitest",
	vitest: { configFile: "vitest.mutation.config.ts", related: false },
	coverageAnalysis: "perTest",
	// The base config's `npm run build` would overwrite the instrumented `.js`
	// before a single test ran; this only refreshes mtimes (the same override
	// scripts/lib/stryker-diff.mjs applies to every compiled target).
	buildCommand: "node scripts/lib/mutation-touch-build.mjs",
	incremental: false,
	// The runner bails at the first failing test of a mutant run, so `killedBy`
	// would name one killer and every later test that also fails would read as
	// "kills nothing". clients/json-cache-read.js (spike 2026-10-14): 89 of 92
	// tests listed with bail, 66 without. Every covered test runs instead.
	disableBail: true,
	// Each runner process holds one vitest instance (the runner pins one worker).
	concurrency: 2,
	reporters: ["clear-text", "json"],
	jsonReporter: { fileName: "reports/mutation/pertest.json" },
};
