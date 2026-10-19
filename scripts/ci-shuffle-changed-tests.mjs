#!/usr/bin/env node
/**
 * scripts/ci-shuffle-changed-tests.mjs (#4397)
 *
 *   node scripts/ci-shuffle-changed-tests.mjs --base <sha> --head <sha>
 *   node scripts/ci-shuffle-changed-tests.mjs --files <a.test.ts,b.test.ts> [--cwd <dir>]
 *
 * The `Changed test files, alone and shuffled` step of ci.yml's
 * `Targeted tests (advisory)` job. A new test file that depends on order or on
 * a sibling file passes in CI's file order and reds on a reorder or a shard
 * split (#4390: a fake LSP server delayed only after its first pull, an
 * earlier case supplied it; #4391: a new spawn file failed 6 of 14 cases under
 * seed 101). Nothing ran a PR's own tests in another order, so the dependence
 * shipped and a reviewer found it by hand.
 *
 * Scope is bounded to the test files the PR adds or changes
 * (`git diff --name-only <base>...<head>`, the pre-push selector's
 * `changedFiles`), at most MAX_FILES of them. Per set it runs
 *
 *   - the whole set under `--sequence.shuffle` once per fixed seed in SEEDS
 *     (a cross-file dependence only shows when the files run together), and
 *   - every file alone, in file order (a dependence on an UNCHANGED sibling's
 *     side effect only shows when that sibling is absent).
 *
 * It does not run per-test (`-t`) isolation: one vitest start per case costs
 * a start per case. Lane settings are not copied here: the file paths go to
 * the repo's own vitest.config.ts, whose projects route an lsp-spawn-heavy or
 * wall-clock file to its own `maxWorkers` and `groupOrder`.
 *
 * Time budget: BUDGET_MS in all, each vitest start bounded by what is left. A
 * start that does not finish, a file over the cap and an unreadable diff are
 * UNPROVEN (exit 3), never green. So is a start that vitest answers with "No
 * test files found": it ran nothing. Exit codes: 0 clean (or no test file in
 * the diff), 1 an order-dependent file or one that fails alone, 2 usage, 3
 * unproven.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { changedFiles } from "./pre-push-targeted-tests.mjs";

/** Two fixed seeds: every run is reproducible with `--sequence.seed=<seed>`. */
export const SEEDS = Object.freeze([202, 424]);
/** Test files run per PR; the rest are listed as not run. */
export const MAX_FILES = 20;
/** Total wall time. ci.yml's job cap is 15 min and its targeted run ~4 min. */
export const BUDGET_MS = 6 * 60_000;
const OUTPUT_TAIL_LINES = 60;

/**
 * The test files a diff adds or changes that vitest collects: `tests/**\/*.test.ts`
 * minus `tests/fixtures/**` (vitest.config.ts `sharedExclude`), existing on
 * disk (a deleted file is in `git diff --name-only`).
 *
 * @param {string[]} paths
 * @param {(file: string) => boolean} [exists]
 * @returns {string[]} sorted, unique
 */
