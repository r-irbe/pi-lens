/**
 * Shellcheck runner for dispatch system
 *
 * Industry-standard linter for shell scripts (bash, sh, zsh).
 * Detects syntax errors, undefined variables, quoting issues, and best practices.
 *
 * Why shellcheck?
 * - Industry standard (used in CI/CD everywhere)
 * - Comprehensive checks (syntax, variables, quotes, best practices)
 * - JSON output for easy parsing
 * - Available on all platforms (apt, brew, cargo, etc.)
 *
 * Alternative considered: bash-language-server
 * - LSP approach like OpenCode uses
 * - Richer features but heavier
 * - shellcheck is simpler and faster for basic linting
 *
 * Install: apt install shellcheck, brew install shellcheck, or cargo install shellcheck
 *
 * Config: .shellcheckrc (optional, zero-config works)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	createAvailabilityChecker,
	coveringLaneAvailable,
	lspPrimaryCoversFile,
	resolveAvailableOrInstall,
} from "./utils/runner-helpers.js";
import { finishParsedRun } from "./utils/tool-failure.js";

const shellcheck = createAvailabilityChecker("shellcheck", ".exe");

/**
 * ShellCheck's supported linter dialects, pinned per defect shape 16 to
 * `bash-lsp/bash-language-server@server-5.8.1`
 * `server/src/shellcheck/config.ts` (`SHELLCHECK_DIALECTS`). A dialect
 * outside this set cannot be analyzed at all — ShellCheck refuses it
 * outright (SC1071) and, where zsh code happens to parse under bash
 * semantics, reports findings built on the wrong dialect. That refusal is
 * why a dialect-resolved CLI run SKIPS client-side instead of reporting.
 */
const SHELLCHECK_DIALECTS: readonly string[] = [
	"sh",
	"bash",
	"dash",
	"ksh",
	"busybox",
] as const;
/** Exported for the class-sweep pin (tests/config/shell-dialect-ownership-sweep); the set itself is the pinned upstream fact. */
export const SHELLCHECK_SUPPORTED_DIALECTS = SHELLCHECK_DIALECTS;

// Upstream shebang/directive parsing, pinned to
// `bash-lsp/bash-language-server@server-5.8.1` `server/src/util/shebang.ts`
// (defect shape 16 — test vectors generated from the real binary, not invented):
const SHEBANG_REGEXP = /^#!(.+)/;
// `/path/to/env [-S] <shell>` or `/path/to/<shell>`; takes the interpreter NAME.
const SHEBANG_INTERPRETER_REGEXP =
	/^[/](?:[^ /]+[/])*(?:env +(?:-S +)?)?([^ /]+)/;
// The first continuous run of blank/comment lines may carry a
// `shellcheck shell=<dialect>` directive (blanked comment lines keep the
// region open; any code line closes it).
const SHELLCHECK_SHELL_OR_EMPTY_REGEXP =
	/^\s*(?:#\s*shellcheck\s+(?:\S+\s+)*shell=(\w+)|#|$)/;
/** How many leading bytes of the file dialect resolution reads, bounded. */
const DIALECT_SNIFF_BYTES = 4096;

/** Dialect facts for a shell file, mirroring upstream `analyzeFile`'s shape. */
export interface ShellFileDialect {
	/** The parsed shebang interpreter name, or null. */
	shebang: string | null;
	/** The parsed `shellcheck shell=` directive value, or null. */
	directive: string | null;
	/** The resolved dialect name (defaults to bash, as upstream does). */
	dialect: string;
}

function parseShebang(content: string): string | null {
	const match = SHEBANG_REGEXP.exec(content);
	if (!match || !match[1]) return null;
	const interpreter = SHEBANG_INTERPRETER_REGEXP.exec(match[1].trim());
	if (!interpreter || !interpreter[1]) return null;
	return interpreter[1].trim();
}

function parseShellDirective(content: string): string | null {
	for (const line of content.split("\n")) {
		const match = SHELLCHECK_SHELL_OR_EMPTY_REGEXP.exec(line);
		// A code line closes the eligible region (upstream's rule).
		if (match === null) break;
		if (match[1]) return match[1].trim();
	}
	return null;
}

/**
 * Resolve a shell file's dialect: `shellcheck shell=` directive, then
 * shebang, then a file extension that carries one (upstream's `parseUri`
 * maps only `.zsh` to a name), defaulting to bash. Resolved against the
 * file's CURRENT bytes; an unreadable file fails open with the bash default
 * (pre-fix behavior — shape 48: the named harm of skipping would be silent
 * coverage loss, so we lint and let the spawn disclose).
 */
export function resolveShellFileDialect(filePath: string): ShellFileDialect {
	let content: string;
	try {
		content = fs
			.readFileSync(filePath)
			?.subarray(0, DIALECT_SNIFF_BYTES)
			.toString("utf8");
	} catch {
		return { shebang: null, directive: null, dialect: "bash" };
	}
	const directive = parseShellDirective(content);
	const shebang = parseShebang(content);
	// Selection lower-cases the extension (`selectionReason`), so the
	// extension arm matches case-insensitively too — a `.ZSH` file must not
	// slip through to the bash fallback.
	const parsed =
		directive ??
		shebang ??
		(path.extname(filePath).toLowerCase() === ".zsh" ? "zsh" : null);
	return {
		shebang,
		directive,
		dialect: parsed ?? "bash",
	};
}

function findShellcheckConfig(cwd: string): string | undefined {
	const local = path.join(cwd, ".shellcheckrc");
	if (fs.existsSync(local)) return local;

	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".shellcheckrc");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return undefined;
}

