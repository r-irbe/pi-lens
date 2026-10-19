/**
 * #4322: the same false clean with no auxiliary at all. When the JSON
 * language server cannot start and no auxiliary is enabled, the touch acquires
 * no client and the tool falls back to `getDiagnostics`, which acquires none
 * either. Its empty answer reached the empty-result classifier, which reads a
 * missing capability snapshot as clean: the file printed "confirmed clean"
 * beside "LSP unavailable", retired its blockers, and a batch cached the clean
 * verdict for the next identical check.
 *
 * These cases drive the REAL `lsp_diagnostics` handler and the real
 * LSPService. The JSON server's command is overridden to a path that does not
 * exist, and every auxiliary is disabled, so no client ever starts.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	getFileDiagnostics,
	reconcileScanDiagnostics,
} from "../../clients/widget-state.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const env = setupTestEnvironment("pi-lens-4322-noclient-");
// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
const workspace = fs.realpathSync(env.tmpDir);
const probe = path.join(workspace, "probe.json");
const secondProbe = path.join(workspace, "second.json");
const thirdProbe = path.join(workspace, "third.json");

type LatencyRow = {
	phase?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
};

/**
 * Runs `work` with the latency sink on: `logLatency` writes nothing in test
 * mode (`isTestMode`, read live), and this case reads the record it writes.
 */
