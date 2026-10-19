import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	_resetReviewGraphSourcePathMemoForTests,
} from "../../../clients/review-graph/builder.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
} from "../../../clients/review-graph/service.js";
import {
	createCaseAliasFixture,
	createTempFile,
	setupTestEnvironment,
} from "../test-utils.js";

/**
 * Recurrence (#4101): `addJsTsFile` handed `localImportToFile` the caller's
 * spelling of the project root with a CANONICAL file key (`normalizeMapKey`).
 * Whenever the two disagree, `path.relative(root, candidate)` started with
 * `..` and every relative import edge was silently dropped: `directImporters`
 * came back empty and the impact cascade lost its importers.
 *
 * Where the two disagree depends on the host. Windows `normalizeMapKey` is
 * `realpathSync.native`, which expands 8.3 names, junctions and subst drives.
 * The POSIX arm adopts only the on-disk CASING (`adoptCanonicalCasing`) and
 * never resolves a symlink, so on POSIX the divergence exists only on a
 * case-insensitive mount (macOS APFS, `nocase` vfat/ntfs3), which no Linux
 * test box has. The second case below uses the real-filesystem stand-in
 * documented there.
 */
async function directImportersOf(
	cwd: string,
	changed: string[],
	target: string,
): Promise<string[]> {
	const graph = await buildOrUpdateGraph(cwd, changed, new FactStore());
	return computeImpactCascade(graph, target).directImporters;
}

/**
 * A project root whose CALLER spelling (`aliasRoot`, `PROJ`) differs from the
 * canonical key spelling (`realRoot`, `proj`) by case alone. Built by the
 * shared case-alias fixture (a case-variant symlink on a case-sensitive
 * filesystem; the real thing on APFS), which reports `skipReason` when the
 * kernel cannot supply the contract.
 */
function caseAliasedRoot(prefix: string): {
	realRoot: string;
	aliasRoot: string;
	skipReason: string | undefined;
	cleanup: () => void;
} {
	const holder = setupTestEnvironment(prefix);
	const fixture = createCaseAliasFixture(holder.tmpDir, {
		dirName: "proj",
		fileName: "seed.txt",
		content: "",
	});
	return {
		realRoot: path.dirname(fixture.onDisk),
		aliasRoot: path.dirname(fixture.rawMisCased),
		skipReason: fixture.skipReason,
		cleanup: holder.cleanup,
	};
}

const SRC_A = "export function alpha() { return 1; }\n";
const SRC_B = [
	"import { alpha } from './a';",
	"export function beta() { return alpha(); }",
	"",
].join("\n");

