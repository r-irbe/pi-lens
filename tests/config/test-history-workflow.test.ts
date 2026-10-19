import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	METADATA_FILENAME,
	rowsFromArtifacts,
} from "../../scripts/test-history-rollup.mjs";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";

const root = path.resolve(import.meta.dirname, "../..");
const load = (file: string) =>
	yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as Record<
		string,
		unknown
	>;

function steps(workflow: string, job: string) {
	const jobs = load(workflow).jobs as Record<string, unknown>;
	const target = jobs[job] as Record<string, unknown>;
	if (!target) throw new Error(`${workflow} has no ${job} job`);
	return target.steps as Array<Record<string, unknown>>;
}

function step(workflow: string, job: string, name: string) {
	const found = steps(workflow, job).find((entry) => entry.name === name);
	if (!found) throw new Error(`${workflow}#${job} has no "${name}" step`);
	return found;
}

describe("#3215 durable test-history workflow contract", () => {
	it("pins the reporter flags and the Linux artifact", () => {
		const command = String(
			step(".github/workflows/ci.yml", "test", "Run tests").run,
		);
		expect(command).toContain("--reporter=default");
		expect(command).toContain("--reporter=json");
		expect(command).toContain("--outputFile=");
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const uploadWith = upload.with as Record<string, unknown>;
		// #3753: one artifact per Unit tests shard; the unsuffixed name is the
		// pre-sharding one (tests/config/unit-tests-shard-workflow.test.ts pins
		// the nightly's download list against the matrix).
		expect(uploadWith.name).toBe(
			"unit-test-results-linux-shard-${{ matrix.shard }}",
		);
		expect(upload.if).toBe("always()");
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		const metadataEnv = metadata.env as Record<string, unknown>;
		expect(metadataEnv.HEAD_SHA).toContain(
			"github.event.pull_request.head.sha",
		);
	});

	// Round 3 F8: the producer wrote and uploaded `test-history-metadata.json`
	// while `scripts/test-history-rollup.mjs` looked for a sibling
	// `metadata.json`, so the nightly rollup exited 2 on every real artifact and
	// lane 1 never wrote a row. The consumer's own exported constant is the one
	// source of truth, and both producer steps are asserted against it here —
	// not against a second copy of the string.
	it("writes and uploads exactly the basename the rollup consumer reads", () => {
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		expect(String(metadata.run)).toContain(`/${METADATA_FILENAME}`);
		const upload = step(
			".github/workflows/ci.yml",
			"test",
			"Upload per-file test results",
		);
		const paths = String((upload.with as Record<string, unknown>).path)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		expect(paths.map((entry) => path.posix.basename(entry))).toEqual([
			"vitest-results.json",
			METADATA_FILENAME,
		]);
	});

	// #3447: a re-run keeps its run id, so the attempt is what tells a failure
	// and its passing re-run apart in the journal. Runs the step's own
	// `node -e` program in process (no child spawn) under the env GitHub sets,
	// then hands what it wrote to the real consumer.
	it("records the run attempt the rollup keys re-runs by", async () => {
		const metadata = step(
			".github/workflows/ci.yml",
			"test",
			"Write test-history artifact metadata",
		);
		const program = /^node -e "([\s\S]*)"$/.exec(String(metadata.run).trim());
		if (!program) throw new Error("metadata step is not a `node -e` program");
		const temp = setupTestEnvironment("pi-lens-history-metadata-").tmpDir;
		try {
			const env = {
				RUNNER_TEMP: temp,
				HEAD_SHA: "c".repeat(40),
				GITHUB_RUN_ID: "36132594277",
				GITHUB_RUN_ATTEMPT: "2",
			};
			new Function("require", "process", program[1].replaceAll('\\"', '"'))(
				createRequire(import.meta.url),
				{ env },
			);
			fs.writeFileSync(
				path.join(temp, "vitest-results.json"),
				JSON.stringify({
					testResults: [{ name: "tests/x.test.ts", status: "passed" }],
				}),
			);
			const [row] = rowsFromArtifacts([temp]);
			expect(row).toMatchObject({
				headSha: env.HEAD_SHA,
				runId: env.GITHUB_RUN_ID,
				runAttempt: "2",
			});
		} finally {
			await cleanupTestEnvironmentsDrained("pi-lens-history-metadata-");
		}
	});

	// The additive `JSON report written to ...` line is CI-only: the local
	// `npm test` script must add no JSON reporter, so a developer's console
	// stream is untouched. The line's exact text and cardinality are pinned by
	// driving the real vitest JsonReporter in
	// `tests/scripts/test-history-rollup.test.ts`.
	it("keeps the JSON reporter out of the local npm test script", () => {
		const { scripts } = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(scripts.test).not.toContain("--reporter=json");
		expect(scripts.test).not.toContain("--outputFile");
	});

	// Recurrence: #4077, `contents: write` on the job that downloads and runs
	// unreviewed rollup code, so a branch dispatch held a token that could push
	// `data/test-history`. The rollup is read-only; the push is its own job.
	it("runs the rollup job from the nightly and from a dispatch, with read-only access", () => {
		const workflow = load(".github/workflows/tool-smoke.yml");
		const jobs = workflow.jobs as Record<string, unknown>;
		const rollup = jobs["test-history-rollup"] as Record<string, unknown>;
		expect(rollup.if).toBe(
			"github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
		);
		expect(rollup.permissions).toEqual({ actions: "read", contents: "read" });
	});
});

