import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchLSP, safeSpawnAsync } = vi.hoisted(() => ({
	launchLSP: vi.fn(),
	safeSpawnAsync: vi.fn(),
}));
vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP,
}));

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import {
	compileLspRegistry,
	loadLSPConfig,
} from "../../../clients/lsp/config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	isLeanWorkspaceLocked,
	LeanServer,
	LSP_SERVERS,
} from "../../../clients/lsp/server.js";
import { removeTempDirSync } from "../test-utils.js";

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

afterEach(() => {
	launchLSP.mockReset();
	safeSpawnAsync.mockReset();
	resetProjectTrust();
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("Lean Lake LSP server", () => {
	it("is registered for Lean files and launches Lake in the project root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-lsp-"));
		dirs.push(root);
		fs.writeFileSync(path.join(root, "lakefile.lean"), "import Lake\n");
		fs.writeFileSync(
			path.join(root, "lean-toolchain"),
			"leanprover/lean4:v4.33.0\n",
		);
		launchLSP.mockResolvedValue(fakeProcess);

		expect(LSP_SERVERS).toContain(LeanServer);
		expect(LeanServer.extensions).toContain(".lean");
		await expect(LeanServer.spawn(root)).resolves.toMatchObject({
			process: fakeProcess,
			source: "direct",
		});
		expect(launchLSP).toHaveBeenCalledWith("lake", ["serve"], { cwd: root });
	});

	// #3750/#4119: `lake serve` cannot analyse a file outside a Lake project, so
	// an empty answer under `RootWithFallback`'s fallback root is unconfirmed,
	// not clean. Pin the trait on the registered row, not only the export.
	it("declares requiresProjectRoot on the registry row", () => {
		expect(
			LSP_SERVERS.find((server) => server.id === "lean")?.requiresProjectRoot,
		).toBe(true);
	});

	// Regression: explicit 4.35/4.36 requests previously launched ambient Lake.
	it("loads a trusted typed Lean context into the registered producer without global module roots", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-lsp-context-"),
		);
		dirs.push(root);
		fs.writeFileSync(path.join(root, "lean-toolchain"), "fixture pin\n");
		const compilerPath = path.join(root, "lean");
		fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
		const context = {
			compilerPath,
			targetVersion: "4.35.0",
			moduleRoots: [root],
		};
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({
				lsp: { serverOverrides: { lean: { leanContext: context } } },
			}),
		);
		vi.stubEnv("LEAN_PATH", "/foreign-global-modules");
		setProjectTrustState("trusted");
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.35.0, fixture)",
			stderr: "",
		});
		launchLSP.mockResolvedValue(fakeProcess);
		const config = await loadLSPConfig(root);
		const server = compileLspRegistry(
			config,
			config.__provenance,
		).registeredServers.find((entry) => entry.id === "lean")!;
		expect(server.requiresProjectRoot).toBe(true);
		expect(server.executesProjectCode).toBe(LeanServer.executesProjectCode);
		await server.spawn(root);
		expect(launchLSP).toHaveBeenCalledWith(
			compilerPath,
			["--server"],
			expect.objectContaining({
				cwd: root,
				env: expect.objectContaining({ LEAN_PATH: root }),
			}),
		);
		expect(JSON.stringify(launchLSP.mock.calls)).not.toContain(
			"foreign-global-modules",
		);
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.33.1, fixture)",
			stderr: "",
		});
		await expect(server.spawn(root)).rejects.toThrow(
			/environment_unavailable.*4\.35\.0.*4\.33\.1/,
		);
		expect(launchLSP).toHaveBeenCalledTimes(1);
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.35.0, fixture)",
			stderr: "",
		});
		fs.writeFileSync(path.join(root, "lake.lock"), "fixture");
		await expect(server.spawn(root)).rejects.toThrow(
			/environment_unavailable.*lock/,
		);
		expect(launchLSP).toHaveBeenCalledTimes(1);
	});

	it("does not fall back to ambient Lake when the schema rejects an explicitly requested context", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-lsp-invalid-context-"),
		);
		dirs.push(root);
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({
				lsp: { serverOverrides: { lean: { leanContext: 42 } } },
			}),
		);
		setProjectTrustState("trusted");
		const config = await loadLSPConfig(root);
		const registry = compileLspRegistry(config, config.__provenance);
		await expect(
			registry.registeredServers
				.find((entry) => entry.id === "lean")!
				.spawn(root),
		).rejects.toThrow(/environment_unavailable.*leanContext/);
		expect(launchLSP).not.toHaveBeenCalled();
	});

	it("checks mixed global compiler and project module-root provenance before admitting context", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-lsp-mixed-context-"),
		);
		const globalDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-lsp-global-context-"),
		);
		dirs.push(root, globalDir);
		const compilerPath = path.join(globalDir, "lean");
		fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
		vi.stubEnv("PI_LENS_HOME", globalDir);
		fs.writeFileSync(
			path.join(globalDir, "config.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						lean: {
							leanContext: {
								compilerPath,
								targetVersion: "4.35.0",
								moduleRoots: [globalDir],
							},
						},
					},
				},
			}),
		);
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: { lean: { leanContext: { moduleRoots: [root] } } },
				},
			}),
		);
		setProjectTrustState("untrusted");
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.35.0, fixture)",
			stderr: "",
		});
		const config = await loadLSPConfig(root);
		const registry = compileLspRegistry(config, config.__provenance);
		await expect(
			registry.registeredServers
				.find((entry) => entry.id === "lean")!
				.spawn(root),
		).rejects.toThrow(/environment_unavailable.*trust/);
		expect(launchLSP).not.toHaveBeenCalled();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("refuses project Lean context under untrusted or unknown pi trust without falling back to ambient Lake", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-lean-lsp-context-trust-"),
		);
		dirs.push(root);
		const compilerPath = path.join(root, "lean");
		fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
		fs.writeFileSync(
			path.join(root, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						lean: {
							leanContext: {
								compilerPath,
								targetVersion: "4.35.0",
								moduleRoots: [root],
							},
						},
					},
				},
			}),
		);
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.35.0, fixture)",
			stderr: "",
		});
		for (const state of ["untrusted", "unknown"] as const) {
			setProjectTrustState(state);
			const config = await loadLSPConfig(root);
			const registry = compileLspRegistry(config, config.__provenance);
			const server = registry.registeredServers.find(
				(entry) => entry.id === "lean",
			)!;
			await expect(server.spawn(root)).rejects.toThrow(
				/environment_unavailable.*trust/,
			);
			expect(registry.serverOverrides.get("lean")?.leanContext).toBeUndefined();
		}
		expect(launchLSP).not.toHaveBeenCalled();
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	});

	it("detects all 4 workspace lock paths + ancestor .lake/build/.lake.lock and switches to lock-safe Mode A without executing project code", () => {
		const outer = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lean-lock-"));
		dirs.push(outer);
		const sub = path.join(outer, "packages", "subpkg");
		fs.mkdirSync(sub, { recursive: true });
		const fakeBin = path.join(outer, "fake-lean-analyzer");
		fs.writeFileSync(fakeBin, "#!/bin/sh\n");
		const prevBin = process.env.LEAN_ANALYZER_BIN;
		process.env.LEAN_ANALYZER_BIN = fakeBin;
		try {
			expect(isLeanWorkspaceLocked(sub)).toBe(false);
			if (typeof LeanServer.executesProjectCode === "function") {
				expect(LeanServer.executesProjectCode(sub)).toBe(true);
			}

			// 1. root/lake.lock
			fs.writeFileSync(path.join(sub, "lake.lock"), "");
			expect(isLeanWorkspaceLocked(sub)).toBe(true);
			if (typeof LeanServer.executesProjectCode === "function") {
				expect(LeanServer.executesProjectCode(sub)).toBe(false);
			}
			fs.unlinkSync(path.join(sub, "lake.lock"));

			// 2. root/.lake/lake.lock
			fs.mkdirSync(path.join(sub, ".lake"), { recursive: true });
			fs.writeFileSync(path.join(sub, ".lake", "lake.lock"), "");
			expect(isLeanWorkspaceLocked(sub)).toBe(true);
			fs.unlinkSync(path.join(sub, ".lake", "lake.lock"));

			// 3. root/.lake/build/.lake.lock
			fs.mkdirSync(path.join(sub, ".lake", "build"), { recursive: true });
			fs.writeFileSync(path.join(sub, ".lake", "build", ".lake.lock"), "");
			expect(isLeanWorkspaceLocked(sub)).toBe(true);
			fs.unlinkSync(path.join(sub, ".lake", "build", ".lake.lock"));

			// 4. ancestor .lake/build/.lake.lock
			fs.mkdirSync(path.join(outer, ".lake", "build"), { recursive: true });
			fs.writeFileSync(path.join(outer, ".lake", "build", ".lake.lock"), "");
			expect(isLeanWorkspaceLocked(sub)).toBe(true);
		} finally {
			if (prevBin === undefined) delete process.env.LEAN_ANALYZER_BIN;
			else process.env.LEAN_ANALYZER_BIN = prevBin;
		}
	});
});
