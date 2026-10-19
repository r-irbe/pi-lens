/**
 * Pure `allowScripts` policy check (#1185). Reconciles `package.json`'s
 * `allowScripts` map with the resolved `package-lock.json`, so a lifecycle
 * script that npm would run (or, under `--strict-allow-scripts`, refuse) is
 * always a reviewed decision in the same PR as the lockfile change.
 *
 * Why a checker and not just npm's `--strict-allow-scripts`: npm only reports
 * the first unreviewed set at install time, never a STALE or name-only approval
 * and never a floating direct range (#1176: `@ast-grep/cli` moved to 0.45.x
 * while its approval stayed at 0.44.1 and nothing failed).
 *
 * The lockfile records `hasInstallScript` but not the phase, so the caller may
 * pass `readPhases(installPath)` to name the phase from an installed tree.
 */

const EXACT_VERSION =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTALL_PHASES = ["preinstall", "install", "postinstall"];
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];

function isJsonObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Split `name@version`, `name`, or `@scope/name@version` at the version `@`. */
export function splitPolicyKey(key) {
	const at = key.lastIndexOf("@");
	if (at <= 0) return { name: key, version: undefined };
	return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function packageNameOf(installPath, entry) {
	if (typeof entry.name === "string") return entry.name;
	const marker = "node_modules/";
	return installPath.slice(installPath.lastIndexOf(marker) + marker.length);
}

/**
 * Every distinct name@version the lockfile resolves with an install script
 * that npm would run. Bundled and linked entries never run theirs.
 */
export function collectLifecyclePackages(lock) {
	const byId = new Map();
	for (const [installPath, entry] of Object.entries(lock?.packages ?? {})) {
		if (installPath === "" || !isJsonObject(entry)) continue;
		if (entry.hasInstallScript !== true || entry.inBundle === true) continue;
		if (entry.link === true || typeof entry.version !== "string") continue;
		const name = packageNameOf(installPath, entry);
		const id = `${name}@${entry.version}`;
		const found = byId.get(id) ?? {
			name,
			version: entry.version,
			paths: [],
		};
		found.paths.push(installPath);
		byId.set(id, found);
	}
	return [...byId.values()].sort((a, b) =>
		`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
	);
}

function describePhase(readPhases, pkg) {
	const phases = readPhases?.(pkg.paths[0]);
	if (!phases) return "phase unknown (package not installed)";
	return phases.length > 0
		? `phase ${phases.join("+")}`
		: "phase install (implicit, binding.gyp)";
}

/** Phases of an installed manifest's own `scripts`, for the report only. */
export function installPhasesOf(manifest) {
	const scripts = isJsonObject(manifest?.scripts) ? manifest.scripts : {};
	return INSTALL_PHASES.filter((phase) => typeof scripts[phase] === "string");
}

function isExactSpec(spec) {
	if (typeof spec !== "string") return false;
	const target = spec.startsWith("npm:")
		? spec.slice(spec.lastIndexOf("@") + 1)
		: spec;
	return EXACT_VERSION.test(target);
}

/**
 * @returns {Array<{kind: string, subject: string, message: string, remediation: string}>}
 */
export function checkAllowScriptsPolicy(pkg, lock, { readPhases } = {}) {
	const problems = [];
	const add = (kind, subject, message, remediation) =>
		problems.push({ kind, subject, message, remediation });

	const policy = pkg?.allowScripts;
	if (policy !== undefined && !isJsonObject(policy)) {
		add(
			"invalid-policy",
			"allowScripts",
			"package.json allowScripts must be an object of name@version -> boolean",
			'Rewrite it as { "name@1.2.3": true | false }.',
		);
		return problems;
	}
	const entries = Object.entries(policy ?? {});
	const resolved = collectLifecyclePackages(lock);

	const covers = (key, value, p) => {
		const { name, version } = splitPolicyKey(key);
		if (name !== p.name) return false;
		return version === undefined ? value === false : version === p.version;
	};
	const isDecided = (p) =>
		entries.some(
			([key, value]) => typeof value === "boolean" && covers(key, value, p),
		);

	for (const [key, value] of entries) {
		const { name, version } = splitPolicyKey(key);
		if (typeof value !== "boolean") {
			add(
				"invalid-policy",
				key,
				`allowScripts["${key}"] must be true (approve) or false (skip), got ${JSON.stringify(value)}`,
				`Set it to true after reviewing the script, or false to skip it.`,
			);
			continue;
		}
		if (
			value === true &&
			!(version !== undefined && EXACT_VERSION.test(version))
		) {
			add(
				"unpinned-approval",
				key,
				`positive approval "${key}" is not an exact name@version`,
				`Replace it with "${name}@<resolved version>": true; a name-only or ranged approval trusts every future release.`,
			);
			continue;
		}
		if (
			value === false &&
			version !== undefined &&
			!EXACT_VERSION.test(version)
		) {
			add(
				"unpinned-approval",
				key,
				`skip entry "${key}" is neither an exact name@version nor a bare name`,
				`Use "${name}@<resolved version>": false or the bare name.`,
			);
			continue;
		}
		// Stale: the entry decides no resolved version of its name, and every
		// resolved version of that name is decided anyway (vacuously when the
		// name no longer resolves). An entry that decides a resolved version is
		// never stale (#1185 verify N-1: a bare skip beside an exact key); one
		// that decides none while a version is undecided is reported once,
		// against that package, as version-mismatch below (#1185 review F1).
		const sameName = resolved.filter((p) => p.name === name);
		if (
			!sameName.some((p) => covers(key, value, p)) &&
			sameName.every(isDecided)
		) {
			add(
				"stale-approval",
				key,
				sameName.length === 0
					? `"${key}" no longer resolves to a package with an install script in package-lock.json`
					: `"${key}" matches no resolved version of ${name}; the other entries already decide every resolved version`,
				`Delete allowScripts["${key}"] (the dependency was removed, bumped, or no longer has an install script).`,
			);
		}
	}

	for (const p of resolved) {
		if (isDecided(p)) continue;
		const where = `${p.paths[0]}${p.paths.length > 1 ? ` (+${p.paths.length - 1} more)` : ""}`;
		const id = `${p.name}@${p.version}`;
		const stale = entries
			.filter(([key]) => splitPolicyKey(key).name === p.name)
			.map(([key]) => key);
		if (stale.length > 0) {
			add(
				"version-mismatch",
				id,
				`${id} (${where}, ${describePhase(readPhases, p)}) resolves to ${p.version} but the policy decides ${stale.join(", ")}`,
				`Add or move the entry to "${id}" in the same PR as the lockfile bump, after re-reviewing the script.`,
			);
		} else {
			add(
				"missing-decision",
				id,
				`${id} (${where}, ${describePhase(readPhases, p)}) has an install script and no allowScripts decision`,
				`Review its script, then add "${id}": true (run it) or "${id}": false (skip it) to package.json allowScripts.`,
			);
		}
	}

	const resolvedByName = new Map(resolved.map((p) => [p.name, p]));
	for (const field of DEPENDENCY_FIELDS) {
		const section = pkg?.[field];
		if (!isJsonObject(section)) continue;
		for (const [name, spec] of Object.entries(section)) {
			const p = resolvedByName.get(name);
			if (!p || isExactSpec(spec)) continue;
			add(
				"floating-direct",
				`${name}@${spec}`,
				`direct ${field} entry ${name} ("${spec}") runs an install script (resolved ${p.version}) under a floating range`,
				`Pin it: "${name}": "${p.version}" in ${field}, and keep allowScripts["${name}@${p.version}"] in step.`,
			);
		}
	}
	return problems;
}

/** The report CI and `npm run check:allow-scripts` print on failure. */
export function formatAllowScriptsProblems(problems) {
	const lines = [
		`allowScripts policy: ${problems.length} problem(s) between package.json and package-lock.json:`,
	];
	for (const p of problems) {
		lines.push(`  [${p.kind}] ${p.message}`, `      fix: ${p.remediation}`);
	}
	lines.push('Review procedure: CONTRIBUTING.md "Lifecycle-script approvals".');
	return lines.join("\n");
}
