import { describe, expect, it } from "vitest";
import {
	classifyWorkflowEdit,
	evaluateWorkflowRunEvidence,
	isCommentOrWhitespaceOnlyEdit,
	readWorkflowTriggers,
} from "../../scripts/lib/workflow-run-evidence.mjs";

// #3085 gap 1. Recurrence: #3033 edited install-smoke steps that only ran on
// master pushes (#3043). The job-level reachability sweep cannot see a
// workflow FILE whose edit no pull request executes; these cases drive the
// file-level classifier and the evidence rule on one fixture per shape.
const FILE = ".github/workflows/stryker-nightly.yml";
const wf = (on: string) =>
	`name: x\non:\n${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;

describe("classifyWorkflowEdit: which edits a pull request executes (#3085)", () => {
	const notExecuting: Array<[string, string, string, boolean]> = [
		[
			"schedule plus workflow_dispatch (the stryker-nightly shape)",
			wf("  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:"),
			"no pull_request trigger",
			true,
		],
		[
			"push only, no dispatch",
			wf("  push:\n    branches: [master]"),
			"no pull_request trigger",
			false,
		],
		[
			"pull_request_target only (the greetings shape)",
			wf("  pull_request_target:\n    types: [opened]\n  workflow_dispatch:"),
			"pull_request_target",
			true,
		],
		[
			"pull_request paths filter excluding the file itself",
			wf("  pull_request:\n    paths:\n      - 'src/**'\n  workflow_dispatch:"),
			"`paths:` filter excludes",
			true,
		],
		[
			"pull_request paths-ignore matching the file itself",
			wf("  pull_request:\n    paths-ignore: ['.github/**']"),
			"`paths-ignore:` filter matches",
			false,
		],
		[
			"pull_request paths negating the file",
			wf(
				"  pull_request:\n    paths:\n      - '.github/**'\n      - '!.github/workflows/stryker-nightly.yml'",
			),
			"`paths:` filter excludes",
			false,
		],
		[
			"pull_request types that never fire on a push",
			wf("  pull_request:\n    types: [labeled, closed]"),
			"`types:` list",
			false,
		],
		[
			"a flow-mapping on: this reader does not parse (fail closed)",
			"on: {pull_request: {branches: [master]}}\njobs: {}\n",
			"could not be read",
			true,
		],
		[
			"an alias of an anchor that was never defined (fail closed)",
			wf("  pull_request:\n    paths: *missing"),
			"filters could not be read",
			false,
		],
		[
			"an aliased paths list that excludes the file",
			wf(
				"  push:\n    paths: &p\n      - 'src/**'\n  pull_request:\n    paths: *p",
			),
			"`paths:` filter excludes",
			false,
		],
		[
			"pull_request with a flow-mapping filter (fail closed)",
			wf("  pull_request: {paths: ['.github/**']}"),
			"filters could not be read",
			false,
		],
		["no on: block at all", "name: x\njobs: {}\n", "could not be read", true],
	];
	it.each(notExecuting)("%s", (_name, text, reason, dispatchable) => {
		const verdict = classifyWorkflowEdit(text, FILE);
		expect(verdict).toMatchObject({ executes: false, dispatchable });
		expect((verdict as { reason: string }).reason).toContain(reason);
	});

	const executing: Array<[string, string]> = [
		["a mapping pull_request", wf("  pull_request:\n    branches: [master]")],
		["the inline list spelling", "on: [push, pull_request]\njobs: {}\n"],
		["the scalar spelling", "on: pull_request\njobs: {}\n"],
		["the block-list spelling", "on:\n  - push\n  - pull_request\njobs: {}\n"],
		[
			"a paths filter naming the file (install-smoke shape)",
			wf(
				"  pull_request:\n    paths:\n      - '.github/workflows/stryker-nightly.yml'",
			),
		],
		[
			"a paths filter whose list sits at the key's indent",
			wf("  pull_request:\n    paths:\n    - '.github/workflows/*.yml'"),
		],
		[
			"a paths filter as a flow list",
			wf("  pull_request:\n    paths: ['.github/**']"),
		],
		[
			"an anchored push paths list aliased by pull_request (install-smoke shape)",
			wf(
				"  push:\n    paths: &p\n      - '.github/workflows/stryker-nightly.yml'\n  pull_request:\n    paths: *p",
			),
		],
		[
			"a types list with synchronize (ci-infra-kill-rerun shape)",
			wf("  pull_request:\n    types: [synchronize]"),
		],
		[
			"trailing comments and quoted on:",
			`name: x\n"on": # triggers\n  pull_request: # PRs\n    paths: [".github/**"] # self\njobs: {}\n`,
		],
	];
	it.each(executing)("an edit executes on %s", (_name, text) => {
		expect(classifyWorkflowEdit(text, FILE)).toEqual({ executes: true });
	});

	it("reads the pull_request_target and dispatch names a mapping declares", () => {
		const triggers = readWorkflowTriggers(
			wf(
				"  pull_request_target:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 3 * * *'",
			),
		);
		expect([...(triggers?.keys() ?? [])]).toEqual([
			"pull_request_target",
			"workflow_dispatch",
			"schedule",
		]);
	});
});

