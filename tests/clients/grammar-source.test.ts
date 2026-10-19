import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	BLOCKED_GRAMMARS,
	GRAMMAR_FILES,
	GRAMMAR_SOURCE_OVERRIDES,
	grammarBlockReason,
	type GrammarRuntime,
	grammarSourceUrl,
	LANGUAGE_TO_GRAMMAR,
	TREE_SITTER_WASMS_VERSION,
} from "../../clients/grammar-source.js";

// The postinstall pre-fetch (scripts/download-grammars.js) runs before the TS
// build, so it can't import the compiled grammar-source — it mirrors the version
// + grammar list. Read it as text (don't import: it would run main()/fetch) and
// guard against silent drift between the two.
const scriptSrc = readFileSync(
	path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../scripts/download-grammars.js",
	),
	"utf8",
);
const scriptVersion = scriptSrc.match(
	/TREE_SITTER_WASMS_VERSION\s*=\s*["']([0-9.]+)["']/,
)?.[1];
const scriptGrammars = [
	...new Set(
		[...scriptSrc.matchAll(/"(tree-sitter-[a-z0-9_]+\.wasm)"/g)].map(
			(m) => m[1],
		),
	),
];

// #1564 G1: scripts/grammars.lock.json pins the sha256 the runtime path now
// verifies downloads against (grammar-source.ts's downloadGrammarDetailed).
// A TREE_SITTER_WASMS_VERSION bump without re-running
// `download-grammars.ts --write-manifest` leaves the lock holding the OLD
// release's hashes, silently — the type checker can't catch a stale JSON
// literal, and `npm test` was fully green on that exact mutation (31/31):
// every runtime download of the NEW release would then sha-mismatch against
// the stale pinned hash and retry forever, bricking every lazy-fetched
// grammar for pnpm/bun users (who skip the postinstall that regenerates the
// bundled core set).
const lockManifest = JSON.parse(
	readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../scripts/grammars.lock.json",
		),
		"utf8",
	),
) as { package: string; version: string; overrides?: OverrideTable };

type OverrideTable = Record<
	string,
	{ package: string; version: string; url: string }
>;

/**
 * Parse the `SOURCE_OVERRIDES` object literal out of a download-grammars
 * source file (.ts or .js) as text: importing the .ts would not exercise the
 * .js twin, and each file is one literal of the same shape. Whole-line and
 * block comments are dropped first so a commented-out row cannot satisfy
 * the parity check.
 */
function readScriptOverrides(file: string): OverrideTable {
	const src = readFileSync(
		path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../scripts",
			file,
		),
		"utf8",
	);
	const start = src.search(/export const SOURCE_OVERRIDES\b[^=]*=\s*\{/);
	if (start < 0) throw new Error(`${file}: SOURCE_OVERRIDES literal not found`);
	const body = src
		.slice(start)
		.split(/\n\};/)[0]
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	const out: OverrideTable = {};
	for (const m of body.matchAll(
		/"(tree-sitter-[a-z0-9_]+\.wasm)":\s*\{\s*package:\s*"([^"]+)",\s*version:\s*"([^"]+)",\s*url:\s*"([^"]+)",?\s*\}/g,
	)) {
		out[m[1]] = { package: m[2], version: m[3], url: m[4] };
	}
	return out;
}