export function selectChangedTestFiles(paths, exists = existsSync) {
	const picked = new Set();
	for (const raw of paths) {
		const file = raw.split(path.sep).join("/");
		if (!/^tests\/.+\.test\.ts$/.test(file)) continue;
		if (file.startsWith("tests/fixtures/")) continue;
		if (exists(file)) picked.add(file);
	}
	return [...picked].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {string[]} files
 * @param {readonly number[]} [seeds]
 * @returns {Array<{ label: string, files: string[], flags: string[] }>}
 */
export function planRuns(files, seeds = SEEDS) {
	const shuffled = seeds.map((seed) => ({
		label: `shuffle seed ${seed}`,
		files,
		flags: ["--sequence.shuffle", `--sequence.seed=${seed}`],
	}));
	const alone = files.map((file) => ({
		label: `alone ${file}`,
		files: [file],
		flags: [],
	}));
	return [...shuffled, ...alone];
}

/** The line a reader pastes to reproduce one red. */
export function reproCommand(run) {
	return `npx vitest run ${run.files.join(" ")}${run.flags.length > 0 ? ` ${run.flags.join(" ")}` : ""}`;
}

function vitestEntry() {
	const require = createRequire(import.meta.url);
	return path.join(
		path.dirname(require.resolve("vitest/package.json")),
		"vitest.mjs",
	);
}

/**
 * The one process boundary: one `vitest run` start.
 *
 * @param {{ files: string[], flags: string[] }} run
 * @param {{ cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options
 * @returns {{ status: number | null, output: string, timedOut: boolean }}
 */
export function execVitest(run, { cwd, timeoutMs, env = process.env }) {
	const result = spawnSync(
		process.execPath,
		[vitestEntry(), "run", ...run.files, ...run.flags],
		{
			cwd,
			env,
			encoding: "utf8",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL",
	};
}

/**
 * Runs the plan in order and stops starting new runs once the budget is spent.
 *
 * @param {Array<{ label: string, files: string[], flags: string[] }>} plan
 * @param {{
 *   cwd: string,
 *   budgetMs?: number,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function runPlan(plan, options) {
	const {
		cwd,
		budgetMs = BUDGET_MS,
		exec = execVitest,
		now = () => performance.now(),
		log = console.log,
	} = options;
	const started = now();
	/** @type {Array<{ run: (typeof plan)[number], verdict: "ok" | "red" | "timeout" | "uncollected", output: string, ms: number }>} */
	const results = [];
	const notRun = [];
	for (const run of plan) {
		const remaining = budgetMs - (now() - started);
		if (remaining <= 0) {
			notRun.push(run);
			continue;
		}
		const runStarted = now();
		const outcome = exec(run, { cwd, timeoutMs: Math.ceil(remaining) });
		const ms = now() - runStarted;
		let verdict;
		if (outcome.timedOut) verdict = "timeout";
		else if (outcome.status === 0) verdict = "ok";
		else if (/^\s*No test files found/m.test(outcome.output))
			verdict = "uncollected";
		else verdict = "red";
		results.push({ run, verdict, output: outcome.output, ms });
		log(
			`[shuffle-changed] ${run.label}: ${verdict} (${(ms / 1000).toFixed(1)}s)`,
		);
		if (verdict === "red") {
			const tail = outcome.output.split("\n").slice(-OUTPUT_TAIL_LINES);
			log(tail.join("\n"));
			log(`[shuffle-changed] reproduce: ${reproCommand(run)}`);
		}
	}
	return { results, notRun };
}

/**
 * @param {{ files: string[], over: string[], results: ReturnType<typeof runPlan>["results"], notRun: ReturnType<typeof runPlan>["notRun"] }} state
 * @returns {{ code: 0 | 1 | 3, kind: "clean" | "red" | "unproven", lines: string[] }}
 */
export function judge({ files, over, results, notRun }) {
	const red = results.filter((entry) => entry.verdict === "red");
	const timedOut = results.filter((entry) => entry.verdict === "timeout");
	const uncollected = results.filter(
		(entry) => entry.verdict === "uncollected",
	);
	const lines = [];
	for (const entry of red) {
		// An alone start has no order to depend on: the file simply fails.
		const kind = entry.run.label.startsWith("alone ")
			? "fails alone"
			: "order-dependent";
		lines.push(`${kind}: ${entry.run.label} (${reproCommand(entry.run)})`);
	}
	for (const entry of timedOut)
		lines.push(`did not finish in the budget: ${entry.run.label}`);
	for (const entry of uncollected)
		lines.push(`not run (no project collects it): ${entry.run.label}`);
	for (const run of notRun) lines.push(`not run (budget spent): ${run.label}`);
	for (const file of over)
		lines.push(`not run (over ${MAX_FILES} files): ${file}`);
	if (red.length > 0) return { code: 1, kind: "red", lines };
	if (lines.length > 0) return { code: 3, kind: "unproven", lines };
	return {
		code: 0,
		kind: "clean",
		lines: [
			`${files.length} file(s): ${results.length} start(s), none order-dependent`,
		],
	};
}

/** @param {string[]} argv */
export function parseArgs(argv) {
	const options = { base: null, head: null, files: null, cwd: process.cwd() };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[++index];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		if (flag === "--base") options.base = value;
		else if (flag === "--head") options.head = value;
		else if (flag === "--files")
			options.files = value.split(",").filter(Boolean);
		else if (flag === "--cwd") options.cwd = path.resolve(value);
		else throw new Error(`unknown argument ${flag}`);
	}
	if (options.files === null && (!options.base || !options.head))
		throw new Error("--base and --head (or --files) are required");
	for (const sha of [options.base, options.head])
		if (sha !== null && !/^[0-9a-f]{7,64}$/i.test(sha))
			throw new Error(`not a commit sha: ${sha}`);
	return options;
}

/**
 * @param {string[]} argv
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   diff?: (range: string) => string[] | null,
 *   exec?: typeof execVitest,
 *   now?: () => number,
 *   budgetMs?: number,
 *   log?: (line: string) => void,
 * }} [io]
 * @returns {number} exit code
 */
export function run(argv, io = {}) {
	const {
		env = process.env,
		diff = changedFiles,
		exec = execVitest,
		now,
		budgetMs,
		log = console.log,
	} = io;
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
	const finish = (verdict) => {
		const summary = `shuffle-changed: exit ${verdict.code} (${verdict.kind})`;
		for (const line of verdict.lines) log(`[shuffle-changed] ${line}`);
		log(summary);
		if (env.GITHUB_STEP_SUMMARY)
			appendFileSync(
				env.GITHUB_STEP_SUMMARY,
				`### Changed test files, alone and shuffled\n\n${verdict.lines.map((line) => `- ${line}`).join("\n")}\n\n${summary}\n`,
			);
		return verdict.code;
	};
	let paths = options.files;
	if (paths === null) {
		paths = diff(`${options.base}...${options.head}`);
		if (paths === null)
			return finish({
				code: 3,
				kind: "unproven",
				lines: ["the changed-file list is unreadable"],
			});
	}
	const found = selectChangedTestFiles(paths, (file) =>
		existsSync(path.join(options.cwd, file)),
	);
	if (found.length === 0)
		return finish({
			code: 0,
			kind: "clean",
			lines: ["no test file added or changed"],
		});
	const files = found.slice(0, MAX_FILES);
	const over = found.slice(MAX_FILES);
	log(
		`[shuffle-changed] ${files.length} file(s), seeds ${SEEDS.join(", ")}, budget ${BUDGET_MS / 1000}s`,
	);
	const { results, notRun } = runPlan(planRuns(files), {
		cwd: options.cwd,
		budgetMs,
		exec,
		now,
		log,
	});
	return finish(judge({ files, over, results, notRun }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = run(process.argv.slice(2));
