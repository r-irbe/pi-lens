#!/usr/bin/env node
/**
 * Run one bounded, restorable hand mutation (#4048).
 *
 * The file is deliberately a small process boundary: callers can use it from
 * a shell or a test without importing the test runner or the project build.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	normalizeVitestOutput,
	parseVitestSummary,
} from "./lib/vitest-summary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
	if (message) console.error(`mutate.mjs: ${message}`);
	console.error(
		"usage: scripts/mutate.mjs --file <path> --find <text|/regex/> --replace <text> --tests <files…> [--built] [--table] [--allow-comment]\n       scripts/mutate.mjs --restore [--file <path>]\n" +
			"exit codes: 0 or the test runner's code, 1 refused or failed, 2 usage, 4 the run could not restore its file (a journal remains)",
	);
	process.exitCode = 2;
}

function argsFrom(argv) {
	const values = { tests: [] };
	let fileSeen = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (
			arg === "--built" ||
			arg === "--table" ||
			arg === "--restore" ||
			arg === "--allow-comment"
		)
			values[arg.slice(2)] = true;
		else if (arg === "--tests") {
			// The list ends at the next flag: `--tests a b --table` is a table run.
			const end = argv.findIndex(
				(value, at) => at > index && value.startsWith("--"),
			);
			values.tests = argv.slice(index + 1, end === -1 ? argv.length : end);
			index = (end === -1 ? argv.length : end) - 1;
		} else if (["--file", "--find", "--replace"].includes(arg)) {
			if (arg === "--file" && fileSeen)
				throw new Error(
					"repeated --file is not supported; provide one file per run",
				);
			if (arg === "--file") fileSeen = true;
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			values[arg.slice(2)] = value;
		} else throw new Error(`unknown argument ${arg}`);
	}
	if (values.restore) return values;
	if (
		!values.file ||
		values.find === undefined ||
		values.replace === undefined
	) {
		throw new Error("--file, --find, and --replace are required");
	}
	if (values.tests.length === 0)
		throw new Error("--tests needs at least one file");
	return values;
}

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function gitClean(file) {
	const result = spawnSync(
		process.env.GIT ?? "git",
		["status", "--porcelain=v1", "--", file],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	if (result.error) throw result.error;
	return result.status === 0 && result.stdout.trim() === "";
}

function twinFor(source) {
	if (source.endsWith(".ts") || source.endsWith(".tsx")) {
		return source.replace(/\.tsx?$/, ".js");
	}
	return null;
}

function parseFind(value) {
	if (value.startsWith("/") && value.lastIndexOf("/") > 0) {
		const slash = value.lastIndexOf("/");
		try {
			return new RegExp(value.slice(1, slash), value.slice(slash + 1));
		} catch (error) {
			throw new Error(`invalid --find regex: ${error.message}`);
		}
	}
	return value;
}

function mutationFor(original, searchable, find, replacement, allowComment) {
	const needle = parseFind(find);
	const codeIndex =
		typeof needle === "string"
			? searchable.indexOf(needle)
			: (() => {
					needle.lastIndex = 0;
					return needle.exec(searchable)?.index ?? -1;
				})();
	if (codeIndex < 0 && !allowComment)
		throw new Error(
			"refusing no-op edit: --find matches only comments/strings/regex literals or is absent",
		);
	const originalIndex =
		codeIndex >= 0
			? codeIndex
			: typeof needle === "string"
				? original.indexOf(needle)
				: original.search(needle);
	const matchLength =
		typeof needle === "string"
			? needle.length
			: (() => {
					needle.lastIndex = 0;
					return needle.exec(original.slice(originalIndex))?.[0].length;
				})();
	const mutated =
		originalIndex >= 0 && matchLength !== undefined
			? original.slice(0, originalIndex) +
				replacement +
				original.slice(originalIndex + matchLength)
			: original.replace(needle, replacement);
	if (mutated === original) {
		throw new Error(
			"refusing no-op edit: --find is absent or replacement is identical",
		);
	}
	return mutated;
}

// The grammar @ast-grep/napi (a direct dependency) parses each JS/TS family
// file with; any other file type is matched raw, because a JS lexer would
// misread its comments and quotes.
const LEXER_LANGUAGES = {
	".ts": "TypeScript",
	".mts": "TypeScript",
	".cts": "TypeScript",
	".tsx": "Tsx",
	".js": "JavaScript",
	".mjs": "JavaScript",
	".cjs": "JavaScript",
	".jsx": "JavaScript",
};

const lexerLanguage = (file) => LEXER_LANGUAGES[path.extname(file)];

/** `source` with comments, strings, regex literals and a template's text blanked to spaces (newlines kept), so a needle can only match code. */
function blankNonCode(source, file, astGrep) {
	const language = lexerLanguage(file);
	if (!language) return source;
	const units = source.split(""); // UTF-16 units, the unit ast-grep reports
	const blank = (node) => {
		const { start, end } = node.range();
		for (let index = start.index; index < end.index; index += 1)
			if (units[index] !== "\n" && units[index] !== "\r") units[index] = " ";
	};
	const nonCode = ["comment", "string", "regex", "template_string"].map(
		(kind) => ({ kind }),
	);
	for (const node of astGrep
		.parse(language, source)
		.root()
		.findAll({ rule: { any: nonCode } })) {
		if (node.kind() !== "template_string") blank(node);
		else
			// A `${…}` substitution is code; the text around it is not.
			for (const part of node.children())
				if (part.kind() !== "template_substitution") blank(part);
	}
	return units.join("");
}

