// flake-shape: in-process-mock — getLSPService and peekLSPService return the shared makeLspServiceDouble to test offline route gating and warm-route binding without spawning lean
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import type { WorkspaceScopeRouteSnapshot } from "../../clients/lsp/index.js";
import {
	initLSPConfig,
	resetLSPConfigStateForTests,
} from "../../clients/lsp/config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import { beginScope } from "../../clients/session-scope.js";
import { createLspNavigationTool } from "../../tools/lsp-navigation.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
	peekService: null as unknown,
}));

vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/capabilities.js")>();
	return {
		...actual,
		getLSPService: () => mocked.service,
		peekLSPService: () => mocked.peekService,
	};
});

const tempDirs: string[] = [];

function parseEnvelope(result: {
	content: Array<{ text?: string }>;
}): Record<string, unknown> {
	return JSON.parse(String(result.content[0]?.text ?? "{}")) as Record<
		string,
		unknown
	>;
}

describe("lsp_navigation admitted-context gate, 5 offline routes, and pure warm-route binding", () => {
	beforeEach(() => {
		setProjectTrustState("trusted");
		resetDegradationLedger();
		resetLSPConfigStateForTests();
		const svc = makeLspServiceDouble({
			supportsLSP: vi.fn().mockReturnValue(true),
			getOperationSupport: vi.fn().mockResolvedValue(null),
			touchFile: vi.fn().mockResolvedValue(undefined),
			workspaceSymbol: vi.fn().mockResolvedValue([]),
			getAdvertisedCommands: vi.fn().mockResolvedValue(["my.cmd"]),
			executeCommand: vi
				.fn()
				.mockResolvedValue({ executed: true, result: "ok" }),
		});
		mocked.service = svc;
		mocked.peekService = svc;
	});

	afterEach(() => {
		resetProjectTrust();
		resetDegradationLedger();
		resetLSPConfigStateForTests();
		for (const dir of tempDirs.splice(0)) {
			removeTempDirSync(dir);
		}
	});

	it("gates all Lean semantic and interactive routes before supportsLSP, getOperationSupport, or touchFile when session or admission is missing", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-nav-gate-"));
		tempDirs.push(tmpDir);
		const leanFile = path.join(tmpDir, "Main.lean");
		fs.writeFileSync(leanFile, "theorem t : 1 = 1 := rfl\n", "utf8");

		// 1. Without live SessionScope handle -> session-unavailable
		const toolNoSession = createLspNavigationTool(() => false);
		const noSessionRes = await toolNoSession.execute(
			"no-session",
			{ operation: "definition", path: leanFile, line: 1, character: 9 },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(noSessionRes.isError).toBe(true);
		const noSessionEnv = parseEnvelope(noSessionRes);
		expect(noSessionEnv.status).toBe("error");
		expect(noSessionEnv.metadata).toMatchObject({
			availability: "unavailable",
			reasonCode: "session-unavailable",
		});

		// 2. With live SessionScope handle but no admitted root -> admission-missing
		const scope = beginScope({ role: "primary" });
		const tool = createLspNavigationTool(
			() => false,
			undefined,
			() => scope.capture(),
		);

		const gatedOps: Array<Record<string, unknown>> = [
			{ operation: "definition", path: leanFile, line: 1, character: 9 },
			{ operation: "implementation", path: leanFile, line: 1, character: 9 },
			{ operation: "moduleImports", path: leanFile },
			{ operation: "moduleImportedBy", path: leanFile },
			{ operation: "typeDefinition", path: leanFile, line: 1, character: 9 },
			{ operation: "declaration", path: leanFile, line: 1, character: 9 },
			{ operation: "references", path: leanFile, line: 1, character: 9 },
			{ operation: "documentSymbol", path: leanFile },
			{ operation: "findSymbol", path: leanFile, query: "t" },
			{
				operation: "prepareCallHierarchy",
				path: leanFile,
				line: 1,
				character: 9,
			},
			{ operation: "workspaceSymbol", path: leanFile, query: "t" },
			{ operation: "hover", path: leanFile, line: 1, character: 9 },
			{ operation: "signatureHelp", path: leanFile, line: 1, character: 9 },
			{ operation: "goal", path: leanFile, line: 1, character: 9 },
			{ operation: "termGoal", path: leanFile, line: 1, character: 9 },
			{ operation: "codeAction", path: leanFile, line: 1, character: 9 },
			{
				operation: "rename",
				path: leanFile,
				line: 1,
				character: 9,
				newName: "t2",
			},
			{
				operation: "rename_file",
				path: leanFile,
				newFilePath: path.join(tmpDir, "Main2.lean"),
			},
			{
				operation: "executeCommand",
				path: leanFile,
				command: "lean.cmd",
			},
			{
				operation: "incomingCalls",
				callHierarchyItem: {
					name: "t",
					kind: 12,
					uri: pathToFileURL(leanFile).href,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					selectionRange: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
				},
			},
			{
				operation: "outgoingCalls",
				callHierarchyItem: {
					name: "t",
					kind: 12,
					uri: pathToFileURL(leanFile).href,
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					selectionRange: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
				},
			},
		];

		for (const params of gatedOps) {
			const res = await tool.execute(
				`gate-${String(params.operation)}`,
				params,
				new AbortController().signal,
				null,
				{ cwd: tmpDir },
			);
			expect(res.isError, String(params.operation)).toBe(true);
			const env = parseEnvelope(res);
			expect(env.status, String(params.operation)).toBe("error");
			expect(env.metadata, String(params.operation)).toMatchObject({
				availability: "unavailable",
				reasonCode: "admission-missing",
			});
		}

		// Zero live LSP service calls occurred across all 22 gated calls
		const svc = mocked.service as {
			supportsLSP: ReturnType<typeof vi.fn>;
			getOperationSupport: ReturnType<typeof vi.fn>;
			touchFile: ReturnType<typeof vi.fn>;
		};
		expect(svc.supportsLSP).not.toHaveBeenCalled();
		expect(svc.getOperationSupport).not.toHaveBeenCalled();
		expect(svc.touchFile).not.toHaveBeenCalled();

		const summary = getDegradationSummary();
		const group = summary.find(
			(entry) => entry.kind === "lean-context-unavailable",
		);
		expect(group?.count).toBeGreaterThanOrEqual(gatedOps.length);
	});

	it("serves the 4 root-confined offline Lean routes, omits @[extern] workspace C expansion, and refuses live-only routes with live-identity-unavailable", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-nav-offline-"),
		);
		tempDirs.push(tmpDir);

		const compilerPath = path.join(tmpDir, "lean");
		fs.writeFileSync(
			compilerPath,
			'#!/bin/sh\necho "Lean (version 4.29.0-rc8, commit 123456)"\n',
			{ mode: 0o755 },
		);

		const modRoot = path.join(tmpDir, "admitted-lib");
		const pkgDir = path.join(modRoot, "MyPkg");
		fs.mkdirSync(pkgDir, { recursive: true });

		const leanFile = path.join(pkgDir, "Core.lean");
		const leanSource = [
			"/-- Core theorem docstring -/",
			'@[extern "my_workspace_c_sym"]',
			"theorem myTheorem (n : Nat) : n = n := by",
			"  have h1 : n = n := rfl",
			"  exact h1",
			"",
		].join("\n");
		fs.writeFileSync(leanFile, leanSource, "utf8");

		// Foreign workspace C file that would have matched under old @[extern] expansion
		const foreignDir = path.join(tmpDir, "src", "native");
		fs.mkdirSync(foreignDir, { recursive: true });
		fs.writeFileSync(
			path.join(foreignDir, "foreign.c"),
			"void my_workspace_c_sym(void) {}\n",
			"utf8",
		);

		// Colocated generated C file under admitted modRoot
		const colocatedC = path.join(pkgDir, "Core.c");
		fs.writeFileSync(
			colocatedC,
			"LEAN_EXPORT lean_object* lp_MyPkg_myTheorem(lean_object* x) {\n  return x;\n}\n",
			"utf8",
		);

		// Colocated .ilean file under admitted modRoot
		fs.writeFileSync(
			path.join(pkgDir, "Core.ilean"),
			JSON.stringify({
				version: 5,
				module: "MyPkg.Core",
				directImports: [["Init", false, false, false]],
				decls: {
					myTheorem: [2, 0, 4, 8, 2, 8, 2, 17],
				},
			}),
			"utf8",
		);

		const configPath = path.join(tmpDir, ".pi-lens.json");
		fs.writeFileSync(
			configPath,
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

		await initLSPConfig(tmpDir);
		const scope = beginScope({ role: "primary" });
		const tool = createLspNavigationTool(
			() => false,
			undefined,
			() => scope.capture(),
		);

		// 1. definition (confined to modRoot, does NOT append foreign.c from @[extern])
		const defRes = await tool.execute(
			"def-1",
			{
				operation: "definition",
				path: leanFile,
				line: 3,
				symbol: "myTheorem",
			},
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(defRes.isError).toBeUndefined();
		const defEnv = parseEnvelope(defRes);
		expect(defEnv.ok).toBe(true);
		expect(defEnv.locations).toHaveLength(1);
		expect((defEnv.locations as Array<{ filePath: string }>)[0]?.filePath).toBe(
			fs.realpathSync(leanFile),
		);

		// 2. implementation (confined to colocated Core.c in modRoot)
		const implRes = await tool.execute(
			"impl-1",
			{
				operation: "implementation",
				path: leanFile,
				line: 3,
				symbol: "myTheorem",
			},
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(implRes.isError).toBeUndefined();
		const implEnv = parseEnvelope(implRes);
		expect(implEnv.ok).toBe(true);
		expect(implEnv.locations).toHaveLength(1);
		expect(
			(implEnv.locations as Array<{ filePath: string }>)[0]?.filePath,
		).toBe(fs.realpathSync(colocatedC));

		// 3. moduleImports & 4. moduleImportedBy
		const impRes = await tool.execute(
			"imp-1",
			{ operation: "moduleImports", path: leanFile },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(impRes.isError).toBeUndefined();
		expect(parseEnvelope(impRes).result).toEqual([
			{ name: "Init", kind: "module" },
		]);

		const impByRes = await tool.execute(
			"impby-1",
			{ operation: "moduleImportedBy", path: leanFile },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(impByRes.isError).toBeUndefined();
		expect(parseEnvelope(impByRes).status).toBe("empty");

		// 5. Live-only Lean operation with admitted context -> live-identity-unavailable
		const hoverRes = await tool.execute(
			"hover-1",
			{ operation: "hover", path: leanFile, line: 3, character: 9 },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(hoverRes.isError).toBe(true);
		expect(parseEnvelope(hoverRes).metadata).toMatchObject({
			availability: "unavailable",
			reasonCode: "live-identity-unavailable",
		});

		// 7. Mutate .pi-lens.json on disk without re-running initLSPConfig -> context-changed!
		fs.writeFileSync(
			configPath,
			`${fs.readFileSync(configPath, "utf8")}\n`,
			"utf8",
		);
		const staleCfgRes = await tool.execute(
			"def-stale-cfg",
			{
				operation: "definition",
				path: leanFile,
				line: 3,
				symbol: "myTheorem",
			},
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(staleCfgRes.isError).toBe(true);
		expect(parseEnvelope(staleCfgRes).metadata).toMatchObject({
			availability: "unavailable",
			reasonCode: "context-changed",
		});
	});

	it("enforces pure warm-route binding for pathless workspaceSymbol and executeCommand", async () => {
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-nav-warm-route-"),
		);
		tempDirs.push(tmpDir);

		const scope = beginScope({ role: "primary" });
		const tool = createLspNavigationTool(
			() => false,
			undefined,
			() => scope.capture(),
		);

		// Case 1: mixed-or-unresolved warm route -> ambiguous-warm-route-unavailable
		const mixedSnapshot: WorkspaceScopeRouteSnapshot = {
			operation: "workspaceSymbol",
			disposition: "mixed-or-unresolved",
			selected: undefined,
			candidates: [],
			isCurrent: () => true,
		};
		(
			mocked.peekService as {
				peekWorkspaceScopeRouteSnapshot?: ReturnType<typeof vi.fn>;
			}
		).peekWorkspaceScopeRouteSnapshot = vi.fn().mockReturnValue(mixedSnapshot);

		const mixedRes = await tool.execute(
			"ws-mixed",
			{ operation: "workspaceSymbol", query: "Foo" },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(mixedRes.isError).toBe(true);
		expect(parseEnvelope(mixedRes).metadata).toMatchObject({
			availability: "unavailable",
			reasonCode: "ambiguous-warm-route-unavailable",
		});

		// Case 2: proven-non-lean warm route that changes mid-flight -> context-changed
		let routeStillCurrent = true;
		const nonLeanSnapshot: WorkspaceScopeRouteSnapshot = {
			operation: "workspaceSymbol",
			disposition: "proven-non-lean",
			selected: {
				key: "typescript:/workspace",
				serverId: "typescript",
				root: "/workspace",
				role: "primary",
				supportsOp: true,
			},
			candidates: [],
			isCurrent: () => routeStillCurrent,
		};
		(
			mocked.peekService as {
				peekWorkspaceScopeRouteSnapshot?: ReturnType<typeof vi.fn>;
			}
		).peekWorkspaceScopeRouteSnapshot = vi
			.fn()
			.mockReturnValue(nonLeanSnapshot);
		(
			mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> }
		).workspaceSymbol = vi.fn().mockImplementation(async () => {
			routeStillCurrent = false;
			return [
				{
					name: "Foo",
					kind: 12,
					location: {
						uri: "file:///workspace/a.ts",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 3 },
						},
					},
				},
			];
		});

		const changedRes = await tool.execute(
			"ws-changed",
			{ operation: "workspaceSymbol", query: "Foo" },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(changedRes.isError).toBe(true);
		expect(parseEnvelope(changedRes).metadata).toMatchObject({
			availability: "unavailable",
			reasonCode: "context-changed",
		});

		// Case 3: proven-non-lean warm route that remains current -> succeeds
		routeStillCurrent = true;
		(
			mocked.service as { workspaceSymbol: ReturnType<typeof vi.fn> }
		).workspaceSymbol = vi.fn().mockResolvedValue([
			{
				name: "Foo",
				kind: 12,
				location: {
					uri: "file:///workspace/a.ts",
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 3 },
					},
				},
			},
		]);
		const okRes = await tool.execute(
			"ws-ok",
			{ operation: "workspaceSymbol", query: "Foo" },
			new AbortController().signal,
			null,
			{ cwd: tmpDir },
		);
		expect(okRes.isError).toBeUndefined();
		expect(parseEnvelope(okRes).ok).toBe(true);
	});
});
