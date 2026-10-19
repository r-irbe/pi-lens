/**
 * Debounced `workspace/didChangeWatchedFiles` batching (#271).
 *
 * `handleNotifyOpen` previously sent one `workspace/didChangeWatchedFiles` per
 * file as each was opened. Many servers (TypeScript, …) kick off a project-wide
 * re-analysis on every such notification, so a turn that edits N files in one
 * project triggered ~N full re-analyses. This per-client queue coalesces the
 * changes within a short window and flushes them as a SINGLE notification, so the
 * server re-indexes once per burst instead of once per file.
 *
 * One queue lives per LSP client (= per serverId+root), so batching is naturally
 * scoped to a single server/project. Worst-case added latency before the server
 * learns of a change is the debounce window — negligible against the multi-second
 * re-analysis it gates.
 */

/** LSP `FileChangeType`: 1 Created, 2 Changed, 3 Deleted. */
export interface WatchedFileChange {
	uri: string;
	type: number;
}

export const WATCH_DEBOUNCE_MS = 100;

/** LSP `FileChangeType` values. */
export const FILE_CREATED = 1;
export const FILE_CHANGED = 2;
export const FILE_DELETED = 3;

/**
 * #4320: a file born this close to (or after) the client's start is one the
 * server's own startup scan may not have seen, and may hold a cached failed
 * lookup for. The margin covers the filesystem's coarse timestamp clock (up to
 * ~10 ms behind `Date.now()`) and errs toward Created: a spurious Created for a
 * file the server already knows is a refresh, a missing one leaves a stale
 * miss for the life of the server.
 */
export const WATCH_BIRTH_MARGIN_MS = 100;

/**
 * #4320: the `FileChangeType` for a path that exists on disk, given its path
 * birth (`pathBirthtimeMs` in `clients/path-birth.ts`). `Changed` says "the
 * bytes differ"; only `Created` makes a server drop a cached "module not
 * found" for the path (measured with Pyrefly 1.3.2: an importer's
 * missing-import survives Changed for the life of the server and clears on
 * Created). A path born after the client started is one the server's startup
 * scan could not have read, so it is Created; an older one is one the server
 * already knew, so it is Changed.
 *
 * - The caller announces Created to one client at most once per path (the
 *   client's `createdAnnounced` memory), so this answers only "is the path
 *   newer than the client".
 * - An unknown client start (`Infinity`) compares below the cutoff and falls
 *   back to the pre-#4320 answer, Changed.
 * - A file moved in from elsewhere keeps its old birth time and is not
 *   recognised here; `rename_file` announces its destination explicitly.
 */
export function watchedTypeForOpen(
	birthtimeMs: number,
	clientStartedAtMs: number = Number.POSITIVE_INFINITY,
): number {
	return birthtimeMs >= clientStartedAtMs - WATCH_BIRTH_MARGIN_MS
		? FILE_CREATED
		: FILE_CHANGED;
}

export class WatchedFilesQueue {
	// uri → latest FileChangeType. A Map collapses repeated events for the same
	// URI (last-type-wins, except Created is never downgraded to Changed inside
	// one window — #4320) while preserving first-seen insertion order.
	private readonly pending = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly flushFn: (changes: WatchedFileChange[]) => void,
		private readonly debounceMs: number = WATCH_DEBOUNCE_MS,
		/**
		 * #4320: called right after a batch carrying a Created is sent: from then
		 * on the server answers with the new path in view, and any answer it gave
		 * before may be a stale "module not found".
		 */
		private readonly onCreated?: () => void,
	) {}

	/** Queue a change; arms the debounce timer if not already pending. */
	enqueue(uri: string, type: number): void {
		// #4320: Created then Changed for one URI inside the window is still a
		// creation for a server that never saw the file. Last-wins would send the
		// Changed alone and the server would keep its stale missing-module cache.
		const held = this.pending.get(uri);
		this.pending.set(
			uri,
			held === FILE_CREATED && type === FILE_CHANGED ? FILE_CREATED : type,
		);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), this.debounceMs);
		// Never hold the event loop open for a pending watched-files flush.
		this.timer.unref?.();
	}

	/** Emit all queued changes as one notification (no-op when empty). */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) return;
		const changes: WatchedFileChange[] = [...this.pending.entries()].map(
			([uri, type]) => ({ uri, type }),
		);
		this.pending.clear();
		this.flushFn(changes);
		if (changes.some((change) => change.type === FILE_CREATED)) {
			this.onCreated?.();
		}
	}

	/**
	 * #4320: send now when a Created is waiting, so a read that follows is
	 * answered by a server that has heard of the new path. Leaves a queue of
	 * edits alone to coalesce as usual.
	 */
	flushIfCreated(): void {
		for (const type of this.pending.values()) {
			if (type === FILE_CREATED) {
				this.flush();
				return;
			}
		}
	}

	/** Drop the timer + any queued changes without emitting (client teardown). */
	cancel(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
	}

	/** Number of distinct URIs currently queued (for tests/introspection). */
	get size(): number {
		return this.pending.size;
	}
}
