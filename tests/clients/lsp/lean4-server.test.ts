import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	detectFileKind,
	getFileKindLabel,
	getLanguageId,
	KIND_EXTENSIONS,
} from "../../../clients/file-kinds.js";
import { getToolPlan } from "../../../clients/dispatch/plan.js";
import {
	getLspCapableKinds,
	getPrimaryDispatchGroup,
} from "../../../clients/language-policy.js";
import {
	CppServer,
	getServerForExtension,
	Lean4Server,
	LSP_SERVERS,
	resolveLeanFallbackFlags,
} from "../../../clients/lsp/server.js";
import { getStrategy } from "../../../clients/lsp/wait-policy/strategies.js";
import { EXCLUDED_DIRS } from "../../../clients/file-utils.js";
import { isExternalOrVendorFile } from "../../../clients/path-utils.js";
import { isGeneratedOrArtifact } from "../../../clients/generated-artifacts.js";
import {
	detectProjectLanguageProfile,
	rootMarkersForFile,
} from "../../../clients/language-profile.js";

describe("Lean4Server LSP registration and semantics", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const d of tempDirs) {
			try {
				fs.rmSync(d, { recursive: true, force: true });
			} catch {}
		}
		tempDirs.length = 0;
	});

	function makeTempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean4-test-"));
		tempDirs.push(dir);
		return dir;
	}

	it("Lean4Server is registered in LSP_SERVERS", () => {
		expect(LSP_SERVERS).toContain(Lean4Server);
		expect(Lean4Server.id).toBe("lean4");
		expect(Lean4Server.name).toBe("Lean 4 Language Server");
		expect(Lean4Server.extensions).toEqual([".lean"]);
	});

	it("resolves Lean4Server for .lean extension", () => {
		const server = getServerForExtension(".lean");
		expect(server).toBeDefined();
		expect(server?.id).toBe("lean4");
	});

	it("file-kinds correctly identifies .lean files", () => {
		expect(detectFileKind("Main.lean")).toBe("lean4");
		expect(detectFileKind("/path/to/MyTheorem.lean")).toBe("lean4");
		expect(getFileKindLabel("lean4")).toBe("Lean 4");
		expect(getLanguageId("lean4")).toBe("lean4");
		expect(KIND_EXTENSIONS.lean4).toEqual([".lean"]);
	});

	it("language policy registers lean4 as LSP-capable with fallback runner", () => {
		expect(getLspCapableKinds()).toContain("lean4");
		const group = getPrimaryDispatchGroup("lean4", true);
		expect(group).toBeDefined();
		expect(group?.mode).toBe("fallback");
		expect(group?.runnerIds).toEqual(["lsp"]);
		expect(group?.filterKinds).toEqual(["lean4"]);
	});

	it("dispatch plan exposes tool plan for lean4", () => {
		const plan = getToolPlan("lean4");
		expect(plan).toBeDefined();
		expect(plan?.name).toBe("Lean 4 Linting");
		expect(plan?.groups.length).toBeGreaterThan(0);
		expect(plan?.groups[0].runnerIds).toContain("lsp");
	});

	it("detects root from lakefile.lean", async () => {
		const root = makeTempDir();
		const subDir = path.join(root, "EASCI", "Foundations");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(root, "lakefile.lean"), "-- lakefile");
		const file = path.join(subDir, "Logic.lean");
		fs.writeFileSync(file, "-- lean file");

		const detected = await Lean4Server.root(file);
		expect(detected).toBe(root);
	});

	it("detects root from lakefile.toml", async () => {
		const root = makeTempDir();
		const subDir = path.join(root, "src");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(root, "lakefile.toml"), 'name = "test"');
		const file = path.join(subDir, "Main.lean");
		fs.writeFileSync(file, "-- lean file");

		const detected = await Lean4Server.root(file);
		expect(detected).toBe(root);
	});

	it("detects root from lean-toolchain", async () => {
		const root = makeTempDir();
		const subDir = path.join(root, "src");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(root, "lean-toolchain"), "leanprover/lean4:v4.33.1\n");
		const file = path.join(subDir, "Main.lean");
		fs.writeFileSync(file, "-- lean file");

		const detected = await Lean4Server.root(file);
		expect(detected).toBe(root);
	});

	it("falls back to file directory when no root marker exists", async () => {
		const root = makeTempDir();
		const subDir = path.join(root, "standalone");
		fs.mkdirSync(subDir, { recursive: true });
		const file = path.join(subDir, "Scratch.lean");
		fs.writeFileSync(file, "-- standalone");

		const detected = await Lean4Server.root(file);
		expect(detected).toBe(subDir);
	});

	it("configures 25,000ms timeouts for Mathlib elaboration", () => {
		expect(Lean4Server.clientWaitTimeoutMs).toBe(25_000);
		expect(Lean4Server.initializeTimeoutMs).toBe(25_000);
	});

	it("has tuned wait policy in SERVER_STRATEGIES with 5000ms aggregateWaitMs and 200ms debounce", () => {
		const strategy = getStrategy("lean4");
		expect(strategy).toBeDefined();
		expect(strategy.aggregateWaitMs).toBe(5000);
		expect(strategy.debounceMs).toBe(200);
		expect(strategy.pullRetryBudgetMs).toBe(0);
		expect(strategy.seedFirstPush).toBe(false);
	});

	it("excludes .lake from source tree walks and classifies .lake as external/vendor", () => {
		expect(EXCLUDED_DIRS).toContain(".lake");
		const projectRoot = "/home/dev/project";
		const vendorFile = "/home/dev/project/.lake/packages/mathlib/Mathlib/Data/Nat/Basic.lean";
		const buildFile = "/home/dev/project/.lake/build/ir/Main.c";
		const sourceFile = "/home/dev/project/Main.lean";

		expect(isExternalOrVendorFile(vendorFile, projectRoot)).toBe(true);
		expect(isExternalOrVendorFile(buildFile, projectRoot)).toBe(true);
		expect(isExternalOrVendorFile(sourceFile, projectRoot)).toBe(false);
	});

	it("classifies lake-manifest.json as generated lockfile artifact", () => {
		expect(isGeneratedOrArtifact("lake-manifest.json")).toBe(true);
		expect(isGeneratedOrArtifact("/repo/lake-manifest.json")).toBe(true);
	});

	it("provides root markers for Lean 4 files", () => {
		const markers = rootMarkersForFile("Main.lean");
		expect(markers).toContain("lakefile.lean");
		expect(markers).toContain("lakefile.toml");
		expect(markers).toContain("lean-toolchain");
	});

	it("detects lean4 in detectProjectLanguageProfile when lakefile.lean exists", () => {
		const root = makeTempDir();
		fs.writeFileSync(path.join(root, "lakefile.lean"), "-- lakefile");
		const profile = detectProjectLanguageProfile(root);
		expect(profile.detectedKinds).toContain("lean4");
		expect(profile.configured.lean4).toBe(true);
		expect(profile.present.lean4).toBe(true);
	});

	it("integrates Lean 4 root markers and sysroot fallback flags into CppServer (clangd)", () => {
		expect(CppServer.root.rootMarkers).toContain("lakefile.lean");
		expect(CppServer.root.rootMarkers).toContain("lakefile.toml");

		const emptyDir = makeTempDir();
		expect(resolveLeanFallbackFlags(emptyDir)).toBeUndefined();

		const leanDir = "/home/radu/code/tacit-mui/docs/easci/lean";
		if (fs.existsSync(leanDir)) {
			const flags = resolveLeanFallbackFlags(leanDir);
			expect(flags).toBeDefined();
			expect(flags?.some((f) => f.startsWith("-I") && f.includes("include"))).toBe(true);
			expect(flags).toContain("-Wno-unused-parameter");
			expect(flags).toContain("-fvisibility=hidden");
		}
	});
});
