export const HISTORY_MAX_AGE_MS: number;
export const HISTORY_MAX_BYTES: number;
export const METADATA_FILENAME: string;
/** The repo-relative posix id a journal row's `file` carries (#3367). */
export function normalizeTestFile(name: string): string;
/** Streams `file` line by line; no string holds the whole file (#4031). */
export function forEachLine(
	file: string,
	onLine: (line: string) => void,
	chunkBytes?: number,
): void;
export function rowsFromArtifacts(inputs: string[]): Array<{
	headSha: string;
	runId: string;
	file: string;
	outcome: string;
	durationMs: number;
	lane: string;
	/** Absent on artifacts written before #3447. */
	runAttempt?: string;
	recordedAt: string;
}>;
/** The newest ingested `recordedAt` of day lines or a raw journal, or null. */
export function historyWatermark(historyPath: string): string | null;
export function rollupTestHistory(options: {
	artifactPaths: string[];
	/** Day lines (read and rewritten), or a raw journal migrated once (#4030). */
	historyPath: string;
	summaryPath: string;
	now?: number;
	maxBytes?: number;
}): {
	/** Sum of per-file runs: the old raw row count. */
	rowCount: number;
	files: Array<{
		file: string;
		passCount: number;
		failCount: number;
		lastFailHead: string | null;
		meanDurationMs: number;
	}>;
	flakeCandidates: Array<{ file: string; headSha: string }>;
	/** One row per failing (file, head); `flake` when the head also passed it. */
	failures: Array<{ file: string; headSha: string; flake: boolean }>;
	/** Every distinct head in the window (failing or not). */
	heads: string[];
	/** ISO time of this rollup: the history selector's staleness clock. */
	generatedAt: string;
	/** The newest ingested `recordedAt`: the next ingest's watermark. */
	ingestedThrough: string | null;
	dayCount: number;
	/** Bytes of the published day lines. */
	bytes: number;
	ingestedParts: number;
	duplicateParts: number;
	migratedRows: number;
};
export function runCli(argv: string[]): number;
