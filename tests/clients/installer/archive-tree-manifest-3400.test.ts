/**
 * Archive installs are verified by a spawn-free tree manifest (#3400).
 *
 * An `archive` tool has no `--version` verdict (a JVM/BEAM launcher script
 * starts the runtime on ANY argument), and before this change the only evidence
 * an archive install had was "HTTP 200 and the marker exists": a swapped CDN
 * object or a truncated tree installed and was recorded as a success. The
 * manifest is the pinned archive sha256 (`ArchiveSpec.sha256`, keyed by the
 * resolved URL) plus the launcher/marker found on disk, plus the runtime on
 * PATH before the download.
 *
 * Recurrences these tests name:
 *   - tampered bytes / a URL bumped without its pin installed unchecked;
 *   - a launcher that is present but empty or not executable was shimmed;
 *   - a `tree-manifest` launcher was spawn-verified with `--version` after a
 *     refresh and on the PATH rung, starting a JVM to learn nothing.
 *
 * `node:https` and `safeSpawnAsync` (the tar/unzip extractor) are the only
 * doubles: the extractor double materialises a fixture tree the way the real
 * one would; hashing, verification, swap, ledger and refresh all run for real
 * against a temp `PI_LENS_HOME`. No real download and no real spawn.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createArchivePinScope } from "../../support/archive-pin.js";
import { withEnv } from "../../support/with-env.js";

vi.unmock("../../../clients/installer/index.js");

const TEST_HOME = vi.hoisted(() => {
	const nodeOs = require("node:os") as typeof import("node:os");
	const nodePath = require("node:path") as typeof import("node:path");
	const nodeFs = require("node:fs") as typeof import("node:fs");
	const dir = nodeFs.mkdtempSync(
		nodePath.join(nodeOs.tmpdir(), "pi-lens-3400-"),
	);
	// TOOLS_DIR / GITHUB_BIN_DIR are module-level consts: the override must land
	// before the installer module is imported.
	process.env.PI_LENS_HOME = dir;
	return dir;
});

const { spawnMock, sessionLogSpy, httpsGetMock, chmodMock } = vi.hoisted(
	() => ({
		spawnMock: vi.fn(),
		sessionLogSpy: vi.fn(),
		httpsGetMock: vi.fn(),
		chmodMock: vi.fn(),
	}),
);

// `chmod` is a reconfigurable passthrough so one test can model a filesystem
// where the launcher chmod silently does nothing (noexec / FAT).
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	chmodMock.mockImplementation((...args: Parameters<typeof actual.chmod>) =>
		actual.chmod(...args),
	);
	const mocked = { ...actual, chmod: chmodMock };
	return { ...mocked, default: mocked };
});

vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: spawnMock,
	resetSafeSpawnWindowsCommandCache: vi.fn(),
}));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));

vi.mock("../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: sessionLogSpy,
	flushSessionStartLog: async () => {},
	flushSessionStartLogSync: () => {},
	SESSIONSTART_LOG_FILE: "",
}));

import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	getInstallAttempt,
	getInstallFailureReason,
	getToolPath,
	getAllToolStatuses,
	installTool,
	resetProbeCacheStateForTesting,
	resolveArchiveUrl,
	TOOLS,
} from "../../../clients/installer/index.js";
import { getManagedToolRefreshStatePath } from "../../../clients/installer/managed-tool-refresh.js";
import { runManagedToolRefresh } from "../../../clients/installer/managed-tool-refresh.js";
import { resetManagedToolRefreshSession } from "../../../clients/installer/managed-tool-refresh-session.js";
import { getRefreshableManagedTools } from "../../../clients/installer/index.js";

const TOOLS_DIR = path.join(TEST_HOME, "tools");
const BIN_DIR = path.join(TEST_HOME, "bin");
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const isWindows = process.platform === "win32";

const sha256 = (body: Buffer | string): string =>
	createHash("sha256").update(body).digest("hex");

// --- https double ---------------------------------------------------------

let served = new Map<string, Buffer>();

httpsGetMock.mockImplementation(
	(url: string, _options: unknown, callback: (res: unknown) => void) => {
		const request = new EventEmitter();
		queueMicrotask(() => {
			const body = served.get(url);
			if (!body) {
				request.emit("error", new Error(`no route for ${url}`));
				return;
			}
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = 200;
			res.headers = {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				res.emit("data", body);
				res.emit("end");
			});
		});
		return request;
	},
);

// --- extractor double -----------------------------------------------------

interface FixtureFile {
	content: string;
	mode?: number;
	/** Materialise a DIRECTORY at this path (a launcher that is not a file). */
	dir?: boolean;
}

