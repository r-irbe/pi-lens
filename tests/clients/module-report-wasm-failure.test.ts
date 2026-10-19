/**
 * #3996: `read_symbol` / `read_enclosing` swallowed a wasm trap thrown while
 * their own callback traversal read the tree (`Could not inspect
 * skill-router.ts: Callback extraction failed: memory access out of bounds`).
 * The traversal's `catch` turned the trap into an ordinary extractor error, so
 * #3605's containment never saw it: no `wasm-trap` record, no budget unit, no
 * parser/tree-cache recycle, and the agent got the raw wasm message. The trap
 * is injected where production raises it, the `children` accessor on
 * web-tree-sitter's real `Node`, after the symbol extractor has finished, so
 * the next `children` read is `extractCallbacks`'s own. The tools, the shared
 * client and the grammar are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { _resetSharedTreeSitterClientForTests } from "../../clients/tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import {
	createReadEnclosingTool,
	createReadSymbolTool,
} from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};

const cleanups: Array<() => void> = [];
// The trap budget is process-wide (#3605); each case starts with a fresh client.
beforeEach(() => {
	_resetSharedTreeSitterClientForTests();
	resetDegradationLedger();
});
afterEach(() => {
	vi.restoreAllMocks();
	while (cleanups.length) cleanups.pop()?.();
	resetDegradationLedger();
});

function trapCount(): number | undefined {
	return getDegradationSummary().find((group) => group.kind === "wasm-trap")
		?.count;
}

/**
 * Throw one `memory access out of bounds` from the next `children` read after
 * the symbol extractor has returned for a tree containing `marker`. The
 * extractor never calls the accessor here; `extractCallbacks` is the next
 * reader, so a pre-fix swallow in it is what the test observes.
 */
async function trapCallbackTraversalOnce(
	marker: string,
	failure: Error = new WebAssembly.RuntimeError("memory access out of bounds"),
): Promise<{
	trapped: () => number;
}> {
	const { Node } = await loadWebTreeSitter();
	const original = Object.getOwnPropertyDescriptor(Node.prototype, "children");
	if (!original?.get) throw new Error("Node.children getter not found");
	const realChildren = original.get;
	let armed = false;
	let thrown = 0;
	const realExtract = TreeSitterSymbolExtractor.prototype.extract;
	vi.spyOn(TreeSitterSymbolExtractor.prototype, "extract").mockImplementation(
		function (
			this: TreeSitterSymbolExtractor,
			...args: Parameters<typeof realExtract>
		) {
			const result = realExtract.apply(this, args);
			if (thrown === 0 && args[2].includes(marker)) armed = true;
			return result;
		},
	);
	vi.spyOn(Node.prototype, "children", "get").mockImplementation(function (
		this: InstanceType<typeof Node>,
	) {
		if (armed) {
			armed = false;
			thrown++;
			throw failure;
		}
		return realChildren.call(this);
	});
	return { trapped: () => thrown };
}

function project(file: string, content: string): { cwd: string } {
	const env = setupTestEnvironment("pi-lens-modreport-wasm-");
	cleanups.push(env.cleanup);
	createTempFile(env.tmpDir, file, content);
	return { cwd: env.tmpDir };
}

const SOURCE = (marker: string) =>
	`export default function router(pi: Api) {\n\tpi.on("start", async () => {\n\t\treturn "${marker}";\n\t});\n}\n`;

