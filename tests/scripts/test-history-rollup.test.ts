import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonReporter } from "vitest/node";
import {
	HISTORY_MAX_AGE_MS,
	METADATA_FILENAME,
	forEachLine,
	historyWatermark,
	normalizeTestFile,
	rollupTestHistory,
	rowsFromArtifacts,
	runCli,
} from "../../scripts/test-history-rollup.mjs";

const roots: string[] = [];
const validHead = "a".repeat(40);
const repoRoot = path.resolve(import.meta.dirname, "../..");
/**
 * The real `unit-test-results-linux` artifact of CI run 35918869980, downloaded
 * with `gh run download 35918869980 -n unit-test-results-linux` and trimmed to
 * three of its 1,165 result entries (one assertion each). Its two basenames and
 * every field the rollup reads are verbatim.
 */
const realArtifact = path.join(
	repoRoot,
	"tests/fixtures/test-history/run-35918869980",
);

/**
 * Journal rows exactly as the nightly rollup wrote them before #3367: `file`
 * is vitest's absolute runner path. Five real lines of `data/test-history`
 * (`git show origin/data/test-history:history/test-results.ndjson`): three
 * from run 35918869980 (no `runAttempt`, the pre-#3447 shape), one failure
 * from run 36132594277 (no `runAttempt`) and one from run 36168594090
 * (`runAttempt: "1"`). The raw journal is the migration input since #4030,
 * and the parser must keep reading every generation.
 */
const oldShapeJournal = path.join(
	repoRoot,
	"tests/fixtures/test-history/journal-schema-absolute-path/test-results.ndjson",
);

/**
 * The #4030 day-line journal (`history/test-daily.ndjson`), version 1: the
 * five raw rows above migrated by `rollupTestHistory` with `--now
 * 2026-09-26T00:00:00.000Z` and no new part. A later reader must keep
 * parsing it.
 */
const dayLineJournal = path.join(
	repoRoot,
	"tests/fixtures/test-history/daily-schema-v1/test-daily.ndjson",
);

afterEach(() => {
	vi.restoreAllMocks();
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-test-history-"));
	roots.push(root);
	return root;
}

/** Always through the shared basename constant, never a literal. */
function writeMetadata(directory: string, metadata: Record<string, unknown>) {
	fs.writeFileSync(
		path.join(directory, METADATA_FILENAME),
		JSON.stringify(metadata),
	);
}

/** One artifact part: a results file beside its metadata. */
function part(
	root: string,
	name: string,
	metadata: Record<string, unknown>,
	results: Array<Record<string, unknown>>,
) {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	writeMetadata(dir, { lane: "linux", ...metadata });
	fs.writeFileSync(
		path.join(dir, "vitest.json"),
		JSON.stringify({ testResults: results }),
	);
	return dir;
}

function fixture() {
	const root = tempRoot();
	const artifact = part(
		root,
		"artifact",
		{ headSha: validHead, runId: 101, recordedAt: "2026-09-22T00:00:00.000Z" },
		[
			{ name: "tests/flaky.test.ts", status: "failed", duration: 12 },
			{ name: "tests/steady.test.ts", status: "passed", duration: 8 },
		],
	);
	return { root, artifact };
}

type DayLine = {
	day: string;
	lane: string;
	newestRecordedAt: string;
	heads: string[];
	parts: string[];
	tests: Record<
		string,
		{
			runs: number;
			passes: number;
			fails: number;
			skips: number;
			durationMs: number;
			passMask?: string;
			failMask?: string;
		}
	>;
};

function dayLines(file: string): DayLine[] {
	return fs
		.readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as DayLine);
}