/**
 * Stand in for tar/unzip: write `files` under the `-C` (tar) / `-d` (unzip)
 * target the installer passed, inside `wrapper` when the archive has one (zip
 * layouts are stripped by the installer, tar layouts by `--strip-components`).
 */
function stubExtractor(
	files: Record<string, FixtureFile>,
	wrapper?: string,
): void {
	spawnMock.mockImplementation(async (_command: string, args: string[]) => {
		const argv = args ?? [];
		const targetIndex = argv.findIndex((a) => a === "-C" || a === "-d");
		if (targetIndex === -1) return { stdout: "1.2.3", stderr: "", status: 0 };
		const root = path.join(
			TOOLS_DIR,
			argv[targetIndex + 1] as string,
			...(wrapper ? [wrapper] : []),
		);
		fs.mkdirSync(root, { recursive: true });
		for (const [rel, file] of Object.entries(files)) {
			const abs = path.join(root, ...rel.split("/"));
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			if (file.dir) {
				fs.mkdirSync(abs);
				continue;
			}
			fs.writeFileSync(abs, file.content, { mode: file.mode ?? 0o755 });
		}
		return { stdout: "", stderr: "", status: 0 };
	});
}

const extractorCalls = (): string[] =>
	spawnMock.mock.calls
		.map(([command, args]) => `${command} ${(args ?? []).join(" ")}`)
		.filter((line) => /-C |-d /.test(line));

// --- registry pin fixture -------------------------------------------------

const pins = createArchivePinScope({ TOOLS, resolveArchiveUrl });

/** Serve `served_` for the tool's archive URL, pinned to `pin.body ?? served_`. */
function route(
	toolId: string,
	served_: Buffer,
	pin: { body?: Buffer; omit?: boolean },
): string {
	const url = pins.pin(toolId, pin.omit ? null : (pin.body ?? served_));
	served.set(url, served_);
	return url;
}

function ledgerRows(): Array<{ subject: string; reason: string }> {
	return (
		getDegradationSummary().find((g) => g.kind === "managed-tool-install")
			?.latestReasons ?? []
	);
}

const logRows = (): string[] =>
	sessionLogSpy.mock.calls.map(([message]) => String(message));

function liveLauncher(toolId: string, rel: string): string {
	const abs = path.join(TOOLS_DIR, toolId, ...rel.split("/"));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, "WORKING-LAUNCHER", { mode: 0o755 });
	return abs;
}

const GOOD = Buffer.from("fixture-archive-bytes");
const TAMPERED = Buffer.from("fixture-archive-bytes!");
const LAUNCHER = `${isWindows ? ".bat" : ""}`;

let originalPath: string | undefined;
let fakeBin: string;
let restoreEnv: () => void;
let restoreJavaHome: () => void;

beforeEach(() => {
	fs.rmSync(TOOLS_DIR, { recursive: true, force: true });
	fs.rmSync(BIN_DIR, { recursive: true, force: true });
	fs.mkdirSync(TOOLS_DIR, { recursive: true });
	served = new Map();
	httpsGetMock.mockClear();
	spawnMock.mockReset();
	sessionLogSpy.mockReset();
	chmodMock.mockClear();
	resetDegradationLedger();
	resetManagedToolRefreshSession();
	resetProbeCacheStateForTesting();
	spawnMock.mockImplementation(async () => ({
		stdout: "1.2.3",
		stderr: "",
		status: 0,
	}));
	originalPath = process.env.PATH;
	fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3400-path-"));
	// A JRE on PATH by default; the runtime test removes it.
	for (const name of ["java", "java.exe"]) {
		fs.writeFileSync(path.join(fakeBin, name), "x");
	}
	process.env.PATH = fakeBin;
	restoreEnv = withEnv({ PI_LENS_DISABLE_TOOL_INSTALL: "0" });
	// An ambient JAVA_HOME on the dev box must not satisfy the runtime gate.
	restoreJavaHome = withEnv({ JAVA_HOME: undefined });
});

