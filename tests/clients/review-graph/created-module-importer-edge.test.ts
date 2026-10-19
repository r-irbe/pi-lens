/**
 * #4346: a module created after the review graph was built resolves an import
 * another file left unresolved. A fresh full build gives that importer an
 * `imports` edge to the module; the incremental update reparsed only the new
 * module, so the importer's edge was missing until the next full build. The
 * workspace-diagnostics cache judges a clean entry fresh through the
 * reverse-dependency index patched from this update, so the missing edge let a
 * clean importer outlive a later break of the module it imports.
 *
 * Recurrence pinned: the #4344 r1 review's graph probe (`importers of b.ts =
 * []` after an incremental update, `["src/a.ts"]` after a full build).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	cacheKeyFor,
	isEntryFresh,
} from "../../../clients/lsp/workspace-diagnostics-cache.js";
import { toPosix } from "../../../clients/path-utils.js";
import {
	buildReverseDependencyIndexFromGraph,
	patchReverseDependencyIndex,
} from "../../../clients/reverse-deps.js";
import {
	_getReviewGraphRebuildCountersForTests,
	_resetReviewGraphRebuildCountersForTests,
	buildOrUpdateGraph,
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getGraphImportChanges,
} from "../../../clients/review-graph/builder.js";
import type { ReviewGraph } from "../../../clients/review-graph/types.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];

beforeAll(() => {
	// The full-build arm must not reuse a persisted graph through the
	// incremental path it is the oracle for (#939 review finding 2).
	process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS = "3600000";
});
afterAll(() => {
	delete process.env.PI_LENS_GRAPH_PERSIST_DEBOUNCE_MS;
});
afterEach(() => {
	clearReviewGraphWorkspaceCache();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function relative(root: string, file: string | undefined): string {
	return file ? toPosix(path.relative(root, file)) : "<placeholder>";
}

/** Every `imports` edge between two files, as root-relative pairs. */
function fileImportEdges(graph: ReviewGraph, root: string): string[] {
	const pairs = new Set<string>();
	for (const edge of graph.edges) {
		if (edge.kind !== "imports") continue;
		const from = graph.nodes.get(edge.from)?.filePath;
		const to = graph.nodes.get(edge.to)?.filePath;
		if (!from || !to) continue;
		pairs.add(`${relative(root, from)} -> ${relative(root, to)}`);
	}
	return [...pairs].sort();
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

interface Scenario {
	name: string;
	initial: Record<string, string>;
	created: string;
	createdContent: string;
	importer: string;
}

const SCENARIOS: Scenario[] = [
	{
		name: "a TypeScript relative import",
		initial: {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\nexport const x = b;\n',
			"src/c.ts": "export const c = 1;\n",
		},
		created: "src/b.ts",
		createdContent: "export const b = 1;\n",
		importer: "src/a.ts",
	},
	{
		name: "a Python dotted import under src/",
		initial: {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"src/fixturepkg/__init__.py": "",
			"tools/probe.py":
				"from fixturepkg.new_module import describe\n\nvalue = describe()\n",
			// Names the module's stem but resolves elsewhere (no top-level
			// new_module): the precise resolution must leave it alone.
			"tools/decoy.py": "import new_module\n\nother = 1\n",
		},
		created: "src/fixturepkg/new_module.py",
		createdContent: "def describe():\n    return 1\n",
		importer: "tools/probe.py",
	},
];

for (const seqPath of [false, true]) {
	describe(`an incremental update that creates an imported module (#4346, ${seqPath ? "seq fast path" : "signature diff"})`, () => {
		for (const scenario of SCENARIOS) {
			it(`gives the importer the edge a full build has, for ${scenario.name}`, async () => {
				const pair = fs.mkdtempSync(
					path.join(os.tmpdir(), "pi-lens-4346-graph-"),
				);
				roots.push(pair);
				const incrementalRoot = path.join(pair, "incremental");
				const fullRoot = path.join(pair, "full");
				writeTree(incrementalRoot, scenario.initial);
				writeTree(fullRoot, scenario.initial);
				const created = path.join(incrementalRoot, scenario.created);
				let seq = 0;
				const seqHint = seqPath
					? {
							projectSeq: () => seq,
							getFilesChangedSince: () => (seq > 0 ? [created] : []),
						}
					: undefined;

				clearGraphCache();
				const before = await buildOrUpdateGraph(
					incrementalRoot,
					[],
					new FactStore(),
					seqHint,
				);
				// The module is missing, so no build has the edge yet.
				expect(fileImportEdges(before, incrementalRoot)).not.toContain(
					`${scenario.importer} -> ${scenario.created}`,
				);

				writeTree(incrementalRoot, {
					[scenario.created]: scenario.createdContent,
				});
				writeTree(fullRoot, { [scenario.created]: scenario.createdContent });
				seq++;
				clearGraphCache();
				const incremental = await buildOrUpdateGraph(
					incrementalRoot,
					[created],
					new FactStore(),
					seqHint,
				);
				clearReviewGraphWorkspaceCache(fullRoot);
				clearGraphCache();
				const full = await buildOrUpdateGraph(fullRoot, [], new FactStore());

				expect(fileImportEdges(full, fullRoot)).toContain(
					`${scenario.importer} -> ${scenario.created}`,
				);
				expect(fileImportEdges(incremental, incrementalRoot)).toEqual(
					fileImportEdges(full, fullRoot),
				);
				// The one-step delta names exactly the new module and its real
				// importer: the reverse-dependency index is patched from it, and a
				// decoy that only shares the stem is not reparsed.
				const delta = getGraphImportChanges(incremental);
				expect(
					delta?.changes
						.map((change) => relative(incrementalRoot, change.filePath))
						.sort(),
				).toEqual([scenario.created, scenario.importer].sort());
			});
		}
	});
}

describe("the importer pass's name filter (#4346)", () => {
	// Recurrence: without the filter, every creation resolves every unresolved
	// import in the graph (each an existsSync walk), which grows with the
	// project on the post-write cascade.
	it("resolves only the imports that name the created file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4346-names-"));
		roots.push(root);
		writeTree(root, {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"src/fixturepkg/__init__.py": "",
			"tools/probe.py":
				"from fixturepkg.new_module import describe\n\nvalue = describe()\n",
			"tools/other.py": "import os\nimport json\nimport sys\n\nx = 1\n",
			"tools/more.py": "import collections\nimport typing\n\ny = 2\n",
		});
		clearGraphCache();
		await buildOrUpdateGraph(root, [], new FactStore());
		const created = path.join(root, "src/fixturepkg/new_module.py");
		writeTree(root, {
			"src/fixturepkg/new_module.py": "def describe():\n    return 1\n",
		});
		_resetReviewGraphRebuildCountersForTests();
		clearGraphCache();
		await buildOrUpdateGraph(root, [created], new FactStore());

		expect(
			_getReviewGraphRebuildCountersForTests().createdImportResolutions,
		).toBe(1);
	});
});

