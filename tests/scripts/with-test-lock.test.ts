/**
 * Tests for scripts/with-test-lock.mjs's pure helpers (#1101, PR #1112 review
 * round 2):
 *
 *  - `resolveVitestEntry` — the primary, shell-free dispatch path: resolves
 *    vitest's own package.json `bin` field so it can be launched via
 *    `node <entry> <args>` directly, with `shell: false`, on every OS. This
 *    is the path every real caller (npm test / test:unit / test:integration,
 *    all of which wrap `vitest run [...]`) actually takes.
 *
 *  - `quoteForWindowsCmd` — the FALLBACK-ONLY path used when the wrapped
 *    command isn't `vitest` (no such caller exists today). Pinned here as
 *    documentation of its real, known limits per the PR #1112 review: it
 *    defends against Windows's "shell:true + args array doesn't quote"
 *    space/quote-splitting bug, but it is NOT a shell-injection-safe
 *    escaper — a quote-containing argument can flip cmd.exe's quote parity,
 *    and `%VAR%` expansion is untouched by quoting. These tests assert the
 *    exact (imperfect) output rather than spawning a real cmd.exe, so they
 *    stay OS-agnostic and fast; the comments describe what a real cmd.exe
 *    would do with that output.
 */

import { describe, expect, it } from "vitest";
import {
	isEntryPoint,
	quoteForWindowsCmd,
	resolveVitestEntry,
	sharedModeRequiresPaths,
} from "../../scripts/with-test-lock.mjs";

describe("resolveVitestEntry", () => {
	it("resolves vitest's bin entry to a real file on disk", async () => {
		const entry = resolveVitestEntry();
		expect(typeof entry).toBe("string");
		expect(entry).not.toBeNull();

		const fs = await import("node:fs");
		expect(fs.existsSync(entry as string)).toBe(true);
	});
});

describe("quoteForWindowsCmd — safe cases (what it's FOR)", () => {
	it("leaves a plain argument with no special characters untouched", () => {
		expect(quoteForWindowsCmd("run")).toBe("run");
		expect(quoteForWindowsCmd("tests/foo.test.ts")).toBe("tests/foo.test.ts");
	});

	it("quotes the empty string", () => {
		expect(quoteForWindowsCmd("")).toBe('""');
	});

	it("wraps an argument containing a space in quotes (the bug this exists to fix)", () => {
		// Without this, `shell:true` + an args array on Windows silently splits
		// this into TWO argv entries on the far side (confirmed experimentally
		// — see with-test-lock.mjs's header comment).
		expect(quoteForWindowsCmd("console.log('A start', Date.now())")).toBe(
			"\"console.log('A start', Date.now())\"",
		);
	});

	it("doubles a trailing backslash immediately before the closing quote", () => {
		// CRT quoting rule: backslashes immediately preceding the closing quote
		// must be doubled so the parser doesn't read them as escaping the
		// closing quote itself.
		expect(quoteForWindowsCmd("C:\\some dir\\")).toBe('"C:\\some dir\\\\"');
	});

	it("escapes an embedded double quote", () => {
		expect(quoteForWindowsCmd('say "hi"')).toBe('"say \\"hi\\""');
	});
});

