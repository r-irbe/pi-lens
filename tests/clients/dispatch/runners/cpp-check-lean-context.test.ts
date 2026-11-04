// Regression: generated Lean C fell back to clang without target runtime headers.
// Only subprocesses are mocked; runner, registry and per-root config are real.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

import runner from "../../../../clients/dispatch/runners/cpp-check.js";
import {
	compileLspRegistry,
	resetLSPConfigStateForTests,
} from "../../../../clients/lsp/config.js";
import { setSessionRootConfig } from "../../../../clients/lsp/session-roots.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../../clients/project-trust.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../../clients/latency-logger.js";
import { resetDegradationLedger } from "../../../../clients/degradation-ledger.js";

const envs: ReturnType<typeof setupTestEnvironment>[] = [];
afterEach(() => {
	resetLSPConfigStateForTests();
	resetProjectTrust();
	resetDegradationLedger();
	vi.unstubAllEnvs();
	safeSpawnAsync.mockReset();
	for (const env of envs.splice(0)) env.cleanup();
});
function fixture() {
	const env = setupTestEnvironment("pi-lens-cpp-check-lean-context-");
	envs.push(env);
	const filePath = path.join(env.tmpDir, "generated.c");
	fs.writeFileSync(
		filePath,
		"#include <lean/lean.h>\nint main(void) { return nope; }\n",
	);
	return { root: env.tmpDir, filePath };
}
function context(root: string, targetVersion: string) {
	const prefix = path.join(root, targetVersion);
	fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
	fs.mkdirSync(path.join(prefix, "include", "lean"), { recursive: true });
	fs.writeFileSync(
		path.join(prefix, "include", "lean", "lean.h"),
		"/* fixture */",
	);
	const compilerPath = path.join(prefix, "bin", "lean");
	fs.writeFileSync(compilerPath, "fixture", { mode: 0o755 });
	return { compilerPath, targetVersion, moduleRoots: [root] };
}
function admit(root: string, leanContext: ReturnType<typeof context>) {
	setProjectTrustState("trusted");
	setSessionRootConfig(
		root,
		compileLspRegistry({ serverOverrides: { lean: { leanContext } } }),
	);
}

