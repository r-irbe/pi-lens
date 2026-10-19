/**
 * #4321: a tab-indented file that the repository's Biome default already
 * formats must come back byte-identical through the real FormatService path.
 *
 * Recurrence this pins: `detectIndentation` returned `{ style: "tab", width: 1 }`
 * and `indentationArgs` forwarded `--indent-width 1`, so Biome (default width 2)
 * joined a call that wraps at 80 columns onto one 85-column line, and the
 * deferred format rewrote a file whose non-writing check had just passed.
 *
 * Nothing is mocked: formatter selection, tool agreement, command resolution
 * and the child process are the production path, and the independent observable
 * is the bytes on disk plus Biome's own non-writing `format` check.
 *
 * The suite needs the pinned `@biomejs/biome` devDependency. When it is absent
 * the suite reports skipped; the top-level guard fails loud in CI (#448).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { FormatService } from "../../clients/format-service.js";
import { clearFormatterRuntimeState } from "../../clients/formatters.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { safeSpawnAsync } from "../../clients/safe-spawn.js";
import { setupTestEnvironment } from "./test-utils.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIOME_BIN = path.join(
	REPO_ROOT,
	"node_modules",
	"@biomejs",
	"biome",
	"bin",
	"biome",
);
const BIOME_PRESENT = fs.existsSync(BIOME_BIN);

// `biome format --write` output at the default width 2: the call wraps because
// the joined `return handleRecord(...)` line is 79 characters plus one tab,
// 81 columns at width 2. At the invented width 1 it is exactly 80 and fits.
const biomeFormatted = [
	"function demo() {",
	"\treturn handleRecord(",
	"\t\trecord,",
	"\t\tcontext,",
	"\t\toptions,",
	"\t\tmetadata,",
	"\t\txxxxxxxxxxxxxxxxxxxxx,",
	"\t);",
	"}",
	"",
].join("\n");

const joined =
	"function demo() {\n\treturn handleRecord(record, context, options, metadata, xxxxxxxxxxxxxxxxxxxxx);\n}\n";

/** Project evidence the tool-agreement seam accepts, with the real binary. */
function writeBiomeProject(root: string): void {
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "node_modules/@biomejs/biome": { version: "2.5.15" } },
		}),
	);
	const bin = path.join(root, "node_modules", ".bin", "biome");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.symlinkSync(BIOME_BIN, bin);
}

async function formatThroughService(filePath: string): Promise<void> {
	const service = new FormatService("format-tab-width", true);
	service.recordRead(filePath);
	const summary = await service.formatFile(filePath);
	expect(summary.formatters).toEqual([
		expect.objectContaining({ name: "biome", success: true }),
	]);
}

/** Biome's own non-writing check; the repository's default must still pass. */
async function biomeCheckPasses(root: string, file: string): Promise<boolean> {
	const result = await safeSpawnAsync(
		path.join(root, "node_modules", ".bin", "biome"),
		["format", file],
		{ cwd: root, timeout: 30_000 },
	);
	return result.status === 0;
}

// Top-level CI guard (#448): outside the conditional describe so a skip cannot
// skip the guard itself.
it("real Biome binary is installed in CI", () => {
	if (process.env.CI) expect(BIOME_PRESENT, `missing ${BIOME_BIN}`).toBe(true);
});

describe.skipIf(!BIOME_PRESENT)(
	"tab width is not inferred from tab counts (#4321)",
	() => {
		beforeEach(() => {
			setProjectTrustState("trusted");
			clearFormatterRuntimeState();
		});

		it("keeps a Biome-formatted tab file near the wrap boundary byte-identical", async () => {
			const env = setupTestEnvironment("pi-lens-format-tab-width-");
			try {
				writeBiomeProject(env.tmpDir);
				const filePath = path.join(env.tmpDir, "demo.ts");
				fs.writeFileSync(filePath, biomeFormatted);
				expect(await biomeCheckPasses(env.tmpDir, filePath)).toBe(true);

				await formatThroughService(filePath);

				expect(fs.readFileSync(filePath, "utf8")).toBe(biomeFormatted);
				expect(await biomeCheckPasses(env.tmpDir, filePath)).toBe(true);
			} finally {
				env.cleanup();
			}
		});

		it("lets an explicit biome.json width win over the formatter default", async () => {
			const env = setupTestEnvironment("pi-lens-format-tab-width-config-");
			try {
				writeBiomeProject(env.tmpDir);
				fs.writeFileSync(
					path.join(env.tmpDir, "biome.json"),
					JSON.stringify({
						formatter: { indentStyle: "tab", indentWidth: 1 },
					}),
				);
				const filePath = path.join(env.tmpDir, "demo.ts");
				fs.writeFileSync(filePath, biomeFormatted);

				await formatThroughService(filePath);

				// The project chose width 1; pi-lens adds no flag of its own, so the
				// configured width is what Biome applied.
				expect(fs.readFileSync(filePath, "utf8")).toBe(joined);
			} finally {
				env.cleanup();
			}
		});

		it("lets an .editorconfig width win over the formatter default", async () => {
			const env = setupTestEnvironment("pi-lens-format-tab-width-ec-");
			try {
				writeBiomeProject(env.tmpDir);
				fs.writeFileSync(
					path.join(env.tmpDir, ".editorconfig"),
					"root = true\n\n[*]\nindent_style = tab\nindent_size = 1\n",
				);
				const filePath = path.join(env.tmpDir, "demo.ts");
				fs.writeFileSync(filePath, biomeFormatted);

				await formatThroughService(filePath);

				expect(fs.readFileSync(filePath, "utf8")).toBe(joined);
			} finally {
				env.cleanup();
			}
		});
	},
);

// flake-shape: real-process-spawn — the real Biome binary's wrapping at the 80-column boundary is the subject; a mocked spawn can only restate the argv the fix chose
