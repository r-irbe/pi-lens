/**
 * Introspection of grammar wasm imports against the web-tree-sitter runtime
 * (#3996). A grammar wasm may import a function the runtime's main module does
 * not export. Loading still succeeds (the loader hands the grammar a stub), and
 * the first parse that reaches the call throws `TypeError: resolved is not a
 * function` out of wasm. The one reader of this seam is the per-PR sweep
 * `tests/clients/grammar-runtime-imports.test.ts` and the nightly guard
 * `scripts/check-grammar-load.mjs`; both import it so the admitted list cannot
 * drift between them.
 *
 * Not imported by any production path: the runtime never needs it, so the
 * bundled `dist/` does not carry it.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getPackageRoot } from "./package-root.js";

const requireFromHere = createRequire(import.meta.url);

/**
 * Imports a grammar may name without the runtime exporting them. Each entry is
 * an admission with its reason: the call sits on an assertion or abort path
 * that already ends the parse, so an unresolved stub there changes nothing the
 * runtime was going to do. Reviewed per grammar when a grammar is bumped.
 */
export const ADMITTED_UNRESOLVED_IMPORTS: Readonly<Record<string, string>> = {
	__assert_fail: "C assert(): only reached after an invariant already broke",
	abort: "C abort(): the grammar ends the process deliberately",
};

// `WebAssembly` is a runtime global the build's `lib` does not declare.
interface WasmModuleHandle {
	readonly compiled?: never;
}
type WasmModuleApi = {
	new (bytes: Uint8Array): WasmModuleHandle;
	imports(
		module: WasmModuleHandle,
	): Array<{ module: string; name: string; kind: string }>;
	exports(module: WasmModuleHandle): Array<{ name: string; kind: string }>;
};
// SAFETY: every supported Node runtime defines `WebAssembly.Module` with the
// static `imports` / `exports` introspection calls; the cast names only those.
const wasm = (
	globalThis as unknown as { WebAssembly: { Module: WasmModuleApi } }
).WebAssembly;

function runtimeDir(): string {
	return dirname(requireFromHere.resolve("web-tree-sitter"));
}

/** Names the web-tree-sitter main module exports. */
export function runtimeExports(): Set<string> {
	const module = new wasm.Module(
		fs.readFileSync(join(runtimeDir(), "tree-sitter.wasm")),
	);
	return new Set(wasm.Module.exports(module).map((entry) => entry.name));
}

/**
 * Function imports from `env` that the runtime neither exports nor
 * {@link ADMITTED_UNRESOLVED_IMPORTS} admits.
 */
export function unresolvedImports(
	wasmBytes: Uint8Array,
	exported: ReadonlySet<string>,
): string[] {
	const unresolved: string[] = [];
	for (const { kind, module, name } of wasm.Module.imports(
		new wasm.Module(wasmBytes),
	)) {
		if (kind !== "function" || module !== "env") continue;
		if (exported.has(name) || exported.has(`_${name}`)) continue;
		if (Object.hasOwn(ADMITTED_UNRESOLVED_IMPORTS, name)) continue;
		unresolved.push(name);
	}
	return unresolved;
}

/**
 * One file per grammar name, first directory wins: the order the client
 * resolves them in (`TreeSitterClient.grammarSourceDirs`), so a stale shadowed
 * copy is not scanned in place of the one a parse would load.
 */
export function grammarWasmFiles(): Map<string, string> {
	const root = getPackageRoot(import.meta.url);
	const byName = new Map<string, string>();
	for (const dir of [
		join(root, "vendor", "grammars"),
		join(root, "grammars"),
		join(runtimeDir(), "grammars"),
	]) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(".wasm") && !byName.has(name)) {
				byName.set(name, join(dir, name));
			}
		}
	}
	return byName;
}