/** Runs the exported CLI arm in process and captures its bounded output. */
function cli(args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
	vi.spyOn(console, "error").mockImplementation((line) =>
		err.push(String(line)),
	);
	// The rollup appends to GITHUB_STEP_SUMMARY when it is set; the Unit tests
	// lane sets it, and a test must not write into the job's own summary.
	vi.stubEnv("GITHUB_STEP_SUMMARY", "");
	const exitCode = runCli(args);
	return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("test-history-rollup real entry point", () => {
	it("aggregates one day line per (day, lane) and identifies same-head pass/fail evidence", () => {
		const { root, artifact } = fixture();
		const second = part(
			root,
			"artifact-2",
			{
				headSha: validHead,
				runId: 102,
				recordedAt: "2026-09-22T01:00:00.000Z",
			},
			[{ name: "tests/flaky.test.ts", status: "passed", duration: 10 }],
		);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [artifact, second],
			historyPath: history,
			summaryPath: summary,
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		// Two runs on one head are two observations (#3447): flaky fails in run
		// 101 and passes in 102, and the day aggregate keeps both, plus steady.
		expect(output.rowCount).toBe(3);
		expect(output.flakeCandidates).toEqual([
			{ file: "tests/flaky.test.ts", headSha: validHead },
		]);
		expect(dayLines(history)).toHaveLength(1);
		const [line] = dayLines(history);
		expect(line).toMatchObject({
			day: "2026-09-22",
			lane: "linux",
			newestRecordedAt: "2026-09-22T01:00:00.000Z",
			heads: [validHead],
		});
		expect(line.tests["tests/flaky.test.ts"]).toEqual({
			runs: 2,
			passes: 1,
			fails: 1,
			skips: 0,
			durationMs: 22,
			passMask: "1",
			failMask: "1",
		});
		expect(JSON.parse(fs.readFileSync(summary, "utf8")).files).toEqual(
			expect.arrayContaining([
				{
					file: "tests/flaky.test.ts",
					passCount: 1,
					failCount: 1,
					lastFailHead: validHead,
					meanDurationMs: 11,
				},
			]),
		);
	});

	// #4030: the same artifacts are downloaded again whenever they fall inside
	// the next night's overlap window. Without the part ledger each re-download
	// adds its runs a second time and doubles every count.
	it("keeps a same-head failure and its passing re-run across nightly rollups, counting each part once (#3447, #4030)", () => {
		// CI run 36132594277: attempt 1 of Unit tests failed and the job was
		// re-run under the same run id. Both attempts upload an artifact.
		const root = tempRoot();
		const attempt = (runAttempt: number, status: string, at: string) =>
			part(
				root,
				`attempt-${runAttempt}`,
				{ headSha: validHead, runId: 7, runAttempt, recordedAt: at },
				[{ name: "tests/race.test.ts", status, duration: 5 }],
			);
		const failed = attempt(1, "failed", "2026-09-25T12:12:40.000Z");
		const passed = attempt(2, "passed", "2026-09-25T12:30:00.000Z");
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const now = Date.parse("2026-09-26T11:00:00.000Z");
		const first = rollupTestHistory({
			artifactPaths: [failed, passed],
			historyPath: history,
			summaryPath: summary,
			now,
		});
		expect(first.ingestedParts).toBe(2);
		const journal = fs.readFileSync(history, "utf8");
		// The next night: the same artifacts are downloaded again.
		const nextNight = rollupTestHistory({
			artifactPaths: [failed, passed],
			historyPath: history,
			summaryPath: summary,
			now: now + 24 * 60 * 60 * 1000,
		});
		expect(nextNight.rowCount).toBe(2);
		expect(nextNight.duplicateParts).toBe(2);
		expect(fs.readFileSync(history, "utf8")).toBe(journal);
		expect(nextNight.flakeCandidates).toEqual([
			{ file: "tests/race.test.ts", headSha: validHead },
		]);
		// And once the artifacts have expired, from the journal alone.
		const afterExpiry = rollupTestHistory({
			artifactPaths: [],
			historyPath: history,
			summaryPath: summary,
			now: now + 2 * 24 * 60 * 60 * 1000,
		});
		expect(afterExpiry.flakeCandidates).toEqual([
			{ file: "tests/race.test.ts", headSha: validHead },
		]);
	});

	// #4030: a day aggregate must keep the #3215 rule whole across days. A
	// passing run on one night and a failing re-run of the same head a night
	// later are still one flaky head, whichever came first.
	it("marks a head flaky when its pass and its failure land on different days, in either order", () => {
		const root = tempRoot();
		const otherHead = "c".repeat(40);
		const parts = [
			part(
				root,
				"pass-day-1",
				{
					headSha: validHead,
					runId: 1,
					recordedAt: "2026-09-20T23:00:00.000Z",
				},
				[{ name: "tests/a.test.ts", status: "passed", duration: 1 }],
			),
			part(
				root,
				"fail-day-2",
				{
					headSha: validHead,
					runId: 2,
					recordedAt: "2026-09-21T01:00:00.000Z",
				},
				[
					{ name: "tests/a.test.ts", status: "failed", duration: 1 },
					{ name: "tests/b.test.ts", status: "failed", duration: 1 },
				],
			),
			part(
				root,
				"pass-day-3",
				{
					headSha: validHead,
					runId: 3,
					recordedAt: "2026-09-22T01:00:00.000Z",
				},
				[{ name: "tests/b.test.ts", status: "passed", duration: 1 }],
			),
			part(
				root,
				"other-head",
				{
					headSha: otherHead,
					runId: 4,
					recordedAt: "2026-09-22T02:00:00.000Z",
				},
				[{ name: "tests/a.test.ts", status: "failed", duration: 1 }],
			),
		];
		const output = rollupTestHistory({
			artifactPaths: parts,
			historyPath: path.join(root, "history.ndjson"),
			summaryPath: path.join(root, "summary.json"),
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		expect(output.dayCount).toBe(3);
		expect(output.failures).toEqual([
			{ file: "tests/a.test.ts", headSha: validHead, flake: true },
			{ file: "tests/a.test.ts", headSha: otherHead, flake: false },
			{ file: "tests/b.test.ts", headSha: validHead, flake: true },
		]);
		expect(
			output.files.find((file) => file.file === "tests/a.test.ts"),
		).toMatchObject({ lastFailHead: otherHead, failCount: 2, passCount: 1 });
	});

	// #4030 F3: the summary was built from the pre-eviction set while the
	// journal was not, so the two disagreed on what history existed. Retention
	// now drops whole days, and every view comes from the days that are kept.
	it("drops whole days past 90 days and derives the summary from the days it keeps", () => {
		const root = tempRoot();
		const now = Date.parse("2026-12-31T12:00:00.000Z");
		const cutoffDay = new Date(now - HISTORY_MAX_AGE_MS)
			.toISOString()
			.slice(0, 10);
		const expiredHead = "d".repeat(40);
		const keptHead = "e".repeat(40);
		const expired = part(
			root,
			"expired",
			{
				headSha: expiredHead,
				runId: 1,
				recordedAt: new Date(
					now - HISTORY_MAX_AGE_MS - 86_400_000,
				).toISOString(),
			},
			[{ name: "tests/old.test.ts", status: "failed", duration: 1 }],
		);
		const kept = part(
			root,
			"kept",
			{ headSha: keptHead, runId: 2, recordedAt: `${cutoffDay}T00:00:01.000Z` },
			[{ name: "tests/new.test.ts", status: "passed", duration: 1 }],
		);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [expired, kept],
			historyPath: history,
			summaryPath: summary,
			now,
		});
		expect(dayLines(history).map((line) => line.day)).toEqual([cutoffDay]);
		const written = JSON.parse(fs.readFileSync(summary, "utf8"));
		expect(written.heads).toEqual([keptHead]);
		// The expired day's failure left with its day.
		expect(
			written.failures.some(
				(failure: { headSha: string }) => failure.headSha === expiredHead,
			),
		).toBe(false);
		expect(written.rowCount).toBe(1);
		expect(written.files.map((file: { file: string }) => file.file)).toEqual([
			"tests/new.test.ts",
		]);
		expect(output.dayCount).toBe(1);
	});

	// #4030 F3: the old byte cap evicted the oldest rows and split a run (1170
	// rows cut to 449). A journal over the bound now refuses to publish: the
	// nightly goes red and the notifier files it, and nothing is evicted.
	it("refuses a journal over its byte bound and writes nothing", () => {
		const { root, artifact } = fixture();
		const history = path.join(root, "history.ndjson");
		fs.copyFileSync(oldShapeJournal, history);
		const before = fs.readFileSync(history, "utf8");
		const summary = path.join(root, "summary.json");
		expect(() =>
			rollupTestHistory({
				artifactPaths: [artifact],
				historyPath: history,
				summaryPath: summary,
				now: Date.parse("2026-09-30T00:00:00.000Z"),
				maxBytes: 400,
			}),
		).toThrow(/over the 400-byte bound; refusing to publish/);
		expect(fs.readFileSync(history, "utf8")).toBe(before);
		expect(fs.existsSync(summary)).toBe(false);
	});

	it("prints the watermark of day lines, of a raw journal, and of no journal", () => {
		const root = tempRoot();
		expect(historyWatermark(oldShapeJournal)).toBe("2026-09-25T17:55:05.062Z");
		expect(historyWatermark(dayLineJournal)).toBe("2026-09-25T17:55:05.062Z");
		expect(historyWatermark(path.join(root, "absent.ndjson"))).toBeNull();
		const printed = cli(["--print-watermark", "--history", dayLineJournal]);
		expect(printed).toEqual({
			exitCode: 0,
			stdout: "2026-09-25T17:55:05.062Z",
			stderr: "",
		});
		expect(
			cli(["--print-watermark", "--history", path.join(root, "absent")]).stdout,
		).toBe("");
	});

	it("fails bounded on a malformed day line", () => {
		const root = tempRoot();
		const history = path.join(root, "history.ndjson");
		fs.writeFileSync(
			history,
			`${JSON.stringify({ day: "2026-09-22", lane: "linux", heads: [], parts: [], tests: { "tests/x.test.ts": { runs: "1" } } })}\n`,
		);
		const result = cli(["--print-watermark", "--history", history]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			"malformed test entry tests/x.test.ts at history line 1",
		);
	});

	// Round 3 F8: the producer uploaded `test-history-metadata.json` while the
	// consumer looked for a sibling `metadata.json`, so the rollup exited 2 on
	// every real artifact and lane 1 never wrote a row. This runs the real CLI
	// over the real downloaded artifact layout, so the two basenames cannot
	// drift apart again without a red here.
	it("rolls up the real run-35918869980 artifact layout into a day line", () => {
		const root = tempRoot();
		const artifacts = path.join(root, "artifacts", "3801234567");
		fs.mkdirSync(artifacts, { recursive: true });
		for (const name of fs.readdirSync(realArtifact))
			fs.copyFileSync(
				path.join(realArtifact, name),
				path.join(artifacts, name),
			);
		expect(fs.readdirSync(artifacts).sort()).toEqual([
			METADATA_FILENAME,
			"vitest-results.json",
		]);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const result = cli([
			"--artifact-dir",
			path.join(root, "artifacts"),
			"--history",
			history,
			"--summary",
			summary,
			"--now",
			"2026-09-24T00:00:00.000Z",
		]);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("test-history: 3 rows, 3 files");
		expect(result.stdout).toContain(
			"test-history ingest: 1 new part(s), 0 already ingested, 0 raw row(s) migrated; 1 day(s)",
		);
		const [line] = dayLines(history);
		// The real metadata's identity, verbatim from the downloaded artifact.
		expect(line).toMatchObject({
			day: "2026-09-23",
			lane: "linux",
			newestRecordedAt: "2026-09-23T21:10:42.273Z",
			heads: ["a5a44be4f846291cd8bf470c8a69973579958fd6"],
			// No `runAttempt` in this pre-#3447 metadata; the part is keyed by
			// its smallest repo-relative file.
			parts: ["35918869980//tests/config/test-history-workflow.test.ts"],
		});
		// Real vitest names a file by its absolute runner path; the journal keys
		// it repo-relative (#3367). Every entry in that run passed. `durationMs`
		// comes from endTime - startTime, because real per-file entries carry no
		// `duration` field.
		expect(Object.keys(line.tests).sort()).toEqual([
			"tests/config/test-history-workflow.test.ts",
			"tests/real-harness/child-exit.test.ts",
			"tests/scripts/test-history-rollup.test.ts",
		]);
		expect(line.tests["tests/real-harness/child-exit.test.ts"]).toMatchObject({
			runs: 1,
			passes: 1,
			fails: 0,
			passMask: "1",
		});
		expect(
			Object.values(line.tests).every((entry) => entry.durationMs > 0),
		).toBe(true);
	});

	// Round 3 F8, the other direction: a results file with no metadata beside it
	// must stay a bounded failure rather than silently inventing an identity.
	it("fails bounded when the metadata basename is absent", () => {
		const root = tempRoot();
		const artifact = path.join(root, "artifact");
		fs.mkdirSync(artifact);
		fs.copyFileSync(
			path.join(realArtifact, "vitest-results.json"),
			path.join(artifact, "vitest-results.json"),
		);
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	it("rejects malformed metadata head SHAs with the CLI's bounded error exit", () => {
		const { root, artifact } = fixture();
		writeMetadata(artifact, {
			headSha: "x",
			runId: 101,
			lane: "linux",
			recordedAt: "2026-09-22T00:00:00.000Z",
		});
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	// Round 3 F7: `/^[0-9a-f]{40}$/i` accepted an uppercase 40-hex head and
	// persisted it. Git never emits one, and an uppercase twin would key as a
	// second head for the same commit, splitting same-head flake evidence.
	it("rejects an uppercase 40-hex head SHA", () => {
		const { root, artifact } = fixture();
		writeMetadata(artifact, {
			headSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
			runId: 101,
			lane: "linux",
			recordedAt: "2026-09-22T00:00:00.000Z",
		});
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	// Round 3 F7, the reader side: an uppercase head already on the data branch
	// must not be carried forward either, in a raw row or in a day line.
	it("refuses to read an uppercase head SHA out of existing history", () => {
		const { root, artifact } = fixture();
		const history = path.join(root, "history.ndjson");
		const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
		for (const line of [
			{
				headSha: upper,
				runId: "1",
				file: "old.test.ts",
				outcome: "passed",
				durationMs: 1,
				lane: "linux",
				recordedAt: "2026-09-22T00:00:00.000Z",
			},
			{
				day: "2026-09-22",
				lane: "linux",
				heads: [upper],
				parts: [],
				tests: {},
			},
		]) {
			fs.writeFileSync(history, `${JSON.stringify(line)}\n`);
			const result = cli([
				"--artifact-dir",
				artifact,
				"--history",
				history,
				"--summary",
				path.join(root, "summary.json"),
			]);
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		}
	});
});

/**
 * #4031: the raw journal reached 104 MB in seven days, and one whole-file
 * string passes Node's string limit (0x1fffffe8 characters) near 512 MiB:
 * the pre-#4030 read failed with "Cannot create a string longer than
 * 0x1fffffe8 characters" on a 625 MB journal (PR #4037 body). The migration
 * reads line by line, so a line split across two reads must come out whole.
 */
describe("streamed journal read (#4031)", () => {
	it("yields every line whole across chunk boundaries, multi-byte text and CRLF", () => {
		const root = tempRoot();
		const file = path.join(root, "lines.ndjson");
		const lines = ['{"a":"πλέγμα"}', "", '{"b":2}', '{"c":"✓✓✓"}'];
		fs.writeFileSync(
			file,
			`${lines[0]}\r\n${lines[1]}\n${lines[2]}\n${lines[3]}`,
		);
		for (const chunkBytes of [1, 3, 7, 1 << 20]) {
			const seen: string[] = [];
			forEachLine(file, (line) => seen.push(line), chunkBytes);
			expect(seen).toEqual([lines[0], lines[2], lines[3]]);
		}
	});
});

/**
 * Round 3 F9 replacement for a `spawnSync("npm test")` pair. The additive
 * console line and the artifact schema both belong to the installed vitest
 * (5.0.0), whose `JsonReporter` is a public `vitest/node` export — so the
 * contract is pinned by driving that real upstream class in process, at a true
 * library boundary, instead of admitting two real child processes to the
 * flake-shape ratchet. The reporter is upstream code, not a double of our
 * assumption about it.
 */
describe("vitest JsonReporter contract the CI producer relies on", () => {
	it("emits exactly one JSON-report line and a schema rowsFromArtifacts reads", async () => {
		const root = tempRoot();
		const outputFile = path.join(root, "vitest-results.json");
		const logged: string[] = [];
		const reporter = new JsonReporter({ outputFile });
		reporter.onInit({
			logger: {
				log: (line: unknown) => logged.push(String(line)),
				warn: (line: unknown) => logged.push(`warn: ${String(line)}`),
			},
			config: { root, passWithNoTests: true },
			snapshot: { summary: {} },
		} as unknown as Parameters<JsonReporter["onInit"]>[0]);
		const test = {
			type: "test",
			name: "keeps one row per file",
			mode: "run",
			meta: {},
			tags: [],
			result: { state: "pass", duration: 7, startTime: 1_000 },
		};
		const fileTask = {
			type: "suite",
			name: "probe.test.ts",
			filepath: "/home/runner/work/pi-lens/pi-lens/tests/probe.test.ts",
			mode: "run",
			result: { state: "pass" },
			tasks: [test],
		};
		await reporter.onTestRunEnd([{ task: fileTask }] as unknown as Parameters<
			JsonReporter["onTestRunEnd"]
		>[0]);

		// The exact additive console contract the `Run tests` step accepts: one
		// line, that text, the resolved output path — and nothing else.
		expect(logged).toEqual([`JSON report written to ${outputFile}`]);

		// The same file the producer uploads, consumed by the real rollup seam.
		writeMetadata(root, {
			headSha: validHead,
			runId: "7",
			lane: "linux",
			recordedAt: "2026-09-23T00:00:00.000Z",
		});
		expect(rowsFromArtifacts([root])).toEqual([
			{
				headSha: validHead,
				runId: "7",
				file: "tests/probe.test.ts",
				outcome: "passed",
				durationMs: 7,
				lane: "linux",
				recordedAt: "2026-09-23T00:00:00.000Z",
			},
		]);
	});
});

/**
 * #3367. The journal key's `file` was vitest's absolute runner path, so the
 * same logical test under another root (a local worktree, a Windows lane, a
 * moved runner workspace) keyed as a second test and split its history. The
 * identity is one repo-relative posix path, derived at both entrances of the
 * rollup (a new artifact, and a raw row read for the #4030 migration).
 *
 * Writers by axis: the only writer of the journal is the nightly rollup's
 * publish step (`tool-smoke.yml`, schedule or master only, #4030 F1), fed by
 * `ci.yml`'s per-shard artifacts (linux today); a future second OS lane is a
 * second producer under another root. Readers: the rollup itself and the
 * lane-3 selector (through `summary.json`); `gen-test-shard-weights` reads
 * artifacts through `rowsFromArtifacts`.
 */
describe("journal identity is the repo-relative path (#3367)", () => {
	it("derives one posix repo-relative id from every runner path spelling", () => {
		expect(
			normalizeTestFile("/home/runner/work/pi-lens/pi-lens/tests/a/b.test.ts"),
		).toBe("tests/a/b.test.ts");
		expect(normalizeTestFile("C:\\work\\pi-lens\\tests\\a\\b.test.ts")).toBe(
			"tests/a/b.test.ts",
		);
		// A checkout whose own root holds a `tests` directory: the repo-relative
		// path starts at the LAST `/tests/`, because test files never nest one.
		expect(normalizeTestFile("/srv/tests/pi-lens/tests/a/b.test.ts")).toBe(
			"tests/a/b.test.ts",
		);
		// Already relative (a local run, the unit fixtures): untouched.
		expect(normalizeTestFile("tests/a/b.test.ts")).toBe("tests/a/b.test.ts");
		expect(normalizeTestFile("./tests/a/b.test.ts")).toBe("tests/a/b.test.ts");
		// No `tests/` anchor: kept verbatim (posix), never dropped from the journal.
		expect(normalizeTestFile("/elsewhere/not-a-test.ts")).toBe(
			"/elsewhere/not-a-test.ts",
		);
	});

	it("collapses one test observed under two roots into one journal entry", () => {
		// Recurrence: lane 3 ranks flakes per file; a second lane with another
		// root would have split every history into two files.
		const root = tempRoot();
		const observe = (name: string, testPath: string) =>
			part(
				root,
				name,
				{
					headSha: validHead,
					runId: 55,
					runAttempt: 1,
					recordedAt: "2026-09-26T00:00:00.000Z",
				},
				[{ name: testPath, status: "passed", duration: 4 }],
			);
		const runner = observe(
			"runner",
			"/home/runner/work/pi-lens/pi-lens/tests/x.test.ts",
		);
		const other = observe("other", "C:\\actions\\pi-lens\\tests\\x.test.ts");
		const history = path.join(root, "history.ndjson");
		const output = rollupTestHistory({
			artifactPaths: [runner, other],
			historyPath: history,
			summaryPath: path.join(root, "summary.json"),
			now: Date.parse("2026-09-27T00:00:00.000Z"),
		});
		expect(output.rowCount).toBe(1);
		expect(dayLines(history).map((line) => Object.keys(line.tests))).toEqual([
			["tests/x.test.ts"],
		]);
	});

	// #4030 migration: the raw journal is read once, folded into day lines, and
	// a run it already holds is not ingested again from a re-downloaded
	// artifact (the first nights' overlap re-lists runs the raw journal has).
	it("migrates the old absolute-path raw journal into day lines once, and skips a run it already holds", () => {
		const root = tempRoot();
		const history = path.join(root, "history.ndjson");
		fs.copyFileSync(oldShapeJournal, history);
		const artifacts = path.join(root, "artifacts", "3801234567");
		fs.mkdirSync(artifacts, { recursive: true });
		for (const name of fs.readdirSync(realArtifact))
			fs.copyFileSync(
				path.join(realArtifact, name),
				path.join(artifacts, name),
			);
		const summary = path.join(root, "summary.json");
		const args = [
			"--artifact-dir",
			path.join(root, "artifacts"),
			"--history",
			history,
			"--summary",
			summary,
			"--now",
			"2026-09-26T00:00:00.000Z",
		];
		const first = cli(args);
		expect(first.exitCode).toBe(0);
		// The artifact re-observes the three run-35918869980 rows the raw journal
		// already holds under their absolute paths: 5 rows, not 8.
		expect(first.stdout).toContain(
			"test-history ingest: 0 new part(s), 1 already ingested, 5 raw row(s) migrated; 2 day(s)",
		);
		const migrated = fs.readFileSync(history, "utf8");
		expect(migrated).toBe(fs.readFileSync(dayLineJournal, "utf8"));
		const written = JSON.parse(fs.readFileSync(summary, "utf8"));
		expect(written.rowCount).toBe(5);
		expect(written.files.map((file: { file: string }) => file.file)).toEqual([
			"tests/clients/instance-registry-race.test.ts",
			"tests/config/test-history-workflow.test.ts",
			"tests/real-harness/child-exit.test.ts",
			"tests/scripts/ci-verdict.test.ts",
			"tests/scripts/test-history-rollup.test.ts",
		]);
		// The raw rows' identities survive the migration: two failing heads, no
		// pass on either, and every head in the window.
		expect(written.failures).toEqual([
			{
				file: "tests/clients/instance-registry-race.test.ts",
				headSha: "6c83c09e092fff64e76f6dff9bc0578ad6cd0c86",
				flake: false,
			},
			{
				file: "tests/scripts/ci-verdict.test.ts",
				headSha: "ddb07b23e74e8522dd155604538d1dc32da6d3d8",
				flake: false,
			},
		]);
		expect(written.heads).toEqual([
			"6c83c09e092fff64e76f6dff9bc0578ad6cd0c86",
			"a5a44be4f846291cd8bf470c8a69973579958fd6",
			"ddb07b23e74e8522dd155604538d1dc32da6d3d8",
		]);
		expect(written.ingestedThrough).toBe("2026-09-25T17:55:05.062Z");
		// A second night over the same artifact and the migrated journal: no
		// byte of the journal moves.
		expect(cli(args).exitCode).toBe(0);
		expect(fs.readFileSync(history, "utf8")).toBe(migrated);
	});

	it("derives flake candidates across a migrated raw row and a new artifact part", () => {
		// Recurrence: a failure stored under the absolute path and its passing
		// re-run stored under the relative one are one test; the flake list must
		// see both observations on the head.
		const root = tempRoot();
		const history = path.join(root, "history.ndjson");
		fs.writeFileSync(
			history,
			`${JSON.stringify({ headSha: validHead, runId: "9", file: "/home/runner/work/pi-lens/pi-lens/tests/race.test.ts", outcome: "failed", durationMs: 3, lane: "linux", runAttempt: "1", recordedAt: "2026-09-25T00:00:00.000Z" })}\n`,
		);
		const retry = part(
			root,
			"retry",
			{
				headSha: validHead,
				runId: 9,
				runAttempt: 2,
				recordedAt: "2026-09-25T01:00:00.000Z",
			},
			[{ name: "tests/race.test.ts", status: "passed", duration: 3 }],
		);
		const output = rollupTestHistory({
			artifactPaths: [retry],
			historyPath: history,
			summaryPath: path.join(root, "summary.json"),
			now: Date.parse("2026-09-26T00:00:00.000Z"),
		});
		// Attempt 2 is a new part of run 9: only attempt 1 was migrated whole.
		expect(output.ingestedParts).toBe(1);
		expect(output.flakeCandidates).toEqual([
			{ file: "tests/race.test.ts", headSha: validHead },
		]);
	});
});

/**
 * #3215 lane 3 consumes the summary, not the journal: the rollup owns the
 * flake rule, so it publishes one `failures` row per (file, head) with the
 * flake mark, and the selector asks that view instead of re-deriving the rule.
 */
describe("summary failures view for the history selector (#3215 lane 3)", () => {
	it("lists each failing (file, head) with its flake mark and stamps the generation time", () => {
		const { root, artifact } = fixture();
		const second = part(
			root,
			"artifact-2",
			{
				headSha: validHead,
				runId: 102,
				recordedAt: "2026-09-22T01:00:00.000Z",
			},
			[{ name: "tests/flaky.test.ts", status: "passed", duration: 10 }],
		);
		// A second head where `solid` fails and never passes: a real failure.
		const otherHead = "b".repeat(40);
		const third = part(
			root,
			"artifact-3",
			{
				headSha: otherHead,
				runId: 103,
				recordedAt: "2026-09-22T02:00:00.000Z",
			},
			[{ name: "tests/solid.test.ts", status: "failed", duration: 2 }],
		);
		const summaryPath = path.join(root, "summary.json");
		const now = Date.parse("2026-09-23T00:00:00.000Z");
		rollupTestHistory({
			artifactPaths: [artifact, second, third],
			historyPath: path.join(root, "history.ndjson"),
			summaryPath,
			now,
		});
		const written = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
		expect(written.failures).toEqual([
			{ file: "tests/flaky.test.ts", headSha: validHead, flake: true },
			{ file: "tests/solid.test.ts", headSha: otherHead, flake: false },
		]);
		expect(written.generatedAt).toBe("2026-09-23T00:00:00.000Z");
		// Every head in the window, failing or not: the selector's hub population.
		expect(written.heads).toEqual([validHead, otherHead].sort());
		// The flake list is the flagged subset of the same view, one derivation.
		expect(written.flakeCandidates).toEqual([
			{ file: "tests/flaky.test.ts", headSha: validHead },
		]);
		expect(written.ingestedThrough).toBe("2026-09-22T02:00:00.000Z");
	});
});