describe("evaluateWorkflowRunEvidence: the quoted branch run (#3085)", () => {
	const text = wf("  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:");
	const run = (
		body: string,
		changedFiles: string[] = [FILE],
		files: Record<string, string | null> = {},
		base: string | null = null,
	) =>
		evaluateWorkflowRunEvidence({
			changedFiles,
			body,
			readWorkflow: (file) => (file in files ? files[file] : text),
			readBaseWorkflow: () => base,
		});
	// A workflow with no workflow_dispatch trigger cannot be run on a branch.
	const noDispatch = { [FILE]: wf("  push:") };

	it("reds an edit with no quoted run", () => {
		const errors = run("## Tests\nTargeted tests pass.");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(FILE);
		expect(errors[0]).toContain(
			"gh workflow run stryker-nightly.yml --ref <branch>",
		);
	});

	it("passes a fenced command followed by its run id", () => {
		const body =
			"```text\n$ gh workflow run stryker-nightly.yml --ref test/x\n✓ Created workflow_dispatch event\nhttps://github.com/o/r/actions/runs/12345678901\n```";
		expect(run(body)).toEqual([]);
	});

	it("passes a `run id` line and the full workflow path", () => {
		expect(
			run(
				"gh workflow run .github/workflows/stryker-nightly.yml --ref b\nrun id: 98765432101",
			),
		).toEqual([]);
	});

	it("passes a quoted workflow name", () => {
		expect(
			run(
				'gh workflow run "stryker-nightly.yml" --ref b\nhttps://github.com/o/r/actions/runs/12345678901',
			),
		).toEqual([]);
	});

	it("reds the command with no run id", () => {
		expect(run("gh workflow run stryker-nightly.yml --ref b")).toHaveLength(1);
	});

	it("reds a run id with no command", () => {
		expect(
			run("see https://github.com/o/r/actions/runs/12345678901"),
		).toHaveLength(1);
	});

	it("reds the command without --ref", () => {
		expect(
			run(
				"gh workflow run stryker-nightly.yml\nhttps://github.com/o/r/actions/runs/12345678901",
			),
		).toHaveLength(1);
	});

	it("reds a run id beyond the window of the command", () => {
		const filler = Array.from({ length: 12 }, () => "unrelated").join("\n");
		expect(
			run(
				`gh workflow run stryker-nightly.yml --ref b\n${filler}\nhttps://github.com/o/r/actions/runs/12345678901`,
			),
		).toHaveLength(1);
	});

	it("reds evidence for a different workflow of the same name prefix", () => {
		expect(
			run(
				"gh workflow run stryker-nightly.yml.bak --ref b\nhttps://github.com/o/r/actions/runs/12345678901",
			),
		).toHaveLength(1);
	});

	it("does not accept evidence hidden in an HTML comment", () => {
		expect(
			run(
				"<!-- gh workflow run stryker-nightly.yml --ref b\nhttps://github.com/o/r/actions/runs/12345678901 -->",
			),
		).toHaveLength(1);
	});

	// Recurrence: PR #4020 round 1 accepted any prose after the dash, so an
	// edit of executable steps cleared the rule. The declaration is accepted only
	// when the check can verify it: no workflow_dispatch trigger, or an edit of
	// comments and blank lines.
	it("parses the declaration: needs the file name, a boundary and a reason (no-dispatch workflow)", () => {
		const declare = (line: string) => run(line, [FILE], noDispatch);
		expect(
			declare(
				"Workflow run unaffected: stryker-nightly.yml \u2014 comment-only edit.",
			),
		).toEqual([]);
		expect(
			declare("Workflow run unaffected: stryker-nightly.yml \u2014"),
		).toHaveLength(1);
		expect(
			declare("Workflow run unaffected: other.yml \u2014 comment-only edit."),
		).toHaveLength(1);
		// A longer name sharing the prefix must not declare this file unaffected.
		expect(
			declare(
				"Workflow run unaffected: stryker-nightly.yml-old \u2014 comment-only edit.",
			),
		).toHaveLength(1);
	});

	const DECLARATION =
		"Workflow run unaffected: stryker-nightly.yml \u2014 only a comment moved.";

	it("rejects a declaration for a dispatchable workflow whose executable steps changed", () => {
		const before = `${text}# old\n`;
		const after = text.replace(
			"runs-on: ubuntu-latest",
			"runs-on: macos-latest",
		);
		const errors = run(DECLARATION, [FILE], { [FILE]: after }, before);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(
			'"Workflow run unaffected" line is not accepted',
		);
		expect(errors[0]).toContain(
			"gh workflow run stryker-nightly.yml --ref <branch>",
		);
	});

	it("rejects a declaration for a dispatchable workflow with no base image (an added file)", () => {
		expect(run(DECLARATION)).toHaveLength(1);
	});

	it("accepts a declaration for a dispatchable workflow whose edit is comments and blank lines", () => {
		const after = `# new header\n${text}\n\n  # trailing note\n`;
		expect(run(DECLARATION, [FILE], { [FILE]: after }, text)).toEqual([]);
	});

	it("does not accept a comment-only edit with no declaration", () => {
		const after = `# new header\n${text}`;
		expect(run("nothing", [FILE], { [FILE]: after }, text)).toHaveLength(1);
	});

	it("accepts a declaration for a workflow with no workflow_dispatch trigger, with or without a base", () => {
		expect(run(DECLARATION, [FILE], noDispatch)).toEqual([]);
		expect(run(DECLARATION, [FILE], noDispatch, "on: push\n")).toEqual([]);
	});

	it("tells a no-dispatch workflow to declare or add the trigger", () => {
		const errors = run("nothing", [FILE], noDispatch);
		expect(errors[0]).toContain("no workflow_dispatch trigger");
		expect(errors[0]).toContain("Workflow run unaffected: stryker-nightly.yml");
	});

	it("requires evidence per changed workflow, not one for all", () => {
		const other = ".github/workflows/compat-smoke.yml";
		const body =
			"gh workflow run stryker-nightly.yml --ref b\nhttps://github.com/o/r/actions/runs/12345678901";
		const errors = run(body, [FILE, other]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(other);
	});

	it("skips a deleted workflow, a pull_request workflow and a non-workflow path", () => {
		expect(run("x", [FILE], { [FILE]: null })).toEqual([]);
		expect(run("x", [FILE], { [FILE]: wf("  pull_request:") })).toEqual([]);
		expect(
			run("x", [
				"scripts/stryker-nightly.yml",
				".github/workflows/sub/x.yml",
				".github/workflows/README.md",
			]),
		).toEqual([]);
	});
});

describe("isCommentOrWhitespaceOnlyEdit (#3085 round 2)", () => {
	const base = "on:\n  push:\njobs:\n  a:\n    steps:\n      - run: echo hi\n";
	it.each([
		["a whole-line comment added", `# c\n${base}`, true],
		[
			"blank lines and trailing blanks added",
			`${base}\n\n`.replace("hi", "hi  "),
			true,
		],
		[
			"a comment inside the steps removed",
			base.replace("      - run", "      # x\n      - run"),
			true,
		],
		["a step changed", base.replace("hi", "bye"), false],
		[
			"a trailing comment added to a content line",
			base.replace("hi", "hi # c"),
			false,
		],
		["indentation changed", base.replace("      - run", "     - run"), false],
		["a step added", `${base}      - run: echo more\n`, false],
	])("%s", (_name, after, expected) => {
		expect(isCommentOrWhitespaceOnlyEdit(base, after)).toBe(expected);
	});
	// Recurrence: PR #4020 round 2 ignored every whole-line `#`, so an added
	// `#!/bin/bash` heredoc line inside `run: |` read as a comment-only edit and
	// cleared the declaration for a changed shell payload.
	describe("block scalar bodies are payload, not comments (#3085 round 3)", () => {
		const scalar = (indicator: string) =>
			`on:\n  push:\njobs:\n  a:\n    steps:\n      - run: ${indicator}\n          echo hi\n          cat <<EOF\n          body\n          EOF\n      - run: echo after\n`;
		it.each(["|", ">", "|-", ">+", "|2", "|+ # keep", "&s |"])(
			"an added whole-line # inside a `%s` body is a change",
			(indicator) => {
				const before = scalar(indicator);
				const after = before.replace(
					"          echo hi\n",
					"          echo hi\n          #!/bin/bash\n",
				);
				expect(isCommentOrWhitespaceOnlyEdit(before, after)).toBe(false);
			},
		);
		it("a blank line added inside a body is a change", () => {
			const before = scalar("|");
			expect(
				isCommentOrWhitespaceOnlyEdit(
					before,
					before.replace("echo hi\n", "echo hi\n\n"),
				),
			).toBe(false);
		});
		it("a # line removed from a body is a change", () => {
			const before = scalar("|").replace(
				"echo hi\n",
				"echo hi\n          # x\n",
			);
			expect(isCommentOrWhitespaceOnlyEdit(before, scalar("|"))).toBe(false);
		});
		it("a list-item `- run: |` and a bare `key: |` both open a body", () => {
			const before = "jobs:\n  a:\n    run: |\n      echo hi\n";
			expect(
				isCommentOrWhitespaceOnlyEdit(
					before,
					before.replace("echo hi", "echo hi\n      # x"),
				),
			).toBe(false);
		});
		it("comments and blanks around the body stay comment-only", () => {
			const before = scalar("|");
			const after = `# header\n${before
				.replace("      - run: |", "      # note\n      - run: |")
				.replace(
					"      - run: echo after",
					"\n      # trailing\n\n      - run: echo after",
				)}`;
			expect(isCommentOrWhitespaceOnlyEdit(before, after)).toBe(true);
		});
		it("a comment less indented than the body ends it and stays comment-only", () => {
			const before = scalar("|");
			const after = before.replace(
				"          EOF\n",
				"          EOF\n    # after the body\n",
			);
			expect(isCommentOrWhitespaceOnlyEdit(before, after)).toBe(true);
		});
	});
	it("is false without a base image", () => {
		expect(isCommentOrWhitespaceOnlyEdit(null, base)).toBe(false);
		expect(isCommentOrWhitespaceOnlyEdit(undefined, base)).toBe(false);
	});
});

// Recurrence: PR #4020 round 1 read `pull_request: *pr` as an empty trigger, so
// a `types: [closed]` workflow (never runs on an open PR) avoided the rule.
describe("aliases in the on: block (#3085 round 2)", () => {
	const alias = (body: string) => wf(body);
	it("resolves an aliased trigger mapping: types [closed] never runs on a push (the review probe)", () => {
		const text = alias(
			"  defaults: &pr\n    types: [closed]\n  pull_request: *pr",
		);
		expect(readWorkflowTriggers(text)?.get("pull_request")).toEqual({
			types: ["closed"],
		});
		expect(classifyWorkflowEdit(text, FILE)).toMatchObject({
			executes: false,
			reason: expect.stringContaining("`types:` list"),
		});
	});
	it("resolves an aliased mapping whose paths name the file", () => {
		const text = alias(
			"  push: &p\n    paths:\n      - '.github/workflows/stryker-nightly.yml'\n  pull_request: *p",
		);
		expect(classifyWorkflowEdit(text, FILE)).toEqual({ executes: true });
	});
	it("resolves an aliased sequence of types", () => {
		const text = alias(
			"  workflow_run:\n    types: &t [closed]\n  pull_request:\n    types: *t",
		);
		expect(classifyWorkflowEdit(text, FILE)).toMatchObject({ executes: false });
	});
	it.each([
		["an alias of an anchor never defined", "  pull_request: *missing"],
		["an anchored flow mapping", "  pull_request: &pr {types: [closed]}"],
		[
			"a merge key in a trigger",
			"  base: &b\n    types: [closed]\n  pull_request:\n    <<: *b",
		],
		["a merge key on the on: block", "  <<: *b\n  push:"],
		["an alias list item", "  - *a"],
	])("fails closed on %s", (_name, body) => {
		const verdict = classifyWorkflowEdit(alias(body), FILE);
		expect(verdict).toMatchObject({ executes: false });
	});
	it("fails closed on an alias or anchor of the whole on: value", () => {
		expect(readWorkflowTriggers("on: *x\njobs: {}\n")).toBeNull();
		expect(readWorkflowTriggers("on: &x\n  push:\njobs: {}\n")).toBeNull();
	});
});
