/**
 * #1782: the session clock the workspace-diagnostics cache measures entry age
 * against, in a module of its own.
 *
 * It lives here rather than in `workspace-diagnostics-cache.ts` for one
 * measured reason (#1786 review F5): `handleSessionStart` must re-arm it, and
 * importing the cache module to do so drags `reverse-deps.ts`,
 * `blocker-freshness.ts`, and the generation-guard machinery into the EAGER
 * session-start module graph — 17 ms, about 9% of cold session start. This file
 * imports nothing, so the re-arm stays a plain synchronous call with no await
 * inserted into the middle of the reset sequence and no import cost.
 *
 * The default is module-import time so the very first sweep in a cold extension
 * host already treats every entry written by a PREVIOUS process as pre-session
 * (fail-closed). It must still be re-armed per session: a pi extension host
 * survives `session_start`, so a process-lifetime value would pin the first
 * session's clock for the life of the process (AGENTS.md's
 * session-signal-vs-latch screen). Registered in
 * `tests/support/session-state-registry.ts`, whose conformance suite proves the
 * reset is reachable from `handleSessionStart`.
 *
 * The one import, `bounded-cache.ts`, imports nothing itself.
 */
import { BoundedFifoMap } from "../bounded-cache.js";

let _sessionStartedAt = Date.now();

/** Re-arm the session clock. Called by `handleSessionStart`. */
export function resetWorkspaceDiagnosticsCacheSession(
	startedAt: number = Date.now(),
): void {
	_sessionStartedAt = startedAt;
	_fileCreations.clear();
	_evictedCreatedAt = 0;
}

/** When the current session started, for entry-age comparisons. */
export function workspaceDiagnosticsCacheSessionStart(): number {
	return _sessionStartedAt;
}

/**
 * #4320: a file created after an entry was scanned can resolve an import that
 * entry reported missing, with no edit to the importer and no edit to anything
 * the importer was known to import (an unresolved import has no edge in the
 * reverse-dependency index), so neither freshness check in `isEntryFresh` can
 * see it.
 *
 * One record per language-server client: the last time that client SENT a
 * `Created` watched-files notification, keyed by its server id and root. Only
 * that server can answer differently because of it, and only for files under
 * that root, so a finding entry is refused when one of the servers behind its
 * findings has a record at a root holding the file, at or after the entry's
 * scan (`workspaceFileCreatedAtFor`). A creation reported to another server,
 * or under another root, leaves the entry serving.
 *
 * Bounded by the live client population; an evicted record folds into
 * `_evictedCreatedAt`, which every entry honours, so eviction can only refuse
 * more, never serve a stale finding. Re-armed with the session clock above.
 */
interface FileCreation {
	serverId: string;
	root: string;
	at: number;
}
const _fileCreations = new BoundedFifoMap<string, FileCreation>(128);
let _evictedCreatedAt = 0;

/** Record that the client for `serverId` at `root` just sent a Created. */
export function noteWorkspaceFileCreated(
	serverId: string,
	root: string,
	at: number = Date.now(),
): void {
	const key = `${serverId}\0${root}`;
	const latest = Math.max(_fileCreations.get(key)?.at ?? 0, at);
	for (const [, evicted] of _fileCreations.set(key, {
		serverId,
		root,
		at: latest,
	})) {
		_evictedCreatedAt = Math.max(_evictedCreatedAt, evicted.at);
	}
}

/**
 * The latest Created a server `fromServer` accepts was sent at a root `holds`
 * accepts
 * (0 when none this session).
 */
export function workspaceFileCreatedAtFor(
	fromServer: (serverId: string) => boolean,
	holds: (root: string) => boolean,
): number {
	let latest = _evictedCreatedAt;
	for (const creation of _fileCreations.values()) {
		if (
			creation.at > latest &&
			fromServer(creation.serverId) &&
			holds(creation.root)
		) {
			latest = creation.at;
		}
	}
	return latest;
}
