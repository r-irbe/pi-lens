// #2780 (recurrence #2776 shape): the nightly `lens_diagnostics mode=full` row
// is the ONLY remaining night-time guard for the default agent tool. The tool
// mirrors `lsp_diagnostics`' verdict shaping, and the #2776 defect was exactly
// a divergence in that shaping — a server that delivered diagnostics while the
// handler rendered zero primary findings. This file pins the row's verdict
// shaping through the real smoke entry (`runLensFull`), including the
// handshake-census skip that keeps a missing toolchain from reading as a red.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	classifyLensFullResult,
	lensFullPopulation,
	report,
	runLensFull,
} from "../../scripts/smoke-tools.mjs";

const fixture = {
	lang: "typescript",
	serverHint: "probe-primary",
	expectedMessage: "Type 'string' is not assignable to type 'number'.",
};

// The real opted-in fixture, not a hand-shaped stand-in: the row is only ever
// driven by `lensFullPopulation()`, so the test selects the same way.
const lensFixture = lensFullPopulation()[0];

const originalHome = process.env.PI_LENS_HOME;
const tempHomes: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const home of tempHomes.splice(0))
		fs.rmSync(home, { recursive: true, force: true });
	if (originalHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = originalHome;
});

function lensDeps(
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
) {
	return {
		population: [lensFixture],
		ensureTool: vi.fn(async () => "/mock/tool"),
		getInstallAttempt: vi.fn(),
		initLSPConfig: vi.fn(async () => undefined),
		CacheManager: class {
			constructor() {}
		},
		bootstrapFixtureWorkspace: vi.fn(async () => ({
			workspace: "/tmp/pi-lens-lens-full-test-workspace",
			absFile: "/tmp/pi-lens-lens-full-test-workspace/bad.ts",
			cleanup: vi.fn(),
		})),
		createLensDiagnosticsTool: () => ({ execute }),
	};
}

async function runWithCensus(
	state: string,
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
) {
	const home = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lens-full-census-"),
	);
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
	await runLensFull({
		langs: ["typescript"],
		install: false,
		verbose: false,
		deps: lensDeps(execute),
	});
	return output.join("\n");
}

describe("lens_diagnostics mode=full row classification (#2780)", () => {
	it("passes only when the full-mode result reports an LSP primary finding", () => {
		expect(
			classifyLensFullResult(
				{
					content: [
						{
							type: "text",
							text: "Type 'string' is not assignable to type 'number'.",
						},
					],
					details: {
						lspPrimaryDiagnosticsCount: 1,
						lspAuxiliaryDiagnosticsCount: 0,
						totalErrors: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "pass", diags: 1 });
	});

	it("reds findings delivered only outside the primary bucket", () => {
		// #2776 recurrence: the diagnostic reached the result but its source
		// differed from the configured primary, so the primary bucket stayed 0.
		expect(
			classifyLensFullResult(
				{
					details: {
						lspPrimaryDiagnosticsCount: 0,
						lspAuxiliaryDiagnosticsCount: 1,
						totalBlocking: 0,
						totalErrors: 0,
						totalWarnings: 1,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail", diags: 1 });
	});

	it("fails a result whose rendered verdict has no project finding", () => {
		expect(
			classifyLensFullResult(
				{ details: { lspPrimaryDiagnosticsCount: 1, totalErrors: 0 } },
				fixture,
			),
		).toMatchObject({ state: "fail" });
	});

	it("fails when the rendered text omits the fixture's expected message", () => {
		const messageFixture = {
			...fixture,
			expectedMessage: "expected fixture message",
		};
		expect(
			classifyLensFullResult(
				{
					content: [
						{ type: "text", text: "No files diagnosed yet this session." },
					],
					details: { lspPrimaryDiagnosticsCount: 1, totalErrors: 1 },
				},
				messageFixture,
			),
		).toMatchObject({ state: "fail" });
	});

	it("fails when the handler ran but reported no primary finding", () => {
		expect(
			classifyLensFullResult(
				{
					details: {
						lspPrimaryDiagnosticsCount: 0,
						lspAuxiliaryDiagnosticsCount: 0,
					},
				},
				fixture,
			),
		).toMatchObject({ state: "fail" });
	});
});

describe("smoke-tools --lens-full entry (#2780)", () => {
	it("drives the real tool with mode=full refreshRunners=cheap and reports a pass", async () => {
		const calls: Record<string, unknown>[] = [];
		const execute = vi.fn(
			async (_toolCallId: string, params: Record<string, unknown>) => {
				calls.push(params);
				return {
					content: [
						{
							type: "text",
							text: "Type 'string' is not assignable to type 'number'.",
						},
					],
					details: { lspPrimaryDiagnosticsCount: 1, totalErrors: 1 },
				};
			},
		);
		const output = await runWithCensus("pass", execute);

		expect(execute).toHaveBeenCalledTimes(1);
		expect(calls[0].mode).toBe("full");
		expect(calls[0].refreshRunners).toBe("cheap");
		expect(calls[0].paths).toEqual([
			"/tmp/pi-lens-lens-full-test-workspace/bad.ts",
		]);
		expect(output).toContain("1 passed · 0 failed");
		expect(output).toContain("1 primary finding");
	});

	it("keeps a non-pass handshake census row out of the run", async () => {
		// R2-M1 recurrence (same seam as the clean gate): a census row that did
		// not pass must never be admitted, or an unavailable server reads as a
		// verdict-shaping failure.
		const execute = vi.fn(async () => ({
			details: { lspPrimaryDiagnosticsCount: 1 },
		}));
		const output = await runWithCensus("skip", execute);

		expect(execute).not.toHaveBeenCalled();
		expect(output).toContain("⚠  typescript");
		expect(output).toContain("0 passed · 0 failed");
	});

	it("returns a nonzero skip-only result for the gated lane and prints SKIPPED", async () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) =>
			output.push(args.join(" ")),
		);
		const result = await runLensFull({
			langs: ["typescript"],
			install: false,
			verbose: false,
			deps: lensDeps(vi.fn()),
		});

		expect(result).toBe(1);
		expect(output.join("\n")).toContain("SKIPPED: 0 passed · 0 failed");
	});

	it("keeps a non-gated skip-only lane at zero", () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args) =>
			output.push(args.join(" ")),
		);
		const result = report(
			[
				{
					lang: "typescript",
					runner: "typescript-language-server",
					state: "skip",
					detail: "server unavailable",
					diags: 0,
				},
			],
			"LSP handshake (install → spawn → initialize)",
		);

		expect(result).toBe(0);
		expect(output.join("\n")).toContain("SKIPPED: 0 passed · 0 failed");
	});
});
