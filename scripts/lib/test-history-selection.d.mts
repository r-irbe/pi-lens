export const HISTORY_STALE_MS: number;
export const HISTORY_MAX_SELECTED: number;
export const HUB_SHARE: number;
export const HUB_MIN_HEADS: number;
export const HISTORY_REF: string;
export const HISTORY_SUMMARY_PATH: string;

export interface HistorySelection {
	/** `unavailable`/`stale` fall back to import-only selection. */
	status: "selected" | "none" | "stale" | "unavailable";
	picks: string[];
	detail: string;
}

export function selectFromHistory(input: {
	summary: unknown;
	changed: string[];
	allTests: string[];
	pathsForHeads: (heads: string[]) => Map<string, string[]>;
	now?: number;
}): HistorySelection;

export function resolveHeadPaths(
	heads: string[],
	options?: { cwd?: string },
): Map<string, string[]>;

export function readHistorySummary(options?: {
	file?: string;
	cwd?: string;
}): { summary: unknown } | { error: string };

export function loadHistorySelection(input: {
	changed: string[];
	allTests: string[];
	now?: number;
	file?: string;
	cwd?: string;
}): HistorySelection;
