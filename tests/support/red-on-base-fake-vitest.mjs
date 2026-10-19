// Fake `vitest run --reporter=json --outputFile=X <files>` (and, with
// `--build`, a fake `npm run build`) for tests/scripts/red-on-base.test.ts.
// The behavior lives in `scenario.json` at the cwd of the tree being run, so
// the base commit and the HEAD commit of a fixture repo can disagree. The
// report shape is vitest's JSON reporter (checked against a real run):
// testResults[].{name, status, assertionResults[].{fullName, status}}.
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const scenario = JSON.parse(readFileSync(join(cwd, "scenario.json"), "utf8"));
const probe = (entry) =>
	appendFileSync(
		process.env.PROBE_LOG,
		`${JSON.stringify({ cwd, pid: process.pid, home: process.env.PI_LENS_HOME, tmp: process.env.TMPDIR, ...entry })}\n`,
	);

if (args.includes("--build")) {
	probe({ phase: "build" });
	process.exit(scenario.buildExit ?? 0);
}

// A governance test that reads Git state (tracked-control-bytes, the gitignore
// shadow scan): green only in a tree whose index lists the committed files.
const gitIndexListsScenario = () => {
	try {
		return execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })
			.split("\n")
			.includes("scenario.json");
	} catch {
		return false;
	}
};

const outputFile = args
	.find((arg) => arg.startsWith("--outputFile="))
	.slice("--outputFile=".length);
const files = args.filter((arg) => arg !== "run" && !arg.startsWith("--"));

const counter = join(process.env.PI_LENS_HOME, "run-count");
const run =
	(existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(run));
probe({ phase: "test", files, run });

// The tool signals ITSELF from inside the run so the tests need no timers.
if (scenario.signalParent && process.env.FAKE_SIGNAL_PARENT) {
	// A grandchild sharing our pipes: it only writes its marker if the tool's
	// group kill did not reach it (the tool waits for the pipes to close).
	spawn(
		process.execPath,
		[
			"-e",
			"setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)",
			`${process.env.PROBE_LOG}.grandchild`,
		],
		{ stdio: "inherit" },
	);
	// A runner that ignores SIGTERM must still be ended by the tool's SIGKILL.
	const ignore = process.env.FAKE_IGNORE_SIGTERM;
	if (ignore) process.on("SIGTERM", () => {});
	process.kill(process.ppid, process.env.FAKE_SIGNAL_PARENT);
	// A SIGKILLed tool orphans this child; it must end on its own soon.
	setTimeout(
		() => {
			if (ignore) writeFileSync(`${process.env.PROBE_LOG}.survived`, "x");
			process.exit(3);
		},
		ignore ? 8_000 : 4_000,
	);
} else {
	let failed = false;
	const testResults = files.map((file) => {
		const spec = scenario.files[file];
		if (spec.suiteFailure) {
			failed = true;
			return {
				name: resolve(cwd, file),
				status: "failed",
				message:
					typeof spec.suiteFailure === "string"
						? spec.suiteFailure.replaceAll("%CWD%", cwd)
						: "",
				assertionResults: [],
			};
		}
		const assertionResults = spec.tests.map((test) => ({
			fullName: test.name,
			title: test.name,
			ancestorTitles: [],
			status:
				(test.status === "failed" &&
					(!test.failOnRuns || test.failOnRuns.includes(run))) ||
				(scenario.needsGitIndex && !gitIndexListsScenario())
					? "failed"
					: "passed",
		}));
		failed ||= assertionResults.some((test) => test.status === "failed");
		return {
			name: resolve(cwd, file),
			status: assertionResults.some((test) => test.status === "failed")
				? "failed"
				: "passed",
			assertionResults,
		};
	});
	if (!scenario.noReport)
		writeFileSync(outputFile, JSON.stringify({ testResults }));
	process.exit(failed || scenario.noReport || scenario.failExit ? 1 : 0);
}
