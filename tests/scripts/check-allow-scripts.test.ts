// flake-shape: real-process-spawn — the committed CLI is the subject (exit code, stdout/stderr report, cwd contract, install-phase read from node_modules); an in-process call of the pure policy cannot prove that boundary.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkAllowScriptsPolicy,
	collectLifecyclePackages,
} from "../../scripts/lib/allow-scripts-policy.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CHECKER = path.join(REPO_ROOT, "scripts/check-allow-scripts.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

type Json = Record<string, unknown>;

function lockWith(packages: Record<string, Json>): Json {
	return { lockfileVersion: 3, packages: { "": {}, ...packages } };
}

const script = (version: string, extra: Json = {}): Json => ({
	version,
	hasInstallScript: true,
	...extra,
});

function runChecker(pkg: Json, lock: Json, installed?: Record<string, Json>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-allow-1185-"));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
	fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
	for (const [installPath, manifest] of Object.entries(installed ?? {})) {
		fs.mkdirSync(path.join(root, installPath), { recursive: true });
		fs.writeFileSync(
			path.join(root, installPath, "package.json"),
			JSON.stringify(manifest),
		);
	}
	const result = spawnSync(process.execPath, [CHECKER], {
		cwd: root,
		encoding: "utf8",
	});
	return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const kinds = (pkg: Json, lock: Json) =>
	checkAllowScriptsPolicy(pkg, lock).map((p) => `${p.kind}:${p.subject}`);

describe("allowScripts policy against the real repo (#1185)", () => {
	// Recurrence: #1176. `@ast-grep/cli` moved to 0.45.x while its approval
	// stayed 0.44.1, and on this repo's own head `@google/genai` (1.52.0 vs
	// 2.21.0) and `protobufjs` (7.6.5 vs 7.6.6) had drifted the same way with
	// `esbuild`/`fsevents` undecided, all green. Drives the committed CLI over
	// the committed package.json + package-lock.json.
	it("the committed policy decides every resolved lifecycle script exactly", () => {
		const result = spawnSync(process.execPath, [CHECKER], {
			cwd: REPO_ROOT,
			encoding: "utf8",
		});
		expect(`${result.stdout}${result.stderr}`).toContain(
			"allowScripts policy matches the resolved lockfile",
		);
		expect(result.status).toBe(0);
	});

	// Recurrence: the checker passing vacuously on an empty inventory. The real
	// lock must resolve script-bearing packages, @ast-grep/cli among them.
	it("the inventory of the committed lockfile is non-empty and names @ast-grep/cli", () => {
		const lock = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"),
		) as Json;
		const names = collectLifecyclePackages(lock).map((p) => p.name);
		expect(names).toContain("@ast-grep/cli");
		expect(names.length).toBeGreaterThanOrEqual(4);
	});
});

