import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SECTION = "Orchestrator lane mechanics";

// PI_LENS_CONTRACT_DOCS_DIR lets the red run point at the pre-change docs, as
// PI_LENS_AGENTS_PATH does for agents-governance.test.ts.
function doc(name: string): string {
	return fs.readFileSync(
		path.join(
			process.env.PI_LENS_CONTRACT_DOCS_DIR ?? path.join(REPO_ROOT, "docs"),
			name,
		),
		"utf8",
	);
}

// Fenced blocks and HTML comments do not count: a heading or grant name quoted
// in an example must not satisfy a presence pin.
function blankMarkdown(text: string): string {
	const blank = (value: string): string => value.replace(/[^\n]/g, " ");
	return text
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, blank);
}

// Blanking keeps offsets, so the section's span in the blanked text is its
// span in the raw text.
function sectionSpan(text: string): [number, number] | undefined {
	const blanked = blankMarkdown(text);
	const start = blanked.search(new RegExp(`^## ${SECTION}\\s*$`, "m"));
	if (start < 0) return undefined;
	const next = blanked.slice(start + 1).search(/^## /m);
	return [start, next < 0 ? text.length : start + 1 + next];
}

function sectionBody(text: string): string {
	const span = sectionSpan(text);
	return span ? text.slice(span[0], span[1]) : "";
}

function outsideSection(text: string): string {
	const span = sectionSpan(text);
	return span ? text.slice(0, span[0]) + text.slice(span[1]) : text;
}

const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("orchestrator lane mechanics contract (#4007)", () => {
	// Recurrence: about 30 delegated briefs each restated the same lane
	// boilerplate, so the copies drifted; the one home is this section.
	it("keeps the section in the shared subagent contract", () => {
		expect(sectionBody(doc("pi-lens-subagent.md")).trim()).not.toBe("");
	});

	// Recurrence: a brief naming a grant that the contract does not define (or
	// a renamed grant) leaves workers guessing what push/PR authority they hold.
	it("defines each Git-authority grant by name", () => {
		const body = sectionBody(doc("pi-lens-subagent.md"));
		for (const grant of ["own-branch", "fork-push", "none"]) {
			expect(body, grant).toMatch(new RegExp(`^ {2}- \`${grant}\`: `, "m"));
		}
	});

	// Recurrence: #3173 (`git worktree remove` over a symlinked node_modules
	// deleted the main install), #3526 (checkouts under tmpfs /tmp), and
	// worker commands run without a lane TMPDIR.
	it("states the checkout, teardown, TMPDIR and summary rules", () => {
		const body = flat(sectionBody(doc("pi-lens-subagent.md")));
		expect(body).toContain(
			"~/.local/share/pi-lens-orchestrator/tmp/<lane>`, never under `/tmp`",
		);
		expect(body).toContain(
			"TMPDIR=~/.local/share/pi-lens-orchestrator/tmp/<lane>-tmp",
		);
		expect(body).toMatch(
			/`rm` a symlinked `node_modules` before `git worktree remove`/,
		);
		expect(body).toContain("#3173");
		expect(body).toContain("Never force");
		expect(body).toContain("ORCHESTRATOR SUMMARY`. Its cap");
		expect(body).toContain("at most 6 lines for a mechanical lane");
		expect(body).toMatch(
			/20 for a locate or investigation\s+pass, and 30 for a fix or review round/,
		);
	});

	// Recurrence: #4044 (2026-10-07: a verify worker's `npm ci --ignore-scripts
	// --dry-run` through a linked node_modules emptied the main install under
	// every lane; the contract only said "preserve linked dependencies" and the
	// brief itself invited the local run).
	it("forbids mutating npm verbs through a linked node_modules and names the scratch-copy answer", () => {
		const body = flat(sectionBody(doc("pi-lens-subagent.md")));
		expect(body).toMatch(
			/Never run a mutating npm verb \([^)]*`ci`[^)]*\), even `--dry-run`, where `node_modules` is a link/,
		);
		expect(body).toContain("#4044");
		expect(body).toContain("Answer install-flag questions in a scratch copy");
		// #4044 sibling: the slash/glob delete forms empty the link target.
		expect(body).toContain(
			"Unlink with `rm node_modules` (no trailing slash or glob)",
		);
	});

	// Recurrence: the section is only useful when the role contracts point to
	// it instead of carrying their own copy.
	it.each(["pi-lens-fixer.md", "pi-lens-reviewer.md"])(
		"points %s at the section",
		(name) => {
			expect(flat(doc(name))).toContain(
				`\`docs/pi-lens-subagent.md\` "${SECTION}"`,
			);
		},
	);

	// Recurrence: the removed copies were the push-form and scratch-path lines
	// that now live only in the section.
	it("keeps the push form and lane TMPDIR in one place", () => {
		const subagent = doc("pi-lens-subagent.md");
		const outside = outsideSection(subagent);
		expect(outside).not.toContain(
			"credential.helper='!gh auth git-credential'",
		);
		expect(outside).not.toContain("pi-lens-orchestrator/tmp/<lane>");
		expect(doc("pi-lens-reviewer.md")).not.toContain(
			"pi-lens-orchestrator/tmp/<lane>",
		);
	});
});
