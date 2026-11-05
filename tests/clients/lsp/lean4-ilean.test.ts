import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { beginScope, retireScope } from "../../../clients/session-scope.js";
import type { LeanNavigationAdmissionAvailable } from "../../../clients/lsp/config.js";
import {
	auditLeanBlueprintStatus,
	buildILeanModuleGraph,
	clearILeanScanCache,
	findILeanRoot,
	findILeanRoots,
	generatePedagogicalProofWalkthrough,
	lookupExternCDeclaration,
	lookupGeneratedCDeclaration,
	lookupILeanDeclaration,
	lookupItpConceptForLeanDeclaration,
	lookupLeanExternForCSymbol,
	readILeanFile,
	resolveConfinedDeclarationLocations,
	scanAllILeanFiles,
} from "../../../clients/lsp/lean4-ilean.js";
import { removeTempDirSync } from "../test-utils.js";

function makeAdmission(
	servedRoot: string,
	moduleRoots: string[],
	targetVersion = "4.29.0-rc8",
	current = true,
): LeanNavigationAdmissionAvailable {
	const compilerPath = path.join(servedRoot, "lean");
	if (!fs.existsSync(compilerPath)) {
		fs.writeFileSync(compilerPath, "#!/bin/sh\n", { mode: 0o755 });
	}
	const registrationId = {};
	return {
		status: "available",
		admittedContext: {
			compilerPath,
			targetVersion,
			moduleRoots,
		},
		servedRoot,
		registrationId,
		contributingSources: [],
		isCurrent: () => current,
	};
}

function makeProbe(version = "4.29.0-rc8") {
	return vi.fn().mockResolvedValue({
		stdout: `Lean (version ${version}, x86_64-unknown-linux-gnu, commit abcdef)\n`,
		stderr: "",
		status: 0,
		signal: null,
	});
}

