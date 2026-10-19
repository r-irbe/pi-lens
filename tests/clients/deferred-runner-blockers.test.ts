/**
 * #3814 — the deferred-blocker recording seam, below the host entry.
 *
 * `tests/index-3814-deferred-blocker-gate.test.ts` proves the commit gate
 * through the pi host. This file pins the two properties that entry cannot
 * reach: the recording's provenance contract with the retire seam, and the
 * gate's fail-open behaviour when its pre-check throws. Real
 * `RuntimeCoordinator`, `CacheManager` and pending store throughout.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	absorbSettledRunnerBlockers,
	judgeDeferredRunnerFindings,
} from "../../clients/deferred-runner-blockers.js";
import {
	deferRunnerFindings,
	peekSettledRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "../../clients/generation-guard.js";
import type { Diagnostic, RunnerResult } from "../../clients/dispatch/types.js";
import { evaluateGitGuard } from "../../clients/git-guard.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

// Only the OS read boundary is wrapped; stores, coordinator, policy, and gate remain real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const RUNNER_ID = "slow-runner";

afterEach(() => {
	resetPendingRunnerFindings();
	resetDegradationLedger();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function blocking(filePath: string): Diagnostic {
	return {
		id: `${RUNNER_ID}:app.ts:1`,
		message: "alpha is not a function",
		filePath,
		line: 1,
		severity: "error",
		semantic: "blocking",
		tool: RUNNER_ID,
		rule: "TS2349",
	};
}

/** A settled deferred answer for `filePath`, scanned just now. `session` is
 * the producer's captured handle; omitting it is a released writer's shape. */
