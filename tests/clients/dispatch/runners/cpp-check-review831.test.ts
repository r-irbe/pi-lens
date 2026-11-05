// flake-shape: in-process-mock — launchLSP and safeSpawnAsync are mocked to observe compiler/Lean-context invocation arguments without spawning external compilers
// Review 831: raw contributions, real content sentinels and lexical boundaries.
import { ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "../../test-utils.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
const { safeSpawnAsync, launchLSP } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	launchLSP: vi.fn(),
}));
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));
vi.mock("../../../../clients/lsp/launch.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/lsp/launch.js")
	>()),
	launchLSP,
}));
import runner from "../../../../clients/dispatch/runners/cpp-check.js";
import {
	loadLSPConfig,
	compileLspRegistry,
	resetLSPConfigStateForTests,
} from "../../../../clients/lsp/config.js";
import { setSessionRootConfig } from "../../../../clients/lsp/session-roots.js";
import {
	setProjectTrustState,
	resetProjectTrust,
} from "../../../../clients/project-trust.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { fileContentProvider } from "../../../../clients/dispatch/facts/file-content.js";
import { validateLeanContext } from "../../../../clients/lean-context.js";

const envs: ReturnType<typeof setupTestEnvironment>[] = [];
afterEach(() => {
	resetLSPConfigStateForTests();
	resetProjectTrust();
	vi.unstubAllEnvs();
	safeSpawnAsync.mockReset();
	launchLSP.mockReset();
	for (const env of envs.splice(0)) env.cleanup();
});
function fixture() {
	const env = setupTestEnvironment("pi-lens-review831-");
	envs.push(env);
	const root = path.join(env.tmpDir, "project");
	const global = path.join(env.tmpDir, "global");
	fs.mkdirSync(root);
	fs.mkdirSync(global);
	vi.stubEnv("PI_LENS_HOME", global);
	vi.stubEnv("PI_LENS_CONFIG_PATH", path.join(global, "config.json"));
	fs.writeFileSync(
		path.join(root, "lean-toolchain"),
		"leanprover/lean4:v4.35.0",
	);
	const prefix = path.join(env.tmpDir, "toolchain");
	fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
	fs.mkdirSync(path.join(prefix, "include", "lean"), { recursive: true });
	const compilerPath = path.join(prefix, "bin", "lean");
	fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
	fs.writeFileSync(
		path.join(prefix, "include", "lean", "lean.h"),
		"/* fixture */",
	);
	const context = {
		compilerPath,
		targetVersion: "4.35.0",
		moduleRoots: [root],
	};
	const file = path.join(root, "generated.c");
	fs.writeFileSync(file, "#include <lean/lean.h>\nint bad = nope;\n");
	safeSpawnAsync.mockImplementation(async (command: string, args: string[]) => {
		if (command === compilerPath)
			return {
				status: 0,
				stdout:
					args[0] === "--version" ? "Lean (version 4.35.0, fixture)" : prefix,
				stderr: "",
			};
		return args[0] === "--version"
			? { status: 0, stdout: "clang version fixture", stderr: "" }
			: {
					status: 1,
					stdout: "",
					stderr: `${file}:2:1: error: malformed or unreadable source`,
				};
	});
	launchLSP.mockResolvedValue({ kill: vi.fn() });
	setProjectTrustState("trusted");
	const write = (where: string, value: unknown) =>
		fs.writeFileSync(
			where,
			JSON.stringify({
				lsp: { serverOverrides: { lean: { leanContext: value } } },
			}),
		);
	return { root, global, context, file, write };
}
async function registry(root: string) {
	const config = await loadLSPConfig(root);
	const admitted = compileLspRegistry(config, config.__provenance);
	setSessionRootConfig(root, admitted);
	return admitted;
}

