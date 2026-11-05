import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	extname,
	isAbsolute,
	join,
	relative,
	resolve as resolvePath,
	sep,
} from "node:path";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	getILeanScanInvalidationStamp,
	invalidateILeanScans,
	type LeanContext,
	verifyLeanContext,
} from "../lean-context.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import type { LineageHandle } from "../session-scope.js";
import type { LeanNavigationAdmissionAvailable } from "./config.js";

export interface ILeanPosition {
	line: number;
	character: number;
}

export interface ILeanRange {
	start: ILeanPosition;
	end: ILeanPosition;
}

export interface ILeanDeclaration {
	name: string;
	module: string;
	range: ILeanRange;
	selectionRange: ILeanRange;
	moduleRoot?: string;
	artifactPath?: string;
	artifactSha256?: string;
	sourcePath?: string;
	sourceSha256?: string;
}

export interface ILeanData {
	version: number;
	module: string;
	directImports: string[];
	decls: Map<string, ILeanDeclaration>;
	moduleRoot?: string;
	artifactPath?: string;
	artifactSha256?: string;
	observedAtMs?: number;
}

export interface ILeanModuleGraph {
	imports: Map<string, string[]>;
	importedBy: Map<string, string[]>;
}

export type ILeanUnavailableReasonCode =
	| "admission-missing"
	| "admission-rejected"
	| "session-unavailable"
	| "context-changed"
	| "compiler-unavailable"
	| "compiler-mismatch"
	| "artifact-unavailable"
	| "source-location-unavailable"
	| "bounds-exceeded"
	| "cancelled";

export interface ILeanScanInventoryItem {
	readonly ["version"]: number;
	readonly module: string;
	readonly directImports: readonly string[];
	readonly decls: ReadonlyMap<string, ILeanDeclaration>;
	readonly moduleRoot: string;
	readonly artifactPath: string;
	readonly artifactSha256: string;
	readonly byteLength: number;
	readonly observedAtMs: number;
}

export interface ILeanScanObservation {
	readonly servedRoot: string;
	readonly scopeId: number | string;
	readonly registrationId: object;
	readonly admittedContext: LeanContext;
	readonly items: readonly ILeanScanInventoryItem[];
	readonly observedAtMs: number;
}

export type ILeanScanSnapshot = ILeanScanObservation;

export interface ILeanScanAvailable {
	readonly ["status"]: "available";
	readonly ["snapshot"]: ILeanScanObservation;
	readonly items: readonly ILeanScanInventoryItem[];
}

export interface ILeanScanUnavailable {
	readonly ["status"]: "unavailable";
	readonly reasonCode: ILeanUnavailableReasonCode;
	readonly message: string;
}

export type ILeanScanResult = ILeanScanAvailable | ILeanScanUnavailable;

export const ILEAN_MAX_IN_FLIGHT_SCANS = 2;
export const ILEAN_MAX_ROOTS = 32;
export const ILEAN_MAX_VISITED_DIRS = 4_096;
export const ILEAN_MAX_DIR_ENTRIES = 32_768;
export const ILEAN_MAX_DEPTH = 64;
export const ILEAN_MAX_FILES = 8_192;
export const ILEAN_MAX_FILE_BYTES = 1_048_576;
export const ILEAN_MAX_TOTAL_BYTES = 33_554_432;
export const ILEAN_MAX_DECLS = 100_000;
export const ILEAN_MAX_IMPORTS = 200_000;
export const ILEAN_SCAN_WALL_BUDGET_MS = 2_000;
export const ILEAN_SUPPORTED_VERSIONS = Object.freeze([3, 4, 5]);

let activeInFlightScans = 0;

export function clearILeanScanCache(scopeId?: number | string): void {
	invalidateILeanScans(scopeId);
}

function isConfinedWithinRoot(
	candidateReal: string,
	rootReal: string,
): boolean {
	if (candidateReal === rootReal) return true;
	const prefix =
		rootReal.endsWith("/") || rootReal.endsWith("\\")
			? rootReal
			: `${rootReal}${sep}`;
	return (
		candidateReal.startsWith(prefix) ||
		candidateReal.startsWith(`${rootReal}/`) ||
		candidateReal.startsWith(`${rootReal}\\`)
	);
}

function isValidModuleSegment(seg: string): boolean {
	return (
		seg.length > 0 &&
		seg.length <= 256 &&
		seg !== "." &&
		seg !== ".." &&
		!/[/\\:\0\r\n]/.test(seg)
	);
}

function validateModuleNameAndRelPath(
	modName: string,
	expectedRelNoExt?: string,
): string[] | null {
	if (!modName || modName.length > 1024 || modName.includes("://")) return null;
	const segments = modName.split(".");
	if (segments.length === 0 || !segments.every(isValidModuleSegment)) {
		return null;
	}
	if (expectedRelNoExt !== undefined) {
		const normalizedRel = expectedRelNoExt.replace(/\\/g, "/");
		if (segments.join("/") !== normalizedRel) {
			return null;
		}
	}
	return segments;
}

function isValidNonNegativeInt(n: unknown): n is number {
	return (
		typeof n === "number" &&
		Number.isFinite(n) &&
		Number.isInteger(n) &&
		n >= 0 &&
		n <= 10_000_000
	);
}

function isValidRangeOrder(
	startLine: number,
	startChar: number,
	endLine: number,
	endChar: number,
): boolean {
	return endLine > startLine || (endLine === startLine && endChar >= startChar);
}

function extractContextRoots(
	admissionOrContext:
		| LeanNavigationAdmissionAvailable
		| LeanContext
		| { readonly admittedContext: LeanContext }
		| string
		| null
		| undefined,
): readonly string[] {
	if (!admissionOrContext || typeof admissionOrContext === "string") {
		return [];
	}
	if ("admittedContext" in admissionOrContext) {
		return admissionOrContext.admittedContext.moduleRoots;
	}
	if ("moduleRoots" in admissionOrContext) {
		return admissionOrContext.moduleRoots;
	}
	return [];
}

/**
 * Projects only the admitted `LeanContext.moduleRoots` in admission order.
 * Ambient workspace `.lake` and `LEAN_INDEX_PACKAGES` are never consulted.
 */
export function findILeanRoots(
	admissionOrContext:
		| LeanNavigationAdmissionAvailable
		| LeanContext
		| { readonly admittedContext: LeanContext }
		| string
		| null
		| undefined,
): string[] {
	const roots: string[] = [];
	const seen = new Set<string>();
	for (const rawRoot of extractContextRoots(admissionOrContext)) {
		try {
			const lst = fs.lstatSync(rawRoot);
			if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
			const real = fs.realpathSync(rawRoot);
			if (!fs.statSync(real).isDirectory()) continue;
			if (!seen.has(real)) {
				seen.add(real);
				roots.push(real);
			}
		} catch {
			// Skip unreadable or missing root
		}
	}
	return roots;
}

/**
 * Projects the primary admitted module root from `LeanContext.moduleRoots`.
 */
export function findILeanRoot(
	admissionOrContext:
		| LeanNavigationAdmissionAvailable
		| LeanContext
		| { readonly admittedContext: LeanContext }
		| string
		| null
		| undefined,
): string | null {
	return findILeanRoots(admissionOrContext)[0] ?? null;
}

interface StrictDecodeResult {
	readonly data: ILeanData | null;
	readonly declCount: number;
	readonly importCount: number;
	readonly byteLength: number;
	readonly sha256: string;
	readonly reasonCode?: ILeanUnavailableReasonCode;
}

