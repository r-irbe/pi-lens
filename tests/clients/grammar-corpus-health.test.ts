/**
 * Hermetic half of the grammar health corpus (#4012). The real parse of every
 * grammar runs only in the nightly (`scripts/check-grammar-corpus.mjs`,
 * `.github/workflows/grammar-health.yml`); the per-PR lane checks that the
 * corpus itself is complete and shaped to reach the constructs that broke a
 * grammar before. It loads no wasm and uses no network. That the fixtures are
 * tracked is checked beside the gitignore rules, in
 * `tests/config/gitignore-tracked-shadow.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_TO_GRAMMAR } from "../../clients/grammar-source.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const CORPUS = resolve(import.meta.dirname, "../fixtures/grammar-health");

/** Language id -> fixture file in the working tree. That every id is also
 * tracked is `tests/config/gitignore-tracked-shadow.test.ts`: a directory read
 * cannot tell a tracked file from an ignored one. */
function corpusFiles(): Map<string, string> {
	return new Map(
		readdirSync(CORPUS).map((name) => [
			name.slice(0, name.indexOf(".")),
			join(CORPUS, name),
		]),
	);
}

describe("grammar health corpus is complete and multi-construct (#4012)", () => {
	const corpus = corpusFiles();
	const languages = Object.keys(LANGUAGE_TO_GRAMMAR).sort();

	it("scans a non-empty corpus", () => {
		assertNonEmptyScan("grammar corpus fixtures", corpus.size, 20);
	});

	it("has a fixture for every LANGUAGE_TO_GRAMMAR key", () => {
		// Recurrence: the nightly reports `missing-corpus` for a language with no
		// fixture; a new registry key must bring its corpus file.
		expect(languages.filter((language) => !corpus.has(language))).toEqual([]);
	});

	it("has no fixture for a language the registry lacks", () => {
		// Recurrence: a renamed or removed grammar leaves a fixture nothing parses.
		expect(
			[...corpus.keys()].filter((id) => !(id in LANGUAGE_TO_GRAMMAR)),
		).toEqual([]);
	});

	it("keeps every fixture a multi-construct file, not a one-liner", () => {
		// Recurrence: #3996 (and PR #4093 r1 HIGH-2): the corpus held one-line
		// `answer = 42` entries that never reached the construct that threw, so
		// the planted isalpha bash grammar still reported ok.
		const thin = [...corpus]
			.filter(
				([, file]) =>
					readFileSync(file, "utf8")
						.split("\n")
						.filter((line) => line.trim() !== "").length < 6,
			)
			.map(([language]) => language);
		expect(thin).toEqual([]);
	});

	it("keeps the bash fixture on the test-command construct #3996 threw on", () => {
		// Recurrence: #3996, the tree-sitter-wasms@0.1.13 bash wasm threw on every
		// `[ a == b ]` and `[[ a != b ]]`.
		const bash = readFileSync(corpus.get("bash")!, "utf8");
		expect(bash).toContain("[ a == b ]");
		expect(bash).toContain("[[ a != b ]]");
	});
});
