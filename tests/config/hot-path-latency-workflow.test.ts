// Pins the #4363 hot-path latency lane to its workflow-level contract. The real
// YAML is loaded, so each assertion reds on the edit that would break it.
//
// Recurrences this prevents:
//  - the lane's streak (10 consecutive green master push runs before it may
//    gate) reads the RUN conclusion. A `continue-on-error` job concludes success
//    on a regression, so the streak would count a red as green;
//  - an Actions cache added to the lane: the repository sits at its 10 GB cap
//    (#4358) and every cache write evicts an entry CI needs;
//  - the script's own time budget raised past the job cap, which would let a
//    hung sample end as a cancelled run instead of a harness failure;
//  - the pull_request and push path filters drifting apart, so master runs a
//    different population than the PRs it is compared with.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	DEFAULT_BUDGET_MS,
	DEFAULT_RUNS,
} from "../../scripts/check-hot-path-latency.mjs";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import { stripSource } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
type Step = {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
};
const workflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/hot-path-latency.yml"), "utf8"),
) as {
	on: {
		pull_request: { paths: string[] };
		push: { branches: string[]; paths: string[] };
	};
	permissions: unknown;
	concurrency: { group: string; "cancel-in-progress": unknown };
	jobs: Record<
		string,
		{
			name: string;
			"continue-on-error"?: unknown;
			"timeout-minutes": number;
			permissions: Record<string, string>;
			steps: Step[];
		}
	>;
};
const job = workflow.jobs.latency;

describe("hot-path latency workflow (#4363)", () => {
	it("is named advisory and keeps a truthful run conclusion", () => {
		expect(isAdvisoryCheck(job.name)).toBe(true);
		expect(job["continue-on-error"]).toBeUndefined();
	});

	it("uses no Actions cache (#4358)", () => {
		for (const step of job.steps) {
			expect(step.uses ?? "").not.toMatch(/actions\/cache/);
			expect(step.with?.cache).toBeUndefined();
		}
	});

	it("bounds the script's own budget at half the job cap", () => {
		expect(DEFAULT_BUDGET_MS / 60_000).toBeLessThanOrEqual(
			job["timeout-minutes"] / 2,
		);
	});

	it("runs on the same paths for pull requests and master pushes", () => {
		expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths);
		expect(workflow.on.push.branches).toEqual(["master"]);
		expect(workflow.on.pull_request.paths).toEqual(
			expect.arrayContaining([
				"clients/**",
				"index.ts",
				"scripts/hot-path-sample.mjs",
				"scripts/check-hot-path-latency.mjs",
				".github/workflows/hot-path-latency.yml",
			]),
		);
	});

	it("is read-only and runs the gate script over two built trees", () => {
		expect(workflow.permissions).toEqual({});
		expect(job.permissions).toEqual({ contents: "read" });
		const runs = job.steps.map((s) => s.run ?? "").join("\n");
		expect(runs).toMatch(/node scripts\/check-hot-path-latency\.mjs/);
		expect(runs.match(/npm run build/g)).toHaveLength(2);
		// The base is the checked-out commit's first parent: master's tip on a
		// pull request's merge ref, the previous commit on a push.
		expect(runs).toContain("git rev-parse HEAD^1");
	});

	it("pins the sample count the false-red argument rests on", () => {
		// Recurrence (review r1 F1): `--runs 5` survived the suite, and N=5 fails
		// about four times as often as N=15 at 20 percent runner spread.
		const gate = job.steps.find((s) =>
			s.run?.includes("check-hot-path-latency"),
		);
		expect(gate?.run).toContain(`--runs ${DEFAULT_RUNS}`);
		expect(DEFAULT_RUNS).toBe(15);
	});

	it("keeps the lane-defining checkout and install lines", () => {
		// Recurrence (review r1 F4): each of these edits survived the suite.
		// Depth 1 makes `HEAD^1` fail, so the lane would red on every run.
		const checkout = job.steps.find((s) =>
			s.uses?.startsWith("actions/checkout@"),
		);
		expect(checkout?.with?.["fetch-depth"]).toBe(2);
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		const install = job.steps.find((s) => s.name === "Install dependencies");
		expect(install?.run).toContain("npm ci");
		expect(install?.run).toContain("--ignore-scripts");
	});

	it("keys master-push runs on the commit so a merge train cancels none", () => {
		// Recurrence (review r1 F3): GitHub cancels a PENDING run when a newer one
		// queues in the same group, even with cancel-in-progress false. A cancelled
		// master run reads as not green in the 10-green flip command.
		const { group } = workflow.concurrency;
		expect(group).toContain("github.sha");
		expect(group).toContain(
			"github.event_name == 'pull_request' && github.ref",
		);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(
			"${{ github.event_name == 'pull_request' }}",
		);
	});
});

describe("hot-path sampler scope (#4363)", () => {
	const sampler = stripSource(
		readFileSync(resolve(ROOT, "scripts/hot-path-sample.mjs"), "utf8"),
		{ strings: "keep" },
	);

	it("turns the lsp runner and tool installs off for dispatch", () => {
		// Recurrence (review r1 F4, c1): with `no-lsp` false a language server's
		// time enters dispatch_small and dispatch_large, which is neither pi-lens's
		// nor repeatable (5.4 s, 10.4 s and 1.5 s in one probe).
		expect(sampler).toMatch(
			/flags\.set\("no-lsp", true\);\s*const \{ dispatchLint \}/,
		);
		expect(sampler).toContain('process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1"');
	});
});
