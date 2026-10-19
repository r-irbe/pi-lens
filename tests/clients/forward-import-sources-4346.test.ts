/**
 * #4346: `extractForwardImportPaths` answers the files one file imports now.
 * The LSP created-module producer calls it on every diagnostics batch that
 * replays a finding, so the parse is kept per file version and the sources are
 * resolved on every call: a module created since must appear without the
 * importer changing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_getForwardImportParsesForTests,
	extractForwardImportPaths,
} from "../../clients/blocker-freshness.js";
import { pathBirthtimeMs } from "../../clients/path-birth.js";
import { toPosix } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDirSync(root);
});

function workspace(prefix: string, files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.push(root);
	write(root, files);
	return root;
}

function write(root: string, files: Record<string, string>): void {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
}

const relative = (root: string, files: string[]): string[] =>
	files.map((file) => toPosix(path.relative(root, file))).sort();

describe("extractForwardImportPaths (#4346)", () => {
	it("answers a module created after the first call, as a full build resolves it", async () => {
		const root = workspace("pi-lens-4346-fwd-", {
			"pyproject.toml": '[project]\nname="x"\nversion="0.0.0"\n',
			"src/fixturepkg/__init__.py": "",
			"tools/probe.py":
				"from fixturepkg.new_module import describe\nimport os\n\nvalue = describe()\n",
		});
		const importer = path.join(root, "tools/probe.py");
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);

		write(root, {
			"src/fixturepkg/new_module.py": "def describe():\n    return 1\n",
		});

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/fixturepkg/new_module.py"]);
	});

	// Recurrence: #4344 r1's replay regression class. Re-parsing each file on
	// every batch took a warm 32-file replay from 7 ms to 118-215 ms (#4346
	// measurement, before this memo).
	it("parses an unchanged file once and still sees a module created since", async () => {
		const root = workspace("pi-lens-4346-fwd-memo-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\nexport const x = b;\n',
		});
		const importer = path.join(root, "src/a.ts");
		const before = _getForwardImportParsesForTests();
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);

		write(root, { "src/b.ts": "export const b = 1;\n" });
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/b.ts"]);
		expect(_getForwardImportParsesForTests() - before).toBe(1);

		// The importer's own change is a new parse.
		write(root, {
			"src/a.ts": 'import { c } from "./c";\nexport const x = c;\n',
			"src/c.ts": "export const c = 1;\n",
		});
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(importer, later, later);
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/c.ts"]);
		expect(_getForwardImportParsesForTests() - before).toBe(2);
	});

	// Recurrence: #4368 r1 R13 (a surviving mutant). A rewrite that lands in
	// the same mtime bucket with a different length must be a new parse, or
	// the memo keeps answering the old imports.
	it("parses again when the size changes under the same mtime", async () => {
		const root = workspace("pi-lens-4346-fwd-size-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\n',
			"src/b.ts": "export const b = 1;\n",
			"src/cc.ts": "export const c = 1;\n",
		});
		const importer = path.join(root, "src/a.ts");
		const pinned = new Date(Date.now() - 60_000);
		fs.utimesSync(importer, pinned, pinned);
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/b.ts"]);

		fs.writeFileSync(importer, 'import { c } from "./cc";\n');
		fs.utimesSync(importer, pinned, pinned);

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/cc.ts"]);
	});

	// Recurrence: #4368 r2. A rewrite that keeps the size and restores the
	// mtime left the memo answering the old imports, so the producer resolved
	// a module the importer no longer imports (the binding test in
	// tests/tools/lsp-diagnostics-created-outside-4346.test.ts went stale).
	it("parses again when a same-size rewrite restores the mtime", async () => {
		const root = workspace("pi-lens-4346-fwd-ctime-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\n',
			"src/b.ts": "export const b = 1;\n",
			"src/c.ts": "export const c = 1;\n",
		});
		const importer = path.join(root, "src/a.ts");
		const pinned = new Date(Date.now() - 60_000);
		fs.utimesSync(importer, pinned, pinned);
		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/b.ts"]);
		const before = fs.statSync(importer);

		fs.writeFileSync(importer, 'import { c } from "./c";\n');
		fs.utimesSync(importer, pinned, pinned);
		const after = fs.statSync(importer);
		expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size]);

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/c.ts"]);
	});

	// Recurrence: #4368 r1 row 13. A module moved in with `mv` keeps an inode
	// born before the language server, so the birth rule read it as old and
	// the server never heard Created. The resolver saw the import resolve to
	// nothing, then to the module: the path appeared in between.
	it("notes a path born when an import that resolved to nothing now resolves to it", async () => {
		const root = workspace("pi-lens-4346-fwd-moved-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { m } from "./moved";\n',
			"stash/moved.ts": "export const m = 1;\n",
		});
		const importer = path.join(root, "src/a.ts");
		const moved = path.join(root, "src/moved.ts");
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);
		fs.renameSync(path.join(root, "stash/moved.ts"), moved);
		const inodeBirth = fs.statSync(moved).birthtimeMs;
		// A fast runner creates, renames and resolves within one clock tick, so
		// the appearance time can tie the inode birth and the strict check below
		// cannot tell them apart (#4375 shard 3/5 red). Let the clock pass the
		// inode birth first; no timer, only event-loop turns, bounded in case
		// the filesystem clock runs ahead of Date.now().
		for (let turn = 0; turn < 100_000 && Date.now() <= inodeBirth; turn++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		const resolvedAt = Date.now();

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/moved.ts"]);

		const birth = pathBirthtimeMs(fs.statSync(moved), moved);
		expect(birth).toBeGreaterThanOrEqual(resolvedAt);
		expect(birth).toBeGreaterThan(inodeBirth);
	});

	// The importer's own edit between the two calls is a new parse; the
	// sources it saw unresolved must survive it, or a module moved in while
	// the importer was being edited stays announced as Changed.
	it("keeps the unresolved observation across an edit of the importer", async () => {
		const root = workspace("pi-lens-4346-fwd-moved-edit-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { m } from "./moved";\n',
			"stash/moved.ts": "export const m = 1;\n",
		});
		const importer = path.join(root, "src/a.ts");
		const moved = path.join(root, "src/moved.ts");
		expect(await extractForwardImportPaths(root, importer)).toEqual([]);
		fs.writeFileSync(
			importer,
			'import { m } from "./moved";\nexport const n = m;\n',
		);
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(importer, later, later);
		fs.renameSync(path.join(root, "stash/moved.ts"), moved);
		const resolvedAt = Date.now();

		expect(
			relative(root, await extractForwardImportPaths(root, importer)),
		).toEqual(["src/moved.ts"]);
		expect(pathBirthtimeMs(fs.statSync(moved), moved)).toBeGreaterThanOrEqual(
			resolvedAt,
		);
	});

	it("notes no birth for an import that resolved at every call", async () => {
		const root = workspace("pi-lens-4346-fwd-steady-", {
			"package.json": '{"name":"g","version":"0.0.0"}\n',
			"src/a.ts": 'import { b } from "./b";\n',
			"src/b.ts": "export const b = 1;\n",
		});
		const importer = path.join(root, "src/a.ts");
		const module = path.join(root, "src/b.ts");
		await extractForwardImportPaths(root, importer);
		await extractForwardImportPaths(root, importer);

		expect(pathBirthtimeMs(fs.statSync(module), module)).toBe(
			fs.statSync(module).birthtimeMs,
		);
	});
});
