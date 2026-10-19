/**
 * #3674: `scripts/setup-git-hooks.mjs` must leave hooks that run from EVERY
 * worktree of the clone, not only the checkout `prepare` ran in.
 *
 * Recurrence this pins: husky writes the RELATIVE `core.hooksPath=.husky/_`,
 * git resolves it against each worktree's root, and `.husky/_` is gitignored
 * so it exists in one tree only. Every linked worktree then ran no
 * pre-commit or pre-push, and two PRs reached CI with oxfmt and tsc failures
 * the hooks would have refused. The subject is a real git worktree layout
 * and the real script; an in-process double cannot resolve a hooksPath.
 *
 * Round 2 recurrence: the script located its repo from the cwd, so any
 * checkout with a `.git` and `node_modules/husky` (an `npm link`, a workspace,
 * a package dir nested in someone else's repo, an inherited GIT_DIR) had ITS
 * shared core.hooksPath rewritten and a `.husky/_` generated. The script is
 * therefore copied INTO each fixture, as it sits in a real checkout, because
 * it now derives the package root from its own location.
 */
// flake-shape: real-process-spawn — the subject is git's own resolution of
// core.hooksPath per worktree plus the real script and husky binary; a stub
// would only restate the path the test itself wrote.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const scriptSource = path.join(repoRoot, "scripts", "setup-git-hooks.mjs");
const SCRIPT_REL = path.join("scripts", "setup-git-hooks.mjs");
const huskyDir = fs.realpathSync(path.join(repoRoot, "node_modules", "husky"));

let fixtureDir: string | undefined;

afterEach(() => {
	if (fixtureDir) {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	}
});

function fixtureEnv(dir: string, overrides: Record<string, string> = {}) {
	const env: Record<string, string> = {
		...gitFixtureEnv(dir),
		HOME: dir,
		...overrides,
	};
	// The script skips under CI / opt-outs; the suite may run under any.
	for (const name of ["CI", "PI_LENS_SKIP_HOOKS", "HUSKY", "XDG_CONFIG_HOME"])
		if (!(name in overrides)) delete env[name];
	return env;
}

const PACKAGE_JSON = (name: string) => `${JSON.stringify({ name })}\n`;

/** Lay the script, a manifest and a husky (real symlink or recording stub) into a tree. */
function installScript(tree: string, name: string) {
	fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
	fs.copyFileSync(scriptSource, path.join(tree, SCRIPT_REL));
	fs.writeFileSync(path.join(tree, "package.json"), PACKAGE_JSON(name));
}

function installHusky(tree: string, stubMarker?: string) {
	const target = path.join(tree, "node_modules", "husky");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	if (stubMarker === undefined) {
		fs.symlinkSync(huskyDir, target, "dir");
		return;
	}
	// A husky that ignores HUSKY=0 and always "succeeds": only the script's own
	// guard can keep it from running.
	fs.mkdirSync(target);
	fs.writeFileSync(
		path.join(target, "bin.js"),
		`require("node:fs").writeFileSync(${JSON.stringify(stubMarker)}, "ran");\n`,
	);
}

function newFixtureDir() {
	fixtureDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-setup-hooks-")),
	);
	return fixtureDir;
}

function gitIn(dir: string) {
	const env = fixtureEnv(dir);
	return (cwd: string, ...args: string[]) =>
		gitExecFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

function initRepo(dir: string, repo: string) {
	const git = gitIn(dir);
	fs.mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "master");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "pi-lens test");
	return git;
}

function runScript(
	dir: string,
	cwd: string,
	overrides: Record<string, string> = {},
) {
	return spawnSync(process.execPath, [path.join(cwd, SCRIPT_REL)], {
		cwd,
		env: fixtureEnv(dir, overrides),
		encoding: "utf8",
	});
}

/** What a foreign repo must keep byte-identical: its config and any generated stubs. */
function snapshotRepo(repo: string) {
	return {
		config: fs.readFileSync(path.join(repo, ".git", "config"), "utf8"),
		husky: fs.existsSync(path.join(repo, ".husky")),
	};
}

/** A real repo (or bare repo) with a tracked sentinel hook, and a linked worktree. */
function makeClone(options: { bareMain?: boolean; stubHusky?: boolean } = {}) {
	const dir = newFixtureDir();
	const env = fixtureEnv(dir);
	const main = path.join(dir, "main");
	const linked = path.join(dir, "linked");
	const huskyMarker = path.join(dir, "husky-stub-ran");
	const git = initRepo(dir, main);
	fs.mkdirSync(path.join(main, ".husky"));
	// Relative to the committing worktree's cwd: proves WHERE the hook ran.
	fs.writeFileSync(
		path.join(main, ".husky", "pre-commit"),
		"pwd -P > .hook-ran\n",
	);
	installScript(main, "pi-lens");
	git(main, "add", ".husky/pre-commit", SCRIPT_REL, "package.json");
	git(main, "commit", "-qm", "init");
	let origin = main;
	if (options.bareMain) {
		origin = path.join(dir, "bare.git");
		git(dir, "clone", "-q", "--bare", main, origin);
		git(origin, "worktree", "add", "-q", linked, "master");
	} else {
		git(main, "worktree", "add", "-q", "-b", "linked-branch", linked);
	}
	for (const tree of options.bareMain ? [linked] : [main, linked])
		installHusky(tree, options.stubHusky ? huskyMarker : undefined);
	const prepare = (cwd: string, overrides: Record<string, string> = {}) =>
		runScript(dir, cwd, overrides);
	const hookRan = (cwd: string) => {
		fs.rmSync(path.join(cwd, ".hook-ran"), { force: true });
		let status = 0;
		try {
			gitExecFileSync("git", ["hook", "run", "pre-commit"], {
				cwd,
				env,
				stdio: "pipe",
			});
		} catch (error) {
			status = (error as { status: number }).status;
		}
		const sentinel = path.join(cwd, ".hook-ran");
		return {
			status,
			cwd: fs.existsSync(sentinel)
				? fs.readFileSync(sentinel, "utf8").trim()
				: undefined,
		};
	};
	return { dir, main, linked, origin, git, prepare, hookRan, huskyMarker };
}

