import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchLSP } = vi.hoisted(() => ({ launchLSP: vi.fn() }));
vi.mock("../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/launch.js")>()),
	launchLSP,
}));

import { isLeanWorkspaceLocked, LeanServer, LSP_SERVERS } from "../../../clients/lsp/server.js";
import { removeTempDirSync } from "../test-utils.js";

const dirs: string[] = [];
const fakeProcess = { kill: vi.fn() } as never;

afterEach(() => {
	launchLSP.mockReset();
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
