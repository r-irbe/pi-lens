/**
 * Tests for #3693: Appending context injection to active user prompt to preserve KV cache
 * for local models (llama.cpp / Qwen) and prefix-caching providers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { _resetProcessSingletonsForTests } from "../../clients/process-singletons.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";

const TIMEOUT_MS = 30_000;

let tmpDir: string;

beforeEach(() => {
	_resetProcessSingletonsForTests();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-3693-append-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadContextHandler() {
	vi.resetModules();
	const { default: registerExtension } = await import("../../index.js");
	const mock = createPiMock();
	registerExtension(mock.asExtensionAPI() as any);
	const context = mock.handlers.get("context")?.[0];
	expect(context).toBeTypeOf("function");
	return { context: context!, mock };
}

describe("context injection appends to last user message (#3693)", () => {
	it(
		"appends findings to a string user prompt with delimiter and preserves original message immutability",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Always verify tests." },
				tmpDir,
			);

			const originalUser = { role: "user", content: "Optimize performance" };
			const originalUserSnapshot = JSON.stringify(originalUser);
			const existing = [{ role: "assistant", content: "Ready." }, originalUser];

			const result = (await context(
				{ messages: existing },
				makeCtx({ cwd: tmpDir, sessionId: "sess-1" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(2);
			expect(result.messages[0]).toEqual({
				role: "assistant",
				content: "Ready.",
			});

			const updatedUser = result.messages[1];
			expect(updatedUser.role).toBe("user");
			expect(updatedUser.content).toBe(
				"Optimize performance\n\n[pi-lens automated context — not a user request]\n\nAlways verify tests.",
			);

			// Constraint 1: Never mutate original message object in place
			expect(updatedUser).not.toBe(originalUser);
			expect(JSON.stringify(originalUser)).toBe(originalUserSnapshot);
			expect(originalUser.content).toBe("Optimize performance");
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty string user prompt without creating leading newline",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Guidance text" },
				tmpDir,
			);

			const emptyPrompt = { role: "user", content: "" };
			const existing = [emptyPrompt];

			const result = (await context(
				{ messages: existing },
				makeCtx({ cwd: tmpDir, sessionId: "sess-2" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			const last = result.messages[0];
			expect(last.role).toBe("user");
			expect(typeof last.content).toBe("string");
			expect((last.content as string).startsWith("\n")).toBe(false);
			expect(last.content).toBe(
				"[pi-lens automated context — not a user request]\n\nGuidance text",
			);
			expect(last).not.toBe(emptyPrompt);
			expect(emptyPrompt.content).toBe("");
		},
		TIMEOUT_MS,
	);

	it(
		"handles array content with text and image blocks, preserving existing blocks, order, and immutability",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Follow safety guidelines." },
				tmpDir,
			);

			const imagePart = {
				type: "image",
				data: "base64_data",
				mimeType: "image/png",
			};
			const textPart = { type: "text", text: "Analyze this image" };
			const originalArray = [imagePart, textPart];
			const originalUser = { role: "user", content: originalArray };
			const originalUserSnapshot = JSON.stringify(originalUser);

			const result = (await context(
				{ messages: [originalUser] },
				makeCtx({ cwd: tmpDir, sessionId: "sess-3" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			const last = result.messages[0];
			expect(last.role).toBe("user");
			expect(Array.isArray(last.content)).toBe(true);

			const contentBlocks = last.content as Array<{
				type: string;
				[key: string]: unknown;
			}>;
			expect(contentBlocks).toHaveLength(3);
			expect(contentBlocks[0]).toEqual(imagePart);
			expect(contentBlocks[1]).toEqual(textPart);
			expect(contentBlocks[2]).toEqual({
				type: "text",
				text: "[pi-lens automated context — not a user request]\n\nFollow safety guidelines.",
			});

			// Immutability: original object and array must remain untouched
			expect(last).not.toBe(originalUser);
			expect(contentBlocks).not.toBe(originalArray);
			expect(originalArray).toHaveLength(2);
			expect(JSON.stringify(originalUser)).toBe(originalUserSnapshot);
		},
		TIMEOUT_MS,
	);

	it(
		"handles empty array content without creating leading blank blocks",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Rule check." },
				tmpDir,
			);

			const emptyArray: unknown[] = [];
			const originalUser = { role: "user", content: emptyArray };

			const result = (await context(
				{ messages: [originalUser] },
				makeCtx({ cwd: tmpDir, sessionId: "sess-4" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			const last = result.messages[0];
			expect(Array.isArray(last.content)).toBe(true);
			const contentBlocks = last.content as Array<{
				type: string;
				text?: string;
			}>;
			expect(contentBlocks).toHaveLength(1);
			expect(contentBlocks[0]).toEqual({
				type: "text",
				text: "[pi-lens automated context — not a user request]\n\nRule check.",
			});
			expect(emptyArray).toHaveLength(0);
			expect(last).not.toBe(originalUser);
		},
		TIMEOUT_MS,
	);

	it(
		"preserves trailing tool_result adjacency by appending after transcript instead of into tool_result",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Tool findings." },
				tmpDir,
			);

			const toolUse = {
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "read", input: {} }],
			};
			const toolResult = {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "ok" },
				],
			};
			const existing = [toolUse, toolResult];

			const result = (await context(
				{ messages: existing },
				makeCtx({ cwd: tmpDir, sessionId: "sess-5" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			// Injected message must be appended AFTER the tool_result message
			expect(result.messages).toHaveLength(3);
			expect(result.messages[0]).toBe(toolUse);
			expect(result.messages[1]).toBe(toolResult);
			expect(result.messages[2].role).toBe("user");
			expect(result.messages[2].content).toContain("Tool findings.");
		},
		TIMEOUT_MS,
	);

	it(
		"falls back to prepend semantics for an empty transcript",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Empty transcript check." },
				tmpDir,
			);

			const result = (await context(
				{ messages: [] },
				makeCtx({ cwd: tmpDir, sessionId: "sess-6" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].role).toBe("user");
			expect(result.messages[0].content).toContain("Empty transcript check.");
		},
		TIMEOUT_MS,
	);

	it(
		"routes a non-string non-array prompt down the append-after path preserving content uncoerced",
		async () => {
			const { context } = await loadContextHandler();

			new CacheManager(false).writeCache(
				"session-start-guidance",
				{ content: "Uncoerced test guidance." },
				tmpDir,
			);

			const customContent = { weird: true };
			const customUser = { role: "user", content: customContent };
			const existing = [{ role: "assistant", content: "Ready." }, customUser];

			const result = (await context(
				{ messages: existing },
				makeCtx({ cwd: tmpDir, sessionId: "sess-7" }),
			)) as { messages: Array<{ role: string; content: unknown }> };

			expect(result).toBeDefined();
			// Appends AFTER the transcript as a new message, leaving customContent untouched
			expect(result.messages).toHaveLength(3);
			expect(result.messages[0]).toEqual({
				role: "assistant",
				content: "Ready.",
			});
			expect(result.messages[1]).toBe(customUser);
			expect(result.messages[1].content).toBe(customContent);
			expect(result.messages[2].role).toBe("user");
			expect(result.messages[2].content).toContain("Uncoerced test guidance.");
		},
		TIMEOUT_MS,
	);
});
