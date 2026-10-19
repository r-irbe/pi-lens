/**
 * Mechanical scan for the "skip that reports as a pass" shape (#2089,
 * AGENTS.md test-authoring screen 2).
 *
 * A test whose body bare-`return`s before it reaches any assertion is reported
 * by Vitest as PASSED, not skipped. The suite then claims coverage it never
 * had, and the claim is loudest exactly where it is least true: a
 * `if (process.platform !== "win32") return;` gate reports green on every one
 * of CI's ubuntu-latest runs while asserting nothing at all. The correct
 * spelling is `it.skipIf(cond)(...)` (declarative, visible in the run summary)
 * or `ctx.skip(reason)` before the return (visible, with a reason attached).
 *
 * The detector is deliberately SYNTACTIC and deliberately conservative — it
 * flags only a bare `return;` that sits at the test callback's own statement
 * level and precedes every assertion in that body. Three consequences worth
 * knowing before you extend it:
 *
 * - **Strings are blanked first.** `tests/clients/tree-sitter-c-rules.test.ts`
 *   feeds the C parser a fixture whose body is `return;`. That is a string, not
 *   a test's control flow, and a scan that reads it as code flags a healthy
 *   test forever.
 * - **Nested function bodies are excluded.** A `return` inside a `forEach`
 *   callback, a `waitFor` predicate or an event handler is ordinary control
 *   flow. Only the callback's OWN statement level can end the test early.
 *   Block braces (`if`, `try`, `catch`, loops) are NOT function bodies — the
 *   compliant `catch { ctx.skip(); return; }` sites live there, and so do the
 *   offenders.
 * - **An assertion anywhere earlier clears the return.** A test that asserts
 *   and then returns has already done its job; the shape this guards is the
 *   body that returns having asserted nothing.
 *
 * Known limits, named rather than papered over:
 *
 * - A test declared through an ALIAS (`const d = it.skipIf(...)`, as in
 *   `tests/clients/installer/posix-group-kill.test.ts`) is invisible to the
 *   walk, which keys on a literal `it`/`test` callee. That alias form is
 *   already the declarative spelling this guard pushes people toward, so the
 *   blind spot points the safe way.
 * - An assertion reachable only inside a nested callback counts as an
 *   assertion. Deciding otherwise needs reachability, not a syntax walk.
 * - A callback passed by REFERENCE (`it("name", handler)`) has no body at the
 *   call site, so there is nothing to walk.
 * - Once a `skip` call is seen, every later return in that body is cleared,
 *   including one on a path the skip does not cover.
 * - `return undefined;` (and any other valued return) is not a bare return:
 *   {@link isBareReturnAt} requires `;` or `}` immediately after the keyword.
 *   It is the same defect wearing a value, and the walk does not see it.
 * - The assertion needle is `assert[\w$]*` followed by `.` or `(`, so an
 *   ordinary identifier that happens to start with `assert` — `assertions.`,
 *   `assertCount(` — clears the body without asserting anything.
 * - `hasSkipCall` (sweep-kit) accepts any receiver outside the it/test/describe/suite
 *   blocklist, so an unrelated `queue.skip(3)` reads as a skip call.
 * - An ASI bare `return` with no semicolon is likewise invisible; oxfmt writes
 *   the semicolon, so it cannot survive a formatted commit here.
 *
 * Every one of these is a false NEGATIVE, the direction a guard should fail in:
 * the sweep can miss a defect, but it cannot manufacture one.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	callbackBodyBrace,
	hasSkipCall,
	isFunctionBrace,
	lineOf,
	listSourceFiles,
	matchingCloseIndex,
	nextNonSpace,
	readWalkedFiles,
	relativePosix,
	stripSource,
	testDeclarations,
} from "./sweep-kit.js";
import { vitestCollects } from "./vitest-collection.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** One test body that ends early without asserting and without skipping. */
export interface VacuousSkip {
	/** Repo-relative posix path of the test file. */
	file: string;
	/** 1-based line of the offending `return`. */
	line: number;
	/** The test's name, as written in its first argument. */
	testName: string;
}

