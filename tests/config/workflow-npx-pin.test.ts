// Recurrence: #4339. tool-smoke.yml:550 `npx vitest run` reached master via
// #4277 and was caught only by the nightly SonarCloud master gate (S6505 and
// S8543: `npx` can install a package on demand and run its lifecycle scripts).
// No PR-time check looked at workflow `npx` calls before this test.
//
// Allowed forms, and nothing else:
//   - `npx -y "<pkg>@${<var>}"`, where <var> is bound in the same `run:`
//     script to package.json's `packageManager` (`npmPinBoundAt`, shared with
//     tests/config/release-npm-pin-gate.test.ts), and that field is itself
//     checked to be an exact `npm@x.y.z` below;
//   - `npx -y <pkg>@<x.y.z>`, a literal exact semver.
// Violations: bare `npx <bin>`, `--yes <pkg>` without a version, a range, a
// tag such as `@latest`, and `npx --no-install`. `--no-install` is refused:
// Sonar keys on the `npx` invocation, not on whether it happens to install,
// and the repo's answer for a bin is `node_modules/.bin/<bin>` (#4339).
//
// Detector discipline (principles §2, "Detectors match code, not prose"):
// every `run:` script is read through `lexShellAligned`, the shell lexer the
// pinned-npm gate shares, with offsets equal to the script's. It blanks
// comments and string bodies, so a comment quoting `npx vitest` neither trips
// the rule nor binds a pin, and `echo "... npx resolved ..."` is not a call.
// js-yaml drops YAML comments before the scripts are read. Argument shape is
// read from the raw script at the lexed call's offset, because the lexer
// blanks the body of the quoted pin.
// Not covered: `npx` inside `bash -c`, `sh -c` or `eval` strings, a quoted or
// path-qualified `npx` (`"npx"`, `/usr/bin/npx`), `npm exec`, `npm x`,
// `pnpm dlx`, `yarn dlx`, `bunx`, and `actions/github-script` or other `with:`
// strings; none occurs in a workflow today. Every `npx` word the lexer leaves
// is a call, so `echo npx` unquoted is a loud false positive.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	lexShellAligned,
	npmPinBoundAt,
} from "../support/workflow-shell-portability.js";

const ROOT = resolve(import.meta.dirname, "../..");

