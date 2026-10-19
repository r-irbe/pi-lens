export interface WorkflowTrigger {
	paths?: string[];
	pathsIgnore?: string[];
	types?: string[];
	unparsed?: boolean;
}
export declare function readWorkflowTriggers(
	text: string,
): Map<string, WorkflowTrigger> | null;
export declare function classifyWorkflowEdit(
	text: string,
	file: string,
):
	| { executes: true }
	| { executes: false; reason: string; dispatchable: boolean };
export declare function evaluateWorkflowRunEvidence(input: {
	changedFiles?: readonly string[];
	body?: string;
	readWorkflow: (file: string) => string | null;
	readBaseWorkflow?: (file: string) => string | null;
}): string[];
export declare function isCommentOrWhitespaceOnlyEdit(
	before: string | null | undefined,
	after: string,
): boolean;
