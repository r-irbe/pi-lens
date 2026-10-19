/**
 * #3552: the review graph and the live dispatch used to share one FactStore
 * for per-file extraction state (`file.content` and the facts derived from it).
 * The graph's providers await (dynamic import, tree-sitter parse), so a
 * same-file dispatch that started during those awaits replaced the shared
 * record and the graph extracted imports from one version and symbols from
 * another. Round 1 re-asserted the graph's snapshot into the shared store, which
 * only moved the race onto the dispatch: it then finished with the graph's
 * STALE `file.content` and `file.functionSummaries` (review F1, F2), and the
 * graph still read derived facts back from the shared store (F3).
 *
 * The invariant pinned here is the private-store boundary: the graph reads and
 * writes a run-local store and never touches the shared one, so
 *   - a graph node is single-version (imports, symbols, lineCount, exported),
 *   - dispatch's facts end on dispatch's version, exactly as with no graph.
 *
 * Gate: the graph dynamic-imports `import-facts.js`, so the module is wrapped
 * with `vi.mock` (original spread in) and the import provider's `run` awaits a
 * test hook either before or after delegating. The hook writes version B to disk
 * and runs a real dispatch fact derivation (`clearFileFactsFor` + `runProviders`,
 * the seam `dispatchLintWithResult` wraps) to completion. That derivation does
 * real `fs/promises` reads and a real tree-sitter parse, so the graph is
 * suspended across genuine macrotasks — a stand-in for a cold grammar load, not
 * a hand-shaped microtask interleave.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({
	armed: undefined as
		| { window: "before-import" | "after-import"; hook: () => Promise<void> }
		| undefined,
}));

vi.mock(
	"../../../clients/dispatch/facts/import-facts.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../clients/dispatch/facts/import-facts.js")
			>();
		const inner = actual.importFactProvider;
		return {
			...actual,
			importFactProvider: {
				...inner,
				async run(...args: Parameters<typeof inner.run>) {
					// Consume the arm so the dispatch the hook starts (which re-enters
					// this wrapper through runProviders) runs the provider unmodified.
					const armed = gate.armed;
					gate.armed = undefined;
					if (armed?.window === "before-import") await armed.hook();
					await inner.run(...args);
					if (armed?.window === "after-import") await armed.hook();
				},
			},
		};
	},
);

import { createDispatchContext } from "../../../clients/dispatch/dispatcher.js";
import { runProviders } from "../../../clients/dispatch/fact-runner.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type { FunctionSummary } from "../../../clients/dispatch/facts/function-facts.js";
import type { ImportEntry } from "../../../clients/dispatch/facts/import-facts.js";
import "../../../clients/dispatch/integration.js"; // registers providers
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../../../clients/review-graph/builder.js";
import { setupTestEnvironment } from "../test-utils.js";

// Version A is what the graph reads: 3 `split("\n")` lines, `beta` exported.
const V_A =
	'import { alpha } from "./alpha.js";\nexport function beta() { return alpha(); }\n';
// Version B is what the racing dispatch reads. It differs from A in imports,
// symbol names, line count (7) and export status (`delta` is module-private),
// so lineCount and `exported` are each distinguishable from version A's (F4).
const V_B =
	'import { gamma } from "./gamma.js";\n\n// delta is module-private\nfunction delta() {\n\treturn gamma();\n}\n';
// Version SEED only exists to give the incremental path a cached graph and a
// dispatch-owned `file.content` before the edit under test.
const V_SEED = "export function seed() { return 1; }\n";

const GRAPH_A = {
	symbols: [{ name: "beta", exported: true }],
	importTargets: ["module:./alpha.js"],
	lineCount: 3,
};
const DISPATCH_B = {
	content: V_B,
	summaryNames: ["delta"],
	importSources: ["./gamma.js"],
};

/** What one graph recorded for `file`: symbols, import targets, line count. */
function graphSummary(
	graph: Awaited<ReturnType<typeof buildOrUpdateGraph>>,
	file: string,
): typeof GRAPH_A {
	const normalized = normalizeMapKey(file);
	const fileNode = graph.nodes.get(`file:${normalized}`);
	return {
		symbols: [...graph.nodes.values()]
			.filter((node) => node.kind === "symbol" && node.filePath === normalized)
			.map((node) => ({
				name: node.symbolName ?? "",
				exported: node.exported === true,
			})),
		importTargets: graph.edges
			.filter(
				(edge) => edge.from === `file:${normalized}` && edge.kind === "imports",
			)
			.map((edge) => edge.to),
		lineCount: fileNode?.metadata?.lineCount as number,
	};
}

type RaceOutcome = {
	mode: string | undefined;
	fired: boolean;
	graph: typeof GRAPH_A;
	dispatch: {
		content: string | undefined;
		summaryNames: string[];
		importSources: string[];
	};
};

/**
 * One real race: the graph reads version A, then a same-file dispatch that
 * reads version B runs to completion inside the graph's import-provider await.
 * `pathKind` picks how the graph gets its bytes: "full" is the tier-3 build
 * (the caller hands the graph its read bytes), "incremental" is the
 * cached-graph update where the graph re-reads disk while a first dispatch
 * already owns `file.content` in the shared store.
 */
