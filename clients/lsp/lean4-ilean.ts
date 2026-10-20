import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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
}

export interface ILeanData {
	version: number;
	module: string;
	directImports: string[];
	decls: Map<string, ILeanDeclaration>;
}

export interface ILeanModuleGraph {
	imports: Map<string, string[]>;
	importedBy: Map<string, string[]>;
}

/**
 * Finds all directories containing compiled .ilean artifacts.
 * External `.lake/packages` (e.g. 7,800+ Mathlib `.ilean` files) are gated behind
 * `process.env.LEAN_INDEX_PACKAGES === "1"` so symbol/module-graph queries remain sub-5ms.
 */
export function findILeanRoots(workspaceRoot: string): string[] {
	const roots: string[] = [];

	const primaryLean = path.join(workspaceRoot, ".lake", "build", "lib", "lean");
	const primaryLib = path.join(workspaceRoot, ".lake", "build", "lib");
	try {
		if (fs.statSync(primaryLean).isDirectory()) {
			roots.push(primaryLean);
		} else if (fs.statSync(primaryLib).isDirectory()) {
			roots.push(primaryLib);
		}
	} catch {
		// does not exist
	}

	if (process.env.LEAN_INDEX_PACKAGES === "1") {
		const packagesDir = path.join(workspaceRoot, ".lake", "packages");
		try {
			const pkgEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
			for (const pkg of pkgEntries) {
				if (pkg.isDirectory()) {
					const pkgLean = path.join(
						packagesDir,
						pkg.name,
						".lake",
						"build",
						"lib",
						"lean",
					);
					const pkgLib = path.join(
						packagesDir,
						pkg.name,
						".lake",
						"build",
						"lib",
					);
					try {
						if (fs.statSync(pkgLean).isDirectory()) {
							roots.push(pkgLean);
						} else if (fs.statSync(pkgLib).isDirectory()) {
							roots.push(pkgLib);
						}
					} catch {
						// package lib not built
					}
				}
			}
		} catch {
			// no packages directory
		}
	}

	return roots;
}

/**
 * Finds the primary .lake/build/lib/lean directory containing compiled .ilean artifacts.
 */
export function findILeanRoot(workspaceRoot: string): string | null {
	return findILeanRoots(workspaceRoot)[0] ?? null;
}

/**
 * Parses an individual .ilean JSON file.
 */
export function readILeanFile(ileanPath: string): ILeanData | null {
	try {
		const raw = fs.readFileSync(ileanPath, "utf-8");
		const data = JSON.parse(raw) as {
			version?: number;
			module?: string;
			directImports?: Array<[string, boolean, boolean, boolean]>;
			decls?: Record<string, number[]>;
		};
		if (!data || typeof data !== "object") return null;

		const modName = data.module ?? "";
		const declMap = new Map<string, ILeanDeclaration>();
		if (data.decls && typeof data.decls === "object") {
			for (const [name, coords] of Object.entries(data.decls)) {
				if (Array.isArray(coords) && coords.length >= 8) {
					declMap.set(name, {
						name,
						module: modName,
						range: {
							start: { line: coords[0] ?? 0, character: coords[1] ?? 0 },
							end: { line: coords[2] ?? 0, character: coords[3] ?? 0 },
						},
						selectionRange: {
							start: { line: coords[4] ?? 0, character: coords[5] ?? 0 },
							end: { line: coords[6] ?? 0, character: coords[7] ?? 0 },
						},
					});
				}
			}
		}

		const imports: string[] = [];
		if (Array.isArray(data.directImports)) {
			for (const entry of data.directImports) {
				if (Array.isArray(entry) && typeof entry[0] === "string") {
					imports.push(entry[0]);
				}
			}
		}

		return {
			version: data.version ?? 0,
			module: modName,
			directImports: imports,
			decls: declMap,
		};
	} catch {
		return null;
	}
}

interface ILeanScanCacheEntry {
	rootsKey: string;
	rootMtimes: string;
	timestampMs: number;
	data: ILeanData[];
}

const ILEAN_SCAN_CACHE_TTL_MS = 10_000;
const ileanScanCache = new Map<string, ILeanScanCacheEntry>();

/**
 * Clears the in-memory .ilean scan cache (useful for testing).
 */
export function clearILeanScanCache(): void {
	ileanScanCache.clear();
}

/**
 * Recursively scans all .ilean files in a workspace root across all roots,
 * with an in-memory per-workspaceRoot cache keyed by roots + directory mtime + TTL.
 */
