/**
 * #3678 F-A and F-C. F-A: a healthy parse or compile of an input that once
 * trapped must drop that input's trap entry, or two separate one-off traps on
 * one unchanged input charge it and skip it for the rest of the process. F-C:
 * the symbol extractor's own query compile must be keyed by query source, or
 * one always-trapping query spends the process budget on every extractor init
 * and the fourth init poisons the runtime.
 *
 * Each test builds its own `TreeSitterClient`, so each gets a fresh
 * `WASM_TRAP_BUDGET`. The shared singleton's budget is process-wide and pinned
 * in tests/clients/tree-sitter-wasm-trap.test.ts and the review-graph suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { loadWebTreeSitter } from "../../clients/deps/web-tree-sitter.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { extractFactsFromTree } from "../../clients/dispatch/facts/tree-sitter-facts.js";
import type { DispatchContext } from "../../clients/dispatch/types.js";
import {
	TreeSitterClient,
	WASM_TRAP_BUDGET,
} from "../../clients/tree-sitter-client.js";
import type { TreeSitterQuery } from "../../clients/tree-sitter-query-loader.js";
import {
	_resetSharedTreeSitterClientForTests,
	isTreeSitterWasmAborted,
	withTreeSitterRoot,
} from "../../clients/tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const { WebAssembly } = globalThis as unknown as {
	WebAssembly: { RuntimeError: new (message: string) => Error };
};
const trap = () => new WebAssembly.RuntimeError("table index is out of bounds");

const cleanups: Array<() => void> = [];
beforeEach(() => resetDegradationLedger());
afterEach(() => {
	vi.restoreAllMocks();
	while (cleanups.length) cleanups.pop()?.();
	resetDegradationLedger();
});

function pythonFile(content = "def f():\n    return 1\n"): string {
	const env = setupTestEnvironment("pi-lens-trap-decay-");
	cleanups.push(env.cleanup);
	return createTempFile(env.tmpDir, "m.py", content);
}

async function liveClient() {
	const onAbort = vi.fn();
	const client = new TreeSitterClient(false, onAbort);
	expect(await client.init()).toBe(true);
	return { client, onAbort };
}

function wasmTrapReasons(): string[] {
	return (
		getDegradationSummary()
			.find((group) => group.kind === "wasm-trap")
			?.latestReasons.map((row) => row.reason) ?? []
	);
}

function pythonRule(id: string): TreeSitterQuery {
	return {
		id,
		name: id,
		severity: "warning",
		category: "test",
		language: "python",
		message: id,
		query: "(function_definition) @fn",
		metavars: ["fn"],
		has_fix: false,
		filePath: "",
	};
}

/**
 * A language handle that traps while `state.on`, the way a grammar whose query
 * compile always traps (`new Query(language, source)` reads `language[0]`)
 * does. Toggled per call to model a one-off compile trap followed by a healthy
 * compile of the same query source.
 */
function trappingLanguage(
	client: TreeSitterClient,
	state: { on: boolean },
): void {
	const internals = client as unknown as {
		loadLanguage: (languageId: string) => Promise<unknown>;
	};
	const realLoad = internals.loadLanguage.bind(client);
	vi.spyOn(internals, "loadLanguage").mockImplementation(async (languageId) =>
		state.on
			? {
					get 0(): number {
						throw trap();
					},
				}
			: realLoad(languageId),
	);
}

