// flake-shape: in-process-mock — loadBootstrapClients is intercepted so MCP session_start tests stay offline without spawning ambient analyzers
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getILeanScanInvalidationStamp } from "../../../clients/lean-context.js";
import { resetLSPService } from "../../../clients/lsp/capabilities.js";
import {
	getLeanNavigationAdmission,
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import { scanAllILeanFiles } from "../../../clients/lsp/lean4-ilean.js";
import {
	_resetMcpSessionContext,
	getMcpSessionContext,
	peekMcpSessionRuntime,
} from "../../../clients/mcp/session.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { beginScope, retireScope } from "../../../clients/session-scope.js";
import { removeTempDirSync } from "../test-utils.js";

const bootstrapMocks = vi.hoisted(() => ({
	loadImpl: null as (() => Promise<unknown>) | null,
}));

vi.mock("../../../clients/bootstrap.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/bootstrap.js")>();
	return {
		...actual,
		loadBootstrapClients: (...args: unknown[]) =>
			bootstrapMocks.loadImpl
				? bootstrapMocks.loadImpl()
				: (
						actual.loadBootstrapClients as (...a: unknown[]) => Promise<unknown>
					)(...args),
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	bootstrapMocks.loadImpl = null;
	resetProjectTrust();
	_resetMcpSessionContext();
	resetLSPConfigStateForTests();
	resetLSPService();
	for (const dir of tempDirs.splice(0)) {
		removeTempDirSync(dir);
	}
});

describe("lean4-ilean lifecycle, reset, and scope isolation", () => {
	it("whole-service resetLSPService invalidates in-flight scan tickets and bumps invalidation stamp", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-reset-"),
		);
		tempDirs.push(tmpDir);

		const compilerPath = path.join(tmpDir, "lean");
		fs.writeFileSync(compilerPath, "#!/bin/sh\n", { mode: 0o755 });
		const modRoot = path.join(tmpDir, "mod");
		fs.mkdirSync(modRoot, { recursive: true });
		fs.writeFileSync(
			path.join(modRoot, "A.ilean"),
			JSON.stringify({
				version: 5,
				module: "A",
				directImports: [],
				decls: { foo: [0, 0, 0, 5, 0, 0, 0, 3] },
			}),
			"utf8",
		);
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						lean: {
							leanContext: {
								compilerPath,
								targetVersion: "4.29.0-rc8",
								moduleRoots: [modRoot],
							},
						},
					},
				},
			}),
			"utf8",
		);

		setProjectTrustState("trusted");
		await initLSPConfig(tmpDir);
		const admission = getLeanNavigationAdmission(tmpDir);
		expect(admission.status).toBe("available");
		if (admission.status !== "available") return;

		const scope = beginScope({ role: "primary" });
		const stampBefore = getILeanScanInvalidationStamp();

		// Trigger whole-service reset mid-probe
		const scanRes = await scanAllILeanFiles(
			admission,
			scope.capture(),
			undefined,
			{
				probe: (async () => {
					resetLSPService();
					return {
						stdout: "Lean (version 4.29.0-rc8, commit abc)\n",
						stderr: "",
						status: 0,
						signal: null,
					};
				}) as never,
			},
		);

		expect(getILeanScanInvalidationStamp()).toBeGreaterThan(stampBefore);
		expect(scanRes.status).toBe("unavailable");
		if (scanRes.status === "unavailable") {
			expect(scanRes.reasonCode).toBe("context-changed");
		}

		// Negative control: a subsequent scan with no reset completes normally
		const controlRes = await scanAllILeanFiles(
			admission,
			scope.capture(),
			undefined,
			{
				probe: (async () => ({
					stdout: "Lean (version 4.29.0-rc8, commit abc)\n",
					stderr: "",
					status: 0,
					signal: null,
				})) as never,
			},
		);
		expect(controlRes.status).toBe("available");
	});

	it("isolates primary and secondary session scopes and rejects retired handles mid-scan", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-ilean-scopes-"),
		);
		tempDirs.push(tmpDir);

		const compilerPath = path.join(tmpDir, "lean");
		fs.writeFileSync(compilerPath, "#!/bin/sh\n", { mode: 0o755 });
		const modRoot = path.join(tmpDir, "mod");
		fs.mkdirSync(modRoot, { recursive: true });
		fs.writeFileSync(
			path.join(modRoot, "A.ilean"),
			JSON.stringify({
				version: 5,
				module: "A",
				directImports: [],
				decls: {},
			}),
			"utf8",
		);
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({
				lsp: {
					serverOverrides: {
						lean: {
							leanContext: {
								compilerPath,
								targetVersion: "4.29.0-rc8",
								moduleRoots: [modRoot],
							},
						},
					},
				},
			}),
			"utf8",
		);

		setProjectTrustState("trusted");
		await initLSPConfig(tmpDir);
		const admission = getLeanNavigationAdmission(tmpDir);
		expect(admission.status).toBe("available");
		if (admission.status !== "available") return;

		const primaryRuntime = new RuntimeCoordinator();
		const secondaryScope = beginScope({ role: "secondary" });
		const primaryHandle = primaryRuntime.captureSessionGeneration();
		const secondaryHandle = secondaryScope.capture();

		expect(primaryHandle.scopeId).not.toBe(secondaryHandle.scopeId);

		// Retire secondary scope during scan; primary remains live
		const secRes = await scanAllILeanFiles(
			admission,
			secondaryHandle,
			undefined,
			{
				probe: (async () => {
					retireScope(secondaryScope, "secondary-shutdown");
					return {
						stdout: "Lean (version 4.29.0-rc8, commit abc)\n",
						stderr: "",
						status: 0,
						signal: null,
					};
				}) as never,
			},
		);
		expect(secRes.status).toBe("unavailable");
		if (secRes.status === "unavailable") {
			expect(secRes.reasonCode).toBe("session-unavailable");
		}
		expect(primaryHandle.isCurrent()).toBe(true);
	});

	it("prevents an in-flight MCP bootstrap interrupted by _resetMcpSessionContext from republishing resolvedRuntime", async () => {
		let resolveGate!: () => void;
		const gate = new Promise<void>((r) => {
			resolveGate = r;
		});

		bootstrapMocks.loadImpl = async () => {
			await gate;
			return {};
		};

		const pendingPromise = getMcpSessionContext();
		expect(peekMcpSessionRuntime()).toBeUndefined();

		// Reset while loadBootstrapClients() is still pending
		_resetMcpSessionContext();
		resolveGate();

		await expect(pendingPromise).rejects.toThrow(
			/MCP session context reset during bootstrap/,
		);
		// Old bootstrap must NOT have republished resolvedRuntime
		expect(peekMcpSessionRuntime()).toBeUndefined();

		// Subsequent bootstrap succeeds and publishes fresh live runtime
		bootstrapMocks.loadImpl = async () => ({});
		const nextCtx = await getMcpSessionContext();
		expect(peekMcpSessionRuntime()).toBe(nextCtx.runtime);
		expect(nextCtx.runtime.captureSessionGeneration().isCurrent()).toBe(true);
	});
});
