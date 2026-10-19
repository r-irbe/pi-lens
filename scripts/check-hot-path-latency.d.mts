// Type declarations for check-hot-path-latency.mjs (#4363).

import type { Comparison, Judgement, Threshold } from "./lib/latency-stats.mjs";

export type Sample = Record<string, number>;
export type TreeLabel = "base" | "head";
export interface Samples {
	base: Sample[];
	head: Sample[];
}
export interface MetricRow extends Comparison, Judgement {
	metric: string;
}
export const DEFAULT_RUNS: number;
export const DEFAULT_BUDGET_MS: number;
export function runSampleProcess(tree: string, scratch: string): Sample;
export function collectSamples(options: {
	base: string;
	head: string;
	runs: number;
	takeSample: (label: TreeLabel, tree: string, index: number) => Sample;
	now?: () => number;
	deadline?: number;
}): Samples;
export function evaluate(samples: Samples, threshold?: Threshold): MetricRow[];
export function renderReport(
	rows: MetricRow[],
	options: { runs: number; threshold?: Threshold },
): string;
export function main(
	argv: string[],
	io?: {
		log?: (line: string) => void;
		takeSample?: (label: TreeLabel, tree: string, index: number) => Sample;
		summaryFile?: string;
		now?: () => number;
	},
): number;
