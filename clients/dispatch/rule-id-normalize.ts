/**
 * Normalize a rule id to the form a user typically writes in a
 * `pi-lens-ignore` comment, an inline suppression, or a project-level
 * `disable`/`select` list. Strips the LSP source prefixes (`ast-grep:`;
 * `shuck:` for the shuck LSP's native `C/S/P/X/K` codes, #3968) and the
 * language suffix used by the rule catalogs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAstGrepRuleSources } from "../sgconfig.js";

/** Derive language tags from shipped rule filenames, rather than a list. */
export function deriveRuleIdLanguageSuffixes(ruleRoot: string): Set<string> {
	const suffixes = new Set<string>();
	const visit = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else {
				const match = /-([a-z0-9]+)\.ya?ml$/i.exec(entry.name);
				if (match) suffixes.add(match[1].toLowerCase());
			}
		}
	};
	visit(ruleRoot);
	return suffixes;
}

const bundledCodeRabbitRules = getAstGrepRuleSources().find(
	(source) => source.origin === "bundled" && source.tier === "secondary",
);
const RULE_ID_LANGUAGE_SUFFIXES = new Set(["js"]);
if (bundledCodeRabbitRules) {
	for (const suffix of deriveRuleIdLanguageSuffixes(
		bundledCodeRabbitRules.dir,
	)) {
		RULE_ID_LANGUAGE_SUFFIXES.add(suffix);
	}
}

/**
 * LSP diagnostic source prefixes that a user's suppressed spelling omits.
 * LSP-sourced diagnostics render `rule` as `"<source>:<code>"`
 * (`clients/dispatch/utils/lsp-diagnostics.ts`), but the user lists the BARE
 * code in `pi-lens-ignore` comments and `rules.<id>.disable` — so those
 * namespaces (plus `shuck`'s native `C/S/P/X/K` codes, whose diagnostics the
 * shuck LSP sources as `shuck:C001`; #3968) strip the prefix before the
 * policy, inline-suppression and matcher comparisons run. Anchored at the
 * start (only the rendered `<source>:` form), so a code that merely CONTAINS
 * the token keeps matching raw.
 */
const LSP_SOURCE_PREFIXES = ["ast-grep:", "shuck:"];

export function normalizeRuleId(ruleId: string): string {
	let normalized = ruleId;
	for (const prefix of LSP_SOURCE_PREFIXES) {
		if (normalized.startsWith(prefix)) {
			normalized = normalized.slice(prefix.length);
			break;
		}
	}
	for (const suffix of RULE_ID_LANGUAGE_SUFFIXES) {
		if (normalized.endsWith(`-${suffix}`)) {
			normalized = normalized.slice(0, -(suffix.length + 1));
		}
	}
	return normalized;
}
