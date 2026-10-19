/**
 * #4368 r2: the forward-import parse memo also keys on size, for a
 * filesystem whose timestamps are coarser than two writes (FAT keeps a
 * two-second mtime, some network mounts whole seconds), where a rewrite
 * inside one tick leaves mtime and ctime unchanged. The stat is the host boundary, so the
 * test coarsens it there; the parse, memo and resolver are real.
 *
 * Recurrence: #4368 r1 R13. The size check survived mutation; with ctime in
 * the key it reds only where ctime cannot move, which is this host shape.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

import { extractForwardImportPaths } from "../../clients/blocker-freshness.js";
import { toPosix } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

const roots: string[] = [];
afterEach(() => {
	vi.mocked(fs.statSync).mockReset();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

describe("forward-import memo on a coarse-timestamp filesystem (#4368)", () => {
	it("parses again when the size changes inside one timestamp tick", async () => {
		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4368-coarse-"));
		roots.push(root);
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(path.join(root, "package.json"), '{"name":"g"}\n');
		fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 1;\n");
		fs.writeFileSync(path.join(root, "src/cc.ts"), "export const c = 1;\n");
		const importer = path.join(root, "src/a.ts");
		fs.writeFileSync(importer, 'import { b } from "./b";\n');
		const tick = Math.floor(Date.now() / 2000) * 2000;
		vi.mocked(fs.statSync).mockImplementation(((
			target: fs.PathLike,
			options?: fs.StatSyncOptions,
		) => {
			const stat = actualFs.statSync(target, options) as fs.Stats;
			if (String(target) !== importer) return stat;
			return Object.assign(
				Object.create(Object.getPrototypeOf(stat)) as fs.Stats,
				stat,
				{ mtimeMs: tick, ctimeMs: tick },
			);
		}) as typeof fs.statSync);
		const files = async () =>
			(await extractForwardImportPaths(root, importer)).map((file) =>
				toPosix(path.relative(root, file)),
			);
		expect(await files()).toEqual(["src/b.ts"]);

		fs.writeFileSync(importer, 'import { c } from "./cc";\n');

		expect(await files()).toEqual(["src/cc.ts"]);
	});
});
