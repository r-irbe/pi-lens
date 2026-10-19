#!/usr/bin/env node
// Driver for the verify-pi-lens skill (see ../SKILL.md). Linux only: the pid
// tracking reads /proc, which macOS and Windows lack.
//
//   verify.mjs doctor  [--tree <dir>]
//   verify.mjs drive   <scenario> [variant] [--tree <dir>]
//   verify.mjs cleanup [--run <dir>] [--trees]
//     (no --run: sweep every run dir under $VERIFY_ROOT/runs)
//
// Run it with env.sh sourced: every path it writes comes from RUN and EVIDENCE.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpStdioClient } from "../../../../scripts/lib/mcp-stdio-client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function die(message) {
	console.error(`verify-pi-lens: ${message}`);
	process.exit(2);
}

if (!fs.existsSync("/proc/self/stat")) {
	console.error("verify-pi-lens: Linux only (pid tracking reads /proc)");
	process.exit(2);
}

function pinnedEnv() {
	const { RUN, EVIDENCE, VERIFY_ROOT, TMPDIR } = process.env;
	if (!RUN || !EVIDENCE || !VERIFY_ROOT || !TMPDIR) {
		die("source scripts/env.sh first (RUN, EVIDENCE, VERIFY_ROOT unset)");
	}
	if (!process.env.HOME?.startsWith(RUN)) die("HOME is not pinned under RUN");
	return { RUN, EVIDENCE, VERIFY_ROOT, TMPDIR };
}

// ---- process tracking: the servers a run spawns, and only those ----------

function readStat(pid) {
	try {
		const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// comm may hold spaces and parens; the fields after the last ")" are fixed.
		const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
		return { ppid: Number(rest[1]), start: rest[19] };
	} catch {
		return undefined;
	}
}

function descendants(rootPid) {
	const children = new Map();
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const st = readStat(entry);
		if (!st) continue;
		const list = children.get(st.ppid) ?? [];
		list.push(Number(entry));
		children.set(st.ppid, list);
	}
	const found = [];
	const stack = [rootPid];
	while (stack.length) {
		const pid = stack.pop();
		found.push(pid);
		stack.push(...(children.get(pid) ?? []));
	}
	return found;
}

/** Remember {pid, start} so cleanup never signals a reused pid. */
function recordPids(runDir, rootPid) {
	const file = path.join(runDir, "pids.json");
	let known = [];
	try {
		known = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		// first record
	}
	for (const pid of descendants(rootPid)) {
		const st = readStat(pid);
		if (st && !known.some((k) => k.pid === pid && k.start === st.start)) {
			known.push({ pid, start: st.start });
		}
	}
	fs.writeFileSync(file, JSON.stringify(known));
}

