/**
 * Recurrence guarded (#4003): a dist-dependent test losing its precondition
 * and failing with an unnamed `Cannot find module .../dist/...`, or passing
 * only after a sibling built `dist/` first.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireBuiltDist } from "./require-built-dist.js";

const tmpDirs: string[] = [];
function fakeRoot(): string {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-require-built-dist-"),
	);
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("requireBuiltDist (#4003)", () => {
	it("throws naming build:dist and every missing path when dist/ is absent", () => {
		const root = fakeRoot();
		expect(() =>
			requireBuiltDist(root, "clients/lsp/config.js", "clients/lsp/index.js"),
		).toThrow(
			new RegExp(
				`dist/ is not built: .*config\\.js, .*index\\.js missing.*npm run build:dist`,
			),
		);
	});

	it("names only the paths that are missing", () => {
		const root = fakeRoot();
		fs.mkdirSync(path.join(root, "dist", "clients", "lsp"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, "dist", "clients", "lsp", "a.js"), "");
		expect(() => requireBuiltDist(root, "clients/lsp/a.js")).not.toThrow();
		expect(() => requireBuiltDist(root, "clients/lsp/a.js", "b.js")).toThrow(
			/b\.js missing/,
		);
		expect(() =>
			requireBuiltDist(root, "clients/lsp/a.js", "b.js"),
		).not.toThrow(/a\.js/);
	});
});
