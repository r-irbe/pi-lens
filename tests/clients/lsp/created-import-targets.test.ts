/**
 * #4346: the bounds of the created-module producer and of the workspace edit's
 * resource-operation announce, through the real modules (no language server
 * needed: neither spawns one).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	CREATED_IMPORT_SCAN_MAX_FILES,
	emitCreatedImportScanRollupAtSessionEnd,
	getCreatedImportScanRollup,
	importTargetsToAnnounce,
} from "../../../clients/lsp/created-import-targets.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { applyWorkspaceEdit } from "../../../clients/lsp/edits.js";
import { resetLSPService } from "../../../clients/lsp/index.js";
import { peekOwnedLspService } from "../../../clients/lsp/service-singleton.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { toPosix } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const roots: string[] = [];
afterEach(() => {
	resetDegradationLedger();
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		'{"name":"w","version":"0.0.0"}\n',
	);
	return root;
}

describe("importTargetsToAnnounce (#4346)", () => {
	// Recurrence: a sweep of hundreds of finding-bearing files would extract
	// every one of them on the diagnostics path; the cap bounds that, and the
	// record says what it left out.
	it("resolves at most the cap of importers per call and records the rest once", async () => {
		const root = workspace("pi-lens-4346-cap-");
		const importers: string[] = [];
		for (let i = 0; i <= CREATED_IMPORT_SCAN_MAX_FILES; i++) {
			const importer = path.join(root, `user${i}.ts`);
			fs.writeFileSync(importer, `import "./mod${i}";\nexport {};\n`);
			fs.writeFileSync(path.join(root, `mod${i}.ts`), "export {};\n");
			importers.push(importer);
		}

		const targets = (await importTargetsToAnnounce(root, importers)).map(
			(file) => toPosix(path.relative(root, file)),
		);
		await importTargetsToAnnounce(root, importers);

		expect(targets).toHaveLength(CREATED_IMPORT_SCAN_MAX_FILES);
		expect(targets).toContain("mod0.ts");
		expect(targets).not.toContain(`mod${CREATED_IMPORT_SCAN_MAX_FILES}.ts`);
		const record = getDegradationSummary().find(
			(group) => group.kind === "lsp-created-import-scan-incomplete",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.subject).toBe("capped");
	});

	it("records nothing within the cap", async () => {
		const root = workspace("pi-lens-4346-cap-under-");
		const importer = path.join(root, "user.ts");
		fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
		fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

		const targets = await importTargetsToAnnounce(root, [importer]);

		expect(targets.map((file) => toPosix(path.relative(root, file)))).toEqual([
			"mod.ts",
		]);
		expect(
			getDegradationSummary().some(
				(group) => group.kind === "lsp-created-import-scan-incomplete",
			),
		).toBe(false);
	});
});

describe("importTargetsToAnnounce bounds (#4368 r1 F2)", () => {
	// Recurrence: #4368 r1 F2. A file the LSP does not sync (over its byte or
	// line limit) gets no server answer, so its imports have nothing to make
	// stale; resolving it only spent the diagnostics call's time.
	it("skips an importer over the LSP sync limits and records it once", async () => {
		const root = workspace("pi-lens-4346-oversized-");
		const importer = path.join(root, "huge.ts");
		fs.writeFileSync(
			importer,
			`import "./mod";\n${"export const x = 1;\n".repeat(5_001)}`,
		);
		fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

		expect(await importTargetsToAnnounce(root, [importer])).toEqual([]);
		await importTargetsToAnnounce(root, [importer]);

		const record = getDegradationSummary().find(
			(group) => group.kind === "lsp-created-import-scan-incomplete",
		);
		expect(record?.count).toBe(1);
		expect(record?.latestReasons[0]?.subject).toBe("oversized");
	});
});

describe("the producer's session rollup (#4368 r1 F3)", () => {
	async function rollupRows(): Promise<Array<Record<string, unknown>>> {
		await flushLatencyLog();
		const logPath = getLatencyLogPath();
		const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
		return text
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						phase?: string;
						metadata?: Record<string, unknown>;
					},
			)
			.filter((row) => row.phase === "lsp_created_import_scan_rollup")
			.map((row) => row.metadata ?? {});
	}

	// Recurrence: #4368 r1 F3. The producer's cost (60 ms to 9 s measured)
	// left no record; one row per session carries it, never one per call.
	it("writes one row per session with the calls, importers and targets, then starts over", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			emitCreatedImportScanRollupAtSessionEnd();
			clearLatencyLog();
			const root = workspace("pi-lens-4346-rollup-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
			fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

			await importTargetsToAnnounce(root, [importer]);
			await importTargetsToAnnounce(root, [importer]);
			expect(await rollupRows()).toEqual([]);
			expect(getCreatedImportScanRollup()).toMatchObject({
				calls: 2,
				importers: 2,
				targets: 2,
			});

			// The session_shutdown reset index.ts runs (no service here).
			resetLSPService({ reason: "session_shutdown" });
			resetLSPService({ reason: "session_shutdown" });

			const rows = await rollupRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				calls: 2,
				importers: 2,
				targets: 2,
				capped: 0,
				oversized: 0,
			});
			expect(typeof rows[0]?.totalMs).toBe("number");
			expect(typeof rows[0]?.maxMs).toBe("number");
			expect(getCreatedImportScanRollup().calls).toBe(0);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
		}
	});

	// Recurrence: #4368 r2 L1 (mutant S7: the rollup emitted on any
	// resetLSPService reason). The row is a session-end record; a reset with
	// any other reason (session_start) must emit nothing and leave the tally
	// for the session's own shutdown.
	it("emits no rollup row for a reset that is not session_shutdown", async () => {
		const previous = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		try {
			emitCreatedImportScanRollupAtSessionEnd();
			clearLatencyLog();
			const root = workspace("pi-lens-4346-rollup-reason-");
			const importer = path.join(root, "user.ts");
			fs.writeFileSync(importer, 'import "./mod";\nexport {};\n');
			fs.writeFileSync(path.join(root, "mod.ts"), "export {};\n");

			await importTargetsToAnnounce(root, [importer]);
			resetLSPService({ reason: "session_start" });

			expect(await rollupRows()).toEqual([]);
			expect(getCreatedImportScanRollup().calls).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previous;
		}
	});
});

describe("a workspace edit's resource operations with no LSP service (#4346)", () => {
	// Recurrence: an edit applied before any LSP use (a `rename_file` with no
	// client yet) must not start the LSP stack only to report its operations.
	it("applies the operation and creates no service", async () => {
		const root = workspace("pi-lens-4346-noservice-");
		const created = path.join(root, "made.ts");
		expect(peekOwnedLspService()).toBeUndefined();

		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			root,
		);

		expect(fs.existsSync(created)).toBe(true);
		expect(peekOwnedLspService()).toBeUndefined();
	});
});
