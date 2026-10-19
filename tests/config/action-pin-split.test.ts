import { readFileSync } from "node:fs";
import { relative, resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { toPosix } from "../../clients/path-utils.js";
import {
	type ActionPin,
	parseActionPins,
	workflowFiles,
} from "../../scripts/check-action-pins.mjs";

// Recurrence #4350: the combined dependabot merge #4333 bumped
// github/codeql-action/analyze and /upload-sarif to v4.38.3 and left /init on
// v4.38.2, in both ci.yml and codeql.yml. Dependabot treats each subpath of an
// action repo as its own dependency, so it can bump them in separate PRs.
// CodeQL refuses a mixed run ("All steps in a workflow that use
// github/codeql-action must use the same version"), and every CodeQL job
// failed in the analyze post-step. The per-file codeql-workflow test compared
// ci.yml with codeql.yml step by step, so a split both files shared passed it.
//
// The rule is one SHA per action repository (owner/repo) across the whole
// tree that scripts/check-action-pins.mjs reads, not only codeql-action: it
// held for every other repository when it landed, and a subpath action such
// as actions/cache/restore + actions/cache/save splits the same way.

const ROOT = resolve(import.meta.dirname, "../..");

// Repository-relative path with forward slashes on every platform. The walker
// emits platform separators, and every expectation in this file uses `/`.
function repoRelative(
	file: string,
	root = ROOT,
	api: { relative: (from: string, to: string) => string } = { relative },
): string {
	return toPosix(api.relative(root, file));
}

const repoOf = (action: string) => action.split("/").slice(0, 2).join("/");

function pinSplits(pins: ActionPin[]): string[] {
	const byRepo = new Map<string, Map<string, string[]>>();
	for (const pin of pins) {
		const repo = repoOf(pin.action);
		const shas = byRepo.get(repo) ?? new Map<string, string[]>();
		byRepo.set(repo, shas);
		const sites = shas.get(pin.sha) ?? [];
		shas.set(pin.sha, sites);
		sites.push(`${pin.file}:${pin.line}`);
	}
	return [...byRepo]
		.filter(([, shas]) => shas.size > 1)
		.map(
			([repo, shas]) =>
				`${repo} has ${shas.size} SHAs: ${[...shas]
					.map(([sha, sites]) => `${sha} at ${sites.join(", ")}`)
					.join("; ")}`,
		);
}

// A `uses:` key in block, flow-map or quoted form. Comment lines are skipped.
const USES_KEY = /(?:^|[\s{,-])["']?uses["']?\s*:\s*["']?([^\s"'},#]+)/;
// Local actions and container uses are not pinned by design.
const LOCAL_OR_DOCKER = /^(?:\.\/|docker:\/\/)/;

interface RemoteUses {
	line: number;
	text: string;
}

function remoteUsesLines(text: string): RemoteUses[] {
	const found: RemoteUses[] = [];
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		if (raw.trimStart().startsWith("#")) continue;
		const match = raw.match(USES_KEY);
		if (!match || LOCAL_OR_DOCKER.test(match[1])) continue;
		found.push({ line: index + 1, text: raw.trim() });
	}
	return found;
}

// Every remote uses: line that parseActionPins does not turn into a pin.
function unparsedUses(text: string, file: string): string[] {
	const pinned = new Set(parseActionPins(text, file).map((pin) => pin.line));
	return remoteUsesLines(text)
		.filter((use) => !pinned.has(use.line))
		.map((use) => `${file}:${use.line}: ${use.text}`);
}

async function treeScan(): Promise<{
	pins: ActionPin[];
	uses: number;
	unparsed: string[];
}> {
	const pins: ActionPin[] = [];
	let uses = 0;
	const unparsed: string[] = [];
	for (const file of await workflowFiles(ROOT)) {
		const text = readFileSync(file, "utf8");
		const rel = repoRelative(file);
		pins.push(...parseActionPins(text, rel));
		uses += remoteUsesLines(text).length;
		unparsed.push(...unparsedUses(text, rel));
	}
	return { pins, uses, unparsed };
}

const FIXTURE_UNPARSED = `jobs:
  build:
    steps:
      - uses: actions/checkout@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v7
      - uses: github/codeql-action/init@v4
      - uses: "actions/cache@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2" # v5
      - {uses: actions/setup-node@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2}
      - uses: ./local-action
      - uses: docker://alpine:3.19
`;

describe("#4350 one SHA per action repository across the workflow tree", () => {
	it("pins every action repository, codeql-action included, to one SHA", async () => {
		const { pins, uses, unparsed } = await treeScan();
		// Every remote uses: line must be parsed into a pin, or the SHA rule
		// below is checking a subset of the tree. Recurrence #4350 review F1.
		expect(
			unparsed,
			`uses: lines parseActionPins does not pin (tag, quoted or flow form): ${unparsed.join("; ")}`,
		).toEqual([]);
		expect(
			uses,
			`${uses} remote uses: lines but ${pins.length} parsed pins`,
		).toBe(pins.length);
		// Floor: the tree still holds the three codeql-action steps in both
		// workflows, so an empty walk or a parser change cannot pass vacuously.
		const codeql = pins.filter(
			(pin) => repoOf(pin.action) === "github/codeql-action",
		);
		expect(new Set(codeql.map((pin) => pin.action))).toEqual(
			new Set([
				"github/codeql-action/init",
				"github/codeql-action/analyze",
				"github/codeql-action/upload-sarif",
			]),
		);
		expect(new Set(codeql.map((pin) => pin.file))).toEqual(
			new Set([".github/workflows/ci.yml", ".github/workflows/codeql.yml"]),
		);
		expect(pinSplits(pins)).toEqual([]);
	});

	it("reports a subpath split within one repository and not across repositories", () => {
		const a = "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2";
		const b = "24c54180a607b1449ed407dd24f251e4e9147c8d";
		const pins = [
			...parseActionPins(
				[
					`      - uses: actions/checkout@${a} # v7`,
					`      - uses: github/codeql-action/init@${a} # v4.38.2`,
					`      - uses: github/codeql-action/analyze@${b} # v4.38.3`,
				].join("\n"),
				"ci.yml",
			),
			...parseActionPins(
				[
					`      - uses: actions/setup-node@${b} # v6.5.0`,
					`      - uses: github/codeql-action/upload-sarif@${b} # v4.38.3`,
				].join("\n"),
				"codeql.yml",
			),
		];
		expect(pinSplits(pins)).toEqual([
			`github/codeql-action has 2 SHAs: ${a} at ci.yml:2; ${b} at ci.yml:3, codeql.yml:2`,
		]);
	});

	it("normalizes a Windows-shaped workflow path to forward slashes", () => {
		// Recurrence #4350 round 3: Unit tests Windows (advisory) reded on
		// Set{'.github\\workflows\\ci.yml'} because the tree path kept the
		// platform separator. Fed through win32 here so Linux reproduces it.
		expect(
			repoRelative("C:\\repo\\.github\\workflows\\ci.yml", "C:\\repo", win32),
		).toBe(".github/workflows/ci.yml");
	});

	it("names every uses: line parseActionPins cannot pin, and only those", () => {
		// Recurrence #4350 review F1: a tag pin (@v4), a quoted uses value and a
		// flow-map step were silently skipped, so a tag-pinned CodeQL step next to
		// SHA-pinned ones passed both checkers. Local ./ and docker:// uses are
		// exempt by design and must not be reported.
		expect(unparsedUses(FIXTURE_UNPARSED, "ci.yml")).toEqual([
			"ci.yml:5: - uses: github/codeql-action/init@v4",
			`ci.yml:6: - uses: "actions/cache@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2" # v5`,
			"ci.yml:7: - {uses: actions/setup-node@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2}",
		]);
	});
});