async function killRecorded(runDir) {
	let known = [];
	try {
		known = JSON.parse(fs.readFileSync(path.join(runDir, "pids.json"), "utf8"));
	} catch {
		return [];
	}
	const live = () =>
		known.filter((k) => readStat(k.pid)?.start === k.start).map((k) => k.pid);
	const killed = live();
	for (const sig of ["SIGTERM", "SIGKILL"]) {
		for (const pid of live()) {
			try {
				process.kill(pid, sig);
			} catch {
				// already gone
			}
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return killed;
}

// ---- cleanup --------------------------------------------------------------

async function cleanup(runDir) {
	const { EVIDENCE, VERIFY_ROOT } = pinnedEnv();
	const runs = path.join(VERIFY_ROOT, "runs");
	// A fresh `. env.sh` mints a new RUN id, so the default sweeps every run dir:
	// a dead earlier run's recorded pids are found there, not under this shell's RUN.
	const targets = runDir
		? [path.resolve(runDir)]
		: fs.existsSync(runs)
			? fs.readdirSync(runs).map((name) => path.join(runs, name))
			: [];
	for (const target of targets) {
		if (path.dirname(target) !== runs)
			die(`${target} is not a run dir under ${runs}`);
		const killed = await killRecorded(target);
		// Evidence is a sibling tree, never under the run dir, so this cannot reach it.
		fs.rmSync(target, { recursive: true, force: true });
		if (killed.length)
			console.log(`cleanup: killed [${killed.join(", ")}] from ${target}`);
	}
	console.log(
		`cleanup: removed ${targets.length} run dir(s), kept ${path.dirname(EVIDENCE)}`,
	);
}

/** `cleanup --trees`: drop the built trees `setup.sh tree` made. */
function removeTrees() {
	const trees = path.join(process.env.VERIFY_ROOT, "trees");
	if (!fs.existsSync(trees)) return;
	for (const entry of fs.readdirSync(trees, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		// Unlink the shared node_modules link first: never recurse through it.
		const link = path.join(trees, entry.name, "node_modules");
		if (fs.lstatSync(link, { throws: false })?.isSymbolicLink())
			fs.unlinkSync(link);
		fs.rmSync(path.join(trees, entry.name), { recursive: true, force: true });
	}
	fs.rmSync(trees, { recursive: true, force: true });
	console.log(`cleanup: removed built trees under ${trees}`);
}

// ---- MCP client -----------------------------------------------------------

function launchServer({ tree, ws, runDir, wirePath }) {
	const wire = fs.createWriteStream(wirePath, { flags: "a" });
	const client = new McpStdioClient(
		path.join(tree, "mcp/server.js"),
		// A host launches the server inside the project; so do we.
		ws,
		{ ...process.env },
		{
			args: [`--cwd=${ws}`],
			onFrame: (dir, msg) =>
				wire.write(`${JSON.stringify({ t: Date.now(), dir, msg })}\n`),
		},
	);
	return {
		child: client.child,
		request: (method, params) => client.request(method, params, 60_000),
		async initialize() {
			const init = await client.request(
				"initialize",
				{
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "verify-pi-lens", version: "1" },
				},
				60_000,
			);
			if (init.error) throw new Error(`initialize: ${init.error.message}`);
			client.notify("notifications/initialized");
			recordPids(runDir, client.child.pid);
		},
		async call(name, args) {
			const started = performance.now();
			const res = await client.request("tools/call", {
				name,
				arguments: args,
			});
			const ms = Math.round(performance.now() - started);
			recordPids(runDir, client.child.pid);
			return {
				ms,
				error: res.error,
				result: res.result,
				blocks: (res.result?.content ?? []).map((c) => c.text ?? ""),
				text: res.result?.content?.map((c) => c.text ?? "").join("\n") ?? "",
			};
		},
		async stop() {
			// Graceful first: ending stdin runs the server's shutdown handler (its
			// telemetry record, the log flush, the IPC socket unlink). SIGTERM, the
			// shared client's close(), bypasses all three; it is only the fallback.
			client.child.stdin.end();
			await Promise.race([
				client.exited,
				new Promise((resolve) => setTimeout(resolve, 5000)),
			]);
			await client.close();
			wire.end();
		},
	};
}

// ---- doctor ---------------------------------------------------------------

async function doctor(tree) {
	const { RUN, EVIDENCE, VERIFY_ROOT } = pinnedEnv();
	const rows = [];
	const check = (name, ok, detail) => {
		rows.push({ name, ok, detail });
		console.log(
			`${ok ? "OK  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`,
		);
	};
	check(
		"env pinned",
		process.env.PI_LENS_HOME?.startsWith(RUN),
		process.env.PI_LENS_HOME,
	);
	const built = fs.existsSync(path.join(tree, "mcp/server.js"));
	check("tree built", built, tree);
	if (built) {
		// Twins older than their source mean the tree under test is not the source.
		const stale = [];
		for (const dir of ["clients", "tools", "mcp"]) {
			for (const entry of fs.readdirSync(path.join(tree, dir), {
				recursive: true,
			})) {
				if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
				const src = path.join(tree, dir, entry);
				const twin = src.replace(/\.ts$/, ".js");
				if (
					!fs.existsSync(twin) ||
					fs.statSync(twin).mtimeMs < fs.statSync(src).mtimeMs
				) {
					stale.push(path.relative(tree, src));
				}
			}
		}
		check(
			"twins fresh (npm run build)",
			stale.length === 0,
			stale.slice(0, 3).join(", "),
		);
	}
	const pyrefly = path.join(VERIFY_ROOT, "py-venv/bin/pyrefly");
	check("pyrefly venv (setup.sh pyrefly)", fs.existsSync(pyrefly), pyrefly);
	if (built) {
		const ws = path.join(RUN, "doctor-ws");
		fs.mkdirSync(ws, { recursive: true });
		fs.writeFileSync(
			path.join(ws, "package.json"),
			'{"name":"doctor","version":"0.0.0"}',
		);
		const server = launchServer({
			tree,
			ws,
			runDir: RUN,
			wirePath: path.join(EVIDENCE, "doctor-wire.jsonl"),
		});
		try {
			await server.initialize();
			const tools = await server.request("tools/list", {});
			const names = (tools.result?.tools ?? []).map((t) => t.name);
			const want = [
				"pilens_diagnostics",
				"pilens_lsp_navigation",
				"pilens_module_report",
			];
			check(
				"tools/list serves the driven tools",
				want.every((n) => names.includes(n)),
				`${names.length} tools`,
			);
			// Alive is not usable: the health report names a wasm abort or broken server.
			const health = await server.call("pilens_health", {});
			fs.writeFileSync(path.join(EVIDENCE, "doctor-health.txt"), health.text);
			check(
				"pilens_health answers",
				!health.error && health.text.length > 0,
				health.text.split("\n")[0],
			);
			const json = /```json\n([\s\S]*?)\n```/.exec(health.text)?.[1];
			const report = json ? JSON.parse(json) : {};
			check(
				"tree-sitter available",
				report.treeSitter?.available === true &&
					report.treeSitter?.wasmAborted === false,
			);
			check(
				"no degradations or broken servers",
				(report.degradations ?? []).length === 0 &&
					(report.brokenServers ?? []).length === 0,
				JSON.stringify(report.degradations ?? "no report"),
			);
		} catch (err) {
			check("MCP handshake", false, String(err));
		} finally {
			await server.stop();
			await killRecorded(RUN);
		}
	}
	const failed = rows.filter((r) => !r.ok).length;
	console.log(`doctor: ${rows.length - failed}/${rows.length} ok`);
	process.exit(failed ? 1 : 0);
}

// ---- drive ----------------------------------------------------------------

async function drive(scenarioName, variant, tree) {
	const { RUN, EVIDENCE } = pinnedEnv();
	const mod = await import(
		pathToFileURL(path.join(here, "scenarios", `${scenarioName}.mjs`)).href
	);
	if (variant && !mod.variants.includes(variant)) {
		die(`${scenarioName} variants: ${mod.variants.join(", ")}`);
	}
	variant ??= mod.variants[0];
	// Everything a drive writes is keyed by its own id, never by the shell's RUN
	// id: a re-sourced env.sh reuses RUN, and an append-only wire log shared by
	// two drives let the unfixed tree pass on the fixed tree's events (#4366 F1).
	const driveId = `${scenarioName}-${variant}-${new Date()
		.toISOString()
		.replace(/\D/g, "")
		.slice(0, 14)}-${process.pid}`;
	const ws = path.join(RUN, `ws-${driveId}`);
	fs.mkdirSync(ws, { recursive: true });
	const evidenceDir = path.join(EVIDENCE, driveId);
	fs.mkdirSync(evidenceDir, { recursive: true });
	// A fresh pi-lens home per drive: a persisted cache from an earlier drive
	// must not answer this one.
	const piHome = path.join(RUN, `pi-home-${driveId}`);
	fs.rmSync(piHome, { recursive: true, force: true });
	process.env.PI_LENS_HOME = piHome;
	process.env.PILENS_DATA_DIR = path.join(piHome, "data");
	// The Pyrefly tee reads these; harmless for scenarios that never start it.
	process.env.VERIFY_LSP_WIRE = path.join(evidenceDir, "lsp-wire");
	process.env.VERIFY_PYREFLY = path.join(
		process.env.VERIFY_ROOT,
		"py-venv/bin/pyrefly",
	);

	const steps = [];
	const expectations = [];
	const ctx = {
		ws,
		tree,
		variant,
		evidenceDir,
		scripts: here,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		write(rel, content) {
			fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
			fs.writeFileSync(path.join(ws, rel), content);
		},
		exists: (rel) => fs.existsSync(path.join(ws, rel)),
		read: (rel) => fs.readFileSync(path.join(ws, rel), "utf8"),
		importTree: (rel) => import(pathToFileURL(path.join(tree, rel)).href),
		/** Lines of the LSP client-to-server wire that match a pattern. */
		lspWire: (re) =>
			fs.existsSync(`${process.env.VERIFY_LSP_WIRE}.in`)
				? fs
						.readFileSync(`${process.env.VERIFY_LSP_WIRE}.in`, "utf8")
						.split("\n")
						.filter((l) => re.test(l))
				: [],
		record(label, data) {
			steps.push({ label, ...data });
			console.log(
				`--- ${label}${data.ms === undefined ? "" : ` (${data.ms} ms)`}`,
			);
		},
		expect(name, ok, detail = "") {
			expectations.push({ name, ok: Boolean(ok), detail });
			console.log(
				`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`,
			);
		},
		/** A residual an open issue owns: a miss is KNOWN, never a failed verdict; a hit is XPASS (close the issue). */
		expectKnown(name, ok, issue, detail = "") {
			expectations.push({
				name,
				ok: true,
				known: issue,
				observed: Boolean(ok),
				detail,
			});
			console.log(
				`${ok ? "XPASS" : "KNOWN"} ${name} (${issue})${detail ? `: ${detail}` : ""}`,
			);
		},
	};
	let server;
	await mod.setup(ctx, variant);
	if (!mod.inProcess?.includes(variant)) {
		server = launchServer({
			tree,
			ws,
			runDir: RUN,
			wirePath: path.join(evidenceDir, "mcp-wire.jsonl"),
		});
		await server.initialize();
		ctx.call = async (tool, args, label) => {
			const out = await server.call(tool, { cwd: ws, ...args });
			ctx.record(label ?? tool, {
				tool,
				args,
				ms: out.ms,
				text: out.text,
				raw: out.result,
			});
			// The structured payload some tools lead with (the first line that is a JSON object).
			out.json = out.text
				.split("\n")
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return undefined;
					}
				})
				.find((v) => v && typeof v === "object");
			if (out.error) throw new Error(`${tool}: ${JSON.stringify(out.error)}`);
			return out;
		};
	}
	let crashed;
	try {
		await mod.run(ctx, variant);
	} catch (err) {
		crashed = err;
		ctx.expect("scenario ran to the end", false, String(err?.stack ?? err));
	} finally {
		await server?.stop();
		// Logs the run wrote, so a verdict can be checked against the records.
		if (fs.existsSync(piHome))
			fs.cpSync(piHome, path.join(evidenceDir, "pi-lens-home"), {
				recursive: true,
			});
		const failed = expectations.filter((e) => !e.ok);
		const known = expectations.filter((e) => e.known).length;
		const passed = expectations.length - failed.length - known;
		fs.writeFileSync(
			path.join(evidenceDir, "steps.json"),
			JSON.stringify(steps, null, 2),
		);
		fs.writeFileSync(
			path.join(evidenceDir, "summary.json"),
			JSON.stringify(
				{
					scenario: scenarioName,
					variant,
					tree,
					passed,
					failed: failed.length,
					known,
					expectations,
				},
				null,
				2,
			),
		);
		// Only what this run spawned; `cleanup` removes the run dir itself.
		await killRecorded(RUN);
		fs.rmSync(ws, { recursive: true, force: true });
		fs.rmSync(piHome, { recursive: true, force: true });
		console.log(
			`verdict: ${scenarioName}/${variant} ${failed.length ? "FAIL" : "PASS"} (${passed}/${expectations.length - known}${known ? `, ${known} KNOWN` : ""}); evidence ${evidenceDir}`,
		);
		process.exitCode = failed.length || crashed ? 1 : 0;
	}
}

// ---- main -----------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest.splice(i, 2)[1] : undefined;
};
const tree = path.resolve(flag("--tree") ?? process.cwd());
const runFlag = flag("--run");
if (cmd === "doctor") await doctor(tree);
else if (cmd === "drive") {
	if (!rest[0]) die("drive needs a scenario name");
	await drive(rest[0], rest[1], tree);
} else if (cmd === "cleanup") {
	await cleanup(runFlag);
	if (process.argv.includes("--trees")) removeTrees();
} else die("usage: verify.mjs doctor | drive <scenario> [variant] | cleanup");
// An in-process scenario can leave timers (graph persist debounce) behind.
process.exit(process.exitCode ?? 0);
