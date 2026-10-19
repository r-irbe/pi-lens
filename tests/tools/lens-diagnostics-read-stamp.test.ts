/**
 * #3573: a finding `lens_diagnostics mode=full` writes to the widget is
 * stamped at the read its verdict was computed from, not when the scan
 * reconciles. Driven through the real tool, the real
 * `LSPService.runWorkspaceDiagnostics` and the real widget store; only the
 * language-server client and its config are doubled.
 *
 * Recurrence: a fresh sweep result carried no `observedAt`, and the #1888
 * correlated commit re-stamped every LSP row with the project scan's stamp or
 * `Date.now()` after the whole sweep. A dependency, or the file itself,
 * written while the sweep was still analysing the file then had an OLDER
 * mtime than the row, so neither widget gate ever demoted it.
 *
 * No wall clock: `Date` is faked and pinned per step, and every mtime is set
 * with `utimesSync`. The concurrent writer lands the moment the sweep's read
 * of `a.ts` resolves (a pass-through spy on `fs.promises.readFile`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearWidgetState,
	getFileDiagnostics,
	reconcileStaleWidgetDependencyBlockers,
	reconcileStaleWidgetFiles,
} from "../../clients/widget-state.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const {
	getServersForFileWithConfig,
	createLSPClient,
	scanProjectDiagnostics,
	fetchFreshProjectDiagnostics,
	logLatency,
} = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
	scanProjectDiagnostics: vi.fn(),
	fetchFreshProjectDiagnostics: vi.fn(),
	logLatency: vi.fn(),
}));
// A pass-through, so every row still reaches the real logger.
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	logLatency.mockImplementation(actual.logLatency);
	return { ...actual, logLatency };
});
vi.mock(
	"../../clients/project-diagnostics/scanner.js",
	async (importOriginal) => ({
		...(await importOriginal()),
		scanProjectDiagnostics,
	}),
);
// The heavyweight analyzers are not under test; they answer with nothing.
vi.mock(
	"../../clients/project-diagnostics/fresh-fetch.js",
	async (importOriginal) => ({
		...(await importOriginal()),
		fetchFreshProjectDiagnostics,
	}),
);
vi.mock("../../clients/bootstrap.js", async (importOriginal) => ({
	...(await importOriginal()),
	loadBootstrapClients: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal()),
	createLSPClient,
}));

import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";
import { LSPService } from "../../clients/lsp/index.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	saveProjectDiagnosticsSnapshot,
	writeProjectDiagnosticsDeltaReport,
} from "../../clients/project-diagnostics/cache.js";
import { createLensDiagnosticsTool } from "../../tools/lens-diagnostics.js";

const PREFIX = "pi-lens-lensdiag-read-stamp-";
// The model's timeline, in ms: the sweep reads a.ts at T_READ, a parallel
// write lands 400 ms into its analysis, and the scan commits at T_REC.
const T_READ = 1_900_000_000_000;
const T_EDIT = T_READ + 400;
const T_REC = T_READ + 1500;
const CASE_MS = 30_000;

function setMtime(file: string, ms: number): void {
	fs.utimesSync(file, ms / 1000, ms / 1000);
}

/** A version-less push server that reports one blocker for `file`. */
function makeClient(root: string, file: string) {
	return {
		isAlive: () => true,
		isDocumentOpen: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		serverId: "typescript",
		root,
		notify: {
			announceCreated: () => undefined,
			open: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
		getDiagnostics: vi.fn((fp: string) =>
			fp === file
				? [
						{
							severity: 1,
							message: "BLOCKER computed on the bytes read at T_READ",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
					]
				: [],
		),
	};
}

/** Run `write` once, right after the sweep's first read of `file` resolves. */
function afterFirstRead(file: string, write: () => void): () => boolean {
	const realReadFile = fs.promises.readFile;
	let landed = false;
	vi.spyOn(fs.promises, "readFile").mockImplementation(
		async (...args: Parameters<typeof realReadFile>) => {
			const bytes = await realReadFile(...args);
			if (!landed && args[0] === file) {
				landed = true;
				write();
			}
			return bytes as never;
		},
	);
	return () => landed;
}

function widgetRows(filePath: string) {
	return (getFileDiagnostics(filePath) ?? []).map((d) => ({
		observedAt: d.observedAt,
		stale: d.stale ?? false,
		staleReason: d.staleReason,
	}));
}

describe("lens_diagnostics mode=full stamps a swept row at its read (#3573)", () => {
	let tmp: string;
	let other: string;
	let file: string;
	let dep: string;
	const services: LSPService[] = [];

	async function fullScan(
		params: { refreshRunners?: string; paths?: string[] } = {},
	): Promise<void> {
		const service = new LSPService();
		services.push(service);
		const tool = createLensDiagnosticsTool(
			{ readCache: vi.fn(() => undefined) } as never,
			() => tmp,
			() => service as never,
		);
		// `other.ts` first, so the group warm-up reads it and not `a.ts`.
		await tool.execute(
			"1",
			{ mode: "full", paths: [other, file], ...params },
			new AbortController().signal,
			null as never,
			{ cwd: tmp } as never,
		);
	}

	beforeEach(() => {
		clearWidgetState();
		resetDegradationLedger();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.realpathSync(setupTestEnvironment(PREFIX).tmpDir);
		fs.mkdirSync(path.join(tmp, ".pi-lens"));
		other = path.join(tmp, "other.ts");
		file = path.join(tmp, "a.ts");
		dep = path.join(tmp, "dep.ts");
		fs.writeFileSync(other, "export const other = 1;\n");
		fs.writeFileSync(
			file,
			'import { y } from "./dep.js";\nexport const z = y;\n',
		);
		fs.writeFileSync(dep, "export const y = 1;\n");
		for (const p of [other, file, dep]) setMtime(p, T_READ - 1000);
		const server = {
			id: "typescript",
			name: "typescript",
			extensions: [".ts"],
			root: async () => tmp,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		};
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
		createLSPClient.mockResolvedValue(makeClient(tmp, file));
		scanProjectDiagnostics.mockReset();
		fetchFreshProjectDiagnostics.mockReset();
		fetchFreshProjectDiagnostics.mockResolvedValue({
			diagnostics: [],
			runners: [],
			analyzed: [],
			authoritativeCoverage: [],
			cold: [],
			coldReasons: {},
			failed: [],
			timings: {},
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T_READ);
	});
	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearWidgetState();
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await Promise.all(services.splice(0).map((s) => s.shutdown()));
			},
		});
	});

	it(
		"a dependency written while the sweep analyses the file demotes its widget row (#3573)",
		async () => {
			const landed = afterFirstRead(file, () => {
				vi.setSystemTime(T_EDIT);
				fs.writeFileSync(dep, "export const y = 2;\n");
				setMtime(dep, T_EDIT);
				vi.setSystemTime(T_REC);
			});
			await fullScan();
			expect(landed()).toBe(true);
			const result = await reconcileStaleWidgetDependencyBlockers(tmp);
			expect(result.demoted).toBe(1);
			expect(widgetRows(file)).toEqual([
				{ observedAt: T_READ, stale: true, staleReason: "dependency-drift" },
			]);
		},
		CASE_MS,
	);

	it(
		"the file rewritten while the sweep analyses it drops its widget row (#3573)",
		async () => {
			afterFirstRead(file, () => {
				vi.setSystemTime(T_EDIT);
				fs.writeFileSync(file, "export const z = 3;\n");
				setMtime(file, T_EDIT);
				vi.setSystemTime(T_REC);
			});
			await fullScan();
			expect(widgetRows(file)).toHaveLength(1);
			expect(await reconcileStaleWidgetFiles()).toBe(1);
			expect(widgetRows(file)).toEqual([]);
		},
		CASE_MS,
	);

	it(
		"a dependency written before the sweep's read leaves the row authoritative (#3573)",
		async () => {
			// Written before the read, its mtime leading the clock by 40 ms (the
			// #1710 skew the 50 ms tolerance absorbs).
			setMtime(dep, T_READ + 40);
			afterFirstRead(file, () => {
				vi.setSystemTime(T_REC);
			});
			await fullScan();
			expect((await reconcileStaleWidgetDependencyBlockers(tmp)).demoted).toBe(
				0,
			);
			expect(await reconcileStaleWidgetFiles()).toBe(0);
			expect(widgetRows(file)).toEqual([
				{ observedAt: T_READ, stale: false, staleReason: undefined },
			]);
		},
		CASE_MS,
	);

	// ── project rows: a fresh cheap-tier scan ────────────────────────────────
	describe("a fresh project scan's rows", () => {
		/**
		 * The cheap-tier scan as `clients/project-diagnostics/scanner.ts` runs
		 * it, on the axis under test: it fingerprints the bytes it READ, and
		 * stamps `scannedAt` after its whole file loop. `during` runs between
		 * the two, while the scan is still analysing other files.
		 */
		function scanReads(filePath: string, during?: () => void) {
			scanProjectDiagnostics.mockImplementation(async () => {
				const bytes = fs.readFileSync(filePath);
				const fingerprint = {
					sizeBytes: bytes.length,
					contentHash: hashDiagnosticContent(bytes.toString("utf-8")),
				};
				vi.setSystemTime(T_EDIT);
				during?.();
				vi.setSystemTime(T_REC);
				return {
					version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
					cwd: tmp,
					tier: "cheap",
					scannedAt: new Date().toISOString(),
					diagnostics: [
						{
							filePath,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "ast-grep-napi",
							runner: "ast-grep-napi",
							rule: "no-debugger",
							message: "PROJECT ROW computed on the bytes the scan read",
							source: "project-scan",
						},
					],
					filesScanned: 1,
					runners: ["ast-grep-napi"],
					fileFingerprints: { [filePath]: fingerprint },
				};
			});
		}

		it(
			"a file rewritten while the project scan is still running leaves no row in the widget (#3573)",
			async () => {
				scanReads(other, () => {
					fs.writeFileSync(other, "export const other = 2;\n");
					setMtime(other, T_EDIT);
				});
				logLatency.mockClear();
				await fullScan({ refreshRunners: "cheap" });
				await reconcileStaleWidgetFiles();
				expect(widgetRows(other)).toEqual([]);
				// The fresh arm's retirement is recorded like the cached arm's.
				expect(
					logLatency.mock.calls
						.map(([row]) => row)
						.filter((row) => row.phase === "project_snapshot_rows_retired"),
				).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({
							files: 1,
							rows: 1,
							arm: "fresh",
						}),
					}),
				]);
			},
			CASE_MS,
		);

		it(
			"a file written before the project scan read it keeps its row (#3573)",
			async () => {
				fs.writeFileSync(other, "export const other = 2;\n");
				setMtime(other, T_READ + 40);
				scanReads(other);
				await fullScan({ refreshRunners: "cheap" });
				expect(await reconcileStaleWidgetFiles()).toBe(0);
				expect(widgetRows(other)).toEqual([
					{ observedAt: T_REC, stale: false, staleReason: undefined },
				]);
			},
			CASE_MS,
		);

		it(
			"the cached arm's retirement of the same rows is labelled cached (#3573)",
			async () => {
				// The same mid-scan rewrite, persisted by an earlier session and
				// served here from the cross-session cache.
				scanReads(other, () => {
					fs.writeFileSync(other, "export const other = 2;\n");
					setMtime(other, T_EDIT);
				});
				saveProjectDiagnosticsSnapshot(tmp, await scanProjectDiagnostics());
				logLatency.mockClear();
				await fullScan({ refreshRunners: "cached" });
				expect(widgetRows(other)).toEqual([]);
				expect(
					logLatency.mock.calls
						.map(([row]) => row)
						.filter((row) => row.phase === "project_snapshot_rows_retired"),
				).toEqual([
					expect.objectContaining({
						metadata: expect.objectContaining({ files: 1, arm: "cached" }),
					}),
				]);
			},
			CASE_MS,
		);
	});

	// ── heavyweight-analyzer and projectDelta rows (#3600) ────────────────────
	describe("a folded heavyweight-analyzer row", () => {
		it(
			"an edit between the analyzer's read and the fold drops its widget row (#3600)",
			async () => {
				// The analyzer read the bytes at T_READ; its row carries that stamp.
				fetchFreshProjectDiagnostics.mockResolvedValue({
					diagnostics: [
						{
							filePath: other,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "knip",
							runner: "knip",
							rule: "knip:file",
							message: "ANALYZER ROW computed on the bytes the analyzer read",
							source: "project-scan",
							observedAt: T_READ,
						},
					],
					runners: ["knip"],
					analyzed: ["knip"],
					authoritativeCoverage: [],
					cold: [],
					coldReasons: {},
					failed: [],
					timings: {},
				});
				// The edit lands after the analyzer's read, before the fold at T_REC.
				fs.writeFileSync(other, "export const other = 2;\n");
				setMtime(other, T_EDIT);
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				expect(widgetRows(other)).toHaveLength(1);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(widgetRows(other)).toEqual([]);
			},
			CASE_MS,
		);

		it(
			"a file written before the analyzer's read keeps its row (#3600)",
			async () => {
				fetchFreshProjectDiagnostics.mockResolvedValue({
					diagnostics: [
						{
							filePath: other,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "knip",
							runner: "knip",
							rule: "knip:file",
							message: "ANALYZER ROW computed on the bytes the analyzer read",
							source: "project-scan",
							observedAt: T_READ,
						},
					],
					runners: ["knip"],
					analyzed: ["knip"],
					authoritativeCoverage: [],
					cold: [],
					coldReasons: {},
					failed: [],
					timings: {},
				});
				// Written before the read, its mtime leading the clock by 40 ms (the
				// #1710 skew the 50 ms tolerance absorbs).
				setMtime(other, T_READ + 40);
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				expect(await reconcileStaleWidgetFiles()).toBe(0);
				expect(widgetRows(other)).toEqual([
					{ observedAt: T_READ, stale: false, staleReason: undefined },
				]);
			},
			CASE_MS,
		);
	});

	describe("a projectDelta row", () => {
		it(
			"an edit between the delta report's generatedAt and the fold drops its widget row (#3600)",
			async () => {
				writeProjectDiagnosticsDeltaReport(tmp, {
					version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
					cwd: tmp,
					generatedAt: new Date(T_READ).toISOString(),
					sessionId: "session",
					turnIndex: 1,
					diagnostics: [
						{
							filePath: other,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "madge",
							runner: "madge",
							rule: "madge:circular",
							message: "DELTA ROW generated before the edit",
							source: "project-scan",
						},
					],
					sources: ["madge"],
				});
				// The edit lands after the report was generated, before the fold.
				fs.writeFileSync(other, "export const other = 2;\n");
				setMtime(other, T_EDIT);
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				expect(widgetRows(other)).toHaveLength(1);
				expect(await reconcileStaleWidgetFiles()).toBe(1);
				expect(widgetRows(other)).toEqual([]);
			},
			CASE_MS,
		);

		it(
			"a projectDelta row keeps its OWN observedAt over the report's generatedAt (#3600)",
			async () => {
				const rowRead = T_READ - 1_000;
				writeProjectDiagnosticsDeltaReport(tmp, {
					version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
					cwd: tmp,
					generatedAt: new Date(T_READ).toISOString(),
					sessionId: "session",
					turnIndex: 1,
					diagnostics: [
						{
							filePath: other,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "madge",
							runner: "madge",
							rule: "madge:circular",
							message: "DELTA ROW carrying its own read stamp",
							source: "project-scan",
							observedAt: rowRead,
						},
					],
					sources: ["madge"],
				});
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				// The report stamp is a FALLBACK for rows the delta writer did not
				// stamp; it must not overwrite a row's own read time.
				expect(widgetRows(other)[0]?.observedAt).toBe(rowRead);
			},
			CASE_MS,
		);

		it(
			"an unparseable generatedAt is recorded rather than silently widened to the fold clock (#3600)",
			async () => {
				writeProjectDiagnosticsDeltaReport(tmp, {
					version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
					cwd: tmp,
					generatedAt: "not-a-timestamp",
					sessionId: "session",
					turnIndex: 1,
					diagnostics: [
						{
							filePath: other,
							line: 1,
							column: 1,
							severity: "error",
							semantic: "blocking",
							tool: "madge",
							runner: "madge",
							rule: "madge:circular",
							message: "DELTA ROW with an unparseable report stamp",
							source: "project-scan",
						},
					],
					sources: ["madge"],
				});
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				const group = getDegradationSummary().find(
					({ kind }) => kind === "project-delta-generatedat-unparseable",
				);
				expect(group?.count).toBe(1);
				// The row still lands, stamped at the fold: the fallback is deliberate
				// and now visible, not a silent freshness widening.
				expect(widgetRows(other)[0]?.observedAt).toBe(T_REC);
			},
			CASE_MS,
		);

		it(
			"a fold with no delta report records no unparseable-generatedAt row (#3600)",
			async () => {
				// The record's guard is `deltaDiagnostics.length > 0`: with no report
				// (or an empty one) there are no rows to widen, and `String(undefined)`
				// would otherwise fabricate a record whose subject is "undefined".
				vi.setSystemTime(T_REC);
				await fullScan({ refreshRunners: "cheap" });
				const group = getDegradationSummary().find(
					({ kind }) => kind === "project-delta-generatedat-unparseable",
				);
				expect(group).toBeUndefined();
			},
			CASE_MS,
		);
	});
});
