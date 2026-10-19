export declare function stripAnsi(text: string): string;
export declare function stripLineTimestamps(text: string): string;
export declare function normalizeVitestOutput(text: string): string;
/** A count is `null` when the transcript does not print it. */
export interface VitestSummary {
	noTests: boolean;
	testsFailed: number | null;
	testsPassed: number | null;
	testsSkipped: number | null;
	failedTestsHeader: number | null;
	suitesFailed: number | null;
	filesFailed: number | null;
	unhandledErrors: number | null;
	failureIds: string[];
	failedFiles: string[];
}
export declare function parseVitestSummary(output: string): VitestSummary;
