/**
 * Governance: a test never reads a log sink before draining it (#4381).
 *
 * Every pi-lens log sink is a `createNdjsonLogger` writer: `log`/`append` only
 * ENQUEUE, and the queue drains through `fs.promises.appendFile`
 * (`clients/ndjson-logger.ts`). A test that takes a byte offset or a line
 * count of the sink file while one of its own writes is still queued counts
 * those late bytes on the wrong side of its window. #4381 is the third time:
 * `config-resolved-phase.test.ts` loaded config (two sessionstart lines
 * enqueued), then took `statSync(SESSIONSTART_LOG_FILE).size` with no
 * `flushSessionStartLog()`, and master run 38515888889 read "expected 0
 * lines, got 2". Earlier members of the class: #3682 (PR #3720), #3721 (PR
 * #3892), #3193. AGENTS.md "Data directories and logs" states the rule
 * ("Flush the specific logger before reading its file"); this sweep makes it
 * a check.
 *
 * The rule, per read: every `stat` / `statSync` / `lstat` / `lstatSync` /
 * `open` / `openSync` / `readFileSync` / `readFile` / `createReadStream` call
 * in `tests/**` whose first argument names an in-process sink needs a drain
 * OF THAT SINK before it, with no other `await` between the drain and the
 * read (an await lets the code under test enqueue more). A drain is the sink
 * module's own `flush*` export (awaited, or a `*Sync` variant),
 * `flushAllNdjsonWriters()`, or an awaited call to a local helper whose body
 * ends drained. A drain counts only where it DOMINATES the read: it must run
 * unconditionally in a block that encloses the read and lies inside the
 * read's scope. A drain under an `if`, a ternary, a `&&`/`||`/`??` operand, a
 * loop, a `catch`, or an inner function does not count; one in a `try` body
 * with no `catch` does (a throw before it skips the read). The scope is the
 * nearest enclosing function that is a declaration, a method, or a test/hook
 * callback; inline callbacks (`.map(...)`, `withHome(() => ...)`) are
 * transparent. A read inside a local helper with no drain of its own is
 * drained when every call site of the helper is.
 *
 * Detectors match code, not prose (#4381 acceptance; principles §2):
 * - The DRAIN needles run over `stripSource` text with strings and comments
 *   blanked, so a comment or string naming `flushSessionStartLog()` cannot
 *   satisfy a read (the self-excuse direction).
 * - The SINK needles are of two kinds. Exported path symbols
 *   (`SESSIONSTART_LOG_FILE`, `getLatencyLogPath()`) and local aliases of
 *   them match blanked text. Basename literals (`"latency.log"`) are string
 *   evidence by nature, so that one needle reads the comment-blanked,
 *   string-kept text, and counts only when the same expression names an
 *   in-process log root (`LOG_ROOT_SYMBOLS`): a comment naming a sink file
 *   creates no requirement, and a child process's `path.join(childHome,
 *   "latency.log")` is not an in-process sink.
 *
 * Both populations are DERIVED, not listed: the sink modules are every
 * `clients/` file that calls `createNdjsonLogger(` in code, and their path
 * symbols, flush exports, and basenames are read from those modules. A new
 * sink joins the sweep without an edit here (AGENTS.md shape 34).
 *
 * Known limits, named (all false negatives):
 * - A read whose path reaches the sink through a function parameter, a value
 *   computed in another module, or a directory a `vi.doMock` redirected
 *   (`tests/clients/lsp/launch.test.ts`) is invisible.
 * - Path shapes the needles do not see: a shell read (`wc -l ${file}`), a
 *   template or concatenated path (`${dir}/latency.log`, `dir +
 *   "/latency.log"`), a basename held in a variable, a root held in any
 *   variable that is not an alias of `LOG_ROOT_SYMBOLS`, and
 *   `fstatSync(fd)` on a descriptor opened elsewhere.
 * - Sinks with no path evidence. `clients/diagnostic-logger.ts` exports no
 *   path symbol, no `flush*`, and builds a dated file name, so no read of it
 *   can match: it is pinned in `BLIND_SINKS`, and a new blind sink reds the
 *   "every blind sink is named" case. Seven sinks are basename-only with no
 *   flush export (actionable-warnings, ast-grep-tools, bus-events, cascade,
 *   dead-code, dispositions, word-index): a read is seen only through a
 *   quoted basename under a recognised root, and only `flushAllNdjsonWriters`
 *   drains them.
 * - A synchronous write between the drain and the read is not modelled. It
 *   cannot flake: its append needs a loop turn, so the read never sees it
 *   and a test that depends on it reds every run.
 * - A reader helper passed by reference (not called) has no call sites to
 *   check, so it is judged on its own body.
 * - Drain forms the matcher does not credit (loud false positives, not
 *   silent passes): `Promise.all([flush...()])`, a dynamic-import flush, and
 *   two drains in sequence before a read of the first sink (the second's
 *   await voids the first). `flushAllNdjsonWriters()` serves all three.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";

import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	readWalkedFile,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLIENTS_ROOT = path.join(REPO_ROOT, "clients");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const SELF = "tests/config/sink-read-drain-sweep.test.ts";

/** One in-process sink module and the evidence a test can name it by. */
interface SinkModule {
	module: string;
	/** Exported path constants/getters, e.g. `SESSIONSTART_LOG_FILE`. */
	pathSymbols: string[];
	/** Exported drains, e.g. `flushSessionStartLog`. */
	flushSymbols: string[];
	/** File basenames the module writes, e.g. `sessionstart.log`. */
	basenames: string[];
}