describe("trap entry decay (#3678 F-A)", () => {
	it("drops an input's entry after a healthy parse, so a later one-off trap is not charged", async () => {
		const { client, onAbort } = await liveClient();
		const file = pythonFile();
		const boom = () => {
			throw trap();
		};

		expect(
			await client.withParsedTree(file, "python", undefined, boom),
		).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		// The healthy parse of the SAME input is the decay event.
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);

		// Without decay the entry is still `1` here, so this second trap is
		// charged and every later parse is skipped.
		expect(
			await client.withParsedTree(file, "python", undefined, boom),
		).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		// The input is not skipped: a healthy parse still runs.
		expect(
			(await client.withParsedTree(file, "python", undefined, () => 1)).parsed,
		).toBe(true);
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("drops a pattern query's entry after a successful compile (#3678 F-A)", async () => {
		const { client } = await liveClient();
		const internals = client as unknown as {
			compileQuery: (pattern: string, languageId: string) => Promise<unknown>;
			queryCache: Map<string, unknown>;
		};
		const state = { on: false };
		trappingLanguage(client, state);
		const compile = () => {
			internals.queryCache.clear();
			return internals.compileQuery("(function_definition) @fn", "python");
		};

		state.on = true;
		expect(await compile()).toBeNull(); // trap: budget 1, entry retry
		state.on = false;
		expect(await compile()).not.toBeNull(); // success: the decay event
		state.on = true;
		expect(await compile()).toBeNull(); // trap again
		state.on = false;
		// With decay the entry is gone, so this compile runs; without it the
		// previous trap charged the query and this returns null uncompiled.
		expect(await compile()).not.toBeNull();
	});

	it("drops a raw query's entry after a successful compile (#3678 F-A)", async () => {
		const { client } = await liveClient();
		const internals = client as unknown as {
			compileRawQuery: (
				queryId: string,
				queryStr: string,
				metavars: string[],
				languageId: string,
			) => Promise<unknown>;
			queryCache: Map<string, unknown>;
		};
		const state = { on: false };
		trappingLanguage(client, state);
		const compile = () => {
			internals.queryCache.clear();
			return internals.compileRawQuery(
				"rule-1",
				"(function_definition) @fn",
				["fn"],
				"python",
			);
		};

		state.on = true;
		expect(await compile()).toBeNull(); // trap: budget 1, entry retry
		state.on = false;
		expect(await compile()).not.toBeNull(); // success: the decay event
		state.on = true;
		expect(await compile()).toBeNull(); // trap again
		state.on = false;
		// With decay the entry is gone, so this compile runs; without it the
		// previous trap charged the query and this returns null uncompiled.
		expect(await compile()).not.toBeNull();
	});
});

describe("swallowing consumers (#3678 F1, F2)", () => {
	/** A batched compile whose `matches` traps deterministically on the marker. */
	async function trapBatchedMatches() {
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		let matchCalls = 0;
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			matchCalls++;
			if (args[0].text.includes("boom_marker")) throw trap();
			return realMatches.apply(this, args);
		});
		return { matchCalls: () => matchCalls };
	}

	it("charges a file whose batched match traps instead of spending budget every call", async () => {
		const { client, onAbort } = await liveClient();
		const calls = await trapBatchedMatches();
		const file = pythonFile("def boom_fn():\n    return 1  # boom_marker\n");
		const rule = pythonRule("trap-rule");

		const outcomes = [];
		for (let i = 0; i < 6; i++) {
			outcomes.push(await client.runQueriesOnFile([rule], file, "python"));
		}

		// `runQueriesOnFile` swallows the trap and returns normally, so the
		// success path must not clear the entry the trap just set. The file is
		// charged on the second call and the later ones never walk the tree.
		expect(onAbort).not.toHaveBeenCalled();
		expect(calls.matchCalls()).toBe(2);
		expect(outcomes).toEqual([[], [], [], [], [], []]);
	});

	it("does not let a healthy consumer clear another consumer's entry", async () => {
		const { client, onAbort } = await liveClient();
		await trapBatchedMatches();
		const content = "def boom_fn():\n    return 1  # boom_marker\n";
		const trapped = pythonFile(content);
		const healthyTwin = pythonFile(content);
		const rule = pythonRule("trap-rule");

		const healthy: boolean[] = [];
		for (let round = 0; round < 5; round++) {
			await client.runQueriesOnFile([rule], trapped, "python");
			healthy.push(
				(await client.withParsedTree(healthyTwin, "python", undefined, () => 1))
					.parsed,
			);
		}

		// Consumer B's healthy parse must not re-arm consumer A's entry, or every
		// A trap spends budget and the fourth aborts the runtime (#3678 F2). A's
		// second trap charges the content, which is then skipped for every
		// caller, as on master: B runs once, then stays quarantined with it.
		expect(onAbort).not.toHaveBeenCalled();
		expect(healthy).toEqual([true, false, false, false, false]);
	});

	it("keys a runQueriesOnFile decay to the rule set, not only the label (#3678 F4)", async () => {
		const { client, onAbort } = await liveClient();
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		// Only the query capturing `@trap_me` traps: rule set A walks it, rule
		// set B (the dispatch runner's different effective set) does not.
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			if (this.captureNames.includes("trap_me")) throw trap();
			return realMatches.apply(this, args);
		});
		const file = pythonFile();
		const setA = [
			{
				...pythonRule("scanner-rule"),
				query: "(function_definition) @trap_me",
				metavars: ["trap_me"],
			},
		];
		const setB = [pythonRule("dispatch-rule")];

		const bMatches: number[] = [];
		for (let round = 0; round < 6; round++) {
			await client.runQueriesOnFile(setA, file, "python");
			bMatches.push(
				(await client.runQueriesOnFile(setB, file, "python")).length,
			);
		}

		// Both sets share the `runQueriesOnFile` label. B's clean walk must not
		// clear A's entry, or A's deterministic trap spends one budget unit per
		// round and the fourth aborts the runtime. A's second trap charges the
		// file for every caller, as on master.
		expect(onAbort).not.toHaveBeenCalled();
		expect(bMatches).toEqual([1, 0, 0, 0, 0, 0]);
	});

	it("keys a runQueryOnFile decay to the rule, not only the label (#3678 F4)", async () => {
		const { client, onAbort } = await liveClient();
		const { Query } = await loadWebTreeSitter();
		const realMatches = Query.prototype.matches;
		vi.spyOn(Query.prototype, "matches").mockImplementation(function (
			this: InstanceType<typeof Query>,
			...args: Parameters<typeof realMatches>
		) {
			if (this.captureNames.includes("trap_me")) throw trap();
			return realMatches.apply(this, args);
		});
		const file = pythonFile();
		const ruleA = {
			...pythonRule("rule-a"),
			query: "(function_definition) @trap_me",
			metavars: ["trap_me"],
		};
		const ruleB = pythonRule("rule-b");

		const bMatches: number[] = [];
		for (let round = 0; round < 6; round++) {
			await client.runQueryOnFile(ruleA, file, "python");
			bMatches.push(
				(await client.runQueryOnFile(ruleB, file, "python")).length,
			);
		}

		// The dispatch runner's per-rule path: rule B's clean walk must not clear
		// rule A's entry, or A's deterministic trap aborts on the fourth round.
		expect(onAbort).not.toHaveBeenCalled();
		expect(bMatches).toEqual([1, 0, 0, 0, 0, 0]);
	});
});

