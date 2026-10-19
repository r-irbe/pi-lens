/**
 * Whether vitest collects a file, read from the repo's own `vitest.config.ts`
 * (#4393). A detector that decides a test exists must not count a file the
 * suite never runs: a support module, or a `*.test.ts` under an excluded tree
 * such as `tests/fixtures/` (#4399 verify r2 F3). The include and exclude
 * lists come from the config itself, so a change there moves this answer
 * with it; nothing here restates a glob.
 */
import { Minimatch } from "minimatch";
import { configDefaults } from "vitest/config";
// The live config source, not the build's gitignored `vitest.config.js`,
// which can lag it (same rule as lsp-spawn-heavy-coverage.test.ts).
// Allowlisted in module-instance-coverage.test.ts.
import vitestConfig from "../../vitest.config.ts";

/** One pattern list: plain paths match by equality, the rest as globs. */
interface Matcher {
	paths: Set<string>;
	globs: RegExp[];
}

interface ProjectGlobs {
	include: Matcher;
	exclude: Matcher;
}

const GLOB_CHARACTER = /[*?[\]{}()!]/;

function compile(patterns: readonly string[]): Matcher {
	const paths = new Set<string>();
	const globs: RegExp[] = [];
	for (const pattern of patterns) {
		const glob = GLOB_CHARACTER.test(pattern)
			? new Minimatch(pattern, { dot: true }).makeRe()
			: false;
		if (glob) globs.push(glob);
		else paths.add(pattern);
	}
	return { paths, globs };
}

const matches = (matcher: Matcher, relativePath: string): boolean =>
	matcher.paths.has(relativePath) ||
	matcher.globs.some((glob) => glob.test(relativePath));

let projectGlobs: ProjectGlobs[] | undefined;

function globs(): ProjectGlobs[] {
	if (projectGlobs) return projectGlobs;
	const root = vitestConfig.test ?? {};
	const rootExclude = root.exclude ?? configDefaults.exclude;
	const projects = (root.projects ?? []) as Array<{
		test?: { include?: string[]; exclude?: string[] };
	}>;
	const tests =
		projects.length > 0 ? projects.map((p) => p.test ?? {}) : [root];
	projectGlobs = tests.map((test) => ({
		include: compile(test.include ?? root.include ?? configDefaults.include),
		exclude: compile(test.exclude ?? rootExclude),
	}));
	return projectGlobs;
}

/** Does some vitest project of this repo collect `relativePath` (POSIX, from the repo root)? */
export function vitestCollects(relativePath: string): boolean {
	return globs().some(
		(project) =>
			matches(project.include, relativePath) &&
			!matches(project.exclude, relativePath),
	);
}
