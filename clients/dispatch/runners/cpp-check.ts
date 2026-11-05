import * as fs from "node:fs";
import * as path from "node:path";
import { pathsEqual } from "../../path-utils.js";
import { safeSpawnAsync } from "../../safe-spawn.js";
import { probeToolAsync } from "../../tool-probe.js";
import { resolveRunnerCwd } from "../../tool-cwd.js";
import { getServerInitOverride } from "../../lsp/config.js";
import { resolveLeanIncludeFlags } from "../../lean-context.js";
import {
	classifyLeanContextFailureMessage,
	recordLeanContextUnavailable,
} from "../../lean-context-unavailable.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { createAvailabilityChecker } from "./utils/runner-helpers.js";
import { finishParsedRun, parseToolRun } from "./utils/tool-failure.js";

type CompilerSpec =
	| { command: string; args: string[]; flavor: "gcc" | "msvc" }
	| undefined;

// Per-compiler availability checkers — each one caches per-cwd and
// dedupes concurrent --version probes, the same protections every other
// runner gets via createAvailabilityChecker. cpp-check previously
// re-spawned its full candidate sweep on every edit.
const compilerCheckers = {
	clang: createAvailabilityChecker("clang", ".exe"),
	gcc: createAvailabilityChecker("gcc", ".exe"),
	cc: createAvailabilityChecker("cc", ".exe"),
	"clang++": createAvailabilityChecker("clang++", ".exe"),
	"g++": createAvailabilityChecker("g++", ".exe"),
	"c++": createAvailabilityChecker("c++", ".exe"),
	cl: createAvailabilityChecker("cl", ".exe"),
} as const;
type CompilerKey = keyof typeof compilerCheckers;

const C_SOURCE_EXTENSIONS = new Set([".c"]);
const C_HEADER_EXTENSIONS = new Set([".h"]);
const CPP_SOURCE_EXTENSIONS = new Set([
	".c++",
	".cc",
	".cp",
	".cpp",
	".cxx",
	".c++m",
	".cppm",
	".cxxm",
	".ixx",
	".cu",
	".hip",
	".mm",
	".clcpp",
]);
const CPP_HEADER_EXTENSIONS = new Set([
	".hh",
	".hpp",
	".hxx",
	".inl",
	".ipp",
	".tpp",
	".txx",
]);

function headerLooksLikeCpp(absPath: string): boolean {
	try {
		const content = fs.readFileSync(absPath, "utf-8");
		return /\b(namespace|template|class|constexpr|concept|using)\b|std::|\b(public|private|protected)\s*:/.test(
			content,
		);
	} catch {
		return false;
	}
}

function getGccLikeCandidates(
	absPath: string,
): Array<{ key: CompilerKey; args: string[] }> {
	const ext = path.extname(absPath).toLowerCase();
	const cMode =
		C_SOURCE_EXTENSIONS.has(ext) ||
		(C_HEADER_EXTENSIONS.has(ext) && !headerLooksLikeCpp(absPath));
	const cppMode =
		CPP_SOURCE_EXTENSIONS.has(ext) || CPP_HEADER_EXTENSIONS.has(ext);

	if (cMode) {
		const cArgs = C_HEADER_EXTENSIONS.has(ext)
			? ["-x", "c-header", "-fsyntax-only", absPath]
			: ["-x", "c", "-fsyntax-only", absPath];
		return [
			{ key: "clang", args: cArgs },
			{ key: "gcc", args: cArgs },
			{ key: "cc", args: cArgs },
		];
	}

	if (cppMode || ext) {
		return [
			{ key: "clang++", args: ["-fsyntax-only", absPath] },
			{ key: "g++", args: ["-fsyntax-only", absPath] },
			{ key: "c++", args: ["-fsyntax-only", absPath] },
		];
	}

	return [];
}

