const CLOSE_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;
// GitHub does not link a keyword and a number split by a newline (#2121).
const CLOSE_ISSUE = /[ \t]*:?[ \t]*#(\d+)/y;
const COMMA_ISSUE = /\s*,\s*#(\d+)/y;

// A clause is the text since the last sentence or clause boundary. A hedge in
// the same clause as the keyword ("not fixed: #N", "Whether this closes #N")
// still leaves GitHub's adjacency rule satisfied, so GitHub closes the issue
// anyway (#4371). A closing line elsewhere ("... are complete. Closes #N",
// "(closes #N", "not a draft and closes #N", "Not a breaking change - Closes
// #N") has its own clause and stays clean.
const CLAUSE_BOUNDARY = /[.!?;,:()\n\u2014\u2013]| - |\b(?:and|but)\b/gi;
const HEDGE =
	/\b(?:not|never|no|cannot|neither|nor|hardly|partial(?:ly)?|whether|if|unless|without|until)\b|n't\b/i;

export const NEGATED_CLOSE_KEYWORD_MESSAGE =
	'Invalid close-keyword usage: GitHub closes the issue for any "keyword #N" or "keyword: #N", even inside a table row or after "not", "never", "partially" or "whether". Rephrase so the keyword is not directly followed by the number, for example "#N stays open" or "refs #N".';

export const INVALID_CLOSE_KEYWORD_MESSAGE =
	'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").';

export function stripNonSemanticMarkdown(body = "") {
	return body
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

function scanCloseIssues(text = "") {
	// Curly apostrophes (Word, macOS, LLM output) hide "doesn’t" from the hedge
	// test; the swap is one character for one, so offsets are unchanged.
	const scanned = text.replace(/[\u2018\u2019]/g, "'");
	const issues = [];
	const commaLists = [];
	const offendingLines = [];
	const negatedMatches = [];
	const cleanIssues = [];
	for (const match of scanned.matchAll(CLOSE_KEYWORD)) {
		const rest = scanned.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;
		const number = Number(issue[1]);
		if (!issues.includes(number)) issues.push(number);
		const lineStart = scanned.lastIndexOf("\n", match.index) + 1;
		const lineEnd = scanned.indexOf("\n", match.index);
		const line = scanned
			.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
			.trim();
		if (line.startsWith("|") || isHedged(scanned, match.index, lineStart)) {
			negatedMatches.push({ number, line });
		} else if (!cleanIssues.includes(number)) cleanIssues.push(number);
		COMMA_ISSUE.lastIndex = 0;
		if (COMMA_ISSUE.exec(rest.slice(issue[0].length))) {
			commaLists.push(number);
			offendingLines.push(line);
		}
	}
	// Issues GitHub closes only through a table row or hedged clause: the author
	// did not mean to close them (#4371).
	const negatedIssues = issues.filter(
		(number) => !cleanIssues.includes(number),
	);
	// An issue also closed plainly elsewhere is the author's intent (#3583).
	const negatedLines = [
		...new Set(
			negatedMatches
				.filter(({ number }) => negatedIssues.includes(number))
				.map(({ line }) => line),
		),
	];
	return { issues, commaLists, offendingLines, negatedLines, negatedIssues };
}

function isHedged(scanned, keywordIndex, lineStart) {
	const before = scanned.slice(lineStart, keywordIndex);
	let clauseStart = 0;
	for (const boundary of before.matchAll(CLAUSE_BOUNDARY))
		clauseStart = boundary.index + boundary[0].length;
	return HEDGE.test(before.slice(clauseStart));
}

export function parseCloseKeywords(body = "") {
	return scanCloseIssues(stripNonSemanticMarkdown(body));
}

export function lintCloseKeywords(body = "") {
	const parsed = parseCloseKeywords(body);
	return {
		...parsed,
		valid: parsed.commaLists.length === 0 && parsed.negatedIssues.length === 0,
	};
}

/** The error lines every lint consumer prints for an invalid body. */
export function closeKeywordErrors(result) {
	const errors = [];
	if (result.commaLists.length > 0) {
		errors.push(INVALID_CLOSE_KEYWORD_MESSAGE);
		for (const line of result.offendingLines)
			errors.push(`  offending line: ${line}`);
	}
	if (result.negatedLines.length > 0) {
		errors.push(NEGATED_CLOSE_KEYWORD_MESSAGE);
		for (const line of result.negatedLines)
			errors.push(`  offending line: ${line}`);
	}
	return errors;
}

export function lintCloseKeywordPlacement(title = "", body = "") {
	const scannedTitle = String(title);
	const titleIssues = [...scanCloseIssues(scannedTitle).issues];
	for (const match of scannedTitle.matchAll(CLOSE_KEYWORD)) {
		const rest = scannedTitle.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;
		const commaTail = rest.slice(issue[0].length).match(/^(?:\s*,\s*#\d+)+/);
		for (const number of commaTail?.[0].matchAll(/#(\d+)/g) ?? []) {
			const value = Number(number[1]);
			if (!titleIssues.includes(value)) titleIssues.push(value);
		}
	}
	const bodyIssues = parseCloseKeywords(body).issues;
	const missingBodyIssues = titleIssues.filter(
		(number) => !bodyIssues.includes(number),
	);
	return {
		valid: missingBodyIssues.length === 0,
		titleIssues,
		missingBodyIssues,
	};
}

export function closeKeywordPlacementMessage(missing) {
	const repairs = missing.map((number) => `Closes #${number}.`).join(" ");
	const alternatives = missing.map((number) => `refs #${number}`).join(", ");
	return `Invalid close-keyword placement: GitHub only honours closing keywords in the PR body, never in the title. Add the matching body keyword(s): ${repairs} Alternatively, use ${alternatives} in the title.`;
}