export function scanAllILeanFiles(workspaceRoot: string): ILeanData[] {
	const resolvedWorkspace = path.resolve(workspaceRoot);
	const roots = findILeanRoots(resolvedWorkspace);
	if (roots.length === 0) return [];

	const indexPackagesFlag = process.env.LEAN_INDEX_PACKAGES === "1" ? "1" : "0";
	const cacheKey = `${resolvedWorkspace}::${indexPackagesFlag}`;
	const rootsKey = roots.join("|");
	const rootMtimes = roots
		.map((r) => {
			try {
				return `${r}:${fs.statSync(r).mtimeMs}`;
			} catch {
				return `${r}:0`;
			}
		})
		.join("|");

	const now = Date.now();
	const cached = ileanScanCache.get(cacheKey);
	if (
		cached &&
		cached.rootsKey === rootsKey &&
		cached.rootMtimes === rootMtimes &&
		now - cached.timestampMs < ILEAN_SCAN_CACHE_TTL_MS
	) {
		return cached.data;
	}

	const results: ILeanData[] = [];
	const queue = [...roots];

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
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".ilean")) {
				const parsed = readILeanFile(full);
				if (parsed) results.push(parsed);
			}
		}
	}

	ileanScanCache.set(cacheKey, {
		rootsKey,
		rootMtimes,
		timestampMs: now,
		data: results,
	});

	return results;
}

/**
 * Builds the module import / importedBy DAG from .ilean files.
 */
