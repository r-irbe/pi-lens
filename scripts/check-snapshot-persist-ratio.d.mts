// Type declarations for check-snapshot-persist-ratio.mjs (#3916).

export const DRIFT_THRESHOLD: number;
export const SAMPLE_COUNT: number;
export const HOSTED_NIGHTS_BEFORE_RECALIBRATION: number;
export interface PersistRatio {
	workerMB: number;
	syncMB: number;
	ratio: number;
}
export interface RatioVerdict {
	state: "clean" | "drift" | "error";
	threshold: number;
	samples?: PersistRatio[];
	median?: number;
	min?: number;
	max?: number;
	reason?: string;
}
export function firstPersistRatio(report: unknown): PersistRatio;
export function evaluate(
	reports: unknown[],
	options?: { threshold?: number; samples?: number },
): RatioVerdict;
export function buildIssueBody(
	verdict: RatioVerdict,
	options?: { runUrl?: string; report?: { node?: string; platform?: string } },
): string;
export function main(argv?: string[], log?: (line: string) => void): number;
