/**
 * Renders the driver's `reports/mutation/mutation.json` (Stryker's own
 * report augmented with a `piLensMutationDiff` key -- see
 * scripts/stryker-diff.mjs's writeReport) as the markdown used for the job
 * summary and the nightly tracking-issue body (scripts/stryker-nightly.mjs,
 * #4005), and by `scripts/mutation-report.mjs` for citing a report directly
 * (#3531).
 *
 * Pure and file-I/O-free so it is unit-testable against literal report
 * fixtures; scripts/mutation-report.mjs and the workflow step are the only
 * callers that touch the filesystem.
 */

function shortSha(sha) {
	return typeof sha === "string" ? sha.slice(0, 12) : "unknown";
}

function metaTable(meta) {
	const rows = [
		["Base", meta.base ?? "?"],
		["Head", `\`${shortSha(meta.headSha)}\``],
	];
	if ((meta.filesSkippedOverCap?.length ?? 0) > 0) {
		rows.push([
			"Skipped (over --max-files)",
			meta.filesSkippedOverCap.join(", "),
		]);
	}
	if ((meta.filesUncovered?.length ?? 0) > 0) {
		rows.push(["No covering test", meta.filesUncovered.join(", ")]);
	}
	const selectionRow = testSelectionRow(meta);
	if (selectionRow) rows.push(selectionRow);
	const incrementalRow = incrementalRowOf(meta);
	if (incrementalRow) rows.push(incrementalRow);
	const rendered = rows.map(([k, v]) => `- **${k}:** ${v}`);
	if ((meta.testsExcluded?.length ?? 0) > 0) {
		rendered.push(
			"- **Excluded tests:**",
			...meta.testsExcluded.map(
				({ file, reason }) => `  - \`${file}\` — ${reason}`,
			),
		);
	}
	return rendered.join("\n");
}

/**
 * The `related N → covering M → kept K` line the driver logs and the report's
 * metadata table shows (#3810). `covering` is null when no coverage probe was
 * usable and the kept set came from the import graph alone.
 *
 * @param {{pool: number, covering: number | null, kept: number, own?: number, unknown?: number, overBudget?: number, estimatedSeconds?: number | null}} selection
 */
export function formatTestSelection(selection) {
	const covering =
		selection.covering === null
			? "coverage unavailable (import-graph ranking)"
			: String(selection.covering);
	const extras = [
		selection.own > 0 ? `${selection.own} own` : null,
		selection.unknown > 0 ? `${selection.unknown} probe failed` : null,
		selection.overBudget > 0
			? `${selection.overBudget} over the runtime cap${typeof selection.estimatedSeconds === "number" ? `, ~${Math.round(selection.estimatedSeconds)} s kept` : ""}`
			: null,
	].filter(Boolean);
	return `related ${selection.pool} → covering ${covering} → kept ${selection.kept}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
}

function validTestSelection(meta) {
	const selection = meta.testSelection;
	return selection &&
		typeof selection.pool === "number" &&
		typeof selection.kept === "number" &&
		typeof selection.dropped === "number" &&
		(selection.covering === null || typeof selection.covering === "number")
		? selection
		: null;
}

function testSelectionRow(meta) {
	const selection = validTestSelection(meta);
	return selection ? ["Test selection", formatTestSelection(selection)] : null;
}

const INCREMENTAL_STATES = {
	"cold-no-cache": "cold (no restored cache)",
	"cold-inputs-changed":
		"cold (a kept test or another changed file differs from the cached run)",
};

function incrementalRowOf(meta) {
	const incremental = meta.incremental;
	if (!incremental) return null;
	if (incremental.state === "warm") {
		return [
			"Incremental",
			typeof incremental.reused === "number" &&
			typeof incremental.total === "number"
				? `${incremental.reused} of ${incremental.total} mutant result(s) reused from the previous push`
				: "restored cache accepted (reuse count unavailable)",
		];
	}
	const text = INCREMENTAL_STATES[incremental.state];
	if (!text) return null;
	const changed = Array.isArray(incremental.changed)
		? incremental.changed.filter((input) => typeof input === "string")
		: [];
	if (incremental.state !== "cold-inputs-changed" || changed.length === 0) {
		return ["Incremental", text];
	}
	const shown = changed.slice(0, 5).map((input) => `\`${input}\``);
	const more = changed.length > 5 ? ` and ${changed.length - 5} more` : "";
	return ["Incremental", `${text}: ${shown.join(", ")}${more}`];
}

