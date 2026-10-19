export declare const SOURCES: readonly [
	"issue",
	"fallback-no-issue",
	"fallback-bad-sha",
];
export declare function markerOf(sha: string): string;
export declare function parseLastReportSha(
	issues: Array<{ title: string; body?: string }>,
	title: string,
): string | null;
export declare function pickBase(options: {
	issues: Array<{ title: string; body?: string }>;
	title: string;
	isAncestor: (sha: string) => boolean;
	fallbackBase: () => string;
}): { base: string; source: (typeof SOURCES)[number] };
export declare const MAX_PENDING: number;
export declare const MAX_BASE_AGE_DAYS: number;
export type ShardArtifact = {
	record?: unknown;
	report?: unknown;
	reportError?: string;
};
export type ShardVerdict = {
	shard: number | null;
	outcome: "complete" | "budget-cut" | "dry-run-timeout" | "failed";
	reason: string | null;
};
export declare function classifyShardArtifact(
	artifact: ShardArtifact,
	window: string,
): ShardVerdict & { report?: unknown };
export declare function combineShards(options: {
	artifacts: ShardArtifact[];
	expectedShards: number[];
	window: string;
}): {
	status: "ok" | "failed";
	shards: ShardVerdict[];
	reports?: unknown[];
};
export type QueueEntry = { file: string; base: string | null };
export type QueueOracle = {
	isAncestor: (sha: string) => boolean;
	floor: string | null;
	isOlderThanFloor: (sha: string) => boolean;
};
export type QueueRead = {
	entries: QueueEntry[];
	rebased: number;
	unknownBase: number;
	floor: string | null;
};
export declare function parsePending(
	issues: Array<{ title: string; body?: string }>,
	title: string,
	git?: QueueOracle,
): QueueRead;
export declare function gitQueueOracle(cwd: string): QueueOracle;
export declare function coverageGaps(report: unknown): {
	capped: string[];
	unfinished: string[];
	retry: string[];
};
export declare function nextQueue(options: {
	oldEntries: QueueEntry[];
	base: string;
	status: string;
	report?: unknown;
	exists: (file: string) => boolean;
}): {
	entries: QueueEntry[];
	dropped: number;
	completed: boolean;
};
export declare function buildNightlyBody(options: {
	base: string;
	head: string;
	source: string;
	status: "ok" | "failed";
	report?: unknown;
	shards?: ShardVerdict[];
	runUrl?: string;
	previous?: QueueRead;
	exists?: (file: string) => boolean;
}): string;
export declare function main(
	argv?: string[],
	cwd?: string,
):
	| {
			base: string;
			source: (typeof SOURCES)[number];
			queue: QueueRead;
	  }
	| { status: "ok" | "failed"; shards: ShardVerdict[]; reports?: unknown[] }
	| string;