// POSIX shell stubs and symlinks; the authoritative Unit tests lane is ubuntu.
describe.skipIf(process.platform === "win32")(
	"setup-git-hooks: hooks run from every worktree (#3674)",
	() => {
		it("prepare in the main checkout: the linked worktree runs the hook in its own cwd", () => {
			const { main, linked, git, prepare, hookRan } = makeClone();
			const result = prepare(main);
			expect(result.status).toBe(0);
			expect(hookRan(main)).toMatchObject({ status: 0, cwd: main });
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
			expect(git(linked, "config", "core.hooksPath")).toBe(
				path.join(main, ".husky", "_"),
			);
		});

		it("prepare inside the linked worktree: hooks are generated in and pinned to the main checkout", () => {
			const { main, linked, git, prepare, hookRan } = makeClone();
			const result = prepare(linked);
			expect(result.status).toBe(0);
			expect(git(main, "config", "core.hooksPath")).toBe(
				path.join(main, ".husky", "_"),
			);
			// A linked worktree can be deleted; the pinned stubs must not live in it.
			expect(fs.existsSync(path.join(linked, ".husky", "_"))).toBe(false);
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
			expect(hookRan(main)).toMatchObject({ status: 0, cwd: main });
		});

		it("prepare inside a linked worktree of a bare main repo falls back to that worktree", () => {
			const { linked, origin, git, prepare, hookRan } = makeClone({
				bareMain: true,
			});
			const result = prepare(linked);
			expect(result.status).toBe(0);
			expect(git(origin, "config", "core.hooksPath")).toBe(
				path.join(linked, ".husky", "_"),
			);
			expect(hookRan(linked)).toMatchObject({ status: 0, cwd: linked });
		});

		it("HUSKY=0 with the real husky installs nothing and leaves core.hooksPath unset", () => {
			const { main, git, prepare } = makeClone();
			const result = prepare(main, { HUSKY: "0" });
			expect(result.status).toBe(0);
			expect(() => git(main, "config", "core.hooksPath")).toThrow();
			expect(fs.existsSync(path.join(main, ".husky", "_"))).toBe(false);
		});

		// The real husky exits on HUSKY=0 before the script's own `git config`, so
		// only a husky that ignores HUSKY=0 can prove the script's guard.
		it("HUSKY=0 never invokes husky and never writes core.hooksPath", () => {
			const { main, git, prepare, huskyMarker } = makeClone({
				stubHusky: true,
			});
			const result = prepare(main, { HUSKY: "0" });
			expect(result.status).toBe(0);
			expect(fs.existsSync(huskyMarker)).toBe(false);
			expect(() => git(main, "config", "core.hooksPath")).toThrow();
			expect(result.stdout).toContain("skipped (HUSKY=0)");
		});

		it("without HUSKY=0 the stub husky IS invoked (the arm above can go red)", () => {
			const { main, prepare, huskyMarker } = makeClone({ stubHusky: true });
			prepare(main);
			expect(fs.existsSync(huskyMarker)).toBe(true);
		});
	},
);

// Ownership (#3674 round 2): a foreign checkout that has `.git` and
// `node_modules/husky` must be left alone.
describe.skipIf(process.platform === "win32")(
	"setup-git-hooks: only pi-lens's own checkout is wired (#3674 round 2)",
	() => {
		it("a foreign repo (package not named pi-lens) keeps its config and gets no .husky", () => {
			const dir = newFixtureDir();
			const foreign = path.join(dir, "user-repo");
			initRepo(dir, foreign);
			installScript(foreign, "user-app");
			installHusky(foreign);
			const before = snapshotRepo(foreign);
			const result = runScript(dir, foreign);
			expect(result.status).toBe(0);
			expect(snapshotRepo(foreign)).toEqual(before);
			expect(result.stdout).toContain("not pi-lens's own git checkout");
		});

		it("a pi-lens-named package nested in someone else's repo (no git repo of its own) leaves that repo alone", () => {
			const dir = newFixtureDir();
			const outer = path.join(dir, "outer");
			initRepo(dir, outer);
			const nested = path.join(outer, "node_modules", "pi-lens");
			installScript(nested, "pi-lens");
			installHusky(nested);
			// Git Metadata without a usable repository: discovery walks up to `outer`.
			fs.mkdirSync(path.join(nested, ".git"));
			const before = snapshotRepo(outer);
			const result = runScript(dir, nested);
			expect(result.status).toBe(0);
			expect(snapshotRepo(outer)).toEqual(before);
			expect(fs.existsSync(path.join(nested, ".husky"))).toBe(false);
			expect(result.stdout).toContain("not pi-lens's own git checkout");
		});

		it("inherited GIT_DIR / GIT_WORK_TREE cannot redirect the wiring to another repo", () => {
			const { dir, main, git, prepare } = makeClone();
			const foreign = path.join(dir, "user-repo");
			initRepo(dir, foreign);
			const before = snapshotRepo(foreign);
			const result = prepare(main, {
				GIT_DIR: path.join(foreign, ".git"),
				GIT_WORK_TREE: foreign,
			});
			expect(result.status).toBe(0);
			expect(git(main, "config", "core.hooksPath")).toBe(
				path.join(main, ".husky", "_"),
			);
			expect(snapshotRepo(foreign)).toEqual(before);
		});
	},
);
