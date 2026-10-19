/**
 * #4400: pi exited (RPC child, pi-lens 4.4.3) with
 * `ERR_INVALID_ARG_TYPE ... at handleSnapshotWorkerResult` because the
 * snapshot host passed a worker result's `stagePath` straight to `fs.rmSync`.
 * `stagePath` rides the worker's result as wire data: the type said it was
 * always a string, the handler never checked, and a throw inside a worker
 * `message` listener is an uncaught exception that ends the host.
 *
 * Recurrences these tests prevent (shape: "worker result field assumed present
 * in a cleanup path"):
 *  - a handler cleanup that reads `result.stagePath` again, for a result that
 *    has a pending request (the host owns that path: it sent it), or for a
 *    late result with none;
 *  - a promotion that renames `result.stagePath` instead of the pending record.
 *
 * How the results are made. A conforming dispatch always sends a `stagePath`,
 * so no unmodified request makes the REAL worker omit it. The first two tests
 * drop `stagePath` from the REQUEST at the `postMessage` boundary and let the
 * real worker script fail on it and post its own error result. The third
 * drops it from a real SUCCESS result at the `message` boundary (a worker from
 * a different build that does not echo it). In every test the host's own
 * `message` listener runs; its throw is recorded by the wrapper, which stands
 * in for the uncaught-exception exit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	getProjectSnapshotPath,
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	loadProjectSnapshot,
	resetProjectSnapshotPersistWorkerForTests,
	saveProjectSnapshot,
	setProjectSnapshotPromotionSeamForTests,
	terminateProjectSnapshotPersistWorkerForTests,
	waitForProjectSnapshotPersistsForTests,
	_resetProjectSnapshotParseCacheForTests,
} from "../../clients/project-snapshot.js";
import type { ProjectSnapshot } from "../../clients/project-snapshot.js";
import { waitFor } from "./interleaving-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

const CORPUS = path.join(
	import.meta.dirname,
	"../fixtures/snapshot-persist/released-4.3.0",
);
const releasedBodyJson = fs.readFileSync(
	path.join(CORPUS, "snapshot.json"),
	"utf-8",
);

function releasedSnapshot(): ProjectSnapshot {
	return JSON.parse(releasedBodyJson) as ProjectSnapshot;
}

async function withProjectDataDirAsync(
	fn: (cwd: string) => Promise<void>,
): Promise<void> {
	const env = setupTestEnvironment("snapshot-worker-stagepath-");
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	try {
		await fn(path.join(env.tmpDir, "project"));
	} finally {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	}
}

interface WorkerResultLike {
	id: number;
	stagePath?: string;
	error?: string;
	[key: string]: unknown;
}

/**
 * Wrap the host's `message` listeners (recording what they saw and threw) and
 * `postMessage` (recording the stage path the host sent, optionally dropping
 * `stagePath` from the request so the real worker fails on it).
 */
function observeWorker(options: {
	stripResultStagePath?: boolean;
	dropRequestStagePath?: boolean;
}): {
	seen: WorkerResultLike[];
	thrown: unknown[];
	sentStagePaths: string[];
} {
	const seen: WorkerResultLike[] = [];
	const thrown: unknown[] = [];
	const sentStagePaths: string[] = [];
	const realOn = Worker.prototype.on;
	vi.spyOn(Worker.prototype, "on").mockImplementation(function (
		this: Worker,
		event: string | symbol,
		listener: (...args: unknown[]) => void,
	) {
		if (event !== "message") return realOn.call(this, event, listener);
		return realOn.call(this, event, (message: WorkerResultLike) => {
			seen.push(message);
			const delivered = options.stripResultStagePath
				? { ...message, stagePath: undefined }
				: message;
			try {
				listener(delivered);
			} catch (err) {
				thrown.push(err);
			}
		});
	} as typeof Worker.prototype.on);
	const realPost = Worker.prototype.postMessage;
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: Worker,
		message: { stagePath?: string },
		transferList?: ArrayBuffer[],
	) {
		if (message.stagePath !== undefined) sentStagePaths.push(message.stagePath);
		const { stagePath: _dropped, ...withoutStagePath } = message;
		realPost.call(
			this,
			options.dropRequestStagePath ? withoutStagePath : message,
			transferList,
		);
	} as typeof Worker.prototype.postMessage);
	return { seen, thrown, sentStagePaths };
}

