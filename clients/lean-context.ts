import * as fs from "node:fs";
import * as path from "node:path";
import { STABILITY_TIER_KEY } from "./config-diagnostic-codes.js";
import type { safeSpawnAsync } from "./safe-spawn.js";

/** Host-admitted exact compiler context, never arbitrary command or env input. */
export interface LeanContext {
	readonly compilerPath: string;
	readonly targetVersion: string;
	readonly moduleRoots: readonly string[];
}

export const LEAN_CONTEXT_CONFIG_SCHEMA = {
	type: "object",
	additionalProperties: false,
	[STABILITY_TIER_KEY]: "experimental",
	properties: {
		compilerPath: { type: "string", [STABILITY_TIER_KEY]: "experimental" },
		targetVersion: { type: "string", [STABILITY_TIER_KEY]: "experimental" },
		moduleRoots: {
			type: "array",
			maxItems: 32,
			items: { type: "string", [STABILITY_TIER_KEY]: "experimental" },
			[STABILITY_TIER_KEY]: "experimental",
		},
	},
	required: ["compilerPath", "targetVersion", "moduleRoots"],
} as const;

export const LEAN_CONTEXT_KEYS = [
	"compilerPath",
	"targetVersion",
	"moduleRoots",
] as const;
export type LeanContextKey = (typeof LEAN_CONTEXT_KEYS)[number];

/** Structural, partial-tier validation before normalization may drop bad leaves. */
export function isLeanContextContribution(
	value: unknown,
): value is Partial<LeanContext> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const absolutePath = (input: unknown): input is string =>
		typeof input === "string" &&
		input.length <= 4096 &&
		!/[\0\r\n]/.test(input) &&
		path.isAbsolute(input);
	return (
		Object.keys(record).every((key) =>
			(LEAN_CONTEXT_KEYS as readonly string[]).includes(key),
		) &&
		(!Object.hasOwn(record, "compilerPath") ||
			(absolutePath(record.compilerPath) &&
				/^lean(?:\.exe)?$/i.test(path.basename(record.compilerPath)))) &&
		(!Object.hasOwn(record, "targetVersion") ||
			(typeof record.targetVersion === "string" &&
				record.targetVersion.length <= 64 &&
				/^4\.\d+\.\d+(?:-[a-z]+\d+)?$/.test(record.targetVersion))) &&
		(!Object.hasOwn(record, "moduleRoots") ||
			(Array.isArray(record.moduleRoots) &&
				record.moduleRoots.length <= 32 &&
				record.moduleRoots.every(
					(root) => absolutePath(root) && !root.includes(path.delimiter),
				)))
	);
}

export function validateLeanContext(value: unknown): LeanContext {
	const unavailable = (): never => {
		throw new Error(
			"environment_unavailable: invalid leanContext; admit an installed absolute lean compilerPath, exact targetVersion and absolute moduleRoots only",
		);
	};
	if (
		!isLeanContextContribution(value) ||
		!LEAN_CONTEXT_KEYS.every((key) => Object.hasOwn(value, key))
	)
		return unavailable();
	const record = value as LeanContext;
	try {
		if (!fs.statSync(record.compilerPath).isFile()) return unavailable();
		fs.accessSync(record.compilerPath, fs.constants.X_OK);
		const compilerPath = fs.realpathSync(record.compilerPath);
		if (compilerPath !== path.resolve(record.compilerPath))
			throw new Error(
				"environment_unavailable: compiler symlink paths unsupported; admit a direct installed lean binary without argv0-dependent indirection",
			);
		const moduleRoots = record.moduleRoots.map((root: string) => {
			if (!fs.statSync(root).isDirectory()) return unavailable();
			const resolved = fs.realpathSync(root);
			if (resolved.includes(path.delimiter)) return unavailable();
			return resolved;
		});
		return Object.freeze({
			compilerPath,
			targetVersion: record.targetVersion,
			moduleRoots: Object.freeze(moduleRoots),
		});
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("environment_unavailable:")
		)
			throw error;
		return unavailable();
	}
}

export function leanContextEnv(context: LeanContext): NodeJS.ProcessEnv {
	// Explicit undefined survives the launcher's ambient-env merge and removes
	// these selection variables from the actual child environment.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEAN_PATH: context.moduleRoots.join(path.delimiter),
		LEAN_SYSROOT: undefined,
		LEAN_SRC_PATH: undefined,
		ELAN_TOOLCHAIN: undefined,
	};
	return env;
}

/** Probe only the admitted compiler; a mismatch is not a source diagnostic. */
export async function verifyLeanContext(
	context: LeanContext,
	cwd: string,
	probe: typeof safeSpawnAsync,
): Promise<void> {
	const result = await probe(context.compilerPath, ["--version"], {
		cwd,
		env: leanContextEnv(context),
		timeout: 2000,
		maxOutputBytes: 65536,
	});
	const observed = /\bversion\s+(4\.\d+\.\d+(?:-[a-z]+\d+)?)(?=[,\s)]|$)/.exec(
		result.stdout,
	)?.[1];
	if (
		result.error ||
		result.status !== 0 ||
		observed !== context.targetVersion
	) {
		throw new Error(
			`environment_unavailable: declared Lean ${context.targetVersion}, observed ${observed || "unavailable"}; select the exact installed compiler before checking source`,
		);
	}
}

/** No cross-context cache: prefix and runtime header are checked per request. */
export async function resolveLeanIncludeFlags(
	context: LeanContext,
	cwd: string,
	probe: typeof safeSpawnAsync,
): Promise<string[]> {
	await verifyLeanContext(context, cwd, probe);
	const result = await probe(context.compilerPath, ["--print-prefix"], {
		cwd,
		env: leanContextEnv(context),
		timeout: 2000,
		maxOutputBytes: 65536,
	});
	const prefix = result.stdout.trim();
	if (
		result.error ||
		result.status !== 0 ||
		!path.isAbsolute(prefix) ||
		!fs.existsSync(path.join(prefix, "include", "lean", "lean.h"))
	) {
		throw new Error(
			`environment_unavailable: Lean ${context.targetVersion} runtime header lean/lean.h unavailable; admit a complete matching installed toolchain`,
		);
	}
	return [`-I${path.join(prefix, "include")}`];
}
