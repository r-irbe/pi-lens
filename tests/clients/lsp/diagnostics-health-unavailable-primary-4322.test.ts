/**
 * #4322: `lsp_diagnostics` falls back to `LSPService.getDiagnostics` when its
 * touch acquires no client, and reads the fallback's health record to tell an
 * answer from the language server apart from one only auxiliaries gave
 * (`unavailablePrimaryServerIds`). The missing-primary direction is pinned in
 * tests/tools/lsp-diagnostics-missing-primary-4322.test.ts; this file pins the
 * no-drop direction: when the JSON server answers beside typos, the record
 * names no unavailable language server.
 *
 * Real LSPService and real clients over a stdio JSON-RPC wire; both the JSON
 * server and typos are the shared fake server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4322-ready-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias, and
// an adopted root is compared against the classifier's realpath.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");

function writeShim(name: string, source: string): string {
	const shim = path.join(workspace, `${name}-server.mjs`);
	fs.writeFileSync(
		shim,
		[
			`process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = ${JSON.stringify(source)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	return shim;
}

describe("the getDiagnostics health record names no unavailable language server when one answered (#4322)", () => {
	let service:
		| {
				shutdown: () => Promise<void>;
				getDiagnostics: (file: string, mode: "document") => Promise<unknown>;
				getDiagnosticsHealth: (
					file: string,
				) => { unavailablePrimaryServerIds?: string[] } | undefined;
		  }
		| undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command overrides are project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		const jsonShim = writeShim("json", "json");
		const typosShim = writeShim("typos", "typos");
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-json-fixture","private":true}\n',
		);
		// typos roots at the nearest `.git` (clients/lsp/server.ts `TyposServer`).
		fs.mkdirSync(path.join(workspace, ".git"));
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: { command: [process.execPath, jsonShim] },
					typos: { command: [process.execPath, typosShim] },
				},
				disabledServers: ["ast-grep", "opengrep", "zizmor"],
			}),
		);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../../clients/lsp/index.js");
		service = lsp.getLSPService() as unknown as typeof service;
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4322-ready-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("lists nothing when the JSON server answers beside the typos auxiliary", async () => {
		fs.writeFileSync(probe, '{"fake-lsp-clean": true}\n');

		await service!.getDiagnostics(probe, "document");

		// The collecting read sets the field whenever it acquired a client; the
		// JSON server answered, so no language server is missing.
		expect(
			service!.getDiagnosticsHealth(probe)?.unavailablePrimaryServerIds,
		).toEqual([]);
	}, 30_000);
});
