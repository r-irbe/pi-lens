import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { STABILITY_TIER_KEY } from "./config-diagnostic-codes.js";
import type { safeSpawnAsync } from "./safe-spawn.js";

/** Host-admitted exact compiler context, never arbitrary command or env input. */
export interface LeanContext {
	readonly compilerPath: string;
	readonly targetVersion: string;
	readonly moduleRoots: readonly string[];
}

export interface LeanBinaryIdentity {
	readonly realPath: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

export interface ServedRootPinDigest {
	readonly filePath: string;
	readonly exists: boolean;
	readonly sha256?: string;
	readonly byteLength?: number;
}

export const LEAN_PIN_FILE_MAX_BYTES = 1_048_576;

const SERVED_ROOT_PIN_FILENAMES = [
	"lean-toolchain",
	"lake-manifest.json",
] as const;

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
	const candidate = value as Record<string, unknown>;
	const absolutePath = (input: unknown): input is string =>
		typeof input === "string" &&
		input.length <= 4096 &&
		!/[\0\r\n]/.test(input) &&
		isAbsolute(input);
	return (
		Object.keys(candidate).every((key) =>
			(LEAN_CONTEXT_KEYS as readonly string[]).includes(key),
		) &&
		(!Object.hasOwn(candidate, "compilerPath") ||
			(absolutePath(candidate.compilerPath) &&
				/^lean(?:\.exe)?$/i.test(basename(candidate.compilerPath)))) &&
		(!Object.hasOwn(candidate, "targetVersion") ||
			(typeof candidate.targetVersion === "string" &&
				candidate.targetVersion.length <= 64 &&
				/^4\.\d+\.\d+(?:-[a-z]+\d+)?$/.test(candidate.targetVersion))) &&
		(!Object.hasOwn(candidate, "moduleRoots") ||
			(Array.isArray(candidate.moduleRoots) &&
				candidate.moduleRoots.length <= 32 &&
				candidate.moduleRoots.every(
					(root) => absolutePath(root) && !root.includes(delimiter),
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
	const candidate = value as LeanContext;
	try {
		if (!fs.statSync(candidate.compilerPath).isFile()) return unavailable();
		fs.accessSync(candidate.compilerPath, fs.constants.X_OK);
		const compilerPath = fs.realpathSync(candidate.compilerPath);
		if (compilerPath !== resolve(candidate.compilerPath))
			throw new Error(
				"environment_unavailable: compiler symlink paths unsupported; admit a direct installed lean binary without argv0-dependent indirection",
			);
		const moduleRoots = candidate.moduleRoots.map((root: string) => {
			if (!fs.statSync(root).isDirectory()) return unavailable();
			const resolved = fs.realpathSync(root);
			if (resolved.includes(delimiter)) return unavailable();
			return resolved;
		});
		return Object.freeze({
			compilerPath,
			targetVersion: candidate.targetVersion,
			moduleRoots: Object.freeze(moduleRoots),
		});
	} catch (thrown) {
		if (
			thrown instanceof Error &&
			thrown.message.startsWith("environment_unavailable:")
		)
			throw thrown;
		return unavailable();
	}
}

export function captureLeanCompilerIdentity(
	compilerPath: string,
): LeanBinaryIdentity | undefined {
	try {
		const realPath = fs.realpathSync(compilerPath);
		if (realPath !== resolve(compilerPath)) return undefined;
		const st = fs.statSync(realPath);
		if (!st.isFile()) return undefined;
		fs.accessSync(realPath, fs.constants.X_OK);
		return Object.freeze({
			realPath,
			dev: st.dev,
			ino: st.ino,
			size: st.size,
			mtimeMs: st.mtimeMs,
			ctimeMs: st.ctimeMs,
		});
	} catch {
		return undefined;
	}
}

export function isLeanCompilerIdentityCurrent(
	identity: LeanBinaryIdentity | undefined,
): boolean {
	if (!identity) return false;
	const current = captureLeanCompilerIdentity(identity.realPath);
	if (!current) return false;
	return (
		current.realPath === identity.realPath &&
		current.dev === identity.dev &&
		current.ino === identity.ino &&
		current.size === identity.size &&
		current.mtimeMs === identity.mtimeMs &&
		current.ctimeMs === identity.ctimeMs
	);
}

function readServedRootPinDigest(
	servedRootReal: string,
	filePath: string,
): ServedRootPinDigest | undefined {
	let lst: fs.Stats;
	try {
		lst = fs.lstatSync(filePath);
	} catch (thrown) {
		if ((thrown as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
			return Object.freeze({ filePath, exists: false });
		}
		return undefined;
	}
	if (lst.isSymbolicLink() || !lst.isFile()) return undefined;
	if (lst.size > LEAN_PIN_FILE_MAX_BYTES) return undefined;
	try {
		const realFile = fs.realpathSync(filePath);
		if (
			realFile !== servedRootReal &&
			!realFile.startsWith(
				servedRootReal.endsWith("/") || servedRootReal.endsWith("\\")
					? servedRootReal
					: `${servedRootReal}/`,
			) &&
			!realFile.startsWith(`${servedRootReal}\\`)
		) {
			return undefined;
		}
		const bytes = fs.readFileSync(realFile);
		if (bytes.byteLength > LEAN_PIN_FILE_MAX_BYTES) return undefined;
		const post = fs.lstatSync(filePath);
		if (
			post.isSymbolicLink() ||
			!post.isFile() ||
			post.dev !== lst.dev ||
			post.ino !== lst.ino ||
			post.size !== lst.size ||
			post.mtimeMs !== lst.mtimeMs ||
			post.ctimeMs !== lst.ctimeMs
		) {
			return undefined;
		}
		return Object.freeze({
			filePath,
			exists: true,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			byteLength: bytes.byteLength,
		});
	} catch {
		return undefined;
	}
}

export function captureServedRootPinDigests(
	servedRoot: string,
): readonly ServedRootPinDigest[] | undefined {
	let servedRootReal: string;
	try {
		servedRootReal = fs.realpathSync(servedRoot);
	} catch {
		return undefined;
	}
	const digests: ServedRootPinDigest[] = [];
	for (const fileName of SERVED_ROOT_PIN_FILENAMES) {
		const candidatePath = join(servedRootReal, fileName);
		const digest = readServedRootPinDigest(servedRootReal, candidatePath);
		if (!digest) return undefined;
		digests.push(digest);
	}
	return Object.freeze(digests);
}

export function areServedRootPinDigestsCurrent(
	servedRoot: string,
	captured: readonly ServedRootPinDigest[] | undefined,
): boolean {
	if (!captured) return false;
	const current = captureServedRootPinDigests(servedRoot);
	if (!current || current.length !== captured.length) return false;
	for (let i = 0; i < captured.length; i++) {
		const prev = captured[i];
		const now = current[i];
		if (
			!prev ||
			!now ||
			prev.filePath !== now.filePath ||
			prev.exists !== now.exists ||
			prev.sha256 !== now.sha256 ||
			prev.byteLength !== now.byteLength
		) {
			return false;
		}
	}
	return true;
}

export function leanContextEnv(context: LeanContext): NodeJS.ProcessEnv {
	// Explicit undefined survives the launcher's ambient-env merge and removes
	// these selection variables from the actual child environment.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		LEAN_PATH: context.moduleRoots.join(delimiter),
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
		Boolean(result["error"]) ||
		result["status"] !== 0 ||
		observed !== context.targetVersion
	) {
		throw new Error(
			`environment_unavailable: declared Lean ${context.targetVersion}, observed ${observed || "unavailable"}; select the exact installed compiler before checking source`,
		);
	}
}

let ileanScanInvalidationStamp = 0;

export function getILeanScanInvalidationStamp(): number {
	return ileanScanInvalidationStamp;
}

export function invalidateILeanScans(_scopeId?: number | string): void {
	ileanScanInvalidationStamp += 1;
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
		Boolean(result["error"]) ||
		result["status"] !== 0 ||
		!isAbsolute(prefix) ||
		!fs.existsSync(join(prefix, "include", "lean", "lean.h"))
	) {
		throw new Error(
			`environment_unavailable: Lean ${context.targetVersion} runtime header lean/lean.h unavailable; admit a complete matching installed toolchain`,
		);
	}
	return [`-I${join(prefix, "include")}`];
}