// The restore rule (#4048 round 3). A journal holds the original bytes and the
// sha256 of both the original and the mutated bytes. The file is written back
// only when its current sha256 equals the mutated sha256. Every other state
// writes nothing and reports the journal path and the three hashes.
const JOURNAL_SUFFIX = ".mutate-backup";

function journalFor(file) {
	return `${file}${JOURNAL_SUFFIX}`;
}

function journalOf(file, original, mutated) {
	return {
		version: 1,
		file: path.relative(root, file),
		originalSha256: digest(original),
		mutatedSha256: digest(mutated),
		original: original.toString("base64"),
	};
}

// `wx`: creating the journal is the lock that keeps a second run off this file.
function writeJournal(file, journal) {
	writeFileSync(journalFor(file), JSON.stringify(journal), { flag: "wx" });
}

function replaceJournal(file, journal) {
	const temporary = `${journalFor(file)}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(journal));
	renameSync(temporary, journalFor(file));
}

function readJournal(file) {
	const journal = JSON.parse(readFileSync(journalFor(file), "utf8"));
	const original = Buffer.from(journal.original, "base64");
	if (
		journal.version !== 1 ||
		typeof journal.originalSha256 !== "string" ||
		typeof journal.mutatedSha256 !== "string" ||
		digest(original) !== journal.originalSha256
	)
		throw new Error(
			"unknown version or original bytes do not match their hash",
		);
	return { ...journal, original };
}

function journalReport(file) {
	const current = statExists(file) ? digest(readFileSync(file)) : "absent";
	try {
		const journal = readJournal(file);
		return {
			journal,
			current,
			text: `original sha256 ${journal.originalSha256}; mutated sha256 ${journal.mutatedSha256}; current sha256 ${current}; journal ${journalFor(file)}`,
		};
	} catch (error) {
		return {
			journal: null,
			current,
			text: `journal ${journalFor(file)} is unreadable (${error.message}); current sha256 ${current}`,
		};
	}
}

/** Restores `file` from its journal under the rule above. Never throws and never writes on a refusal. */
function restoreJournal(file) {
	if (!statExists(journalFor(file))) return { restored: false, refusal: null };
	const { journal, current, text } = journalReport(file);
	const name = path.relative(root, file);
	if (!journal || current !== journal.mutatedSha256)
		return { restored: false, refusal: `refusing to restore ${name}: ${text}` };
	try {
		writeFileSync(file, journal.original);
		if (digest(readFileSync(file)) !== journal.originalSha256)
			throw new Error("restored bytes do not match the original sha256");
		unlinkSync(journalFor(file));
		return { restored: true, refusal: null };
	} catch (error) {
		return {
			restored: false,
			refusal: `restore of ${name} failed (${error.message}): ${text}`,
		};
	}
}

function journalFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules")
			found.push(...journalFiles(full));
		else if (entry.isFile() && entry.name.endsWith(JOURNAL_SUFFIX))
			found.push(full.slice(0, -JOURNAL_SUFFIX.length));
	}
	return found;
}

function failedTitles(output) {
	return output
		.split("\n")
		.filter((line) => /FAIL|×|✗/.test(line))
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 20);
}

function classifyTestRun(testRun) {
	if (parseVitestSummary(testRun.output).noTests) return "ERROR";
	return testRun.code === 0 ? "SURVIVED" : "RED";
}

function runTests(files, onSignal) {
	return new Promise((resolve) => {
		const command = path.join(root, "node_modules", ".bin", "vitest");
		const child = spawn(
			command,
			["run", ...files, "--configLoader", "runner"],
			{
				cwd: root,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		activeChild = child;
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		const stop = () => {
			child.kill("SIGINT");
			onSignal();
		};
		process.once("SIGINT", stop);
		child.once("close", (code, signal) => {
			activeChild = null;
			process.removeListener("SIGINT", stop);
			// The shared Vitest parser strips colour for the classification;
			// report the same plain text in the table.
			resolve({
				code: code ?? 130,
				signal,
				output: normalizeVitestOutput(output),
			});
		});
	});
}

let activeChild = null;

function build() {
	const result = spawnSync(
		process.execPath,
		[
			path.join(root, "node_modules", "typescript", "bin", "tsc"),
			"--project",
			"tsconfig.build.json",
		],
		{ cwd: root, env: process.env, encoding: "utf8", stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`build failed with exit code ${result.status}`);
}

function appendTable(options, result) {
	const row = `| ${options.file} | ${result.code} | ${result.status} | ${result.failed.length ? result.failed.join(" ") : "—"} |\n`;
	const body = path.join(root, "PR_BODY.md");
	if (options.table && statExists(body))
		writeFileSync(body, `${readFileSync(body, "utf8")}${row}`);
	console.log(`mutation-table: ${row.trimEnd()}`);
}

function statExists(file) {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}

function restoreCommand(options) {
	const source = options.file ? path.resolve(root, options.file) : null;
	const twin = source && !options.built ? twinFor(source) : null;
	const files = source ? [source, ...(twin ? [twin] : [])] : journalFiles(root);
	let restored = 0;
	let refused = 0;
	for (const file of files) {
		const outcome = restoreJournal(file);
		if (outcome.restored) restored += 1;
		if (outcome.refusal) {
			refused += 1;
			console.error(`mutate.mjs: ${outcome.refusal}`);
		}
	}
	console.log(`restored ${restored} mutation journal(s)`);
	return refused === 0 ? 0 : 1;
}

async function main() {
	let options;
	try {
		options = argsFrom(process.argv.slice(2));
	} catch (error) {
		usage(error.message);
		return 2;
	}
	if (options.restore) return restoreCommand(options);
	const source = path.resolve(root, options.file);
	const target = source;
	const candidateTwin = options.built ? null : twinFor(source);
	const twin =
		candidateTwin && statExists(candidateTwin) ? candidateTwin : null;
	const files = [target, ...(twin ? [twin] : [])];
	try {
		for (const file of files) {
			const name = path.relative(root, file);
			if (!statExists(file)) throw new Error(`file does not exist: ${name}`);
			// A journal is a live run's lock or a dead run's evidence; this run
			// cannot tell which, so only --restore ever consumes one.
			if (statExists(journalFor(file)))
				throw new Error(
					`refusing to start on ${name}: a mutation journal exists (a live run, or a run that died; recover with --restore): ${journalReport(file).text}`,
				);
			if (!gitClean(name)) throw new Error(`refusing dirty file: ${name}`);
		}
	} catch (error) {
		console.error(`mutate.mjs: ${error.message}`);
		return 1;
	}
	// Files whose journal this run created, in creation order.
	const owned = [];
	let result = { code: 2, failed: [], status: "RED" };
	let interrupted = false;
	let handlingSignal = false;
	const restoreOwned = () => {
		const refusals = [];
		for (const file of owned) {
			const { refusal } = restoreJournal(file);
			if (refusal) refusals.push(refusal);
		}
		return refusals;
	};
	const signalHandler = (signal) => {
		if (handlingSignal) return;
		handlingSignal = true;
		interrupted = true;
		try {
			if (activeChild) activeChild.kill("SIGKILL");
			for (const refusal of restoreOwned())
				console.error(`mutate.mjs: ${refusal}`);
		} finally {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
		}
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.once(signal, () => signalHandler(signal));
	process.once("uncaughtException", (error) => {
		try {
			for (const refusal of restoreOwned())
				console.error(`mutate.mjs: ${refusal}`);
		} finally {
			console.error(error.stack ?? error);
			process.exit(1);
		}
	});
	try {
		const originals = new Map(files.map((file) => [file, readFileSync(file)]));
		const original = originals.get(target);
		const lexer = lexerLanguage(target) ? await import("@ast-grep/napi") : null;
		const text = original.toString("utf8");
		const mutated = Buffer.from(
			mutationFor(
				text,
				lexer ? blankNonCode(text, target, lexer) : text,
				options.find,
				options.replace,
				options["allow-comment"],
			),
			"utf8",
		);
		writeJournal(target, journalOf(target, original, mutated));
		owned.push(target);
		writeFileSync(target, mutated);
		if (twin) {
			// The build has not rewritten the twin yet, so "mutated" is what it
			// is now; the real mutated hash is recorded the moment the build ends.
			const twinBytes = originals.get(twin);
			writeJournal(twin, journalOf(twin, twinBytes, twinBytes));
			owned.push(twin);
			try {
				build();
			} finally {
				// Nothing else runs between the build and this record, so the
				// twin's current bytes are the build's output, failed build included.
				replaceJournal(twin, journalOf(twin, twinBytes, readFileSync(twin)));
			}
		}
		if (interrupted)
			result = { code: 130, failed: ["interrupted"], status: "RED" };
		else {
			const testRun = await runTests(options.tests, () => {
				interrupted = true;
			});
			result = {
				code: testRun.code,
				failed: failedTitles(testRun.output),
				status: classifyTestRun(testRun),
			};
		}
	} catch (error) {
		result = { code: 1, failed: [error.message], status: "RED" };
	}
	const refusals = restoreOwned();
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.removeAllListeners(signal);
	if (refusals.length > 0) {
		for (const refusal of refusals) console.error(`mutate.mjs: ${refusal}`);
		result = { code: 4, failed: refusals, status: "ERROR" };
	}
	console.log("--- mutation transcript ---");
	console.log(
		`mutation: ${options.file} (${options.find} -> ${options.replace})`,
	);
	console.log(`exit code: ${result.code}`);
	console.log(
		`failed test titles: ${result.failed.length ? result.failed.join("; ") : "none"}`,
	);
	console.log(result.status);
	appendTable(options, result);
	return result.code;
}

main().then((code) => {
	process.exitCode = code;
});
