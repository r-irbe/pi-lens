#!/usr/bin/env node
/**
 * One latency sample of the pi-lens hot paths (#4363), in a fresh process.
 *
 *   node scripts/hot-path-sample.mjs --tree <built-checkout> --scratch <dir>
 *
 * Prints one JSON line of wall-clock milliseconds, one key per metric below.
 * `scripts/check-hot-path-latency.mjs` runs it N times against the PR head and
 * N times against the base tree, interleaved, and decides.
 *
 * Every number comes from a production entry point of `--tree`, built with
 * `npm run build` (the compiled twins next to the sources):
 *
 *   extension_load   `import("<tree>/index.js")` plus the default-export
 *                    factory against a recording host.
 *   session_start    the registered `session_start` handler, awaited.
 *   dispatch_small /
 *   dispatch_large   `dispatchLint` (clients/dispatch/integration.js), the
 *                    entry `tool_result` uses, on a 42-line and a 4002-line
 *                    TypeScript fixture (whole six-line functions, so the
 *                    file parses). Small is the process's first
 *                    dispatch (grammar and rule loading included), large the
 *                    second, on a file the process has not seen. The `lsp`
 *                    runner is off (`no-lsp`) and tool installs are disabled
 *                    (`PI_LENS_DISABLE_TOOL_INSTALL`), so the runners left are
 *                    the in-process ones; a language server's or a
 *                    downloader's time is not pi-lens's and not repeatable.
 *   replay_small /
 *   replay_large     the workspace-diagnostics cache replay (#4344): a fresh
 *                    `createWorkspaceDiagnosticsCacheContext` loading a
 *                    persisted cache of 200 / 2000 entries, then one `lookup`
 *                    per file.
 *
 * Fixtures are generated deterministically here, so base and head see the
 * same bytes. The host is a recording stub: it is the one boundary a script
 * cannot run for real (no model, no pi UI).
 *
 * Scope: this times pi-lens's own code on these paths. A language server's
 * time (the 624 ms Pyrefly re-touch #4344 measured) is not in it; the replay
 * metric sees the cache half of that regression only.
 *
 * `PI_LENS_HOME` and `PILENS_DATA_DIR` are pinned under `--scratch` before the
 * first import, so nothing reaches the real home.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SMALL_LINES = 40;
const LARGE_LINES = 4000;
const REPLAY_SMALL = 200;
const REPLAY_LARGE = 2000;

/**
 * Deterministic TypeScript of at least `lines` lines: whole six-line functions
 * with a few branches, so the file is valid and every runner parses it.
 */
function fixtureSource(lines) {
	const out = [];
	let n = 0;
	while (out.length < lines) {
		out.push(
			`export function f${n}(a: number, b: string): string {`,
			`\tif (a > ${n}) {`,
			`\t\treturn b + String(a * ${n});`,
			"\t}",
			"\treturn b;",
			"}",
		);
		n++;
	}
	return `${out.join("\n")}\n`;
}

/** A recording stand-in for pi's ExtensionAPI: the host boundary. */
function makeHost() {
	const handlers = new Map();
	const flags = new Map();
	const pi = {
		registerFlag: (name, o) => flags.set(name, o?.default),
		registerCommand: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getFlag: (name) => flags.get(name),
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	return { pi, handlers, flags };
}

function makeCtx(cwd) {
	const manager = {
		getSessionId: () => "hot-path-sample",
		getSessionFile: () => undefined,
	};
	return {
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setTitle: () => {},
			theme: {},
		},
		mode: "tui",
		hasUI: true,
		cwd,
		sessionManager: manager,
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		waitForIdle: async () => {},
		isProjectTrusted: () => true,
	};
}

async function timed(fn) {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

function argValue(name) {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? process.argv[at + 1] : undefined;
}

async function sample(tree, scratch) {
	const imp = (rel) => import(pathToFileURL(path.join(tree, rel)).href);
	const project = path.join(scratch, "project");
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(path.join(project, ".git"), "");
	fs.writeFileSync(
		path.join(project, "package.json"),
		'{"name":"hot-path-fixture","version":"1.0.0","type":"module"}\n',
	);
	const smallFile = path.join(project, "src", "small.ts");
	const largeFile = path.join(project, "src", "large.ts");
	fs.writeFileSync(smallFile, fixtureSource(SMALL_LINES));
	fs.writeFileSync(largeFile, fixtureSource(LARGE_LINES));

	const result = {};
	const { pi, handlers, flags } = makeHost();
	result.extension_load = await timed(async () => {
		const mod = await imp("index.js");
		await mod.default(pi);
	});

	flags.set("no-lsp", false);
	const startHandler = handlers.get("session_start")?.[0];
	if (!startHandler) throw new Error("no session_start handler registered");
	result.session_start = await timed(() =>
		startHandler(
			{ type: "session_start", reason: "startup" },
			makeCtx(project),
		),
	);

	// The `lsp` runner spawns a language server whose time is not pi-lens's.
	flags.set("no-lsp", true);
	const { dispatchLint } = await imp("clients/dispatch/integration.js");
	result.dispatch_small = await timed(() =>
		dispatchLint(smallFile, project, pi),
	);
	result.dispatch_large = await timed(() =>
		dispatchLint(largeFile, project, pi),
	);

	const cache = await imp("clients/lsp/workspace-diagnostics-cache.js");
	for (const [metric, count] of [
		["replay_small", REPLAY_SMALL],
		["replay_large", REPLAY_LARGE],
	]) {
		const dir = path.join(scratch, metric);
		fs.mkdirSync(dir, { recursive: true });
		const files = [];
		for (let i = 0; i < count; i++) {
			const file = path.join(dir, `f${i}.ts`);
			fs.writeFileSync(file, `export const v${i} = ${i};\n`);
			files.push(file);
		}
		const scope = cache.buildScopeKey("all");
		const writer = cache.createWorkspaceDiagnosticsCacheContext(dir);
		for (const [i, file] of files.entries()) {
			const stat = fs.statSync(file);
			// Every fourth entry carries a finding, so the expiry policy runs.
			const diagnostics =
				i % 4 === 0
					? [
							{
								severity: 2,
								message: `unused v${i}`,
								range: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 1 },
								},
								serverId: "typescript",
							},
						]
					: [];
			writer.record(
				file,
				scope,
				diagnostics,
				stat.mtimeMs,
				undefined,
				stat.size,
			);
		}
		writer.persist();
		let served = 0;
		result[metric] = await timed(async () => {
			const reader = cache.createWorkspaceDiagnosticsCacheContext(dir);
			for (const file of files) {
				if (reader.lookup(file, scope)) served++;
			}
		});
		if (served !== count) {
			throw new Error(`${metric}: replay served ${served} of ${count} entries`);
		}
	}
	return result;
}

const tree = argValue("tree");
const scratch = argValue("scratch");
if (!tree || !scratch) {
	console.error("usage: hot-path-sample.mjs --tree <dir> --scratch <dir>");
	process.exit(2);
}
const home = path.join(path.resolve(scratch), "home");
fs.mkdirSync(home, { recursive: true });
process.env.PI_LENS_HOME = home;
process.env.PILENS_DATA_DIR = home;
process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
const result = await sample(path.resolve(tree), path.resolve(scratch));
process.stdout.write(`${JSON.stringify(result)}\n`);
// The extension leaves timers and watchers behind; this process is one sample.
process.exit(0);
