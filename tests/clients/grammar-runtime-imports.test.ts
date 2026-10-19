/**
 * #3996: a grammar wasm may import a symbol web-tree-sitter's main module does
 * not export. Loading succeeds (the loader hands the grammar a stub), and the
 * first parse that reaches the call throws `TypeError: resolved is not a
 * function` out of wasm. The tree-sitter-wasms@0.1.13 bash wasm imported
 * `isalpha`; every `[ a == b ]` threw, and the parser stayed dead. This sweep
 * reads each shipped grammar's import section and the runtime's export section
 * and reds on any function import the runtime cannot resolve. It needs no
 * parse, so it covers constructs no fixture thought of.
 *
 * Population: every `*.wasm` in `vendor/grammars/`, the bundled `grammars/` and
 * the lazily fetched `web-tree-sitter/grammars/`, one per name in that order. A grammar absent on this
 * machine (not fetched yet) is not scanned; the floor below keeps an empty
 * population from passing, and the visible count is asserted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ADMITTED_UNRESOLVED_IMPORTS,
	grammarWasmFiles,
	runtimeExports,
	unresolvedImports,
} from "../../clients/grammar-wasm-imports.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/** A module with no body whose import section names `env.<name>` functions. */
function wasmImporting(names: string[]): Uint8Array {
	const text = (value: string) => [value.length, ...Buffer.from(value)];
	const imports = names.flatMap((name) => [
		...text("env"),
		...text(name),
		0,
		0,
	]);
	return Uint8Array.from([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		...[1, 4, 1, 0x60, 0, 0], // type section: one `() -> ()`
		...[2, imports.length + 1, names.length, ...imports], // import section
	]);
}

describe("shipped grammars import only symbols the runtime exports (#3996)", () => {
	const exported = runtimeExports();
	const files = [...grammarWasmFiles().values()];

	it("scans a non-empty grammar population including bash", () => {
		// Recurrence: a sweep over an empty directory passes vacuously.
		assertNonEmptyScan("shipped grammar wasm files", files.length, 12);
		expect(files.map((file) => path.basename(file))).toContain(
			"tree-sitter-bash.wasm",
		);
	});

	it("resolves every function import of every grammar, or admits it with a reason", () => {
		// Recurrence: #3996, tree-sitter-wasms@0.1.13 bash wasm importing
		// `isalpha`, which web-tree-sitter 0.25 does not export.
		const offenders = files.flatMap((file) =>
			unresolvedImports(fs.readFileSync(file), exported).map(
				(name) => `${path.basename(file)} imports ${name}`,
			),
		);

		expect(offenders).toEqual([]);
	});

	it("flags an unexported import and passes exported and admitted ones", () => {
		// Recurrence: #3996. The shared helper is what both this sweep and the
		// nightly guard call; a filter that stopped flagging `isalpha`, or one
		// that stopped admitting `abort`, must red here, not only on a real
		// grammar that happens to be fetched.
		// A bare export and an underscore-prefixed one (emscripten's C ABI spelling).
		expect(exported.has("malloc")).toBe(true);
		expect(exported.has("_emscripten_stack_restore")).toBe(true);
		expect(
			unresolvedImports(
				wasmImporting([
					"isalpha",
					"abort",
					"__assert_fail",
					"malloc",
					"emscripten_stack_restore",
				]),
				exported,
			),
		).toEqual(["isalpha"]);
		expect(Object.keys(ADMITTED_UNRESOLVED_IMPORTS).sort()).toEqual([
			"__assert_fail",
			"abort",
		]);
	});
});