describe("read_symbol / read_enclosing contain a wasm trap in the callback traversal (#3996)", () => {
	it("reports a trapped callback traversal as a contained wasm failure, not a raw extractor error", async () => {
		// Recurrence: #3996 reported `Callback extraction failed: memory access
		// out of bounds` verbatim, and nothing counted the trap.
		const { cwd } = project("skill-router.ts", SOURCE("MARK_A"));
		const probe = await trapCallbackTraversalOnce("MARK_A");
		const tool = createReadSymbolTool(
			() => cwd,
			() => {},
		);

		const result = await tool.execute(
			"1",
			{ path: "skill-router.ts", symbol: "missingHandler" },
			undefined,
			null,
			{ cwd },
		);

		expect(probe.trapped()).toBe(1);
		expect(result.isError).toBe(true);
		const text = String(result.content[0]?.text);
		expect(text).toContain("tree-sitter wasm runtime failure");
		expect(text).toContain("memory access out of bounds");
		expect(trapCount()).toBe(1);
	});

	it("keeps returning a symbol the extractor already found when only the callback traversal trapped", async () => {
		// Recurrence: the swallow hid the trap even where the tool succeeded, so
		// a runtime trapping on every read never spent budget.
		const { cwd } = project("skill-router.ts", SOURCE("MARK_B"));
		await trapCallbackTraversalOnce("MARK_B");
		const tool = createReadSymbolTool(
			() => cwd,
			() => {},
		);

		const result = await tool.execute(
			"2",
			{ path: "skill-router.ts", symbol: "router" },
			undefined,
			null,
			{ cwd },
		);

		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toContain("function router");
		expect(trapCount()).toBe(1);
	});

	it("leaves an extractor bug that is not a wasm failure as a plain callback error, uncounted", async () => {
		// Recurrence guard for the classification gate: only a wasm failure is
		// the runtime's; a JS bug in the traversal must not spend trap budget or
		// be relabelled as a runtime failure.
		const { cwd } = project("skill-router.ts", SOURCE("MARK_E"));
		await trapCallbackTraversalOnce("MARK_E", new TypeError("extractor bug"));
		const tool = createReadSymbolTool(
			() => cwd,
			() => {},
		);

		const result = await tool.execute(
			"6",
			{ path: "skill-router.ts", symbol: "missingHandler" },
			undefined,
			null,
			{ cwd },
		);

		expect(String(result.content[0]?.text)).toContain(
			"Callback extraction failed: extractor bug",
		);
		expect(String(result.content[0]?.text)).not.toContain("wasm runtime");
		expect(trapCount()).toBeUndefined();
	});

	it("recovers on the next call: one trap does not poison the runtime", async () => {
		// Recurrence guard for the budget: a single contained trap recycles the
		// parsers and leaves tree-sitter usable for the same file.
		const { cwd } = project("skill-router.ts", SOURCE("MARK_C"));
		await trapCallbackTraversalOnce("MARK_C");
		const tool = createReadSymbolTool(
			() => cwd,
			() => {},
		);
		const first = await tool.execute(
			"3",
			{ path: "skill-router.ts", symbol: "missingHandler" },
			undefined,
			null,
			{ cwd },
		);
		expect(first.isError).toBe(true);

		const second = await tool.execute(
			"4",
			{ path: "skill-router.ts", symbol: "router" },
			undefined,
			null,
			{ cwd },
		);

		expect(second.isError).toBeFalsy();
		expect(String(second.content[0]?.text)).toContain("function router");
		expect(trapCount()).toBe(1);
		expect(
			getDegradationSummary().some((group) => group.kind === "wasm-abort"),
		).toBe(false);
	});

	it("read_enclosing keeps the enclosing symbol and counts the trap", async () => {
		const { cwd } = project("skill-router.ts", SOURCE("MARK_D"));
		await trapCallbackTraversalOnce("MARK_D");
		const tool = createReadEnclosingTool(
			() => cwd,
			() => {},
		);

		const result = await tool.execute(
			"5",
			{ path: "skill-router.ts", line: 3 },
			undefined,
			null,
			{ cwd },
		);

		expect(trapCount()).toBe(1);
		expect(String(result.content[0]?.text)).toContain("function router");
		expect((result.details as { warnings?: string[] }).warnings).toEqual([
			"Callback extraction failed: tree-sitter wasm runtime failure (memory access out of bounds)",
		]);
	});
});
