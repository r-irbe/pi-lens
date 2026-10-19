// File-level rule for workflow edits no pull request executes (#3085 gap 1).
//
// THE RECURRENCE (#3043). #3033 edited install-smoke.yml steps that only ran
// on master pushes; six cells then failed on every master push for a day. The
// job-level sweep (tests/config/workflow-pull-request-reachability.test.ts)
// judges the jobs of workflows a pull request can trigger. It cannot see a
// workflow file whose EDIT never executes on the PR at all, so the only cover
// for those edits was one AGENTS.md sentence nothing enforced.
//
// WHAT COUNTS AS "THE EDIT EXECUTES ON THE PR": the post-image of the edited
// file runs on a `pull_request` event of the PR. Four shapes do not:
//   - no `pull_request` trigger (schedule, workflow_dispatch, push,
//     workflow_run, labels, release: tool-smoke, release, stale, ...);
//   - `pull_request_target` only: GitHub runs the BASE branch's copy of the
//     file, so the edited lines are not the lines that run (greetings.yml,
//     close-keyword-verification.yml);
//   - a `pull_request` trigger whose `paths:`/`paths-ignore:` filter excludes
//     the workflow file itself;
//   - a `pull_request` trigger whose `types:` list names neither `opened` nor
//     `synchronize`, so a push to the PR never starts it.
// An `on:` block this reader cannot parse is treated as not executing: the
// rule fails closed and asks for evidence rather than reading clean.
//
// The reader is dependency-free on purpose: the PR-body lane runs
// `node scripts/check-pr-body.mjs` with no `npm install`, so js-yaml is not
// available there. tests/config/workflow-pull-request-reachability.test.ts
// pins this reader against js-yaml over every workflow in the tree.
import { matchGlob } from "./tla-coverage.mjs";

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const RUN_ID = /(?:\/actions\/runs\/|\brun[ -]?id\b[^\d\n]{0,4})(\d{8,})/i;
// Lines after the `gh workflow run` line that may carry its run id. A pasted
// transcript puts the id on the next line or two; the window is bounded so one
// run id cannot satisfy every edited workflow in a long body.
const RUN_ID_WINDOW_LINES = 8;

const stripComment = (line) => line.replace(/(^|\s)#.*$/, "$1").trimEnd();
const indentOf = (line) => /^ */.exec(line)[0].length;
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

function flowList(value) {
	const match = /^\[(.*)\]$/.exec(value.trim());
	return match ? match[1].split(",").map(unquote).filter(Boolean) : null;
}

// `paths`, `paths-ignore` and `types` of one trigger: a flow list on the key's
// line, or a block list beneath it, optionally anchored (`&name`) or an alias
// (`*name`) of an earlier anchored list, the way install-smoke.yml shares one
// `paths:` between `push` and `pull_request`. Anything else is unparsed (null).
function readFilter(subLines, key, anchors) {
	const keyIndex = subLines.findIndex((line) =>
		new RegExp(`^\\s*${key}\\s*:`).test(line),
	);
	if (keyIndex < 0) return undefined;
	let inline = subLines[keyIndex].replace(/^[^:]+:\s*/, "").trim();
	const alias = /^\*(\S+)$/.exec(inline);
	if (alias) return anchors.get(alias[1]) ?? null;
	const anchor = /^&(\S+)\s*(.*)$/.exec(inline);
	if (anchor) inline = anchor[2];
	let value;
	if (inline) value = flowList(inline);
	else {
		const keyIndent = indentOf(subLines[keyIndex]);
		const items = [];
		for (const line of subLines.slice(keyIndex + 1)) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("- ")) break;
			if (indentOf(line) < keyIndent) break;
			items.push(unquote(trimmed.slice(2)));
		}
		value = items.length ? items : null;
	}
	if (anchor && value) anchors.set(anchor[1], value);
	return value;
}

/**
 * The triggers a workflow file's `on:` declares, as
 * `Map<name, { paths?, pathsIgnore?, types?, unparsed? }>`, or `null` when the
 * block is absent or in a spelling this reader does not parse (a flow
 * mapping). The three spellings GitHub accepts are read: a scalar, a list, a
 * mapping.
 */