describe("cpp-check scoped Lean runtime context", () => {
	it("uses only the admitted A/B/A target includes and preserves genuine C errors", async () => {
		const { root, filePath } = fixture();
		const a = context(root, "4.35.0");
		const b = context(root, "4.36.0-rc1");
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				const ctx = [a, b].find((entry) => entry.compilerPath === command);
				if (ctx)
					return {
						status: 0,
						stdout:
							args[0] === "--version"
								? `Lean (version ${ctx.targetVersion}, fixture)`
								: path.dirname(path.dirname(command)),
						stderr: "",
					};
				if (args[0] === "--version")
					return { status: 0, stdout: "clang version fixture", stderr: "" };
				return {
					status: 1,
					stdout: "",
					stderr: `${filePath}:2:25: error: use of undeclared identifier 'nope'`,
				};
			},
		);
		for (const selected of [a, b, a]) {
			admit(root, selected);
			const result = await runner.run(
				makeRunnerCtx(filePath, root, { kind: "cxx" }),
			);
			expect(result.status).toBe("failed");
			expect(result.diagnostics[0]?.message).toContain(
				"undeclared identifier 'nope'",
			);
			expect(result.failureKind).toBe("blocking_diagnostics");
			const compile = safeSpawnAsync.mock.calls
				.filter((call) => call[1].includes("-fsyntax-only"))
				.at(-1)!;
			expect(compile[1]).toContain(
				`-I${path.join(path.dirname(path.dirname(selected.compilerPath)), "include")}`,
			);
			const foreign = selected === a ? b : a;
			expect(compile[1].join(" ")).not.toContain(
				path.join(path.dirname(path.dirname(foreign.compilerPath)), "include"),
			);
		}
	});

	it("reports actionable environment-unavailable rather than a target source error without context", async () => {
		const { root, filePath } = fixture();
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "clang version fixture",
			stderr: "",
		});
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		await flushLatencyLog();
		const sink = getLatencyLogPath();
		const offset = fs.existsSync(sink) ? fs.statSync(sink).size : 0;
		const result = await runner.run(
			makeRunnerCtx(filePath, root, { kind: "cxx" }),
		);
		expect(result.failureKind).toBe("unavailable");
		expect(result.failureMessage).toContain("leanContext");
		expect(result.diagnostics[0]?.rule).toBe("environment-unavailable");
		expect(safeSpawnAsync).not.toHaveBeenCalled();
		await flushLatencyLog();
		const rows = fs
			.readFileSync(sink, "utf8")
			.slice(offset)
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(rows).toContainEqual(
			expect.objectContaining({
				phase: "degradation_ledger",
				metadata: expect.objectContaining({
					kind: "runner-empty-result",
					subject: "cpp-check",
					mode: "lean-context-unavailable",
				}),
			}),
		);
	});

	it("declines a wrong compiler version or absent headers without running the C compiler", async () => {
		const { root, filePath } = fixture();
		const a = context(root, "4.35.0");
		admit(root, a);
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: "Lean (version 4.33.1, fixture)",
			stderr: "",
		});
		const mismatch = await runner.run(
			makeRunnerCtx(filePath, root, { kind: "cxx" }),
		);
		expect(mismatch.failureKind).toBe("unavailable");
		expect(mismatch.failureMessage).toMatch(/4\.35\.0.*4\.33\.1/);
		expect(
			safeSpawnAsync.mock.calls.some((call) =>
				call[1].includes("-fsyntax-only"),
			),
		).toBe(false);
		safeSpawnAsync.mockImplementation(
			async (_command: string, args: string[]) => ({
				status: 0,
				stdout:
					args[0] === "--version"
						? "Lean (version 4.35.0, fixture)"
						: path.join(root, "missing-sysroot"),
				stderr: "",
			}),
		);
		const missing = await runner.run(
			makeRunnerCtx(filePath, root, { kind: "cxx" }),
		);
		expect(missing.failureKind).toBe("unavailable");
		expect(missing.failureMessage).toContain("lean/lean.h");
	});

	it("does not mistake a commented or quoted include for a generated Lean dependency", async () => {
		const { root, filePath } = fixture();
		for (const source of [
			"/* #include <lean/lean.h> */\nint bad = nope;",
			'const char* raw = R"(\n#include <lean/lean.h>\n)";\nint bad = nope;',
		]) {
			fs.writeFileSync(filePath, source);
			safeSpawnAsync.mockImplementation(
				async (_command: string, args: string[]) =>
					args[0] === "--version"
						? { status: 0, stdout: "clang version fixture", stderr: "" }
						: {
								status: 1,
								stdout: "",
								stderr: `${filePath}:2:1: error: use of undeclared identifier 'nope'`,
							},
			);
			const result = await runner.run(
				makeRunnerCtx(filePath, root, { kind: "cxx" }),
			);
			expect(result.failureKind).toBe("blocking_diagnostics");
		}
	});

	it("uses the admitted runtime directory with MSVC argv without adding global flags", async () => {
		const { root, filePath } = fixture();
		const a = context(root, "4.35.0");
		admit(root, a);
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				if (command === a.compilerPath)
					return {
						status: 0,
						stdout:
							args[0] === "--version"
								? "Lean (version 4.35.0, fixture)"
								: path.dirname(path.dirname(command)),
						stderr: "",
					};
				if (args.includes("/Zs"))
					return {
						status: 1,
						stdout: `${filePath}(2,25): error C2065: 'nope': undeclared identifier`,
						stderr: "",
					};
				if (command === "cl" && args.length === 0)
					return { status: 0, stdout: "MSVC fixture", stderr: "" };
				return {
					status: null,
					error: new Error("tool not found"),
					failure: "tool-not-found",
					stdout: "",
					stderr: "",
				};
			},
		);
		const result = await runner.run(
			makeRunnerCtx(filePath, root, { kind: "cxx" }),
		);
		expect(result.failureKind).toBe("blocking_diagnostics");
		expect(result.diagnostics[0]?.rule).toBe("C2065");
		const compile = safeSpawnAsync.mock.calls.find((call) =>
			call[1].includes("/Zs"),
		)!;
		expect(compile[1]).toContain(
			`/I${path.join(path.dirname(path.dirname(a.compilerPath)), "include")}`,
		);
	});

	it("keeps context-free ordinary C errors as findings", async () => {
		const { root, filePath } = fixture();
		fs.writeFileSync(filePath, "int main(void) { return nope; }\n");
		safeSpawnAsync.mockImplementation(
			async (_command: string, args: string[]) =>
				args[0] === "--version"
					? { status: 0, stdout: "clang version fixture", stderr: "" }
					: {
							status: 1,
							stdout: "",
							stderr: `${filePath}:1:25: error: use of undeclared identifier 'nope'`,
						},
		);
		const result = await runner.run(
			makeRunnerCtx(filePath, root, { kind: "cxx" }),
		);
		expect(result.status).toBe("failed");
		expect(result.diagnostics[0]?.message).toContain(
			"undeclared identifier 'nope'",
		);
		expect(result.failureKind).toBe("blocking_diagnostics");
	});
});
