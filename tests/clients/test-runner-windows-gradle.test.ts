/**
 * #3956 — Windows Gradle test runs must reach the repository-local wrapper.
 *
 * On Windows `RUNNERS.gradle.command` used to be a bare `gradlew.bat`. The
 * Windows resolver treats a separator-less command as a PATH-only name, so the
 * repository-local wrapper was never considered: resolution returned `null`,
 * `synthesizeEnoentError` produced `tool-not-found`, and the runner surfaced
 * `Runner error: spawn gradlew.bat ENOENT` even though the child cwd was the
 * directory that owns the wrapper.
 *
 * These cases drive the REAL `TestRunnerClient.runTestFileAsync` through the
 * REAL `safeSpawnAsync`, `resolveWindowsCommand`, and `buildWindowsShellCommand`
 * and intercept only the two external boundaries the owner suites already
 * intercept (`safe-spawn-windows-env-plumbing.test.ts` is the precedent):
 * `node:fs`'s `statSync` (so Windows-shaped resolution runs in pure JS) and
 * `node:child_process`'s `spawn`/`spawnSync` (so no real OS process starts).
 * The production owner, resolver, and command builder are never mocked, and
 * the fake child is the shared `makeFakeChild` fixture.
 *
 * `process.platform` is forced before the dynamic import so the load-time
 * `RUNNERS` table evaluates the Windows spelling on any host OS (AGENTS defect
 * shape 30: a module-load platform constant must not be exercised as Linux
 * twice).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeChild } from "../support/fake-child.js";

const statSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: statSyncMock };
});

// Typed with the real call shape so `.mock.calls[n]` is a proper 3-tuple, the
// same trap `safe-spawn-windows-env-plumbing.test.ts` documents.
const spawnMock = vi.hoisted(() =>
	vi.fn(
		(
			_command: string,
			_args: string[],
			_options: Record<string, unknown>,
		): unknown => {
			throw new Error("spawnMock: no return value configured for this call");
		},
	),
);
const spawnSyncMock = vi.hoisted(() =>
	vi.fn(() => ({
		stdout: Buffer.from(""),
		stderr: Buffer.from(""),
		status: 0,
		error: undefined,
	})),
);
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock, spawnSync: spawnSyncMock };
});

const realPlatform = process.platform;
const realPath = process.env.PATH;
const realPathExt = process.env.PATHEXT;
const roots: string[] = [];
const targetChildren: Array<ReturnType<typeof makeFakeChild>> = [];
const targetSpawns: Array<{
	command: string;
	args: string[];
	options: Record<string, unknown>;
}> = [];
/** Resolves on the first target spawn; reset per test (no wall-clock wait). */
let resolveTargetSpawn: () => void = () => {};
let targetSpawned: Promise<void> = Promise.resolve();

function makeRoot(prefix = "pi-lens-3956-"): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

