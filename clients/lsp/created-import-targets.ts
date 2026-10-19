/**
 * #4346: the producer for a module created outside pi-lens (a shell, `cp`,
 * codegen, another editor). No tool result names such a file, so no Created
 * reaches a language server that caches a failed lookup (Pyrefly and pyright,
 * measured), and its importer keeps reporting the missing import for the
 * server's life when only the importer is diagnosed.
 *
 * The importer is the one input that names the module, and it is in hand when
 * a diagnostics call is about to answer for it. So before a batch answers, the
 * files its importers resolve to now (`extractForwardImportPaths`, the
 * tree-sitter import extraction and the review graph's resolvers, which the
 * inline-blocker sweep also uses) join the files announced
 * through `LSPService.announceCreatedFiles`. Each client still decides what is
 * new to it (#4344's path-birth rule and announced memory), so an old module,
 * or one already announced, sends nothing.
 *
 * Bounded: at most {@link CREATED_IMPORT_SCAN_MAX_FILES} importers per call,
 * and none the LSP does not sync (`exceedsLspSyncLimits`): such a file gets no
 * server answer, so its imports have nothing to make stale (#4368 r1 F2).
 * Each bound is recorded once per session (`lsp-created-import-scan-incomplete`,
 * subjects `capped` and `oversized`). A dependency no import names (a
 * TypeScript ambient declaration, a Go same-package file) is outside it.
 *
 * Observed by one `lsp_created_import_scan_rollup` row per session
 * ({@link emitCreatedImportScanRollupAtSessionEnd}), never one per call.
 */
import * as fs from "node:fs";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { logLatency } from "../latency-logger.js";
import { getProcessSingleton } from "../process-singletons.js";
import { exceedsLspSyncLimits } from "./content-limits.js";

/** Importers resolved per diagnostics call. */
export const CREATED_IMPORT_SCAN_MAX_FILES = 32;

interface CreatedImportScanRollup {
	/** The project the last call resolved in, for the row's `filePath`. */
	cwd: string;
	calls: number;
	importers: number;
	targets: number;
	capped: number;
	oversized: number;
	totalMs: number;
	maxMs: number;
}

// One cell per process, as the session-end rollups beside it (a module graph
// evaluated twice still counts into one tally).
function rollup(): CreatedImportScanRollup {
	return getProcessSingleton("lsp-created-import-scan-rollup", 1, () => ({
		cwd: "",
		calls: 0,
		importers: 0,
		targets: 0,
		capped: 0,
		oversized: 0,
		totalMs: 0,
		maxMs: 0,
	}));
}

/** Snapshot of this session's producer tally (non-mutating). */
export function getCreatedImportScanRollup(): Readonly<CreatedImportScanRollup> {
	return { ...rollup() };
}

/**
 * One `lsp_created_import_scan_rollup` row at a primary `session_shutdown`
 * (`resetLSPService` with that reason calls it):
 * the calls that resolved importers this session, the importers resolved, the
 * targets found, the calls past the cap, the importers skipped as oversized,
 * and the total and longest call. Nothing when no call resolved anything;
 * clears the tally.
 */
export function emitCreatedImportScanRollupAtSessionEnd(): void {
	const tally = rollup();
	if (tally.calls === 0) return;
	const { cwd, ...counts } = tally;
	logLatency({
		type: "phase",
		phase: "lsp_created_import_scan_rollup",
		filePath: cwd,
		durationMs: 0,
		metadata: { ...counts, totalMs: Math.round(counts.totalMs) },
	});
	Object.assign(tally, {
		calls: 0,
		importers: 0,
		targets: 0,
		capped: 0,
		oversized: 0,
		totalMs: 0,
		maxMs: 0,
	});
}

/**
 * Whether `filePath` is over the bound the LSP syncs. An unreadable file is
 * not: extraction answers it with no imports.
 */
function overLspSyncLimits(filePath: string): boolean {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return false;
	}
	return exceedsLspSyncLimits(content).tooLarge;
}

/** The files `importers` import now, deduplicated, for `announceCreatedFiles`. */
export async function importTargetsToAnnounce(
	cwd: string,
	importers: readonly string[],
): Promise<string[]> {
	if (importers.length === 0) return [];
	const started = performance.now();
	const tally = rollup();
	if (importers.length > CREATED_IMPORT_SCAN_MAX_FILES) {
		tally.capped += 1;
		recordDegradationOnce({
			kind: "lsp-created-import-scan-incomplete",
			subject: "capped",
			reason: `resolved the imports of ${CREATED_IMPORT_SCAN_MAX_FILES} of ${importers.length} files in one diagnostics call`,
		});
	}
	// Lazy: the import extraction stack stays off the LSP module graph until a
	// call has an importer to resolve.
	const { extractForwardImportPaths } = await import("../blocker-freshness.js");
	const targets = new Set<string>();
	let resolved = 0;
	// Extraction answers [] for a missing, unreadable or non-source file; it
	// does not throw (its own contract, which the blocker sweep relies on too).
	for (const importer of importers.slice(0, CREATED_IMPORT_SCAN_MAX_FILES)) {
		if (overLspSyncLimits(importer)) {
			tally.oversized += 1;
			recordDegradationOnce({
				kind: "lsp-created-import-scan-incomplete",
				subject: "oversized",
				reason:
					"skipped resolving the imports of a file over the LSP sync limits (the LSP does not sync it, so it has no answer to refresh)",
			});
			continue;
		}
		resolved += 1;
		for (const target of await extractForwardImportPaths(cwd, importer)) {
			targets.add(target);
		}
	}
	const elapsedMs = performance.now() - started;
	tally.cwd = cwd;
	tally.calls += 1;
	tally.importers += resolved;
	tally.targets += targets.size;
	tally.totalMs += elapsedMs;
	tally.maxMs = Math.max(tally.maxMs, Math.round(elapsedMs));
	return [...targets];
}