function decodeILeanBytesStrict(
	rawBytes: Buffer,
	expectedRelNoExt?: string,
	moduleRoot?: string,
	artifactPath?: string,
	observedAtMs?: number,
): StrictDecodeResult {
	if (rawBytes.byteLength > ILEAN_MAX_FILE_BYTES) {
		return {
			data: null,
			declCount: 0,
			importCount: 0,
			byteLength: rawBytes.byteLength,
			sha256: "",
			reasonCode: "bounds-exceeded",
		};
	}
	const sha256 = createHash("sha256").update(rawBytes).digest("hex");
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(rawBytes.toString("utf8"));
	} catch {
		return {
			data: null,
			declCount: 0,
			importCount: 0,
			byteLength: rawBytes.byteLength,
			sha256,
			reasonCode: "artifact-unavailable",
		};
	}
	if (
		!parsedJson ||
		typeof parsedJson !== "object" ||
		Array.isArray(parsedJson)
	) {
		return {
			data: null,
			declCount: 0,
			importCount: 0,
			byteLength: rawBytes.byteLength,
			sha256,
			reasonCode: "artifact-unavailable",
		};
	}
	const data = parsedJson as Record<string, unknown>;
	const fmtVer = data.version;
	if (
		typeof fmtVer !== "number" ||
		!Number.isInteger(fmtVer) ||
		!(ILEAN_SUPPORTED_VERSIONS as readonly number[]).includes(fmtVer)
	) {
		return {
			data: null,
			declCount: 0,
			importCount: 0,
			byteLength: rawBytes.byteLength,
			sha256,
			reasonCode: "artifact-unavailable",
		};
	}
	const modName = data.module;
	if (
		typeof modName !== "string" ||
		!validateModuleNameAndRelPath(modName, expectedRelNoExt)
	) {
		return {
			data: null,
			declCount: 0,
			importCount: 0,
			byteLength: rawBytes.byteLength,
			sha256,
			reasonCode: "artifact-unavailable",
		};
	}

	const imports: string[] = [];
	if (data.directImports !== undefined) {
		if (!Array.isArray(data.directImports)) {
			return {
				data: null,
				declCount: 0,
				importCount: 0,
				byteLength: rawBytes.byteLength,
				sha256,
				reasonCode: "artifact-unavailable",
			};
		}
		if (data.directImports.length > ILEAN_MAX_IMPORTS) {
			return {
				data: null,
				declCount: 0,
				importCount: data.directImports.length,
				byteLength: rawBytes.byteLength,
				sha256,
				reasonCode: "bounds-exceeded",
			};
		}
		for (const entry of data.directImports) {
			const impName =
				typeof entry === "string"
					? entry
					: Array.isArray(entry) && typeof entry[0] === "string"
						? entry[0]
						: null;
			if (!impName || !validateModuleNameAndRelPath(impName)) {
				return {
					data: null,
					declCount: 0,
					importCount: imports.length,
					byteLength: rawBytes.byteLength,
					sha256,
					reasonCode: "artifact-unavailable",
				};
			}
			imports.push(impName);
		}
	}

	const declMap = new Map<string, ILeanDeclaration>();
	if (data.decls !== undefined) {
		if (
			!data.decls ||
			typeof data.decls !== "object" ||
			Array.isArray(data.decls)
		) {
			return {
				data: null,
				declCount: 0,
				importCount: imports.length,
				byteLength: rawBytes.byteLength,
				sha256,
				reasonCode: "artifact-unavailable",
			};
		}
		const entries = Object.entries(data.decls as Record<string, unknown>);
		if (entries.length > ILEAN_MAX_DECLS) {
			return {
				data: null,
				declCount: entries.length,
				importCount: imports.length,
				byteLength: rawBytes.byteLength,
				sha256,
				reasonCode: "bounds-exceeded",
			};
		}
		for (const [name, coords] of entries) {
			if (
				!name ||
				name.length > 512 ||
				/[\0\r\n]/.test(name) ||
				!Array.isArray(coords) ||
				coords.length < 8
			) {
				return {
					data: null,
					declCount: declMap.size,
					importCount: imports.length,
					byteLength: rawBytes.byteLength,
					sha256,
					reasonCode: "artifact-unavailable",
				};
			}
			const c0 = coords[0];
			const c1 = coords[1];
			const c2 = coords[2];
			const c3 = coords[3];
			const c4 = coords[4];
			const c5 = coords[5];
			const c6 = coords[6];
			const c7 = coords[7];
			if (
				!isValidNonNegativeInt(c0) ||
				!isValidNonNegativeInt(c1) ||
				!isValidNonNegativeInt(c2) ||
				!isValidNonNegativeInt(c3) ||
				!isValidNonNegativeInt(c4) ||
				!isValidNonNegativeInt(c5) ||
				!isValidNonNegativeInt(c6) ||
				!isValidNonNegativeInt(c7) ||
				!isValidRangeOrder(c0, c1, c2, c3) ||
				!isValidRangeOrder(c4, c5, c6, c7)
			) {
				return {
					data: null,
					declCount: declMap.size,
					importCount: imports.length,
					byteLength: rawBytes.byteLength,
					sha256,
					reasonCode: "artifact-unavailable",
				};
			}
			declMap.set(
				name,
				Object.freeze({
					name,
					module: modName,
					range: Object.freeze({
						start: Object.freeze({ line: c0, character: c1 }),
						end: Object.freeze({ line: c2, character: c3 }),
					}),
					selectionRange: Object.freeze({
						start: Object.freeze({ line: c4, character: c5 }),
						end: Object.freeze({ line: c6, character: c7 }),
					}),
					...(moduleRoot ? { moduleRoot } : {}),
					...(artifactPath ? { artifactPath } : {}),
					artifactSha256: sha256,
				}),
			);
		}
	}

	return {
		data: {
			version: fmtVer,
			module: modName,
			directImports: imports,
			decls: declMap,
			...(moduleRoot ? { moduleRoot } : {}),
			...(artifactPath ? { artifactPath } : {}),
			artifactSha256: sha256,
			...(observedAtMs !== undefined ? { observedAtMs } : {}),
		},
		declCount: declMap.size,
		importCount: imports.length,
		byteLength: rawBytes.byteLength,
		sha256,
	};
}

/**
 * Parses an individual .ilean JSON file with strict schema and size bounds.
 */
export function readILeanFile(
	ileanPath: string,
	expectedRelNoExt?: string,
	moduleRoot?: string,
): ILeanData | null {
	try {
		const lst = fs.lstatSync(ileanPath);
		if (lst.isSymbolicLink() || !lst.isFile()) return null;
		if (lst.size > ILEAN_MAX_FILE_BYTES) return null;
		const real = fs.realpathSync(ileanPath);
		if (moduleRoot && !isConfinedWithinRoot(real, moduleRoot)) return null;
		const rawBytes = fs.readFileSync(real);
		const post = fs.lstatSync(ileanPath);
		if (
			post.isSymbolicLink() ||
			!post.isFile() ||
			post.dev !== lst.dev ||
			post.ino !== lst.ino ||
			post.size !== lst.size ||
			post.mtimeMs !== lst.mtimeMs ||
			post.ctimeMs !== lst.ctimeMs
		) {
			return null;
		}
		return decodeILeanBytesStrict(
			rawBytes,
			expectedRelNoExt,
			moduleRoot,
			real,
			Date.now(),
		).data;
	} catch {
		return null;
	}
}

export interface ScanILeanOptions {
	readonly probe?: typeof safeSpawnAsync;
	readonly now?: () => number;
	readonly maxVisitedDirs?: number;
	readonly maxDirEntries?: number;
	readonly maxDepth?: number;
	readonly maxFiles?: number;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxDecls?: number;
	readonly maxImports?: number;
	readonly wallBudgetMs?: number;
}

/**
 * Bounded, admitted-context, session-scoped `.ilean` scanner.
 * Default cross-request retained snapshot count is 0 (request-local recomputation).
 */
