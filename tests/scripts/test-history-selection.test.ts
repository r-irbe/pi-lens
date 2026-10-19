import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectTargetedTests } from "../../scripts/pre-push-targeted-tests.mjs";
import {
	HISTORY_MAX_SELECTED,
	HISTORY_STALE_MS,
	HUB_MIN_HEADS,
	loadHistorySelection,
	selectFromHistory,
} from "../../scripts/lib/test-history-selection.mjs";

/**
 * #3215 lane 3. The pre-push selector reads imports only, so a change to a
 * non-imported file (the rule YAML, a doc) selects nothing even when past heads
 * that touched the same directory failed specific tests. #3214 round 1 redded
 * only `tests/scripts/rule-catalogs.test.ts`, reachable from no import of the
 * changed YAML. `selectFromHistory` adds those tests from the rollup's
 * `failures` view; it never removes the import-derived selection.
 */

const now = Date.parse("2026-10-07T12:00:00.000Z");
const fresh = new Date(now - HISTORY_STALE_MS / 2).toISOString();
const head = (n: number) => String(n).padStart(40, "0");
const allTests = [
	"tests/scripts/rule-catalogs.test.ts",
	"tests/config/sweep-floor-coverage.test.ts",
	"tests/clients/other.test.ts",
	"tests/clients/ci-only.test.ts",
];

function summary(
	failures: Array<{ file: string; headSha: string; flake?: boolean }>,
	generatedAt = fresh,
	otherHeads: string[] = [],
) {
	return {
		generatedAt,
		heads: [...new Set([...failures.map((f) => f.headSha), ...otherHeads])],
		failures: failures.map((f) => ({ flake: false, ...f })),
	};
}

function touching(map: Record<string, string[]>) {
	const asked: string[][] = [];
	const pathsForHeads = (heads: string[]) => {
		asked.push([...heads]);
		return new Map(
			heads.filter((h) => map[h]).map((h) => [h, map[h] as string[]]),
		);
	};
	return { pathsForHeads, asked };
}

const yamlChange = ["rules/ast-grep-rules/rules/no-new-rule.yml"];
const roundOne = summary([
	{ file: "tests/scripts/rule-catalogs.test.ts", headSha: head(1) },
	{ file: "tests/config/sweep-floor-coverage.test.ts", headSha: head(1) },
]);
const roundOneTouched = {
	[head(1)]: ["rules/ast-grep-rules/rules/other-rule.yml", "docs/a.md"],
};

