/**
 * Tests for #190 Phase 1 — per-session diagnostic state persistence + the
 * widget-state export/import that backs resume rehydration.
 */

import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	dropStaleFiles,
	loadSessionState,
	saveSessionState,
	STATE_VERSION,
} from "../../clients/session-state-store.js";
import type { PersistedReadGuardState } from "../../clients/read-guard.js";
import { createReadGuard } from "../../clients/read-guard.js";
import {
	clearWidgetState,
	exportWidgetState,
	getFileDiagnosticSummaries,
	importWidgetState,
	type PersistedWidgetState,
	recordDiagnostics,
	reconcileStaleWidgetFiles,
	widgetStore,
} from "../../clients/widget-state.js";
import { beginScope } from "../../clients/session-scope.js";

let dataDir: string;
let prevDataDir: string | undefined;
const cwd = "/proj/example";

beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "pi-lens-session-store-"));
	prevDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = dataDir;
});

afterAll(() => {
	if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = prevDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => clearWidgetState());

function seedDiagnostics() {
	recordDiagnostics("/proj/example/a.ts", [
		{
			tool: "tsc",
			severity: "error",
			semantic: "blocking",
			message: "boom",
			line: 5,
		},
	]);
	recordDiagnostics("/proj/example/b.ts", [
		{
			tool: "eslint",
			severity: "warning",
			message: "meh",
			line: 2,
			rule: "no-x",
		},
	]);
}

describe("widget-state export/import (#190)", () => {
	it("round-trips the per-file diagnostic state", () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		expect(before).toHaveLength(2);

		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		expect(importWidgetState(snapshot)).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("rejects a snapshot from a different version (no partial import)", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		clearWidgetState();
		expect(importWidgetState({ ...snapshot, version: 999 })).toBe(false);
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});

	it("does NOT persist lspServers (process-bound) — only files + languages", () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		expect(Object.keys(snapshot)).toEqual(
			expect.arrayContaining(["version", "sessionLanguages", "files"]),
		);
		expect(
			(snapshot as unknown as Record<string, unknown>).lspServers,
		).toBeUndefined();
	});
});

describe("session-state-store save/load (#190)", () => {
	it("persists and reloads a session's widget snapshot keyed by session id", async () => {
		seedDiagnostics();
		const snapshot = exportWidgetState();
		await saveSessionState(cwd, "019ead34-uuid", { widget: snapshot });

		const loaded = await loadSessionState(cwd, "019ead34-uuid");
		expect(loaded?.sessionId).toBe("019ead34-uuid");
		expect(loaded?.stores.widget).toEqual(snapshot);
	});

	it("returns undefined for an unknown or empty session id", async () => {
		expect(await loadSessionState(cwd, "never-saved")).toBeUndefined();
		expect(await loadSessionState(cwd, "")).toBeUndefined();
		expect(await loadSessionState(cwd, undefined)).toBeUndefined();
	});

	it("save is a no-op for a missing session id (no throw)", async () => {
		await expect(
			saveSessionState(cwd, undefined, { widget: exportWidgetState() }),
		).resolves.toBeUndefined();
		await expect(
			saveSessionState(cwd, "", { widget: exportWidgetState() }),
		).resolves.toBeUndefined();
	});

	it("end-to-end resume flow: save → clear → load → import restores findings", async () => {
		seedDiagnostics();
		const before = getFileDiagnosticSummaries();
		await saveSessionState(cwd, "resume-me", { widget: exportWidgetState() });

		// Simulate a fresh process: nothing in memory.
		clearWidgetState();
		expect(getFileDiagnosticSummaries()).toEqual([]);

		// Resume: load by the same stable id and rehydrate.
		const loaded = await loadSessionState(cwd, "resume-me");
		expect(
			importWidgetState(loaded?.stores.widget as PersistedWidgetState),
		).toBe(true);
		expect(getFileDiagnosticSummaries()).toEqual(before);
	});

	it("rejects and ignores a persisted snapshot whose version does not match STATE_VERSION (#1106)", async () => {
		seedDiagnostics();
		await saveSessionState(cwd, "wrong-version-session", {
			widget: exportWidgetState(),
		});

		// Sanity: the freshly-saved snapshot loads fine at the current version.
		const before = await loadSessionState(cwd, "wrong-version-session");
		expect(before?.version).toBe(STATE_VERSION);

		// Corrupt the on-disk version to a deliberate mismatch (never a hardcoded
		// literal — #1116 pattern) and confirm the reject path is taken: the
		// caller sees `undefined`, exactly like a missing/corrupt file.
		const sessionsDir = join(getProjectDataDir(cwd), "sessions");
		const [file] = readdirSync(sessionsDir).filter((f) =>
			f.includes("wrong-version-session"),
		);
		const filePath = join(sessionsDir, file);
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		raw.version = STATE_VERSION + 1;
		writeFileSync(filePath, JSON.stringify(raw));

		const loaded = await loadSessionState(cwd, "wrong-version-session");
		expect(loaded).toBeUndefined();
	});

	it("isolates sessions: one id's state does not leak into another", async () => {
		seedDiagnostics();
		await saveSessionState(cwd, "session-A", { widget: exportWidgetState() });

		clearWidgetState();
		recordDiagnostics("/proj/example/c.ts", [
			{ tool: "ruff", severity: "error", message: "other", line: 1 },
		]);
		await saveSessionState(cwd, "session-B", { widget: exportWidgetState() });

		const files = (state: Awaited<ReturnType<typeof loadSessionState>>) =>
			(state?.stores.widget as PersistedWidgetState | undefined)?.files.map(
				(f) => f.filePath,
			) ?? [];
		expect(files(await loadSessionState(cwd, "session-A")).sort()).toEqual([
			"/proj/example/a.ts",
			"/proj/example/b.ts",
		]);
		expect(files(await loadSessionState(cwd, "session-B"))).toEqual([
			"/proj/example/c.ts",
		]);
	});
});

