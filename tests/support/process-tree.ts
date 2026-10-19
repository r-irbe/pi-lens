import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { adoptProcessTree } from "./kill-guard.js";

/** Walks of a still-growing tree before the kill goes ahead (each ≤ 1 s). */
const MAX_WALKS = 4;
const PS_TIMEOUT_MS = 1_000;

/**
 * SIGKILL a spawned child AND everything below it (#4081).
 *
 * `child.kill("SIGKILL")` reaches only the direct child. The real pi leaves
 * grandchildren behind (knip, `npx ast-grep scan`, typescript-language-server
 * --version), and they are not even in its process group: pi's launcher
 * spawns them detached, so each is the leader of its own group. They are
 * reparented and keep writing under the scratch HOME for up to ~1.5 s, which
 * is what turned a recursive teardown into ENOTEMPTY. A group kill of the
 * child's group would not reach them, so the tree is walked by parent pid.
 *
 * Returns the pids signalled (the child first), for a caller that must wait
 * until they are gone. An already-reaped child returns [] and signals nothing:
 * its pid may have been recycled, and its children are no longer discoverable.
 *
 * POSIX: freeze (SIGSTOP) the child and every descendant `ps` lists, re-walk
 * until no new descendant appears (at most {@link MAX_WALKS} walks), then
 * SIGKILL every frozen pid.
 * Windows: `taskkill /T /F`, the same tree kill the production seam uses.
 */
export function killProcessTree(child: {
	pid?: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
}): number[] {
	const root = child.pid;
	if (
		root === undefined ||
		child.exitCode !== null ||
		child.signalCode !== null
	)
		return [];
	if (process.platform === "win32") {
		const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
		spawnSync(taskkill, ["/PID", String(root), "/T", "/F"], {
			shell: false,
			windowsHide: true,
			stdio: "ignore",
		});
		return [root];
	}
	// Freeze, re-walk, then kill (#4082 r3). Each walk SIGSTOPs every pid it
	// newly lists; a frozen process can neither fork nor exit on its own, so
	// its children stay its children and the next walk lists what it forked
	// after the previous snapshot. Re-walking after a SIGKILL would find
	// nothing: a dead parent's children are reparented at its exit. Every pid
	// is adopted into the kill guard before its first signal, because after
	// one its ancestry is gone (a self-exiting mid process reparents too).
	// Known limit: a process reparented before the first walk (its parent
	// exited earlier on its own) is not listed; the callers' bounded wait and
	// removal absorb its writes.
	const frozen = new Set<number>();
	for (let walk = 0; walk < MAX_WALKS; walk++) {
		const fresh = [root, ...descendantsOf(root)].filter(
			(pid) => !frozen.has(pid),
		);
		if (fresh.length === 0) break;
		adoptProcessTree(root, fresh);
		for (const pid of fresh) {
			signal(pid, "SIGSTOP");
			frozen.add(pid);
		}
	}
	for (const pid of frozen) signal(pid, "SIGKILL");
	return [...frozen];
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// ESRCH: already gone. EPERM: not ours to signal.
	}
}

/** Every pid below `root`, from one `ps` snapshot (empty when `ps` is absent). */
function descendantsOf(root: number): number[] {
	const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
		encoding: "utf8",
		timeout: PS_TIMEOUT_MS,
	});
	if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
	const children = new Map<number, number[]>();
	for (const line of ps.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const parent = Number(match[2]);
		children.set(parent, [...(children.get(parent) ?? []), Number(match[1])]);
	}
	const out: number[] = [];
	for (const queue = [root]; queue.length > 0;) {
		for (const pid of children.get(queue.pop() as number) ?? []) {
			out.push(pid);
			queue.push(pid);
		}
	}
	return out;
}

/**
 * Whether `pid` still exists and is not a zombie (or being reaped). A zombie holds no file
 * handles and is only waiting for its (reparented) parent to reap it, so it
 * cannot write under a directory being removed.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
	try {
		// Z: a zombie; X: being reaped right now (#4082 r3: a poll that saw Z,
		// then X, read the process as alive again).
		return !/^\d+ \(.*\) [ZX] /s.test(
			readFileSync(`/proc/${pid}/stat`, "utf8"),
		);
	} catch {
		// Linux: the zombie that answered `kill(pid, 0)` was reaped before its
		// `/proc` entry was read (#4082 r3: a poll then saw it "alive" again).
		// Elsewhere there is no `/proc`, and `kill(pid, 0)` is the evidence.
		return process.platform !== "linux";
	}
}
