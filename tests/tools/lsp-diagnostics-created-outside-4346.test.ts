/**
 * #4346: a module created outside pi-lens (a shell, `cp`, codegen) reached no
 * language server, because no tool result names it. A server that caches a
 * failed lookup (Pyrefly and pyright, measured) kept the importer's missing
 * import for its whole life when only the importer was diagnosed. A workspace
 * edit's resource operations (create, rename, delete) sent no watched-files
 * event either.
 *
 * These cases drive the REAL `lsp_diagnostics` handler, LSPService, client and
 * workspace edit applier over a stdio JSON-RPC wire. The server is the shared
 * fake in its stale-lookup profile, configured as the project's server for
 * `.ts` files (the built-in one disabled), for `import "./name"` lines that
 * resolve to `name.ts`, which the review graph's extraction also reads.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const fakeServer = fileURLToPath(
	new URL("../fixtures/fake-lsp-server.mjs", import.meta.url),
);
const env = setupTestEnvironment("pi-lens-4346-outside-");
const workspace = env.tmpDir;
const trace = path.join(workspace, "server.trace");

async function diagnose(
	args: { paths: string[] } | { path: string },
): Promise<{ text: string; details: Record<string, unknown> }> {
	const { createLspDiagnosticsTool } =
		await import("../../tools/lsp-diagnostics.js");
	const result = (await createLspDiagnosticsTool().execute(
		"probe-4346",
		{ ...args, serverScope: "primary", waitMs: 3000, concurrency: 1 },
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

function watchedLines(): string[] {
	if (!fs.existsSync(trace)) return [];
	return fs
		.readFileSync(trace, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("watched "));
}

/**
 * Diagnose a file no call has seen: the batch first sends any waiting Created
 * (`announceCreatedFiles` flushes the watch queue), and the touch is a round
 * trip to the server, which writes its trace line before it answers (stdio
 * keeps the order). So the trace is complete for every event sent before.
 */
let roundTrips = 0;
async function roundTrip(): Promise<void> {
	const probe = path.join(workspace, `round_trip_${roundTrips++}.ts`);
	fs.writeFileSync(probe, "export {};\n");
	await diagnose({ paths: [probe] });
}

let service: { shutdown: () => Promise<void> } | undefined;

