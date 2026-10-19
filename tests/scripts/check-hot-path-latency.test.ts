/**
 * Hot-path latency regression gate (#4363).
 *
 * Recurrences this file prevents:
 *  - #4344 round 1: replay went from 6 ms to 321 ms and only a reviewer who
 *    re-ran a probe saw it. The planted-slowdown rows require the rule to fail
 *    a large, clean shift on a short path and on a long one;
 *  - #4344 round 2: "624 ms to 7 ms" from one run each. The noise rows require
 *    that two samples of the SAME latency distribution never fail the lane (a
 *    gate that cries wolf is switched off), and that a shift buried in noise
 *    does not pass for a verdict;
 *  - a threshold edit that drops a half of the rule (significance, ratio or
 *    the millisecond floor): one row per half;
 *  - the interleave or the dropped warm-up pair removed, which would let host
 *    drift or a cold file cache land on one tree.
 *
 * It never times anything. Every sample here is synthetic and seeded: the real
 * measurement is the CI lane (`.github/workflows/hot-path-latency.yml`), whose
 * red-first transcript is in the PR that added it. The sampler itself
 * (`scripts/hot-path-sample.mjs`) is not run here, so a wall-clock assertion
 * on a shared runner cannot flake this suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectSamples,
	evaluate,
	main,
	renderReport,
	type Sample,
	type TreeLabel,
} from "../../scripts/check-hot-path-latency.mjs";
import {
	bootstrapCompare,
	DEFAULT_THRESHOLD,
	judge,
	mulberry32,
} from "../../scripts/lib/latency-stats.mjs";

/** Seeded log-normal samples around `centre`, `n` of them. */
function noisy(centre: number, spread: number, n: number, seed: number) {
	const random = mulberry32(seed);
	return Array.from({ length: n }, () => {
		const z =
			Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
		return centre * Math.exp(spread * z);
	});
}

const verdict = (base: number[], head: number[]) =>
	judge(bootstrapCompare(base, head, { iterations: 500 }));

describe("bootstrapCompare", () => {
	it("returns the same interval for the same samples (seeded)", () => {
		const base = noisy(100, 0.05, 15, 1);
		const head = noisy(120, 0.05, 15, 2);
		expect(bootstrapCompare(base, head)).toEqual(bootstrapCompare(base, head));
	});

	it("brackets the observed shift and orders the interval", () => {
		const c = bootstrapCompare(
			noisy(100, 0.05, 15, 3),
			noisy(150, 0.05, 15, 4),
		);
		expect(c.diff.lo).toBeLessThanOrEqual(c.diff.point);
		expect(c.diff.point).toBeLessThanOrEqual(c.diff.hi);
		expect(c.ratio.lo).toBeGreaterThan(1.3);
		expect(c.ratio.hi).toBeLessThan(1.7);
	});

	it("widens the interval as the confidence level rises", () => {
		// Recurrence: a confidence level the code ignores. With the tail forced to
		// zero every level reads the full resample range and the 95 percent rule
		// is a 100 percent rule that the other tests cannot tell apart.
		const base = noisy(100, 0.1, 15, 13);
		const head = noisy(130, 0.1, 15, 14);
		const width = (confidence: number) => {
			const c = bootstrapCompare(base, head, { confidence });
			return c.diff.hi - c.diff.lo;
		};
		expect(width(0.8)).toBeLessThan(width(0.95));
		expect(width(0.95)).toBeLessThan(width(0.99));
	});

	it("refuses a group too small to resample", () => {
		expect(() => bootstrapCompare([1], [1, 2])).toThrow(/at least 2 samples/);
	});
});

describe("judge: the rule is significance AND threshold (#4344 r1, r2)", () => {
	it("fails a 6 ms path that became 321 ms", () => {
		const v = verdict(noisy(6, 0.1, 15, 5), noisy(321, 0.1, 15, 6));
		expect(v).toEqual({
			significant: true,
			aboveThreshold: true,
			regression: true,
		});
	});

	it("fails a 30 percent slowdown of a 600 ms path", () => {
		expect(
			verdict(noisy(600, 0.02, 15, 7), noisy(800, 0.02, 15, 8)).regression,
		).toBe(true);
	});

	it("does not fail a significant shift below the ratio threshold", () => {
		// Tight noise makes a 10 percent shift of a 600 ms path significant; it
		// is below `minRatio`, so it is a note, not a failure.
		const v = verdict(noisy(600, 0.005, 15, 9), noisy(660, 0.005, 15, 10));
		expect(v.significant).toBe(true);
		expect(v.aboveThreshold).toBe(false);
		expect(v.regression).toBe(false);
	});

	it("does not fail a large ratio under the millisecond floor", () => {
		// 2 ms to 4 ms is 2x but 2 ms of absolute shift: below the runner's noise.
		const v = verdict(noisy(2, 0.005, 15, 11), noisy(4, 0.005, 15, 12));
		expect(v.significant).toBe(true);
		expect(v.aboveThreshold).toBe(false);
		expect(v.regression).toBe(false);
	});

	it("does not fail a big point shift the noise cannot separate from zero", () => {
		// One sample group with a 30 percent spread and a handful of runs: the
		// medians differ by well over the threshold, the interval spans zero.
		const base = [100, 100, 100, 100, 100, 210, 220, 230];
		const head = [100, 100, 100, 210, 220, 230, 240, 250];
		const c = bootstrapCompare(base, head, { iterations: 500 });
		expect(c.ratio.point).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD.minRatio);
		const v = judge(c);
		expect(v.aboveThreshold).toBe(true);
		expect(v.significant).toBe(false);
		expect(v.regression).toBe(false);
	});

	// 300 seeded pairs of one distribution; returns how many the rule fails.
	function falseReds(spread: number): number {
		let failures = 0;
		for (let seed = 0; seed < 300; seed++) {
			const base = noisy(40, spread, 15, seed * 2 + 1000);
			const head = noisy(40, spread, 15, seed * 2 + 1001);
			if (verdict(base, head).regression) failures++;
		}
		return failures;
	}

	it("never fails two samples of one distribution at 10 percent spread", () => {
		// The lane measures 1 to 3 percent spread on a quiet host (PR body
		// transcript); 10 percent is the noise of a loaded shared runner.
		expect(falseReds(0.1)).toBe(0);
	});

	it("fails under 3 percent of same-distribution pairs even at 25 percent spread", () => {
		expect(falseReds(0.25)).toBeLessThan(9);
	});
});