afterEach(() => {
	pins.restoreAll();
	fs.rmSync(fakeBin, { recursive: true, force: true });
	if (originalPath !== undefined) process.env.PATH = originalPath;
	restoreEnv();
	restoreJavaHome();
	vi.unstubAllEnvs();
});

afterAll(() => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// --- the two shapes: a launcher archive and a tree bundle ------------------

const SHAPES = [
	{
		label: "launcher archive (spotbugs)",
		toolId: "spotbugs",
		files: { "bin/spotbugs": { content: "#!/bin/sh\nexit 0\n" } },
		liveRel: "bin/spotbugs",
	},
	{
		label: "tree bundle (powershell-editor-services)",
		toolId: "powershell-editor-services",
		files: {
			"PowerShellEditorServices/Start-EditorServices.ps1": {
				content: "# bootstrap",
			},
		},
		liveRel: "PowerShellEditorServices/Start-EditorServices.ps1",
	},
] as const;

describe.each(SHAPES)("archive install integrity: $label", (shape) => {
	it("refuses tampered bytes before extraction, keeps the live tree, and records once", async () => {
		const live = liveLauncher(shape.toolId, shape.liveRel);
		route(shape.toolId, TAMPERED, { body: GOOD });
		stubExtractor({ ...shape.files });

		const ok = await installTool(shape.toolId);

		expect(ok).toBe(false);
		// No byte of the tampered archive reached the extractor.
		expect(extractorCalls()).toEqual([]);
		expect(fs.readFileSync(live, "utf-8")).toBe("WORKING-LAUNCHER");
		expect(ledgerRows()).toEqual([
			{
				subject: expect.stringContaining(`${shape.toolId}:`),
				reason: "archive integrity sha256-mismatch",
			},
		]);
		expect(ledgerRows()[0]?.subject).toMatch(/:integrity$/);
		expect(getInstallAttempt(shape.toolId)).toMatchObject({
			outcome: "failed",
		});
		expect(getInstallFailureReason(shape.toolId)).toContain("sha256-mismatch");
		expect(
			logRows().some(
				(l) =>
					l.includes(`archive-install ${shape.toolId}`) &&
					l.includes("refused sha256-mismatch"),
			),
		).toBe(true);
	});

	it("refuses a URL that has no pin instead of installing it unchecked", async () => {
		liveLauncher(shape.toolId, shape.liveRel);
		route(shape.toolId, GOOD, { omit: true });
		stubExtractor({ ...shape.files });

		const ok = await installTool(shape.toolId);

		expect(ok).toBe(false);
		expect(extractorCalls()).toEqual([]);
		expect(ledgerRows().map((r) => r.reason)).toEqual([
			"archive integrity sha256-unpinned",
		]);
		expect(getInstallFailureReason(shape.toolId)).toContain("sha256-unpinned");
	});

	it("installs an archive whose bytes match the pin", async () => {
		route(shape.toolId, GOOD, {});
		stubExtractor({ ...shape.files });

		const ok = await installTool(shape.toolId);

		expect(ok).toBe(true);
		expect(ledgerRows()).toEqual([]);
		// Review F7: the success row names the digest that was verified.
		expect(
			logRows().some(
				(l) =>
					l.includes(`archive-install ${shape.toolId}: installed`) &&
					l.includes(`sha256 verified ${sha256(GOOD)}`),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(TOOLS_DIR, shape.toolId, ...shape.liveRel.split("/")),
			),
		).toBe(true);
		expect(extractorCalls()).toHaveLength(1);
	});

	it("refuses a correctly pinned archive whose tree lacks the launcher or marker", async () => {
		const live = liveLauncher(shape.toolId, shape.liveRel);
		route(shape.toolId, GOOD, {});
		stubExtractor({ "unrelated.txt": { content: "nothing useful" } });

		const ok = await installTool(shape.toolId);

		expect(ok).toBe(false);
		expect(fs.readFileSync(live, "utf-8")).toBe("WORKING-LAUNCHER");
		expect(ledgerRows().map((r) => r.reason)).toEqual([
			expect.stringMatching(/archive extraction (launcher|marker)-missing/),
		]);
	});
});

describe("archive launcher must be runnable, not merely present", () => {
	it("refuses an empty launcher and keeps the live tree", async () => {
		const live = liveLauncher("spotbugs", "bin/spotbugs");
		route("spotbugs", GOOD, {});
		stubExtractor({ [`bin/spotbugs`]: { content: "" } });

		const ok = await installTool("spotbugs");

		expect(ok).toBe(false);
		expect(fs.readFileSync(live, "utf-8")).toBe("WORKING-LAUNCHER");
		expect(ledgerRows().map((r) => r.reason)).toEqual([
			"archive extraction launcher-invalid",
		]);
		expect(fs.existsSync(path.join(BIN_DIR, "spotbugs"))).toBe(false);
	});

	// Review F3: size and mode alone would pass a directory (non-zero size, 0755).
	it("refuses a launcher path that is a directory", async () => {
		const live = liveLauncher("spotbugs", "bin/spotbugs");
		route("spotbugs", GOOD, {});
		stubExtractor({ "bin/spotbugs": { content: "", dir: true } });

		const ok = await installTool("spotbugs");

		expect(ok).toBe(false);
		expect(fs.readFileSync(live, "utf-8")).toBe("WORKING-LAUNCHER");
		expect(ledgerRows().map((r) => r.reason)).toEqual([
			"archive extraction launcher-invalid",
		]);
	});

	// lane: Unit tests (ubuntu) — X_OK is a POSIX mode property; Windows has no
	// executable bit to lose, and the installer skips the check there.
	it.skipIf(isWindows)(
		"refuses a launcher the filesystem would not let chmod make executable",
		async () => {
			const live = liveLauncher("spotbugs", "bin/spotbugs");
			route("spotbugs", GOOD, {});
			stubExtractor({
				"bin/spotbugs": { content: "#!/bin/sh\nexit 0\n", mode: 0o644 },
			});
			// A chmod that "succeeds" and changes nothing (FAT, or a zip entry that
			// never carried the exec bit).
			chmodMock.mockImplementation(async () => {});

			const ok = await installTool("spotbugs");

			expect(ok).toBe(false);
			expect(fs.readFileSync(live, "utf-8")).toBe("WORKING-LAUNCHER");
			expect(ledgerRows().map((r) => r.reason)).toEqual([
				"archive extraction launcher-invalid",
			]);
			expect(fs.existsSync(path.join(BIN_DIR, "spotbugs"))).toBe(false);
		},
	);
});

// --- kotlin-language-server: the first consumer ----------------------------

describe("kotlin-language-server registry entry (#3400)", () => {
	const kotlin = TOOLS.find((t) => t.id === "kotlin-language-server");

	it("is a pinned, manifest-verified launcher archive that needs java", () => {
		expect(kotlin?.installStrategy).toBe("archive");
		expect(kotlin?.verification).toBe("tree-manifest");
		expect(kotlin?.archive?.launcher).toBe("bin/kotlin-language-server");
		expect(kotlin?.archive?.runtime).toBe("java");
		const url = resolveArchiveUrl(kotlin!.archive!) as string;
		expect(url).toMatch(
			/fwcd\/kotlin-language-server\/releases\/download\/[\d.]+\/server\.zip$/,
		);
		expect(kotlin?.archive?.sha256?.[url]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("installs from a zip whose launcher sits under a stripped top-level dir", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor(
			{
				[`bin/kotlin-language-server${LAUNCHER}`]: {
					content: "#!/bin/sh\nexit 0\n",
				},
			},
			"server",
		);

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(true);
		expect(
			fs.existsSync(path.join(BIN_DIR, `kotlin-language-server${LAUNCHER}`)),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(
					TOOLS_DIR,
					"kotlin-language-server",
					"bin",
					`kotlin-language-server${LAUNCHER}`,
				),
			),
		).toBe(true);
	});

	it("is unavailable without java and never downloads the archive", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor({});
		process.env.PATH = path.join(fakeBin, "no-java-here");

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(false);
		expect(httpsGetMock).not.toHaveBeenCalled();
		expect(getInstallAttempt("kotlin-language-server")).toMatchObject({
			outcome: "unavailable",
			reason: "runtime java not found on PATH",
		});
		expect(logRows()).toContain(
			"auto-install kotlin-language-server: runtime java not found on PATH",
		);
	});

	// Review F2: fwcd's launcher resolves $JAVA_HOME/bin/java, so a box whose
	// JDK is reachable only through JAVA_HOME can run it and must not be refused.
	it("accepts a JAVA_HOME-only java and installs", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor(
			{
				[`bin/kotlin-language-server${LAUNCHER}`]: {
					content: "#!/bin/sh\nexit 0\n",
				},
			},
			"server",
		);
		process.env.PATH = path.join(fakeBin, "no-java-here");
		const jdk = path.join(fakeBin, "jdk");
		fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
		fs.writeFileSync(
			path.join(jdk, "bin", isWindows ? "java.exe" : "java"),
			"x",
			{ mode: 0o755 },
		);
		process.env.JAVA_HOME = jdk;

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(true);
		expect(httpsGetMock).toHaveBeenCalledTimes(1);
	});

	// Round 3 R-A: fwcd's launcher treats a NON-EMPTY JAVA_HOME as authoritative
	// and dies "JAVA_HOME is set to an invalid directory" when
	// $JAVA_HOME/bin/java is not executable, whatever PATH has. A gate that ORs
	// PATH java with JAVA_HOME java downloads 87 MB for a launcher that cannot
	// start. PATH has a good java in every test below (beforeEach).
	it("refuses a stale JAVA_HOME even though PATH has a java, before any download", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor({});
		process.env.JAVA_HOME = path.join(fakeBin, "deleted-jdk");

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(false);
		expect(httpsGetMock).not.toHaveBeenCalled();
		expect(getInstallAttempt("kotlin-language-server")).toMatchObject({
			outcome: "unavailable",
			reason: "runtime java is not an executable file under JAVA_HOME",
		});
	});

	// lane: Unit tests (ubuntu) — the exec bit is a POSIX mode property.
	it.skipIf(isWindows)(
		"refuses a mode-644 JAVA_HOME java even though PATH has a java",
		async () => {
			route("kotlin-language-server", GOOD, {});
			stubExtractor({});
			const jdk = path.join(fakeBin, "noexec-jdk");
			fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
			fs.writeFileSync(path.join(jdk, "bin", "java"), "x", { mode: 0o644 });
			process.env.JAVA_HOME = jdk;

			const ok = await installTool("kotlin-language-server");

			expect(ok).toBe(false);
			expect(httpsGetMock).not.toHaveBeenCalled();
		},
	);

	it("falls back to PATH java when JAVA_HOME is empty", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor(
			{
				[`bin/kotlin-language-server${LAUNCHER}`]: {
					content: "#!/bin/sh\nexit 0\n",
				},
			},
			"server",
		);
		process.env.JAVA_HOME = "";

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(true);
		expect(httpsGetMock).toHaveBeenCalledTimes(1);
	});

	// Round 3 S-1: on win32 the JDK's executable is bin/java.exe. The platform
	// override is the installer's own test seam, so the ubuntu lane covers the
	// name selection. The gate is what is under test: the download is attempted
	// (the later extract step is the POSIX stub's and is not asserted).
	it("accepts a win32 JAVA_HOME whose only java is bin/java.exe", async () => {
		const restore = withEnv({ PI_LENS_TEST_PLATFORM: "win32" });
		try {
			route("kotlin-language-server", GOOD, {});
			stubExtractor({});
			process.env.PATH = path.join(fakeBin, "no-java-here");
			const jdk = path.join(fakeBin, "win-jdk");
			fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
			fs.writeFileSync(path.join(jdk, "bin", "java.exe"), "x", { mode: 0o644 });
			process.env.JAVA_HOME = jdk;

			await installTool("kotlin-language-server");

			expect(httpsGetMock).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it.each([
		["an empty file", (javaPath: string) => fs.writeFileSync(javaPath, "")],
		["a directory", (javaPath: string) => fs.mkdirSync(javaPath)],
	])("does not count a JAVA_HOME java that is %s", async (_label, makeJava) => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor({});
		process.env.PATH = path.join(fakeBin, "no-java-here");
		const jdk = path.join(fakeBin, "broken-jdk");
		fs.mkdirSync(path.join(jdk, "bin"), { recursive: true });
		makeJava(path.join(jdk, "bin", isWindows ? "java.exe" : "java"));
		process.env.JAVA_HOME = jdk;

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(false);
		expect(httpsGetMock).not.toHaveBeenCalled();
	});

	it("still refuses when JAVA_HOME points at a directory with no java", async () => {
		route("kotlin-language-server", GOOD, {});
		stubExtractor({});
		process.env.PATH = path.join(fakeBin, "no-java-here");
		process.env.JAVA_HOME = path.join(fakeBin, "empty-jdk");

		const ok = await installTool("kotlin-language-server");

		expect(ok).toBe(false);
		expect(httpsGetMock).not.toHaveBeenCalled();
		expect(getInstallAttempt("kotlin-language-server")).toMatchObject({
			outcome: "unavailable",
		});
	});

	// Review F1: the /lens-tools listing (getAllToolStatuses, awaited by the
	// command handler) probed a PATH copy with --version, starting a JVM.
	it("lists a PATH kotlin-language-server without spawning it, but still probes other PATH tools", async () => {
		for (const name of ["kotlin-language-server", "actionlint"]) {
			fs.writeFileSync(path.join(fakeBin, name), "#!/bin/sh\nexit 0\n", {
				mode: 0o755,
			});
			if (isWindows) fs.writeFileSync(path.join(fakeBin, `${name}.exe`), "x");
		}

		const statuses = await getAllToolStatuses();

		const kotlin = statuses.find((t) => t.id === "kotlin-language-server");
		expect(kotlin).toMatchObject({ installed: true, source: "global-path" });
		expect(kotlin?.version).toBeUndefined();
		expect(
			spawnMock.mock.calls.filter(([command]) =>
				String(command).includes("kotlin-language-server"),
			),
		).toEqual([]);
		// Control: a tool that is not `tree-manifest` still gets its version probe.
		expect(statuses.find((t) => t.id === "actionlint")?.version).toBe("1.2.3");
	});

	it("refresh does not spawn the JVM launcher to verify the new tree", async () => {
		// A live install + a stale stamp, so the refresh downloads the pinned zip.
		fs.mkdirSync(BIN_DIR, { recursive: true });
		const shim = path.join(BIN_DIR, `kotlin-language-server${LAUNCHER}`);
		fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const stamps: Record<string, unknown> = {};
		for (const candidate of getRefreshableManagedTools()) {
			if (candidate.toolId !== "kotlin-language-server") {
				stamps[candidate.toolId] = { checkedAt: NOW };
			}
		}
		stamps["kotlin-language-server"] = {
			checkedAt: NOW - 8 * DAY_MS,
			resolutionId: "stale-url",
		};
		fs.mkdirSync(TOOLS_DIR, { recursive: true });
		fs.writeFileSync(
			getManagedToolRefreshStatePath(),
			JSON.stringify({ version: 1, tools: stamps }),
		);
		route("kotlin-language-server", GOOD, {});
		stubExtractor(
			{
				[`bin/kotlin-language-server${LAUNCHER}`]: {
					content: "#!/bin/sh\nexit 0\n",
				},
			},
			"server",
		);

		const outcome = await runManagedToolRefresh(NOW);

		expect(outcome.refreshed[0]).toMatchObject({
			toolId: "kotlin-language-server",
			strategy: "archive",
			ok: true,
			changed: true,
		});
		expect(
			spawnMock.mock.calls.filter(([command]) =>
				String(command).includes("kotlin-language-server"),
			),
		).toEqual([]);
	});

	it("resolves a PATH kotlin-language-server without a --version spawn", async () => {
		fs.writeFileSync(
			path.join(fakeBin, "kotlin-language-server"),
			"#!/bin/sh\nexit 0\n",
			{
				mode: 0o755,
			},
		);
		if (isWindows) {
			fs.writeFileSync(path.join(fakeBin, "kotlin-language-server.exe"), "x");
		}
		// The launcher answers an unknown argument with a nonzero exit.
		spawnMock.mockImplementation(async (command: string) =>
			String(command).includes("kotlin-language-server")
				? { stdout: "", stderr: "unknown option", status: 1 }
				: { stdout: "1.2.3", stderr: "", status: 0 },
		);

		const resolved = await getToolPath("kotlin-language-server");

		expect(resolved).toBe("kotlin-language-server");
		expect(
			spawnMock.mock.calls.filter(([command]) =>
				String(command).includes("kotlin-language-server"),
			),
		).toEqual([]);
	});
});
