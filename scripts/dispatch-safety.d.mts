export declare const REPOSITORY_DEFAULT_PERMISSIONS: string;
export declare const WRITE_SCOPES: Set<string>;
export declare function effectivePermissions(
	workflowPermissions: unknown,
	jobPermissions: unknown,
): Record<string, unknown>;
export declare function writeScopes(
	permissions: Record<string, unknown>,
): string[];
export declare function workflowDocument(
	source: string,
): Record<string, unknown>;
export declare function workflowTriggers(on: unknown): string[];
export type DispatchableJob = {
	id: string;
	name: string;
	job: { if?: unknown; steps?: Array<{ if?: unknown }> };
	permissions: Record<string, unknown>;
	writeScopes: string[];
};
export declare function dispatchableJobs(
	source: string,
	workflowPath?: string,
): DispatchableJob[];
export declare function hasWriteToken(job: DispatchableJob): boolean;
export type Guard =
	| { guarded: true; conjunct: unknown }
	| { guarded: false; reason: string };
export declare function guardOf(...conditions: unknown[]): Guard;
export declare function guardSkipsOnRef(
	job: DispatchableJob,
	ref: string,
): boolean;
export declare function parseArgs(
	argv: string[],
): { file: string; ref: string } | { error: string };
export declare function runCli(
	argv: string[],
	cwd?: string,
): { code: number; stdout: string[]; stderr: string[] };
