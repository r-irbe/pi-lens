import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WATCH_BIRTH_MARGIN_MS,
	WATCH_DEBOUNCE_MS,
	WatchedFilesQueue,
	watchedTypeForOpen,
	type WatchedFileChange,
} from "../../../clients/lsp/watch-queue.js";

/**
 * #271 — per-client debounced `workspace/didChangeWatchedFiles` batching.
 */
describe("WatchedFilesQueue (#271)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("coalesces a burst into ONE flush, last-type-wins, insertion order", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));

		// (uriA,Changed), (uriA,Changed), (uriB,Created)
		q.enqueue("file:///a", 2);
		q.enqueue("file:///a", 2);
		q.enqueue("file:///b", 1);

		expect(flushes).toHaveLength(0); // nothing sent before the window
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);

		expect(flushes).toEqual([
			[
				{ uri: "file:///a", type: 2 },
				{ uri: "file:///b", type: 1 },
			],
		]);
	});

	it("last enqueue wins when a URI's type changes within the window", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2); // Changed
		q.enqueue("file:///a", 3); // …then Deleted
		q.enqueue("file:///b", 3); // Deleted
		q.enqueue("file:///b", 1); // …then re-Created
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([
			[
				{ uri: "file:///a", type: 3 },
				{ uri: "file:///b", type: 1 },
			],
		]);
	});

	// #4320 recurrence: last-wins turned Created into Changed when a file was
	// opened (Created) and reported Changed again inside one 100 ms window, and
	// Pyrefly keeps a failed `import new_module` lookup until it hears Created.
	it("never downgrades Created to Changed inside one window (#4320)", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///new", 1); // Created
		q.enqueue("file:///new", 2); // …then Changed
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([[{ uri: "file:///new", type: 1 }]]);
	});

	it("keeps Changed then Created as Created (#4320)", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///new", 2);
		q.enqueue("file:///new", 1);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([[{ uri: "file:///new", type: 1 }]]);
	});

	it("reports a Created that is deleted in the same window as Deleted (#4320)", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///gone", 1);
		q.enqueue("file:///gone", 3);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([[{ uri: "file:///gone", type: 3 }]]);
	});

	// #4320 r2: the creation marker is the moment the server is TOLD (a batch
	// carrying a Created is sent). Round 1 also marked at queue time, before the
	// server knew, which a batch that sends Created up front no longer needs.
	it("signals onCreated after a batch carrying a Created is sent, only then (#4320)", () => {
		const calls: string[] = [];
		const q = new WatchedFilesQueue(
			() => calls.push("flush"),
			WATCH_DEBOUNCE_MS,
			() => calls.push("created"),
		);
		q.enqueue("file:///existing", 2);
		q.enqueue("file:///new", 1);
		expect(calls).toEqual([]);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(calls).toEqual(["flush", "created"]);

		calls.length = 0;
		q.enqueue("file:///only-changed", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(calls).toEqual(["flush"]);
	});

	// #4320 r2 (F1): an importer read before the 100 ms window closed was
	// answered by a server that had not yet heard Created for its module.
	it("sends at once when a Created is waiting, and leaves edits to coalesce (#4320)", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///edited", 2);
		q.flushIfCreated();
		expect(flushes).toEqual([]);
		q.enqueue("file:///new", 1);
		q.flushIfCreated();
		expect(flushes).toEqual([
			[
				{ uri: "file:///edited", type: 2 },
				{ uri: "file:///new", type: 1 },
			],
		]);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toHaveLength(1);
	});

	it("flushes once after the window with no further enqueues", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 5); // long idle
		expect(flushes).toHaveLength(1);
	});

	it("does not flush before the debounce window elapses", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS - 1);
		expect(flushes).toHaveLength(0);
	});

	it("re-arms for a second burst after a flush", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		q.enqueue("file:///b", 1);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toEqual([
			[{ uri: "file:///a", type: 2 }],
			[{ uri: "file:///b", type: 1 }],
		]);
	});

	it("cancel() drops the timer + pending changes without emitting", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		expect(q.size).toBe(1);
		q.cancel();
		expect(q.size).toBe(0);
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 5);
		expect(flushes).toHaveLength(0);
	});

	it("manual flush() emits immediately and empties the queue", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.enqueue("file:///a", 2);
		q.flush();
		expect(flushes).toEqual([[{ uri: "file:///a", type: 2 }]]);
		// the armed timer is cleared, so the window passing does not double-emit
		vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
		expect(flushes).toHaveLength(1);
	});

	it("flush() on an empty queue is a no-op", () => {
		const flushes: WatchedFileChange[][] = [];
		const q = new WatchedFilesQueue((c) => flushes.push(c));
		q.flush();
		expect(flushes).toHaveLength(0);
	});
});

/**
 * #4320: Created vs Changed for a path that exists on disk, from its path
 * birth. Created only for a path born after the client started (the server's
 * startup scan could not have read it); a long-existing file stays Changed so a
 * first open of a project's existing files does not announce a creation each.
 * An unknown birth (0, or ctime without statx) never reaches this function:
 * `pathBirthtimeMs` answers `undefined` and the client sends Changed.
 */
describe("watchedTypeForOpen (#4320)", () => {
	const started = 1_000_000;

	it("is Created for a file born after the client started", () => {
		expect(watchedTypeForOpen(started + 5_000, started)).toBe(1);
	});

	it("is Changed for a file born well before the client started", () => {
		expect(watchedTypeForOpen(started - 60_000, started)).toBe(2);
	});

	it("draws the line at the margin: Created at the edge, Changed one ms before it", () => {
		expect(watchedTypeForOpen(started - WATCH_BIRTH_MARGIN_MS, started)).toBe(
			1,
		);
		expect(
			watchedTypeForOpen(started - WATCH_BIRTH_MARGIN_MS - 1, started),
		).toBe(2);
	});

	it("stays Changed when the client has no start time", () => {
		expect(watchedTypeForOpen(started + 5_000, undefined)).toBe(2);
	});
});