describe("quoteForWindowsCmd — KNOWN LIMITS (documented, not fixed here)", () => {
	it("does NOT neutralize %VAR% expansion — cmd.exe still expands it despite quoting", () => {
		const quoted = quoteForWindowsCmd("%TEMP%\\evil");
		// The raw, unescaped %TEMP% survives verbatim inside the quotes — a
		// real cmd.exe /c line built from this would still expand %TEMP% to
		// its value before the quoted argument is even parsed as one token.
		expect(quoted).toContain("%TEMP%");
		expect(quoted).toBe('"%TEMP%\\evil"');
	});

	it("does not prevent an embedded quote from flipping cmd's quote parity", () => {
		// A caller-controlled argument like `foo" & calc.exe & "bar` becomes,
		// after this function's CRT-style escaping, a token whose escaped
		// quotes cmd.exe's own /c parser does NOT treat as CRT does — when
		// concatenated onto a real cmd.exe command line (as with-test-lock.mjs
		// does via `spawn(fullCommandLine, { shell: true })`), the escaped
		// quote can still end the quoted region early from cmd's point of
		// view, and a subsequent `&` is then interpreted as a command
		// separator, not literal text. This function only fixes CRT-style
		// argv-boundary splitting (the space bug); it is not a defense against
		// this. Documented per PR #1112 review; not exploitable via any real
		// caller today, since commandArgs always comes from this process's own
		// argv (package.json script definitions), never external input.
		const quoted = quoteForWindowsCmd('foo" & calc.exe & "bar');
		expect(quoted).toBe('"foo\\" & calc.exe & \\"bar"');
		// The escaped quotes are present in the output — proving this function
		// does not strip/reject/reject-on-detect them — which is exactly the
		// shape the review flagged as unsafe for untrusted input.
		expect(quoted).toContain('\\"');
		expect(quoted).toContain("&");
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 1 (S11)
// ---------------------------------------------------------------------------

describe("sharedModeRequiresPaths (review S11)", () => {
	// `npm run test:targeted` with no file arguments expands to
	// `with-test-lock.mjs --shared -- vitest run`, i.e. the FULL suite under a
	// shared slot — several of which can run at once. That is precisely the
	// contention #1101's exclusive lock exists to prevent, arrived at by the
	// mechanism meant to relieve it.
	it("flags a shared run with no arguments at all", () => {
		expect(sharedModeRequiresPaths(["vitest", "run"])).toBe(true);
	});

	it("flags a shared run whose only arguments are flags", () => {
		expect(
			sharedModeRequiresPaths(["vitest", "run", "--project=default"]),
		).toBe(true);
	});

	it("flags a name filter, which still collects the whole suite", () => {
		expect(sharedModeRequiresPaths(["vitest", "run", "-t", "some name"])).toBe(
			true,
		);
	});

	it("accepts a shared run naming a test file", () => {
		expect(
			sharedModeRequiresPaths(["vitest", "run", "tests/scripts/x.test.ts"]),
		).toBe(false);
	});

	it("accepts a shared run naming a glob", () => {
		expect(
			sharedModeRequiresPaths(["vitest", "run", "tests/config/*.test.ts"]),
		).toBe(false);
	});

	it("accepts a bare file name with a test extension", () => {
		expect(sharedModeRequiresPaths(["vitest", "run", "x.test.ts"])).toBe(false);
	});

	it("accepts a Windows-spelled path", () => {
		expect(
			sharedModeRequiresPaths(["vitest", "run", "tests\\scripts\\x.test.ts"]),
		).toBe(false);
	});
});

describe("isEntryPoint (#4086)", () => {
	const self = "/repo/scripts/with-test-lock.mjs";
	const selfUrl = `file://${self}`;
	// A resolver over a fake filesystem: `/link/scripts` is a symlink to
	// `/repo/scripts`; anything unlisted does not exist.
	const resolveIn =
		(entries: Record<string, string>) =>
		(p: string): string => {
			const hit = entries[p];
			if (hit === undefined) throw new Error(`ENOENT: ${p}`);
			return hit;
		};

	it("is the entry point when argv[1] reaches this file through a symlink", () => {
		// #4086 recurrence: the lexical compare returned false for a symlinked
		// scripts/ directory, so the CLI exited 0 having run nothing.
		const realpath = resolveIn({
			"/link/scripts/with-test-lock.mjs": self,
			[self]: self,
		});
		expect(
			isEntryPoint(selfUrl, {
				argv1: "/link/scripts/with-test-lock.mjs",
				realpath,
			}),
		).toBe(true);
	});

	it("is the entry point under --preserve-symlinks-main, where the module URL is the symlinked spelling", () => {
		// #4086 review F5 recurrence: dropping the realpath of the module's own
		// URL made this false whenever the main URL kept its symlinked spelling.
		const linked = "/link/scripts/with-test-lock.mjs";
		const realpath = resolveIn({ [linked]: self });
		expect(isEntryPoint(`file://${linked}`, { argv1: linked, realpath })).toBe(
			true,
		);
	});

	it("is not the entry point when another file is the entry point", () => {
		// #4086 review F4 recurrence: a guard that is always true runs main() on
		// every import of this file (the selector imports it).
		const realpath = resolveIn({
			"/repo/other.mjs": "/repo/other.mjs",
			[self]: self,
		});
		expect(isEntryPoint(selfUrl, { argv1: "/repo/other.mjs", realpath })).toBe(
			false,
		);
	});

	it.each([
		["empty", ""],
		["stdin marker", "-"],
		["not a real path (node -e foo)", "pi-lens-no-such-entry-point"],
	])(
		"returns false, never throws, when argv[1] is %s (default resolver)",
		(_name, argv1) => {
			// #4086 review F2 recurrence: throwing on an unresolvable argv[1] made
			// merely importing the script throw under `node -e` and stdin. Uses the
			// real fs.realpathSync.native (the undefined argv[1] of a bare `node -e`
			// is covered through a real child in pre-push-targeted-tests.test.ts).
			expect(isEntryPoint(selfUrl, { argv1 })).toBe(false);
		},
	);

	it("fails closed when its own path cannot be resolved", () => {
		// #4086 review F3 recurrence: returning false here would silently skip
		// the CLI, the exit-0-having-run-nothing failure this guard exists for.
		const realpath = resolveIn({
			"/repo/scripts/x.mjs": "/repo/scripts/x.mjs",
		});
		expect(() =>
			isEntryPoint(selfUrl, { argv1: "/repo/scripts/x.mjs", realpath }),
		).toThrow(
			/cannot resolve the entry-point path of file:\/\/\/repo\/scripts\/with-test-lock\.mjs: ENOENT/,
		);
	});
});
