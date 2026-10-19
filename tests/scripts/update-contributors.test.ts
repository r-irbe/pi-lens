import { describe, expect, it } from "vitest";
import {
	classifyFiles,
	classifyIssue,
	formatPlan,
	assertNotTruncated,
	isBot,
	loadLists,
	planContributions,
} from "../../scripts/update-contributors.mjs";

// Recorded `gh pr list` / `gh issue list` / `gh pr view --json files` shapes
// (refs #3772). Recurrence guarded: the hand-run refresh in PR #3773 that
// omitted reporters and docs/tests-only authors and could not be re-run.
const prs = [
	{ number: 3702, author: { login: "LucaBarrella" } },
	{ number: 3369, author: { login: "AngriestBird" } },
	{ number: 3638, author: { login: "app/dependabot" } },
	{ number: 1, author: { login: "apmantza" } },
];
const issues = [
	{
		number: 3693,
		title: "Support X",
		author: { login: "LucaBarrella" },
		labels: [{ name: "enhancement" }],
	},
	{
		number: 3749,
		title: "MCP tools accept unknown arguments silently",
		author: { login: "zjael" },
		labels: [],
	},
	{
		number: 3442,
		title: "nightly drift",
		author: { login: "app/github-actions" },
		labels: [{ name: "nightly-drift" }],
	},
	{ number: 9, title: "Some question", author: { login: "asker" }, labels: [] },
];
const filesByPr = {
	3702: ["clients/a.ts", "tests/a.test.ts"],
	3369: ["AGENTS.md", "tests/b.test.ts"],
};

describe("update-contributors planning", () => {
	it("credits code, reporters, and docs/tests-only PRs; skips owner and bots", () => {
		const plan = planContributions({
			prs,
			issues,
			filesByPr,
			existing: {},
			owner: "apmantza",
		});
		const by = Object.fromEntries(plan.map((p) => [p.login, p]));
		expect(by.LucaBarrella.add).toEqual(["code", "ideas"]);
		expect(by.LucaBarrella.evidence).toEqual({ code: [3702], ideas: [3693] });
		expect(by.AngriestBird.add).toEqual(["doc", "test"]);
		expect(by.zjael.add).toEqual(["bug"]);
		expect(Object.keys(by).sort()).toEqual([
			"AngriestBird",
			"LucaBarrella",
			"zjael",
		]);
	});

	it("is idempotent: a second run over the applied result plans nothing", () => {
		const first = planContributions({
			prs,
			issues,
			filesByPr,
			existing: {},
			owner: "apmantza",
		});
		const existing = Object.fromEntries(first.map((p) => [p.login, p.add]));
		const second = planContributions({
			prs,
			issues,
			filesByPr,
			existing,
			owner: "apmantza",
		});
		expect(second).toEqual([]);
		expect(formatPlan(second)).toContain("up to date");
	});

	it("only adds missing types to an existing entry, case-insensitively", () => {
		const plan = planContributions({
			prs,
			issues,
			filesByPr,
			existing: { lucabarrella: ["code"] },
			owner: "apmantza",
		});
		const luca = plan.find((p) => p.login === "LucaBarrella");
		expect(luca).toMatchObject({ isNew: false, add: ["ideas"] });
	});
});

describe("update-contributors classification", () => {
	it("maps changed files to code, doc, test", () => {
		expect(classifyFiles(["docs/x.md"])).toEqual(["doc"]);
		expect(classifyFiles(["tests/x.test.ts"])).toEqual(["test"]);
		expect(classifyFiles(["README.md", "tests/x.test.ts"])).toEqual([
			"doc",
			"test",
		]);
		expect(classifyFiles(["README.md", "clients/x.ts"])).toEqual(["code"]);
	});

	it("labels win, then titles; drift and duplicates earn nothing", () => {
		expect(classifyIssue({ title: "x", labels: [{ name: "bug" }] })).toBe(
			"bug",
		);
		expect(classifyIssue({ title: "Bug: thing", labels: [] })).toBe("bug");
		expect(classifyIssue({ title: "Add Expert LSP", labels: [] })).toBe(
			"ideas",
		);
		expect(
			classifyIssue({
				title: "crash on start",
				labels: [{ name: "duplicate" }],
			}),
		).toBeNull();
		expect(classifyIssue({ title: "hello", labels: [] })).toBeNull();
	});

	it("recognises bot logins", () => {
		expect(isBot("app/dependabot")).toBe(true);
		expect(isBot("renovate[bot]")).toBe(true);
		expect(isBot("LucaBarrella")).toBe(false);
		expect(isBot("anyone", true)).toBe(true);
	});

	// Recurrence: the first bot regex ended in (\\b|$), so human logins that merely
	// start with a bot name were dropped from the credit list (review of #3773).
	it("keeps human logins that start with a bot name", () => {
		for (const login of [
			"claude-fan",
			"copilot-jones",
			"codecov-user",
			"renovate-x",
			"github-actions-fan",
		]) {
			expect(isBot(login)).toBe(false);
		}
	});

	// Recurrence: repo-specific words in the bug regex made docs/UX questions count as bugs.
	it("does not classify generic titles as bugs", () => {
		expect(
			classifyIssue({ title: "Question about reference docs", labels: [] }),
		).toBeNull();
		expect(
			classifyIssue({ title: "Make error messages clearer", labels: [] }),
		).toBe("ideas");
		expect(classifyIssue({ title: "Add fix for error", labels: [] })).toBe(
			"ideas",
		);
		expect(
			classifyIssue({ title: "Multiple failures on start", labels: [] }),
		).toBe("bug");
	});

	// Recurrence: a gh list truncated at --limit silently dropped contributors.
	it("refuses a list that came back at the limit", () => {
		expect(() => assertNotTruncated([1, 2, 3], "issues", 3)).toThrow(
			/truncated/,
		);
		expect(assertNotTruncated([1, 2], "issues", 3)).toEqual([1, 2]);
	});

	// Recurrence: assertNotTruncated existed but main() never called it (verify of #3773).
	it("loadLists refuses a full-limit gh result for either list", () => {
		const full = Array.from({ length: 5000 }, (_, i) => ({ number: i }));
		expect(() => loadLists((a) => (a[0] === "pr" ? full : []), "o/r")).toThrow(
			/merged PRs/,
		);
		expect(() =>
			loadLists((a) => (a[0] === "issue" ? full : []), "o/r"),
		).toThrow(/issues/);
		expect(loadLists(() => [], "o/r")).toEqual({ prs: [], issues: [] });
	});

	// Recurrence: a planner that ignored gh's author.is_bot stayed green (verify of #3773).
	it("plans nothing for an author gh marks as a bot", () => {
		const plan = planContributions({
			prs: [{ number: 1, author: { login: "x-robot", is_bot: true } }],
			issues: [
				{
					number: 2,
					title: "Bug: crash",
					labels: [],
					author: { login: "x-robot", is_bot: true },
				},
			],
			filesByPr: { 1: ["clients/a.ts"] },
			existing: {},
			owner: "apmantza",
		});
		expect(plan).toEqual([]);
	});
});
