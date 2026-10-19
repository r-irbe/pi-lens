export declare function isBot(login: string, isBotFlag?: boolean): boolean;
export declare function classifyFiles(paths: string[]): string[];
export declare function classifyIssue(issue: {
	title?: string;
	labels?: unknown[];
}): "bug" | "ideas" | null;
export declare function planContributions(input: {
	prs: { number: number; author?: { login: string; is_bot?: boolean } }[];
	issues: {
		number: number;
		title: string;
		author?: { login: string; is_bot?: boolean };
		labels: unknown[];
	}[];
	filesByPr: Record<number, string[]>;
	existing: Record<string, string[]>;
	owner: string;
}): {
	login: string;
	isNew: boolean;
	add: string[];
	evidence: Record<string, number[]>;
}[];
export declare function formatPlan(
	plan: ReturnType<typeof planContributions>,
): string;
export declare function assertNotTruncated<T>(
	list: T[],
	what: string,
	limit?: number,
): T[];
export declare function loadLists(
	run: (args: string[]) => any,
	repo: string,
): { prs: any[]; issues: any[] };