export async function scanAllILeanFiles(
	admission: LeanNavigationAdmissionAvailable | null | undefined,
	sessionHandle: LineageHandle | null | undefined,
	signal?: AbortSignal,
	options: ScanILeanOptions = {},
): Promise<ILeanScanResult> {
	if (!admission || admission["status"] !== "available") {
		return {
			["status"]: "unavailable",
			reasonCode: "admission-missing",
			message:
				"environment_unavailable: Lean semantic navigation requires an admitted leanContext",
		};
	}
	if (!sessionHandle || !sessionHandle.isCurrent()) {
		return {
			["status"]: "unavailable",
			reasonCode: "session-unavailable",
			message:
				"environment_unavailable: Lean semantic navigation requires a live SessionScope handle",
		};
	}
	if (signal?.aborted) {
		return {
			["status"]: "unavailable",
			reasonCode: "cancelled",
			message: "environment_unavailable: Lean artifact scan cancelled",
		};
	}
	if (!admission.isCurrent()) {
		return {
			["status"]: "unavailable",
			reasonCode: "context-changed",
			message:
				"environment_unavailable: admitted Lean context or contributing configuration changed before scan",
		};
	}
	if (activeInFlightScans >= ILEAN_MAX_IN_FLIGHT_SCANS) {
		return {
			["status"]: "unavailable",
			reasonCode: "bounds-exceeded",
			message: `environment_unavailable: concurrent Lean artifact scan limit (${ILEAN_MAX_IN_FLIGHT_SCANS}) exceeded`,
		};
	}

	const startStamp = getILeanScanInvalidationStamp();
	const capturedScopeId = sessionHandle.scopeId;
	const capturedRegistrationId = admission.registrationId;
	const nowFn = options.now ?? Date.now;
	const startedAtMs = nowFn();
	const wallBudgetMs = options.wallBudgetMs ?? ILEAN_SCAN_WALL_BUDGET_MS;
	const maxVisitedDirs = options.maxVisitedDirs ?? ILEAN_MAX_VISITED_DIRS;
	const maxDirEntries = options.maxDirEntries ?? ILEAN_MAX_DIR_ENTRIES;
	const maxDepth = options.maxDepth ?? ILEAN_MAX_DEPTH;
	const maxFiles = options.maxFiles ?? ILEAN_MAX_FILES;
	const maxFileBytes = options.maxFileBytes ?? ILEAN_MAX_FILE_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? ILEAN_MAX_TOTAL_BYTES;
	const maxDecls = options.maxDecls ?? ILEAN_MAX_DECLS;
	const maxImports = options.maxImports ?? ILEAN_MAX_IMPORTS;

	const rawModuleRoots = admission.admittedContext.moduleRoots;
	if (rawModuleRoots.length > ILEAN_MAX_ROOTS) {
		return {
			["status"]: "unavailable",
			reasonCode: "bounds-exceeded",
			message: `environment_unavailable: moduleRoots count (${rawModuleRoots.length}) exceeds cap (${ILEAN_MAX_ROOTS})`,
		};
	}

	activeInFlightScans += 1;
	try {
		const probe = options.probe ?? safeSpawnAsync;
		try {
			await verifyLeanContext(
				admission.admittedContext,
				admission.servedRoot,
				probe,
			);
		} catch (thrown) {
			const msg =
				thrown instanceof Error
					? thrown.message
					: "environment_unavailable: Lean compiler verification failed";
			const isMismatch = msg.includes("declared Lean ");
			return {
				["status"]: "unavailable",
				reasonCode: isMismatch ? "compiler-mismatch" : "compiler-unavailable",
				message: msg,
			};
		}

		if (signal?.aborted) {
			return {
				["status"]: "unavailable",
				reasonCode: "cancelled",
				message: "environment_unavailable: Lean artifact scan cancelled",
			};
		}
		if (
			!sessionHandle.isCurrent() ||
			sessionHandle.scopeId !== capturedScopeId ||
			getILeanScanInvalidationStamp() !== startStamp ||
			admission.registrationId !== capturedRegistrationId ||
			!admission.isCurrent()
		) {
			return {
				["status"]: "unavailable",
				reasonCode: !sessionHandle.isCurrent()
					? "session-unavailable"
					: "context-changed",
				message:
					"environment_unavailable: session or admitted Lean context changed during compiler verification",
			};
		}

		const canonicalRoots: string[] = [];
		const seenRootSet = new Set<string>();
		for (const rootCandidate of rawModuleRoots) {
			try {
				const st = fs.statSync(rootCandidate);
				if (!st.isDirectory()) {
					return {
						["status"]: "unavailable",
						reasonCode: "context-changed",
						message:
							"environment_unavailable: admitted moduleRoot is no longer a directory",
					};
				}
				const realRoot = fs.realpathSync(rootCandidate);
				if (realRoot !== rootCandidate) {
					return {
						["status"]: "unavailable",
						reasonCode: "context-changed",
						message:
							"environment_unavailable: admitted moduleRoot canonical path changed",
					};
				}
				if (!seenRootSet.has(realRoot)) {
					seenRootSet.add(realRoot);
					canonicalRoots.push(realRoot);
				}
			} catch {
				return {
					["status"]: "unavailable",
					reasonCode: "context-changed",
					message:
						"environment_unavailable: admitted moduleRoot is no longer accessible",
				};
			}
		}

		let visitedDirs = 0;
		let inspectedEntries = 0;
		let totalFiles = 0;
		let totalBytes = 0;
		let totalDecls = 0;
		let totalImports = 0;

		const seenArtifacts = new Set<string>();
		const seenModules = new Map<string, string>();
		const items: ILeanScanInventoryItem[] = [];
		const preReadFingerprints: Array<{
			artifactPath: string;
			sha256: string;
			byteLength: number;
		}> = [];

		for (const moduleRoot of canonicalRoots) {
			const stack: Array<{ dirPath: string; depth: number }> = [
				{ dirPath: moduleRoot, depth: 0 },
			];

			while (stack.length > 0) {
				if (signal?.aborted) {
					return {
						["status"]: "unavailable",
						reasonCode: "cancelled",
						message: "environment_unavailable: Lean artifact scan cancelled",
					};
				}
				if (nowFn() - startedAtMs > wallBudgetMs) {
					return {
						["status"]: "unavailable",
						reasonCode: "bounds-exceeded",
						message: `environment_unavailable: Lean artifact scan exceeded wall budget (${wallBudgetMs}ms)`,
					};
				}

				const current = stack.pop()!;
				if (current.depth > maxDepth) {
					return {
						["status"]: "unavailable",
						reasonCode: "bounds-exceeded",
						message: `environment_unavailable: directory depth exceeded cap (${maxDepth})`,
					};
				}

				visitedDirs += 1;
				if (visitedDirs > maxVisitedDirs) {
					return {
						["status"]: "unavailable",
						reasonCode: "bounds-exceeded",
						message: `environment_unavailable: visited directory count exceeded cap (${maxVisitedDirs})`,
					};
				}

				let dirLst: fs.Stats;
				let dirReal: string;
				try {
					dirLst = fs.lstatSync(current.dirPath);
					if (dirLst.isSymbolicLink() || !dirLst.isDirectory()) {
						return {
							["status"]: "unavailable",
							reasonCode: "artifact-unavailable",
							message:
								"environment_unavailable: descendant symlink or non-directory encountered in moduleRoot",
						};
					}
					dirReal = fs.realpathSync(current.dirPath);
				} catch {
					return {
						["status"]: "unavailable",
						reasonCode: "artifact-unavailable",
						message:
							"environment_unavailable: unreadable directory in admitted moduleRoot",
					};
				}
				if (!isConfinedWithinRoot(dirReal, moduleRoot)) {
					return {
						["status"]: "unavailable",
						reasonCode: "artifact-unavailable",
						message:
							"environment_unavailable: directory escaped admitted moduleRoot",
					};
				}

				let dirHandle: fs.Dir;
				try {
					dirHandle = fs.opendirSync(dirReal);
				} catch {
					return {
						["status"]: "unavailable",
						reasonCode: "artifact-unavailable",
						message:
							"environment_unavailable: failed to open directory in admitted moduleRoot",
					};
				}

				const childDirs: string[] = [];
				const childFiles: string[] = [];
				try {
					while (true) {
						const dirent = dirHandle.readSync();
						if (!dirent) break;
						inspectedEntries += 1;
						if (inspectedEntries > maxDirEntries) {
							return {
								["status"]: "unavailable",
								reasonCode: "bounds-exceeded",
								message: `environment_unavailable: directory entry count exceeded cap (${maxDirEntries})`,
							};
						}
						if (dirent.isSymbolicLink()) {
							return {
								["status"]: "unavailable",
								reasonCode: "artifact-unavailable",
								message:
									"environment_unavailable: symlink entry rejected inside admitted moduleRoot",
							};
						}
						const childFull = join(dirReal, dirent.name);
						if (dirent.isDirectory()) {
							childDirs.push(childFull);
						} else if (dirent.isFile() && dirent.name.endsWith(".ilean")) {
							childFiles.push(childFull);
						}
					}
				} finally {
					try {
						dirHandle.closeSync();
					} catch {
						// ignore close error
					}
				}

				childDirs.sort();
				for (let i = childDirs.length - 1; i >= 0; i--) {
					stack.push({ dirPath: childDirs[i]!, depth: current.depth + 1 });
				}

				childFiles.sort();
				for (const ileanFile of childFiles) {
					if (signal?.aborted) {
						return {
							["status"]: "unavailable",
							reasonCode: "cancelled",
							message: "environment_unavailable: Lean artifact scan cancelled",
						};
					}
					if (nowFn() - startedAtMs > wallBudgetMs) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: Lean artifact scan exceeded wall budget (${wallBudgetMs}ms)`,
						};
					}

					let fileLst: fs.Stats;
					let fileReal: string;
					try {
						fileLst = fs.lstatSync(ileanFile);
						if (fileLst.isSymbolicLink() || !fileLst.isFile()) {
							return {
								["status"]: "unavailable",
								reasonCode: "artifact-unavailable",
								message:
									"environment_unavailable: symlink or non-regular .ilean file rejected",
							};
						}
						if (fileLst.size > maxFileBytes) {
							return {
								["status"]: "unavailable",
								reasonCode: "bounds-exceeded",
								message: `environment_unavailable: .ilean file exceeds per-file byte cap (${maxFileBytes})`,
							};
						}
						fileReal = fs.realpathSync(ileanFile);
					} catch {
						return {
							["status"]: "unavailable",
							reasonCode: "artifact-unavailable",
							message: "environment_unavailable: unreadable .ilean file",
						};
					}
					if (!isConfinedWithinRoot(fileReal, moduleRoot)) {
						return {
							["status"]: "unavailable",
							reasonCode: "artifact-unavailable",
							message:
								"environment_unavailable: .ilean file escaped admitted moduleRoot",
						};
					}

					if (seenArtifacts.has(fileReal)) {
						continue;
					}
					seenArtifacts.add(fileReal);

					totalFiles += 1;
					if (totalFiles > maxFiles) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: .ilean file count exceeded cap (${maxFiles})`,
						};
					}

					let rawBytes: Buffer;
					try {
						rawBytes = fs.readFileSync(fileReal);
						const postLst = fs.lstatSync(ileanFile);
						if (
							postLst.isSymbolicLink() ||
							!postLst.isFile() ||
							postLst.dev !== fileLst.dev ||
							postLst.ino !== fileLst.ino ||
							postLst.size !== fileLst.size ||
							postLst.mtimeMs !== fileLst.mtimeMs ||
							postLst.ctimeMs !== fileLst.ctimeMs
						) {
							return {
								["status"]: "unavailable",
								reasonCode: "context-changed",
								message:
									"environment_unavailable: .ilean artifact changed during scan",
							};
						}
					} catch {
						return {
							["status"]: "unavailable",
							reasonCode: "artifact-unavailable",
							message: "environment_unavailable: failed to read .ilean file",
						};
					}

					if (rawBytes.byteLength > maxFileBytes) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: .ilean file exceeds per-file byte cap (${maxFileBytes})`,
						};
					}
					totalBytes += rawBytes.byteLength;
					if (totalBytes > maxTotalBytes) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: aggregate .ilean bytes exceeded cap (${maxTotalBytes})`,
						};
					}

					const relFromRoot = relative(moduleRoot, fileReal).replace(
						/\.ilean$/,
						"",
					);
					const observedAtMs = nowFn();
					const decoded = decodeILeanBytesStrict(
						rawBytes,
						relFromRoot,
						moduleRoot,
						fileReal,
						observedAtMs,
					);
					if (!decoded.data) {
						const reasonCode = decoded.reasonCode ?? "artifact-unavailable";
						return {
							["status"]: "unavailable",
							reasonCode,
							message:
								reasonCode === "bounds-exceeded"
									? "environment_unavailable: .ilean decoded payload exceeded bounds"
									: "environment_unavailable: malformed or schema-mismatched .ilean artifact",
						};
					}

					totalDecls += decoded.declCount;
					if (totalDecls > maxDecls) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: aggregate declaration count exceeded cap (${maxDecls})`,
						};
					}
					totalImports += decoded.importCount;
					if (totalImports > maxImports) {
						return {
							["status"]: "unavailable",
							reasonCode: "bounds-exceeded",
							message: `environment_unavailable: aggregate direct-import count exceeded cap (${maxImports})`,
						};
					}

					const existingRoot = seenModules.get(decoded.data.module);
					if (existingRoot !== undefined) {
						if (existingRoot === moduleRoot) {
							return {
								["status"]: "unavailable",
								reasonCode: "artifact-unavailable",
								message: `environment_unavailable: duplicate module ${decoded.data.module} in same moduleRoot`,
							};
						}
						// Earlier moduleRoot in admission order wins; skip shadowed duplicate from later root
						continue;
					}
					seenModules.set(decoded.data.module, moduleRoot);

					preReadFingerprints.push({
						artifactPath: fileReal,
						sha256: decoded.sha256,
						byteLength: decoded.byteLength,
					});

					items.push(
						Object.freeze({
							version: decoded.data["version"],
							module: decoded.data.module,
							directImports: Object.freeze([...decoded.data.directImports]),
							decls: decoded.data.decls,
							moduleRoot,
							artifactPath: fileReal,
							artifactSha256: decoded.sha256,
							byteLength: decoded.byteLength,
							observedAtMs,
						}),
					);
				}
			}
		}

		// Re-verify artifact inventory digests before publishing snapshot
		for (const fp of preReadFingerprints) {
			try {
				const lst = fs.lstatSync(fp.artifactPath);
				if (
					lst.isSymbolicLink() ||
					!lst.isFile() ||
					lst.size !== fp.byteLength
				) {
					return {
						["status"]: "unavailable",
						reasonCode: "context-changed",
						message:
							"environment_unavailable: .ilean artifact changed before completion",
					};
				}
				const bytes = fs.readFileSync(fp.artifactPath);
				if (
					bytes.byteLength !== fp.byteLength ||
					createHash("sha256").update(bytes).digest("hex") !== fp.sha256
				) {
					return {
						["status"]: "unavailable",
						reasonCode: "context-changed",
						message:
							"environment_unavailable: .ilean artifact content digest changed before completion",
					};
				}
			} catch {
				return {
					["status"]: "unavailable",
					reasonCode: "context-changed",
					message:
						"environment_unavailable: .ilean artifact became unreadable before completion",
				};
			}
		}

		if (
			signal?.aborted ||
			!sessionHandle.isCurrent() ||
			sessionHandle.scopeId !== capturedScopeId ||
			getILeanScanInvalidationStamp() !== startStamp ||
			admission.registrationId !== capturedRegistrationId ||
			!admission.isCurrent()
		) {
			return {
				["status"]: "unavailable",
				reasonCode: signal?.aborted
					? "cancelled"
					: !sessionHandle.isCurrent()
						? "session-unavailable"
						: "context-changed",
				message:
					"environment_unavailable: session or admitted Lean context changed before scan completion",
			};
		}

		const observation: ILeanScanObservation = Object.freeze({
			servedRoot: admission.servedRoot,
			scopeId: capturedScopeId,
			registrationId: capturedRegistrationId,
			admittedContext: admission.admittedContext,
			items: Object.freeze(items),
			observedAtMs: nowFn(),
		});

		return {
			["status"]: "available",
			["snapshot"]: observation,
			items: observation.items,
		};
	} finally {
		activeInFlightScans = Math.max(0, activeInFlightScans - 1);
	}
}

function extractItems(
	input:
		| ILeanScanObservation
		| ILeanScanAvailable
		| readonly ILeanScanInventoryItem[]
		| readonly ILeanData[]
		| null
		| undefined,
): readonly (ILeanScanInventoryItem | ILeanData)[] {
	if (!input) return [];
	if (Array.isArray(input)) return input;
	if ("items" in input && Array.isArray(input.items)) return input.items;
	return [];
}

/**
 * Builds the module import / importedBy DAG from an admitted `.ilean` scan observation.
 */
export function buildILeanModuleGraph(
	observation:
		| ILeanScanObservation
		| ILeanScanAvailable
		| readonly ILeanScanInventoryItem[]
		| readonly ILeanData[]
		| null
		| undefined,
): ILeanModuleGraph {
	const all = extractItems(observation);
	const imports = new Map<string, string[]>();
	const importedBy = new Map<string, string[]>();

	for (const item of all) {
		if (!item.module) continue;
		imports.set(item.module, [...item.directImports]);
		if (!importedBy.has(item.module)) {
			importedBy.set(item.module, []);
		}
		for (const imp of item.directImports) {
			const list = importedBy.get(imp);
			if (list) {
				list.push(item.module);
			} else {
				importedBy.set(imp, [item.module]);
			}
		}
	}

	return { imports, importedBy };
}

/**
 * Looks up declarations matching a symbol query from an admitted `.ilean` scan observation,
 * supporting exact names and qualified suffix matches.
 */
export function lookupILeanDeclaration(
	observation:
		| ILeanScanObservation
		| ILeanScanAvailable
		| readonly ILeanScanInventoryItem[]
		| readonly ILeanData[]
		| null
		| undefined,
	symbolName: string,
): ILeanDeclaration[] {
	const all = extractItems(observation);
	const matches: ILeanDeclaration[] = [];
	const suffix = `.${symbolName}`;
	for (const file of all) {
		for (const [name, decl] of file.decls.entries()) {
			if (name === symbolName || name.endsWith(suffix)) {
				matches.push({
					...decl,
					...(file.moduleRoot ? { moduleRoot: file.moduleRoot } : {}),
					...(file.artifactPath ? { artifactPath: file.artifactPath } : {}),
					...(file.artifactSha256
						? { artifactSha256: file.artifactSha256 }
						: {}),
				});
			}
		}
	}
	return matches;
}

export interface ConfinedSourceLocation {
	readonly uri: string;
	readonly filePath: string;
	readonly range: ILeanRange;
	readonly sourceSha256: string;
}

export interface ConfinedSourceResolutionAvailable {
	readonly ["status"]: "available";
	readonly locations: readonly ConfinedSourceLocation[];
}

export interface ConfinedSourceResolutionUnavailable {
	readonly ["status"]: "unavailable";
	readonly reasonCode: ILeanUnavailableReasonCode;
	readonly message: string;
}

export type ConfinedSourceResolutionResult =
	| ConfinedSourceResolutionAvailable
	| ConfinedSourceResolutionUnavailable;

function readConfinedFileUnderModuleRoot(
	moduleRoot: string,
	moduleName: string,
	ext: ".lean" | ".c",
): {
	filePath: string;
	content: string;
	lines: string[];
	sha256: string;
} | null {
	const segments = validateModuleNameAndRelPath(moduleName);
	if (!segments) return null;
	try {
		const rootReal = fs.realpathSync(moduleRoot);
		let currentDir = rootReal;
		for (let i = 0; i < segments.length - 1; i++) {
			const segPath = join(currentDir, segments[i]!);
			const segLst = fs.lstatSync(segPath);
			if (segLst.isSymbolicLink() || !segLst.isDirectory()) return null;
			const segReal = fs.realpathSync(segPath);
			if (!isConfinedWithinRoot(segReal, rootReal)) return null;
			currentDir = segReal;
		}
		const candidate = join(
			currentDir,
			`${segments[segments.length - 1]!}${ext}`,
		);
		const lst = fs.lstatSync(candidate);
		if (lst.isSymbolicLink() || !lst.isFile()) return null;
		if (lst.size > ILEAN_MAX_FILE_BYTES) return null;
		const realFile = fs.realpathSync(candidate);
		if (!isConfinedWithinRoot(realFile, rootReal)) return null;
		const rawBytes = fs.readFileSync(realFile);
		if (rawBytes.byteLength > ILEAN_MAX_FILE_BYTES) return null;
		const post = fs.lstatSync(candidate);
		if (
			post.isSymbolicLink() ||
			!post.isFile() ||
			post.dev !== lst.dev ||
			post.ino !== lst.ino ||
			post.size !== lst.size ||
			post.mtimeMs !== lst.mtimeMs ||
			post.ctimeMs !== lst.ctimeMs
		) {
			return null;
		}
		const sha256 = createHash("sha256").update(rawBytes).digest("hex");
		const content = rawBytes.toString("utf8");
		return {
			filePath: realFile,
			content,
			lines: content.split(/\r?\n/),
			sha256,
		};
	} catch {
		return null;
	}
}

function isRangeWithinSourceLines(
	range: ILeanRange,
	lines: readonly string[],
): boolean {
	if (lines.length === 0) return false;
	const { start, end } = range;
	if (
		start.line < 0 ||
		end.line < start.line ||
		end.line >= lines.length ||
		start.character < 0 ||
		end.character < 0
	) {
		return false;
	}
	const startLineLen = (lines[start.line] ?? "").length;
	const endLineLen = (lines[end.line] ?? "").length;
	if (start.character > startLineLen || end.character > endLineLen) {
		return false;
	}
	return isValidRangeOrder(
		start.line,
		start.character,
		end.line,
		end.character,
	);
}

/**
 * Resolves declaration locations strictly within the same admitted `moduleRoot`
 * that supplied each `.ilean` declaration, verifying source file confinement and coordinate bounds.
 */
export function resolveConfinedDeclarationLocations(
	declarations: readonly ILeanDeclaration[],
): ConfinedSourceResolutionResult {
	if (declarations.length === 0) {
		return { ["status"]: "available", locations: [] };
	}
	const locations: ConfinedSourceLocation[] = [];
	for (const decl of declarations) {
		if (!decl.moduleRoot) {
			return {
				["status"]: "unavailable",
				reasonCode: "source-location-unavailable",
				message:
					"environment_unavailable: declaration has no admitted moduleRoot provenance",
			};
		}
		const sourceFile = readConfinedFileUnderModuleRoot(
			decl.moduleRoot,
			decl.module,
			".lean",
		);
		if (!sourceFile) {
			return {
				["status"]: "unavailable",
				reasonCode: "source-location-unavailable",
				message: `environment_unavailable: colocated source for ${decl.module} is unavailable under its admitted moduleRoot`,
			};
		}
		if (
			!isRangeWithinSourceLines(decl.range, sourceFile.lines) ||
			!isRangeWithinSourceLines(decl.selectionRange, sourceFile.lines)
		) {
			return {
				["status"]: "unavailable",
				reasonCode: "source-location-unavailable",
				message: `environment_unavailable: declaration coordinates for ${decl.name} exceed colocated source bounds`,
			};
		}
		locations.push(
			Object.freeze({
				uri: pathToFileURL(sourceFile.filePath).href,
				filePath: sourceFile.filePath,
				range: decl.selectionRange,
				sourceSha256: sourceFile.sha256,
			}),
		);
	}
	return {
		["status"]: "available",
		locations: Object.freeze(locations),
	};
}

export interface GeneratedCLocation {
	filePath: string;
	line: number;
	symbol: string;
	sourceSha256?: string;
}

/**
 * Resolves the generated C implementation for a Lean declaration strictly within
 * the same admitted `moduleRoot` that supplied the `.ilean` artifact.
 * Never falls back to workspace `.lake/build/ir`.
 */
export function lookupGeneratedCDeclaration(
	moduleRootOrObservation:
		| string
		| ILeanScanObservation
		| ILeanScanAvailable
		| null
		| undefined,
	moduleName: string,
	symbolName: string,
): GeneratedCLocation | null {
	if (!moduleRootOrObservation) return null;
	let targetRoot: string | undefined;
	if (typeof moduleRootOrObservation === "string") {
		targetRoot = moduleRootOrObservation;
	} else {
		const items = extractItems(moduleRootOrObservation);
		const matched = items.find((item) => item.module === moduleName);
		targetRoot = matched?.moduleRoot;
	}
	if (!targetRoot) return null;

	const cFile = readConfinedFileUnderModuleRoot(targetRoot, moduleName, ".c");
	if (!cFile) return null;

	const lines = cFile.lines;
	const base = symbolName.includes(".")
		? symbolName.split(".").pop()!
		: symbolName;
	const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const defPattern = new RegExp(
		`\\b((?:_init_)?(?:lean_|l[p_])[A-Za-z0-9_]*${escapedBase}(?:___boxed)?)\\s*\\([^;]*\\)\\s*\\{`,
	);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(defPattern);
		if (match?.[1]) {
			return {
				filePath: cFile.filePath,
				line: i,
				symbol: match[1],
				sourceSha256: cFile.sha256,
			};
		}
	}

	const declPattern = new RegExp(
		`\\b((?:lean_|l[p_])[A-Za-z0-9_]*${escapedBase})\\s*;`,
	);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i]!.match(declPattern);
		if (match?.[1]) {
			return {
				filePath: cFile.filePath,
				line: i,
				symbol: match[1],
				sourceSha256: cFile.sha256,
			};
		}
	}

	return null;
}

/**
 * Searches for an extern C symbol declaration or definition in human-authored
 * workspace C/C++ files (explicitly excluding generated .lake build directories).
 */
export function lookupExternCDeclaration(
	workspaceRoot: string,
	cSymbol: string,
): GeneratedCLocation | null {
	const candidates: string[] = [];
	const queue = [workspaceRoot];
	const cExtensions = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"]);

	while (queue.length > 0) {
		const current = queue.pop();
		if (!current) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (
				entry.name.startsWith(".") ||
				entry.name === "node_modules" ||
				entry.name === ".lake"
			) {
				continue;
			}
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (
				entry.isFile() &&
				cExtensions.has(extname(entry.name).toLowerCase())
			) {
				candidates.push(full);
			}
		}
	}

	const symbolPattern = new RegExp(`\\b${cSymbol}\\b`);
	for (const file of candidates) {
		try {
			const content = fs.readFileSync(file, "utf8");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				if (symbolPattern.test(lines[i]!)) {
					return {
						filePath: file,
						line: i,
						symbol: cSymbol,
					};
				}
			}
		} catch {
			continue;
		}
	}

	return null;
}

/**
 * Looks up a Lean declaration that binds a given C symbol via @[extern "cSymbol"].
 */
export function lookupLeanExternForCSymbol(
	workspaceRoot: string,
	cSymbol: string,
): {
	uri: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
} | null {
	const queue = [workspaceRoot];
	const pattern = new RegExp(`@\\[extern\\s+"${cSymbol}"\\]`);
	while (queue.length > 0) {
		const current = queue.pop();
		if (!current) break;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (
				entry.name.startsWith(".") ||
				entry.name === "node_modules" ||
				entry.name === ".lake"
			) {
				continue;
			}
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".lean")) {
				try {
					const content = fs.readFileSync(full, "utf8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (pattern.test(lines[i]!)) {
							return {
								uri: pathToFileURL(full).href,
								range: {
									start: { line: i, character: 0 },
									end: {
										line: i,
										character: lines[i]!.length,
									},
								},
							};
						}
					}
				} catch {
					continue;
				}
			}
		}
	}
	return null;
}

export interface ItpConceptMatch {
	conceptId: string;
	canonicalName: string;
	domainTheory: string;
	msc2020: string[];
	primaryTactics: string[];
	syntaxPattern?: string;
	authoritativeIntervals?: string[];
}

/**
 * Searches the ITP Master Authority Ontology for concepts related to a Lean 4 symbol or tactic.
 */
export function lookupItpConceptForLeanDeclaration(
	symbolOrTactic: string,
	workspaceRoot?: string,
): ItpConceptMatch[] {
	const query = symbolOrTactic.trim().toLowerCase();
	if (!query) return [];

	const candidatePaths = [
		workspaceRoot
			? resolvePath(
					workspaceRoot,
					"docs/investigation-garden/source-materials/indexes/master-authority-index.json",
				)
			: "",
		workspaceRoot
			? resolvePath(
					workspaceRoot,
					"vendor/itp-ontology/master-authority-index.json",
				)
			: "",
		resolvePath(
			__dirname,
			"../../vendor/itp-ontology/master-authority-index.json",
		),
		resolvePath(
			__dirname,
			"../vendor/itp-ontology/master-authority-index.json",
		),
		resolvePath(__dirname, "vendor/itp-ontology/master-authority-index.json"),
		resolvePath(
			process.cwd(),
			"docs/investigation-garden/source-materials/indexes/master-authority-index.json",
		),
		resolvePath(
			process.cwd(),
			"vendor/itp-ontology/master-authority-index.json",
		),
	].filter(Boolean);

	let indexPath: string | undefined;
	for (const p of candidatePaths) {
		if (fs.existsSync(p)) {
			indexPath = p;
			break;
		}
	}

	if (!indexPath) return [];

	try {
		const raw = fs.readFileSync(indexPath, "utf8");
		const data = JSON.parse(raw);
		const concepts = data.master_concepts || [];
		const results: ItpConceptMatch[] = [];

		for (const c of concepts) {
			const cid = (c.concept_id || "").toLowerCase();
			const cname = (c.canonical_name || "").toLowerCase();
			const domain = (c.ranganathan_facet?.domain_theory || "").toLowerCase();
			const synonyms = (c.synonyms || []).map((s: string) => s.toLowerCase());

			const leanMap = c.prover_mappings?.lean4;
			const leanTactics = (leanMap?.primary_tactics || [])
				.join(" ")
				.toLowerCase();
			const syntaxPat = (leanMap?.syntax_pattern || "").toLowerCase();

			if (
				cid.includes(query) ||
				cname.includes(query) ||
				domain.includes(query) ||
				synonyms.some((s: string) => s.includes(query)) ||
				leanTactics.includes(query) ||
				syntaxPat.includes(query)
			) {
				results.push({
					conceptId: c.concept_id,
					canonicalName: c.canonical_name,
					domainTheory: c.ranganathan_facet?.domain_theory || "ITP",
					msc2020: c.msc2020 || [],
					primaryTactics: leanMap?.primary_tactics || [],
					syntaxPattern: leanMap?.syntax_pattern,
					authoritativeIntervals: c.authoritative_intervals,
				});
			}
		}
		return results;
	} catch {
		return [];
	}
}

export interface BlueprintStatusResult {
	formalizationDir: string;
	blueprintDir: string;
	leanTheoremsCount: number;
	blueprintTheoremsCount: number;
	prematureLeanokCount: number;
	missingLeanokCount: number;
	ghostNodesCount: number;
	untrackedLeanCount: number;
	prematureLeanok: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}>;
	missingLeanok: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}>;
	ghostNodes: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}>;
	untrackedLean: Array<{
		leanSymbol: string;
		file: string;
		line: number;
	}>;
	rendered: string;
}

export interface PedagogicalWalkthroughResult {
	symbol: string;
	module?: string;
	filePath?: string;
	line?: number;
	docstring?: string;
	statement: {
		rawLean: string;
		informalSummary: string;
		rigorousLatex: string;
	};
	milestones: Array<{ line: number; text: string }>;
	rendered: string;
}

function findFilesRecursively(
	dir: string,
	ext: string,
	excludeDirs: Set<string>,
): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!excludeDirs.has(entry.name)) {
					results.push(
						...findFilesRecursively(
							path.join(dir, entry.name),
							ext,
							excludeDirs,
						),
					);
				}
			} else if (entry.isFile() && entry.name.endsWith(ext)) {
				results.push(path.join(dir, entry.name));
			}
		}
	} catch {
		// Ignore unreadable paths
	}
	return results;
}

export function deformalizeLeanMathStatement(rawStatement: string): {
	informalSummary: string;
	rigorousLatex: string;
} {
	const cleaned = rawStatement
		.replace(
			/^(?:(?:noncomputable|scoped|protected|private)\s+)*(?:theorem|lemma|def)\s+[A-Za-z0-9_.]+\s*/,
			"",
		)
		.replace(/:=\s*(?:by)?.*$/, "")
		.trim();

	const latex = cleaned
		.replace(/->/g, "\\to ")
		.replace(/\bforall\b/g, "\\forall ")
		.replace(/\bexists\b/g, "\\exists ")
		.replace(/<=/g, "\\le ")
		.replace(/>=/g, "\\ge ")
		.replace(/!=/g, "\\ne ")
		.replace(/\bReal\b/g, "\\mathbb{R}")
		.replace(/\bNat\b/g, "\\mathbb{N}")
		.replace(/\bInt\b/g, "\\mathbb{Z}")
		.replace(/\bRat\b/g, "\\mathbb{Q}")
		.replace(/\bComplex\b/g, "\\mathbb{C}");

	const informal =
		"States that for all valid inputs satisfying structural preconditions, mathematical invariants and bounds hold uniformly.";

	return {
		informalSummary: informal,
		rigorousLatex: latex,
	};
}

export function auditLeanBlueprintStatus(
	workspaceRoot: string,
	options?: { blueprintDir?: string; formalizationDir?: string },
): BlueprintStatusResult {
	const excludeDirs = new Set([
		".git",
		".lake",
		"vendor",
		"node_modules",
		"dist",
		".cache",
	]);

	// Resolve blueprint directory
	let resolvedBlueprintDir = "";
	if (options?.blueprintDir) {
		const bpCandidate = path.isAbsolute(options.blueprintDir)
			? options.blueprintDir
			: path.resolve(workspaceRoot, options.blueprintDir);
		if (fs.existsSync(bpCandidate)) {
			resolvedBlueprintDir = bpCandidate;
		}
	}
	if (!resolvedBlueprintDir) {
		const candidates = [
			path.resolve(workspaceRoot, "blueprint", "src"),
			path.resolve(workspaceRoot, "docs", "blueprint"),
			path.resolve(workspaceRoot, "blueprint"),
			path.resolve(workspaceRoot, "docs", "easci", "blueprint"),
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) {
				resolvedBlueprintDir = c;
				break;
			}
		}
	}

	// Resolve formalization directory
	let resolvedFormalizationDir = "";
	if (options?.formalizationDir) {
		const formCandidate = path.isAbsolute(options.formalizationDir)
			? options.formalizationDir
			: path.resolve(workspaceRoot, options.formalizationDir);
		if (fs.existsSync(formCandidate)) {
			resolvedFormalizationDir = formCandidate;
		}
	}
	if (!resolvedFormalizationDir) {
		const candidates = [
			path.resolve(workspaceRoot, "docs", "easci", "lean", "EASCI"),
			path.resolve(workspaceRoot, "docs", "easci", "lean"),
			path.resolve(workspaceRoot, "EASCI"),
			path.resolve(workspaceRoot, "lean"),
			workspaceRoot,
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) {
				resolvedFormalizationDir = c;
				break;
			}
		}
	}

	// Collect Lean files and scan declarations
	const leanFiles = findFilesRecursively(
		resolvedFormalizationDir,
		".lean",
		excludeDirs,
	);
	interface ScannedLeanDecl {
		name: string;
		file: string;
		line: number;
		hasSorry: boolean;
	}
	const leanDecls: ScannedLeanDecl[] = [];
	const leanDeclsByName = new Map<string, ScannedLeanDecl>();

	const declRegex =
		/^(?:(?:noncomputable|scoped|protected|private)\s+)*(theorem|lemma|def)\s+([A-Za-z0-9_.]+)/;

	for (const file of leanFiles) {
		try {
			const content = fs.readFileSync(file, "utf8");
			const lines = content.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const match = lines[i]!.trim().match(declRegex);
				if (match) {
					const name = match[2]!;
					let hasSorry = false;
					let inBlockComment = false;
					for (let j = i; j < Math.min(lines.length, i + 250); j++) {
						const l = lines[j]!.trim();
						if (
							j > i &&
							(declRegex.test(l) || l.startsWith("/--") || l.startsWith("/-"))
						) {
							break;
						}
						if (l.startsWith("end ") && !l.startsWith("end of")) break;
						if (l.startsWith("/-") || l.startsWith("/--")) {
							inBlockComment = true;
						}
						if (inBlockComment) {
							if (l.includes("-/")) inBlockComment = false;
							continue;
						}
						if (l.startsWith("--")) continue;
						const codePart = l.split("--")[0]!;
						if (/\bsorry\b/.test(codePart)) {
							hasSorry = true;
							break;
						}
					}
					const decl: ScannedLeanDecl = {
						name,
						file: path.relative(workspaceRoot, file),
						line: i + 1,
						hasSorry,
					};
					leanDecls.push(decl);
					leanDeclsByName.set(name, decl);
				}
			}
		} catch {
			// Ignore unreadable file
		}
	}

	// Collect Blueprint TeX files
	const texFiles = resolvedBlueprintDir
		? findFilesRecursively(resolvedBlueprintDir, ".tex", excludeDirs)
		: [];

	interface ScannedBpNode {
		label: string;
		leanSymbol: string;
		hasLeanok: boolean;
		file: string;
		line: number;
	}
	const bpNodes: ScannedBpNode[] = [];

	const leanTagRegex = /\\lean\{([^}]+)\}/g;
	const labelRegex = /\\label\{([^}]+)\}/;

	for (const file of texFiles) {
		try {
			const content = fs.readFileSync(file, "utf8");
			const lines = content.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const lineText = lines[i]!;
				let leanMatch: RegExpExecArray | null;
				leanTagRegex.lastIndex = 0;
				while ((leanMatch = leanTagRegex.exec(lineText)) !== null) {
					const leanSymbol = leanMatch[1]!.trim();
					let start = i;
					while (
						start > 0 &&
						!lines[start]!.includes("\\begin{") &&
						!lines[start]!.includes("\\end{")
					) {
						start--;
					}
					let end = i;
					while (
						end < lines.length - 1 &&
						!lines[end]!.includes("\\end{") &&
						!lines[end]!.includes("\\begin{")
					) {
						end++;
					}
					const windowText = lines.slice(start, end + 1).join("\n");
					const labelMatch = windowText.match(labelRegex);
					const label = labelMatch ? labelMatch[1]! : leanSymbol;
					const hasLeanok = windowText.includes("\\leanok");

					bpNodes.push({
						label,
						leanSymbol,
						hasLeanok,
						file: path.relative(workspaceRoot, file),
						line: i + 1,
					});
				}
			}
		} catch {
			// Ignore unreadable file
		}
	}

	// Cross-check
	const prematureLeanok: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}> = [];
	const missingLeanok: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}> = [];
	const ghostNodes: Array<{
		label: string;
		leanSymbol: string;
		file: string;
		line: number;
	}> = [];

	const referencedLeanSymbols = new Set<string>();

	for (const node of bpNodes) {
		referencedLeanSymbols.add(node.leanSymbol);
		const decl =
			leanDeclsByName.get(node.leanSymbol) ||
			leanDeclsByName.get(node.leanSymbol.split(".").pop()!);

		if (!decl) {
			ghostNodes.push({
				label: node.label,
				leanSymbol: node.leanSymbol,
				file: node.file,
				line: node.line,
			});
		} else if (node.hasLeanok && decl.hasSorry) {
			prematureLeanok.push({
				label: node.label,
				leanSymbol: node.leanSymbol,
				file: decl.file,
				line: decl.line,
			});
		} else if (!node.hasLeanok && !decl.hasSorry) {
			missingLeanok.push({
				label: node.label,
				leanSymbol: node.leanSymbol,
				file: decl.file,
				line: decl.line,
			});
		}
	}

	const untrackedLean: Array<{
		leanSymbol: string;
		file: string;
		line: number;
	}> = [];
	for (const decl of leanDecls) {
		if (
			!referencedLeanSymbols.has(decl.name) &&
			!referencedLeanSymbols.has(decl.name.split(".").pop()!)
		) {
			untrackedLean.push({
				leanSymbol: decl.name,
				file: decl.file,
				line: decl.line,
			});
		}
	}

	let rendered = `### Lean Blueprint Coverage & Integrity Audit\n\n`;
	rendered += `- **Formalization Dir**: \`${path.relative(workspaceRoot, resolvedFormalizationDir) || "."}\`\n`;
	rendered += `- **Blueprint Dir**: \`${path.relative(workspaceRoot, resolvedBlueprintDir) || "(not found)"}\`\n`;
	rendered += `- **Physical Lean Declarations**: ${leanDecls.length}\n`;
	rendered += `- **Blueprint LaTeX Nodes**: ${bpNodes.length}\n`;
	rendered += `- **Premature \\\\leanok (Contains Sorries)**: ${prematureLeanok.length}\n`;
	rendered += `- **Missing \\\\leanok (Fully Proven in Lean)**: ${missingLeanok.length}\n`;
	rendered += `- **Ghost Nodes (Blueprint tag missing in Lean)**: ${ghostNodes.length}\n`;
	rendered += `- **Untracked Lean Theorems**: ${untrackedLean.length}\n\n`;

	if (prematureLeanok.length > 0) {
		rendered += `#### Premature \\\\leanok (Critical Integrity Violations)\n`;
		for (const p of prematureLeanok.slice(0, 10)) {
			rendered += `- \`${p.label}\` -> \`${p.leanSymbol}\` (${p.file}:${p.line})\n`;
		}
		if (prematureLeanok.length > 10) {
			rendered += `- ... and ${prematureLeanok.length - 10} more\n`;
		}
		rendered += "\n";
	}

	if (missingLeanok.length > 0) {
		rendered += `#### Missing \\\\leanok (Proven but Unmarked in Blueprint)\n`;
		for (const m of missingLeanok.slice(0, 10)) {
			rendered += `- \`${m.label}\` -> \`${m.leanSymbol}\` (${m.file}:${m.line})\n`;
		}
		if (missingLeanok.length > 10) {
			rendered += `- ... and ${missingLeanok.length - 10} more\n`;
		}
		rendered += "\n";
	}

	if (ghostNodes.length > 0) {
		rendered += `#### Ghost Nodes (Tagged in Blueprint but Missing in Lean)\n`;
		for (const g of ghostNodes.slice(0, 10)) {
			rendered += `- \`${g.label}\` -> \`${g.leanSymbol}\` (${g.file}:${g.line})\n`;
		}
		if (ghostNodes.length > 10) {
			rendered += `- ... and ${ghostNodes.length - 10} more\n`;
		}
		rendered += "\n";
	}

	return {
		formalizationDir: resolvedFormalizationDir,
		blueprintDir: resolvedBlueprintDir,
		leanTheoremsCount: leanDecls.length,
		blueprintTheoremsCount: bpNodes.length,
		prematureLeanokCount: prematureLeanok.length,
		missingLeanokCount: missingLeanok.length,
		ghostNodesCount: ghostNodes.length,
		untrackedLeanCount: untrackedLean.length,
		prematureLeanok,
		missingLeanok,
		ghostNodes,
		untrackedLean,
		rendered,
	};
}

/**
 * Generates a pedagogical proof walkthrough strictly from an admitted `.ilean` scan
 * observation or an explicitly confined `.lean` file inside `admittedContext.moduleRoots`.
 * Workspace-wide recursive file search is never performed.
 */
export function generatePedagogicalProofWalkthrough(
	observationOrWorkspace:
		| ILeanScanObservation
		| ILeanScanAvailable
		| LeanNavigationAdmissionAvailable
		| string
		| null
		| undefined,
	symbol: string,
	filePath?: string,
): PedagogicalWalkthroughResult | null {
	const trimmedSymbol = symbol.trim();
	if (!trimmedSymbol || !observationOrWorkspace) return null;
	if (typeof observationOrWorkspace === "string") {
		// Unadmitted raw workspace strings are refused under admitted-context navigation
		return null;
	}

	const observation: ILeanScanObservation | undefined =
		"servedRoot" in observationOrWorkspace && "items" in observationOrWorkspace
			? observationOrWorkspace
			: "snapshot" in observationOrWorkspace
				? observationOrWorkspace["snapshot"]
				: undefined;
	const admittedRoots =
		observation?.admittedContext.moduleRoots ??
		("admittedContext" in observationOrWorkspace
			? observationOrWorkspace.admittedContext.moduleRoots
			: []);
	const servedRoot =
		observation?.servedRoot ??
		("servedRoot" in observationOrWorkspace
			? observationOrWorkspace.servedRoot
			: "");

	if (admittedRoots.length === 0) return null;

	let targetFile = "";
	let line = 0;
	let moduleName = "";
	let lines: string[] = [];

	if (filePath) {
		try {
			const candidate = isAbsolute(filePath)
				? filePath
				: servedRoot
					? join(servedRoot, filePath)
					: "";
			if (!candidate) return null;
			const lst = fs.lstatSync(candidate);
			if (lst.isSymbolicLink() || !lst.isFile()) return null;
			if (lst.size > ILEAN_MAX_FILE_BYTES) return null;
			const realFile = fs.realpathSync(candidate);
			const confined = admittedRoots.some((root) => {
				try {
					return isConfinedWithinRoot(realFile, fs.realpathSync(root));
				} catch {
					return false;
				}
			});
			if (!confined) return null;
			const rawBytes = fs.readFileSync(realFile);
			if (rawBytes.byteLength > ILEAN_MAX_FILE_BYTES) return null;
			const post = fs.lstatSync(candidate);
			if (
				post.isSymbolicLink() ||
				!post.isFile() ||
				post.dev !== lst.dev ||
				post.ino !== lst.ino ||
				post.size !== lst.size ||
				post.mtimeMs !== lst.mtimeMs ||
				post.ctimeMs !== lst.ctimeMs
			) {
				return null;
			}
			targetFile = realFile;
			lines = rawBytes.toString("utf8").split(/\r?\n/);
		} catch {
			return null;
		}
	}

	if (!targetFile && observation) {
		const ileanMatches = lookupILeanDeclaration(observation, trimmedSymbol);
		if (ileanMatches.length > 0) {
			const m = ileanMatches[0]!;
			if (!m.moduleRoot) return null;
			const colocated = readConfinedFileUnderModuleRoot(
				m.moduleRoot,
				m.module,
				".lean",
			);
			if (
				!colocated ||
				!isRangeWithinSourceLines(m.range, colocated.lines) ||
				!isRangeWithinSourceLines(m.selectionRange, colocated.lines)
			) {
				return null;
			}
			moduleName = m.module;
			targetFile = colocated.filePath;
			lines = colocated.lines;
			line = m.selectionRange.start.line + 1;
		}
	}

	if (!targetFile || lines.length === 0) {
		return null;
	}

	if (line === 0) {
		const symShort = trimmedSymbol.split(".").pop()!;
		const escapedSym = symShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const declRegex = new RegExp(
			`^(?:(?:noncomputable|scoped|protected|private)\\s+)*(?:theorem|lemma|def)\\s+${escapedSym}\\b`,
		);
		for (let i = 0; i < lines.length; i++) {
			if (declRegex.test(lines[i]!.trim())) {
				line = i + 1;
				break;
			}
		}
	}

	if (line <= 0 || line > lines.length) return null;

	let docstring = "";
	if (line > 1) {
		let c = line - 2;
		while (c >= 0 && lines[c]!.trim() === "") c--;
		if (c >= 0 && lines[c]!.trim().endsWith("-/")) {
			const endD = c;
			while (c >= 0 && !lines[c]!.includes("/--")) c--;
			if (c >= 0 && lines[c]!.includes("/--")) {
				const docLines = lines.slice(c, endD + 1).map((l) =>
					l
						.replace(/^\s*\/--\s*/, "")
						.replace(/\s*-\/\s*$/, "")
						.trim(),
				);
				const nonBlankLines: string[] = [];
				for (const dl of docLines) {
					if (dl) nonBlankLines.push(dl);
				}
				docstring = nonBlankLines.join(" ");
			}
		}
	}

	const statementLines: string[] = [];
	let proofStart = line;
	let idx = line - 1;
	while (idx < lines.length) {
		statementLines.push(lines[idx]!.trim());
		if (lines[idx]!.includes(":=") || lines[idx]!.includes("where")) {
			proofStart = idx + 2;
			break;
		}
		idx++;
	}
	const rawStatement = statementLines.join(" ");
	const deformalized = deformalizeLeanMathStatement(rawStatement);

	const milestones: Array<{ line: number; text: string }> = [];
	const milestoneRegex =
		/^\s*(?:have\b|obtain\b|calc\b|induction\b|rcases\b|cases\b|constructor\b|by_contra\b|ext\b)/;
	for (
		let p = proofStart - 1;
		p < Math.min(lines.length, proofStart + 250);
		p++
	) {
		const trimmed = lines[p]!.trim();
		if (
			/^(?:(?:noncomputable|scoped|protected|private)\s+)*(?:theorem|lemma|def|structure|class)\s+[A-Za-z0-9_.]+\b/.test(
				trimmed,
			)
		) {
			break;
		}
		if (trimmed.startsWith("end ") && !trimmed.startsWith("end of")) break;
		if (milestoneRegex.test(trimmed)) {
			milestones.push({ line: p + 1, text: trimmed });
		}
	}

	const relFile = servedRoot ? relative(servedRoot, targetFile) : targetFile;

	let md = `# Pedagogical Proof Walkthrough: \`${trimmedSymbol}\`\n\n`;
	md += `**Location**: \`${relFile}:${line}\`\n\n`;
	if (docstring) {
		md += `> ${docstring}\n\n`;
	}

	md += `## Stage 1: Intuitive Mathematical Summary\n`;
	md += `${deformalized.informalSummary}\n\n`;

	md += `## Stage 2: Rigorous Mathematical Formulation\n`;
	md += `$$\n${deformalized.rigorousLatex}\n$$\n\n`;

	md += `## Stage 3: Type De-formalization & Proof Milestone Skeleton\n`;
	md += `### Formal Lean Declaration\n`;
	md += `\`\`\`lean\n${rawStatement}\n\`\`\`\n\n`;

	md += `### Milestone Towers\n`;
	if (milestones.length > 0) {
		for (const ms of milestones) {
			md += `- **Line ${ms.line}**: \`${ms.text}\`\n`;
		}
	} else {
		md += `- *Direct / automated term proof without intermediate have-lemmas.*\n`;
	}
	md += "\n";

	return {
		symbol: trimmedSymbol,
		module: moduleName || undefined,
		filePath: relFile,
		line,
		docstring: docstring || undefined,
		statement: {
			rawLean: rawStatement,
			informalSummary: deformalized.informalSummary,
			rigorousLatex: deformalized.rigorousLatex,
		},
		milestones,
		rendered: md,
	};
}