describe("review graph with a project root spelled differently from the canonical keys (#4101)", () => {
	afterEach(() => {
		clearGraphCache();
		clearReviewGraphWorkspaceCache();
		_resetReviewGraphSourcePathMemoForTests();
	});

	// A directory junction is the Windows spelling of an OneDrive/profile
	// redirect; `realpathSync.native` expands it in the file keys while the root
	// stays the junction path. Runs on the "Unit tests Windows (advisory)" job.
	// lane: windows-vitest
	it.skipIf(process.platform !== "win32")(
		"keeps the import edge when cwd is a junction to the real root",
		async () => {
			const real = setupTestEnvironment("pi-lens-rg-junction-real-");
			const holder = setupTestEnvironment("pi-lens-rg-junction-link-");
			try {
				const linkRoot = path.join(holder.tmpDir, "project-link");
				fs.symlinkSync(real.tmpDir, linkRoot, "junction");
				const aPath = createTempFile(linkRoot, "src/a.ts", SRC_A);
				const bPath = createTempFile(linkRoot, "src/b.ts", SRC_B);
				// The premise: the key expands the junction, the root does not.
				expect(normalizeMapKey(bPath).toLowerCase()).not.toBe(
					bPath.replace(/\\/g, "/").toLowerCase(),
				);
				const importers = await directImportersOf(
					linkRoot,
					[aPath, bPath],
					aPath,
				);
				expect(importers).toContain(normalizeMapKey(bPath));
			} finally {
				holder.cleanup();
				real.cleanup();
			}
		},
	);

	// lane: Unit tests (Linux shards). Not a Windows case: win32 `path` is
	// already case-insensitive, so the premise cannot hold there. The fixture
	// is the real-filesystem stand-in for a mis-cased `cd` into a
	// case-insensitive mount (see `caseAliasedRoot`).
	it.skipIf(process.platform === "win32")(
		"keeps the import edge when the key differs from cwd by case alone",
		async (ctx) => {
			const { realRoot, aliasRoot, skipReason, cleanup } = caseAliasedRoot(
				"pi-lens-rg-casefold-",
			);
			try {
				if (skipReason) return ctx.skip(skipReason);
				const aPath = createTempFile(aliasRoot, "src/a.ts", SRC_A);
				const bPath = createTempFile(aliasRoot, "src/b.ts", SRC_B);
				// The premise: the key adopts the on-disk casing, the root does not.
				expect(normalizeMapKey(bPath)).toBe(path.join(realRoot, "src/b.ts"));
				expect(normalizeMapKey(aliasRoot)).toBe(realRoot);

				const importers = await directImportersOf(
					aliasRoot,
					[aPath, bPath],
					normalizeMapKey(aPath),
				);
				expect(importers).toContain(normalizeMapKey(bPath));
			} finally {
				cleanup();
			}
		},
	);

	// #4101 sibling: the tsconfig-paths branch of `localImportToFile` hands
	// `resolveAliasedImport` the CANONICAL importer dir, so its targets are
	// canonical while `isWithin` held the caller's spelling of the root.
	it.skipIf(process.platform === "win32")(
		"keeps a tsconfig-paths alias edge when the key differs from cwd by case alone",
		async (ctx) => {
			const { aliasRoot, skipReason, cleanup } = caseAliasedRoot(
				"pi-lens-rg-casefold-alias-",
			);
			try {
				if (skipReason) return ctx.skip(skipReason);
				createTempFile(
					aliasRoot,
					"tsconfig.json",
					JSON.stringify({
						compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
					}),
				);
				const aPath = createTempFile(aliasRoot, "src/a.ts", SRC_A);
				const bPath = createTempFile(
					aliasRoot,
					"src/b.ts",
					SRC_B.replace("'./a'", "'@app/a'"),
				);
				const importers = await directImportersOf(
					aliasRoot,
					[aPath, bPath],
					normalizeMapKey(aPath),
				);
				expect(importers).toContain(normalizeMapKey(bPath));
			} finally {
				cleanup();
			}
		},
	);

	// The other direction of the same containment test: a relative import that
	// resolves to an EXISTING file outside the project root is not an edge.
	it("adds no import edge to an existing file outside the project root", async () => {
		const env = setupTestEnvironment("pi-lens-rg-outside-");
		try {
			const root = path.join(env.tmpDir, "proj");
			const outsidePath = createTempFile(env.tmpDir, "outside/x.ts", SRC_A);
			const bPath = createTempFile(
				root,
				"src/b.ts",
				"import { alpha } from '../../outside/x';\nexport const beta = alpha;\n",
			);
			const importers = await directImportersOf(
				root,
				[bPath],
				normalizeMapKey(outsidePath),
			);
			expect(importers).not.toContain(normalizeMapKey(bPath));
		} finally {
			env.cleanup();
		}
	});

	// Guard against the tempting wrong fix: canonicalizing the root with
	// `fs.realpathSync` alone. POSIX keys keep a symlinked root's own spelling,
	// so a resolved root would NOT contain them and this edge would be lost on
	// every symlinked checkout (macOS `/var` -> `/private/var`). Passes on the
	// pre-fix code by design: it pins the boundary the fix must not cross.
	it.skipIf(process.platform === "win32")(
		"keeps the import edge when cwd is a symlink to the real root on POSIX",
		async () => {
			const real = setupTestEnvironment("pi-lens-rg-symlink-real-");
			const holder = setupTestEnvironment("pi-lens-rg-symlink-link-");
			try {
				const linkRoot = path.join(holder.tmpDir, "project-link");
				fs.symlinkSync(real.tmpDir, linkRoot, "dir");
				const aPath = createTempFile(linkRoot, "src/a.ts", SRC_A);
				const bPath = createTempFile(linkRoot, "src/b.ts", SRC_B);
				const importers = await directImportersOf(
					linkRoot,
					[aPath, bPath],
					aPath,
				);
				expect(importers).toContain(normalizeMapKey(bPath));
			} finally {
				holder.cleanup();
				real.cleanup();
			}
		},
	);
});