beforeAll(async () => {
	// Host-boundary stub: a project-configured server needs pi's trust (#4248).
	setProjectTrustState("trusted");
	const shim = path.join(workspace, "stale-lookup-server.mjs");
	fs.writeFileSync(
		shim,
		[
			'process.env.FAKE_LSP_NO_DIAGNOSTIC_PROVIDER = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_LOOKUP = "1";',
			'process.env.FAKE_LSP_STALE_MODULE_EXT = ".ts";',
			`process.env.FAKE_LSP_TRACE_FILE = ${JSON.stringify(trace)};`,
			`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"outside","version":"0.0.0"}\n',
	);
	// Born before any server starts: an existing module, never Created.
	fs.writeFileSync(path.join(workspace, "old_module.ts"), "export {};\n");
	// Row 13: a module whose inode is older than the server, moved into place
	// later. `mv` keeps the inode and its birth time.
	fs.mkdirSync(path.join(workspace, "stash"));
	fs.writeFileSync(
		path.join(workspace, "stash", "moved_module.ts"),
		"export {};\n",
	);
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			servers: {
				"stale-ts": {
					name: "stale lookup server",
					extensions: [".ts"],
					command: process.execPath,
					args: [shim],
					rootMarkers: ["package.json"],
				},
			},
			disabledServers: ["typescript", "deno", "opengrep", "ast-grep", "typos"],
		}),
	);
	// Older than the client, which starts at the first diagnostics call.
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(workspace);
	const lsp = await import("../../clients/lsp/index.js");
	service = lsp.getLSPService();
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained("pi-lens-4346-outside-", {
		beforeDrain: async () => {
			await service?.shutdown();
		},
	});
	resetProjectTrust();
});

describe("a module created outside pi-lens (#4346)", () => {
	it("clears the importer when only the importer is diagnosed after the module appears", async () => {
		const importer = path.join(workspace, "batch_user.ts");
		fs.writeFileSync(importer, 'import "./batch_module";\nexport {};\n');
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(1);

		// Outside pi-lens: no tool result, no pi write, no open of the module.
		const created = path.join(workspace, "batch_module.ts");
		fs.writeFileSync(created, "export {};\n");
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module batch_module");
		expect(after.details.primaryDiagnosticsCount).toBe(0);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);
	}, 30_000);

	it("clears the importer on the single-file route too", async () => {
		const importer = path.join(workspace, "scalar_user.ts");
		fs.writeFileSync(importer, 'import "./scalar_module";\nexport {};\n');
		expect((await diagnose({ path: importer })).text).toContain(
			"Cannot find module scalar_module",
		);

		fs.writeFileSync(path.join(workspace, "scalar_module.ts"), "export {};\n");
		const after = await diagnose({ path: importer });

		expect(after.text).not.toContain("Cannot find module scalar_module");
	}, 30_000);

	// Row 3b: codegen writes a gitignored module the sweep never lists, so
	// only the importer names it.
	it("clears the importer in a workspace sweep when the module is gitignored", async () => {
		fs.writeFileSync(path.join(workspace, ".gitignore"), "gen/\n");
		const importer = path.join(workspace, "swept_user.ts");
		fs.writeFileSync(importer, 'import "./gen/swept_gen";\nexport {};\n');
		const sweep = async () =>
			(
				await (
					service as unknown as {
						runWorkspaceDiagnostics: (
							cwd: string,
						) => Promise<Array<{ filePath: string; diagnostics: unknown[] }>>;
					}
				).runWorkspaceDiagnostics(workspace)
			).find((result) => result.filePath === importer)?.diagnostics.length;
		expect(await sweep()).toBe(1);
		// The importer is itself new: its first open sent Created, which drops
		// the first sweep's entry. The second records the entry under test.
		expect(await sweep()).toBe(1);

		fs.mkdirSync(path.join(workspace, "gen"));
		fs.writeFileSync(
			path.join(workspace, "gen", "swept_gen.ts"),
			"export {};\n",
		);

		expect(await sweep()).toBe(0);
	}, 60_000);

	// Recurrence: #4368 r1 F1. pi's write hook touches the importer without
	// recording a cache entry, so a gate on cached findings skipped it, and the
	// first batch call after the module appeared replayed the server's stale
	// lookup (the single-file route already cleared on its first call).
	it("clears an importer pi's write hook touched, on the first batch call", async () => {
		const lsp = service as unknown as {
			touchFile: (
				filePath: string,
				content: string,
				options: { diagnostics: "document"; source: string },
			) => Promise<unknown>;
		};
		const importer = path.join(workspace, "hook_user.ts");
		const content = 'import "./hook_module";\nexport {};\n';
		fs.writeFileSync(importer, content);
		await lsp.touchFile(importer, content, {
			diagnostics: "document",
			source: "write-hook-4368",
		});

		fs.writeFileSync(path.join(workspace, "hook_module.ts"), "export {};\n");
		const first = await diagnose({ paths: [importer] });

		expect(first.text).not.toContain("Cannot find module hook_module");
		expect(first.details.primaryDiagnosticsCount).toBe(0);
	}, 30_000);

	// Recurrence: #4368 r1 F1, the binding half of "a fresh clean entry". A
	// rewrite that keeps the size and mtime passes the stat check, and only
	// the content binding shows the bytes changed: the new import must still
	// be resolved, or the server's stale lookup for it is served on the
	// re-touch.
	it("resolves an importer whose clean entry no longer matches its bytes", async () => {
		fs.writeFileSync(path.join(workspace, "bind_a.ts"), "export {};\n");
		const importer = path.join(workspace, "bind_user.ts");
		fs.writeFileSync(importer, 'import "./bind_a";\nexport {};\n');
		// Whole seconds, so restoring the mtime later is exact.
		const pinned = Math.floor(Date.now() / 1000) - 30;
		fs.utimesSync(importer, pinned, pinned);
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(0);
		const { mtimeMs } = fs.statSync(importer);
		// The server learns that bind_b is missing through another file.
		const other = path.join(workspace, "bind_other.ts");
		fs.writeFileSync(other, 'import "./bind_b";\nexport {};\n');
		expect((await diagnose({ paths: [other] })).text).toContain(
			"Cannot find module bind_b",
		);

		fs.writeFileSync(path.join(workspace, "bind_b.ts"), "export {};\n");
		fs.writeFileSync(importer, 'import "./bind_b";\nexport {};\n');
		fs.utimesSync(importer, pinned, pinned);
		// Precondition: the stat check cannot see the rewrite.
		expect(fs.statSync(importer).mtimeMs).toBe(mtimeMs);
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module bind_b");
	}, 30_000);

	// Recurrence: #4368 r1 row 13. A module moved in with `mv` keeps its old
	// inode birth, so the birth rule sent Changed and the importer stayed stale
	// for the server's life. The resolver saw the import unresolved, then
	// resolved: the path appeared in between.
	it("announces a module moved in with an old inode as Created", async () => {
		const importer = path.join(workspace, "moved_user.ts");
		fs.writeFileSync(importer, 'import "./moved_module";\nexport {};\n');
		expect((await diagnose({ paths: [importer] })).text).toContain(
			"Cannot find module moved_module",
		);

		const moved = path.join(workspace, "moved_module.ts");
		fs.renameSync(path.join(workspace, "stash", "moved_module.ts"), moved);
		const after = await diagnose({ paths: [importer] });

		expect(after.text).not.toContain("Cannot find module moved_module");
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 1`);
	}, 30_000);

	it("announces no module born before the server started", async () => {
		const importer = path.join(workspace, "old_user.ts");
		fs.writeFileSync(
			importer,
			'import "./old_module";\nimport "./never_module";\nexport {};\n',
		);
		const first = await diagnose({ paths: [importer] });
		// The import that never resolves keeps reporting.
		expect(first.text).toContain("Cannot find module never_module");
		await diagnose({ paths: [importer] });

		const oldUri = pathToFileURL(path.join(workspace, "old_module.ts")).href;
		expect(watchedLines()).not.toContain(`watched ${oldUri} 1`);
	}, 30_000);
});