export function readWorkflowTriggers(text) {
	const lines = String(text ?? "")
		.split(/\r?\n/)
		.map(stripComment);
	const start = lines.findIndex((line) => /^(?:on|"on"|'on')\s*:/.test(line));
	if (start < 0) return null;
	const triggers = new Map();
	const inline = lines[start].replace(/^[^:]+:\s*/, "").trim();
	// An anchor or alias on `on:` itself, or a merge key anywhere in the block,
	// hides triggers this reader cannot see: fail closed (null).
	if (/^[&*]/.test(inline)) return null;
	if (inline) {
		const list = flowList(inline);
		if (list) {
			for (const name of list) triggers.set(name, {});
			return triggers;
		}
		if (/^[{[]/.test(inline)) return null;
		triggers.set(unquote(inline), {});
		return triggers;
	}
	const block = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.trim()) continue;
		if (indentOf(line) === 0 && !line.startsWith("- ")) break;
		block.push(line);
	}
	if (!block.length) return null;
	if (block.some((line) => /^\s*(?:-\s+)?(?:<<\s*:|[&*])/.test(line)))
		return null;
	const base = indentOf(block[0]);
	if (block[0].trim().startsWith("- ")) {
		for (const line of block)
			if (indentOf(line) === base && line.trim().startsWith("- "))
				triggers.set(unquote(line.trim().slice(2)), {});
		return triggers;
	}
	const anchors = new Map();
	// Anchored trigger mappings (`defaults: &pr` over a block), kept as the
	// block's own lines so an alias (`pull_request: *pr`) reads the same filters.
	const mappings = new Map();
	let current = null;
	let anchored = null;
	let sub = [];
	const flush = () => {
		if (!current) return;
		const entry = triggers.get(current);
		if (anchored) mappings.set(anchored, sub);
		for (const [field, key] of [
			["paths", "paths"],
			["pathsIgnore", "paths-ignore"],
			["types", "types"],
		]) {
			const value = readFilter(sub, key, anchors);
			if (value === null) entry.unparsed = true;
			else if (value !== undefined) entry[field] = value;
		}
	};
	for (const line of block) {
		const key =
			indentOf(line) === base ? /^(\S+?)\s*:\s*(.*)$/.exec(line.trim()) : null;
		if (key) {
			flush();
			current = unquote(key[1]);
			sub = [];
			anchored = null;
			// The value after an optional `&anchor`: empty (a block follows), an
			// empty mapping or null, an alias of an anchored block, or anything else
			// (a flow mapping, a scalar) this reader does not read.
			const head = /^&(\S+)\s*(.*)$/.exec(key[2].trim());
			if (head) anchored = head[1];
			const value = (head ? head[2] : key[2]).trim();
			const alias = /^\*(\S+)$/.exec(value);
			const resolved = alias ? mappings.get(alias[1]) : undefined;
			if (alias && resolved) sub = [...resolved];
			triggers.set(
				current,
				value === "" || value === "{}" || value === "null" || value === "~"
					? {}
					: alias && resolved
						? {}
						: { unparsed: true },
			);
		} else sub.push(line);
	}
	flush();
	return triggers;
}

function pathFilterMatches(patterns, file) {
	let included = false;
	for (const pattern of patterns) {
		const negated = pattern.startsWith("!");
		if (matchGlob(negated ? pattern.slice(1) : pattern, file))
			included = !negated;
	}
	return included;
}

/**
 * Does the post-image of `file` execute on a pull request of its own edit?
 * `{ executes: true }`, or `{ executes: false, reason, dispatchable }` where
 * `dispatchable` says `gh workflow run` can start it (a `workflow_dispatch`
 * trigger).
 */
export function classifyWorkflowEdit(text, file) {
	const triggers = readWorkflowTriggers(text);
	if (!triggers)
		return {
			executes: false,
			reason: "its `on:` block could not be read",
			dispatchable: true,
		};
	const dispatchable = triggers.has("workflow_dispatch");
	const pr = triggers.get("pull_request");
	if (!pr)
		return {
			executes: false,
			reason: triggers.has("pull_request_target")
				? "it has only a pull_request_target trigger, which runs the base branch's copy of the file"
				: "it has no pull_request trigger",
			dispatchable,
		};
	if (pr.unparsed)
		return {
			executes: false,
			reason: "its pull_request filters could not be read",
			dispatchable,
		};
	if (pr.paths && !pathFilterMatches(pr.paths, file))
		return {
			executes: false,
			reason:
				"its pull_request `paths:` filter excludes the workflow file itself",
			dispatchable,
		};
	if (pr.pathsIgnore?.some((pattern) => matchGlob(pattern, file)))
		return {
			executes: false,
			reason:
				"its pull_request `paths-ignore:` filter matches the workflow file itself",
			dispatchable,
		};
	if (
		pr.types &&
		!pr.types.some((type) => type === "opened" || type === "synchronize")
	)
		return {
			executes: false,
			reason:
				"its pull_request `types:` list never starts it on a push to the PR",
			dispatchable,
		};
	return { executes: true };
}

// The names a body may use for `file`: the bare name or the full path. Matched
// as whole tokens, never as a pattern built from the name.
const namesOf = (file) => [file.slice(file.lastIndexOf("/") + 1), file];

