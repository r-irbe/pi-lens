export interface ActionPin {
	action: string;
	sha: string;
	tag: string;
	file: string;
	line: number;
}

export interface MatchingTag {
	tag: string;
	sha: string;
}

export function parseActionPins(text: string, file?: string): ActionPin[];
export function validatePins(
	pins: ActionPin[],
	resolveTag: (action: string, tag: string) => Promise<string | MatchingTag[]>,
	exemptions?: Record<string, string>,
): Promise<string[]>;
export function resolveGithubTag(
	action: string,
	tag: string,
	fetchImpl?: typeof fetch,
	env?: NodeJS.ProcessEnv,
): Promise<string | undefined>;
export function resolveGithubMatchingTags(
	action: string,
	prefix: string,
	fetchImpl?: typeof fetch,
	env?: NodeJS.ProcessEnv,
): Promise<MatchingTag[]>;
export function workflowFiles(root?: string): Promise<string[]>;
export function checkActionPins(options?: {
	root?: string;
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}): Promise<string[]>;
export function main(): Promise<void>;
