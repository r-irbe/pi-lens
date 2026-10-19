// The format step pi-lens runs after a write: FormatService.formatFile picks the
// formatter for the file kind and rewrites the file in place. In-process on the
// tree's built twins (the hook that calls it is pi's, which the model-driven
// scripts/run-harness.mjs covers); `scripts/smoke-tools.mjs --format` is the
// per-language sweep over the repo fixtures.
//   python-ruff   a mis-formatted python file, ruff from the py-venv
export const variants = ["python-ruff"];
export const inProcess = ["python-ruff"];

import fs from "node:fs";
import path from "node:path";

const FILE = "src/messy.py";
const MESSY =
	"def f():\n    x = {  'a' :1}\n    return  x\n\n\nprint(  f() )\n";
const FORMATTED = 'def f():\n    x = {"a": 1}\n    return x\n\n\nprint(f())\n';

export async function setup(ctx) {
	ctx.write(FILE, MESSY);
	// Without project evidence the agreement gate declines to run ruff.
	ctx.write(
		"pyproject.toml",
		'[project]\nname = "x"\nversion = "0.0.0"\n\n[tool.ruff]\nline-length = 88\n',
	);
	// pi-lens resolves a project-local ruff from <project>/.venv/bin.
	fs.symlinkSync(
		path.join(process.env.VERIFY_ROOT, "py-venv"),
		path.join(ctx.ws, ".venv"),
	);
}

export async function run(ctx) {
	(await ctx.importTree("clients/project-trust.js")).setProjectTrustState(
		"trusted",
	);
	const { getFormatService } = await ctx.importTree(
		"clients/format-service.js",
	);
	const service = getFormatService();
	const abs = path.join(ctx.ws, FILE);
	// recordRead is the read baseline the external-modification guard needs.
	service.recordRead(abs);
	const first = await service.formatFile(abs);
	ctx.record("format the file", { summary: first });
	const ruff = first.formatters.find((f) => f.name === "ruff");
	ctx.expect(
		"ruff was selected and ran",
		ruff?.success === true && ruff.outcome !== "unavailable",
		JSON.stringify(first.formatters),
	);
	ctx.expect("the summary reports a change", first.anyChanged === true);
	ctx.expect(
		"file state: the file holds the formatted text",
		ctx.read(FILE) === FORMATTED,
		JSON.stringify(ctx.read(FILE)),
	);
	service.recordRead(abs);
	const second = await service.formatFile(abs);
	ctx.record("format again", { summary: second });
	ctx.expect(
		"a second pass changes nothing",
		second.anyChanged === false && ctx.read(FILE) === FORMATTED,
	);
}
