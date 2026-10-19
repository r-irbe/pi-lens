import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** NUL-delimited `git ls-files -z` of the whole index. */
function trackedFiles(): string {
	return gitExecFileSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
	});
}

/**
 * A git-tracked file that also matches a `.gitignore` pattern is invisible
 * to any ignore-respecting tool that doesn't special-case tracked status —
 * `rg`, plain `grep --exclude-from`, GitHub code search. Git itself keeps
 * tracking the file (`git status`/`git check-ignore` on an already-indexed
 * path both special-case it), so nothing in git itself flags the shadow
 * (#2250).
 *
 * `git check-ignore --no-index` is git's own textual pattern evaluator —
 * the same primitive `rg`'s gitignore support and GitHub code search apply
 * — so piping every tracked path through it is the ground truth for "would
 * a real ignore-respecting tool skip this file", with zero reimplemented
 * gitignore dialect (a hand-rolled matcher previously here missed
 * negations entirely and produced false positives on `.changelog/*.md`
 * fragments git does NOT actually ignore). `-z`/`--stdin -z` NUL-delimit
 * both ends so no filename with a space or unusual character is misread.
 */
function findShadowedTrackedFiles(): string[] {
	const tracked = trackedFiles();
	const trackedCount = tracked.split("\0").filter(Boolean).length;
	// Floor set well under the repo's real tracked-file count (~2,950) so it
	// still catches a silent zero — e.g. the `input` forwarding this test
	// relies on (git-fixture-env.ts's GitExecOptions) getting dropped in a
	// future edit, which would make `shadowed` trivially equal `[]` for the
	// wrong reason and pass forever (#2250 review V3).
	assertNonEmptyScan("git ls-files (tracked files scanned)", trackedCount, 500);

	let shadowed: string;
	try {
		shadowed = gitExecFileSync(
			"git",
			["check-ignore", "--no-index", "--stdin", "-z"],
			{ cwd: root, encoding: "utf8", input: tracked },
		);
	} catch (err) {
		// git check-ignore exits 1 when NONE of the stdin paths are ignored —
		// that's the passing case, not a failure. Any other exit still throws.
		const e = err as { status?: number; stdout?: string | Buffer };
		if (e.status !== 1) throw err;
		shadowed =
			typeof e.stdout === "string"
				? e.stdout
				: (e.stdout?.toString("utf8") ?? "");
	}

	return shadowed.split("\0").filter(Boolean);
}

describe("gitignore does not shadow tracked files (#2250)", () => {
	it("no git-tracked file is reported ignored by git check-ignore --no-index", () => {
		const shadowed = findShadowedTrackedFiles();
		expect(shadowed).toEqual([]);
	});

	it("tracks a grammar-health fixture for every LANGUAGE_TO_GRAMMAR key (#4012)", () => {
		// Recurrence: PR #4093 r1 committed 26 of 27 fixtures. The root `*.js`
		// ignore rule hid javascript.js, so a working tree that held the file
		// passed every local check while CI (which checks out only tracked
		// files) reported it missing. The index, not the directory, is the
		// population.
		const corpus = "tests/fixtures/grammar-health";
		const tracked = new Set(
			trackedFiles()
				.split("\0")
				.filter((file) => file.startsWith(`${corpus}/`))
				.map((file) => {
					const name = file.slice(corpus.length + 1);
					return name.slice(0, name.indexOf("."));
				}),
		);
		assertNonEmptyScan("tracked grammar corpus fixtures", tracked.size, 20);
		expect(
			Object.keys(LANGUAGE_TO_GRAMMAR)
				.filter((language) => !tracked.has(language))
				.sort(),
		).toEqual([]);
	});
});
// flake-shape: real-process-spawn — real gitignore rules and index entries decide shadow files outside the test process