describe("lean4-ilean admitted-context reader", () => {
	it("refuses raw workspace strings and missing admission or session handles", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-empty-"),
		);
		try {
			expect(findILeanRoot(tmpDir)).toBeNull();
			expect(findILeanRoots(tmpDir)).toEqual([]);

			const noAdm = await scanAllILeanFiles(null, null);
			expect(noAdm.status).toBe("unavailable");
			if (noAdm.status === "unavailable") {
				expect(noAdm.reasonCode).toBe("admission-missing");
			}

			const scope = beginScope({ role: "primary" });
			const handle = scope.capture();
			retireScope(scope, "test");
			const admission = makeAdmission(tmpDir, [tmpDir]);
			const retiredRes = await scanAllILeanFiles(admission, handle);
			expect(retiredRes.status).toBe("unavailable");
			if (retiredRes.status === "unavailable") {
				expect(retiredRes.reasonCode).toBe("session-unavailable");
			}

			expect(lookupILeanDeclaration(null, "Foo")).toEqual([]);
			const graph = buildILeanModuleGraph(null);
			expect(graph.imports.size).toBe(0);
			expect(graph.importedBy.size).toBe(0);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("scans admitted moduleRoots, parses valid .ilean files, and resolves confined declaration locations", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-test-"),
		);
		try {
			const modRoot = path.join(tmpDir, ".lake", "build", "lib", "lean");
			const pkgDir = path.join(modRoot, "MyPkg");
			fs.mkdirSync(pkgDir, { recursive: true });

			const samplePath = path.join(pkgDir, "Core.ilean");
			const sampleJson = {
				version: 5,
				module: "MyPkg.Core",
				directImports: [
					["MyPkg.Tactics", false, false, false],
					["Init", false, false, false],
				],
				decls: {
					MyState: [1, 0, 2, 10, 1, 4, 1, 11],
					myTheorem: [4, 0, 5, 5, 4, 8, 4, 17],
				},
				references: {},
			};
			fs.writeFileSync(samplePath, JSON.stringify(sampleJson), "utf-8");

			// Colocated source under the same admitted moduleRoot
			const leanSourceLines = [
				"-- header",
				"def MyState : Nat := 0",
				"  -- body",
				"",
				"theorem myTheorem : 1 = 1 := by",
				"  rfl",
				"",
			];
			fs.writeFileSync(
				path.join(pkgDir, "Core.lean"),
				leanSourceLines.join("\n"),
				"utf-8",
			);

			const admission = makeAdmission(tmpDir, [modRoot]);
			expect(findILeanRoot(admission)).toBe(fs.realpathSync(modRoot));
			expect(findILeanRoots(admission)).toEqual([fs.realpathSync(modRoot)]);

			const parsed = readILeanFile(
				samplePath,
				"MyPkg/Core",
				fs.realpathSync(modRoot),
			);
			expect(parsed).not.toBeNull();
			expect(parsed?.module).toBe("MyPkg.Core");
			expect(parsed?.version).toBe(5);
			expect(parsed?.directImports).toEqual(["MyPkg.Tactics", "Init"]);

			const scope = beginScope({ role: "primary" });
			const scanRes = await scanAllILeanFiles(
				admission,
				scope.capture(),
				undefined,
				{ probe: makeProbe() as never },
			);
			expect(scanRes.status).toBe("available");
			if (scanRes.status !== "available") return;
			expect(scanRes.items).toHaveLength(1);

			const found = lookupILeanDeclaration(scanRes.snapshot, "myTheorem");
			expect(found).toHaveLength(1);
			expect(found[0]?.name).toBe("myTheorem");
			expect(found[0]?.selectionRange.start.line).toBe(4);

			const resolved = resolveConfinedDeclarationLocations(found);
			expect(resolved.status).toBe("available");
			if (resolved.status === "available") {
				expect(resolved.locations).toHaveLength(1);
				expect(resolved.locations[0]?.filePath).toBe(
					fs.realpathSync(path.join(pkgDir, "Core.lean")),
				);
			}

			const graph = buildILeanModuleGraph(scanRes.snapshot);
			expect(graph.imports.get("MyPkg.Core")).toEqual([
				"MyPkg.Tactics",
				"Init",
			]);
			expect(graph.importedBy.get("MyPkg.Tactics")).toEqual(["MyPkg.Core"]);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("rejects malformed or schema-mismatched .ilean artifacts fail-closed without partial graph success", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-corrupt-"),
		);
		try {
			const badPath = path.join(tmpDir, "bad.ilean");
			fs.writeFileSync(badPath, "not valid json", "utf-8");
			expect(readILeanFile(badPath)).toBeNull();

			const admission = makeAdmission(tmpDir, [tmpDir]);
			const scope = beginScope({ role: "primary" });
			const res = await scanAllILeanFiles(
				admission,
				scope.capture(),
				undefined,
				{ probe: makeProbe() as never },
			);
			expect(res.status).toBe("unavailable");
			if (res.status === "unavailable") {
				expect(res.reasonCode).toBe("artifact-unavailable");
			}
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("ignores ambient LEAN_INDEX_PACKAGES and .lake/packages unless explicitly listed in admittedContext.moduleRoots", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-pkgs-"),
		);
		const prevEnv = process.env.LEAN_INDEX_PACKAGES;
		try {
			const mainRoot = path.join(tmpDir, ".lake", "build", "lib", "lean");
			const mainPkg = path.join(mainRoot, "MyPkg");
			const unAdmittedPkgRoot = path.join(
				tmpDir,
				".lake",
				"packages",
				"mathlib",
				".lake",
				"build",
				"lib",
				"lean",
			);
			const unAdmittedPkg = path.join(unAdmittedPkgRoot, "Mathlib");
			fs.mkdirSync(mainPkg, { recursive: true });
			fs.mkdirSync(unAdmittedPkg, { recursive: true });

			fs.writeFileSync(
				path.join(mainPkg, "Main.ilean"),
				JSON.stringify({
					version: 5,
					module: "MyPkg.Main",
					directImports: [],
					decls: { mainThm: [0, 0, 0, 10, 0, 0, 0, 7] },
				}),
				"utf-8",
			);
			fs.writeFileSync(
				path.join(unAdmittedPkg, "Dep.ilean"),
				JSON.stringify({
					version: 5,
					module: "Mathlib.Dep",
					directImports: [],
					decls: { depThm: [0, 0, 0, 10, 0, 0, 0, 6] },
				}),
				"utf-8",
			);

			process.env.LEAN_INDEX_PACKAGES = "1";
			const admission = makeAdmission(tmpDir, [mainRoot]);
			const scope = beginScope({ role: "primary" });
			const scanRes = await scanAllILeanFiles(
				admission,
				scope.capture(),
				undefined,
				{ probe: makeProbe() as never },
			);
			expect(scanRes.status).toBe("available");
			if (scanRes.status === "available") {
				expect(scanRes.items).toHaveLength(1);
				expect(scanRes.items[0]?.module).toBe("MyPkg.Main");
				expect(lookupILeanDeclaration(scanRes.snapshot, "depThm")).toEqual([]);
			}
		} finally {
			if (prevEnv === undefined) {
				delete process.env.LEAN_INDEX_PACKAGES;
			} else {
				process.env.LEAN_INDEX_PACKAGES = prevEnv;
			}
			clearILeanScanCache();
			removeTempDirSync(tmpDir);
		}
	});

	it("resolves generated C implementation only under the same admitted moduleRoot and never falls back to .lake/build/ir", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c-ir-test-"));
		try {
			const modRoot = path.join(tmpDir, "admitted-root");
			const pkgDir = path.join(modRoot, "MyPkg");
			fs.mkdirSync(pkgDir, { recursive: true });
			const cFile = path.join(pkgDir, "Core.c");
			const cCode = `// Lean compiler output
#include <lean/lean.h>
LEAN_EXPORT lean_object* lp_MyPkg_myTheorem(lean_object*);
LEAN_EXPORT lean_object* lp_MyPkg_myTheorem(lean_object* x) {
    return x;
}
static lean_object* _init_lp_MyPkg_myConst(void) {
    return lean_unsigned_to_nat(10);
}
LEAN_EXPORT lean_object* lp_MyPkg_myBoxedFn___boxed(lean_object* a, lean_object* b) {
    return a;
}
`;
			fs.writeFileSync(cFile, cCode, "utf-8");

			// Also create an unadmitted .lake/build/ir file to verify it is never read
			const ambientIr = path.join(tmpDir, ".lake", "build", "ir", "MyPkg");
			fs.mkdirSync(ambientIr, { recursive: true });
			fs.writeFileSync(
				path.join(ambientIr, "AmbientOnly.c"),
				"LEAN_EXPORT lean_object* lp_MyPkg_ambientFn(lean_object* x) { return x; }\n",
				"utf-8",
			);

			const loc = lookupGeneratedCDeclaration(
				modRoot,
				"MyPkg.Core",
				"myTheorem",
			);
			expect(loc).not.toBeNull();
			expect(loc?.filePath).toBe(fs.realpathSync(cFile));
			expect(loc?.line).toBe(3);
			expect(loc?.symbol).toBe("lp_MyPkg_myTheorem");

			const constLoc = lookupGeneratedCDeclaration(
				modRoot,
				"MyPkg.Core",
				"myConst",
			);
			expect(constLoc?.line).toBe(6);
			expect(constLoc?.symbol).toBe("_init_lp_MyPkg_myConst");

			const boxedLoc = lookupGeneratedCDeclaration(
				modRoot,
				"MyPkg.Core",
				"myBoxedFn",
			);
			expect(boxedLoc?.line).toBe(9);
			expect(boxedLoc?.symbol).toBe("lp_MyPkg_myBoxedFn___boxed");

			// Ambient .lake/build/ir is ignored
			expect(
				lookupGeneratedCDeclaration(tmpDir, "MyPkg.AmbientOnly", "ambientFn"),
			).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("generates pedagogical proof walkthrough from an admitted observation and refuses raw workspace string", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pedagogical-walkthrough-"),
		);
		try {
			const leanDir = path.join(tmpDir, "EASCI");
			fs.mkdirSync(leanDir, { recursive: true });

			const sampleLean = `/-- Cauchy-Schwarz inequality for inner products -/
theorem cauchy_schwarz_inequality (u v : Real) : u * v <= u * u + v * v := by
  have h1 : 0 <= (u - v) * (u - v) := by sorry
  have h2 : 2 * (u * v) <= u * u + v * v := by sorry
  sorry
`;
			const filePath = path.join(leanDir, "Analysis.lean");
			fs.writeFileSync(filePath, sampleLean, "utf-8");
			fs.writeFileSync(
				path.join(leanDir, "Analysis.ilean"),
				JSON.stringify({
					version: 5,
					module: "Analysis",
					directImports: [],
					decls: {
						cauchy_schwarz_inequality: [0, 0, 4, 7, 1, 8, 1, 33],
					},
				}),
				"utf-8",
			);

			// Raw workspace string is refused
			expect(
				generatePedagogicalProofWalkthrough(
					tmpDir,
					"cauchy_schwarz_inequality",
					filePath,
				),
			).toBeNull();

			const admission = makeAdmission(tmpDir, [leanDir]);
			const scope = beginScope({ role: "primary" });
			const scanRes = await scanAllILeanFiles(
				admission,
				scope.capture(),
				undefined,
				{ probe: makeProbe() as never },
			);
			expect(scanRes.status).toBe("available");
			if (scanRes.status !== "available") return;

			const walkthrough = generatePedagogicalProofWalkthrough(
				scanRes.snapshot,
				"cauchy_schwarz_inequality",
			);

			expect(walkthrough).not.toBeNull();
			expect(walkthrough?.symbol).toBe("cauchy_schwarz_inequality");
			expect(walkthrough?.docstring).toContain("Cauchy-Schwarz inequality");
			expect(walkthrough?.milestones.length).toBe(2);
			expect(walkthrough?.statement.rigorousLatex).toContain("\\le");
			expect(walkthrough?.statement.rigorousLatex).toContain("\\mathbb{R}");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("preserves extern C lookup, ITP ontology lookup, and blueprintStatus audit", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-c-extern-test-"),
		);
		try {
			const nativeDir = path.join(tmpDir, "src", "native");
			fs.mkdirSync(nativeDir, { recursive: true });
			const cFile = path.join(nativeDir, "ffi.c");
			fs.writeFileSync(
				cFile,
				"LEAN_EXPORT lean_object* my_native_c_func(lean_object* a) {\n return a;\n}\n",
				"utf-8",
			);

			const leanDir = path.join(tmpDir, "MyPkg");
			fs.mkdirSync(leanDir, { recursive: true });
			fs.writeFileSync(
				path.join(leanDir, "Native.lean"),
				'import Init\n@[extern "my_native_c_func"]\nopaque myNativeFunc (n : Nat) : IO Nat\n',
				"utf-8",
			);

			expect(
				lookupExternCDeclaration(tmpDir, "my_native_c_func")?.filePath,
			).toBe(cFile);
			expect(
				lookupLeanExternForCSymbol(tmpDir, "my_native_c_func")?.uri,
			).toContain("Native.lean");

			const indexDir = path.join(
				tmpDir,
				"docs",
				"investigation-garden",
				"source-materials",
				"indexes",
			);
			fs.mkdirSync(indexDir, { recursive: true });
			fs.writeFileSync(
				path.join(indexDir, "master-authority-index.json"),
				JSON.stringify({
					version: "1.0.0",
					master_concepts: [
						{
							concept_id: "CONCEPT-HOARE",
							canonical_name: "Hoare Logic",
							ranganathan_facet: { domain_theory: "Verification" },
							msc2020: ["68Q60"],
							prover_mappings: { lean4: { primary_tactics: ["wp"] } },
						},
					],
				}),
				"utf-8",
			);
			expect(lookupItpConceptForLeanDeclaration("Hoare", tmpDir)).toHaveLength(
				1,
			);

			const bpDir = path.join(tmpDir, "blueprint", "src");
			fs.mkdirSync(bpDir, { recursive: true });
			fs.writeFileSync(
				path.join(leanDir, "Core.lean"),
				"theorem proven_theorem (n : Nat) : n = n := by\n  rfl\n",
				"utf-8",
			);
			fs.writeFileSync(
				path.join(bpDir, "content.tex"),
				"\\begin{theorem}\\label{thm:p}\\lean{proven_theorem}\\leanok\\end{theorem}\n",
				"utf-8",
			);
			const bp = auditLeanBlueprintStatus(tmpDir, {
				blueprintDir: "blueprint/src",
				formalizationDir: "MyPkg",
			});
			expect(bp.leanTheoremsCount).toBe(1);
			expect(bp.blueprintTheoremsCount).toBe(1);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
