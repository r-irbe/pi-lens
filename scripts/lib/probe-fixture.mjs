// The per-fixture measurement step of scripts/probe-clean-signal.mjs, lifted out
// of that script (which executes on import) so its row attribution can be
// driven with injected collaborators. #3665 recurrence: the call site that
// resolved `row.serverId` was only exercised by the nightly, so a revert to the
// primary-by-role expression stayed green in every unit test.
import * as fs from "node:fs";
import * as path from "node:path";
import {
	classifyCleanBehavior,
	classifyFirstPublish,
	resolveProbeServerId,
} from "./clean-signal.mjs";

// Budgets (reuse the original probe's generosity — this is off the hot path).
const CLIENT_WAIT_MS = 30000; // cold spawn + initialize
const PROVE_LIVE_WAIT_MS = 8000; // first touch: cold analysis may be slow (match smoke-tools)
const STEP_WAIT_MS = 2500; // per-touch publish budget (matches the old probe)
const SETTLE_MS = 400; // let a late publish land + past the touch debounce

// A byte-changing, diagnostic-neutral edit: append a trailing comment line in the
// file's comment syntax (falls back to a blank line). Keeps the diagnostic SET
// unchanged so a re-publish is purely the server's clean-scan behavior.
function commentFor(file) {
	const ext = path.extname(file).toLowerCase();
	if (
		[
			".py",
			".rb",
			".sh",
			".yaml",
			".yml",
			".toml",
			".tf",
			".ex",
			".exs",
			".nix",
			".ps1",
		].includes(ext)
	)
		return "#";
	if ([".lua", ".sql", ".hs"].includes(ext)) return "--";
	if ([".clj", ".ml", ".mli"].includes(ext)) return ";;"; // best-effort; ocaml uses (* *) but a trailing line is harmless bytes
	return "//"; // js/ts/go/rust/c/cpp/java/kotlin/php/dart/zig/vue/svelte/prisma…
}

/**
 * @param {object} deps the script's live collaborators: `lsp`, `repoRoot`,
 *   `install`, `ensureTool`, `initLSPConfig`, `getServersForFileWithConfig`,
 *   `bootstrapFixtureWorkspace`, `drainPublishTrace`, `pubLogSize`, `sleep`.
 */
export function createProbeFixture(deps) {
	const {
		lsp,
		repoRoot,
		install,
		ensureTool,
		initLSPConfig,
		getServersForFileWithConfig,
		bootstrapFixtureWorkspace,
		drainPublishTrace,
		pubLogSize,
		sleep,
	} = deps;
	return async function probeFixture(fx, dst, row) {
		// `dst` is pre-created by the caller (mkdtemp'd BEFORE `withTimeout` starts
		// the race, so its `finally` can always clean it up, even if bootstrapping
		// itself times out) — pass it straight through as `workspace`.
		const { absFile } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot,
			workspace: dst,
		});
		row.serverId = resolveProbeServerId(
			fx,
			getServersForFileWithConfig(absFile),
		);
		if (install && ensureTool) {
			for (const t of fx.tools ?? [])
				await ensureTool(t).catch(() => undefined);
		}
		if (!lsp.supportsLSP(absFile)) {
			row.mode = "no-lsp";
			row.detail = "no LSP server registered for this file";
			return;
		}

		const auxIds = fx.auxiliaryServerIds ?? [];
		const useAux = auxIds.length > 0;
		const touch = (content, diagWaitMs) =>
			lsp.touchFile(absFile, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: useAux ? "with-auxiliary" : "primary",
				...(useAux ? { auxiliaryServerIds: auxIds } : {}),
				maxClientWaitMs: CLIENT_WAIT_MS,
				maxDiagnosticsWaitMs: diagWaitMs,
				source: "clean-probe",
			});

		const dirtyContent = fs.readFileSync(absFile, "utf8");

		// PHASE-AWARE capture: one sink per phase, switched between touches (a
		// publish can land during touchFile, the settle window, or the capability
		// read, so the sink stays live across each phase's whole span):
		//   dirty phase — the first touch: cold spawn + initialize + first analysis
		//     (generous budget + settle, so a slow cold publish is both captured AND
		//     attributed to the dirty phase, not leaked into the next one);
		//   clean-transition phase — a byte-changing, diagnostic-neutral edit (the
		//     clean→clean analog): bytes differ so the file re-opens (the touch-notify
		//     debounce doesn't dedupe it) and the server re-scans, while the
		//     diagnostic SET is unchanged. Publish here (and whether it carries a
		//     version) is the discriminator.
		const dirtyPubs = [];
		const cleanPubs = [];
		let dirtyResult;
		let support;
		try {
			drainPublishTrace.reset(pubLogSize());
			dirtyResult = await touch(dirtyContent, PROVE_LIVE_WAIT_MS);
			await sleep(SETTLE_MS);
			support = await lsp.getWorkspaceDiagnosticsSupport(absFile);
			await sleep(SETTLE_MS);
			// Phase boundary: every publish written so far is the dirty touch's.
			drainPublishTrace(dirtyPubs, row.serverId);

			fs.writeFileSync(
				absFile,
				`${dirtyContent}\n${commentFor(fx.file)} clean-probe edit\n`,
			);
			await sleep(SETTLE_MS);
			await touch(fs.readFileSync(absFile, "utf8"), STEP_WAIT_MS);
			await sleep(SETTLE_MS);
		} finally {
			drainPublishTrace(cleanPubs, row.serverId);
		}

		row.mode = support?.mode ?? "unknown";
		if (row.mode === "pull") {
			row.behavior = "n/a (pull)";
			row.tier = 1;
			row.tierLabel = "1";
			row.detail = "pull-mode: authoritative clean via textDocument/diagnostic";
			return;
		}

		const obs = {
			dirtyPublishes: dirtyPubs.length,
			dirtyVersioned: dirtyPubs.filter((p) => p.versioned).length,
			cleanTransitionPublishes: cleanPubs.length,
			cleanTransitionVersioned: cleanPubs.filter((p) => p.versioned).length,
		};
		const dirtyDiagCount = Array.isArray(dirtyResult) ? dirtyResult.length : 0;
		const verdict = classifyCleanBehavior(obs);
		// #3310: the first-publish class comes from the dirty phase's publish ORDER,
		// which this trace already holds — no extra touch, no extra server time.
		const firstPublishVerdict = classifyFirstPublish(dirtyPubs);
		row.firstPublish = firstPublishVerdict.firstPublish;
		row.behavior = verdict.behavior;
		row.tier = verdict.tier;
		row.tierLabel = verdict.tierLabel;
		row.detail = `dirtyPubs=${obs.dirtyPublishes}(v:${obs.dirtyVersioned}) cleanPubs=${obs.cleanTransitionPublishes}(v:${obs.cleanTransitionVersioned}) dirtyDiags=${dirtyDiagCount} first-publish=${row.firstPublish} — ${verdict.reason}; ${firstPublishVerdict.reason}`;
	};
}