async function race(
	pathKind: "full" | "incremental",
	window: "before-import" | "after-import",
): Promise<RaceOutcome> {
	const env = setupTestEnvironment("pi-lens-3552-");
	try {
		const file = path.join(env.tmpDir, "a.ts");
		const store = new FactStore("3552-race");
		const ctx = createDispatchContext(
			file,
			env.tmpDir,
			{ getFlag: () => false },
			store,
		);
		if (pathKind === "incremental") {
			fs.writeFileSync(file, V_SEED);
			await buildOrUpdateGraph(env.tmpDir, [file], store);
			// The dispatch runs AFTER the seeding build: a graph-seeded record is
			// released by the build itself, and this record must be dispatch-owned.
			store.clearFileFactsFor(ctx.filePath);
			await runProviders(ctx);
			store.endDispatchFor(ctx.filePath);
		}
		fs.writeFileSync(file, V_A);
		gate.armed = {
			window,
			hook: async () => {
				fs.writeFileSync(file, V_B);
				store.clearFileFactsFor(ctx.filePath);
				await runProviders(ctx);
				store.endDispatchFor(ctx.filePath);
			},
		};

		const graph = await buildOrUpdateGraph(env.tmpDir, [file], store);

		return {
			mode: getLastGraphBuildInfo().mode,
			fired: gate.armed === undefined,
			graph: graphSummary(graph, file),
			dispatch: {
				content: store.getFileFact<string>(file, "file.content"),
				summaryNames: (
					store.getFileFact<FunctionSummary[]>(
						file,
						"file.functionSummaries",
					) ?? []
				).map((fn) => fn.name),
				importSources: (
					store.getFileFact<ImportEntry[]>(file, "file.imports") ?? []
				).map((entry) => entry.source),
			},
		};
	} finally {
		env.cleanup();
	}
}

const CASES = [
	["full", "before-import"],
	["full", "after-import"],
	["incremental", "before-import"],
	["incremental", "after-import"],
] as const;

describe("review-graph vs a concurrent same-file dispatch (#3552)", () => {
	afterEach(() => {
		gate.armed = undefined;
		clearReviewGraphWorkspaceCache();
	});

	it.each(CASES)(
		"%s build, dispatch starts %s: the graph node is single-version (imports, symbols, lineCount, exported)",
		async (pathKind, window) => {
			const out = await race(pathKind, window);
			expect(out.fired).toBe(true); // the gate fired
			expect(out.mode).toBe(pathKind === "full" ? "full" : "incremental");
			expect(out.graph).toEqual(GRAPH_A);
		},
	);

	it.each(CASES)(
		"%s build, dispatch starts %s: dispatch's file.content stays the bytes dispatch read",
		async (pathKind, window) => {
			const out = await race(pathKind, window);
			expect(out.fired).toBe(true);
			expect(out.dispatch.content).toBe(DISPATCH_B.content);
		},
	);

	it.each(CASES)(
		"%s build, dispatch starts %s: dispatch's derived facts stay on dispatch's version",
		async (pathKind, window) => {
			const out = await race(pathKind, window);
			expect(out.fired).toBe(true);
			expect({
				summaryNames: out.dispatch.summaryNames,
				importSources: out.dispatch.importSources,
			}).toEqual({
				summaryNames: DISPATCH_B.summaryNames,
				importSources: DISPATCH_B.importSources,
			});
		},
	);

	// Recurrence guarded: the run store must be per RUN. A module-level or
	// per-process run store (verify r2, mutation M5) would let two overlapping
	// graph runs on the same file overwrite each other's `file.content` and
	// derived facts across their awaits, exactly the mixed-version node of #3552.
	// Two workspaces (cwd `tmp` and `tmp/sub`) contain the same file, so their
	// builds are distinct (no in-flight dedupe) yet touch one path.
	it("two overlapping graph runs on the same file each stay single-version", async () => {
		const env = setupTestEnvironment("pi-lens-3552-overlap-");
		try {
			const sub = path.join(env.tmpDir, "sub");
			fs.mkdirSync(sub);
			const file = path.join(sub, "a.ts");
			fs.writeFileSync(file, V_A);
			const store = new FactStore("3552-overlap");
			let second: ReturnType<typeof buildOrUpdateGraph> | undefined;
			gate.armed = {
				window: "after-import",
				hook: async () => {
					// Run 1 has read version A and finished its import provider. A
					// second graph run over the same file now reads version B and
					// completes both providers before run 1 resumes.
					fs.writeFileSync(file, V_B);
					second = buildOrUpdateGraph(sub, [file], store);
					await second;
				},
			};

			const first = await buildOrUpdateGraph(env.tmpDir, [file], store);

			expect(gate.armed).toBeUndefined(); // the gate fired
			expect(graphSummary(first, file)).toEqual(GRAPH_A);
			expect(graphSummary(await second!, file)).toEqual({
				symbols: [{ name: "delta", exported: false }],
				importTargets: ["module:./gamma.js"],
				lineCount: 7,
			});
		} finally {
			env.cleanup();
		}
	});
});
