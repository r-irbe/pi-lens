/**
 * Nightly snapshot-persist drift check (#3916, recurrence of #3789).
 *
 * Recurrences this file prevents:
 *  - the #3789 shape itself: a change puts a structured clone (or a second
 *    serialization) back on the worker persist path and nothing on master
 *    notices until a user reports the RSS spike. The threshold tests read the
 *    raw bench reports of the cloning tree (4.3.0) and of the fixed tree and
 *    require the committed threshold to separate them with a margin, so a
 *    threshold edit that no longer separates the measured trees reds here;
 *  - a threshold loosened (or tightened) without a measurement behind it;
 *  - one noisy first persist deciding a nightly (round 2: the first hosted
 *    sample, 1.822, sat at the dev box's healthy ceiling of 1.831), so the
 *    verdict is the median of five independent samples and a single outlier
 *    must not flip it either way;
 *  - an unusable measurement going red with no tracking issue (round 2), and
 *    a provisional threshold presented as settled (round 2);
 *  - the nightly job rewired so it no longer reds on drift, reaches the
 *    tracking issue through a second mechanism, or widens its permissions.
 *
 * It never re-measures: an RSS assertion on a shared CI runner would flake.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	buildIssueBody,
	DRIFT_THRESHOLD,
	evaluate,
	firstPersistRatio,
	HOSTED_NIGHTS_BEFORE_RECALIBRATION,
	main,
	SAMPLE_COUNT,
} from "../../scripts/check-snapshot-persist-ratio.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const fixture = (name: string) =>
	JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures", name), "utf8"));

interface Report {
	results: { mode: string; runs: { persist: number; rssJumpMB: number }[] }[];
}
const calibration = fixture("snapshot-persist-nightly-calibration.json") as {
	healthy: Report[];
	regressed: Report[];
};
const measurement = fixture("snapshot-persist-measurement.json") as {
	rounds: { before: Report[]; after: Report[] };
};
const healthy = [...calibration.healthy, ...measurement.rounds.after];
const regressed = [...calibration.regressed, ...measurement.rounds.before];

const one = (r: Report) => evaluate([r], { samples: 1 });
const five = (...ratios: number[]) =>
	evaluate(ratios.map((ratio) => report(ratio * 100, 100)));
const report = (workerMB: number, syncMB: number): Report => ({
	results: [
		{ mode: "worker", runs: [{ persist: 0, rssJumpMB: workerMB }] },
		{ mode: "sync", runs: [{ persist: 0, rssJumpMB: syncMB }] },
	],
});

describe("DRIFT_THRESHOLD separates the measured trees (#3916)", () => {
	it("holds the measured populations the constant was chosen from", () => {
		expect(healthy).toHaveLength(11);
		expect(regressed).toHaveLength(9);
	});

	it("sits at least 5% above every fixed-tree run and 5% below every cloning-tree run", () => {
		const healthyWorst = Math.max(
			...healthy.map((r) => firstPersistRatio(r).ratio),
		);
		const regressedBest = Math.min(
			...regressed.map((r) => firstPersistRatio(r).ratio),
		);
		expect(DRIFT_THRESHOLD).toBeGreaterThanOrEqual(healthyWorst * 1.05);
		expect(DRIFT_THRESHOLD).toBeLessThanOrEqual(regressedBest / 1.05);
	});

	it("calls every fixed-tree run clean and every cloning-tree run drift", () => {
		expect(healthy.map((r) => one(r).state)).toEqual(
			healthy.map(() => "clean"),
		);
		expect(regressed.map((r) => one(r).state)).toEqual(
			regressed.map(() => "drift"),
		);
	});
});

describe("evaluate", () => {
	it("treats a median exactly at the threshold as clean and anything above as drift", () => {
		const t = DRIFT_THRESHOLD;
		expect(five(t, t, t, t, t).state).toBe("clean");
		expect(five(t + 0.01, t + 0.01, t + 0.01, t + 0.01, t + 0.01).state).toBe(
			"drift",
		);
	});

	it("lets one outlier sample flip the verdict in neither direction", () => {
		// Round 2: a healthy worker spiked once (146-149 MB, ratio 1.54-1.60) in
		// 2 of 8 local runs, and a single clone-shaped sample must not red a
		// healthy night; four cloning samples and one lucky low sample must not
		// pass a regressed night.
		expect(five(1.8, 1.8, 1.8, 1.8, 3.5).state).toBe("clean");
		expect(five(2.3, 2.3, 2.3, 2.3, 1.2).state).toBe("drift");
		expect(five(1.8, 1.8, 3.5, 3.5, 3.5).state).toBe("drift");
		expect(five(2.3, 2.3, 1.2, 1.2, 1.2).state).toBe("clean");
	});

	it("reports the median, min and max of the sample ratios, not the mean", () => {
		const verdict = five(1.5, 1.7, 1.8, 1.9, 4.0);
		expect(verdict.median).toBeCloseTo(1.8, 10);
		expect(verdict.min).toBeCloseTo(1.5, 10);
		expect(verdict.max).toBeCloseTo(4.0, 10);
		expect(verdict.samples).toHaveLength(5);
	});

	it("reads persist 0, not a later persist", () => {
		const warm = report(100, 100);
		warm.results[0].runs.push({ persist: 1, rssJumpMB: 900 });
		expect(one(warm)).toMatchObject({ state: "clean", median: 1 });
	});

	it("requires SAMPLE_COUNT independent reports", () => {
		expect(SAMPLE_COUNT).toBe(5);
		const four = evaluate(Array.from({ length: 4 }, () => report(100, 100)));
		expect(four.state).toBe("error");
		expect(four.reason).toContain("need 5 independent bench reports, got 4");
	});

	it.each([
		["no results", {}],
		["no sync result", { results: [report(100, 100).results[0]] }],
		[
			"no persist 0",
			{
				results: [
					{ mode: "worker", runs: [{ persist: 1, rssJumpMB: 9 }] },
					report(1, 1).results[1],
				],
			},
		],
		["a zero sync jump", report(100, 0)],
		["a non-numeric jump", report(Number.NaN, 100)],
	])(
		"reports an unusable sample (%s) as error, never as a verdict",
		(_name, bad) => {
			const verdict = evaluate([
				bad,
				...Array.from({ length: 4 }, () => report(100, 100)),
			]);
			expect(verdict.state).toBe("error");
			expect(verdict.reason).toContain("sample 1:");
			expect(verdict.reason).toContain("persist 0");
		},
	);
});

describe("main (the CLI the workflow runs)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});
	/** One bench report per entry; a string is written verbatim, null is never written. */
	const run = (benches: (unknown | null)[], extra: string[] = []) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-snapshot-ratio-"));
		dirs.push(dir);
		const body = join(dir, "out", "issue.md");
		const state = join(dir, "out", "state");
		mkdirSync(join(dir, "out"));
		const reportArgs = benches.flatMap((bench, index) => {
			const reportPath = join(dir, `report-${index + 1}.json`);
			if (bench !== null) {
				writeFileSync(
					reportPath,
					typeof bench === "string" ? bench : JSON.stringify(bench),
				);
			}
			return ["--report", reportPath];
		});
		writeFileSync(body, "stale body from an earlier night");
		const lines: string[] = [];
		const code = main(
			[...reportArgs, "--body", body, "--state", state, ...extra],
			(line: string) => lines.push(line),
		);
		const read = (path: string) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		};
		return { code, lines, body: read(body), state: read(state)?.trim() };
	};
	const samples = (list: Report[], count = SAMPLE_COUNT) =>
		Array.from({ length: count }, (_, i) => list[i % list.length]);

	it("drift: exit 1, state drift, a body with median/min/max, the run URL and the provisional note", () => {
		const out = run(samples(regressed), [
			"--run-url",
			"https://example.invalid/run/1",
		]);
		expect(out.code).toBe(1);
		expect(out.state).toBe("drift");
		expect(out.body).toContain(String(DRIFT_THRESHOLD));
		expect(out.body).toMatch(
			/median .*\*\*2\.\d{3}\*\* \(min 2\.\d{3}, max 2\.\d{3}/,
		);
		expect(out.body).toContain("https://example.invalid/run/1");
		expect(out.body).toContain("PROVISIONAL");
		expect(out.body).toContain(
			`re-calibrated after ${HOSTED_NIGHTS_BEFORE_RECALIBRATION} hosted nights`,
		);
		expect(out.lines.join("\n")).toContain("::error::");
	});

	it("clean: exit 0, state clean, the log line carries median/min/max, and a stale body is removed", () => {
		const out = run(samples(healthy));
		expect(out.code).toBe(0);
		expect(out.state).toBe("clean");
		expect(out.body).toBeUndefined();
		expect(out.lines.join("\n")).toMatch(
			/snapshot-persist ratio: clean median=1\.\d{3} min=1\.\d{3} max=1\.\d{3} n=5 threshold=1\.95 \(PROVISIONAL\)/,
		);
	});

	it("one cloning-shaped sample among five healthy ones stays clean through the real CLI", () => {
		const out = run([...samples(healthy, 4), regressed[0]]);
		expect(out.code).toBe(0);
		expect(out.state).toBe("clean");
	});

	it("unusable measurement: exit 2, state error, and the issue body carries the reason", () => {
		// Round 2: exit 2 used to go red with no tracking issue; the body is what
		// the notifier upserts.
		const cases: [string, (unknown | null)[]][] = [
			["not json", [...samples(healthy, 4), "not json"]],
			["empty report", [...samples(healthy, 4), {}]],
			["a missing report file", [...samples(healthy, 4), null]],
			["too few reports", samples(healthy, 3)],
		];
		for (const [name, benches] of cases) {
			const out = run(benches);
			expect(out.code, name).toBe(2);
			expect(out.state, name).toBe("error");
			expect(out.body, name).toContain("unusable tonight");
			expect(out.body, name).toContain("Reason:");
			expect(out.body, name).toContain("PROVISIONAL");
			expect(out.body, name).not.toContain("stale body");
		}
		expect(run([...samples(healthy, 4), null]).body).toContain("cannot read");
		expect(run(samples(healthy, 3)).body).toContain("need 5 independent");
	});

	it("requires --report", () => {
		expect(() => main([], () => {})).toThrow("--report is required");
	});
});

