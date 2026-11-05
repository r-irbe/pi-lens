import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	classifyLeanContextFailureMessage,
	type LeanContextUnavailableReasonCode,
	recordLeanContextUnavailable,
} from "../../clients/lean-context-unavailable.js";
import { setupTestEnvironment } from "./test-utils.js";

const envs: ReturnType<typeof setupTestEnvironment>[] = [];

afterEach(() => {
	resetDegradationLedger();
	vi.unstubAllEnvs();
	for (const env of envs.splice(0)) env.cleanup();
});

describe("lean-context-unavailable bounded decision recorder", () => {
	it("records pre-execution lean-context-unavailable for cpp-check and lsp-navigation without runner-empty-result pollution", async () => {
		const env = setupTestEnvironment("pi-lens-lean-ctx-unavail-");
		envs.push(env);
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		await flushLatencyLog();
		const sink = getLatencyLogPath();
		const offset = fs.existsSync(sink) ? fs.statSync(sink).size : 0;

		const firstCpp = recordLeanContextUnavailable({
			caller: "cpp-check",
			reasonCode: "admission-missing",
			reason:
				"environment_unavailable: generated Lean C requires an admitted lsp.serverOverrides.lean.leanContext",
		});
		const secondCpp = recordLeanContextUnavailable({
			caller: "cpp-check",
			reasonCode: "compiler-mismatch",
			reason:
				"environment_unavailable: Lean compiler reported 4.33.1, which is not configured Lean context 4.35.0",
		});
		const firstNav = recordLeanContextUnavailable({
			caller: "lsp-navigation",
			reasonCode: "live-identity-unavailable",
			reason:
				"environment_unavailable: live Lean semantic route requires matching live server identity",
		});

		expect(firstCpp).toBe(true);
		expect(secondCpp).toBe(false);
		expect(firstNav).toBe(true);

		const summary = getDegradationSummary();
		const group = summary.find(
			(entry) => entry.kind === "lean-context-unavailable",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(3);
		expect(
			summary.some(
				(entry) =>
					entry.kind === "runner-empty-result" ||
					entry.kind === "runner-parsed-nothing",
			),
		).toBe(false);

		await flushLatencyLog();
		const rows = fs
			.readFileSync(sink, "utf8")
			.slice(offset)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		expect(rows).toContainEqual(
			expect.objectContaining({
				phase: "degradation_ledger",
				metadata: expect.objectContaining({
					kind: "lean-context-unavailable",
					subject: "cpp-check",
					consumer: "cpp-check",
					phase: "pre-execution",
					reasonCode: "admission-missing",
				}),
			}),
		);
		expect(rows).toContainEqual(
			expect.objectContaining({
				phase: "degradation_ledger",
				metadata: expect.objectContaining({
					kind: "lean-context-unavailable",
					subject: "lsp-navigation",
					consumer: "lsp-navigation",
					phase: "pre-execution",
					reasonCode: "live-identity-unavailable",
				}),
			}),
		);
	});

	it("classifies pre-execution failure messages into finite reason codes", () => {
		const cases: Array<[string, boolean, LeanContextUnavailableReasonCode]> = [
			[
				"environment_unavailable: project .pi-lens.json rejected /lsp/serverOverrides/lean/leanContext",
				true,
				"admission-rejected",
			],
			[
				"environment_unavailable: generated Lean C requires an admitted lsp.serverOverrides.lean.leanContext",
				false,
				"admission-missing",
			],
			[
				"environment_unavailable: /opt/lean/bin/lean reported 4.33.1, which is not configured Lean context 4.35.0",
				false,
				"compiler-mismatch",
			],
			[
				"environment_unavailable: admitted Lean runtime header /opt/lean/include/lean/lean.h is missing",
				false,
				"compiler-unavailable",
			],
		];
		for (const [msg, rejected, expected] of cases) {
			expect(classifyLeanContextFailureMessage(msg, rejected)).toBe(expected);
		}
	});
});
