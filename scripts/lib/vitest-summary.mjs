// The one reader of Vitest console output (#4087). Every script that parses a
// Vitest transcript (pre-push counts, lane-check, mutate, ci-test-diff, the
// Windows failure count, ci-verdict's red-row label, the CI classifier) asks
// `parseVitestSummary`, so ANSI colour, Actions timestamps and CRLF are
// removed in exactly one place. CI runs Vitest with colour: escape codes split
// `Tests` from its counts and `FAIL` from its file, which read as "no tests"
// or "no red" (#4074, #4075, #4079, #4087). Test any new caller with
// FORCE_COLOR=1 output (AGENTS.md shape 63).
//
// Pure: no GitHub, git or process access, so a script that only reads a
// transcript does not become a workflow writer by importing it.

/** Strips the ANSI color/cursor codes vitest's reporter and GitHub Actions
 * both wrap every line in. Every pattern below matches against the stripped
 * text -- matching raw escape-coded text is what makes log heuristics
 * brittle across reporter versions. */
// Every CSI sequence (colour, cursor), not only `m`: `scripts/ci-verdict.mjs`
// reads job logs through this same helper (#3700).
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) is the literal ANSI escape-sequence lead byte this pattern strips, not accidental input.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text) {
	return text.replace(ANSI_PATTERN, "");
}

/**
 * Strips the GitHub Actions per-line ISO-8601 timestamp prefix (real log,
 * every line): "2026-08-26T00:09:00.9329487Z  FAIL ...". Every job log
 * fetched from the real API is prefixed this way on EVERY line -- discovered
 * the hard way in review round 2 (V4): a `^\s*` line-start anchor added to
 * fix a different false-positive (BARE_FAIL_LINE matching "FAIL" inside a
 * passing test's own title) broke on the very real fixtures it was meant to
 * keep working, because "FAIL" is never actually the first character on a
 * real log line -- the timestamp is. Applied before any anchored pattern
 * below, so "line start" means "start of content", not "start of the raw
 * line".
 */
const LINE_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z ?/gm;
export function stripLineTimestamps(text) {
	return text.replace(LINE_TIMESTAMP_PREFIX, "");
}

const VITEST_TEST_FILE = /\S+\.(?:test|spec)\.[cm]?[jt]sx?/;

/** Extract Vitest failure-banner identities from an already-normalized log. */
function extractVitestFailureIds(log) {
	const ids = new Set();
	for (const rawLine of log.split("\n")) {
		const line = rawLine.match(/^\s*FAIL\b\s+(.*)$/)?.[1];
		if (!line) continue;
		const fileMatch = line.match(VITEST_TEST_FILE);
		if (!fileMatch) continue;
		const file = fileMatch[0];
		const prefix = line.slice(0, fileMatch.index).trim();
		const project = prefix
			? prefix
					.split(/\s+/)
					.at(-1)
					.replace(/^\|+|\|+$/g, "")
			: "";
		const suffix = line.slice(fileMatch.index + file.length);
		const testName = suffix.match(/^\s*>\s*(.+?)\s*$/)?.[1];
		const id = `${project ? `${project}::` : ""}${file}${testName ? ` › ${testName.replace(/\s+/g, " ")}` : ""}`;
		ids.add(id);
	}
	return [...ids].sort();
}

// A structural summary line: `Tests` followed by a count and a word (or
// `no tests`), never prose. Vitest prints its summary last, so the LAST such
// line is the run's own; an earlier one is a nested transcript a failing
// assertion quoted (this repo's mutate and pre-push tests do), and prose such
// as `Tests are great` is not a summary at all.
const VITEST_TESTS_LINE =
	/^[ \t]*Tests[ \t]+((?:\d+[ \t]+[a-z]+|no tests).*)$/gm;
const VITEST_FILES_LINE = /^[ \t]*Test Files[ \t]+(\d+[ \t]+[a-z]+.*)$/gm;
// A reporter line naming a failing test FILE: `FAIL <project> <file> > name`
// or the inline `❯ <project> <file> (N tests | M failed)`. A stack frame
// `❯ <file>:5:35` ends in `:line`, which the trailing `\s|\(` rejects.
const VITEST_FAILED_FILE_LINE =
	/^\s*(?:❯|FAIL)\s+(?:\S+\s+)?(\S+?\.test\.tsx?)(?:\s|\()/gm;

/** A Vitest transcript with ANSI, Actions timestamps and CRLF removed. */
export function normalizeVitestOutput(text) {
	return stripLineTimestamps(stripAnsi(text)).replace(/\r\n?/g, "\n");
}

/**
 * Counts and failure identities of one Vitest transcript. A count is `null`
 * when the transcript does not print it (the reporter omits a zero), so a
 * caller can tell "0" from "no summary".
 *
 * @param {string} output raw console output, coloured or not
 */
export function parseVitestSummary(output) {
	const text = normalizeVitestOutput(String(output));
	const lastLine = (pattern) => [...text.matchAll(pattern)].at(-1)?.[1] ?? "";
	const testsLine = lastLine(VITEST_TESTS_LINE);
	const filesLine = lastLine(VITEST_FILES_LINE);
	const count = (source, pattern) => {
		const value = source.match(pattern)?.[1];
		return value === undefined ? null : Number(value);
	};
	const inLine = (line, word) =>
		count(line, new RegExp(`(\\d+)\\s+${word}\\b`));
	return {
		noTests: /^(?:no tests|0 tests)\b/.test(testsLine),
		testsFailed: inLine(testsLine, "failed"),
		testsPassed: inLine(testsLine, "passed"),
		testsSkipped: inLine(testsLine, "skipped"),
		failedTestsHeader: count(text, /\bFailed Tests\s+(\d+)\b/i),
		suitesFailed: count(text, /\bFailed Suites\s+(\d+)\b/i),
		filesFailed: inLine(filesLine, "failed"),
		unhandledErrors: count(text, /\bErrors\s+(\d+)\s+error(?:s)?\b/i),
		failureIds: extractVitestFailureIds(text),
		failedFiles: [
			...new Set(
				[...text.matchAll(VITEST_FAILED_FILE_LINE)].map((match) => match[1]),
			),
		],
	};
}
