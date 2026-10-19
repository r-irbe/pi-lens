/**
 * #3678 F-A through the real review-graph builder: an input's trap entry must
 * decay after a healthy parse of the same content, or two separate one-off
 * traps on one unchanged file leave it `charged` and every later build reuses
 * its empty entry for the rest of the process. A trap is keyed by language and
 * content, not by path, so a healthy parse of another file holding the same
 * content is the decay event a real cross-surface parse would provide.
 *
 * This file drives the process-wide shared client, so it gets one fresh
 * `WASM_TRAP_BUDGET`; the per-client decay cases live in
 * tests/clients/tree-sitter-trap-decay.test.ts.
 */
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getGraphBuildInfoForGraph,
} from "../../../clients/review-graph/builder.js";
import { TreeSitterSymbolExtractor } from "../../../clients/tree-sitter-symbol-extractor.js";
import { getSharedTreeSitterClient } from "../../../clients/tree-sitter-shared.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

vi.mock("../../../clients/lsp-document-symbols.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../clients/lsp-document-symbols.js")
	>()),
	getOpenDocumentSymbols: vi.fn().mockResolvedValue(null),
}));

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trap = () => new WebAssembly.RuntimeError("table index is out of bounds");

const cleanups: Array<() => void> = [];
beforeEach(() => {
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
	flushReviewGraphPersistsForTests();
	clearReviewGraphWorkspaceCache();
	while (cleanups.length) cleanups.pop()?.();
});

describe("a one-off trap's entry decays after a healthy parse (#3678 F-A)", () => {
	it("decays when the SAME consumer parses the same unchanged content", async () => {
		const env = setupTestEnvironment("pi-lens-wasm-decay-");
		cleanups.push(env.cleanup);
		const content = "def trap_here_fn():\n    return 41\n";
		const trapped = createTempFile(env.tmpDir, "a.py", content);
		const other = createTempFile(
			env.tmpDir,
			"c.py",
			"def gamma_fn():\n    return 3\n",
		);
		const twinEnv = setupTestEnvironment("pi-lens-wasm-decay-twin-");
		cleanups.push(twinEnv.cleanup);
		const twin = createTempFile(twinEnv.tmpDir, "twin.py", content);

		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);
		const realExtract = TreeSitterSymbolExtractor.prototype.extract;
		let trappedExtractions = 2;
		vi.spyOn(TreeSitterSymbolExtractor.prototype, "extract").mockImplementation(
			function (
				this: TreeSitterSymbolExtractor,
				tree: Parameters<typeof realExtract>[0],
				filePath: string,
				fileContent: string,
			) {
				if (path.basename(filePath) === "a.py" && trappedExtractions-- > 0) {
					throw trap();
				}
				return realExtract.call(this, tree, filePath, fileContent);
			},
		);

		// Build 1: a.py's one-off trap costs it its symbols.
		const first = await buildOrUpdateGraph(
			env.tmpDir,
			[trapped, other],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(first).wasmTrappedFiles).toBe(1);

		// The healthy parse of the SAME input by the SAME consumer (the review
		// graph) is the decay event the builder itself would provide.
		expect(
			(
				await client.withParsedTree(
					twin,
					"python",
					content,
					() => 1,
					"review-graph",
				)
			).parsed,
		).toBe(true);

		// Build 2: a.py is retried (its in-memory signature was stamped), and its
		// second one-off trap must again be `retry`. Without decay the entry is
		// still `1`, so this trap is charged instead.
		await buildOrUpdateGraph(env.tmpDir, [trapped], new FactStore());

		// Build 3: a `retry` file is re-extracted and recovers; a `charged` one is
		// skipped for the rest of the process and stays in the graph as degraded.
		const third = await buildOrUpdateGraph(
			env.tmpDir,
			[trapped],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(third).wasmTrappedFiles).toBeUndefined();
	});

	it("does not decay when a DIFFERENT consumer parses the same content (#3678 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-wasm-decay-x-");
		cleanups.push(env.cleanup);
		const content = "def trap_here_fn():\n    return 42\n";
		const trapped = createTempFile(env.tmpDir, "a.py", content);
		const other = createTempFile(
			env.tmpDir,
			"c.py",
			"def gamma_fn():\n    return 4\n",
		);
		const twinEnv = setupTestEnvironment("pi-lens-wasm-decay-x-twin-");
		cleanups.push(twinEnv.cleanup);
		const twin = createTempFile(twinEnv.tmpDir, "twin.py", content);

		const client = getSharedTreeSitterClient()!;
		expect(await client.init()).toBe(true);
		const realExtract = TreeSitterSymbolExtractor.prototype.extract;
		let trappedExtractions = 2;
		vi.spyOn(TreeSitterSymbolExtractor.prototype, "extract").mockImplementation(
			function (
				this: TreeSitterSymbolExtractor,
				tree: Parameters<typeof realExtract>[0],
				filePath: string,
				fileContent: string,
			) {
				if (path.basename(filePath) === "a.py" && trappedExtractions-- > 0) {
					throw trap();
				}
				return realExtract.call(this, tree, filePath, fileContent);
			},
		);

		const first = await buildOrUpdateGraph(
			env.tmpDir,
			[trapped, other],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(first).wasmTrappedFiles).toBe(1);

		// A different surface parses the same language and content. It must not
		// clear the review graph's entry, or a.py would retry forever and spend
		// budget on every build.
		expect(
			(
				await client.withParsedTree(
					twin,
					"python",
					content,
					() => 1,
					"other-surface",
				)
			).parsed,
		).toBe(true);

		// Build 2 traps a second time, and the untouched entry charges it.
		const second = await buildOrUpdateGraph(
			env.tmpDir,
			[trapped],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(second).wasmTrappedFiles).toBe(1);

		// A charged file stays degraded: a third build skips it rather than
		// retrying. With cross-consumer decay this build re-extracts and recovers.
		const third = await buildOrUpdateGraph(
			env.tmpDir,
			[trapped],
			new FactStore(),
		);
		expect(getGraphBuildInfoForGraph(third).wasmTrappedFiles).toBe(1);
	});
});