describe("dropStaleFiles — freshness reconciliation (#190/#180)", () => {
	let fsDir: string;
	const fileEntry = (
		filePath: string,
	): PersistedWidgetState["files"][number] => ({
		filePath,
		runners: [],
		formatters: [],
		diagnostics: [],
		allDiagnostics: [],
		diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
		hasFinalDiagnosticsSnapshot: true,
		touchedAt: 0,
	});

	beforeAll(() => {
		fsDir = mkdtempSync(join(tmpdir(), "pi-lens-stale-"));
	});
	afterAll(() => rmSync(fsDir, { recursive: true, force: true }));

	it("keeps unchanged files, drops files modified or deleted since the snapshot", async () => {
		const fresh = join(fsDir, "fresh.ts");
		const modified = join(fsDir, "modified.ts");
		const gone = join(fsDir, "gone.ts"); // never created on disk
		writeFileSync(fresh, "a");
		writeFileSync(modified, "b");

		const savedAt = Date.now();
		// fresh: last modified well before the snapshot → unchanged → keep
		utimesSync(fresh, new Date(savedAt - 60_000), new Date(savedAt - 60_000));
		// modified: touched after the snapshot → stale → drop
		utimesSync(
			modified,
			new Date(savedAt + 60_000),
			new Date(savedAt + 60_000),
		);

		const widget: PersistedWidgetState = {
			version: 1,
			sessionLanguages: [],
			files: [fileEntry(fresh), fileEntry(modified), fileEntry(gone)],
		};

		const result = await dropStaleFiles(widget, savedAt);
		expect(result.files.map((f) => f.filePath)).toEqual([fresh]);
	});

	it("preserves non-file fields and returns all files when none are stale", async () => {
		const a = join(fsDir, "a.ts");
		writeFileSync(a, "x");
		const savedAt = Date.now() + 60_000; // snapshot "after" the file mtime
		const widget: PersistedWidgetState = {
			version: 1,
			sessionLanguages: ["typescript"],
			files: [fileEntry(a)],
		};
		const result = await dropStaleFiles(widget, savedAt);
		expect(result.sessionLanguages).toEqual(["typescript"]);
		expect(result.files).toHaveLength(1);
	});
});

describe("reconcileStaleWidgetFiles — live widget freshness (lens_diagnostics)", () => {
	let liveDir: string;
	beforeAll(() => {
		liveDir = mkdtempSync(join(tmpdir(), "pi-lens-live-stale-"));
	});
	afterAll(() => rmSync(liveDir, { recursive: true, force: true }));
	beforeEach(() => clearWidgetState());

	it("drops files edited after their diagnostics were recorded, keeps unchanged ones", async () => {
		const fixed = join(liveDir, "fixed.ts");
		const unchanged = join(liveDir, "unchanged.ts");
		writeFileSync(fixed, "before");
		writeFileSync(unchanged, "stable");

		recordDiagnostics(fixed, [
			{ tool: "tsc", severity: "error", message: "boom", line: 1 },
		]);
		recordDiagnostics(unchanged, [
			{ tool: "eslint", severity: "warning", message: "meh", line: 1 },
		]);
		expect(getFileDiagnosticSummaries()).toHaveLength(2);

		// Simulate the agent fixing `fixed` AFTER it was last recorded: its mtime
		// now postdates touchedAt. `unchanged` keeps an older mtime.
		const recordedAt = Date.now();
		utimesSync(
			unchanged,
			new Date(recordedAt - 60_000),
			new Date(recordedAt - 60_000),
		);
		utimesSync(
			fixed,
			new Date(recordedAt + 60_000),
			new Date(recordedAt + 60_000),
		);

		const dropped = await reconcileStaleWidgetFiles();
		expect(dropped).toBe(1);
		expect(getFileDiagnosticSummaries().map((s) => s.filePath)).toEqual([
			unchanged,
		]);
	});

	it("drops entries whose file was deleted", async () => {
		const gone = join(liveDir, "gone.ts");
		writeFileSync(gone, "x");
		recordDiagnostics(gone, [
			{ tool: "tsc", severity: "error", message: "x", line: 1 },
		]);
		rmSync(gone, { force: true });

		expect(await reconcileStaleWidgetFiles()).toBe(1);
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});
});