describe("one budget unit per poisoned content, whatever the caller (#3678 F5, F6)", () => {
	const CALLERS = [
		"review-graph",
		"runQueriesOnFile",
		"read-expansion",
		"module-report",
		"blocker-freshness",
		"tree-sitter-shared",
	];

	/** A parser whose `parse` traps on `marker` content: a parse-phase trap
	 * that the content causes, whoever asked for the parse. */
	function trappingParse(client: TreeSitterClient, state: { on: boolean }) {
		const internals = client as unknown as {
			getParser: (languageId: string) => Promise<{
				parse: (source: string) => unknown;
			} | null>;
		};
		const realGet = internals.getParser.bind(client);
		vi.spyOn(internals, "getParser").mockImplementation(async (languageId) => {
			const parser = await realGet(languageId);
			return (
				parser && {
					parse: (source: string) => {
						if (state.on && source.includes("poison_marker")) throw trap();
						return parser.parse(source);
					},
				}
			);
		});
	}

	it("charges a parse trap once for six callers of one poisoned file (F5)", async () => {
		const { client, onAbort } = await liveClient();
		trappingParse(client, { on: true });
		const file = pythonFile("def f():\n    return 1  # poison_marker\n");

		const outcomes: unknown[] = [];
		for (let round = 0; round < 2; round++) {
			for (const caller of CALLERS) {
				const outcome = await client.withParsedTree(
					file,
					"python",
					undefined,
					() => 1,
					caller,
				);
				outcomes.push(outcome.parsed ? "ok" : outcome.wasmTrap);
			}
		}

		// The content poisons the grammar, not a consumer: its first trap spends
		// one unit and the second charges it for every caller, as on master.
		// Keyed per caller, each caller's first trap spends a unit and the
		// fourth caller aborts the runtime.
		expect(onAbort).not.toHaveBeenCalled();
		expect(outcomes).toEqual(["retry", ...Array(11).fill("charged")]);
	});

	it("charges a consume trap once for six callers of one poisoned tree (F6)", async () => {
		const { client, onAbort } = await liveClient();
		const file = pythonFile();

		const outcomes: unknown[] = [];
		for (let round = 0; round < 2; round++) {
			for (const caller of CALLERS) {
				const outcome = await client.withParsedTree(
					file,
					"python",
					undefined,
					() => {
						throw trap();
					},
					caller,
				);
				outcomes.push(outcome.parsed ? "ok" : outcome.wasmTrap);
			}
		}

		// Every walk of this tree traps. A per-caller key spends one unit per
		// caller and the fourth aborts; one entry per content charges it on the
		// second caller and skips it for the rest, as on master.
		expect(onAbort).not.toHaveBeenCalled();
		expect(outcomes).toEqual(["retry", ...Array(11).fill("charged")]);
	});

	it("decays a one-off parse trap after a clean parse by any caller (F-A)", async () => {
		const { client, onAbort } = await liveClient();
		const state = { on: true };
		trappingParse(client, state);
		const content = "def f():\n    return 1  # poison_marker\n";
		const file = pythonFile(content);
		// Same content, another path: its clean tree is cached under its own
		// path, so `file` is parsed again (and can trap again) below.
		const twin = pythonFile(content);
		const parse = (path: string, caller: string) =>
			client.withParsedTree(path, "python", undefined, () => 1, caller);

		expect(await parse(file, "review-graph")).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		state.on = false;
		// A clean parse is the decay event for a parse-phase entry, whichever
		// caller asked: the parse carries no consumer.
		expect((await parse(twin, "read-expansion")).parsed).toBe(true);
		state.on = true;
		// Without the decay the entry is still `1` and this trap charges it.
		expect(await parse(file, "review-graph")).toEqual({
			parsed: false,
			wasmTrap: "retry",
		});
		expect(wasmTrapReasons().some((r) => r.startsWith("input charged:"))).toBe(
			false,
		);
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("withTreeSitterRoot callers keep their own identity (#3678 F4)", () => {
	afterEach(() => _resetSharedTreeSitterClientForTests());

	it("does not let the IR parse check re-arm a complexity walk's trap", async () => {
		_resetSharedTreeSitterClientForTests();
		const file = pythonFile("def g():\n    return 2\n");
		const content = "def g():\n    return 2\n";

		const walks: unknown[] = [];
		for (let round = 0; round < 5; round++) {
			const walk = await withTreeSitterRoot(
				file,
				content,
				() => {
					throw trap();
				},
				"complexity",
			);
			walks.push(walk.parsed ? "ok" : walk.wasmTrap);
			await withTreeSitterRoot(file, content, () => true, "review-graph-ir");
		}

		// The complexity walk traps on this content; the review graph's parse
		// check (`() => true`) succeeds. Under one shared label the check heals
		// the walk's entry every round and the fourth trap aborts the runtime.
		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(walks).toEqual([
			"retry",
			"charged",
			"charged",
			"charged",
			"charged",
		]);
	});

	it("keeps each fact provider's identity through extractFactsFromTree", async () => {
		_resetSharedTreeSitterClientForTests();
		const content = "def h():\n    return 3\n";
		const file = pythonFile(content);
		const store = new FactStore();
		store.setFileFact(file, "file.content", content);
		const ctx = { filePath: file } as DispatchContext;

		const healthy: unknown[] = [];
		for (let round = 0; round < 5; round++) {
			await extractFactsFromTree(
				ctx,
				store,
				"fact.trapping",
				{ "file.trapping": [] },
				() => {
					throw trap();
				},
			);
			await extractFactsFromTree(
				ctx,
				store,
				"fact.healthy",
				{ "file.healthy": [] },
				() => ({ "file.healthy": [] }),
				"file.healthyCoverage",
			);
			healthy.push(store.getFileFact(file, "file.healthyCoverage"));
		}

		// Two providers on one file: the healthy one must not heal the trapping
		// one's entry, or the fourth trap aborts the runtime. The trapping
		// provider's second trap charges the content for every provider.
		expect(isTreeSitterWasmAborted()).toBe(false);
		expect(healthy).toEqual([
			"complete",
			"unavailable",
			"unavailable",
			"unavailable",
			"unavailable",
		]);
	});
});

describe("query-compile keying (#3678 F-C)", () => {
	it("charges a repeated compile trap to its query source instead of the budget", () => {
		const onAbort = vi.fn();
		const client = new TreeSitterClient(false, onAbort);
		const extractor = new TreeSitterSymbolExtractor("python", client);
		const compileQuery = (
			extractor as unknown as {
				compileQuery: (
					Query: new () => never,
					language: unknown,
					src: string,
					label: string,
				) => unknown;
			}
		).compileQuery.bind(extractor);
		class TrappingQuery {
			constructor() {
				throw trap();
			}
		}
		const src = "(function_definition) @fn";

		const outcomes: unknown[] = [];
		for (let i = 0; i < WASM_TRAP_BUDGET + 2; i++) {
			outcomes.push(compileQuery(TrappingQuery as never, {}, src, "defs"));
		}

		// The first trap spends one budget unit; every later one is charged to
		// the same query source, so the runtime never aborts and each attempt
		// still returns the documented null.
		expect(outcomes).toEqual([null, null, null, null, null]);
		expect(onAbort).not.toHaveBeenCalled();
	});

	it("spends budget per distinct query source, not one constant key", () => {
		const onAbort = vi.fn();
		const client = new TreeSitterClient(false, onAbort);
		const extractor = new TreeSitterSymbolExtractor("python", client);
		const compileQuery = (
			extractor as unknown as {
				compileQuery: (
					Query: new () => never,
					language: unknown,
					src: string,
					label: string,
				) => unknown;
			}
		).compileQuery.bind(extractor);
		class TrappingQuery {
			constructor() {
				throw trap();
			}
		}

		for (let i = 0; i < WASM_TRAP_BUDGET; i++) {
			expect(
				compileQuery(
					TrappingQuery as never,
					{},
					`(function_definition) @f${i}`,
					"defs",
				),
			).toBeNull();
		}
		expect(onAbort).not.toHaveBeenCalled();

		// Each distinct source's first trap spent one unit, so the next distinct
		// source crosses the budget. With a constant key the earlier sources
		// collide, charge, and leave budget for this one — no abort.
		expect(() =>
			compileQuery(TrappingQuery as never, {}, "(class_definition) @c", "defs"),
		).toThrow();
		expect(onAbort).toHaveBeenCalledTimes(1);
	});
});