async function resolveCompiler(
	absPath: string,
	cwd: string,
): Promise<CompilerSpec> {
	for (const candidate of getGccLikeCandidates(absPath)) {
		const checker = compilerCheckers[candidate.key];
		if (await checker.isAvailableAsync(cwd)) {
			const command = checker.getCommand(cwd) ?? candidate.key;
			return { command, args: candidate.args, flavor: "gcc" };
		}
	}

	// MSVC `cl.exe` doesn't accept `--version`; the createAvailabilityChecker
	// probe used by every other compiler returns false even when cl is on
	// PATH. Keep the ad-hoc no-arg probe but cache the resolution via the
	// shared checker so subsequent edits don't re-spawn.
	const clChecker = compilerCheckers.cl;
	const clCmd = clChecker.getCommand(cwd);
	if (clCmd) {
		// Already probed in a previous turn and resolved.
		return {
			command: clCmd,
			args: ["/nologo", "/Zs", absPath],
			flavor: "msvc",
		};
	}
	// Mirrors the deliberate global-PATH probes in utils/runner-helpers.ts:
	// this never resolves a config file or a target path, so there is no cwd
	// for it to get wrong.
	const clProbe = await probeToolAsync("cl", [], { timeout: 5000 });
	if (!clProbe.error && clProbe.status !== null) {
		return {
			command: "cl",
			args: ["/nologo", "/Zs", absPath],
			flavor: "msvc",
		};
	}

	return undefined;
}

function parseGccLikeOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s+(.+)$/i,
		);
		if (!match) continue;
		const [, sourcePath, lineStr, colStr, severityLabel, message] = match;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, sourcePath.trim()), absTarget)) continue;

		const severity = severityLabel.toLowerCase().includes("error")
			? "error"
			: "warning";
		diagnostics.push({
			id: `cpp-check-${severityLabel}-${lineStr}-${colStr || "1"}`,
			message: message.trim(),
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity,
			// This single-file syntax check has no compile database, include path,
			// or build flags. It can inform, but cannot prove a project blocker.
			semantic: "warning",
			tool: "cpp-check",
			rule: severityLabel.toLowerCase(),
			fixable: false,
		});
	}
	return diagnostics;
}

function parseMsvcOutput(
	raw: string,
	filePath: string,
	cwd: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const absTarget = path.resolve(cwd, filePath);
	for (const line of raw.split(/\r?\n/)) {
		const match = line.match(
			/^(.*)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s+([A-Z]+\d+):\s+(.+)$/i,
		);
		if (!match) continue;
		const [, sourcePath, lineStr, colStr, severityLabel, rule, message] = match;
		// #3278: one seam for reported-path attribution — see javac.ts.
		if (!pathsEqual(path.resolve(cwd, sourcePath.trim()), absTarget)) continue;

		const severity = severityLabel.toLowerCase().includes("error")
			? "error"
			: "warning";
		diagnostics.push({
			id: `cpp-check-${rule}-${lineStr}-${colStr || "1"}`,
			message: `[${rule}] ${message.trim()}`,
			filePath,
			line: Number.parseInt(lineStr, 10) || 1,
			column: Number.parseInt(colStr || "1", 10) || 1,
			severity,
			// MSVC is invoked with the same context-free single-file contract.
			semantic: "warning",
			tool: "cpp-check",
			rule,
			fixable: false,
		});
	}
	return diagnostics;
}

function beginsWithLeanRuntimeInclude(content: string): boolean {
	// C splices backslash-newline before recognizing comments/directives. Only
	// the generated header's literal logical directive is supported, not macros.
	const logical = content.replace(/\\\r?\n/g, "");
	const trivia = /[ \t\v\f\r\n]+|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//y;
	let offset = 0;
	while (trivia.exec(logical)) offset = trivia.lastIndex;
	const include =
		/^#[ \t\v\f]*include[ \t\v\f]*(?:<lean\/lean\.h>|"lean\/lean\.h")/.exec(
			logical.slice(offset),
		);
	if (!include) return false;
	let end = offset + include[0].length;
	const trailing = /[ \t\v\f]+|\/\*[^\r\n]*?\*\//y;
	trailing.lastIndex = end;
	while (trailing.exec(logical)) end = trailing.lastIndex;
	const nextChar = logical[end];
	return (
		end === logical.length ||
		(nextChar !== undefined && /[\r\n]/.test(nextChar)) ||
		logical.startsWith("//", end)
	);
}