it.each(["whole", "leaf", "array"])(
	"refuses effective malformed %s contribution in both registered LSP and CPP rather than global A",
	async (kind) => {
		const f = fixture();
		f.write(path.join(f.global, "config.json"), f.context);
		const malformed =
			kind === "whole"
				? 42
				: kind === "leaf"
					? { targetVersion: 42 }
					: { moduleRoots: [f.root, 42] };
		f.write(path.join(f.root, ".pi-lens.json"), malformed);
		const admitted = await registry(f.root);
		const verdict = await admitted.registeredServers
			.find((s) => s.id === "lean")!
			.spawn(f.root)
			.then(
				() => "started",
				(error: Error) => error.message,
			);
		const cpp = await runner.run(
			makeRunnerCtx(f.file, f.root, { kind: "cxx" }),
		);
		expect(verdict).toMatch(/environment_unavailable.*leanContext/);
		expect(cpp.failureKind).toBe("unavailable");
		expect(cpp.failureMessage).toContain(path.join(f.root, ".pi-lens.json"));
		expect(cpp.failureMessage).toContain(
			"/lsp/serverOverrides/lean/leanContext",
		);
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		expect(launchLSP).not.toHaveBeenCalled();
	},
);
it.each(["valid-partial", "full-recovery"])(
	"retains valid context resolution and %s across actual registry and CPP",
	async (kind) => {
		const f = fixture();
		f.write(
			path.join(f.global, "config.json"),
			kind === "full-recovery" ? 42 : { ...f.context, moduleRoots: [] },
		);
		f.write(
			path.join(f.root, ".pi-lens.json"),
			kind === "full-recovery" ? f.context : { moduleRoots: [f.root] },
		);
		const admitted = await registry(f.root);
		expect(admitted.serverOverrides.get("lean")?.leanContext).toEqual(
			f.context,
		);
		await admitted.registeredServers
			.find((s) => s.id === "lean")!
			.spawn(f.root);
		const cpp = await runner.run(
			makeRunnerCtx(f.file, f.root, { kind: "cxx" }),
		);
		expect(cpp.failureKind).toBe("blocking_diagnostics");
		expect(launchLSP.mock.calls[0][0]).toBe(f.context.compilerPath);
	},
);
it("keeps invalid contributions atomic until all supplied axes are replaced by valid higher partials", async () => {
	const f = fixture();
	f.write(path.join(f.global, "config.json"), f.context);
	f.write(path.join(f.root, ".pi-lens.json"), {
		targetVersion: 42,
		moduleRoots: [f.root],
	});
	const nested = path.join(f.root, "nested");
	fs.mkdirSync(nested);
	const nestedConfig = path.join(nested, ".pi-lens.json");
	f.write(nestedConfig, { targetVersion: "4.35.0" });
	const firstConfig = await loadLSPConfig(nested);
	const rejection = firstConfig.__leanContextRejection;
	ok(
		rejection,
		"expected bounded rejection provenance before inspecting its keys",
	);
	expect(Object.keys(rejection).sort()).toEqual(["file", "key", "tier"]);
	const first = compileLspRegistry(firstConfig, firstConfig.__provenance);
	await expect(
		first.registeredServers.find((s) => s.id === "lean")!.spawn(nested),
	).rejects.toThrow(/environment_unavailable/);
	expect(safeSpawnAsync).not.toHaveBeenCalled();
	f.write(nestedConfig, { targetVersion: "4.35.0", moduleRoots: [f.root] });
	const recovered = await registry(nested);
	expect(recovered.serverOverrides.get("lean")?.leanContext).toEqual(f.context);
	await recovered.registeredServers.find((s) => s.id === "lean")!.spawn(nested);
});

it("preserves the native unreadable-file verdict from real file provider null through FactStore to CPP", async () => {
	const f = fixture();
	fs.unlinkSync(f.file);
	const facts = new FactStore();
	const ctx = makeRunnerCtx(f.file, f.root, { kind: "cxx", facts });
	await fileContentProvider.run(ctx, facts);
	expect(facts.getFileFact(f.file, "file.content")).toBeNull();
	const result = await runner.run(ctx);
	expect(result.failureKind).toBe("blocking_diagnostics");
	expect(result.diagnostics[0]?.message).toContain("unreadable source");
	expect(
		safeSpawnAsync.mock.calls.some((call) => call[1].includes("-fsyntax-only")),
	).toBe(true);
});
it.each([
	'#include <lean/lean.h"\nint bad = ;',
	'#include "lean/lean.h>\nint bad = ;',
	"#\ninclude <lean/lean.h>\nint bad = ;",
	"#include <lean/lean.h> junk\nint bad = ;",
	"// continued \\\n#include <lean/lean.h>\nint bad = ;",
	"// continued \\\r\n#include <lean/lean.h>\nint bad = ;",
])(
	"keeps malformed or commented directive on native source-error path: %j",
	async (source) => {
		const f = fixture();
		fs.writeFileSync(f.file, source);
		const result = await runner.run(
			makeRunnerCtx(f.file, f.root, { kind: "cxx" }),
		);
		expect(result.failureKind).toBe("blocking_diagnostics");
		expect(result.diagnostics[0]?.message).toContain("malformed");
	},
);
it.each(['#include "lean/lean.h"\n', "#inc\\\nlude <lean/lean.h>\n"])(
	"recognizes the supported paired logical include: %j",
	async (source) => {
		const f = fixture();
		fs.writeFileSync(f.file, source);
		const result = await runner.run(
			makeRunnerCtx(f.file, f.root, { kind: "cxx" }),
		);
		expect(result.failureKind).toBe("unavailable");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
	},
);
it("rejects compiler symlinks before registry probes rather than erase argv0", async () => {
	const f = fixture();
	const target = path.join(path.dirname(f.context.compilerPath), "lean-real");
	fs.renameSync(f.context.compilerPath, target);
	fs.symlinkSync(target, f.context.compilerPath);
	expect(() => validateLeanContext(f.context)).toThrow(/symlink.*unsupported/);
	f.write(path.join(f.root, ".pi-lens.json"), f.context);
	const admitted = await registry(f.root);
	const cpp = await runner.run(makeRunnerCtx(f.file, f.root, { kind: "cxx" }));
	await expect(
		admitted.registeredServers.find((s) => s.id === "lean")!.spawn(f.root),
	).rejects.toThrow(/environment_unavailable/);
	expect(cpp.failureKind).toBe("unavailable");
	expect(safeSpawnAsync).not.toHaveBeenCalled();
});
