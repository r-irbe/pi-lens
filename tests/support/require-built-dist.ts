/**
 * Explicit precondition for a test that genuinely needs the bundled `dist/`
 * tree (#4003). `npm run build` emits compiled twins in place next to each
 * `.ts`; only `npm run build:dist` produces `dist/`. A test that loads a
 * shipped script which itself imports `dist/clients/...` (the LSP fixture
 * harness scripts do, by design) cannot be pointed at the in-place twins: a
 * second copy of a module-level registry would not be the one the script
 * reads. Such a test calls this in `beforeAll` and fails with the named
 * message below instead of an oblique `Cannot find module dist/...`, and
 * instead of passing only after a sibling file (the packaging family's
 * `npm pack` runs `prepare` -> `build:dist` in place) happened to build it.
 *
 * CI's `test` shards get `dist/` from `npm install`'s `prepare` script.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export function requireBuiltDist(
	repoRoot: string,
	...relPaths: string[]
): void {
	const missing = relPaths
		.map((rel) => path.join(repoRoot, "dist", rel))
		.filter((abs) => !fs.existsSync(abs));
	if (missing.length === 0) return;
	throw new Error(
		`dist/ is not built: ${missing.join(", ")} missing. ` +
			"These tests exercise shipped scripts that import dist/; " +
			"run `npm run build:dist` first (`npm run build` does not produce dist/).",
	);
}
