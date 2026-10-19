/**
 * #4368 r1 F2: cold import extraction grew with the square of the file (1600
 * lines 190 ms, 12000 lines 9.2 s) on the diagnostics path. Two causes: the
 * forward-import resolver ran the whole symbol extractor, and the extractor's
 * per-definition helpers (decorators, doc comments) materialized every sibling
 * of each definition, so a module of top-level definitions cost
 * definitions x scope. The review graph's full extraction paid the same.
 *
 * The work is counted in tree nodes materialized through `Node.children`, the
 * unit the quadratic walk spent, so each bound is exact and needs no clock.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractForwardImportPaths } from "../../clients/blocker-freshness.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import {
	buildOrUpdateGraph,
	clearGraphCache,
} from "../../clients/review-graph/builder.js";
import { removeTempDirSync } from "./test-utils.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string, files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	for (const [file, content] of Object.entries(files))
		fs.writeFileSync(path.join(root, file), content);
	return root;
}

/** Tree nodes `run` materializes through `Node.children`. */
async function countChildren(run: () => Promise<unknown>): Promise<number> {
	const { Node } = await loadWebTreeSitter();
	const descriptor = Object.getOwnPropertyDescriptor(
		Node.prototype,
		"children",
	);
	const getter = descriptor?.get;
	if (!descriptor || !getter) throw new Error("Node.children getter");
	let materialized = 0;
	Object.defineProperty(Node.prototype, "children", {
		...descriptor,
		get(this: unknown) {
			const children = getter.call(this) as unknown[];
			materialized += children.length;
			return children;
		},
	});
	try {
		await run();
	} finally {
		Object.defineProperty(Node.prototype, "children", descriptor);
	}
	return materialized;
}

/**
 * A Python module of `definitions` documented top-level functions. Undecorated
 * on purpose: a decorated definition's parent is its small
 * `decorated_definition` wrapper, while a plain one's siblings are the whole
 * module (4 014 000 nodes materialized for 1000 definitions before the fix,
 * 253 500 for 250).
 */
const pythonModule = (definitions: number) =>
	`import os\nfrom pkg.missing import nothing\n${Array.from(
		{ length: definitions },
		(_, i) => `# f${i} adds\ndef f${i}(a, b):\n    return a + b + ${i}\n`,
	).join("\n")}`;

describe("symbol extraction cost (#4368 r1 F2)", () => {
	// Recurrence: #4368 r1 F2, 32 cold files of about 4500 lines took 68 s on
	// the diagnostics path with no deadline.
	it("resolves a four times larger file's imports with at most four times the work", async () => {
		const root = workspace("pi-lens-4368-fwd-cost-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"small.py": pythonModule(250),
			"large.py": pythonModule(1000),
		});
		const small = await countChildren(() =>
			extractForwardImportPaths(root, path.join(root, "small.py")),
		);
		const large = await countChildren(() =>
			extractForwardImportPaths(root, path.join(root, "large.py")),
		);

		expect(large).toBeLessThanOrEqual(Math.max(4 * small, 64));
	});

	// Recurrence: #4368 r1 F2. The import path ran the definitions and
	// references passes as well, three tree queries per file for one answer.
	it("runs one tree query per file to resolve its imports", async () => {
		const root = workspace("pi-lens-4368-fwd-queries-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"m.py": pythonModule(10),
		});
		const { Query } = await loadWebTreeSitter();
		const matches = Query.prototype.matches;
		let queries = 0;
		Query.prototype.matches = function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof matches>
		) {
			queries += 1;
			return matches.apply(this, args);
		};
		try {
			await extractForwardImportPaths(root, path.join(root, "m.py"));
		} finally {
			Query.prototype.matches = matches;
		}

		expect(queries).toBe(1);
	});

	// Recurrence: #4368 r1 F2. The review graph's full extraction of the same
	// 12000-line module took 9.6 s through the decorator and doc-comment
	// helpers.
	it("extracts a four times larger file's symbols with at most about four times the work", async () => {
		const smallRoot = workspace("pi-lens-4368-graph-small-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"m.py": pythonModule(250),
		});
		const largeRoot = workspace("pi-lens-4368-graph-large-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"m.py": pythonModule(1000),
		});
		const build = (root: string) => async () => {
			clearGraphCache();
			await buildOrUpdateGraph(root, [], new FactStore());
		};
		const small = await countChildren(build(smallRoot));
		const large = await countChildren(build(largeRoot));

		expect(large).toBeLessThanOrEqual(5 * small);
	});
});