describe("collectSamples", () => {
	it("alternates which tree goes first and drops the warm-up pair", () => {
		const calls: string[] = [];
		const samples = collectSamples({
			base: "B",
			head: "H",
			runs: 4,
			takeSample: (label, tree, index) => {
				calls.push(`${label}:${tree}:${index}`);
				return { m: index };
			},
		});
		expect(calls).toEqual([
			"base:B:-1",
			"head:H:-1",
			"head:H:0",
			"base:B:0",
			"base:B:1",
			"head:H:1",
			"head:H:2",
			"base:B:2",
			"base:B:3",
			"head:H:3",
		]);
		expect(samples.base.map((s) => s.m)).toEqual([0, 1, 2, 3]);
		expect(samples.head.map((s) => s.m)).toEqual([0, 1, 2, 3]);
	});

	it("stops when the time budget is spent instead of running on", () => {
		let clock = 0;
		expect(() =>
			collectSamples({
				base: "B",
				head: "H",
				runs: 15,
				takeSample: () => {
					clock += 100;
					return { m: 1 };
				},
				now: () => clock,
				deadline: 500,
			}),
		).toThrow(/time budget spent/);
	});
});

describe("evaluate", () => {
	it("rejects a sample that lacks a metric the first one has", () => {
		expect(() =>
			evaluate({
				base: [{ a: 1 }, { a: 2 }],
				head: [{ a: 1 }, {}],
			}),
		).toThrow(/lacks a finite a/);
	});
});

describe("main: exit codes and report", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-lens-hot-path-latency-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A fake host: `head` is `slowdown` ms slower on `metric`, with seeded noise. */
	function fakeSamples(metric: string, slowdown: number) {
		const draws: Record<TreeLabel, number[]> = {
			base: noisy(20, 0.03, 40, 21),
			head: noisy(20, 0.03, 40, 22).map((v) => v + slowdown),
		};
		const next: Record<TreeLabel, number> = { base: 0, head: 0 };
		return (label: TreeLabel): Sample => ({
			steady: 1000,
			[metric]: draws[label][next[label]++],
		});
	}

	const argv = ["--base", "B", "--head", "H", "--runs", "15"];

	it("exits 0 and says so when nothing slowed down", () => {
		const lines: string[] = [];
		const code = main(argv, {
			takeSample: fakeSamples("session_start", 0),
			log: (l) => lines.push(l),
		});
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("hot-path latency: no regression");
	});

	it("exits 1 and names the slowed metric for a planted slowdown", () => {
		const lines: string[] = [];
		const code = main(argv, {
			takeSample: fakeSamples("session_start", 60),
			log: (l) => lines.push(l),
		});
		const out = lines.join("\n");
		expect(code).toBe(1);
		expect(out).toContain("hot-path latency: REGRESSION in session_start");
		expect(out).toMatch(/\| session_start \|.*REGRESSION \|/);
		expect(out).toMatch(/\| steady \|.*\| ok \|/);
	});

	it("exits 2, not 1, when a sample cannot be taken", () => {
		const lines: string[] = [];
		const code = main(argv, {
			takeSample: () => {
				throw new Error("sample of B failed (exit 1): boom");
			},
			log: (l) => lines.push(l),
		});
		expect(code).toBe(2);
		expect(lines.join("\n")).toContain("harness failure");
	});

	it("exits 2 on a missing tree or too few runs, and runs from 5 up", () => {
		// Recurrence (review r1 b5): the guard moved to `runs < 1` and stayed
		// green, because the old row used a value below 1 and a real spawn failed
		// into exit 2 anyway. The sample seam is injected here so only the guard
		// decides, at the boundary on both sides.
		const log = () => {};
		const takeSample = fakeSamples("session_start", 0);
		expect(main(["--head", "H"], { log, takeSample })).toBe(2);
		expect(
			main(["--base", "B", "--head", "H", "--runs", "4"], { log, takeSample }),
		).toBe(2);
		expect(
			main(["--base", "B", "--head", "H", "--runs", "5"], {
				log,
				takeSample: fakeSamples("session_start", 0),
			}),
		).toBe(0);
	});

	it("appends the table to the step summary and writes the json rows", () => {
		const summary = join(dir, "summary.md");
		const json = join(dir, "rows.json");
		mkdirSync(dir, { recursive: true });
		main([...argv, "--json", json], {
			takeSample: fakeSamples("replay_large", 40),
			log: () => {},
			summaryFile: summary,
		});
		expect(readFileSync(summary, "utf8")).toContain("| replay_large |");
		const rows = JSON.parse(readFileSync(json, "utf8")).rows;
		expect(
			rows.find((r: { metric: string }) => r.metric === "replay_large"),
		).toMatchObject({
			regression: true,
		});
	});

	it("prints the rule with the thresholds it applies", () => {
		const report = renderReport([], { runs: 15 });
		expect(report).toContain(`${DEFAULT_THRESHOLD.minRatio}x`);
		expect(report).toContain(`${DEFAULT_THRESHOLD.minDiffMs} ms`);
	});
});
