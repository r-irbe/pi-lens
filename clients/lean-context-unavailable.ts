import { incrementDegradationCount } from "./degradation-ledger.js";

export type LeanContextUnavailableReasonCode =
	| "admission-missing"
	| "admission-rejected"
	| "session-unavailable"
	| "context-changed"
	| "compiler-unavailable"
	| "compiler-mismatch"
	| "artifact-unavailable"
	| "source-location-unavailable"
	| "bounds-exceeded"
	| "cancelled"
	| "live-identity-unavailable"
	| "ambiguous-warm-route-unavailable";

export type LeanContextUnavailableCaller = "cpp-check" | "lsp-navigation";

export interface LeanContextUnavailableInput {
	readonly caller: LeanContextUnavailableCaller;
	readonly reasonCode: LeanContextUnavailableReasonCode;
	readonly reason: string;
}

export function classifyLeanContextFailureMessage(
	message: string,
	rejectedByConfig = false,
): LeanContextUnavailableReasonCode {
	if (rejectedByConfig) return "admission-rejected";
	if (
		message.includes("requires an admitted") ||
		message.includes("no admitted")
	) {
		return "admission-missing";
	}
	if (
		message.includes("is not") &&
		message.includes("configured Lean context")
	) {
		return "compiler-mismatch";
	}
	if (
		message.includes("lean/lean.h") ||
		message.includes("--print-prefix") ||
		message.includes("--version") ||
		message.includes("cannot verify") ||
		message.includes("cannot resolve")
	) {
		return "compiler-unavailable";
	}
	return "admission-missing";
}

export function recordLeanContextUnavailable(
	input: LeanContextUnavailableInput,
): boolean {
	return incrementDegradationCount({
		kind: "lean-context-unavailable",
		subject: input.caller,
		reason: input.reason,
		metadata: {
			["consumer"]: input.caller,
			phase: "pre-execution",
			reasonCode: input.reasonCode,
		},
	});
}
