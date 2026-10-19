// `node --require` preload for tests/mcp/server.smoke.test.ts (#4081): the
// first process that loads it spawns the detached, reparentable writer the real
// tools' children model (own process group, writing under PI_LENS_HOME), and
// records its pid and home in ORPHAN_WRITER_INFO. Later node processes (the
// server's own children) see the file and do nothing.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const info = process.env.ORPHAN_WRITER_INFO;
if (info && !fs.existsSync(info)) {
	const home = process.env.PI_LENS_HOME;
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	// Bounded on disk (2000 names, rewritten in a cycle) and in time (20 s): a
	// writer that outlives a failed teardown must not fill the disk.
	const writer = `
const fs = require("fs"), p = require("path");
const dir = process.argv[1], end = Date.now() + 20000;
fs.mkdirSync(dir, { recursive: true });
for (let i = 0; Date.now() < end; i++) {
  try { fs.writeFileSync(p.join(dir, "f" + (i % 2000)), "x"); } catch {}
}`;
	const child = spawn(
		process.execPath,
		["-e", writer, path.join(home, "orphan")],
		{ detached: true, stdio: "ignore", env },
	);
	child.unref();
	fs.writeFileSync(info, JSON.stringify({ home, writer: child.pid }));
}