/**
 * #4030 review F1: the rollup job ran on any dispatched ref and its one step
 * pushed `data/test-history`, so a branch dispatch (run 37592572019) reached
 * the push with unreviewed rollup code; only GitHub's 100 MB limit stopped it.
 * #4077 split it: the rollup job only downloads and rolls up (any ref), the
 * push is `test-history-publish` (contents: write, schedule or master) and the
 * red-night issue is `test-history-notify` (issues: write, schedule or master).
 */
describe("test-history publish and notify scope (#4030, #4077)", () => {
	const PUBLISH_IF =
		"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";
	const NOTIFY_IF = `always() && (${PUBLISH_IF})`;
	const WORKFLOW = ".github/workflows/tool-smoke.yml";
	const jobsOf = () =>
		load(WORKFLOW).jobs as Record<string, Record<string, unknown>>;
	const rollupSteps = () => steps(WORKFLOW, "test-history-rollup");
	const publishSteps = () => steps(WORKFLOW, "test-history-publish");
	// Text a step runs, comments and quoted strings included: a push spelled
	// anywhere in a run block is a push.
	const runOf = (entry: Record<string, unknown>) => String(entry.run ?? "");

	it("pushes the data branch from exactly one step of one guarded job", () => {
		const pushing = Object.entries(jobsOf()).flatMap(([job, body]) =>
			(body.steps as Array<Record<string, unknown>>)
				.filter((entry) => /\bgit\s+push\b/.test(runOf(entry)))
				.map((entry) => `${job}/${entry.name}`),
		);
		expect(pushing).toEqual(["test-history-publish/Publish data branch"]);
		const publish = jobsOf()["test-history-publish"];
		expect(publish.if).toBe(PUBLISH_IF);
		expect(publish.needs).toBe("test-history-rollup");
		expect(publish.permissions).toEqual({ contents: "write" });
		expect(
			runOf(
				publishSteps().find((entry) => entry.name === "Publish data branch") ??
					{},
			),
		).toContain("HEAD:data/test-history");
	});

	it("rolls up on every ref without touching the data branch", () => {
		const dry = step(WORKFLOW, "test-history-rollup", "Roll up test history");
		expect(dry.if).toBeUndefined();
		expect(runOf(dry)).toContain("test-history-rollup.mjs");
		expect(runOf(dry)).not.toMatch(/\bgit\s+(push|checkout|commit)\b/);
		for (const entry of rollupSteps())
			expect(runOf(entry)).not.toMatch(/\bgit\s+push\b/);
	});

	it("downloads incrementally after the journal's watermark", () => {
		const watermark = step(
			WORKFLOW,
			"test-history-rollup",
			"Read the history watermark",
		);
		expect(watermark.id).toBe("watermark");
		expect(runOf(watermark)).toContain("--print-watermark");
		// Day lines first; the raw journal only as the one-time migration input.
		expect(runOf(watermark).indexOf("history/test-daily.ndjson")).toBeLessThan(
			runOf(watermark).indexOf("history/test-results.ndjson"),
		);
		const download = step(
			WORKFLOW,
			"test-history-rollup",
			"Download unit-test result artifacts",
		);
		expect((download.env as Record<string, unknown>).SINCE).toBe(
			"${{ steps.watermark.outputs.since }}",
		);
		expect(runOf(download)).toContain('--since "$SINCE"');
	});

	// Recurrence: #4077, an artifact name or path that drifts between the
	// rollup's upload and the publish job's download hands the push an empty
	// artifact dir, which rolls up nothing and still pushes a green night.
	it("hands the downloaded results to the publish job under one artifact name and root", () => {
		const upload = rollupSteps().at(-1) as Record<string, unknown>;
		const uploadWith = upload.with as Record<string, unknown>;
		expect(String(upload.uses)).toContain("actions/upload-artifact@");
		expect(uploadWith.name).toBe("test-history-ingest");
		expect(String(uploadWith.path)).toContain(
			"${{ runner.temp }}/test-history-artifacts",
		);
		const download = publishSteps().find(
			(entry) =>
				entry.uses && String(entry.uses).includes("download-artifact@"),
		) as Record<string, unknown>;
		expect((download.with as Record<string, unknown>).name).toBe(
			uploadWith.name,
		);
		// The artifact keeps paths relative to the runner temp root, where the
		// publish step reads `--artifact-dir`.
		expect((download.with as Record<string, unknown>).path).toBe(
			"${{ runner.temp }}",
		);
		expect(
			runOf(
				publishSteps().find((entry) => entry.name === "Publish data branch") ??
					{},
			),
		).toContain('--artifact-dir "$RUNNER_TEMP/test-history-artifacts"');
	});

	// Recurrence: #4076 verify r3 F1. On a night with no new CI artifacts the
	// producer's `test-history-artifacts/` is empty and upload-artifact drops an
	// empty directory, so the publish job's download holds only the manifest;
	// `test-history-rollup.mjs --artifact-dir <missing>` then exits 2 and the
	// notifier files a false "rollup red" issue.
	it("creates the artifact directory in the publish job before the rollup reads it", () => {
		const publish = runOf(
			step(WORKFLOW, "test-history-publish", "Publish data branch"),
		);
		const mkdirAt = publish.indexOf(
			'mkdir -p "$RUNNER_TEMP/test-history-artifacts"',
		);
		expect(mkdirAt).toBeGreaterThanOrEqual(0);
		expect(mkdirAt).toBeLessThan(publish.indexOf("test-history-rollup.mjs"));
	});

	it("publishes day lines and retires the raw journal", () => {
		const publish = runOf(
			step(WORKFLOW, "test-history-publish", "Publish data branch"),
		);
		expect(publish).toContain("history/test-daily.ndjson");
		expect(publish).toContain(
			"git rm -q --ignore-unmatch history/test-results.ndjson",
		);
	});

	// #4030 detection retrospective: six red nights were never alerted because
	// the tool-smoke notifier reads only the tool-smoke job.
	it("files, refreshes and closes a tracking issue for a red rollup or publish, from its own job", () => {
		const notifyJob = jobsOf()["test-history-notify"];
		expect(notifyJob.if).toBe(NOTIFY_IF);
		expect(notifyJob.needs).toEqual([
			"test-history-rollup",
			"test-history-publish",
		]);
		expect(notifyJob.permissions).toEqual({
			contents: "read",
			issues: "write",
		});
		expect(notifyJob["continue-on-error"]).toBe(true);
		const all = steps(WORKFLOW, "test-history-notify");
		const notify = all.at(-1) as Record<string, unknown>;
		expect(notify.name).toBe(
			"Notify on test-history rollup red (file/update/close tracking issue)",
		);
		const env = notify.env as Record<string, unknown>;
		expect(env.ROLLUP_RESULT).toBe("${{ needs.test-history-rollup.result }}");
		expect(env.PUBLISH_RESULT).toBe("${{ needs.test-history-publish.result }}");
		const run = runOf(notify);
		// Red when either job failed; closed only when BOTH succeeded (a
		// cancelled rollup skips the publish and must not close the issue).
		expect(run).toContain(
			'[ "$ROLLUP_RESULT" = failure ] || [ "$PUBLISH_RESULT" = failure ]',
		);
		expect(run).toContain(
			'[ "$ROLLUP_RESULT" = success ] && [ "$PUBLISH_RESULT" = success ]',
		);
		expect(run).toMatch(
			/node "\$cli" --title "\$TITLE" --label nightly-drift --body-file/,
		);
		expect(run).toMatch(
			/node "\$cli" --title "\$TITLE" --label nightly-drift --clean --close-when-clean/,
		);
		// The notify job does not check out the data branch, so the CLI runs from
		// its own checkout; the publish job still stages the scripts first.
		expect(run).toContain("cli=scripts/upsert-tracking-issue.mjs");
		expect(
			runOf(step(WORKFLOW, "test-history-publish", "Stage the rollup scripts")),
		).toContain('cp -r scripts "$RUNNER_TEMP/history-scripts"');
		const publishNames = publishSteps().map((entry) => entry.name);
		expect(publishNames.indexOf("Stage the rollup scripts")).toBeLessThan(
			publishNames.indexOf("Publish data branch"),
		);
	});
});