describe("grammar-source ↔ download-grammars stay in sync", () => {
	it("pins the same tree-sitter-wasms version", () => {
		expect(scriptVersion).toBe(TREE_SITTER_WASMS_VERSION);
	});

	it("pins scripts/grammars.lock.json to the same release the runtime downloads (#1564 G1)", () => {
		expect(lockManifest.version).toBe(TREE_SITTER_WASMS_VERSION);
		expect(lockManifest.package).toBe("tree-sitter-wasms");
	});

	it("downloads exactly the grammars the runtime maps", () => {
		expect(scriptGrammars.sort()).toEqual([...GRAMMAR_FILES].sort());
	});

	it("GRAMMAR_FILES is the deduped value set of LANGUAGE_TO_GRAMMAR", () => {
		expect([...GRAMMAR_FILES].sort()).toEqual(
			[...new Set(Object.values(LANGUAGE_TO_GRAMMAR))].sort(),
		);
	});

	it("mirrors the same source overrides in download-grammars.js", () => {
		for (const o of Object.values(GRAMMAR_SOURCE_OVERRIDES)) {
			// The mirror lists each override's url (which embeds package + version).
			expect(scriptSrc).toContain(o.url);
			expect(o.url).toContain(o.version);
		}
	});

	// Recurrence: #3996 added the bash override in all four places by hand; the
	// mirror test above walks only runtime -> .js by URL, so deleting a row from
	// clients/grammar-source.ts alone (or from the .ts/.lock) reddened nothing but
	// the glossary version pin. The override set is declared in four places that
	// the postinstall (.js), the runtime (clients), the manifest writer (.ts) and
	// the integrity lock must agree on, key for key.
	it("declares every source override identically in grammar-source.ts, download-grammars.ts/.js and grammars.lock.json (#3996)", () => {
		const sources: Record<string, OverrideTable> = {
			"clients/grammar-source.ts GRAMMAR_SOURCE_OVERRIDES":
				GRAMMAR_SOURCE_OVERRIDES,
			"scripts/download-grammars.ts SOURCE_OVERRIDES": readScriptOverrides(
				"download-grammars.ts",
			),
			"scripts/download-grammars.js SOURCE_OVERRIDES": readScriptOverrides(
				"download-grammars.js",
			),
			"scripts/grammars.lock.json overrides": lockManifest.overrides ?? {},
		};
		// The union of keys is the expected set, so a row dropped from any one
		// place is named instead of silently shrinking the comparison.
		const union = [
			...new Set(Object.values(sources).flatMap((t) => Object.keys(t))),
		].sort();
		expect(union.length).toBeGreaterThan(0);
		for (const [label, table] of Object.entries(sources)) {
			const missing = union.filter((k) => !(k in table));
			expect(
				missing,
				`${label} is missing override row(s) ${missing.join(", ")} that another source declares`,
			).toEqual([]);
		}
		const reference = GRAMMAR_SOURCE_OVERRIDES;
		for (const [label, table] of Object.entries(sources)) {
			for (const k of union) {
				expect(
					table[k],
					`${label} row ${k} differs from clients/grammar-source.ts (package/version/url)`,
				).toEqual(reference[k]);
			}
		}
	});
});

describe("GRAMMAR_SOURCE_OVERRIDES (#255)", () => {
	it("routes lua to the @tree-sitter-grammars build, not the aggregator", () => {
		const o = GRAMMAR_SOURCE_OVERRIDES["tree-sitter-lua.wasm"];
		expect(o?.package).toBe("@tree-sitter-grammars/tree-sitter-lua");
		const url = grammarSourceUrl("tree-sitter-lua.wasm");
		expect(url).toBe(o?.url);
		expect(url).not.toContain("tree-sitter-wasms");
	});

	it("leaves non-overridden grammars on the aggregator CDN", () => {
		const url = grammarSourceUrl("tree-sitter-python.wasm");
		expect(url).toContain(`tree-sitter-wasms@${TREE_SITTER_WASMS_VERSION}`);
		expect(url).toContain("tree-sitter-python.wasm");
	});
});

describe("BLOCKED_GRAMMARS runtime guard (#432)", () => {
	const rt = (over: Partial<GrammarRuntime> = {}): GrammarRuntime => ({
		nodeMajor: 24,
		isV8: true,
		platform: "linux",
		...over,
	});

	afterEach(() => {
		delete process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD;
	});

	it("blocks swift on V8 + Node >= 24 (all platforms)", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(
				grammarBlockReason("tree-sitter-swift.wasm", rt({ platform })),
			).toMatch(/crashes the runtime/);
		}
	});

	it("does NOT block swift on Node <= 22", () => {
		expect(
			grammarBlockReason("tree-sitter-swift.wasm", rt({ nodeMajor: 22 })),
		).toBeNull();
	});

	it("does NOT block swift under bun / non-V8 (JavaScriptCore)", () => {
		expect(
			grammarBlockReason("tree-sitter-swift.wasm", rt({ isV8: false })),
		).toBeNull();
	});

	it("does not block a normal grammar", () => {
		expect(grammarBlockReason("tree-sitter-typescript.wasm", rt())).toBeNull();
	});

	it("PILENS_UNSAFE_FORCE_GRAMMAR_LOAD bypasses the block (probe hatch)", () => {
		expect(grammarBlockReason("tree-sitter-swift.wasm", rt())).not.toBeNull();
		process.env.PILENS_UNSAFE_FORCE_GRAMMAR_LOAD = "1";
		expect(grammarBlockReason("tree-sitter-swift.wasm", rt())).toBeNull();
	});

	it("swift is the only currently-blocked grammar", () => {
		expect(Object.keys(BLOCKED_GRAMMARS)).toEqual(["tree-sitter-swift.wasm"]);
	});
});
