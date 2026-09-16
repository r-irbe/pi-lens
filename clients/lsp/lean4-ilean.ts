import * as fs from "node:fs";
import * as path from "node:path";

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
 * Finds the .lake/build/lib/lean directory containing compiled .ilean artifacts.
 */
export function findILeanRoot(workspaceRoot: string): string | null {
	const candidates = [
		path.join(workspaceRoot, ".lake", "build", "lib", "lean"),
		path.join(workspaceRoot, ".lake", "build", "lib"),
	];
	for (const cand of candidates) {
		try {
			if (fs.statSync(cand).isDirectory()) return cand;
		} catch {
			// directory does not exist
		}
	}
	return null;
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

/**
 * Recursively scans all .ilean files in a workspace root.
 */
export function scanAllILeanFiles(workspaceRoot: string): ILeanData[] {
	const root = findILeanRoot(workspaceRoot);
	if (!root) return [];

	const results: ILeanData[] = [];
	const queue = [root];

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
 * Looks up declarations matching a symbol query from cached .ilean artifacts.
 */
export function lookupILeanDeclaration(
	workspaceRoot: string,
	symbolName: string,
): ILeanDeclaration[] {
	const all = scanAllILeanFiles(workspaceRoot);
	const matches: ILeanDeclaration[] = [];
	for (const file of all) {
		const decl = file.decls.get(symbolName);
		if (decl) {
			matches.push(decl);
		}
	}
	return matches;
}