describe("buildIssueBody", () => {
	it("states the median, min, max, threshold and runner", () => {
		const verdict = five(2.2, 2.4, 2.5, 2.6, 3.0);
		const body = buildIssueBody(verdict, {
			report: { node: "v22.1.0", platform: "linux x64" },
		});
		expect(body).toContain("**2.500** (min 2.200, max 3.000;");
		expect(body).toContain(`**${DRIFT_THRESHOLD}**`);
		expect(body).toContain("v22.1.0 on linux x64");
	});

	it("marks the threshold provisional and names the recalibration point in drift and error bodies", () => {
		for (const verdict of [five(2.5, 2.5, 2.5, 2.5, 2.5), evaluate([])]) {
			const body = buildIssueBody(verdict);
			expect(body).toContain("**The threshold is PROVISIONAL.**");
			expect(body).toContain("after 7 hosted nights");
		}
		expect(HOSTED_NIGHTS_BEFORE_RECALIBRATION).toBe(7);
	});
});

describe("tool-smoke.yml snapshot-persist-bench wiring (#3916)", () => {
	type Step = {
		name?: string;
		id?: string;
		if?: string;
		run?: string;
		"continue-on-error"?: boolean;
		"timeout-minutes"?: number;
	};
	type Job = {
		if?: string;
		needs?: string;
		"continue-on-error"?: boolean;
		permissions?: Record<string, string>;
		"timeout-minutes"?: number;
		steps: Step[];
	};
	const source = readFileSync(
		resolve(ROOT, ".github/workflows/tool-smoke.yml"),
		"utf8",
	);
	const jobs = (yaml.load(source) as { jobs: Record<string, Job> }).jobs;
	const job = jobs["snapshot-persist-bench"];
	// #4077: the bench job is read-only; the tracking issue is the writer job's.
	const writer = jobs["snapshot-persist-notify"];
	const step = (needle: string, from: Job = job) => {
		const found = from.steps.find((candidate) =>
			String(candidate.run ?? "").includes(needle),
		);
		if (!found) throw new Error(`no step runs ${needle}`);
		return found;
	};

	// Recurrence: #4077, a write scope on the job that runs the bench, so a
	// branch dispatch held it; the issue writer is its own guarded job.
	it("keeps the bench read-only and gives the tracking issue its own narrow writer job", () => {
		expect(job).toBeDefined();
		expect(job.permissions).toEqual({ contents: "read" });
		expect(job.if).toBeUndefined();
		expect(writer.permissions).toEqual({ contents: "read", issues: "write" });
		expect(writer.needs).toBe("snapshot-persist-bench");
		expect(writer.if).toBe(
			"always() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master')",
		);
		// The tool-smoke job's own grant is read-only now: this lane widens nothing.
		expect(jobs["tool-smoke"].permissions).toEqual({
			contents: "read",
			"pull-requests": "read",
		});
	});

	it("bounds the bench step below the job bound", () => {
		expect(step("bench-snapshot-persist.mjs")["timeout-minutes"]).toBeLessThan(
			job["timeout-minutes"] as number,
		);
	});

	it("benches, checks, then notifies, passing the same report and state paths", () => {
		const names = job.steps.map((s) => String(s.run ?? ""));
		const at = (needle: string) =>
			names.findIndex((run) => run.includes(needle));
		expect(at("bench-snapshot-persist.mjs")).toBeGreaterThan(
			at("npm run build"),
		);
		expect(at("check-snapshot-persist-ratio.mjs")).toBeGreaterThan(
			at("bench-snapshot-persist.mjs"),
		);
		// The check's files are staged for the writer job after it, on every outcome.
		const stageStep = job.steps.find(
			(s) => s.name === "Stage the notifier inputs",
		) as Step;
		expect(at("snapshot-persist-notify-inputs")).toBeGreaterThan(
			at("check-snapshot-persist-ratio.mjs"),
		);
		expect(stageStep.if).toBe("always()");
		const bench = step("bench-snapshot-persist.mjs").run as string;
		const check = step("check-snapshot-persist-ratio.mjs").run as string;
		const notify = step("upsert-tracking-issue.mjs", writer).run as string;
		const stage = stageStep.run as string;
		// N independent bench invocations (a loop, not later persists of one
		// child), each writing the report the checker is given.
		const indices = /for i in ([\d ]+); do/.exec(bench)?.[1].trim().split(" ");
		expect(indices).toHaveLength(SAMPLE_COUNT);
		expect(bench).toContain("--persists 1");
		expect(bench).toContain(
			'--out "$RUNNER_TEMP/snapshot-persist-bench-$i.json"',
		);
		const reports = [...check.matchAll(/--report "([^"]+)"/g)].map((m) => m[1]);
		expect(reports).toEqual(
			(indices ?? []).map(
				(i) => `$RUNNER_TEMP/snapshot-persist-bench-${i}.json`,
			),
		);
		const state = /--state "([^"]+)"/.exec(check)?.[1];
		const body = /--body "([^"]+)"/.exec(check)?.[1];
		expect(state && notify.includes(state)).toBe(true);
		expect(body && notify.includes(body)).toBe(true);
		// Recurrence: #4077, a staged name that drifts from the checker's file
		// reaches the writer as "missing" and never files the issue.
		expect(state && stage.includes(state)).toBe(true);
		expect(body && stage.includes(body)).toBe(true);
	});

	it("lets a drift or unusable verdict red the job but never lets the notifier do so", () => {
		const check = step("check-snapshot-persist-ratio.mjs");
		expect(check["continue-on-error"]).toBeUndefined();
		// The checker's exit code survives the `| tee` that feeds the step summary.
		expect(check.run).toContain("PIPESTATUS[0]");
		expect(check.run).toContain('exit "$CODE"');
		const notify = writer.steps.find((s) => s.name?.startsWith("Notify on"));
		expect(notify?.["continue-on-error"]).toBe(true);
		expect(writer["continue-on-error"]).toBe(true);
	});

	it("runs the check after a failed bench (a missing report is the unusable case) but not after a failed build", () => {
		const bench = job.steps.find((candidate) => candidate.id === "bench");
		expect(bench).toBeDefined();
		const check = step("check-snapshot-persist-ratio.mjs");
		expect(check.if).toBe(
			"${{ !cancelled() && steps.bench.outcome != 'skipped' }}",
		);
	});

	it("files the tracking issue for an unusable measurement as well as for drift", () => {
		const notify = step("upsert-tracking-issue.mjs", writer).run as string;
		expect(notify).toContain('[ "$STATE" = drift ] || [ "$STATE" = error ]');
		expect(notify).toMatch(/elif \[ "\$STATE" = clean \]/);
	});

	it("reaches the tracking issue only through the shared CLI", () => {
		const own = [...job.steps, ...writer.steps]
			.map((s) => String(s.run ?? ""))
			.join("\n");
		expect(own).toContain("--label nightly-drift");
		expect(own).toContain("--close-when-clean");
		expect(own).not.toMatch(/gh issue (create|edit|comment|close)/);
	});
});
