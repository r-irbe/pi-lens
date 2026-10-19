/**
 * #4400 (sibling of the project-snapshot report): the review-graph persist
 * host read `result.stagePath` in every cleanup and promotion of its worker
 * `message` listener. `stagePath` is wire data from the worker thread; when it
 * is missing, `fs.rm(undefined)` throws out of the listener, which is an
 * uncaught exception that ends the host.
 *
 * Recurrences these tests prevent (shape: "worker result field assumed present
 * in a cleanup path"):
 *  - the authoritative-persist handler cleaning or renaming `result.stagePath`
 *    instead of the stage path its own request record holds;
 *  - the checkpoint handler doing the same instead of `cp.stagePath`;
 *  - the late-result branch (no request record) removing an unchecked path.
 *
 * How the results are made: see tests/clients/project-snapshot-worker-result-
 * stagepath.test.ts. A conforming dispatch always sends a `stagePath`, so the
 * error results here come from the REAL worker failing on a request whose
 * `stagePath` was dropped at the `postMessage` boundary, and the success result
 * is a real one with `stagePath` dropped at the `message` boundary. The host's
 * own `message` listener runs in every test; its throw is recorded by the
 * wrapper, which stands in for the uncaught-exception exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	_readReviewGraphCheckpointForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersist,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getCheckpointOffloadCountForTests,
	getReviewGraphWorkerFallbackReasonForTests,
	resetReviewGraphPersistWorkerForTests,
	reviewGraphCachePath,
	terminateReviewGraphPersistWorkerForTests,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { waitFor } from "./interleaving-kit.js";
import { removeTempDirSync } from "./test-utils.js";

const SOURCES: Record<string, string> = {
	"src/a.ts": "export const alpha = 1;\n",
	"src/b.ts": "import { alpha } from './a';\nexport const beta = alpha;\n",
	"src/c.ts":
		"import { beta } from './b';\nexport function gamma() { return beta; }\n",
	"src/d.ts": "export function delta() { return 4; }\n",
	"src/e.ts": "import { gamma } from './c';\nexport const eps = gamma();\n",
	"src/f.ts": "import { delta } from './d';\nexport const zeta = delta();\n",
};

const roots: string[] = [];

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-stage-"));
	roots.push(root);
	for (const [relative, content] of Object.entries(SOURCES)) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
	return root;
}

interface WorkerResultLike {
	id: number;
	stagePath?: string;
	error?: string;
	[key: string]: unknown;
}

/**
 * Wrap the host's `message` listeners (recording what they saw and threw) and
 * `postMessage` (recording the stage paths the host sent, optionally dropping
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

async function awaitMessages(
	seen: readonly unknown[],
	count = 1,
): Promise<void> {
	await waitFor(
		() => seen.length,
		(seenCount) => seenCount >= count,
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
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	resetReviewGraphPersistWorkerForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	flushReviewGraphPersistsForTests();
	await waitForReviewGraphPersistsForTests();
	await terminateReviewGraphPersistWorkerForTests();
	resetReviewGraphPersistWorkerForTests();
	clearReviewGraphWorkspaceCache();
	clearGraphCache();
	delete process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS;
	delete process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER;
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "0";
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

describe("review-graph worker result without stagePath (#4400)", () => {
	it("does not throw for a late error result that has no request record", async () => {
		const root = makeRoot();
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "200";
		const { seen, thrown } = observeWorker({ dropRequestStagePath: true });

		await buildOrUpdateGraph(root, [], new FactStore());
		// The forced flush removes the in-flight request record, so the worker's
		// result arrives for an id the host no longer tracks.
		expect(flushReviewGraphPersist(root).ok).toBe(true);
		await awaitMessages(seen);

		expect(seen[0]?.stagePath).toBeUndefined();
		expect(seen[0]?.error).toBeTypeOf("string");
		expect(thrown).toEqual([]);
	});

	it("falls back to the main-thread write when the worker fails before staging", async () => {
		const root = makeRoot();
		const { seen, thrown, sentStagePaths } = observeWorker({
			dropRequestStagePath: true,
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		await awaitMessages(seen);
		// Before the settle: a throw strands the request's completion.
		expect(thrown).toEqual([]);
		await waitForReviewGraphPersistsForTests();

		expect(seen[0]?.stagePath).toBeUndefined();
		expect(getReviewGraphWorkerFallbackReasonForTests()).toMatch(/path/);
		expect(fs.existsSync(reviewGraphCachePath(root))).toBe(true);
		await expectStagesGone(sentStagePaths);
	});

	it("promotes the host's own stage when a worker result does not echo stagePath", async () => {
		const root = makeRoot();
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		const built = await buildOrUpdateGraph(root, [], new FactStore());
		await awaitMessages(seen);
		expect(thrown).toEqual([]);
		await waitForReviewGraphPersistsForTests();

		expect(seen[0]?.error).toBeUndefined();
		expect(getReviewGraphWorkerFallbackReasonForTests()).toBeUndefined();
		await expectStagesGone(sentStagePaths);
		clearReviewGraphWorkspaceCache(root);
		expect(getCachedReviewGraph(root)?.nodes.size).toBe(built.nodes.size);
	});

	it("drops a checkpoint whose worker failed before staging, without throwing", async () => {
		const root = makeRoot();
		// A checkpoint every 2 files with no interval floor: the 6-file build
		// offloads mid-build checkpoints to the same worker.
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "2";
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		const { seen, thrown, sentStagePaths } = observeWorker({
			dropRequestStagePath: true,
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		expect(getCheckpointOffloadCountForTests()).toBeGreaterThanOrEqual(1);
		// The persist request and at least one checkpoint request.
		await awaitMessages(seen, 2);
		await waitForReviewGraphPersistsForTests();

		expect(thrown).toEqual([]);
		expect(seen.every((message) => message.stagePath === undefined)).toBe(true);
		await expectStagesGone(sentStagePaths);
	});

	it("reaps a superseded generation's own stage when its result has no stagePath", async () => {
		const root = makeRoot();
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "150";
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		// A second build schedules a newer generation while the first is in flight.
		fs.writeFileSync(path.join(root, "src/g.ts"), "export const eta = 7;\n");
		await buildOrUpdateGraph(
			root,
			[path.join(root, "src/g.ts")],
			new FactStore(),
		);
		await awaitMessages(seen, 2);
		await waitForReviewGraphPersistsForTests();

		expect(thrown).toEqual([]);
		// The superseded result's reap must hit the host's stage, not `undefined`
		// (whose throw the handler catches and logs, leaving the stage behind).
		expect(sentStagePaths.length).toBeGreaterThanOrEqual(2);
		await expectStagesGone(sentStagePaths);
	});

	it("removes the host's stage when promotion fails and the result has no stagePath", async () => {
		const root = makeRoot();
		// A non-empty directory where the graph cache goes makes the promotion
		// rename fail for real (the destination cannot be replaced), so the
		// handler's catch runs.
		const cachePath = reviewGraphCachePath(root);
		fs.mkdirSync(cachePath, { recursive: true });
		fs.writeFileSync(path.join(cachePath, "blocker"), "x");
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		await awaitMessages(seen);
		expect(thrown).toEqual([]);
		await waitForReviewGraphPersistsForTests();

		expect(seen[0]?.error).toBeUndefined();
		await expectStagesGone(sentStagePaths);
	});

	it("discards a superseded checkpoint's own stage when its result has no stagePath", async () => {
		const root = makeRoot();
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "2";
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		// Slow worker: the build completes (which retires the checkpoint
		// generation) before the checkpoint results arrive.
		process.env.PI_LENS_TEST_PERSIST_WORKER_DELAY_MS = "150";
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		await buildOrUpdateGraph(root, [], new FactStore());
		expect(getCheckpointOffloadCountForTests()).toBeGreaterThanOrEqual(1);
		await awaitMessages(seen, 2);
		await waitForReviewGraphPersistsForTests();

		expect(thrown).toEqual([]);
		await expectStagesGone(sentStagePaths);
	});

	// #4400 r1 F1: the build aborts after its fifth sync checkpoint without
	// retiring the checkpoint generation, so the four offloaded strides promote
	// live. Without this seam every checkpoint result arrives after the build
	// retired its generation and only the gate branch runs.
	it("promotes a live checkpoint from the host's own stage when the result has no stagePath", async () => {
		const root = makeRoot();
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "1";
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "5";
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		await expect(buildOrUpdateGraph(root, [], new FactStore())).rejects.toThrow(
			/checkpoint_test_abort/,
		);
		// The sync checkpoint holds 5 files; the last offloaded stride holds 4.
		expect(
			_readReviewGraphCheckpointForTests(root)?.processedFiles,
		).toHaveLength(5);
		await awaitMessages(seen, 4);
		await waitFor(
			() => _readReviewGraphCheckpointForTests(root)?.processedFiles.length,
			(processed) => processed === 4,
			{ timeoutMs: 15_000 },
		);

		expect(thrown).toEqual([]);
		await expectStagesGone(sentStagePaths);
	});

	it("removes the host's stage when a live checkpoint promotion fails and the result has no stagePath", async () => {
		const root = makeRoot();
		process.env.PI_LENS_GRAPH_CHECKPOINT_EVERY_FILES = "1";
		process.env.PI_LENS_GRAPH_CHECKPOINT_MIN_INTERVAL_MS = "0";
		process.env.PI_LENS_GRAPH_CHECKPOINT_TEST_STOP_AFTER = "5";
		const { seen, thrown, sentStagePaths } = observeWorker({
			stripResultStagePath: true,
		});

		await expect(buildOrUpdateGraph(root, [], new FactStore())).rejects.toThrow(
			/checkpoint_test_abort/,
		);
		// A non-empty directory where the checkpoint goes makes the live rename
		// fail for real, so the promotion catch runs.
		const checkpointPath = sentStagePaths[0]?.replace(/\.stage-.*$/, "") ?? "";
		fs.rmSync(checkpointPath, { force: true });
		fs.mkdirSync(checkpointPath, { recursive: true });
		fs.writeFileSync(path.join(checkpointPath, "blocker"), "x");
		await awaitMessages(seen, 4);
		await waitForReviewGraphPersistsForTests();

		expect(thrown).toEqual([]);
		await expectStagesGone(sentStagePaths);
	});
});