// Only a DROPPED test makes the population truncated: kept < covering is not
// the test, since a PR's own tests are kept whether or not they cover a line.
// Two caps drop tests: the count cap (`dropped`) and the runtime cap
// (`overBudget`, #4092); each is named, because the second also drops own tests.
function testCapNotice(meta) {
	const selection = validTestSelection(meta);
	const overBudget = selection?.overBudget > 0 ? selection.overBudget : 0;
	if (!selection || (selection.dropped <= 0 && overBudget === 0)) return null;
	const drops = [
		selection.dropped > 0
			? `${selection.dropped} ${selection.covering === null ? "related" : "covering"} test(s) dropped by the test cap`
			: null,
		overBudget > 0
			? `${overBudget} test(s) dropped by the runtime cap${typeof selection.estimatedSeconds === "number" ? ` (~${Math.round(selection.estimatedSeconds)} s of estimated test time kept)` : ""}`
			: null,
	].filter(Boolean);
	return `**Bounded evidence:** ${drops.join("; ")} (${selection.kept} kept). The score is from a truncated test population.`;
}

const BOUNDED_CELL_CHARS = 160;
const clipCell = (text) =>
	text.length > BOUNDED_CELL_CHARS
		? `${text.slice(0, BOUNDED_CELL_CHARS)}...`
		: text;

/**
 * @param {object} report a parsed reports/mutation/mutation.json
 * @param {{maxSurvivors?: number}} [options] `maxSurvivors` bounds the survivor
 *   table (and clips each cell) for a destination with a size limit, such as a
 *   GitHub issue body (#4005); the heading keeps the full count.
 * @returns {string} markdown
 */
