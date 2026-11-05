import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiLensConfig } from "../../clients/config-resolve.js";
import { setupTestEnvironment } from "./test-utils.js";

const envs: ReturnType<typeof setupTestEnvironment>[] = [];

afterEach(() => {
	for (const env of envs.splice(0)) env.cleanup();
});

function fixture() {
	const env = setupTestEnvironment("pi-lens-cfg-lean-rej-");
	envs.push(env);
	const homeDir = path.join(env.tmpDir, "home");
	const globalDir = path.join(homeDir, ".pi-lens");
	const projectDir = path.join(homeDir, "workspace");
	const nestedDir = path.join(projectDir, "packages", "sub");
	fs.mkdirSync(globalDir, { recursive: true });
	fs.mkdirSync(nestedDir, { recursive: true });
	const globalConfigPath = path.join(globalDir, "config.json");
	const projectConfigPath = path.join(projectDir, ".pi-lens.json");
	const nestedConfigPath = path.join(nestedDir, ".pi-lens.json");
	return {
		homeDir,
		globalDir,
		globalConfigPath,
		projectDir,
		projectConfigPath,
		nestedDir,
		nestedConfigPath,
		writeLeanContext(target: string, leanContext: unknown) {
			fs.writeFileSync(
				target,
				JSON.stringify({
					lsp: { serverOverrides: { lean: { leanContext } } },
				}),
			);
		},
		resolve(cwd = nestedDir) {
			return resolvePiLensConfig({
				cwd,
				globalConfigPath,
				globalDir,
				homeDir,
			});
		},
	};
}

describe("config-resolve LeanContext rejection provenance and source digests", () => {
	it("preserves insertion-order first survivor across whole-invalid, single-axis, atomic multi-axis, overwrite, and delete/reinsert recovery", () => {
		const f = fixture();

		// 1. Whole-object invalid at global tier taints all 3 axes with key: undefined
		f.writeLeanContext(f.globalConfigPath, 42);
		const wholeInvalid = f.resolve();
		expect(wholeInvalid.leanContextRejection).toEqual({
			tier: "global",
			file: f.globalConfigPath,
			key: undefined,
		});

		// 2. Partial valid at project tier recovers compilerPath + targetVersion, leaving moduleRoots tainted from global
		f.writeLeanContext(f.projectConfigPath, {
			compilerPath: "/opt/lean/bin/lean",
			targetVersion: "4.35.0",
		});
		const partialRecovery = f.resolve();
		expect(partialRecovery.leanContextRejection).toEqual({
			tier: "global",
			file: f.globalConfigPath,
			key: undefined,
		});

		// 3. Single-axis invalid at nested tier overwrites targetVersion without reordering moduleRoots (global remains first survivor)
		f.writeLeanContext(f.nestedConfigPath, {
			targetVersion: 99,
		});
		const overwriteWithoutReorder = f.resolve();
		expect(overwriteWithoutReorder.leanContextRejection).toEqual({
			tier: "global",
			file: f.globalConfigPath,
			key: undefined,
		});

		// 4. Delete/reinsert: valid global + invalid multi-axis at project + valid partial at nested
		f.writeLeanContext(f.globalConfigPath, {
			compilerPath: "/opt/lean/bin/lean",
			targetVersion: "4.35.0",
			moduleRoots: [f.projectDir],
		});
		f.writeLeanContext(f.projectConfigPath, {
			targetVersion: 42,
			moduleRoots: [f.projectDir, 99],
		});
		f.writeLeanContext(f.nestedConfigPath, {
			targetVersion: "4.35.0",
		});
		const atomicRemaining = f.resolve();
		expect(atomicRemaining.leanContextRejection).toEqual({
			tier: "project",
			file: f.projectConfigPath,
			key: undefined,
		});

		// 5. Full recovery across tiers clears leanContextRejection
		f.writeLeanContext(f.nestedConfigPath, {
			targetVersion: "4.35.0",
			moduleRoots: [f.projectDir],
		});
		const recovered = f.resolve();
		expect(recovered.leanContextRejection).toBeUndefined();
	});

	it("captures read-time SHA-256 digests and existence state for candidate config paths without mutating after disk edits", () => {
		const f = fixture();
		f.writeLeanContext(f.projectConfigPath, {
			compilerPath: "/opt/lean/bin/lean",
			targetVersion: "4.35.0",
			moduleRoots: [f.projectDir],
		});
		const originalBytes = fs.readFileSync(f.projectConfigPath);
		const expectedSha = createHash("sha256")
			.update(originalBytes)
			.digest("hex");

		const res = f.resolve();
		const projectEntry = res.contributingConfigSources.find(
			(entry) => entry.file === f.projectConfigPath,
		);
		expect(projectEntry).toEqual({
			file: f.projectConfigPath,
			tier: "project",
			exists: true,
			sha256: expectedSha,
			byteLength: originalBytes.byteLength,
		});

		const nestedEntry = res.contributingConfigSources.find(
			(entry) => entry.file === f.nestedConfigPath,
		);
		expect(nestedEntry).toEqual({
			file: f.nestedConfigPath,
			tier: "nested-project",
			exists: false,
		});

		// Mutate the project file on disk and create the previously absent nested file;
		// the already-resolved contributingConfigSources snapshot remains immutable.
		f.writeLeanContext(f.projectConfigPath, {
			compilerPath: "/opt/other/bin/lean",
			targetVersion: "4.36.0",
			moduleRoots: [f.projectDir],
		});
		f.writeLeanContext(f.nestedConfigPath, {
			targetVersion: "4.36.0",
		});

		expect(
			res.contributingConfigSources.find(
				(entry) => entry.file === f.projectConfigPath,
			)?.sha256,
		).toBe(expectedSha);
		expect(
			res.contributingConfigSources.find(
				(entry) => entry.file === f.nestedConfigPath,
			)?.exists,
		).toBe(false);
	});
});