async function settledAnswer(
	filePath: string,
	cwd: string,
	session?: GenerationHandle,
): Promise<void> {
	const result: RunnerResult = {
		status: "succeeded",
		diagnostics: [blocking(filePath)],
		semantic: "blocking",
	};
	deferRunnerFindings({
		filePath,
		cwd,
		projectRoot: cwd,
		runnerId: RUNNER_ID,
		markedAtMs: Date.now(),
		promise: Promise.resolve(result),
		...(session ? { session } : {}),
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("deferred blocker recording (#3814)", () => {
	it("keeps a fresh settled blocker gating when its bytes cannot be read", async () => {
		// Recurrence: #3896 mutant27 removed the optional byte read, turning
		// EACCES after a successful stat into a pre-check exception and false allow.
		// The real-filesystem POSIX probe proved the same red; faulting only the
		// OS read makes this witness portable without weakening any real owner.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			const actualFs =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(fs.readFileSync).mockImplementation((file, options) => {
				if (file === filePath) {
					throw Object.assign(new Error("EACCES: reading app.ts"), {
						code: "EACCES",
					});
				}
				return actualFs.readFileSync(file, options);
			});
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(true);
			expect(
				getDegradationSummary().some(
					(row) => row.kind === "deferred-blocker-gate-error",
				),
			).toBe(false);
		} finally {
			vi.mocked(fs.readFileSync).mockImplementation(
				(await vi.importActual<typeof import("node:fs")>("node:fs"))
					.readFileSync,
			);
			env.cleanup();
		}
	});

	it("leaves the missing-path record to delivery rather than writing it during a gate peek", async () => {
		// Recurrence: #3814 r1 L1 duplicated delivery records from a commit peek.
		// Mutation of advisory-provenance's quiet guard must red this real sink.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			fs.unlinkSync(filePath);
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(false);
			await flushLatencyLog();
			const before = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.filePath === env.tmpDir &&
						row.phase === "finding_dead_path_drop",
				);
			expect(before).toHaveLength(0);
			// The real settled store still owns the answer; delivery asks the same
			// verdict without quiet, just as the turn-end lane does.
			const [pending] = peekSettledRunnerFindings();
			expect(pending).toBeDefined();
			judgeDeferredRunnerFindings(pending, env.tmpDir);
			await flushLatencyLog();
			const after = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.filePath === env.tmpDir &&
						row.phase === "finding_dead_path_drop",
				);
			expect(after).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("counts only newly recorded files when a settled replay joins a fresh answer", async () => {
		// The worker home is pinned before logger load; opt into the real sink.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		// Recurrence: #3896 mutant63 counted an already recorded answer as a
		// newly blocking file in the commit-gate result and latency record.
		const env = setupTestEnvironment("pi-lens-3814-sources-");
		try {
			const firstPath = path.join(env.tmpDir, "first.ts");
			const secondPath = path.join(env.tmpDir, "second.ts");
			fs.writeFileSync(firstPath, "alpha();\n");
			fs.writeFileSync(secondPath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(firstPath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);
			await settledAnswer(secondPath, env.tmpDir);
			const result = absorbSettledRunnerBlockers(runtime, env.tmpDir);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(2);
			expect(result.recorded).toBe(1);
			expect(result.fileCount).toBe(1);
			await flushLatencyLog();
			const rows = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.phase === "deferred_runner_blockers" &&
						row.filePath === env.tmpDir,
				);
			expect(rows).toHaveLength(2);
			expect(rows.at(-1)?.metadata).toMatchObject({
				recorded: 1,
				fileCount: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("is retired only by a clean verdict that covers the runner that raised it", async () => {
		// Recurrence: inline blockers carry the `tool` ids behind them so an
		// LSP-only clean cannot retire an eslint/pyright blocker (#1561 F1). A
		// deferred record that dropped `sources` would be retired by any clean
		// verdict, or (fail-closed on unknown provenance) by none.
		const env = setupTestEnvironment("pi-lens-3814-sources-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					"lsp",
				]),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					RUNNER_ID,
				]),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("makes a file blocking again when a deferred blocker joins a fully suppressed record", async () => {
		// Recurrence: `policySuppressed` is a verdict about the OLD finding set
		// (#3248). A merge that kept it would let the gate ignore a live deferred
		// blocker because the agent marked the earlier, different finding.
		const env = setupTestEnvironment("pi-lens-3814-suppressed-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const inline: Diagnostic = {
				...blocking(filePath),
				id: "inline-tool:app.ts:1",
				tool: "inline-tool",
				message: "inline finding",
			};
			runtime.recordInlineBlockers(
				filePath,
				"inline summary",
				runtime.nextWriteIndex(),
				["inline-tool"],
				[1],
				undefined,
				[inline],
			);
			runtime.applyInlineBlockerPolicyVerdicts([filePath]);
			runtime.updateGitGuardStatus(false, "");
			expect(runtime.gitGuardHasBlockers).toBe(false);

			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a record with no structured diagnostics as it was", async () => {
		// Recurrence: merging into a text-only record would replace its text with
		// the new findings alone at the next replay (the replay re-renders from
		// `diagnostics`). The file already blocks, so nothing is lost by waiting.
		const env = setupTestEnvironment("pi-lens-3814-unstructured-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.recordInlineBlockers(
				filePath,
				"legacy summary text",
				runtime.nextWriteIndex(),
				["legacy-tool"],
			);
			await settledAnswer(filePath, env.tmpDir);

			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(0);
			expect(runtime.getInlineBlockersSnapshot()).toMatchObject([
				{ summary: "legacy summary text" },
			]);
			expect(
				runtime.getInlineBlockersSnapshot()[0]?.diagnostics,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("fails open on a pre-check fault and judges the same answer again at the next attempt", async () => {
		// Recurrence (r1 L2): the gate claimed every settled entry before judging
		// any, so one transient fault left the entry unjudged for the rest of the
		// session and the next commit passed on a blocker that was waiting. The
		// fault is one counted ledger row; the retry blocks.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			await settledAnswer(filePath, env.tmpDir);
			vi.spyOn(runtime, "recordDeferredInlineBlockers").mockImplementationOnce(
				() => {
					throw new Error("injected recording fault");
				},
			);

			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				false,
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "deferred-blocker-gate-error",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.reason).toContain(
				"injected recording fault",
			);
			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				true,
			);
		} finally {
			env.cleanup();
		}
	});

	it("stamps the record with the moment the runner scanned", async () => {
		// Recurrence (r1 L3): `recordedAtMs` is the baseline the dependency-drift
		// sweep compares file and import mtimes against; a record stamped 0 is
		// demoted at the first sweep, and stamped with the recording time it would
		// never see a drift that happened between the scan and the recording.
		const env = setupTestEnvironment("pi-lens-3814-stamp-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const markedAtMs = Date.now() + 10_000;
			deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: RUNNER_ID,
				markedAtMs,
				promise: Promise.resolve({
					status: "succeeded",
					diagnostics: [blocking(filePath)],
					semantic: "blocking",
				} satisfies RunnerResult),
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.getInlineBlockersSnapshot()[0]?.recordedAtMs).toBe(
				markedAtMs,
			);
		} finally {
			env.cleanup();
		}
	});

	it("drops a retired producer's settled answer from the gate (staleReject)", async () => {
		// #3758/#3814: the gate's non-draining peek applies the same owned
		// admission the turn-end drain does. A commit in the gap before the next
		// session_start clears this store must not block on a retired session's
		// answer; the drop leaves the handle's `generation-guard-stale-write` row.
		const env = setupTestEnvironment("pi-lens-3814-peek-stale-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const sessions = createGenerationSource("test-runtime-session");
			const retired = sessions.capture();
			await settledAnswer(filePath, env.tmpDir, retired);
			sessions.bump();

			const cacheManager = new CacheManager(false);
			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				false,
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "generation-guard-stale-write",
			);
			expect(row?.latestReasons[0]?.subject).toContain(
				`commit-gate:${RUNNER_ID}:${filePath}`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the sole live answer gating beside a retired one (no-drop)", async () => {
		// Shape 54: the fence is proven in both directions. The retired file must
		// not be recorded while the live session's only fresh answer still is;
		// a peek that skipped the whole store on the first stale entry would let
		// this commit through.
		const env = setupTestEnvironment("pi-lens-3814-peek-live-");
		try {
			const stalePath = path.join(env.tmpDir, "stale.ts");
			const livePath = path.join(env.tmpDir, "live.ts");
			fs.writeFileSync(stalePath, "beta();\n");
			fs.writeFileSync(livePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const sessions = createGenerationSource("test-runtime-session");
			const retired = sessions.capture();
			await settledAnswer(stalePath, env.tmpDir, retired);
			sessions.bump();
			const live = sessions.capture();
			await settledAnswer(livePath, env.tmpDir, live);

			const recording = absorbSettledRunnerBlockers(runtime, env.tmpDir);
			expect(recording.recorded).toBe(1);
			expect(recording.fileCount).toBe(1);
			expect(
				runtime.getInlineBlockersSnapshot().map((record) => record.filePath),
			).toEqual([livePath]);
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
