import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyLspGateResult,
	classifyOfficialDockerGateResult,
	LSP_FIXTURES,
	runCreatedModuleWitness,
	runLspGate,
} from "../../scripts/smoke-tools.mjs";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

const fixture = { lang: "lua", serverHint: "probe-primary" };

const gateFixture = {
	lang: "typescript",
	dir: "tests/fixtures/tool-smoke/typescript",
	file: "bad.ts",
	serverHint: "probe-primary",
	tools: [],
	setup: undefined,
};

const originalHome = process.env.PI_LENS_HOME;
const tempHomes: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const home of tempHomes.splice(0))
		fs.rmSync(home, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
});

function gateDeps(
	execute: () => Promise<unknown>,
	fixtureOverrides: Record<string, unknown> = {},
	hasDockerBuildx = true,
) {
	const selectedFixture = { ...gateFixture, ...fixtureOverrides };
	return {
		population: {
			eligible: [selectedFixture],
			gated: [selectedFixture],
			exempt: [],
		},
		ensureTool: vi.fn(async () => "/mock/tool"),
		getInstallAttempt: vi.fn(),
		initLSPConfig: vi.fn(async () => undefined),
		bootstrapFixtureWorkspace: vi.fn(async () => ({
			workspace: "/tmp/pi-lens-gate-test-workspace",
			absFile: "/tmp/pi-lens-gate-test-workspace/bad.ts",
			cleanup: vi.fn(),
		})),
		createLspDiagnosticsTool: () => ({ execute }),
		adoptProjectTrustFromContext: vi.fn(),
		hasDockerBuildx: vi.fn(() => hasDockerBuildx),
	};
}

async function runGateWithCensus(
	state: string,
	execute: () => Promise<unknown>,
	fixtureOverrides?: Record<string, unknown>,
	hasDockerBuildx = true,
) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gate-census-"));
	tempHomes.push(home);
	process.env.PI_LENS_HOME = home;
	fs.writeFileSync(
		path.join(home, "lsp-handshake-census.json"),
		JSON.stringify({ typescript: { state } }),
	);
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args) =>
		output.push(args.join(" ")),
	);
	const deps = gateDeps(execute, fixtureOverrides, hasDockerBuildx);
	await runLspGate({
		langs: ["typescript"],
		install: false,
		verbose: false,
		deps,
	});
	return { output: output.join("\n"), deps };
}