export function renderMutationMarkdown(report, { maxSurvivors } = {}) {
	const meta = report?.piLensMutationDiff ?? {};
	const lines = ["### Mutation diff (advisory)", ""];

	// round 2 R2-1: shared by the zero-mutant and the scored path below, so a
	// run that sampled ranges down and then found nothing still SAYS it
	// sampled -- previously the zero-mutant branch returned before this note
	// was ever built, so a false-looking "no mutable code in M ranges" verdict
	// carried no hint that only a subset of M was actually tried.
	const samplingNote = meta.rangesSampled
		? `_Sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges deterministically (seed \`${shortSha(meta.headSha)}\`)._`
		: null;

	// round 5 R4-1: `meta.counts` is only ever set by THIS driver's own
	// completed/partial write paths. A raw Stryker `mutation.json` -- read
	// directly, never through `scripts/stryker-diff.mjs`'s `writeReport` --
	// carries no `piLensMutationDiff` at all, so `meta.counts` is absent even
	// though `report.files` holds real mutants. Deriving the counts (and so
	// the total the backstop below reads) from those mutants when `counts`
	// itself is missing keeps the backstop from misreading a genuine result
	// as 0 evaluated (verified: at `fbb080105`, a raw report with 1 Survived +
	// 1 Killed and no meta rendered "0 mutants evaluated" instead of "####
	// Survivors (1)") -- and keeps the score line's own killed/survived/…
	// breakdown consistent with that total, rather than showing "(2 total)"
	// against "0 killed, 0 survived".
	const counts =
		meta.counts ??
		Object.values(report?.files ?? {}).reduce((out, file) => {
			for (const mutant of file.mutants ?? []) {
				out[mutant.status] = (out[mutant.status] ?? 0) + 1;
			}
			return out;
		}, {});
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

	// round 4 R3-1: a backstop at the render seam, independent of which
	// driver branch wrote the report. Every driver path that evaluates zero
	// mutants is SUPPOSED to set `meta.zeroMutants`, and every interrupted
	// path with a usable result is SUPPOSED to set `meta.partial` -- but the
	// review found the driver's own success-vs-zero and partial-vs-zero `if`s
	// still readable as removable duplicates: mutating either one (`if
	// (mutants.length > 0)` to `>= 0`, or `if (outcome.partial)` to `false`)
	// produced a report with NEITHER `zeroMutants` NOR `partial` set and 0
	// total mutants -- the exact S1 clean-pass signature -- with all four
	// mutation test files still 100/100 green, since nothing exercises the
	// DRIVER's own branch, only the library functions it calls. This renders
	// that same signature as "not a clean pass" regardless of which driver
	// path (existing or one written later) produced it.
	const zeroMutants =
		meta.zeroMutants ??
		(!meta.partial && total === 0
			? {
					reason:
						"the report has no zeroMutants explanation and no partial result, but scored 0 total mutants -- rendered as unresolved rather than a clean pass",
				}
			: null);

	if (zeroMutants) {
		lines.push(
			"**0 mutants evaluated.** This is not a clean pass -- it means the lane found nothing to mutate or could not finish.",
			"",
			`> ${zeroMutants.reason}`,
			"",
		);
		if (samplingNote) lines.push(samplingNote, "");
		const capNote = testCapNotice(meta);
		if (capNote) lines.push(capNote, "");
		lines.push(metaTable(meta));
		return lines.join("\n");
	}

	// #3592 item 2: a second, independent backstop from round 4's R3-1 one
	// above. That one catches a report with 0 total mutants and neither
	// `zeroMutants` nor `partial` set. This one catches the OTHER shape a
	// dropped `partial` flag can produce: a run that was cut short AFTER
	// evaluating SOME mutants (so `total > 0`, the R3-1 backstop does not
	// fire) but fewer than the dry run measured for this same, unsampled
	// candidate set -- if a future driver change stopped setting
	// `meta.partial` on that path, the report would otherwise render as a
	// normal, complete scored pass with a silently short survivor table.
	// Only meaningful when NOT sampled: a sampled run legitimately evaluates
	// fewer mutants than `measuredTotalMutants` (which counts the WHOLE
	// candidate range set, not just the sampled subset) by design, and no
	// per-range count exists to compute an expected sampled total (#3592
	// item 1).
	// F3 (#3592 round 2): `!zeroMutants` and `total > 0` were dead conjuncts
	// -- control flow can only reach this line when the `if (zeroMutants)`
	// branch above did NOT return, i.e. `zeroMutants` is already falsy here,
	// and (given `!meta.partial` below) `total !== 0` follows from
	// `zeroMutants`'s own definition (`!meta.partial && total === 0`), so
	// `total > 0` was equally guaranteed rather than checked. Removed; the
	// remaining four conjuncts are the only ones a mutation can affect.
	const evaluatedMismatch =
		!meta.partial &&
		!meta.rangesSampled &&
		typeof meta.measuredTotalMutants === "number" &&
		meta.measuredTotalMutants !== total;

	if (evaluatedMismatch) {
		lines.push(
			`**Incomplete run.** This is not a clean pass -- ${total} mutant(s) were evaluated but the dry run measured ${meta.measuredTotalMutants}, and the report carries no partial explanation.`,
			"",
		);
		lines.push(metaTable(meta));
		return lines.join("\n");
	}

	const survivors = Object.entries(report.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? [])
				.filter((m) => m.status === "Survived")
				.map((mutant) => ({ ...mutant, fileName })),
	);

	// round 2 S2: a budget kill can still leave a real, partial result --
	// labelled here so it is never confused with a run that evaluated every
	// range it set out to.
	if (meta.partial) {
		lines.push(
			`**Partial run** -- ${meta.partial.evaluated} of ${meta.partial.total ?? "an unknown total of"} mutant(s) evaluated before the interrupt.`,
			"",
			`> ${meta.partial.reason}`,
			"",
		);
	}

	const capNote = testCapNotice(meta);
	lines.push(
		`**Score: ${meta.score ?? "n/a"}%** -- ${counts.Killed ?? 0} killed, ${counts.Survived ?? 0} survived, ${counts.Timeout ?? 0} timeout, ${counts.NoCoverage ?? 0} no coverage (${total} total)${capNote ? ` — ${capNote.replaceAll("**", "")}` : ""}`,
		"",
	);

	if (samplingNote) lines.push(samplingNote, "");

	if (survivors.length > 0) {
		lines.push(`#### Survivors (${survivors.length})`, "");
		lines.push("| Location | Mutator | Original → Replacement |");
		lines.push("|---|---|---|");
		const bounded = typeof maxSurvivors === "number";
		const shown = bounded ? survivors.slice(0, maxSurvivors) : survivors;
		const cell = (text) => (bounded ? clipCell(text) : text);
		for (const mutant of shown) {
			const location = mutant.tsLocation
				? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
				: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
			const original = cell(mutant.original ?? "").replaceAll("|", "\\|");
			const replacement = cell(mutant.replacement ?? "").replaceAll("|", "\\|");
			lines.push(
				`| \`${location}\` | ${mutant.mutatorName} | \`${original}\` → \`${replacement}\` |`,
			);
		}
		if (shown.length < survivors.length) {
			lines.push(
				"",
				`_Showing the first ${shown.length} of ${survivors.length} survivors; the full list is in the \`mutation-report\` workflow artifact (kept 90 days)._`,
			);
		}
		lines.push("");
	} else {
		lines.push("No survivors.", "");
	}

	lines.push(metaTable(meta));
	if ((meta.testsRun?.length ?? 0) > 0) {
		lines.push(
			"",
			`<details><summary>Tests run (${meta.testsRun.length})</summary>\n\n${meta.testsRun.map((t) => `- \`${t}\``).join("\n")}\n\n</details>`,
		);
	}

	return lines.join("\n");
}