describe("selectFromHistory (#3215 lane 3)", () => {
	it("selects what failed on past heads that touched the changed directory, where import selection finds nothing", () => {
		// Recurrence: #3214 round 1 (rules/ YAML change, red only in
		// rule-catalogs.test.ts), invisible to the import-only pre-push selector.
		const importOnly = selectTargetedTests(yamlChange, allTests);
		expect(importOnly.selected).toEqual([]);
		const history = selectFromHistory({
			summary: roundOne,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(history.status).toBe("selected");
		expect([...history.picks].sort()).toEqual([
			"tests/config/sweep-floor-coverage.test.ts",
			"tests/scripts/rule-catalogs.test.ts",
		]);
		const merged = selectTargetedTests(yamlChange, allTests, {
			historyPicks: history.picks,
		});
		expect([...merged.selected].sort()).toEqual([...history.picks].sort());
		expect(merged.fromHistory).toEqual(expect.arrayContaining(history.picks));
	});

	it("ignores a failure that passed on the same head (a flake, not a signal)", () => {
		// Recurrence: a flaky file's co-occurrence would put it in every
		// selection for the directory its flaky heads touched.
		const flaky = summary([
			{
				file: "tests/scripts/rule-catalogs.test.ts",
				headSha: head(1),
				flake: true,
			},
		]);
		const result = selectFromHistory({
			summary: flaky,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(result.status).toBe("none");
	});

	it.each([
		[
			"a sibling directory under the same top-level directory",
			"rules/ast-grep-rules/readme.md",
		],
		["another top-level directory", "clients/lsp/client.ts"],
	])("does not select for a change in %s", (_name, changedFile) => {
		// Recurrence: prefix matching widened to a shared top-level segment would
		// put every recorded failure under `rules/` in every `rules/**` selection.
		const result = selectFromHistory({
			summary: roundOne,
			changed: [changedFile],
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
	});

	it("falls back to import-only and says so when the history is stale", () => {
		// The issue's own caveat: lagging data degrades selection. The nightly
		// rollup was red from 2026-09-30, so the journal on the data branch is
		// the stale case today.
		const stale = new Date(now - HISTORY_STALE_MS - 1000).toISOString();
		const asked = touching(roundOneTouched);
		const result = selectFromHistory({
			summary: { ...roundOne, generatedAt: stale },
			changed: yamlChange,
			allTests,
			pathsForHeads: asked.pathsForHeads,
			now,
		});
		expect(result.status).toBe("stale");
		expect(result.picks).toEqual([]);
		expect(result.detail).toContain("stale");
		expect(asked.asked).toEqual([]);
	});

	it.each([
		["no summary", null],
		["a pre-lane-3 summary without a failures view", { rowCount: 3 }],
		["a fresh summary without a failures view", { generatedAt: fresh }],
		[
			"a fresh summary without a heads view",
			{ generatedAt: fresh, failures: [] },
		],
		["a summary with no generation time", { failures: [] }],
		["an unparseable generation time", { failures: [], generatedAt: "soon" }],
	])("is unavailable, never stale-guessed, for %s", (_name, value) => {
		const result = selectFromHistory({
			summary: value as never,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching({}).pathsForHeads,
			now,
		});
		expect(result.status).toBe("unavailable");
		expect(result.picks).toEqual([]);
	});

	it("skips heads git cannot resolve to paths, and counts them", () => {
		// Recurrence: an unmerged PR head absent from the clone, or a merge-commit
		// head (no first-parent diff to attribute), must not crash or match.
		const result = selectFromHistory({
			summary: roundOne,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching({}).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(result.detail).toContain("1 of 1 failing head(s) unresolved");
	});

	it("drops a recorded failure whose test file no longer exists", () => {
		const gone = summary([
			{ file: "tests/deleted/long-gone.test.ts", headSha: head(1) },
		]);
		const result = selectFromHistory({
			summary: gone,
			changed: yamlChange,
			allTests,
			pathsForHeads: touching(roundOneTouched).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
	});

	it("does not consult history for a changed test file", () => {
		// Recurrence: a tests/ directory change would match every past head that
		// touched tests/ and select its flaky failures; the changed test itself
		// is already selected directly.
		const asked = touching({ [head(1)]: ["tests/scripts/x.test.ts"] });
		const result = selectFromHistory({
			summary: roundOne,
			changed: ["tests/scripts/x.test.ts"],
			allTests,
			pathsForHeads: asked.pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(asked.asked).toEqual([]);
	});

	it("ranks by distinct failing heads and caps the addition", () => {
		const many = Array.from({ length: HISTORY_MAX_SELECTED + 3 }, (_, i) => ({
			file: `tests/many/t${String(i).padStart(2, "0")}.test.ts`,
			headSha: head(10 + i),
		}));
		// t05 fails on two heads, so it ranks first.
		many.push({ file: "tests/many/t05.test.ts", headSha: head(99) });
		const tests = [
			...allTests,
			...many.map((f) => f.file).filter((f, i, a) => a.indexOf(f) === i),
		];
		const quiet200 = Array.from({ length: 200 }, (_, i) => head(1000 + i));
		const touched = {
			...Object.fromEntries(
				many.map((f) => [f.headSha, ["rules/ast-grep-rules/rules/z.yml"]]),
			),
			...Object.fromEntries(quiet200.map((h) => [h, ["docs/q.md"]])),
		};
		const result = selectFromHistory({
			// Enough quiet heads that the rules directory stays under the hub share.
			summary: summary(many, fresh, quiet200),
			changed: yamlChange,
			allTests: tests,
			pathsForHeads: touching(touched).pathsForHeads,
			now,
		});
		expect(result.picks).toHaveLength(HISTORY_MAX_SELECTED);
		expect(result.picks[0]).toBe("tests/many/t05.test.ts");
	});
});

describe("selectTargetedTests with history picks (#3215 lane 3)", () => {
	it("adds history picks beside the import selection", () => {
		// Recurrence: lane 3 must add, never remove (the issue's own rule); the
		// import cap degrades to the registries, and history picks are bounded by
		// their own cap so they survive it.
		const result = selectTargetedTests(["clients/hub.ts"], allTests, {
			historyPicks: ["tests/scripts/rule-catalogs.test.ts"],
		});
		expect(result.selected).toContain("tests/scripts/rule-catalogs.test.ts");
		expect(result.fromHistory).toEqual(["tests/scripts/rule-catalogs.test.ts"]);
	});

	it("does not report a registry-armed suite as added by history", () => {
		// Recurrence: a history pick that the governance registry already armed
		// (strictness-ratchet fails on many unrelated pushes) was printed as
		// "history added" for a production change that arms it anyway.
		const armedSuite = "tests/config/strictness-ratchet.test.ts";
		const result = selectTargetedTests(
			["clients/hub.ts"],
			[...allTests, armedSuite],
			{ historyPicks: [armedSuite] },
		);
		expect(result.selected).toContain(armedSuite);
		expect(result.fromHistory).toEqual([]);
	});

	it("does not report an import-selected test as added by history", () => {
		// A changed test file is selected directly (it must exist on disk).
		const self = "tests/scripts/test-history-selection.test.ts";
		const result = selectTargetedTests([self], [...allTests, self], {
			historyPicks: [self],
		});
		expect(result.selected).toContain(self);
		expect(result.fromHistory).toEqual([]);
	});
});

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tmpRoots: string[] = [];
afterEach(() => {
	tmpRoots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const tmpFile = (name: string, content: string) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-history-sel-"));
	tmpRoots.push(root);
	const file = path.join(root, name);
	fs.writeFileSync(file, content);
	return file;
};

describe("hub directories carry no locality signal (#3215 lane 3, review F1)", () => {
	// Recurrence: PR #4026 review. `.changelog/` is touched by 13 of the 37
	// resolvable failing heads (105 of the last 300 master commits) and the repo
	// root by 7, so equality on directories made every fragment-carrying change
	// add the same ten globally-failing tests and displace the directory's own
	// failures; on the issue's own #3214 case it dropped rule-catalogs.test.ts.
	const rulesHead = "3aa900d7e".padEnd(40, "0");
	const yaml = "rules/ast-grep-rules/rules/advisory-registry-subset.yml";
	const hubFailures = (touch: string, n: number, base: number, label: string) =>
		Array.from({ length: n }, (_, i) => ({
			file: `tests/${label}/t${String(i).padStart(2, "0")}.test.ts`,
			headSha: head(base + i),
			touch,
		}));
	const changelogHeads = hubFailures(".changelog/f.md", 15, 100, "changelog");
	const rootHeads = hubFailures("package.json", 12, 200, "root");
	const quiet = Array.from({ length: 10 }, (_, i) => head(300 + i));
	const crowded = [...changelogHeads, ...rootHeads];
	const touched = {
		[rulesHead]: [yaml.replace("advisory-registry-subset", "other")],
		...Object.fromEntries(crowded.map((f) => [f.headSha, [f.touch]])),
		...Object.fromEntries(quiet.map((h) => [h, ["docs/q.md"]])),
	};
	const history = summary(
		[
			{ file: "tests/scripts/rule-catalogs.test.ts", headSha: rulesHead },
			{ file: "tests/config/sweep-floor-coverage.test.ts", headSha: rulesHead },
			...crowded.map(({ file, headSha }) => ({ file, headSha })),
		],
		fresh,
		quiet,
	);
	const tests = [...allTests, ...crowded.map((f) => f.file)];
	const run = (changed: string[]) =>
		selectFromHistory({
			summary: history,
			changed,
			allTests: tests,
			pathsForHeads: touching(touched).pathsForHeads,
			now,
		});

	it.each([
		["a changelog fragment", [yaml, ".changelog/x.md"]],
		["a root file", [yaml, "package.json"]],
		["both", [yaml, ".changelog/x.md", "package.json"]],
	])(
		"keeps the #3214 selection when the change also carries %s",
		(_n, changed) => {
			const result = run(changed);
			expect([...result.picks].sort()).toEqual([
				"tests/config/sweep-floor-coverage.test.ts",
				"tests/scripts/rule-catalogs.test.ts",
			]);
		},
	);

	it("adds nothing for a change that touches only hub directories, and says so", () => {
		const result = run([".changelog/x.md", "package.json"]);
		expect(result.picks).toEqual([]);
		expect(result.status).toBe("none");
		expect(result.detail).toContain("hub");
	});

	// Recurrence: PR #4026 verify V1. The share's denominator is the heads whose
	// paths resolve; heads git cannot resolve (merge commits, heads missing from
	// the clone: 120 of 307 on the real journal) have unknown directories and
	// must not dilute it. Dividing by `summary.heads.length` instead turned the
	// repo root and `.changelog` back into signal on real data.
	it("measures the hub share over resolvable heads, not over every head in the summary", () => {
		const touchers = Array.from({ length: 12 }, (_, i) => ({
			file: `tests/diluted/t${i}.test.ts`,
			headSha: head(500 + i),
		}));
		const resolvable = [
			...touchers.map((f) => f.headSha),
			...Array.from({ length: 28 }, (_, i) => head(600 + i)),
		];
		// 12 of 40 resolvable heads (30%) touch `.changelog`; against all 240
		// heads in the summary it would be 5%.
		const unresolvable = Array.from({ length: 200 }, (_, i) => head(700 + i));
		const map: Record<string, string[]> = Object.fromEntries(
			resolvable.map((h, i) => [
				h,
				i < 12 ? [".changelog/f.md"] : ["docs/q.md"],
			]),
		);
		const result = selectFromHistory({
			summary: summary(touchers, fresh, [
				...resolvable.slice(12),
				...unresolvable,
			]),
			changed: [".changelog/x.md"],
			allTests: [...allTests, ...touchers.map((f) => f.file)],
			pathsForHeads: touching(map).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual([]);
		expect(result.detail).toContain("hub");
	});

	// Recurrence: PR #4026 verify D2. The minimum is inclusive: exactly
	// HUB_MIN_HEADS touching heads is a hub, one fewer is not.
	it.each([
		[HUB_MIN_HEADS, true],
		[HUB_MIN_HEADS - 1, false],
	])("treats a directory touched by %i of 40 heads as hub=%s", (n, isHub) => {
		const touchers = Array.from({ length: n }, (_, i) => ({
			file: `tests/edge/t${i}.test.ts`,
			headSha: head(800 + i),
		}));
		const others = Array.from({ length: 40 - n }, (_, i) => head(900 + i));
		const map: Record<string, string[]> = {
			...Object.fromEntries(touchers.map((f) => [f.headSha, ["edge/f.md"]])),
			...Object.fromEntries(others.map((h) => [h, ["docs/q.md"]])),
		};
		const result = selectFromHistory({
			summary: summary(touchers, fresh, others),
			changed: ["edge/x.md"],
			allTests: [...allTests, ...touchers.map((f) => f.file)],
			pathsForHeads: touching(map).pathsForHeads,
			now,
		});
		expect(result.picks.length > 0).toBe(!isHub);
	});

	it("does not call a directory a hub on a small history", () => {
		// A directory needs a minimum head count before its share means anything:
		// with three heads, one touching a directory is a third of history.
		const small = summary(
			[{ file: "tests/scripts/rule-catalogs.test.ts", headSha: head(1) }],
			fresh,
			[head(2), head(3)],
		);
		const result = selectFromHistory({
			summary: small,
			changed: [".changelog/x.md"],
			allTests,
			pathsForHeads: touching({
				[head(1)]: [".changelog/y.md"],
				[head(2)]: ["docs/a.md"],
				[head(3)]: ["docs/b.md"],
			}).pathsForHeads,
			now,
		});
		expect(result.picks).toEqual(["tests/scripts/rule-catalogs.test.ts"]);
	});
});

describe("an unreadable history gets its own reason (#3215 lane 3, review F3 and F5)", () => {
	// Recurrence: PR #4026 review. An absent ref, a missing file and garbage JSON
	// all printed "no failures view in the history summary", so a fork or fresh
	// clone read like a pre-lane-3 summary.
	const base = { changed: yamlChange, allTests, now };

	it("names a missing --history-summary file", () => {
		const result = loadHistorySelection({
			...base,
			file: path.join(os.tmpdir(), "pi-lens-no-such-summary.json"),
		});
		expect(result.status).toBe("unavailable");
		expect(result.detail).toContain("history unreadable");
		expect(result.detail).toContain("pi-lens-no-such-summary.json");
	});

	it("names a summary that is not JSON", () => {
		const result = loadHistorySelection({
			...base,
			file: tmpFile("summary.json", "{not json"),
		});
		expect(result.status).toBe("unavailable");
		expect(result.detail).toContain("history unreadable");
		expect(result.detail).toContain("not valid JSON");
	});

	it("reads the real pre-lane-3 summary as 'no failures view', not as unreadable", () => {
		// The old shape of history/summary.json, trimmed from the real
		// data/test-history branch (rowCount, files, flakeCandidates).
		const result = loadHistorySelection({
			...base,
			file: path.join(
				repoRoot,
				"tests/fixtures/test-history/summary-schema-pre-lane3/summary.json",
			),
		});
		expect(result.status).toBe("unavailable");
		expect(result.detail).toContain("no failures view");
		expect(result.detail).not.toContain("unreadable");
	});
});