describe("LSP diagnostics clean-gate classification (#2780/#2776)", () => {
	it("requires the official Docker BuildKit rule, or discloses unavailable buildx", () => {
		// #3939 recurrence: the official server's old fixture produced an empty
		// list, and allowEmptyBaseline turned that unsupported rule set into green.
		const finding = {
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "JSONArgsRecommended" }],
			},
		};
		expect(classifyOfficialDockerGateResult(finding, true)).toMatchObject({
			state: "pass",
		});
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				true,
			),
		).toMatchObject({ state: "fail" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { totalDiagnostics: 0, diagnostics: [] } },
				false,
			),
		).toMatchObject({ state: "skip", detail: "buildx unavailable" });
		expect(
			classifyOfficialDockerGateResult(
				{ details: { unavailable: "official server unavailable" } },
				true,
			),
		).toMatchObject({ state: "skip", detail: "official server unavailable" });
	});

	it("passes only when the real handler reports a primary finding", () => {
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 1,
						auxiliaryDiagnosticsCount: 0,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds diagnostics delivered only outside the primary bucket", () => {
		// #2776 recurrence: a custom primary pushed a finding whose source differed
		// from its server id, so the handler returned a diagnostic but rendered zero
		// primary findings. The nightly gate must catch that provenance drift.
		expect(
			classifyLspGateResult(
				{
					details: {
						totalDiagnostics: 1,
						primaryDiagnosticsCount: 0,
						auxiliaryDiagnosticsCount: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("skips a server whose declared tool is unavailable", () => {
		// #3309 recurrence: installer availability can disagree with a real
		// language-toolchain server. The gate must use the handler's no_clients
		// decision, not an ensureTool preflight.
		expect(classifyLspGateResult(undefined, fixture, true)).toMatchObject({
			state: "skip",
		});
	});

	it("fails when the handler ran but returned no primary finding", () => {
		expect(
			classifyLspGateResult(
				{ details: { totalDiagnostics: 0, primaryDiagnosticsCount: 0 } },
				fixture,
			),
		).toMatchObject({ state: "fail" });
	});
});

describe("smoke-tools --lsp-gate census admission (#3309)", () => {
	it("keeps a non-pass handshake census row unavailable", async () => {
		// R2-M1 recurrence: a census row that did not pass was admitted to the
		// diagnostic handler, so an unavailable handshake could look gated.
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { output } = await runGateWithCensus("skip", execute);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps a handler-owned unavailable result out of the gated census", async () => {
		// R2-M1 companion cell: the handler can discover unavailability after the
		// handshake census passed; that result must retain the ⚠ row semantics.
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "", stderr: "" });
		const execute = vi.fn(async () => {
			await safeSpawnAsync("probe-language-server", []);
			return { details: { unavailable: "probe server unavailable" } };
		});
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		expect(output).toContain("⚠  typescript");
		expect(output).toContain(
			"LSP clean-gate census: gated 0 / handshake-only 0 / unavailable 1",
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(safeSpawnAsync).toHaveBeenCalledOnce();
	});

	it("routes a declared diagnostic code through the gated classifier", async () => {
		const execute = vi.fn(async () => ({
			details: {
				totalDiagnostics: 1,
				primaryDiagnosticsCount: 1,
				diagnostics: [{ code: "DifferentRule" }],
			},
		}));
		const { output } = await runGateWithCensus(
			"pass",
			execute,
			{ expectDiagnosticCode: "AnyDeclaredRule" },
			true,
		);

		// #3939 recurrence: removing the declared-code routing would let the
		// generic primary-finding classifier accept the wrong rule.
		expect(output).toContain("✗  typescript");
		expect(output).toContain(
			"official Docker server did not return AnyDeclaredRule",
		);
	});

	it("adopts the host trust result before driving diagnostics", async () => {
		const execute = vi.fn(async () => ({
			details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
		}));
		const { deps } = await runGateWithCensus("pass", execute);

		expect(deps.adoptProjectTrustFromContext).toHaveBeenCalledOnce();
		const context = deps.adoptProjectTrustFromContext.mock.calls[0][0];
		expect(context).toEqual({ isProjectTrusted: expect.any(Function) });
		expect(context.isProjectTrusted()).toBe(true);
	});
});

// #4320/#4346: the witness's verdicts, through its real entry with a scripted
// language-server answer (the server is the process boundary; the nightly
// runs it against pyright). A witness that cannot red, or that passes when the
// missing import was never reported, would be a vacuous nightly row.
describe("smoke-tools created-module witness (#4320/#4346)", () => {
	const python = LSP_FIXTURES.find(
		(fixture) =>
			fixture.lang === "python" &&
			(fixture as { createdModuleWitness?: unknown }).createdModuleWitness,
	);

	async function witness(reports: (call: number, name: string) => boolean) {
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-created-witness-"),
		);
		tempHomes.push(workspace);
		const calls: string[] = [];
		const execute = vi.fn(async (_id: string, params: { path: string }) => {
			const source = fs.readFileSync(params.path, "utf8");
			const name = /import (\w+)/.exec(source)?.[1] ?? "";
			calls.push(name);
			const missing = reports(
				calls.filter((entry) => entry === name).length,
				name,
			);
			return {
				content: [
					{ text: missing ? `Import "${name}" could not be resolved` : "ok" },
				],
			};
		});
		const touchFile = vi.fn(async () => undefined);
		const rows = await runCreatedModuleWitness(python, {
			workspace,
			execute,
			getLSPService: () => makeLspServiceDouble({ touchFile }),
		});
		return { rows, touchFile, workspace };
	}

	it("passes both cases when the missing import clears on the next call", async () => {
		const { rows, touchFile } = await witness((call) => call === 1);
		expect(rows.map((row) => row.state)).toEqual(["pass", "pass"]);
		// The pi write case syncs the module through the service; the outside
		// case never does.
		expect(touchFile).toHaveBeenCalledOnce();
	});

	it("reds a case whose importer still reports the created module", async () => {
		const { rows } = await witness(() => true);
		expect(rows.map((row) => row.state)).toEqual(["fail", "fail"]);
		expect(rows[1].detail).toContain("still reports");
	});

	it("runs inside the clean gate and counts its red", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-gate-census-"));
		const workspace = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-created-witness-gate-"),
		);
		tempHomes.push(home, workspace);
		process.env.PI_LENS_HOME = home;
		fs.writeFileSync(
			path.join(home, "lsp-handshake-census.json"),
			JSON.stringify({ python: { state: "pass" } }),
		);
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) =>
			output.push(args.join(" ")),
		);
		// Every call reports one primary finding, the module included: the
		// clean gate passes and the witness's importer never clears.
		const execute = vi.fn(async (_id: string, params: { path: string }) => {
			const name = /import (\w+)/.exec(
				fs.readFileSync(params.path, "utf8"),
			)?.[1];
			return {
				details: { totalDiagnostics: 1, primaryDiagnosticsCount: 1 },
				content: [{ text: `Import "${name}" could not be resolved` }],
			};
		});
		fs.writeFileSync(path.join(workspace, "bad.py"), "import os\n");
		const failures = await runLspGate({
			langs: ["python"],
			install: false,
			verbose: false,
			deps: {
				population: { eligible: [python], gated: [python], exempt: [] },
				ensureTool: vi.fn(async () => "/mock/tool"),
				getInstallAttempt: vi.fn(),
				initLSPConfig: vi.fn(async () => undefined),
				bootstrapFixtureWorkspace: vi.fn(async () => ({
					workspace,
					absFile: path.join(workspace, "bad.py"),
					cleanup: vi.fn(),
				})),
				createLspDiagnosticsTool: () => ({ execute }),
				adoptProjectTrustFromContext: vi.fn(),
				getLSPService: () => makeLspServiceDouble(),
			},
		});

		expect(output.join("\n")).toContain("LSP created-module witness");
		expect(failures).toBe(2);
	});

	it("reds a case whose missing import was never reported first", async () => {
		const { rows } = await witness(() => false);
		expect(rows.map((row) => row.detail)).toEqual([
			expect.stringContaining("precondition"),
			expect.stringContaining("precondition"),
		]);
	});
});