describe("the importer pass's trigger (#4346)", () => {
	// Recurrence: #4368 r1 R16 (a surviving mutant). Only a file new to the
	// graph can answer an unresolved import; treating every updated file as
	// created resolves on each edit, the post-write cascade's hot path.
	it("resolves nothing on an update that only edits existing files", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4346-edit-"));
		roots.push(root);
		writeTree(root, {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"src/fixturepkg/__init__.py": "",
			"src/fixturepkg/new_module.py": "def describe():\n    return 1\n",
			// Unresolved, and named by the edited file's stem.
			"tools/probe.py": "import new_module\n\nvalue = 1\n",
		});
		clearGraphCache();
		await buildOrUpdateGraph(root, [], new FactStore());
		const edited = path.join(root, "src/fixturepkg/new_module.py");
		writeTree(root, {
			"src/fixturepkg/new_module.py": "def describe():\n    return 2\n",
		});
		_resetReviewGraphRebuildCountersForTests();
		clearGraphCache();
		await buildOrUpdateGraph(root, [edited], new FactStore());

		expect(
			_getReviewGraphRebuildCountersForTests().createdImportResolutions,
		).toBe(0);
	});
});

describe("the workspace-diagnostics cache on the new edge (#4346)", () => {
	it("refuses a clean importer entry once the module it now imports changes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4346-edge-"));
		roots.push(root);
		writeTree(root, {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\nexport const x = b;\n',
		});
		clearGraphCache();
		const before = await buildOrUpdateGraph(root, [], new FactStore());
		const index = buildReverseDependencyIndexFromGraph({
			cwd: root,
			graph: before,
		});
		const module = path.join(root, "src/b.ts");
		writeTree(root, { "src/b.ts": "export const b = 1;\n" });
		clearGraphCache();
		const after = await buildOrUpdateGraph(root, [module], new FactStore());
		const delta = getGraphImportChanges(after);
		expect(delta).toBeDefined();
		const patched = patchReverseDependencyIndex(index, delta?.changes ?? []);

		// The importer is re-checked after the module exists and answers clean.
		const importer = path.join(root, "src/a.ts");
		const stat = fs.statSync(importer);
		const scannedAt = Date.now();
		const cleanEntry = {
			diagnostics: [],
			count: 0,
			mtimeMs: stat.mtimeMs,
			sizeBytes: stat.size,
			scannedAt,
			scopeKey: "all|",
			depIndexAtScan: true,
		};
		// The cache's own lookup key (`createWorkspaceDiagnosticsCacheContext`).
		const getImports = (file: string): string[] | undefined =>
			patched.imports[cacheKeyFor(file)];
		expect(isEntryFresh(importer, cleanEntry, getImports)).toBe(true);

		// Then the module breaks the import. The importer's bytes never change.
		writeTree(root, { "src/b.ts": "export const renamed = 1;\n" });
		const later = new Date(scannedAt + 60_000);
		fs.utimesSync(module, later, later);
		expect(isEntryFresh(importer, cleanEntry, getImports)).toBe(false);
	});
});
