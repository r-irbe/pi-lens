/**
 * #4320: when a PATH came into existence, as far as this process can tell.
 *
 * A language server needs a watched-files `Created` for a path it may hold a
 * failed lookup for, and only then (Pyrefly 1.3.2 keeps `import new_module`
 * missing until it hears Created). The inode's birth time answers "is this
 * file newer than the server?", but it is not the path's birth:
 *
 * - pi-lens's own partial edits replace the file through `writeFileAtomic`
 *   (temp file + rename), so an edited file gets a NEW inode and a new birth
 *   time. {@link noteAtomicReplace} records that the installed inode stands
 *   for a path born earlier, and {@link pathBirthtimeMs} answers with that
 *   earlier birth.
 * - A filesystem without a birth time reports 0, and Node on Linux without
 *   `statx` (kernels before 4.11, or a seccomp profile that blocks it) reports
 *   ctime as the birth time, which every in-place edit moves. Both make the
 *   birth unknown: {@link pathBirthtimeMs} returns `undefined` and leaves one
 *   degradation record per cause per session.
 *
 * - #4368 r1 row 13: a file moved into place (`mv`, a rename) keeps its inode
 *   and the inode's old birth, so it reads as older than the server that
 *   holds a failed lookup for its path. When pi-lens saw the path absent and
 *   later sees it present, the path was born in between: the import resolver
 *   ({@link notePathAppeared}) reports an import that resolved to nothing and
 *   now resolves to the path, and {@link pathBirthtimeMs} answers with that
 *   later observation.
 *
 * An editor or tool that replaces a file this way outside pi-lens leaves no
 * record, and its new inode reads exactly like a newly created file. Nothing
 * in a stat result tells the two apart.
 */
import * as fs from "node:fs";
import { BoundedFifoMap } from "./bounded-cache.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { normalizeMapKey } from "./path-utils.js";

/** The stat fields a path birth is read from. */
export type BirthStat = Pick<
	fs.Stats,
	"dev" | "ino" | "birthtimeMs" | "ctimeMs"
>;

/**
 * Inodes pi-lens installed over an existing path, keyed by the installed
 * inode's identity, mapped to the replaced path's birth. The inode's own birth
 * is part of the key, so an inode number the filesystem reuses for an
 * unrelated file never inherits the record. Bounded: an evicted record only
 * means that file's next first open may be announced as Created once.
 */
const replacedPathBirths = new BoundedFifoMap<string, number>(1024);

const inodeKey = (stat: BirthStat): string =>
	`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

/**
 * Record that pi-lens installed `after` over the path `before` described.
 * Chained replacements carry the first birth forward.
 */
export function noteAtomicReplace(before: BirthStat, after: BirthStat): void {
	const birth = replacedPathBirths.get(inodeKey(before)) ?? before.birthtimeMs;
	replacedPathBirths.set(inodeKey(after), birth);
}

/**
 * Paths pi-lens saw absent and then present, mapped to the first observation
 * of their presence. Bounded: an evicted record only means that path falls
 * back to its inode's birth.
 */
const appearedPaths = new BoundedFifoMap<string, number>(1024);

/**
 * Record that `filePath` was absent at an earlier observation and is present
 * now (#4368 r1 row 13), so its path was born no earlier than `atMs`.
 */
export function notePathAppeared(filePath: string, atMs = Date.now()): void {
	appearedPaths.set(normalizeMapKey(filePath), atMs);
}

let birthIsCtimeAlias: boolean | undefined;

/**
 * True when Node reports ctime as the birth time. libuv falls back from statx
 * to stat when statx is missing or blocked and then copies ctime into the
 * birth time. procfs keeps no birth time, so with statx `/proc` reports 0
 * and without it reports its ctime (measured on Linux 7.0 with
 * `systemd-run -p SystemCallFilter=~statx`). Asked once per process: the
 * fallback is process-wide and cannot change.
 */
function birthTimeIsCtimeAlias(): boolean {
	if (birthIsCtimeAlias !== undefined) return birthIsCtimeAlias;
	birthIsCtimeAlias = false;
	if (process.platform === "linux") {
		try {
			const proc = fs.statSync("/proc");
			birthIsCtimeAlias =
				proc.birthtimeMs !== 0 && proc.birthtimeMs === proc.ctimeMs;
		} catch {
			// No procfs: no evidence of the fallback, keep the birth time.
		}
	}
	return birthIsCtimeAlias;
}

/** Test seam: forget the per-process answer, or pin it. */
export function resetPathBirthForTests(ctimeAlias?: boolean): void {
	birthIsCtimeAlias = ctimeAlias;
	replacedPathBirths.clear();
	appearedPaths.clear();
}

/**
 * The birth time of the path `stat` describes, or `undefined` when this
 * process cannot know it (see the module comment). With `filePath`, a
 * recorded appearance of that path (`notePathAppeared`) answers when it is
 * later than the inode's birth, or when the inode's birth is unknown.
 */
export function pathBirthtimeMs(
	stat: BirthStat,
	filePath?: string,
): number | undefined {
	const appeared =
		filePath === undefined
			? undefined
			: appearedPaths.get(normalizeMapKey(filePath));
	const inode = inodeBirthtimeMs(stat);
	if (appeared === undefined) return inode;
	return inode === undefined ? appeared : Math.max(inode, appeared);
}

function inodeBirthtimeMs(stat: BirthStat): number | undefined {
	if (!(stat.birthtimeMs > 0)) {
		recordDegradationOnce({
			kind: "lsp-file-birth-unknown",
			subject: "no-birth-time",
			reason:
				"the filesystem reports no birth time; a file created while a language server runs is announced as Changed (#4320)",
		});
		return undefined;
	}
	if (birthTimeIsCtimeAlias()) {
		recordDegradationOnce({
			kind: "lsp-file-birth-unknown",
			subject: "ctime-alias",
			reason:
				"Node reports ctime as the birth time (no statx); a file created while a language server runs is announced as Changed (#4320)",
		});
		return undefined;
	}
	return replacedPathBirths.get(inodeKey(stat)) ?? stat.birthtimeMs;
}
