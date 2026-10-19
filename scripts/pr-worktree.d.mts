// Type declarations for scripts/pr-worktree.mjs (untyped .mjs imported from
// .ts tests). Only the exported seams are declared; the CLI body is not
// importable surface.

export function resolveWorktreesRoot(env?: NodeJS.ProcessEnv): string;

export interface PrWorktreeCliOptions {
	command: string | null;
	target: string | null;
	mode: string | null;
	name: string | null;
	help: boolean;
	errors: string[];
}

export function parseArgs(argv: string[]): PrWorktreeCliOptions;

export function run(options?: {
	argv?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	gitExec?: (args: string[], options?: { cwd?: string }) => string;
	ghExec?: (args: string[], options?: { cwd?: string }) => string;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}): number;

export function main(): void;
