// Type declarations for lsp-idle-eviction-doc.mjs (untyped .mjs imported from .ts tests).

export type IdleEvictionResult =
	| "eligible"
	| "vetoed"
	| "inconclusive"
	| "unavailable";

export type IdleEvictionPolicy = "transparent" | "resident" | "unmeasured";

export interface IdleEvictionRow {
	serverId: string;
	role?: "primary" | "auxiliary";
	declared?: string;
	fixture?: string | null;
	result: IdleEvictionResult;
	reason?: string;
	initMs?: number;
	rssBytes?: number | null;
	respawn?: "ok" | "failed" | "not-evicted";
	coldStartMs?: number;
	coverage?: "preserved" | "narrowed" | "unproven";
	/** Findings the respawned server reported that the baseline did not. */
	widened?: number;
}

export interface IdleEvictionFinding {
	serverId: string;
	kind: string;
	severity: "drift" | "proposal" | "info";
	detail: string;
}

export const REASONS: Record<string, string>;
export const RESULT_STATES: readonly IdleEvictionResult[];

export function summarizeRows(rows: readonly IdleEvictionRow[]): {
	total: number;
	eligible: number;
	vetoed: number;
	inconclusive: number;
	unavailable: number;
	budget: number;
};

export function idleEvictionDrift(
	rows: readonly IdleEvictionRow[],
	declared: ReadonlyMap<string, string>,
): IdleEvictionFinding[];

export function renderIdleEvictionDoc(options: {
	rows: readonly IdleEvictionRow[];
	declared: ReadonlyMap<string, string>;
	date: string;
	platform: string;
}): string;

export function renderRawTable(rows: readonly IdleEvictionRow[]): string;

export function parseIdleEvictionDoc(text: string):
	| {
			serverId: string;
			role: string;
			declared: string;
			result: string;
			reason: string | undefined;
	  }[]
	| null;

export const IDLE_EVICTION_DRIFT_TITLE: string;

export function buildIdleEvictionDriftBody(
	findings: readonly IdleEvictionFinding[],
	options?: { runUrl?: string | null },
): string | null;

export function driftIssueState(
	rows: readonly IdleEvictionRow[],
	declared: ReadonlyMap<string, string>,
): "drift" | "clean" | "unknown";
