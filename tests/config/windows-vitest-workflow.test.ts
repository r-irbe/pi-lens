import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/ci.yml");

type Step = {
	name?: string;
	uses?: string;
	run?: string;
	shell?: string;
	id?: string;
	if?: string;
	"continue-on-error"?: boolean;
};
type Job = {
	name?: string;
	"runs-on"?: string;
	"continue-on-error"?: boolean;
	"timeout-minutes"?: number;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	steps?: Step[];
};

function readWorkflow(): { jobs: Record<string, Job> } {
	return yaml.load(readFileSync(WORKFLOW_PATH, "utf8")) as {
		jobs: Record<string, Job>;
	};
}

describe("Windows Vitest workflow contract (#2536)", () => {
	it("keeps the Windows subset lane present, bounded, and advisory", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		expect(job?.name).toBe("Unit tests Windows (advisory)");
		expect(job?.["runs-on"]).toBe("windows-latest");
		expect(job?.["continue-on-error"]).toBeUndefined();
		expect(job?.["timeout-minutes"]).toBe(25);
		expect(job?.outputs?.windows_vitest).toBe(
			"${{ steps.windows-vitest.outcome }}",
		);
		expect(job?.permissions).toEqual({ contents: "read" });
	});

	it("keeps dynamic Windows enumeration and the runner command wired", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const enumeration = steps.find(
			(step) => step.name === "Enumerate Windows Vitest subset",
		);
		const runner = steps.find(
			(step) => step.name === "Run Windows Vitest subset",
		);
		const outcome = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);

		// Recurrence: #2536's Windows-only tests were present but had no CI
		// consumer; deleting either population source would silently recreate it.
		expect(enumeration?.shell).toBe("bash");
		expect(enumeration?.run).toContain(
			"node scripts/lib/win32-gate-population.mjs --files",
		);
		expect(enumeration?.run).not.toMatch(/git grep/);
		expect(enumeration?.run).toContain("${#FILES[@]} -eq 0");
		expect(raw).toContain("win32-gate-population.mjs --summary");
		expect(runner?.run).toContain("--configLoader runner");
		expect(runner?.id).toBe("windows-vitest");
		expect(runner?.["continue-on-error"]).toBe(true);
		expect(outcome?.if).toBe("always()");
		expect(raw).toContain("on 7 consecutive master/PR runs");
		expect(raw).toContain("Windows Vitest subset step outcome:");
		expect(raw).toContain("windows_vitest=$outcome");
		expect(raw).toContain("PI_LENS_TEST_TIMEOUT_SCALE: '3'");
	});

	// #3926: a failed checkout leaves no repository and the enumeration step is
	// skipped, so the summary must not invoke the checked-out population script;
	// it reports "Not executed" and still writes the outcome keys the job output
	// reads. The node invocation stays inside the list-present branch.
	it("guards the Windows summary on the executed-file list", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const outcome = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const run = String(outcome?.run ?? "");
		expect(outcome?.if).toBe("always()");
		const guard = run.indexOf('[ -f "$RUNNER_TEMP/windows-vitest-files.txt" ]');
		const population = run.indexOf("win32-gate-population.mjs --summary");
		const unavailable = run.indexOf("Not executed");
		const key = run.indexOf("windows_vitest=$outcome");
		expect(guard).toBeGreaterThan(-1);
		expect(population).toBeGreaterThan(guard);
		expect(unavailable).toBeGreaterThan(population);
		expect(key).toBeGreaterThan(-1);
	});

	it("publishes a visible red after recording the failed Vitest count", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		const record = steps.find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = steps.find(
			(step) => step.name === "Fail Windows advisory when Vitest fails",
		);

		// Recurrence: #4019's continue-on-error made 56 failed Windows tests read
		// as a green job, hiding the red from both reviewers and ci-verdict.
		expect(record?.run).toContain(
			'windows-vitest-failure-count.mjs "$RUNNER_TEMP/windows-vitest.log"',
		);
		expect(record?.run).toContain("Windows Vitest failures:");
		expect(failure?.if).toBe("always()");
		expect(failure?.run).toContain("steps.windows-vitest.outcome");
		expect(failure?.run).toContain("exit 1");
		expect(raw).toContain("continue-on-error: true");
	});

	// Recurrence: #4042 review F1 — a Vitest crash creates an empty log, so an
	// absent summary must stay visibly unavailable rather than becoming zero.
	it("reports an unknown count when Vitest emits no summary", () => {
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		const job = readWorkflow().jobs["unit-tests-windows"];
		const record = (job?.steps ?? []).find(
			(step) => step.name === "Record Windows Vitest outcome",
		);
		const failure = (job?.steps ?? []).find(
			(step) => step.name === "Fail Windows advisory when Vitest fails",
		);
		expect(record?.run).toContain(
			"Windows Vitest failures: ${failures:-unknown}",
		);
		expect(failure?.run).toContain("${failures:-unknown} Vitest tests failed");
		expect(raw).not.toContain("Windows Vitest failures: ${failures:-0}");
	});

	it("pins the sibling action revisions and the isolated home", () => {
		const job = readWorkflow().jobs["unit-tests-windows"];
		const steps = job?.steps ?? [];
		expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
			"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
			"actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
		]);
		const raw = readFileSync(WORKFLOW_PATH, "utf8");
		expect(raw).toContain(
			'PI_LENS_HOME=$RUNNER_TEMP/pi-lens-home" >> "$GITHUB_ENV"',
		);
		expect(raw).toContain("npm ci --no-audit --no-fund");
		expect(raw).toContain("npm run build");
	});
});
