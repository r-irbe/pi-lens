export type Verdict =
	| "CAUSED-BY-CHANGE"
	| "RED-ON-BASE"
	| "INCONCLUSIVE"
	| "ALL-GREEN";
export type TestVerdict = {
	id: string;
	verdict: "CAUSED-BY-CHANGE" | "RED-ON-BASE" | "INCONCLUSIVE";
	detail?: string;
};
export const EXIT: {
	OK: 0;
	CAUSED: 1;
	USAGE: 2;
	INCONCLUSIVE: 3;
	BUILD: 4;
};
export const HEAD_GREEN_MESSAGE: string;
export function decideVerdict(runs: {
	head: { failed: string[]; loadErrors?: Record<string, string> }[];
	base: { failed: string[]; loadErrors?: Record<string, string> };
}): { verdict: Verdict; tests: TestVerdict[] };
export function failedTestIds(
	report: {
		testResults?: {
			name: string;
			status?: string;
			assertionResults?: { status: string; fullName: string }[];
		}[];
	},
	cwd: string,
): string[];
export function main(argv?: string[]): Promise<number>;
export function suiteLoadErrors(
	report: {
		testResults?: {
			name: string;
			status?: string;
			message?: string;
			assertionResults?: { status: string }[];
		}[];
	},
	cwd: string,
): Record<string, string>;
