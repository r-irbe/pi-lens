/**
 * History-based test selection (#3215 lane 3).
 *
 * The pre-push selector (`scripts/pre-push-targeted-tests.mjs`) reads imports
 * only, so a change to a file no test imports (a rule YAML, a doc) selects
 * nothing even when earlier heads that touched the same directory failed
 * specific tests: #3214 round 1 redded only `tests/scripts/rule-catalogs.test.ts`.
 * This module adds those tests. It never removes the import-derived selection.
 *
 * Input is the `failures` view of `history/summary.json` on the
 * `data/test-history` branch, which the rollup derives from the journal
 * (`scripts/test-history-rollup.mjs`, the owner of the flake rule: a failure
 * that passed on the same head is marked `flake` there and ignored here). Every
 * `file` in it is the journal's repo-relative id (#3367), the same string as a
 * `tests/**` path in this checkout.
 *
 * Rules, each pinned by tests/scripts/test-history-selection.test.ts:
 * - A change matches a past failing head when one of the head's touched
 *   directories equals the directory of a changed file. Equality, not a prefix:
 *   a prefix would match every head under `clients/` for any `clients/**` change
 *   (the issue says "by directory prefix"; this is a declared deviation).
 * - Hub directories (HUB_SHARE) are dropped from both sides: `.changelog/` and
 *   the repo root are touched by unrelated heads, so a fragment would otherwise
 *   add the same globally failing tests to every change. The share is computed
 *   from the summary's `heads` view, the journal's own population.
 * - Heads that git cannot resolve (not in this clone, or a merge commit, which
 *   has no first-parent diff to attribute) are skipped and counted.
 * - Changed `tests/` files never consult history: they are selected directly.
 * - At most HISTORY_MAX_SELECTED tests are added, ranked by distinct failing
 *   heads.
 * - The journal is lagging data when the summary is older than HISTORY_STALE_MS
 *   (the nightly rollup runs daily): the selector says so and adds nothing.
 *   Lag is journal-wide, not per directory: the journal has one writer, and a
 *   per-directory age would need the touched paths of every head, not only the
 *   failing ones.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const HISTORY_STALE_MS = 3 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_SELECTED = 10;
/**
 * A directory touched by more than this share of the journal's resolvable heads
 * (and by at least HUB_MIN_HEADS of them) says nothing about which test fails:
 * unrelated heads all touch it. Measured on the real journal (187 resolvable of
 * 307 heads, 2026-10-07): .changelog 38%, tests/clients 36%, tests/config 28%,
 * scripts 19%, clients 18%, the repo root 13%, tests/clients/lsp 10%,
 * scripts/lib 8%, docs 6%; a rules directory is touched by a handful. 10% takes
 * in the changelog and the root; the minimum keeps a short history from calling
 * everything a hub.
 */
export const HUB_SHARE = 0.1;
export const HUB_MIN_HEADS = 10;
export const HISTORY_REF = "origin/data/test-history";
export const HISTORY_SUMMARY_PATH = "history/summary.json";

const dirOf = (file) => path.posix.dirname(file);

function parseSummary(summary, now) {
	if (
		!summary ||
		typeof summary !== "object" ||
		!Array.isArray(summary.failures)
	)
		return { reason: "no failures view in the history summary" };
	if (!Array.isArray(summary.heads))
		return { reason: "no heads view in the history summary" };
	const generated = Date.parse(summary.generatedAt);
	if (!Number.isFinite(generated))
		return { reason: "history summary has no generation time" };
	return { ageMs: now - generated, generated };
}

/**
 * @param {{ summary: unknown, changed: string[], allTests: string[],
 *   pathsForHeads: (heads: string[]) => Map<string, string[]>, now?: number }} input
 * @returns {{ status: "selected"|"none"|"stale"|"unavailable", picks: string[], detail: string }}
 */