async function settle(cwd: string): Promise<void> {
	await waitFor(
		() => getProjectSnapshotPersistStateForTests(cwd),
		(state) => !state.active && !state.queued,
		{ timeoutMs: 15_000 },
	);
}

async function awaitMessage(seen: readonly unknown[]): Promise<void> {
	await waitFor(
		() => seen.length,
		(count) => count >= 1,
		{ timeoutMs: 15_000 },
	);
}

/** The error and catch paths remove the stage with an async `fs.rm`. */
async function expectStagesGone(paths: readonly string[]): Promise<void> {
	await waitFor(
		() => paths.filter((stagePath) => fs.existsSync(stagePath)),
		(left) => left.length === 0,
		{ timeoutMs: 5_000 },
	);
}

beforeEach(() => {
	resetDegradationLedger();
	delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
	resetProjectSnapshotPersistWorkerForTests();
	_resetProjectSnapshotParseCacheForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await waitForProjectSnapshotPersistsForTests();
	await terminateProjectSnapshotPersistWorkerForTests();
	resetProjectSnapshotPersistWorkerForTests();
	_resetProjectSnapshotParseCacheForTests();
	delete process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS;
});

describe("snapshot worker result without stagePath (#4400)", () => {
	it("does not throw for a late error result that has no pending request", async () =>
		withProjectDataDirAsync(async (cwd) => {
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "200";
			const { seen, thrown } = observeWorker({ dropRequestStagePath: true });

			saveProjectSnapshot(cwd, releasedSnapshot());
			// The reset forgets the in-flight request, so the worker's result
			// arrives for an id the host no longer tracks.
			resetProjectSnapshotPersistWorkerForTests();
			await awaitMessage(seen);

			expect(seen[0]?.stagePath).toBeUndefined();
			expect(seen[0]?.error).toBeTypeOf("string");
			expect(thrown).toEqual([]);
		}));

	it("falls back to the main-thread write when the worker fails before staging", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const { seen, thrown, sentStagePaths } = observeWorker({
				dropRequestStagePath: true,
			});

			saveProjectSnapshot(cwd, releasedSnapshot());
			await awaitMessage(seen);
			// Before the settle: a throw strands the key's active slot, and the
			// settle would then time out instead of naming the TypeError.
			expect(thrown).toEqual([]);
			await settle(cwd);

			expect(seen[0]?.stagePath).toBeUndefined();
			expect(getProjectSnapshotPersistErrorForTests()).toContain("path");
			expect(
				gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(
					"utf-8",
				),
			).toBe(releasedBodyJson);
			await expectStagesGone(sentStagePaths);
		}));

	it("promotes the host's own stage when a worker result does not echo stagePath", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const { seen, thrown, sentStagePaths } = observeWorker({
				stripResultStagePath: true,
			});

			saveProjectSnapshot(cwd, releasedSnapshot());
			await awaitMessage(seen);
			expect(thrown).toEqual([]);
			await settle(cwd);

			expect(seen[0]?.error).toBeUndefined();
			expect(getProjectSnapshotPersistErrorForTests()).toBeUndefined();
			expect(getProjectSnapshotPersistStateForTests(cwd).workerBodyWrites).toBe(
				1,
			);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(releasedSnapshot().seq);
			await expectStagesGone(sentStagePaths);
		}));

	it("discards a superseded generation's own stage when its result has no stagePath", async () =>
		withProjectDataDirAsync(async (cwd) => {
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "150";
			const { seen, thrown, sentStagePaths } = observeWorker({
				stripResultStagePath: true,
			});
			const first = releasedSnapshot();

			// The second save supersedes the first while the first is in flight.
			saveProjectSnapshot(cwd, first);
			saveProjectSnapshot(cwd, { ...first, seq: first.seq + 1 });
			await settle(cwd);

			expect(seen.length).toBeGreaterThanOrEqual(2);
			expect(thrown).toEqual([]);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(first.seq + 1);
			await expectStagesGone(sentStagePaths);
		}));

	it("falls back and removes the host's stage when promotion fails and the result has no stagePath", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const { thrown, sentStagePaths } = observeWorker({
				stripResultStagePath: true,
			});
			// Between the worker's result and the promotion, the staged body
			// vanishes, so the rename fails and the handler's catch runs.
			setProjectSnapshotPromotionSeamForTests(async () => {
				for (const stagePath of sentStagePaths) {
					fs.rmSync(stagePath, { force: true });
				}
			});

			saveProjectSnapshot(cwd, releasedSnapshot());
			await settle(cwd);

			expect(thrown).toEqual([]);
			expect(getProjectSnapshotPersistErrorForTests()).toMatch(/ENOENT/);
			expect(
				gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(
					"utf-8",
				),
			).toBe(releasedBodyJson);
		}));
});

