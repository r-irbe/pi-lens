/**
 * #3996: `read_enclosing` answered `tree-sitter failed to parse as bash` for
 * valid scripts. The bash wasm in tree-sitter-wasms@0.1.13 imports `isalpha`,
 * which web-tree-sitter 0.25's main module does not export, so its external
 * scanner threw `TypeError: resolved is not a function` out of `parse()` on
 * every test command comparing with `==` / `!=` (`[ a == b ]`, `[[ a != b ]]`).
 * The parser then stayed dead for every later parse in the process. Heredocs
 * and `$(date +%s)` (the reporter's guess) parse fine on both grammars. The
 * pinned grammar is now the maintained tree-sitter-bash build (the #255 / #427
 * override mechanism). Tools, client and grammar are real; nothing is mocked.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	createReadEnclosingTool,
	createReadSymbolTool,
} from "../../tools/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function script(body: string): { cwd: string; file: string } {
	const env = setupTestEnvironment("pi-lens-bash-read-");
	cleanups.push(env.cleanup);
	createTempFile(env.tmpDir, "startup-smoke.sh", body);
	return { cwd: env.tmpDir, file: "startup-smoke.sh" };
}

async function enclosing(
	cwd: string,
	file: string,
	line: number,
): Promise<{ isError?: boolean; text: string }> {
	const tool = createReadEnclosingTool(
		() => cwd,
		() => {},
	);
	const result = await tool.execute(
		"e",
		{ path: file, line, kinds: ["function"] },
		undefined,
		null,
		{ cwd },
	);
	return { isError: result.isError, text: String(result.content[0]?.text) };
}

// Line 7 is inside `check_args`; the heredoc and substitutions are the
// constructs the report named.
const HEREDOC_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
START="$(date +%s)"

write_config() {
  cat <<EOF2 > out.json
{ "started": $(date +%s) }
EOF2
}

write_indented() {
  cat <<-'EOF'
	indented $(not expanded)
	EOF
}

elapsed() {
  echo "$(( $(date +%s) - START ))s"
}
`;

describe("read_enclosing parses bash (#3996)", () => {
	it("control: heredocs and $(date +%s) alone parse, so they are not the trigger", async () => {
		// Recurrence: the report blamed heredocs and command substitution; the
		// failure is the `==` scanner path, and this control keeps that honest.
		const { cwd, file } = script(HEREDOC_SCRIPT);

		const heredoc = await enclosing(cwd, file, 7);
		const after = await enclosing(cwd, file, 18);

		expect(heredoc.isError).toBeFalsy();
		expect(heredoc.text).toContain("write_config");
		expect(after.isError).toBeFalsy();
		expect(after.text).toContain("elapsed");
	});

	it.each([
		[
			"[ a == b ]",
			`check_args() {\n  if [ "\${1:-}" == "--quiet" ]; then QUIET=1; fi\n}\n`,
		],
		["[[ a == b ]]", `check_args() {\n  [[ "$1" == "x" ]] && echo hit\n}\n`],
		["[[ a != b ]]", `check_args() {\n  [[ $1 != y ]] || return 1\n}\n`],
	])("reads the enclosing function around %s", async (_label, body) => {
		// Recurrence: #3996. `==` / `!=` followed by a non-glob word made the
		// 0.1.13 grammar throw `resolved is not a function` out of parse().
		const { cwd, file } = script(`#!/usr/bin/env bash\n${body}`);

		const result = await enclosing(cwd, file, 3);

		expect(result.text).toContain("check_args");
		expect(result.isError).toBeFalsy();
	});

	it("reads a bash function by name after a script that uses ==", async () => {
		// The agent's other read path: read_symbol over the same grammar.
		const { cwd, file } = script(
			`#!/usr/bin/env bash\nrun_probe() {\n  [ "$1" == "go" ] && echo "$(date +%s)"\n}\n`,
		);
		const tool = createReadSymbolTool(
			() => cwd,
			() => {},
		);

		const result = await tool.execute(
			"s",
			{ path: file, symbol: "run_probe" },
			undefined,
			null,
			{ cwd },
		);

		expect(String(result.content[0]?.text)).toContain("run_probe");
		expect(result.isError).toBeFalsy();
	});
});