const NPX_CALL = /(?<![\w./-])npx(?=[\s)]|$)/g;
// `-y`/`--yes`, then the pinned form, then a word boundary (space, `)`, `;`...).
const PINNED_VAR =
	/^\s+(?:-y|--yes)\s+(["']?)[\w@./-]+@\$\{(\w+)\}\1(?=[\s);&|]|$)/;
const EXACT_SEMVER =
	/^\s+(?:-y|--yes)\s+(["']?)[\w@./-]+@\d+\.\d+\.\d+\1(?=[\s);&|]|$)/;

export type NpxFinding = { calls: number; violations: string[] };

/** Walk every `run:` string in a parsed workflow or composite action. */
function collectRuns(node: unknown, out: string[]): string[] {
	if (Array.isArray(node)) {
		for (const child of node) collectRuns(child, out);
	} else if (node && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (key === "run" && typeof value === "string") out.push(value);
			else collectRuns(value, out);
		}
	}
	return out;
}

export function scanWorkflowSource(source: string): NpxFinding {
	const finding: NpxFinding = { calls: 0, violations: [] };
	for (const run of collectRuns(yaml.load(source), [])) {
		for (const match of lexShellAligned(run).matchAll(NPX_CALL)) {
			finding.calls++;
			const at = match.index ?? 0;
			const rest = run
				.slice(at + "npx".length)
				.replace(/\\\r?\n[ \t]*/g, "")
				.split("\n")[0];
			const offending = `npx${rest}`.trim();
			const pinned = PINNED_VAR.exec(rest);
			if (pinned) {
				if (!npmPinBoundAt(run, pinned[2], at))
					finding.violations.push(
						`pin variable \${${pinned[2]}} is not bound to packageManager in this step: ${offending}`,
					);
				continue;
			}
			if (EXACT_SEMVER.test(rest)) continue;
			finding.violations.push(
				`not a pinned or exact-semver npx form: ${offending}`,
			);
		}
	}
	return finding;
}

function listYamlFiles(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) listYamlFiles(path, out);
		else if (/\.ya?ml$/.test(name)) out.push(path);
	}
}

function repoWorkflowFiles(): string[] {
	const files: string[] = [];
	const workflows = join(ROOT, ".github/workflows");
	for (const name of readdirSync(workflows))
		if (/\.ya?ml$/.test(name)) files.push(join(workflows, name));
	const actions = join(ROOT, ".github/actions");
	if (existsSync(actions)) listYamlFiles(actions, files);
	return files.map((path) => relative(ROOT, path)).sort();
}

const workflow = (body: string) =>
	`jobs:\n  j:\n    steps:\n      - run: |\n${body
		.split("\n")
		.map((line) => `          ${line}`)
		.join("\n")}\n`;
// The literal every pinned workflow step writes, kept independent of
// NPM_PIN_SOURCE so the fixture cannot agree with the helper by construction.
const PIN_LINE = `npm_pin="$(node -p "require('./package.json').packageManager.replace(/^npm@/, '')")"`;

describe("workflow npx calls are pinned (#4339)", () => {
	it("package.json pins npm to an exact version", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
	});

	it("every npx call in every workflow and composite action is pinned", () => {
		const files = repoWorkflowFiles();
		assertNonEmptyScan("npx pin scan: workflow files", files.length, 15);
		const findings = files.map((file) => ({
			file,
			...scanWorkflowSource(readFileSync(join(ROOT, file), "utf8")),
		}));
		assertNonEmptyScan(
			"npx pin scan: npx words in lexed run scripts",
			findings.reduce((sum, f) => sum + f.calls, 0),
			10,
		);
		const violations = findings.flatMap((f) =>
			f.violations.map((v) => `${f.file}: ${v}`),
		);
		expect(violations).toEqual([]);
	});

	it.each([
		["flags a bare npx <bin>", "npx vitest run tests/a.ts", 1],
		["flags --yes without a version", "npx --yes pkg", 1],
		["flags a tag", "npx -y pkg@latest", 1],
		["flags a range", "npx -y pkg@^1.2.3", 1],
		[
			"flags --no-install (Sonar keys on the call)",
			"npx --no-install vitest",
			1,
		],
		["accepts a literal exact semver", "npx -y pkg@1.2.3 x", 0],
		[
			"accepts a pin variable assigned from packageManager",
			`${PIN_LINE}\nnpx -y "npm@\${npm_pin}" --version`,
			0,
		],
		[
			"rejects a pin variable never assigned from packageManager",
			`npx -y "npm@\${other}" --version`,
			1,
		],
		[
			"rejects a pin variable whose only assignment is commented out",
			`# ${PIN_LINE}\nnpx -y "npm@\${npm_pin}" --version`,
			1,
		],
		["ignores a comment quoting npx", "# npx vitest run\necho ok", 0],
		[
			"ignores npx inside an echoed string",
			'echo "toolchain: npx resolved npm"',
			0,
		],
		["catches a call continued onto the next line", "npx vitest \\\n  run", 1],
		// #4339 review F2: the bind is read from the assignment itself.
		[
			"rejects a bind whose packageManager read is only in a trailing comment",
			`npm_pin="$(node -p "require('./package.json').version")" # require('./package.json').packageManager\nnpx -y "npm@\${npm_pin}" --version`,
			1,
		],
		[
			"rejects a pin variable reassigned after its bind",
			`${PIN_LINE}\nnpm_pin=latest\nnpx -y "npm@\${npm_pin}" --version`,
			1,
		],
		[
			"rejects a bind that is only an echo argument",
			`echo ${PIN_LINE}\nnpx -y "npm@\${npm_pin}" --version`,
			1,
		],
		[
			"rejects a bind that only prefixes one command",
			`${PIN_LINE} true\nnpx -y "npm@\${npm_pin}" --version`,
			1,
		],
		[
			"rejects a pin variable used before its bind",
			`npx -y "npm@\${npm_pin}" --version\n${PIN_LINE}`,
			1,
		],
		// #4339 review F3: a comment does not continue, and escaped quotes do
		// not open or close a string.
		[
			"catches a call after a comment that ends in a backslash",
			"# note \\\nnpx foo",
			1,
		],
		[
			"catches a call after an escaped double quote",
			'echo "a \\" b" && npx foo',
			1,
		],
		[
			"catches a call after an escaped single quote",
			"echo it\\'s && npx foo",
			1,
		],
		["catches a call after an ANSI-C string", "echo $'a\\'b' && npx foo", 1],
	])("fixture: %s", (_name, body, expected) => {
		expect(scanWorkflowSource(workflow(body)).violations).toHaveLength(
			expected,
		);
	});

	// #4339 review F1: each step is its own shell, so a bind in job a does not
	// reach job b.
	it("rejects a pin variable bound only in another job's step", () => {
		const source = `jobs:
  a:
    steps:
      - run: |
          ${PIN_LINE}
          npx -y "npm@\${npm_pin}" --version
  b:
    steps:
      - run: npx -y "npm@\${npm_pin}" publish
`;
		expect(scanWorkflowSource(source).violations).toEqual([
			'pin variable ${npm_pin} is not bound to packageManager in this step: npx -y "npm@${npm_pin}" publish',
		]);
	});
});