describe("snapshot stage reap that cannot remove the stage (#4400 r1 F2)", () => {
	// A directory at the stage path makes the host's sync `rmSync` throw EISDIR,
	// the stand-in for a Windows EBUSY/EPERM. Pre-fix the throw left the worker
	// `message` listener and ended the host (probe exit 42).
	/** The ledger bounds the subject, so assert the count, not the path. */
	function reapFailureCount(): number | undefined {
		return getDegradationSummary().find(
			(entry) => entry.kind === "project-snapshot-stage-reap-failed",
		)?.count;
	}

	/** Generation numbers are small and per-process; cover the ones a test uses. */
	function blockStagePaths(cwd: string): string[] {
		const gz = getProjectSnapshotPath(cwd);
		fs.mkdirSync(path.dirname(gz), { recursive: true });
		const blocked: string[] = [];
		for (let generation = 0; generation < 6; generation++) {
			const stagePath = `${gz}.stage-${process.pid}-${generation}`;
			fs.mkdirSync(stagePath, { recursive: true });
			fs.writeFileSync(path.join(stagePath, "blocker"), "x");
			blocked.push(stagePath);
		}
		return blocked;
	}

	it("survives a failed reap of an error result's stage and still falls back", async () =>
		withProjectDataDirAsync(async (cwd) => {
			const { seen, thrown } = observeWorker({});
			blockStagePaths(cwd);

			saveProjectSnapshot(cwd, releasedSnapshot());
			await awaitMessage(seen);
			expect(thrown).toEqual([]);
			await settle(cwd);

			expect(seen[0]?.error).toBeTypeOf("string");
			expect(
				gunzipSync(fs.readFileSync(getProjectSnapshotPath(cwd))).toString(
					"utf-8",
				),
			).toBe(releasedBodyJson);
			expect(reapFailureCount()).toBe(1);
		}));

	it("survives a failed reap of a superseded generation's stage and completes the key", async () =>
		withProjectDataDirAsync(async (cwd) => {
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "150";
			const { seen, thrown, sentStagePaths } = observeWorker({});
			const first = releasedSnapshot();
			// Between the first result and its handler, the staged file is replaced
			// by a non-empty directory, so the generation gate's reap fails.
			let swapped = false;
			setProjectSnapshotPromotionSeamForTests(async () => {
				if (swapped) return;
				swapped = true;
				const stagePath = sentStagePaths[0] as string;
				fs.rmSync(stagePath, { force: true });
				fs.mkdirSync(stagePath, { recursive: true });
				fs.writeFileSync(path.join(stagePath, "blocker"), "x");
			});

			saveProjectSnapshot(cwd, first);
			saveProjectSnapshot(cwd, { ...first, seq: first.seq + 1 });
			await settle(cwd);

			expect(seen.length).toBeGreaterThanOrEqual(2);
			expect(thrown).toEqual([]);
			_resetProjectSnapshotParseCacheForTests();
			expect(loadProjectSnapshot(cwd)?.seq).toBe(first.seq + 1);
			expect(reapFailureCount()).toBe(1);
		}));

	it("survives a failed reap of a late result's echoed stage", async () =>
		withProjectDataDirAsync(async (cwd) => {
			process.env.PI_LENS_TEST_SNAPSHOT_PERSIST_WORKER_DELAY_MS = "200";
			const { seen, thrown } = observeWorker({});
			const blocked = blockStagePaths(cwd);

			saveProjectSnapshot(cwd, releasedSnapshot());
			resetProjectSnapshotPersistWorkerForTests();
			await awaitMessage(seen);

			expect(thrown).toEqual([]);
			expect(blocked).toContain(seen[0]?.stagePath);
			expect(reapFailureCount()).toBe(1);
		}));
});