export function buildILeanModuleGraph(workspaceRoot: string): ILeanModuleGraph {
	const all = scanAllILeanFiles(workspaceRoot);
	const imports = new Map<string, string[]>();
	const importedBy = new Map<string, string[]>();

	for (const item of all) {
		if (!item.module) continue;
		imports.set(item.module, item.directImports);
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
 * Looks up declarations matching a symbol query from cached .ilean artifacts,
 * supporting exact names and qualified suffix matches.
 */
export function lookupILeanDeclaration(
	workspaceRoot: string,
	symbolName: string,
): ILeanDeclaration[] {
	const all = scanAllILeanFiles(workspaceRoot);
	const matches: ILeanDeclaration[] = [];
	const suffix = `.${symbolName}`;
	for (const file of all) {
		for (const [name, decl] of file.decls.entries()) {
			if (name === symbolName || name.endsWith(suffix)) {
				matches.push(decl);
			}
		}
	}
	return matches;
}

export interface GeneratedCLocation {
	filePath: string;
	line: number;
	symbol: string;
}

/**
 * Resolves the generated C implementation for a Lean declaration within
 * Lake's intermediate build directory (.lake/build/ir/).
 */
export function lookupGeneratedCDeclaration(
	workspaceRoot: string,
	moduleName: string,
	symbolName: string,
): GeneratedCLocation | null {
	const relPath = moduleName.replace(/\./g, path.sep) + ".c";
	const candidate = path.join(workspaceRoot, ".lake", "build", "ir", relPath);
	if (!fs.existsSync(candidate)) return null;

	try {
		const content = fs.readFileSync(candidate, "utf8");
		const lines = content.split("\n");
		const base = symbolName.includes(".")
			? symbolName.split(".").pop()!
			: symbolName;
		const defPattern = new RegExp(
			`\\b((?:_init_)?(?:lean_|l[p_])[A-Za-z0-9_]*${base}(?:___boxed)?)\\s*\\([^;]*\\)\\s*\\{`,
		);
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(defPattern);
			if (match) {
				return {
					filePath: candidate,
					line: i,
					symbol: match[1],
				};
			}
		}

		// Fallback to static/exported variable declaration for constants/values
		const declPattern = new RegExp(
			`\\b((?:lean_|l[p_])[A-Za-z0-9_]*${base})\\s*;`,
		);
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(declPattern);
			if (match) {
				return {
					filePath: candidate,
					line: i,
					symbol: match[1],
				};
			}
		}
	} catch {
		return null;
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
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (
				entry.isFile() &&
				cExtensions.has(path.extname(entry.name).toLowerCase())
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
				if (symbolPattern.test(lines[i])) {
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
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".lean")) {
				try {
					const content = fs.readFileSync(full, "utf8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (pattern.test(lines[i])) {
							return {
								uri: pathToFileURL(full).href,
								range: {
									start: { line: i, character: 0 },
									end: {
										line: i,
										character: lines[i].length,
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
			? path.resolve(
					workspaceRoot,
					"docs/investigation-garden/source-materials/indexes/master-authority-index.json",
				)
			: "",
		workspaceRoot
			? path.resolve(
					workspaceRoot,
					"vendor/itp-ontology/master-authority-index.json",
				)
			: "",
		path.resolve(
			__dirname,
			"../../vendor/itp-ontology/master-authority-index.json",
		),
		path.resolve(
			__dirname,
			"../vendor/itp-ontology/master-authority-index.json",
		),
		path.resolve(__dirname, "vendor/itp-ontology/master-authority-index.json"),
		path.resolve(
			process.cwd(),
			"docs/investigation-garden/source-materials/indexes/master-authority-index.json",
		),
		path.resolve(
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
				const match = lines[i].trim().match(declRegex);
				if (match) {
					const name = match[2];
					let hasSorry = false;
					// Scan proof body until next decl or end
					let inBlockComment = false;
					for (let j = i; j < Math.min(lines.length, i + 250); j++) {
						const l = lines[j].trim();
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
						const codePart = l.split("--")[0];
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
				const lineText = lines[i];
				let leanMatch: RegExpExecArray | null;
				leanTagRegex.lastIndex = 0;
				while ((leanMatch = leanTagRegex.exec(lineText)) !== null) {
					const leanSymbol = leanMatch[1].trim();
					// Look for label and leanok strictly within the enclosing environment
					let start = i;
					while (
						start > 0 &&
						!lines[start].includes("\\begin{") &&
						!lines[start].includes("\\end{")
					) {
						start--;
					}
					let end = i;
					while (
						end < lines.length - 1 &&
						!lines[end].includes("\\end{") &&
						!lines[end].includes("\\begin{")
					) {
						end++;
					}
					const windowText = lines.slice(start, end + 1).join("\n");
					const labelMatch = windowText.match(labelRegex);
					const label = labelMatch ? labelMatch[1] : leanSymbol;
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

export function generatePedagogicalProofWalkthrough(
	workspaceRoot: string,
	symbol: string,
	filePath?: string,
): PedagogicalWalkthroughResult | null {
	const trimmedSymbol = symbol.trim();
	if (!trimmedSymbol) return null;

	let targetFile = filePath ? path.resolve(workspaceRoot, filePath) : "";
	let line = 0;
	let moduleName = "";

	if (!targetFile || !fs.existsSync(targetFile)) {
		const ileanMatches = lookupILeanDeclaration(workspaceRoot, trimmedSymbol);
		if (ileanMatches.length > 0) {
			const m = ileanMatches[0];
			moduleName = m.module;
			line = m.selectionRange.start.line + 1;
			const modRel = moduleName.replace(/\./g, "/") + ".lean";
			const candidates = [
				path.resolve(workspaceRoot, modRel),
				path.resolve(workspaceRoot, "docs/easci/lean", modRel),
				path.resolve(workspaceRoot, "EASCI", modRel),
			];
			for (const c of candidates) {
				if (fs.existsSync(c)) {
					targetFile = c;
					break;
				}
			}
		}
	}

	if (!targetFile || !fs.existsSync(targetFile)) {
		const leanFiles = findFilesRecursively(
			workspaceRoot,
			".lean",
			new Set([".git", ".lake", "vendor", "node_modules"]),
		);
		const declRegex = new RegExp(
			`^(?:(?:noncomputable|scoped|protected|private)\\s+)*(?:theorem|lemma|def)\\s+${trimmedSymbol.split(".").pop()!}\\b`,
		);
		for (const f of leanFiles) {
			try {
				const content = fs.readFileSync(f, "utf8");
				const lines = content.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (declRegex.test(lines[i].trim())) {
						targetFile = f;
						line = i + 1;
						break;
					}
				}
				if (targetFile) break;
			} catch {
				// Continue search
			}
		}
	}

	if (!targetFile || !fs.existsSync(targetFile)) {
		return null;
	}

	const rawContent = fs.readFileSync(targetFile, "utf8");
	const lines = rawContent.split(/\r?\n/);

	if (line === 0) {
		const symShort = trimmedSymbol.split(".").pop()!;
		const declRegex = new RegExp(
			`^(?:(?:noncomputable|scoped|protected|private)\\s+)*(?:theorem|lemma|def)\\s+${symShort}\\b`,
		);
		for (let i = 0; i < lines.length; i++) {
			if (declRegex.test(lines[i].trim())) {
				line = i + 1;
				break;
			}
		}
	}

	if (line === 0) return null;

	let docstring = "";
	if (line > 1) {
		let c = line - 2;
		while (c >= 0 && lines[c].trim() === "") c--;
		if (c >= 0 && lines[c].trim().endsWith("-/")) {
			const endD = c;
			while (c >= 0 && !lines[c].includes("/--")) c--;
			if (c >= 0 && lines[c].includes("/--")) {
				const docLines = lines.slice(c, endD + 1).map((l) =>
					l
						.replace(/^\s*\/--\s*/, "")
						.replace(/\s*-\/\s*$/, "")
						.trim(),
				);
				docstring = docLines.filter(Boolean).join(" ");
			}
		}
	}

	const statementLines: string[] = [];
	let proofStart = line;
	let idx = line - 1;
	while (idx < lines.length) {
		statementLines.push(lines[idx].trim());
		if (lines[idx].includes(":=") || lines[idx].includes("where")) {
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
		const trimmed = lines[p].trim();
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

	const relFile = path.relative(workspaceRoot, targetFile);

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
