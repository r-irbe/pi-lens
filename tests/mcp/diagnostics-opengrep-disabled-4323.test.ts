/**
 * #4323: MCP `pilens_diagnostics source=lsp` honours `opengrep.enabled=false`
 * in the global config, as `pilens_analyze` already does.
 *
 * The witness drives the real MCP server (`McpHarness`), whose
 * `createLensDiagnosticsTool` call injects the config-backed flag resolver.
 * Each server gets its own workspace, with project command overrides for the
 * JSON server (the shared fake, answering clean) and for Opengrep (a shim that
 * records each start in a marker file, then runs the same fake). The MCP
 * server declares trusted execution at startup, so the overrides apply.
 *
 * The control server, with an empty global config, starts Opengrep for the
 * same check; that proves the fixture would have started it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { McpHarness, repoRoot, testTimeoutScale } from "./harness.js";

const FAKE_SERVER = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
const OPENGREP_FINDING = "opengrep stand-in finding";

interface Fixture {
	workspace: string;
	probe: string;
	startsMarker: string;
	configPath: string;
}

function makeFixture(globalConfig: Record<string, unknown>): Fixture {
	// The harness removes this directory in `dispose()`.
	const workspace = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4323-mcp-")),
	);
	const startsMarker = path.join(workspace, "opengrep-starts.txt");
	const fakeImport = `import(${JSON.stringify(pathToFileURL(FAKE_SERVER).href)});`;
	const opengrepShim = path.join(workspace, "opengrep-server.mjs");
	fs.writeFileSync(
		opengrepShim,
		[
			'import { appendFileSync } from "node:fs";',
			`appendFileSync(${JSON.stringify(startsMarker)}, process.pid + "\\n");`,
			'process.env.FAKE_LSP_RESPOND_PULL_WITH = "items";',
			'process.env.FAKE_LSP_DIAGNOSTIC_SOURCE = "Semgrep";',
			`process.env.FAKE_LSP_DIAGNOSTIC_MESSAGE = ${JSON.stringify(OPENGREP_FINDING)};`,
			fakeImport,
			"",
		].join("\n"),
	);
	const jsonShim = path.join(workspace, "json-server.mjs");
	fs.writeFileSync(
		jsonShim,
		['process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";', fakeImport, ""].join(
			"\n",
		),
	);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4323-mcp-fixture","private":true}\n',
	);
	// Opengrep roots at the nearest `.git` (clients/lsp/server.ts).
	fs.mkdirSync(path.join(workspace, ".git"));
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				json: { command: [process.execPath, jsonShim] },
				opengrep: { command: [process.execPath, opengrepShim] },
			},
			disabledServers: ["ast-grep", "typos", "zizmor"],
		}),
	);
	const probe = path.join(workspace, "probe.json");
	fs.writeFileSync(probe, '{"a": 1}\n');
	// Outside the workspace's `.pi-lens`, so it is a global config file only.
	const configPath = path.join(workspace, "global-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(globalConfig)}\n`);
	return { workspace, probe, startsMarker, configPath };
}

function starts(marker: string): number {
	if (!fs.existsSync(marker)) return 0;
	return fs.readFileSync(marker, "utf8").split("\n").filter(Boolean).length;
}

/** Runs one `pilens_diagnostics source=lsp` call; returns its text and the
 *  Opengrep start count, read before `dispose()` removes the workspace. */
async function checkThroughMcp(
	globalConfig: Record<string, unknown>,
): Promise<{ text: string; opengrepStarts: number }> {
	const fixture = makeFixture(globalConfig);
	const harness = new McpHarness({
		cwd: fixture.workspace,
		env: {
			PI_LENS_CONFIG_PATH: fixture.configPath,
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
		},
	});
	try {
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "4323-test", version: "0" },
		});
		harness.notify("notifications/initialized");
		const res = await harness.request(
			2,
			"tools/call",
			{
				name: "pilens_diagnostics",
				arguments: {
					source: "lsp",
					path: fixture.probe,
					serverScope: "all",
					waitMs: 3000,
				},
			},
			60_000 * testTimeoutScale,
		);
		const result = res.result as { content: { text: string }[] };
		return {
			text: result.content.map((c) => c.text).join("\n"),
			opengrepStarts: starts(fixture.startsMarker),
		};
	} finally {
		harness.dispose();
	}
}

describe("MCP pilens_diagnostics with opengrep.enabled=false (#4323)", () => {
	it(
		"does not start Opengrep when the global config switches it off",
		async () => {
			const { text, opengrepStarts } = await checkThroughMcp({
				opengrep: { enabled: false },
			});

			expect(opengrepStarts).toBe(0);
			expect(text).not.toContain(OPENGREP_FINDING);
		},
		90_000 * testTimeoutScale,
	);

	it(
		"starts Opengrep and shows its finding when the config leaves it on",
		async () => {
			const { text, opengrepStarts } = await checkThroughMcp({});

			expect(opengrepStarts).toBeGreaterThan(0);
			expect(text).toContain(OPENGREP_FINDING);
		},
		90_000 * testTimeoutScale,
	);
});
