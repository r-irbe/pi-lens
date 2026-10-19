export declare const GOVERNANCE_TEST_PREFIX: string;
export declare function isGovernanceTest(file: string): boolean;
export declare function planPertest(
	moduleFile: string,
	options?: {
		testFiles?: string[];
		readFile?: (file: string) => string;
		exclusions?: Record<string, { reason?: string }>;
	},
): {
	module: string;
	target: string;
	tests: string[];
	excluded: Array<{ file: string; reason: string }>;
};
export declare const MAX_ROTATION_MODULE_LINES: number;
export declare function eligibleModules(
	moduleFiles: string[],
	options: {
		testFiles: string[];
		lineCount?: (file: string) => number;
		maxLines?: number;
		readFile?: (file: string) => string;
	},
): string[];
export declare function pickModule(eligible: string[], index: number): string;
export declare function splitRunnableTests(
	tests: string[],
	vitestJson: {
		testResults: Array<{
			name: string;
			status: string;
			message?: string;
			assertionResults: Array<{ title: string; status: string }>;
		}>;
	},
	root: string,
): {
	kept: string[];
	dropped: Array<{ file: string; failures: string[] }>;
};
export declare function patchVitestRunner(runnerDir: string): {
	patched: number;
};
export type ReportMutant = {
	id: string;
	status: string;
	coveredBy?: string[];
	killedBy?: string[];
	static?: boolean;
};
export type MutationReport = {
	files: Record<string, { mutants: ReportMutant[] }>;
	testFiles?: Record<string, { tests: Array<{ id: string; name: string }> }>;
};
export type Candidate = {
	id: string;
	file: string;
	name: string;
	code: "covers-no-mutant" | "redundant" | "observes-nothing";
	reason: string;
	covers: number;
	kills: number;
	survivedCovered: number;
	killedByOthers: number;
	own: boolean;
};
export declare function isOwnTest(
	testFile: string,
	moduleFile: string,
): boolean;
export declare function findWorthlessTests(
	report: MutationReport,
	moduleFile?: string,
): Candidate[];
export declare function summarizeReport(
	report: MutationReport,
): { total: number } & Record<string, number>;
export declare function renderCandidates(
	candidates: Candidate[],
	summary: Record<string, number>,
	meta?: { module?: string },
): string;