// HTML comments are the one place prose could satisfy the rule invisibly.
const blankComments = (body) =>
	String(body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");

function quotesRunId(lines, file) {
	const names = namesOf(file);
	return lines.some((line, index) => {
		const argument = /\bgh\s+workflow\s+run\s+(\S+)/.exec(line)?.[1];
		return (
			argument !== undefined &&
			names.includes(unquote(argument)) &&
			/--ref\b/.test(line) &&
			lines
				.slice(index, index + RUN_ID_WINDOW_LINES)
				.some((candidate) => RUN_ID.test(candidate))
		);
	});
}

function declaresUnaffected(lines, file) {
	const names = namesOf(file);
	return lines.some((line) => {
		const head = /^\s*(?:[-*+]\s+)?\**Workflow run unaffected:\s*/.exec(line);
		if (!head) return false;
		const rest = line.slice(head[0].length);
		// The name ends at a boundary (`x.yml-old` is another file) and a dash and
		// a reason follow it.
		return names.some((name) => {
			if (!rest.startsWith(name)) return false;
			const after = rest.slice(name.length);
			return !/^[\w.-]/.test(after) && /^\s*[\u2014\u2013-]\s*\S/.test(after);
		});
	});
}

// What an image says once the lines that carry no behaviour are dropped:
// whole-line comments, blank lines and trailing blanks. Everything inside a
// block scalar body (`run: |`, `>`, `|-`, `>+`, `|2`: the indicator line plus
// every more-indented line after it) is kept VERBATIM, `#` lines and blanks
// included, because there it is shell payload (`#!/bin/bash`, a heredoc
// line), not YAML. A trailing comment on a content line and indentation also
// count as changes. Limit: a multi-line quoted or plain scalar is not tracked.
const BLOCK_SCALAR = /[:-]\s+(?:[&!]\S+\s+)*[|>][+-]?\d?[+-]?\s*(?:#.*)?$/;
const behaviour = (text) => {
	const lines = String(text).split(/\r?\n/);
	const out = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!/^\s*(?:#.*)?$/.test(line)) out.push(line.trimEnd());
		else continue;
		if (!BLOCK_SCALAR.test(line)) continue;
		const indent = indentOf(line);
		let end = index + 1;
		let lastContent = index;
		for (; end < lines.length; end += 1) {
			if (lines[end].trim() === "") continue;
			if (indentOf(lines[end]) <= indent) break;
			lastContent = end;
		}
		for (let body = index + 1; body <= lastContent; body += 1)
			out.push(`\u0000${lines[body]}`);
	}
	return out;
};

/** True when `after` differs from `before` only by whole-line comments and blanks. */
export function isCommentOrWhitespaceOnlyEdit(before, after) {
	if (before === null || before === undefined) return false;
	const a = behaviour(before);
	const b = behaviour(after);
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * The rule: every changed workflow file whose edit no pull request executes
 * must have its branch run (`gh workflow run <file> --ref <branch>`) quoted
 * with a run id in the PR body. A `Workflow run unaffected: <file> \u2014
 * <reason>` line clears it only when the check can verify the claim: the
 * workflow has no `workflow_dispatch` trigger (it cannot be run on a branch at
 * all), or the edit is comments and blank lines only. `readWorkflow(file)`
 * returns the post-image text, or `null` for a file the PR deleted;
 * `readBaseWorkflow(file)` the merge-base image, or `null` for an added file.
 */
export function evaluateWorkflowRunEvidence({
	changedFiles = [],
	body = "",
	readWorkflow,
	readBaseWorkflow = () => null,
}) {
	const lines = blankComments(body).split(/\r?\n/);
	const errors = [];
	for (const file of [...new Set(changedFiles)].sort()) {
		if (!WORKFLOW_PATH.test(file)) continue;
		const text = readWorkflow(file);
		if (text === null) continue;
		const verdict = classifyWorkflowEdit(text, file);
		if (verdict.executes) continue;
		if (quotesRunId(lines, file)) continue;
		const name = file.slice(file.lastIndexOf("/") + 1);
		const evidence = `run \`gh workflow run ${name} --ref <branch>\` and quote the command with its run id`;
		const declared = declaresUnaffected(lines, file);
		if (
			declared &&
			(!verdict.dispatchable ||
				isCommentOrWhitespaceOnlyEdit(readBaseWorkflow(file), text))
		)
			continue;
		errors.push(
			`Changed workflow ${file} has no pull request run of its edit (${verdict.reason}): ` +
				(declared
					? `its "Workflow run unaffected" line is not accepted because the workflow can be run by hand and the edit is more than comments and blank lines; ${evidence}.`
					: verdict.dispatchable
						? `${evidence}; a "Workflow run unaffected: ${name} \u2014 <reason>" line is accepted only for an edit of comments and blank lines.`
						: `it has no workflow_dispatch trigger to run it by hand: add "Workflow run unaffected: ${name} \u2014 <reason>" to the PR body, or add the trigger and ${evidence}.`),
		);
	}
	return errors;
}
