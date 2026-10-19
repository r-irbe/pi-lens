/**
 * #3748 item 1, the pi host ADAPTER: `index.ts`'s `context` handler drains the
 * agent advisory queue for the scope its own activation serves.
 *
 * The recurrence this prevents: `consumeAgentNudge(dbg)` passing no scope. The
 * queue is drained per scope (`tests/clients/agent-advisory-scope.test.ts`),
 * so that call would silently stop delivering the primary's own advisory, such
 * as the #3741 fix-run loss notice, while every unit test stayed green.
 *
 * Real: the extension, its host-mock `session_start` and `context` handlers,
 * and the `RuntimeCoordinator` `index.ts` owns, reached by observing the
 * `resetForSession` its session start performs. Nothing is faked.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueAgentAdvisory } from "../clients/agent-nudge.js";
import { RuntimeCoordinator } from "../clients/runtime-coordinator.js";
import extension from "../index.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3748-advisory-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	removeTempDirSync(tmpDir);
});

describe("pi context delivers the primary's own queued advisory (#3748)", () => {
	it("injects an advisory queued under the activation's session scope", async () => {
		const runtimes: RuntimeCoordinator[] = [];
		const resetForSession = RuntimeCoordinator.prototype.resetForSession;
		vi.spyOn(
			RuntimeCoordinator.prototype,
			"resetForSession",
		).mockImplementation(function (this: RuntimeCoordinator, ...args) {
			runtimes.push(this);
			return resetForSession.apply(this, args);
		});
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		);
		const runtime = runtimes[0];
		expect(runtime).toBeDefined();
		queueAgentAdvisory("lost edit in a.rs", runtime.captureSessionGeneration());

		const injected = (await pi.emit(
			"context",
			{ messages: [{ role: "user", content: "keep working" }] },
			makeCtx({ cwd: tmpDir, sessionId: "pi-3748-advisory-session" }),
		)) as { messages?: Array<{ content: string }> } | undefined;

		expect(
			(injected?.messages ?? []).map((m) => m.content).join("\n"),
		).toContain("lost edit in a.rs");
	});
});
