export type LaneVerdict = "clean" | "red-caused" | "unproven";
export type RedVerdict = "CAUSED-BY-CHANGE" | "RED-ON-BASE" | "INCONCLUSIVE";
export interface LaneFinding {
	kind: "red-caused" | "unproven";
	reason: string;
}

export const LANE_EXIT: Record<LaneVerdict, 0 | 1 | 3>;

/** `red-caused` outranks `unproven`; no finding is `clean`. */
export function decideLane(findings: LaneFinding[]): LaneVerdict;

/** Only `clean` is 0; an unknown verdict is `unproven`'s code. */
export function laneExitCode(verdict: string): 0 | 1 | 3;

/** Worst per-test verdict of each file in one red-on-base transcript. */
export function classifyFailureFiles(
	files: string[],
	redOnBaseOutput: string,
): Array<{ file: string; verdict: RedVerdict }>;

export function reportedFailureFiles(
	output: string,
	candidates: string[],
): string[];

export function unattributedFailure(
	status: number,
	output: string,
	files: string[],
): string | null;

export function main(argv?: string[]): number;