async function withLatencySink<T>(work: () => Promise<T>): Promise<T> {
	const saved = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	try {
		return await work();
	} finally {
		if (saved === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = saved;
	}
}

/** The real latency sink's lines, after a flush. */
async function latencyLines(): Promise<string[]> {
	await flushLatencyLog();
	const logPath = getLatencyLogPath();
	return fs.existsSync(logPath)
		? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
		: [];
}

/** `phase` rows for `file` from line `from` on. */
async function latencyRows(
	phase: string,
	file: string,
	from: number,
): Promise<LatencyRow[]> {
	const name = path.basename(file).toLowerCase();
	return (await latencyLines())
		.slice(from)
		.map((line) => JSON.parse(line) as LatencyRow)
		.filter(
			(row) =>
				row.phase === phase &&
				String(row.filePath ?? "")
					.toLowerCase()
					.endsWith(name),
		);
}

async function diagnose(
	serverScope: "primary" | "all",
	target: { path: string } | { paths: string[] },
	onConfirmedNoBlockers?: (info: { coveredSources: string[] }) => void,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool(
		undefined,
		onConfirmedNoBlockers,
	).execute(
		"probe-4322-noclient",
		{ ...target, serverScope, waitMs: 3000 },
		undefined,
		null,
		{ cwd: workspace },
	)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return {
		text: String(result.content[0]?.text),
		details: result.details ?? {},
	};
}

describe("a JSON file with no language server and no auxiliary (#4322)", () => {
	let service: { shutdown: () => Promise<void> } | undefined;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;

	beforeAll(async () => {
		// Never fetch a real vscode-json-language-server for the missing primary.
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		// Host-boundary stub: the command override is project config, which
		// #4248 admits only in a project pi has trusted.
		setProjectTrustState("trusted");
		fs.writeFileSync(
			path.join(workspace, "package.json"),
			'{"name":"synthetic-json-fixture","private":true}\n',
		);
		fs.mkdirSync(path.join(workspace, ".git"));
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({
				serverOverrides: {
					json: {
						command: [
							path.join(workspace, "missing", "json-language-server"),
							"--stdio",
						],
					},
				},
				disabledServers: ["ast-grep", "opengrep", "typos", "zizmor"],
			}),
		);
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(workspace);
		const lsp = await import("../../clients/lsp/index.js");
		service = lsp.getLSPService();
	});

	afterAll(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-4322-noclient-", {
			beforeDrain: async () => {
				await service?.shutdown();
			},
		});
		resetProjectTrust();
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	});

	it("does not report invalid JSON clean or retire its blockers", async () => {
		fs.writeFileSync(probe, '{"probe": }\n');
		const retired: string[][] = [];
		// The footer holds the JSON server's last answer for this file.
		const lastAnswer = [
			{ severity: "error", message: "JSON server's last answer", tool: "lsp" },
		];
		expect(reconcileScanDiagnostics(probe, lastAnswer, true)).toBe(true);

		const from = (await latencyLines()).length;
		const result = await withLatencySink(() =>
			diagnose("all", { path: probe }, (info) =>
				retired.push(info.coveredSources),
			),
		);

		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
		expect(retired).toEqual([]);
		expect(getFileDiagnostics(probe)?.map((d) => d.message)).toEqual([
			"JSON server's last answer",
		]);
		// The fallback read's health record and its own row name the server.
		const health = (
			service as unknown as {
				getDiagnosticsHealth: (
					file: string,
				) => { unavailablePrimaryServerIds?: string[] } | undefined;
			}
		).getDiagnosticsHealth(probe);
		expect(health?.unavailablePrimaryServerIds).toEqual(["json"]);
		expect(
			(await latencyRows("lsp_diagnostics_aggregate", probe, from)).map(
				(row) => row.metadata?.unavailablePrimaryServerIds,
			),
		).toContainEqual(["json"]);
	}, 30_000);

	it("does not report the primary-only check clean", async () => {
		fs.writeFileSync(probe, '{"probe": }\n');
		const retired: string[][] = [];

		const result = await diagnose("primary", { path: probe }, (info) =>
			retired.push(info.coveredSources),
		);

		expect(result.details.unconfirmed).toBe(true);
		expect(result.text).toContain("Primary LSP (json): not available");
		expect(result.text).not.toContain("confirmed clean");
		expect(retired).toEqual([]);
	}, 30_000);

	it("names a batch's files unavailable and never caches them clean", async () => {
		fs.writeFileSync(secondProbe, '{"second": }\n');
		fs.writeFileSync(thirdProbe, '{"third": }\n');
		const retired: string[][] = [];
		const batch = () =>
			diagnose("all", { paths: [secondProbe, thirdProbe] }, (info) =>
				retired.push(info.coveredSources),
			);

		const first = await batch();
		// The identical check again: a clean verdict cached by the first would
		// be served here.
		const second = await batch();

		for (const result of [first, second]) {
			const outcomes = result.details.outcomes as Array<{
				outcome?: string;
				reason?: string;
			}>;
			expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
				"unavailable",
				"unavailable",
			]);
			expect(outcomes.map((outcome) => outcome.reason)).toEqual([
				expect.stringContaining("Primary LSP (json): not available"),
				expect.stringContaining("Primary LSP (json): not available"),
			]);
		}
		expect(retired).toEqual([]);
	}, 30_000);

	it("keeps a file no language server covers unsupported, not unavailable", async () => {
		// No primary and no auxiliary for this kind of file: nothing was expected
		// to answer, so its outcome stays "unsupported".
		const plain = path.join(workspace, "notes.unknownext");
		fs.writeFileSync(plain, "plain text\n");
		// #4397: this case writes the JSON file it expects "unavailable" for.
		// `secondProbe` only exists once the batch case above has run; a
		// shuffled order read a missing file and got "failed".
		const unavailable = path.join(workspace, "unavailable.json");
		fs.writeFileSync(unavailable, '{"unavailable": }\n');

		const result = await diagnose("all", { paths: [plain, unavailable] });

		const outcomes = result.details.outcomes as Array<{ outcome?: string }>;
		expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
			"unsupported",
			"unavailable",
		]);
	}, 30_000);

	it("does not count the language server's last known rows as auxiliary findings", async () => {
		const fourthProbe = path.join(workspace, "fourth.json");
		fs.writeFileSync(fourthProbe, '{"fourth": }\n');
		// The JSON server's own row from an earlier answer, before it went away.
		// With no client this read returns it as the last known answer.
		const { normalizeMapKey } = await import("../../clients/path-utils.js");
		(
			service as unknown as { lastKnownDiagnostics: Map<string, unknown[]> }
		).lastKnownDiagnostics.set(normalizeMapKey(fourthProbe), [
			{
				range: {
					start: { line: 0, character: 10 },
					end: { line: 0, character: 11 },
				},
				severity: 1,
				message: "json server's earlier row",
				source: "json",
				serverId: "json",
			},
		]);

		const result = await diagnose("all", { paths: [fourthProbe] });

		const outcomes = result.details.outcomes as Array<{
			outcome?: string;
			primaryDiagnosticsCount?: number;
		}>;
		expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["unavailable"]);
		expect(outcomes[0]?.primaryDiagnosticsCount).toBe(1);
		expect(result.text).toContain("Showing stale last-known diagnostics");
		expect(result.text).not.toContain("auxiliary findings only");
	}, 30_000);
});
