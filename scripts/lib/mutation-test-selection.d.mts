export type ChangedRanges = Array<[number, number]>;
export declare function coveredChangedLines(
	entry: {
		statementMap?: Record<
			string,
			{ start: { line: number }; end: { line: number } }
		>;
		s?: Record<string, number>;
	},
	ranges: ChangedRanges,
): number;
export declare function coveredChangedLinesInReport(
	coverage: Record<string, object>,
	rangesByFile: Map<string, ChangedRanges>,
	root?: string,
	sourceCounts?: Map<string, number>,
): number;
export declare const INCREMENTAL_FINGERPRINT_PATH: string;
export declare const PROBE_REPORTS_ROOT: string;
export declare function probeReportsDirectory(test: string): string;
export declare function buildCoverageProbeArgs(
	test: string,
	includeFiles: string[],
	reportsDirectory: string,
	options?: { testTimeoutMs?: number },
): string[];
export type TestProbeResult = { lines: number } | { unknown: string };
export declare function probeTestCoverage(
	test: string,
	deps: {
		run: (test: string) => Promise<{
			status: number | null;
			timedOut?: boolean;
			aborted?: boolean;
		}>;
		readCoverage: (test: string) => Record<string, object> | null;
		rangesByFile: Map<string, ChangedRanges>;
		root?: string;
		sourceCounts?: Map<string, number>;
	},
): Promise<TestProbeResult>;
export declare function probeAllTests(
	tests: string[],
	probe: (test: string) => Promise<TestProbeResult>,
	options: { concurrency: number; signal?: AbortSignal },
): Promise<Map<string, number | null>>;
export declare function ownTestFiles(changedPaths: string[]): string[];
export declare function partitionOwnTests(
	changedPaths: string[],
	deps: {
		exists: (file: string) => boolean;
		exclusionOf: (file: string) => { file: string; reason: string } | null;
		alreadyExcluded?: Array<{ file: string }>;
	},
): { own: string[]; excluded: Array<{ file: string; reason: string }> };
export declare function probeConcurrency(cpus: number): number;
export type TestSelection = {
	mode: "coverage" | "import-graph";
	pool: number;
	covering: number | null;
	kept: string[];
	dropped: string[];
	overBudget: string[];
	unmeasured: number;
	estimatedSeconds: number | null;
	own: string[];
	unknown: string[];
};
export declare function selectMutationTests(args: {
	related: string[];
	ownTests?: string[];
	priorities?: Map<string, number>;
	lines: Map<string, number | null> | null;
	maxTests: number;
	activeSources?: string[];
	sourceCoverage?: Map<string, Map<string, number> | null>;
	runtime?: {
		seconds: Map<string, number | null>;
		maxSeconds: number;
		unknownSeconds: number;
		fileOverheadSeconds: number;
	};
}): TestSelection;
export declare function fingerprintPaths(args: {
	changedFiles: string[];
	mutatedFiles: string[];
	keptTests: string[];
}): string[];
export declare function fingerprintEntries(
	entries: Array<[string, string]>,
): string;
export type Fingerprint = { digest: string; inputs: Record<string, string> };
export declare function buildFingerprint(args: {
	forkPoint: string;
	nodeVersion: string;
	read: (file: string) => string;
	changedFiles: string[];
	mutatedFiles: string[];
	keptTests: string[];
}): Fingerprint;
export declare function changedFingerprintInputs(
	previous: Record<string, string>,
	current: Record<string, string>,
): string[];
export declare function serializeFingerprint(fingerprint: Fingerprint): string;
export declare function parseFingerprint(text: string): Fingerprint | null;
export declare function decideIncrementalReuse(args: {
	hasIncrementalFile: boolean;
	previous: string | null;
	current: string;
}): {
	reuse: boolean;
	state: "cold-no-cache" | "cold-inputs-changed" | "warm";
};
export declare function pruneIncrementalReport<
	T extends {
		files: Record<
			string,
			{
				mutants: Array<{
					location: { start: { line: number }; end: { line: number } };
				}>;
			}
		>;
	},
>(report: T, patterns: string[]): T;
export declare function parseIncrementalReuse(
	log: string,
): { reused: number; total: number } | null;
export declare function forkPointOf(
	git: (args: string[]) => string,
	ref: string,
	head: string,
): string;
export declare function parseNameList(output: string): string[];
export declare function runProbeProcess(options: {
	spawnAsync?: (
		command: string,
		args: string[],
		options: Record<string, unknown>,
	) => Promise<{ status: number | null; failure?: string }>;
	command: string;
	args: string[];
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ status: number | null; timedOut: boolean; aborted: boolean }>;
export declare function readProbeCoverage(
	io: {
		exists: (file: string) => boolean;
		read: (file: string) => string;
		remove: (directory: string) => void;
	},
	directory: string,
): Record<string, object> | null;
export declare function readProbeSeconds(
	io: {
		exists: (file: string) => boolean;
		read: (file: string) => string;
	},
	directory: string,
): number | null;
export declare function selectionNotes(
	choice: {
		dropped: string[];
		unknown: string[];
		overBudget?: string[];
		unmeasured?: number;
		estimatedSeconds?: number | null;
	},
	maxTests: number,
	maxSeconds?: number,
): string[];
export declare function planIncrementalAttempt(args: {
	attempt: number;
	decision: { reuse: boolean; state: string; changed?: string[] };
}): { reuse: boolean; meta: { state: string; changed?: string[] } };
export declare function withReuseCount<M extends { state: string }>(
	meta: M,
	log: string,
): M | { state: "warm"; reused: number | null; total: number | null };
