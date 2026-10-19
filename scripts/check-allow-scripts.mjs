#!/usr/bin/env node
/**
 * Fail if package.json's `allowScripts` policy does not decide every resolved
 * install-time lifecycle script exactly (#1185): a script with no decision, an
 * approval whose version no longer resolves, a stale or name-only approval, or
 * a direct script-bearing dependency on a floating range.
 *
 * Reads package.json and package-lock.json from the working directory (the
 * same contract as check-lockfile-sync.mjs) and names the install phase from
 * node_modules when the tree is installed. Offline and deterministic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	checkAllowScriptsPolicy,
	formatAllowScriptsProblems,
	installPhasesOf,
} from "./lib/allow-scripts-policy.mjs";

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
}

const pkg = read("package.json");
const lock = read("package-lock.json");

const readPhases = (installPath) => {
	const manifest = path.join(installPath, "package.json");
	if (!fs.existsSync(manifest)) return undefined;
	try {
		return installPhasesOf(JSON.parse(fs.readFileSync(manifest, "utf-8")));
	} catch {
		return undefined;
	}
};

const problems = checkAllowScriptsPolicy(pkg, lock, { readPhases });
if (problems.length > 0) {
	console.error(formatAllowScriptsProblems(problems));
	process.exit(1);
}
console.log("allowScripts policy matches the resolved lockfile ✓");