/** Drains every registered writer at once (`clients/ndjson-logger.ts`). */
const GLOBAL_DRAINS = ["flushAllNdjsonWriters"];

/**
 * The in-process log roots. A basename literal names an in-process sink only
 * when its path expression also names one of these (directly or through a
 * local alias); `path.join(childHome, "latency.log")` names a child process's
 * file, which no in-process flush can drain. Pinned against drift by the
 * "every sink module roots its path in LOG_ROOT_SYMBOLS" case below.
 */
/**
 * Sink modules with no path evidence at all: no exported path symbol and no
 * basename literal, so the sweep can match no read of them. Each is named
 * with its reason; the "every blind sink is named" case reds on a new one.
 */
const BLIND_SINKS: Record<string, string> = {
	"clients/diagnostic-logger.ts":
		"dated file name (logs/<date>.jsonl) and an instance `.flush()`; its one reader, tests/index-3190-inline-blocker-deleted-path-witness.test.ts, drains by hand",
};

const LOG_ROOT_SYMBOLS = [
	"getGlobalPiLensLogDir",
	"getGlobalPiLensDir",
	"PI_LENS_HOME",
];

const EXPORTED_NAME =
	/\bexport\s+(?:async\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/g;
const PATH_SYMBOL = /(?:_FILE|_PATH)$|^get\w*Path$/;
const FLUSH_SYMBOL = /^flush\w*$/;
const BASENAME_LITERAL = /["'`]([\w-][\w.-]*\.(?:log|jsonl))["'`]/g;

function sinkModuleFromSource(
	module: string,
	source: string,
): SinkModule | undefined {
	const blanked = stripSource(source);
	if (!/\bcreateNdjsonLogger\s*\(/.test(blanked)) return undefined;
	// The factory's own module defines it; it is not a sink.
	if (/\bfunction\s+createNdjsonLogger\b/.test(blanked)) return undefined;
	const exported = [...blanked.matchAll(EXPORTED_NAME)].map((m) => m[1]);
	const kept = stripSource(source, { strings: "keep" });
	return {
		module,
		pathSymbols: exported.filter((name) => PATH_SYMBOL.test(name)),
		flushSymbols: exported.filter((name) => FLUSH_SYMBOL.test(name)),
		basenames: [
			...new Set([...kept.matchAll(BASENAME_LITERAL)].map((m) => m[1])),
		],
	};
}

function discoverSinkModules(): Array<SinkModule & { source: string }> {
	const sinks: Array<SinkModule & { source: string }> = [];
	for (const absolute of listSourceFiles(CLIENTS_ROOT, {
		extensions: [".ts"],
		skipTests: true,
	})) {
		const source = fs.readFileSync(absolute, "utf8");
		const sink = sinkModuleFromSource(
			relativePosix(REPO_ROOT, absolute),
			source,
		);
		if (sink) sinks.push({ ...sink, source });
	}
	return sinks;
}

/** One sink read with no drain of its sink before it. */
interface UndrainedRead {
	line: number;
	callee: string;
	sinks: string[];
	text: string;
	/** Lines of the undrained call sites, when the read sits in a local helper. */
	undrainedCallers: number[];
}

// `open`/`openSync` count because `fstatSync(fd).size` carries no path: the
// open of the sink is where its offset is taken.
const READ_CALLEES = new Set([
	"stat",
	"statSync",
	"lstat",
	"lstatSync",
	"open",
	"openSync",
	"readFileSync",
	"readFile",
	"createReadStream",
]);
const SCOPE_CALLEES = new Set([
	"it",
	"test",
	"describe",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
]);
const FUNCTION_KINDS = [
	"arrow_function",
	"function_expression",
	"function_declaration",
	"generator_function_declaration",
	"method_definition",
];
const CALLER_DEPTH = 3;

function calleeName(call: SgNode): string | undefined {
	const fn = call.field("function");
	if (fn?.kind() === "identifier") return fn.text();
	if (fn?.kind() === "member_expression") {
		const object = fn.field("object");
		// `it.each(...)`, `it.skipIf(...)`: the scope callee is the object.
		const objectName = object?.kind() === "identifier" ? object.text() : "";
		if (SCOPE_CALLEES.has(objectName)) return objectName;
		return fn.field("property")?.text();
	}
	if (fn?.kind() === "call_expression") return calleeName(fn);
	return undefined;
}

function isFunction(node: SgNode): boolean {
	return FUNCTION_KINDS.includes(String(node.kind()));
}

/**
 * The nearest enclosing function that owns a drain-ordering scope: a
 * declaration, a method, or a test/hook callback. A callback passed to any
 * other call (`.map`, `waitFor`, `withHome`) runs inside its caller's
 * ordering, so it is transparent.
 */
function scopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current) {
		if (isFunction(current)) {
			const parent = current.parent();
			const call = parent?.kind() === "arguments" ? parent.parent() : null;
			const transparent =
				call?.kind() === "call_expression" &&
				!SCOPE_CALLEES.has(calleeName(call) ?? "");
			if (!transparent) return current;
		}
		current = current.parent();
	}
	return undefined;
}

/** The nearest enclosing function of any kind: a binding's lexical scope. */
function lexicalScopeOf(node: SgNode): SgNode | undefined {
	let current = node.parent();
	while (current && !isFunction(current)) current = current.parent();
	return current ?? undefined;
}

/** The name a function is called by, when it is a local helper. */
function declaredName(fn: SgNode): string | undefined {
	if (fn.kind() !== "arrow_function" && fn.kind() !== "function_expression") {
		return fn.field("name")?.text();
	}
	const parent = fn.parent();
	if (parent?.kind() !== "variable_declarator") return undefined;
	const name = parent.field("name");
	return name?.kind() === "identifier" ? name.text() : undefined;
}

/**
 * Kinds a drain may not sit under on its way up to its block: under any of
 * them it runs conditionally, late, or never (state table D3, D4, D5).
 */
const CONDITIONAL_KINDS = new Set([
	...FUNCTION_KINDS,
	"if_statement",
	"else_clause",
	"ternary_expression",
	"switch_case",
	"switch_default",
	"for_statement",
	"for_in_statement",
	"while_statement",
	"do_statement",
	"catch_clause",
	"finally_clause",
]);
const SHORT_CIRCUIT = /^(?:&&|\|\||\?\?)$/;

/** A call that can drain: awaited, or a `*Sync` call that needs no await. */
interface DrainCall {
	name: string;
	/** The block it runs in unconditionally, or undefined (see drainBlock). */
	block: SgNode | undefined;
	end: number;
}

/** Every awaited or `*Sync` call in `calls`, with its name and drain block. */
function drainCalls(calls: readonly SgNode[]): DrainCall[] {
	const out: DrainCall[] = [];
	for (const call of calls) {
		const fn = call.field("function");
		const name =
			fn?.kind() === "identifier"
				? fn.text()
				: fn?.kind() === "member_expression"
					? fn.field("property")?.text()
					: undefined;
		if (!name) continue;
		if (!name.endsWith("Sync") && call.parent()?.kind() !== "await_expression")
			continue;
		out.push({ name, block: drainBlock(call), end: call.range().end.index });
	}
	return out;
}

/**
 * The block a drain call runs in unconditionally: the nearest enclosing
 * `statement_block` (or the program), reached without passing a condition, a
 * loop, a short-circuit operand, or a function boundary. `undefined` when
 * the drain is conditional or nested (state table D3, D4).
 */
function drainBlock(call: SgNode): SgNode | undefined {
	let node = call;
	for (;;) {
		const parent = node.parent();
		if (!parent) return undefined;
		const kind = String(parent.kind());
		// A `try` body with no `catch` dominates the code after the try: if it
		// throws before the drain, the finally rethrows and the read never runs
		// (D7). A `catch` can swallow that throw, so its body does not (D8).
		const owner = parent.parent();
		if (
			kind === "statement_block" &&
			owner?.kind() === "try_statement" &&
			owner.field("body")?.range().start.index === parent.range().start.index &&
			!owner.field("handler")
		) {
			node = owner;
			continue;
		}
		if (kind === "statement_block" || kind === "program") return parent;
		if (CONDITIONAL_KINDS.has(kind)) return undefined;
		if (
			kind === "binary_expression" &&
			SHORT_CIRCUIT.test(parent.field("operator")?.text() ?? "")
		)
			return undefined;
		node = parent;
	}
}

const within = (inner: SgNode, outer: SgNode): boolean =>
	outer.range().start.index <= inner.range().start.index &&
	inner.range().end.index <= outer.range().end.index;

const nameNeedle = (name: string, member: boolean): RegExp =>
	new RegExp(`${member ? "\\b" : "(?<![\\w$.])"}${escapeRegExp(name)}\\b`);

interface Binding {
	name: string;
	start: number;
	end: number;
	owners: ReadonlySet<string>;
}

function scanUndrainedSinkReads(
	source: string,
	sinks: readonly SinkModule[],
): UndrainedRead[] {
	const blanked = stripSource(source);
	const kept = stripSource(source, { strings: "keep" });
	const symbolOwner = new Map<string, string>();
	const basenameOwner = new Map<string, string>();
	for (const sink of sinks) {
		for (const symbol of sink.pathSymbols) symbolOwner.set(symbol, sink.module);
		for (const base of sink.basenames) basenameOwner.set(base, sink.module);
	}
	const literalNeedle = (base: string): RegExp =>
		new RegExp(`["'\`]${escapeRegExp(base)}["'\`]`);
	// Cheap admission on code text: no sink named, nothing to parse.
	if (
		![...symbolOwner.keys()].some((s) => nameNeedle(s, true).test(blanked)) &&
		![...basenameOwner.keys()].some((b) => literalNeedle(b).test(kept))
	) {
		return [];
	}

	const root = parse(Lang.TypeScript, source).root();
	const sinkAliases: Binding[] = [];
	const rootAliases: Binding[] = [];
	const visible = (
		bindings: Binding[],
		start: number,
		end: number,
	): Binding[] =>
		bindings.filter(
			(b) =>
				b.start <= start &&
				end <= b.end &&
				nameNeedle(b.name, false).test(blanked.slice(start, end)),
		);
	const namesRoot = (start: number, end: number): boolean =>
		LOG_ROOT_SYMBOLS.some((s) =>
			nameNeedle(s, true).test(blanked.slice(start, end)),
		) || visible(rootAliases, start, end).length > 0;
	const sinksIn = (start: number, end: number): Set<string> => {
		const owners = new Set<string>();
		const code = blanked.slice(start, end);
		for (const [symbol, owner] of symbolOwner) {
			if (nameNeedle(symbol, true).test(code)) owners.add(owner);
		}
		for (const alias of visible(sinkAliases, start, end)) {
			for (const owner of alias.owners) owners.add(owner);
		}
		const literal = kept.slice(start, end);
		for (const [base, owner] of basenameOwner) {
			if (literalNeedle(base).test(literal) && namesRoot(start, end)) {
				owners.add(owner);
			}
		}
		return owners;
	};
	const readsInside = (node: SgNode): boolean =>
		node
			.findAll({ rule: { kind: "call_expression" } })
			.some((call) => READ_CALLEES.has(calleeName(call) ?? ""));
	const bind = (
		into: Binding[],
		name: string,
		at: SgNode,
		owners: ReadonlySet<string>,
	): void => {
		const scope = lexicalScopeOf(at);
		const start = scope?.range().start.index ?? 0;
		const end = scope?.range().end.index ?? source.length;
		if (!into.some((b) => b.name === name && b.start === start)) {
			into.push({ name, start, end, owners });
		}
	};

	// Path aliases, lexically scoped: `const file = getLatencyLogPath()`,
	// `const dir = getGlobalPiLensLogDir()`, `const logFile = () =>
	// path.join(dir, "latency.log")`, `function logPath() { return ...; }`.
	const declarators = root.findAll({ rule: { kind: "variable_declarator" } });
	const functionDecls = root.findAll({
		rule: { kind: "function_declaration" },
	});
	for (let pass = 0; pass < 3; pass++) {
		for (const decl of declarators) {
			const name = decl.field("name");
			const value = decl.field("value");
			if (name?.kind() !== "identifier" || !value || readsInside(value))
				continue;
			const start = value.range().start.index;
			const end = value.range().end.index;
			const owners = sinksIn(start, end);
			if (owners.size > 0) bind(sinkAliases, name.text(), decl, owners);
			else if (namesRoot(start, end))
				bind(rootAliases, name.text(), decl, new Set());
		}
		for (const fn of functionDecls) {
			const name = fn.field("name")?.text();
			if (!name) continue;
			const owners = new Set<string>();
			for (const ret of fn.findAll({ rule: { kind: "return_statement" } })) {
				if (readsInside(ret)) continue;
				const range = ret.range();
				for (const owner of sinksIn(range.start.index, range.end.index)) {
					owners.add(owner);
				}
			}
			if (owners.size > 0) bind(sinkAliases, name, fn, owners);
		}
	}

	// Drains per sink: its flush exports, the global drain, and every local
	// helper whose body ends drained (`await configResolvedRows()`): a drain
	// that is a direct statement of the helper's body, with no await after it
	// (state table D11, D12).
	const drainNames = new Map<string, string[]>();
	for (const sink of sinks) {
		drainNames.set(sink.module, [...sink.flushSymbols, ...GLOBAL_DRAINS]);
	}
	const calls = root.findAll({ rule: { kind: "call_expression" } });
	const drains = drainCalls(calls);
	const bodies: Array<{ name: string; start: number; end: number }> = [];
	for (const fn of root.findAll({
		rule: { any: FUNCTION_KINDS.map((kind) => ({ kind })) },
	})) {
		const name = declaredName(fn);
		const body = fn.field("body");
		if (!name || body?.kind() !== "statement_block") continue;
		bodies.push({
			name,
			start: body.range().start.index,
			end: body.range().end.index,
		});
	}
	for (let pass = 0; pass < 3; pass++) {
		for (const body of bodies) {
			for (const names of drainNames.values()) {
				if (names.includes(body.name)) continue;
				const last = drains
					.filter(
						(drain) =>
							names.includes(drain.name) &&
							drain.block?.range().start.index === body.start,
					)
					.at(-1);
				if (!last) continue;
				const after = blanked.slice(last.end, body.end);
				if (!/\bawait\b/.test(after)) names.push(body.name);
			}
		}
	}

	const callsTo = (name: string, inside: SgNode): SgNode[] => {
		const start = inside.range().start.index;
		const end = inside.range().end.index;
		return calls.filter((call) => {
			const fn = call.field("function");
			const at = call.range().start.index;
			return (
				fn?.kind() === "identifier" &&
				fn.text() === name &&
				!(start <= at && at < end)
			);
		});
	};

	/**
	 * Drained at `node` for `owner`: the last credited drain of that sink
	 * precedes it with no other `await` in between (any await lets the code
	 * under test enqueue more). A drain is credited when the block it runs in
	 * unconditionally encloses `node` and lies inside `node`'s scope (state
	 * table D1, D2). With no credited drain, a local helper is drained when
	 * every call site of it is (D13).
	 */
	const undrainedAt = (
		node: SgNode,
		owner: string,
		depth: number,
	): number[] => {
		const scope = scopeOf(node);
		const names = drainNames.get(owner) ?? GLOBAL_DRAINS;
		const line = node.range().start.line + 1;
		const at = node.range().start.index;
		const last = drains
			.filter(
				({ name, block, end }) =>
					end <= at &&
					names.includes(name) &&
					block !== undefined &&
					within(node, block) &&
					(scope === undefined || within(block, scope)),
			)
			.at(-1);
		if (last) {
			const gap = blanked.slice(last.end, at).replace(/\bawait\s*$/, "");
			return /\bawait\b/.test(gap) ? [line] : [];
		}
		const helper = scope ? declaredName(scope) : undefined;
		if (!scope || !helper || depth >= CALLER_DEPTH) return [line];
		const sites = callsTo(helper, scope);
		if (sites.length === 0) return [line];
		return sites.flatMap((site) => undrainedAt(site, owner, depth + 1));
	};

	const hits: UndrainedRead[] = [];
	const lines = source.split("\n");
	for (const call of calls) {
		const callee = calleeName(call);
		if (!callee || !READ_CALLEES.has(callee)) continue;
		const first = call.field("arguments")?.namedChildren()[0];
		if (!first) continue;
		const owners = sinksIn(first.range().start.index, first.range().end.index);
		const undrained: string[] = [];
		const callers = new Set<number>();
		const line = call.range().start.line + 1;
		for (const owner of owners) {
			const at = undrainedAt(call, owner, 0);
			if (at.length === 0) continue;
			undrained.push(owner);
			for (const site of at) if (site !== line) callers.add(site);
		}
		if (undrained.length === 0) continue;
		hits.push({
			line,
			callee,
			sinks: undrained.sort(),
			text: lines[line - 1]?.trim() ?? "",
			undrainedCallers: [...callers].sort((a, b) => a - b),
		});
	}
	return hits;
}

/** Fixture sinks: the shape of the two real modules #4381 involves. */
const FIXTURE_SINKS: SinkModule[] = [
	{
		module: "clients/sessionstart-logger.ts",
		pathSymbols: ["SESSIONSTART_LOG_FILE"],
		flushSymbols: ["flushSessionStartLog", "flushSessionStartLogSync"],
		basenames: ["sessionstart.log"],
	},
	{
		module: "clients/latency-logger.ts",
		pathSymbols: ["getLatencyLogPath"],
		flushSymbols: ["flushLatencyLog"],
		basenames: ["latency.log"],
	},
];

const scanFixture = (source: string): UndrainedRead[] =>
	scanUndrainedSinkReads(source, FIXTURE_SINKS);

describe("sink reads drain first (#4381)", () => {
	// Recurrence: #4381 (master run 38515888889), after #3682, #3721 and #3193.
	it("no test reads an in-process log sink before draining it", () => {
		const sinks = discoverSinkModules();
		// Dead-scan floors (sweep-kit, #1718): the sink discovery and the tree
		// walk each have to find something before an empty result means clean.
		assertNonEmptyScan("ndjson sink modules", sinks.length, 10);
		const files = listSourceFiles(TESTS_ROOT, {
			extensions: [".ts"],
			exclude: (rel) => rel.startsWith("fixtures/"),
		});
		assertNonEmptyScan("tests/ source files", files.length, 1000);
		const violations: string[] = [];
		let sinkFiles = 0;
		for (const absolute of files) {
			const rel = relativePosix(REPO_ROOT, absolute);
			if (rel === SELF) continue;
			const source = readWalkedFile(absolute);
			if (source === undefined) continue;
			if (
				sinks.some((sink) => sink.pathSymbols.some((s) => source.includes(s)))
			)
				sinkFiles += 1;
			for (const hit of scanUndrainedSinkReads(source, sinks)) {
				const callers = hit.undrainedCallers.length
					? ` (undrained call sites: ${hit.undrainedCallers.map((line) => `:${line}`).join(", ")})`
					: "";
				violations.push(
					`${rel}:${hit.line} ${hit.callee} of ${hit.sinks.join(", ")}${callers}: ${hit.text}`,
				);
			}
		}
		assertNonEmptyScan("test files naming a sink path symbol", sinkFiles, 20);
		expect(
			violations,
			"a test reads a log sink while its own writes may still be queued (#4381). " +
				"Await the sink's flush (flushSessionStartLog, flushLatencyLog, ..., or " +
				"flushAllNdjsonWriters) in the same scope right before the read, with no " +
				"other await in between, or inside the helper that reads. " +
				"Promise.all([flush...]), a dynamic-import flush, and sequential drains " +
				"are not recognised; use flushAllNdjsonWriters().",
		).toEqual([]);
	}, 120_000);

	it("every sink module roots its path in LOG_ROOT_SYMBOLS (drift pin)", () => {
		// A sink that moves to another root would make the basename evidence
		// above silently stop matching its in-process reads.
		const unrooted = discoverSinkModules()
			.filter(
				({ source }) =>
					!LOG_ROOT_SYMBOLS.some((symbol) =>
						nameNeedle(symbol, true).test(stripSource(source)),
					),
			)
			.map(({ module }) => module);
		expect(unrooted).toEqual([]);
	});

	it("every blind sink is named (no path symbol, no basename)", () => {
		// Recurrence: review r1 of #4384 F1. diagnostic-logger.ts matched
		// nothing, the drift pin above still passed, and its one undrained
		// offset read (index-3190 witness) was in neither sweep table.
		const blind = discoverSinkModules()
			.filter((s) => s.pathSymbols.length === 0 && s.basenames.length === 0)
			.map(({ module }) => module)
			.sort();
		expect(blind).toEqual(Object.keys(BLIND_SINKS).sort());
	});

	describe("sink discovery", () => {
		it("reads path symbols, drains and basenames from a sink module", () => {
			const sink = sinkModuleFromSource(
				"clients/x-logger.ts",
				[
					'const X_LOG_FILE = path.join(getGlobalPiLensLogDir(), "x.log");',
					"const writer = createNdjsonLogger({ filePath: X_LOG_FILE });",
					"export function getXLogPath(): string { return X_LOG_FILE; }",
					"export function flushXLog(): Promise<void> { return writer.flush(); }",
					"export function logX(): void {}",
				].join("\n"),
			);
			expect(sink).toEqual({
				module: "clients/x-logger.ts",
				pathSymbols: ["getXLogPath"],
				flushSymbols: ["flushXLog"],
				basenames: ["x.log"],
			});
		});

		it("a module naming the factory only in a comment or string is no sink", () => {
			expect(
				sinkModuleFromSource(
					"clients/y.ts",
					'// createNdjsonLogger({ filePath })\nconst s = "createNdjsonLogger(";',
				),
			).toBeUndefined();
		});
	});

	describe("detector", () => {
		const offsetHelper = [
			"function sessionStartOffset(): number {",
			"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
			"}",
		].join("\n");

		it("flags the #4381 shape: an offset helper with no drain, called after a write", () => {
			const hits = scanFixture(
				[
					offsetHelper,
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tawait flushLatencyLog();",
					"\tconst offset = sessionStartOffset();",
					"});",
				].join("\n"),
			);
			expect(hits).toEqual([
				{
					line: 2,
					callee: "statSync",
					sinks: ["clients/sessionstart-logger.ts"],
					text: "return fs.statSync(SESSIONSTART_LOG_FILE).size;",
					undrainedCallers: [7],
				},
			]);
		});

		it("accepts the fixed helper: it drains its own sink before the offset", () => {
			expect(
				scanFixture(
					[
						"async function sessionStartOffset(): Promise<number> {",
						"\tawait flushSessionStartLog();",
						"\treturn fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"}",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a drain named only in a comment or a string does not count", () => {
			for (const launder of [
				"\t// await flushSessionStartLog();",
				'\tconst note = "await flushSessionStartLog();";',
				"\tconst note = `await flushSessionStartLog();`;",
			]) {
				const hits = scanFixture(
					[
						'it("x", async () => {',
						launder,
						"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"});",
					].join("\n"),
				);
				expect(
					hits.map((hit) => hit.line),
					launder,
				).toEqual([3]);
			}
		});

		it("a drain of a different sink does not count", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tconst size = fs.statSync(SESSIONSTART_LOG_FILE).size;",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.sinks)).toEqual([
				["clients/sessionstart-logger.ts"],
			]);
		});

		it("an await between the drain and the read voids the drain", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tawait new Promise((resolve) => setImmediate(resolve));",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([4]);
		});

		it("accepts a sync Sync-drain, the global drain, and a local draining helper", () => {
			expect(
				scanFixture(
					[
						"async function rows(): Promise<string> {",
						"\tawait flushLatencyLog();",
						'\treturn fs.readFileSync(getLatencyLogPath(), "utf8");',
						"}",
						'it("x", async () => {',
						"\tflushSessionStartLogSync();",
						"\tconst a = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait flushAllNdjsonWriters();",
						"\tconst b = fs.statSync(SESSIONSTART_LOG_FILE).size;",
						"\tawait rows();",
						'\tconst c = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a helper that awaits more work after its drain is no drain", () => {
			const hits = scanFixture(
				[
					"async function settle(): Promise<void> {",
					"\tawait flushLatencyLog();",
					"\tawait runTurn();",
					"}",
					'it("x", async () => {',
					"\tawait settle();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([7]);
		});

		it("stat, lstat, open and openSync of a sink are reads (A2, A4)", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait loadLSPConfig(dir, home);",
					"\tconst a = (await fs.promises.stat(getLatencyLogPath())).size;",
					"\tconst b = (await fsp.lstat(getLatencyLogPath())).size;",
					'\tconst fd = fs.openSync(SESSIONSTART_LOG_FILE, "r");',
					"\tconst c = fs.fstatSync(fd).size;",
					'\tconst handle = await fs.promises.open(SESSIONSTART_LOG_FILE, "r");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.callee])).toEqual([
				[3, "stat"],
				[4, "lstat"],
				[5, "openSync"],
				[7, "open"],
			]);
		});

		it("a drain that does not dominate the read is not credited (A19, A20)", () => {
			// Each case is a drain the read cannot rely on: it sits behind a
			// condition, inside a function nothing calls, inside a callback the
			// read does not wait on, or inside a try block whose catch can
			// swallow a throw raised before the drain.
			const cases: Array<[string, string[]]> = [
				[
					"if block (A19)",
					["\tif (cond) {", "\t\tawait flushLatencyLog();", "\t}"],
				],
				["braceless if", ["\tif (cond) await flushLatencyLog();"]],
				["ternary", ["\tcond ? await flushLatencyLog() : undefined;"]],
				["logical and", ["\tcond && (await flushLatencyLog());"]],
				[
					"uncalled inner function, block body (A20)",
					[
						"\tconst unused = async () => {",
						"\t\tawait flushLatencyLog();",
						"\t};",
					],
				],
				[
					"uncalled inner function, expression body",
					["\tconst unused = async () => await flushLatencyLog();"],
				],
				[
					"callback the read does not wait on",
					[
						"\tsetImmediate(async () => {",
						"\t\tawait flushLatencyLog();",
						"\t});",
					],
				],
				[
					"try block with a catch the read follows",
					["\ttry {", "\t\tawait flushLatencyLog();", "\t} catch {}"],
				],
			];
			const verdicts = cases.map(([label, drain]) => {
				const source = [
					'it("x", async () => {',
					...drain,
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				];
				const flagged = scanFixture(source.join("\n")).map((hit) => hit.line);
				return `${label}: ${flagged.includes(source.length - 1) ? "flagged" : "credited"}`;
			});
			expect(verdicts).toEqual(cases.map(([label]) => `${label}: flagged`));
		});

		it("a helper whose drain is conditional is no draining helper", () => {
			const hits = scanFixture(
				[
					"async function maybeDrain(): Promise<void> {",
					"\tif (cond) await flushLatencyLog();",
					"}",
					'it("x", async () => {',
					"\tawait maybeDrain();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([6]);
		});

		it("a helper whose drain sits in an inner function it never calls is no draining helper", () => {
			// The drain's block is the inner arrow's body, not the helper's, so
			// the helper does not end drained (state table D11).
			const hits = scanFixture(
				[
					"async function notADrain(): Promise<void> {",
					"\tconst later = async () => {",
					"\t\tawait flushLatencyLog();",
					"\t};",
					"}",
					'it("x", async () => {',
					"\tawait notADrain();",
					'\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([8]);
		});

		it("a drain outside a reader helper's scope does not credit its read", () => {
			// The drain dominates the helper's declaration, not its call: the
			// helper runs after `await write()` (state table D2, D13).
			const hits = scanFixture(
				[
					'it("x", async () => {',
					"\tawait flushLatencyLog();",
					"\tfunction offset(): number {",
					"\t\treturn fs.statSync(getLatencyLogPath()).size;",
					"\t}",
					"\tawait write();",
					"\tconst before = offset();",
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[4, [7]],
			]);
		});

		it("a drain in a try body with no catch credits the read after the try", () => {
			// The tree's shape (runtime-turn-test-runner-bounds, result-contract-
			// governance): the drain ends a try whose finally restores an env
			// var; a throw before it skips the read, so it dominates.
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"	try {",
						"		await flushLatencyLog();",
						"	} finally {",
						"		restore();",
						"	}",
						'	const rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a drain in an enclosing block credits a read nested below it", () => {
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tawait flushLatencyLog();",
						"\tif (cond) {",
						'\t\tconst rows = fs.readFileSync(getLatencyLogPath(), "utf8");',
						"\t}",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("an inline callback reads inside its caller's drain order; aliases resolve", () => {
			expect(
				scanFixture(
					[
						'it("x", async () => {',
						"\tconst file = getLatencyLogPath();",
						"\tawait flushLatencyLog();",
						"\tconst sizes = [file].map((f) => fs.statSync(file).size);",
						"});",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("an alias is visible only in the scope that declares it", () => {
			// `file` names the latency sink inside `writerSide` only; the same name
			// as another function's parameter is an unrelated path.
			expect(
				scanFixture(
					[
						"function writerSide(): string {",
						"\tconst file = getLatencyLogPath();",
						"\treturn file;",
						"}",
						"function unrelated(file: string): number {",
						"\treturn fs.statSync(file).size;",
						"}",
					].join("\n"),
				),
			).toEqual([]);
		});

		it("a sync reader helper is drained only when every call site drains", () => {
			const reader = [
				"function rowsFor(): string {",
				"\tconst file = getLatencyLogPath();",
				'\treturn fs.readFileSync(file, "utf8");',
				"}",
			];
			const drained = [
				'it("a", async () => {',
				"\tawait flushLatencyLog();",
				'\texpect(rowsFor()).toBe("");',
				"});",
			];
			expect(scanFixture([...reader, ...drained].join("\n"))).toEqual([]);
			const hits = scanFixture(
				[
					...reader,
					...drained,
					'it("b", async () => {',
					'\texpect(rowsFor()).toBe("");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => [hit.line, hit.undrainedCallers])).toEqual([
				[3, [10]],
			]);
		});

		it("a basename literal names an in-process sink only under an in-process root", () => {
			const hits = scanFixture(
				[
					'it("x", async () => {',
					'\tconst child = fs.readFileSync(path.join(childHome, "latency.log"), "utf8");',
					'\tconst notes = fs.statSync(path.join(dir, "notes.txt")).size;',
					"\tconst root = getGlobalPiLensLogDir();",
					'\tconst own = fs.readFileSync(path.join(root, "latency.log"), "utf8");',
					'\tconst env = fs.readFileSync(path.join(process.env.PI_LENS_HOME ?? "", "latency.log"), "utf8");',
					"});",
				].join("\n"),
			);
			expect(hits.map((hit) => hit.line)).toEqual([5, 6]);
		});
	});
});
