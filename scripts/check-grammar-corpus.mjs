#!/usr/bin/env node
/**
 * Parse one committed multi-construct corpus file through TreeSitterClient per
 * grammar (#4012). Each parent-process result is one bounded JSON record per
 * grammar; a child keeps an uncatchable WASM abort from hiding the remaining
 * results. Record `reason`s: `missing-corpus`, `grammar-did-not-load` (status
 * unavailable: a missing download), `null-parse` (the grammar loaded but the
 * parse threw), `error-node` (the tree holds an ERROR or MISSING node), and a
 * signal or exit code for a child that died.
 *
 * Nightly only (`.github/workflows/grammar-health.yml`). The per-PR lane checks
 * the corpus is complete and tracked, hermetically
 * (`tests/clients/grammar-corpus-health.test.ts`).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CORPUS = path.join(ROOT, "tests", "fixtures", "grammar-health");
const CHILD = process.argv[2] === "--child";
const language = process.argv[3];

function corpusFiles() {
	return new Map(
		readdirSync(CORPUS)
			.filter((name) => name.includes("."))
			.map((name) => [
				name.slice(0, name.indexOf(".")),
				path.join(CORPUS, name),
			]),
	);
}

async function parseOne(id) {
	const { TreeSitterClient } = await import("../clients/tree-sitter-client.js");
	const client = new TreeSitterClient();
	if (!(await client.init()))
		return { status: "unavailable", reason: "runtime" };
	const file = corpusFiles().get(id);
	if (!file) return { status: "failed", reason: "missing-corpus" };
	if (!(await client.isLanguageSupported(id)))
		return { status: "unavailable", reason: "grammar-did-not-load" };
	// The grammar loaded, so a null tree is a parse that threw: the client
	// swallows it (#3996: the bash wasm's unresolved `isalpha` import threw
	// `resolved is not a function` on `[ a == b ]`).
	const tree = await client.parseFile(file, id);
	if (!tree) return { status: "failed", reason: "null-parse" };
	if (tree.rootNode.hasError) return { status: "failed", reason: "error-node" };
	return { status: "ok" };
}

async function main() {
	const { LANGUAGE_TO_GRAMMAR, grammarBlockReason } =
		await import("../clients/grammar-source.js");
	const languages = Object.keys(LANGUAGE_TO_GRAMMAR).sort();
	if (CHILD) {
		const result = await parseOne(language);
		console.log(
			JSON.stringify({
				grammar: LANGUAGE_TO_GRAMMAR[language],
				language,
				...result,
			}),
		);
		process.exitCode = result.status === "ok" ? 0 : 1;
		return;
	}

	const failures = [];
	for (const id of languages) {
		const grammar = LANGUAGE_TO_GRAMMAR[id];
		const blocked = grammarBlockReason(grammar);
		if (blocked) {
			console.log(
				JSON.stringify({
					grammar,
					language: id,
					status: "blocked",
					reason: blocked,
				}),
			);
			continue;
		}
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(import.meta.url), "--child", id],
			{
				encoding: "utf8",
				timeout: 120_000,
			},
		);
		let record;
		try {
			record = JSON.parse(result.stdout.trim().split("\n").at(-1));
		} catch {
			record = {
				grammar,
				language: id,
				status: "failed",
				reason:
					result.signal ?? result.error?.message ?? `exit ${result.status}`,
			};
		}
		console.log(JSON.stringify(record));
		if (record.status !== "ok") failures.push(id);
	}
	if (failures.length) {
		console.error(`grammar corpus failed: ${failures.join(", ")}`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