/** Stable identity for exempting one reviewed site. */
export function vacuousSkipKey(entry: {
	file: string;
	testName: string;
}): string {
	return `${entry.file}:${entry.testName}`;
}

/**
 * An assertion — anything the repo uses to make a claim. `assert[\w$]*` on
 * purpose: `assertNonEmptyScan(`, `assertGrammarAvailable(` and friends are
 * assertions under a longer name, and a test that calls one has not returned
 * vacuously.
 */
const ASSERTION = /(?<![\w$.])(?:expect|expectTypeOf|assert[\w$]*)\s*[.(]/;

/** Every vacuous early return in one file's source text. */
export function scanVacuousSkipsInSource(
	file: string,
	raw: string,
): VacuousSkip[] {
	const stripped = stripSource(raw, { strings: "blank" });
	const found: VacuousSkip[] = [];
	// Every `it`/`test` call, live or not: a skipped test's early return is
	// the same shape, and the walk is the shared one (#4393).
	for (const declaration of testDeclarations(raw, stripped)) {
		if (declaration.callee !== "it" && declaration.callee !== "test") continue;
		const { callParen, callEnd } = declaration;
		const bodyOpen = callbackBodyBrace(stripped, callParen, callEnd);
		if (bodyOpen < 0) continue;
		const bodyClose = matchingCloseIndex(stripped, bodyOpen, "{", "}");
		if (bodyClose < 0) continue;
		const hit = firstVacuousReturn(stripped, bodyOpen, bodyClose);
		if (hit < 0) continue;
		found.push({
			file,
			line: lineOf(stripped, hit),
			testName: declaration.title,
		});
	}
	return found;
}

/**
 * Index of the first bare `return` at the callback's own statement level that
 * has neither asserted nor skipped, or -1. Function braces raise the depth;
 * block braces do not, because a compliant `catch { ctx.skip(); return; }` and
 * a bare `if (!win32) return;` both live inside blocks.
 */
function firstVacuousReturn(
	stripped: string,
	bodyOpen: number,
	bodyClose: number,
): number {
	let functionDepth = 0;
	const braceIsFunction: boolean[] = [];
	for (let i = bodyOpen + 1; i < bodyClose; i++) {
		const ch = stripped[i];
		if (ch === "{") {
			const isFunction = isFunctionBrace(stripped, i);
			braceIsFunction.push(isFunction);
			if (isFunction) functionDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceIsFunction.pop() === true) functionDepth--;
			continue;
		}
		if (functionDepth > 0 || !isBareReturnAt(stripped, i)) continue;
		const before = stripped.slice(bodyOpen + 1, i);
		return ASSERTION.test(before) || hasSkipCall(before) ? -1 : i;
	}
	return -1;
}

/** A `return` statement with no value, starting at `i`. */
function isBareReturnAt(stripped: string, i: number): boolean {
	if (stripped[i] !== "r" || stripped.slice(i, i + 6) !== "return")
		return false;
	if (i > 0 && /[\w$.]/.test(stripped[i - 1])) return false;
	const after = nextNonSpace(stripped, i + 6);
	return stripped[after] === ";" || stripped[after] === "}";
}

/**
 * Every file under `tests/` that vitest's own config collects
 * ({@link vitestCollects}). The walk prunes `fixtures/` only for speed:
 * vitest treats that tree as INPUT to tests, and the config, not this prune,
 * decides membership.
 */
export function listTestFiles(): string[] {
	return listSourceFiles(path.join(repoRoot, "tests"), {
		extensions: [".ts"],
		exclude: (relative) => relative.startsWith("fixtures/"),
	}).filter((file) => vitestCollects(relativePosix(repoRoot, file)));
}

/** Scan the whole `tests/` tree for tests that pass by returning early.
 *
 *  Reads through `readWalkedFile`: a path that vanished between the walk and
 *  the read is out of the population, not a finding (#3082 — this scan was
 *  one of the four rotating ENOENT victims). */
export function scanVacuousSkips(): VacuousSkip[] {
	return readWalkedFiles(listTestFiles()).flatMap(({ file, source }) =>
		scanVacuousSkipsInSource(relativePosix(repoRoot, file), source),
	);
}