export function selectFromHistory({
	summary,
	changed,
	allTests,
	pathsForHeads,
	now = Date.now(),
}) {
	const parsed = parseSummary(summary, now);
	if ("reason" in parsed)
		return {
			status: "unavailable",
			picks: [],
			detail: `${parsed.reason}; import-only`,
		};
	if (parsed.ageMs > HISTORY_STALE_MS)
		return {
			status: "stale",
			picks: [],
			detail: `history stale (generated ${new Date(parsed.generated).toISOString()}, older than ${HISTORY_STALE_MS / 86_400_000} days); import-only`,
		};
	const changedDirs = new Set(
		changed.filter((file) => !file.startsWith("tests/")).map(dirOf),
	);
	if (changedDirs.size === 0)
		return { status: "none", picks: [], detail: "history: no non-test change" };
	const failures = summary.failures.filter(
		(failure) => failure && failure.flake !== true,
	);
	const failingHeads = [...new Set(failures.map((failure) => failure.headSha))];
	const touched = pathsForHeads([
		...new Set([...summary.heads, ...failingHeads]),
	]);
	const dirsOf = new Map(
		[...touched].map(([sha, files]) => [sha, new Set(files.map(dirOf))]),
	);
	const touchCount = new Map();
	for (const dirs of dirsOf.values())
		for (const dir of dirs) touchCount.set(dir, (touchCount.get(dir) ?? 0) + 1);
	const hubs = new Set(
		[...touchCount]
			.filter(
				([, count]) =>
					count >= HUB_MIN_HEADS && count / dirsOf.size > HUB_SHARE,
			)
			.map(([dir]) => dir),
	);
	const usable = [...changedDirs].filter((dir) => !hubs.has(dir));
	if (usable.length === 0)
		return {
			status: "none",
			picks: [],
			detail: `history: only hub director${changedDirs.size === 1 ? "y" : "ies"} changed (${[...changedDirs].join(", ")}); no locality signal`,
		};
	const matching = new Set(
		failingHeads.filter((sha) =>
			[...(dirsOf.get(sha) ?? [])].some((dir) => usable.includes(dir)),
		),
	);
	const unresolved = failingHeads.filter((sha) => !dirsOf.has(sha)).length;
	const available = new Set(allTests);
	const score = new Map();
	for (const failure of failures) {
		if (!matching.has(failure.headSha) || !available.has(failure.file))
			continue;
		let failedOn = score.get(failure.file);
		if (!failedOn) score.set(failure.file, (failedOn = new Set()));
		failedOn.add(failure.headSha);
	}
	const picks = [...score.entries()]
		.sort(
			([a, failedA], [b, failedB]) =>
				failedB.size - failedA.size || (a < b ? -1 : a > b ? 1 : 0),
		)
		.slice(0, HISTORY_MAX_SELECTED)
		.map(([file]) => file);
	const note = unresolved
		? `; ${unresolved} of ${failingHeads.length} failing head(s) unresolved`
		: "";
	return {
		status: picks.length > 0 ? "selected" : "none",
		picks,
		detail: `history added ${picks.length} test file(s) from ${matching.size} matching head(s)${hubs.size > 0 && usable.length < changedDirs.size ? `; ${changedDirs.size - usable.length} hub director(ies) ignored` : ""}${note}`,
	};
}

function git(args, { cwd, input }) {
	return execFileSync("git", args, {
		cwd,
		input,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/**
 * Touched paths per head: the head's own first-parent diff. A head missing
 * from the clone, or a merge commit (`git log` prints no diff for one), has no
 * entry in the result. Two git processes for the whole set, however many heads.
 *
 * @param {string[]} heads
 * @param {{ cwd?: string }} [options]
 * @returns {Map<string, string[]>}
 */
export function resolveHeadPaths(heads, { cwd } = {}) {
	const result = new Map();
	if (heads.length === 0) return result;
	const present = git(["cat-file", "--batch-check"], {
		cwd,
		input: `${heads.join("\n")}\n`,
	})
		.split("\n")
		.filter((line) => /^[0-9a-f]{40} commit /.test(line))
		.map((line) => line.slice(0, 40));
	if (present.length === 0) return result;
	// \x01 cannot occur in a path git prints, so it marks each commit header.
	const log = git(
		["log", "--no-walk=unsorted", "--stdin", "--format=%x01%H", "--name-only"],
		{ cwd, input: `${present.join("\n")}\n` },
	);
	for (const block of log.split("\x01").filter(Boolean)) {
		const [sha, ...files] = block.split("\n").filter(Boolean);
		if (files.length > 0) result.set(sha, files);
	}
	return result;
}

/**
 * Reads the summary from a file (`--history-summary`) or the data-branch ref.
 * Returns `{ summary }` or `{ error }` with a reason that names which of the
 * three failures happened (absent ref or file, unreadable file, bad JSON).
 */
export function readHistorySummary({ file, cwd } = {}) {
	let text;
	try {
		text = file
			? readFileSync(file, "utf8")
			: git(["show", `${HISTORY_REF}:${HISTORY_SUMMARY_PATH}`], { cwd });
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message.split("\n")[0] : "";
		return {
			error: file
				? `cannot read ${file} (${detail})`
				: `no ${HISTORY_REF}:${HISTORY_SUMMARY_PATH} (absent ref or file)`,
		};
	}
	try {
		return { summary: JSON.parse(text) };
	} catch {
		return { error: `${file ?? HISTORY_REF} is not valid JSON` };
	}
}

/**
 * The impure entry the pre-push script calls. A failure anywhere degrades to
 * "unavailable" with the reason in `detail`; selection is advisory input to a
 * hook and must never block a push on a history problem.
 */
export function loadHistorySelection({ changed, allTests, now, file, cwd }) {
	try {
		const read = readHistorySummary({ file, cwd });
		if ("error" in read)
			return {
				status: "unavailable",
				picks: [],
				detail: `history unreadable (${read.error}); import-only`,
			};
		return selectFromHistory({
			summary: read.summary,
			changed,
			allTests,
			pathsForHeads: (heads) => resolveHeadPaths(heads, { cwd }),
			now,
		});
	} catch (error) {
		return {
			status: "unavailable",
			picks: [],
			detail: `history unreadable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); import-only`,
		};
	}
}
