import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVitestSummary } from "./vitest-summary.mjs";

/** Return the failed-test count from a Vitest Windows runner log, if present. */
export function parseWindowsVitestFailureCount(log) {
	return parseVitestSummary(log).testsFailed;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	const count = parseWindowsVitestFailureCount(
		readFileSync(process.argv[2], "utf8"),
	);
	process.stdout.write(count === null ? "unknown\n" : `${count}\n`);
}