const cppCheckRunner: RunnerDefinition = {
	id: "cpp-check",
	appliesTo: ["cxx"],
	priority: PRIORITY.GENERAL_ANALYSIS,
	skipTestFiles: false,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const cwd = resolveRunnerCwd(ctx, "cpp-check");
		const absPath = path.resolve(cwd, ctx.filePath);
		let content = ctx.facts.getFileFact<string | null>(
			ctx.filePath,
			"file.content",
		);
		if (content === undefined) {
			try {
				content = fs.readFileSync(absPath, "utf8");
			} catch {
				content = "";
			} // Preserve the ordinary compiler's unreadable-file verdict.
		}
		let leanIncludeFlags: string[] = [];
		if (beginsWithLeanRuntimeInclude(content ?? "")) {
			let rejectedByConfig = false;
			try {
				const override = getServerInitOverride("lean", absPath);
				if (override?.leanContextUnavailable) {
					rejectedByConfig = true;
					throw new Error(override.leanContextUnavailable);
				}
				if (!override?.leanContext)
					throw new Error(
						"environment_unavailable: generated Lean C requires an admitted lsp.serverOverrides.lean.leanContext for matching runtime headers",
					);
				leanIncludeFlags = await resolveLeanIncludeFlags(
					override.leanContext,
					cwd,
					safeSpawnAsync,
				);
			} catch (thrown) {
				const message =
					thrown instanceof Error
						? thrown.message
						: "environment_unavailable: cannot resolve the admitted Lean runtime headers";
				recordLeanContextUnavailable({
					caller: "cpp-check",
					reasonCode: classifyLeanContextFailureMessage(
						message,
						rejectedByConfig,
					),
					reason: message,
				});
				return {
					status: "failed",
					failureKind: "unavailable",
					failureMessage: message,
					semantic: "warning",
					diagnostics: [
						{
							id: "cpp-check-environment-unavailable",
							filePath: ctx.filePath,
							tool: "cpp-check",
							rule: "environment-unavailable",
							severity: "warning",
							semantic: "warning",
							message,
						},
					],
				};
			}
		}
		const compiler = await resolveCompiler(absPath, cwd);
		if (!compiler) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const includeArgs =
			compiler.flavor === "msvc"
				? leanIncludeFlags.map((flag) => `/I${flag.slice(2)}`)
				: leanIncludeFlags;
		const result = await safeSpawnAsync(
			compiler.command,
			[...includeArgs, ...compiler.args],
			{
				cwd,
				timeout: 30000,
			},
		);
		const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		const parsed = parseToolRun(
			"cpp-check",
			{
				result,
				output: raw,
				// EXIT TABLE (gcc/clang 13 measured fixture): 0 clean; 1 findings; 2 error; other nonzero rejected.
				exitCodes: { ran: [1, 2] },
			},
			(output) =>
				compiler.flavor === "msvc"
					? parseMsvcOutput(output, ctx.filePath, cwd)
					: parseGccLikeOutput(output, ctx.filePath, cwd),
		);
		if (parsed.skipped) return parsed.skipped;
		return finishParsedRun({
			tool: "cpp-check",
			ctx,
			result,
			diagnostics: parsed.diagnostics,
			classify: (diagnostics) => ({
				status: diagnostics.some((d) => d.severity === "error")
					? "failed"
					: "succeeded",
				semantic: "warning",
			}),
		});
	},
};

export default cppCheckRunner;
