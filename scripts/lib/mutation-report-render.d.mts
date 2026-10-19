export declare function renderMutationMarkdown(
	report: unknown,
	options?: { maxSurvivors?: number },
): string;
export declare function formatTestSelection(selection: {
	pool: number;
	covering: number | null;
	kept: number;
	own?: number;
	unknown?: number;
	overBudget?: number;
	estimatedSeconds?: number | null;
}): string;
