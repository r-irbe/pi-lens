import type { Candidate } from "./lib/stryker-pertest.mjs";

export declare function main(
	argv?: string[],
):
	| { patched: number }
	| { module: string }
	| ReturnType<typeof import("./lib/stryker-pertest.mjs").splitRunnableTests>
	| ReturnType<typeof import("./lib/stryker-pertest.mjs").planPertest>
	| { summary: Record<string, number>; candidates: Candidate[] };
