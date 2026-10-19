export declare function addedChangelogFragments(options: {
	base?: string;
	head?: string;
	cwd: string;
	git?: (
		args: string[],
		options: { cwd: string; encoding: "utf8" },
	) => string | Buffer;
	mergeRef?: boolean;
}): string[] | null;

export declare function checkChangelogFragments(options: {
	base?: string;
	head?: string;
	cwd: string;
	git?: (
		args: string[],
		options: { cwd: string; encoding: "utf8" },
	) => string | Buffer;
	mergeRef?: boolean;
}): { valid: boolean; fragments: string[] | null; message: string };
