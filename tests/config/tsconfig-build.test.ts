import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const readJson = (name: string) =>
	JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

// Recurrence: tsconfig.build emitted only dist/, while normal tests and the
// ordinary TS mutation runner consumed adjacent JS. Normal build passed but
// freshness refused 515 sources. Keep the dev compiler and packaging separate.
describe("tsconfig.build runtime contract", () => {
	it("normal build and ordinary TS mutation share adjacent compiler output", () => {
		const build = readJson("tsconfig.build.json");
		expect(readJson("package.json").scripts.build).toBe(
			"tsc --project tsconfig.build.json",
		);
		expect(build.compilerOptions.outDir).toBeUndefined();
		expect(build.compilerOptions.noEmit).not.toBe(true);
		expect(build.compilerOptions.emitDeclarationOnly).not.toBe(true);
		expect(build.include).toEqual(["**/*.ts"]);
		expect(build.exclude).toContain("tests");
		expect(build.exclude).toContain("dist");
	});

	it("distribution compilation overrides output without moving package entrypoints", () => {
		const dist = readJson("tsconfig.dist.json");
		const pkg = readJson("package.json");
		expect(dist.extends).toBe("./tsconfig.build.json");
		expect(dist.compilerOptions.outDir).toBe("./dist");
		expect(dist.compilerOptions.rootDir).toBe(".");
		expect(dist.compilerOptions.declaration).toBe(false);
		expect(pkg.scripts["build:dist"]).toContain("tsconfig.dist.json");
		expect(pkg.main).toBe("./dist/index.js");
		expect(pkg.pi.extensions).toEqual(["./dist/index.js"]);
		expect(Object.values(pkg.bin)).toEqual([
			"dist/mcp/cli.js",
			"dist/mcp/server.js",
			"dist/mcp/analyze-cli.js",
		]);
	});
});
