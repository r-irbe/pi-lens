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
	lookupItpConceptForLeanDeclaration,
	readILeanFile,
	scanAllILeanFiles,
	auditLeanBlueprintStatus,
	generatePedagogicalProofWalkthrough,
} from "../../../clients/lsp/lean4-ilean.js";

describe("lean4-ilean offline reader", () => {
	it("returns null for workspace without .lake directory", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-empty-"),
		);
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
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-test-"),
		);
		try {
			const ileanDir = path.join(
				tmpDir,
				".lake",
				"build",
				"lib",
				"lean",
				"MyPkg",
			);
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
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-corrupt-"),
		);
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
static lean_object* _init_lp_MyPkg_myConst(void) {
    return lean_unsigned_to_nat(10);
}
LEAN_EXPORT lean_object* lp_MyPkg_myBoxedFn___boxed(lean_object* a, lean_object* b) {
    return a;
}
`;
			fs.writeFileSync(cFile, cCode, "utf-8");

			const loc = lookupGeneratedCDeclaration(
				tmpDir,
				"MyPkg.Core",
				"myTheorem",
			);
			expect(loc).not.toBeNull();
			expect(loc?.filePath).toBe(cFile);
			expect(loc?.line).toBe(3);
			expect(loc?.symbol).toBe("lp_MyPkg_myTheorem");

			const constLoc = lookupGeneratedCDeclaration(
				tmpDir,
				"MyPkg.Core",
				"myConst",
			);
			expect(constLoc).not.toBeNull();
			expect(constLoc?.line).toBe(6);
			expect(constLoc?.symbol).toBe("_init_lp_MyPkg_myConst");

			const boxedLoc = lookupGeneratedCDeclaration(
				tmpDir,
				"MyPkg.Core",
				"myBoxedFn",
			);
			expect(boxedLoc).not.toBeNull();
			expect(boxedLoc?.line).toBe(9);
			expect(boxedLoc?.symbol).toBe("lp_MyPkg_myBoxedFn___boxed");

			expect(
				lookupGeneratedCDeclaration(tmpDir, "MyPkg.Core", "nonExistent"),
			).toBeNull();
			expect(
				lookupGeneratedCDeclaration(tmpDir, "MyPkg.Missing", "myTheorem"),
			).toBeNull();
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("resolves extern C declarations and reverse Lean bindings", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-c-extern-test-"),
		);
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

	it("looks up ITP master concepts matching queries", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-itp-test-"));
		try {
			const indexDir = path.join(
				tmpDir,
				"docs",
				"investigation-garden",
				"source-materials",
				"indexes",
			);
			fs.mkdirSync(indexDir, { recursive: true });
			const sampleIndex = {
				version: "1.0.0",
				master_concepts: [
					{
						concept_id: "CONCEPT-HOARE-LOGIC-WEAKEST-PRECONDITION",
						canonical_name: "Hoare Logic & Weakest Preconditions",
						ranganathan_facet: {
							domain_theory: "Deductive Program Verification",
						},
						msc2020: ["68Q60", "03B44"],
						prover_mappings: {
							lean4: {
								primary_tactics: ["wp", "vcgen", "hoare_step"],
								syntax_pattern: "wp [h]",
							},
						},
					},
				],
			};
			fs.writeFileSync(
				path.join(indexDir, "master-authority-index.json"),
				JSON.stringify(sampleIndex, null, 2),
				"utf-8",
			);

			const matches = lookupItpConceptForLeanDeclaration("Hoare", tmpDir);
			expect(matches.length).toBe(1);
			expect(matches[0].conceptId).toBe(
				"CONCEPT-HOARE-LOGIC-WEAKEST-PRECONDITION",
			);
			expect(matches[0].primaryTactics).toContain("wp");
			expect(matches[0].domainTheory).toBe("Deductive Program Verification");

			const tacticMatches = lookupItpConceptForLeanDeclaration("vcgen", tmpDir);
			expect(tacticMatches.length).toBe(1);

			const noMatches = lookupItpConceptForLeanDeclaration(
				"nonexistent-term",
				tmpDir,
			);
			expect(noMatches.length).toBe(0);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("audits lean blueprint status and detects premature leanok, missing leanok, and ghost nodes", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-blueprint-status-"),
		);
		try {
			const leanDir = path.join(tmpDir, "EASCI");
			const bpDir = path.join(tmpDir, "blueprint", "src");
			fs.mkdirSync(leanDir, { recursive: true });
			fs.mkdirSync(bpDir, { recursive: true });

			const sampleLean = `
/-- A fully proven theorem without sorries -/
theorem proven_theorem (n : Nat) : n + 0 = n := by
  rfl

/-- A partially formal theorem with sorry -/
theorem incomplete_theorem (n : Nat) : n * 0 = 0 := by
  sorry

/-- An untracked theorem -/
theorem untracked_theorem (n : Nat) : n = n := by
  rfl
`;
			fs.writeFileSync(path.join(leanDir, "Core.lean"), sampleLean, "utf-8");

			const sampleTex = `
\\begin{theorem}[Proven Theorem]
\\label{thm:proven}
\\lean{proven_theorem}
This theorem is proven.
\\end{theorem}

\\begin{theorem}[Incomplete Theorem]
\\label{thm:incomplete}
\\lean{incomplete_theorem}
\\leanok
This theorem falsely claims leanok.
\\end{theorem}

\\begin{theorem}[Ghost Theorem]
\\label{thm:ghost}
\\lean{nonexistent_theorem}
\\leanok
This theorem does not exist in Lean.
\\end{theorem}
`;
			fs.writeFileSync(path.join(bpDir, "content.tex"), sampleTex, "utf-8");

			const status = auditLeanBlueprintStatus(tmpDir, {
				blueprintDir: "blueprint/src",
				formalizationDir: "EASCI",
			});

			expect(status.leanTheoremsCount).toBe(3);
			expect(status.blueprintTheoremsCount).toBe(3);
			expect(status.prematureLeanokCount).toBe(1);
			expect(status.prematureLeanok[0].leanSymbol).toBe("incomplete_theorem");
			expect(status.missingLeanokCount).toBe(1);
			expect(status.missingLeanok[0].leanSymbol).toBe("proven_theorem");
			expect(status.ghostNodesCount).toBe(1);
			expect(status.ghostNodes[0].leanSymbol).toBe("nonexistent_theorem");
			expect(status.untrackedLeanCount).toBe(1);
			expect(status.untrackedLean[0].leanSymbol).toBe("untracked_theorem");
			expect(status.rendered).toContain(
				"Lean Blueprint Coverage & Integrity Audit",
			);
		} finally {
			removeTempDirSync(tmpDir);
		}
	});

	it("generates pedagogical proof walkthrough with 3-stage mathematical breakdown", () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pedagogical-walkthrough-"),
		);
		try {
			const leanDir = path.join(tmpDir, "EASCI");
			fs.mkdirSync(leanDir, { recursive: true });

			const sampleLean = `
/-- Cauchy-Schwarz inequality for inner products -/
theorem cauchy_schwarz_inequality (u v : Real) : u * v <= u * u + v * v := by
  have h1 : 0 <= (u - v) * (u - v) := by sorry
  have h2 : 2 * (u * v) <= u * u + v * v := by sorry
  sorry
`;
			const filePath = path.join(leanDir, "Analysis.lean");
			fs.writeFileSync(filePath, sampleLean, "utf-8");

			const walkthrough = generatePedagogicalProofWalkthrough(
				tmpDir,
				"cauchy_schwarz_inequality",
				filePath,
			);

			expect(walkthrough).not.toBeNull();
			expect(walkthrough?.symbol).toBe("cauchy_schwarz_inequality");
			expect(walkthrough?.docstring).toContain("Cauchy-Schwarz inequality");
			expect(walkthrough?.milestones.length).toBe(2);
			expect(walkthrough?.milestones[0].text).toContain("have h1");
			expect(walkthrough?.milestones[1].text).toContain("have h2");
			expect(walkthrough?.statement.rigorousLatex).toContain("\\le");
			expect(walkthrough?.statement.rigorousLatex).toContain("\\mathbb{R}");
			expect(walkthrough?.rendered).toContain(
				"Stage 1: Intuitive Mathematical Summary",
			);
			expect(walkthrough?.rendered).toContain(
				"Stage 2: Rigorous Mathematical Formulation",
			);
			expect(walkthrough?.rendered).toContain("Stage 3: Type De-formalization");
		} finally {
			removeTempDirSync(tmpDir);
		}
	});
});