describe("read-guard read-set persistence across resume (#1041)", () => {
	it("save → load → import rehydrates the read-set so a resumed edit is allowed", async () => {
		// Real file on disk so recordRead captures line hashes and the resumed
		// edit's per-line check can compare them against current content.
		const fileDir = mkdtempSync(join(tmpdir(), "pi-lens-rg-resume-"));
		const filePath = join(fileDir, "foo.ts");
		writeFileSync(
			filePath,
			`${Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
		);
		// Backdate mtime so the file reads as authored in a prior session (the
		// resume scenario) rather than "written this session" — otherwise the edit
		// is session-authored-allowed and the zero-read baseline assertion is moot.
		const longAgo = new Date("2000-01-01T00:00:00Z");
		utimesSync(filePath, longAgo, longAgo);
		try {
			// Session 1: record a read, then persist on the SAME #190 snapshot the
			// widget state rides.
			const guard1 = createReadGuard("resume-session");
			guard1.recordRead({
				filePath,
				requestedOffset: 1,
				requestedLimit: 50,
				effectiveOffset: 1,
				effectiveLimit: 50,
				expandedByLsp: false,
				turnIndex: 1,
				writeIndex: 1,
				timestamp: Date.now(),
				toolCallId: "call_resume_read",
			});
			await saveSessionState(cwd, "resume-session", {
				widget: exportWidgetState(),
				"read-guard": guard1.exportState(),
			});

			// Resume: fresh guard, load persisted state, import.
			const loaded = await loadSessionState(cwd, "resume-session");
			const readGuard = loaded?.stores["read-guard"] as
				| PersistedReadGuardState
				| undefined;
			expect(readGuard).toBeDefined();
			const guard2 = createReadGuard("resume-session-2");
			expect(guard2.checkEdit(filePath, [20, 30]).action).toBe("block");
			// #3521: the read's tool result is on the resumed branch.
			const result = guard2.importBranch(
				readGuard,
				new Set(["call_resume_read"]),
			);
			expect(result.imported).toBe(1);
			expect(guard2.getReadHistory(filePath)).toHaveLength(1);
			expect(guard2.checkEdit(filePath, [20, 30]).action).toBe("allow");
		} finally {
			rmSync(fileDir, { recursive: true, force: true });
		}
	});

	it("backward-compat: a version-1 read-set loads as a clean guard, never a crash (#3521)", async () => {
		// Before #3521 records carried no toolCallId, so nothing can be matched
		// against the branch: the widget still rehydrates, the guard starts clean.
		const fileDir = mkdtempSync(join(tmpdir(), "pi-lens-rg-v1-"));
		const filePath = join(fileDir, "foo.ts");
		writeFileSync(filePath, "a\nb\nc\n");
		try {
			seedDiagnostics();
			const v1Record = {
				filePath,
				requestedOffset: 1,
				requestedLimit: 3,
				effectiveOffset: 1,
				effectiveLimit: 3,
				expandedByLsp: false,
				turnIndex: 1,
				writeIndex: 1,
				timestamp: Date.now(),
			};
			await saveSessionState(cwd, "v1-session", {
				widget: exportWidgetState(),
				"read-guard": { version: 1, reads: [[filePath, [v1Record]]] },
			});
			const loaded = await loadSessionState(cwd, "v1-session");
			expect(
				(loaded?.stores.widget as PersistedWidgetState | undefined)?.files
					.length,
			).toBeGreaterThan(0);
			const guard = createReadGuard("v1-session");
			expect(
				guard.importBranch(
					loaded?.stores["read-guard"] as PersistedReadGuardState,
					new Set(["anything"]),
				),
			).toEqual({ imported: 0, dropped: 0 });
			expect(guard.getReadHistory(filePath)).toHaveLength(0);
		} finally {
			rmSync(fileDir, { recursive: true, force: true });
		}
	});
});

/**
 * #3612: the sidecar envelope moved to version 2 (one payload per session
 * store). The recurrence: an envelope change that stops reading the files
 * the previous build wrote, so every resume after an upgrade starts empty.
 * The fixtures were written by the version-1 build (`origin/master` before
 * #3612) through its own `saveSessionState`.
 */
describe("version-1 sidecars still load (#3612)", () => {
	const FIXTURES = join(__dirname, "..", "fixtures", "session-state");

	async function loadFixture(name: string) {
		const sessionsDir = join(getProjectDataDir(cwd), "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		copyFileSync(
			join(FIXTURES, `${name}.json`),
			join(sessionsDir, `${name}.json`),
		);
		return loadSessionState(cwd, name);
	}

	it("loads a widget-only version-1 file as the widget store", async () => {
		const loaded = await loadFixture("v1-widget");
		expect(loaded?.savedAt).toBe(1759250000000);
		expect(loaded?.stores["read-guard"]).toBeUndefined();
		expect(
			importWidgetState(loaded?.stores.widget as PersistedWidgetState),
		).toBe(true);
		expect(getFileDiagnosticSummaries().map((f) => f.filePath)).toEqual([
			"/proj/example/a.ts",
		]);
	});

	it("loads a version-1 file's read-set as the read-guard store", async () => {
		const loaded = await loadFixture("v1-widget-read-guard");
		expect(loaded?.stores.widget).toBeDefined();
		const readGuard = loaded?.stores["read-guard"] as PersistedReadGuardState;
		expect(readGuard.reads.map(([key]) => key)).toEqual(["/proj/example/a.ts"]);
		// The record parses: its tool call is on the branch, and only the
		// missing file drops it.
		expect(
			createReadGuard("v1-fixture").importBranch(
				readGuard,
				new Set(["call_fixture_read"]),
			),
		).toEqual({ imported: 0, dropped: 1 });
	});

	it("loads a version-2 file whose stores are not an object as nothing", async () => {
		const sessionsDir = join(getProjectDataDir(cwd), "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		for (const [name, stores] of [
			["v2-null-stores", null],
			["v2-string-stores", "widget"],
		] as const) {
			writeFileSync(
				join(sessionsDir, `${name}.json`),
				JSON.stringify({ version: 2, sessionId: name, savedAt: 1, stores }),
			);
			expect(await loadSessionState(cwd, name), name).toBeUndefined();
		}
	});

	it("writes version 2 and never version 1", async () => {
		await saveSessionState(cwd, "v2-written", { widget: exportWidgetState() });
		const sessionsDir = join(getProjectDataDir(cwd), "sessions");
		const raw = JSON.parse(
			readFileSync(join(sessionsDir, "v2-written.json"), "utf-8"),
		);
		expect(raw.version).toBe(2);
		expect(raw.widget).toBeUndefined();
		expect(raw.stores.widget).toBeDefined();
	});
});

/**
 * #3612: the widget as a session store. The recurrences: a resume or a
 * `pi --fork` that shows a file changed on disk since its sidecar was saved
 * (#180/#190), and a malformed sidecar that crashes the session start.
 */
describe("the widget store's restore (#3612)", () => {
	function ctxFor(source: "own-sidecar", savedAt: number) {
		return {
			reason: "fork" as const,
			source,
			savedAt,
			sessionManager: undefined,
			cwd,
		};
	}

	it("reconciles a sidecar with disk: a file changed since the save re-scans", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-widget-store-"));
		try {
			const kept = join(dir, "kept.ts");
			const changed = join(dir, "changed.ts");
			for (const file of [kept, changed]) {
				writeFileSync(file, "x\n");
				utimesSync(file, new Date(1_000_000), new Date(1_000_000));
				recordDiagnostics(file, [
					{ tool: "tsc", severity: "error", message: "boom", line: 1 },
				]);
			}
			const saved = exportWidgetState();
			utimesSync(changed, new Date(9_000_000), new Date(9_000_000));
			const scope = beginScope({ role: "primary" });
			const files = () =>
				getFileDiagnosticSummaries()
					.map((f) => f.filePath)
					.sort();

			await widgetStore.restore(scope, saved, ctxFor("own-sidecar", 9_000_000));
			expect(files()).toEqual([changed, kept].sort());

			await widgetStore.restore(scope, saved, ctxFor("own-sidecar", 2_000_000));
			expect(files()).toEqual([kept]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restores a payload without files as an empty widget", async () => {
		seedDiagnostics();
		const scope = beginScope({ role: "primary" });
		await widgetStore.restore(scope, { version: 3 }, ctxFor("own-sidecar", 1));
		await widgetStore.restore(scope, undefined, ctxFor("own-sidecar", 1));
		expect(getFileDiagnosticSummaries()).toEqual([]);
	});
});