function write(root: string, relative: string, content = "\n"): string {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function gradleFixture(prefix?: string): { root: string; testFile: string } {
	const root = makeRoot(prefix);
	write(root, "gradlew.bat", "@echo off\r\n");
	write(root, "build.gradle.kts");
	const testFile = write(
		root,
		"src/test/java/ExampleTest.java",
		"class ExampleTest {}\n",
	);
	return { root, testFile };
}

/** Only the named Windows-shaped candidates exist; everything else is ENOENT. */
function markWindowsFilesPresent(files: readonly string[]): void {
	const present = new Set(files);
	statSyncMock.mockImplementation((candidate: unknown) => {
		if (present.has(String(candidate))) return { isFile: () => true };
		throw new Error("ENOENT");
	});
}

/** The wrapper candidate the resolver derives from an uncanonicalized cwd. */
function win32WrapperCandidate(root: string, basename: string): string {
	return path.win32.normalize(
		path.win32.resolve(path.win32.normalize(root), `./${basename}`),
	);
}

/**
 * Intercept only the external child boundary: the package-manager presence
 * probes this owner performs (`which`/`where <pm>`) settle as a clean "not
 * found", and every other spawn is the target this suite observes.
 */
function installSpawnBoundary(): void {
	spawnMock.mockImplementation(
		(command: string, args: string[], options: Record<string, unknown>) => {
			const child = makeFakeChild();
			if (command === "which" || command === "where") {
				queueMicrotask(() => {
					child.emit("exit", 1, null);
					child.emit("close", 1, null);
				});
				return child;
			}
			targetChildren.push(child);
			targetSpawns.push({ command, args, options });
			resolveTargetSpawn();
			return child;
		},
	);
}

async function runAndSettle(promise: Promise<unknown>): Promise<void> {
	// The run settling before any target spawn is itself the failure.
	await Promise.race([
		targetSpawned,
		promise.then(() => {
			throw new Error("run settled without a target spawn");
		}),
	]);
	const child = targetChildren[0];
	if (!child) throw new Error("expected a target child spawn");
	child.emit("exit", 0, null);
	child.emit("close", 0, null);
	await promise;
}

beforeEach(() => {
	statSyncMock.mockReset();
	spawnMock.mockReset();
	spawnSyncMock.mockReset();
	targetChildren.length = 0;
	targetSpawns.length = 0;
	targetSpawned = new Promise<void>((resolve) => {
		resolveTargetSpawn = resolve;
	});
	installSpawnBoundary();
});

afterEach(() => {
	Object.defineProperty(process, "platform", {
		value: realPlatform,
		configurable: true,
	});
	if (realPath === undefined) delete process.env.PATH;
	else process.env.PATH = realPath;
	if (realPathExt === undefined) delete process.env.PATHEXT;
	else process.env.PATHEXT = realPathExt;
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
	vi.resetModules();
});

describe("Windows Gradle wrapper resolution reaches the owner spawn (#3956)", () => {
	it("passes the cwd-relative batch wrapper to cmd.exe with the wrapper cwd and argv", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const { root, testFile } = gradleFixture();
		const expectedResolved = win32WrapperCandidate(root, "gradlew.bat");
		markWindowsFilesPresent([expectedResolved]);

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const promise = new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);
		await runAndSettle(promise);
		const result = await promise;

		expect(result.error).toBeUndefined();
		expect(result.failed).toBe(0);
		const call = targetSpawns[0];
		if (!call) throw new Error("expected one cmd.exe spawn");
		const { command: spawnCmd, args: spawnArgs, options: spawnOptions } = call;
		expect(spawnCmd).toMatch(/cmd\.exe$/i);
		expect(String(spawnArgs[3])).toContain(expectedResolved);
		expect(String(spawnArgs[3])).toContain("test --no-daemon");
		expect(spawnOptions.cwd).toBe(path.win32.normalize(root));
	});

	it("keeps a missing wrapper a failure, never a clean zero", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const root = makeRoot();
		write(root, "build.gradle.kts");
		const testFile = write(
			root,
			"src/test/java/ExampleTest.java",
			"class ExampleTest {}\n",
		);
		markWindowsFilesPresent([]);

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const result = await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);

		expect(spawnMock).not.toHaveBeenCalled();
		expect(result.passed).toBe(0);
		expect(result.failed).toBe(0);
		expect(result.error).toMatch(/spawn .*gradlew\.bat ENOENT/);
	});

	it("anchors a nested module on the wrapper root", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const { root } = gradleFixture();
		write(root, "mod/build.gradle.kts");
		const testFile = write(
			root,
			"mod/src/test/java/ModuleTest.java",
			"class ModuleTest {}\n",
		);
		const expectedResolved = win32WrapperCandidate(root, "gradlew.bat");
		markWindowsFilesPresent([expectedResolved]);

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const promise = new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);
		await runAndSettle(promise);
		await promise;

		const call = targetSpawns[0];
		if (!call) throw new Error("expected one cmd.exe spawn");
		expect(call.options.cwd).toBe(path.win32.normalize(root));
		expect(String(call.args[3])).toContain(expectedResolved);
	});

	it("survives spaces in the wrapper path", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const { root, testFile } = gradleFixture("pi-lens 3956 spaces-");
		const expectedResolved = win32WrapperCandidate(root, "gradlew.bat");
		markWindowsFilesPresent([expectedResolved]);

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const promise = new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);
		await runAndSettle(promise);
		await promise;

		const call = targetSpawns[0];
		if (!call) throw new Error("expected one cmd.exe spawn");
		expect(call.options.cwd).toBe(path.win32.normalize(root));
		expect(String(call.args[3])).toContain(expectedResolved);
	});

	it("keeps the POSIX launcher unchanged", async () => {
		// Forced, not inherited: on a native Windows host the load-time table
		// would otherwise evaluate the win32 spelling (AGENTS defect shape 30).
		Object.defineProperty(process, "platform", {
			value: "linux",
			configurable: true,
		});
		const { root, testFile } = gradleFixture();

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const promise = new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);
		await runAndSettle(promise);
		await promise;

		const call = targetSpawns[0];
		if (!call) throw new Error("expected one gradlew spawn");
		expect(call.command).toBe("./gradlew");
		expect(call.args).toEqual(["test", "--no-daemon"]);
		expect(call.options.cwd).toBe(root);
	});

	it("keeps Maven a PATH-only command that ignores a cwd-local binary", async () => {
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		const root = makeRoot();
		write(root, "pom.xml", "<project/>\n");
		// A cwd-local `mvn` must not be mistaken for the Gradle wrapper shape.
		write(root, "mvn", "@echo off\r\n");
		const testFile = write(
			root,
			"src/test/java/ExampleTest.java",
			"class ExampleTest {}\n",
		);
		process.env.PATH = "C:\\tools";
		process.env.PATHEXT = ".CMD";
		markWindowsFilesPresent(["C:\\tools\\mvn.cmd"]);

		const { RUNNERS, TestRunnerClient } =
			await import("../../clients/test-runner-client.js");
		const promise = new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"maven",
			RUNNERS.maven,
		);
		await runAndSettle(promise);
		await promise;

		const call = targetSpawns[0];
		if (!call) throw new Error("expected one cmd.exe spawn");
		expect(call.command).toMatch(/cmd\.exe$/i);
		expect(String(call.args[3])).toContain("C:\\tools\\mvn.cmd");
		expect(String(call.args[3])).not.toContain(path.win32.normalize(root));
	});
});
