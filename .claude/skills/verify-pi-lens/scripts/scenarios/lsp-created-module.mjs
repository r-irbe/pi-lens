// #4320: a module created after Pyrefly started must clear the importer's
// missing-import without a restart. Variants are the probe shapes the #4344
// reviews found:
//   issue          module listed first in one call (the reporter's steps)
//   importer-first the importer is listed BEFORE the new module
//   importer-only  module created on disk, never opened by pi-lens (known
//                  residual, #4346: expected to stay stale until fixed)
//   replay         an unrelated edit must not drop the cached findings
import { spawnSync } from "node:child_process";
import path from "node:path";

export const variants = ["issue", "importer-first", "importer-only", "replay"];

const MODULE = "src/fixturepkg/new_module.py";
const IMPORTER = "tools/probe.py";
const BAD = "tools/bad.py";
const MISSING = /Cannot find module `fixturepkg\.new_module`/;

export async function setup(ctx) {
	const python = spawnSync(
		"python3",
		["-c", "import sys;print(sys.executable)"],
		{ encoding: "utf8" },
	).stdout.trim();
	ctx.write(
		"pyproject.toml",
		`[project]\nname="x"\nversion="0.0.0"\n[tool.pyrefly]\nsearch-path=["src"]\npython-interpreter-path="${python}"\n`,
	);
	ctx.write("src/fixturepkg/__init__.py", "");
	ctx.write(
		IMPORTER,
		"from fixturepkg.new_module import describe_source\n\nvalue: str = describe_source()\n",
	);
	// A genuinely missing module: it must keep reporting in every step.
	ctx.write(BAD, "from fixturepkg.never_exists import nothing\n");
	ctx.write("src/fixturepkg/old.py", "def keep() -> int:\n    return 1\n");
	ctx.write(
		".pi-lens/lsp.json",
		JSON.stringify({
			servers: {
				pyrefly: {
					name: "Pyrefly",
					extensions: [".py", ".pyi"],
					command: path.join(ctx.scripts, "pyrefly-tee.sh"),
					args: ["lsp"],
					rootMarkers: ["pyproject.toml"],
				},
			},
			disabledServers: ["python", "python-jedi"],
		}),
	);
}

const check = (ctx, paths, label) =>
	ctx.call(
		"pilens_diagnostics",
		{
			source: "lsp",
			scope: "paths",
			paths,
			serverScope: "primary",
			waitMs: 3000,
			severity: "all",
		},
		label,
	);

export async function run(ctx, variant) {
	const created = "def describe_source() -> str:\n    return 'synthetic'\n";
	if (variant === "replay") return replay(ctx);

	const first = await check(ctx, [IMPORTER, BAD], "before: importer + bad");
	ctx.expect(
		"before: the importer reports the missing module",
		MISSING.test(first.text),
	);
	ctx.expect(
		"before: bad.py reports its missing module",
		/never_exists/.test(first.text),
	);

	ctx.write(MODULE, created);
	ctx.expect("file state: the module exists on disk", ctx.exists(MODULE));

	if (variant === "importer-only") {
		const after = await check(ctx, [IMPORTER], "after: importer only");
		// #4346: the importer's own imports name the module, so the call
		// announces it as Created before it answers.
		ctx.expect(
			"importer-only: the importer is clean",
			!MISSING.test(after.text),
		);
		return;
	}
	const order =
		variant === "issue" ? [MODULE, IMPORTER, BAD] : [IMPORTER, MODULE, BAD];
	const after = await check(ctx, order, `after: ${variant} order`);
	ctx.expect(
		`${variant}: the importer no longer reports the missing module`,
		!MISSING.test(after.text),
		after.text.split("\n").find((l) => MISSING.test(l)) ?? "",
	);
	ctx.expect(
		`${variant}: bad.py still reports its genuinely missing module`,
		/never_exists/.test(after.text),
	);
	const created1 = ctx
		.lspWire(/didChangeWatchedFiles/)
		.filter((l) => l.includes("new_module.py") && /"type":1\b/.test(l));
	ctx.expect(
		`${variant}: the wire carries a Created (type 1) for new_module.py`,
		created1.length >= 1,
		`${created1.length} event(s)`,
	);
}

async function replay(ctx) {
	const paths = [IMPORTER, BAD];
	const cold = await check(ctx, paths, "cold scan");
	const warm = await check(ctx, paths, "replay, nothing changed");
	// Edit an unrelated existing file in place (pi's own write/edit keep the birth time).
	ctx.write("src/fixturepkg/old.py", "def keep() -> int:\n    return 2\n");
	await check(ctx, ["src/fixturepkg/old.py"], "open the edited unrelated file");
	const after = await check(ctx, paths, "replay after an unrelated edit");
	ctx.expect(
		"replay answers are unchanged",
		cold.text
			.split("\n")
			.filter((l) => /missing-import/.test(l))
			.join() ===
			after.text
				.split("\n")
				.filter((l) => /missing-import/.test(l))
				.join(),
	);
	// A spurious Created drops every finding-bearing entry and costs a rescan
	// (measured on #4344: 6 ms replay vs 321 ms after the drop).
	ctx.expect(
		"replay after an unrelated edit stays a cache replay",
		after.ms <= Math.max(warm.ms * 5, 150),
		`replay ${warm.ms} ms, after edit ${after.ms} ms`,
	);
	const spurious = ctx
		.lspWire(/didChangeWatchedFiles/)
		.filter((l) => l.includes("old.py") && /"type":1\b/.test(l));
	ctx.expect(
		"the in-place edit is announced Changed, not Created",
		spurious.length === 0,
		`${spurious.length} Created event(s) for old.py`,
	);
}