/**
 * Parse shellcheck JSON output
 *
 * Format: Array of check objects
 * [{
 *   "file": "script.sh",
 *   "line": 10,
 *   "endLine": 10,
 *   "column": 5,
 *   "endColumn": 10,
 *   "level": "warning",
 *   "code": 2154,
 *   "message": "var is referenced but not assigned.",
 *   "fix": null
 * }]
 *
 * Levels: "error", "warning", "info", "style"
 */
function parseShellcheckOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);

	if (!raw.trim()) {
		return diagnostics;
	}

	try {
		const parsed = JSON.parse(raw) as Array<{
			file?: string;
			line?: number;
			endLine?: number;
			column?: number;
			endColumn?: number;
			level?: string;
			code?: number;
			message?: string;
			fix?: unknown;
		}>;

		if (!Array.isArray(parsed)) {
			return diagnostics;
		}

		for (const item of parsed) {
			if (!item.message || !item.line) continue;
			if (!item.file || !pathsEqual(path.resolve(cwd, item.file), absTarget))
				continue;

			// Map shellcheck levels to our severity
			const severityMap: Record<string, "error" | "warning" | "info"> = {
				error: "error",
				warning: "warning",
				info: "info",
				style: "info",
			};
			const severity = severityMap[item.level || "warning"] || "warning";

			const ruleCode = item.code ? `SC${item.code}` : "unknown";

			diagnostics.push({
				id: `shellcheck-${item.line}-${ruleCode}`,
				message: `[${ruleCode}] ${item.message}`,
				filePath,
				line: item.line,
				column: item.column || 1,
				severity,
				semantic: severity === "error" ? "blocking" : "warning",
				tool: "shellcheck",
				rule: ruleCode,
				fixable: !!item.fix,
				autoFixAvailable: false,
				fixKind: item.fix ? "suggestion" : undefined,
			});
		}
	} catch {
		// JSON parse failed, return empty
		return diagnostics;
	}

	return diagnostics;
}

const shellcheckRunner: RunnerDefinition = {
	id: "shellcheck",
	appliesTo: ["shell"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false, // Shell scripts in test directories should still be checked

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "shellcheck");

		// #233, generalized (#3968): when the file's selected primary LSP
		// declares a covers fact for THIS RUNNER's capability (the old literal
		// `bash` server-id match could not express that), and the covering lane
		// can actually run, the warm server already produces these diagnostics —
		// skip the redundant CLI scan. Stays active when the covering lane is
		// absent so shell coverage never regresses.
		const cover = lspPrimaryCoversFile(ctx, "shellcheck");
		if (
			cover &&
			(await coveringLaneAvailable(ctx, cover)) &&
			(await ctx.hasTool("shellcheck"))
		) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "covered-by-primary",
				// WHO claimed (#3968 F2): declared (the row's own covers, gated
				// on the custom row's own command) or builtin-fact.
				claimSource: cover.claimSource,
			};
		}

		// #3968 dialect gate — categorical, deliberately independent of covers:
		// ShellCheck cannot analyze dialects outside SHELLCHECK_DIALECTS (it
		// refuses them outright with SC1071, and zsh-adjacent code that happens
		// to parse under bash semantics reports findings built on the wrong
		// dialect — error-severity noise exactly like #3968's report). Skipping
		// client-side here diverges from the upstream LSP lane's deliberate
		// pass-through on shebang'd files, because THAT pass-through is the
		// reported harm — the #1064 "let ShellCheck report it" comment protects
		// the bash-lsp embedding, not a CLI lane with no other zsh lane to defer
		// to. `zsh` always skips, regardless of LSP state.
		const dialectInfo = resolveShellFileDialect(ctx.filePath);
		if (!SHELLCHECK_DIALECTS.includes(dialectInfo.dialect)) {
			return {
				status: "skipped",
				diagnostics: [],
				semantic: "none",
				skipReason: "dialect-unsupported",
			};
		}

		let cmd: string | null = null;
		if (await shellcheck.isAvailableAsync(cwd)) {
			cmd = shellcheck.getCommand(cwd);
		} else {
			const managed = await resolveAvailableOrInstall(
				shellcheck,
				"shellcheck",
				cwd,
			);
			if (managed) cmd = managed;
		}
		if (!cmd) return { status: "skipped", diagnostics: [], semantic: "none" };

		// Build args
		// --format json: JSON output
		// --shell: specify the dialect ONLY when the file carries neither a
		// shebang nor a `shellcheck shell=` directive — ShellCheck performs its
		// own shebang parsing when one exists (mirror of
		// bash-language-server@server-5.8.1's lint flow, their #1064 guard
		// against interfering with that). A shebang-less file keeps the bash
		// fallback, exactly like upstream's own tentative detection.
		// --severity: minimum severity (we'll filter ourselves)
		const args: string[] = ["--format", "json"];
		if (!dialectInfo.shebang && !dialectInfo.directive) {
			args.push("--shell", dialectInfo.dialect);
		}

		// Check for config file
		const configPath = findShellcheckConfig(ctx.cwd);
		if (!configPath) {
			// No config file: surface `info`-level findings (e.g. SC2086
			// double-quote-to-prevent-globbing — a high-value, commonly-relevant
			// check that was previously dropped, #213) while still excluding pure
			// `style` rules to limit noise. Projects opt into style via .shellcheckrc.
			args.push("--severity", "info");
		}

		args.push(ctx.filePath);

		const result = await safeSpawnAsync(cmd, args, { cwd, timeout: 15000 });

		// shellcheck exits with code 1 if issues found, 0 if clean
		if (result.status === 0 && !result.stdout?.trim()) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Parse diagnostics
		const raw = result.stdout + result.stderr;
		const diagnostics = parseShellcheckOutput(raw, ctx.filePath, cwd);

		return finishParsedRun({
			tool: "shellcheck",
			ctx,
			result,
			diagnostics,
		});
	},
};

export default shellcheckRunner;
