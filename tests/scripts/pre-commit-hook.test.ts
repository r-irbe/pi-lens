/**
 * #3451: the pre-commit hook's format step over the staged set, run through
 * the real `.husky/pre-commit` in a throwaway git repo. The hook's text
 * contract (pinned binary, staged-only) stays in
 * pre-push-targeted-tests.test.ts beside the other `.husky` pins.
 */
// flake-shape: real-process-spawn — the subject is the real hook script piped
// through real git and the pinned oxfmt binary; exit 123 from xargs is a
// process-boundary fact an in-process double cannot reproduce.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

const repoRoot = path.resolve(__dirname, "..", "..");

let fixtureDir: string | undefined;

function write(relPath: string, content: string) {
	const full = path.join(fixtureDir as string, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

function enterFixture() {
	fixtureDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-pre-commit-test-"),
	);
}

afterEach(() => {
	if (fixtureDir) {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	}
});

// POSIX shell hook and shell shims; the authoritative Unit tests lane is ubuntu.
describe.skipIf(process.platform === "win32")(
	"pre-commit hook: format step on the staged set (#3451)",
	() => {
		const oxfmtBin = path.join(repoRoot, "node_modules", ".bin", "oxfmt");
		const UNFORMATTED = "const  a=1\n";

		it.each([
			"HANDBACK_4034.md",
			"REVIEW_notes.md",
			"VERIFY_result.md",
			"INVESTIGATION_case.md",
			"REVIEW.md",
			"INVESTIGATION.md",
			"MONITOR.md",
			"PR_BODY.md",
			"COMMIT_MSG.txt",
		])("refuses a staged root handoff file with a named rule: %s", (file) => {
			enterFixture();
			const dir = fixtureDir as string;
			const env = gitFixtureEnv(dir);
			fs.copyFileSync(
				path.join(repoRoot, ".husky/pre-commit"),
				path.join(dir, "pre-commit"),
			);
			fs.chmodSync(path.join(dir, "pre-commit"), 0o755);
			const git = (...args: string[]) =>
				gitExecFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
			git("init", "-q");
			write(file, "handoff\n");
			git("add", "-f", "--", file);
			const result = spawnSync("sh", [path.join(dir, "pre-commit")], {
				cwd: dir,
				env: { ...env, PI_LENS_SKIP_HOOKS: "" },
				encoding: "utf8",
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`refusing rule handoff-file: ${file}`);
		});

		function commitHook(stage: Record<string, string>) {
			enterFixture();
			const dir = fixtureDir as string;
			const stubs = path.join(dir, ".stubs");
			fs.mkdirSync(stubs);
			fs.writeFileSync(path.join(stubs, "npm"), "#!/bin/sh\nexit 0\n", {
				mode: 0o755,
			});
			fs.writeFileSync(
				path.join(stubs, "npx"),
				'#!/bin/sh\n[ "$1" = --no-install ] && shift\n[ "$1" = oxfmt ] && shift\nexec "$OXFMT_BIN" "$@"\n',
				{ mode: 0o755 },
			);
			fs.copyFileSync(
				path.join(repoRoot, ".oxfmtrc.json"),
				path.join(dir, ".oxfmtrc.json"),
			);
			const env = {
				...gitFixtureEnv(dir),
				PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ""}`,
				OXFMT_BIN: oxfmtBin,
				PI_LENS_SKIP_HOOKS: "",
			};
			const git = (...args: string[]) =>
				gitExecFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
			git("init", "-q");
			for (const [rel, content] of Object.entries(stage)) {
				write(rel, content);
				git("add", "--", rel);
			}
			return spawnSync("sh", [path.join(repoRoot, ".husky/pre-commit")], {
				cwd: dir,
				env,
				encoding: "utf8",
			});
		}

		it("passes a staged set of only formatter-ignored files (release roll)", () => {
			const result = commitHook({
				"CHANGELOG.md": "# Changelog\n",
				"package.json": "{}\n",
			});
			expect(result.status, result.stderr + result.stdout).toBe(0);
			expect(result.stdout + result.stderr).toContain(
				"No files found matching the given patterns",
			);
		});

		it("passes a staged set of only ignored format-smoke fixtures", () => {
			const result = commitHook({
				"tests/fixtures/format-smoke/bad.ts": UNFORMATTED,
			});
			expect(result.status, result.stderr + result.stdout).toBe(0);
		});

		it("still refuses an unformatted staged .ts file", () => {
			const result = commitHook({
				"CHANGELOG.md": "# Changelog\n",
				"src/bad.ts": UNFORMATTED,
			});
			expect(result.status).not.toBe(0);
			expect(result.stdout + result.stderr).toContain("src/bad.ts");
		});
	},
);
