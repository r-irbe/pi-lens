// A newline-delimited JSON-RPC client for the pi-lens MCP stdio server.
//
// Shared by scripts/release-qa.mjs (release-readiness rows) and the
// verify-pi-lens skill driver (.claude/skills/verify-pi-lens/scripts/verify.mjs).
// `tests/mcp/harness.ts` is the third sibling and stays separate: it is
// TypeScript coupled to vitest isolation dirs, which a plain node script cannot
// import.
//
// `request` never rejects: a timeout, a write failure and a server exit all
// resolve `{ error: { message } }`, so a caller can never read a missing answer
// as a pass.
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 180_000;

export class McpStdioClient {
	/**
	 * @param {string} serverJs absolute path of the built mcp/server.js
	 * @param {string} cwd the project the server runs inside
	 * @param {NodeJS.ProcessEnv} env
	 * @param {{ args?: string[], onFrame?: (dir: "send" | "recv" | "stderr", text: string) => void }} [options]
	 *   `onFrame` sees every frame sent, received, and every stderr chunk.
	 */
	constructor(serverJs, cwd, env, options = {}) {
		this.onFrame = options.onFrame;
		this.child = spawn(process.execPath, [serverJs, ...(options.args ?? [])], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = [];
		this.buf = "";
		this.child.stderr.on("data", (chunk) => {
			this.stderr.push(chunk.toString());
			this.onFrame?.("stderr", chunk.toString());
		});
		// A string decoder, not chunk.toString(): a multi-byte character split
		// across two chunks must not decode to U+FFFD.
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => {
			this.buf += chunk;
			let i = this.buf.indexOf("\n");
			while (i >= 0) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				i = this.buf.indexOf("\n");
				if (!line) continue;
				this.onFrame?.("recv", line);
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
			}
		});
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code) => {
				for (const [, waiter] of this.pending) {
					waiter.resolve({ error: { message: `server exited (${code})` } });
				}
				this.pending.clear();
				resolve(code);
			});
		});
	}

	write(message) {
		const line = JSON.stringify(message);
		this.onFrame?.("send", line);
		this.child.stdin.write(`${line}\n`);
	}

	request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ error: { message: `timeout after ${timeoutMs}ms` } });
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: { message: `write failed: ${err?.message || err}` } });
			}
		});
	}

	notify(method, params) {
		try {
			this.write({ jsonrpc: "2.0", method, params });
		} catch {}
	}

	/** The first text block of a tools/call result, or an error marker. */
	async callToolText(name, args, timeoutMs) {
		const response = await this.request(
			"tools/call",
			{ name, arguments: args },
			timeoutMs,
		);
		if (response.error) {
			return { ok: false, text: `JSON-RPC error: ${response.error.message}` };
		}
		const text = response.result?.content?.[0]?.text ?? "";
		return { ok: response.result?.isError !== true, text: String(text) };
	}

	async close() {
		try {
			this.child.kill("SIGTERM");
		} catch {}
		await Promise.race([
			this.exited,
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
		try {
			this.child.kill("SIGKILL");
		} catch {}
	}
}
