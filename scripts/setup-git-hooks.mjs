#!/usr/bin/env node
// scripts/setup-git-hooks.mjs (#1804)
//
// Wires Husky-managed hooks (.husky/pre-commit, .husky/pre-push) into this
// clone's `core.hooksPath`, as a step inside the `prepare` npm lifecycle
// script. `prepare` also runs `build:dist` + grammar download — steps that
// consumers who install pi-lens as a dependency (`npm install --omit=dev`,
// no .git present, no devDependencies) depend on and that MUST fail loudly
// on error. Hook wiring must never share that failure path with them: it is
// dev-only and best-effort, so it lives in its own script, invoked last, and
// swallows its own errors instead of `|| true`-ing the whole `prepare` chain
// (which would also mask a real build failure).
//
// Skipped, not attempted, when:
//   - PI_LENS_SKIP_HOOKS is set   explicit install opt-out (`PI_LENS_SKIP_HOOKS=1
//                                  npm ci`; never on git commit/push/merge/
//                                  rebase, which guard-bash denies, #3778) —
//                                  any non-empty value, same rule the
//                                  hooks themselves use (.husky/pre-commit,
//                                  .husky/pre-push)
//   - CI is set (not "false")     GitHub Actions sets CI=true, but other CI
//                                  runners set other truthy spellings; treat
//                                  any non-empty value other than "false" as
//                                  CI. CI never commits, hooks buy nothing.
//   - no .git here                consumer install (dependency, tarball) —
//                                  there is no repo to attach hooks to
//   - no node_modules/husky       devDependencies weren't installed
//                                  (production/consumer install)
//   - HUSKY=0                     husky's own opt-out; husky would install
//                                  nothing, so the path must not be rewritten
//   - not pi-lens's own checkout  the package root (from THIS file's location,
//                                  never the cwd) must be a package named
//                                  pi-lens whose own `.git` is the repo Git
//                                  resolves there. An `npm link`, workspace or
//                                  a package dir nested in someone else's repo
//                                  has `.git` and husky too, and would have its
//                                  shared core.hooksPath rewritten otherwise.
//                                  Inherited GIT_DIR / GIT_WORK_TREE /
//                                  GIT_COMMON_DIR / GIT_INDEX_FILE are cleared
//                                  for every git and husky child so discovery
//                                  is never ambient.
//
// Linked worktrees (#3674): husky writes `core.hooksPath=.husky/_`, a
// RELATIVE path, and git resolves it against each worktree's root. `.husky/_`
// (the generated stubs) is gitignored, so it only exists where husky ran, and
// every other linked worktree ran no pre-commit or pre-push at all (two PRs
// reached CI with oxfmt and tsc failures). `core.hooksPath` lives in the
// shared config, so one value serves every worktree: husky is run in, and the
// path pinned absolute to, the MAIN worktree's `.husky/_` even when `prepare`
// runs inside a linked worktree (which may be deleted later; the main
// checkout is the one tree that outlives them). Hook scripts therefore come
// from the main checkout's `.husky/`, and run in the committing worktree's
// cwd. A moved repo leaves a dangling absolute path until the next `prepare`
// rewrites it.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

function isSet(value) {
	return typeof value === "string" && value.length > 0;
}

function isCi() {
	const value = process.env.CI;
	return isSet(value) && value.trim().toLowerCase() !== "false";
}

function gitEnv() {
	const env = { ...process.env };
	for (const name of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
	])
		delete env[name];
	return env;
}

function gitOutput(args) {
	return execFileSync("git", ["-C", packageRoot, ...args], {
		encoding: "utf8",
		env: gitEnv(),
	});
}

function isPiLensCheckout() {
	try {
		const manifest = JSON.parse(
			readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		);
		if (manifest.name !== "pi-lens") return false;
		const toplevel = gitOutput(["rev-parse", "--show-toplevel"]).trim();
		return realpathSync(toplevel) === realpathSync(packageRoot);
	} catch {
		return false;
	}
}

function skipReason() {
	if (isSet(process.env.PI_LENS_SKIP_HOOKS)) return "PI_LENS_SKIP_HOOKS is set";
	if (isCi()) return "CI is set";
	if (process.env.HUSKY === "0") return "HUSKY=0";
	if (!existsSync(path.join(packageRoot, ".git")))
		return "no .git (not a clone)";
	if (!existsSync(path.join(packageRoot, "node_modules/husky/bin.js")))
		return "husky not installed (production install)";
	if (!isPiLensCheckout()) return "not pi-lens's own git checkout";
	return null;
}

const reason = skipReason();
if (reason) {
	console.log(`[setup-git-hooks] skipped (${reason}).`);
	process.exit(0);
}

// First `worktree` entry of `git worktree list` is always the main worktree;
// a bare main repo has no working tree to hold `.husky/_`, so fall back to
// the checkout running `prepare`.
function mainWorktreeRoot() {
	const [first, second] = gitOutput([
		"worktree",
		"list",
		"--porcelain",
		"-z",
	]).split("\0");
	if (second === "bare") return packageRoot;
	return first.slice("worktree ".length);
}

try {
	const huskyBin = path.join(packageRoot, "node_modules/husky/bin.js");
	const root = mainWorktreeRoot();
	execFileSync(process.execPath, [huskyBin], {
		cwd: root,
		env: gitEnv(),
		stdio: "inherit",
	});
	const hooksDir = path.join(root, ".husky", "_");
	execFileSync("git", ["-C", root, "config", "core.hooksPath", hooksDir], {
		env: gitEnv(),
		stdio: "inherit",
	});
} catch (error) {
	// Best-effort: a broken git-hooks install must never fail `npm install`.
	console.warn(
		`[setup-git-hooks] husky install failed, continuing without local hooks: ${error instanceof Error ? error.message : error}`,
	);
}
