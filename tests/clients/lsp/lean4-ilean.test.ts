import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempDirSync } from "../test-utils.js";
import {
	buildILeanModuleGraph,
	findILeanRoot,
	lookupILeanDeclaration,
	lookupGeneratedCDeclaration,
	lookupExternCDeclaration,
	lookupLeanExternForCSymbol,
	readILeanFile,
	scanAllILeanFiles,
} from "../../../clients/lsp/lean4-ilean.js";

describe("lean4-ilean offline reader", () => {
	it("returns null for workspace without .lake directory", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ilean-empty-"));
		try {
			expect(findILeanRoot(tmpDir)).toBeNull();
			expect(scanAllILeanFiles(tmpDir)).toEqual([]);
			expect(lookupILeanDeclaration(tmpDir, "Foo")).toEqual([]);
			const graph = buildILeanModuleGraph(tmpDir);
			expect(graph.imports.size).toBe(0);
			expect(graph.importedBy.size).toBe(0);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("parses valid .ilean file with declarations and imports", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ilean-test-"));
		try {
			const ileanDir = path.join(tmpDir, ".lake", "build", "lib", "lean", "MyPkg");
			fs.mkdirSync(ileanDir, { recursive: true });
			const samplePath = path.join(ileanDir, "Core.ilean");
			const sampleJson = {
				version: 5,
				module: "MyPkg.Core",
				directImports: [
					["MyPkg.Tactics", false, false, false],
					["Init", false, false, false],
				],
				decls: {
					MyState: [10, 0, 20, 5, 12, 10, 12, 17],
					myTheorem: [25, 0, 30, 10, 25, 8, 25, 17],
				},
				references: {},
			};
			fs.writeFileSync(samplePath, JSON.stringify(sampleJson), "utf-8");

			expect(findILeanRoot(tmpDir)).toBe(
				path.join(tmpDir, ".lake", "build", "lib", "lean"),
			);

			const parsed = readILeanFile(samplePath);
			expect(parsed).not.toBeNull();
			expect(parsed?.module).toBe("MyPkg.Core");
			expect(parsed?.version).toBe(5);
			expect(parsed?.directImports).toEqual(["MyPkg.Tactics", "Init"]);

			const stateDecl = parsed?.decls.get("MyState");
			expect(stateDecl).toBeDefined();
			expect(stateDecl?.name).toBe("MyState");
			expect(stateDecl?.module).toBe("MyPkg.Core");
			expect(stateDecl?.range).toEqual({
				start: { line: 10, character: 0 },
				end: { line: 20, character: 5 },
			});
			expect(stateDecl?.selectionRange).toEqual({
				start: { line: 12, character: 10 },
				end: { line: 12, character: 17 },
			});

			const all = scanAllILeanFiles(tmpDir);
			expect(all).toHaveLength(1);

			const found = lookupILeanDeclaration(tmpDir, "myTheorem");
			expect(found).toHaveLength(1);
			expect(found[0]?.name).toBe("myTheorem");
			expect(found[0]?.selectionRange.start.line).toBe(25);

			const graph = buildILeanModuleGraph(tmpDir);
			expect(graph.imports.get("MyPkg.Core")).toEqual([
				"MyPkg.Tactics",
				"Init",
			]);
			expect(graph.importedBy.get("MyPkg.Tactics")).toEqual(["MyPkg.Core"]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("handles malformed or invalid .ilean files gracefully", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ilean-corrupt-"));
		try {
			const badPath = path.join(tmpDir, "bad.ilean");
			fs.writeFileSync(badPath, "not valid json", "utf-8");
			expect(readILeanFile(badPath)).toBeNull();

			const nonExistent = path.join(tmpDir, "missing.ilean");
			expect(readILeanFile(nonExistent)).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("resolves generated C implementation in .lake/build/ir/", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c-ir-test-"));
		try {
			const irDir = path.join(tmpDir, ".lake", "build", "ir", "MyPkg");
			fs.mkdirSync(irDir, { recursive: true });
			const cFile = path.join(irDir, "Core.c");
			const cCode = `// Lean compiler output
#include <lean/lean.h>
LEAN_EXPORT lean_object* lp_MyPkg_myTheorem(lean_object*);
LEAN_EXPORT lean_object* lp_MyPkg_myTheorem(lean_object* x) {
    return x;
}
`;
			fs.writeFileSync(cFile, cCode, "utf-8");

			const loc = lookupGeneratedCDeclaration(tmpDir, "MyPkg.Core", "myTheorem");
			expect(loc).not.toBeNull();
			expect(loc?.filePath).toBe(cFile);
			expect(loc?.line).toBe(3);
			expect(loc?.symbol).toBe("lp_MyPkg_myTheorem");

			expect(lookupGeneratedCDeclaration(tmpDir, "MyPkg.Core", "nonExistent")).toBeNull();
			expect(lookupGeneratedCDeclaration(tmpDir, "MyPkg.Missing", "myTheorem")).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("resolves extern C declarations and reverse Lean bindings", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c-extern-test-"));
		try {
			const nativeDir = path.join(tmpDir, "src", "native");
			fs.mkdirSync(nativeDir, { recursive: true });
			const cFile = path.join(nativeDir, "ffi.c");
			const cCode = `#include <lean/lean.h>
LEAN_EXPORT lean_object* my_native_c_func(lean_object* a) {
    return a;
}
`;
			fs.writeFileSync(cFile, cCode, "utf-8");

			const leanDir = path.join(tmpDir, "MyPkg");
			fs.mkdirSync(leanDir, { recursive: true });
			const leanFile = path.join(leanDir, "Native.lean");
			const leanCode = `import Init
@[extern "my_native_c_func"]
opaque myNativeFunc (n : Nat) : IO Nat
`;
			fs.writeFileSync(leanFile, leanCode, "utf-8");

			const cLoc = lookupExternCDeclaration(tmpDir, "my_native_c_func");
			expect(cLoc).not.toBeNull();
			expect(cLoc?.filePath).toBe(cFile);
			expect(cLoc?.line).toBe(1);

			const leanLoc = lookupLeanExternForCSymbol(tmpDir, "my_native_c_func");
			expect(leanLoc).not.toBeNull();
			expect(leanLoc?.uri).toContain("Native.lean");
			expect(leanLoc?.range.start.line).toBe(1);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
