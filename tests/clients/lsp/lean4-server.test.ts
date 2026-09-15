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
	getServerForExtension,
	Lean4Server,
	LSP_SERVERS,
} from "../../../clients/lsp/server.js";

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
});