describe("allowScripts policy failure list (#1185)", () => {
	const lock = lockWith({
		"node_modules/dep-a": script("1.2.3"),
		"node_modules/@scope/dep-b": script("2.0.0"),
	});
	const exact = {
		allowScripts: { "dep-a@1.2.3": true, "@scope/dep-b@2.0.0": false },
	};

	it("accepts exact approvals and skips for every resolved script", () => {
		expect(kinds(exact, lock)).toEqual([]);
	});

	// Recurrence: a script-bearing dependency bump that does not touch policy
	// (#1176): the entry pins 1.2.2 and the lock resolves 1.2.3.
	it("fails an approval pinned to another version than the lock resolves", () => {
		const out = runChecker(
			{ allowScripts: { "dep-a@1.2.2": true, "@scope/dep-b@2.0.0": true } },
			lock,
		);
		expect(out.status).toBe(1);
		expect(out.out).toContain("[version-mismatch] dep-a@1.2.3");
		expect(out.out).toContain("dep-a@1.2.2");
		expect(out.out).toContain("Add or move the entry");
	});

	// A plain bump is ONE finding, against the resolved package: the old entry
	// is not also reported stale, because nothing else covers the new version.
	it("reports a plain version bump once, as version-mismatch", () => {
		expect(
			kinds(
				{ allowScripts: { "dep-a@1.2.2": true, "@scope/dep-b@2.0.0": true } },
				lock,
			),
		).toEqual(["version-mismatch:dep-a@1.2.3"]);
	});

	// Recurrence (#1185 review F1): an old-version approval kept beside the
	// resolved one survived because staleness was judged by name. With
	// `esbuild@0.27.0` next to the resolved 0.28.2 the checker and
	// `npm ci --strict-allow-scripts` both exited 0.
	it("fails an old-version approval kept beside the resolved version of the same name", () => {
		const out = runChecker(
			{
				allowScripts: {
					"dep-a@1.2.3": true,
					"dep-a@1.2.2": true,
					"@scope/dep-b@2.0.0": false,
				},
			},
			lock,
		);
		expect(out.status).toBe(1);
		expect(out.out).toContain('[stale-approval] "dep-a@1.2.2"');
		expect(out.out).not.toContain("version-mismatch");
	});

	// The same name at two resolved versions: an entry for a third version is
	// stale only once the other keys cover BOTH resolved copies.
	it("keeps a mismatch, not a stale report, while another resolved version is still undecided", () => {
		const dupes = lockWith({
			"node_modules/dep-a": script("1.2.3"),
			"node_modules/x/node_modules/dep-a": script("1.0.0"),
		});
		expect(
			kinds(
				{ allowScripts: { "dep-a@1.2.3": true, "dep-a@0.9.0": true } },
				dupes,
			),
		).toEqual(["version-mismatch:dep-a@1.0.0"]);
		expect(
			kinds(
				{
					allowScripts: {
						"dep-a@1.2.3": true,
						"dep-a@1.0.0": true,
						"dep-a@0.9.0": true,
					},
				},
				dupes,
			),
		).toEqual(["stale-approval:dep-a@0.9.0"]);
	});

	// Recurrence (#1185 verify N-1): round 2 judged a key stale when the OTHER
	// keys decided every resolved version, so a bare skip and an exact key for
	// the same resolved version covered each other and both read stale.
	const fooLock = lockWith({ "node_modules/foo": script("2.0.0") });

	it("keeps a bare-name skip and a versioned key that matches a resolved version both live", () => {
		expect(
			kinds({ allowScripts: { foo: false, "foo@2.0.0": true } }, fooLock),
		).toEqual([]);
	});

	it("reports only the unmatched versioned key beside a bare-name skip", () => {
		expect(
			kinds({ allowScripts: { foo: false, "foo@1.0.0": true } }, fooLock),
		).toEqual(["stale-approval:foo@1.0.0"]);
	});

	// The PR #4028 round-3 table: one key kind (bare true, bare false, exact
	// version that resolves) against one name's resolved set. The other cells
	// are the named tests around this one.
	it("decides staleness by one rule in every cell of the key-kind by resolved-set table", () => {
		const none = lockWith({ "node_modules/other": script("1.0.0") });
		const several = lockWith({
			"node_modules/foo": script("2.0.0"),
			"node_modules/x/node_modules/foo": script("1.0.0"),
		});
		const other = { "other@1.0.0": true };
		const cells: Array<[string, Json, Json, string[]]> = [
			["T0", { ...other, foo: true }, none, ["unpinned-approval:foo"]],
			[
				"T1k",
				{ foo: true, "foo@2.0.0": true },
				fooLock,
				["unpinned-approval:foo"],
			],
			[
				"Tnk",
				{ foo: true, "foo@1.0.0": true, "foo@2.0.0": true },
				several,
				["unpinned-approval:foo"],
			],
			[
				"Tnu",
				{ foo: true, "foo@2.0.0": true },
				several,
				["unpinned-approval:foo", "version-mismatch:foo@1.0.0"],
			],
			["F0", { ...other, foo: false }, none, ["stale-approval:foo"]],
			[
				"Fnk",
				{ foo: false, "foo@1.0.0": true, "foo@2.0.0": false },
				several,
				[],
			],
			["Fnu", { foo: false, "foo@2.0.0": true }, several, []],
			["Hnk", { "foo@1.0.0": true, "foo@2.0.0": false }, several, []],
		];
		for (const [cell, allowScripts, cellLock, want] of cells) {
			expect(kinds({ allowScripts }, cellLock), cell).toEqual(want);
		}
	});

	// Recurrence: a new transitive script dependency lands unreviewed.
	it("fails a resolved script with no decision and names package, version, path and fix", () => {
		const out = runChecker({ allowScripts: { "dep-a@1.2.3": true } }, lock);
		expect(out.status).toBe(1);
		expect(out.out).toContain("[missing-decision] @scope/dep-b@2.0.0");
		expect(out.out).toContain("node_modules/@scope/dep-b");
		expect(out.out).toContain('"@scope/dep-b@2.0.0": true');
	});

	// Recurrence: an approval outliving its dependency keeps a trust grant
	// that nothing resolves any more.
	it("fails an obsolete approval for a package that no longer resolves", () => {
		expect(
			kinds(
				{ allowScripts: { ...exact.allowScripts, "gone@9.9.9": true } },
				lock,
			),
		).toEqual(["stale-approval:gone@9.9.9"]);
	});

	// Recurrence: a package that lost its install script keeps its approval.
	it("fails an approval whose package resolves without an install script", () => {
		const noScript = lockWith({
			"node_modules/dep-a": { version: "1.2.3" },
			"node_modules/@scope/dep-b": script("2.0.0"),
		});
		expect(kinds(exact, noScript)).toEqual(["stale-approval:dep-a@1.2.3"]);
	});

	// Recurrence: a name-only or ranged approval trusts every future release.
	it("fails name-only, ranged and non-boolean positive entries", () => {
		const problems = kinds(
			{
				allowScripts: {
					"dep-a": true,
					"@scope/dep-b@^2.0.0": true,
				},
			},
			lock,
		);
		expect(problems).toContain("unpinned-approval:dep-a");
		expect(problems).toContain("unpinned-approval:@scope/dep-b@^2.0.0");
		expect(
			kinds(
				{
					allowScripts: {
						"dep-a@1.2.3": "yes",
						"@scope/dep-b@2.0.0": true,
					},
				},
				lock,
			),
		).toContain("invalid-policy:dep-a@1.2.3");
	});

	// A bare-name skip is fail-safe (npm lets deny win) and still counts as the
	// explicit classification the issue asks for.
	it("accepts a bare-name skip as the decision", () => {
		expect(
			kinds(
				{ allowScripts: { "dep-a@1.2.3": true, "@scope/dep-b": false } },
				lock,
			),
		).toEqual([]);
	});

	// Recurrence: a direct dependency that runs a script on a floating range
	// (`@ast-grep/cli` was "^0.45.0") moves under a stale approval.
	it("fails a direct script-bearing dependency on a floating range, not an exact one", () => {
		const floating = kinds(
			{ ...exact, dependencies: { "dep-a": "^1.2.0" } },
			lock,
		);
		expect(floating).toEqual(["floating-direct:dep-a@^1.2.0"]);
		expect(
			kinds({ ...exact, devDependencies: { "dep-a": "~1.2.3" } }, lock),
		).toEqual(["floating-direct:dep-a@~1.2.3"]);
		expect(
			kinds({ ...exact, dependencies: { "dep-a": "1.2.3" } }, lock),
		).toEqual([]);
		expect(
			kinds({ ...exact, dependencies: { other: "^1.0.0" } }, lock),
		).toEqual([]);
	});

	// Recurrence: bundled and linked entries never run their scripts, so they
	// must not demand a decision npm itself would not ask for.
	it("ignores bundled and linked lock entries", () => {
		const skipped = lockWith({
			"node_modules/bundled": script("1.0.0", { inBundle: true }),
			"node_modules/linked": script("1.0.0", { link: true }),
		});
		expect(kinds({}, skipped)).toEqual([]);
	});

	// Recurrence: two copies of one package at different versions each need a
	// decision, so an approval of one copy cannot cover the other.
	it("requires a decision for every resolved version of a name", () => {
		const dupes = lockWith({
			"node_modules/dep-a": script("1.2.3"),
			"node_modules/x/node_modules/dep-a": script("1.0.0"),
		});
		expect(kinds({ allowScripts: { "dep-a@1.2.3": true } }, dupes)).toEqual([
			"version-mismatch:dep-a@1.0.0",
		]);
	});

	// The report must name the install phase from an installed tree.
	it("names the install phase read from the installed manifest", () => {
		const out = runChecker(
			{ allowScripts: {} },
			lockWith({ "node_modules/dep-a": script("1.2.3") }),
			{
				"node_modules/dep-a": {
					name: "dep-a",
					version: "1.2.3",
					scripts: { postinstall: "node x.js" },
				},
			},
		);
		expect(out.out).toContain("phase postinstall");
	});

	it("rejects a non-object allowScripts", () => {
		expect(kinds({ allowScripts: ["dep-a@1.2.3"] }, lock)).toEqual([
			"invalid-policy:allowScripts",
		]);
	});
});