describe("a workspace edit's resource operations (#4346)", () => {
	it("sends Created, Deleted, and the rename pair the moment they reach disk", async () => {
		const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
		// A live client must exist for the events to reach a server.
		await roundTrip();

		const created = path.join(workspace, "edit_created.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [{ kind: "create", uri: pathToFileURL(created).href }],
			},
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 1`,
		);

		const moved = path.join(workspace, "edit_moved.ts");
		await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						kind: "rename",
						oldUri: pathToFileURL(created).href,
						newUri: pathToFileURL(moved).href,
					},
				],
			},
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 1`);
		expect(watchedLines()).toContain(
			`watched ${pathToFileURL(created).href} 3`,
		);

		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "delete", uri: pathToFileURL(moved).href }] },
			workspace,
		);
		await roundTrip();
		expect(watchedLines()).toContain(`watched ${pathToFileURL(moved).href} 3`);
	}, 30_000);

	// Recurrence: an edit that fails mid-application has already written its
	// earlier operations ("no rollback performed"); a server must still hear
	// about the file that now exists.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"announces an applied create when a later operation fails",
		async () => {
			const { applyWorkspaceEdit } = await import("../../clients/lsp/edits.js");
			// #4397: a Created event reaches a RUNNING client only. A sibling case
			// used to have started it; run first, no client existed to hear it.
			await roundTrip();
			const locked = path.join(workspace, "locked");
			fs.mkdirSync(locked);
			const target = path.join(locked, "target.ts");
			fs.writeFileSync(target, "export const a = 1;\n");
			fs.chmodSync(target, 0o444);
			fs.chmodSync(locked, 0o555);
			const created = path.join(workspace, "edit_partial.ts");
			try {
				await expect(
					applyWorkspaceEdit(
						{
							documentChanges: [
								{ kind: "create", uri: pathToFileURL(created).href },
								{
									textDocument: {
										uri: pathToFileURL(target).href,
										version: null,
									},
									edits: [
										{
											range: {
												start: { line: 0, character: 13 },
												end: { line: 0, character: 14 },
											},
											newText: "b",
										},
									],
								},
							],
						},
						workspace,
					),
				).rejects.toThrow(/failed mid-application/);
			} finally {
				fs.chmodSync(locked, 0o755);
			}
			await roundTrip();
			expect(watchedLines()).toContain(
				`watched ${pathToFileURL(created).href} 1`,
			);
		},
		30_000,
	);
});

describe("the producer's cost gate (#4346)", () => {
	// Recurrence: #4344 r1, where a per-call extra pass took the cached replay
	// from 6 ms to 321 ms. A fresh clean entry for the current bytes cannot
	// show a missing import (every import it names resolved), so a batch
	// resolves every file except those (#4368 r1 F1 widened the gate from
	// "has cached findings" to this).
	it("resolves no file a fresh clean entry answers, and resolves it again once edited", async () => {
		const { getCreatedImportScanRollup } =
			await import("../../clients/lsp/created-import-targets.js");
		fs.writeFileSync(path.join(workspace, "gate_module.ts"), "export {};\n");
		const importer = path.join(workspace, "gate_user.ts");
		fs.writeFileSync(importer, 'import "./gate_module";\nexport {};\n');
		const resolved = () => getCreatedImportScanRollup().importers;

		const before = resolved();
		expect(
			(await diagnose({ paths: [importer] })).details.primaryDiagnosticsCount,
		).toBe(0);
		expect(resolved() - before).toBe(1);

		await diagnose({ paths: [importer] });
		expect(resolved() - before).toBe(1);

		fs.appendFileSync(importer, "// edited\n");
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(importer, later, later);
		await diagnose({ paths: [importer] });
		expect(resolved() - before).toBe(2);
	}, 30_000);
});
